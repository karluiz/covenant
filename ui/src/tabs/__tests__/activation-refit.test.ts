import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeActivationRefit,
  HiddenOutputBatch,
  HIDDEN_OUTPUT_BATCH_DELAY_MS,
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

describe("HiddenOutputBatch", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces hidden PTY chunks into one ordered terminal write", () => {
    vi.useFakeTimers();
    const writes: Uint8Array[] = [];
    const batch = new HiddenOutputBatch((data) => writes.push(data));

    batch.enqueue(new Uint8Array([1, 2]));
    batch.enqueue(new Uint8Array([3]));
    expect(writes).toEqual([]);

    vi.advanceTimersByTime(HIDDEN_OUTPUT_BATCH_DELAY_MS);
    expect(writes).toHaveLength(1);
    expect([...writes[0]]).toEqual([1, 2, 3]);
  });

  it("flushes a pending hidden batch before a tab becomes active", () => {
    vi.useFakeTimers();
    const writes: Uint8Array[] = [];
    const batch = new HiddenOutputBatch((data) => writes.push(data));

    batch.enqueue(new Uint8Array([7]));
    batch.flush();
    vi.advanceTimersByTime(HIDDEN_OUTPUT_BATCH_DELAY_MS);

    expect(writes).toHaveLength(1);
    expect([...writes[0]]).toEqual([7]);
  });
});

describe("shouldRoNudge", () => {
  it("skips the nudge on an activation-owned reveal (host was 0x0, nothing pending)", () => {
    expect(shouldRoNudge({ revealing: true, dimsChanged: false, rows: 40, wroteWhileHidden: false })).toBe(false);
  });

  it("nudges on a reveal that activate() never handled (bytes still pending)", () => {
    // A pane can be revealed without going through activate() — e.g. its
    // host regains size after an ancestor was display:none. If data arrived
    // while it was unmeasurable, the scroll area is stale and the user
    // can't scroll to the bottom until the nudge re-syncs it.
    expect(shouldRoNudge({ revealing: true, dimsChanged: false, rows: 40, wroteWhileHidden: true })).toBe(true);
  });

  it("nudges on sub-cell drift while visible (same dims after fit)", () => {
    expect(shouldRoNudge({ revealing: false, dimsChanged: false, rows: 40, wroteWhileHidden: false })).toBe(true);
  });

  it("skips the nudge when fit already resized (resize re-syncs the scroll area)", () => {
    expect(shouldRoNudge({ revealing: false, dimsChanged: true, rows: 40, wroteWhileHidden: false })).toBe(false);
  });

  it("never nudges a 1-row terminal", () => {
    expect(shouldRoNudge({ revealing: true, dimsChanged: false, rows: 1, wroteWhileHidden: true })).toBe(false);
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
