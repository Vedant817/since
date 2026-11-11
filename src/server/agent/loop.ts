import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type {
  AgentResult,
  ChatMeta,
  Claim,
  DateRange,
  DiffRow,
  GroundingReport,
  Intent,
  RecallHit,
  RouterOutput,
  Source,
  StreamEvent,
  Turn,
} from '../../shared/types.js';
import type { LlmClient } from '../llm/openai.js';
import type { Db } from '../memory/db.js';
import {
  claimsNeedingCheck,
  dedupeClaims,
  getActiveClaims,
  getClaimsForTurns,
  getKnownEntities,
  insertClaims,
  recordClaimCheck,
  listClaims,
  type NewClaim,
} from '../memory/claim-store.js';
import {
  addTurn,
  getAssistantTurnAfter,
  getConversation,
  getRecentTurns,
  getRecallHits,
  getTurnsBetween,
  searchTurns,
  setTurnResolution,
  updateConversationTitle,
  updateConversationTimezone,
} from '../memory/turns.js';
import type { WebSearchTool } from '../search/service.js';
import { domainOf, rankResults } from '../search/service.js';
import { compareClaims, extractClaims, extractClaimsHeuristic } from './claims.js';
import { groundDraft, quoteExists } from './grounding.js';
import { buildSearchQueries, inferTimePhrase, routeMessage } from './router.js';
import {
  renderDemoFreshAnswer,
  renderRecallAnswer,
  renderVerificationAnswer,
  streamLiveAnswer,
} from './synthesize.js';
import { resolveTemporal } from './temporal.js';
import { formatShortDate, safeTimeZone } from './timezone.js';

export interface AgentDeps {
  db: Db;
  llm: LlmClient | null;
  search: WebSearchTool;
  mode: 'live' | 'demo';
  userTimezone?: string;
  now?: () => Date;
}

export interface RunAgentInput {
  conversationId: string;
  message: string;
  timezone?: string;
  emit: (event: StreamEvent) => void | Promise<void>;
  signal?: AbortSignal;
}

const PRONOUN = /\b(them|those|it|that|these|any of them|the same)\b/i;

function uniqueEntities(entities: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entity of entities) {
    const trimmed = entity.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result.slice(0, 8);
}

function entityMatches(claim: Claim, entities: string[]): boolean {
  if (entities.length === 0) return true;
  const claimEntity = claim.entity.toLowerCase();
  return entities.some((entity) => {
    const target = entity.toLowerCase();
    return claimEntity.includes(target) || target.includes(claimEntity);
  });
}

function filterClaimsForMessage(claims: Claim[], message: string): Claim[] {
  const pricingOnly =
    /(pricing|price|cost)/i.test(message) &&
    !/(shipped|shipping|feature|launch|release|announcement|product|still|correct)/i.test(message);
  if (!pricingOnly) return claims;
  const filtered = claims.filter((claim) =>
    /(pric|cost|plan)/i.test(claim.attribute),
  );
  return filtered.length > 0 ? filtered : claims;
}

function selectClaims(claims: Claim[], limit = 10): Claim[] {
  const deduped = dedupeClaims(claims);
  if (deduped.length <= limit) return deduped;
  const picked: Claim[] = [];
  const seenEntities = new Set<string>();
  for (const claim of deduped) {
    if (picked.length >= limit) break;
    const key = claim.entity.toLowerCase();
    if (seenEntities.has(key)) continue;
    seenEntities.add(key);
    picked.push(claim);
  }
  for (const claim of deduped) {
    if (picked.length >= limit) break;
    if (!picked.includes(claim)) picked.push(claim);
  }
  return picked;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index]!;
      try {
        results[index] = { ok: true, value: await fn(item) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function selectSources<T extends { title: string; url: string; content: string }>(
  results: T[],
  entities: string[],
  cap: number,
): T[] {
  const chosen: T[] = [];
  const urls = new Set<string>();
  for (const entity of entities) {
    const match = results.find(
      (source) =>
        !urls.has(source.url) &&
        `${source.title} ${source.content}`.toLowerCase().includes(entity.toLowerCase()),
    );
    if (match) {
      chosen.push(match);
      urls.add(match.url);
    }
  }
  for (const source of results) {
    if (chosen.length >= cap) break;
    if (urls.has(source.url)) continue;
    chosen.push(source);
    urls.add(source.url);
  }
  return chosen.slice(0, cap);
}

function searchStartFor(range: DateRange | undefined, claims: Claim[]): string | undefined {
  if (range) return range.start;
  if (claims.length === 0) return undefined;
  const dates = claims
    .map((claim) => new Date(claim.asOf))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  return dates[0]?.toISOString();
}

function buildRecallByText(
  db: Db,
  conversationId: string,
  message: string,
  entities: string[],
  fallbackTurns: Turn[],
): RecallHit[] {
  const terms = entities.length > 0 ? entities : message
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((token) => token.length > 3)
    .slice(-4);
  const users = new Map<string, Turn>();
  for (const term of terms.slice(0, 6)) {
    for (const turn of searchTurns(db, conversationId, term, 6)) {
      if (turn.role === 'user') users.set(turn.id, turn);
    }
  }
  const hits: RecallHit[] = [];
  for (const userTurn of users.values()) {
    hits.push({ userTurn, answerTurn: getAssistantTurnAfter(db, userTurn) });
  }
  if (hits.length === 0) {
    for (const turn of fallbackTurns.filter((candidate) => candidate.role === 'user').slice(-3)) {
      hits.push({ userTurn: turn, answerTurn: getAssistantTurnAfter(db, turn) });
    }
  }
  return hits.sort(
    (a, b) => new Date(a.userTurn.createdAt).getTime() - new Date(b.userTurn.createdAt).getTime(),
  );
}

function diffFromCheck(
  claim: Claim,
  check: {
    verdict: 'changed' | 'unchanged' | 'unclear';
    newValue?: string;
    sourceUrl?: string;
    quote?: string;
    confidence?: number;
    checkedAt: string;
  },
  note?: string,
): DiffRow {
  return {
    claimId: claim.id,
    entity: claim.entity,
    attribute: claim.attribute,
    thenValue: claim.value,
    thenAsOf: claim.asOf,
    thenSourceUrl: claim.sourceUrl,
    nowValue: check.newValue,
    nowSourceUrl: check.sourceUrl,
    verdict: check.verdict,
    confidence: check.confidence,
    quote: check.quote,
    checkedAt: check.checkedAt,
    resolutionNote: note,
  };
}

function claimsFromChangedChecks(
  diffs: DiffRow[],
  claims: Claim[],
  turnId: string,
): NewClaim[] {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const result: NewClaim[] = [];
  const seen = new Set<string>();
  for (const diff of diffs) {
    if (diff.verdict !== 'changed' || !diff.nowValue || !diff.quote) continue;
    const old = byId.get(diff.claimId);
    if (!old) continue;
    const key = `${diff.entity.toLowerCase()}::${diff.attribute.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      turnId,
      entity: diff.entity,
      attribute: diff.attribute,
      value: diff.nowValue.slice(0, 500),
      asOf: diff.checkedAt.slice(0, 10),
      sourceUrl: diff.nowSourceUrl,
      quote: diff.quote.slice(0, 800),
      volatility: old.volatility,
      supersedes: old.id,
    });
  }
  return result;
}

export async function runAgentTurn(deps: AgentDeps, input: RunAgentInput): Promise<AgentResult> {
  const started = performance.now();
  const now = deps.now ? deps.now() : new Date();
  const emit = input.emit;
  const db = deps.db;
  const conversation = getConversation(db, input.conversationId);
  if (!conversation) throw new Error('Conversation not found.');
  const timezone = safeTimeZone(
    input.timezone ?? conversation.timezone,
    deps.userTimezone ?? conversation.timezone,
  );
  if (timezone !== conversation.timezone) updateConversationTimezone(db, conversation.id, timezone);

  const recent = getRecentTurns(db, conversation.id, 8);
  const knownEntities = getKnownEntities(db, conversation.id);
  const activeClaims = getActiveClaims(db, conversation.id, { limit: 20 });

  const userTurn = addTurn(db, {
    conversationId: conversation.id,
    role: 'user',
    text: input.message,
    createdAt: now.toISOString(),
    meta: { timezone },
  });
  if (conversation.title === 'New conversation') {
    updateConversationTitle(db, conversation.id, input.message.slice(0, 72));
  }

  const timings: Record<string, number> = {};
  const mark = (key: string, from: number) => {
    timings[key] = Math.round(performance.now() - from);
  };

  await emit({ type: 'status', step: 'resolving' });
  const resolveStarted = performance.now();
  const router = await routeMessage({
    message: input.message,
    now,
    timezone,
    recentTurns: recent,
    knownEntities,
    claims: activeClaims,
    llm: deps.llm,
    signal: input.signal,
  });
  const inferred = inferTimePhrase(input.message);
  let phrase = router.timePhrase;
  if (
    phrase &&
    inferred &&
    phrase.toLowerCase() === 'today' &&
    !/^today\b/i.test(inferred) &&
    /(what did i ask|i asked|remember)/i.test(input.message)
  ) {
    phrase = inferred;
  }
  let resolution = resolveTemporal(input.message, now, timezone, phrase);
  if (!resolution.range && !resolution.ambiguous && inferred && inferred !== phrase) {
    resolution = resolveTemporal(input.message, now, timezone, inferred);
  }
  mark('resolve', resolveStarted);
  setTurnResolution(db, userTurn.id, {
    start: resolution.range?.start,
    end: resolution.range?.end,
    note: resolution.note,
  });

  const memoryIntent =
    router.intent === 'recall' ||
    router.intent === 'reverify' ||
    router.intent === 'recall_reverify';
  const clarify =
    router.intent === 'clarify' ||
    (memoryIntent && resolution.ambiguous && !resolution.range);
  if (clarify) {
    const question =
      router.clarifyQuestion ??
      resolution.clarifyQuestion ??
      'Which date should I check?';
    const answerStarted = performance.now();
    const assistantId = randomUUID();
    const assistant = addTurn(db, {
      id: assistantId,
      conversationId: conversation.id,
      role: 'assistant',
      text: question,
      createdAt: new Date(now.getTime() + Math.max(1, performance.now() - started)).toISOString(),
      resolutionNote: resolution.note,
      intent: 'clarify',
      latencyMs: Math.round(performance.now() - started),
      meta: { mode: deps.mode },
    });
    mark('answer', answerStarted);
    const grounding: GroundingReport = {
      total: 0,
      verified: 0,
      rejected: 0,
      rejectionRate: 0,
    };
    const meta: ChatMeta = {
      mode: deps.mode,
      intent: 'clarify',
      entities: router.entities,
      dateRange: resolution.range,
      resolutionNote: resolution.note,
      assumption: resolution.assumption,
      grounding,
      timings,
      note: 'Asked one clarifying question.',
    };
    await emit({ type: 'meta', ...meta });
    await emit({ type: 'draft', delta: question, replace: true });
    await emit({ type: 'answer', turn: assistant, claims: [], grounding, meta });
    await emit({ type: 'done', turnId: assistant.id, latencyMs: assistant.latencyMs });
    return {
      assistantTurn: assistant,
      intent: 'clarify',
      mode: deps.mode,
      meta,
      recall: [],
      sources: [],
      diff: [],
      claims: [],
      grounding,
      timings,
    };
  }

  const range = resolution.range;
  const rangeTurns = range
    ? getTurnsBetween(db, conversation.id, range.start, range.end)
    : [];
  const rangeClaims = getClaimsForTurns(
    db,
    rangeTurns.map((turn) => turn.id),
  );

  let recall: RecallHit[] = [];
  if (router.intent === 'recall' || router.intent === 'recall_reverify') {
    await emit({ type: 'status', step: 'recalling' });
    const recallStarted = performance.now();
    recall = range
      ? getRecallHits(db, conversation.id, range.start, range.end)
      : buildRecallByText(db, conversation.id, input.message, router.entities, recent);
    mark('recall', recallStarted);
  }
  if (
    (router.intent === 'recall' || router.intent === 'recall_reverify') &&
    recall.length > 0
  ) {
    await emit({ type: 'recall', hits: recall });
  }

  const recalledClaims = getClaimsForTurns(
    db,
    recall.flatMap((hit) => (hit.answerTurn ? [hit.answerTurn.id] : [])),
  );

  const entityPool = [...rangeClaims, ...recalledClaims];
  let entities = uniqueEntities(router.entities);
  if (entities.length === 0) {
    entities = uniqueEntities(entityPool.map((claim) => claim.entity));
  }
  if (entities.length === 0 && rangeTurns.length > 0) {
    const text = rangeTurns.map((turn) => turn.text).join(' ').toLowerCase();
    entities = uniqueEntities(
      knownEntities.filter((entity) => text.includes(entity.toLowerCase())),
    );
  }
  if (entities.length === 0 && PRONOUN.test(input.message)) {
    const lastAssistant = [...recent].reverse().find((turn) => turn.role === 'assistant');
    if (lastAssistant) {
      entities = uniqueEntities(
        getClaimsForTurns(db, [lastAssistant.id]).map((claim) => claim.entity),
      );
    }
    if (entities.length === 0) entities = uniqueEntities(knownEntities);
  }

  let claimsForCheck: Claim[] = [];
  if (router.intent === 'recall_reverify') {
    claimsForCheck = dedupeClaims(recalledClaims);
  } else if (router.intent === 'reverify') {
    // Without a date range, prioritize claims whose volatility TTL has elapsed.
    // A high-volatility price claim is due after 24 hours; a low-volatility
    // definition can wait 30 days. If nothing is due, check the active set.
    const due = claimsNeedingCheck(db, conversation.id, now);
    const pool = rangeClaims.length > 0 ? rangeClaims : due.length > 0 ? due : activeClaims;
    claimsForCheck = dedupeClaims(pool);
    if (claimsForCheck.length === 0) {
      claimsForCheck = dedupeClaims(
        getActiveClaims(db, conversation.id, {
          entities: entities.length > 0 ? entities : undefined,
          limit: 24,
        }),
      );
    }
  }
  if (claimsForCheck.length > 0 && entities.length > 0) {
    const matching = claimsForCheck.filter((claim) => entityMatches(claim, entities));
    if (matching.length > 0) claimsForCheck = matching;
  }
  claimsForCheck = selectClaims(filterClaimsForMessage(claimsForCheck, input.message), 10);

  let effectiveIntent: Intent = router.intent;
  let note: string | undefined;
  if (effectiveIntent === 'reverify' && claimsForCheck.length === 0) {
    effectiveIntent = 'fresh';
    note = 'No stored claim matched; answered from current sources instead.';
  }
  if (effectiveIntent === 'recall' && recall.length === 0) {
    note = 'No matching conversation found.';
  }

  const shouldSearch =
    effectiveIntent === 'fresh' ||
    ((effectiveIntent === 'reverify' || effectiveIntent === 'recall_reverify') &&
      claimsForCheck.length > 0);

  await emit({
    type: 'meta',
    mode: deps.mode,
    intent: effectiveIntent,
    entities,
    dateRange: range,
    resolutionNote: resolution.note,
    assumption: resolution.assumption,
    note,
  });

  let sources: Source[] = [];
  let searchQueries: string[] = [];
  let searchErrors = 0;

  if (shouldSearch) {
    const searchStarted = performance.now();
    const rangeLabel = range ? formatShortDate(new Date(range.start), timezone) : undefined;
    const queries = buildSearchQueries({
      router,
      message: input.message,
      entities,
      claims: claimsForCheck,
      rangeLabel,
    });
    searchQueries = queries.map((query) => query.query);
    await emit({
      type: 'status',
      step: 'searching',
      detail:
        entities.length > 0
          ? `Checking ${entities.length} ${entities.length === 1 ? 'entity' : 'entities'} across ${queries.length} ${queries.length === 1 ? 'query' : 'queries'}`
          : `Checking ${queries.length} ${queries.length === 1 ? 'query' : 'queries'}`,
    });
    const startDate = searchStartFor(range, claimsForCheck);
    const endDate = now.toISOString();
    const searchResponses = await mapLimit(queries, 4, async (item) => {
      const results = await deps.search.run(
        {
          query: item.query,
          startDate,
          endDate,
          maxResults: 5,
          volatility: 'high',
        },
        input.signal,
      );
      return results;
    });
    const allResults = searchResponses.flatMap((response) => {
      if (!response.ok) {
        searchErrors += 1;
        return [];
      }
      return response.value;
    });
    const filtered = startDate
      ? allResults.filter(
          (result) =>
            !result.publishedAt ||
            new Date(result.publishedAt).getTime() >= new Date(startDate).getTime(),
        )
      : allResults;
    const usable = filtered.length > 0 ? filtered : allResults;
    const ranked = rankResults(usable, now);
    const cap = Math.min(Math.max(6, entities.length), 8);
    sources = selectSources(ranked, entities, cap).map((source, index) => ({
      ...source,
      id: `S${index + 1}`,
      domain: domainOf(source.url),
      content: source.content.slice(0, 8_000),
      retrievedAt: now.toISOString(),
    }));
    mark('search', searchStarted);
    await emit({ type: 'sources', sources });
  }

  let draft = '';
  let citations: Array<{ sourceId: string; quote?: string }> = [];
  let grounding: GroundingReport = {
    total: 0,
    verified: 0,
    rejected: 0,
    rejectionRate: 0,
  };
  let diff: DiffRow[] = [];
  let newClaims: NewClaim[] = [];
  const verdicts: Array<{ verdict: string; claimId: string }> = [];

  if (effectiveIntent === 'recall') {
    const rendered = renderRecallAnswer({ recall, rangeLabel: range?.label, timezone });
    draft = rendered.text;
    citations = rendered.citations;
    grounding = rendered.report;
    await emit({ type: 'draft', delta: draft, replace: true });
  } else if (
    (effectiveIntent === 'reverify' || effectiveIntent === 'recall_reverify') &&
    claimsForCheck.length > 0
  ) {
    if (!shouldSearch || sources.length === 0) {
      const recallPart =
        effectiveIntent === 'recall_reverify' && recall.length > 0
          ? `${renderRecallAnswer({ recall, rangeLabel: range?.label, timezone }).text}\n\n`
          : '';
      draft = `${recallPart}I have stored claims to compare, but the web search returned no usable sources. I cannot tell you whether they changed.`;
      grounding = { total: 0, verified: 0, rejected: 0, rejectionRate: 0 };
      await emit({ type: 'draft', delta: draft, replace: true });
    } else {
      const compareStarted = performance.now();
      await emit({
        type: 'status',
        step: 'comparing',
        detail: `Comparing ${claimsForCheck.length} stored ${claimsForCheck.length === 1 ? 'claim' : 'claims'} with today’s sources`,
      });
      const comparisons = await compareClaims({
        claims: claimsForCheck,
        sources,
        now,
        llm: deps.llm,
        signal: input.signal,
      });
      const claimById = new Map(claimsForCheck.map((claim) => [claim.id, claim]));
      for (const comparison of comparisons) {
        const claim = claimById.get(comparison.check.claimId);
        if (!claim) continue;
        const stored = recordClaimCheck(db, comparison.check);
        verdicts.push({ verdict: stored.verdict, claimId: claim.id });
        diff.push(
          diffFromCheck(
            claim,
            {
              verdict: stored.verdict,
              newValue: stored.newValue,
              sourceUrl: stored.sourceUrl,
              quote: stored.quote,
              confidence: stored.confidence,
              checkedAt: stored.checkedAt,
            },
            comparison.note,
          ),
        );
      }
      mark('compare', compareStarted);
      await emit({ type: 'diff', rows: diff });

      const rendered = renderVerificationAnswer({
        recall: effectiveIntent === 'recall_reverify' ? recall : [],
        rangeLabel: range?.label,
        checks: diff,
        claims: claimsForCheck,
        sources,
        now,
        timezone,
      });
      draft = rendered.text;
      citations = rendered.citations;
      grounding = rendered.report;
      await emit({ type: 'draft', delta: draft, replace: true });
    }
  } else if (effectiveIntent === 'recall_reverify') {
    const rendered = renderRecallAnswer({ recall, rangeLabel: range?.label, timezone });
    draft =
      recall.length > 0
        ? `${rendered.text}\n\nI do not have stored claims from that answer, so there is nothing concrete to re-check. I can check current sources if you ask a fresh question.`
        : rendered.text;
    citations = rendered.citations;
    grounding = rendered.report;
    await emit({ type: 'draft', delta: draft, replace: true });
  } else {
    // Fresh web answer.
    const rangeLabel = range?.label;
    if (sources.length === 0) {
      draft =
        'I could not find usable sources for that question. I would rather say that than guess. Try a more specific entity or product name.';
      if (searchErrors > 0) {
        draft =
          'Web search failed before I could retrieve usable sources. Check the search API key and try again. I will not guess an answer.';
      }
      grounding = { total: 0, verified: 0, rejected: 0, rejectionRate: 0 };
      await emit({ type: 'draft', delta: draft, replace: true });
    } else {
      const writeStarted = performance.now();
      await emit({ type: 'status', step: 'writing' });
      if (deps.llm && deps.mode === 'live') {
        try {
          draft = await streamLiveAnswer({
            llm: deps.llm,
            message: input.message,
            sources,
            entities,
            resolutionNote: resolution.note,
            now,
            timezone,
            signal: input.signal,
            onDelta: async (delta) => {
              await emit({ type: 'draft', delta });
            },
          });
        } catch {
          draft = '';
        }
      }
      if (!draft || !/\[S\d+\]/.test(draft)) {
        const fallback = renderDemoFreshAnswer({
          sources,
          entities,
          rangeLabel,
          timezone,
          message: input.message,
        });
        draft = fallback.text;
        citations = fallback.citations;
        grounding = fallback.report;
        await emit({ type: 'draft', delta: draft, replace: true });
      }
      mark('write', writeStarted);

      if (deps.llm && deps.mode === 'live' && draft && /\[S\d+\]/.test(draft)) {
        const groundStarted = performance.now();
        await emit({ type: 'status', step: 'grounding' });
        const grounded = await groundDraft({
          draft,
          sources,
          llm: deps.llm,
          signal: input.signal,
        });
        mark('ground', groundStarted);
        if (grounded.report.total === 0 || grounded.report.verified === 0) {
          const fallback = renderDemoFreshAnswer({
            sources,
            entities,
            rangeLabel,
            timezone,
            message: input.message,
          });
          draft = fallback.text;
          citations = fallback.citations;
          grounding = fallback.report;
          await emit({ type: 'draft', delta: draft, replace: true });
        } else {
          draft = grounded.text;
          citations = grounded.citations;
          grounding = grounded.report;
        }
      }
      if (note) draft = `${note}\n\n${draft}`;
    }
  }

  if (!draft) {
    draft = 'I could not produce a grounded answer from the sources I checked.';
  }

  const assistantId = randomUUID();
  let extracted: NewClaim[] = [];
  if (effectiveIntent === 'fresh' && sources.length > 0) {
    const extractionStarted = performance.now();
    await emit({ type: 'status', step: 'remembering' });
    if (deps.llm && deps.mode === 'live') {
      const result = await extractClaims({
        answer: draft,
        sources,
        turnId: assistantId,
        knownEntities: [...entities, ...knownEntities],
        llm: deps.llm,
        now,
        signal: input.signal,
      });
      extracted = result.claims;
    } else {
      extracted = extractClaimsHeuristic({
        answer: draft,
        sources,
        turnId: assistantId,
        knownEntities: [...entities, ...knownEntities],
        now,
      }).claims;
    }
    mark('extract', extractionStarted);
  } else if (diff.length > 0) {
    extracted = claimsFromChangedChecks(diff, claimsForCheck, assistantId);
  }

  const assistantCreatedAt = new Date(
    now.getTime() + Math.max(1, Math.round(performance.now() - started)),
  ).toISOString();
  let storedClaims: Claim[] = [];
  const assistant = db.transaction(() => {
    const turn = addTurn(db, {
      id: assistantId,
      conversationId: conversation.id,
      role: 'assistant',
      text: draft,
      createdAt: assistantCreatedAt,
      resolvedStart: range?.start,
      resolvedEnd: range?.end,
      resolutionNote: resolution.note,
      sources,
      citations,
      latencyMs: Math.round(performance.now() - started),
      intent: effectiveIntent,
      meta: {
        mode: deps.mode,
        entities,
        searchQueries,
        searchErrors,
        grounding,
        verdicts,
        diff,
        timings,
        assumption: resolution.assumption,
        note,
        recallUserTurnIds: recall.map((hit) => hit.userTurn.id),
      },
    });
    storedClaims = insertClaims(db, extracted);
    return turn;
  })();

  const meta: ChatMeta = {
    mode: deps.mode,
    model: deps.llm?.smartModel,
    intent: effectiveIntent,
    entities,
    dateRange: range,
    resolutionNote: resolution.note,
    assumption: resolution.assumption,
    grounding,
    searchQueries,
    searchErrors,
    timings,
    claimsExtracted: storedClaims.length,
    note,
  };

  const allClaims = listClaims(db, conversation.id, 200);
  await emit({ type: 'answer', turn: assistant, claims: allClaims, grounding, meta });
  await emit({ type: 'done', turnId: assistant.id, latencyMs: assistant.latencyMs });

  return {
    assistantTurn: assistant,
    intent: effectiveIntent,
    mode: deps.mode,
    meta,
    recall: effectiveIntent === 'recall' || effectiveIntent === 'recall_reverify' ? recall : [],
    sources,
    diff,
    claims: allClaims,
    grounding,
    timings,
  };
}
