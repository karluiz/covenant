import type { Terminal } from "@xterm/xterm";
import type { MissionInfo } from "../api";
import type { PiChatView } from "../executors/pi/view";

export type PaneId = string;
export type PaneKind = "terminal" | "pi";
export type SplitOrientation = "horizontal" | "vertical";

export type IdleAgentState = {
  agent: string;
  sinceMs: number;
  promptText: string | null;
};

// MissionInfo is imported from ../api — the canonical definition lives there.

// No exported Block type exists in the blocks module yet; keep a minimal
// structural stub here so Pane.blocks compiles. Replace once blocks/manager
// exports a real Block interface.
export interface Block {
  id: string;
}

export interface Pane {
  id: PaneId;
  kind: PaneKind;
  sessionId: string | null;
  cwd: string;
  mission: MissionInfo | null;
  operator: string | null;
  blocks: Block[];
  xterm: Terminal | null;
  piView: PiChatView | null;
  executor: string | null;
  operatorEnabled: boolean;
  operatorLive: boolean;
  aomExcluded: boolean;
  observer_ids: string[];
  spawn_id: string | null;
  idleAgent: IdleAgentState | null;
  busyProc: string | null;
  /// Live operator phase for the strip / status bar, fed by the
  /// `operator-status` event (Phase 2). Null until the first event for
  /// this pane's session.
  operatorPhase: import("../api").OperatorPhase | null;
  /// `phaseSinceUnixMs` from the last `operator-status` event — drives the
  /// "deciding 12s" elapsed counter.
  phaseSince: number | null;
  operatorName: string | null;
  operatorEmoji: string | null;
  /// Most recent command seen on this pane's session (from `block_started`).
  /// Feeds `listOpenSessions().last_command`. Null until the first command.
  lastCommand: string | null;
  /// Count of finished blocks on this pane's session. Feeds
  /// `listOpenSessions().block_count`.
  blockCount: number;
  replayKey: string;
  /// DOM container for this pane (the .pane-host div).
  /// Null only briefly during construction before mounting.
  el: HTMLElement | null;
}

export interface TabLayout {
  kind: "single" | "split";
  orientation?: SplitOrientation;
  activePaneIdx: 0 | 1;
  ratio?: number;
}

export interface Tab {
  id: string;
  panes: [Pane] | [Pane, Pane];
  layout: TabLayout;
}

export const activePane = (t: Tab): Pane =>
  // safe: assertLayoutValid keeps activePaneIdx < panes.length
  t.panes[t.layout.activePaneIdx]!;

export function assertLayoutValid(t: Tab): void {
  if (t.layout.kind === "single" && t.panes.length !== 1) {
    throw new Error(`invariant: layout=single requires 1 pane, got ${t.panes.length}`);
  }
  if (t.layout.kind === "split" && t.panes.length !== 2) {
    throw new Error(`invariant: layout=split requires 2 panes, got ${t.panes.length}`);
  }
  if (t.layout.kind === "split" && !t.layout.orientation) {
    throw new Error(`invariant: layout=split requires orientation`);
  }
  if (t.layout.activePaneIdx >= t.panes.length) {
    throw new Error(`invariant: activePaneIdx ${t.layout.activePaneIdx} out of range (panes.length=${t.panes.length})`);
  }
}

export function collapseToSingle(t: Tab, dropIdx: 0 | 1): void {
  if (t.layout.kind !== "split") return;
  // safe: split layout invariant guarantees panes.length === 2
  const split = t.panes as [Pane, Pane];
  const survivor = split[dropIdx === 0 ? 1 : 0];
  t.panes = [survivor];
  t.layout = { kind: "single", activePaneIdx: 0 };
  assertLayoutValid(t);
}
