import { Text } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { AT_QUERY, frontMatterEndLine, minimalEdit } from './helpers';

// ---------------------------------------------------------------------------
// minimalEdit

describe('minimalEdit', () => {
  it('returns unchanged range when strings are identical', () => {
    const r = minimalEdit(0, 5, 'hello', 'hello');
    expect(r.from).toBe(r.to);
    expect(r.insert).toBe('');
  });

  it('trims common prefix', () => {
    // from=10, to=16 (== 10 + 'abcXYZ'.length)
    const r = minimalEdit(10, 16, 'abcXYZ', 'abcDEF');
    expect(r.from).toBe(13);
    expect(r.to).toBe(16);
    expect(r.insert).toBe('DEF');
  });

  it('trims common suffix', () => {
    // from=0, to=6 (== 0 + 'XYZabc'.length)
    const r = minimalEdit(0, 6, 'XYZabc', 'DEFabc');
    expect(r.from).toBe(0);
    expect(r.to).toBe(3);
    expect(r.insert).toBe('DEF');
  });

  it('trims both prefix and suffix', () => {
    // "- [ ] task text" → "- [x] task text": only the status char changes
    const before = '- [ ] task text';
    const after  = '- [x] task text';
    const r = minimalEdit(0, before.length, before, after);
    expect(r.insert).toBe('x');
    expect(r.from).toBe(3);
    expect(r.to).toBe(4);
  });

  it('handles insertion (from === to)', () => {
    const r = minimalEdit(5, 5, '', 'NEW');
    expect(r.from).toBe(5);
    expect(r.to).toBe(5);
    expect(r.insert).toBe('NEW');
  });

  it('handles deletion (insert is empty)', () => {
    const r = minimalEdit(0, 3, 'abc', '');
    expect(r.from).toBe(0);
    expect(r.to).toBe(3);
    expect(r.insert).toBe('');
  });

  it('honours the from offset', () => {
    // from=100, to=105 (== 100 + 'aaXaa'.length)
    const r = minimalEdit(100, 105, 'aaXaa', 'aaYaa');
    expect(r.from).toBe(102);
    expect(r.to).toBe(103);
    expect(r.insert).toBe('Y');
  });
});

// ---------------------------------------------------------------------------
// frontMatterEndLine

describe('frontMatterEndLine', () => {
  const end = (lines: string[]) => frontMatterEndLine(Text.of(lines));

  it('returns 0 for empty doc', () => {
    expect(end([''])).toBe(0);
  });

  it('returns 0 when first line is not ---', () => {
    expect(end(['# Title', '---', '---'])).toBe(0);
  });

  it('returns 0 when no closing ---', () => {
    expect(end(['---', 'tags: work'])).toBe(0);
  });

  it('returns 1-based line of closing --- (simple)', () => {
    expect(end(['---', 'tags: work', '---'])).toBe(3);
  });

  it('returns line of first closing ---', () => {
    expect(end(['---', 'a: 1', '---', 'b: 2', '---'])).toBe(3);
  });

  it('returns 0 for a single ---', () => {
    expect(end(['---'])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AT_QUERY trigger regex

describe('AT_QUERY', () => {
  const matches = (text: string) => AT_QUERY.test(text);
  const capture = (text: string) => AT_QUERY.exec(text)?.[1];

  it('matches at line start', () => {
    expect(matches('@due')).toBe(true);
    expect(capture('@due')).toBe('due');
  });

  it('matches after a space', () => {
    expect(matches('some text @due')).toBe(true);
    expect(capture('some text @due')).toBe('due');
  });

  it('matches after a tab', () => {
    expect(matches('text\t@due')).toBe(true);
  });

  it('matches after a CJK character (no space)', () => {
    expect(matches('买菜@明天')).toBe(true);
    expect(capture('买菜@明天')).toBe('明天');
  });

  it('does not match after a non-whitespace latin character', () => {
    expect(matches('abc@due')).toBe(false);
  });

  it('captures multi-word query', () => {
    expect(capture('task @due next')).toBe('due next');
  });

  it('limits capture to 30 chars', () => {
    const long = 'a'.repeat(35);
    const m = AT_QUERY.exec('@' + long);
    if (m) expect(m[1].length).toBeLessThanOrEqual(30);
  });
});
