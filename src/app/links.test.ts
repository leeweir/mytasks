import { describe, expect, it } from "vitest";
import { classifyLink, findHeadingLine } from "./links";

const FROM = "/v/work/list.md";

describe("classifyLink", () => {
  it("sends web, mail and phone links to the system", () => {
    expect(classifyLink(FROM, "https://example.com")).toEqual({ kind: "url", url: "https://example.com" });
    expect(classifyLink(FROM, "mailto:a@b.c")).toEqual({ kind: "url", url: "mailto:a@b.c" });
    expect(classifyLink(FROM, "tel:123")).toEqual({ kind: "url", url: "tel:123" });
  });

  it("does not hand other schemes to the opener", () => {
    expect(classifyLink(FROM, "file:///etc/passwd").kind).toBe("unsupported");
    expect(classifyLink(FROM, "obsidian://open?x").kind).toBe("unsupported");
  });

  it("treats a bare fragment as a heading in the same document", () => {
    expect(classifyLink(FROM, "#下周")).toEqual({ kind: "heading", fragment: "下周" });
  });

  it("resolves attachments and notes relative to the linking file", () => {
    expect(classifyLink(FROM, "attachments/a%20b.pdf")).toEqual({ kind: "file", path: "/v/work/attachments/a b.pdf", fragment: null });
    expect(classifyLink(FROM, "../home.md#Plan")).toEqual({ kind: "file", path: "/v/home.md", fragment: "Plan" });
  });
});

describe("findHeadingLine", () => {
  const doc = "# 工作\n\n```\n## Fake\n```\n## Next Week\n- [ ] a\n### Done!\n";

  it("matches the heading text exactly", () => {
    expect(findHeadingLine(doc, "工作")).toBe(0);
    expect(findHeadingLine(doc, "Next%20Week")).toBe(5);
  });

  it("matches GitHub-style slugs", () => {
    expect(findHeadingLine(doc, "next-week")).toBe(5);
    expect(findHeadingLine(doc, "done")).toBe(7);
  });

  it("ignores headings inside fenced code", () => {
    expect(findHeadingLine(doc, "Fake")).toBeNull();
  });
});
