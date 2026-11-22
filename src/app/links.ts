import { fencedLines, splitLines } from "../core";
import { resolveRelative } from "./paths";

export type LinkTarget =
  /** Opened by the system through the opener plugin. */
  | { kind: "url"; url: string }
  | { kind: "unsupported"; url: string }
  /** Heading in the document containing the link. */
  | { kind: "heading"; fragment: string }
  /** Absolute path, resolved against the linking document. */
  | { kind: "file"; path: string; fragment: string | null };

const OPENABLE_SCHEME = /^(?:https?|mailto|tel):/i;

export function classifyLink(fromFile: string, href: string): LinkTarget {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return OPENABLE_SCHEME.test(href) ? { kind: "url", url: href } : { kind: "unsupported", url: href };
  }
  const hash = href.indexOf("#");
  const fragment = hash < 0 ? null : href.slice(hash + 1);
  const beforeHash = hash < 0 ? href : href.slice(0, hash);
  const query = beforeHash.indexOf("?");
  const target = query < 0 ? beforeHash : beforeHash.slice(0, query);
  if (!target) return { kind: "heading", fragment: fragment ?? "" };
  return { kind: "file", path: resolveRelative(fromFile, target), fragment: fragment || null };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** GitHub-style anchor: lowercase, punctuation dropped, whitespace runs become '-'. */
function slug(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

const ATX = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

/**
 * 0-based line of the ATX heading a link fragment refers to, outside fenced code.
 * Accepts Obsidian (`#My Heading`) and GitHub (`#my-heading`) styles; exact text wins.
 */
export function findHeadingLine(doc: string, fragment: string): number | null {
  const wanted = decode(fragment).trim();
  if (!wanted) return null;
  const fenced = fencedLines(doc);
  const lines = splitLines(doc);
  let bySlug: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue;
    const m = ATX.exec(lines[i].text);
    if (!m) continue;
    const text = (m[1] ?? "").trim();
    if (text === wanted) return i;
    if (bySlug === null && slug(text) === slug(wanted)) bySlug = i;
  }
  return bySlug;
}
