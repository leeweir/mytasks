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

export interface ParsedTask {
  indent: string; // leading whitespace verbatim
  bullet: string; // '-', '*', '+', or '1.' style
  status: string; // char inside [ ]
  checked: boolean; // status is 'x' or 'X'
  description: string; // text without trailing field tokens (tags kept)
  tags: string[]; // without '#', from description
  fields: TaskFields;
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
