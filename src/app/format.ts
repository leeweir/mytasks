import { addDays, parseISODate, type Priority } from "../core";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export const PRIORITY_META: Record<Priority, { emoji: string; label: string; rank: number }> = {
  highest: { emoji: "🔺", label: "最高", rank: 0 },
  high: { emoji: "⏫", label: "高", rank: 1 },
  medium: { emoji: "🔼", label: "中", rank: 2 },
  low: { emoji: "🔽", label: "低", rank: 3 },
  lowest: { emoji: "⏬", label: "最低", rank: 4 },
};

/** Human label for an ISO date relative to today: 今天 / 明天 / 昨天 / 10月4日 周六 (year when different). */
export function dateLabel(iso: string, today: string): string {
  if (iso === today) return "今天";
  if (iso === addDays(today, 1)) return "明天";
  if (iso === addDays(today, -1)) return "昨天";
  const d = parseISODate(iso);
  const sameYear = iso.slice(0, 4) === today.slice(0, 4);
  return `${sameYear ? "" : `${d.getFullYear()}年`}${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}
