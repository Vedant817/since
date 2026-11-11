export type Role = 'user' | 'assistant';

export type Intent = 'fresh' | 'recall' | 'reverify' | 'recall_reverify' | 'clarify';

export type Volatility = 'high' | 'medium' | 'low';

export type Verdict = 'changed' | 'unchanged' | 'unclear';

export interface Source {
  id: string;
  title: string;
  url: string;
  domain: string;
  publishedAt?: string;
  retrievedAt: string;
  content: string;
  score?: number;
  demo?: boolean;
}

export interface Citation {
  sourceId: string;
  quote?: string;
}

export interface Conversation {
  id: string;
  createdAt: string;
  timezone: string;
  title: string;
}

export interface Turn {
  id: string;
  conversationId: string;
  role: Role;
  text: string;
  createdAt: string;
  resolvedStart?: string;
  resolvedEnd?: string;
  resolutionNote?: string;
  sources: Source[];
  citations: Citation[];
  latencyMs?: number;
  intent?: Intent;
  meta?: Record<string, unknown>;
}

export interface Claim {
  id: string;
  turnId: string;
  entity: string;
  attribute: string;
  value: string;
  asOf: string;
  sourceUrl?: string;
  quote?: string;
  volatility: Volatility;
  lastCheckedAt?: string;
  status: 'active' | 'superseded';
  createdAt: string;
}

export interface ClaimCheck {
  id: string;
  claimId: string;
  checkedAt: string;
  verdict: Verdict;
  newValue?: string;
  sourceUrl?: string;
  quote?: string;
  confidence?: number;
}

export interface DiffRow {
  claimId: string;
  entity: string;
  attribute: string;
  thenValue: string;
  thenAsOf: string;
  thenSourceUrl?: string;
  nowValue?: string;
  nowSourceUrl?: string;
  verdict: Verdict;
  confidence?: number;
  quote?: string;
  checkedAt: string;
  resolutionNote?: string;
}

export interface RecallHit {
  userTurn: Turn;
  answerTurn?: Turn;
}

export interface DateRange {
  start: string;
  end: string;
  label: string;
  timePhrase?: string;
  dateOnly: boolean;
}

export interface TemporalResolution {
  range?: DateRange;
  note: string;
  assumption?: string;
  ambiguous: boolean;
  clarifyQuestion?: string;
}

export interface RouterOutput {
  intent: Intent;
  timePhrase?: string;
  entities: string[];
  queries: string[];
  clarifyQuestion?: string;
  reason?: string;
}

export interface GroundingReport {
  total: number;
  verified: number;
  rejected: number;
  rejectionRate: number;
}

export interface ChatMeta {
  mode: 'live' | 'demo';
  model?: string;
  intent: Intent;
  entities: string[];
  dateRange?: DateRange;
  resolutionNote?: string;
  assumption?: string;
  grounding?: GroundingReport;
  searchQueries?: string[];
  searchErrors?: number;
  timings?: Record<string, number>;
  claimsExtracted?: number;
  note?: string;
}

export interface StreamEvent {
  type:
    | 'status'
    | 'meta'
    | 'recall'
    | 'sources'
    | 'diff'
    | 'draft'
    | 'answer'
    | 'error'
    | 'done';
  [key: string]: unknown;
}

export interface ConversationPayload {
  conversation: Conversation;
  turns: Turn[];
  claims: Claim[];
}

export interface ChatRequestBody {
  conversationId: string;
  message: string;
  timezone?: string;
}

export interface AgentResult {
  assistantTurn: Turn;
  intent: Intent;
  mode: 'live' | 'demo';
  meta: ChatMeta;
  recall: RecallHit[];
  sources: Source[];
  diff: DiffRow[];
  claims: Claim[];
  grounding: GroundingReport;
  timings: Record<string, number>;
}

export interface StatusEvent {
  type: 'status';
  step: 'resolving' | 'recalling' | 'searching' | 'comparing' | 'writing' | 'grounding' | 'remembering';
  detail?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
