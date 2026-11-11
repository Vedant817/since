import type { Citation, Intent, RecallHit, Role, Source, Turn } from '../../shared/types.js';
import { newId, nowIso, type Db } from './db.js';

interface TurnRow {
  id: string;
  conversation_id: string;
  role: Role;
  text: string;
  created_at: string;
  resolved_start: string | null;
  resolved_end: string | null;
  resolution_note: string | null;
  sources_json: string | null;
  citations_json: string | null;
  latency_ms: number | null;
  intent: Intent | null;
  meta_json: string | null;
}

export interface NewTurn {
  id?: string;
  conversationId: string;
  role: Role;
  text: string;
  createdAt?: string;
  resolvedStart?: string | null;
  resolvedEnd?: string | null;
  resolutionNote?: string | null;
  sources?: Source[];
  citations?: Citation[];
  latencyMs?: number | null;
  intent?: Intent | null;
  meta?: Record<string, unknown> | null;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    text: row.text,
    createdAt: row.created_at,
    resolvedStart: row.resolved_start ?? undefined,
    resolvedEnd: row.resolved_end ?? undefined,
    resolutionNote: row.resolution_note ?? undefined,
    sources: parseJson<Source[]>(row.sources_json, []),
    citations: parseJson<Citation[]>(row.citations_json, []),
    latencyMs: row.latency_ms ?? undefined,
    intent: row.intent ?? undefined,
    meta: parseJson<Record<string, unknown>>(row.meta_json, {}),
  };
}

export function createConversation(
  db: Db,
  options: { timezone?: string; title?: string; id?: string; createdAt?: string } = {},
): { id: string; timezone: string; title: string; createdAt: string } {
  const id = options.id ?? newId();
  const createdAt = options.createdAt ?? nowIso();
  const timezone = options.timezone ?? 'UTC';
  const title = options.title ?? 'New conversation';
  db.prepare(
    'INSERT INTO conversations (id, created_at, timezone, title) VALUES (?, ?, ?, ?)',
  ).run(id, createdAt, timezone, title);
  return { id, timezone, title, createdAt };
}

export function getConversation(
  db: Db,
  id: string,
): { id: string; timezone: string; title: string; createdAt: string } | undefined {
  const row = db
    .prepare('SELECT id, created_at, timezone, title FROM conversations WHERE id = ?')
    .get(id) as
    | { id: string; created_at: string; timezone: string; title: string }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    createdAt: row.created_at,
    timezone: row.timezone,
    title: row.title,
  };
}

export function updateConversationTimezone(db: Db, id: string, timezone: string): void {
  db.prepare('UPDATE conversations SET timezone = ? WHERE id = ?').run(timezone, id);
}

export function updateConversationTitle(db: Db, id: string, title: string): void {
  db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title.slice(0, 120), id);
}

export function addTurn(db: Db, input: NewTurn): Turn {
  const id = input.id ?? newId();
  const createdAt = input.createdAt ?? nowIso();
  const sources = input.sources ?? [];
  const citations = input.citations ?? [];
  const meta = input.meta ?? {};

  const insert = db.transaction(() => {
    db.prepare(
      `INSERT INTO turns (
        id, conversation_id, role, text, created_at, resolved_start, resolved_end,
        resolution_note, sources_json, citations_json, latency_ms, intent, meta_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.conversationId,
      input.role,
      input.text,
      createdAt,
      input.resolvedStart ?? null,
      input.resolvedEnd ?? null,
      input.resolutionNote ?? null,
      JSON.stringify(sources),
      JSON.stringify(citations),
      input.latencyMs ?? null,
      input.intent ?? null,
      JSON.stringify(meta),
    );
    db.prepare('INSERT INTO turns_fts (turn_id, text) VALUES (?, ?)').run(id, input.text);
  });
  insert();

  return {
    id,
    conversationId: input.conversationId,
    role: input.role,
    text: input.text,
    createdAt,
    resolvedStart: input.resolvedStart ?? undefined,
    resolvedEnd: input.resolvedEnd ?? undefined,
    resolutionNote: input.resolutionNote ?? undefined,
    sources,
    citations,
    latencyMs: input.latencyMs ?? undefined,
    intent: input.intent ?? undefined,
    meta,
  };
}

export function setTurnResolution(
  db: Db,
  turnId: string,
  resolution: { start?: string; end?: string; note?: string },
): void {
  db.prepare('UPDATE turns SET resolved_start = ?, resolved_end = ?, resolution_note = ? WHERE id = ?').run(
    resolution.start ?? null,
    resolution.end ?? null,
    resolution.note ?? null,
    turnId,
  );
}

export function getTurn(db: Db, id: string): Turn | undefined {
  const row = db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as TurnRow | undefined;
  return row ? toTurn(row) : undefined;
}

export function getTurns(db: Db, conversationId: string, limit = 200): Turn[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
        SELECT * FROM turns WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?
      ) ORDER BY created_at ASC`,
    )
    .all(conversationId, limit) as TurnRow[];
  return rows.map(toTurn);
}

export function getRecentTurns(db: Db, conversationId: string, limit = 8): Turn[] {
  return getTurns(db, conversationId, limit);
}

export function getTurnsBetween(
  db: Db,
  conversationId: string,
  startIso: string,
  endIso: string,
): Turn[] {
  const rows = db
    .prepare(
      `SELECT * FROM turns
       WHERE conversation_id = ? AND created_at >= ? AND created_at < ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId, startIso, endIso) as TurnRow[];
  return rows.map(toTurn);
}

export function getRecallHits(
  db: Db,
  conversationId: string,
  startIso: string,
  endIso: string,
): RecallHit[] {
  const all = getTurnsBetween(db, conversationId, startIso, endIso);
  const hits: RecallHit[] = [];
  for (let i = 0; i < all.length; i += 1) {
    const turn = all[i];
    if (!turn || turn.role !== 'user') continue;
    const next = all[i + 1];
    let answerTurn = next?.role === 'assistant' ? next : undefined;
    if (!answerTurn) {
      const following = db
        .prepare(
          `SELECT * FROM turns
           WHERE conversation_id = ? AND role = 'assistant' AND created_at >= ?
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(conversationId, turn.createdAt) as TurnRow | undefined;
      if (following) answerTurn = toTurn(following);
    }
    hits.push({ userTurn: turn, answerTurn });
  }
  return hits;
}

export function getAssistantTurnAfter(db: Db, turn: Turn): Turn | undefined {
  const row = db
    .prepare(
      `SELECT * FROM turns
       WHERE conversation_id = ? AND role = 'assistant' AND created_at >= ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(turn.conversationId, turn.createdAt) as TurnRow | undefined;
  return row ? toTurn(row) : undefined;
}

function ftsQuery(text: string): string {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2)
    .slice(0, 10);
  if (tokens.length === 0) return '';
  return tokens.map((token) => `"${token}"*`).join(' AND ');
}

export function searchTurns(db: Db, conversationId: string, text: string, limit = 8): Turn[] {
  const query = ftsQuery(text);
  if (!query) return [];
  try {
    const rows = db
      .prepare(
        `SELECT t.* FROM turns_fts f
         JOIN turns t ON t.id = f.turn_id
         WHERE turns_fts MATCH ? AND t.conversation_id = ?
         ORDER BY rank LIMIT ?`,
      )
      .all(query, conversationId, limit) as TurnRow[];
    return rows.map(toTurn);
  } catch {
    const like = `%${text.slice(0, 80)}%`;
    const rows = db
      .prepare(
        `SELECT * FROM turns WHERE conversation_id = ? AND text LIKE ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(conversationId, like, limit) as TurnRow[];
    return rows.map(toTurn);
  }
}

export function countTurns(db: Db, conversationId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?')
    .get(conversationId) as { n: number };
  return row.n;
}
