import { z } from 'zod';
import { safeTimeZone } from './agent/timezone.js';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  DATABASE_PATH: z.string().default('./data/since.db'),
  USER_TZ: z.string().default('UTC'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  MODEL_FAST: z.string().default('gpt-4.1-mini'),
  MODEL_SMART: z.string().default('gpt-4.1'),
  TAVILY_API_KEY: z.string().optional(),
});

export interface AppConfig {
  port: number;
  databasePath: string;
  userTimezone: string;
  mode: 'live' | 'demo';
  missingKeys: string[];
  openai?: {
    apiKey: string;
    baseUrl: string;
    fastModel: string;
    smartModel: string;
  };
  tavilyApiKey?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  const values = parsed.success ? parsed.data : EnvSchema.parse({});
  const missingKeys: string[] = [];
  if (!values.OPENAI_API_KEY) missingKeys.push('OPENAI_API_KEY');
  if (!values.TAVILY_API_KEY) missingKeys.push('TAVILY_API_KEY');
  const mode = missingKeys.length === 0 ? 'live' : 'demo';

  return {
    port: values.PORT,
    databasePath: values.DATABASE_PATH,
    userTimezone: safeTimeZone(values.USER_TZ, 'UTC'),
    mode,
    missingKeys,
    openai: values.OPENAI_API_KEY
      ? {
          apiKey: values.OPENAI_API_KEY,
          baseUrl: values.OPENAI_BASE_URL,
          fastModel: values.MODEL_FAST,
          smartModel: values.MODEL_SMART,
        }
      : undefined,
    tavilyApiKey: values.TAVILY_API_KEY,
  };
}
