import { describe, expect, it } from 'vitest';
import { resolveTemporal } from '../src/server/agent/temporal.js';
import { localDateKey } from '../src/server/agent/timezone.js';

const NOW = new Date('2026-11-11T04:30:00.000Z');
const IST = 'Asia/Kolkata';

function rangeFor(message: string, now = NOW, timeZone = IST) {
  return resolveTemporal(message, now, timeZone).range;
}

function expectLocalStart(message: string, expected: string, timeZone = IST) {
  const range = rangeFor(message, NOW, timeZone);
  expect(range, message).toBeDefined();
  expect(localDateKey(new Date(range!.start), timeZone), message).toBe(expected);
}

describe('temporal resolver', () => {
  it('resolves “last Tuesday” to the previous civil Tuesday in IST', () => {
    const range = rangeFor('What did I ask you last Tuesday?');
    expect(range).toBeDefined();
    expect(range!.start).toBe('2026-11-09T18:30:00.000Z');
    expect(range!.end).toBe('2026-11-10T18:30:00.000Z');
    expect(range!.label).toContain('Tue 10 Nov 2026');
    expect(range!.timePhrase?.toLowerCase()).toContain('last tuesday');
  });

  it('resolves “on 3 November” to 3 November, not today', () => {
    const range = rangeFor('What did I ask you on 3 November?');
    expect(range).toBeDefined();
    expect(localDateKey(new Date(range!.start), IST)).toBe('2026-11-03');
    expect(range!.start).toBe('2026-11-02T18:30:00.000Z');
    expect(range!.end).toBe('2026-11-03T18:30:00.000Z');
    expect(range!.label).toContain('Tue 3 Nov 2026');
  });

  it('resolves “since Monday” through now', () => {
    const range = rangeFor('Compare the CRM tools since Monday.');
    expect(range).toBeDefined();
    expect(range!.start).toBe('2026-11-08T18:30:00.000Z');
    expect(range!.end).toBe(NOW.toISOString());
    expect(range!.dateOnly).toBe(false);
  });

  it('uses calendar months, not rolling 30-day windows', () => {
    const range = rangeFor('What did I ask last month?');
    expect(range).toBeDefined();
    expect(range!.start).toBe('2026-09-30T18:30:00.000Z');
    expect(range!.end).toBe('2026-10-31T18:30:00.000Z');
    expect(range!.label).toContain('Thu 1 Oct 2026');
  });

  it('resolves this week from Monday', () => {
    const range = rangeFor('What did I ask this week?');
    expect(range).toBeDefined();
    expect(range!.start).toBe('2026-11-08T18:30:00.000Z');
    expect(range!.end).toBe(NOW.toISOString());
  });

  it('resolves the week before last as a full Monday-to-Monday week', () => {
    const range = rangeFor('What did I ask the week before last?');
    expect(range).toBeDefined();
    expect(localDateKey(new Date(range!.start), IST)).toBe('2026-10-26');
    expect(localDateKey(new Date(range!.end), IST)).toBe('2026-11-02');
  });

  it('resolves a time-specific phrase to an hour, not a day', () => {
    const range = rangeFor('What did I ask last Tuesday at 4pm?');
    expect(range).toBeDefined();
    expect(range!.start).toBe('2026-11-10T10:30:00.000Z');
    expect(range!.end).toBe('2026-11-10T11:30:00.000Z');
    expect(range!.dateOnly).toBe(false);
  });

  it('resolves yesterday in the user timezone', () => {
    const range = rangeFor('What did I ask yesterday?');
    expect(range).toBeDefined();
    expect(localDateKey(new Date(range!.start), IST)).toBe('2026-11-10');
    expect(localDateKey(new Date(range!.end), IST)).toBe('2026-11-11');
  });

  it('handles a 25-hour DST day in America/New_York', () => {
    // DST ends on 1 November 2026 in New York. "Yesterday" from 2 November
    // points at the 25-hour day.
    const now = new Date('2026-11-02T17:00:00.000Z');
    const resolution = resolveTemporal('What did I ask yesterday?', now, 'America/New_York');
    expect(resolution.range).toBeDefined();
    expect(resolution.range!.start).toBe('2026-11-01T04:00:00.000Z');
    expect(resolution.range!.end).toBe('2026-11-02T05:00:00.000Z');
    const hours =
      (new Date(resolution.range!.end).getTime() -
        new Date(resolution.range!.start).getTime()) /
      3_600_000;
    expect(hours).toBe(25);
  });

  it('produces different instants for the same phrase in different timezones', () => {
    const kolkata = rangeFor('What did I ask on 3 November?', NOW, 'Asia/Kolkata');
    const losAngeles = rangeFor('What did I ask on 3 November?', NOW, 'America/Los_Angeles');
    expect(kolkata!.start).toBe('2026-11-02T18:30:00.000Z');
    expect(losAngeles!.start).toBe('2026-11-03T08:00:00.000Z');
  });

  it('asks one clarifying question for a vague date', () => {
    const resolution = resolveTemporal('What did I ask you the other day?', NOW, IST);
    expect(resolution.ambiguous).toBe(true);
    expect(resolution.range).toBeUndefined();
    expect(resolution.clarifyQuestion).toMatch(/which date/i);
  });

  it('clamps a date beyond the two-year window without inverting the range', () => {
    const resolution = resolveTemporal('What did I ask on 3 November 2019?', NOW, IST);
    expect(resolution.range).toBeDefined();
    expect(resolution.assumption).toMatch(/two-year/i);
    const start = new Date(resolution.range!.start).getTime();
    const end = new Date(resolution.range!.end).getTime();
    expect(start).toBeLessThanOrEqual(NOW.getTime());
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBe(24 * 60 * 60 * 1000);
  });

  it.each([
    'today',
    'yesterday',
    'this week',
    'last week',
    'last month',
    'this month',
    'last year',
    'this year',
    'the week before last',
    'since Monday',
    'since yesterday',
    'since last Tuesday',
    'since 3 November',
    'last Tuesday',
    'last Friday',
    'on 3 November',
    '3 November',
    'Nov 3',
    '3rd November',
    '3 Nov 2026',
    'last Tuesday at 4pm',
    'yesterday at 4pm',
    'last 5 days',
    'past two weeks',
    'two weeks ago',
    'a month ago',
    'next Monday',
  ])('resolves the phrase %s to a usable range', (phrase) => {
    const resolution = resolveTemporal(`What did I ask ${phrase}?`, NOW, IST);
    expect(resolution.range, phrase).toBeDefined();
    const start = new Date(resolution.range!.start).getTime();
    const end = new Date(resolution.range!.end).getTime();
    expect(Number.isNaN(start)).toBe(false);
    expect(Number.isNaN(end)).toBe(false);
    expect(end).toBeGreaterThan(start);
  });
});
