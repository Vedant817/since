import * as chrono from 'chrono-node';
import type { DateRange, TemporalResolution } from '../../shared/types.js';
import {
  addCivilDays,
  dayRangeFromParts,
  formatShortDate,
  getZonedParts,
  monthRange,
  partsAt,
  startOfWeek,
  yearRange,
  zonedToUtc,
  type ZonedParts,
} from './timezone.js';

const TWO_YEARS_MS = 2 * 365.25 * 24 * 60 * 60 * 1000;
const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

interface ParsedFragment {
  start: Date;
  end: Date;
  timeSpecific: boolean;
  explicitYear: boolean;
  label: string;
  phrase: string;
  assumption?: string;
}

function withCap(start: Date, end: Date, now: Date): { start: Date; end: Date } {
  if (start.getTime() > now.getTime()) return { start, end: start };
  if (end.getTime() > now.getTime() && start.getTime() <= now.getTime()) {
    return { start, end: now };
  }
  return { start, end };
}

function rangeLabel(start: Date, end: Date, timeZone: string): string {
  const endDisplay = new Date(Math.max(start.getTime(), end.getTime() - 1));
  if (formatShortDate(start, timeZone) === formatShortDate(endDisplay, timeZone)) {
    return formatShortDate(start, timeZone);
  }
  return `${formatShortDate(start, timeZone)} → ${formatShortDate(endDisplay, timeZone)}`;
}

function makeRange(
  start: Date,
  end: Date,
  timeZone: string,
  timePhrase: string,
  dateOnly: boolean,
  capNow = false,
  now?: Date,
): DateRange {
  const bounded = capNow && now ? withCap(start, end, now) : { start, end };
  return {
    start: bounded.start.toISOString(),
    end: bounded.end.toISOString(),
    label: rangeLabel(bounded.start, bounded.end, timeZone),
    timePhrase,
    dateOnly,
  };
}

function dayRangeForParts(
  parts: Pick<ZonedParts, 'year' | 'month' | 'day'>,
  timeZone: string,
): { start: Date; end: Date } {
  return dayRangeFromParts(parts, timeZone);
}

function phraseNote(phrase: string, range: DateRange): string {
  return `Read “${phrase}” as ${range.label}${range.dateOnly ? '' : ` (through now)`}.`;
}

function parseChronoFragment(
  fragment: string,
  now: Date,
  timeZone: string,
): ParsedFragment | null {
  const localNow = getZonedParts(now, timeZone);
  // Build a server-local reference at noon on the user's civil date. chrono resolves
  // relative phrases against that civil date; we then reinterpret the components
  // in the user's timezone.
  const reference = new Date(localNow.year, localNow.month - 1, localNow.day, 12, 0, 0, 0);
  const forward = /\bnext\b/i.test(fragment);
  const results = chrono.parse(fragment, reference, { forwardDate: forward });
  if (results.length === 0) return null;

  const result = results.reduce((best, current) =>
    current.text.length > best.text.length ? current : best,
  );
  const parsed = result.start.date();
  let year = parsed.getFullYear();
  let month = parsed.getMonth() + 1;
  let day = parsed.getDate();
  const timeSpecific = result.start.isCertain('hour');
  const hour = timeSpecific ? parsed.getHours() : 0;
  const minute = timeSpecific ? parsed.getMinutes() : 0;
  const explicitYear = result.start.isCertain('year');
  let assumption: string | undefined;

  const lastWeekday =
    /^last\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(fragment);
  if (
    lastWeekday &&
    year === localNow.year &&
    month === localNow.month &&
    day === localNow.day
  ) {
    const shifted = addCivilDays({ year, month, day, hour: 0, minute: 0, second: 0, weekday: '' }, -7);
    year = shifted.year;
    month = shifted.month;
    day = shifted.day;
    assumption = '“last” on the same weekday was read as the previous week.';
  }

  const candidate = zonedToUtc({ year, month, day, hour, minute, second: 0 }, timeZone);

  if (!explicitYear && candidate.getTime() > now.getTime() + 24 * 60 * 60 * 1000 && !forward) {
    year -= 1;
    assumption = 'No year was given, so the most recent past occurrence was used.';
  }

  let start: Date;
  let end: Date;
  if (timeSpecific) {
    start = zonedToUtc({ year, month, day, hour, minute, second: 0 }, timeZone);
    end = new Date(start.getTime() + 60 * 60 * 1000);
  } else {
    const range = dayRangeForParts({ year, month, day }, timeZone);
    start = range.start;
    end = range.end;
  }

  if (start.getTime() < now.getTime() - TWO_YEARS_MS) {
    const duration = Math.max(24 * 60 * 60 * 1000, end.getTime() - start.getTime());
    start = new Date(now.getTime() - TWO_YEARS_MS);
    end = new Date(Math.min(now.getTime(), start.getTime() + duration));
    assumption = 'The requested date is beyond the two-year memory window; clamped.';
  } else if (start.getTime() > now.getTime() + TWO_YEARS_MS) {
    const duration = Math.max(24 * 60 * 60 * 1000, end.getTime() - start.getTime());
    start = new Date(now.getTime() + TWO_YEARS_MS);
    end = new Date(start.getTime() + duration);
    assumption = 'The requested date is beyond the two-year window; clamped.';
  }

  return {
    start,
    end,
    timeSpecific,
    explicitYear,
    label: timeSpecific
      ? rangeLabel(start, end, timeZone)
      : rangeLabel(start, end, timeZone),
    phrase: result.text,
    assumption,
  };
}

function vagueResolution(message: string): TemporalResolution | null {
  const match = message.match(
    /\b(the other (?:day|week|month)|recently|lately|a while ago|some time ago)\b/i,
  );
  if (!match) return null;
  const phrase = match[0];
  return {
    note: `“${phrase}” is not a specific date.`,
    ambiguous: true,
    clarifyQuestion: `Which date do you mean by “${phrase}”?`,
  };
}

export function resolveTemporal(
  message: string,
  now: Date,
  timeZone: string,
  phraseOverride?: string,
): TemporalResolution {
  const text = message.replace(/\s+/g, ' ').trim();
  const override = phraseOverride?.replace(/\s+/g, ' ').trim();
  if (override && override.toLowerCase() !== text.toLowerCase()) {
    return resolveTemporal(override, now, timeZone);
  }
  const lower = text.toLowerCase();
  const localNow = getZonedParts(now, timeZone);

  const today = dayRangeForParts(localNow, timeZone);
  const yesterdayParts = addCivilDays(localNow, -1);
  const yesterday = dayRangeForParts(yesterdayParts, timeZone);

  if (/\banother day\b/i.test(text)) {
    return {
      note: 'No specific date range detected.',
      ambiguous: false,
    };
  }

  const vague = vagueResolution(text);
  if (vague) return vague;

  if (/\bthe week before last\b/i.test(text)) {
    const twoWeeksAgo = addCivilDays(localNow, -14);
    const monday = startOfWeek(zonedToUtc(partsAt(twoWeeksAgo), timeZone), timeZone);
    const end = new Date(monday.getTime());
    const next = addCivilDays(twoWeeksAgo, 7);
    const nextMonday = startOfWeek(zonedToUtc(partsAt(next), timeZone), timeZone);
    const range = makeRange(monday, nextMonday, timeZone, 'the week before last', true, true, now);
    return {
      range,
      note: phraseNote('the week before last', range),
      ambiguous: false,
    };
  }

  if (/\btoday\b/i.test(text)) {
    const range = makeRange(today.start, today.end, timeZone, 'today', true, true, now);
    return { range, note: phraseNote('today', range), ambiguous: false };
  }

  if (/\byesterday\b/i.test(text)) {
    const range = makeRange(yesterday.start, yesterday.end, timeZone, 'yesterday', true);
    return { range, note: phraseNote('yesterday', range), ambiguous: false };
  }

  if (/\bthis week\b/i.test(text)) {
    const monday = startOfWeek(now, timeZone);
    const range = makeRange(monday, today.end, timeZone, 'this week', false, true, now);
    return { range, note: phraseNote('this week', range), ambiguous: false };
  }

  if (/\blast week\b/i.test(text)) {
    const thisMonday = startOfWeek(now, timeZone);
    const previousMonday = new Date(thisMonday.getTime() - 7 * 24 * 60 * 60 * 1000);
    const range = makeRange(previousMonday, thisMonday, timeZone, 'last week', true);
    return { range, note: phraseNote('last week', range), ambiguous: false };
  }

  if (/\blast month\b/i.test(text)) {
    const previousMonth = localNow.month === 1 ? 12 : localNow.month - 1;
    const previousYear = localNow.month === 1 ? localNow.year - 1 : localNow.year;
    const month = monthRange(previousYear, previousMonth, timeZone);
    const range = makeRange(month.start, month.end, timeZone, 'last month', true);
    return { range, note: phraseNote('last month', range), ambiguous: false };
  }

  if (/\bthis month\b/i.test(text)) {
    const month = monthRange(localNow.year, localNow.month, timeZone);
    const range = makeRange(month.start, month.end, timeZone, 'this month', false, true, now);
    return { range, note: phraseNote('this month', range), ambiguous: false };
  }

  if (/\blast year\b/i.test(text)) {
    const year = yearRange(localNow.year - 1, timeZone);
    const range = makeRange(year.start, year.end, timeZone, 'last year', true);
    return { range, note: phraseNote('last year', range), ambiguous: false };
  }

  if (/\bthis year\b/i.test(text)) {
    const year = yearRange(localNow.year, timeZone);
    const range = makeRange(year.start, year.end, timeZone, 'this year', false, true, now);
    return { range, note: phraseNote('this year', range), ambiguous: false };
  }

  const rolling = text.match(
    /\b(?:last|past)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month|year)s?\b/i,
  );
  if (rolling) {
    const rawCount = rolling[1]?.toLowerCase() ?? '1';
    const count = NUMBER_WORDS[rawCount] ?? Number.parseInt(rawCount, 10);
    const unit = rolling[2]?.toLowerCase();
    let start: Date;
    if (unit === 'day') {
      start = dayRangeForParts(addCivilDays(localNow, -count), timeZone).start;
    } else if (unit === 'week') {
      const monday = startOfWeek(now, timeZone);
      start = new Date(monday.getTime() - (count - 1) * 7 * 24 * 60 * 60 * 1000);
    } else if (unit === 'month') {
      const targetMonth = localNow.month - count;
      const monthIndex = ((targetMonth - 1) % 12 + 12) % 12;
      const yearOffset = Math.floor((targetMonth - 1) / 12);
      start = monthRange(localNow.year + yearOffset, monthIndex + 1, timeZone).start;
    } else {
      start = yearRange(localNow.year - count, timeZone).start;
    }
    const range = makeRange(start, today.end, timeZone, rolling[0], false, true, now);
    return { range, note: phraseNote(rolling[0], range), ambiguous: false };
  }

  const sinceMatch = text.match(/\bsince\s+(.+)$/i);
  const sinceFragment = sinceMatch?.[1]?.trim() ?? '';
  const pronounSince = /^(then|it|that|this|now)\b/i.test(sinceFragment);
  if (sinceFragment && !pronounSince) {
    const fragment = sinceFragment;
    const parsed = parseChronoFragment(fragment, now, timeZone);
    if (parsed) {
      const range = makeRange(parsed.start, now, timeZone, `since ${parsed.phrase}`, false);
      return {
        range,
        note: `Read “since ${parsed.phrase}” as ${range.label} (through now).`,
        assumption: parsed.assumption,
        ambiguous: false,
      };
    }
    return {
      note: `Could not resolve what “since ${fragment}” refers to.`,
      ambiguous: true,
      clarifyQuestion: `Since which date should I look?`,
    };
  }

  const parsed = parseChronoFragment(text, now, timeZone);
  if (parsed) {
    const range = makeRange(parsed.start, parsed.end, timeZone, parsed.phrase, !parsed.timeSpecific);
    const assumption = parsed.assumption;
    return {
      range,
      note: phraseNote(parsed.phrase, range),
      assumption,
      ambiguous: false,
    };
  }

  return {
    note: 'No date range detected.',
    ambiguous: false,
  };
}

export function phraseForTests(phrase: string): boolean {
  const result = chrono.parse(phrase, new Date(2026, 10, 11, 12, 0, 0, 0), { forwardDate: false });
  return result.length > 0;
}
