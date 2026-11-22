// Typed wrappers around the Rust backend (src-tauri/src).
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type { UnlistenFn };

export interface VaultFile {
  path: string;
  rel: string;
  content: string;
  /** Modification time, ms since the Unix epoch. */
  mtime: number;
}

export interface VaultListing {
  files: VaultFile[];
  /** Vault-relative POSIX paths, recursive, including empty directories. */
  dirs: string[];
}

export type AttachmentSource = { path: string } | { bytes: Uint8Array; ext: string };

export interface ReminderItem {
  id: string;
  title: string;
  body: string;
  /** Local time, 'YYYY-MM-DD HH:mm'. */
  at: string;
}

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

export function setVault(path: string): Promise<void> {
  return invoke<void>('set_vault', { path });
}

export function listVault(): Promise<VaultListing> {
  return invoke<VaultListing>('list_vault');
}

export function readFile(path: string): Promise<string> {
  return invoke<string>('read_file', { path });
}

export function writeFile(path: string, content: string): Promise<void> {
  return invoke<void>('write_file', { path, content });
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

export function exportPdf(html: string, outPath: string): Promise<void> {
  return invoke<void>('export_pdf', { html, outPath });
}

export function onVaultChanged(cb: (paths: string[]) => void): Promise<UnlistenFn> {
  return listen<string[]>('vault-changed', (event) => cb(event.payload));
}

export function onMenu(cb: (id: MenuId) => void): Promise<UnlistenFn> {
  return listen<MenuId>('menu', (event) => cb(event.payload));
}

/** Acknowledge a native quit request only after all pending changes are saved. */
export function allowExit(): Promise<void> {
  return invoke<void>('allow_exit');
}

export function onExitRequested(cb: () => void): Promise<UnlistenFn> {
  return listen('exit-requested', cb);
}
