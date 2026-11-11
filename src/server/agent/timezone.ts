const formatterCache = new Map<string, Intl.DateTimeFormat>();

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function safeTimeZone(timeZone: string | undefined, fallback = 'UTC'): string {
  if (timeZone && isValidTimeZone(timeZone)) return timeZone;
  return isValidTimeZone(fallback) ? fallback : 'UTC';
}

export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const values: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: values.weekday ?? '',
  };
}

function utcValue(parts: Pick<ZonedParts, 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'>): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );
}

/** Convert civil date-time parts in a timezone to the corresponding UTC instant. */
export function zonedToUtc(
  parts: Pick<ZonedParts, 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'>,
  timeZone: string,
): Date {
  let guess = new Date(utcValue(parts));
  for (let i = 0; i < 3; i += 1) {
    const actual = getZonedParts(guess, timeZone);
    const delta = utcValue(parts) - utcValue(actual);
    if (delta === 0) break;
    guess = new Date(guess.getTime() + delta);
  }
  return guess;
}

export function addCivilDays(parts: ZonedParts, days: number): ZonedParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0, 0));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0,
    weekday: parts.weekday,
  };
}

export function partsAt(
  parts: Pick<ZonedParts, 'year' | 'month' | 'day'>,
  hour = 0,
  minute = 0,
  second = 0,
): ZonedParts {
  return {
    ...parts,
    hour,
    minute,
    second,
    weekday: '',
  };
}

export function dayStart(date: Date, timeZone: string): Date {
  const p = getZonedParts(date, timeZone);
  return zonedToUtc(partsAt(p), timeZone);
}

export function dayRangeFromParts(
  parts: Pick<ZonedParts, 'year' | 'month' | 'day'>,
  timeZone: string,
): { start: Date; end: Date } {
  const start = zonedToUtc(partsAt(parts), timeZone);
  const next = addCivilDays({ ...partsAt(parts), weekday: '' }, 1);
  const end = zonedToUtc(partsAt(next), timeZone);
  return { start, end };
}

export function startOfWeek(date: Date, timeZone: string): Date {
  const p = getZonedParts(date, timeZone);
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const daysSinceMonday = weekdayIndex === 0 ? 6 : weekdayIndex - 1;
  const monday = addCivilDays(p, -daysSinceMonday);
  return zonedToUtc(partsAt(monday), timeZone);
}

export function monthRange(
  year: number,
  month: number,
  timeZone: string,
): { start: Date; end: Date } {
  const start = zonedToUtc(partsAt({ year, month, day: 1 }), timeZone);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const end = zonedToUtc(partsAt({ year: nextYear, month: nextMonth, day: 1 }), timeZone);
  return { start, end };
}

export function yearRange(year: number, timeZone: string): { start: Date; end: Date } {
  const start = zonedToUtc(partsAt({ year, month: 1, day: 1 }), timeZone);
  const end = zonedToUtc(partsAt({ year: year + 1, month: 1, day: 1 }), timeZone);
  return { start, end };
}

export function localDateKey(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function formatShortDate(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  const weekday = p.weekday;
  const month = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone }).format(date);
  return `${weekday} ${p.day} ${month} ${p.year}`;
}

export function formatDateTime(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  const month = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone }).format(date);
  const hour = String(p.hour).padStart(2, '0');
  const minute = String(p.minute).padStart(2, '0');
  return `${p.weekday} ${p.day} ${month} ${p.year}, ${hour}:${minute}`;
}

export function formatLongDate(date: Date, timeZone: string): string {
  const p = getZonedParts(date, timeZone);
  const month = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone }).format(date);
  return `${p.day} ${month} ${p.year}`;
}

export function startOfHour(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCMinutes(0, 0, 0);
  return copy;
}

export function dateKeyToParts(key: string): { year: number; month: number; day: number } {
  const [year, month, day] = key.split('-').map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}
