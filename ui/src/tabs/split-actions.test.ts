import { describe, expect, it, vi } from "vitest";
import {
  splitPaneAction,
  closePaneAction,
  focusPaneAction,
  swapPanesAction,
  setPaneOrientationAction,
  setPaneRatioAction,
} from "./split-actions";
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

const makeSplitTab = (id: string): Tab => {
  const t = makeSingleTab(id);
  (t.panes as Pane[]).push(makePane("p1"));
  t.layout = { kind: "split", orientation: "horizontal", activePaneIdx: 0, ratio: 0.5 };
  return t;
};

describe("closePaneAction", () => {
  it("collapses split → single, drops the right pane", async () => {
    const tab = makeSingleTab("t1");
    (tab.panes as Pane[]).push(makePane("p1"));
    tab.layout = { kind: "split", orientation: "horizontal", activePaneIdx: 1, ratio: 0.5 };
    const ctx = {
      killSession: vi.fn().mockResolvedValue(undefined),
      unmountPaneFromDom: vi.fn(),
      focusPane: vi.fn(),
    };
    const result = await closePaneAction(tab, 1, ctx);
    expect(result).toBe("collapsed");
    expect(tab.panes.length).toBe(1);
    expect(tab.panes[0].id).toBe("p0");
    expect(tab.layout.kind).toBe("single");
    expect(tab.layout.activePaneIdx).toBe(0);
    expect(ctx.killSession).toHaveBeenCalledWith("s-p1");
    expect(ctx.unmountPaneFromDom).toHaveBeenCalledWith(tab, 1);
    expect(ctx.focusPane).toHaveBeenCalledWith(tab, 0);
  });

  it("closing pane 0 keeps pane 1, slides it to index 0", async () => {
    const tab = makeSingleTab("t1");
    (tab.panes as Pane[]).push(makePane("p1"));
    tab.layout = { kind: "split", orientation: "horizontal", activePaneIdx: 0, ratio: 0.5 };
    const ctx = {
      killSession: vi.fn().mockResolvedValue(undefined),
      unmountPaneFromDom: vi.fn(),
      focusPane: vi.fn(),
    };
    const result = await closePaneAction(tab, 0, ctx);
    expect(result).toBe("collapsed");
    expect(tab.panes.length).toBe(1);
    expect(tab.panes[0].id).toBe("p1");
    expect(ctx.killSession).toHaveBeenCalledWith("s-p0");
  });

  it("returns 'close-tab' when called on a single-pane tab", async () => {
    const tab = makeSingleTab("t1");
    const ctx = {
      killSession: vi.fn(),
      unmountPaneFromDom: vi.fn(),
      focusPane: vi.fn(),
    };
    const result = await closePaneAction(tab, 0, ctx);
    expect(result).toBe("close-tab");
    expect(ctx.killSession).not.toHaveBeenCalled();
    expect(ctx.unmountPaneFromDom).not.toHaveBeenCalled();
  });
});

describe("focusPaneAction", () => {
  it("updates activePaneIdx and calls the DOM focus", () => {
    const tab = makeSplitTab("t1");
    const ctx = { focusInDom: vi.fn() };
    focusPaneAction(tab, 1, ctx);
    expect(tab.layout.activePaneIdx).toBe(1);
    expect(ctx.focusInDom).toHaveBeenCalledWith(tab, 1);
  });

  it("no-op on a single-pane tab even if idx=0", () => {
    const tab = makeSingleTab("t1");
    const ctx = { focusInDom: vi.fn() };
    focusPaneAction(tab, 0, ctx);
    expect(tab.layout.activePaneIdx).toBe(0);
    expect(ctx.focusInDom).toHaveBeenCalledWith(tab, 0);
  });
});

describe("swapPanesAction", () => {
  it("swaps panes, inverts ratio, keeps the visually-active half in place", () => {
    const tab = makeSplitTab("t1");
    tab.layout.ratio = 0.7;
    tab.layout.activePaneIdx = 0;
    const ctx = { remountSplit: vi.fn() };
    swapPanesAction(tab, ctx);
    expect(tab.panes[0]!.id).toBe("p1");
    expect(tab.panes[1]!.id).toBe("p0");
    expect(tab.layout.activePaneIdx).toBe(1); // followed the original active
    expect(tab.layout.ratio).toBeCloseTo(0.3); // 1 - 0.7
    expect(ctx.remountSplit).toHaveBeenCalled();
  });

  it("no-op on single-pane tab", () => {
    const tab = makeSingleTab("t1");
    const ctx = { remountSplit: vi.fn() };
    swapPanesAction(tab, ctx);
    expect(tab.panes.length).toBe(1);
    expect(ctx.remountSplit).not.toHaveBeenCalled();
  });
});

describe("setPaneOrientationAction", () => {
  it("flips orientation, keeps panes + ratio", () => {
    const tab = makeSplitTab("t1");
    tab.layout.ratio = 0.6;
    const ctx = { remountSplit: vi.fn() };
    setPaneOrientationAction(tab, "vertical", ctx);
    expect(tab.layout.orientation).toBe("vertical");
    expect(tab.layout.ratio).toBe(0.6);
    expect(ctx.remountSplit).toHaveBeenCalled();
  });

  it("no-op on single-pane tab", () => {
    const tab = makeSingleTab("t1");
    const ctx = { remountSplit: vi.fn() };
    setPaneOrientationAction(tab, "vertical", ctx);
    expect(tab.layout.kind).toBe("single");
    expect(ctx.remountSplit).not.toHaveBeenCalled();
  });
});

describe("setPaneRatioAction", () => {
  it("clamps ratio to [0.1, 0.9]", () => {
    const tab = makeSplitTab("t1");
    setPaneRatioAction(tab, 0.05);
    expect(tab.layout.ratio).toBe(0.1);
    setPaneRatioAction(tab, 0.95);
    expect(tab.layout.ratio).toBe(0.9);
    setPaneRatioAction(tab, 0.42);
    expect(tab.layout.ratio).toBe(0.42);
  });
});
