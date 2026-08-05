/// Pure (DOM-free) construction + ranking of command-palette items.
/// Three kinds — workspaces, tabs, actions — fuzzy-ranked and split
/// into capped sections. Unit-tested in isolation.

import { fuzzyScore } from "../mentions/fuzzy";
import type { WorkspaceView } from "./manager";
import type { TabRow } from "./finder";

export type PaletteKind = "workspace" | "tab" | "action" | "create";

export interface PaletteItem {
  kind: PaletteKind;
  id: string;
  title: string;
  subtitle?: string;
  /// Row-scoped rename ("the row is the object"). Absent when this row
  /// can't be renamed from here — e.g. a tab in a background workspace,
  /// which has no live id to rename.
  rename?: (name: string) => void;
  /// Row-scoped destroy: delete for a workspace, close for a tab. Absent
  /// when unavailable; `destroyBlocked` then carries the reason so the
  /// footer dims the key instead of the key silently doing nothing.
  destroy?: () => void | Promise<void>;
  destroyBlocked?: string;
  /// Footer wording for destroy — workspaces are deleted, tabs closed.
  destroyVerb?: string;
  /// Group name, rendered as its own span so CSS can uppercase it
  /// (groups render uppercase everywhere; never mutate the string).
  subtitleGroup?: string;
  color?: string | null;
  icon?: string;
  current?: boolean;
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
  recent: PaletteItem[];
  workspaces: PaletteItem[];
  tabs: PaletteItem[];
  actions: PaletteItem[];
  /// Zero or one row: "create workspace <query>", offered when the query
  /// names no existing workspace. Last in traversal order on purpose —
  /// typing `rav` to reach RAVEN must never put create under ⏎.
  create: PaletteItem[];
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
  /// Row-scoped verbs. An absent callback means the verb isn't offered on
  /// that row at all — the item simply carries no `rename` / `destroy`,
  /// rather than one that no-ops.
  renameWorkspace?: (id: string, name: string) => void;
  /// Host-owned delete policy (undo window vs typed confirm). The palette
  /// never decides severity.
  deleteWorkspace?: (id: string) => void | Promise<void>;
  /// Why this workspace can't be deleted, or null when it can.
  deleteBlocked?: (id: string) => string | null;
  renameTab?: (row: TabRow, name: string) => void;
  closeTab?: (row: TabRow) => void;
  createWorkspace?: (name: string) => void | Promise<void>;
}

const RECENT_CAP = 5;
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
  const blocked = ctx.deleteBlocked?.(w.id) ?? null;
  const del = ctx.deleteWorkspace;
  return {
    kind: "workspace",
    id: w.id,
    title: w.name,
    subtitle: `${w.tab_count} ${unit} · ${relTime(w.last_used_at)}`,
    color: w.color,
    current: w.id === ctx.activeWorkspaceId,
    score,
    rename: ctx.renameWorkspace ? (name) => ctx.renameWorkspace?.(w.id, name) : undefined,
    destroy: del && !blocked ? () => del(w.id) : undefined,
    destroyBlocked: blocked ?? undefined,
    destroyVerb: "delete",
    run: () => {
      if (w.id !== ctx.activeWorkspaceId) return ctx.switchWorkspace?.(w.id);
    },
  };
}

function tabItem(r: TabRow, ctx: BuildCtx, score: number): PaletteItem {
  // Only live tabs carry an id, and only the active workspace has live
  // tabs — a background workspace's rows are manifest entries, so their
  // verbs are gated off with a reason rather than silently missing.
  const live = r.workspaceActive && r.tabId !== null;
  const rename = ctx.renameTab;
  const close = ctx.closeTab;
  return {
    kind: "tab",
    id: `${r.workspaceId}:${r.tabIndex}`,
    rename: live && rename ? (name) => rename(r, name) : undefined,
    destroy: live && close ? () => close(r) : undefined,
    destroyBlocked: live ? undefined : "switch to that workspace first",
    destroyVerb: "close",
    title: r.title,
    subtitle: r.workspaceName || undefined,
    subtitleGroup: r.groupName ?? undefined,
    color: r.groupColor ?? r.workspaceColor,
    current: r.workspaceActive && r.isActiveTabInWorkspace,
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

/// The create row: a search that found no workspace by that name. The name
/// is what the user already typed, so there is no auto-name to correct
/// afterwards.
function createItem(name: string, ctx: BuildCtx): PaletteItem {
  return {
    kind: "create",
    id: `create:${name}`,
    title: `Create workspace “${name}”`,
    icon: "+",
    score: -1,
    run: () => ctx.createWorkspace?.(name),
  };
}

function byScoreDesc(a: PaletteItem, b: PaletteItem): number {
  return b.score - a.score;
}

export function buildSections(query: string, ctx: BuildCtx): Sections {
  const q = query.trim();

  if (q === "") {
    const recentRows = ctx.tabs
      .filter((r) => r.lastActiveAt !== null && !(r.workspaceActive && r.isActiveTabInWorkspace))
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
      .slice(0, RECENT_CAP);
    const recentIds = new Set(recentRows.map((r) => `${r.workspaceId}:${r.tabIndex}`));
    const recent = recentRows.map((r) => tabItem(r, ctx, 0));
    const workspaces = [...ctx.workspaces]
      .sort((a, b) => b.last_used_at - a.last_used_at)
      .slice(0, WS_CAP)
      .map((w) => wsItem(w, ctx, 0));
    const tabs = ctx.tabs
      .filter(
        (r) =>
          r.workspaceId === ctx.activeWorkspaceId &&
          !recentIds.has(`${r.workspaceId}:${r.tabIndex}`),
      )
      .slice(0, TAB_CAP)
      .map((r) => tabItem(r, ctx, 0));
    return { recent, workspaces, tabs, actions: [], create: [] };
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

  const named = ctx.workspaces.some((w) => w.name.trim().toLowerCase() === q.toLowerCase());

  return {
    recent: [],
    workspaces: workspaces.sort(byScoreDesc).slice(0, WS_CAP),
    tabs: tabs.sort(byScoreDesc).slice(0, TAB_CAP),
    actions: actions.sort(byScoreDesc).slice(0, ACTION_CAP),
    create: named ? [] : [createItem(q, ctx)],
  };
}

/// Flatten sections into the cursor-traversal order (headers excluded):
/// Recent → Workspaces → Tabs → Actions → Create.
export function flattenSections(s: Sections): PaletteItem[] {
  return [...s.recent, ...s.workspaces, ...s.tabs, ...s.actions, ...s.create];
}
