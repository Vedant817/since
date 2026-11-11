import type {
  Citation,
  Claim,
  DiffRow,
  GroundingReport,
  RecallHit,
  Source,
} from '../../shared/types.js';
import type { LlmClient } from '../llm/openai.js';
import {
  splitSentences,
  sanitizeSourceText,
  quoteExists,
} from './grounding.js';
import { synthesisSystemPrompt, synthesisUserPrompt } from './prompts.js';
import { formatShortDate } from './timezone.js';

function clip(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function cleanStoredAnswer(value: string, max: number): string {
  return clip(
    value
      .replace(/\[S\d+\]\s*/g, '')
      .replace(/\s+([.,;:!?])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim(),
    max,
  );
}

function sourceDate(source: Source): string {
  return source.publishedAt
    ? formatShortDate(new Date(source.publishedAt), 'UTC')
    : 'retrieved today';
}

function findPricingSentence(source: Source): string | undefined {
  const clean = sanitizeSourceText(source.content);
  const sentences = clean.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim());
  return sentences.find(
    (sentence) =>
      /\$\s?\d/.test(sentence) &&
      /(price|pricing|cost|per user|per month|per hour|plan|remains|unchanged)/i.test(sentence),
  );
}

function findFeatureSentence(source: Source): string | undefined {
  const clean = sanitizeSourceText(source.content);
  const sentences = clean.split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim());
  return sentences.find(
    (sentence) =>
      /(launch|released|generally available|announced|now included|now available|shipped)/i.test(
        sentence,
      ) && !/\$/.test(sentence),
  );
}

function isPricingChanged(quote: string): boolean {
  if (/(unchanged|has not changed|no pricing change|remains|holds at|same price)/i.test(quote)) {
    return false;
  }
  return /(up from|raised|increased|now costs|now \$\d|price change|updated .* pricing)/i.test(
    quote,
  );
}

function isPricingUnchanged(quote: string): boolean {
  return /(unchanged|has not changed|no pricing change|remains|holds at|same price)/i.test(quote);
}

export interface DeterministicAnswer {
  text: string;
  citations: Citation[];
  report: GroundingReport;
}

export function renderDemoFreshAnswer(input: {
  sources: Source[];
  entities: string[];
  rangeLabel?: string;
  timezone: string;
  message: string;
}): DeterministicAnswer {
  const meaningful = input.sources.filter((source) => !source.url.includes('/demo-mode'));
  if (meaningful.length === 0) {
    const text =
      'Live web search is not configured in this build, so I cannot answer that question. Add `OPENAI_API_KEY` and `TAVILY_API_KEY` to `.env`, restart, and ask again. The demo corpus only covers a small CRM shortlist and managed Postgres providers.';
    return {
      text,
      citations: [],
      report: { total: 0, verified: 0, rejected: 0, rejectionRate: 0 },
    };
  }

  const citations: Citation[] = [];
  const citationMap = new Map<string, string>();
  const blocks: string[] = [];
  const scope =
    input.entities.length > 0
      ? input.entities.slice(0, 6)
      : meaningful.slice(0, 4).map((source) => source.title.split(/[:—–-]/)[0] ?? source.title);
  const range = input.rangeLabel ? ` since ${input.rangeLabel}` : '';

  for (const entity of scope) {
    const source =
      meaningful.find((candidate) =>
        `${candidate.title} ${candidate.content}`.toLowerCase().includes(entity.toLowerCase()),
      ) ?? meaningful.find((candidate) => candidate.title.toLowerCase().includes(entity.toLowerCase()));
    if (!source) continue;

    const pricing = findPricingSentence(source);
    const feature = findFeatureSentence(source);
    const changed = pricing ? isPricingChanged(pricing) : false;
    const unchanged = pricing ? isPricingUnchanged(pricing) : false;
    const status: string[] = [];
    if (changed) status.push('pricing changed');
    else if (unchanged) status.push('pricing unchanged');
    if (feature) status.push('shipped something');
    if (status.length === 0) status.push('update found');

    const lines: string[] = [`**${entity}** — ${status.join(', ')} [${source.id}]`];
    if (pricing) {
      lines.push(`- Pricing: “${clip(pricing, 300)}” [${source.id}] (${sourceDate(source)})`);
      citationMap.set(source.id, pricing);
    }
    if (feature && feature !== pricing) {
      lines.push(`- Shipped: “${clip(feature, 300)}” [${source.id}] (${sourceDate(source)})`);
      if ((citationMap.get(source.id)?.length ?? 0) < feature.length) {
        citationMap.set(source.id, feature);
      }
    }
    blocks.push(lines.join('\n'));
  }

  if (blocks.length === 0) {
    for (const source of meaningful.slice(0, 4)) {
      const clean = sanitizeSourceText(source.content);
      const quote = findPricingSentence(source) ?? findFeatureSentence(source) ?? clip(clean, 240);
      blocks.push(`**${source.title}** [${source.id}]\n“${clip(quote, 300)}” (${sourceDate(source)})`);
      citationMap.set(source.id, quote);
    }
  }

  const intro =
    input.entities.length > 0
      ? `I checked current sources for **${input.entities.length}** ${input.entities.length === 1 ? 'entity' : 'entities'}${range}.`
      : 'Here is what the sources I checked say.';
  const text = `${intro}\n\n${blocks.join('\n\n')}`;

  for (const [sourceId, quote] of citationMap) citations.push({ sourceId, quote });
  let verified = 0;
  for (const citation of citations) {
    const source = input.sources.find((candidate) => candidate.id === citation.sourceId);
    if (source && citation.quote && quoteExists(citation.quote, source.content)) verified += 1;
  }
  const total = citations.length;

  return {
    text,
    citations,
    report: {
      total,
      verified,
      rejected: total - verified,
      rejectionRate: total > 0 ? (total - verified) / total : 0,
    },
  };
}

export async function streamLiveAnswer(input: {
  llm: LlmClient;
  message: string;
  sources: Source[];
  entities: string[];
  resolutionNote?: string;
  now: Date;
  timezone: string;
  signal?: AbortSignal;
  onDelta: (delta: string) => void | Promise<void>;
}): Promise<string> {
  let draft = '';
  const stream = input.llm.streamText({
    system: synthesisSystemPrompt(input.now, input.timezone),
    user: synthesisUserPrompt({
      message: input.message,
      sources: input.sources,
      resolutionNote: input.resolutionNote,
      entities: input.entities,
      intent: 'fresh',
    }),
    model: 'smart',
    temperature: 0.25,
    maxTokens: 1500,
    signal: input.signal,
  });
  for await (const delta of stream) {
    draft += delta;
    await input.onDelta(delta);
  }
  return draft.trim();
}

export function renderRecallAnswer(input: {
  recall: RecallHit[];
  rangeLabel?: string;
  timezone: string;
}): DeterministicAnswer {
  if (input.recall.length === 0) {
    const text = input.rangeLabel
      ? `I do not have a recorded conversation on ${input.rangeLabel}. I will not invent one.`
      : 'I could not find an earlier conversation that matches that question.';
    return {
      text,
      citations: [],
      report: { total: 0, verified: 0, rejected: 0, rejectionRate: 0 },
    };
  }

  const dateLabel =
    input.rangeLabel ??
    formatShortDate(new Date(input.recall[0]!.userTurn.createdAt), input.timezone);
  const items = input.recall.slice(0, 10).map((hit, index) => {
    const question = clip(hit.userTurn.text, 700);
    const answer = hit.answerTurn ? cleanStoredAnswer(hit.answerTurn.text, 320) : '';
    return `${index + 1}. **“${question}”**${answer ? `\n   I answered: “${answer}”` : ''}`;
  });
  return {
    text: `## From your conversation on ${dateLabel}\n\nOn ${dateLabel} you asked:\n\n${items.join('\n')}`,
    citations: [],
    report: { total: 0, verified: 0, rejected: 0, rejectionRate: 0 },
  };
}

function sourceIdForUrl(sources: Source[], url: string | undefined): string | undefined {
  if (!url) return undefined;
  return sources.find((source) => source.url === url)?.id;
}

export function renderVerificationAnswer(input: {
  recall: RecallHit[];
  rangeLabel?: string;
  checks: DiffRow[];
  claims: Claim[];
  sources: Source[];
  now: Date;
  timezone: string;
}): DeterministicAnswer {
  const parts: string[] = [];
  const citations: Citation[] = [];
  const citationMap = new Map<string, string>();

  if (input.recall.length > 0) {
    const first = input.recall[0]!.userTurn.createdAt;
    const dateLabel = input.rangeLabel ?? formatShortDate(new Date(first), input.timezone);
    parts.push(`## From your conversation on ${dateLabel}`);
    parts.push(`On ${dateLabel} you asked:`);
    const items = input.recall.slice(0, 8).map((hit, index) => {
      const question = clip(hit.userTurn.text, 700);
      const answer = hit.answerTurn ? cleanStoredAnswer(hit.answerTurn.text, 280) : '';
      return `${index + 1}. **“${question}”**${answer ? `\n   I answered: “${answer}”` : ''}`;
    });
    parts.push(items.join('\n'));
  } else if (input.rangeLabel) {
    parts.push(`I do not have a recorded conversation on ${input.rangeLabel}. I will not invent one.`);
  }

  if (input.checks.length > 0) {
    const changed = input.checks.filter((check) => check.verdict === 'changed').length;
    const unchanged = input.checks.filter((check) => check.verdict === 'unchanged').length;
    const unclear = input.checks.filter((check) => check.verdict === 'unclear').length;
    parts.push('## Re-checked today');
    parts.push(
      `I checked ${input.checks.length} stored ${input.checks.length === 1 ? 'claim' : 'claims'} against sources retrieved today: **${changed} changed**, **${unchanged} no change found**, **${unclear} unclear**.`,
    );
    const rows = input.checks.slice(0, 10).map((check) => {
      const sourceId = sourceIdForUrl(input.sources, check.nowSourceUrl);
      let nowCell = 'Unclear — no dated source stated a checkable value';
      if (check.verdict === 'changed') {
        nowCell = `${clip(check.nowValue ?? 'Changed', 180)}${sourceId ? ` [${sourceId}]` : ''}`;
      } else if (check.verdict === 'unchanged') {
        nowCell = `No change found in sources checked today${sourceId ? ` [${sourceId}]` : ''}`;
      }
      const sourcedQuote =
        sourceId && check.quote
          ? input.sources.find((candidate) => candidate.id === sourceId)
          : undefined;
      const quoteIsValid = Boolean(
        sourcedQuote && check.quote && quoteExists(check.quote, sourcedQuote.content),
      );
      if (sourceId && check.quote && quoteIsValid) {
        citationMap.set(sourceId, check.quote);
      } else {
        nowCell = nowCell.replace(` [${sourceId}]`, '');
      }
      return `| ${check.entity} · ${check.attribute} | ${clip(check.thenValue, 120)} | ${nowCell} |`;
    });
    parts.push('| Item | Then | Now |\n| --- | --- | --- |');
    parts.push(...rows);
    if (unclear > 0) {
      parts.push(
        'Unclear is a real answer here: the sources I checked did not state a current value I could verify.',
      );
    }
  } else if (input.recall.length > 0) {
    parts.push(
      'I do not have stored claims from that answer, so there is nothing concrete to re-check. Ask a fresh question and I will store checkable claims from this answer onward.',
    );
  }

  for (const [sourceId, quote] of citationMap) citations.push({ sourceId, quote });
  const text = parts.filter(Boolean).join('\n\n').trim();
  const verified = citations.filter((citation) => {
    const source = input.sources.find((candidate) => candidate.id === citation.sourceId);
    return Boolean(source && citation.quote && quoteExists(citation.quote, source.content));
  }).length;
  const total = citations.length;

  return {
    text,
    citations,
    report: {
      total,
      verified,
      rejected: total - verified,
      rejectionRate: total > 0 ? (total - verified) / total : 0,
    },
  };
}
