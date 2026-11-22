/** Resolve a Markdown destination relative to its document, decoding escaped filename characters. */
export function resolveRelative(fromFile: string, target: string): string {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // A literal percent sign is a valid filename character too.
  }
  const parts = decoded.startsWith("/") ? [""] : fromFile.split("/").slice(0, -1);
  for (const seg of decoded.split("/")) {
    if (seg === "..") {
      if (parts.length > 1) parts.pop();
    } else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

/** Encode path segments, including parentheses and #, without encoding directory separators. */
export function markdownPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

/**
 * A relative destination written in `fromFile`, rewritten so it points at the same file
 * from `outFile`. null for absolute paths, URLs with a scheme, and in-document anchors.
 */
export function rebaseUrl(fromFile: string, outFile: string, url: string): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(url)) return null;
  const boundary = url.search(/[?#]/);
  const path = boundary < 0 ? url : url.slice(0, boundary);
  if (!path) return null;
  const suffix = boundary < 0 ? "" : url.slice(boundary);
  const destination = outFile.split("/").slice(0, -1);
  const target = resolveRelative(fromFile, path).split("/");
  let common = 0;
  while (common < destination.length && common < target.length && destination[common] === target[common]) common++;
  const rel = [...Array<string>(destination.length - common).fill(".."), ...target.slice(common)].join("/");
  return markdownPath(rel) + suffix;
}
