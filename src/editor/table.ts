import { EditorView, WidgetType } from '@codemirror/view';
import MarkdownIt from 'markdown-it';
import { normalizeHref } from './format';
import type { PreviewConfig } from './widgets';

interface CellRenderEnv {
  [key: string | symbol]: unknown;
  resolveImage(src: string): string | null;
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
const renderImage = md.renderer.rules.image!;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const attr = token.attrGet('src');
  const resolve = (env as CellRenderEnv | undefined)?.resolveImage;
  if (attr !== null && resolve) {
    const resolved = resolve(String(attr));
    if (resolved) token.attrSet('src', resolved);
  }
  return renderImage(tokens, idx, options, env, self);
};

interface Cell {
  text: string;
  /** Offset of the end of the trimmed cell text within the row string. */
  end: number;
}

/** Split a GFM table row on unescaped pipes, dropping the optional outer pipes. */
function splitRow(row: string): Cell[] {
  const cells: Cell[] = [];
  let i = 0;
  while (i < row.length && (row[i] === ' ' || row[i] === '\t')) i++;
  if (row[i] === '|') i++;
  let start = i;
  const push = (from: number, to: number) => {
    const raw = row.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    cells.push({ text, end: from + lead + text.length });
  };
  for (; i < row.length; i++) {
    if (row[i] === '\\') {
      i++;
    } else if (row[i] === '|') {
      push(start, i);
      start = i + 1;
    }
  }
  if (row.slice(start).trim()) push(start, row.length);
  return cells;
}

function cellAlign(delimiter: string): string {
  const left = delimiter.startsWith(':');
  const right = delimiter.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

/** Rendered GFM table; `source` is the full text of the table's lines. */
export class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly cfg: PreviewConfig) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  get estimatedHeight(): number {
    return Math.max(1, this.source.split('\n').length - 1) * 34;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table';
    const table = document.createElement('table');
    wrap.appendChild(table);

    const lines = this.source.split('\n');
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of lines) {
      lineStarts.push(offset);
      offset += line.length + 1;
    }
    const header = splitRow(lines[0]);
    const aligns = splitRow(lines[1] ?? '').map((c) => cellAlign(c.text));
    const env: CellRenderEnv = { resolveImage: (src) => this.cfg.resolveImage(src) };

    const fillRow = (tr: HTMLTableRowElement, tag: 'th' | 'td', cells: Cell[], lineIndex: number) => {
      for (let c = 0; c < header.length; c++) {
        const el = document.createElement(tag);
        const cell = cells[c];
        if (aligns[c]) el.style.textAlign = aligns[c];
        if (cell) {
          el.innerHTML = md.renderInline(cell.text, env);
          el.dataset.off = String(lineStarts[lineIndex] + cell.end);
        } else {
          el.dataset.off = String(lineStarts[lineIndex] + lines[lineIndex].length);
        }
        tr.appendChild(el);
      }
    };

    const thead = table.createTHead();
    fillRow(thead.insertRow(), 'th', header, 0);
    const tbody = table.createTBody();
    for (let i = 2; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      fillRow(tbody.insertRow(), 'td', splitRow(lines[i]), i);
    }

    wrap.addEventListener('click', (e) => e.preventDefault());
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const target = e.target as HTMLElement;
      const href = target.closest('a')?.getAttribute('href');
      if (href) {
        this.cfg.onOpenLink(normalizeHref(href));
        return;
      }
      const cell = target.closest<HTMLElement>('[data-off]');
      const base = view.posAtDOM(wrap);
      const pos = Math.min(base + (cell ? Number(cell.dataset.off) : 0), view.state.doc.length);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    return wrap;
  }

  ignoreEvent(): boolean {
    return true;
  }
}
