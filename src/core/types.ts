export type Priority = 'highest' | 'high' | 'medium' | 'low' | 'lowest';

export interface TaskFields {
  priority?: Priority;
  recurrence?: string; // raw rule text after 🔁
  reminder?: string; // 'YYYY-MM-DD HH:mm'
  created?: string;
  start?: string;
  scheduled?: string;
  due?: string; // 'YYYY-MM-DD'
  done?: string; // 'YYYY-MM-DD'
}

export type FieldKind = keyof TaskFields;

/** Obsidian Tasks fields this app doesn't edit; kept verbatim on rewrite. */
export type ExtraKind = 'id' | 'dependsOn' | 'onCompletion' | 'cancelledDate';

export interface ExtraField {
  kind: ExtraKind;
  /** Token text exactly as written (emoji + value). */
  raw: string;
}

export interface ParsedTask {
  indent: string; // leading whitespace verbatim
  bullet: string; // '-', '*', '+', or '1.' style
  status: string; // char inside [ ]
  checked: boolean; // status is 'x' or 'X'
  cancelled: boolean; // status is '-'
  description: string; // text without trailing field tokens (tags kept)
  tags: string[]; // without '#', from description
  fields: TaskFields;
  /** 🆔 ⛔ 🏁 ❌ tokens from the trailing field region, in line order. */
  extras?: ExtraField[];
  /** Obsidian block id (without '^') that ended the line; always re-emitted last. */
  blockId?: string;
}

/** Char offsets within the raw line, covering emoji+value. */
export interface FieldToken {
  kind: FieldKind;
  from: number;
  to: number;
  value: string;
}

/** Offsets into ORIGINAL text; sorted, non-overlapping. */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

/** 0-based line + exact line text. */
export interface TaskIdentity {
  line: number;
  raw: string;
}

/** null = remove the field. */
export type FieldPatch = { [K in FieldKind]?: TaskFields[K] | null };
