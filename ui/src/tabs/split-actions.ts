// ui/src/tabs/split-actions.ts
//
// Pure-ish action that mutates a Tab to add a second pane.
// All side-effecting operations (PTY spawn, DOM mount, focus) are
// injected via SplitActionCtx so unit tests can mock them cheaply.

import {
  assertLayoutValid,
  type Pane,
  type SplitOrientation,
  type Tab,
} from "./pane";

export interface SplitActionCtx {
  /** Spawn a new PTY session for the new pane, returning its sessionId. */
  spawnSession: (cwd: string) => Promise<string>;
  /** Mount the new pane's DOM (.pane-host) inside the .terminal-block. */
  mountPaneInDom: (tab: Tab, paneIdx: 0 | 1) => void;
  /** Move keyboard focus to the named pane. */
  focusPane: (tab: Tab, paneIdx: 0 | 1) => void;
}

/**
 * Splits a tab into two panes. The new pane inherits the source pane's
 * cwd, spawns a fresh PTY session, and becomes the active pane.
 * Throws if the tab is already split.
 */
export async function splitPaneAction(
  tab: Tab,
  orientation: SplitOrientation,
  sourcePaneIdx: 0 | 1,
  ctx: SplitActionCtx,
): Promise<void> {
  if (tab.layout.kind === "split") {
    throw new Error(`tab ${tab.id} is already split`);
  }

  // tab.layout.kind === "single" at this point, so panes.length === 1.
  // sourcePaneIdx is 0 | 1 typed; index 0 is always present in a single tab.
  // The non-null assertion is justified: assertLayoutValid() enforces this invariant,
  // and we check layout.kind === "single" above.
  const source = tab.panes[sourcePaneIdx]!;
  const sessionId = await ctx.spawnSession(source.cwd);

  const newPane: Pane = {
    id: `p-${crypto.randomUUID()}`,
    kind: "terminal",
    sessionId,
    cwd: source.cwd, // safe: source is non-null (guarded above)
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
    operatorPhase: null,
    phaseSince: null,
    operatorName: null,
    operatorEmoji: null,
    lastCommand: null,
    blockCount: 0,
    replayKey: `rk-${sessionId}`,
  };

  tab.panes = [tab.panes[0], newPane] as [Pane, Pane];
  tab.layout = {
    kind: "split",
    orientation,
    activePaneIdx: 1,
    ratio: 0.5,
  };

  assertLayoutValid(tab);

  ctx.mountPaneInDom(tab, 1);
  ctx.focusPane(tab, 1);
}

export interface CloseActionCtx {
  /** Kill the PTY session and free backend resources. */
  killSession: (sessionId: string) => Promise<void>;
  /** Remove the pane's DOM (.pane-host) from the .terminal-block. */
  unmountPaneFromDom: (tab: Tab, paneIdx: 0 | 1) => void;
  /** Move keyboard focus to the named pane. */
  focusPane: (tab: Tab, paneIdx: 0 | 1) => void;
}

export type CloseResult = "collapsed" | "close-tab";

/**
 * Removes a pane from a tab. On a single-pane tab, returns "close-tab"
 * so the caller can close the whole tab. On a split tab, kills the
 * pane's PTY, unmounts its DOM, collapses the layout to single, and
 * focuses the surviving pane.
 */
export interface FocusActionCtx {
  /** Move keyboard focus to the named pane's DOM (e.g., xterm.focus()). */
  focusInDom: (tab: Tab, paneIdx: 0 | 1) => void;
}

export function focusPaneAction(tab: Tab, paneIdx: 0 | 1, ctx: FocusActionCtx): void {
  tab.layout.activePaneIdx = paneIdx;
  ctx.focusInDom(tab, paneIdx);
}

export interface RemountCtx {
  /** Rebuild the split DOM after a layout change (orientation, swap, etc.). */
  remountSplit: (tab: Tab) => void;
}

export function swapPanesAction(tab: Tab, ctx: RemountCtx): void {
  if (tab.layout.kind !== "split") return;
  tab.panes = [tab.panes[1]!, tab.panes[0]!] as [Pane, Pane];
  tab.layout.activePaneIdx = (1 - tab.layout.activePaneIdx) as 0 | 1;
  if (tab.layout.ratio !== undefined) {
    tab.layout.ratio = 1 - tab.layout.ratio;
  }
  ctx.remountSplit(tab);
}

export function setPaneOrientationAction(
  tab: Tab,
  orientation: SplitOrientation,
  ctx: RemountCtx,
): void {
  if (tab.layout.kind !== "split") return;
  tab.layout.orientation = orientation;
  ctx.remountSplit(tab);
}

export function setPaneRatioAction(tab: Tab, ratio: number): void {
  if (tab.layout.kind !== "split") return;
  tab.layout.ratio = Math.max(0.1, Math.min(0.9, ratio));
}

export async function closePaneAction(
  tab: Tab,
  paneIdx: 0 | 1,
  ctx: CloseActionCtx,
): Promise<CloseResult> {
  if (tab.layout.kind === "single") {
    return "close-tab";
  }
  const victim = tab.panes[paneIdx];
  if (victim?.sessionId) {
    await ctx.killSession(victim.sessionId);
  }
  ctx.unmountPaneFromDom(tab, paneIdx);
  const survivorIdx = (paneIdx === 0 ? 1 : 0) as 0 | 1;
  const survivor = tab.panes[survivorIdx];
  if (!survivor) throw new Error(`closePaneAction: missing survivor pane at ${survivorIdx}`);
  tab.panes = [survivor];
  tab.layout = { kind: "single", activePaneIdx: 0 };
  assertLayoutValid(tab);
  ctx.focusPane(tab, 0);
  return "collapsed";
}
