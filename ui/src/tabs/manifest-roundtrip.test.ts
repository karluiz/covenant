import { describe, expect, it } from "vitest";
import { serializeTab, liftLegacyTab } from "./manager";
import type { Pane } from "./pane";

const pane = (id: string, cwd: string): Pane => ({
  id,
  kind: "terminal",
  sessionId: `s-${id}`,
  cwd,
  mission: null,
  operator: null,
  blocks: [],
  xterm: null,
  piView: null,
  el: null,
  executor: null,
  operatorEnabled: false,
  operatorLive: false,
  aomExcluded: false,
  observer_ids: [],
  spawn_id: null,
  idleAgent: null,
  busyProc: null,
  replayKey: `rk-${id}`,
});

describe("serializeTab", () => {
  it("serializes a single-pane shell tab", () => {
    const tab = {
      id: "t1",
      kind: "shell" as const,
      customName: null,
      color: null,
      groupId: null,
      panes: [pane("p0", "/a")] as [Pane],
      layout: { kind: "single" as const, activePaneIdx: 0 as const },
    };
    const s = serializeTab(tab);
    expect(s.panes).toHaveLength(1);
    expect(s.panes![0].cwd).toBe("/a");
    expect(s.panes![0].kind).toBe("terminal");
    expect(s.layout).toEqual({
      kind: "single",
      orientation: undefined,
      active: 0,
      ratio: undefined,
    });
  });

  it("serializes a split tab with orientation + ratio", () => {
    const tab = {
      id: "t1",
      kind: "shell" as const,
      customName: null,
      color: null,
      groupId: null,
      panes: [pane("p0", "/a"), pane("p1", "/b")] as [Pane, Pane],
      layout: {
        kind: "split" as const,
        orientation: "horizontal" as const,
        activePaneIdx: 1 as const,
        ratio: 0.6,
      },
    };
    const s = serializeTab(tab);
    expect(s.panes).toHaveLength(2);
    expect(s.panes![1].cwd).toBe("/b");
    expect(s.layout?.kind).toBe("split");
    expect(s.layout?.orientation).toBe("horizontal");
    expect(s.layout?.active).toBe(1);
    expect(s.layout?.ratio).toBe(0.6);
  });

  it("roundtrip: serialize → liftLegacyTab returns the same shape", () => {
    const tab = {
      id: "t1",
      kind: "shell" as const,
      customName: "tests",
      color: null,
      groupId: null,
      panes: [pane("p0", "/repo")] as [Pane],
      layout: { kind: "single" as const, activePaneIdx: 0 as const },
    };
    const s = serializeTab(tab);
    const lifted = liftLegacyTab(s);
    // Already has panes + layout → liftLegacyTab must return the same reference.
    expect(lifted).toBe(s);
    expect(lifted.panes![0].cwd).toBe("/repo");
  });
});
