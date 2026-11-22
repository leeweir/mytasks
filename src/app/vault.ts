import { listVault, readVaultFiles, type SkippedFile } from "../backend";
import { indexFile, type IndexedTask } from "../core";
import { toLF } from "./text";
import { mergeListing } from "./vaultMerge";

export interface VaultFile {
  path: string;
  rel: string;
  /** LF-only text; the session restores each file's line endings on write. */
  content: string;
}

export interface VaultState {
  root: string | null;
  loaded: boolean;
  files: ReadonlyMap<string, VaultFile>;
  dirs: readonly string[];
  tasks: readonly IndexedTask[];
  /** Files the last full listing left out (not UTF-8, unreadable folders). */
  skipped: readonly SkippedFile[];
}

/** `scope` = paths of a partial refresh; null = full listing, where unlisted means deleted. */
type Reconciler = (root: string, files: VaultFile[], scope: ReadonlySet<string> | null) => Promise<VaultFile[]>;

type Listener = () => void;

/** In-memory mirror of the vault: file contents + task index. Single source for all views. */
class VaultStore {
  private state: VaultState = { root: null, loaded: false, files: new Map(), dirs: [], tasks: [], skipped: [] };
  private perFile = new Map<string, IndexedTask[]>();
  private listeners = new Set<Listener>();
  private loadVersion = 0;
  /** Monotonic counter of content changes applied to the store. */
  private seq = 0;
  /** Last `seq` at which each path's content was set (or removed) after a disk read began. */
  private changedAt = new Map<string, number>();
  private reconcile: Reconciler | undefined;

  /** Installed by persistence so every reload preserves unsaved editor buffers. */
  setReconciler(reconcile: Reconciler) {
    this.reconcile = reconcile;
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  get = (): VaultState => this.state;

  private emit(patch: Partial<VaultState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private index(files: ReadonlyMap<string, VaultFile>): IndexedTask[] {
    const perFile = new Map<string, IndexedTask[]>();
    const out: IndexedTask[] = [];
    for (const f of files.values()) {
      const prev = this.state.files.get(f.path);
      const tasks = (prev && prev.content === f.content ? this.perFile.get(f.path) : undefined) ?? indexFile(f.path, f.content);
      perFile.set(f.path, tasks);
      out.push(...tasks);
    }
    this.perFile = perFile;
    return out;
  }

  private changedSince(start: number): string[] {
    return [...this.changedAt].filter(([, at]) => at > start).map(([path]) => path);
  }

  /** Shows a newly chosen vault immediately, before its first listing arrives. */
  switchTo(root: string) {
    this.loadVersion++;
    this.perFile = new Map();
    this.changedAt.clear();
    this.emit({ root, loaded: false, files: new Map(), dirs: [], tasks: [], skipped: [] });
  }

  async load(root: string): Promise<void> {
    const version = ++this.loadVersion;
    const start = this.seq;
    const res = await listVault();
    if (version !== this.loadVersion) return;
    const listed = res.files.map((f) => ({ path: f.path, rel: f.rel, content: toLF(f.content) }));
    const reconciled = this.reconcile ? await this.reconcile(root, listed, null) : listed;
    if (version !== this.loadVersion) return;
    // In-app writes and partial refreshes that landed while the listing was in flight are newer.
    const current = this.state.root === root ? this.state.files : new Map<string, VaultFile>();
    const files = new Map(mergeListing(reconciled, current, this.changedSince(start)).map((f) => [f.path, f]));
    // Changes after `start` stay recorded: a refresh begun during this listing still needs them.
    for (const [path, at] of this.changedAt) if (at <= start) this.changedAt.delete(path);
    this.emit({ root, loaded: true, files, dirs: res.dirs, tasks: this.index(files), skipped: res.skipped });
  }

  /** Re-reads only `paths` (canonical .md paths reported by the watcher). */
  async refresh(root: string, paths: readonly string[]): Promise<void> {
    if (!paths.length) return;
    const version = this.loadVersion;
    const start = this.seq;
    const res = await readVaultFiles([...paths]);
    if (version !== this.loadVersion || this.state.root !== root) return;
    const present = res.flatMap((f) => f.content === null ? [] : [{ path: f.path, rel: f.rel, content: toLF(f.content) }]);
    const scope = new Set(paths);
    const reconciled = this.reconcile ? await this.reconcile(root, present, scope) : present;
    if (version !== this.loadVersion || this.state.root !== root) return;
    const newer = new Set(this.changedSince(start));
    const files = new Map(this.state.files);
    for (const path of scope) if (!newer.has(path)) files.delete(path);
    for (const f of reconciled) if (!newer.has(f.path)) files.set(f.path, f);
    const seq = ++this.seq;
    for (const path of scope) if (!newer.has(path)) this.changedAt.set(path, seq);
    // Files that became unreadable are reported like those a full listing skips.
    const reread = new Set(res.map((f) => f.rel));
    const skipped = [
      ...this.state.skipped.filter((s) => !reread.has(s.rel)),
      ...res.flatMap((f) => f.content === null && f.skipped !== null ? [{ rel: f.rel, reason: f.skipped }] : []),
    ];
    this.emit({ files, tasks: this.index(files), skipped });
  }

  /** Records a successful in-app write so a listing begun before it cannot restore older text. */
  touch(path: string) {
    this.changedAt.set(path, ++this.seq);
  }

  /** Update one file's content (after an in-app edit or write). */
  setContent(path: string, content: string) {
    const prev = this.state.files.get(path);
    if (prev && prev.content === content) return;
    const root = this.state.root ?? "";
    const rel = prev?.rel ?? (path.startsWith(root + "/") ? path.slice(root.length + 1) : path);
    const files = new Map(this.state.files);
    files.set(path, { path, rel, content });
    this.changedAt.set(path, ++this.seq);
    this.emit({ files, tasks: this.index(files) });
  }
}

export const vault = new VaultStore();
