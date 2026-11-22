import { describe, expect, it } from "vitest";
import { rebaseMarkdown } from "./exporter";
import { rebaseUrl } from "./paths";

describe("rebaseUrl", () => {
  it("rewrites an attachment link for an export saved in another folder", () => {
    expect(rebaseUrl("/v/work/list.md", "/Users/me/Desktop/list.html", "attachments/a%20b.pdf"))
      .toBe("../../../v/work/attachments/a%20b.pdf");
    expect(rebaseUrl("/v/work/list.md", "/v/out/list.html", "attachments/x.png?v=2#p"))
      .toBe("../work/attachments/x.png?v=2#p");
  });

  it("leaves URLs, absolute paths and anchors alone", () => {
    expect(rebaseUrl("/v/list.md", "/o/list.html", "https://x.y/z")).toBeNull();
    expect(rebaseUrl("/v/list.md", "/o/list.html", "/abs/p.png")).toBeNull();
    expect(rebaseUrl("/v/list.md", "/o/list.html", "#heading")).toBeNull();
  });
});

describe("rebaseMarkdown", () => {
  it("rebases links and images in a Markdown copy", () => {
    const text = "[doc](attachments/a.pdf) ![](attachments/b.png) [web](https://x.y)\n";
    expect(rebaseMarkdown("/v/work/list.md", "/v/list 副本.md", text))
      .toBe("[doc](work/attachments/a.pdf) ![](work/attachments/b.png) [web](https://x.y)\n");
  });
});
