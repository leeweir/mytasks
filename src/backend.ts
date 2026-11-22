// Typed wrappers around the Rust backend (src-tauri/src).
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type { UnlistenFn };

export interface VaultFile {
  path: string;
  rel: string;
  content: string;
}

export interface SkippedFile {
  rel: string;
  reason: string;
}

export interface VaultListing {
  files: VaultFile[];
  /** Vault-relative POSIX paths, recursive, including empty directories. */
  dirs: string[];
  /** Unreadable directories and non-UTF-8 Markdown files left out of the listing. */
  skipped: SkippedFile[];
}

export interface VaultFileRead {
  path: string;
  rel: string;
  /** null = file gone, excluded, not Markdown, or not UTF-8. */
  content: string | null;
  /** Why an existing file was left out (e.g. not UTF-8, unreadable); null otherwise. */
  skipped: string | null;
}

export interface VaultChange {
  /** Canonical absolute .md paths changed on disk (own writes filtered). */
  paths: string[];
  /** The change cannot be mapped to individual files; reload the whole vault. */
  full: boolean;
}

export type AttachmentSource = { path: string } | { bytes: Uint8Array; ext: string };

export interface ReminderItem {
  id: string;
  title: string;
  body: string;
  /** Local time, 'YYYY-MM-DD HH:mm'. */
  at: string;
}

export type ExportKind = 'pdf' | 'html' | 'md';

export type MenuId =
  | 'new-list'
  | 'new-folder'
  | 'choose-vault'
  | 'export-pdf'
  | 'export-html'
  | 'export-md'
  | 'find'
  | 'toggle-task'
  | 'view-today'
  | 'view-upcoming'
  | 'view-tags'
  | 'view-done'
  | 'view-lists';

export function getVault(): Promise<string | null> {
  return invoke<string | null>('get_vault');
}

/** Native folder picker; the backend activates and persists the vault. null = cancelled. */
export function chooseVault(): Promise<string | null> {
  return invoke<string | null>('choose_vault');
}

export function listVault(): Promise<VaultListing> {
  return invoke<VaultListing>('list_vault');
}

export function readVaultFiles(paths: string[]): Promise<VaultFileRead[]> {
  return invoke<VaultFileRead[]>('read_vault_files', { paths });
}

export function readFile(path: string): Promise<string> {
  return invoke<string>('read_file', { path });
}

/**
 * `expected` is the exact disk text the write is based on; the backend refuses with a
 * `CONFLICT:` error when the file differs or is missing. null overwrites unconditionally.
 */
export function writeFile(path: string, content: string, expected: string | null): Promise<void> {
  return invoke<void>('write_file', { path, content, expected });
}

export function isConflictError(e: unknown): boolean {
  return String(e).startsWith('CONFLICT:');
}

export function createFile(rel: string, content: string): Promise<string> {
  return invoke<string>('create_file', { rel, content });
}

export function createDir(rel: string): Promise<void> {
  return invoke<void>('create_dir', { rel });
}

export function renamePath(from: string, toRel: string): Promise<string> {
  return invoke<string>('rename_path', { from, toRel });
}

export function trashPath(path: string): Promise<void> {
  return invoke<void>('trash_path', { path });
}

/** Opens a non-executable file inside the vault with its default application. */
export function openVaultPath(path: string): Promise<void> {
  return invoke<void>('open_vault_path', { path });
}

/** URL serving a vault file through the `vaultfile` protocol. */
export function fileUrl(path: string): string {
  return convertFileSrc(path, 'vaultfile');
}

export function saveAttachment(forFile: string, src: AttachmentSource): Promise<string> {
  if ('path' in src) {
    return invoke<string>('save_attachment', { forFile, srcPath: src.path });
  }
  // Raw IPC body avoids JSON-encoding the image bytes.
  return invoke<string>('save_attachment_bytes', src.bytes, {
    headers: {
      'x-for-file': encodeURIComponent(forFile),
      'x-ext': encodeURIComponent(src.ext),
    },
  });
}

export function scheduleReminders(items: ReminderItem[]): Promise<void> {
  return invoke<void>('schedule_reminders', { items });
}

/** Native save dialog; the chosen path is allowlisted for one write_export / export_pdf. */
export function chooseExportPath(defaultName: string, ext: ExportKind): Promise<string | null> {
  return invoke<string | null>('choose_export_path', { defaultName, ext });
}

export function writeExport(path: string, content: string): Promise<void> {
  return invoke<void>('write_export', { path, content });
}

export function exportPdf(html: string, outPath: string): Promise<void> {
  return invoke<void>('export_pdf', { html, outPath });
}

export function onVaultChanged(cb: (change: VaultChange) => void): Promise<UnlistenFn> {
  return listen<VaultChange>('vault-changed', (event) => cb(event.payload));
}

export function onMenu(cb: (id: MenuId) => void): Promise<UnlistenFn> {
  return listen<MenuId>('menu', (event) => cb(event.payload));
}

/** Acknowledge a native quit request only after all pending changes are saved. */
export function allowExit(): Promise<void> {
  return invoke<void>('allow_exit');
}

/** Decline a native quit request (e.g. a logout) when pending changes could not be saved. */
export function cancelExit(): Promise<void> {
  return invoke<void>('cancel_exit');
}

export function onExitRequested(cb: () => void): Promise<UnlistenFn> {
  return listen('exit-requested', cb);
}
