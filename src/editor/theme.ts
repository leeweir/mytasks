import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const MONO = 'var(--md-font-mono)';

const highlightStyle = HighlightStyle.define([
  // Markdown structure
  { tag: t.heading, fontWeight: '700', color: 'var(--md-heading)' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--md-link)' },
  { tag: t.url, color: 'var(--md-link)' },
  { tag: t.monospace, fontFamily: MONO },
  { tag: t.quote, color: 'var(--md-quote)' },
  { tag: [t.processingInstruction, t.contentSeparator], color: 'var(--md-mark)' },
  // Code blocks
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: 'var(--code-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--code-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--code-number)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--code-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: 'var(--code-function)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--code-property)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--code-tag)' },
  { tag: [t.meta, t.annotation], color: 'var(--code-meta)' },
  { tag: t.invalid, color: 'var(--md-overdue)' },
]);

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--md-bg)',
    color: 'var(--md-fg)',
    fontSize: '15px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'var(--md-font)',
    lineHeight: '1.7',
  },
  '.cm-content': {
    maxWidth: '808px',
    width: '100%',
    margin: '0 auto',
    padding: '32px 24px 40vh',
    caretColor: 'var(--md-accent)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--md-accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--md-selection)' },
  '.cm-tooltip': {
    border: '1px solid var(--md-border)',
    backgroundColor: 'var(--md-popover-bg)',
    color: 'var(--md-fg)',
    borderRadius: '8px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--md-font)',
    maxHeight: '18em',
    minWidth: '240px',
    padding: '4px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '4px 10px',
    borderRadius: '5px',
    lineHeight: '1.5',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--md-accent)',
    color: '#fff',
  },
  '.cm-completionDetail': {
    marginLeft: '12px',
    fontStyle: 'normal',
    opacity: '0.7',
  },
});

/** Editor chrome + syntax colours; all colours come from CSS variables in editor.css. */
export const theme: Extension = [editorTheme, syntaxHighlighting(highlightStyle)];
