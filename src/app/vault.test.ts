import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultFileRead, VaultListing } from "../backend";
import { vault } from "./vault";

const backend = vi.hoisted(() => ({
  listVault: vi.fn<() => Promise<VaultListing>>(),
  readVaultFiles: vi.fn<(paths: string[]) => Promise<VaultFileRead[]>>(),
}));
vi.mock("../backend", () => backend);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const listing = (files: [string, string][]): VaultListing => ({
  files: files.map(([path, content]) => ({ path, rel: path.slice(3), content })),
  dirs: [],
  skipped: [],
});

describe("vault reload ordering", () => {
  beforeEach(async () => {
    vault.switchTo("/v");
    backend.listVault.mockResolvedValueOnce(listing([["/v/a.md", "- [ ] A"]]));
    await vault.load("/v");
  });

  it("keeps a write that succeeded after a stale listing was read", async () => {
    const stale = deferred<VaultListing>();
    backend.listVault.mockReturnValueOnce(stale.promise);
    const loading = vault.load("/v");
    // In-app toggle: indexed before the listing returns, written to disk, buffer released.
    vault.setContent("/v/a.md", "- [x] A");
    vault.touch("/v/a.md");
    stale.resolve(listing([["/v/a.md", "- [ ] A"]]));
    await loading;
    expect(vault.get().files.get("/v/a.md")?.content).toBe("- [x] A");
  });

  it("keeps a write that lands while the listing is in flight, even when its text was indexed earlier", async () => {
    vault.setContent("/v/a.md", "- [x] A");
    const stale = deferred<VaultListing>();
    backend.listVault.mockReturnValueOnce(stale.promise);
    const loading = vault.load("/v");
    // The write itself lands while the listing is in flight.
    vault.touch("/v/a.md");
    stale.resolve(listing([["/v/a.md", "- [ ] A"]]));
    await loading;
    expect(vault.get().files.get("/v/a.md")?.content).toBe("- [x] A");
  });

  it("does not forget a change newer than a full load for an in-flight refresh", async () => {
    const list = deferred<VaultListing>();
    backend.listVault.mockReturnValueOnce(list.promise);
    const loading = vault.load("/v");
    const read = deferred<VaultFileRead[]>();
    backend.readVaultFiles.mockReturnValueOnce(read.promise);
    const refreshing = vault.refresh("/v", ["/v/a.md"]);
    vault.setContent("/v/a.md", "- [x] A");
    list.resolve(listing([["/v/a.md", "- [ ] A"]]));
    await loading;
    read.resolve([{ path: "/v/a.md", rel: "a.md", content: "- [ ] A", skipped: null }]);
    await refreshing;
    expect(vault.get().files.get("/v/a.md")?.content).toBe("- [x] A");
  });

  it("reports a file that became unreadable in a partial refresh", async () => {
    backend.readVaultFiles.mockResolvedValueOnce([{ path: "/v/a.md", rel: "a.md", content: null, skipped: "not UTF-8" }]);
    await vault.refresh("/v", ["/v/a.md"]);
    expect(vault.get().files.has("/v/a.md")).toBe(false);
    expect(vault.get().skipped).toEqual([{ rel: "a.md", reason: "not UTF-8" }]);
  });
});
