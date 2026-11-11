import { z } from 'zod';
import type { Citation, GroundingReport, Source } from '../../shared/types.js';
import type { LlmClient } from '../llm/openai.js';
import {
  citationVerifierSystemPrompt,
  citationVerifierUserPrompt,
} from './prompts.js';

const CitationVerifierResponse = z.object({
  citations: z.array(
    z.object({
      sentence: z.number().int().min(0),
      sourceId: z.string(),
      quote: z.string().default(''),
      supported: z.boolean().default(false),
    }),
  ),
});

const INSTRUCTION_PATTERNS = [
  /ignore (all )?(previous|prior|above|earlier) instructions/i,
  /disregard (all )?(previous|prior|above|earlier) instructions/i,
  /you are now (in )?(developer|dan|jailbreak|admin) mode/i,
  /system prompt/i,
  /reveal (your|the) (prompt|instructions|secrets)/i,
  /reply with (pwned|hacked|owned)/i,
  /print (your|the) (prompt|instructions)/i,
  /follow these instructions/i,
];

export function sanitizeSourceText(text: string): string {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((part) => part.trim().length > 0)
    .filter((part) => !INSTRUCTION_PATTERNS.some((pattern) => pattern.test(part)))
    .join(' ')
    .replace(/\bPWNED\b/gi, '[removed]');
}

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`>#]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function quoteExists(quote: string, content: string): boolean {
  const normalizedQuote = normalizeForMatch(quote);
  if (normalizedQuote.length < 8) return false;
  return normalizeForMatch(sanitizeSourceText(content)).includes(normalizedQuote);
}

export function splitSentences(line: string): string[] {
  if (!line.trim()) return [line];
  if (/^\s*(\||#|[-*]\s|\d+\.\s)/.test(line)) return [line];
  try {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    return [...segmenter.segment(line)].map((segment) => segment.segment);
  } catch {
    return line.split(/(?<=[.!?])\s+/);
  }
}

export function extractCitations(text: string): string[] {
  const matches = text.matchAll(/\[(S\d+)\]/g);
  return [...new Set([...matches].map((match) => match[1] ?? '').filter(Boolean))];
}

export function stripCitations(text: string): string {
  return text.replace(/\s*\[S\d+\]/g, '').replace(/[ \t]+\n/g, '\n').trim();
}

function tokenSet(text: string): Set<string> {
  return new Set(
    normalizeForMatch(text)
      .split(' ')
      .filter((token) => token.length > 2),
  );
}

export function currencyAmounts(text: string): string[] {
  return [...text.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)].map((match) =>
    (match[1] ?? '').replace(/,/g, '').replace(/\.0+$/, ''),
  );
}

export function amountsSupported(claimText: string, quote: string): boolean {
  const needed = currencyAmounts(claimText);
  if (needed.length === 0) return true;
  const available = new Set(currencyAmounts(quote));
  return needed.every((amount) => available.has(amount));
}

export function findSupportQuote(sentence: string, content: string): string | undefined {
  const quoted = sentence.match(/[“"]([^”"]{20,240})[”"]/);
  if (quoted?.[1] && quoteExists(quoted[1], content)) return quoted[1];

  const sourceSentences: string[] = [];
  for (const part of content.split(/(?<=[.!?])\s+|\n+/)) {
    const trimmed = part.trim();
    if (trimmed.length <= 20 || INSTRUCTION_PATTERNS.some((p) => p.test(trimmed))) continue;
    // A quoted span inside a longer run of text is the strongest support: it is
    // the exact claim the source is making. Offer it before the surrounding run
    // so equal lexical overlap prefers the tighter quote.
    for (const match of trimmed.matchAll(/[“"]([^”"]{20,240})[”"]/g)) {
      const inner = match[1]?.trim();
      if (inner) sourceSentences.push(inner);
    }
    sourceSentences.push(trimmed);
  }
  const wanted = tokenSet(stripCitations(sentence));
  if (wanted.size === 0) return undefined;

  const ranked: Array<{ sentence: string; overlap: number }> = [];
  for (const candidate of sourceSentences) {
    const tokens = tokenSet(candidate);
    let shared = 0;
    for (const token of wanted) if (tokens.has(token)) shared += 1;
    ranked.push({ sentence: candidate, overlap: shared / wanted.size });
  }
  ranked.sort((a, b) => b.overlap - a.overlap);
  const best = ranked.find(
    (candidate) =>
      candidate.overlap >= 0.55 && amountsSupported(sentence, candidate.sentence),
  );
  return best?.sentence;
}

export interface GroundingInput {
  draft: string;
  sources: Source[];
  llm?: LlmClient | null;
  signal?: AbortSignal;
}

export interface GroundingResult {
  text: string;
  citations: Citation[];
  report: GroundingReport;
  removedSentences: string[];
}

interface SentencePair {
  sentenceIndex: number;
  sentence: string;
  sourceIds: string[];
}

function collectPairs(draft: string): SentencePair[] {
  const pairs: SentencePair[] = [];
  let sentenceIndex = 0;
  for (const line of draft.split('\n')) {
    for (const sentence of splitSentences(line)) {
      const sourceIds = extractCitations(sentence);
      if (sourceIds.length > 0) {
        pairs.push({ sentenceIndex, sentence, sourceIds });
        sentenceIndex += 1;
      }
    }
  }
  return pairs;
}

export async function groundDraft(input: GroundingInput): Promise<GroundingResult> {
  const pairs = collectPairs(input.draft);
  const sourceMap = new Map(input.sources.map((source) => [source.id, source]));
  const verification = new Map<string, { verified: boolean; quote?: string }>();
  const totalPairs = pairs.reduce((sum, pair) => sum + pair.sourceIds.length, 0);

  if (pairs.length > 0 && input.llm) {
    try {
      const response = await input.llm.completeJson({
        system: citationVerifierSystemPrompt(),
        user: citationVerifierUserPrompt({
          sentences: pairs.map((pair) => ({
            index: pair.sentenceIndex,
            text: pair.sentence,
            sourceIds: pair.sourceIds,
          })),
          sources: input.sources,
        }),
        schema: CitationVerifierResponse,
        model: 'fast',
        temperature: 0,
        maxTokens: 1600,
        signal: input.signal,
      });
      for (const entry of response.citations) {
        const source = sourceMap.get(entry.sourceId);
        if (!source) continue;
        const quote = entry.quote?.trim() ?? '';
        const verified =
          entry.supported === true &&
          quote.length > 0 &&
          quoteExists(quote, source.content);
        verification.set(`${entry.sentence}:${entry.sourceId}`, {
          verified,
          quote: verified ? quote : undefined,
        });
      }
    } catch {
      // Fall through to the deterministic lexical check. A verifier outage must
      // not turn into an ungrounded answer.
    }
  }

  const used = new Set<string>();
  const citationQuotes = new Map<string, string>();
  const removedSentences: string[] = [];
  let verifiedPairs = 0;
  let pairCursor = 0;

  const processedLines: string[] = [];
  for (const line of input.draft.split('\n')) {
    const sentences = splitSentences(line);
    const kept: string[] = [];
    for (const sentence of sentences) {
      const sourceIds = extractCitations(sentence);
      if (sourceIds.length === 0) {
        kept.push(sentence);
        continue;
      }
      const pair = pairs[pairCursor];
      pairCursor += 1;
      if (!pair) continue;

      const verifiedIds: string[] = [];
      for (const sourceId of sourceIds) {
        const source = sourceMap.get(sourceId);
        if (!source) continue;
        const key = `${pair.sentenceIndex}:${sourceId}`;
        let quote: string | undefined;
        let verified = false;
        if (verification.has(key)) {
          const entry = verification.get(key);
          verified = entry?.verified ?? false;
          quote = entry?.quote;
        } else {
          quote = findSupportQuote(sentence, source.content);
          verified = Boolean(quote);
        }
        if (!verified) continue;
        verifiedIds.push(sourceId);
        used.add(sourceId);
        verifiedPairs += 1;
        if (
          quote &&
          (!citationQuotes.has(sourceId) || (citationQuotes.get(sourceId)?.length ?? 0) < quote.length)
        ) {
          citationQuotes.set(sourceId, quote);
        }
      }
      if (verifiedIds.length === 0) {
        removedSentences.push(sentence.trim());
        continue;
      }
      let rewritten = sentence;
      for (const sourceId of sourceIds) {
        if (!verifiedIds.includes(sourceId)) {
          rewritten = rewritten.replace(new RegExp(`\\s*\\[${sourceId}\\]`, 'g'), '');
        }
      }
      kept.push(rewritten);
    }
    const joined = kept.join(' ').replace(/\s+([.,;:!?])/g, '$1').trimEnd();
    processedLines.push(joined);
  }

  let text = processedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) text = 'I could not ground a claim in the sources I checked.';

  const citations: Citation[] = [...used].map((sourceId) => ({
    sourceId,
    quote: citationQuotes.get(sourceId),
  }));
  const rejected = totalPairs - verifiedPairs;
  const rejectionRate = totalPairs > 0 ? rejected / totalPairs : 0;

  return {
    text,
    citations,
    report: {
      total: totalPairs,
      verified: verifiedPairs,
      rejected,
      rejectionRate,
    },
    removedSentences,
  };
}

export function citationsAreGrounded(
  citations: Citation[],
  sources: Source[],
  text: string,
): boolean {
  for (const citation of citations) {
    const source = sources.find((candidate) => candidate.id === citation.sourceId);
    if (!source) return false;
    if (!text.includes(`[${citation.sourceId}]`)) return false;
    if (!citation.quote || !quoteExists(citation.quote, source.content)) return false;
  }
  return true;
}
