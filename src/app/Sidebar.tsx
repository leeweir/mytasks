import { useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import { allTags, isOpenTask, todayTasks, upcomingTasks } from "../core";
import type { VaultState } from "./vault";
import { Icon, type IconName } from "./icons";

export type View =
  | { kind: "today" }
  | { kind: "upcoming" }
  | { kind: "tags"; tag: string | null }
  | { kind: "done" }
  | { kind: "file"; path: string };

export interface TreeTarget {
  /** Vault-relative path; '' = vault root. */
  rel: string;
  isDir: boolean;
  path: string;
}

interface Node {
  name: string;
  rel: string;
  dirs: Node[];
  files: { name: string; rel: string; path: string; open: number }[];
}

function buildTree(state: Pick<VaultState, "dirs" | "files" | "tasks">): Node {
  const root: Node = { name: "", rel: "", dirs: [], files: [] };
  const dirMap = new Map<string, Node>([["", root]]);
  const ensure = (rel: string): Node => {
    const existing = dirMap.get(rel);
    if (existing) return existing;
    const cut = rel.lastIndexOf("/");
    const parent = ensure(cut < 0 ? "" : rel.slice(0, cut));
    const node: Node = { name: rel.slice(cut + 1), rel, dirs: [], files: [] };
    parent.dirs.push(node);
    dirMap.set(rel, node);
    return node;
  };
  for (const d of state.dirs) ensure(d);
  const openCount = new Map<string, number>();
  for (const t of state.tasks) if (isOpenTask(t.task)) openCount.set(t.path, (openCount.get(t.path) ?? 0) + 1);
  for (const f of state.files.values()) {
    const cut = f.rel.lastIndexOf("/");
    ensure(cut < 0 ? "" : f.rel.slice(0, cut)).files.push({
      name: f.rel.slice(cut + 1).replace(/\.md$/i, ""),
      rel: f.rel,
      path: f.path,
      open: openCount.get(f.path) ?? 0,
    });
  }
  const sort = (n: Node) => {
    n.dirs.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    n.files.sort((a, b) => a.name.localeCompare(b.name, "zh"));
    n.dirs.forEach(sort);
  };
  sort(root);
  return root;
}

interface Props {
  state: VaultState;
  view: View;
  today: string;
  query: string;
  searchText: string;
  searchRef: RefObject<HTMLInputElement | null>;
  onQuery(text: string, composing: boolean): void;
  onView(v: View): void;
  onContext(e: MouseEvent, target: TreeTarget): void;
  onNewList(): void;
  onChooseVault(): void;
}

export function Sidebar({ state, view, today, query, searchText, searchRef, onQuery, onView, onContext, onNewList, onChooseVault }: Props) {
  const { dirs, files, tasks } = state;
  const tree = useMemo(() => buildTree({ dirs, files, tasks }), [dirs, files, tasks]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const composing = useRef(false);
  const { todayCount, upcomingCount, tags } = useMemo(() => {
    const list = [...tasks];
    return {
      todayCount: todayTasks(list, today).length,
      upcomingCount: upcomingTasks(list, today, 7).reduce((n, g) => n + g.tasks.length, 0),
      tags: allTags(list),
    };
  }, [tasks, today]);
  const rootName = state.root?.split("/").pop() ?? "";

  const nav = (label: string, icon: IconName, v: View, count?: number) => {
    const active = !query && view.kind === v.kind && (v.kind !== "tags" || (view.kind === "tags" && view.tag === v.tag));
    return (
      <button
        data-kind={v.kind}
        key={`${v.kind}:${label}`}
        className={`nav${active ? " active" : ""}`}
        onClick={() => onView(v)}
      >
        <Icon name={icon} className="icon" />
        <span className="label">{label}</span>
        {!!count && <span className="count">{count}</span>}
      </button>
    );
  };

  const renderNode = (n: Node, depth: number) => (
    <>
      {n.dirs.map((d) => {
        const closed = collapsed[d.rel];
        return (
          <div key={d.rel}>
            <button
              className={`nav dir${closed ? "" : " open"}`}
              style={{ paddingLeft: 8 + depth * 16 }}
              aria-expanded={!closed}
              onClick={() => setCollapsed({ ...collapsed, [d.rel]: !closed })}
              onContextMenu={(e) => onContext(e, { rel: d.rel, isDir: true, path: `${state.root}/${d.rel}` })}
            >
              <Icon name="chevron" className="icon chevron" />
              <span className="label">{d.name}</span>
            </button>
            {!closed && renderNode(d, depth + 1)}
          </div>
        );
      })}
      {n.files.map((f) => (
        <button
          key={f.rel}
          className={`nav${!query && view.kind === "file" && view.path === f.path ? " active" : ""}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => onView({ kind: "file", path: f.path })}
          onContextMenu={(e) => onContext(e, { rel: f.rel, isDir: false, path: f.path })}
        >
          <Icon name="list" className="icon" />
          <span className="label">{f.name}</span>
          {!!f.open && <span className="count">{f.open}</span>}
        </button>
      ))}
    </>
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-top" data-tauri-drag-region />
      <label className="search">
        <Icon name="search" className="search-icon" />
        <input
          ref={searchRef}
          placeholder="搜索"
          aria-label="搜索"
          value={searchText}
          onCompositionStart={(e) => {
            composing.current = true;
            onQuery(e.currentTarget.value, true);
          }}
          onCompositionEnd={(e) => {
            composing.current = false;
            onQuery(e.currentTarget.value, false);
          }}
          onChange={(e) => onQuery(e.currentTarget.value, composing.current)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !composing.current && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
              e.preventDefault();
              onQuery("", false);
            }
          }}
        />
        {!searchText && <kbd className="search-hint">⌘F</kbd>}
      </label>
      <div className="scroll">
        <div className="section">
          {nav("今天", "sun", { kind: "today" }, todayCount)}
          {nav("即将到期", "calendar", { kind: "upcoming" }, upcomingCount)}
          {nav("已完成", "checkCircle", { kind: "done" })}
        </div>
        <div className="section">
          <div className="section-title">
            <button className="link" onClick={() => onView({ kind: "tags", tag: null })}>
              标签
            </button>
          </div>
          {tags.map((t) => nav(t.tag, "hash", { kind: "tags", tag: t.tag }, t.count))}
        </div>
        <div className="section" onContextMenu={(e) => e.target === e.currentTarget && onContext(e, { rel: "", isDir: true, path: state.root ?? "" })}>
          <div
            className="section-title"
            onContextMenu={(e) => onContext(e, { rel: "", isDir: true, path: state.root ?? "" })}
          >
            <span>清单</span>
            <button className="icon-btn add-list" onClick={onNewList} aria-label="新建清单" title="新建清单 ⌘N">
              <Icon name="plus" />
            </button>
          </div>
          {renderNode(tree, 0)}
        </div>
      </div>
      <div className="vault-switch">
        <Icon name="folder" className="icon" />
        <span className="vault-name" title={state.root ?? ""}>{rootName}</span>
        <button className="text-btn" onClick={onChooseVault} aria-label="更换任务文件夹">更换…</button>
      </div>
    </aside>
  );
}
