/**
 * Natural-language date / reminder / recurrence / priority suggestions for the
 * editor's `@` completion. Understands Chinese and English.
 */
import {
  addDays,
  addMonths,
  daysInMonth,
  diffDays,
  endOfMonth,
  formatHHMM,
  fromYMD,
  startOfWeek,
  toHHMM,
  todayISO,
  weekdayOf,
  ymd,
} from './dates';
import { formatRecurrence, nextOccurrence, parseRecurrence, type Recurrence } from './recurrence';
import { PRIORITY_BY_EMOJI, PRIORITY_EMOJI } from './task';
import type { Priority } from './types';

export interface Suggestion {
  label: string;
  detail: string;
  insert: string;
}

interface Ctx {
  today: string;
  /** Current local time 'HH:mm'. */
  nowTime: string;
}

interface Parsed {
  date?: string;
  time?: string;
  rec?: Recurrence;
  priority?: Priority;
  remind?: boolean;
  due?: boolean;
  /** The time is midnight at the end of the parsed day (晚上12点). */
  nextDay?: boolean;
}

type Rule = { re: RegExp; run: (m: RegExpExecArray, p: Parsed, c: Ctx) => boolean };

const MAX_SUGGESTIONS = 8;
const CJK_RE = /[\u3400-\u9fff]/;

// ---------------------------------------------------------------------------
// Small parsing helpers

const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** '15', '十五', '二十', '两' → number; null when malformed. */
function cnNum(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split('十');
  if (parts.length === 1) return s.length === 1 ? (CN_DIGITS[s] ?? null) : null;
  if (parts.length !== 2 || parts[0].length > 1 || parts[1].length > 1) return null;
  const tens = parts[0] === '' ? 1 : CN_DIGITS[parts[0]];
  const ones = parts[1] === '' ? 0 : CN_DIGITS[parts[1]];
  return tens === undefined || ones === undefined ? null : tens * 10 + ones;
}

const ZH_WEEKDAY: Record<string, number> = {
  日: 0, 天: 0, 七: 0, '7': 0, 一: 1, '1': 1, 二: 2, '2': 2, 三: 3, '3': 3, 四: 4, '4': 4,
  五: 5, '5': 5, 六: 6, '6': 6,
};

const EN_WEEKDAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const EN_MONTH: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const EN_NUMBER: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const ZH_WD_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const ZH_WD_CHARS = ['日', '一', '二', '三', '四', '五', '六'];
const EN_WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EN_WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EN_MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const N = '(\\d{1,3}|[零〇一二两三四五六七八九十]{1,3})';
const WD_CHAR = '[一二三四五六日天七]|[1-7](?![0-9:：点时號号日天周个月])';
const EN_WD = '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
const EN_MON =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const END = '(?![a-z0-9])';

function rx(source: string): RegExp {
  return new RegExp(`^(?:${source})`, 'i');
}

function setDate(p: Parsed, date: string | null): boolean {
  if (date === null || p.date !== undefined) return false;
  p.date = date;
  return true;
}

function setTime(p: Parsed, h: number, m: number): boolean {
  if (p.time !== undefined || !(h >= 0 && h <= 23 && m >= 0 && m <= 59)) return false;
  p.time = formatHHMM(h, m);
  return true;
}

function setRec(p: Parsed, rec: Recurrence | null): boolean {
  if (rec === null || p.rec !== undefined || !(rec.interval >= 1)) return false;
  p.rec = rec;
  return true;
}

function setPriority(p: Parsed, priority: Priority): boolean {
  if (p.priority !== undefined) return false;
  p.priority = priority;
  return true;
}

/** Next date (today included) falling on weekday `wd`. */
function upcomingWeekday(today: string, wd: number): string {
  return addDays(today, (wd - weekdayOf(today) + 7) % 7);
}

/** Weekday `wd` of the Monday-based week `weeks` weeks from the current one. */
function weekdayInWeek(today: string, weeks: number, wd: number): string {
  return addDays(startOfWeek(today), 7 * weeks + ((wd + 6) % 7));
}

/** Month/day with optional year; without a year, the next such date on or after today. */
function monthDayDate(today: string, month: number, day: number, year?: number): string | null {
  if (!(month >= 1 && month <= 12 && day >= 1)) return null;
  if (year !== undefined) return day <= daysInMonth(year, month) ? fromYMD(year, month, day) : null;
  const y = ymd(today)[0];
  // Up to 8 years ahead so that Feb 29 always finds a leap year.
  for (let k = 0; k <= 8; k++) {
    if (day > daysInMonth(y + k, month)) continue;
    const date = fromYMD(y + k, month, day);
    if (date >= today) return date;
  }
  return null;
}

/** Day of the current month, or of the next month when already past. */
function dayOfMonthDate(today: string, day: number): string | null {
  const [y, m] = ymd(today);
  for (let i = 0; i < 12; i++) {
    const first = addMonths(fromYMD(y, m, 1), i, 1);
    const [fy, fm] = ymd(first);
    if (day > daysInMonth(fy, fm)) continue;
    const date = fromYMD(fy, fm, day);
    if (date >= today) return date;
  }
  return null;
}

function periodHour(period: string, h: number): number {
  if (/下午|傍晚|晚上|今晚|明晚|夜里|pm|p\.m\.|^p$/i.test(period)) return h < 12 ? h + 12 : h;
  if (period === '中午') return h <= 2 ? h + 12 : h;
  if (/^(am|a\.m\.|a)$/i.test(period)) return h === 12 ? 0 : h;
  return h;
}

/** Hour `h` (1-12) of a Chinese day period; 晚上/夜里 12点 is the following midnight. */
function setPeriodTime(p: Parsed, period: string, h: number, min: number): boolean {
  if (h === 12 && /^(?:今晚|明晚|晚上|夜里)$/.test(period)) {
    if (!setTime(p, 0, min)) return false;
    p.nextDay = true;
    return true;
  }
  return setTime(p, periodHour(period, h), min);
}

/** Minutes from '半', '一刻', '三刻', '15分', '15'. */
function zhMinutes(s: string | undefined): number | null {
  if (!s) return 0;
  if (s === '半') return 30;
  if (s === '一刻') return 15;
  if (s === '三刻') return 45;
  return cnNum(s.replace(/分$/, ''));
}

function enCount(s: string): number | null {
  return /^\d+$/.test(s) ? Number(s) : (EN_NUMBER[s.toLowerCase()] ?? null);
}

function zhWeekdays(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.match(/[一二三四五六日天七1-7]/g) ?? []) {
    const wd = ZH_WEEKDAY[ch];
    if (!out.includes(wd)) out.push(wd);
  }
  return out.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
}

// ---------------------------------------------------------------------------
// Grammar. Rules are tried in order at the current position of the query.

const ZH_PERIOD = '(今晚|明早|明晚|凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)';
const ZH_HOUR = `${N}(?:点钟?|时)(半|一刻|三刻|${N}分?)?`;
const PERIOD_DEFAULT: Record<string, string> = {
  今晚: '20:00', 明早: '09:00', 明晚: '20:00', 凌晨: '06:00', 早上: '09:00', 早晨: '09:00',
  上午: '09:00', 中午: '12:00', 下午: '15:00', 傍晚: '18:00', 晚上: '20:00', 夜里: '22:00',
};

const RULES: Rule[] = [
  // Reminder / due keywords.
  { re: rx('提醒我?|闹钟|⏰'), run: (_m, p) => !p.remind && (p.remind = true) },
  { re: rx(`(?:remind(?:\\s+me)?|reminder|alarm)${END}`), run: (_m, p) => !p.remind && (p.remind = true) },
  { re: rx(`截止|到期|due${END}|📅`), run: (_m, p) => !p.due && (p.due = true) },

  // Chinese recurrence.
  { re: rx('每个?工作日|工作日'), run: (_m, p) => setRec(p, { interval: 1, unit: 'week', weekdays: [1, 2, 3, 4, 5] }) },
  { re: rx('每个?(?:周|星期|礼拜)末'), run: (_m, p) => setRec(p, { interval: 1, unit: 'week', weekdays: [6, 0] }) },
  {
    re: rx(`(?:每(隔)?${N}?个?(?:周|星期|礼拜)|(隔周))((?:[、,，和及与\\s]*(?:周|星期|礼拜)?(?:${WD_CHAR}))*)`),
    run: (m, p) => {
      const n = m[2] ? cnNum(m[2]) : 1;
      if (n === null) return false;
      const interval = m[3] ? 2 : m[1] ? n + 1 : n;
      const weekdays = zhWeekdays(m[4] ?? '');
      return setRec(p, weekdays.length > 0 ? { interval, unit: 'week', weekdays } : { interval, unit: 'week' });
    },
  },
  {
    re: rx(`每(隔)?${N}?个?月(?:的)?(?:${N}(?:号|日)|(最后一天|月底|月末|底|末))?`),
    run: (m, p) => {
      const n = m[2] ? cnNum(m[2]) : 1;
      if (n === null) return false;
      const interval = m[1] ? n + 1 : n;
      if (m[4]) return setRec(p, { interval, unit: 'month', monthDay: 'last' });
      if (m[3]) {
        const day = cnNum(m[3]);
        return day !== null && day >= 1 && day <= 31 && setRec(p, { interval, unit: 'month', monthDay: day });
      }
      return setRec(p, { interval, unit: 'month' });
    },
  },
  {
    re: rx(`每(隔)?${N}?年`),
    run: (m, p) => {
      const n = m[2] ? cnNum(m[2]) : 1;
      return n !== null && setRec(p, { interval: m[1] ? n + 1 : n, unit: 'year' });
    },
  },
  {
    re: rx(`每(隔)?${N}?(?:天|日)|(隔天)`),
    run: (m, p) => {
      const n = m[2] ? cnNum(m[2]) : 1;
      if (n === null) return false;
      return setRec(p, { interval: m[3] ? 2 : m[1] ? n + 1 : n, unit: 'day' });
    },
  },

  // English recurrence: the longest word prefix that forms a valid rule.
  {
    re: rx(`every(?:\\s+[a-z0-9,&]+)+|daily|weekly|monthly|yearly|annually`),
    run: (m, p) => {
      let candidate = m[0];
      for (;;) {
        const rec = parseRecurrence(candidate.replace(/,+$/, ''));
        if (rec) {
          // Consume only the accepted prefix; the rest is parsed by other rules.
          m[0] = candidate;
          return setRec(p, rec);
        }
        const cut = candidate.replace(/\s+\S+$/, '');
        if (cut === candidate) return false;
        candidate = cut;
      }
    },
  },

  // Explicit dates.
  {
    re: rx('(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})(?![0-9])'),
    run: (m, p, c) => setDate(p, monthDayDate(c.today, Number(m[2]), Number(m[3]), Number(m[1]))),
  },
  {
    re: rx(`(?:(\\d{4})年)?${N}月${N}(?:日|号)?`),
    run: (m, p, c) => {
      const month = cnNum(m[2]);
      const day = cnNum(m[3]);
      return month !== null && day !== null && setDate(p, monthDayDate(c.today, month, day, m[1] ? Number(m[1]) : undefined));
    },
  },
  {
    re: rx('(\\d{1,2})[-/](\\d{1,2})(?![0-9:/-])'),
    run: (m, p, c) => setDate(p, monthDayDate(c.today, Number(m[1]), Number(m[2]))),
  },

  // Chinese relative dates.
  { re: rx('大后天'), run: (_m, p, c) => setDate(p, addDays(c.today, 3)) },
  { re: rx('今天|今日'), run: (_m, p, c) => setDate(p, c.today) },
  { re: rx('明天|明日'), run: (_m, p, c) => setDate(p, addDays(c.today, 1)) },
  { re: rx('后天'), run: (_m, p, c) => setDate(p, addDays(c.today, 2)) },
  { re: rx('昨天|昨日'), run: (_m, p, c) => setDate(p, addDays(c.today, -1)) },
  { re: rx('前天'), run: (_m, p, c) => setDate(p, addDays(c.today, -2)) },
  {
    re: rx(`(下下个?|下个?|这个?|本|上个?)?(?:周|星期|礼拜)(${WD_CHAR})`),
    run: (m, p, c) => {
      const wd = ZH_WEEKDAY[m[2]];
      const prefix = (m[1] ?? '').replace('个', '');
      if (prefix === '') return setDate(p, upcomingWeekday(c.today, wd));
      const weeks: Record<string, number> = { 下下: 2, 下: 1, 这: 0, 本: 0, 上: -1 };
      const date = weekdayInWeek(c.today, weeks[prefix], wd);
      // A past day of the current week resolves to its next occurrence.
      return setDate(p, weeks[prefix] === 0 && date < c.today ? upcomingWeekday(c.today, wd) : date);
    },
  },
  {
    re: rx('(下个?|这个?|本)?(?:周|星期|礼拜)末'),
    run: (m, p, c) => {
      if (m[1]?.startsWith('下')) return setDate(p, weekdayInWeek(c.today, 1, 6));
      // On a Sunday the current weekend is today.
      return setDate(p, weekdayOf(c.today) === 0 ? c.today : upcomingWeekday(c.today, 6));
    },
  },
  { re: rx('下个?(?:周|星期|礼拜)'), run: (_m, p, c) => setDate(p, weekdayInWeek(c.today, 1, 1)) },
  { re: rx('下个?月(?:底|末)'), run: (_m, p, c) => setDate(p, endOfMonth(addMonths(c.today, 1, 1))) },
  {
    re: rx(`下个?月(?:${N}(?:号|日))?`),
    run: (m, p, c) => {
      if (!m[1]) return setDate(p, addMonths(c.today, 1));
      const day = cnNum(m[1]);
      const first = addMonths(c.today, 1, 1);
      const [y, mo] = ymd(first);
      return day !== null && day >= 1 && day <= daysInMonth(y, mo) && setDate(p, fromYMD(y, mo, day));
    },
  },
  { re: rx('(?:本|这个?)?月(?:底|末)'), run: (_m, p, c) => setDate(p, endOfMonth(c.today)) },
  {
    re: rx(`${N}(?:个)?(天|日|周|星期|礼拜|月|年)(?:后|以后|之后)`),
    run: (m, p, c) => {
      const n = cnNum(m[1]);
      if (n === null) return false;
      if (m[2] === '天' || m[2] === '日') return setDate(p, addDays(c.today, n));
      if (m[2] === '月') return setDate(p, addMonths(c.today, n));
      if (m[2] === '年') return setDate(p, addMonths(c.today, 12 * n));
      return setDate(p, addDays(c.today, 7 * n));
    },
  },
  {
    re: rx(`${N}(?:号|日)`),
    run: (m, p, c) => {
      const day = cnNum(m[1]);
      return day !== null && day >= 1 && day <= 31 && setDate(p, dayOfMonthDate(c.today, day));
    },
  },

  // Chinese times.
  {
    re: rx(`${ZH_PERIOD}(?:${ZH_HOUR}|(\\d{1,2})[:：](\\d{2}))?`),
    run: (m, p, c) => {
      const period = m[1];
      if (period === '今晚' && !setDate(p, c.today)) return false;
      if ((period === '明早' || period === '明晚') && !setDate(p, addDays(c.today, 1))) return false;
      if (m[2]) {
        const h = cnNum(m[2]);
        const min = zhMinutes(m[3]);
        return h !== null && min !== null && h <= 12 && setPeriodTime(p, period, h, min);
      }
      if (m[5]) {
        const h = Number(m[5]);
        return h <= 23 && (h <= 12 ? setPeriodTime(p, period, h, Number(m[6])) : setTime(p, h, Number(m[6])));
      }
      const [h, min] = PERIOD_DEFAULT[period].split(':').map(Number);
      return setTime(p, h, min);
    },
  },
  {
    re: rx(ZH_HOUR),
    run: (m, p) => {
      const h = cnNum(m[1]);
      const min = zhMinutes(m[2]);
      return h !== null && min !== null && setTime(p, h, min);
    },
  },

  // English relative dates.
  { re: rx(`(?:the\\s+)?day\\s+after\\s+tomorrow${END}`), run: (_m, p, c) => setDate(p, addDays(c.today, 2)) },
  { re: rx(`today|tod${END}`), run: (_m, p, c) => setDate(p, c.today) },
  { re: rx(`(?:tomorrow|tomorow|tmrw?)${END}`), run: (_m, p, c) => setDate(p, addDays(c.today, 1)) },
  { re: rx(`yesterday${END}`), run: (_m, p, c) => setDate(p, addDays(c.today, -1)) },
  { re: rx(`next\\s+week${END}`), run: (_m, p, c) => setDate(p, weekdayInWeek(c.today, 1, 1)) },
  { re: rx(`next\\s+month${END}`), run: (_m, p, c) => setDate(p, addMonths(c.today, 1)) },
  { re: rx(`(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?month${END}|eom${END}`), run: (_m, p, c) => setDate(p, endOfMonth(c.today)) },
  {
    re: rx(`(?:this\\s+)?weekend${END}`),
    // On a Sunday the current weekend is today (same as 周末).
    run: (_m, p, c) => setDate(p, weekdayOf(c.today) === 0 ? c.today : upcomingWeekday(c.today, 6)),
  },
  {
    re: rx(`(?:(next|this)\\s+)?${EN_WD}${END}`),
    run: (m, p, c) => {
      const wd = EN_WEEKDAY[m[2].slice(0, 3).toLowerCase()];
      const which = m[1]?.toLowerCase();
      if (which === 'next') return setDate(p, weekdayInWeek(c.today, 1, wd));
      return setDate(p, upcomingWeekday(c.today, wd));
    },
  },
  {
    re: rx(`in\\s+(\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(day|week|month|year)s?${END}`),
    run: (m, p, c) => {
      const n = enCount(m[1]);
      if (n === null) return false;
      const unit = m[2].toLowerCase();
      if (unit === 'day') return setDate(p, addDays(c.today, n));
      if (unit === 'week') return setDate(p, addDays(c.today, 7 * n));
      return setDate(p, addMonths(c.today, unit === 'month' ? n : 12 * n));
    },
  },
  {
    re: rx(`(\\d+)\\s+(day|week)s?\\s+(?:later|from\\s+now)${END}`),
    run: (m, p, c) => setDate(p, addDays(c.today, Number(m[1]) * (m[2].toLowerCase() === 'week' ? 7 : 1))),
  },
  {
    re: rx(`${EN_MON}\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?${END}`),
    run: (m, p, c) =>
      setDate(p, monthDayDate(c.today, EN_MONTH[m[1].slice(0, 3).toLowerCase()], Number(m[2]), m[3] ? Number(m[3]) : undefined)),
  },
  {
    re: rx(`(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${EN_MON}\\.?(?:,?\\s+(\\d{4}))?${END}`),
    run: (m, p, c) =>
      setDate(p, monthDayDate(c.today, EN_MONTH[m[2].slice(0, 3).toLowerCase()], Number(m[1]), m[3] ? Number(m[3]) : undefined)),
  },

  // English / numeric times.
  {
    re: rx(`(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.m\\.|p\\.m\\.|am|pm|a|p)${END}`),
    run: (m, p) => {
      const h = Number(m[1]);
      return h >= 1 && h <= 12 && setTime(p, periodHour(m[3], h), m[2] ? Number(m[2]) : 0);
    },
  },
  { re: rx('(\\d{1,2})[:：](\\d{2})(?![0-9])'), run: (m, p) => setTime(p, Number(m[1]), Number(m[2])) },
  { re: rx(`noon|midday${END}`), run: (_m, p) => setTime(p, 12, 0) },
  { re: rx(`midnight${END}`), run: (_m, p) => setTime(p, 0, 0) },
  { re: rx(`tonight${END}`), run: (_m, p, c) => setDate(p, c.today) && setTime(p, 20, 0) },
  {
    re: rx(`(?:in\\s+the\\s+|this\\s+)?(morning|afternoon|evening|night)${END}`),
    run: (m, p) => {
      const hours: Record<string, number> = { morning: 9, afternoon: 15, evening: 19, night: 20 };
      return setTime(p, hours[m[1].toLowerCase()], 0);
    },
  },

  // Priority (after times so that 中午 wins over 中).
  { re: rx('最高优先级|优先级最高|最高|紧急'), run: (_m, p) => setPriority(p, 'highest') },
  { re: rx('最低优先级|优先级最低|最低'), run: (_m, p) => setPriority(p, 'lowest') },
  { re: rx('高优先级|优先级高|高|重要'), run: (_m, p) => setPriority(p, 'high') },
  { re: rx('中优先级|优先级中|中等|中|普通'), run: (_m, p) => setPriority(p, 'medium') },
  { re: rx('低优先级|优先级低|低'), run: (_m, p) => setPriority(p, 'low') },
  { re: rx(`(?:highest|urgent|critical)(?:\\s+priority)?${END}`), run: (_m, p) => setPriority(p, 'highest') },
  { re: rx(`lowest(?:\\s+priority)?${END}`), run: (_m, p) => setPriority(p, 'lowest') },
  { re: rx(`(?:high|important)(?:\\s+priority)?${END}`), run: (_m, p) => setPriority(p, 'high') },
  { re: rx(`(?:medium|med|normal)(?:\\s+priority)?${END}`), run: (_m, p) => setPriority(p, 'medium') },
  { re: rx(`low(?:\\s+priority)?${END}`), run: (_m, p) => setPriority(p, 'low') },
  {
    re: rx(`p([1-5])${END}`),
    run: (m, p) => setPriority(p, (['highest', 'high', 'medium', 'low', 'lowest'] as const)[Number(m[1]) - 1]),
  },
  {
    re: rx(`priority\\s+(highest|high|medium|low|lowest)${END}`),
    run: (m, p) => setPriority(p, m[1].toLowerCase() as Priority),
  },
  {
    re: rx('(?:🔺|⏫|🔼|🔽|⏬)\\uFE0F?'),
    run: (m, p) => setPriority(p, PRIORITY_BY_EMOJI[m[0].replace(/\uFE0F/g, '')]),
  },

  // Filler words.
  { re: rx(`(?:at|on|by|me|the|priority)${END}|的|在|于|到|优先级`), run: () => true },
];

/** Parses the whole query; null if any part is not understood or nothing meaningful was found. */
function parse(query: string, ctx: Ctx): Parsed | null {
  const p: Parsed = {};
  let rest = query;
  for (;;) {
    rest = rest.replace(/^[\s,，、;；.。]+/, '');
    if (rest === '') break;
    let advanced = false;
    for (const rule of RULES) {
      const m = rule.re.exec(rest);
      if (!m || m[0].length === 0) continue;
      const snapshot = { ...p };
      if (rule.run(m, p, ctx)) {
        rest = rest.slice(m[0].length);
        advanced = true;
        break;
      }
      // Undo partial updates of a failed rule.
      for (const key of Object.keys(p) as (keyof Parsed)[]) delete p[key];
      Object.assign(p, snapshot);
    }
    if (!advanced) return null;
  }
  const meaningful = p.date || p.time || p.rec || p.priority || p.remind || p.due;
  return meaningful ? p : null;
}

// ---------------------------------------------------------------------------
// Presentation

const ZH_PRIORITY: Record<Priority, string> = { highest: '最高', high: '高', medium: '中', low: '低', lowest: '最低' };
const EN_PRIORITY: Record<Priority, string> = {
  highest: 'Highest', high: 'High', medium: 'Medium', low: 'Low', lowest: 'Lowest',
};

function relativeDate(date: string, today: string, zh: boolean): string {
  const diff = diffDays(today, date);
  const wd = weekdayOf(date);
  const weeks = diffDays(startOfWeek(today), startOfWeek(date)) / 7;
  const [y, m, d] = ymd(date);
  const sameYear = y === ymd(today)[0];
  if (zh) {
    const named: Record<string, string> = { '-1': '昨天', '0': '今天', '1': '明天', '2': '后天' };
    if (named[String(diff)]) return named[String(diff)];
    if (diff > 0 && weeks === 0) return `本${ZH_WD_NAMES[wd]}`;
    if (diff > 0 && weeks === 1) return `下${ZH_WD_NAMES[wd]}`;
    return sameYear ? `${m}月${d}日` : `${y}年${m}月${d}日`;
  }
  const named: Record<string, string> = { '-1': 'Yesterday', '0': 'Today', '1': 'Tomorrow' };
  if (named[String(diff)]) return named[String(diff)];
  if (diff > 0 && diff < 7) return EN_WD_LONG[wd];
  if (diff > 0 && weeks === 1) return `Next ${EN_WD_LONG[wd]}`;
  return sameYear ? `${EN_MONTH_SHORT[m - 1]} ${d}` : `${EN_MONTH_SHORT[m - 1]} ${d}, ${y}`;
}

function dateDetail(date: string, zh: boolean): string {
  return `${date} ${(zh ? ZH_WD_NAMES : EN_WD_SHORT)[weekdayOf(date)]}`;
}

function zhRecurrence(r: Recurrence): string {
  const every = r.interval === 1 ? '每' : `每${r.interval}`;
  switch (r.unit) {
    case 'day':
      return r.interval === 1 ? '每天' : `每${r.interval}天`;
    case 'week': {
      const days = r.weekdays ?? [];
      if (r.interval === 1 && days.join() === '1,2,3,4,5') return '工作日';
      const base = r.interval === 1 ? '每周' : `每${r.interval}周`;
      return days.length > 0 ? `${base}${days.map((d) => ZH_WD_CHARS[d]).join('、')}` : base;
    }
    case 'month': {
      const base = `${every}${r.interval === 1 ? '' : '个'}月`;
      if (r.monthDay === 'last') return `${base}最后一天`;
      return r.monthDay !== undefined ? `${base}${r.monthDay}号` : base;
    }
    case 'year':
      return `${every}年`;
  }
}

interface Part {
  insert: string;
  label: string;
  detail: string;
}

/**
 * First occurrence of `r` on or after today (strictly after today when `time` has passed).
 * Rules without fixed weekdays or day of month start today.
 */
function firstOccurrence(r: Recurrence, ctx: Ctx, time: string | undefined): string {
  const anchored = (r.weekdays !== undefined && r.weekdays.length > 0) || r.monthDay !== undefined;
  const first = anchored ? nextOccurrence(r, addDays(ctx.today, -1)) : ctx.today;
  return first === ctx.today && time !== undefined && time <= ctx.nowTime ? nextOccurrence(r, ctx.today) : first;
}

function suggestionsFor(p: Parsed, ctx: Ctx, zh: boolean): Suggestion[] {
  const prio: Part[] = p.priority
    ? [
        {
          insert: PRIORITY_EMOJI[p.priority],
          label: zh ? `${ZH_PRIORITY[p.priority]}优先级` : `${EN_PRIORITY[p.priority]} priority`,
          detail: PRIORITY_EMOJI[p.priority],
        },
      ]
    : [];
  const due = (date: string): Part => ({
    insert: `📅 ${date}`,
    label: zh ? `截止 ${relativeDate(date, ctx.today, zh)}` : `Due ${relativeDate(date, ctx.today, zh)}`,
    detail: dateDetail(date, zh),
  });
  const remind = (date: string, time: string): Part => ({
    insert: `⏰ ${date} ${time}`,
    label: zh ? `提醒 ${relativeDate(date, ctx.today, zh)} ${time}` : `Remind ${relativeDate(date, ctx.today, zh)} ${time}`,
    detail: `${dateDetail(date, zh)} ${time}`,
  });
  const combine = (parts: Part[]): Suggestion => ({
    insert: parts.map((x) => x.insert).join(' '),
    label: parts.map((x) => x.label).join(' · '),
    detail: parts.map((x) => x.detail).join(' · '),
  });

  // A date given with 晚上12点 means the midnight that ends it.
  const date = p.date !== undefined && p.nextDay ? addDays(p.date, 1) : p.date;

  if (p.rec) {
    const rule = formatRecurrence(p.rec);
    const parts: Part[] = [
      ...prio,
      { insert: `🔁 ${rule}`, label: zh ? `重复 ${zhRecurrence(p.rec)}` : `Repeat ${rule}`, detail: rule },
    ];
    if (p.time !== undefined || p.remind) {
      const time = p.time ?? '09:00';
      parts.push(remind(date ?? firstOccurrence(p.rec, ctx, time), time));
    } else if (date !== undefined) {
      parts.push(due(date));
    }
    return [combine(parts)];
  }

  if (date !== undefined || p.time !== undefined) {
    // Without a date, a time that has passed today (always so for midnight) means tomorrow.
    const when = date ?? (p.time !== undefined && p.time <= ctx.nowTime ? addDays(ctx.today, 1) : ctx.today);
    if (p.remind) return [combine([...prio, remind(when, p.time ?? '09:00')])];
    if (p.due || p.time === undefined) return [combine([...prio, due(when)])];
    const out = [combine([...prio, remind(when, p.time)])];
    if (date !== undefined) out.push(combine([...prio, due(when)]));
    return out;
  }

  if (p.remind) {
    const out: Suggestion[] = [];
    const nextHour = Number(ctx.nowTime.slice(0, 2)) + 1;
    if (nextHour <= 23) out.push(combine([...prio, remind(ctx.today, formatHHMM(nextHour, 0))]));
    out.push(combine([...prio, remind(addDays(ctx.today, 1), '09:00')]));
    out.push(combine([...prio, remind(weekdayInWeek(ctx.today, 1, 1), '09:00')]));
    return out;
  }

  return prio.length > 0 ? [combine(prio)] : [];
}

// ---------------------------------------------------------------------------
// Completion phrases (prefix matching)

const ZH_PHRASES = [
  '今天', '明天', '后天', '大后天', '昨天', '今晚', '明早', '明晚',
  '下周一', '下周二', '下周三', '下周四', '下周五', '下周六', '下周日', '下周', '下个月', '月底', '周末',
  '周一', '周二', '周三', '周四', '周五', '周六', '周日',
  '星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日',
  '这周五', '本周五',
  '上午9点', '中午', '下午3点', '晚上8点', '早上8点',
  '每天', '每周', '每周一', '每周二', '每周三', '每周四', '每周五', '每周六', '每周日', '每周一三五',
  '每两周', '工作日', '每月', '每月1号', '每月15号', '每月最后一天', '每年',
  '提醒', '提醒 明天 9点', '提醒 今晚 8点',
  '最高优先级', '高优先级', '中优先级', '低优先级', '最低优先级', '紧急', '重要',
];

const EN_PHRASES = [
  'today', 'tomorrow', 'tonight', 'yesterday', 'next week', 'next month', 'end of month', 'weekend',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'next monday', 'next tuesday', 'next wednesday', 'next thursday', 'next friday', 'next saturday', 'next sunday',
  'this friday', 'noon', '9am', '3pm',
  'every day', 'every week', 'every weekday', 'every other week', 'every month', 'every month on the 15th',
  'every month on the last', 'every year',
  'every monday', 'every tuesday', 'every wednesday', 'every thursday', 'every friday', 'every saturday', 'every sunday',
  'remind', 'remind tomorrow 9am', 'remind tonight',
  'highest priority', 'high priority', 'medium priority', 'low priority', 'lowest priority', 'urgent',
];

function dynamicPhrases(query: string, zh: boolean): string[] {
  const m = /(\d{1,3})$/.exec(query);
  if (!m) return [];
  const n = m[1];
  return zh
    ? [`${n}点`, `${n}号`, `${n}天后`, `${n}周后`, `${n}个月后`, `下午${n}点`, `晚上${n}点`, `每${n}天`, `每月${n}号`]
    : [`${n}am`, `${n}pm`, `in ${n} days`, `in ${n} weeks`, `in ${n} months`, `every ${n} days`, `every ${n} weeks`];
}

const DEFAULT_PHRASES = ['今天', '明天', '下周一', '提醒 明天 9点', '每天', '每周', '高优先级'];

/** Suggestions for the text typed after '@'. Empty query → common defaults. */
export function suggest(query: string, now: Date): Suggestion[] {
  const ctx: Ctx = { today: todayISO(now), nowTime: toHHMM(now) };
  const q = query.trim();
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (list: Suggestion[], max = Infinity) => {
    let added = 0;
    for (const s of list) {
      if (out.length >= MAX_SUGGESTIONS || added >= max) return;
      if (seen.has(s.insert)) continue;
      seen.add(s.insert);
      out.push(s);
      added++;
    }
  };

  if (q === '') {
    for (const phrase of DEFAULT_PHRASES) {
      const p = parse(phrase, ctx);
      if (p) add(suggestionsFor(p, ctx, true), 1);
    }
    return out;
  }

  const zh = CJK_RE.test(q) || !/[a-z]/i.test(q);
  const full = parse(q, ctx);
  if (full) add(suggestionsFor(full, ctx, zh));

  const lower = q.toLowerCase();
  const phrases = [...dynamicPhrases(lower, zh), ...(zh ? ZH_PHRASES : EN_PHRASES)];
  const heads = new Map<number, boolean>();
  for (let i = 0; i < lower.length && out.length < MAX_SUGGESTIONS; i++) {
    const suffix = lower.slice(i);
    if (/^\s/.test(suffix)) continue;
    const head = q.slice(0, i);
    for (const phrase of phrases) {
      if (!phrase.startsWith(suffix) || phrase === suffix) continue;
      let headOk = heads.get(i);
      if (headOk === undefined) {
        headOk = head.trim() === '' || parse(head, ctx) !== null;
        heads.set(i, headOk);
      }
      if (!headOk) break;
      const p = parse(head + phrase, ctx);
      if (p) add(suggestionsFor(p, ctx, zh), 1);
      if (out.length >= MAX_SUGGESTIONS) break;
    }
  }
  return out;
}
