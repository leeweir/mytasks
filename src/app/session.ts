import { isConflictError, readFile, writeFile } from "../backend";
import { applyEdits, archiveTask, RecurrenceError, setTaskFields, splitLines, toggleTask, type FieldPatch, type TaskIdentity, type TextEdit } from "../core";
import type { EditorHandle } from "../editor";
import { vault } from "./vault";
import { toast } from "./toast";
import { assertLine, detectEol, fromLF, lineText, StaleTaskError, toLF, type Eol } from "./text";

const AUTOSAVE_MS = 1000;
const INDEX_DELAY_MS = 200;
const ARCHIVE_DELAY_MS = 3000;

export interface DiskConflict {
  path: string;
  /** Exact disk text; null means the file was deleted, not an empty document. */
  disk: string | null;
}

/**
 * Documents are LF-only in memory (editor, index, core). `disk` is the exact text last read
 * from or written to disk and is the `expected` baseline for the next write.
 */
interface DocumentBuffer {
  path: string;
  doc: string;
  /** LF form of the disk baseline; null = file absent. */
  saved: string | null;
  /** Exact disk text of the baseline; undefined = not read yet; null = absent, user chose to (re)create. */
  disk: string | null | undefined;
  eol: Eol;
  handle: EditorHandle | null;
  timer: number | undefined;
  indexTimer: number | undefined;
  conflict: DiskConflict | null;
  error: string | null;
  replacing: boolean;
}

type Session = DocumentBuffer & { handle: EditorHandle };

export interface SaveError {
  path: string;
  message: string;
}

export interface SessionStatus {
  conflicts: readonly DiskConflict[];
  errors: readonly SaveError[];
}

// Buffers outlive editors: a failed cleanup save must never discard the only local copy.
const buffers = new Map<string, DocumentBuffer>();
const chains = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
let session: Session | null = null;
let status: SessionStatus = { conflicts: [], errors: [] };

export const sessionStatus = {
  get: () => status,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

function sameStatus(a: SessionStatus, b: SessionStatus): boolean {
  return a.conflicts.length === b.conflicts.length
    && a.conflicts.every((c, i) => c === b.conflicts[i])
    && a.errors.length === b.errors.length
    && a.errors.every((e, i) => e.path === b.errors[i].path && e.message === b.errors[i].message);
}

/** Keeps the previous snapshot when nothing visible changed, so subscribers do not re-render. */
function publish() {
  const docs = [...buffers.values()];
  const next: SessionStatus = {
    conflicts: docs.flatMap((s) => s.conflict ? [s.conflict] : []),
    errors: docs.flatMap((s) => s.error ? [{ path: s.path, message: s.error }] : []),
  };
  if (sameStatus(status, next)) return;
  status = next;
  for (const listener of listeners) listener();
}

function enqueue<T>(path: string, run: () => Promise<T>): Promise<T> {
  const next = (chains.get(path) ?? Promise.resolve()).then(run, run);
  chains.set(path, next);
  const remove = () => { if (chains.get(path) === next) chains.delete(path); };
  void next.then(remove, remove);
  return next;
}

function stopAutosave(s: DocumentBuffer) {
  window.clearTimeout(s.timer);
  s.timer = undefined;
}

/** Publishes the buffer to the task index now instead of after the typing debounce. */
function syncIndex(s: DocumentBuffer) {
  window.clearTimeout(s.indexTimer);
  s.indexTimer = undefined;
  if (buffers.get(s.path) === s) vault.setContent(s.path, s.doc);
}

function releaseClean(s: DocumentBuffer) {
  if (!s.handle && !s.conflict && !s.error && s.doc === s.saved && buffers.get(s.path) === s) {
    syncIndex(s);
    buffers.delete(s.path);
  }
}

function dropBuffer(s: DocumentBuffer) {
  stopAutosave(s);
  window.clearTimeout(s.indexTimer);
  cancelArchives(s.path);
  if (buffers.get(s.path) === s) buffers.delete(s.path);
  if (session === s) session = null;
  s.handle = null;
  publish();
}

function setDisk(s: DocumentBuffer, disk: string | null) {
  s.disk = disk;
  if (disk !== null) s.eol = detectEol(disk);
}

function newBuffer(path: string, doc: string, disk: string | undefined): DocumentBuffer {
  const s: DocumentBuffer = {
    path, doc, saved: doc, disk, eol: "\n", handle: null, timer: undefined, indexTimer: undefined,
    conflict: null, error: null, replacing: false,
  };
  if (disk !== undefined) s.eol = detectEol(disk);
  buffers.set(path, s);
  return s;
}

/** `saved` is the LF document the editor was created with (the indexed file content). */
export function openSession(path: string, handle: EditorHandle, saved: string) {
  if (session && session.handle !== handle) {
    const previous: DocumentBuffer = session;
    previous.handle = null;
    session = null;
    releaseClean(previous);
  }
  const s = buffers.get(path) ?? newBuffer(path, saved, undefined);
  s.handle = handle;
  session = s as Session;
  if (handle.getDoc() !== s.doc) replaceEditor(s);
  syncIndex(s);
  publish();
}

/** Passing a handle is editor cleanup; a stale cleanup cannot close a newer editor. */
export async function closeSession(handle?: EditorHandle): Promise<void> {
  const s = handle ? [...buffers.values()].find((item) => item.handle === handle) : session;
  if (!s) return;
  const closingHandle = s.handle;
  try {
    await flushBuffer(s);
    if (s.handle === closingHandle) {
      s.handle = null;
      if (session === s) session = null;
    }
  } finally {
    // Explicit navigation failures keep the live session. Unmount failures keep its buffer.
    if (handle && s.handle === handle) {
      s.handle = null;
      if (session === s) session = null;
    }
    releaseClean(s);
    publish();
  }
}

export function currentSession(): Readonly<Session> | null {
  return session;
}

/** Editor onChange hook: retain the latest document independently of the editor's lifetime. */
export function noteEdited(path: string, doc: string) {
  const s = session;
  if (!s || s.path !== path || s.replacing) return;
  trackArchives(path, s.doc, doc);
  s.doc = doc;
  window.clearTimeout(s.indexTimer);
  s.indexTimer = window.setTimeout(() => syncIndex(s), INDEX_DELAY_MS);
  stopAutosave(s);
  if (!s.conflict && s.doc !== s.saved) {
    s.timer = window.setTimeout(() => { void flushBuffer(s).catch(() => undefined); }, AUTOSAVE_MS);
  }
  publish();
}

class ConflictError extends Error {
  constructor() { super("文件在磁盘上已变化，请先处理冲突"); }
}

async function diskContent(path: string): Promise<string | null> {
  try {
    return await readFile(path);
  } catch (e) {
    // Backend preserves the OS error code. Permission/I/O errors must not mean deletion.
    if (/\bENOENT\b|\(os error 2\)/.test(String(e))) return null;
    throw e;
  }
}

function conflictWith(s: DocumentBuffer, disk: string | null) {
  stopAutosave(s);
  cancelArchives(s.path);
  if (!s.conflict || s.conflict.disk !== disk) s.conflict = { path: s.path, disk };
  s.error = null;
  publish();
}

function reportFailure(s: DocumentBuffer, e: unknown) {
  if (e instanceof ConflictError) return;
  s.error = String(e);
  publish();
}

/**
 * Confirms the write baseline against the disk. Returns true when the disk already holds
 * the buffer's document, so nothing is left to write.
 */
async function rebaseline(s: DocumentBuffer): Promise<boolean> {
  const disk = await diskContent(s.path);
  if (s.conflict) throw new ConflictError();
  const lf = disk === null ? null : toLF(disk);
  if (lf === s.saved) {
    setDisk(s, disk);
    return false;
  }
  if (lf === s.doc) {
    setDisk(s, disk);
    s.saved = lf;
    return true;
  }
  conflictWith(s, disk);
  throw new ConflictError();
}

/** Runs only inside the path queue. Every write names the disk text it replaces. */
async function saveBuffer(s: DocumentBuffer): Promise<void> {
  stopAutosave(s);
  if (s.conflict) throw new ConflictError();
  try {
    while (s.doc !== s.saved) {
      if (s.disk === undefined && await rebaseline(s)) break;
      // Read after awaiting disk: changes typed during the read belong to this write.
      const doc = s.doc;
      const raw = fromLF(doc, s.eol);
      try {
        await writeFile(s.path, raw, s.disk ?? null);
      } catch (e) {
        if (!isConflictError(e)) throw e;
        const expected = s.disk;
        if (await rebaseline(s)) break;
        // Same baseline refused twice: report instead of looping.
        if (s.disk === expected) throw e;
        continue;
      }
      s.disk = raw;
      // A listing that started before this write must not bring back the old text once the buffer is released.
      vault.touch(s.path);
      s.saved = doc;
      // Typing during a slow write is saved in a subsequent, never overlapping write.
    }
    s.error = null;
  } catch (e) {
    reportFailure(s, e);
    throw e;
  } finally {
    releaseClean(s);
    publish();
  }
}

function flushBuffer(s: DocumentBuffer): Promise<void> {
  stopAutosave(s);
  syncIndex(s);
  return enqueue(s.path, () => saveBuffer(s));
}

async function settleAll(promises: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

const within = (path: string, scope: string) => path === scope || path.startsWith(`${scope}/`);

/**
 * Flush retained documents, including failed saves from editors that have unmounted.
 * With `scope`, only that file or the files below that folder.
 */
export async function flush(scope?: string): Promise<void> {
  const inScope = (path: string) => scope === undefined || within(path, scope);
  // Mutations may still be creating their buffer from a disk read.
  await settleAll([...chains].filter(([path]) => inScope(path)).map(([, p]) => p));
  await settleAll([...buffers.values()].filter((s) => inScope(s.path)).map(flushBuffer));
}

/** Navigation only waits for the open document; other failed saves stay in the error bar. */
export function flushCurrent(): Promise<void> {
  return session ? flush(session.path) : Promise.resolve();
}

function replaceEditor(s: DocumentBuffer) {
  s.replacing = true;
  try { s.handle?.setDoc(s.doc); } finally { s.replacing = false; }
}

function loadDiskInto(s: DocumentBuffer, disk: string) {
  stopAutosave(s);
  cancelArchives(s.path);
  setDisk(s, disk);
  s.saved = toLF(disk);
  s.doc = s.saved;
  s.conflict = null;
  s.error = null;
  replaceEditor(s);
  syncIndex(s);
  publish();
}

type Dropped = "kept" | "deleted" | "unreadable";

/**
 * After the user chose to drop local changes, reindex what is left on disk: a full listing
 * after a deletion, just this path when the disk version cannot be read (not UTF-8, no access).
 * Returns true when the buffer is gone, so the caller can leave its view.
 */
async function afterDrop(path: string, outcome: Dropped): Promise<boolean> {
  const root = vault.get().root;
  if (root && outcome === "deleted") await vault.load(root);
  // A path the backend refuses to read (e.g. a symlink leaving the vault) needs a full listing.
  if (root && outcome === "unreadable") await vault.refresh(root, [path]).catch(() => vault.load(root));
  return outcome !== "kept";
}

/** Returns true only when the user explicitly dropped the local document. */
export function resolveConflict(conflict: DiskConflict, choice: "local" | "disk"): Promise<boolean> {
  return enqueue(conflict.path, async (): Promise<Dropped> => {
    const s = buffers.get(conflict.path);
    if (!s || s.conflict !== conflict) throw new ConflictError();
    let disk: string | null;
    try {
      disk = await diskContent(s.path);
    } catch (e) {
      if (choice === "local") throw e;
      dropBuffer(s);
      return "unreadable";
    }
    if (disk !== conflict.disk) {
      conflictWith(s, disk);
      throw new ConflictError();
    }
    if (choice === "local") {
      // Explicit overwrite: the write is based on exactly the disk text the user saw.
      setDisk(s, disk);
      s.saved = disk === null ? null : toLF(disk);
      s.conflict = null;
      await saveBuffer(s);
      syncIndex(s);
      return "kept";
    }
    if (disk !== null) {
      loadDiskInto(s, disk);
      releaseClean(s);
      return "kept";
    }
    dropBuffer(s);
    return "deleted";
  }).then((outcome) => afterDrop(conflict.path, outcome));
}

/** Retry a failed save. */
export function retrySave(path: string): Promise<void> {
  const s = buffers.get(path);
  return s ? flushBuffer(s) : Promise.resolve();
}

/** In-memory document of a retained buffer, converted back to the file's line endings. */
export function localCopy(path: string): string | null {
  const s = buffers.get(path);
  return s ? fromLF(s.doc, s.eol) : null;
}

/**
 * Throws away local changes and reloads the disk version. Returns true when the buffer was
 * dropped because the file no longer exists or cannot be read, so the caller can leave its view.
 */
export function discardChanges(path: string): Promise<boolean> {
  return enqueue(path, async (): Promise<Dropped> => {
    const s = buffers.get(path);
    if (!s) return "kept";
    let disk: string | null;
    try {
      disk = await diskContent(path);
    } catch {
      dropBuffer(s);
      return "unreadable";
    }
    if (disk === null) {
      dropBuffer(s);
      return "deleted";
    }
    loadDiskInto(s, disk);
    releaseClean(s);
    return "kept";
  }).then((outcome) => afterDrop(path, outcome));
}

/** Vault switch: callers flush first; nothing in the old vault can be saved afterwards. */
export function forgetAll() {
  cancelArchives();
  for (const s of [...buffers.values()]) dropBuffer(s);
}

/**
 * Every vault refresh passes here. `scope` limits a partial refresh to those paths; null is
 * a full listing, where an unlisted path means a deleted file. Dirty/deleted documents remain
 * in the index, while disk reconciliation is ordered after this app's writes.
 */
vault.setReconciler(async (root, files, scope) => {
  const inScope = (path: string) => path.startsWith(`${root}/`) && (!scope || scope.has(path));
  if (vault.get().root && vault.get().root !== root) cancelArchives();
  const listed = new Set(files.map((f) => f.path));
  for (const archive of pendingArchives.values()) {
    if (inScope(archive.path) && !listed.has(archive.path)) cancelArchives(archive.path);
  }
  await Promise.all([...buffers.values()].filter((s) => inScope(s.path)).map((s) => enqueue(s.path, async () => {
    if (buffers.get(s.path) !== s) return;
    let disk: string | null;
    try {
      disk = await diskContent(s.path);
    } catch (e) {
      // One unreadable file must not stop the rest of the vault from reloading.
      reportFailure(s, e);
      return;
    }
    const lf = disk === null ? null : toLF(disk);
    if (s.conflict) conflictWith(s, disk);
    else if (lf === s.saved) { if (disk !== null) setDisk(s, disk); /* The listing may have raced our write. */ }
    else if (disk === null || s.doc !== s.saved && lf !== s.doc) conflictWith(s, disk);
    else loadDiskInto(s, disk);
  }).catch(() => undefined)));
  const merged = new Map(files.map((f) => [f.path, f]));
  for (const s of buffers.values()) {
    if (!inScope(s.path)) continue;
    const previous = merged.get(s.path) ?? vault.get().files.get(s.path);
    merged.set(s.path, { path: s.path, rel: previous?.rel ?? s.path.slice(root.length + 1), content: s.doc });
  }
  return [...merged.values()];
});

/** Routes all mutations and saves through the same per-file queue; `compute` sees LF text. */
export function mutateFile(path: string, compute: (text: string) => TextEdit[]): Promise<void> {
  return enqueue(path, async () => {
    let s = buffers.get(path);
    try {
      if (!s) {
        const raw = await readFile(path);
        // An editor may have opened while the disk read was pending.
        s = buffers.get(path) ?? newBuffer(path, toLF(raw), raw);
      }
      if (s.conflict) throw new ConflictError();
      // The editor is authoritative for an open document.
      const before = s.handle ? s.handle.getDoc() : s.doc;
      const edits = compute(before);
      if (!edits.length) { releaseClean(s); return; }
      const next = applyEdits(before, edits);
      if (s.handle) {
        s.handle.applyEdits(edits);
      } else {
        trackArchives(path, before, next);
        s.doc = next;
        syncIndex(s);
        await saveBuffer(s);
      }
    } catch (e) {
      // Mistakes the user can retry: reported once, never marking the buffer as failed.
      if (e instanceof StaleTaskError || e instanceof RecurrenceError) {
        toast.show({ text: e.message });
        if (s) releaseClean(s);
      } else if (s) {
        reportFailure(s, e);
      } else {
        toast.show({ text: `修改失败：${String(e)}` });
      }
      throw e;
    }
  });
}

/** Minimal single edit transforming a into b. */
function diffEdit(a: string, b: string): TextEdit[] {
  if (a === b) return [];
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return [{ from: start, to: endA, insert: b.slice(start, endB) }];
}

interface PendingArchive {
  key: number;
  path: string;
  id: TaskIdentity;
  content: string;
  timer: number;
  cancelled: boolean;
  job?: Promise<void>;
}
const pendingArchives = new Map<number, PendingArchive>();
const archiveJobs = new Set<Promise<void>>();
let archiveKey = 0;

/** Normal view switches leave timers intact. Removal, rename, and vault switches cancel them. */
export function cancelArchives(path?: string) {
  for (const [key, pending] of pendingArchives) {
    if (path && !within(pending.path, path)) continue;
    pending.cancelled = true;
    window.clearTimeout(pending.timer);
    pendingArchives.delete(key);
  }
}

function trackArchives(path: string, before: string, after: string) {
  const [edit] = diffEdit(before, after);
  if (!edit) return;
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const oldTexts = oldLines.map((l) => l.text);
  const newTexts = newLines.map((l) => l.text);
  for (const [key, pending] of pendingArchives) {
    if (pending.path !== path) continue;
    // String-only onChange cannot identify which identical line was inserted/deleted.
    const ambiguous = oldTexts.indexOf(pending.id.raw) !== oldTexts.lastIndexOf(pending.id.raw)
      || newTexts.indexOf(pending.id.raw) !== newTexts.lastIndexOf(pending.id.raw);
    const old = oldLines[pending.id.line];
    const offset = old?.start ?? before.length;
    const end = offset + pending.id.raw.length;
    const overlaps = edit.from < end && edit.to > offset || edit.from > offset && edit.from < end;
    const nextOffset = edit.to <= offset ? offset + edit.insert.length - (edit.to - edit.from) : offset;
    const line = splitLines(after.slice(0, nextOffset)).length - 1;
    if (ambiguous || pending.content !== before || overlaps || old?.text !== pending.id.raw || newTexts[line] !== pending.id.raw) {
      pending.cancelled = true;
      window.clearTimeout(pending.timer);
      pendingArchives.delete(key);
    } else {
      pending.id = { ...pending.id, line };
      pending.content = after;
    }
  }
}

function runArchive(pending: PendingArchive): Promise<void> {
  if (pending.job) return pending.job;
  window.clearTimeout(pending.timer);
  const job = mutateFile(pending.path, (text) => {
    // Never fall back to another identical task after an untracked external change.
    if (pending.cancelled || text !== pending.content || lineText(text, pending.id.line) !== pending.id.raw) return [];
    return archiveTask(text, pending.id);
  });
  pending.job = job;
  archiveJobs.add(job);
  const done = () => {
    pendingArchives.delete(pending.key);
    archiveJobs.delete(job);
  };
  void job.then(done, done);
  return job;
}

/** Exit only: finish delayed archive work before the final flush/allow_exit handshake. */
export async function flushArchives(): Promise<void> {
  await settleAll([...chains.values()]);
  await settleAll([...archiveJobs, ...[...pendingArchives.values()].map(runArchive)]);
}

/** `expectRaw` is the task's line text when the user acted; a changed line aborts with a toast. */
export async function toggle(path: string, line: number, expectRaw: string): Promise<void> {
  let before = "";
  let after = "";
  let candidate: TaskIdentity | null = null;
  let checked = false;
  await mutateFile(path, (text) => {
    assertLine(text, line, expectRaw);
    const r = toggleTask(text, line, new Date());
    before = text;
    after = applyEdits(text, r.edits);
    checked = r.checkedNow;
    candidate = r.checkedNow ? r.archiveCandidate : null;
    return r.edits;
  });
  if (!checked || before === after) return;

  const id = candidate as TaskIdentity | null;
  let key: number | null = null;
  if (id) {
    key = ++archiveKey;
    const pending: PendingArchive = { key, path, id, content: after, timer: 0, cancelled: false };
    pending.timer = window.setTimeout(() => { void runArchive(pending).catch(() => undefined); }, ARCHIVE_DELAY_MS);
    pendingArchives.set(key, pending);
  }
  toast.show({
    text: "已完成",
    action: {
      label: "撤销",
      run: () => {
        if (key !== null) {
          const pending = pendingArchives.get(key);
          if (pending) pending.cancelled = true;
          window.clearTimeout(pending?.timer);
          pendingArchives.delete(key);
        }
        void mutateFile(path, (cur) => cur === after ? diffEdit(cur, before) : []).catch(() => undefined);
      },
    },
    durationMs: ARCHIVE_DELAY_MS,
  });
}

export function patchFields(path: string, line: number, patch: FieldPatch, expectRaw: string): Promise<void> {
  return mutateFile(path, (text) => {
    assertLine(text, line, expectRaw);
    return setTaskFields(text, line, patch);
  });
}

/** Current text of a document: the retained buffer when there is one, else the index. */
export function documentText(path: string): string | undefined {
  return buffers.get(path)?.doc ?? vault.get().files.get(path)?.content;
}
