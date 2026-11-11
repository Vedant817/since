export interface SearchResult {
  title: string;
  url: string;
  content: string;
  publishedAt?: string;
  score?: number;
  demo?: boolean;
}

export interface SearchOptions {
  startDate?: string;
  endDate?: string;
  maxResults?: number;
  highVolatility?: boolean;
  signal?: AbortSignal;
}

export interface SearchClient {
  name: string;
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

export class SearchError extends Error {
  constructor(
    message: string,
    readonly code: 'auth' | 'rate_limit' | 'network' | 'bad_response' | 'not_configured',
  ) {
    super(message);
    this.name = 'SearchError';
  }
}
