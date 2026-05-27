import { describe, expect, it } from "vitest";
import { serializeTab, liftLegacyTab } from "./manager";
import type { Pane, TabLayout } from "./pane";

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

// Minimal tab factory — mirrors the shape serializeTab expects.
const makeTab = (
  id: string,
  panes: Pane[],
  layout: TabLayout,
  opts: { customName?: string | null; color?: string | null; groupId?: string | null; kind?: "shell" | "pi" } = {},
) => ({
  id,
  kind: opts.kind ?? ("shell" as const),
  customName: opts.customName ?? null,
  color: opts.color ?? null,
  groupId: opts.groupId ?? null,
  panes: panes as [Pane] | [Pane, Pane],
  layout,
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

describe("serializeTab → liftLegacyTab roundtrip for split tabs", () => {
  it("split tab survives roundtrip with both panes' data intact", () => {
    const p0: Pane = {
      ...pane("p0", "/repo-a"),
      mission: { kind: "spec", path: "docs/specs/foo.md" } as any,
      operator: "claude",
      observer_ids: ["codex"],
      spawn_id: "spawn-1",
      aomExcluded: true,
      replayKey: "rk-p0",
    };
    const p1: Pane = { ...pane("p1", "/repo-b"), operator: "copilot", replayKey: "rk-p1" };

    const tab = makeTab(
      "t1",
      [p0, p1],
      { kind: "split", orientation: "vertical", activePaneIdx: 1, ratio: 0.7 },
      { customName: "split-tab", color: "#abc", groupId: "g1" },
    );

    const s = serializeTab(tab);
    const lifted = liftLegacyTab(s);

    expect(lifted.panes).toHaveLength(2);
    // Pane 0
    expect(lifted.panes![0].cwd).toBe("/repo-a");
    expect(lifted.panes![0].mission_path).toBe("docs/specs/foo.md");
    expect(lifted.panes![0].operator_id).toBe("claude");
    expect(lifted.panes![0].observer_ids).toEqual(["codex"]);
    expect(lifted.panes![0].spawn_id).toBe("spawn-1");
    expect(lifted.panes![0].aom_excluded).toBe(true);
    expect(lifted.panes![0].replay_key).toBe("rk-p0");
    // Pane 1
    expect(lifted.panes![1].cwd).toBe("/repo-b");
    expect(lifted.panes![1].operator_id).toBe("copilot");
    expect(lifted.panes![1].replay_key).toBe("rk-p1");
    // Layout
    expect(lifted.layout).toEqual({
      kind: "split",
      orientation: "vertical",
      active: 1,
      ratio: 0.7,
    });
  });

  it("single-pane and split-pane tabs both lift cleanly", () => {
    // Single-pane tab
    const s1 = serializeTab(
      makeTab("t1", [pane("p0", "/a")], { kind: "single", activePaneIdx: 0 }),
    );
    expect(s1.layout).toEqual({ kind: "single", orientation: undefined, active: 0, ratio: undefined });
    expect(s1.panes).toHaveLength(1);

    // Split tab
    const s2 = serializeTab(
      makeTab(
        "t1",
        [pane("p0", "/a"), pane("p1", "/b")],
        { kind: "split", orientation: "horizontal", activePaneIdx: 0, ratio: 0.5 },
      ),
    );
    expect(s2.panes).toHaveLength(2);
    expect(s2.layout!.kind).toBe("split");

    // Both shapes lift cleanly
    expect(liftLegacyTab(s1).panes).toHaveLength(1);
    expect(liftLegacyTab(s2).panes).toHaveLength(2);
  });

  it("Pi pane kind round-trip — first pane kind: pi serializes top-level kind: pi", () => {
    const piPane: Pane = { ...pane("p0", "/notes"), kind: "pi" };
    const tab = makeTab(
      "t1",
      [piPane],
      { kind: "single", activePaneIdx: 0 },
      { kind: "pi" },
    );
    const s = serializeTab(tab);
    expect(s.kind).toBe("pi");
    expect(s.panes![0].kind).toBe("pi");
  });
});
