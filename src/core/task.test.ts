import { describe, expect, test } from 'vitest';
import { parseTaskLine, formatTaskLine, fieldTokens, tagRanges, isOpenTask } from './task';

describe('parseTaskLine', () => {
  test('basic checkbox', () => {
    const t = parseTaskLine('- [ ] Task description');
    expect(t).toMatchObject({
      indent: '',
      bullet: '-',
      status: ' ',
      checked: false,
      description: 'Task description',
      tags: [],
      fields: {},
    });
  });

  test('checked', () => {
    expect(parseTaskLine('- [x] Done')?.checked).toBe(true);
    expect(parseTaskLine('- [X] Done')?.checked).toBe(true);
  });

  test('indented with tabs', () => {
    const t = parseTaskLine('\t\t- [x] Nested');
    expect(t?.indent).toBe('\t\t');
  });

  test('bullets', () => {
    expect(parseTaskLine('- [ ] A')?.bullet).toBe('-');
    expect(parseTaskLine('* [ ] B')?.bullet).toBe('*');
    expect(parseTaskLine('+ [ ] C')?.bullet).toBe('+');
    expect(parseTaskLine('1. [ ] D')?.bullet).toBe('1.');
    expect(parseTaskLine('42) [ ] E')?.bullet).toBe('42)');
  });

  test('fields at end only', () => {
    const t = parseTaskLine('- [ ] Text 📅 2026-10-05 #tag ⏫');
    expect(t?.description).toBe('Text #tag');
    expect(t?.fields.due).toBe('2026-10-05');
    expect(t?.fields.priority).toBe('high');
    expect(t?.tags).toEqual(['tag']);
  });

  test('emoji inside description stays', () => {
    const t = parseTaskLine('- [ ] Buy 🍎 and 🍌');
    expect(t?.description).toBe('Buy 🍎 and 🍌');
  });

  test('variation selectors normalized', () => {
    const t1 = parseTaskLine('- [ ] Task ⏫');
    const t2 = parseTaskLine('- [ ] Task ⏫\uFE0F');
    expect(t1?.fields.priority).toBe('high');
    expect(t2?.fields.priority).toBe('high');
  });

  test('repeated field: first stays in description', () => {
    const t = parseTaskLine('- [ ] 📅 2026-10-01 text 📅 2026-10-05');
    expect(t?.description).toBe('📅 2026-10-01 text');
    expect(t?.fields.due).toBe('2026-10-05');
  });

  test('adjacent duplicate field stays in description', () => {
    const t = parseTaskLine('- [ ] text 📅 2026-10-01 📅 2026-10-05');
    expect(t?.description).toBe('text 📅 2026-10-01');
    expect(t?.fields.due).toBe('2026-10-05');
  });

  test('all field kinds', () => {
    const t = parseTaskLine(
      '- [ ] Do it 🔺 🔁 every week on Monday ⏰ 2026-10-04 09:30 ➕ 2026-10-01 🛫 2026-10-02 ⏳ 2026-10-03 📅 2026-10-05 ✅ 2026-10-06',
    );
    expect(t?.description).toBe('Do it');
    expect(t?.fields).toEqual({
      priority: 'highest',
      recurrence: 'every week on Monday',
      reminder: '2026-10-04 09:30',
      created: '2026-10-01',
      start: '2026-10-02',
      scheduled: '2026-10-03',
      due: '2026-10-05',
      done: '2026-10-06',
    });
  });

  test('text after a field keeps everything in description', () => {
    const t = parseTaskLine('- [ ] Pay 📅 2026-10-05 bill');
    expect(t?.description).toBe('Pay 📅 2026-10-05 bill');
    expect(t?.fields).toEqual({});
  });

  test('variation selector on start emoji', () => {
    expect(parseTaskLine('- [ ] Go 🛫\uFE0F 2026-10-02')?.fields.start).toBe('2026-10-02');
    expect(parseTaskLine('- [ ] Go 🗓\uFE0F 2026-10-02')?.fields.due).toBe('2026-10-02');
  });

  test('interleaved tags extracted', () => {
    const t = parseTaskLine('- [ ] Text #a #b ⏫ #c 📅 2026-10-05 #d');
    expect(t?.description).toBe('Text #a #b #c #d');
    expect(t?.tags).toEqual(['a', 'b', 'c', 'd']);
  });

  test('non-task lines', () => {
    expect(parseTaskLine('Just text')).toBeNull();
    expect(parseTaskLine('- Not a task')).toBeNull();
    expect(parseTaskLine('- []')).toBeNull();
  });

  test('tags with slashes and unicode', () => {
    const t = parseTaskLine('- [ ] Task #项目/子任务 #done');
    expect(t?.tags).toEqual(['项目/子任务', 'done']);
  });

  test('tags must have non-digit', () => {
    const t = parseTaskLine('- [ ] Task #123 #a1 #2b');
    expect(t?.tags).toEqual(['a1', '2b']);
  });
});

describe('formatTaskLine', () => {
  test('round-trip', () => {
    const raw = '  - [x] Task #tag ⏫ 📅 2026-10-05';
    const t = parseTaskLine(raw)!;
    expect(formatTaskLine(t)).toBe(raw);
  });

  test('canonical order', () => {
    const t = parseTaskLine('- [ ] Text')!;
    t.fields = { due: '2026-10-05', priority: 'high', reminder: '2026-10-04 09:00', recurrence: 'every day' };
    expect(formatTaskLine(t)).toBe('- [ ] Text ⏫ 🔁 every day ⏰ 2026-10-04 09:00 📅 2026-10-05');
  });

  test('empty description', () => {
    const t = parseTaskLine('- [ ] ')!;
    expect(formatTaskLine(t)).toBe('- [ ]');
  });
});

describe('fieldTokens', () => {
  test('offsets', () => {
    const line = '- [ ] Text 📅 2026-10-05 ⏫';
    const tokens = fieldTokens(line);
    expect(tokens).toHaveLength(2);
    expect(tokens[0].kind).toBe('due');
    expect(line.slice(tokens[0].from, tokens[0].to)).toBe('📅 2026-10-05');
    expect(tokens[1].kind).toBe('priority');
    expect(line.slice(tokens[1].from, tokens[1].to)).toBe('⏫');
  });

  test('non-task line', () => {
    expect(fieldTokens('Not a task')).toEqual([]);
  });
});

describe('tagRanges', () => {
  test('task line', () => {
    const line = '- [ ] Text #a #b/c';
    const ranges = tagRanges(line);
    expect(ranges).toHaveLength(2);
    expect(line.slice(ranges[0].from, ranges[0].to)).toBe('#a');
    expect(ranges[0].tag).toBe('a');
    expect(line.slice(ranges[1].from, ranges[1].to)).toBe('#b/c');
    expect(ranges[1].tag).toBe('b/c');
  });

  test('non-task line', () => {
    const ranges = tagRanges('Text #tag');
    expect(ranges).toHaveLength(1);
    expect(ranges[0].tag).toBe('tag');
  });
});

describe('cancelled status', () => {
  test('[-] is cancelled, not checked', () => {
    expect(parseTaskLine('- [-] Dropped')).toMatchObject({ checked: false, cancelled: true });
    expect(parseTaskLine('- [x] Done')).toMatchObject({ checked: true, cancelled: false });
    expect(parseTaskLine('- [ ] Open')).toMatchObject({ checked: false, cancelled: false });
  });

  test('isOpenTask', () => {
    expect(isOpenTask(parseTaskLine('- [ ] a')!)).toBe(true);
    expect(isOpenTask(parseTaskLine('- [/] a')!)).toBe(true);
    expect(isOpenTask(parseTaskLine('- [x] a')!)).toBe(false);
    expect(isOpenTask(parseTaskLine('- [-] a')!)).toBe(false);
  });
});

describe('block ids and kept Obsidian fields', () => {
  test('a trailing ^block-id does not hide fields', () => {
    const t = parseTaskLine('- [ ] Task 📅 2026-10-05 ^abc-123');
    expect(t?.fields).toEqual({ due: '2026-10-05' });
    expect(t?.blockId).toBe('abc-123');
    expect(t?.description).toBe('Task');
  });

  test('block id on a task without fields', () => {
    const t = parseTaskLine('- [ ] Task ^b1')!;
    expect(t.description).toBe('Task');
    expect(formatTaskLine({ ...t, fields: { due: '2026-10-05' } })).toBe('- [ ] Task 📅 2026-10-05 ^b1');
  });

  test('a caret inside a word is not a block id', () => {
    expect(parseTaskLine('- [ ] x^2')?.blockId).toBeUndefined();
  });

  test('🆔 ⛔ 🏁 ❌ do not stop the field scan and round-trip verbatim', () => {
    const raw = '- [ ] T 🔁 every day 🏁 delete 📅 2026-10-05 🆔 abc ⛔ x1, y2 ❌ 2026-10-01';
    const t = parseTaskLine(raw)!;
    expect(t.fields).toEqual({ recurrence: 'every day', due: '2026-10-05' });
    expect(t.description).toBe('T');
    expect(t.extras?.map((e) => e.raw)).toEqual(['🏁 delete', '🆔 abc', '⛔ x1, y2', '❌ 2026-10-01']);
    expect(formatTaskLine(t)).toBe('- [ ] T 🔁 every day 📅 2026-10-05 🏁 delete 🆔 abc ⛔ x1, y2 ❌ 2026-10-01');
  });

  test('field token offsets account for the block id', () => {
    const line = '- [ ] T 📅 2026-10-05 ^id';
    const [tok] = fieldTokens(line);
    expect(line.slice(tok.from, tok.to)).toBe('📅 2026-10-05');
  });
});
