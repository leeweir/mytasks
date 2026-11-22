import { describe, expect, test } from 'vitest';
import { suggest } from './nlp';
import { addDays, addMonths, diffDays, weekdayOf, toISODate, parseISODate } from './dates';

// Saturday 2026-10-03 10:30 local time.
const NOW = new Date(2026, 9, 3, 10, 30);
const inserts = (q: string) => suggest(q, NOW).map((s) => s.insert);
const first = (q: string) => suggest(q, NOW)[0];

describe('dates helpers', () => {
  test('basics', () => {
    expect(toISODate(NOW)).toBe('2026-10-03');
    expect(toISODate(parseISODate('2026-02-28'))).toBe('2026-02-28');
    expect(weekdayOf('2026-10-03')).toBe(6);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(diffDays('2026-10-03', '2026-11-03')).toBe(31);
  });
});

describe('suggest: Chinese dates', () => {
  test.each([
    ['今天', '📅 2026-10-03'],
    ['明天', '📅 2026-10-04'],
    ['后天', '📅 2026-10-05'],
    ['大后天', '📅 2026-10-06'],
    ['昨天', '📅 2026-10-02'],
    ['周一', '📅 2026-10-05'],
    ['星期三', '📅 2026-10-07'],
    ['礼拜五', '📅 2026-10-09'],
    ['周五', '📅 2026-10-09'], // past weekday → next occurrence
    ['周六', '📅 2026-10-03'],
    ['下周一', '📅 2026-10-05'],
    ['下周五', '📅 2026-10-09'],
    ['这周五', '📅 2026-10-09'],
    ['本周日', '📅 2026-10-04'],
    ['3天后', '📅 2026-10-06'],
    ['2周后', '📅 2026-10-17'],
    ['1个月后', '📅 2026-11-03'],
    ['10月5日', '📅 2026-10-05'],
    ['10月5号', '📅 2026-10-05'],
    ['10-5', '📅 2026-10-05'],
    ['10/5', '📅 2026-10-05'],
    ['2026-10-05', '📅 2026-10-05'],
    ['1月5日', '📅 2027-01-05'], // past month-day rolls to next year
    ['下个月', '📅 2026-11-03'],
    ['月底', '📅 2026-10-31'],
  ])('%s', (q, insert) => {
    expect(first(q).insert).toBe(insert);
  });

  test('labels are Chinese and detail shows weekday', () => {
    const s = first('明天');
    expect(s.label).toBe('截止 明天');
    expect(s.detail).toBe('2026-10-04 周日');
  });
});

describe('suggest: Chinese times', () => {
  test('date + time offers reminder first, then due', () => {
    expect(inserts('明天下午3点')).toEqual(['⏰ 2026-10-04 15:00', '📅 2026-10-04']);
    expect(inserts('明天 9点半')).toEqual(['⏰ 2026-10-04 09:30', '📅 2026-10-04']);
  });

  test.each([
    ['9点', '⏰ 2026-10-04 09:00'], // 09:00 already passed today
    ['9:30', '⏰ 2026-10-04 09:30'],
    ['上午11点', '⏰ 2026-10-03 11:00'],
    ['下午3点', '⏰ 2026-10-03 15:00'],
    ['晚上8点', '⏰ 2026-10-03 20:00'],
    ['中午', '⏰ 2026-10-03 12:00'],
    ['早上', '⏰ 2026-10-04 09:00'],
    ['今晚', '⏰ 2026-10-03 20:00'],
  ])('%s', (q, insert) => {
    expect(first(q).insert).toBe(insert);
  });

  test('reminder keyword', () => {
    expect(inserts('提醒 明天')).toEqual(['⏰ 2026-10-04 09:00']);
    expect(inserts('提醒我 后天 下午2点')).toEqual(['⏰ 2026-10-05 14:00']);
    expect(first('提醒').insert).toMatch(/^⏰ /);
  });
});

describe('suggest: Chinese recurrence & priority', () => {
  test.each([
    ['每天', '🔁 every day'],
    ['每日', '🔁 every day'],
    ['每周', '🔁 every week'],
    ['每周一', '🔁 every week on Monday'],
    ['每周一三五', '🔁 every week on Monday, Wednesday, Friday'],
    ['每周一、周三', '🔁 every week on Monday, Wednesday'],
    ['每两周', '🔁 every 2 weeks'],
    ['每月', '🔁 every month'],
    ['每月15号', '🔁 every month on the 15th'],
    ['每月最后一天', '🔁 every month on the last'],
    ['每年', '🔁 every year'],
    ['工作日', '🔁 every weekday'],
    ['每3天', '🔁 every 3 days'],
    ['最高', '🔺'],
    ['紧急', '🔺'],
    ['高', '⏫'],
    ['重要', '⏫'],
    ['中', '🔼'],
    ['低', '🔽'],
    ['最低', '⏬'],
    ['p1', '🔺'],
    ['p2', '⏫'],
  ])('%s', (q, insert) => {
    expect(first(q).insert).toBe(insert);
  });

  test('recurrence with time adds reminder at first occurrence', () => {
    expect(first('每周一 9点').insert).toBe('🔁 every week on Monday ⏰ 2026-10-05 09:00');
  });

  test('priority combined', () => {
    expect(first('明天 高').insert).toBe('⏫ 📅 2026-10-04');
  });
});

describe('suggest: English', () => {
  test.each([
    ['today', '📅 2026-10-03'],
    ['tomorrow', '📅 2026-10-04'],
    ['mon', '📅 2026-10-05'],
    ['friday', '📅 2026-10-09'],
    ['next friday', '📅 2026-10-09'],
    ['next monday', '📅 2026-10-05'],
    ['in 3 days', '📅 2026-10-06'],
    ['in 2 weeks', '📅 2026-10-17'],
    ['oct 5', '📅 2026-10-05'],
    ['5 oct', '📅 2026-10-05'],
    ['9am', '⏰ 2026-10-04 09:00'],
    ['3:30pm', '⏰ 2026-10-03 15:30'],
    ['15:00', '⏰ 2026-10-03 15:00'],
    ['noon', '⏰ 2026-10-03 12:00'],
    ['tonight', '⏰ 2026-10-03 20:00'],
    ['every day', '🔁 every day'],
    ['every week', '🔁 every week'],
    ['every month', '🔁 every month'],
    ['every year', '🔁 every year'],
    ['every 3 days', '🔁 every 3 days'],
    ['every monday', '🔁 every week on Monday'],
    ['every mon, wed', '🔁 every week on Monday, Wednesday'],
    ['every month on the 15th', '🔁 every month on the 15th'],
    ['every month last day', '🔁 every month on the last'],
    ['every weekday', '🔁 every weekday'],
    ['highest', '🔺'],
    ['urgent', '🔺'],
    ['high', '⏫'],
    ['medium', '🔼'],
    ['low', '🔽'],
    ['lowest', '⏬'],
  ])('%s', (q, insert) => {
    expect(first(q).insert).toBe(insert);
  });

  test('date + time offers both', () => {
    expect(inserts('tomorrow 9am')).toEqual(['⏰ 2026-10-04 09:00', '📅 2026-10-04']);
  });

  test('remind keyword defaults to 09:00', () => {
    expect(inserts('remind me tomorrow')).toEqual(['⏰ 2026-10-04 09:00']);
    expect(inserts('remind tomorrow at 3pm')).toEqual(['⏰ 2026-10-04 15:00']);
  });

  test('labels are English', () => {
    const s = first('tomorrow');
    expect(s.label).toBe('Due Tomorrow');
    expect(s.detail).toBe('2026-10-04 Sun');
  });
});

describe('suggest: prefixes and defaults', () => {
  test('partial Chinese', () => {
    expect(inserts('明')).toContain('📅 2026-10-04');
    expect(inserts('每周')).toContain('🔁 every week on Monday');
  });

  test('partial English', () => {
    expect(first('tom').insert).toBe('📅 2026-10-04');
    expect(inserts('every')).toContain('🔁 every day');
    expect(inserts('in 3')).toContain('📅 2026-10-06');
  });

  test('partial completion after a parsed head', () => {
    expect(inserts('明天 下')).toContain('⏰ 2026-10-04 15:00');
  });

  test('empty query gives defaults', () => {
    expect(inserts('')).toEqual([
      '📅 2026-10-03',
      '📅 2026-10-04',
      '📅 2026-10-05',
      '⏰ 2026-10-04 09:00',
      '🔁 every day',
      '🔁 every week',
      '⏫',
    ]);
  });

  test('unknown input yields nothing', () => {
    expect(suggest('xyzzy', NOW)).toEqual([]);
  });

  test('at most 8 suggestions, unique inserts', () => {
    const list = inserts('每');
    expect(list.length).toBeLessThanOrEqual(8);
    expect(new Set(list).size).toBe(list.length);
  });
});

describe('suggest: first reminder of rules without a fixed day', () => {
  // NOW is Saturday 2026-10-03 10:30.
  test.each([
    ['每周 9点', '🔁 every week ⏰ 2026-10-10 09:00'], // 09:00 passed → next week
    ['every week 11am', '🔁 every week ⏰ 2026-10-03 11:00'],
    ['每月 11点', '🔁 every month ⏰ 2026-10-03 11:00'],
    ['每月 9点', '🔁 every month ⏰ 2026-11-03 09:00'],
    ['每年 提醒', '🔁 every year ⏰ 2027-10-03 09:00'],
    ['每3天 下午3点', '🔁 every 3 days ⏰ 2026-10-03 15:00'],
    ['每月15号 9点', '🔁 every month on the 15th ⏰ 2026-10-15 09:00'],
  ])('%s', (q, insert) => {
    expect(first(q).insert).toBe(insert);
  });
});

describe('suggest: ambiguities', () => {
  test('晚上/夜里 12点 is the following midnight', () => {
    expect(first('晚上12点').insert).toBe('⏰ 2026-10-04 00:00');
    expect(first('夜里12点').insert).toBe('⏰ 2026-10-04 00:00');
    expect(first('明天晚上12点').insert).toBe('⏰ 2026-10-05 00:00');
    expect(first('明晚12点').insert).toBe('⏰ 2026-10-05 00:00');
    expect(first('晚上11点').insert).toBe('⏰ 2026-10-03 23:00');
    expect(first('中午12点').insert).toBe('⏰ 2026-10-03 12:00');
  });

  test('Feb 29 rolls to the next leap year', () => {
    expect(first('2/29').insert).toBe('📅 2028-02-29');
    expect(first('2月29日').insert).toBe('📅 2028-02-29');
    expect(suggest('2027-02-29', NOW)).toEqual([]);
  });

  test('weekend and 周末 agree on a Sunday', () => {
    const sunday = new Date(2026, 9, 4, 10, 0);
    expect(suggest('weekend', sunday)[0].insert).toBe('📅 2026-10-04');
    expect(suggest('周末', sunday)[0].insert).toBe('📅 2026-10-04');
    expect(first('weekend').insert).toBe('📅 2026-10-03');
  });
});
