import { describe, expect, it } from "vitest";
import {
  computeActivationRefit,
  pickPaintedPaneId,
  shouldRoNudge,
} from "../manager";

// Tab activation used to repaint visibly several frames AFTER the pane was
// already on screen (stale canvas → fit → unconditional resize-nudge →
// scrollToBottom), which users saw as flicker / a jump on every tab switch.
// The fix routes those decisions through the pure helpers below; the manager
// wires them into activate() and the per-tab ResizeObserver.

describe("computeActivationRefit", () => {
  const atBottom = { viewportY: 10, baseY: 10 };

  it("skips the resize nudge when nothing was written while hidden", () => {
    const plan = computeActivationRefit({ wroteWhileHidden: false, rows: 40, ...atBottom });
    expect(plan.nudge).toBe(false);
  });

  it("nudges when data arrived while the pane was display:none", () => {
    const plan = computeActivationRefit({ wroteWhileHidden: true, rows: 40, ...atBottom });
    expect(plan.nudge).toBe(true);
  });

  it("never nudges a 1-row terminal (resize to 0 rows is invalid)", () => {
    const plan = computeActivationRefit({ wroteWhileHidden: true, rows: 1, ...atBottom });
    expect(plan.nudge).toBe(false);
  });

  it("restores bottom pin when the viewport was at the bottom", () => {
    const plan = computeActivationRefit({ wroteWhileHidden: false, rows: 40, viewportY: 10, baseY: 10 });
    expect(plan.scrollToBottom).toBe(true);
  });

  it("preserves the user's scroll position when scrolled up", () => {
    const plan = computeActivationRefit({ wroteWhileHidden: false, rows: 40, viewportY: 3, baseY: 10 });
    expect(plan.scrollToBottom).toBe(false);
  });
});

describe("shouldRoNudge", () => {
  it("skips the nudge on the reveal transition (host was 0x0)", () => {
    expect(shouldRoNudge({ revealing: true, dimsChanged: false, rows: 40 })).toBe(false);
  });

  it("nudges on sub-cell drift while visible (same dims after fit)", () => {
    expect(shouldRoNudge({ revealing: false, dimsChanged: false, rows: 40 })).toBe(true);
  });

  it("skips the nudge when fit already resized (resize re-syncs the scroll area)", () => {
    expect(shouldRoNudge({ revealing: false, dimsChanged: true, rows: 40 })).toBe(false);
  });

  it("never nudges a 1-row terminal", () => {
    expect(shouldRoNudge({ revealing: false, dimsChanged: false, rows: 1 })).toBe(false);
  });
});

describe("pickPaintedPaneId", () => {
  it("returns the pane currently painted on screen", () => {
    const id = pickPaintedPaneId(
      [
        { id: "a", hidden: false, visibility: "" },
        { id: "b", hidden: true, visibility: "" },
      ],
      "b",
    );
    expect(id).toBe("a");
  });

  it("excludes the activation target itself", () => {
    const id = pickPaintedPaneId([{ id: "a", hidden: false, visibility: "" }], "a");
    expect(id).toBeNull();
  });

  it("skips panes prepared invisibly (visibility:hidden mid-switch)", () => {
    const id = pickPaintedPaneId(
      [
        { id: "a", hidden: false, visibility: "hidden" },
        { id: "b", hidden: true, visibility: "" },
      ],
      "b",
    );
    expect(id).toBeNull();
  });

  it("returns null when every pane is hidden", () => {
    const id = pickPaintedPaneId(
      [
        { id: "a", hidden: true, visibility: "" },
        { id: "b", hidden: true, visibility: "" },
      ],
      "b",
    );
    expect(id).toBeNull();
  });
});
