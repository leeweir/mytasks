import { describe, expect, test } from 'vitest';
import { toggleTask, archiveTask, setTaskFields, applyEdits, lineOffset, fencedLines, RecurrenceError } from './doc';
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

describe('recurrence: dates keep their offsets from the reference date', () => {
  const NOV22 = new Date(2026, 10, 22);
  const nextLine = (text: string, now = NOV22) => applyEdits(text, toggleTask(text, 0, now).edits).split('\n')[0];

  test('when done: reminder moves with the due date', () => {
    expect(nextLine('- [ ] T 🔁 every 3 days when done ⏰ 2026-11-10 09:00 📅 2026-11-10')).toBe(
      '- [ ] T 🔁 every 3 days when done ⏰ 2026-11-25 09:00 📅 2026-11-25',
    );
  });

  test('when done: reminder-only task restarts from today, time kept', () => {
    expect(nextLine('- [ ] T 🔁 every day when done ⏰ 2026-11-01 07:30')).toBe(
      '- [ ] T 🔁 every day when done ⏰ 2026-11-23 07:30',
    );
  });

  test('scheduled-only task gets no invented due date', () => {
    expect(nextLine('- [ ] T 🔁 every week ⏳ 2026-10-01')).toBe('- [ ] T 🔁 every week ⏳ 2026-10-08');
  });

  test('start-only task shifts its start date', () => {
    expect(nextLine('- [ ] T 🔁 every month 🛫 2026-10-15')).toBe('- [ ] T 🔁 every month 🛫 2026-11-15');
  });

  test('when done: every date keeps its offset from due', () => {
    expect(nextLine('- [ ] T 🔁 every week when done ⏰ 2026-11-09 18:00 🛫 2026-11-08 ⏳ 2026-11-09 📅 2026-11-10')).toBe(
      '- [ ] T 🔁 every week when done ⏰ 2026-11-28 18:00 🛫 2026-11-27 ⏳ 2026-11-28 📅 2026-11-29',
    );
  });

  test('reminder is the reference when there is no due date', () => {
    expect(nextLine('- [ ] T 🔁 every week ⏰ 2026-11-20 08:00 ⏳ 2026-11-19')).toBe(
      '- [ ] T 🔁 every week ⏰ 2026-11-27 08:00 ⏳ 2026-11-26',
    );
  });
});

describe('unparseable recurrence', () => {
  test('completing throws RecurrenceError and produces no edits', () => {
    const text = '- [ ] Rent 🔁 every month on the last Friday 📅 2026-11-27';
    expect(() => toggleTask(text, 0, new Date(2026, 10, 22))).toThrow(RecurrenceError);
    expect(() => toggleTask(text, 0, new Date(2026, 10, 22))).toThrow('无法识别的重复规则：every month on the last Friday');
  });

  test('unchecking a completed task with such a rule still works', () => {
    const text = '- [x] Rent 🔁 every month on the last Friday ✅ 2026-11-22';
    expect(applyEdits(text, toggleTask(text, 0, new Date(2026, 10, 22)).edits)).toBe(
      '- [ ] Rent 🔁 every month on the last Friday',
    );
  });
});

describe('fenced code', () => {
  test('fencedLines covers fence lines and content; closing fence needs only whitespace', () => {
    const text = 'a\n```js\n- [ ] x\n```js\n## Done\n```  \nb\n~~~~\n~~~\n';
    expect([...fencedLines(text)]).toEqual([1, 2, 3, 4, 5, 7, 8, 9]);
  });

  test('closing fence must match char and be at least as long', () => {
    expect([...fencedLines('````\n```\n~~~~\n````\nafter')]).toEqual([0, 1, 2, 3]);
  });

  test('a backtick fence info string cannot contain backticks', () => {
    expect([...fencedLines('``` a`b\n- [ ] t')]).toEqual([]);
  });

  test('CRLF text', () => {
    expect([...fencedLines('a\r\n```\r\nb\r\n```\r\nc')]).toEqual([1, 2, 3]);
  });

  test('Done heading inside a fence with an info-string "closing" line is ignored', () => {
    const text = '- [x] A\n```md\n```js\n## Done\n- [x] sample\n```\n';
    const result = applyEdits(text, archiveTask(text, { line: 0, raw: '- [x] A' }));
    expect(result).toBe('```md\n```js\n## Done\n- [x] sample\n```\n\n## Done\n- [x] A\n');
  });

  test('completing a parent does not check task lines in a nested code block', () => {
    const text = '- [ ] Parent\n  ```\n  - [ ] sample\n  ```\n  - [ ] Child';
    expect(applyEdits(text, toggleTask(text, 0, new Date(2026, 9, 3)).edits)).toBe(
      '- [x] Parent ✅ 2026-10-03\n  ```\n  - [ ] sample\n  ```\n  - [x] Child ✅ 2026-10-03',
    );
  });
});

describe('cancelled tasks', () => {
  test('toggling a cancelled task reopens it without spawning a recurrence', () => {
    const text = '- [-] T 🔁 every day 📅 2026-10-01 ❌ 2026-10-02';
    const r = toggleTask(text, 0, new Date(2026, 9, 3));
    expect(r.checkedNow).toBe(false);
    expect(applyEdits(text, r.edits)).toBe('- [ ] T 🔁 every day 📅 2026-10-01');
  });

  test('completing a parent leaves cancelled children alone', () => {
    const text = '- [ ] P\n  - [-] C';
    expect(applyEdits(text, toggleTask(text, 0, new Date(2026, 9, 3)).edits)).toBe('- [x] P ✅ 2026-10-03\n  - [-] C');
  });
});

describe('block ids and kept Obsidian fields', () => {
  const NOW = new Date(2026, 9, 3);

  test('completion keeps ^id at the end of the line', () => {
    const text = '- [ ] Task 📅 2026-10-05 ^abc123';
    expect(applyEdits(text, toggleTask(text, 0, NOW).edits)).toBe('- [x] Task 📅 2026-10-05 ✅ 2026-10-03 ^abc123');
  });

  test('recurrence: id and block id stay on the completed line', () => {
    const text = '- [ ] T 🔁 every day 🏁 delete 📅 2026-10-03 🆔 t1 ^blk';
    expect(applyEdits(text, toggleTask(text, 0, NOW).edits)).toBe(
      '- [ ] T 🔁 every day 📅 2026-10-04 🏁 delete\n- [x] T 🔁 every day 📅 2026-10-03 ✅ 2026-10-03 🏁 delete 🆔 t1 ^blk',
    );
  });

  test('setTaskFields keeps ⛔ and ^id', () => {
    const text = '- [ ] T ⛔ a1,b2 ^x';
    expect(applyEdits(text, setTaskFields(text, 0, { due: '2026-10-05' }))).toBe('- [ ] T 📅 2026-10-05 ⛔ a1,b2 ^x');
  });
});

describe('setTaskFields: clearing a duplicated field', () => {
  test('removes the older duplicate left in the description', () => {
    const text = '- [ ] t 📅 2026-10-01 📅 2026-10-05';
    expect(applyEdits(text, setTaskFields(text, 0, { due: null }))).toBe('- [ ] t');
  });

  test('unchecking removes duplicated done dates', () => {
    const text = '- [x] t ✅ 2026-10-01 ✅ 2026-10-02';
    expect(applyEdits(text, toggleTask(text, 0, new Date(2026, 9, 3)).edits)).toBe('- [ ] t');
  });
});

describe('CRLF input: edits are offsets into the given text', () => {
  test('toggleTask on a middle line', () => {
    const text = '# L\r\n- [ ] A\r\n- [ ] B\r\n- [ ] C\r\n';
    expect(applyEdits(text, toggleTask(text, 2, new Date(2026, 10, 22)).edits)).toBe(
      '# L\r\n- [ ] A\r\n- [x] B ✅ 2026-11-22\r\n- [ ] C\r\n',
    );
  });

  test('toggleTask recurrence inserts a CRLF line', () => {
    const text = 'x\r\n- [ ] R 🔁 every day 📅 2026-11-22\r\n';
    expect(applyEdits(text, toggleTask(text, 1, new Date(2026, 10, 22)).edits)).toBe(
      'x\r\n- [ ] R 🔁 every day 📅 2026-11-23\r\n- [x] R 🔁 every day 📅 2026-11-22 ✅ 2026-11-22\r\n',
    );
  });

  test('setTaskFields on the last line', () => {
    const text = '- [ ] A\r\n- [ ] B 📅 2026-10-05\r\n';
    expect(applyEdits(text, setTaskFields(text, 1, { due: '2026-10-06' }))).toBe('- [ ] A\r\n- [ ] B 📅 2026-10-06\r\n');
  });
});
