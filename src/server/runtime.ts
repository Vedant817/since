import type { AppConfig } from './config.js';
import { OpenAiCompatibleLlm, type LlmClient } from './llm/openai.js';
import type { Db } from './memory/db.js';
import { BraveSearch } from './search/brave.js';
import { createDemoSearch } from './search/demo.js';
import { createWebSearchTool, SearchService, type WebSearchTool } from './search/service.js';
import { TavilySearch } from './search/tavily.js';
import type { SearchClient } from './search/types.js';

export interface Runtime {
  config: AppConfig;
  db: Db;
  llm: LlmClient | null;
  searchTool: WebSearchTool;
  searchService: SearchService;
}

function createSearchClient(config: AppConfig, now: Date): SearchClient {
  if (config.mode !== 'live' || !config.search) return createDemoSearch(now);
  if (config.search.provider === 'brave') {
    return new BraveSearch({ apiKey: config.search.apiKey });
  }
  return new TavilySearch({ apiKey: config.search.apiKey });
}

export function createRuntime(config: AppConfig, db: Db, now = new Date()): Runtime {
  const llm = config.mode === 'live' && config.llm ? new OpenAiCompatibleLlm(config.llm) : null;
  const searchClient = createSearchClient(config, now);
  const searchService = new SearchService(db, searchClient, () => new Date());
  return {
    config,
    db,
    llm,
    searchTool: createWebSearchTool(searchService),
    searchService,
  };
}
