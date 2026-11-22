import { EditorView, WidgetType } from '@codemirror/view';
import type { FieldKind } from '../core';

/** Callbacks and services the live preview needs from the host. */
export interface PreviewConfig {
  resolveImage(src: string): string | null;
  onToggleRequest(line: number): void;
  onBadgeClick(line: number, kind: FieldKind, rect: DOMRect): void;
  onOpenLink(href: string): void;
  now(): Date;
}

/** 0-based document line of a widget's DOM node, or null if it is detached. */
function lineOfDom(view: EditorView, dom: HTMLElement): number | null {
  if (!dom.isConnected) return null;
  const pos = view.posAtDOM(dom);
  return view.state.doc.lineAt(pos).number - 1;
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly cfg: PreviewConfig) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-md-checkbox';
    box.checked = this.checked;
    box.tabIndex = -1;
    box.setAttribute('aria-label', this.checked ? '标记为未完成' : '标记为完成');
    // Keep focus and selection where they are: the host performs the toggle.
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      const line = lineOfDom(view, box);
      if (line !== null) this.cfg.onToggleRequest(line);
    });
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const BULLETS = ['•', '◦', '▪'];

export class BulletWidget extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }

  eq(other: BulletWidget): boolean {
    return other.depth === this.depth;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-bullet';
    span.textContent = BULLETS[this.depth % BULLETS.length];
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export class HrWidget extends WidgetType {
  eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-hr';
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export class FenceWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }

  eq(other: FenceWidget): boolean {
    return other.lang === this.lang;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-fence-label';
    span.textContent = this.lang;
    return span;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export class BadgeWidget extends WidgetType {
  constructor(
    readonly kind: FieldKind,
    readonly text: string,
    readonly state: string,
    readonly cfg: PreviewConfig,
  ) {
    super();
  }

  eq(other: BadgeWidget): boolean {
    return other.kind === this.kind && other.text === this.text && other.state === this.state;
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    span.className = `cm-md-badge cm-md-badge-${this.kind}${this.state ? ' ' + this.state : ''}`;
    span.textContent = this.text;
    span.setAttribute('role', 'button');
    span.addEventListener('mousedown', (e) => e.preventDefault());
    span.addEventListener('click', (e) => {
      e.preventDefault();
      const line = lineOfDom(view, span);
      if (line !== null) this.cfg.onBadgeClick(line, this.kind, span.getBoundingClientRect());
    });
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly url: string | null,
  ) {
    super();
  }

  eq(other: ImageWidget): boolean {
    return other.url === this.url && other.alt === this.alt && other.src === this.src;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-image';
    const broken = () => {
      wrap.classList.add('is-broken');
      wrap.textContent = `🖼 ${this.alt || this.src}`;
      view.requestMeasure();
    };
    if (!this.url) {
      broken();
      return wrap;
    }
    const img = document.createElement('img');
    img.src = this.url;
    img.alt = this.alt;
    img.draggable = false;
    img.addEventListener('load', () => view.requestMeasure());
    img.addEventListener('error', broken);
    wrap.appendChild(img);
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
