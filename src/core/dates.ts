/**
 * Calendar-date helpers. ISO dates ('YYYY-MM-DD') are treated as plain calendar
 * days; arithmetic is done in UTC so DST transitions never shift a day.
 */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local calendar date of `d`. */
export function toISODate(d: Date): string {
  return fromYMD(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Local midnight of the given ISO date. Throws on malformed input. */
export function parseISODate(s: string): Date {
  const [y, m, d] = ymd(s);
  const date = new Date(y, m - 1, d);
  // Two-digit years would otherwise be mapped to 19xx.
  date.setFullYear(y);
  return date;
}

export function todayISO(now: Date): string {
  return toISODate(now);
}

export function isISODate(s: string): boolean {
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(Number(m[1]), mo);
}

/** [year, month(1-12), day]. Throws on malformed input. */
export function ymd(s: string): [number, number, number] {
  const m = ISO_RE.exec(s);
  if (!m) throw new Error(`Invalid ISO date: ${s}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Builds an ISO date, normalizing overflowing months/days (like Date). */
export function fromYMD(y: number, m: number, d: number): string {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return `${String(t.getUTCFullYear()).padStart(4, '0')}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

function utcMs(iso: string): number {
  const [y, m, d] = ymd(iso);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return t.getTime();
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = ymd(iso);
  return fromYMD(y, m, d + n);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: string, b: string): number {
  return Math.round((utcMs(b) - utcMs(a)) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(iso: string): number {
  return new Date(utcMs(iso)).getUTCDay();
}

export function daysInMonth(y: number, m: number): number {
  const t = new Date(0);
  t.setUTCFullYear(y, m, 0);
  return t.getUTCDate();
}

/**
 * Adds `n` months. The day of month is `day` (default: the day of `iso`),
 * clamped to the target month's length; 'last' picks the month's last day.
 */
export function addMonths(iso: string, n: number, day?: number | 'last'): string {
  const [y, m, d] = ymd(iso);
  const total = y * 12 + (m - 1) + n;
  const ty = Math.floor(total / 12);
  const tm = total - ty * 12 + 1;
  const dim = daysInMonth(ty, tm);
  const want = day === 'last' ? dim : Math.min(day ?? d, dim);
  return fromYMD(ty, tm, want);
}

/** Monday of the (Monday-based) week containing `iso`. */
export function startOfWeek(iso: string): string {
  return addDays(iso, -((weekdayOf(iso) + 6) % 7));
}

export function endOfMonth(iso: string): string {
  return addMonths(iso, 0, 'last');
}

/** 'HH:mm' of a local Date. */
export function toHHMM(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatHHMM(h: number, m: number): string {
  return `${pad2(h)}:${pad2(m)}`;
}

/** Local Date for 'YYYY-MM-DD' + 'HH:mm'. */
export function localDateTime(iso: string, hhmm: string): Date {
  const date = parseISODate(iso);
  const tm = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (tm) date.setHours(Number(tm[1]), Number(tm[2]), 0, 0);
  return date;
}
