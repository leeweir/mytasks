import { parseRecurrence } from '../core';
import type { FieldKind, Priority } from '../core';

const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六'];

const PRIORITY_EMOJI: Record<Priority, string> = {
  highest: '🔺',
  high: '⏫',
  medium: '🔼',
  low: '🔽',
  lowest: '⏬',
};

const PRIORITY_LABEL: Record<Priority, string> = {
  highest: '最高',
  high: '高',
  medium: '中',
  low: '低',
  lowest: '最低',
};

const KIND_EMOJI: Record<Exclude<FieldKind, 'priority'>, string> = {
  recurrence: '🔁',
  reminder: '⏰',
  created: '➕',
  start: '🛫',
  scheduled: '⏳',
  due: '📅',
  done: '✅',
};

function splitISO(iso: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** '2026-10-04' → '10月4日 周日' (year prefixed when it differs from today's). */
export function formatDateZh(iso: string, todayIso: string): string {
  const p = splitISO(iso);
  if (!p) return iso;
  const [y, m, d] = p;
  const weekday = WEEKDAY_ZH[new Date(y, m - 1, d).getDay()];
  const year = todayIso.slice(0, 4) === String(y) ? '' : `${y}年`;
  return `${year}${m}月${d}日 周${weekday}`;
}

/** '2026-10-04 09:00' → '10/4 09:00'. */
export function formatReminder(value: string, todayIso: string): string {
  const [date, time = ''] = value.trim().split(/\s+/);
  const p = splitISO(date);
  if (!p) return value;
  const [y, m, d] = p;
  const year = todayIso.slice(0, 4) === String(y) ? '' : `${y}/`;
  return `${year}${m}/${d}${time ? ' ' + time : ''}`;
}

function weekdayList(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  return sorted.map((d) => WEEKDAY_ZH[d]).join('、');
}

/** English Obsidian rule → short Chinese label; falls back to the raw text. */
export function formatRecurrenceZh(text: string): string {
  const r = parseRecurrence(text);
  if (!r) return text;
  const n = r.interval > 1 ? String(r.interval) : '';
  switch (r.unit) {
    case 'day':
      return `每${n}天`;
    case 'week': {
      const base = `每${n}周`;
      if (!r.weekdays || r.weekdays.length === 0) return base;
      return r.interval > 1 ? `${base}的周${weekdayList(r.weekdays)}` : `${base}${weekdayList(r.weekdays)}`;
    }
    case 'month': {
      const base = r.interval > 1 ? `每${n}个月` : '每月';
      if (r.monthDay === 'last') return `${base}最后一天`;
      if (typeof r.monthDay === 'number') return `${base}${r.monthDay}日`;
      return base;
    }
    default:
      return `每${n}年`;
  }
}

/** Badge text for a field token, e.g. '📅 10月4日 周六', '⏫ 高'. */
export function badgeText(kind: FieldKind, value: string, todayIso: string): string {
  if (kind === 'priority') {
    const p = value as Priority;
    return p in PRIORITY_LABEL ? `${PRIORITY_EMOJI[p]} ${PRIORITY_LABEL[p]}` : value;
  }
  const emoji = KIND_EMOJI[kind];
  switch (kind) {
    case 'recurrence':
      return `${emoji} ${formatRecurrenceZh(value)}`;
    case 'reminder':
      return `${emoji} ${formatReminder(value, todayIso)}`;
    default:
      return `${emoji} ${formatDateZh(value, todayIso)}`;
  }
}

/** Ensure a link target is something an opener understands. */
export function normalizeHref(raw: string): string {
  let href = raw.trim();
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
  if (/^[a-z][\w+.-]*:/i.test(href)) return href;
  if (/^www\./i.test(href)) return `https://${href}`;
  if (/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(href)) return `mailto:${href}`;
  return href;
}
