import { useMemo, type MouseEvent, type ReactNode } from "react";
import {
  allTags,
  doneTasks,
  isOpenTask,
  searchVault,
  tagTasks,
  todayTasks,
  upcomingTasks,
  type FieldKind,
  type IndexedTask,
  type Priority,
} from "../core";
import type { FieldTarget } from "./FieldPopover";
import { dateLabel, PRIORITY_META } from "./format";
import { Icon } from "./icons";
import { toggle } from "./session";
import type { VaultState } from "./vault";

/** Checkbox ring colour for each priority (three tones; the extremes share their neighbour's). */
const PRIORITY_RING: Record<Priority, "high" | "medium" | "low"> = {
  highest: "high",
  high: "high",
  medium: "medium",
  low: "low",
  lowest: "low",
};

export interface RowActions {
  today: string;
  open(path: string, line: number): void;
  editField(target: FieldTarget): void;
}

function Description({ text }: { text: string }) {
  const parts = text.split(/(#[^\s#]*[^\s#\d][^\s#]*)/u);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <span key={i} className="tag">
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

export function TaskRow({ t, actions, showList = true }: { t: IndexedTask; actions: RowActions; showList?: boolean }) {
  const { fields } = t.task;
  const field = (kind: FieldKind) => (e: MouseEvent) => {
    e.stopPropagation();
    actions.editField({ path: t.path, line: t.line, raw: t.raw, kind, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
  };
  const open = isOpenTask(t.task);
  const overdue = open && !!fields.due && fields.due < actions.today;
  const rowClass = ["row", fields.priority && `p-${PRIORITY_RING[fields.priority]}`, t.task.checked && "checked", t.task.cancelled && "cancelled"]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={rowClass} onClick={() => actions.open(t.path, t.line)}>
      <input
        type="checkbox"
        className="check"
        checked={t.task.checked}
        onClick={(e) => e.stopPropagation()}
        aria-label={`${t.task.checked ? "取消完成" : "完成"} ${t.task.description}`}
        onChange={() => void toggle(t.path, t.line, t.raw).catch(() => undefined)}
      />
      <div className="row-main">
        <div className="row-line">
          <div className="row-text">
            <Description text={t.task.description || "（无标题）"} />
          </div>
          {showList && <span className="row-list">{t.listName}</span>}
        </div>
        <div className="row-meta">
          {fields.priority && (
            <button className="meta flag" onClick={field("priority")}>
              <Icon name="flag" size={12} />
              {PRIORITY_META[fields.priority].label}
            </button>
          )}
          {fields.recurrence && (
            <button className="meta" onClick={field("recurrence")}>
              <Icon name="repeat" size={12} />
              {fields.recurrence}
            </button>
          )}
          {fields.reminder && (
            <button className="meta" onClick={field("reminder")}>
              <Icon name="bell" size={12} />
              {dateLabel(fields.reminder.slice(0, 10), actions.today)} {fields.reminder.slice(11)}
            </button>
          )}
          {fields.due && (
            <button
              className={`meta${overdue ? " danger" : fields.due === actions.today ? " accent" : ""}`}
              onClick={field("due")}
            >
              <Icon name="calendar" size={12} />
              {dateLabel(fields.due, actions.today)}
            </button>
          )}
          {fields.done && (
            <button className="meta" onClick={field("done")}>
              <Icon name="checkCircle" size={12} />
              {dateLabel(fields.done, actions.today)}
            </button>
          )}
          {open && (
            <span className="row-add">
              {!fields.due && (
                <button className="icon-btn" title="截止日期" aria-label="添加截止日期" onClick={field("due")}>
                  <Icon name="calendar" size={12} />
                </button>
              )}
              {!fields.reminder && (
                <button className="icon-btn" title="提醒" aria-label="添加提醒" onClick={field("reminder")}>
                  <Icon name="bell" size={12} />
                </button>
              )}
              {!fields.priority && (
                <button className="icon-btn" title="优先级" aria-label="设置优先级" onClick={field("priority")}>
                  <Icon name="flag" size={12} />
                </button>
              )}
              {!fields.recurrence && (
                <button className="icon-btn" title="重复" aria-label="设置重复" onClick={field("recurrence")}>
                  <Icon name="repeat" size={12} />
                </button>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, tasks, actions, tone }: { title: string; tasks: IndexedTask[]; actions: RowActions; tone?: string }) {
  if (!tasks.length) return null;
  return (
    <section className="group">
      <h3 className={tone}>
        {title} <span className="count">{tasks.length}</span>
      </h3>
      {tasks.map((t) => (
        <TaskRow key={`${t.path}:${t.line}`} t={t} actions={actions} />
      ))}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function TodayView({ tasks, actions }: { tasks: readonly IndexedTask[]; actions: RowActions }) {
  const { list, overdue, rest } = useMemo(() => {
    const list = todayTasks([...tasks], actions.today);
    const overdue: IndexedTask[] = [];
    const rest: IndexedTask[] = [];
    for (const t of list) (t.task.fields.due && t.task.fields.due < actions.today ? overdue : rest).push(t);
    return { list, overdue, rest };
  }, [tasks, actions.today]);
  return (
    <div className="view">
      <h1>今天</h1>
      <div className="subtitle">{new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(new Date(`${actions.today}T12:00:00`))}</div>
      {!list.length && <Empty text="今天没有待办。在清单里给任务加上 📅 日期，或按 ⌘N 新建清单。" />}
      <Section title="已过期" tone="danger" tasks={overdue} actions={actions} />
      <Section title="今天" tasks={rest} actions={actions} />
    </div>
  );
}

export function UpcomingView({ tasks, actions }: { tasks: readonly IndexedTask[]; actions: RowActions }) {
  const groups = useMemo(() => upcomingTasks([...tasks], actions.today, 7), [tasks, actions.today]);
  return (
    <div className="view">
      <h1>即将到期</h1>
      <div className="subtitle">未来 7 天</div>
      {!groups.some((g) => g.tasks.length) && <Empty text="未来 7 天没有到期任务。给任务加上 📅 日期，它就会出现在这里。" />}
      {groups.map((g) => (
        <Section key={g.date} title={dateLabel(g.date, actions.today)} tasks={g.tasks} actions={actions} />
      ))}
    </div>
  );
}

export function TagView({
  tasks,
  tag,
  onSelectTag,
  actions,
}: {
  tasks: readonly IndexedTask[];
  tag: string | null;
  onSelectTag(tag: string): void;
  actions: RowActions;
}) {
  const tags = useMemo(() => allTags([...tasks]), [tasks]);
  const list = useMemo(() => (tag ? tagTasks([...tasks], tag) : []), [tasks, tag]);
  return (
    <div className="view">
      <h1>{tag ? `#${tag}` : "标签"}</h1>
      <div className="tag-cloud">
        {tags.map((t) => (
          <button key={t.tag} className={`tag${t.tag === tag ? " on" : ""}`} onClick={() => onSelectTag(t.tag)}>
            #{t.tag}<span className="count">{t.count}</span>
          </button>
        ))}
        {!tags.length && <Empty text="还没有标签。在任务里写上 #标签，就能在这里按标签查看。" />}
      </div>
      {tag && (list.length ? <Section title="未完成" tasks={list} actions={actions} /> : <Empty text="这个标签下没有未完成的任务。" />)}
    </div>
  );
}

export function DoneView({ tasks, actions }: { tasks: readonly IndexedTask[]; actions: RowActions }) {
  const { list, groups } = useMemo(() => {
    const list = doneTasks([...tasks]);
    const groups = new Map<string, IndexedTask[]>();
    for (const t of list) {
      const key = t.task.fields.done ?? "";
      const group = groups.get(key);
      if (group) group.push(t);
      else groups.set(key, [t]);
    }
    return { list, groups };
  }, [tasks]);
  return (
    <div className="view">
      <h1>已完成</h1>
      {!list.length && <Empty text="还没有完成的任务。勾选一个任务，它会按完成日期出现在这里。" />}
      {[...groups].map(([date, ts]) => (
        <Section key={date} title={date ? dateLabel(date, actions.today) : "未记录日期"} tasks={ts} actions={actions} />
      ))}
    </div>
  );
}

function Highlight({ text, matches }: { text: string; matches: [number, number][] }) {
  const out: ReactNode[] = [];
  let pos = 0;
  [...matches]
    .sort((a, b) => a[0] - b[0])
    .forEach(([from, to], i) => {
      if (from < pos) return;
      out.push(text.slice(pos, from), <mark key={i}>{text.slice(from, to)}</mark>);
      pos = to;
    });
  out.push(text.slice(pos));
  return <>{out}</>;
}

export function SearchView({ files, query, actions }: { files: VaultState["files"]; query: string; actions: RowActions }) {
  const { results, byFile } = useMemo(() => {
    const results = searchVault(
      [...files.values()].map((f) => ({ path: f.path, content: f.content })),
      query,
    );
    const byFile = new Map<string, typeof results>();
    for (const r of results) {
      const group = byFile.get(r.path);
      if (group) group.push(r);
      else byFile.set(r.path, [r]);
    }
    return { results, byFile };
  }, [files, query]);
  return (
    <div className="view">
      <h1>搜索</h1>
      <div className="subtitle">{results.length} 条结果</div>
      {!results.length && <Empty text="没有匹配的内容。换个关键词试试。" />}
      {[...byFile].map(([path, rs]) => (
        <section key={path} className="group">
          <h3>{files.get(path)?.rel ?? path}</h3>
          {rs.map((r) => (
            <div key={r.line} className="row search-hit" onClick={() => actions.open(path, Math.max(r.line, 0))}>
              <span className="line-no">{r.line >= 0 ? r.line + 1 : "文件名"}</span>
              <span className="row-text">
                <Highlight text={r.text} matches={r.matches} />
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
