/// Pure (DOM-free) construction + ranking of command-palette items.
/// Three kinds — workspaces, tabs, actions — fuzzy-ranked and split
/// into capped sections. Unit-tested in isolation.

import { fuzzyScore } from "../mentions/fuzzy";
import type { WorkspaceView } from "./manager";
import type { TabRow } from "./finder";

export type PaletteKind = "workspace" | "tab" | "action";

export interface PaletteItem {
  kind: PaletteKind;
  id: string;
  title: string;
  subtitle?: string;
  color?: string | null;
  icon?: string;
  score: number;
  run: () => void | Promise<void>;
}

export interface PaletteAction {
  id: string;
  title: string;
  icon?: string;
  run: () => void | Promise<void>;
}

export interface Sections {
  workspaces: PaletteItem[];
  tabs: PaletteItem[];
  actions: PaletteItem[];
}

export interface BuildCtx {
  workspaces: WorkspaceView[];
  tabs: TabRow[];
  actions: PaletteAction[];
  activeWorkspaceId: string;
  /// Operations captured by item.run closures. Optional so pure tests
  /// can omit them when not exercising run().
  switchWorkspace?: (id: string) => void | Promise<void>;
  activateTab?: (index: number) => void;
}

const WS_CAP = 5;
const TAB_CAP = 8;
const ACTION_CAP = 6;

function relTime(ms: number): string {
  const dt = Date.now() - ms;
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

function wsItem(w: WorkspaceView, ctx: BuildCtx, score: number): PaletteItem {
  const unit = w.tab_count === 1 ? "tab" : "tabs";
  return {
    kind: "workspace",
    id: w.id,
    title: w.name,
    subtitle: `${w.tab_count} ${unit} · ${relTime(w.last_used_at)}`,
    color: w.color,
    score,
    run: () => {
      if (w.id !== ctx.activeWorkspaceId) return ctx.switchWorkspace?.(w.id);
    },
  };
}

function tabItem(r: TabRow, ctx: BuildCtx, score: number): PaletteItem {
  const where = [r.workspaceName, r.groupName].filter(Boolean).join(" › ");
  return {
    kind: "tab",
    id: `${r.workspaceId}:${r.tabIndex}`,
    title: r.title,
    subtitle: where ? `in ${where}` : undefined,
    color: r.groupColor ?? r.workspaceColor,
    score,
    run: async () => {
      if (r.workspaceId !== ctx.activeWorkspaceId) {
        await ctx.switchWorkspace?.(r.workspaceId);
      }
      ctx.activateTab?.(r.tabIndex);
    },
  };
}

function actionItem(a: PaletteAction, score: number): PaletteItem {
  return { kind: "action", id: a.id, title: a.title, icon: a.icon, score, run: a.run };
}

function byScoreDesc(a: PaletteItem, b: PaletteItem): number {
  return b.score - a.score;
}

export function buildSections(query: string, ctx: BuildCtx): Sections {
  const q = query.trim();

  if (q === "") {
    const workspaces = [...ctx.workspaces]
      .sort((a, b) => b.last_used_at - a.last_used_at)
      .slice(0, WS_CAP)
      .map((w) => wsItem(w, ctx, 0));
    const tabs = ctx.tabs
      .filter((r) => r.workspaceId === ctx.activeWorkspaceId)
      .slice(0, TAB_CAP)
      .map((r) => tabItem(r, ctx, 0));
    return { workspaces, tabs, actions: [] };
  }

  const workspaces: PaletteItem[] = [];
  for (const w of ctx.workspaces) {
    const s = fuzzyScore(w.name, q);
    if (s !== null) workspaces.push(wsItem(w, ctx, s));
  }
  const tabs: PaletteItem[] = [];
  for (const r of ctx.tabs) {
    const s = fuzzyScore(r.title, q);
    if (s !== null) tabs.push(tabItem(r, ctx, s));
  }
  const actions: PaletteItem[] = [];
  for (const a of ctx.actions) {
    const s = fuzzyScore(a.title, q);
    if (s !== null) actions.push(actionItem(a, s));
  }

  return {
    workspaces: workspaces.sort(byScoreDesc).slice(0, WS_CAP),
    tabs: tabs.sort(byScoreDesc).slice(0, TAB_CAP),
    actions: actions.sort(byScoreDesc).slice(0, ACTION_CAP),
  };
}

/// Flatten sections into the cursor-traversal order (headers excluded):
/// Workspaces → Tabs → Actions.
export function flattenSections(s: Sections): PaletteItem[] {
  return [...s.workspaces, ...s.tabs, ...s.actions];
}
