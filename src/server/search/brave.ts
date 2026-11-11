import { z } from 'zod';
import type { SearchClient, SearchOptions, SearchResult } from './types.js';
import { SearchError } from './types.js';

const BraveResult = z.object({
  title: z.string().default('Untitled'),
  url: z.string().url(),
  description: z.string().optional().default(''),
  extra_snippets: z.array(z.string()).optional().default([]),
  age: z.string().optional(),
  page_age: z.string().optional(),
});

const BraveResponse = z.object({
  web: z
    .object({
      results: z.array(BraveResult).default([]),
    })
    .optional(),
});

function cleanContent(value: string): string {
  return value
    .replace(/\u0000/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 14_000);
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return undefined;
}

export interface BraveConfig {
  apiKey: string;
  baseUrl?: string;
}

export class BraveSearch implements SearchClient {
  readonly name = 'brave';
  private readonly baseUrl: string;

  constructor(private readonly config: BraveConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.search.brave.com').replace(/\/$/, '');
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const count = Math.min(Math.max(options.maxResults ?? 6, 1), 20);
    const url = new URL(`${this.baseUrl}/res/v1/web/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(count));
    url.searchParams.set('extra_snippets', 'true');
    // Brave supports freshness filters like pd/pw/pm/py, but mapping arbitrary
    // date ranges is limited. Prefer no filter over dropping the query.

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-subscription-token': this.config.apiKey,
        },
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

    if (response.status === 401 || response.status === 403) {
      throw new SearchError('Brave Search rejected the API key.', 'auth');
    }
    if (response.status === 429) {
      throw new SearchError('Brave Search rate limit reached; try again shortly.', 'rate_limit');
    }
    if (!response.ok) {
      throw new SearchError(`Web search failed (HTTP ${response.status}).`, 'bad_response');
    }

    const json: unknown = await response.json();
    const parsed = BraveResponse.safeParse(json);
    if (!parsed.success) {
      throw new SearchError('Web search returned an unexpected response.', 'bad_response');
    }

    const results = parsed.data.web?.results ?? [];
    return results.map((result) => {
      const parts = [result.description, ...result.extra_snippets].filter(Boolean);
      return {
        title: result.title,
        url: result.url,
        content: cleanContent(parts.join('\n\n')),
        publishedAt: normalizeDate(result.page_age ?? result.age),
      };
    });
  }
}
