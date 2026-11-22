import { readFile, writeFile } from "../backend";
import { applyEdits, archiveTask, setTaskFields, toggleTask, type FieldPatch, type TaskIdentity, type TextEdit } from "../core";
import type { EditorHandle } from "../editor";
import { vault, type VaultFile } from "./vault";
import { toast } from "./toast";

const AUTOSAVE_MS = 1000;
const ARCHIVE_DELAY_MS = 3000;

export interface DiskConflict {
  path: string;
  /** null means the file was deleted, not an empty document. */
  disk: string | null;
}

interface DocumentBuffer {
  path: string;
  doc: string;
  saved: string | null;
  handle: EditorHandle | null;
  timer: number | undefined;
  conflict: DiskConflict | null;
  error: string | null;
  replacing: boolean;
}

type Session = DocumentBuffer & { handle: EditorHandle };
interface SessionStatus {
  conflicts: readonly DiskConflict[];
  errors: readonly { path: string; message: string }[];
  dirty: boolean;
  saving: boolean;
}

// Buffers outlive editors: a failed cleanup save must never discard the only local copy.
const buffers = new Map<string, DocumentBuffer>();
const chains = new Map<string, Promise<unknown>>();
const listeners = new Set<() => void>();
let session: Session | null = null;
let saving = 0;
let status: SessionStatus = { conflicts: [], errors: [], dirty: false, saving: false };

export const sessionStatus = {
  get: () => status,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

function publish() {
  const docs = [...buffers.values()];
  status = {
    conflicts: docs.flatMap((s) => s.conflict ? [s.conflict] : []),
    errors: docs.flatMap((s) => s.error ? [{ path: s.path, message: s.error }] : []),
    dirty: docs.some((s) => s.doc !== s.saved),
    saving: saving > 0,
  };
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

function releaseClean(s: DocumentBuffer) {
  if (!s.handle && !s.conflict && s.doc === s.saved && buffers.get(s.path) === s) buffers.delete(s.path);
}

function newBuffer(path: string, content: string): DocumentBuffer {
  const s: DocumentBuffer = { path, doc: content, saved: content, handle: null, timer: undefined, conflict: null, error: null, replacing: false };
  buffers.set(path, s);
  return s;
}

export function openSession(path: string, handle: EditorHandle, saved: string) {
  if (session && session.handle !== handle) {
    const previous: DocumentBuffer = session;
    previous.handle = null;
    session = null;
    releaseClean(previous);
  }
  const s = buffers.get(path) ?? newBuffer(path, saved);
  s.handle = handle;
  session = s as Session;
  if (handle.getDoc() !== s.doc) replaceEditor(s);
  vault.setContent(path, s.doc);
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

export function isDirty(): boolean {
  return !!session && session.doc !== session.saved;
}

/** Editor onChange hook: retain the latest document independently of the editor's lifetime. */
export function noteEdited(path: string, doc: string) {
  const s = session;
  if (!s || s.path !== path || s.replacing) return;
  trackArchives(path, s.doc, doc);
  s.doc = doc;
  vault.setContent(path, doc);
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
  const message = String(e);
  if (s.error !== message) {
    toast.show({
      text: `保存失败，修改仍保留：${message}`,
      action: { label: "重试", run: () => { void flushBuffer(s).catch(() => undefined); } },
    });
  }
  s.error = message;
  publish();
}

/** Runs only inside the path queue. Every write checks the disk baseline first. */
async function saveBuffer(s: DocumentBuffer): Promise<void> {
  stopAutosave(s);
  if (s.conflict) throw new ConflictError();
  saving++;
  publish();
  try {
    while (s.doc !== s.saved) {
      const disk = await diskContent(s.path);
      if (s.conflict) throw new ConflictError();
      if (disk !== s.saved) {
        if (disk === s.doc) {
          s.saved = disk;
          break;
        }
        conflictWith(s, disk);
        throw new ConflictError();
      }
      // Read after awaiting disk: changes typed during the read belong to this write.
      const doc = s.doc;
      await writeFile(s.path, doc);
      s.saved = doc;
      // Typing during a slow write is saved in a subsequent, never overlapping write.
    }
    s.error = null;
  } catch (e) {
    reportFailure(s, e);
    throw e;
  } finally {
    saving--;
    releaseClean(s);
    publish();
  }
}

function flushBuffer(s: DocumentBuffer): Promise<void> {
  stopAutosave(s);
  return enqueue(s.path, () => saveBuffer(s));
}

async function settleAll(promises: Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) throw failed.reason;
}

/** Flush all retained documents, including failed saves from editors that have unmounted. */
export async function flush(): Promise<void> {
  // Mutations may still be creating their buffer from a disk read.
  await settleAll([...chains.values()]);
  await settleAll([...buffers.values()].map(flushBuffer));
}

function replaceEditor(s: DocumentBuffer) {
  s.replacing = true;
  try { s.handle?.setDoc(s.doc); } finally { s.replacing = false; }
}

function loadDiskInto(s: DocumentBuffer, content: string) {
  stopAutosave(s);
  cancelArchives(s.path);
  s.saved = content;
  s.doc = content;
  s.conflict = null;
  s.error = null;
  replaceEditor(s);
  vault.setContent(s.path, content);
  publish();
}

/** External reload is serialized and revalidated; setDoc must reset the editor undo history. */
export function reloadSession(content: string): Promise<void> {
  const s = session;
  if (!s) return Promise.resolve();
  return enqueue(s.path, async () => {
    const disk = await diskContent(s.path);
    if (disk !== content) {
      conflictWith(s, disk);
      throw new ConflictError();
    }
    loadDiskInto(s, content);
  });
}

/** Explicit permission to overwrite this baseline; flush still rechecks the actual disk. */
export function markDiskContent(content: string | null) {
  if (!session) return;
  stopAutosave(session);
  session.saved = content;
  session.conflict = null;
  session.error = null;
  publish();
}

/** Returns true only when the user explicitly accepted a deletion. */
export function resolveConflict(conflict: DiskConflict, choice: "local" | "disk"): Promise<boolean> {
  return enqueue(conflict.path, async () => {
    const s = buffers.get(conflict.path);
    if (!s || s.conflict !== conflict) throw new ConflictError();
    const disk = await diskContent(s.path);
    if (disk !== conflict.disk) {
      conflictWith(s, disk);
      throw new ConflictError();
    }
    if (choice === "local") {
      s.saved = disk;
      s.conflict = null;
      await saveBuffer(s);
      vault.setContent(s.path, s.doc);
      return false;
    }
    if (disk !== null) {
      loadDiskInto(s, disk);
      releaseClean(s);
      return false;
    }
    stopAutosave(s);
    cancelArchives(s.path);
    buffers.delete(s.path);
    if (session === s) session = null;
    s.handle = null;
    publish();
    return true;
  }).then(async (deleted) => {
    const root = vault.get().root;
    if (deleted && root) await vault.load(root);
    return deleted;
  });
}

/**
 * Every vault refresh passes here, not only watcher refreshes. Dirty/deleted documents
 * remain in the index, while disk reconciliation is ordered after this app's writes.
 */
vault.setReconciler(async (root, files) => {
  const inVault = (path: string) => path.startsWith(`${root}/`);
  if (vault.get().root && vault.get().root !== root) cancelArchives();
  const listed = new Map(files.map((f) => [f.path, f]));
  for (const archive of pendingArchives.values()) {
    if (!inVault(archive.path) || !listed.has(archive.path)) cancelArchives(archive.path);
  }
  await Promise.all([...buffers.values()].filter((s) => inVault(s.path)).map((s) => enqueue(s.path, async () => {
    if (buffers.get(s.path) !== s) return;
    const disk = await diskContent(s.path);
    if (s.conflict) conflictWith(s, disk);
    else if (disk === s.saved) { /* The listing may have raced our write; preserve the buffer below. */ }
    else if (disk === null || s.doc !== s.saved && disk !== s.doc) conflictWith(s, disk);
    else loadDiskInto(s, disk);
  })));
  const merged = new Map<string, VaultFile>(files.map((f) => [f.path, f]));
  for (const s of buffers.values()) {
    if (!inVault(s.path)) continue;
    const previous = merged.get(s.path) ?? vault.get().files.get(s.path);
    merged.set(s.path, { path: s.path, rel: previous?.rel ?? s.path.slice(root.length + 1), mtime: previous?.mtime ?? Date.now(), content: s.doc });
  }
  return [...merged.values()];
});

/** Routes all mutations and saves through the same per-file queue. */
export function mutateFile(path: string, compute: (text: string) => TextEdit[]): Promise<void> {
  return enqueue(path, async () => {
    let s = buffers.get(path);
    try {
      if (!s) {
        const text = await readFile(path);
        // An editor may have opened while the disk read was pending.
        s = buffers.get(path) ?? newBuffer(path, text);
      }
      if (s.conflict) throw new ConflictError();
      const before = s.doc;
      const edits = compute(before);
      if (!edits.length) { releaseClean(s); return; }
      const next = applyEdits(before, edits);
      if (s.handle) {
        s.handle.applyEdits(edits);
      } else {
        trackArchives(path, before, next);
        s.doc = next;
        vault.setContent(path, next);
        await saveBuffer(s);
      }
    } catch (e) {
      if (s) reportFailure(s, e);
      else toast.show({ text: `修改失败：${String(e)}` });
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
    if (path && pending.path !== path && !pending.path.startsWith(`${path}/`)) continue;
    pending.cancelled = true;
    window.clearTimeout(pending.timer);
    pendingArchives.delete(key);
  }
}

function trackArchives(path: string, before: string, after: string) {
  const [edit] = diffEdit(before, after);
  if (!edit) return;
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  for (const [key, pending] of pendingArchives) {
    if (pending.path !== path) continue;
    // String-only onChange cannot identify which identical line was inserted/deleted.
    const ambiguous = oldLines.indexOf(pending.id.raw) !== oldLines.lastIndexOf(pending.id.raw)
      || newLines.indexOf(pending.id.raw) !== newLines.lastIndexOf(pending.id.raw);
    const offset = oldLines.slice(0, pending.id.line).reduce((n, line) => n + line.length + 1, 0);
    const end = offset + pending.id.raw.length;
    const overlaps = edit.from < end && edit.to > offset || edit.from > offset && edit.from < end;
    const nextOffset = edit.to <= offset ? offset + edit.insert.length - (edit.to - edit.from) : offset;
    const line = after.slice(0, nextOffset).split("\n").length - 1;
    if (ambiguous || pending.content !== before || overlaps || oldLines[pending.id.line] !== pending.id.raw || newLines[line] !== pending.id.raw) {
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
    if (pending.cancelled || text !== pending.content || text.split("\n")[pending.id.line] !== pending.id.raw) return [];
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

export async function toggle(path: string, line: number): Promise<void> {
  let before = "";
  let after = "";
  let candidate: TaskIdentity | null = null;
  let checked = false;
  await mutateFile(path, (text) => {
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

export function patchFields(path: string, line: number, patch: FieldPatch): Promise<void> {
  return mutateFile(path, (text) => setTaskFields(text, line, patch));
}
