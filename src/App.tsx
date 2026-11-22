import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import {
  allowExit,
  cancelExit,
  chooseExportPath,
  chooseVault as pickVault,
  onExitRequested,
  createDir,
  createFile,
  exportPdf,
  getVault,
  onMenu,
  onVaultChanged,
  openVaultPath,
  renamePath,
  saveAttachment,
  trashPath,
  writeExport,
  type ExportKind,
  type MenuId,
} from "./backend";
import { listNameOf, todayISO, type FieldKind } from "./core";
import { EditorPane } from "./app/EditorPane";
import { markdownPath } from "./app/paths";
import { renderExportHtml, rebaseMarkdown } from "./app/exporter";
import { FieldPopover, type FieldTarget } from "./app/FieldPopover";
import { Icon } from "./app/icons";
import { classifyLink, findHeadingLine } from "./app/links";
import { ConflictDialog, ContextMenu, PromptDialog, SaveErrorBar, type MenuItem } from "./app/overlays";
import { syncReminders } from "./app/reminders";
import {
  cancelArchives,
  closeSession,
  currentSession,
  discardChanges,
  documentText,
  flush,
  flushArchives,
  flushCurrent,
  forgetAll,
  localCopy,
  resolveConflict,
  retrySave,
  sessionStatus,
  toggle,
} from "./app/session";
import { Sidebar, type TreeTarget, type View } from "./app/Sidebar";
import { lineText } from "./app/text";
import { toast, Toasts } from "./app/toast";
import { vault } from "./app/vault";
import { DoneView, SearchView, TagView, TodayView, UpcomingView, type RowActions } from "./app/views";
import "./App.css";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|svg|bmp|tiff?)$/i;
/** Rust awaits notification authorization; a first-run prompt must not hold up quitting. */
const EXIT_REMINDER_TIMEOUT_MS = 2000;

type Prompt = { title: string; initial: string; confirmLabel?: string; onSubmit(value: string): void };

function dirOfRel(rel: string): string {
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
}

export default function App() {
  const state = useSyncExternalStore(vault.subscribe, vault.get);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<View>({ kind: "today" });
  // Bumped whenever the session was closed while the editor stays on screen, so it remounts and reattaches.
  const [sessionEpoch, setSessionEpoch] = useState(0);
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

  const leaveDeleted = useCallback((path: string) => {
    setView((current) => current.kind === "file" && current.path === path ? { kind: "today" } : current);
  }, []);

  // ---- vault lifecycle ----
  useEffect(() => {
    getVault()
      .then(async (root) => {
        if (root) await vault.load(root);
      })
      .catch((e) => toast.show({ text: `无法打开文件夹：${String(e)}` }))
      .finally(() => setBooting(false));
  }, []);

  const chooseVault = useCallback(async () => {
    try {
      // The backend refuses writes outside the active vault, so everything is saved first.
      await flushArchives();
      await flush();
    } catch (e) {
      toast.show({ text: `请先保存或解决冲突：${String(e)}` });
      return;
    }
    let picked: string | null;
    try {
      picked = await pickVault();
    } catch (e) {
      toast.show({ text: `无法切换文件夹：${String(e)}` });
      return;
    }
    if (!picked) return;
    forgetAll();
    setView({ kind: "today" });
    setJump(null);
    clearSearch();
    setSessionEpoch((n) => n + 1);
    vault.switchTo(picked);
    try {
      await vault.load(picked);
    } catch (e) {
      toast.show({ text: `无法读取文件夹：${String(e)}` });
    }
  }, [clearSearch]);

  // All vault loads reconcile through persistence before publishing the new index.
  useEffect(() => {
    let timer: number | undefined;
    let disposed = false;
    let paths = new Set<string>();
    let full = false;
    const un = onVaultChanged((change) => {
      full ||= change.full;
      for (const p of change.paths) paths.add(p);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const root = vault.get().root;
        const batch = [...paths];
        const reloadAll = full;
        paths = new Set();
        full = false;
        if (!root || disposed) return;
        void (reloadAll ? vault.load(root) : vault.refresh(root, batch))
          .catch((e) => toast.show({ text: `读取外部修改失败：${String(e)}` }));
      }, 120);
    });
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      void un.then((f) => f());
    };
  }, []);

  // Each skipped file is reported once per session.
  const reportedSkips = useRef(new Set<string>());
  useEffect(() => {
    const fresh = state.skipped.filter((s) => !reportedSkips.current.has(`${s.rel}\n${s.reason}`));
    if (!fresh.length) return;
    for (const s of fresh) reportedSkips.current.add(`${s.rel}\n${s.reason}`);
    const shown = fresh.slice(0, 5).map((s) => `${s.rel}（${s.reason}）`).join("、");
    toast.show({
      text: `已跳过 ${fresh.length} 个无法读取的文件（非 UTF-8 或无权限）：${shown}${fresh.length > 5 ? " 等" : ""}`,
      durationMs: 10_000,
    });
  }, [state.skipped]);

  const resolveDiskConflict = async (choice: "local" | "disk") => {
    if (!conflict || resolvingConflict) return;
    setResolvingConflict(true);
    try {
      if (await resolveConflict(conflict, choice)) leaveDeleted(conflict.path);
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
  useEffect(() => {
    if (!state.loaded) return;
    const id = window.setTimeout(() => {
      syncReminders(state.tasks, new Date()).catch((e) => toast.show({ text: `提醒设置失败：${String(e)}` }));
    }, 1500);
    return () => window.clearTimeout(id);
  }, [state.tasks, state.loaded, today]);

  // ---- navigation ----
  // Only the open document must be saved before leaving it; other failures stay in the error bar.
  const openFile = useCallback(async (path: string, line: number | null = null) => {
    try {
      await flushCurrent();
      clearSearch();
      setView({ kind: "file", path });
      setJump(line === null ? null : { line });
    } catch (e) {
      toast.show({ text: `请先保存或解决冲突：${String(e)}` });
    }
  }, [clearSearch]);

  const go = useCallback(async (v: View) => {
    try {
      await flushCurrent();
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
      await flushCurrent();
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
            await vault.refresh(vault.get().root!, [path]);
            void openFile(path, 2);
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
          const parent = dirOfRel(t.rel);
          const newRel = `${parent ? `${parent}/` : ""}${name}${t.isDir ? "" : ".md"}`;
          if (newRel === t.rel) return;
          const open = openPathRef.current;
          const affectsOpen = !!open && (open === t.path || open.startsWith(`${t.path}/`));
          let reopen = open;
          let closed = false;
          try {
            await flushArchives();
            await flush(t.path);
            cancelArchives(t.path);
            if (affectsOpen) {
              await closeSession();
              closed = true;
            }
            const newPath = await renamePath(t.path, newRel);
            if (affectsOpen) reopen = t.isDir ? newPath + open!.slice(t.path.length) : newPath;
            await vault.load(vault.get().root!);
          } catch (e) {
            toast.show({ text: `重命名失败：${String(e)}` });
          } finally {
            // The closed session must be reattached even when the path did not change.
            if (closed) {
              setView({ kind: "file", path: reopen! });
              setSessionEpoch((n) => n + 1);
            }
          }
        },
      });
    },
    [],
  );

  const remove = useCallback(async (t: TreeTarget) => {
    const ok = await ask(`将 “${t.rel}” 移到废纸篓？`, { title: "删除", kind: "warning", okLabel: "移到废纸篓", cancelLabel: "取消" });
    if (!ok) return;
    const open = openPathRef.current;
    try {
      await flush(t.path);
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
  const doExport = useCallback(async (kind: ExportKind) => {
    const s = currentSession();
    if (!s) {
      toast.show({ text: "请先打开一个清单" });
      return;
    }
    try {
      await flush(s.path);
      const content = s.doc;
      const out = await chooseExportPath(`${listNameOf(s.path)}${kind === "md" ? " 副本" : ""}.${kind}`, kind);
      if (!out) return;
      // A Markdown copy saved inside the vault is not an own write, so the watcher indexes it.
      if (kind === "md") await writeExport(out, rebaseMarkdown(s.path, out, content));
      else {
        const { html, failedImages } = await renderExportHtml(s.path, content, out);
        if (failedImages.length) {
          toast.show({ text: `${failedImages.length} 张图片无法嵌入，已保留原链接：${failedImages.slice(0, 3).join("、")}` });
        }
        if (kind === "html") await writeExport(out, html);
        else await exportPdf(html, out);
      }
      toast.show({ text: `已导出到 ${out.split("/").pop()}` });
    } catch (e) {
      toast.show({ text: `导出失败：${String(e)}` });
    }
  }, []);

  // ---- failed saves ----
  const saveCopy = useCallback(async (path: string) => {
    const text = localCopy(path);
    if (text === null) return;
    try {
      const out = await chooseExportPath(`${listNameOf(path)} 副本.md`, "md");
      if (!out) return;
      await writeExport(out, rebaseMarkdown(path, out, text));
      toast.show({ text: `已另存到 ${out.split("/").pop()}` });
    } catch (e) {
      toast.show({ text: `另存失败：${String(e)}` });
    }
  }, []);

  const discard = useCallback(async (path: string) => {
    const ok = await ask(`放弃 “${path.split("/").pop()}” 未保存的修改，并载入磁盘上的版本？`, {
      title: "放弃本地修改", kind: "warning", okLabel: "放弃修改", cancelLabel: "取消",
    });
    if (!ok) return;
    try {
      if (await discardChanges(path)) leaveDeleted(path);
    } catch (e) {
      toast.show({ text: `无法载入磁盘版本：${String(e)}` });
    }
  }, [leaveDeleted]);

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
        return void go({ kind: "today" });
      case "view-upcoming":
        return void go({ kind: "upcoming" });
      case "view-tags":
        return void go({ kind: "tags", tag: null });
      case "view-done":
        return void go({ kind: "done" });
      case "view-lists": {
        const first = [...state.files.values()].sort((a, b) => a.rel.localeCompare(b.rel, "zh"))[0];
        if (first) void openFile(first.path);
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
        } catch (e) {
          toast.show({ text: `尚未退出，请先保存或解决冲突：${String(e)}` });
          // A pending logout must be cancelled rather than left waiting for this window.
          await cancelExit().catch((err) => console.error("Cancelling exit failed:", err));
          return;
        }
        // Register reminders added or removed just before quitting. Neither a refusal nor a
        // first-run permission prompt may block quitting. (tsconfig lib ES2020: no Promise.withResolvers.)
        if (vault.get().loaded) {
          await Promise.race([
            syncReminders(vault.get().tasks, new Date()).catch((e) => console.error("Reminder scheduling failed:", e)),
            new Promise((resolve) => window.setTimeout(resolve, EXIT_REMINDER_TIMEOUT_MS)),
          ]);
        }
        await allowExit();
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
      const from = openPathRef.current;
      if (!from) return;
      const target = classifyLink(from, href);
      switch (target.kind) {
        case "url":
          void openUrl(target.url).catch((e) => toast.show({ text: `无法打开链接：${String(e)}` }));
          return;
        case "unsupported":
          toast.show({ text: `不支持打开此类链接：${target.url}` });
          return;
        case "heading": {
          const s = currentSession();
          const line = s ? findHeadingLine(s.handle.getDoc(), target.fragment) : null;
          if (line === null) toast.show({ text: `找不到标题：${target.fragment}` });
          else setJump({ line });
          return;
        }
        case "file": {
          if (!vault.get().files.has(target.path)) {
            void openVaultPath(target.path).catch((e) => toast.show({ text: `无法打开：${String(e)}` }));
            return;
          }
          const line = target.fragment ? findHeadingLine(documentText(target.path) ?? "", target.fragment) : null;
          if (target.path !== from) void openFile(target.path, line);
          else if (line !== null) setJump({ line });
        }
      }
    },
    [openFile],
  );

  const rowActions: RowActions = useMemo(
    () => ({ today, open: (path, line) => void openFile(path, line), editField: setField }),
    [today, openFile],
  );

  const onBadge = useCallback((line: number, text: string, kind: FieldKind, rect: DOMRect) => {
    const path = openPathRef.current;
    if (path) setField({ path, line, raw: text, kind, rect });
  }, []);
  const onToggle = useCallback((line: number) => {
    const s = currentSession();
    if (!s || s.path !== openPathRef.current) return;
    // The editor document is current at request time; the line text pins the task.
    const raw = lineText(s.handle.getDoc(), line);
    if (raw !== undefined) void toggle(s.path, line, raw).catch(() => undefined);
  }, []);

  if (booting) return <div className="welcome" />;

  if (!state.root) {
    return (
      <div className="welcome">
        <div className="welcome-drag" data-tauri-drag-region />
        <div className="welcome-card">
          <span className="welcome-mark" aria-hidden="true" />
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
  if (query.trim()) main = <SearchView files={state.files} query={query.trim()} actions={rowActions} />;
  else if (view.kind === "today") main = <TodayView tasks={state.tasks} actions={rowActions} />;
  else if (view.kind === "upcoming") main = <UpcomingView tasks={state.tasks} actions={rowActions} />;
  else if (view.kind === "tags")
    main = <TagView tasks={state.tasks} tag={view.tag} onSelectTag={(tag) => void go({ kind: "tags", tag })} actions={rowActions} />;
  else if (view.kind === "done") main = <DoneView tasks={state.tasks} actions={rowActions} />;
  else if (openFileState)
    main = (
      <EditorPane
        key={`${openFileState.path}\n${sessionEpoch}`}
        path={openFileState.path}
        content={openFileState.content}
        jump={jump}
        onBadge={onBadge}
        onToggle={onToggle}
        onOpenLink={openLink}
      />
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
        onView={(v) => void (v.kind === "file" ? openFile(v.path) : go(v))}
        onContext={onContext}
        onNewList={() => newList("")}
        onChooseVault={() => void chooseVault()}
      />
      <main className="main">
        <header className="topbar" data-tauri-drag-region>
          {!query.trim() && openFileState && (
            <>
              <span className="crumb" data-tauri-drag-region>
                {openFileState.rel.replace(/\.md$/i, "").split("/").join(" / ")}
              </span>
              <button
                className="icon-btn topbar-action"
                aria-label="导出"
                title="导出"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu({
                    x: Math.max(8, Math.min(r.right - 180, window.innerWidth - 188)), y: r.bottom + 6,
                    items: [
                      { label: "导出 PDF…", run: () => void doExport("pdf") },
                      { label: "导出 HTML…", run: () => void doExport("html") },
                      { label: "导出 Markdown 副本…", run: () => void doExport("md") },
                    ],
                  });
                }}
              >
                <Icon name="share" />
              </button>
            </>
          )}
        </header>
        <SaveErrorBar
          errors={persistence.errors}
          onRetry={(path) => void retrySave(path).catch(() => undefined)}
          onSaveCopy={(path) => void saveCopy(path)}
          onDiscard={(path) => void discard(path)}
        />
        <div className="main-body">{main}</div>
      </main>
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
