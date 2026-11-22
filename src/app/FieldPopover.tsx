import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { addDays, parseTaskLine, suggest, todayISO, type FieldKind, type FieldPatch, type Priority } from "../core";
import { PRIORITY_META } from "./format";
import { Icon } from "./icons";
import { documentText, patchFields } from "./session";
import { lineText } from "./text";
import { vault } from "./vault";

export interface FieldTarget {
  path: string;
  line: number;
  /** The task's line text when the popover opened; edits abort if the line has changed. */
  raw: string;
  kind: FieldKind;
  rect: DOMRect;
}

const TITLES: Record<FieldKind, string> = {
  due: "截止日期",
  reminder: "提醒",
  priority: "优先级",
  recurrence: "重复",
  done: "完成日期",
  start: "开始日期",
  scheduled: "计划日期",
  created: "创建日期",
};

function nextMonday(today: string): string {
  const day = new Date(`${today}T00:00:00`).getDay();
  return addDays(today, ((8 - day) % 7) || 7);
}

export function FieldPopover({ target, onClose }: { target: FieldTarget; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: target.rect.left, top: target.rect.bottom + 6 });
  // Re-render on index updates so a task that moved or changed is reported instead of patched.
  useSyncExternalStore(vault.subscribe, vault.get);
  const stale = lineText(documentText(target.path) ?? "", target.line) !== target.raw;
  const task = parseTaskLine(target.raw);
  const current = task?.fields[target.kind];
  const today = todayISO(new Date());
  const [text, setText] = useState(typeof current === "string" ? current : "");

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(target.rect.left, window.innerWidth - r.width - 12);
    const below = target.rect.bottom + 6;
    const top = below + r.height > window.innerHeight - 12 ? Math.max(12, target.rect.top - r.height - 6) : below;
    setPos({ left: Math.max(12, left), top });
  }, [target]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const apply = (patch: FieldPatch) => {
    void patchFields(target.path, target.line, patch, target.raw).catch(() => undefined);
    onClose();
  };
  const set = (value: string | null) => apply({ [target.kind]: value } as FieldPatch);

  let body: ReactNode;
  if (target.kind === "priority") {
    body = (
      <div className="pop-grid">
        {(Object.keys(PRIORITY_META) as Priority[]).map((p) => (
          <button key={p} className={`prio${current === p ? " on" : ""}`} data-priority={p} onClick={() => set(p)}>
            <Icon name="flag" size={12} />
            {PRIORITY_META[p].label}
          </button>
        ))}
        <button onClick={() => set(null)}>无</button>
      </div>
    );
  } else if (target.kind === "reminder") {
    const value = text.replace(" ", "T");
    body = (
      <>
        <input
          type="datetime-local"
          autoFocus
          value={value}
          onChange={(e) => setText(e.target.value.replace("T", " "))}
          onKeyDown={(e) => e.key === "Enter" && text && set(text)}
        />
        <div className="pop-row">
          <button
            onClick={() => {
              const d = new Date(Date.now() + 3600_000);
              set(`${todayISO(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
            }}
          >
            一小时后
          </button>
          <button onClick={() => set(`${addDays(today, 1)} 09:00`)}>明天 9:00</button>
          <button onClick={() => set(`${today} 20:00`)}>今晚 20:00</button>
        </div>
        <div className="pop-row end">
          <button onClick={() => set(null)}>清除</button>
          <button className="primary" disabled={!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)} onClick={() => set(text)}>
            确定
          </button>
        </div>
      </>
    );
  } else if (target.kind === "recurrence") {
    const query = text.trim();
    const options = suggest(query.startsWith("每") || /^every/i.test(query) ? query : `每${query}`, new Date())
      .filter((s) => s.insert.startsWith("🔁"))
      .slice(0, 6);
    body = (
      <>
        <input
          autoFocus
          placeholder="每周一 / every 2 weeks"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && options[0]) set(options[0].insert.replace(/^🔁\s*/, ""));
          }}
        />
        <div className="pop-list">
          {options.map((s) => (
            <button key={s.insert} onClick={() => set(s.insert.replace(/^🔁\s*/, ""))}>
              <span>{s.label}</span>
              <small>{s.insert.replace(/^🔁\s*/, "")}</small>
            </button>
          ))}
        </div>
        <div className="pop-row end">
          <button onClick={() => set(null)}>不重复</button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <input
          type="date"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && text && set(text)}
        />
        <div className="pop-row">
          <button onClick={() => set(today)}>今天</button>
          <button onClick={() => set(addDays(today, 1))}>明天</button>
          <button onClick={() => set(nextMonday(today))}>下周一</button>
        </div>
        <div className="pop-row end">
          <button onClick={() => set(null)}>清除</button>
          <button className="primary" disabled={!/^\d{4}-\d{2}-\d{2}$/.test(text)} onClick={() => set(text)}>
            确定
          </button>
        </div>
      </>
    );
  }

  return (
    <div ref={ref} className="popover" style={{ left: pos.left, top: pos.top }}>
      <div className="pop-title">{TITLES[target.kind]}</div>
      {task && !stale ? body : <div className="muted">任务已变化或已不存在</div>}
    </div>
  );
}
