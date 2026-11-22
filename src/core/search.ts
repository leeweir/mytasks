import { splitLines } from './doc';

export interface SearchHit {
  path: string;
  /** 0-based line; -1 = file name match. */
  line: number;
  text: string;
  /** [from, to) character ranges of term occurrences in `text`, sorted and merged. */
  matches: [number, number][];
}

/** Ranges of every occurrence of every term, or null if some term is missing. */
function findTerms(text: string, terms: string[]): [number, number][] | null {
  const lower = text.toLowerCase();
  // Lower-casing can change length for a few characters; offsets are only exact when it doesn't.
  const exact = lower.length === text.length;
  const ranges: [number, number][] = [];
  for (const term of terms) {
    let at = lower.indexOf(term);
    if (at === -1) return null;
    while (at !== -1) {
      if (exact) ranges.push([at, at + term.length]);
      at = lower.indexOf(term, at + term.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/**
 * Case-insensitive search: every whitespace-separated term must appear in the line
 * (or in the file name, reported with line -1 before the file's line hits).
 */
export function searchVault(
  files: { path: string; content: string }[],
  query: string,
  limit = 200,
): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0 || limit <= 0) return [];
  const out: SearchHit[] = [];
  for (const file of files) {
    const name = file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    const nameMatches = findTerms(name, terms);
    if (nameMatches) {
      out.push({ path: file.path, line: -1, text: name, matches: nameMatches });
      if (out.length >= limit) return out;
    }
    const lines = splitLines(file.content);
    for (let i = 0; i < lines.length; i++) {
      const matches = findTerms(lines[i].text, terms);
      if (!matches) continue;
      out.push({ path: file.path, line: i, text: lines[i].text, matches });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
