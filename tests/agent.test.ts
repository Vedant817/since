import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '../src/shared/types.js';
import { runAgentTurn } from '../src/server/agent/loop.js';
import { citationsAreGrounded } from '../src/server/agent/grounding.js';
import { loadConfig } from '../src/server/config.js';
import { openDatabase } from '../src/server/memory/db.js';
import { seedDemoHistory } from '../src/server/memory/seed.js';
import { createConversation } from '../src/server/memory/turns.js';
import { createRuntime } from '../src/server/runtime.js';

const FIXED_NOW = new Date('2026-11-11T04:30:00.000Z');
const TZ = 'Asia/Kolkata';
const config = loadConfig({});

async function run(
  message: string,
  options: { seed?: boolean } = {},
): Promise<{ result: Awaited<ReturnType<typeof runAgentTurn>>; events: StreamEvent[] }> {
  const db = openDatabase(':memory:');
  try {
    const runtime = createRuntime(config, db, FIXED_NOW);
    const conversationId =
      options.seed === false
        ? createConversation(db, { timezone: TZ }).id
        : seedDemoHistory(db, { timezone: TZ, now: FIXED_NOW });
    const events: StreamEvent[] = [];
    const result = await runAgentTurn(
      {
        db,
        llm: null,
        search: runtime.searchTool,
        mode: 'demo',
        userTimezone: TZ,
        now: () => FIXED_NOW,
      },
      {
        conversationId,
        message,
        timezone: TZ,
        emit: (event) => {
          events.push(event);
        },
      },
    );
    return { result, events };
  } finally {
    db.close();
  }
}

describe('agent integration — deterministic demo mode', () => {
  it('recalls the 3 November conversation by exact civil date', async () => {
    const { result, events } = await run('What did I ask you on 3 November?');
    expect(result.intent).toBe('recall');
    expect(result.recall.length).toBeGreaterThanOrEqual(2);
    expect(result.assistantTurn.resolvedStart).toBe('2026-11-02T18:30:00.000Z');
    expect(result.assistantTurn.text).toContain('On Tue 3 Nov 2026 you asked');
    expect(result.assistantTurn.text).toContain('managed Postgres');
    expect(result.assistantTurn.text).toContain('backups');
    expect(result.sources).toHaveLength(0);
    expect(result.grounding.total).toBe(0);
    expect(events.some((event) => event.type === 'recall')).toBe(true);
    expect(result.assistantTurn.meta?.recallUserTurnIds).toHaveLength(2);
  });

  it('recalls and re-checks: two changed, one unchanged, one unclear', async () => {
    const { result, events } = await run(
      'What did I ask on 3 November, and is it still true?',
    );
    expect(result.intent).toBe('recall_reverify');
    expect(result.diff.length).toBeGreaterThanOrEqual(4);
    expect(result.diff.filter((row) => row.verdict === 'changed').length).toBeGreaterThanOrEqual(2);
    expect(result.diff.filter((row) => row.verdict === 'unchanged').length).toBeGreaterThanOrEqual(1);
    expect(result.diff.filter((row) => row.verdict === 'unclear').length).toBeGreaterThanOrEqual(1);
    expect(result.assistantTurn.text).toContain('Re-checked today');
    expect(result.assistantTurn.text).toContain('Neon');
    expect(result.grounding.rejected).toBe(0);
    expect(result.grounding.verified).toBeGreaterThan(0);
    expect(
      citationsAreGrounded(
        result.assistantTurn.citations,
        result.assistantTurn.sources,
        result.assistantTurn.text,
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === 'diff')).toBe(true);
    expect(result.assistantTurn.meta?.recallUserTurnIds).toHaveLength(2);
  });

  it('reports no change when the stored HubSpot price still holds', async () => {
    const { result } = await run('Has HubSpot changed its price since Monday?');
    expect(result.intent).toBe('reverify');
    expect(result.diff.length).toBeGreaterThan(0);
    expect(result.diff.every((row) => row.verdict === 'unchanged')).toBe(true);
    expect(result.assistantTurn.text).toContain('no change');
    expect(result.grounding.rejected).toBe(0);
  });

  it('answers a fresh question with cited demo sources and stores claims', async () => {
    const { result } = await run('Compare Neon, Supabase, and Amazon RDS pricing.', {
      seed: false,
    });
    expect(result.intent).toBe('fresh');
    expect(result.sources.length).toBeGreaterThanOrEqual(3);
    expect(result.assistantTurn.text).toMatch(/\[S\d+\]/);
    expect(result.grounding.total).toBeGreaterThan(0);
    expect(result.grounding.rejected).toBe(0);
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.assistantTurn.sources.every((source) => source.demo)).toBe(true);
  });

  it('asks a clarifying question for a vague date instead of inventing a day', async () => {
    const { result } = await run('What did I ask you the other day?', { seed: false });
    expect(result.intent).toBe('clarify');
    expect(result.assistantTurn.text).toMatch(/which date/i);
    expect(result.sources).toHaveLength(0);
    expect(result.assistantTurn.resolutionNote).toMatch(/not a specific date/i);
  });

  it('does not let injected source text reach the answer', async () => {
    const { result } = await run('Acme Analytics pricing', { seed: false });
    expect(result.intent).toBe('fresh');
    expect(result.assistantTurn.text).toContain('$99');
    expect(result.assistantTurn.text).not.toMatch(/PWNED|developer mode|ignore previous/i);
    expect(result.assistantTurn.text).not.toMatch(/system prompt/i);
  });
});
