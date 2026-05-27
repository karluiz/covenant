// ui/src/tabs/pane-splitter.ts
//
// Reusable drag helper for the .pane-splitter element.
// Mirrors the editor splitter drag pattern at blocks/manager.ts but is
// parameterized by orientation and callback so it can be used in any
// split-pane context.

import type { SplitOrientation } from "./pane";

export interface PaneSplitterOpts {
  /** The .pane-splitter element (the draggable strip) */
  splitter: HTMLElement;
  /** The .terminal-block parent element (the grid container) */
  block: HTMLElement;
  orientation: SplitOrientation;
  /** Called during drag with the live ratio (0–1). Update CSS variable here. */
  onRatio: (ratio: number) => void;
  /** Called once on pointerup with the final committed ratio. Persist here. */
  onCommit: (ratio: number) => void;
}

/**
 * Install pointer-drag handlers on a pane splitter. Returns a dispose
 * function. Mirrors the editor splitter drag pattern at manager.ts:2177.
 *
 * Key behaviors:
 * - PointerCapture for smooth tracking across pane boundaries
 * - RAF debounce so a pointermove storm doesn't thrash layout
 * - Disable text selection + show resize cursor globally during drag
 * - pane-splitter-dragging class on block disables pointer-events on pane
 *   children so xterm/editor doesn't intercept the drag
 * - Ratio clamped to [0.1, 0.9] (matches setPaneRatioAction)
 * - Cleanup on pointerup or pointercancel
 */
export function installPaneSplitter(opts: PaneSplitterOpts): () => void {
  const { splitter, block, orientation, onRatio, onCommit } = opts;

  const onPointerDown = (e: PointerEvent) => {
    e.preventDefault();

    const startX = e.clientX;
    const startY = e.clientY;
    const total =
      orientation === "horizontal" ? block.offsetWidth : block.offsetHeight;

    // Read the current ratio from the CSS custom property; fall back to 0.5
    // if the variable is not set (e.g. first drag before any persist).
    const startRatio =
      parseFloat(
        getComputedStyle(block).getPropertyValue("--pane-ratio"),
      ) || 0.5;

    // Lock global cursor and text selection for the duration of the drag.
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor =
      orientation === "horizontal" ? "col-resize" : "row-resize";

    // This class lets CSS disable pointer-events on pane children (xterm,
    // editors) so they don't capture pointer events during the drag.
    block.classList.add("pane-splitter-dragging");

    try {
      splitter.setPointerCapture(e.pointerId);
    } catch {
      // Pointer capture not supported in all environments (e.g. jsdom in tests).
      // The cursor lock + dragging class are the fallback.
    }

    // RAF debounce: accumulate the latest pointer position and flush once per
    // animation frame. This keeps layout updates throttled to 60 fps even if
    // pointermove fires at a higher rate.
    let pending: number | null = null;
    let rafScheduled = false;
    let lastRatio = startRatio;

    const flush = () => {
      rafScheduled = false;
      if (pending === null) return;
      const rawPos = pending;
      pending = null;
      const moved =
        orientation === "horizontal" ? rawPos - startX : rawPos - startY;
      const newRatio = Math.max(
        0.1,
        Math.min(0.9, startRatio + moved / total),
      );
      lastRatio = newRatio;
      onRatio(newRatio);
    };

    const onMove = (ev: PointerEvent) => {
      pending = orientation === "horizontal" ? ev.clientX : ev.clientY;
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flush);
      }
    };

    const cleanup = (ev: PointerEvent) => {
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      block.classList.remove("pane-splitter-dragging");

      try {
        splitter.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore — may already be released */
      }

      splitter.removeEventListener("pointermove", onMove);
      splitter.removeEventListener("pointerup", cleanup);
      splitter.removeEventListener("pointercancel", cleanup);

      // Flush any pending RAF so the final position is applied before commit.
      if (pending !== null) flush();

      onCommit(lastRatio);
    };

    splitter.addEventListener("pointermove", onMove);
    splitter.addEventListener("pointerup", cleanup);
    splitter.addEventListener("pointercancel", cleanup);
  };

  splitter.addEventListener("pointerdown", onPointerDown);

  // Return a dispose function that tears down the pointerdown listener.
  // Per-drag listeners (pointermove/pointerup/pointercancel) are torn down
  // automatically in the cleanup handler above.
  return () => splitter.removeEventListener("pointerdown", onPointerDown);
}
