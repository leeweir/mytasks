import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { suggest } from '../core';
import { AT_QUERY } from './helpers';

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

function isInCode(state: EditorState, pos: number): boolean {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') return true;
    }
  }
  return false;
}

/** Completion source turning '@query' into Obsidian Tasks field tokens via core `suggest`. */
export function atCompletion(now: () => Date): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    if (isInCode(ctx.state, ctx.pos)) return null;
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
