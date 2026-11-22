import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const MONO = 'var(--md-font-mono)';

const highlightStyle = HighlightStyle.define([
  // Markdown structure
  { tag: t.heading, fontWeight: '600', color: 'var(--md-heading)' },
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
    lineHeight: '1.65',
  },
  // Column matches the app's smart views: 720px wide, text starting at the same edge as view titles.
  '.cm-content': {
    maxWidth: '820px',
    width: '100%',
    margin: '0 auto',
    padding: '12px 60px 40vh',
    caretColor: 'var(--md-accent)',
  },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--md-accent)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--md-selection)' },
  '.cm-tooltip': {
    border: 'none',
    backgroundColor: 'var(--md-popover-bg)',
    backdropFilter: 'blur(24px) saturate(180%)',
    WebkitBackdropFilter: 'blur(24px) saturate(180%)',
    color: 'var(--md-fg)',
    borderRadius: '12px',
    boxShadow: 'var(--md-popover-shadow)',
    overflow: 'hidden',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--md-font)',
    fontSize: '13px',
    maxHeight: '18em',
    minWidth: '240px',
    padding: '5px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    minHeight: '26px',
    padding: '0 10px',
    borderRadius: '6px',
    lineHeight: '1.4',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--md-accent)',
    color: 'var(--md-on-accent)',
  },
  '.cm-completionDetail': {
    marginLeft: 'auto',
    paddingLeft: '16px',
    fontStyle: 'normal',
    fontSize: '12px',
    opacity: '0.7',
  },
});

/** Editor chrome + syntax colours; all colours come from CSS variables in editor.css. */
export const theme: Extension = [editorTheme, syntaxHighlighting(highlightStyle)];
