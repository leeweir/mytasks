import type { FieldKind, FieldToken, ParsedTask, Priority, TaskFields } from './types';

const TASK_RE = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+\[(.)\](?:[ \t]+(.*)|[ \t]*)$/u;

export const PRIORITY_EMOJI: Record<Priority, string> = {
  highest: '🔺',
  high: '⏫',
  medium: '🔼',
  low: '🔽',
  lowest: '⏬',
};

export const PRIORITY_BY_EMOJI: Record<string, Priority> = {
  '🔺': 'highest',
  '⏫': 'high',
  '🔼': 'medium',
  '🔽': 'low',
  '⏬': 'lowest',
};

/** Emoji used when serializing each field (canonical order = key order). */
export const FIELD_EMOJI: Record<Exclude<FieldKind, 'priority'>, string> = {
  recurrence: '🔁',
  reminder: '⏰',
  created: '➕',
  start: '🛫',
  scheduled: '⏳',
  due: '📅',
  done: '✅',
};

export const FIELD_ORDER: FieldKind[] = [
  'priority',
  'recurrence',
  'reminder',
  'created',
  'start',
  'scheduled',
  'due',
  'done',
];

const VS = '\\uFE0F?';
const DATE = '(\\d{4}-\\d{2}-\\d{2})';

/** Each regex matches a field token at the very end of the input. */
const FIELD_PATTERNS: { kind: FieldKind; re: RegExp }[] = [
  { kind: 'priority', re: new RegExp(`(🔺|⏫|🔼|🔽|⏬)${VS}$`, 'u') },
  { kind: 'recurrence', re: new RegExp(`🔁${VS}[ \\t]*([a-zA-Z0-9, !]*[a-zA-Z0-9!])$`, 'u') },
  { kind: 'reminder', re: new RegExp(`⏰${VS}[ \\t]*(\\d{4}-\\d{2}-\\d{2}(?:[ \\t]+\\d{1,2}:\\d{2})?)$`, 'u') },
  { kind: 'created', re: new RegExp(`➕${VS}[ \\t]*${DATE}$`, 'u') },
  { kind: 'start', re: new RegExp(`🛫${VS}[ \\t]*${DATE}$`, 'u') },
  { kind: 'scheduled', re: new RegExp(`(?:⏳|⌛)${VS}[ \\t]*${DATE}$`, 'u') },
  { kind: 'due', re: new RegExp(`(?:📅|📆|🗓)${VS}[ \\t]*${DATE}$`, 'u') },
  { kind: 'done', re: new RegExp(`✅${VS}[ \\t]*${DATE}$`, 'u') },
];

const TAG_BODY = `[^\\s#!@$%^&*(),.?":{}|<>'\`~=+\\[\\]\\\\;，。！？、；：“”‘’（）【】《》🔺⏫🔼🔽⏬🔁⏰➕🛫⏳⌛📅📆🗓✅\\uFE0F]+`;
const TAG_AT_END_RE = new RegExp(`(?:^|(?<=\\s))#(${TAG_BODY})$`, 'u');
const TAG_GLOBAL_RE = new RegExp(`(?<=^|\\s)#(${TAG_BODY})`, 'gu');
const HAS_NON_DIGIT = /[^0-9]/;

interface Analysis {
  task: ParsedTask;
  tokens: FieldToken[];
  /** Offset of the description start within the raw line. */
  contentStart: number;
}

function analyze(line: string): Analysis | null {
  const m = TASK_RE.exec(line);
  if (!m) return null;
  const [, indent, bullet, status] = m;
  const content = m[4] ?? '';
  const contentStart = line.length - content.length;

  const tokens: FieldToken[] = [];
  const trailingTags: string[] = [];
  const seen: Partial<Record<FieldKind, true>> = {};
  let end = content.length;

  for (;;) {
    while (end > 0 && (content[end - 1] === ' ' || content[end - 1] === '\t')) end--;
    const head = content.slice(0, end);
    let matched = false;
    for (const { kind, re } of FIELD_PATTERNS) {
      const fm = re.exec(head);
      if (!fm) continue;
      // A repeated field ends the trailing region: the earlier copy stays in the description.
      if (seen[kind]) break;
      seen[kind] = true;
      tokens.push({
        kind,
        from: contentStart + fm.index,
        to: contentStart + end,
        value: fm[1].replace(/[ \t]+/g, ' ').trim(),
      });
      end = fm.index;
      matched = true;
      break;
    }
    if (!matched) {
      const tm = TAG_AT_END_RE.exec(head);
      if (!tm || !HAS_NON_DIGIT.test(tm[1])) break;
      trailingTags.unshift(tm[0]);
      end = tm.index;
    }
  }

  let description: string;
  if (tokens.length === 0) {
    description = content.replace(/[ \t]+$/, '');
  } else {
    // Tags interleaved with fields belong to the description (Obsidian semantics).
    description = [content.slice(0, end), ...trailingTags].filter((s) => s.length > 0).join(' ');
  }

  const fields: TaskFields = {};
  for (const { kind, value } of tokens) {
    if (kind === 'priority') {
      fields.priority = PRIORITY_BY_EMOJI[value.replace(/\uFE0F/g, '')];
    } else {
      fields[kind] = value;
    }
  }
  tokens.sort((a, b) => a.from - b.from);

  return {
    task: {
      indent,
      bullet,
      status,
      checked: status === 'x' || status === 'X',
      description,
      tags: extractTags(description),
      fields,
    },
    tokens,
    contentStart,
  };
}

function extractTags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TAG_GLOBAL_RE)) {
    if (HAS_NON_DIGIT.test(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export function parseTaskLine(line: string): ParsedTask | null {
  return analyze(line)?.task ?? null;
}

/** Serializes a task: description followed by fields in canonical order. */
export function formatTaskLine(t: ParsedTask): string {
  const parts: string[] = [];
  const description = t.description.trim();
  if (description) parts.push(description);
  for (const kind of FIELD_ORDER) {
    const value = t.fields[kind];
    if (value === undefined || value === null || value === '') continue;
    if (kind === 'priority') {
      parts.push(PRIORITY_EMOJI[value as Priority]);
    } else {
      parts.push(`${FIELD_EMOJI[kind]} ${value}`);
    }
  }
  const head = `${t.indent}${t.bullet} [${t.status}]`;
  return parts.length > 0 ? `${head} ${parts.join(' ')}` : head;
}

/** Field tokens of a task line, sorted by offset. Empty for non-task lines. */
export function fieldTokens(line: string): FieldToken[] {
  return analyze(line)?.tokens ?? [];
}

/**
 * `#tag` ranges in a line (offsets cover the '#'). For task lines only the text after
 * the checkbox is scanned; other lines are scanned entirely.
 */
export function tagRanges(line: string): { from: number; to: number; tag: string }[] {
  const start = analyze(line)?.contentStart ?? 0;
  const out: { from: number; to: number; tag: string }[] = [];
  const scan = line.slice(start);
  for (const m of scan.matchAll(TAG_GLOBAL_RE)) {
    if (!HAS_NON_DIGIT.test(m[1])) continue;
    const from = start + (m.index ?? 0);
    out.push({ from, to: from + m[0].length, tag: m[1] });
  }
  return out;
}
