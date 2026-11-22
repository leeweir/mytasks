import { describe, expect, test } from 'vitest';
import { searchVault } from './search';

describe('searchVault', () => {
  test('all terms must match', () => {
    const files = [
      { path: '/a.md', content: 'hello world' },
      { path: '/b.md', content: 'hello there' },
    ];
    const hits = searchVault(files, 'hello world');
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe('/a.md');
  });

  test('case-insensitive', () => {
    const files = [{ path: '/a.md', content: 'Hello World' }];
    const hits = searchVault(files, 'hello world');
    expect(hits).toHaveLength(1);
  });

  test('filename match', () => {
    const files = [{ path: '/folder/shopping-list.md', content: 'Text' }];
    const hits = searchVault(files, 'shopping');
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(-1);
    expect(hits[0].text).toBe('shopping-list');
  });

  test('filename and line matches', () => {
    const files = [{ path: '/work.md', content: 'Work task\nOther' }];
    const hits = searchVault(files, 'work');
    expect(hits).toHaveLength(2);
    expect(hits[0].line).toBe(-1);
    expect(hits[1].line).toBe(0);
  });

  test('match ranges', () => {
    const files = [{ path: '/a.md', content: 'hello world hello' }];
    const hits = searchVault(files, 'hello');
    expect(hits[0].matches).toEqual([
      [0, 5],
      [12, 17],
    ]);
  });

  test('ranges for each term, overlapping merged', () => {
    const files = [{ path: '/a.md', content: 'hello world' }];
    expect(searchVault(files, 'hello world')[0].matches).toEqual([
      [0, 5],
      [6, 11],
    ]);
    expect(searchVault(files, 'hell ello')[0].matches).toEqual([[0, 5]]);
  });

  test('limit', () => {
    const files = [{ path: '/a.md', content: 'match\nmatch\nmatch' }];
    const hits = searchVault(files, 'match', 2);
    expect(hits).toHaveLength(2);
  });

  test('empty query', () => {
    const files = [{ path: '/a.md', content: 'Text' }];
    expect(searchVault(files, '')).toHaveLength(0);
  });
});

describe('searchVault: line numbers and caching', () => {
  test('line numbers and text in LF and CRLF files', () => {
    const files = [
      { path: '/a.md', content: 'one\ntwo Foo\nthree\nfoo four' },
      { path: '/b.md', content: 'x\r\nFOO y\r\n\r\nz foo\r\n' },
    ];
    expect(searchVault(files, 'foo').map((h) => [h.path, h.line, h.text, h.matches])).toEqual([
      ['/a.md', 1, 'two Foo', [[4, 7]]],
      ['/a.md', 3, 'foo four', [[0, 3]]],
      ['/b.md', 1, 'FOO y', [[0, 3]]],
      ['/b.md', 3, 'z foo', [[2, 5]]],
    ]);
  });

  test('all terms on one line, first term found on several lines', () => {
    const files = [{ path: '/a.md', content: 'alpha\nalpha beta\nbeta alpha alpha' }];
    expect(searchVault(files, 'alpha beta').map((h) => h.line)).toEqual([1, 2]);
  });

  test('changed content is searched afresh', () => {
    expect(searchVault([{ path: '/a.md', content: 'old text' }], 'new')).toEqual([]);
    expect(searchVault([{ path: '/a.md', content: 'new text' }], 'new').map((h) => h.line)).toEqual([0]);
  });

  test('files where lower-casing changes length still report correct lines', () => {
    const hits = searchVault([{ path: '/a.md', content: 'İstanbul\nfoo bar\nİ bar' }], 'bar');
    // Ranges are exact only on lines whose lower-casing keeps their length.
    expect(hits.map((h) => [h.line, h.text, h.matches])).toEqual([
      [1, 'foo bar', [[4, 7]]],
      [2, 'İ bar', []],
    ]);
  });
});
