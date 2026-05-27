import type { Terminal } from "@xterm/xterm";
import type { PiChatView } from "../executors/pi/view";

export type PaneId = string;
export type PaneKind = "terminal" | "pi";
export type SplitOrientation = "horizontal" | "vertical";

export interface MissionInfo {
  path: string;
  title: string;
}

export interface Block {
  id: string;
  // …full Block shape lives in blocks module; we re-export for the Pane type
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

export const activePane = (t: Tab): Pane => t.panes[t.layout.activePaneIdx];

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
  const survivor = t.panes[dropIdx === 0 ? 1 : 0];
  t.panes = [survivor];
  t.layout = { kind: "single", activePaneIdx: 0 };
  assertLayoutValid(t);
}
