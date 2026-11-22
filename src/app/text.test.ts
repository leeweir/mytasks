import { describe, expect, it } from "vitest";
import { setTaskFields, toggleTask, applyEdits } from "../core";
import { assertLine, detectEol, fromLF, isValidName, StaleTaskError, toLF } from "./text";

describe("line endings", () => {
  it("round-trips a CRLF file through the LF session form", () => {
    const disk = "# L\r\n- [ ] A\r\n- [ ] B\r\n";
    const eol = detectEol(disk);
    expect(eol).toBe("\r\n");
    expect(toLF(disk)).toBe("# L\n- [ ] A\n- [ ] B\n");
    expect(fromLF(toLF(disk), eol)).toBe(disk);
  });

  it("toggles the right task when the editor holds the LF form of a CRLF file", () => {
    const disk = "# L\r\n- [ ] A\r\n- [ ] B\r\n- [ ] C\r\n";
    const doc = toLF(disk);
    const next = applyEdits(doc, toggleTask(doc, 2, new Date(2026, 10, 22)).edits);
    expect(fromLF(next, detectEol(disk))).toBe("# L\r\n- [ ] A\r\n- [x] B ✅ 2026-11-22\r\n- [ ] C\r\n");
  });

  it("keeps LF files and mixed files with mostly LF as LF", () => {
    expect(detectEol("a\nb\n")).toBe("\n");
    expect(detectEol("a\r\nb\nc\n")).toBe("\n");
    expect(detectEol("single line")).toBe("\n");
    expect(fromLF("a\nb", "\n")).toBe("a\nb");
  });

  it("normalizes lone CR like the editor does", () => {
    expect(toLF("a\rb\r\nc")).toBe("a\nb\nc");
  });
});

describe("task identity", () => {
  const doc = "- [ ] A\n- [ ] B 📅 2026-11-22\n- [ ] C\n";

  it("accepts the line the user acted on", () => {
    expect(() => assertLine(doc, 1, "- [ ] B 📅 2026-11-22")).not.toThrow();
  });

  it("rejects a line that now holds another task", () => {
    // Task A was archived: B moved up to line 0 and C now sits at line 1.
    const shifted = "- [ ] B 📅 2026-11-22\n- [ ] C\n";
    expect(() => assertLine(shifted, 1, "- [ ] B 📅 2026-11-22")).toThrow(StaleTaskError);
    expect(() => assertLine(shifted, 5, "- [ ] C")).toThrow(StaleTaskError);
  });

  it("guards a field patch so it never lands on the wrong task", () => {
    const shifted = "- [ ] B 📅 2026-11-22\n- [ ] C\n";
    const patch = () => {
      assertLine(shifted, 1, "- [ ] B 📅 2026-11-22");
      return setTaskFields(shifted, 1, { due: "2026-12-01" });
    };
    expect(patch).toThrow("任务已变化");
  });
});

describe("item names", () => {
  it("rejects hidden names that the vault listing would skip", () => {
    expect(isValidName(".foo")).toBe(false);
    expect(isValidName("..")).toBe(false);
    expect(isValidName("a/b")).toBe(false);
    expect(isValidName("")).toBe(false);
    expect(isValidName("工作.v2")).toBe(true);
  });
});
