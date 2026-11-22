import { describe, expect, test } from 'vitest';
import { toggleTask, archiveTask, setTaskFields, applyEdits, lineOffset } from './doc';
import type { TextEdit } from './types';

describe('lineOffset', () => {
  test('basic', () => {
    const text = 'a\nb\nc';
    expect(lineOffset(text, 0)).toBe(0);
    expect(lineOffset(text, 1)).toBe(2);
    expect(lineOffset(text, 2)).toBe(4);
    expect(lineOffset(text, 10)).toBe(5);
  });
});

describe('CRLF documents', () => {
  test('toggle and archive keep CRLF line endings', () => {
    const text = '- [ ] A\r\n- [ ] B\r\n';
    const toggled = toggleTask(text, 0, new Date(2026, 9, 3));
    const after = applyEdits(text, toggled.edits);
    expect(after).toBe('- [x] A ✅ 2026-10-03\r\n- [ ] B\r\n');
    const archived = applyEdits(after, archiveTask(after, toggled.archiveCandidate!));
    expect(archived).toBe('- [ ] B\r\n\r\n## Done\r\n- [x] A ✅ 2026-10-03\r\n');
  });
});

describe('applyEdits', () => {
  test('single edit', () => {
    expect(applyEdits('hello world', [{ from: 6, to: 11, insert: 'there' }])).toBe('hello there');
  });

  test('multiple edits', () => {
    const text = 'one two three';
    const edits: TextEdit[] = [
      { from: 0, to: 3, insert: '1' },
      { from: 8, to: 13, insert: '3' },
    ];
    expect(applyEdits(text, edits)).toBe('1 two 3');
  });

  test('insertion', () => {
    expect(applyEdits('ab', [{ from: 1, to: 1, insert: 'X' }])).toBe('aXb');
  });
});

describe('toggleTask', () => {
  test('check plain task', () => {
    const text = '- [ ] Task';
    const { edits, checkedNow, archiveCandidate } = toggleTask(text, 0, new Date(2026, 9, 3));
    expect(checkedNow).toBe(true);
    expect(applyEdits(text, edits)).toBe('- [x] Task ✅ 2026-10-03');
    expect(archiveCandidate).toEqual({ line: 0, raw: '- [x] Task ✅ 2026-10-03' });
  });

  test('uncheck removes done date', () => {
    const text = '- [x] Task ✅ 2026-10-03';
    const { edits, checkedNow, archiveCandidate } = toggleTask(text, 0, new Date(2026, 9, 5));
    expect(checkedNow).toBe(false);
    expect(applyEdits(text, edits)).toBe('- [ ] Task');
    expect(archiveCandidate).toBeNull();
  });

  test('check with descendants', () => {
    const text = '- [ ] Parent\n  - [ ] Child\n  - [x] Already done';
    const { edits, checkedNow } = toggleTask(text, 0, new Date(2026, 9, 3));
    expect(checkedNow).toBe(true);
    const result = applyEdits(text, edits);
    expect(result).toBe(
      '- [x] Parent ✅ 2026-10-03\n  - [x] Child ✅ 2026-10-03\n  - [x] Already done',
    );
  });

  test('recurring task creates new line above', () => {
    const text = 'Intro\n- [ ] Task 📅 2026-10-05 🔁 every day\n  - [ ] Sub';
    const { edits, checkedNow, archiveCandidate } = toggleTask(text, 1, new Date(2026, 9, 3));
    expect(checkedNow).toBe(true);
    const result = applyEdits(text, edits);
    expect(result).toBe(
      'Intro\n- [ ] Task 🔁 every day 📅 2026-10-06\n- [x] Task 🔁 every day 📅 2026-10-05 ✅ 2026-10-03\n  - [x] Sub ✅ 2026-10-03',
    );
    expect(archiveCandidate).toEqual({ line: 2, raw: '- [x] Task 🔁 every day 📅 2026-10-05 ✅ 2026-10-03' });
    // The identity reflects the post-edit text, so archiving finds the line directly.
    const archived = applyEdits(result, archiveTask(result, archiveCandidate!));
    expect(archived).toBe(
      'Intro\n- [ ] Task 🔁 every day 📅 2026-10-06\n\n## Done\n- [x] Task 🔁 every day 📅 2026-10-05 ✅ 2026-10-03\n  - [x] Sub ✅ 2026-10-03\n',
    );
  });

  test('recurring with due and reminder shifts both by the same delta', () => {
    const text = '- [ ] Pay rent 🔁 every month on the 1st ⏰ 2026-09-30 18:00 🛫 2026-09-28 📅 2026-10-01';
    const { edits } = toggleTask(text, 0, new Date(2026, 9, 3));
    expect(applyEdits(text, edits)).toBe(
      '- [ ] Pay rent 🔁 every month on the 1st ⏰ 2026-10-31 18:00 🛫 2026-10-29 📅 2026-11-01\n' +
        '- [x] Pay rent 🔁 every month on the 1st ⏰ 2026-09-30 18:00 🛫 2026-09-28 📅 2026-10-01 ✅ 2026-10-03',
    );
  });

  test('recurring weekday rule without due uses today as base', () => {
    const text = '- [ ] Gym 🔁 every week on Monday, Wednesday';
    const { edits } = toggleTask(text, 0, new Date(2026, 9, 3));
    expect(applyEdits(text, edits).split('\n')[0]).toBe('- [ ] Gym 🔁 every week on Monday, Wednesday 📅 2026-10-05');
  });

  test('recurring with reminder shifts time', () => {
    const text = '- [ ] Wake up ⏰ 2026-10-05 08:00 🔁 every day';
    const { edits } = toggleTask(text, 0, new Date(2026, 9, 5, 9, 0));
    const result = applyEdits(text, edits);
    expect(result).toContain('⏰ 2026-10-06 08:00');
  });

  test('nested task has no archive candidate', () => {
    const text = 'Top\n  - [ ] Nested';
    const { archiveCandidate } = toggleTask(text, 1, new Date(2026, 9, 3));
    expect(archiveCandidate).toBeNull();
  });

  test('task in done section has no archive candidate', () => {
    const text = '## Done\n- [ ] Task';
    const { archiveCandidate } = toggleTask(text, 1, new Date(2026, 9, 3));
    expect(archiveCandidate).toBeNull();
  });
});

describe('archiveTask', () => {
  test('creates done section', () => {
    const text = '- [x] Task ✅ 2026-10-03';
    const edits = archiveTask(text, { line: 0, raw: '- [x] Task ✅ 2026-10-03' });
    const result = applyEdits(text, edits);
    expect(result).toBe('## Done\n- [x] Task ✅ 2026-10-03\n');
  });

  test('creates done section after content with blank line', () => {
    const text = '# List\n- [x] Task\n- [ ] Other\n';
    const result = applyEdits(text, archiveTask(text, { line: 1, raw: '- [x] Task' }));
    expect(result).toBe('# List\n- [ ] Other\n\n## Done\n- [x] Task\n');
  });

  test('inserts above existing done items and leaves following sections alone', () => {
    const text = '- [x] New\n- [ ] Keep\n\n## Done\n\n- [x] Old\n\n## Notes\ntext';
    const edits = archiveTask(text, { line: 0, raw: '- [x] New' });
    expect(edits).toHaveLength(2);
    expect(applyEdits(text, edits)).toBe('- [ ] Keep\n\n## Done\n\n- [x] New\n- [x] Old\n\n## Notes\ntext');
  });

  test('task already inside done section is not moved', () => {
    const text = '## Done\n- [x] Old';
    expect(archiveTask(text, { line: 1, raw: '- [x] Old' })).toEqual([]);
  });

  test('missing identity is a no-op', () => {
    expect(archiveTask('- [x] A', { line: 0, raw: '- [x] B' })).toEqual([]);
  });

  test('non-task identity is a no-op', () => {
    const text = 'Other\n\n## Done\n- [x] Old';
    const edits = archiveTask(text, { line: 0, raw: 'Other' });
    expect(edits).toEqual([]);
  });

  test('moves to top of done section', () => {
    const text = '- [x] New ✅ 2026-10-03\n\n## Done\n- [x] Old ✅ 2026-10-02';
    const edits = archiveTask(text, { line: 0, raw: '- [x] New ✅ 2026-10-03' });
    const result = applyEdits(text, edits);
    expect(result).toBe('\n## Done\n- [x] New ✅ 2026-10-03\n- [x] Old ✅ 2026-10-02');
  });

  test('moves subtree', () => {
    const text = '- [x] Parent\n  - [x] Child\n\n## Done';
    const edits = archiveTask(text, { line: 0, raw: '- [x] Parent' });
    const result = applyEdits(text, edits);
    expect(result).toBe('\n## Done\n- [x] Parent\n  - [x] Child');
  });

  test('unchecked task not archived', () => {
    const text = '- [ ] Task';
    const edits = archiveTask(text, { line: 0, raw: '- [ ] Task' });
    expect(edits).toEqual([]);
  });

  test('identity: line match preferred', () => {
    const text = '- [x] Task\n- [x] Task';
    const edits = archiveTask(text, { line: 1, raw: '- [x] Task' });
    const result = applyEdits(text, edits);
    expect(result).toBe('- [x] Task\n\n## Done\n- [x] Task\n');
  });

  test('identity: fallback to raw match', () => {
    const text = '- [x] A\n- [x] Target';
    const edits = archiveTask(text, { line: 0, raw: '- [x] Target' });
    const result = applyEdits(text, edits);
    expect(result).toBe('- [x] A\n\n## Done\n- [x] Target\n');
  });

  test('subtree with blank lines', () => {
    const text = '- [x] Parent\n\n  - [x] Child\n\n## Done';
    const edits = archiveTask(text, { line: 0, raw: '- [x] Parent' });
    const result = applyEdits(text, edits);
    expect(result).toBe('\n## Done\n- [x] Parent\n\n  - [x] Child');
  });
});

describe('setTaskFields', () => {
  test('add field', () => {
    const text = '- [ ] Task';
    const edits = setTaskFields(text, 0, { due: '2026-10-05' });
    expect(applyEdits(text, edits)).toBe('- [ ] Task 📅 2026-10-05');
  });

  test('remove field', () => {
    const text = '- [ ] Task 📅 2026-10-05';
    const edits = setTaskFields(text, 0, { due: null });
    expect(applyEdits(text, edits)).toBe('- [ ] Task');
  });

  test('update field', () => {
    const text = '- [ ] Task 📅 2026-10-05';
    const edits = setTaskFields(text, 0, { due: '2026-10-06' });
    expect(applyEdits(text, edits)).toBe('- [ ] Task 📅 2026-10-06');
  });

  test('non-task line', () => {
    const edits = setTaskFields('Text', 0, { due: '2026-10-05' });
    expect(edits).toEqual([]);
  });

  test('no change', () => {
    const text = '- [ ] Task 📅 2026-10-05';
    const edits = setTaskFields(text, 0, { due: '2026-10-05' });
    expect(edits).toEqual([]);
  });
});
