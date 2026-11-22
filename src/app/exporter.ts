import MarkdownIt from "markdown-it";
import { parser, GFM } from "@lezer/markdown";
import { fileUrl } from "../backend";
import { applyEdits, type TextEdit } from "../core";
import { rebaseUrl, resolveRelative } from "./paths";

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
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const type = res.headers.get("content-type") ?? "application/octet-stream";
  return `data:${type};base64,${btoa(bin)}`;
}

export interface ExportedHtml {
  html: string;
  /** Local image sources that could not be embedded; they keep a link to the original file. */
  failedImages: string[];
}

/**
 * Standalone HTML for a list written to `outFile`: local images are embedded as data URLs
 * and relative links are rebased so they still reach the original files from `outFile`.
 */
export async function renderExportHtml(path: string, content: string, outFile: string): Promise<ExportedHtml> {
  const title = path.split("/").pop()!.replace(/\.md$/i, "");
  const doc = new DOMParser().parseFromString(md.render(content), "text/html");
  for (const a of doc.querySelectorAll("a[href]")) {
    const rebased = rebaseUrl(path, outFile, a.getAttribute("href")!);
    if (rebased !== null) a.setAttribute("href", rebased);
  }
  const failedImages: string[] = [];
  await Promise.all(
    [...doc.querySelectorAll("img")].map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (/^(https?:|data:)/.test(src)) return;
      const boundary = src.search(/[?#]/);
      const file = boundary < 0 ? src : src.slice(0, boundary);
      try {
        if (!file) throw new Error("empty image path");
        img.setAttribute("src", await toDataUrl(fileUrl(resolveRelative(path, file))));
      } catch {
        failedImages.push(src);
        const rebased = rebaseUrl(path, outFile, src);
        if (rebased !== null) img.setAttribute("src", rebased);
      }
    }),
  );
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body>${doc.body.innerHTML}</body></html>`;
  return { html, failedImages };
}

/** A Markdown copy keeps local links working at its new location; the original attachments stay in the vault. */
export function rebaseMarkdown(fromFile: string, outFile: string, content: string): string {
  const edits: TextEdit[] = [];
  parser.configure(GFM).parse(content).iterate({
    enter(node) {
      if (node.name !== "URL" || !["Image", "Link", "LinkReference"].includes(node.node.parent?.name ?? "")) return;
      const raw = content.slice(node.from, node.to);
      const rebased = rebaseUrl(fromFile, outFile, raw.startsWith("<") ? raw.slice(1, -1) : raw);
      if (rebased !== null) edits.push({ from: node.from, to: node.to, insert: rebased });
    },
  });
  return applyEdits(content, edits);
}
