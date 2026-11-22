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
