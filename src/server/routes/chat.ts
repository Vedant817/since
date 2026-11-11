import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { LlmError } from '../llm/openai.js';
import { runAgentTurn } from '../agent/loop.js';
import { safeTimeZone } from '../agent/timezone.js';
import { listClaims } from '../memory/claim-store.js';
import { createConversation, getConversation, getTurns } from '../memory/turns.js';
import type { Runtime } from '../runtime.js';
import { SearchError } from '../search/types.js';

const ConversationBody = z.object({
  timezone: z.string().max(80).optional(),
  title: z.string().max(120).optional(),
});

const ChatBody = z.object({
  conversationId: z.string().min(1),
  message: z.string().min(1).max(4000),
  timezone: z.string().max(80).optional(),
});

const SeedBody = z.object({
  timezone: z.string().max(80).optional(),
});

function safeErrorMessage(error: unknown): string {
  if (error instanceof LlmError || error instanceof SearchError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return 'Request cancelled.';
  return 'Something went wrong while answering. The server log has the details.';
}

export function chatRoutes(runtime: Runtime): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      ok: true,
      mode: runtime.config.mode,
      missingKeys: runtime.config.missingKeys,
      searchProvider: runtime.searchService.provider,
      models: runtime.config.openai
        ? {
            fast: runtime.config.openai.fastModel,
            smart: runtime.config.openai.smartModel,
          }
        : null,
      userTimezone: runtime.config.userTimezone,
      now: new Date().toISOString(),
    }),
  );

  app.post('/conversations', async (c) => {
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const parsed = ConversationBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid conversation payload.' }, 400);
    }
    const timezone = safeTimeZone(parsed.data.timezone, runtime.config.userTimezone);
    const conversation = createConversation(runtime.db, {
      timezone,
      title: parsed.data.title ?? 'New conversation',
    });
    return c.json({ conversation });
  });

  app.get('/conversations/:id', (c) => {
    const id = c.req.param('id');
    const conversation = getConversation(runtime.db, id);
    if (!conversation) return c.json({ error: 'Conversation not found.' }, 404);
    return c.json({
      conversation,
      turns: getTurns(runtime.db, id, 200),
      claims: listClaims(runtime.db, id, 200),
    });
  });

  app.get('/claims', (c) => {
    const conversationId = c.req.query('conversationId');
    if (!conversationId) return c.json({ error: 'conversationId is required.' }, 400);
    return c.json({ claims: listClaims(runtime.db, conversationId, 200) });
  });

  app.post('/demo/seed', async (c) => {
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const parsed = SeedBody.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Invalid seed payload.' }, 400);
    const { seedDemoHistory } = await import('../memory/seed.js');
    const timezone = safeTimeZone(parsed.data.timezone, runtime.config.userTimezone);
    const conversationId = seedDemoHistory(runtime.db, { timezone });
    return c.json({ conversationId });
  });

  app.post('/chat', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Request body must be JSON.' }, 400);
    }
    const parsed = ChatBody.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.issues.map((issue) => issue.message).join('; ') },
        400,
      );
    }
    const conversation = runtime.db
      .prepare('SELECT id FROM conversations WHERE id = ?')
      .get(parsed.data.conversationId);
    if (!conversation) return c.json({ error: 'Conversation not found.' }, 404);

    return streamSSE(c, async (stream) => {
      const emit = async (event: Record<string, unknown>) => {
        await stream.writeSSE({
          event: String(event.type ?? 'message'),
          data: JSON.stringify(event),
        });
      };
      try {
        await runAgentTurn(
          {
            db: runtime.db,
            llm: runtime.llm,
            search: runtime.searchTool,
            mode: runtime.config.mode,
            userTimezone: runtime.config.userTimezone,
          },
          {
            conversationId: parsed.data.conversationId,
            message: parsed.data.message,
            timezone: parsed.data.timezone ?? runtime.config.userTimezone,
            emit,
            signal: c.req.raw.signal,
          },
        );
      } catch (error) {
        console.error('[since] chat failed:', error);
        try {
          await emit({ type: 'error', message: safeErrorMessage(error) });
          await emit({ type: 'done' });
        } catch {
          // The client disconnected; nothing useful left to write.
        }
      }
    });
  });

  return app;
}
