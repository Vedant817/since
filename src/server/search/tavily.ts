import { z } from 'zod';
import type { SearchClient, SearchOptions, SearchResult } from './types.js';
import { SearchError } from './types.js';

const TavilyResult = z.object({
  title: z.string().default('Untitled'),
  url: z.string().url(),
  content: z.string().optional().default(''),
  raw_content: z.string().nullable().optional(),
  score: z.number().optional(),
  published_date: z.string().nullable().optional(),
});

const TavilyResponse = z.object({
  results: z.array(TavilyResult).default([]),
  detail: z.unknown().optional(),
});

function normalizeDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function cleanContent(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 14_000);
}

export interface TavilyConfig {
  apiKey: string;
  baseUrl?: string;
}

export class TavilySearch implements SearchClient {
  readonly name = 'tavily';
  private readonly baseUrl: string;

  constructor(private readonly config: TavilyConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.tavily.com').replace(/\/$/, '');
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const maxResults = Math.min(Math.max(options.maxResults ?? 6, 1), 8);
    const body: Record<string, unknown> = {
      api_key: this.config.apiKey,
      query,
      search_depth: 'advanced',
      include_raw_content: true,
      include_answer: false,
      include_images: false,
      max_results: maxResults,
      topic: 'general',
    };
    if (options.startDate) body.start_date = options.startDate.slice(0, 10);
    if (options.endDate) body.end_date = options.endDate.slice(0, 10);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: options.signal ?? AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new SearchError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'Web search timed out.'
          : 'Could not reach the web search provider.',
        'network',
      );
    }

    // Some Tavily-compatible gateways do not accept date bounds. Retry the same
    // query once without them rather than losing the answer.
    if (response.status === 400 && (options.startDate || options.endDate)) {
      const { start_date: _start, end_date: _end, ...fallback } = body;
      try {
        response = await fetch(`${this.baseUrl}/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(fallback),
          signal: options.signal ?? AbortSignal.timeout(20_000),
        });
      } catch {
        throw new SearchError('Could not reach the web search provider.', 'network');
      }
    }

    if (response.status === 401 || response.status === 403) {
      throw new SearchError('Tavily rejected the API key.', 'auth');
    }
    if (response.status === 429) {
      throw new SearchError('Tavily rate limit reached; try again shortly.', 'rate_limit');
    }
    if (!response.ok) {
      throw new SearchError(`Web search failed (HTTP ${response.status}).`, 'bad_response');
    }

    const json: unknown = await response.json();
    const parsed = TavilyResponse.safeParse(json);
    if (!parsed.success) {
      throw new SearchError('Web search returned an unexpected response.', 'bad_response');
    }

    return parsed.data.results.map((result) => ({
      title: result.title.trim() || domainOf(result.url) || 'Untitled',
      url: result.url,
      content: cleanContent(result.raw_content || result.content),
      publishedAt: normalizeDate(result.published_date),
      score: result.score,
    }));
  }
}
