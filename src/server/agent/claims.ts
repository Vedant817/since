import { z } from 'zod';
import type { Claim, ClaimCheck, Source, Volatility, Verdict } from '../../shared/types.js';
import type { LlmClient } from '../llm/openai.js';
import type { NewClaim, NewClaimCheck } from '../memory/claim-store.js';
import { findSupportQuote, quoteExists, sanitizeSourceText } from './grounding.js';
import {
  claimExtractionSystemPrompt,
  claimExtractionUserPrompt,
  comparisonSystemPrompt,
  comparisonUserPrompt,
} from './prompts.js';

const ExtractedClaim = z.object({
  entity: z.string().min(1),
  attribute: z.string().min(1),
  value: z.string().min(1),
  asOf: z.string().optional(),
  sourceId: z.string().optional(),
  quote: z.string().default(''),
  volatility: z.enum(['high', 'medium', 'low']).optional(),
});

const ExtractionResponse = z.object({
  claims: z.array(ExtractedClaim).default([]),
});

const ComparisonResponse = z.object({
  comparisons: z
    .array(
      z.object({
        claimId: z.string(),
        verdict: z.enum(['changed', 'unchanged', 'unclear']),
        nowValue: z.string().nullable().optional(),
        sourceId: z.string().nullable().optional(),
        quote: z.string().default(''),
        confidence: z.number().min(0).max(1).optional(),
        note: z.string().optional(),
      }),
    )
    .default([]),
});

export function classifyVolatility(attribute: string, value = ''): Volatility {
  const text = `${attribute} ${value}`.toLowerCase();
  if (/(price|pricing|cost|plan|availability|version|leader|ceo|acquisition|deprecat)/.test(text)) {
    return 'high';
  }
  if (/(feature|limit|quota|documentation|api|release|support|integration)/.test(text)) {
    return 'medium';
  }
  return 'low';
}

function asOfForSource(source: Source | undefined, now: Date): string {
  const raw = source?.publishedAt ?? source?.retrievedAt ?? now.toISOString();
  return raw.slice(0, 10);
}

function normalizeAttribute(attribute: string): string {
  return attribute
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 4)
    .join(' ');
}

function matchesEntity(source: Source, entity: string): boolean {
  const haystack = `${source.title} ${source.content}`.toLowerCase();
  return haystack.includes(entity.toLowerCase());
}

export interface ClaimExtractionResult {
  claims: NewClaim[];
  rejected: number;
}

export async function extractClaims(input: {
  answer: string;
  sources: Source[];
  turnId: string;
  knownEntities: string[];
  llm?: LlmClient | null;
  now: Date;
  signal?: AbortSignal;
}): Promise<ClaimExtractionResult> {
  if (input.llm) {
    try {
      const response = await input.llm.completeJson({
        system: claimExtractionSystemPrompt(),
        user: claimExtractionUserPrompt({
          answer: input.answer,
          sources: input.sources,
          now: input.now,
        }),
        schema: ExtractionResponse,
        model: 'fast',
        temperature: 0,
        maxTokens: 1600,
        signal: input.signal,
      });
      const sourceMap = new Map(input.sources.map((source) => [source.id, source]));
      const claims: NewClaim[] = [];
      const seen = new Set<string>();
      let rejected = 0;
      for (const item of response.claims ?? []) {
        const source = item.sourceId ? sourceMap.get(item.sourceId) : undefined;
        const quote = item.quote?.trim() ?? '';
        if (!source || !quote || !quoteExists(quote, source.content)) {
          rejected += 1;
          continue;
        }
        const entity = item.entity.trim();
        const attribute = normalizeAttribute(item.attribute);
        const key = `${entity.toLowerCase()}::${attribute}`;
        if (seen.has(key)) continue;
        seen.add(key);
        claims.push({
          turnId: input.turnId,
          entity,
          attribute,
          value: item.value.trim().slice(0, 500),
          asOf: item.asOf && /^\d{4}-\d{2}-\d{2}/.test(item.asOf)
            ? item.asOf.slice(0, 10)
            : asOfForSource(source, input.now),
          sourceUrl: source.url,
          quote: quote.slice(0, 800),
          volatility: item.volatility ?? classifyVolatility(attribute, item.value),
        });
        if (claims.length >= 12) break;
      }
      if (claims.length > 0) return { claims, rejected };
      // An empty extraction is a legitimate outcome, but a contract failure is
      // not. Fall through only when nothing at all was usable.
    } catch {
      // Deterministic extraction keeps memory useful even when the fast call fails.
    }
  }

  return extractClaimsHeuristic(input);
}

export function extractClaimsHeuristic(input: {
  answer: string;
  sources: Source[];
  turnId: string;
  knownEntities: string[];
  now: Date;
}): ClaimExtractionResult {
  const sourceMap = new Map(input.sources.map((source) => [source.id, source]));
  const claims: NewClaim[] = [];
  const seen = new Set<string>();
  let rejected = 0;

  for (const line of input.answer.split('\n')) {
    const sourceIds = [...line.matchAll(/\[(S\d+)\]/g)].map((match) => match[1] ?? '');
    if (sourceIds.length === 0) continue;
    for (const sourceId of sourceIds) {
      const source = sourceMap.get(sourceId);
      if (!source) {
        rejected += 1;
        continue;
      }
      const entity =
        input.knownEntities.find((candidate) => matchesEntity(source, candidate)) ??
        input.knownEntities.find((candidate) => line.toLowerCase().includes(candidate.toLowerCase())) ??
        source.title.split(/[:—–-]/)[0]?.trim() ??
        'Unknown';
      const cleanLine = sanitizeSourceText(line.replace(/\[S\d+\]/g, ''));
      const quote = findSupportQuote(cleanLine, source.content) ?? cleanLine;
      if (!quoteExists(quote, source.content)) {
        rejected += 1;
        continue;
      }
      const lower = `${cleanLine} ${source.title}`.toLowerCase();
      const attribute = /(\$|price|pricing|cost|per user|per month|per hour)/.test(lower)
        ? 'pricing'
        : /(launch|release|available|announce|feature|agent|inbox)/.test(lower)
          ? 'features'
          : 'availability';
      const key = `${entity.toLowerCase()}::${attribute}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const value =
        cleanLine.length > 240 ? `${cleanLine.slice(0, 237)}…` : cleanLine.trim();
      claims.push({
        turnId: input.turnId,
        entity,
        attribute,
        value,
        asOf: asOfForSource(source, input.now),
        sourceUrl: source.url,
        quote: quote.slice(0, 800),
        volatility: classifyVolatility(attribute, value),
      });
      if (claims.length >= 12) return { claims, rejected };
    }
  }
  return { claims, rejected };
}

export interface ComparisonResult {
  check: NewClaimCheck;
  note?: string;
}

function extractAmounts(text: string): number[] {
  return [...text.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
}

function relevantSentences(claim: Claim, source: Source): string[] {
  const sentences = sanitizeSourceText(source.content)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);
  const attribute = claim.attribute.toLowerCase();
  return sentences.filter((sentence) => {
    const lower = sentence.toLowerCase();
    if (attribute.includes('pric') || attribute.includes('cost') || attribute.includes('plan')) {
      return /\$|price|pricing|cost|per user|per month|per hour|remains|unchanged|up from/.test(lower);
    }
    if (attribute.includes('feature') || attribute.includes('avail') || attribute.includes('release')) {
      return /launch|release|available|announce|feature|agent|inbox|remains|unchanged|now/.test(
        lower,
      );
    }
    return true;
  });
}

function overlapScore(claim: Claim, sentence: string): number {
  const claimTokens = new Set(
    `${claim.entity} ${claim.attribute} ${claim.value}`
      .toLowerCase()
      .replace(/[^a-z0-9$.\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
  const sentenceTokens = new Set(
    sentence
      .toLowerCase()
      .replace(/[^a-z0-9$.\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
  let shared = 0;
  for (const token of claimTokens) if (sentenceTokens.has(token)) shared += 1;
  return claimTokens.size > 0 ? shared / claimTokens.size : 0;
}

export function compareClaimsHeuristic(
  claims: Claim[],
  sources: Source[],
  now: Date,
): ComparisonResult[] {
  const results: ComparisonResult[] = [];
  for (const claim of claims) {
    const candidates = sources.filter((source) => matchesEntity(source, claim.entity));
    if (candidates.length === 0) {
      results.push({
        check: {
          claimId: claim.id,
          verdict: 'unclear',
          thenValue: claim.value,
          confidence: 0.2,
          checkedAt: now.toISOString(),
        },
        note: 'No source in the evidence set mentioned this entity.',
      });
      continue;
    }

    const sentences = candidates.flatMap((source) =>
      relevantSentences(claim, source).map((sentence) => ({ sentence, source })),
    );
    if (sentences.length === 0) {
      results.push({
        check: {
          claimId: claim.id,
          verdict: 'unclear',
          thenValue: claim.value,
          confidence: 0.2,
          checkedAt: now.toISOString(),
        },
        note: 'Relevant sources did not state a checkable value.',
      });
      continue;
    }

    const ranked = sentences
      .map((item) => ({ ...item, overlap: overlapScore(claim, item.sentence) }))
      .sort((a, b) => b.overlap - a.overlap);
    const best = ranked[0]!;
    const sentenceLower = best.sentence.toLowerCase();
    const oldAmounts = extractAmounts(claim.value);
    const newAmounts = extractAmounts(best.sentence);
    const oldAmount = oldAmounts[0];
    const newAmount = newAmounts[0];
    const hasDate = Boolean(best.source.publishedAt);
    const explicitlyChanged =
      /(now|up from|raised|increased|increase|new price|updated|has changed|changed to)/.test(
        sentenceLower,
      );
    const explicitlyUnchanged =
      /(unchanged|has not changed|no change|remains|still costs|same price|holds at)/.test(
        sentenceLower,
      );

    if (oldAmount !== undefined) {
      if (
        newAmount !== undefined &&
        newAmount !== oldAmount &&
        (explicitlyChanged || newAmounts.includes(oldAmount))
      ) {
        results.push({
          check: {
            claimId: claim.id,
            verdict: hasDate || explicitlyChanged ? 'changed' : 'unclear',
            thenValue: claim.value,
            newValue: best.sentence,
            sourceUrl: best.source.url,
            quote: best.sentence,
            confidence: hasDate ? 0.9 : 0.6,
            sourceIds: [best.source.id],
            checkedAt: now.toISOString(),
          },
          note: hasDate ? undefined : 'The source had no publication date; retrieved today.',
        });
        continue;
      }
      if (newAmount === oldAmount && explicitlyUnchanged) {
        results.push({
          check: {
            claimId: claim.id,
            verdict: 'unchanged',
            thenValue: claim.value,
            newValue: claim.value,
            sourceUrl: best.source.url,
            quote: best.sentence,
            confidence: 0.88,
            sourceIds: [best.source.id],
            checkedAt: now.toISOString(),
          },
        });
        continue;
      }
    }

    if (explicitlyUnchanged && !explicitlyChanged) {
      results.push({
        check: {
          claimId: claim.id,
          verdict: 'unchanged',
          thenValue: claim.value,
          newValue: claim.value,
          sourceUrl: best.source.url,
          quote: best.sentence,
          confidence: 0.72,
          sourceIds: [best.source.id],
          checkedAt: now.toISOString(),
        },
      });
      continue;
    }

    if (
      /(now generally available|generally available|launched|released|announced|now included)/.test(
        sentenceLower,
      ) &&
      !/remains|unchanged/.test(sentenceLower)
    ) {
      results.push({
        check: {
          claimId: claim.id,
          verdict: 'changed',
          thenValue: claim.value,
          newValue: best.sentence,
          sourceUrl: best.source.url,
          quote: best.sentence,
          confidence: hasDate ? 0.68 : 0.5,
          sourceIds: [best.source.id],
          checkedAt: now.toISOString(),
        },
        note: hasDate ? undefined : 'The source had no publication date; retrieved today.',
      });
      continue;
    }

    results.push({
      check: {
        claimId: claim.id,
        verdict: 'unclear',
        thenValue: claim.value,
        confidence: 0.35,
        sourceIds: [best.source.id],
        checkedAt: now.toISOString(),
      },
      note: 'The evidence did not explicitly confirm or contradict the old value.',
    });
  }
  return results;
}

export async function compareClaims(input: {
  claims: Claim[];
  sources: Source[];
  now: Date;
  llm?: LlmClient | null;
  signal?: AbortSignal;
}): Promise<ComparisonResult[]> {
  if (input.llm) {
    try {
      const response = await input.llm.completeJson({
        system: comparisonSystemPrompt(),
        user: comparisonUserPrompt({
          claims: input.claims,
          sources: input.sources,
          now: input.now,
        }),
        schema: ComparisonResponse,
        model: 'fast',
        temperature: 0,
        maxTokens: 1800,
        signal: input.signal,
      });
      const sourceMap = new Map(input.sources.map((source) => [source.id, source]));
      const byId = new Map(input.claims.map((claim) => [claim.id, claim]));
      const results: ComparisonResult[] = [];
      for (const item of response.comparisons ?? []) {
        const claim = byId.get(item.claimId);
        if (!claim) continue;
        const source = item.sourceId ? sourceMap.get(item.sourceId) : undefined;
        let verdict: Verdict = item.verdict;
        let quote = item.quote?.trim() ?? '';
        if ((verdict === 'changed' || verdict === 'unchanged') && (!source || !quoteExists(quote, source.content))) {
          verdict = 'unclear';
          quote = '';
        }
        results.push({
          check: {
            claimId: claim.id,
            verdict,
            thenValue: claim.value,
            newValue: verdict === 'unclear' ? undefined : item.nowValue?.trim() || claim.value,
            sourceUrl: verdict === 'unclear' ? undefined : source?.url,
            quote: verdict === 'unclear' ? undefined : quote,
            confidence: item.confidence ?? 0.6,
            sourceIds: source ? [source.id] : [],
            checkedAt: input.now.toISOString(),
          },
          note: item.note,
        });
      }
      const answered = new Set(results.map((result) => result.check.claimId));
      const missing = input.claims.filter((claim) => !answered.has(claim.id));
      if (missing.length > 0) {
        results.push(...compareClaimsHeuristic(missing, input.sources, input.now));
      }
      if (results.length > 0) return results;
    } catch {
      // Fall back to the deterministic comparison.
    }
  }
  return compareClaimsHeuristic(input.claims, input.sources, input.now);
}

export function summarizeCheck(check: NewClaimCheck): string {
  if (check.verdict === 'changed') return 'Changed';
  if (check.verdict === 'unchanged') return 'No change found';
  return 'Unclear';
}
