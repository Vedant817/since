import { z } from 'zod';
import { safeTimeZone } from './agent/timezone.js';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATABASE_PATH: z.string().default('./data/since.db'),
  USER_TZ: z.string().default('UTC'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  MODEL_FAST: z.string().optional(),
  MODEL_SMART: z.string().optional(),
  // Free/alternative LLM providers (OpenAI-compatible chat completions).
  GROQ_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  // Web search providers (content-returning search).
  TAVILY_API_KEY: z.string().optional(),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
});

export interface LlmConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  fastModel: string;
  smartModel: string;
}

export interface SearchConfig {
  provider: 'tavily' | 'brave';
  apiKey: string;
}

export interface AppConfig {
  port: number;
  databasePath: string;
  userTimezone: string;
  mode: 'live' | 'demo';
  missingKeys: string[];
  llm?: LlmConfig;
  search?: SearchConfig;
  /** @deprecated Use llm */
  openai?: LlmConfig;
  /** @deprecated Use search */
  tavilyApiKey?: string;
}

interface LlmPreset {
  provider: string;
  baseUrl: string;
  fastModel: string;
  smartModel: string;
}

const PRESETS: Record<string, LlmPreset> = {
  groq: {
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    fastModel: 'llama-3.1-8b-instant',
    smartModel: 'llama-3.3-70b-versatile',
  },
  openrouter: {
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    fastModel: 'meta-llama/llama-3.1-8b-instruct:free',
    smartModel: 'meta-llama/llama-3.3-70b-instruct:free',
  },
  gemini: {
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    fastModel: 'gemini-2.0-flash',
    smartModel: 'gemini-2.0-flash',
  },
  openai: {
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    fastModel: 'gpt-4.1-mini',
    smartModel: 'gpt-4.1',
  },
};

function resolveLlm(values: z.infer<typeof EnvSchema>): LlmConfig | undefined {
  let apiKey: string | undefined;
  let preset: LlmPreset = PRESETS.openai;

  if (values.GROQ_API_KEY) {
    apiKey = values.GROQ_API_KEY;
    preset = PRESETS.groq;
  } else if (values.OPENROUTER_API_KEY) {
    apiKey = values.OPENROUTER_API_KEY;
    preset = PRESETS.openrouter;
  } else if (values.GEMINI_API_KEY) {
    apiKey = values.GEMINI_API_KEY;
    preset = PRESETS.gemini;
  } else if (values.OPENAI_API_KEY) {
    apiKey = values.OPENAI_API_KEY;
    preset = PRESETS.openai;
  }

  if (!apiKey) return undefined;

  return {
    provider: preset.provider,
    apiKey,
    baseUrl: values.OPENAI_BASE_URL ?? preset.baseUrl,
    fastModel: values.MODEL_FAST ?? preset.fastModel,
    smartModel: values.MODEL_SMART ?? preset.smartModel,
  };
}

function resolveSearch(values: z.infer<typeof EnvSchema>): SearchConfig | undefined {
  if (values.TAVILY_API_KEY) {
    return { provider: 'tavily', apiKey: values.TAVILY_API_KEY };
  }
  if (values.BRAVE_SEARCH_API_KEY) {
    return { provider: 'brave', apiKey: values.BRAVE_SEARCH_API_KEY };
  }
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  const values = parsed.success ? parsed.data : EnvSchema.parse({});

  const llm = resolveLlm(values);
  const search = resolveSearch(values);
  const missingKeys: string[] = [];
  if (!llm) {
    missingKeys.push('LLM_API_KEY (OPENAI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY)');
  }
  if (!search) {
    missingKeys.push('SEARCH_API_KEY (TAVILY_API_KEY or BRAVE_SEARCH_API_KEY)');
  }
  const mode = missingKeys.length === 0 ? 'live' : 'demo';

  return {
    port: values.PORT,
    databasePath: values.DATABASE_PATH,
    userTimezone: safeTimeZone(values.USER_TZ, 'UTC'),
    mode,
    missingKeys,
    llm,
    search,
    // Back-compat fields used by older code paths.
    openai: llm,
    tavilyApiKey: search?.provider === 'tavily' ? search.apiKey : undefined,
  };
}
