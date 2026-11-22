import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { suggest } from '../core';

/** '@' at line start or after whitespace, then up to 30 chars (spaces allowed) up to the cursor. */
const AT_QUERY = /(?:^|\s)@([^@\n]{0,30})$/;

function applySuggestion(insert: string) {
  return (view: EditorView, _completion: Completion, from: number, to: number) => {
    const doc = view.state.doc;
    const before = from > 0 ? doc.sliceString(from - 1, from) : '';
    const after = doc.sliceString(to, to + 1);
    const lead = before && !/\s/.test(before) ? ' ' : '';
    const hasTrailingSpace = after === ' ' || after === '\t';
    const text = lead + insert + (hasTrailingSpace ? '' : ' ');
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length + (hasTrailingSpace ? 1 : 0) },
      userEvent: 'input.complete',
      scrollIntoView: true,
    });
  };
}

/** Completion source turning '@query' into Obsidian Tasks field tokens via core `suggest`. */
export function atCompletion(now: () => Date): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const match = AT_QUERY.exec(line.text.slice(0, ctx.pos - line.from));
    if (!match) return null;
    const query = match[1];
    const suggestions = suggest(query.trim(), now());
    if (!suggestions.length) return null;
    return {
      from: ctx.pos - query.length - 1,
      to: ctx.pos,
      filter: false,
      options: suggestions.map((s, i) => ({
        label: s.label,
        detail: s.detail,
        boost: 99 - Math.min(i, 198),
        apply: applySuggestion(s.insert),
      })),
    };
  };
}
