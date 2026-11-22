import {
  addDays,
  addMonths,
  daysInMonth,
  startOfWeek,
  weekdayOf,
  ymd,
  fromYMD,
} from './dates';

export interface Recurrence {
  interval: number;
  unit: 'day' | 'week' | 'month' | 'year';
  weekdays?: number[]; // 0 = Sunday
  monthDay?: number | 'last';
}

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const WEEKDAY_ALIASES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/** Monday-first ordering used for display and week iteration. */
const mondayIndex = (wd: number) => (wd + 6) % 7;

/** Parses 'monday, wed and fri' (plural names allowed). Null if any word is not a weekday. */
export function parseWeekdayList(text: string): number[] | null {
  const words = text
    .toLowerCase()
    .split(/\s*(?:,|&|\band\b|\s)\s*/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return null;
  const out = new Set<number>();
  for (const word of words) {
    const wd = WEEKDAY_ALIASES[word] ?? WEEKDAY_ALIASES[word.replace(/s$/, '')];
    if (wd === undefined) return null;
    out.add(wd);
  }
  return [...out].sort((a, b) => mondayIndex(a) - mondayIndex(b));
}

const WORKDAYS = [1, 2, 3, 4, 5];

/**
 * Parses Obsidian-style recurrence rules (case-insensitive, plurals allowed):
 * 'every day', 'every 3 days', 'every other week', 'every week on Monday, Wednesday',
 * 'every Monday', 'every weekday', 'every month on the 15th', 'every month on the last',
 * 'every year', plus 'daily'/'weekly'/'monthly'/'yearly'. A trailing 'when done' is ignored.
 */
export function parseRecurrence(text: string): Recurrence | null {
  let s = text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*when done$/, '')
    .trim();
  const alias: Record<string, string> = {
    daily: 'every day',
    weekly: 'every week',
    monthly: 'every month',
    yearly: 'every year',
    annually: 'every year',
  };
  s = alias[s] ?? s;
  const m = /^every\s+(.+)$/.exec(s);
  if (!m) return null;
  let rest = m[1];
  let interval = 1;
  const other = /^other\s+(.+)$/.exec(rest);
  const num = /^(\d+)\s+(.+)$/.exec(rest);
  if (other) {
    interval = 2;
    rest = other[1];
  } else if (num) {
    interval = Number(num[1]);
    rest = num[2];
  }
  if (!Number.isInteger(interval) || interval < 1) return null;

  if (/^weekdays?$/.test(rest)) return { interval, unit: 'week', weekdays: [...WORKDAYS] };
  if (/^weekends?$/.test(rest)) return { interval, unit: 'week', weekdays: [6, 0] };
  const bareDays = parseWeekdayList(rest);
  if (bareDays) return { interval, unit: 'week', weekdays: bareDays };

  const um = /^(day|week|month|year)s?(?:\s+(.*))?$/.exec(rest);
  if (!um) return null;
  const unit = um[1] as Recurrence['unit'];
  const tail = (um[2] ?? '').replace(/^on\s+/, '').trim();
  if (tail === '') return { interval, unit };

  if (unit === 'week') {
    if (/^weekdays?$/.test(tail)) return { interval, unit, weekdays: [...WORKDAYS] };
    const days = parseWeekdayList(tail);
    return days ? { interval, unit, weekdays: days } : null;
  }
  if (unit === 'month') {
    if (/^(?:the\s+)?last(?:\s+day)?$/.test(tail)) return { interval, unit, monthDay: 'last' };
    const dm = /^(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+day)?$/.exec(tail);
    if (!dm) return null;
    const day = Number(dm[1]);
    return day >= 1 && day <= 31 ? { interval, unit, monthDay: day } : null;
  }
  return null;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const suffix = ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** Canonical Obsidian-compatible rule text. */
export function formatRecurrence(r: Recurrence): string {
  const base = r.interval === 1 ? `every ${r.unit}` : `every ${r.interval} ${r.unit}s`;
  if (r.unit === 'week' && r.weekdays && r.weekdays.length > 0) {
    const days = [...new Set(r.weekdays)].sort((a, b) => mondayIndex(a) - mondayIndex(b));
    if (r.interval === 1 && days.join() === WORKDAYS.join()) return 'every weekday';
    return `${base} on ${days.map((d) => WEEKDAY_NAMES[d]).join(', ')}`;
  }
  if (r.unit === 'month' && r.monthDay !== undefined) {
    return `${base} on the ${r.monthDay === 'last' ? 'last' : ordinal(r.monthDay)}`;
  }
  return base;
}

/** First occurrence strictly after `fromISO`. */
export function nextOccurrence(r: Recurrence, fromISO: string): string {
  const interval = Math.max(1, Math.floor(r.interval) || 1);
  switch (r.unit) {
    case 'day':
      return addDays(fromISO, interval);
    case 'week': {
      if (!r.weekdays || r.weekdays.length === 0) return addDays(fromISO, 7 * interval);
      const set = new Set(r.weekdays);
      // Remaining days of the current (Monday-based) week.
      const weekStart = startOfWeek(fromISO);
      for (let i = mondayIndex(weekdayOf(fromISO)) + 1; i < 7; i++) {
        const day = addDays(weekStart, i);
        if (set.has(weekdayOf(day))) return day;
      }
      const nextWeek = addDays(weekStart, 7 * interval);
      for (let i = 0; i < 7; i++) {
        const day = addDays(nextWeek, i);
        if (set.has(weekdayOf(day))) return day;
      }
      return addDays(fromISO, 7 * interval);
    }
    case 'month': {
      const [y, m, d] = ymd(fromISO);
      if (r.monthDay !== undefined) {
        const target = r.monthDay === 'last' ? daysInMonth(y, m) : Math.min(r.monthDay, daysInMonth(y, m));
        if (target > d) return fromYMD(y, m, target);
        return addMonths(fromISO, interval, r.monthDay);
      }
      return addMonths(fromISO, interval);
    }
    case 'year':
      return addMonths(fromISO, 12 * interval);
  }
}
