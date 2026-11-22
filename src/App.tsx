import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import {
  allowExit,
  onExitRequested,
  createDir,
  createFile,
  exportPdf,
  getVault,
  onMenu,
  onVaultChanged,
  renamePath,
  saveAttachment,
  scheduleReminders,
  setVault,
  trashPath,
  writeFile,
  type MenuId,
} from "./backend";
import { pendingReminders, todayISO, type FieldKind } from "./core";
import { EditorPane } from "./app/EditorPane";
import { markdownPath, resolveRelative } from "./app/paths";
import { renderExportHtml, rebaseMarkdown } from "./app/exporter";
import { FieldPopover, type FieldTarget } from "./app/FieldPopover";
import { ConflictDialog, ContextMenu, PromptDialog, type MenuItem } from "./app/overlays";
import { closeSession, currentSession, flush, resolveConflict, sessionStatus, toggle } from "./app/session";
import { cancelArchives, flushArchives } from "./app/session";
import { Sidebar, type TreeTarget, type View } from "./app/Sidebar";
import { toast, Toasts } from "./app/toast";
import { vault } from "./app/vault";
import { DoneView, SearchView, TagView, TodayView, UpcomingView, type RowActions } from "./app/views";
import "./App.css";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|svg|bmp|tiff?)$/i;

type Prompt = { title: string; initial: string; confirmLabel?: string; onSubmit(value: string): void };

function dirOfRel(rel: string): string {
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
}

export default function App() {
  const state = useSyncExternalStore(vault.subscribe, vault.get);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<View>({ kind: "today" });
  const [query, setQuery] = useState("");
  const [searchText, setSearchText] = useState("");
  const searchRequest = useRef(0);
  const clearSearch = useCallback(() => {
    searchRequest.current++;
    setSearchText("");
    setQuery("");
  }, []);
  const [jump, setJump] = useState<{ line: number } | null>(null);
  const [today, setToday] = useState(() => todayISO(new Date()));
  const [field, setField] = useState<FieldTarget | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const persistence = useSyncExternalStore(sessionStatus.subscribe, sessionStatus.get);
  const conflict = persistence.conflicts[0] ?? null;
  const [resolvingConflict, setResolvingConflict] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const openPathRef = useRef<string | null>(null);
  openPathRef.current = view.kind === "file" ? view.path : null;

  // ---- vault lifecycle ----
  const loadVault = useCallback(async (root: string) => {
    await setVault(root);
    await vault.load(root);
  }, []);

  useEffect(() => {
    getVault()
      .then(async (root) => {
        if (root) await loadVault(root);
      })
      .catch((e) => toast.show({ text: `无法打开文件夹：${String(e)}` }))
      .finally(() => setBooting(false));
  }, [loadVault]);

  const chooseVault = useCallback(async () => {
    try {
      const picked = await openDialog({ directory: true, title: "选择任务文件夹" });
      if (typeof picked !== "string") return;
      await flushArchives();
      await flush();
      cancelArchives();
      await closeSession();
      await loadVault(picked);
      setView({ kind: "today" });
      clearSearch();
    } catch (e) {
      toast.show({ text: `无法切换文件夹：${String(e)}` });
    }
  }, [loadVault, clearSearch]);

  // All vault loads reconcile through persistence before publishing the new index.
  useEffect(() => {
    let timer: number | undefined;
    let disposed = false;
    const un = onVaultChanged(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const root = vault.get().root;
        if (!root || disposed) return;
        void vault.load(root).catch((e) => toast.show({ text: `读取外部修改失败：${String(e)}` }));
      }, 120);
    });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      void un.then((f) => f());
    };
  }, []);

  const resolveDiskConflict = async (choice: "local" | "disk") => {
    if (!conflict || resolvingConflict) return;
    setResolvingConflict(true);
    try {
      const deleted = await resolveConflict(conflict, choice);
      if (deleted) {
        setView((current) => current.kind === "file" && current.path === conflict.path ? { kind: "today" } : current);
      }
    } catch (e) {
      toast.show({ text: `无法处理冲突：${String(e)}` });
    } finally {
      setResolvingConflict(false);
    }
  };

  // Day rollover.
  useEffect(() => {
    const id = window.setInterval(() => setToday(todayISO(new Date())), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Keep scheduled notifications in sync with ⏰ fields.
  const lastReminders = useRef("");
  useEffect(() => {
    if (!state.loaded) return;
    const id = window.setTimeout(() => {
      const items = pendingReminders([...state.tasks], new Date());
      const key = JSON.stringify(items);
      if (key === lastReminders.current) return;
      lastReminders.current = key;
      scheduleReminders(items).catch((e) => toast.show({ text: `提醒设置失败：${String(e)}` }));
    }, 1500);
    return () => window.clearTimeout(id);
  }, [state.tasks, state.loaded, today]);

  // ---- navigation ----
  const openFile = useCallback(async (path: string, line: number | null = null) => {
    try {
      await flush();
      clearSearch();
      setView({ kind: "file", path });
      setJump(line === null ? null : { line });
    } catch (e) {
      toast.show({ text: `请先保存或解决冲突：${String(e)}` });
    }
  }, [clearSearch]);

  const go = useCallback(async (v: View) => {
    try {
      await flush();
      clearSearch();
      setView(v);
      setJump(null);
    } catch (e) {
      toast.show({ text: `请先保存或解决冲突：${String(e)}` });
    }
  }, [clearSearch]);

  const search = useCallback(async (text: string, composing: boolean) => {
    // Controlled inputs must echo each edit synchronously, including marked IME text.
    setSearchText(text);
    const request = ++searchRequest.current;
    if (composing) return;
    try {
      // Keep the editor mounted until its pending changes have been saved.
      await flush();
      if (request === searchRequest.current) setQuery(text);
    } catch (e) {
      if (request === searchRequest.current) {
        toast.show({ text: `请先保存或解决冲突：${String(e)}` });
      }
    }
  }, []);

  // ---- file operations ----
  const newList = useCallback(
    (dirRel: string) =>
      setPrompt({
        title: dirRel ? `在 “${dirRel}” 中新建清单` : "新建清单",
        initial: "",
        confirmLabel: "创建",
        onSubmit: async (name) => {
          setPrompt(null);
          try {
            const rel = `${dirRel ? `${dirRel}/` : ""}${name}.md`;
            const path = await createFile(rel, `# ${name}\n\n- [ ] `);
            await vault.load(vault.get().root!);
            openFile(path, 2);
          } catch (e) {
            toast.show({ text: `创建失败：${String(e)}` });
          }
        },
      }),
    [openFile],
  );

  const newFolder = useCallback(
    (dirRel: string) =>
      setPrompt({
        title: "新建文件夹",
        initial: "",
        confirmLabel: "创建",
        onSubmit: async (name) => {
          setPrompt(null);
          try {
            await createDir(`${dirRel ? `${dirRel}/` : ""}${name}`);
            await vault.load(vault.get().root!);
          } catch (e) {
            toast.show({ text: `创建失败：${String(e)}` });
          }
        },
      }),
    [],
  );

  const rename = useCallback(
    (t: TreeTarget) => {
      const base = t.rel.split("/").pop()!;
      setPrompt({
        title: "重命名",
        initial: t.isDir ? base : base.replace(/\.md$/i, ""),
        confirmLabel: "重命名",
        onSubmit: async (name) => {
          setPrompt(null);
          const open = openPathRef.current;
          const affectsOpen = !!open && (open === t.path || open.startsWith(`${t.path}/`));
          try {
            await flushArchives();
            await flush();
            cancelArchives(t.path);
            if (affectsOpen) await closeSession();
            const parent = dirOfRel(t.rel);
            const newRel = `${parent ? `${parent}/` : ""}${name}${t.isDir ? "" : ".md"}`;
            const newPath = await renamePath(t.path, newRel);
            await vault.load(vault.get().root!);
            if (affectsOpen) openFile(t.isDir ? newPath + open!.slice(t.path.length) : newPath);
          } catch (e) {
            toast.show({ text: `重命名失败：${String(e)}` });
            if (affectsOpen) openFile(open!);
          }
        },
      });
    },
    [openFile],
  );

  const remove = useCallback(async (t: TreeTarget) => {
    const ok = await ask(`将 “${t.rel}” 移到废纸篓？`, { title: "删除", kind: "warning", okLabel: "移到废纸篓", cancelLabel: "取消" });
    if (!ok) return;
    const open = openPathRef.current;
    try {
      await flush();
      cancelArchives(t.path);
      if (open && (open === t.path || open.startsWith(`${t.path}/`))) {
        await closeSession();
        setView({ kind: "today" });
      }
      await trashPath(t.path);
      await vault.load(vault.get().root!);
    } catch (e) {
      toast.show({ text: `删除失败：${String(e)}` });
    }
  }, []);

  const onContext = useCallback(
    (e: MouseEvent, t: TreeTarget) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = t.isDir ? t.rel : dirOfRel(t.rel);
      const items: MenuItem[] = [
        { label: "新建清单", run: () => newList(dir) },
        { label: "新建文件夹", run: () => newFolder(dir) },
      ];
      if (t.rel) {
        items.push({ label: "重命名…", run: () => rename(t) });
        items.push({ label: "移到废纸篓", danger: true, run: () => void remove(t) });
      }
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [newList, newFolder, rename, remove],
  );

  // ---- export ----
  const doExport = useCallback(async (kind: "pdf" | "html" | "md") => {
    const s = currentSession();
    if (!s) {
      toast.show({ text: "请先打开一个清单" });
      return;
    }
    try {
      await flush();
      const content = s.handle.getDoc();
      const base = s.path.split("/").pop()!.replace(/\.md$/i, "");
      const out = await saveDialog({
        title: "导出",
        defaultPath: `${base}${kind === "md" ? " 副本" : ""}.${kind}`,
        filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
      });
      if (!out) return;
      if (kind === "md") await writeFile(out, rebaseMarkdown(s.path, out, content));
      else {
        const html = await renderExportHtml(s.path, content);
        if (kind === "html") await writeFile(out, html);
        else await exportPdf(html, out);
      }
      toast.show({ text: `已导出到 ${out.split("/").pop()}` });
    } catch (e) {
      toast.show({ text: `导出失败：${String(e)}` });
    }
  }, []);

  // ---- menu ----
  const menuHandler = useRef<(id: MenuId) => void>(() => undefined);
  menuHandler.current = (id: MenuId) => {
    if (!state.root && id !== "choose-vault") return;
    const currentDir = view.kind === "file" ? dirOfRel(state.files.get(view.path)?.rel ?? "") : "";
    switch (id) {
      case "new-list":
        return newList(currentDir);
      case "new-folder":
        return newFolder(currentDir);
      case "choose-vault":
        return void chooseVault();
      case "export-pdf":
        return void doExport("pdf");
      case "export-html":
        return void doExport("html");
      case "export-md":
        return void doExport("md");
      case "find":
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      case "toggle-task":
        return currentSession()?.handle.toggleTaskAtCursor();
      case "view-today":
        return go({ kind: "today" });
      case "view-upcoming":
        return go({ kind: "upcoming" });
      case "view-tags":
        return go({ kind: "tags", tag: null });
      case "view-done":
        return go({ kind: "done" });
      case "view-lists": {
        const first = [...state.files.values()].sort((a, b) => a.rel.localeCompare(b.rel, "zh"))[0];
        if (first) openFile(first.path);
        return;
      }
    }
  };
  useEffect(() => {
    const un = onMenu((id) => menuHandler.current(id));
    return () => void un.then((f) => f());
  }, []);

  useEffect(() => {
    const un = onExitRequested(() => {
      void (async () => {
        try {
          await flushArchives();
          await flush();
          await allowExit();
        } catch (e) {
          toast.show({ text: `尚未退出，请先保存或解决冲突：${String(e)}` });
        }
      })();
    });
    return () => void un.then((f) => f());
  }, []);

  // ---- drag & drop attachments into the editor ----
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type !== "drop") return;
      const s = currentSession();
      if (!s) return;
      const scale = window.devicePixelRatio || 1;
      const { x, y } = e.payload.position;
      const parts: string[] = [];
      for (const p of e.payload.paths) {
        try {
          const rel = markdownPath(await saveAttachment(s.path, { path: p }));
          const name = p.split("/").pop()!.replace(/[\\\[\]]/g, "\\$&");
          parts.push(IMAGE_EXT.test(p) ? `![](${rel})` : `[${name}](${rel})`);
        } catch (err) {
          toast.show({ text: `添加附件失败：${String(err)}` });
        }
      }
      if (parts.length && currentSession() === s) s.handle.insertAtCoords(x / scale, y / scale, parts.join("\n"));
    });
    return () => void un.then((f) => f());
  }, []);

  // ---- links ----
  const openLink = useCallback(
    (href: string) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        void openUrl(href).catch((e) => toast.show({ text: `无法打开链接：${String(e)}` }));
        return;
      }
      const from = openPathRef.current;
      if (!from) return;
      const target = resolveRelative(from, href.split("#")[0]);
      if (vault.get().files.has(target)) openFile(target);
      else void openPath(target).catch((e) => toast.show({ text: `无法打开：${String(e)}` }));
    },
    [openFile],
  );

  const rowActions: RowActions = {
    today,
    open: (path, line) => openFile(path, line),
    editField: setField,
  };

  const onBadge = useCallback((line: number, kind: FieldKind, rect: DOMRect) => {
    const path = openPathRef.current;
    if (path) setField({ path, line, kind, rect });
  }, []);
  const onToggle = useCallback((line: number) => {
    const path = openPathRef.current;
    if (path) void toggle(path, line).catch(() => undefined);
  }, []);

  if (booting) return <div className="welcome" />;

  if (!state.root) {
    return (
      <div className="welcome">
        <div className="welcome-card">
          <div className="welcome-icon">☑︎</div>
          <h1>Tasks</h1>
          <p>选择一个文件夹存放你的任务清单。每个 .md 文件就是一个清单，可以用任何编辑器打开。</p>
          <button className="primary big" onClick={() => void chooseVault()}>
            选择文件夹…
          </button>
        </div>
        <Toasts />
      </div>
    );
  }

  const openFileState = view.kind === "file" ? state.files.get(view.path) : undefined;

  let main;
  if (query.trim()) main = <SearchView state={state} query={query.trim()} actions={rowActions} />;
  else if (view.kind === "today") main = <TodayView tasks={state.tasks} actions={rowActions} />;
  else if (view.kind === "upcoming") main = <UpcomingView tasks={state.tasks} actions={rowActions} />;
  else if (view.kind === "tags")
    main = <TagView tasks={state.tasks} tag={view.tag} onSelectTag={(tag) => go({ kind: "tags", tag })} actions={rowActions} />;
  else if (view.kind === "done") main = <DoneView tasks={state.tasks} actions={rowActions} />;
  else if (openFileState)
    main = (
      <div className="file-view">
        <div className="file-header">
          <span className="crumb">{openFileState.rel.replace(/\.md$/i, "").split("/").join(" / ")}</span>
          <button className="header-action" onClick={(e) => setMenu({
            x: Math.min(e.clientX, window.innerWidth - 176), y: e.clientY + 8,
            items: [
              { label: "导出 PDF…", run: () => void doExport("pdf") },
              { label: "导出 HTML…", run: () => void doExport("html") },
              { label: "导出 Markdown 副本…", run: () => void doExport("md") },
            ],
          })}>导出</button>
        </div>
        <EditorPane
          key={openFileState.path}
          path={openFileState.path}
          content={openFileState.content}
          jump={jump}
          onBadge={onBadge}
          onToggle={onToggle}
          onOpenLink={openLink}
        />
      </div>
    );
  else main = <div className="empty">清单不存在</div>;

  return (
    <div className="app">
      <Sidebar
        state={state}
        view={view}
        today={today}
        query={query}
        searchText={searchText}
        searchRef={searchRef}
        onQuery={(text, composing) => void search(text, composing)}
        onView={(v) => (v.kind === "file" ? openFile(v.path) : go(v))}
        onContext={onContext}
        onNewList={() => newList("")}
        onChooseVault={() => void chooseVault()}
      />
      <main className="main">{main}</main>
      {field && <FieldPopover target={field} onClose={() => setField(null)} />}
      {prompt && <PromptDialog {...prompt} onCancel={() => setPrompt(null)} />}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(null)} />}
      {conflict && (
        <ConflictDialog
          name={conflict.path.split("/").pop()!}
          deleted={conflict.disk === null}
          busy={resolvingConflict}
          onKeepMine={() => void resolveDiskConflict("local")}
          onLoadDisk={() => void resolveDiskConflict("disk")}
        />
      )}
      <Toasts />
    </div>
  );
}
