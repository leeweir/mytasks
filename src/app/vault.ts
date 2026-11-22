import { listVault } from "../backend";
import { indexFile, type IndexedTask } from "../core";

export interface VaultFile {
  path: string;
  rel: string;
  content: string;
  mtime: number;
}

export interface VaultState {
  root: string | null;
  loaded: boolean;
  files: ReadonlyMap<string, VaultFile>;
  dirs: readonly string[];
  tasks: readonly IndexedTask[];
}

type Listener = () => void;

/** In-memory mirror of the vault: file contents + task index. Single source for all views. */
class VaultStore {
  private state: VaultState = { root: null, loaded: false, files: new Map(), dirs: [], tasks: [] };
  private perFile = new Map<string, IndexedTask[]>();
  private listeners = new Set<Listener>();
  private loadVersion = 0;
  private reconcile: ((root: string, files: VaultFile[]) => Promise<VaultFile[]>) | undefined;

  /** Installed by persistence so every reload preserves unsaved editor buffers. */
  setReconciler(reconcile: (root: string, files: VaultFile[]) => Promise<VaultFile[]>) {
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

  private flatten(): IndexedTask[] {
    const out: IndexedTask[] = [];
    for (const ts of this.perFile.values()) out.push(...ts);
    return out;
  }

  async load(root: string): Promise<void> {
    const version = ++this.loadVersion;
    const res = await listVault();
    if (version !== this.loadVersion) return;
    const reconciled = this.reconcile ? await this.reconcile(root, res.files) : res.files;
    if (version !== this.loadVersion) return;
    const files = new Map<string, VaultFile>();
    const perFile = new Map<string, IndexedTask[]>();
    for (const f of reconciled) {
      files.set(f.path, f);
      const prev = this.state.files.get(f.path);
      const cached = prev && prev.content === f.content ? this.perFile.get(f.path) : undefined;
      perFile.set(f.path, cached ?? indexFile(f.path, f.content));
    }
    this.perFile = perFile;
    this.emit({ root, loaded: true, files, dirs: res.dirs, tasks: this.flatten() });
  }

  clear() {
    this.loadVersion++;
    this.perFile = new Map();
    this.emit({ root: null, loaded: false, files: new Map(), dirs: [], tasks: [] });
  }

  /** Update one file's content (after an in-app edit or write). */
  setContent(path: string, content: string) {
    const prev = this.state.files.get(path);
    if (prev && prev.content === content) return;
    const root = this.state.root ?? "";
    const rel = prev?.rel ?? (path.startsWith(root + "/") ? path.slice(root.length + 1) : path);
    const files = new Map(this.state.files);
    files.set(path, { path, rel, content, mtime: Date.now() / 1000 });
    this.perFile.set(path, indexFile(path, content));
    this.emit({ files, tasks: this.flatten() });
  }
}

export const vault = new VaultStore();
