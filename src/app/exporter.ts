import { convertFileSrc } from "@tauri-apps/api/core";
import MarkdownIt from "markdown-it";
import { parser, GFM } from "@lezer/markdown";
import { applyEdits, type TextEdit } from "../core";
import { markdownPath, resolveRelative } from "./paths";

const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

/** Render `- [ ]` / `- [x]` list items as disabled checkboxes. */
md.core.ruler.after("inline", "task-checkboxes", (state) => {
  const tokens = state.tokens;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
    const first = inline.children?.[0];
    const m = first?.type === "text" ? /^\[([ xX])\]\s/.exec(first.content) : null;
    if (!first || !m) continue;
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("html_inline", "", 0);
    box.content = `<input type="checkbox" disabled${m[1] === " " ? "" : " checked"}> `;
    inline.children!.unshift(box);
    tokens[i - 2].attrJoin("class", m[1] === " " ? "task" : "task done");
  }
});

const CSS = `
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#1d1d1f;max-width:760px;margin:0 auto;padding:24px}
h1,h2,h3{line-height:1.25}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f2f2f4;padding:1px 4px;border-radius:4px}
pre{background:#f2f2f4;padding:12px;border-radius:8px;overflow:auto}
pre code{background:none;padding:0}
blockquote{margin:0;padding-left:12px;border-left:3px solid #d0d0d6;color:#555}
table{border-collapse:collapse}td,th{border:1px solid #d0d0d6;padding:4px 10px}
img{max-width:100%}
li.task{list-style:none;margin-left:-1.3em}
li.task.done>p,li.task.done{color:#888}
li.task input{margin-right:6px}
@media print{body{padding:0}}
`;

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

async function toDataUrl(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`无法读取导出图片 (${res.status})：${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const type = res.headers.get("content-type") ?? "application/octet-stream";
  return `data:${type};base64,${btoa(bin)}`;
}

/** Standalone HTML for a list; local images are embedded as data URLs so the file is self-contained. */
export async function renderExportHtml(path: string, content: string): Promise<string> {
  const title = path.split("/").pop()!.replace(/\.md$/i, "");
  const doc = new DOMParser().parseFromString(md.render(content), "text/html");
  await Promise.all(
    [...doc.querySelectorAll("img")].map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (/^(https?:|data:)/.test(src)) return;
      img.setAttribute("src", await toDataUrl(convertFileSrc(resolveRelative(path, src))));
    }),
  );
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${doc.body.innerHTML}</body></html>`;
}

/** A Markdown copy keeps local links working at its new location; the original attachments stay in the vault. */
export function rebaseMarkdown(fromFile: string, outFile: string, content: string): string {
  const edits: TextEdit[] = [];
  const destination = outFile.split("/").slice(0, -1);
  parser.configure(GFM).parse(content).iterate({
    enter(node) {
      if (node.name !== "URL" || !["Image", "Link", "LinkReference"].includes(node.node.parent?.name ?? "")) return;
      const raw = content.slice(node.from, node.to);
      const url = raw.startsWith("<") ? raw.slice(1, -1) : raw;
      if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(url)) return;
      const boundary = url.search(/[?#]/);
      const path = boundary < 0 ? url : url.slice(0, boundary);
      if (!path) return;
      const suffix = boundary < 0 ? "" : url.slice(boundary);
      const target = resolveRelative(fromFile, path).split("/");
      let common = 0;
      while (common < destination.length && common < target.length && destination[common] === target[common]) common++;
      const rel = [...Array<string>(destination.length - common).fill(".."), ...target.slice(common)].join("/");
      edits.push({ from: node.from, to: node.to, insert: markdownPath(rel) + suffix });
    },
  });
  return applyEdits(content, edits);
}
