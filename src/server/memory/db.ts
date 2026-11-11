import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type Db = Database.Database;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  title TEXT NOT NULL DEFAULT 'New conversation'
);

CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_start TEXT,
  resolved_end TEXT,
  resolution_note TEXT,
  sources_json TEXT,
  citations_json TEXT,
  latency_ms INTEGER,
  intent TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS turns_by_time ON turns(conversation_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(turn_id UNINDEXED, text);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL REFERENCES turns(id),
  entity TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  as_of TEXT NOT NULL,
  source_url TEXT,
  quote TEXT,
  volatility TEXT NOT NULL CHECK (volatility IN ('high','medium','low')),
  last_checked_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_by_entity ON claims(entity);
CREATE INDEX IF NOT EXISTS claims_by_turn ON claims(turn_id);
CREATE INDEX IF NOT EXISTS claims_by_status ON claims(status);

CREATE TABLE IF NOT EXISTS claim_checks (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(id),
  checked_at TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('changed','unchanged','unclear')),
  then_value TEXT,
  new_value TEXT,
  source_url TEXT,
  quote TEXT,
  confidence REAL,
  source_ids_json TEXT
);
CREATE INDEX IF NOT EXISTS claim_checks_by_claim ON claim_checks(claim_id, checked_at);

CREATE TABLE IF NOT EXISTS search_cache (
  key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

export function openDatabase(path = './data/since.db'): Db {
  const filename = path === ':memory:' ? path : resolve(path);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export function transaction<T>(db: Db, fn: () => T): T {
  const run = db.transaction(fn);
  return run();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}
