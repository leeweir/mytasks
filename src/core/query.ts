import { addDays, localDateTime } from './dates';
import { doneSections, applyEdits, fencedLines, indentWidth, splitLines } from './doc';
import { isOpenTask, parseTaskLine, tagRanges } from './task';
import type { ParsedTask, Priority } from './types';

export interface IndexedTask {
  path: string;
  line: number;
  raw: string;
  task: ParsedTask;
  depth: number;
  inDone: boolean;
  listName: string;
}

export interface Reminder {
  id: string;
  title: string;
  body: string;
  /** Local time 'YYYY-MM-DD HH:mm'. */
  at: string;
}

/** File basename without a trailing '.md'. */
export function listNameOf(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  return base.replace(/\.md$/i, '');
}

export function indexFile(path: string, content: string): IndexedTask[] {
  const lines = splitLines(content).map((l) => l.text);
  const sections = doneSections(lines);
  const fenced = fencedLines(content);
  const listName = listNameOf(path);
  const out: IndexedTask[] = [];
  // Indent widths of the enclosing task lines.
  const stack: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || fenced.has(i)) continue;
    const width = indentWidth(raw);
    while (stack.length > 0 && stack[stack.length - 1] >= width) stack.pop();
    const task = parseTaskLine(raw);
    if (!task) continue;
    out.push({
      path,
      line: i,
      raw,
      task,
      depth: stack.length,
      inDone: sections.some(([s, e]) => i > s && i < e),
      listName,
    });
    stack.push(width);
  }
  return out;
}

/** Sort rank; tasks without priority rank between medium and low (Obsidian semantics). */
const PRIORITY_RANK: Record<Priority | 'none', number> = {
  highest: 0,
  high: 1,
  medium: 2,
  none: 3,
  low: 4,
  lowest: 5,
};

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Due ascending (none last), priority highest→lowest, path, line. */
export function sortTasks(ts: IndexedTask[]): IndexedTask[] {
  return [...ts].sort((a, b) => {
    const da = a.task.fields.due;
    const db = b.task.fields.due;
    if (da !== db) {
      if (da === undefined) return 1;
      if (db === undefined) return -1;
      return compareStr(da, db);
    }
    const pa = PRIORITY_RANK[a.task.fields.priority ?? 'none'];
    const pb = PRIORITY_RANK[b.task.fields.priority ?? 'none'];
    if (pa !== pb) return pa - pb;
    return compareStr(a.path, b.path) || a.line - b.line;
  });
}

/**
 * Open tasks due today or earlier, with a reminder today, or (without a due date) with
 * a reminder on an earlier day.
 */
export function todayTasks(all: IndexedTask[], today: string): IndexedTask[] {
  return sortTasks(
    all.filter(({ task }) => {
      if (!isOpenTask(task)) return false;
      const { due } = task.fields;
      const reminderDate = task.fields.reminder?.slice(0, 10);
      if (due !== undefined && due <= today) return true;
      if (reminderDate === undefined) return false;
      return reminderDate === today || (due === undefined && reminderDate < today);
    }),
  );
}

/** Open tasks due in (today, today+days], grouped by due date ascending. */
export function upcomingTasks(
  all: IndexedTask[],
  today: string,
  days = 7,
): { date: string; tasks: IndexedTask[] }[] {
  const last = addDays(today, days);
  const groups = new Map<string, IndexedTask[]>();
  for (const t of all) {
    const due = t.task.fields.due;
    if (!isOpenTask(t.task) || due === undefined || due <= today || due > last) continue;
    const group = groups.get(due);
    if (group) group.push(t);
    else groups.set(due, [t]);
  }
  return [...groups.keys()].sort().map((date) => ({ date, tasks: sortTasks(groups.get(date) ?? []) }));
}

/** Tags across open tasks (case-insensitive grouping, first spelling kept), sorted by tag. */
export function allTags(all: IndexedTask[]): { tag: string; count: number }[] {
  const byKey = new Map<string, { tag: string; count: number }>();
  for (const t of all) {
    if (!isOpenTask(t.task)) continue;
    const keys = new Set(t.task.tags.map((tag) => tag.toLowerCase()));
    for (const tag of t.task.tags) {
      const key = tag.toLowerCase();
      if (!keys.delete(key)) continue;
      const entry = byKey.get(key);
      if (entry) entry.count++;
      else byKey.set(key, { tag, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => a.tag.localeCompare(b.tag));
}

/** Open tasks carrying `tag` or a nested child of it ('a' matches 'a/b'); case-insensitive. */
export function tagTasks(all: IndexedTask[], tag: string): IndexedTask[] {
  const want = tag.replace(/^#/, '').toLowerCase();
  return sortTasks(
    all.filter(
      (t) =>
        isOpenTask(t.task) &&
        t.task.tags.some((x) => {
          const lower = x.toLowerCase();
          return lower === want || lower.startsWith(`${want}/`);
        }),
    ),
  );
}

/** Checked tasks, most recent done date first (undated last), then path, line. */
export function doneTasks(all: IndexedTask[]): IndexedTask[] {
  return all
    .filter((t) => t.task.checked)
    .sort((a, b) => {
      const da = a.task.fields.done;
      const db = b.task.fields.done;
      if (da !== db) {
        if (da === undefined) return 1;
        if (db === undefined) return -1;
        return compareStr(db, da);
      }
      return compareStr(a.path, b.path) || a.line - b.line;
    });
}

/** 32-bit FNV-1a as 8 hex chars. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Open tasks whose reminder is after `now`, soonest first (date-only reminders fire at 09:00). */
export function pendingReminders(all: IndexedTask[], now: Date, limit = Infinity): Reminder[] {
  const out: { time: number; reminder: Reminder }[] = [];
  for (const t of all) {
    const reminder = t.task.fields.reminder;
    if (!isOpenTask(t.task) || !reminder) continue;
    const m = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}):(\d{2}))?$/.exec(reminder);
    if (!m) continue;
    const at = `${m[1]} ${m[2] ? m[2].padStart(2, '0') : '09'}:${m[3] ?? '00'}`;
    const time = localDateTime(m[1], at.slice(11)).getTime();
    if (!(time > now.getTime())) continue;
    const description = t.task.description;
    const untagged = applyEdits(
      description,
      tagRanges(description).map(({ from, to }) => ({ from, to, insert: '' })),
    );
    const title = untagged.replace(/\s+/g, ' ').trim();
    out.push({
      time,
      reminder: { id: fnv1a(`${t.path}\n${t.raw}`), title: title || t.listName, body: t.listName, at },
    });
  }
  return out
    .sort((a, b) => a.time - b.time || compareStr(a.reminder.id, b.reminder.id))
    .slice(0, Math.max(0, limit))
    .map((x) => x.reminder);
}
