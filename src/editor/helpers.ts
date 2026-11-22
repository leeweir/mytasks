/**
 * Pure, side-effect-free helpers shared between editor modules and unit tests.
 */

/** Trims an edit to its minimal diff (common prefix + suffix removed).
 *  Prevents cursor jumps when the replaced region hasn't actually changed. */
export function minimalEdit(
  from: number,
  to: number,
  currentSlice: string,
  insert: string,
): { from: number; to: number; insert: string } {
  let pre = 0;
  while (pre < currentSlice.length && pre < insert.length && currentSlice[pre] === insert[pre]) pre++;
  let suf = 0;
  while (
    suf < currentSlice.length - pre &&
    suf < insert.length - pre &&
    currentSlice[currentSlice.length - 1 - suf] === insert[insert.length - 1 - suf]
  )
    suf++;
  return {
    from: from + pre,
    to: to - suf,
    insert: insert.slice(pre, insert.length - suf),
  };
}

/** Returns the 1-based line number of the closing `---` of a YAML front-matter
 *  block, or 0 when the document does not begin with a valid block.
 *  Accepts a CodeMirror `Text` (or anything with the same line accessors). */
export function frontMatterEndLine(doc: { readonly lines: number; line(n: number): { readonly text: string } }): number {
  if (doc.lines < 2 || doc.line(1).text !== '---') return 0;
  for (let i = 2; i <= doc.lines; i++) {
    if (doc.line(i).text === '---') return i;
  }
  return 0;
}

/** `@`-completion trigger: line-start, whitespace, or a CJK Han character
 *  immediately before `@`, then up to 30 non-newline chars to the cursor. */
export const AT_QUERY = /(?:^|[\s\p{Script=Han}])@([^@\n]{0,30})$/u;
