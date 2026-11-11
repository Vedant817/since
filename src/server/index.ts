import 'dotenv/config';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { loadConfig } from './config.js';
import { openDatabase } from './memory/db.js';
import { chatRoutes } from './routes/chat.js';
import { createRuntime } from './runtime.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const runtime = createRuntime(config, db);

const app = new Hono();
app.use(logger());

app.route('/api', chatRoutes(runtime));

const clientDist = './dist/client';
const hasClient = existsSync(`${clientDist}/index.html`);
if (!hasClient) {
  app.get('/', (c) => c.redirect('/api/health'));
} else {
  app.use('/*', serveStatic({ root: clientDist }));
  app.get('*', serveStatic({ path: `${clientDist}/index.html` }));
}

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: '127.0.0.1',
  },
  (info) => {
    console.log(`\n  Since is running at http://localhost:${info.port}`);
    console.log(
      `  Mode: ${config.mode.toUpperCase()}${
        config.mode === 'demo' && config.missingKeys.length > 0
          ? ` — missing ${config.missingKeys.join(' and ')}. For free live mode, set GROQ_API_KEY + (TAVILY_API_KEY or BRAVE_SEARCH_API_KEY) in .env`
          : ''
      }`,
    );
    if (config.mode === 'live') {
      console.log(
        `  Providers: llm=${config.llm?.provider ?? 'none'} search=${config.search?.provider ?? 'demo'}`,
      );
    }
    console.log(`  Database: ${config.databasePath}\n`);
  },
);

function shutdown() {
  server.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
