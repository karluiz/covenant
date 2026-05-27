import { describe, expect, it, vi } from "vitest";
import { splitPaneAction } from "./split-actions";
import type { Tab, Pane } from "./pane";

const makePane = (id: string, cwd = "/repo"): Pane => ({
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
  replayKey: "",
});

const makeSingleTab = (id: string): Tab => ({
  id,
  panes: [makePane("p0")],
  layout: { kind: "single", activePaneIdx: 0 },
} as unknown as Tab);

describe("splitPaneAction", () => {
  it("creates a new pane inheriting source cwd", async () => {
    const tab = makeSingleTab("t1");
    const ctx = {
      spawnSession: vi.fn().mockResolvedValue("s-new"),
      mountPaneInDom: vi.fn(),
      focusPane: vi.fn(),
    };
    await splitPaneAction(tab, "horizontal", 0, ctx);
    // After the split, panes is [Pane, Pane]. Cast to access index 1.
    const panes = tab.panes as [Pane, Pane];
    expect(panes.length).toBe(2);
    expect(panes[1].cwd).toBe("/repo");
    expect(panes[1].kind).toBe("terminal");
    expect(tab.layout.kind).toBe("split");
    expect(tab.layout.orientation).toBe("horizontal");
    expect(tab.layout.ratio).toBe(0.5);
    expect(tab.layout.activePaneIdx).toBe(1);
    expect(ctx.spawnSession).toHaveBeenCalledWith("/repo");
    expect(ctx.mountPaneInDom).toHaveBeenCalled();
    expect(ctx.focusPane).toHaveBeenCalled();
  });

  it("refuses to split when tab is already split", async () => {
    const tab = makeSingleTab("t1");
    (tab.panes as Pane[]).push(makePane("p1"));
    tab.layout = { kind: "split", orientation: "horizontal", activePaneIdx: 0, ratio: 0.5 };
    const ctx = {
      spawnSession: vi.fn(),
      mountPaneInDom: vi.fn(),
      focusPane: vi.fn(),
    };
    await expect(splitPaneAction(tab, "horizontal", 0, ctx)).rejects.toThrow(/already split/);
    expect(ctx.spawnSession).not.toHaveBeenCalled();
  });
});
