import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState, Range, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { fieldTokens, parseTaskLine, tagRanges, todayISO } from '../core';
import { badgeText, normalizeHref } from './format';
import { TableWidget } from './table';
import {
  BadgeWidget,
  BulletWidget,
  CheckboxWidget,
  FenceWidget,
  HrWidget,
  ImageWidget,
  type PreviewConfig,
} from './widgets';

// ---------------------------------------------------------------------------
// Focus tracking: an unfocused editor renders every line.

const setFocus = StateEffect.define<boolean>();

const focusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocus)) value = e.value;
    return value;
  },
});

interface Span {
  from: number;
  to: number;
}

/** Selection ranges expanded to whole lines; these lines show raw markdown. */
function rawSpans(state: EditorState): Span[] {
  if (!state.field(focusField)) return [];
  return state.selection.ranges.map((r) => ({
    from: state.doc.lineAt(r.from).from,
    to: state.doc.lineAt(r.to).to,
  }));
}

function intersects(spans: Span[], from: number, to: number): boolean {
  return spans.some((s) => s.from <= to && s.to >= from);
}

function previewInputsChanged(startState: EditorState, state: EditorState): boolean {
  return (
    syntaxTree(startState) !== syntaxTree(state) ||
    startState.field(focusField) !== state.field(focusField)
  );
}

// ---------------------------------------------------------------------------
// Shared decorations

const hide = Decoration.replace({});
const markEm = Decoration.mark({ class: 'cm-md-em' });
const markStrong = Decoration.mark({ class: 'cm-md-strong' });
const markStrike = Decoration.mark({ class: 'cm-md-strike' });
const markCode = Decoration.mark({ class: 'cm-md-inline-code' });
const markLink = Decoration.mark({ class: 'cm-md-link' });
const markTag = Decoration.mark({ class: 'cm-md-tag' });
const markIndent = Decoration.mark({ class: 'cm-md-indent' });
const markFieldRaw = Decoration.mark({ class: 'cm-md-field-raw' });
const markOlMark = Decoration.mark({ class: 'cm-md-ol-mark' });

const lineDecoCache = new Map<string, Decoration>();
function lineDeco(cls: string): Decoration {
  let deco = lineDecoCache.get(cls);
  if (!deco) {
    deco = Decoration.line({ class: cls });
    lineDecoCache.set(cls, deco);
  }
  return deco;
}

const hrWidget = Decoration.replace({ widget: new HrWidget() });

// ---------------------------------------------------------------------------
// Inline live preview (view plugin, visible ranges only)

const LINK_PARENTS: Record<string, true> = { Link: true, Image: true, Autolink: true, LinkReference: true };

function buildInline(view: EditorView, cfg: PreviewConfig): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const tree: Tree = ensureSyntaxTree(state, view.viewport.to, 25) ?? syntaxTree(state);
  const spans = rawSpans(state);
  const lineIsRaw = (pos: number) => {
    const line = doc.lineAt(pos);
    return intersects(spans, line.from, line.to);
  };
  const sameLine = (a: number, b: number) => doc.lineAt(a).number === doc.lineAt(b).number;
  const followingSpace = (pos: number) => (doc.sliceString(pos, pos + 1) === ' ' ? 1 : 0);

  const lineDecos: Range<Decoration>[] = [];
  const treeDecos: Range<Decoration>[] = [];
  const lineLevel: Range<Decoration>[] = [];
  const badgeRanges: Span[] = [];
  const inlineCode: Span[] = [];

  const hideUnlessRaw = (from: number, to: number) => {
    if (from < to && !lineIsRaw(from)) treeDecos.push(hide.range(from, to));
  };

  for (const range of view.visibleRanges) {
    const firstVisible = doc.lineAt(range.from).number;
    const lastVisible = doc.lineAt(range.to).number;
    const special = new Set<number>(); // code / table lines: no per-line processing
    const eachLine = (from: number, to: number, fn: (lineNo: number) => void) => {
      const start = Math.max(doc.lineAt(from).number, firstVisible);
      const end = Math.min(doc.lineAt(to).number, lastVisible);
      for (let n = start; n <= end; n++) fn(n);
    };

    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (ref) => {
        const name = ref.name;
        switch (name) {
          case 'FencedCode':
          case 'CodeBlock': {
            const first = doc.lineAt(ref.from);
            const last = doc.lineAt(ref.to);
            const raw = intersects(spans, first.from, last.to);
            const node = ref.node;
            const marks = name === 'FencedCode' ? node.getChildren('CodeMark') : [];
            const open = marks[0];
            const close = marks.length > 1 ? marks[marks.length - 1] : null;
            const closeLine = close ? doc.lineAt(close.from).number : -1;
            eachLine(ref.from, ref.to, (n) => {
              special.add(n);
              let cls = 'cm-md-codeblock';
              if (n === first.number) cls += ' cm-md-codeblock-begin';
              if (n === last.number) cls += ' cm-md-codeblock-end';
              if (!raw && marks.length && (n === first.number || n === closeLine)) cls += ' cm-md-fence-hidden';
              lineDecos.push(lineDeco(cls).range(doc.line(n).from));
            });
            if (!raw && open && open.from >= range.from && open.from <= range.to) {
              const info = node.getChild('CodeInfo');
              const lang = info ? doc.sliceString(info.from, info.to) : '';
              treeDecos.push(Decoration.replace({ widget: new FenceWidget(lang) }).range(open.from, first.to));
            }
            if (!raw && close && closeLine !== first.number && close.from >= range.from && close.from <= range.to) {
              treeDecos.push(hide.range(close.from, close.to));
            }
            return false;
          }
          case 'Table': {
            const raw = intersects(spans, doc.lineAt(ref.from).from, doc.lineAt(ref.to).to);
            eachLine(ref.from, ref.to, (n) => {
              special.add(n);
              if (raw) lineDecos.push(lineDeco('cm-md-table-raw').range(doc.line(n).from));
            });
            return false;
          }
          case 'HTMLBlock':
          case 'CommentBlock':
          case 'ProcessingInstructionBlock':
          case 'LinkReference':
            return false;
          case 'ATXHeading1':
          case 'ATXHeading2':
          case 'ATXHeading3':
          case 'ATXHeading4':
          case 'ATXHeading5':
          case 'ATXHeading6':
            lineDecos.push(lineDeco(`cm-md-h${name.slice(-1)}`).range(doc.lineAt(ref.from).from));
            return;
          case 'SetextHeading1':
          case 'SetextHeading2': {
            const markLine = doc.lineAt(ref.to).number;
            eachLine(ref.from, ref.to, (n) => {
              const cls = n === markLine ? 'cm-md-setext-mark' : `cm-md-h${name.slice(-1)}`;
              lineDecos.push(lineDeco(cls).range(doc.line(n).from));
            });
            return;
          }
          case 'HeaderMark': {
            const heading = ref.node.parent;
            if (!heading) return;
            if (heading.name.startsWith('Setext')) {
              if (!intersects(spans, heading.from, heading.to)) treeDecos.push(hide.range(ref.from, ref.to));
            } else if (ref.from === heading.from) {
              hideUnlessRaw(ref.from, ref.to + followingSpace(ref.to));
            } else {
              hideUnlessRaw(ref.from, ref.to);
            }
            return;
          }
          case 'Blockquote':
            eachLine(ref.from, ref.to, (n) => lineDecos.push(lineDeco('cm-md-quote').range(doc.line(n).from)));
            return;
          case 'QuoteMark':
            hideUnlessRaw(ref.from, ref.to + followingSpace(ref.to));
            return;
          case 'Emphasis':
            treeDecos.push(markEm.range(ref.from, ref.to));
            return;
          case 'StrongEmphasis':
            treeDecos.push(markStrong.range(ref.from, ref.to));
            return;
          case 'Strikethrough':
            treeDecos.push(markStrike.range(ref.from, ref.to));
            return;
          case 'InlineCode':
            treeDecos.push(markCode.range(ref.from, ref.to));
            inlineCode.push({ from: ref.from, to: ref.to });
            return;
          case 'EmphasisMark':
          case 'StrikethroughMark':
            hideUnlessRaw(ref.from, ref.to);
            return;
          case 'CodeMark':
            if (ref.node.parent?.name === 'InlineCode') hideUnlessRaw(ref.from, ref.to);
            return;
          case 'Escape':
            hideUnlessRaw(ref.from, ref.from + 1);
            return;
          case 'Link':
            addLink(ref.node);
            return;
          case 'Image':
            addImage(ref.node);
            return false;
          case 'Autolink':
            addAutolink(ref.node);
            return false;
          case 'URL': {
            const parent = ref.node.parent;
            if (parent && LINK_PARENTS[parent.name]) return;
            treeDecos.push(linkMark(ref.from, ref.to, lineIsRaw(ref.from) ? null : doc.sliceString(ref.from, ref.to)));
            return;
          }
          case 'HorizontalRule':
            if (!lineIsRaw(ref.from) && sameLine(ref.from, ref.to)) treeDecos.push(hrWidget.range(ref.from, ref.to));
            return false;
          case 'ListMark':
            addListMark(ref.node);
            return;
        }
      },
    });

    for (let n = firstVisible; n <= lastVisible; n++) {
      if (!special.has(n)) decorateLine(n);
    }
  }

  function linkMark(from: number, to: number, href: string | null): Range<Decoration> {
    if (!href) return markLink.range(from, to);
    return Decoration.mark({ class: 'cm-md-link', attributes: { 'data-href': normalizeHref(href) } }).range(from, to);
  }

  function addLink(node: SyntaxNode) {
    const marks = node.getChildren('LinkMark');
    if (marks.length < 2 || marks[0].from !== node.from) return;
    const textFrom = marks[0].to;
    const textTo = marks[1].from;
    if (textTo <= textFrom) return;
    const url = node.getChild('URL');
    const raw = intersects(spans, doc.lineAt(node.from).from, doc.lineAt(node.to).to);
    if (raw) {
      treeDecos.push(markLink.range(textFrom, textTo));
      return;
    }
    treeDecos.push(hide.range(node.from, textFrom));
    if (sameLine(textTo, node.to)) treeDecos.push(hide.range(textTo, node.to));
    treeDecos.push(linkMark(textFrom, textTo, url ? doc.sliceString(url.from, url.to) : null));
  }

  function addImage(node: SyntaxNode) {
    if (lineIsRaw(node.from) || !sameLine(node.from, node.to)) return;
    const marks = node.getChildren('LinkMark');
    const url = node.getChild('URL');
    if (!url || marks.length < 2) return;
    const alt = doc.sliceString(marks[0].to, marks[1].from);
    let src = doc.sliceString(url.from, url.to);
    if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1);
    const widget = new ImageWidget(src, alt, cfg.resolveImage(src));
    treeDecos.push(Decoration.replace({ widget }).range(node.from, node.to));
  }

  function addAutolink(node: SyntaxNode) {
    const url = node.getChild('URL');
    if (!url) return;
    if (lineIsRaw(node.from)) {
      treeDecos.push(markLink.range(url.from, url.to));
      return;
    }
    for (const mark of node.getChildren('LinkMark')) treeDecos.push(hide.range(mark.from, mark.to));
    treeDecos.push(linkMark(url.from, url.to, doc.sliceString(url.from, url.to)));
  }

  function addListMark(mark: SyntaxNode) {
    const item = mark.parent;
    if (!item || item.name !== 'ListItem') return;
    const line = doc.lineAt(mark.from);
    const raw = intersects(spans, line.from, line.to);
    const marker = item.getChild('Task')?.getChild('TaskMarker');
    if (marker && doc.lineAt(marker.from).number === line.number) {
      lineDecos.push(lineDeco('cm-md-task').range(line.from));
      if (raw) return;
      const checked = /[xX]/.test(doc.sliceString(marker.from, marker.to));
      const end = marker.to + followingSpace(marker.to);
      treeDecos.push(Decoration.replace({ widget: new CheckboxWidget(checked, cfg) }).range(mark.from, end));
      return;
    }
    if (item.parent?.name !== 'BulletList') {
      treeDecos.push(markOlMark.range(mark.from, mark.to));
      return;
    }
    if (raw) return;
    let depth = 0;
    for (let p = item.parent.parent; p; p = p.parent) {
      if (p.name === 'BulletList' || p.name === 'OrderedList') depth++;
    }
    treeDecos.push(Decoration.replace({ widget: new BulletWidget(depth) }).range(mark.from, mark.to));
  }

  function decorateLine(n: number) {
    const line = doc.line(n);
    const text = line.text;
    if (!text) return;
    const indent = /^[ \t]*/.exec(text)![0].length;
    if (indent > 0 && indent < text.length) lineLevel.push(markIndent.range(line.from, line.from + indent));

    const raw = intersects(spans, line.from, line.to);
    const lineBadges: Span[] = [];
    const task = parseTaskLine(text);
    if (task) {
      if (task.checked) lineDecos.push(lineDeco('cm-md-task-done').range(line.from));
      const today = todayISO(cfg.now());
      for (const tok of fieldTokens(text)) {
        const from = line.from + tok.from;
        const to = line.from + tok.to;
        if (raw) {
          lineLevel.push(markFieldRaw.range(from, to));
          continue;
        }
        const value = task.fields[tok.kind] ?? tok.value;
        let state = '';
        if (!task.checked && tok.kind === 'due') {
          if (value < today) state = 'is-overdue';
          else if (value === today) state = 'is-today';
        } else if (!task.checked && tok.kind === 'reminder' && value.slice(0, 10) === today) {
          state = 'is-today';
        }
        const widget = new BadgeWidget(tok.kind, badgeText(tok.kind, value, today), state, cfg);
        lineLevel.push(Decoration.replace({ widget }).range(from, to));
        lineBadges.push({ from, to });
      }
      badgeRanges.push(...lineBadges);
    }

    for (const tag of tagRanges(text)) {
      const from = line.from + tag.from;
      const to = line.from + tag.to;
      if (inlineCode.some((c) => c.from < to && c.to > from)) continue;
      if (lineBadges.some((b) => b.from < to && b.to > from)) continue;
      lineLevel.push(markTag.range(from, to));
    }
  }

  const kept = badgeRanges.length
    ? treeDecos.filter((d) => !badgeRanges.some((b) => d.from < b.to && d.to > b.from))
    : treeDecos;
  return Decoration.set([...lineDecos, ...kept, ...lineLevel], true);
}

/** href of the link/autolink/bare URL at `pos`, if any. */
function linkAt(state: EditorState, pos: number): string | null {
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name === 'URL') return normalizeHref(state.doc.sliceString(node.from, node.to));
      if (node.name === 'Link' || node.name === 'Image' || node.name === 'Autolink') {
        const url = node.getChild('URL');
        return url ? normalizeHref(state.doc.sliceString(url.from, url.to)) : null;
      }
    }
  }
  return null;
}

function inlinePreview(cfg: PreviewConfig): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildInline(view, cfg);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          previewInputsChanged(update.startState, update.state)
        ) {
          this.decorations = buildInline(update.view, cfg);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(event, view) {
          if (event.button !== 0 || event.shiftKey) return false;
          const link = (event.target as HTMLElement).closest?.('.cm-md-link[data-href]');
          let href = link?.getAttribute('data-href') ?? null;
          if (!href && event.metaKey) {
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            if (pos !== null) href = linkAt(view.state, pos);
          }
          if (!href) return false;
          event.preventDefault();
          cfg.onOpenLink(href);
          return true;
        },
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Tables: multi-line block replacements must come from a state field.

const TABLE_SKIP: Record<string, true> = {
  Paragraph: true,
  FencedCode: true,
  CodeBlock: true,
  HTMLBlock: true,
  CommentBlock: true,
  ProcessingInstructionBlock: true,
  LinkReference: true,
  HorizontalRule: true,
  ATXHeading1: true,
  ATXHeading2: true,
  ATXHeading3: true,
  ATXHeading4: true,
  ATXHeading5: true,
  ATXHeading6: true,
  SetextHeading1: true,
  SetextHeading2: true,
  Task: true,
};

function buildTables(state: EditorState, cfg: PreviewConfig): DecorationSet {
  const doc = state.doc;
  const spans = rawSpans(state);
  const out: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter(ref) {
      if (TABLE_SKIP[ref.name]) return false;
      if (ref.name !== 'Table') return;
      const first = doc.lineAt(ref.from);
      const last = doc.lineAt(ref.to);
      // Tables nested in blockquotes carry '>' prefixes; leave those raw.
      if (/\S/.test(doc.sliceString(first.from, ref.from))) return false;
      if (!intersects(spans, first.from, last.to)) {
        const widget = new TableWidget(doc.sliceString(first.from, last.to), cfg);
        out.push(Decoration.replace({ widget, block: true }).range(first.from, last.to));
      }
      return false;
    },
  });
  return Decoration.set(out);
}

function tablePreview(cfg: PreviewConfig): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => buildTables(state, cfg),
    update(value, tr) {
      if (tr.docChanged || tr.selection || previewInputsChanged(tr.startState, tr.state)) {
        return buildTables(tr.state, cfg);
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

/** Obsidian-style live preview: raw markdown on selected lines, rendered elsewhere. */
export function livePreview(cfg: PreviewConfig): Extension {
  return [
    focusField,
    EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing)),
    tablePreview(cfg),
    inlinePreview(cfg),
  ];
}
