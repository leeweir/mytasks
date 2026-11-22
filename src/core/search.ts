import { splitLines } from './doc';

export interface SearchHit {
  path: string;
  /** 0-based line; -1 = file name match. */
  line: number;
  text: string;
  /** [from, to) character ranges of term occurrences in `text`, sorted and merged. */
  matches: [number, number][];
}

/**
 * Ranges of every occurrence of every term in `text` (lower-cased as `lower`), or null
 * if some term is missing.
 */
function findTerms(text: string, lower: string, terms: string[]): [number, number][] | null {
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

/** Lower-cased file contents from the previous search, keyed by path. */
let lowerCache = new Map<string, { content: string; lower: string }>();

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
  // Rebuilt from the current files so entries of removed files are dropped.
  const previous = lowerCache;
  lowerCache = new Map();
  for (const file of files) {
    const cached = previous.get(file.path);
    const lower = cached && cached.content === file.content ? cached.lower : file.content.toLowerCase();
    lowerCache.set(file.path, { content: file.content, lower });
  }

  const out: SearchHit[] = [];
  for (const file of files) {
    const name = file.path.slice(file.path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    const nameMatches = findTerms(name, name.toLowerCase(), terms);
    if (nameMatches) {
      out.push({ path: file.path, line: -1, text: name, matches: nameMatches });
      if (out.length >= limit) return out;
    }
    const { content } = file;
    const lower = lowerCache.get(file.path)?.lower ?? content.toLowerCase();
    // A line can only match when the whole file contains every term.
    if (terms.some((term) => !lower.includes(term))) continue;

    if (lower.length !== content.length) {
      // Offsets differ between the texts: lower-case line by line.
      const lines = splitLines(content);
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i].text;
        const matches = findTerms(text, text.toLowerCase(), terms);
        if (!matches) continue;
        out.push({ path: file.path, line: i, text, matches });
        if (out.length >= limit) return out;
      }
      continue;
    }

    // Visit only lines containing the first term; line numbers are counted incrementally.
    let line = 0;
    let counted = 0;
    let at = lower.indexOf(terms[0]);
    while (at !== -1) {
      const start = lower.lastIndexOf('\n', at - 1) + 1;
      const nl = lower.indexOf('\n', at);
      const rawEnd = nl === -1 ? lower.length : nl;
      const end = rawEnd > start && content.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
      for (let p = lower.indexOf('\n', counted); p !== -1 && p < start; p = lower.indexOf('\n', p + 1)) {
        line++;
        counted = p + 1;
      }
      const text = content.slice(start, end);
      const matches = findTerms(text, lower.slice(start, end), terms);
      if (matches) {
        out.push({ path: file.path, line, text, matches });
        if (out.length >= limit) return out;
      }
      if (nl === -1) break;
      at = lower.indexOf(terms[0], nl + 1);
    }
  }
  return out;
}
