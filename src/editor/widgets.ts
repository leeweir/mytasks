import { EditorView, WidgetType } from '@codemirror/view';
import type { FieldKind, Priority } from '../core';

/** Callbacks and services the live preview needs from the host. */
export interface PreviewConfig {
  resolveImage(src: string): string | null;
  onToggleRequest(line: number): void;
  onBadgeClick(line: number, lineText: string, kind: FieldKind, rect: DOMRect): void;
  onOpenLink(href: string): void;
  now(): Date;
}

/** 0-based document line of a widget's DOM node, or null if it is detached. */
function lineOfDom(view: EditorView, dom: HTMLElement): number | null {
  if (!dom.isConnected) return null;
  const pos = view.posAtDOM(dom);
  return view.state.doc.lineAt(pos).number - 1;
}

/** Checkbox ring tone per priority; shared with the app's task rows (`.p-high` etc.). */
const PRIORITY_RING: Record<Priority, string> = {
  highest: 'p-high',
  high: 'p-high',
  medium: 'p-medium',
  low: 'p-low',
  lowest: 'p-low',
};

/** Time of the last checkbox click; the next checked box built shortly after plays the completion pop once. */
let popRequestedAt = -Infinity;

export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly cancelled: boolean,
    readonly priority: Priority | undefined,
    readonly cfg: PreviewConfig,
  ) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.cancelled === this.cancelled && other.priority === this.priority;
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-md-checkbox';
    if (this.priority) box.classList.add(PRIORITY_RING[this.priority]);
    if (this.cancelled) box.classList.add('is-cancelled');
    if (this.checked && performance.now() - popRequestedAt < 1500) {
      box.classList.add('is-popping');
      popRequestedAt = -Infinity;
    }
    box.checked = this.checked;
    box.tabIndex = -1;
    box.setAttribute('aria-label', this.cancelled ? '重新打开任务' : this.checked ? '标记为未完成' : '标记为完成');
    // Keep focus and selection where they are: the host performs the toggle.
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      popRequestedAt = performance.now();
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
    span.dataset.kind = this.kind;
    span.textContent = this.text;
    span.setAttribute('role', 'button');
    span.addEventListener('mousedown', (e) => e.preventDefault());
    span.addEventListener('click', (e) => {
      e.preventDefault();
      if (!span.isConnected) return;
      const pos = view.posAtDOM(span);
      const lineObj = view.state.doc.lineAt(pos);
      this.cfg.onBadgeClick(lineObj.number - 1, lineObj.text, this.kind, span.getBoundingClientRect());
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
