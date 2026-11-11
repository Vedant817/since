import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { Claim, DiffRow, Intent, Source, Turn } from '../../shared/types.js';

marked.setOptions({ gfm: true, breaks: true });

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMarkdown(text: string, sources: Source[] = []): string {
  const raw = marked.parse(text, { async: false }) as string;
  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
  });
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const withLinks = clean.replace(
    /<a\s/gi,
    '<a target="_blank" rel="noopener noreferrer" ',
  );
  return withLinks.replace(/\[(S\d+)\]/g, (_match, id: string) => {
    const source = sourceMap.get(id);
    const title = escapeHtml(source?.title ?? 'Source');
    return `<button type="button" class="citation-chip" data-cite="${escapeHtml(id)}" title="${title}">${escapeHtml(id)}</button>`;
  });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(iso: string | undefined, timezone?: string): string {
  if (!iso) return 'undated';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'undated';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: timezone,
    }).formatToParts(date);
    const day = parts.find((part) => part.type === 'day')?.value ?? '';
    const month = parts.find((part) => part.type === 'month')?.value ?? '';
    const year = parts.find((part) => part.type === 'year')?.value ?? '';
    return `${day} ${month} ${year}`;
  } catch {
    return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  }
}

export function formatDateTime(iso: string | undefined, timezone?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: timezone,
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

export function formatRelative(iso: string | undefined, now = Date.now()): string {
  if (!iso) return 'not checked';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'not checked';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 8) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function formatLatency(ms: number | undefined): string {
  if (!ms || ms < 0) return '';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function intentLabel(intent: Intent | undefined): string {
  switch (intent) {
    case 'recall':
      return 'Recalled from memory';
    case 'reverify':
      return 'Re-checked claims';
    case 'recall_reverify':
      return 'Recall + re-check';
    case 'clarify':
      return 'Clarifying';
    default:
      return 'Web answer';
  }
}

export function initials(value: string): string {
  const cleaned = value.replace(/^www\./, '');
  const parts = cleaned.split(/[.\s-]+/).filter(Boolean);
  if (parts.length === 1) return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
}

export function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export function stripCitationMarkers(value: string): string {
  return value
    .replace(/\[S\d+\]\s*/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function readMetaDiff(turn: Turn): DiffRow[] {
  const raw = turn.meta?.diff;
  return Array.isArray(raw) ? (raw as DiffRow[]) : [];
}

export function groupClaims(claims: Claim[]): Array<{ entity: string; claims: Claim[] }> {
  const map = new Map<string, Claim[]>();
  for (const claim of claims) {
    const key = claim.entity;
    const list = map.get(key) ?? [];
    list.push(claim);
    map.set(key, list);
  }
  return [...map.entries()]
    .map(([entity, list]) => ({
      entity,
      claims: list.sort((a, b) => b.asOf.localeCompare(a.asOf)),
    }))
    .sort((a, b) => a.entity.localeCompare(b.entity));
}

export function sourceLabel(source: Source): string {
  if (source.demo) return 'demo corpus';
  return source.domain || 'web';
}
