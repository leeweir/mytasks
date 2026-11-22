import { addDays, diffDays, todayISO } from './dates';
import { nextOccurrence, parseRecurrence } from './recurrence';
import { formatTaskLine, parseTaskLine } from './task';
import type { FieldKind, FieldPatch, ParsedTask, TaskFields, TaskIdentity, TextEdit } from './types';

export interface DocLine {
  /** Line text without the line break (and without a trailing '\r'). */
  text: string;
  /** Offset of the first character. */
  start: number;
  /** Offset just past `text` (before any '\r\n' / '\n'). */
  end: number;
}

export function splitLines(text: string): DocLine[] {
  const out: DocLine[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const rawEnd = nl === -1 ? text.length : nl;
    const end = rawEnd > start && text.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
    out.push({ text: text.slice(start, end), start, end });
    if (nl === -1) return out;
    start = nl + 1;
  }
}

/** Applies edits whose offsets refer to the original text. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  let out = '';
  let pos = 0;
  for (const e of sorted) {
    if (e.from < pos) throw new Error('Overlapping edits');
    out += text.slice(pos, e.from) + e.insert;
    pos = e.to;
  }
  return out + text.slice(pos);
}

/** Offset of the start of a 0-based line; text length when out of range. */
export function lineOffset(text: string, line: number): number {
  if (line <= 0) return 0;
  let pos = 0;
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) return text.length;
    pos = nl + 1;
  }
  return pos;
}

/** Visual indentation width (tab = 4 columns). */
export function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 4 - (w % 4);
    else break;
  }
  return w;
}

const isBlank = (s: string) => s.trim() === '';

/**
 * Exclusive end index of the subtree rooted at line `idx`: following lines indented
 * deeper than it. Blank lines are included only when deeper content follows them.
 */
export function subtreeEnd(lines: readonly string[], idx: number): number {
  const base = indentWidth(lines[idx]);
  let end = idx + 1;
  for (let i = idx + 1; i < lines.length; i++) {
    if (isBlank(lines[i])) continue;
    if (indentWidth(lines[i]) <= base) break;
    end = i + 1;
  }
  return end;
}

/** Heading level (1-6) of a Markdown ATX heading line, else 0. */
function headingLevel(line: string): number {
  const m = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line);
  return m ? m[1].length : 0;
}

/**
 * `## Done` sections as [start, end) line ranges (heading included). A section runs
 * to the next heading of level ≤ 2 or EOF; fenced code blocks are skipped.
 */
export function doneSections(lines: readonly string[]): [number, number][] {
  const out: [number, number][] = [];
  let open = -1;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fm) {
      if (fence === null) fence = fm[1];
      else if (fm[1][0] === fence[0] && fm[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const level = headingLevel(line);
    if (level === 0 || level > 2) continue;
    if (open !== -1) {
      out.push([open, i]);
      open = -1;
    }
    if (line.replace(/[ \t]+$/, '') === '## Done') open = i;
  }
  if (open !== -1) out.push([open, lines.length]);
  return out;
}

function inRanges(ranges: [number, number][], line: number): boolean {
  return ranges.some(([s, e]) => line > s && line < e);
}

function checkedCopy(t: ParsedTask, today: string): ParsedTask {
  return { ...t, status: 'x', checked: true, fields: { ...t.fields, done: today } };
}

/** The unchecked next instance of a recurring task, or null if the rule is invalid. */
function nextInstance(t: ParsedTask, today: string): ParsedTask | null {
  const rule = t.fields.recurrence;
  if (!rule) return null;
  const whenDone = /\bwhen done\s*$/i.test(rule);
  const r = parseRecurrence(rule);
  if (!r) return null;
  const f = t.fields;
  const reminderDate = f.reminder?.slice(0, 10);
  const base = whenDone ? today : (f.due ?? reminderDate ?? today);
  const next = nextOccurrence(r, base);
  const delta = diffDays(base, next);
  const fields: TaskFields = { ...f };
  delete fields.done;
  if (f.due !== undefined || f.reminder === undefined) fields.due = next;
  if (f.reminder !== undefined && reminderDate) {
    fields.reminder = addDays(reminderDate, delta) + f.reminder.slice(10);
  }
  if (f.start !== undefined) fields.start = addDays(f.start, delta);
  if (f.scheduled !== undefined) fields.scheduled = addDays(f.scheduled, delta);
  if (f.created !== undefined) fields.created = today;
  return { ...t, status: ' ', checked: false, fields };
}

export function toggleTask(
  text: string,
  line: number,
  now: Date,
): { edits: TextEdit[]; checkedNow: boolean; archiveCandidate: TaskIdentity | null } {
  const lines = splitLines(text);
  const target = lines[line];
  const task = target ? parseTaskLine(target.text) : null;
  if (!target || !task) return { edits: [], checkedNow: false, archiveCandidate: null };

  if (task.checked) {
    const fields = { ...task.fields };
    delete fields.done;
    const unchecked = formatTaskLine({ ...task, fields, status: ' ', checked: false });
    return {
      edits: [{ from: target.start, to: target.end, insert: unchecked }],
      checkedNow: false,
      archiveCandidate: null,
    };
  }

  const today = todayISO(now);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const edits: TextEdit[] = [];
  const checkedLine = formatTaskLine(checkedCopy(task, today));
  const next = nextInstance(task, today);
  edits.push({
    from: target.start,
    to: target.end,
    insert: next ? formatTaskLine(next) + eol + checkedLine : checkedLine,
  });

  const texts = lines.map((l) => l.text);
  const end = subtreeEnd(texts, line);
  for (let i = line + 1; i < end; i++) {
    const child = parseTaskLine(texts[i]);
    if (!child || child.checked) continue;
    edits.push({ from: lines[i].start, to: lines[i].end, insert: formatTaskLine(checkedCopy(child, today)) });
  }

  const topLevel = indentWidth(target.text) === 0;
  const archiveCandidate =
    topLevel && !inRanges(doneSections(texts), line)
      ? { line: next ? line + 1 : line, raw: checkedLine }
      : null;
  return { edits, checkedNow: true, archiveCandidate };
}

/** Merges touching/overlapping edits (all relative to `text`) into a sorted, disjoint list. */
function normalizeEdits(text: string, edits: TextEdit[]): TextEdit[] {
  const sorted = [...edits].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: TextEdit[] = [];
  for (const e of sorted) {
    const prev = out[out.length - 1];
    if (prev && e.from <= prev.to) {
      const from = prev.from;
      const to = Math.max(prev.to, e.to);
      const segment = text.slice(from, to);
      const insert = applyEdits(segment, [
        { from: 0, to: prev.to - from, insert: prev.insert },
        { from: e.from - from, to: e.to - from, insert: e.insert },
      ]);
      out[out.length - 1] = { from, to, insert };
    } else {
      out.push(e);
    }
  }
  return out;
}

export function archiveTask(text: string, id: TaskIdentity): TextEdit[] {
  const lines = splitLines(text);
  const texts = lines.map((l) => l.text);
  const idx = texts[id.line] === id.raw ? id.line : texts.indexOf(id.raw);
  if (idx === -1) return [];
  const task = parseTaskLine(texts[idx]);
  if (!task || !task.checked) return [];
  const sections = doneSections(texts);
  if (inRanges(sections, idx)) return [];

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const end = subtreeEnd(texts, idx);
  const block = texts.slice(idx, end).join(eol);

  // Removal of the block including its line break.
  const removal: TextEdit =
    end < lines.length
      ? { from: lines[idx].start, to: lines[end].start, insert: '' }
      : { from: idx > 0 ? lines[idx - 1].end : 0, to: text.length, insert: '' };

  let insertion: TextEdit;
  const section = sections.length > 0 ? sections[sections.length - 1] : null;
  if (section) {
    const [h, secEnd] = section;
    let k = h + 1;
    while (k < secEnd && isBlank(texts[k])) k++;
    // Keep blank lines after the heading only when existing items follow them.
    if (k >= secEnd) k = h + 1;
    insertion =
      k < lines.length
        ? { from: lines[k].start, to: lines[k].start, insert: block + eol }
        : { from: text.length, to: text.length, insert: eol + block };
  } else {
    const rest = applyEdits(text, [removal]);
    let prefix: string;
    if (rest === '') prefix = '';
    else if (rest.endsWith('\n\n') || rest.endsWith('\r\n\r\n')) prefix = '';
    else if (rest.endsWith('\n')) prefix = eol;
    else prefix = eol + eol;
    insertion = { from: text.length, to: text.length, insert: `${prefix}## Done${eol}${block}${eol}` };
  }
  return normalizeEdits(text, [removal, insertion]);
}

export function setTaskFields(text: string, line: number, patch: FieldPatch): TextEdit[] {
  const lines = splitLines(text);
  const target = lines[line];
  const task = target ? parseTaskLine(target.text) : null;
  if (!target || !task) return [];
  const fields: TaskFields = { ...task.fields };
  for (const kind of Object.keys(patch) as FieldKind[]) {
    const value = patch[kind];
    if (value === undefined) continue;
    if (value === null || value === '') delete fields[kind];
    else (fields as Record<FieldKind, string>)[kind] = value;
  }
  const formatted = formatTaskLine({ ...task, fields });
  if (formatted === target.text) return [];
  return [{ from: target.start, to: target.end, insert: formatted }];
}
