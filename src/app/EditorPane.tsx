import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { saveAttachment } from "../backend";
import type { FieldKind } from "../core";
import { createEditor, type EditorHandle } from "../editor";
import { closeSession, noteEdited, openSession } from "./session";
import { markdownPath, resolveRelative } from "./paths";
import { toast } from "./toast";


interface Props {
  path: string;
  content: string;
  /** New object identity = scroll request (so re-jumping to the same line works). */
  jump: { line: number } | null;
  onBadge(line: number, kind: FieldKind, rect: DOMRect): void;
  onToggle(line: number): void;
  onOpenLink(href: string): void;
}

export function EditorPane({ path, content, jump, onBadge, onToggle, onOpenLink }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const cb = useRef({ onBadge, onToggle, onOpenLink });
  cb.current = { onBadge, onToggle, onOpenLink };
  const handleRef = useRef<EditorHandle | null>(null);

  useEffect(() => {
    const handle = createEditor({
      parent: host.current!,
      doc: content,
      resolveImage: (src) => (/^(https?:|data:)/.test(src) ? src : convertFileSrc(resolveRelative(path, src))),
      onChange: (doc) => noteEdited(path, doc),
      onToggleRequest: (l) => cb.current.onToggle(l),
      onBadgeClick: (l, kind, rect) => cb.current.onBadge(l, kind, rect),
      onOpenLink: (href) => cb.current.onOpenLink(href),
      onPasteImage: async (bytes, ext) => {
        try {
          const rel = await saveAttachment(path, { bytes, ext });
          return `![](${markdownPath(rel)})`;
        } catch (e) {
          toast.show({ text: `添加图片失败：${String(e)}` });
          return null;
        }
      },
      now: () => new Date(),
    });
    handleRef.current = handle;
    openSession(path, handle, content);
    handle.focus();
    return () => {
      handleRef.current = null;
      void closeSession(handle).catch(() => undefined).finally(() => handle.destroy());
    };
    // Editor instance is per file; content is only the initial document.
  }, [path]);

  useEffect(() => {
    if (jump) handleRef.current?.scrollToLine(jump.line);
  }, [jump, path]);

  return <div className="editor-host" ref={host} />;
}
