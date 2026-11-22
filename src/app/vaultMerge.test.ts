import { describe, expect, it } from "vitest";
import { mergeListing } from "./vaultMerge";

const f = (path: string, content: string) => ({ path, rel: path.slice(3), content });

describe("mergeListing", () => {
  it("keeps an in-app write that landed after a stale listing was read", () => {
    const listed = [f("/v/a.md", "- [ ] A"), f("/v/b.md", "- [ ] B")];
    const current = new Map([["/v/a.md", f("/v/a.md", "- [x] A ✅ 2026-11-22")]]);
    const merged = mergeListing(listed, current, ["/v/a.md"]);
    expect(merged.find((x) => x.path === "/v/a.md")?.content).toBe("- [x] A ✅ 2026-11-22");
    expect(merged.find((x) => x.path === "/v/b.md")?.content).toBe("- [ ] B");
  });

  it("takes the listing for paths unchanged since it started", () => {
    const listed = [f("/v/a.md", "disk")];
    const current = new Map([["/v/a.md", f("/v/a.md", "old")]]);
    expect(mergeListing(listed, current, [])[0].content).toBe("disk");
  });

  it("keeps a file removed after the listing started removed", () => {
    const listed = [f("/v/a.md", "x"), f("/v/gone.md", "y")];
    expect(mergeListing(listed, new Map(), ["/v/gone.md"]).map((x) => x.path)).toEqual(["/v/a.md"]);
  });
});
