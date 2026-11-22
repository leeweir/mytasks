import type { MouseEvent, ReactNode } from "react";
import {
  allTags,
  doneTasks,
  searchVault,
  tagTasks,
  todayTasks,
  upcomingTasks,
  type FieldKind,
  type IndexedTask,
} from "../core";
import type { FieldTarget } from "./FieldPopover";
import { dateLabel, PRIORITY_META } from "./format";
import { toggle } from "./session";
import type { VaultState } from "./vault";

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
    actions.editField({ path: t.path, line: t.line, kind, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
  };
  const overdue = !t.task.checked && !!fields.due && fields.due < actions.today;
  return (
    <div className={`row${t.task.checked ? " checked" : ""}`} onClick={() => actions.open(t.path, t.line)}>
      <input
        type="checkbox"
        checked={t.task.checked}
        onClick={(e) => e.stopPropagation()}
        aria-label={`${t.task.checked ? "取消完成" : "完成"} ${t.task.description}`}
        onChange={() => void toggle(t.path, t.line).catch(() => undefined)}
      />
      <div className="row-main">
        <div className="row-text">
          <Description text={t.task.description || "（无标题）"} />
        </div>
        <div className="row-meta">
          {fields.priority && (
            <button className="badge" onClick={field("priority")}>
              {PRIORITY_META[fields.priority].emoji} {PRIORITY_META[fields.priority].label}
            </button>
          )}
          {fields.recurrence && (
            <button className="badge" onClick={field("recurrence")}>
              🔁 {fields.recurrence}
            </button>
          )}
          {fields.reminder && (
            <button className="badge" onClick={field("reminder")}>
              ⏰ {dateLabel(fields.reminder.slice(0, 10), actions.today)} {fields.reminder.slice(11)}
            </button>
          )}
          {fields.due && (
            <button
              className={`badge${overdue ? " danger" : fields.due === actions.today ? " accent" : ""}`}
              onClick={field("due")}
            >
              📅 {dateLabel(fields.due, actions.today)}
            </button>
          )}
          {fields.done && (
            <button className="badge" onClick={field("done")}>
              ✅ {dateLabel(fields.done, actions.today)}
            </button>
          )}
          {!t.task.checked && (
            <span className="row-add">
              {!fields.due && (
                <button className="badge ghost" title="截止日期" onClick={field("due")}>
                  📅
                </button>
              )}
              {!fields.reminder && (
                <button className="badge ghost" title="提醒" onClick={field("reminder")}>
                  ⏰
                </button>
              )}
              {!fields.priority && (
                <button className="badge ghost" title="优先级" onClick={field("priority")}>
                  ⏫
                </button>
              )}
              {!fields.recurrence && (
                <button className="badge ghost" title="重复" onClick={field("recurrence")}>
                  🔁
                </button>
              )}
            </span>
          )}
          {showList && <span className="row-list">{t.listName}</span>}
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
  const list = todayTasks([...tasks], actions.today);
  const overdue = list.filter((t) => t.task.fields.due && t.task.fields.due < actions.today);
  const rest = list.filter((t) => !overdue.includes(t));
  return (
    <div className="view">
      <h1>今天</h1>
      <div className="subtitle">{new Intl.DateTimeFormat("zh-CN", { dateStyle: "full" }).format(new Date(`${actions.today}T12:00:00`))}</div>
      {!list.length && <Empty text="今天没有到期任务。按 ⌘N 新建清单。" />}
      <Section title="已过期" tone="danger" tasks={overdue} actions={actions} />
      <Section title="今天" tasks={rest} actions={actions} />
    </div>
  );
}

export function UpcomingView({ tasks, actions }: { tasks: readonly IndexedTask[]; actions: RowActions }) {
  const groups = upcomingTasks([...tasks], actions.today, 7);
  return (
    <div className="view">
      <h1>即将到期</h1>
      <div className="subtitle">未来 7 天</div>
      {!groups.some((g) => g.tasks.length) && <Empty text="未来 7 天没有到期任务" />}
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
  const tags = allTags([...tasks]);
  const list = tag ? tagTasks([...tasks], tag) : [];
  return (
    <div className="view">
      <h1>{tag ? `#${tag}` : "标签"}</h1>
      <div className="tag-cloud">
        {tags.map((t) => (
          <button key={t.tag} className={`tag${t.tag === tag ? " on" : ""}`} onClick={() => onSelectTag(t.tag)}>
            #{t.tag} <span className="count">{t.count}</span>
          </button>
        ))}
        {!tags.length && <Empty text="还没有标签。在任务里写 #标签 即可。" />}
      </div>
      {tag && (list.length ? <Section title="未完成" tasks={list} actions={actions} /> : <Empty text="这个标签下没有未完成任务" />)}
    </div>
  );
}

export function DoneView({ tasks, actions }: { tasks: readonly IndexedTask[]; actions: RowActions }) {
  const list = doneTasks([...tasks]);
  const groups = new Map<string, IndexedTask[]>();
  for (const t of list) {
    const key = t.task.fields.done ?? "";
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return (
    <div className="view">
      <h1>已完成</h1>
      {!list.length && <Empty text="还没有完成的任务" />}
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

export function SearchView({ state, query, actions }: { state: VaultState; query: string; actions: RowActions }) {
  const results = searchVault(
    [...state.files.values()].map((f) => ({ path: f.path, content: f.content })),
    query,
  );
  const byFile = new Map<string, typeof results>();
  for (const r of results) byFile.set(r.path, [...(byFile.get(r.path) ?? []), r]);
  return (
    <div className="view">
      <h1>搜索</h1>
      <div className="subtitle">
        “{query}” · {results.length} 条结果
      </div>
      {!results.length && <Empty text="没有匹配" />}
      {[...byFile].map(([path, rs]) => (
        <section key={path} className="group">
          <h3>{state.files.get(path)?.rel ?? path}</h3>
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
