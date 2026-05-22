import { describe, it, expect } from "vitest";
import { LivePool, type PoolableTabManager, type TabManagerFactory } from "./live-pool";

class FakeManager implements PoolableTabManager {
  static disposed: string[] = [];
  constructor(public id: string) {}
  attached = false;
  scrollback = new Map<string, string>([["t0", `snap-${this.id}`]]);
  private blockListeners = new Set<(ev: { tabId: string; exitCode: number }) => void>();
  detach() { this.attached = false; }
  attach() { this.attached = true; }
  async dispose() { FakeManager.disposed.push(this.id); }
  serializeScrollback() { return new Map(this.scrollback); }
  restoreScrollback(s: Map<string, string>) { this.scrollback = new Map(s); }
  serializeManifest() { return { version: 1, tabs: [], groups: [], active_index: 0 }; }
  async replaceFromManifest() { /* no-op */ }
  onBlockFinished(cb: (ev: { tabId: string; exitCode: number }) => void) {
    this.blockListeners.add(cb);
    return () => { this.blockListeners.delete(cb); };
  }
  emitBlock(exitCode: number) {
    for (const l of this.blockListeners) l({ tabId: "t0", exitCode });
  }
}

function fakeFactory(): TabManagerFactory & { created: FakeManager[] } {
  const created: FakeManager[] = [];
  return {
    created,
    create(id) { const m = new FakeManager(id); created.push(m); return m; },
    hosts() {
      return { tabbar: document.createElement("div"), workspace: document.createElement("div") };
    },
  };
}

describe("LivePool", () => {
  it("activate creates and tracks a new live workspace", async () => {
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 3 });
    await pool.activate("a", {});
    expect(pool.isLive("a")).toBe(true);
    expect(pool.size).toBe(1);
  });

  it("switching does not dispose the previous workspace", async () => {
    FakeManager.disposed = [];
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 3 });
    await pool.activate("a", {});
    await pool.activate("b", {});
    expect(pool.isLive("a")).toBe(true);
    expect(pool.isLive("b")).toBe(true);
    expect(FakeManager.disposed).toEqual([]);
  });

  it("hibernates LRU when exceeding limit", async () => {
    FakeManager.disposed = [];
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 2 });
    await pool.activate("a", {});
    await pool.activate("b", {});
    await pool.activate("c", {});
    expect(pool.isHibernated("a")).toBe(true);
    expect(pool.isLive("a")).toBe(false);
    expect(FakeManager.disposed).toEqual(["a"]);
  });

  it("rehydrates hibernated scrollback on re-activate", async () => {
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 2 });
    await pool.activate("a", {});
    const aFirst = f.created[0];
    aFirst.scrollback = new Map([["t0", "saved-content"]]);
    await pool.activate("b", {});
    await pool.activate("c", {}); // evicts a
    await pool.activate("a", {}); // rehydrate
    const aSecond = f.created.find((m) => m.id === "a" && m !== aFirst);
    expect(aSecond?.scrollback.get("t0")).toBe("saved-content");
  });

  it("activity tracker accumulates only while inactive", async () => {
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 3 });
    await pool.activate("a", {});
    await pool.activate("b", {});
    const a = f.created.find((m) => m.id === "a")!;
    a.emitBlock(0);
    a.emitBlock(1);
    expect(pool.activityOf("a")).toEqual({ unseenBlocks: 2, hasFailure: true, hasAgentNote: false });
    await pool.activate("a", {});
    expect(pool.activityOf("a")).toEqual({ unseenBlocks: 0, hasFailure: false, hasAgentNote: false });
  });

  it("hibernate refuses to evict the active workspace", async () => {
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 5 });
    await pool.activate("a", {});
    await expect(pool.hibernate("a")).rejects.toThrow();
  });

  it("setLimit lower hibernates down to the new bound", async () => {
    FakeManager.disposed = [];
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 5 });
    await pool.activate("a", {});
    await pool.activate("b", {});
    await pool.activate("c", {});
    await pool.activate("d", {});
    await pool.setLimit(2);
    expect(pool.isHibernated("a")).toBe(true);
    expect(pool.isHibernated("b")).toBe(true);
    expect(pool.isLive("c")).toBe(true);
    expect(pool.isLive("d")).toBe(true);
  });

  it("forget removes from both pools and clears active", async () => {
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 3 });
    await pool.activate("a", {});
    await pool.forget("a");
    expect(pool.isLive("a")).toBe(false);
    expect(pool.isHibernated("a")).toBe(false);
  });

  it("setLimit clamps to [1, 20]", async () => {
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 5 });
    await pool.setLimit(0);
    await pool.activate("a", {});
    await pool.activate("b", {});
    expect(pool.isHibernated("a")).toBe(true);
  });
});
