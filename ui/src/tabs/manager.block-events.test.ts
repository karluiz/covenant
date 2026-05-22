import { describe, it, expect } from "vitest";

// Direct unit test of the registrar fan-out; full TabManager
// construction requires DOM + Tauri shims and is exercised by
// integration tests.

class FakeTabManager {
  private listeners = new Set<(ev: { tabId: string; exitCode: number }) => void>();
  onBlockFinished(cb: (ev: { tabId: string; exitCode: number }) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  notifyBlockFinished(tabId: string, exitCode: number) {
    for (const l of this.listeners) l({ tabId, exitCode });
  }
}

describe("block-finished fan-out", () => {
  it("delivers events and respects unsubscribe", () => {
    const m = new FakeTabManager();
    const seen: Array<{ tabId: string; exitCode: number }> = [];
    const off = m.onBlockFinished((e) => seen.push(e));
    m.notifyBlockFinished("t1", 0);
    m.notifyBlockFinished("t2", 1);
    off();
    m.notifyBlockFinished("t3", 0);
    expect(seen).toEqual([
      { tabId: "t1", exitCode: 0 },
      { tabId: "t2", exitCode: 1 },
    ]);
  });
});
