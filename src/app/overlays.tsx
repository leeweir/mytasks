import { useEffect, useRef, useState } from "react";
import type { SaveError } from "./session";
import { isValidName } from "./text";

export function PromptDialog({
  title,
  initial,
  placeholder,
  confirmLabel = "确定",
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: string;
  placeholder?: string;
  confirmLabel?: string;
  onSubmit(value: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.select(), []);
  const valid = isValidName(value.trim());
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit(value.trim());
        }}
      >
        <div className="dialog-title">{title}</div>
        <input
          ref={ref}
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && onCancel()}
        />
        <div className="pop-row end">
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="primary" disabled={!valid}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ConflictDialog({ name, deleted, busy, onKeepMine, onLoadDisk }: {
  name: string;
  deleted: boolean;
  busy: boolean;
  onKeepMine(): void;
  onLoadDisk(): void;
}) {
  return (
    <div className="backdrop">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title" aria-describedby="conflict-description" aria-busy={busy}>
        <div className="dialog-title" id="conflict-title">“{name}” 已在外部被{deleted ? "删除" : "修改"}</div>
        <p className="muted" id="conflict-description">
          {deleted ? "本地内容仍保留，自动保存已暂停。要重新创建文件，还是接受删除并丢弃本地内容？" : "本地修改仍保留，自动保存已暂停。要保留哪个版本？"}
        </p>
        <div className="pop-row end">
          <button disabled={busy} onClick={onLoadDisk}>{deleted ? "接受删除" : "载入磁盘版本"}</button>
          <button className="primary" disabled={busy} onClick={onKeepMine}>
            {deleted ? "保留本地并重新创建" : "保留我的修改"}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  run(): void;
  danger?: boolean;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose(): void }) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div className="context-menu" style={{ left: x, top: y }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it) => (
        <button
          key={it.label}
          className={it.danger ? "danger" : ""}
          onClick={() => {
            onClose();
            it.run();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Persistent bar under the main top bar until each failed save is retried, copied out, or discarded. */
export function SaveErrorBar({ errors, onRetry, onSaveCopy, onDiscard }: {
  errors: readonly SaveError[];
  onRetry(path: string): void;
  onSaveCopy(path: string): void;
  onDiscard(path: string): void;
}) {
  if (!errors.length) return null;
  return (
    <div className="save-errors" role="alert">
      {errors.map((e) => (
        <div key={e.path} className="toast save-error">
          <span className="save-error-text">
            “{e.path.split("/").pop()}” 保存失败，修改仍在内存中：{e.message}
          </span>
          <button onClick={() => onRetry(e.path)}>重试</button>
          <button onClick={() => onSaveCopy(e.path)}>另存副本…</button>
          <button className="danger" onClick={() => onDiscard(e.path)}>放弃本地修改</button>
        </div>
      ))}
    </div>
  );
}
