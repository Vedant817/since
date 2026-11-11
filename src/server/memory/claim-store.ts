import type {
  Claim,
  ClaimCheck,
  DiffRow,
  Verdict,
  Volatility,
} from '../../shared/types.js';
import { newId, nowIso, type Db } from './db.js';

interface ClaimRow {
  id: string;
  turn_id: string;
  entity: string;
  attribute: string;
  value: string;
  as_of: string;
  source_url: string | null;
  quote: string | null;
  volatility: Volatility;
  last_checked_at: string | null;
  status: 'active' | 'superseded';
  created_at: string;
}

interface ClaimCheckRow {
  id: string;
  claim_id: string;
  checked_at: string;
  verdict: Verdict;
  then_value: string | null;
  new_value: string | null;
  source_url: string | null;
  quote: string | null;
  confidence: number | null;
  source_ids_json: string | null;
}

export interface NewClaim {
  turnId: string;
  entity: string;
  attribute: string;
  value: string;
  asOf: string;
  sourceUrl?: string;
  quote?: string;
  volatility: Volatility;
  createdAt?: string;
  /** When a re-check replaces an older claim, the old row becomes superseded. */
  supersedes?: string;
}

export interface NewClaimCheck {
  claimId: string;
  verdict: Verdict;
  thenValue?: string;
  newValue?: string;
  sourceUrl?: string;
  quote?: string;
  confidence?: number;
  sourceIds?: string[];
  checkedAt?: string;
}

export const VOLATILITY_TTL_MS: Record<Volatility, number> = {
  high: 24 * 60 * 60 * 1000,
  medium: 7 * 24 * 60 * 60 * 1000,
  low: 30 * 24 * 60 * 60 * 1000,
};

function toClaim(row: ClaimRow): Claim {
  return {
    id: row.id,
    turnId: row.turn_id,
    entity: row.entity,
    attribute: row.attribute,
    value: row.value,
    asOf: row.as_of,
    sourceUrl: row.source_url ?? undefined,
    quote: row.quote ?? undefined,
    volatility: row.volatility,
    lastCheckedAt: row.last_checked_at ?? undefined,
    status: row.status,
    createdAt: row.created_at,
  };
}

function toCheck(row: ClaimCheckRow): ClaimCheck {
  return {
    id: row.id,
    claimId: row.claim_id,
    checkedAt: row.checked_at,
    verdict: row.verdict,
    newValue: row.new_value ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    quote: row.quote ?? undefined,
    confidence: row.confidence ?? undefined,
  };
}

export function insertClaims(db: Db, claims: NewClaim[]): Claim[] {
  const insert = db.prepare(
    `INSERT INTO claims (
      id, turn_id, entity, attribute, value, as_of, source_url, quote,
      volatility, last_checked_at, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?)`,
  );
  const created: Claim[] = [];
  const run = db.transaction(() => {
    for (const claim of claims) {
      const id = newId();
      const createdAt = claim.createdAt ?? nowIso();
      insert.run(
        id,
        claim.turnId,
        claim.entity,
        claim.attribute,
        claim.value,
        claim.asOf,
        claim.sourceUrl ?? null,
        claim.quote ?? null,
        claim.volatility,
        createdAt,
      );
      if (claim.supersedes) {
        db.prepare(
          "UPDATE claims SET status = 'superseded' WHERE id = ? AND status = 'active'",
        ).run(claim.supersedes);
      }
      created.push({
        id,
        turnId: claim.turnId,
        entity: claim.entity,
        attribute: claim.attribute,
        value: claim.value,
        asOf: claim.asOf,
        sourceUrl: claim.sourceUrl,
        quote: claim.quote,
        volatility: claim.volatility,
        status: 'active',
        createdAt,
      });
    }
  });
  run();
  return created;
}

export function getClaimsForTurns(db: Db, turnIds: string[]): Claim[] {
  if (turnIds.length === 0) return [];
  const placeholders = turnIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM claims WHERE turn_id IN (${placeholders}) AND status = 'active'
       ORDER BY as_of DESC, created_at DESC`,
    )
    .all(...turnIds) as ClaimRow[];
  return rows.map(toClaim);
}

export function getActiveClaims(
  db: Db,
  conversationId: string,
  options: { entities?: string[]; turnIds?: string[]; limit?: number } = {},
): Claim[] {
  const clauses = ['t.conversation_id = ?', "c.status = 'active'"];
  const params: unknown[] = [conversationId];

  if (options.entities && options.entities.length > 0) {
    const placeholders = options.entities.map(() => '?').join(',');
    clauses.push(`lower(c.entity) IN (${placeholders})`);
    params.push(...options.entities.map((entity) => entity.toLowerCase()));
  }
  if (options.turnIds && options.turnIds.length > 0) {
    const placeholders = options.turnIds.map(() => '?').join(',');
    clauses.push(`c.turn_id IN (${placeholders})`);
    params.push(...options.turnIds);
  }

  const limit = options.limit ?? 20;
  const rows = db
    .prepare(
      `SELECT c.* FROM claims c JOIN turns t ON t.id = c.turn_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY c.as_of DESC, c.created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as ClaimRow[];
  return dedupeClaims(rows.map(toClaim));
}

export function dedupeClaims(claims: Claim[]): Claim[] {
  const seen = new Set<string>();
  const result: Claim[] = [];
  for (const claim of claims) {
    const key = `${claim.entity.toLowerCase()}::${claim.attribute.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(claim);
  }
  return result;
}

export function listClaims(db: Db, conversationId: string, limit = 100): Claim[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM claims c JOIN turns t ON t.id = c.turn_id
       WHERE t.conversation_id = ?
       ORDER BY c.as_of DESC, c.created_at DESC LIMIT ?`,
    )
    .all(conversationId, limit) as ClaimRow[];
  return rows.map(toClaim);
}

export function getKnownEntities(db: Db, conversationId: string): string[] {
  const rows = db
    .prepare(
      `SELECT c.entity, COUNT(*) AS n FROM claims c JOIN turns t ON t.id = c.turn_id
       WHERE t.conversation_id = ? AND c.status = 'active'
       GROUP BY c.entity ORDER BY n DESC LIMIT 20`,
    )
    .all(conversationId) as Array<{ entity: string; n: number }>;
  return rows.map((row) => row.entity);
}

export function recordClaimCheck(db: Db, input: NewClaimCheck): ClaimCheck {
  const id = newId();
  const checkedAt = input.checkedAt ?? nowIso();
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO claim_checks (
        id, claim_id, checked_at, verdict, then_value, new_value, source_url,
        quote, confidence, source_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.claimId,
      checkedAt,
      input.verdict,
      input.thenValue ?? null,
      input.newValue ?? null,
      input.sourceUrl ?? null,
      input.quote ?? null,
      input.confidence ?? null,
      JSON.stringify(input.sourceIds ?? []),
    );
    db.prepare('UPDATE claims SET last_checked_at = ? WHERE id = ?').run(checkedAt, input.claimId);
  });
  run();

  return {
    id,
    claimId: input.claimId,
    checkedAt,
    verdict: input.verdict,
    newValue: input.newValue,
    sourceUrl: input.sourceUrl,
    quote: input.quote,
    confidence: input.confidence,
  };
}

export function getLatestCheck(db: Db, claimId: string): ClaimCheck | undefined {
  const row = db
    .prepare(
      'SELECT * FROM claim_checks WHERE claim_id = ? ORDER BY checked_at DESC LIMIT 1',
    )
    .get(claimId) as ClaimCheckRow | undefined;
  return row ? toCheck(row) : undefined;
}

export function getDiffRows(db: Db, conversationId: string, limit = 30): DiffRow[] {
  const rows = db
    .prepare(
      `SELECT ch.*, c.entity, c.attribute, c.value, c.as_of
       FROM claim_checks ch
       JOIN claims c ON c.id = ch.claim_id
       JOIN turns t ON t.id = c.turn_id
       WHERE t.conversation_id = ?
         AND ch.checked_at = (
           SELECT MAX(ch2.checked_at) FROM claim_checks ch2 WHERE ch2.claim_id = ch.claim_id
         )
       ORDER BY ch.checked_at DESC LIMIT ?`,
    )
    .all(conversationId, limit) as Array<
    ClaimCheckRow & { entity: string; attribute: string; value: string; as_of: string }
  >;
  return rows.map((row) => ({
    claimId: row.claim_id,
    entity: row.entity,
    attribute: row.attribute,
    thenValue: row.then_value ?? row.value,
    thenAsOf: row.as_of,
    nowValue: row.new_value ?? undefined,
    nowSourceUrl: row.source_url ?? undefined,
    verdict: row.verdict,
    confidence: row.confidence ?? undefined,
    quote: row.quote ?? undefined,
    checkedAt: row.checked_at,
  }));
}

export function isClaimStale(claim: Claim, now: Date): boolean {
  const reference = claim.lastCheckedAt ? new Date(claim.lastCheckedAt) : new Date(claim.asOf);
  return now.getTime() - reference.getTime() > VOLATILITY_TTL_MS[claim.volatility];
}

export function claimsNeedingCheck(db: Db, conversationId: string, now: Date): Claim[] {
  return getActiveClaims(db, conversationId, { limit: 20 }).filter((claim) =>
    isClaimStale(claim, now),
  );
}
