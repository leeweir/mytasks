import { autocompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { indentUnit } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, keymap } from '@codemirror/view';
import { parseTaskLine } from '../core';
import type { FieldKind, TextEdit } from '../core';
import { atCompletion } from './completion';
import { livePreview } from './livePreview';
import { theme } from './theme';
import type { PreviewConfig } from './widgets';
import './editor.css';

export interface EditorOptions {
  parent: HTMLElement;
  doc: string;
  resolveImage(src: string): string | null;
  onChange(doc: string): void;
  onToggleRequest(line: number): void;
  onBadgeClick(line: number, kind: FieldKind, rect: DOMRect): void;
  onOpenLink(href: string): void;
  onPasteImage(data: Uint8Array, ext: string): Promise<string | null>;
  now(): Date;
}

export interface EditorHandle {
  getDoc(): string;
  setDoc(doc: string): void;
  applyEdits(edits: TextEdit[]): void;
  insertAtCoords(x: number, y: number, text: string): void;
  insertAtCursor(text: string): void;
  toggleTaskAtCursor(): void;
  scrollToLine(line: number): void;
  focus(): void;
  destroy(): void;
}

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

function imageExt(file: File): string {
  const fromName = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return IMAGE_EXT[file.type] ?? fromName ?? 'png';
}

export function createEditor(opts: EditorOptions): EditorHandle {
  // EditorOptions structurally satisfies the preview's callback contract.
  const cfg: PreviewConfig = opts;

  const insertAtCursor = (view: EditorView, text: string) => {
    view.dispatch(view.state.replaceSelection(text), { userEvent: 'input', scrollIntoView: true });
  };

  const toggleAtCursor = (view: EditorView): boolean => {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    if (!parseTaskLine(line.text)) return false;
    opts.onToggleRequest(line.number - 1);
    return true;
  };

  const pasteImages = async (view: EditorView, files: File[]) => {
    for (const file of files) {
      try {
        const markdownText = await opts.onPasteImage(new Uint8Array(await file.arrayBuffer()), imageExt(file));
        if (markdownText) insertAtCursor(view, markdownText);
      } catch (err) {
        console.error('Pasting image failed:', err);
      }
    }
  };

  const extensions = [
      history(),
      drawSelection(),
      dropCursor(),
      EditorView.lineWrapping,
      EditorState.tabSize.of(4),
      indentUnit.of('\t'),
      markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
      theme,
      livePreview(cfg),
      autocompletion({
        override: [atCompletion(() => opts.now())],
        activateOnTyping: true,
        icons: false,
      }),
      Prec.high(
        keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: (view) => {
              toggleAtCursor(view);
              return true;
            },
          },
          { key: 'Tab', run: indentMore, preventDefault: true },
          { key: 'Shift-Tab', run: indentLess, preventDefault: true },
        ]),
      ),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.editorAttributes.of({ class: 'tasks-editor' }),
      EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      EditorView.domEventHandlers({
        paste(event, view) {
          const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
          if (!files.length) return false;
          event.preventDefault();
          void pasteImages(view, files);
          return true;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) opts.onChange(update.state.doc.toString());
      }),
  ];

  const view = new EditorView({ state: EditorState.create({ doc: opts.doc, extensions }), parent: opts.parent });

  return {
    getDoc: () => view.state.doc.toString(),

    setDoc(doc) {
      if (view.state.doc.toString() === doc) return;
      const cursor = Math.min(view.state.selection.main.head, doc.length);
      // A disk version is a new editing baseline; undo must never restore the previous file version.
      view.setState(EditorState.create({ doc, extensions, selection: EditorSelection.cursor(cursor) }));
    },

    applyEdits(edits) {
      if (!edits.length) return;
      view.dispatch({
        changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
        userEvent: 'input',
      });
    },

    insertAtCoords(x, y, text) {
      const pos = view.posAtCoords({ x, y });
      if (pos === null) {
        insertAtCursor(view, text);
        return;
      }
      view.dispatch({
        changes: { from: pos, insert: text },
        selection: EditorSelection.cursor(pos + text.length),
        userEvent: 'input',
        scrollIntoView: true,
      });
    },

    insertAtCursor: (text) => insertAtCursor(view, text),

    toggleTaskAtCursor() {
      toggleAtCursor(view);
    },

    scrollToLine(line) {
      const doc = view.state.doc;
      const target = doc.line(Math.min(Math.max(line + 1, 1), doc.lines));
      view.dispatch({
        selection: EditorSelection.cursor(target.to),
        effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
      });
      view.focus();
    },

    focus: () => view.focus(),

    destroy: () => view.destroy(),
  };
}
