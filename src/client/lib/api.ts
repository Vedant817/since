import type {
  ChatRequestBody,
  Claim,
  Conversation,
  ConversationPayload,
  StreamEvent,
} from '../../shared/types.js';

export interface Health {
  ok: boolean;
  mode: 'live' | 'demo';
  missingKeys: string[];
  searchProvider: string;
  models: { fast: string; smart: string } | null;
  userTimezone: string;
  now: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Keep the status message.
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export function getHealth(): Promise<Health> {
  return request<Health>('/api/health');
}

export function createConversation(timezone: string): Promise<{ conversation: Conversation }> {
  return request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ timezone }),
  });
}

export function getConversation(id: string): Promise<ConversationPayload> {
  return request(`/api/conversations/${encodeURIComponent(id)}`);
}

export function seedDemo(timezone: string): Promise<{ conversationId: string }> {
  return request('/api/demo/seed', {
    method: 'POST',
    body: JSON.stringify({ timezone }),
  });
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export interface ChatStreamOptions {
  conversationId: string;
  message: string;
  timezone: string;
  signal?: AbortSignal;
  onEvent: (event: StreamEvent) => void | Promise<void>;
}

export async function streamChat(options: ChatStreamOptions): Promise<void> {
  const body: ChatRequestBody = {
    conversationId: options.conversationId,
    message: options.message,
    timezone: options.timezone,
  };
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    let message = `Chat failed (${response.status}).`;
    try {
      const json = (await response.json()) as { error?: string };
      if (json.error) message = json.error;
    } catch {
      // Keep the status message.
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error('The response did not include a stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = async (block: string) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    try {
      const parsed = JSON.parse(raw) as StreamEvent;
      if (!parsed.type) parsed.type = eventName as StreamEvent['type'];
      await options.onEvent(parsed);
    } catch {
      // Ignore malformed keep-alive frames; the typed events are JSON.
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.trim()) await dispatch(block);
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (buffer.trim()) await dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
}

export function mergeClaims(existing: Claim[], incoming: Claim[]): Claim[] {
  const map = new Map(existing.map((claim) => [claim.id, claim]));
  for (const claim of incoming) map.set(claim.id, claim);
  return [...map.values()].sort((a, b) => b.asOf.localeCompare(a.asOf));
}
