import { describe, expect, test } from 'vitest';
import { parseRecurrence, formatRecurrence, nextOccurrence } from './recurrence';

describe('parseRecurrence', () => {
  test('simple units', () => {
    expect(parseRecurrence('every day')).toEqual({ interval: 1, unit: 'day' });
    expect(parseRecurrence('every week')).toEqual({ interval: 1, unit: 'week' });
    expect(parseRecurrence('every month')).toEqual({ interval: 1, unit: 'month' });
    expect(parseRecurrence('every year')).toEqual({ interval: 1, unit: 'year' });
  });

  test('intervals', () => {
    expect(parseRecurrence('every 3 days')).toEqual({ interval: 3, unit: 'day' });
    expect(parseRecurrence('every 2 weeks')).toEqual({ interval: 2, unit: 'week' });
    expect(parseRecurrence('every other week')).toEqual({ interval: 2, unit: 'week' });
  });

  test('weekdays', () => {
    expect(parseRecurrence('every Monday')).toEqual({ interval: 1, unit: 'week', weekdays: [1] });
    expect(parseRecurrence('every week on Monday')).toEqual({ interval: 1, unit: 'week', weekdays: [1] });
    expect(parseRecurrence('every mon, wed')).toEqual({ interval: 1, unit: 'week', weekdays: [1, 3] });
    expect(parseRecurrence('every weekday')).toEqual({ interval: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] });
  });

  test('month day', () => {
    expect(parseRecurrence('every month on the 15th')).toEqual({ interval: 1, unit: 'month', monthDay: 15 });
    expect(parseRecurrence('every month on the last')).toEqual({ interval: 1, unit: 'month', monthDay: 'last' });
  });

  test('aliases', () => {
    expect(parseRecurrence('daily')).toEqual({ interval: 1, unit: 'day' });
    expect(parseRecurrence('weekly')).toEqual({ interval: 1, unit: 'week' });
    expect(parseRecurrence('monthly')).toEqual({ interval: 1, unit: 'month' });
  });

  test('when done suffix', () => {
    expect(parseRecurrence('every week when done')).toEqual({ interval: 1, unit: 'week' });
  });

  test('invalid', () => {
    expect(parseRecurrence('foo')).toBeNull();
    expect(parseRecurrence('every 0 days')).toBeNull();
    expect(parseRecurrence('monday')).toBeNull();
  });
});

describe('formatRecurrence', () => {
  test('round-trip', () => {
    const rules = [
      'every day',
      'every 3 days',
      'every week',
      'every 2 weeks',
      'every weekday',
      'every week on Monday',
      'every week on Monday, Wednesday',
      'every month',
      'every month on the 15th',
      'every month on the last',
      'every year',
    ];
    for (const r of rules) {
      const parsed = parseRecurrence(r);
      expect(parsed).not.toBeNull();
      expect(formatRecurrence(parsed!)).toBe(r);
    }
  });
});

describe('nextOccurrence', () => {
  test('day', () => {
    const r = { interval: 1, unit: 'day' as const };
    expect(nextOccurrence(r, '2026-10-03')).toBe('2026-10-04');
    expect(nextOccurrence({ interval: 3, unit: 'day' }, '2026-10-03')).toBe('2026-10-06');
  });

  test('week', () => {
    expect(nextOccurrence({ interval: 1, unit: 'week' }, '2026-10-03')).toBe('2026-10-10');
    expect(nextOccurrence({ interval: 2, unit: 'week' }, '2026-10-03')).toBe('2026-10-17');
  });

  test('week with weekdays', () => {
    const r = { interval: 1, unit: 'week' as const, weekdays: [1, 3, 5] };
    expect(nextOccurrence(r, '2026-10-03')).toBe('2026-10-05');
    expect(nextOccurrence(r, '2026-10-05')).toBe('2026-10-07');
    expect(nextOccurrence(r, '2026-10-07')).toBe('2026-10-09');
    expect(nextOccurrence(r, '2026-10-09')).toBe('2026-10-12');
  });

  test('month', () => {
    expect(nextOccurrence({ interval: 1, unit: 'month' }, '2026-10-03')).toBe('2026-11-03');
    expect(nextOccurrence({ interval: 2, unit: 'month' }, '2026-10-03')).toBe('2026-12-03');
  });

  test('month with day', () => {
    const r = { interval: 1, unit: 'month' as const, monthDay: 15 };
    expect(nextOccurrence(r, '2026-10-03')).toBe('2026-10-15');
    expect(nextOccurrence(r, '2026-10-15')).toBe('2026-11-15');
  });

  test('month clamping Jan 31', () => {
    const r = { interval: 1, unit: 'month' as const, monthDay: 31 };
    expect(nextOccurrence(r, '2026-01-31')).toBe('2026-02-28');
    expect(nextOccurrence(r, '2026-02-28')).toBe('2026-03-31');
  });

  test('month last', () => {
    const r = { interval: 1, unit: 'month' as const, monthDay: 'last' as const };
    expect(nextOccurrence(r, '2026-01-15')).toBe('2026-01-31');
    expect(nextOccurrence(r, '2026-01-31')).toBe('2026-02-28');
    expect(nextOccurrence(r, '2026-02-28')).toBe('2026-03-31');
  });

  test('year', () => {
    expect(nextOccurrence({ interval: 1, unit: 'year' }, '2026-10-03')).toBe('2027-10-03');
    expect(nextOccurrence({ interval: 2, unit: 'year' }, '2026-10-03')).toBe('2028-10-03');
  });
});
