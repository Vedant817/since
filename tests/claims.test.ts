import { describe, expect, it } from 'vitest';
import type { Claim, Source } from '../src/shared/types.js';
import {
  classifyVolatility,
  compareClaimsHeuristic,
  extractClaimsHeuristic,
} from '../src/server/agent/claims.js';

const NOW = new Date('2026-11-11T04:30:00.000Z');

function claim(overrides: Partial<Claim> = {}): Claim {
  return {
    id: 'claim-1',
    turnId: 'turn-1',
    entity: 'Neon',
    attribute: 'pricing',
    value: '$19 per month (Launch plan, includes 100 GB storage and 300 compute hours)',
    asOf: '2026-11-03',
    sourceUrl: 'https://demo.since.local/neon/launch-pricing',
    quote: 'The Neon Launch plan costs $19 per month',
    volatility: 'high',
    status: 'active',
    createdAt: '2026-11-03T03:42:00.000Z',
    ...overrides,
  };
}

function source(overrides: Partial<Source> = {}): Source {
  return {
    id: 'S1',
    title: 'Neon updates Launch plan pricing',
    url: 'https://demo.since.local/neon/launch-pricing',
    domain: 'demo.since.local',
    publishedAt: '2026-11-11T09:00:00.000Z',
    retrievedAt: '2026-11-11T10:00:00.000Z',
    content:
      'Neon posted a pricing change for its managed Postgres Launch plan. "The Launch plan is now $24 per month, up from $19 per month." The plan still includes 100 GB of storage and 300 compute hours.',
    demo: true,
    ...overrides,
  };
}

describe('claim classification', () => {
  it('marks prices and availability as high volatility', () => {
    expect(classifyVolatility('pricing')).toBe('high');
    expect(classifyVolatility('availability')).toBe('high');
  });

  it('marks features and limits as medium volatility', () => {
    expect(classifyVolatility('features')).toBe('medium');
    expect(classifyVolatility('rate limit')).toBe('medium');
  });

  it('defaults to low volatility for durable facts', () => {
    expect(classifyVolatility('founded')).toBe('low');
  });
});

describe('claim comparison', () => {
  it('detects a changed price and keeps the supporting quote', () => {
    const [result] = compareClaimsHeuristic([claim()], [source()], NOW);
    expect(result).toBeDefined();
    expect(result!.check.verdict).toBe('changed');
    expect(result!.check.newValue).toContain('$24');
    expect(result!.check.quote).toContain('up from $19');
    expect(result!.check.sourceUrl).toBe('https://demo.since.local/neon/launch-pricing');
    expect(result!.check.confidence).toBeGreaterThan(0.8);
  });

  it('detects an explicitly unchanged price', () => {
    const unchangedSource = source({
      id: 'S2',
      title: 'Supabase Pro plan pricing unchanged',
      url: 'https://demo.since.local/supabase/pro-plan',
      content:
        'The Supabase Pro plan remains $25 per month and has not changed. It includes 8 GB of database space.',
    });
    const supabase = claim({
      entity: 'Supabase',
      value: '$25 per month (Pro plan, includes 8 GB database space)',
      sourceUrl: 'https://demo.since.local/supabase/pro-plan',
      quote: 'The Supabase Pro plan costs $25 per month',
    });
    const [result] = compareClaimsHeuristic([supabase], [unchangedSource], NOW);
    expect(result!.check.verdict).toBe('unchanged');
    expect(result!.check.quote).toContain('remains $25');
  });

  it('returns unclear when no source mentions the entity', () => {
    const [result] = compareClaimsHeuristic([claim()], [], NOW);
    expect(result!.check.verdict).toBe('unclear');
    expect(result!.note).toMatch(/no source/i);
  });

  it('returns unclear rather than inventing a change', () => {
    const vagueSource = source({
      content: 'Neon published a blog post about its engineering culture.',
    });
    const [result] = compareClaimsHeuristic([claim()], [vagueSource], NOW);
    expect(result!.check.verdict).toBe('unclear');
  });
});

describe('claim extraction', () => {
  it('extracts a checkable claim only when the quote exists in the source', () => {
    const result = extractClaimsHeuristic({
      answer:
        '**Neon** — “The Neon Launch plan costs $19 per month and includes 100 GB of storage.” [S1]',
      sources: [
        source({
          content:
            'The Neon Launch plan costs $19 per month and includes 100 GB of storage. Branching is available.',
        }),
      ],
      turnId: 'turn-1',
      knownEntities: ['Neon'],
      now: NOW,
    });
    expect(result.rejected).toBe(0);
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.entity).toBe('Neon');
    expect(result.claims[0]?.attribute).toBe('pricing');
    expect(result.claims[0]?.quote).toContain('$19 per month');
    expect(result.claims[0]?.volatility).toBe('high');
  });

  it('rejects a cited claim whose quote is not in the source', () => {
    const result = extractClaimsHeuristic({
      answer: '**Neon** — “Neon costs $999 per month for the Launch plan.” [S1]',
      sources: [source()],
      turnId: 'turn-1',
      knownEntities: ['Neon'],
      now: NOW,
    });
    expect(result.claims).toHaveLength(0);
    expect(result.rejected).toBeGreaterThan(0);
  });
});
