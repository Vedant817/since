import * as chrono from 'chrono-node';
import { z } from 'zod';
import type { Claim, Intent, RouterOutput, Turn } from '../../shared/types.js';
import type { LlmClient } from '../llm/openai.js';
import { routerPrompt } from './prompts.js';

const RouterResponse = z.object({
  intent: z.enum(['fresh', 'recall', 'reverify', 'recall_reverify', 'clarify']),
  timePhrase: z.string().nullable().optional(),
  entities: z.array(z.string()).default([]),
  queries: z.array(z.string()).default([]),
  clarifyQuestion: z.string().nullable().optional(),
  reason: z.string().optional(),
});

const RECALL_CUE =
  /\b(what did i (ask|say)|what did we (discuss|talk about)|remind me|do you remember|last time i asked|i asked (you )?about|my (question|answer)|you (said|told)|earlier i asked|previous (question|answer)|recall)\b/i;
const REVERIFY_CUE =
  /\b(still|changed|change|update|any news|latest|current|now|today|out of date|accurate|shipped)\b/i;
const HISTORY_CUE =
  /\b(since|last|ago|yesterday|today|this week|this month|this year|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|that|it|them|those|previous|earlier)\b/i;
const PRONOUN_CUE = /\b(them|those|it|that|these|any of them)\b/i;
const VAGUE_CUE = /\b(the other (day|week|month)|recently|lately|a while ago|some time ago)\b/i;

export function inferTimePhrase(message: string): string | undefined {
  const since = message.match(/\bsince\s+(?!then\b|it\b|that\b|now\b)([^?.!]+)/i);
  if (since?.[1]) {
    const fragment = since[1].trim();
    const parsed = chrono.parse(fragment, new Date(), { forwardDate: false });
    if (parsed.length > 0) return `since ${parsed[0]!.text}`;
  }
  const vague = message.match(VAGUE_CUE);
  if (vague?.[0]) return vague[0];
  const results = chrono.parse(message, new Date(), { forwardDate: false });
  if (results.length === 0) return undefined;
  const best = results.reduce((longest, result) =>
    result.text.length > longest.text.length ? result : longest,
  );
  return best.text;
}

function literalEntities(message: string, knownEntities: string[]): string[] {
  const lower = message.toLowerCase();
  return knownEntities
    .filter((entity) => lower.includes(entity.toLowerCase()))
    .slice(0, 8);
}

export function routeHeuristically(input: {
  message: string;
  knownEntities: string[];
  claims: Claim[];
  recentTurns: Turn[];
}): RouterOutput {
  const recall = RECALL_CUE.test(input.message);
  const reverify = REVERIFY_CUE.test(input.message);
  const history = HISTORY_CUE.test(input.message);
  const pronoun = PRONOUN_CUE.test(input.message);
  const vague = VAGUE_CUE.test(input.message);
  const timePhrase = inferTimePhrase(input.message);
  const entities = literalEntities(input.message, input.knownEntities);

  let intent: Intent = 'fresh';
  if (recall && reverify) intent = 'recall_reverify';
  else if (recall) intent = 'recall';
  else if (reverify && (history || pronoun || input.claims.length > 0 || entities.length > 0)) {
    intent = 'reverify';
  }

  if (vague) {
    intent = recall ? 'recall' : 'reverify';
    return {
      intent,
      timePhrase: timePhrase ?? VAGUE_CUE.exec(input.message)?.[0],
      entities,
      queries: [],
      reason: 'Vague time reference needs resolution.',
    };
  }

  return {
    intent,
    timePhrase,
    entities,
    queries: [],
    reason: 'Heuristic route.',
  };
}

export async function routeMessage(input: {
  message: string;
  now: Date;
  timezone: string;
  recentTurns: Turn[];
  knownEntities: string[];
  claims: Claim[];
  llm?: LlmClient | null;
  signal?: AbortSignal;
}): Promise<RouterOutput> {
  if (input.llm) {
    try {
      const response = await input.llm.completeJson({
        system:
          'You are a precise routing component. Return JSON only, matching the requested shape. Never answer the user question.',
        user: routerPrompt(input),
        schema: RouterResponse,
        model: 'fast',
        temperature: 0,
        maxTokens: 900,
        signal: input.signal,
      });
      const entities = [...new Set((response.entities ?? []).map((entity) => entity.trim()).filter(Boolean))].slice(0, 8);
      const queries = [...new Set((response.queries ?? []).map((query) => query.trim()).filter(Boolean))].slice(0, 8);
      const result: RouterOutput = {
        intent: response.intent,
        timePhrase: response.timePhrase?.trim() || undefined,
        entities,
        queries,
        clarifyQuestion: response.clarifyQuestion?.trim() || undefined,
        reason: response.reason,
      };
      // Guard the most common LLM routing mistake: label a memory question as
      // fresh even though the user explicitly asked what they said earlier.
      if (result.intent === 'fresh' && RECALL_CUE.test(input.message)) {
        return routeHeuristically(input);
      }
      return result;
    } catch {
      // Routing is a latency-sensitive step. A bad fast call falls back to the
      // deterministic rules rather than failing the turn.
    }
  }
  return routeHeuristically(input);
}

export function buildSearchQueries(input: {
  router: RouterOutput;
  message: string;
  entities: string[];
  claims: Claim[];
  rangeLabel?: string;
}): Array<{ query: string; entity?: string }> {
  const queries: Array<{ query: string; entity?: string }> = [];
  const seen = new Set<string>();
  const timeLabel = input.rangeLabel ?? 'this month';
  const add = (query: string, entity?: string) => {
    const normalized = query.replace(/\s+/g, ' ').trim();
    if (normalized.length < 2 || seen.has(normalized.toLowerCase())) return;
    seen.add(normalized.toLowerCase());
    queries.push({ query: normalized, entity });
  };

  for (const query of input.router.queries) add(query);

  if (queries.length === 0) {
    if (input.entities.length > 0) {
      for (const entity of input.entities.slice(0, 6)) {
        const attribute =
          input.claims.find((claim) => claim.entity.toLowerCase() === entity.toLowerCase())
            ?.attribute ?? 'pricing and product';
        add(`${entity} ${attribute} update since ${timeLabel}`, entity);
      }
      const wantsShipped = /(shipped|launch|release|feature|announcement|product)/i.test(
        input.message,
      );
      if (wantsShipped && input.entities.length <= 3) {
        for (const entity of input.entities.slice(0, 2)) {
          add(`${entity} new product announcement since ${timeLabel}`, entity);
        }
      }
    } else {
      add(input.message.slice(0, 300));
    }
  } else if (input.entities.length > 0) {
    // Attach entities to model-written queries when it omitted the vendor name.
    for (const item of [...queries]) {
      if (!item.entity) {
        const entity = input.entities.find((candidate) =>
          item.query.toLowerCase().includes(candidate.toLowerCase()),
        );
        if (entity) item.entity = entity;
      }
    }
    // Cover entities the model forgot, without exceeding the query budget.
    const covered = new Set(queries.map((item) => item.entity?.toLowerCase()).filter(Boolean));
    for (const entity of input.entities) {
      if (queries.length >= 8) break;
      if (!covered.has(entity.toLowerCase())) {
        add(`${entity} pricing and product update since ${timeLabel}`, entity);
      }
    }
  }

  return queries.slice(0, 8);
}
