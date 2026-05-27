import { describe, expect, it } from "vitest";
import {
  activePane,
  assertLayoutValid,
  collapseToSingle,
  type Pane,
  type Tab,
} from "./pane";

const pane = (id: string, cwd = "/"): Pane => ({
  id,
  kind: "terminal",
  sessionId: null,
  cwd,
  mission: null,
  operator: null,
  blocks: [],
  xterm: null,
  piView: null,
});

const singleTab = (id: string): Tab => ({
  id,
  panes: [pane("p0")],
  layout: { kind: "single", activePaneIdx: 0 },
});

const splitTab = (id: string): Tab => ({
  id,
  panes: [pane("p0"), pane("p1")],
  layout: { kind: "split", orientation: "horizontal", activePaneIdx: 0, ratio: 0.5 },
});

describe("activePane", () => {
  it("returns pane 0 of a single tab", () => {
    const t = singleTab("t1");
    expect(activePane(t).id).toBe("p0");
  });

  it("returns the indexed pane of a split tab", () => {
    const t = splitTab("t1");
    t.layout.activePaneIdx = 1;
    expect(activePane(t).id).toBe("p1");
  });
});

describe("assertLayoutValid", () => {
  it("accepts a valid single tab", () => {
    expect(() => assertLayoutValid(singleTab("t1"))).not.toThrow();
  });

  it("accepts a valid split tab", () => {
    expect(() => assertLayoutValid(splitTab("t1"))).not.toThrow();
  });

  it("rejects single + 2 panes", () => {
    const t = singleTab("t1");
    (t.panes as Pane[]).push(pane("p1"));
    expect(() => assertLayoutValid(t)).toThrow(/single.*1 pane/);
  });

  it("rejects split + 1 pane", () => {
    const t = splitTab("t1");
    (t.panes as Pane[]).pop();
    expect(() => assertLayoutValid(t)).toThrow(/split.*2 panes/);
  });

  it("rejects split with no orientation", () => {
    const t = splitTab("t1");
    delete t.layout.orientation;
    expect(() => assertLayoutValid(t)).toThrow(/orientation/);
  });

  it("rejects activePaneIdx out of range", () => {
    const t = splitTab("t1");
    t.layout.activePaneIdx = 2 as 0 | 1;
    expect(() => assertLayoutValid(t)).toThrow(/activePaneIdx/);
  });
});

describe("collapseToSingle", () => {
  it("drops pane[1] and keeps pane[0]", () => {
    const t = splitTab("t1");
    collapseToSingle(t, 1);
    expect(t.panes.length).toBe(1);
    expect(t.panes[0].id).toBe("p0");
    expect(t.layout.kind).toBe("single");
    expect(t.layout.activePaneIdx).toBe(0);
  });

  it("drops pane[0] and slides pane[1] to index 0", () => {
    const t = splitTab("t1");
    collapseToSingle(t, 0);
    expect(t.panes.length).toBe(1);
    expect(t.panes[0].id).toBe("p1");
    expect(t.layout.kind).toBe("single");
    expect(t.layout.activePaneIdx).toBe(0);
  });

  it("clears orientation and ratio on collapse", () => {
    const t = splitTab("t1");
    collapseToSingle(t, 1);
    expect(t.layout.orientation).toBeUndefined();
    expect(t.layout.ratio).toBeUndefined();
  });
});
