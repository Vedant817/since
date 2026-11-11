import type { AppConfig } from './config.js';
import { OpenAiCompatibleLlm, type LlmClient } from './llm/openai.js';
import type { Db } from './memory/db.js';
import { createDemoSearch } from './search/demo.js';
import { createWebSearchTool, SearchService, type WebSearchTool } from './search/service.js';
import { TavilySearch } from './search/tavily.js';

export interface Runtime {
  config: AppConfig;
  db: Db;
  llm: LlmClient | null;
  searchTool: WebSearchTool;
  searchService: SearchService;
}

export function createRuntime(config: AppConfig, db: Db, now = new Date()): Runtime {
  const llm =
    config.mode === 'live' && config.openai ? new OpenAiCompatibleLlm(config.openai) : null;
  const searchClient =
    config.mode === 'live' && config.tavilyApiKey
      ? new TavilySearch({ apiKey: config.tavilyApiKey })
      : createDemoSearch(now);
  const searchService = new SearchService(db, searchClient, () => new Date());
  return {
    config,
    db,
    llm,
    searchTool: createWebSearchTool(searchService),
    searchService,
  };
}
