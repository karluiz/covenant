import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chunkForTermWrite,
  computeActivationRefit,
  HiddenOutputBatch,
  HIDDEN_OUTPUT_BATCH_DELAY_MS,
  pickPaintedPaneId,
  planHiddenTabResizes,
  shouldRoNudge,
  TERM_WRITE_CHUNK_BYTES,
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

  it("caps a large merged flush into parse-safe segments, order preserved", () => {
    // xterm parses each write() chunk atomically — a starved batch timer can
    // accumulate a multi-MB merge that would become one unbreakable
    // main-thread parse task at activation-time flush.
    vi.useFakeTimers();
    const writes: Uint8Array[] = [];
    const batch = new HiddenOutputBatch((data) => writes.push(data));

    const half = new Uint8Array(TERM_WRITE_CHUNK_BYTES).fill(1);
    const third = new Uint8Array(Math.ceil(TERM_WRITE_CHUNK_BYTES / 3)).fill(2);
    batch.enqueue(half);
    batch.enqueue(third);
    batch.flush();

    expect(writes.length).toBeGreaterThan(1);
    for (const w of writes) expect(w.byteLength).toBeLessThanOrEqual(TERM_WRITE_CHUNK_BYTES);
    const total = writes.reduce((n, w) => n + w.byteLength, 0);
    expect(total).toBe(half.byteLength + third.byteLength);
    const joined = new Uint8Array(total);
    let off = 0;
    for (const w of writes) {
      joined.set(w, off);
      off += w.byteLength;
    }
    expect(joined[0]).toBe(1);
    expect(joined[half.byteLength]).toBe(2);
    expect(joined[total - 1]).toBe(2);
  });

  it("splits even a single oversized chunk", () => {
    vi.useFakeTimers();
    const writes: Uint8Array[] = [];
    const batch = new HiddenOutputBatch((data) => writes.push(data));

    batch.enqueue(new Uint8Array(TERM_WRITE_CHUNK_BYTES * 2 + 5).fill(9));
    batch.flush();

    expect(writes.map((w) => w.byteLength)).toEqual([
      TERM_WRITE_CHUNK_BYTES,
      TERM_WRITE_CHUNK_BYTES,
      5,
    ]);
  });
});

describe("chunkForTermWrite", () => {
  it("returns the original view untouched when it fits the cap", () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(chunkForTermWrite(data)).toEqual([data]);
  });

  it("slices an oversized buffer into cap-sized views, no bytes lost", () => {
    const data = new Uint8Array(TERM_WRITE_CHUNK_BYTES * 2 + 7);
    data[0] = 11;
    data[TERM_WRITE_CHUNK_BYTES] = 22;
    data[data.length - 1] = 33;
    const chunks = chunkForTermWrite(data);
    expect(chunks.map((c) => c.byteLength)).toEqual([
      TERM_WRITE_CHUNK_BYTES,
      TERM_WRITE_CHUNK_BYTES,
      7,
    ]);
    expect(chunks[0][0]).toBe(11);
    expect(chunks[1][0]).toBe(22);
    expect(chunks[2][6]).toBe(33);
  });

  it("returns nothing for an empty buffer", () => {
    expect(chunkForTermWrite(new Uint8Array(0))).toEqual([]);
  });
});

describe("planHiddenTabResizes", () => {
  const active = { cols: 220, rows: 60 };
  const base = {
    kind: "shell",
    hidden: true,
    split: false,
    editorVisible: false,
    hasTerm: true,
    cols: 80,
    rows: 24,
  };

  it("targets hidden single-pane shell tabs with stale dims", () => {
    expect(planHiddenTabResizes([{ id: "a", ...base }], active)).toEqual(["a"]);
  });

  it("skips tabs already at the active grid", () => {
    expect(
      planHiddenTabResizes([{ id: "a", ...base, cols: 220, rows: 60 }], active),
    ).toEqual([]);
  });

  it("skips visible tabs, splits, editor drawers, and non-shell tabs", () => {
    expect(
      planHiddenTabResizes(
        [
          { id: "visible", ...base, hidden: false },
          { id: "split", ...base, split: true },
          { id: "editor", ...base, editorVisible: true },
          { id: "acp", ...base, kind: "acp" },
          { id: "no-term", ...base, hasTerm: false },
        ],
        active,
      ),
    ).toEqual([]);
  });

  it("no-ops when the active grid is degenerate", () => {
    expect(planHiddenTabResizes([{ id: "a", ...base }], { cols: 0, rows: 0 })).toEqual([]);
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
