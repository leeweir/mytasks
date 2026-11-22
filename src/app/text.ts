import { splitLines } from "../core";

export type Eol = "\n" | "\r\n";

/** The line ending most of the file uses; ties and single-line files default to LF. */
export function detectEol(text: string): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return crlf > lf ? "\r\n" : "\n";
}

/** LF-only text, splitting lines exactly like CodeMirror's default (`\r\n`, `\r`, `\n`). */
export function toLF(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

export function fromLF(text: string, eol: Eol): string {
  return eol === "\n" ? text : text.replace(/\n/g, "\r\n");
}

/** A task was addressed by line, but that line no longer holds the same text. */
export class StaleTaskError extends Error {
  constructor() {
    super("任务已变化，请重试");
  }
}

/** Throws StaleTaskError unless line `line` of `text` is exactly `raw`. */
export function assertLine(text: string, line: number, raw: string): void {
  if (splitLines(text)[line]?.text !== raw) throw new StaleTaskError();
}

/** Text of a 0-based line, or undefined when out of range. */
export function lineText(text: string, line: number): string | undefined {
  return splitLines(text)[line]?.text;
}

/**
 * A file or folder name typed by the user: no path separators, and no leading '.', since
 * hidden entries are skipped by the vault listing and the item would vanish.
 */
export function isValidName(name: string): boolean {
  return name !== "" && !/[/\\:]/.test(name) && !name.startsWith(".");
}
