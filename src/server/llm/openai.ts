import { z } from 'zod';

export class LlmError extends Error {
  constructor(
    message: string,
    readonly code: 'auth' | 'rate_limit' | 'network' | 'bad_response' | 'parse',
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface JsonRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  model?: 'fast' | 'smart';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface StreamRequest {
  system: string;
  user: string;
  model?: 'fast' | 'smart';
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmClient {
  readonly provider: string;
  readonly fastModel: string;
  readonly smartModel: string;
  completeJson<T>(request: JsonRequest<T>): Promise<T>;
  streamText(request: StreamRequest): AsyncGenerator<string>;
}

const CompletionEnvelope = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional(),
          })
          .optional(),
        delta: z
          .object({
            content: z.string().nullable().optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
    })
    .optional(),
});

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}${path}`;
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const objectStart = candidate.indexOf('{');
    const arrayStart = candidate.indexOf('[');
    const start =
      objectStart === -1
        ? arrayStart
        : arrayStart === -1
          ? objectStart
          : Math.min(objectStart, arrayStart);
    if (start === -1) throw new LlmError('Model did not return JSON.', 'parse');
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (end <= start) throw new LlmError('Model did not return JSON.', 'parse');
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      throw new LlmError('Model returned invalid JSON.', 'parse');
    }
  }
}

function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d|o-)/i.test(model);
}

export interface OpenAiConfig {
  apiKey: string;
  baseUrl: string;
  fastModel: string;
  smartModel: string;
}

export class OpenAiCompatibleLlm implements LlmClient {
  readonly provider = 'openai-compatible';
  readonly fastModel: string;
  readonly smartModel: string;
  private readonly url: string;

  constructor(private readonly config: OpenAiConfig) {
    this.fastModel = config.fastModel;
    this.smartModel = config.smartModel;
    this.url = joinUrl(config.baseUrl, '/chat/completions');
  }

  private body(
    model: string,
    messages: Array<{ role: string; content: string }>,
    options: { temperature?: number; maxTokens?: number; stream: boolean; json: boolean },
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: options.stream,
    };
    if (!isReasoningModel(model)) {
      body.temperature = options.temperature ?? 0.2;
      body.max_tokens = options.maxTokens ?? 1200;
    } else {
      body.max_completion_tokens = options.maxTokens ?? 1200;
    }
    if (options.json) body.response_format = { type: 'json_object' };
    return body;
  }

  private async fetchCompletion(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(60_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      return await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: combined,
      });
    } catch (error) {
      throw new LlmError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'The model timed out.'
          : 'Could not reach the model provider.',
        'network',
      );
    }
  }

  private async assertOk(response: Response): Promise<void> {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      throw new LlmError('The model provider rejected the API key.', 'auth');
    }
    if (response.status === 429) {
      throw new LlmError('The model provider rate limit was reached.', 'rate_limit');
    }
    const detail = await response.text().catch(() => '');
    throw new LlmError(
      `Model request failed (HTTP ${response.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`,
      'bad_response',
    );
  }

  async completeJson<T>(request: JsonRequest<T>): Promise<T> {
    const model = request.model === 'smart' ? this.smartModel : this.fastModel;
    const messages = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ];
    let response = await this.fetchCompletion(
      this.body(model, messages, {
        temperature: request.temperature,
        maxTokens: request.maxTokens ?? 1200,
        stream: false,
        json: true,
      }),
      request.signal,
    );

    // Not every OpenAI-compatible gateway implements response_format. One
    // targeted retry without it is cheaper than failing the turn.
    if (response.status === 400) {
      const detail = await response.clone().text().catch(() => '');
      if (/response_format|json_object/i.test(detail)) {
        response = await this.fetchCompletion(
          this.body(model, messages, {
            temperature: request.temperature,
            maxTokens: request.maxTokens ?? 1200,
            stream: false,
            json: false,
          }),
          request.signal,
        );
      }
    }
    await this.assertOk(response);

    const json: unknown = await response.json();
    const envelope = CompletionEnvelope.safeParse(json);
    if (!envelope.success) {
      throw new LlmError('Model returned an unexpected response envelope.', 'bad_response');
    }
    const content = envelope.data.choices[0]?.message?.content;
    if (!content) throw new LlmError('Model returned an empty response.', 'bad_response');
    const parsed = request.schema.safeParse(extractJson(content));
    if (!parsed.success) {
      throw new LlmError(
        `Model JSON did not match the contract: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
        'parse',
      );
    }
    return parsed.data;
  }

  async *streamText(request: StreamRequest): AsyncGenerator<string> {
    const model = request.model === 'fast' ? this.fastModel : this.smartModel;
    const messages = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ];
    const response = await this.fetchCompletion(
      this.body(model, messages, {
        temperature: request.temperature,
        maxTokens: request.maxTokens ?? 1400,
        stream: true,
        json: false,
      }),
      request.signal,
    );
    await this.assertOk(response);
    if (!response.body) throw new LlmError('Model returned no stream.', 'bad_response');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = CompletionEnvelope.safeParse(JSON.parse(data));
            if (!parsed.success) continue;
            const delta = parsed.data.choices[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // Keep the stream resilient to provider keep-alive noise.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
