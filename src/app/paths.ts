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
