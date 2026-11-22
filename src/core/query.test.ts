import { describe, expect, test } from 'vitest';
import { indexFile, sortTasks, todayTasks, upcomingTasks, allTags, tagTasks, doneTasks, pendingReminders } from './query';

const SAMPLE = `# List

- [ ] Task A 📅 2026-10-03
- [ ] Task B 📅 2026-10-05 ⏫
  - [ ] Subtask 📅 2026-10-06
- [x] Done ✅ 2026-10-02

## Done
- [x] Old ✅ 2026-10-01
`;

describe('indexFile', () => {
  test('basic', () => {
    const tasks = indexFile('/path/list.md', SAMPLE);
    expect(tasks).toHaveLength(5);
    expect(tasks[0].line).toBe(2);
    expect(tasks[0].task.description).toBe('Task A');
    expect(tasks[0].depth).toBe(0);
    expect(tasks[0].inDone).toBe(false);
    expect(tasks[0].listName).toBe('list');
    expect(tasks[2].depth).toBe(1);
    expect(tasks[4].inDone).toBe(true);
  });

  test('skips blank lines', () => {
    const tasks = indexFile('/x.md', '\n\n- [ ] Task\n\n');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].line).toBe(2);
  });
});

describe('sortTasks', () => {
  test('due ascending', () => {
    const tasks = indexFile('/x.md', '- [ ] C 📅 2026-10-05\n- [ ] A 📅 2026-10-03\n- [ ] B 📅 2026-10-04');
    const sorted = sortTasks(tasks);
    expect(sorted.map((t) => t.task.description)).toEqual(['A', 'B', 'C']);
  });

  test('no due last', () => {
    const tasks = indexFile('/x.md', '- [ ] A\n- [ ] B 📅 2026-10-03');
    const sorted = sortTasks(tasks);
    expect(sorted.map((t) => t.task.description)).toEqual(['B', 'A']);
  });

  test('priority', () => {
    const tasks = indexFile('/x.md', '- [ ] A\n- [ ] B ⏫\n- [ ] C 🔺');
    const sorted = sortTasks(tasks);
    expect(sorted.map((t) => t.task.description)).toEqual(['C', 'B', 'A']);
  });
});

describe('todayTasks', () => {
  test('due today or earlier', () => {
    const tasks = indexFile('/x.md', '- [ ] A 📅 2026-10-03\n- [ ] B 📅 2026-10-04\n- [ ] C 📅 2026-10-02');
    const today = todayTasks(tasks, '2026-10-03');
    expect(today.map((t) => t.task.description)).toEqual(['C', 'A']);
  });

  test('reminder today', () => {
    const tasks = indexFile('/x.md', '- [ ] A ⏰ 2026-10-03 09:00\n- [ ] B ⏰ 2026-10-04 09:00');
    const today = todayTasks(tasks, '2026-10-03');
    expect(today.map((t) => t.task.description)).toEqual(['A']);
  });

  test('excludes checked', () => {
    const tasks = indexFile('/x.md', '- [x] A 📅 2026-10-03\n- [ ] B 📅 2026-10-03');
    const today = todayTasks(tasks, '2026-10-03');
    expect(today.map((t) => t.task.description)).toEqual(['B']);
  });
});

describe('upcomingTasks', () => {
  test('groups by date', () => {
    const tasks = indexFile('/x.md', '- [ ] A 📅 2026-10-05\n- [ ] B 📅 2026-10-05\n- [ ] C 📅 2026-10-06');
    const groups = upcomingTasks(tasks, '2026-10-03', 7);
    expect(groups).toHaveLength(2);
    expect(groups[0].date).toBe('2026-10-05');
    expect(groups[0].tasks).toHaveLength(2);
    expect(groups[1].date).toBe('2026-10-06');
  });

  test('excludes today', () => {
    const tasks = indexFile('/x.md', '- [ ] A 📅 2026-10-03\n- [ ] B 📅 2026-10-04');
    const groups = upcomingTasks(tasks, '2026-10-03', 7);
    expect(groups[0].date).toBe('2026-10-04');
  });

  test('excludes beyond range', () => {
    const tasks = indexFile('/x.md', '- [ ] A 📅 2026-10-15');
    const groups = upcomingTasks(tasks, '2026-10-03', 7);
    expect(groups).toHaveLength(0);
  });
});

describe('allTags', () => {
  test('case-insensitive grouping', () => {
    const tasks = indexFile('/x.md', '- [ ] A #Work\n- [ ] B #work\n- [ ] C #Home');
    const tags = allTags(tasks);
    expect(tags).toHaveLength(2);
    expect(tags.find((t) => t.tag === 'Work')?.count).toBe(2);
    expect(tags.find((t) => t.tag === 'Home')?.count).toBe(1);
  });

  test('sorted', () => {
    const tasks = indexFile('/x.md', '- [ ] A #z\n- [ ] B #a');
    const tags = allTags(tasks);
    expect(tags.map((t) => t.tag)).toEqual(['a', 'z']);
  });

  test('deduplicates per task', () => {
    const tasks = indexFile('/x.md', '- [ ] A #tag #tag');
    const tags = allTags(tasks);
    expect(tags[0].count).toBe(1);
  });
});

describe('tagTasks', () => {
  test('exact match', () => {
    const tasks = indexFile('/x.md', '- [ ] A #work\n- [ ] B #home');
    const result = tagTasks(tasks, 'work');
    expect(result).toHaveLength(1);
    expect(result[0].task.description).toBe('A #work');
  });

  test('nested match', () => {
    const tasks = indexFile('/x.md', '- [ ] A #project/sub\n- [ ] B #project\n- [ ] C #other');
    const result = tagTasks(tasks, 'project');
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.line)).toEqual([0, 1]);
  });

  test('case-insensitive', () => {
    const tasks = indexFile('/x.md', '- [ ] A #Work');
    expect(tagTasks(tasks, 'work')).toHaveLength(1);
  });

  test('excludes checked', () => {
    const tasks = indexFile('/x.md', '- [x] A #tag\n- [ ] B #tag');
    expect(tagTasks(tasks, 'tag')).toHaveLength(1);
  });
});

describe('doneTasks', () => {
  test('sorted by done date desc', () => {
    const tasks = indexFile('/x.md', '- [x] A ✅ 2026-10-01\n- [x] B ✅ 2026-10-03\n- [x] C ✅ 2026-10-02');
    const done = doneTasks(tasks);
    expect(done.map((t) => t.task.description)).toEqual(['B', 'C', 'A']);
  });

  test('undated last', () => {
    const tasks = indexFile('/x.md', '- [x] A ✅ 2026-10-01\n- [x] B');
    const done = doneTasks(tasks);
    expect(done.map((t) => t.task.description)).toEqual(['A', 'B']);
  });
});

describe('pendingReminders', () => {
  test('after now', () => {
    const tasks = indexFile('/x.md', '- [ ] A ⏰ 2026-10-03 10:00\n- [ ] B ⏰ 2026-10-03 09:00');
    const now = new Date(2026, 9, 3, 9, 30);
    const reminders = pendingReminders(tasks, now);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].title).toBe('A');
    expect(reminders[0].at).toBe('2026-10-03 10:00');
  });

  test('date-only defaults 09:00', () => {
    const tasks = indexFile('/x.md', '- [ ] A ⏰ 2026-10-04');
    const now = new Date(2026, 9, 3, 10, 0);
    const reminders = pendingReminders(tasks, now);
    expect(reminders[0].at).toBe('2026-10-04 09:00');
  });

  test('strips tags from title', () => {
    const tasks = indexFile('/x.md', '- [ ] Buy #groceries ⏰ 2026-10-04 09:00');
    const now = new Date(2026, 9, 3);
    const reminders = pendingReminders(tasks, now);
    expect(reminders[0].title).toBe('Buy');
  });

  test('empty description uses list name', () => {
    const tasks = indexFile('/list.md', '- [ ] ⏰ 2026-10-04 09:00');
    const now = new Date(2026, 9, 3);
    const reminders = pendingReminders(tasks, now);
    expect(reminders[0].title).toBe('list');
  });

  test('limit', () => {
    const tasks = indexFile('/x.md', '- [ ] A ⏰ 2026-10-04 09:00\n- [ ] B ⏰ 2026-10-04 10:00\n- [ ] C ⏰ 2026-10-04 11:00');
    const now = new Date(2026, 9, 3);
    const reminders = pendingReminders(tasks, now, 2);
    expect(reminders).toHaveLength(2);
  });

  test('does not silently omit tasks beyond the first 64 reminders', () => {
    const titles = Array.from({ length: 65 }, (_,i) => `task ${i}`);
    const tasks = indexFile('/many.md', titles.map(title => `- [ ] ${title} ⏰ 2026-10-04 09:00`).join('\n'));
    const reminders = pendingReminders(tasks, new Date(2026, 9, 3));
    expect(reminders.map(item => item.title).sort()).toEqual([...titles].sort());
  });
});

