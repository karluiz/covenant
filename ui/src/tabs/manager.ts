// Tab manager: each tab owns one backend Session, its own xterm.js
// Terminal, and its own BlockManager. Switching tabs hides inactive
// panes via the [hidden] attribute — terminals are never re-mounted on
// activation, satisfying the CLAUDE.md TS conventions.
//
// M-UX1 adds: rename (double-click or context menu), color (right-click
// → swatches), and drag-reorder.
// M-UX2 adds: tab groups. A group is a named, color-bearing container.
// A tab can be in 0 or 1 group. Adding/removing rearranges `tabs[]` so
// grouped members stay adjacent (single visual run per group).
// All metadata is in-memory only — persistence ties to session
// restoration which is its own arch change (M7+ scope).

import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { CanvasAddon } from "@xterm/addon-canvas";
import {
  attachLigatures,
  type LigatureHandle,
} from "../terminal/ligatures";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { TerminalFinder } from "../terminal/finder";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BrowserPane } from "../browser/pane";
import { FavoritesRail } from "../browser/favorites/rail";

import { closeSessionCheck } from "../api";
import {
  projectNotesApi,
  promptsApi,
  type Command,
  type Prompt,
} from "../project-notes/api";
import { sendPromptToSession } from "../project-notes/paste";
import { openMindLossModal } from "../operator/mind-loss-modal";
import { openConfirmPrompt } from "../workspaces/confirm-prompt";
import { openConfirmTyped } from "../workspaces/confirm-typed";
import {
  aomStatus,
  aomStop,
  clearAllAomExcluded,
  clearSessionMission,
  closeSession,
  getBlockedSessionIds,
  getSessionMission,
  getSettings,
  getExperimentalFlags,
  isAomExcluded,
  isOperatorEnabled,
  isOperatorLive,
  operatorLevelFromXp,
  operatorList,
  resizeSession,
  resolveExistingPath,
  scoreSetCurrentSession,
  setAomExcluded,
  sessionSetOperator,
  setOperatorEnabled,
  getRemoteArmed,
  setRemoteArmed,
  setOperatorLive,
  operatorSoloStart,
  operatorSoloStop,
  setSessionMission,
  setTabTitle,
  teammateListTasks,
  teammateCancelActiveTask,
  notchSetLabel,
  spawnSession,
  replayScrollback,
  deleteScrollback,
  tabManifestSave,
  writeToSession,
  type MissionInfo,
  type Operator,
  type SessionId,
  type TerminalConfig,
} from "../api";
import { BlockManager } from "../blocks/manager";
import type { StatusBar } from "../status/bar";
import { RecallManager } from "../recall/manager";
import { StructureTree } from "../structure/tree";
import { attachFileDrop } from "../structure/file-drop";
import { StructureEditor } from "../structure/editor";
import { pushInfoToast } from "../notifications/toast";
import { Icons } from "../icons";
import { ContextMenu, COLOR_SWATCHES, COLOR_SWATCHES_PASTEL, type MenuItem } from "../menu/context-menu";
import { openNewSuperpowersTopicModal, type MissionPageOpts, type PageResult } from "../mission/page";
import { createGroupShell } from "./group-shell";
import { renderAvatarHtml } from "../operator/avatars";
import { detectExecutor } from "../executor";
import { PiChatView } from "../executors/pi/view";
import { spawnPiSession, piSetSessionName } from "../api";
import type { AomBanner } from "../aom/banner";
import { mountSpecBadge, type SpecBadgeHandle } from "../aom/spec-badge";
import { getSpecPromptState } from "../aom/spec-prompt";
import { Familiars } from "../familiars/api";
import { setFamiliarFor } from "../familiars/registry";
import { zoom } from "../zoom";
import { attachTooltip } from "../tooltip/tooltip";
import type { Pane, TabLayout, SplitOrientation } from "./pane";
import { activePane, assertLayoutValid } from "./pane";
import {
  splitPaneAction,
  closePaneAction,
  focusPaneAction,
  swapPanesAction,
  setPaneRatioAction,
} from "./split-actions";
import { installPaneSplitter } from "./pane-splitter";
import { positionGlassIndicator } from "./glass-indicator";
import { sessionHintsFromTabs, type SessionHint } from "../convergence/hints";

/// Ensure a Familiar exists for the given session. If one is already
/// registered backend-side (e.g. survived a relaunch), reuse it;
/// otherwise spawn a fresh "Familiar" with conversational defaults.
/// Always populates the session->familiar registry.
async function ensureFamiliarFor(sessionId: string): Promise<string> {
  const list = await Familiars.list();
  const existing = list.find((f) => f.session_id === sessionId);
  if (existing) {
    setFamiliarFor(sessionId, existing.id);
    return existing.id;
  }
  const id = await Familiars.spawn(sessionId, "Familiar", "conversational", 5.0);
  setFamiliarFor(sessionId, id);
  return id;
}

const DEFAULT_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const DEFAULT_FONT_SIZE = 13;

/// Split panes (D12 v0) build their own xterm + FitAddon locally in
/// mountSecondPaneDom rather than going through spawnTab. We keep their
/// fit addons here, keyed by the terminal, so applyTerminalSettings can
/// refit a secondary pane after a live font change. WeakMap so entries
/// are reclaimed automatically when a pane's terminal is disposed.
const paneFitAddons = new WeakMap<Terminal, FitAddon>();

/// xterm palettes. background stays fully transparent so the workspace
/// surface tint (--surface-alpha) reads through. Light palette is
/// GitHub Light — ANSI values chosen to match its terminal preset.
const TERMINAL_THEME_DARK = {
  background: "rgba(0, 0, 0, 0)",
  foreground: "#d6d8db",
  cursor: "#7aa2f7",
  cursorAccent: "#0b0d10",
  selectionBackground: "#2a3148",
} as const;

const TERMINAL_THEME_LIGHT = {
  background: "rgba(255, 255, 255, 0.97)",
  foreground: "#24292f",
  cursor: "#2f6fed",
  cursorAccent: "#ffffff",
  selectionBackground: "#b6d4fe",
  black:   "#24292f",
  red:     "#cf222e",
  green:   "#116329",
  yellow:  "#4d2d00",
  blue:    "#0969da",
  magenta: "#8250df",
  cyan:    "#1b7c83",
  white:   "#6e7781",
  brightBlack:   "#57606a",
  brightRed:     "#a40e26",
  brightGreen:   "#1a7f37",
  brightYellow:  "#633c01",
  brightBlue:    "#218bff",
  brightMagenta: "#a475f9",
  brightCyan:    "#3192aa",
  brightWhite:   "#8c959f",
} as const;

function termTheme(): typeof TERMINAL_THEME_DARK | typeof TERMINAL_THEME_LIGHT {
  return document.body.classList.contains("theme-light")
    ? TERMINAL_THEME_LIGHT
    : TERMINAL_THEME_DARK;
}

/// Scale negative letter-spacing by DPR. The user calibrates the
/// value on whatever display they use most (typically Retina, DPR=2),
/// where sub-pixel anti-aliasing absorbs the overlap. On a 1x
/// external display each CSS pixel is one device pixel, so the same
/// negative value renders glyphs literally on top of each other. We
/// normalize so the same setting looks the same across DPRs.
function scaledLetterSpacing(raw: number): number {
  if (raw >= 0) return raw;
  const dpr = window.devicePixelRatio || 1;
  // DPR=2 → full value; DPR=1 → 0 (no overlap on 1x displays);
  // linear in between. Negative letter-spacing only works visually
  // when sub-pixel anti-aliasing absorbs the overlap, which requires
  // DPR > 1.
  const factor = Math.max(0, Math.min(1, dpr - 1));
  return raw * factor;
}

function buildTerminalOptions(font: TerminalConfig | null): Record<string, unknown> {
  const baseSize = font?.font_size || DEFAULT_FONT_SIZE;
  return {
    fontFamily: font?.font_family || DEFAULT_FONT_FAMILY,
    fontSize: baseSize * zoom.level(),
    lineHeight: font?.line_height ?? 1.2,
    letterSpacing: scaledLetterSpacing(font?.letter_spacing ?? 0),
    cursorBlink: true,
    cursorStyle: "block",
    allowProposedApi: true,
    /// xterm's DOM/canvas renderer paints theme.background opaquely
    /// unless this is on. Required for vibrancy to show through.
    allowTransparency: true,
    convertEol: false,
    scrollback: 10_000,
    theme: termTheme(),
  };
}

interface Tab {
  id: string;
  /// Tab kind discriminator. "shell" (default, also for legacy manifests
  /// that lack the field) drives the existing xterm + blocks + recall +
  /// editor pipeline. "pi" hosts a PiChatView in `pane` instead — all
  /// xterm-specific fields below are undefined for "pi" tabs and every
  /// xterm-touching method early-returns on `kind === "pi"`.
  /// "browser" hosts a BrowserPane (native webview chrome) in `pane`;
  /// like "pi" it leaves every xterm-specific field undefined and every
  /// terminal-touching method early-returns / guards on it.
  kind: "shell" | "pi" | "browser";
  /// Default name from the spawn sequence ("zsh 1"). Always present.
  defaultTitle: string;
  /// User-set name. When set, takes precedence over defaultTitle.
  customName: string | null;
  /// Hex color or null. Drives left-border + faint background tint.
  color: string | null;
  /// Group membership. Null = not in any group.
  groupId: string | null;
  pane: HTMLElement;
  /// xterm-specific fields below — populated for "shell" tabs, left
  /// undefined for "pi" tabs (the pane hosts a PiChatView instead).
  termHost?: HTMLElement;
  blocksHost?: HTMLElement;
  term?: Terminal;
  fit?: FitAddon;
  /// Held so applyTerminalSettings can call webgl.clearTextureAtlas()
  /// when the font changes — the addon caches glyph bitmaps separately
  /// from the terminal options.
  webgl?: WebglAddon | null;
  canvas?: CanvasAddon | null;
  ligatures?: LigatureHandle | null;
  /// Cmd+F in-terminal search. SearchAddon highlights matches inside
  /// the xterm buffer; the finder is the floating overlay UI.
  search?: SearchAddon;
  finder?: TerminalFinder;
  blocks?: BlockManager;
  recall?: RecallManager;
  structure?: StructureTree;
  editor?: StructureEditor;
  /// All-in-one "open this file in the editor" entry point — handles
  /// un-hiding the editor host + splitter, restoring the persisted
  /// splitter width, opening the file, and refitting the terminal.
  /// Stored as a closure so it can capture the per-tab `showSplitter`
  /// helper without forcing every caller to know the dance.
  openEditor?: (path: string, opts?: { line?: number }) => void;
  /// Pi-specific — set when `kind === "pi"`. Subscribes to the Pi RPC
  /// event stream and renders the chat panel inside `pane`.
  piView?: PiChatView;
  /// Browser-specific — set when `kind === "browser"`. Owns the native
  /// webview chrome mounted inside `pane`.
  browser?: BrowserPane;
  /// True when PTY output was written into xterm while the pane was
  /// display:none — xterm can't measure its viewport then, so the scroll
  /// area goes stale and activate() must run the resize nudge to re-sync
  /// it. Cleared after the nudge runs. Shell tabs are born true (replay
  /// scrollback + early shell output land before first activation).
  wroteWhileHidden?: boolean;
  /// Which sidebar view is currently selected manually. Recall still
  /// overrides this when user is typing (existing behavior).
  sidebarView: "blocks" | "structure" | "recall";
  disposers: IDisposable[];
  /// Spec-pending badge handle. Destroyed on closeTab and recreated on
  /// each renderTabPill call to keep subscriptions symmetric.
  specBadge: SpecBadgeHandle | null;
  /// Phase C: all data fields (sessionId, replayKey, cwd, mission,
  /// operator_id/operator, operatorEnabled, operatorLive, aomExcluded,
  /// observer_ids, spawn_id, executor, idleAgent, busyProc) have been
  /// removed from Tab. Access via activePane(tab).<field> instead.
  panes: [Pane] | [Pane, Pane];
  layout: TabLayout;
  /// Phase D: wrapper that contains 1 or 2 pane-hosts. Always present
  /// (single-pane tabs have one pane-host).
  terminalBlock: HTMLElement;
}

interface TabGroup {
  id: string;
  name: string;
  color: string | null;
  collapsed: boolean;
  /// Default cwd for new tabs created inside this group. Null = no
  /// default (new tabs start in $HOME like ungrouped tabs). Set via
  /// the group's context menu ("Set root dir…").
  rootDir: string | null;
}

/// Persisted manifest schema. Version-tagged so we can evolve later
/// without breaking old files. Bumped → `restoreFromManifest` falls
/// back to a fresh tab instead of failing loudly.
export interface TabManifestV1 {
  version: 1;
  active_index: number;
  tabs: SerializedTab[];
  groups: SerializedGroup[];
}

export interface SerializedTab {
  /// Tab kind. Optional for backward compat — old manifests default to
  /// "shell" on restore so existing installs upgrade seamlessly.
  kind?: "shell" | "pi";
  custom_name: string | null;
  cwd: string | null;
  color: string | null;
  group_id: string | null;
  /// Spec path of the mission attached to this tab at save time. The
  /// backend used to auto-restore missions on `cwd_changed` from a
  /// per-cwd map, but that leaked missions onto unrelated new tabs in
  /// the same dir. Now restoration is explicit per persisted tab —
  /// fresh tabs (⌘T) always start blank.
  mission_path: string | null;
  /// Operator pinned to this tab at save time. Null = default operator.
  operator_id: string | null;
  /// Observers persisted for this tab. Optional for backward compat —
  /// old manifests without it default to [] on restore.
  observer_ids?: string[];
  /// Spawn bound to this tab at save time. Optional for backward compat.
  spawn_id?: string | null;
  /// AOM exclusion persisted for this tab. Optional for backward compat
  /// — old manifests that lack the field default to false on restore.
  aom_excluded?: boolean;
  /// Stable scrollback-log key. Optional for backward compat — old
  /// manifests without it get a fresh key on first restore (so the
  /// first reopen has no replay, which is the correct behavior).
  replay_key?: string;
  /// 4.x — multi-pane support. When present, supersedes the scalar
  /// `cwd`/`mission_path`/`operator_id`/`replay_key` fields above; the
  /// loader passes the legacy tab through `liftLegacyTab()` first so
  /// the rest of the pipeline always sees the new shape.
  panes?: SerializedPane[];
  layout?: SerializedLayout;
}

export interface SerializedPane {
  id: string;
  /** "terminal" maps to "shell" at the tab level — renamed for clarity. */
  kind: "terminal" | "pi";
  cwd: string | null;
  mission_path: string | null;
  operator_id: string | null;
  replay_key: string;
  observer_ids?: string[];
  spawn_id?: string | null;
  aom_excluded?: boolean;
}

export interface SerializedLayout {
  kind: "single" | "split";
  orientation?: "horizontal" | "vertical";
  active: 0 | 1;
  ratio?: number;
}

/// Serialize a live Tab into the canonical SerializedTab shape (panes[] +
/// layout). The legacy scalar fields (cwd, mission_path, operator_id at the
/// tab level) are emitted as null — new readers always use panes[i] instead.
/// Exported so tests can call it directly without a full TabManager.
export function serializeTab(tab: {
  kind: "shell" | "pi";
  customName: string | null;
  color: string | null;
  groupId: string | null;
  panes: [Pane] | [Pane, Pane];
  layout: TabLayout;
}): SerializedTab {
  const serializePane = (p: Pane): SerializedPane => ({
    id: p.id,
    kind: p.kind,
    cwd: p.cwd || null,
    mission_path: p.mission?.path ?? null,
    operator_id: p.operator,
    replay_key: p.replayKey,
    observer_ids: p.observer_ids,
    spawn_id: p.spawn_id,
    aom_excluded: p.aomExcluded,
  });
  const pane0 = tab.panes[0]!;
  const pane1 = tab.panes[1];
  return {
    kind: pane0.kind === "pi" ? "pi" : "shell",
    custom_name: tab.customName,
    cwd: null,           // legacy mirror; new readers use panes[i].cwd
    color: tab.color,
    group_id: tab.groupId,
    mission_path: null,  // legacy mirror; new readers use panes[i].mission_path
    operator_id: null,   // legacy mirror; new readers use panes[i].operator_id
    panes: pane1
      ? [serializePane(pane0), serializePane(pane1)]
      : [serializePane(pane0)],
    layout: {
      kind: tab.layout.kind,
      orientation: tab.layout.orientation,
      active: tab.layout.activePaneIdx,
      ratio: tab.layout.ratio,
    },
  };
}

export function liftLegacyTab(t: SerializedTab): SerializedTab {
  if (t.panes && t.panes.length > 0) {
    const p0 = t.panes[0];
    // Heal partial shape: if panes survived but layout didn't, synthesize a single-layout
    // so we don't lose the panes array.
    const withLayout: SerializedTab = t.layout
      ? t
      : { ...t, layout: { kind: "single", active: 0 } };
    // Backfill top-level mirrors from pane[0] so the existing restore loop
    // and any other top-level consumers keep working with new-format manifests.
    // serializeTab writes top-level scalars as null for new-format tabs, which
    // would cause restoreFromManifest to lose cwd/mission/operator on first restart.
    // Use ?? (not ||) so that an explicit empty string is still respected.
    return {
      ...withLayout,
      kind: withLayout.kind ?? (p0.kind === "pi" ? "pi" : "shell"),
      cwd: withLayout.cwd ?? p0.cwd,
      mission_path: withLayout.mission_path ?? p0.mission_path,
      operator_id: withLayout.operator_id ?? p0.operator_id,
      replay_key: withLayout.replay_key ?? p0.replay_key,
      observer_ids: withLayout.observer_ids ?? p0.observer_ids,
      spawn_id: withLayout.spawn_id ?? p0.spawn_id,
      aom_excluded: withLayout.aom_excluded ?? p0.aom_excluded,
    };
  }
  const pane: SerializedPane = {
    id: `legacy-${t.replay_key ?? crypto.randomUUID()}`,
    kind: t.kind === "pi" ? "pi" : "terminal",
    cwd: t.cwd,
    mission_path: t.mission_path,
    operator_id: t.operator_id,
    replay_key: t.replay_key ?? "",
    observer_ids: t.observer_ids,
    spawn_id: t.spawn_id,
    aom_excluded: t.aom_excluded,
  };
  return { ...t, panes: [pane], layout: { kind: "single", active: 0 } };
}

interface SerializedGroup {
  id: string;
  name: string;
  color: string | null;
  collapsed: boolean;
  /// Default cwd for new tabs created in this group. Optional for
  /// backward compat — older manifests lacking the field default to
  /// null on restore.
  root_dir?: string | null;
}

export interface RailTabView {
  id: string;
  name: string;
  color: string | null;
  active: boolean;
  /// Tab kind, so the rail can mark non-terminal (browser) tabs with a
  /// distinct glyph instead of rendering them like a shell cell.
  kind: Tab["kind"];
}

export interface RailGroupView {
  id: string;
  name: string;
  color: string | null;
  tabs: RailTabView[];
}

export interface RailSnapshot {
  items: Array<
    | { kind: "group"; group: RailGroupView }
    | { kind: "tab"; tab: RailTabView }
  >;
}

type RenameTarget =
  | { kind: "tab"; id: string }
  | { kind: "group"; id: string }
  | null;

type DragSource =
  | { kind: "tab"; id: string }
  | { kind: "group"; id: string }
  | null;

/// Last path segment of a cwd, for the cold-start tab title. Empty/unknown
/// cwd falls back to "shell".
function cwdBasename(cwd: string | null | undefined): string {
  const seg = (cwd ?? "").split("/").filter(Boolean).pop();
  return seg && seg.length > 0 ? seg : "shell";
}

function tabDisplayName(t: Tab): string {
  return t.customName?.trim() || t.defaultTitle;
}

export function shouldForwardRename(args: {
  executor: string | null;
  kind: "shell" | "pi" | "browser";
  previousCustomName: string | null;
  newCustomName: string | null;
}): boolean {
  const wasUnnamed =
    !args.previousCustomName || args.previousCustomName.trim().length === 0;
  const isNamedNow =
    !!args.newCustomName && args.newCustomName.trim().length > 0;
  const isPi = args.kind === "pi" || args.executor === "pi";
  return wasUnnamed && isNamedNow && isPi;
}

/// Pure helper: returns the next observer_ids array after attempting to
/// add `operatorId`. Returns the SAME reference (===) when the add is a
/// no-op (already the driver, or already an observer) so callers can
/// cheaply detect "nothing changed" without a deep compare.
export function computeAddObserver(
  driverId: string | null,
  observers: readonly string[],
  operatorId: string,
): string[] {
  if (driverId === operatorId) return observers as string[]; // can't observe what you drive
  if (observers.includes(operatorId)) return observers as string[]; // idempotent
  return [...observers, operatorId];
}

/// Pure helper: returns the next observer_ids array after removing
/// `operatorId`. Same-reference contract as computeAddObserver.
export function computeRemoveObserver(
  observers: readonly string[],
  operatorId: string,
): string[] {
  if (!observers.includes(operatorId)) return observers as string[];
  return observers.filter((id) => id !== operatorId);
}

/// Pure helper: returns the next observer_ids array after promoting
/// `newDriverId` to driver. Strips the new driver from the observers
/// list so the two sets stay disjoint. When `newDriverId` is null
/// (demotion), observers are returned unchanged (as a fresh copy).
export function stripObserverOnPromote(
  observers: readonly string[],
  newDriverId: string | null,
): string[] {
  if (!newDriverId) return [...observers];
  return observers.filter((id) => id !== newDriverId);
}

/// Placement facts inherited by an auto-spawned tab: working dir, group, color.
export interface TabPlacement {
  cwd: string;
  groupId: string | null;
  color: string | null;
}

/// Pure resolver: from a snapshot of (operator, cwd, groupId, color) per tab,
/// return the placement of the FIRST tab currently driven by `operatorId`, or
/// null if none. Kept pure so it's unit-testable without a TabManager instance
/// (the manager has dozens of constructor-time deps).
export function resolveOperatorPlacement(
  rows: Array<{ operator: string | null; cwd: string; groupId: string | null; color: string | null }>,
  operatorId: string,
): TabPlacement | null {
  const hit = rows.find((r) => r.operator === operatorId);
  return hit ? { cwd: hit.cwd, groupId: hit.groupId, color: hit.color } : null;
}

/// Pure policy for the activation-time refit. Activation used to run an
/// unconditional rows-1/rows resize nudge plus scrollToBottom on every tab
/// switch — visible as flicker + a viewport jump 2 frames after the pane
/// was already on screen. The nudge is only needed to re-sync xterm's
/// scroll area after data was written while the pane was display:none
/// (xterm can't measure the viewport then), and the bottom pin should
/// only be restored if the user was actually at the bottom.
export interface ActivationRefitPlan {
  nudge: boolean;
  scrollToBottom: boolean;
}

export function computeActivationRefit(opts: {
  wroteWhileHidden: boolean;
  viewportY: number;
  baseY: number;
  rows: number;
}): ActivationRefitPlan {
  return {
    nudge: opts.wroteWhileHidden && opts.rows > 1,
    scrollToBottom: opts.viewportY >= opts.baseY,
  };
}

/// Pure policy for the ResizeObserver second-pass nudge. The nudge exists
/// for sub-cell drift while VISIBLE (status bar mount, splitter settle —
/// host height changed but fit() resolved to the same cols/rows). It must
/// NOT run on the reveal transition (host going 0x0 → real size when a
/// hidden tab is activated): activate() already handles that case, and
/// nudging there repaints the terminal right after it became visible.
export function shouldRoNudge(opts: {
  revealing: boolean;
  dimsChanged: boolean;
  rows: number;
}): boolean {
  return !opts.revealing && !opts.dimsChanged && opts.rows > 1;
}

/// Pure helper: which pane is actually painted on screen right now —
/// laid out (`hidden` false) AND composited (not `visibility:hidden`,
/// i.e. not a pane another in-flight activation prepared invisibly).
/// Activation keeps that pane up as the visual frame until the incoming
/// pane has fitted and rendered, so a tab switch is one clean cross-cut
/// instead of paint-then-jump spread over several frames.
export function pickPaintedPaneId(
  panes: ReadonlyArray<{ id: string; hidden: boolean; visibility: string }>,
  targetId: string,
): string | null {
  const painted = panes.find(
    (p) => p.id !== targetId && !p.hidden && p.visibility !== "hidden",
  );
  return painted ? painted.id : null;
}

/// localStorage key for the short-id → display-name cache. Purpose:
/// when an Operator-decisions row points at a tab that's been closed,
/// we still want to show "zsh 2" or "anvil-light-toggle" instead of
/// `…3BDWPP`. The cache is populated on every tab create / rename so
/// the entry is up to date even if the tab is closed seconds later.
const SESSION_NAME_CACHE_KEY = "covenant.session-name-history";
const SESSION_NAME_CACHE_MAX = 200;

interface CachedSessionName {
  name: string;
  /// Last touched (Unix-ms). Used for LRU trim when the cache fills.
  ts: number;
}

function loadSessionNameCache(): Map<string, CachedSessionName> {
  try {
    const raw = localStorage.getItem(SESSION_NAME_CACHE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Record<string, CachedSessionName>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function saveSessionNameCache(m: Map<string, CachedSessionName>): void {
  try {
    // Trim to most-recent SESSION_NAME_CACHE_MAX. Older entries are
    // evicted — they're for sessions the user almost certainly won't
    // see surface in the panel again.
    if (m.size > SESSION_NAME_CACHE_MAX) {
      const sorted = Array.from(m.entries()).sort((a, b) => b[1].ts - a[1].ts);
      m = new Map(sorted.slice(0, SESSION_NAME_CACHE_MAX));
    }
    localStorage.setItem(
      SESSION_NAME_CACHE_KEY,
      JSON.stringify(Object.fromEntries(m)),
    );
  } catch {
    /* quota / private mode — fine to skip */
  }
}


export class TabManager {
  private readonly tabs: Tab[] = [];
  private readonly groups: Map<string, TabGroup> = new Map();
  private activeId: string | null = null;
  private missionPicker: ((opts: MissionPageOpts) => Promise<PageResult>) | null = null;
  private nextSeq = 1;
  private nextGroupSeq = 1;
  private readonly menu: ContextMenu;
  private renaming: RenameTarget = null;
  private dragging: DragSource = null;
  /// Cache of operator_id → Operator for rendering chips. Populated
  /// once at boot via refreshOperatorCache() and refreshed after any
  /// CRUD (setTabOperator, picker save). Not polled.
  private operatorCache: Map<string, Operator> = new Map();
  /// groupId → last-rendered collapsed state. Used to detect a fold/
  /// unfold transition between renders so we can stage the "from"
  /// state on the freshly-built pill and flip to the "to" state on
  /// the next frame, letting CSS animate.
  private lastCollapsed: Map<string, boolean> = new Map();
  /// Pending debounce handle for `scheduleSave`. Coalesces a burst of
  /// state changes (drag reorder, group manipulations, …) into one
  /// disk write 200ms later.
  private saveTimer: number | null = null;

  /// Optional persistence callback installed by the WorkspaceManager.
  /// When set, the workspace layer owns disk writes — TabManager will
  /// invoke this instead of writing a bare V1 envelope, so the file on
  /// disk always carries the V2 wrapper.
  private onPersistRequest: (() => void) | null = null;

  /// True while replaceFromManifest is tearing down + rebuilding tabs.
  /// Guards `onAllTabsClosed` so a workspace switch (which transiently
  /// empties this.tabs) doesn't fire the "no tabs left → close window"
  /// handler that main.ts wired up.
  private inReplace = false;

  /// Hibernated workspaces: their Tab objects + groups + active selection
  /// are stashed here while another workspace is in front. PTYs stay
  /// alive on the backend and xterm buffers keep accumulating output
  /// because the data-event subscriptions on each Tab remain wired. The
  /// DOM panes are detached from `this.workspace` but not destroyed.
  private hibernated: Map<
    string,
    { tabs: Tab[]; groups: Map<string, TabGroup>; activeId: string | null }
  > = new Map();

  setOnPersistRequest(cb: (() => void) | null): void {
    this.onPersistRequest = cb;
  }

  /// Name of the active workspace, pushed in by WorkspaceManager on boot
  /// and on every switch. Threaded into score events so the analytics
  /// "BY GROUP" panel can attribute same-named tab groups to the right
  /// workspace. Null until WorkspaceManager wires it.
  private activeWorkspaceName: string | null = null;

  setActiveWorkspaceName(name: string | null): void {
    this.activeWorkspaceName = name;
    // Re-push the active session context so the workspace lands on
    // subsequent score events even if the tab strip didn't change.
    this.emitActiveTab();
  }

  /// Workspace integration hooks. The workspace layer injects:
  ///  - `listWorkspaces`: returns the catalog (id+name+active) so the
  ///    group context menu can render a "Move to workspace…" submenu.
  ///  - `moveGroupToWorkspace`: performs the actual cross-workspace move.
  ///  - `activeWorkspaceRootDir`: the active workspace's root_dir (or
  ///    null), used as the final cwd fallback in createTab.
  private listWorkspaces: (() => Array<{ id: string; name: string; active: boolean }>) | null = null;
  private moveGroupToWorkspace: ((groupId: string, workspaceId: string) => Promise<void>) | null = null;
  private activeWorkspaceRootDir: (() => string | null) | null = null;

  setWorkspaceCatalog(
    list: () => Array<{ id: string; name: string; active: boolean }>,
    move: (groupId: string, workspaceId: string) => Promise<void>,
  ): void {
    this.listWorkspaces = list;
    this.moveGroupToWorkspace = move;
  }

  setActiveWorkspaceRootDirGetter(getter: () => string | null): void {
    this.activeWorkspaceRootDir = getter;
  }

  /// Read-only snapshot of a group and the tabs that belong to it, in
  /// the SerializedTab/SerializedGroup shape used by `serializeManifest`.
  /// Returns null if the group doesn't exist.
  snapshotGroupForMove(
    groupId: string,
  ): { group: SerializedGroup; tabs: SerializedTab[] } | null {
    const g = this.groups.get(groupId);
    if (!g) return null;
    const manifest = this.serializeManifest();
    const groupSer = manifest.groups.find((sg) => sg.id === groupId);
    if (!groupSer) return null;
    const tabs = manifest.tabs.filter((t) => t.group_id === groupId);
    return { group: groupSer, tabs };
  }

  /// Tear down every tab in `groupId` plus the group itself, without the
  /// mind-loss confirm modal (the workspace move flow has its own UX).
  /// Mirrors the bypass used by `replaceFromManifest`.
  removeGroupAndTabs(groupId: string): void {
    const ids = this.tabs.filter((t) => t.groupId === groupId).map((t) => t.id);
    this.inReplace = true;
    try {
      for (const id of ids) this.finalizeCloseTab(id);
      this.groups.delete(groupId);
    } finally {
      this.inReplace = false;
    }
    this.renderTabbar();
    this.scheduleSave();
  }

  /// 3.14 — set of sessionIds currently in convergence `blocked` state.
  /// Refreshed at 1 Hz by `blockedPollTimer`; drives the per-tab
  /// escalation dot. Diff-based updates avoid DOM churn for tabs whose
  /// state did not change.
  private blockedSessionIds: Set<string> = new Set();
  private blockedPollTimer: number | null = null;

  /// short-id → display name cache (see `SESSION_NAME_CACHE_KEY`).
  /// Updated on every name-affecting mutation; consulted by panels
  /// that need to label closed tabs.
  private sessionNameCache: Map<string, CachedSessionName> = loadSessionNameCache();

  /// Held so the per-tab Operator badge knows whether AOM is on (toggle
  /// is active only during AOM). Wired by main.ts after both classes
  /// are constructed.
  private aomBanner: AomBanner | null = null;

  setAomBanner(banner: AomBanner): void {
    this.aomBanner = banner;
  }

  /// Held so TabManager can push the per-tab AOM exclusion list to
  /// the status bar's chip + popover. Wired by main.ts after both
  /// classes are constructed.
  private statusBar: StatusBar | null = null;

  setStatusBar(sb: StatusBar): void {
    this.statusBar = sb;
  }

  /// Whether experimental split-panes are enabled. Loaded from settings
  /// at boot via `loadExperimentalFlags()`; updated live via
  /// `setSplitPanesEnabled()` when the user saves the settings panel.
  private splitPanesEnabled = false;

  /// Whether `experimental.internal_browser` is on. When true, link
  /// clicks (WebLinks addon + bare host:port provider) open an in-app
  /// browser tab instead of the system browser. Loaded at boot and
  /// refreshed via `loadExperimentalFlags()` on settings save.
  private experimentalInternalBrowser = false;

  async loadExperimentalFlags(): Promise<void> {
    const f = await getExperimentalFlags();
    this.splitPanesEnabled = f.split_panes;
    const wasOn = this.experimentalInternalBrowser;
    this.experimentalInternalBrowser = f.internal_browser;
    if (wasOn && !this.experimentalInternalBrowser) {
      this.closeAllBrowserTabs();
    }
    this.setStatusbarTwoRow(f.statusbar_two_row);
  }

  private closeAllBrowserTabs(): void {
    for (const tab of [...this.tabs]) {
      if (tab.kind === "browser") this.closeTab(tab.id);
    }
  }

  setSplitPanesEnabled(v: boolean): void {
    this.splitPanesEnabled = v;
    // D12 will wire `rebindSplitShortcuts()` here; for now this is a no-op.
  }

  /// Driven by `experimental.statusbar_two_row` — toggles the status
  /// bar between the shipped two-row layout (true) and the original
  /// single-row layout (false). StatusBar is a singleton held at
  /// `this.statusBar` (constructed in main.ts:867 and assigned via
  /// `setStatusBar`), so we forward to one instance.
  setStatusbarTwoRow(v: boolean): void {
    this.statusBar?.setTwoRow(v);
  }

  /// Public read for keybindings + context menu gating.
  canSplitPanes(): boolean {
    return this.splitPanesEnabled;
  }

  /// Public read of `experimental.internal_browser` for the titlebar
  /// globe button + ⌘B shortcut gating. Mirrors the cached in-memory
  /// flag refreshed via `loadExperimentalFlags()` on settings save.
  isInternalBrowserEnabled(): boolean {
    return this.experimentalInternalBrowser;
  }

  // D12 — split-pane public API -----------------------------------------------

  canSplit(): boolean {
    if (!this.splitPanesEnabled) return false;
    const tab = this.tabs.find((t) => t.id === this.activeId);
    return tab !== undefined && tab.layout.kind === "single";
  }

  async splitActivePane(orientation: SplitOrientation): Promise<void> {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab || !this.splitPanesEnabled || tab.layout.kind === "split") return;
    await splitPaneAction(tab, orientation, 0, {
      spawnSession: (cwd) => this.spawnPtyForPane(cwd),
      mountPaneInDom: (t, idx) => this.mountSecondPaneDom(t as Tab, idx),
      focusPane: (t, idx) => this.focusPaneDom(t as Tab, idx),
    });
    // D14 — reflect the new active-pane index after split.
    this.updateActivePaneClass(tab);
    this.scheduleSave();
    // F3 — update tabbar so the split glyph appears immediately.
    this.renderTabbar();
  }

  focusOtherPane(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab || tab.layout.kind !== "split") return;
    const nextIdx = (1 - tab.layout.activePaneIdx) as 0 | 1;
    focusPaneAction(tab, nextIdx, {
      focusInDom: (t, idx) => this.focusPaneDom(t as Tab, idx),
    });
  }

  swapActivePanes(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab || !this.splitPanesEnabled || tab.layout.kind !== "split") return;
    swapPanesAction(tab, {
      remountSplit: (t) => this.remountSplitDom(t as Tab),
    });
    // D14 — reflect swapped active-pane index.
    this.updateActivePaneClass(tab);
    this.scheduleSave();
    // F3 — keep tabbar glyph tooltip in sync after swap.
    this.renderTabbar();
  }

  /// F1 — convert an existing terminal pane to a Pi chat pane in place.
  /// Disposes the old xterm, kills the old PTY session, spawns a fresh
  /// Pi session, and mounts a PiChatView into the same .pane-host element.
  /// Gated on `experimental.splitPanes`. No-ops if the pane is already "pi".
  async convertPaneToPi(tab: Tab, paneIdx: 0 | 1): Promise<void> {
    if (!this.splitPanesEnabled) return;
    const p = tab.panes[paneIdx];
    if (!p || p.kind === "pi") return;
    if (!p.el) return;

    // 1. Dispose terminal artifacts on this pane.
    p.xterm?.dispose();
    p.xterm = null;

    // 2. Clear the pane-host's DOM children (was the termHost containing xterm).
    while (p.el.firstChild) p.el.removeChild(p.el.firstChild);

    // 3. Kill the old PTY session if one exists (don't leak backend processes).
    if (p.sessionId) {
      try { await closeSession(p.sessionId as SessionId); } catch { /* ignore — already closed */ }
    }

    // 4. Spawn a fresh Pi session.
    const piSessionId = await spawnPiSession({ cwd: p.cwd || undefined });

    // 5. Mount a new PiChatView into the existing pane-host element.
    const view = new PiChatView({ sessionId: piSessionId, host: p.el, cwd: p.cwd || null });

    // 6. Update pane state.
    p.kind = "pi";
    p.sessionId = piSessionId as string;
    p.piView = view;
    p.xterm = null;
    p.executor = "pi";
    p.aomExcluded = true; // Pi sessions never enter AOM

    this.updateActivePaneClass(tab);
    this.scheduleSave();
  }

  // D12 — private DOM/PTY helpers for split-pane actions -----------------------

  private async spawnPtyForPane(cwd: string): Promise<string> {
    const paneId = `p-${crypto.randomUUID()}`;
    // Minimal spawn for D12 — output routing wired in mountSecondPaneDom.
    // The xterm instance is created there; we bind it via pane.xterm after
    // mount so onOutput can reference it.
    let xtermRef: { write: (data: Uint8Array) => void } | null = null;
    const sessionId = await spawnSession(
      {
        onOutput: (chunk) => { xtermRef?.write(chunk); },
        onSessionEvent: (_event) => { /* TODO: D13 — full event wiring */ },
      },
      { initialCwd: cwd, paneId },
    );
    // Store on the pane after split-actions creates it, via a late-binding
    // closure. The mount helper wires xtermRef after open().
    (this as unknown as Record<string, unknown>)[`_xtermRef_${sessionId}`] = (ref: { write: (d: Uint8Array) => void } | null) => { xtermRef = ref; };
    return sessionId as string;
  }

  private mountSecondPaneDom(tab: Tab, paneIdx: 0 | 1): void {
    const block = tab.terminalBlock;
    const layout = tab.layout;
    if (layout.kind !== "split") return;

    // Mark the grid container as split so CSS rules engage.
    block.dataset.split = layout.orientation ?? "horizontal";
    delete block.dataset.layout;
    const initR = layout.ratio ?? 0.5;
    block.style.setProperty("--pane-ratio", `${initR}fr`);
    block.style.setProperty("--pane-complement", `${1 - initR}fr`);

    // Build the splitter strip between the two pane-hosts.
    const splitter = document.createElement("div");
    splitter.className = "pane-splitter";
    block.appendChild(splitter);

    // Build pane-host[1] — the new (second) pane container.
    const paneHost1 = document.createElement("div");
    paneHost1.className = "pane-host";
    block.appendChild(paneHost1);

    const newPane = tab.panes[paneIdx];
    if (!newPane) return;
    newPane.el = paneHost1;

    // Mount a basic xterm Terminal in the new pane (D12 v0).
    // Full feature parity (blocks, recall, finder, webgl, ligatures) follows in D13.
    // Inherit the font from the sibling (first) pane's live xterm so the
    // split pane matches the user's configured font/size/zoom exactly.
    // The sibling was built via buildTerminalOptions() and is kept in
    // sync by applyTerminalSettings(); copying its options avoids an
    // async settings fetch in this synchronous mount path. Falls back to
    // defaults only when there is no sibling terminal.
    const sib = tab.term;
    const term = new Terminal({
      fontFamily: sib?.options.fontFamily ?? DEFAULT_FONT_FAMILY,
      fontSize: sib?.options.fontSize ?? DEFAULT_FONT_SIZE,
      lineHeight: sib?.options.lineHeight ?? 1.2,
      letterSpacing: sib?.options.letterSpacing ?? 0,
      convertEol: true,
      allowTransparency: true,
      theme: termTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    paneFitAddons.set(term, fit);
    term.open(paneHost1);
    fit.fit();
    newPane.xterm = term;

    // Late-bind the output channel so spawnPtyForPane's closure can write
    // output bytes into this xterm. The sessionId is on newPane already.
    const sessionId = newPane.sessionId;
    if (sessionId) {
      const binder = (this as unknown as Record<string, unknown>)[`_xtermRef_${sessionId}`] as ((ref: { write: (d: Uint8Array) => void } | null) => void) | undefined;
      if (binder) {
        binder({ write: (data) => {
          term.write(data);
          if (tab.pane.hidden) tab.wroteWhileHidden = true;
        } });
        delete (this as unknown as Record<string, unknown>)[`_xtermRef_${sessionId}`];
      }
    }

    // Wire data (keystrokes) → PTY.
    const encoder = new TextEncoder();
    term.onData((data) => {
      if (sessionId) {
        void writeToSession(sessionId as SessionId, encoder.encode(data)).catch((e) => {
          // eslint-disable-next-line no-console
          console.error("split-pane write failed", e);
        });
      }
    });

    // Wire resize → backend.
    term.onResize(({ cols, rows }) => {
      if (sessionId) {
        void resizeSession(sessionId as SessionId, cols, rows).catch(() => {});
      }
    });

    // ResizeObserver so fit() fires whenever the pane-host dimensions change.
    let rafId: number | null = null;
    const ro = new ResizeObserver(() => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (paneHost1.offsetWidth === 0 || paneHost1.offsetHeight === 0) return;
        try { fit.fit(); } catch { /* ignore */ }
        if (sessionId) void resizeSession(sessionId as SessionId, term.cols, term.rows).catch(() => {});
      });
    });
    ro.observe(paneHost1);
    // Push cleanup into the parent tab's disposers so closeTab tears it down.
    tab.disposers.push({ dispose: () => { ro.disconnect(); if (rafId !== null) cancelAnimationFrame(rafId); } });
    tab.disposers.push({ dispose: () => { try { term.dispose(); } catch { /* ignore */ } } });

    // D14 — active-pane border: wire pane-1 focus via focusin.
    // xterm's internal textarea bubbles focusin through the pane-host container.
    // Dynamic findIndex lookup so the correct index is used after a pane swap.
    const pane1FocusIn = (): void => {
      const idx = tab.panes.findIndex((p) => p.el === paneHost1);
      if (idx < 0) return;
      if (tab.layout.activePaneIdx === idx) return;
      tab.layout.activePaneIdx = idx as 0 | 1;
      this.updateActivePaneClass(tab);
      this.onActiveContextChange?.(activePane(tab).cwd);
      this.emitActiveMission();
    };
    paneHost1.addEventListener("focusin", pane1FocusIn);
    tab.disposers.push({ dispose: () => paneHost1.removeEventListener("focusin", pane1FocusIn) });

    // F2 — right-click context menu on pane-host 1 (second pane).
    tab.disposers.push(this.installPaneContextMenu(paneHost1, tab, 1));

    // Splitter drag wires to setPaneRatio.
    installPaneSplitter({
      splitter,
      block,
      orientation: layout.orientation ?? "horizontal",
      onRatio: (r) => {
        block.style.setProperty("--pane-ratio", `${r}fr`);
        block.style.setProperty("--pane-complement", `${1 - r}fr`);
      },
      onCommit: (r) => {
        setPaneRatioAction(tab, r);
        this.scheduleSave();
        requestAnimationFrame(() => { try { fit.fit(); } catch { /* ignore */ } });
      },
    });
  }

  private focusPaneDom(tab: Tab, paneIdx: 0 | 1): void {
    const pane = tab.panes[paneIdx];
    if (!pane) return;
    try { pane.xterm?.focus(); } catch { /* ignore */ }
    // PiChatView doesn't expose a public focus() method in v1 — call via
    // duck-typed cast so this compiles and works when a focus() is added later.
    (pane.piView as unknown as { focus?: () => void } | null)?.focus?.();
  }

  private remountSplitDom(tab: Tab): void {
    if (tab.layout.kind !== "split") return;
    const block = tab.terminalBlock;
    const splitter = block.querySelector<HTMLElement>(".pane-splitter");
    if (!splitter) return;
    const pane0 = tab.panes[0];
    const pane1 = tab.panes[1];
    if (!pane0?.el || !pane1?.el) return;
    // Physically reorder DOM children to match panes[] order:
    // pane0.el → splitter → pane1.el. Position the three relative to each
    // other (not via absolute moves) so the result holds regardless of their
    // current order — the old sequence left the splitter at index 0 after a
    // swap, collapsing the flex layout into one blank pane.
    block.insertBefore(splitter, pane1.el);
    block.insertBefore(pane0.el, splitter);
    // Refit both xterms — DOM reorder doesn't trigger ResizeObserver.
    requestAnimationFrame(() => {
      if (pane0.xterm) {
        try { pane0.xterm.refresh(0, (pane0.xterm.rows ?? 1) - 1); } catch { /* ignore */ }
      }
      if (pane1.xterm) {
        try { pane1.xterm.refresh(0, (pane1.xterm.rows ?? 1) - 1); } catch { /* ignore */ }
      }
    });
  }

  // E2 — restore second pane from manifest ----------------------------------------

  /// Spawns a PTY for the persisted second pane, populates tab.panes[1],
  /// mounts the DOM (reusing mountSecondPaneDom), and restores layout
  /// fields. Called from the post-spawn setup loop in restoreFromManifest
  /// when the persisted tab had layout.kind === "split".
  private async restoreSecondPaneForTab(
    tab: Tab,
    persistedPane: SerializedPane,
    layout: SerializedLayout,
  ): Promise<void> {
    // 1. Replay persisted scrollback into a temporary buffer so the second
    //    pane's xterm sees history before the live channel attaches.
    //    We hold a mutable reference updated after mountSecondPaneDom wires
    //    the real xterm. The PTY output closure below captures this ref.
    let secondPaneXterm: { write: (data: Uint8Array) => void } | null = null;
    const replayKey = persistedPane.replay_key;

    try {
      // Replay is best-effort — missing scrollback log is not fatal.
      const tail = await replayScrollback(replayKey);
      // xterm isn't mounted yet; we'll replay again once it is (see step 5).
      // Keep the bytes in a local so we can write them after mount.
      if (tail.byteLength > 0) {
        // Store for deferred write below.
        (this as unknown as Record<string, unknown>)[`_replayTail_${replayKey}`] = tail;
      }
    } catch {
      /* non-fatal */
    }

    // 2. Spawn PTY for the second pane. Output routes through the ref.
    const paneId = persistedPane.id || `p-${crypto.randomUUID()}`;
    const cwd = persistedPane.cwd ?? "";
    let sessionId: string;
    try {
      sessionId = await spawnSession(
        {
          onOutput: (chunk) => { secondPaneXterm?.write(chunk); },
          onSessionEvent: (_event) => { /* TODO: full event wiring (D13-equivalent for restore) */ },
        },
        {
          initialCwd: cwd || null,
          replayKey: replayKey || null,
          paneId,
        },
      ) as string;
    } catch (err) {
      console.warn("E2: failed to spawn PTY for restored second pane", err);
      return;
    }

    // 3. Construct the second Pane object.
    const newPane: import("./pane").Pane = {
      id: paneId,
      kind: "terminal",
      sessionId,
      cwd,
      mission: null,
      operator: persistedPane.operator_id ?? null,
      blocks: [],
      xterm: null,
      piView: null,
      executor: null,
      operatorEnabled: false,
      operatorLive: false,
      operatorSolo: false,
      aomExcluded: persistedPane.aom_excluded ?? false,
      observer_ids: Array.isArray(persistedPane.observer_ids) ? [...persistedPane.observer_ids] : [],
      spawn_id: persistedPane.spawn_id ?? null,
      idleAgent: null,
      busyProc: null,
      replayKey,
      el: null,
    };

    // 4. Set tab.panes[1] and update layout BEFORE mountSecondPaneDom so
    //    the DOM helper reads the correct orientation, ratio, and pane.
    tab.panes = [tab.panes[0]!, newPane] as [import("./pane").Pane, import("./pane").Pane];
    tab.layout = {
      kind: "split",
      orientation: layout.orientation ?? "horizontal",
      activePaneIdx: layout.active === 0 ? 0 : 1,
      ratio: layout.ratio,
    };
    assertLayoutValid(tab);

    // 5. Plant the late-binding hook that mountSecondPaneDom expects.
    //    spawnPtyForPane stores a closure under `_xtermRef_${sessionId}`;
    //    mountSecondPaneDom calls it once xterm is open to wire output.
    //    We replicate the same contract here so we can reuse mountSecondPaneDom.
    (this as unknown as Record<string, unknown>)[`_xtermRef_${sessionId}`] = (ref: { write: (d: Uint8Array) => void } | null) => {
      secondPaneXterm = ref;
      // Flush any scrollback that arrived before xterm was mounted.
      if (ref) {
        const tail = (this as unknown as Record<string, unknown>)[`_replayTail_${replayKey}`] as Uint8Array | undefined;
        if (tail && tail.byteLength > 0) {
          ref.write(tail);
        }
        delete (this as unknown as Record<string, unknown>)[`_replayTail_${replayKey}`];
      }
    };

    // 6. Mount DOM (splitter + pane-host + xterm). This reads tab.panes[1]
    //    (already set above) and calls the xtermRef binder we planted.
    this.mountSecondPaneDom(tab, 1);

    // 7. Restore operator on the backend for the second pane.
    if (newPane.operator && sessionId) {
      sessionSetOperator(sessionId as SessionId, newPane.operator).catch((e) => {
        console.warn("E2: session_set_operator failed for restored second pane", e);
      });
    }

    // 8. Restore AOM exclusion on the backend for the second pane.
    if (sessionId) {
      setAomExcluded(sessionId as SessionId, newPane.aomExcluded)
        .then(() => { /* persisted value applied */ })
        .catch((err) => {
          console.warn("E2: aom_excluded restore failed for second pane", err);
        });
    }

    // 9. Reflect active-pane indicator after second pane is fully mounted.
    this.updateActivePaneClass(tab);
    this.scheduleSave();
  }

  // End E2 restore helpers -------------------------------------------------------

  // D14 — active-pane border follows focus -----------------------------------------

  /// Toggle the `.active` CSS class on each pane-host so D5's
  /// `--accent` border follows the focused pane.
  private updateActivePaneClass(tab: Tab): void {
    // The active-pane border is only meaningful when there's another pane
    // to distinguish it from. Single-pane tabs get no border regardless of
    // focus state.
    const showBorder = tab.layout.kind === "split";
    tab.panes.forEach((p, idx) => {
      if (p.el) {
        p.el.classList.toggle("active", showBorder && idx === tab.layout.activePaneIdx);
      }
    });
  }

  // End D14 active-pane helpers -------------------------------------------------

  // F2 — right-click pane context menu ----------------------------------------

  private installPaneContextMenu(paneHost: HTMLElement, tab: Tab, paneIdx: 0 | 1): IDisposable {
    const onContextMenu = (e: MouseEvent) => {
      // We take over right-click on panes to surface split actions plus saved
      // commands/prompts. Always suppress the native menu and build our own.
      e.preventDefault();
      void this.showPaneContextMenu(e.clientX, e.clientY, tab, paneIdx);
    };
    paneHost.addEventListener("contextmenu", onContextMenu);
    return { dispose: () => paneHost.removeEventListener("contextmenu", onContextMenu) };
  }

  /// Max saved items rendered per section before we stop and point the user at
  /// the panel — keeps the menu from growing taller than the viewport.
  private static readonly PANE_MENU_SECTION_CAP = 8;

  private async showPaneContextMenu(
    x: number,
    y: number,
    tab: Tab,
    paneIdx: 0 | 1,
  ): Promise<void> {
    // Tear down any existing menu first.
    document.querySelector(".pane-context-menu")?.remove();

    const flag = this.splitPanesEnabled;
    const isSingle = tab.layout.kind === "single";
    const isSplit = tab.layout.kind === "split";

    // Resolve the pane the user clicked so commands/prompts target ITS session,
    // not whatever happens to be active elsewhere. `panes` is [Pane] | [Pane,
    // Pane]; a single-pane tab only has index 0.
    const pane = tab.panes[paneIdx] ?? tab.panes[0];
    const sessionId = pane?.sessionId ?? null;
    const groupId = tab.groupId ?? null;

    // Fetch saved items: commands are per-group, prompts are global. Both are
    // best-effort — a failure just omits that section.
    let commands: Command[] = [];
    let prompts: Prompt[] = [];
    try {
      if (groupId) commands = (await projectNotesApi.snapshot(groupId)).commands;
    } catch {
      /* omit commands section */
    }
    try {
      prompts = await promptsApi.list();
    } catch {
      /* omit prompts section */
    }

    const menu = document.createElement("div");
    menu.className = "pane-context-menu";
    menu.style.position = "fixed";
    // The app applies CSS `zoom` to <html>. WebKit reports MouseEvent
    // client coords in visual (zoomed) px, but a fixed element's left/top
    // are local px scaled by zoom — so we must divide the click position by
    // the zoom level, else the menu lands `x * zoom` to the right/down.
    const z = zoom.level();
    menu.style.top = `${y / z}px`;
    menu.style.left = `${x / z}px`;

    const dismiss = () => {
      menu.remove();
      document.removeEventListener("click", outsideClick, true);
      document.removeEventListener("keydown", onKey);
    };

    const addItem = (label: string, action: () => void): void => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pane-context-menu-item";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        dismiss();
        action();
      });
      menu.appendChild(btn);
    };
    const addSection = (label: string): void => {
      if (menu.childElementCount > 0) {
        const sep = document.createElement("div");
        sep.className = "pane-context-menu-separator";
        menu.appendChild(sep);
      }
      const head = document.createElement("div");
      head.className = "pane-context-menu-section";
      head.textContent = label;
      menu.appendChild(head);
    };
    const addHint = (label: string): void => {
      const hint = document.createElement("div");
      hint.className = "pane-context-menu-hint";
      hint.textContent = label;
      menu.appendChild(hint);
    };
    const addCapped = <T>(rows: T[], render: (row: T) => void): void => {
      const cap = TabManager.PANE_MENU_SECTION_CAP;
      for (const row of rows.slice(0, cap)) render(row);
      if (rows.length > cap) addHint(`+${rows.length - cap} more in panel`);
    };

    // Run-selection: when the clicked pane has highlighted text, offer to run
    // it in a fresh tab (paste-and-execute via createTab's initialCommand). Pi
    // panes have no xterm → getSelection() is unavailable → item absent.
    const selection = pane?.xterm?.getSelection()?.trim() ?? "";
    if (selection.length > 0) {
      addItem("Run selection in new tab", () => {
        void this.createTab({
          cwd: pane?.cwd ?? null,
          groupId,
          color: tab.color,
          initialCommand: selection,
        });
      });
    }

    // Split actions (only when the feature is on / a split exists).
    if (flag && isSingle) {
      addItem("Split right", () => void this.splitActivePane("horizontal"));
      addItem("Split down", () => void this.splitActivePane("vertical"));
    }
    if (flag && isSplit) {
      addItem("Swap panes", () => void this.swapActivePanes());
    }
    // Close pane only when there's actually a pane to close (not the tab).
    if (isSplit) {
      addItem("Close pane", () => void this.closePaneByIdx(tab, paneIdx));
    }

    const encoder = new TextEncoder();
    // Commands/prompts need a target session. `sessionId` is a const, so the
    // truthiness narrowing below carries into the click closures.
    if (sessionId) {
      // Commands paste WITHOUT a trailing newline — the user reviews then hits
      // Enter (matches the Commands tab "paste" semantics).
      if (commands.length > 0) {
        addSection("Commands");
        addCapped(commands, (c) =>
          addItem(c.title, () => {
            void writeToSession(sessionId, encoder.encode(c.command));
          }),
        );
      }
      // Prompts send AND submit (bracketed paste + carriage return).
      if (prompts.length > 0) {
        addSection("Prompts");
        addCapped(prompts, (p) =>
          addItem(p.title, () => {
            void sendPromptToSession(sessionId, p.body);
          }),
        );
      }
    }

    if (menu.childElementCount === 0) {
      addHint("No saved commands or prompts");
    }

    document.body.appendChild(menu);

    // Clamp into the viewport — sections can make the menu tall/wide.
    // getBoundingClientRect() and window.inner* are both in visual px, so the
    // comparisons hold; the corrective left/top we write are local px, hence
    // the `/ z` (see the positioning note above).
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    if (rect.bottom > window.innerHeight - margin) {
      menu.style.top = `${Math.max(margin, window.innerHeight - margin - rect.height) / z}px`;
    }
    if (rect.right > window.innerWidth - margin) {
      menu.style.left = `${Math.max(margin, window.innerWidth - margin - rect.width) / z}px`;
    }

    // Dismiss on outside click or Escape.
    const outsideClick = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) dismiss();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") dismiss();
    };
    setTimeout(() => {
      document.addEventListener("click", outsideClick, true);
      document.addEventListener("keydown", onKey);
    }, 0);
  }

  // End F2 pane context menu ---------------------------------------------------

  // End D12 split-pane helpers -------------------------------------------------

  /// 3.7 — fired whenever the *active* tab's cwd context changes:
  ///   - tab switched (new active tab → its cwd)
  ///   - active tab emitted cwd_changed (its new cwd)
  ///   - last tab closed (null)
  /// Set by main.ts to push updates into the StatusBar. Single
  /// listener — there's only one bar.
  public onActiveContextChange: ((cwd: string | null) => void) | null = null;

  /// Any tab's cwd changed, including background worktrees. Spec detection
  /// uses this so a background executor writing docs/specs in its own
  /// worktree still gets a detector before the user switches to it.
  public onAnyTabContextChange: ((cwd: string | null) => void) | null = null;

  /// Mission-side companion to onActiveContextChange. Fires whenever the
  /// active tab's mission changes (set / cleared / hot-reloaded by the
  /// backend file watcher) OR when the active tab itself changes. Pushes
  /// (mission, sessionId) so the StatusBar can render the chip and route
  /// the modal's content fetch to the right session.
  public onActiveMissionChange:
    | ((mission: MissionInfo | null, sessionId: SessionId | null) => void)
    | null = null;

  /// Sibling of `onActiveMissionChange` for the Operator state. Fires
  /// when the active tab's `operatorEnabled` / `operatorLive` flips
  /// OR the active tab itself changes. The status bar uses this to
  /// render an Operator chip in place of the per-tab pill icon that
  /// used to live on every tab.
  public onActiveOperatorChange:
    | ((
        state: { enabled: boolean; live: boolean } | null,
        sessionId: SessionId | null,
      ) => void)
    | null = null;

  /// Fires when the active tab's pinned Operator entity changes — either
  /// because the tab switched or because setTabOperator was called on the
  /// active tab. The status bar uses this to render the operator chip.
  /// Passes null when the active tab has no pinned operator_id or the
  /// cache doesn't have a match yet.
  public onActiveOperatorEntityChange: ((op: Operator | null) => void) | null = null;

  /// Fires when the active tab's bound spawn_id changes — either because
  /// the active tab switched or because setActiveSpawnId was called.
  /// Passes null when the active tab has no bound spawn.
  public onActiveSpawnChange: ((spawnId: string | null) => void) | null = null;

  /// Fires whenever the *active* tab's identity (name, color, or
  /// group membership/color) changes — including activation. Lets the
  /// status bar render a leading chip so the user always knows which
  /// terminal is focused, even when the tabbar is hidden / collapsed.
  public onActiveTabChange:
    | ((info: {
        name: string;
        color: string | null;
        groupName: string | null;
        groupColor: string | null;
      } | null) => void)
    | null = null;

  /// Fires whenever the active tab changes (including when the active tab
  /// closes and there is no replacement). Receives the new active tab's
  /// sessionId, or null when no tab is active. Used by FamiliarPanel to
  /// re-bind its chat/status/audit to the per-tab Familiar.
  public onActiveSessionChange:
    | ((sessionId: SessionId | null) => void)
    | null = null;

  /// Fires whenever the active tab's executor label changes without a tab
  /// activation (e.g. a PTY tab starts/stops `pi`, `claude`, or `codex`).
  /// The Activity sidebar uses this to keep its header in sync while the
  /// session id itself is unchanged.
  public onActiveExecutorChange:
    | ((executor: string | null) => void)
    | null = null;

  /// Fires after every tabbar re-render so the collapsed-rail (the
  /// thin sidebar shown in vertical mode when the user folds the
  /// tabbar) can rebuild its dot/cell view from the same source of
  /// truth. Single-listener — only the rail consumes this.
  public onAfterRender: (() => void) | null = null;

  /// Fires when the user clicks the project-notes icon on a group chip.
  public onOpenProjectNotes: ((groupId: string, groupLabel: string, groupColor: string | null) => void) | null = null;

  /// Fires whenever a tab is activated. Used by main.ts to dismiss any
  /// overlay panels (docs, drafts, capabilities, settings, etc.) so the
  /// terminal becomes visible — selecting a tab implies "show me this
  /// terminal", which is impossible while a fullscreen panel covers it.
  public onTabActivated: (() => void) | null = null;

  /// Fires whenever any tab's operator_id changes (bind, rebind, or unbind).
  /// Subscribers should recompute derived state across the full tab list,
  /// not just the active tab. Use this in the teammate panel to keep the
  /// "active on …" subtitle in sync with bindings made from elsewhere.
  private tabOperatorChangeListeners = new Set<() => void>();

  public subscribeTabOperatorChange(handler: () => void): () => void {
    this.tabOperatorChangeListeners.add(handler);
    return () => {
      this.tabOperatorChangeListeners.delete(handler);
    };
  }

  private emitTabOperatorChange(): void {
    for (const h of this.tabOperatorChangeListeners) h();
  }

  /// Update optional callbacks without reconstructing the manager.
  setOptions(opts: { onOpenProjectNotes?: (groupId: string, groupLabel: string, groupColor: string | null) => void }): void {
    if (opts.onOpenProjectNotes !== undefined) {
      this.onOpenProjectNotes = opts.onOpenProjectNotes;
    }
  }

  /// Returns the group that owns the currently active tab, or null if
  /// the active tab has no group (or no tabs exist).
  activeGroup(): { id: string; name: string; color: string | null; rootDir: string | null } | null {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab?.groupId) return null;
    const g = this.groups.get(tab.groupId);
    return g
      ? { id: g.id, name: g.name, color: g.color ?? null, rootDir: g.rootDir ?? null }
      : null;
  }

  /// Resolve the placement (cwd/group/color) of the tab currently driven by
  /// `operatorId`. Used to spawn a delegated handoff tab in the delegator's
  /// own workspace. Returns null when the operator has no bound tab.
  public placementForOperator(operatorId: string): TabPlacement | null {
    const rows = this.tabs.map((t) => {
      const p = activePane(t);
      return {
        operator: p.operator ?? null,
        cwd: p.cwd,
        groupId: t.groupId ?? null,
        color: t.color ?? null,
      };
    });
    return resolveOperatorPlacement(rows, operatorId);
  }

  /// Lookup the `rootDir` of a group by id. Returns null if the group
  /// doesn't exist or has no root dir set.
  groupRootDirFor(groupId: string): string | null {
    return this.groups.get(groupId)?.rootDir ?? null;
  }

  constructor(
    private readonly tabbarHost: HTMLElement,
    private readonly workspace: HTMLElement,
    newTabBtn: HTMLElement,
    private readonly onAllTabsClosed: () => void,
  ) {
    this.menu = new ContextMenu(document.body);

    // A context menu is plain DOM; the internal browser is a native
    // webview that the OS compositor paints above all DOM regardless of
    // z-index. The webview can't be covered by DOM, so while a menu is
    // open we freeze the active browser into a snapshot <img> and hide
    // the real webview — the menu then renders over the frozen page.
    // Restored on dismiss.
    ContextMenu.onMenusChanged = (bounds): void => {
      const active = this.tabs.find((t) => t.id === this.activeId);
      if (active?.kind !== "browser") return;
      if (bounds) void active.browser?.freeze();
      else active.browser?.unfreeze();
    };

    newTabBtn.addEventListener("click", () => {
      void this.createTab();
    });

    // Operator deletion: drop the cache entry and unpin any tab whose
    // `operator` pointer matched. The backend already unpinned the
    // session record; this keeps the in-memory view consistent so the
    // status bar avatar (which reads via operatorCache) stops rendering
    // the removed operator without waiting for a tab switch / XP tick.
    window.addEventListener("operator:deleted", (ev: Event) => {
      const id = (ev as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      this.operatorCache.delete(id);
      for (const tab of this.tabs) {
        for (const pane of tab.panes) {
          if (pane.operator === id) pane.operator = null;
        }
      }
      // Pull fresh data from backend (handles default re-pin etc.) and
      // re-render. refreshOperatorCache also calls renderTabbar.
      void this.refreshOperatorCache();
    });
    // Right-click on empty tabbar area → "New group" menu. We only
    // catch the event when it isn't on a tab pill or a group chip;
    // those have their own contextmenu handlers that stop here.
    this.tabbarHost.addEventListener("contextmenu", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".tab-btn, .group-chip")) return;
      e.preventDefault();
      this.menu.show(e.clientX, e.clientY, [
        {
          label: "New tab",
          icon: Icons.plus(),
          shortcut: "⌘T",
          onClick: () => {
            void this.createTab();
          },
        },
        {
          label: "New group",
          icon: Icons.folderPlus(),
          shortcut: "⌘⇧G",
          onClick: () => {
            this.createEmptyGroup();
          },
        },
      ]);
    });
    let lastDpr = window.devicePixelRatio;
    window.addEventListener("resize", () => {
      if (window.devicePixelRatio !== lastDpr) {
        lastDpr = window.devicePixelRatio;
        this.rebuildWebglAtlases();
      } else {
        this.refitActive();
      }
    });

    // Glass theme: reposition the sliding indicator on layout changes.
    window.addEventListener("resize", () => positionGlassIndicator(this.tabbarHost));
    this.tabbarHost.addEventListener("scroll", () => positionGlassIndicator(this.tabbarHost));
    this.tabbarHost.addEventListener("transitionend", (e) => {
      const p = (e as TransitionEvent).propertyName;
      if (p === "max-width" || p === "max-height") positionGlassIndicator(this.tabbarHost);
    });

    // When the window moves between monitors with different scaling
    // (common on Samsung 4K + macOS), devicePixelRatio changes. The
    // WebGL glyph atlas was sized for the old DPR — leaving it stale
    // produces overlapping/garbled characters. matchMedia on the
    // current resolution fires once when DPR changes; we rebuild the
    // addon on every tab and refit. We re-arm the listener each time
    // because the media query is bound to the previous DPR value.
    const armDprListener = () => {
      const mql = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`,
      );
      const onChange = () => {
        this.rebuildWebglAtlases();
        armDprListener();
      };
      mql.addEventListener("change", onChange, { once: true });
    };
    armDprListener();

    window.addEventListener("beforeunload", () => {
      for (const tab of this.tabs) {
        for (const p of tab.panes) {
          const sid = p.sessionId;
          if (sid) void closeSession(sid as SessionId).catch(() => {});
        }
      }
      if (this.blockedPollTimer !== null) {
        window.clearInterval(this.blockedPollTimer);
        this.blockedPollTimer = null;
      }
    });
    // 3.14 — 1 Hz poll for the per-tab escalation dot. Independent of
    // the convergence overlay's open/closed lifecycle.
    this.blockedPollTimer = window.setInterval(() => {
      void this.pollBlockedSessions();
    }, 1000);
  }

  /// 3.14 — fetch blocked-session ids and reconcile dots on changed tabs.
  private async pollBlockedSessions(): Promise<void> {
    let ids: string[];
    try {
      // Pass [] — TabManager is the canonical tab metadata source but
      // operator metadata now flows through the snapshot/registry, so the
      // backend returns escalations correctly even without tab hints here.
      ids = await getBlockedSessionIds([]);
    } catch {
      return;
    }
    const next = new Set(ids);
    const changed = new Set<string>();
    for (const id of next) if (!this.blockedSessionIds.has(id)) changed.add(id);
    for (const id of this.blockedSessionIds) if (!next.has(id)) changed.add(id);
    if (changed.size === 0) return;
    this.blockedSessionIds = next;
    for (const tab of this.tabs) {
      const pane = activePane(tab);
      if (!pane.sessionId || !changed.has(pane.sessionId)) continue;
      const pill = this.tabbarHost.querySelector<HTMLElement>(
        `.tab-btn[data-tab-id="${tab.id}"]`,
      );
      if (pill) this.applyEscalationDot(pill, next.has(pane.sessionId));
    }
  }

  /// Mount/remove the pulsing "agent idle waiting" badge on a tab's
  /// chip. Idempotent — always strips any prior badge before re-adding,
  /// so repeated agent_idle_waiting events don't stack DOM nodes.
  private renderTabBadge(tab: Tab): void {
    const pill = this.tabbarHost.querySelector<HTMLElement>(
      `.tab-btn[data-tab-id="${tab.id}"]`,
    );
    if (!pill) return;
    const existing = pill.querySelector(".tab-idle-badge");
    if (existing) existing.remove();
    const idleAgent = activePane(tab).idleAgent;
    if (idleAgent) {
      const badge = document.createElement("span");
      badge.className = "tab-idle-badge";
      badge.title = idleAgent.promptText ?? `${idleAgent.agent} waiting`;
      // Insert before the close button so the pulse sits next to the
      // label, not past the X.
      const close = pill.querySelector(".tab-close");
      if (close) pill.insertBefore(badge, close);
      else pill.appendChild(badge);
    }
  }

  /// Mount/remove the palpitating "app running" dot — green pulse
  /// next to the tab label when a non-shell process occupies the PTY's
  /// foreground pgrp (npm, node, python, cargo, vite, …). Idempotent.
  private renderTabBusyDot(tab: Tab): void {
    const pill = this.tabbarHost.querySelector<HTMLElement>(
      `.tab-btn[data-tab-id="${tab.id}"]`,
    );
    if (!pill) return;
    const existing = pill.querySelector(".tab-busy-dot");
    // Executor tabs (pi, claude, codex, …) already convey "agent running"
    // via the executor chip — the pulse dot is for user-initiated dev
    // tools only. Keep pi homologous to the other agent executors.
    const paneB = activePane(tab);
    const isAgent = tab.kind === "pi" || !!paneB.executor;
    if (paneB.busyProc && !isAgent) {
      if (existing instanceof HTMLElement) {
        existing.title = `${paneB.busyProc} running`;
        return;
      }
      const dot = document.createElement("span");
      dot.className = "tab-busy-dot";
      dot.title = `${paneB.busyProc} running`;
      // Prepend so it sits before the label (left side of the tab).
      pill.insertBefore(dot, pill.firstChild);
    } else if (existing) {
      existing.remove();
    }
  }

  private applyEscalationDot(pill: HTMLElement, blocked: boolean): void {
    const existing = pill.querySelector(".tab-chip__escalation-dot");
    if (blocked && !existing) {
      const dot = document.createElement("span");
      dot.className = "tab-chip__escalation-dot";
      dot.title = "Operator escalated — needs your input";
      pill.appendChild(dot);
    } else if (!blocked && existing) {
      existing.remove();
    }
  }

  /// Refresh the in-memory operator cache from the backend. Should be
  /// called once at boot and after any operator CRUD. Triggers a tab
  /// strip re-render so chips pick up the latest names/colors.
  async refreshOperatorCache(): Promise<void> {
    try {
      const ops = await operatorList();
      this.operatorCache = new Map(ops.map((o) => [o.id, o]));
      this.renderTabbar();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("refreshOperatorCache failed", err);
    }
  }

  /// 3.12 — patch the cached operator's XP in place and re-render the
  /// tab strip. Avoids a full operatorList round-trip on every decision.
  applyOperatorXpUpdate(operatorId: string, xp: number): void {
    const op = this.operatorCache.get(operatorId);
    if (!op) return;
    op.xp = xp;
    this.renderTabbar();
  }

  /// Pointer-event-based drag implementation.
  ///
  /// We don't use HTML5 drag-and-drop because Tauri's WebKit on macOS
  /// doesn't reliably deliver `dragenter`/`dragover`/`drop` events to
  /// elements when the source lives in the same container — they get
  /// swallowed by the OS-level drag-region handling. Pointer events
  /// always fire, so we synthesize the whole flow ourselves.
  private installTabPointerDrag(pill: HTMLElement, tabId: string): void {
    pill.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // left click only
      if ((e.target as HTMLElement).closest(".tab-close")) return;
      if (this.isRenamingTab(tabId)) return;
      // Prevent webkit's default text-selection initiation. Without
      // this, dragging over neighbouring tab labels triggers a text-
      // selection sweep (highlighted "zsh 2", "zsh 3", etc).
      e.preventDefault();
      this.beginPointerDrag(e, { kind: "tab", id: tabId });
    });
  }

  private installChipPointerDrag(chip: HTMLElement, groupId: string): void {
    chip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(".group-chip-chev")) return;
      if (this.isRenamingGroup(groupId)) return;
      e.preventDefault();
      this.beginPointerDrag(e, { kind: "group", id: groupId });
    });
  }

  private beginPointerDrag(e: PointerEvent, src: NonNullable<DragSource>): void {
    const startX = e.clientX;
    const startY = e.clientY;
    let activated = false;
    let ghost: HTMLElement | null = null;
    let sourceEl: HTMLElement | null = null;

    const cleanup = (): void => {
      document.body.classList.remove("tab-drag-active");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      this.tabbarHost
        .querySelectorAll(".tab-drop-left, .tab-drop-right, .group-chip-drop")
        .forEach((el) =>
          el.classList.remove(
            "tab-drop-left",
            "tab-drop-right",
            "group-chip-drop",
          ),
        );
      if (ghost) {
        ghost.remove();
        ghost = null;
      }
      // Clear dragging state BEFORE the live-DOM sweep — render() may
      // have run during the drop (reorder/moveGroup* mutate state) and
      // re-applied `group-chip-dragging`/`tab-dragging` to the freshly
      // built nodes because `this.dragging` was still set. The cached
      // `sourceEl` points at the now-detached pre-render node, so it
      // can't clear the class from the new DOM. Sweep the live tree.
      this.dragging = null;
      this.tabbarHost
        .querySelectorAll(".tab-dragging, .group-chip-dragging, .group-member-dragging")
        .forEach((el) =>
          el.classList.remove(
            "tab-dragging",
            "group-chip-dragging",
            "group-member-dragging",
          ),
        );
      sourceEl = null;
    };

    const findSourceEl = (): HTMLElement | null => {
      const sel =
        src.kind === "tab"
          ? `.tab-btn[data-tab-id="${src.id}"]`
          : `.group-chip[data-group-id="${src.id}"]`;
      return this.tabbarHost.querySelector<HTMLElement>(sel);
    };

    let ghostOriginX = 0;
    let ghostOriginY = 0;

    const activate = (): void => {
      activated = true;
      this.dragging = src;
      // Globally disable text selection + tweak cursor while a drag
      // is in flight. Without this, hovering over neighbour tab labels
      // selects their text mid-drag.
      document.body.classList.add("tab-drag-active");
      sourceEl = findSourceEl();
      if (sourceEl) {
        sourceEl.classList.add(
          src.kind === "tab" ? "tab-dragging" : "group-chip-dragging",
        );
        const vertical = document.body.classList.contains("tabbar-left");
        if (src.kind === "group") {
          // Lift the chip + every member pill together as one card so
          // the user feels they're carrying the whole group, matching
          // the tab drag's "picked up" affordance.
          const memberIds = this.tabs
            .filter((t) => t.groupId === src.id)
            .map((t) => t.id);
          const memberEls: HTMLElement[] = [];
          for (const id of memberIds) {
            const el = this.tabbarHost.querySelector<HTMLElement>(
              `.tab-btn[data-tab-id="${id}"]`,
            );
            if (el) memberEls.push(el);
          }
          const parts = [sourceEl, ...memberEls];
          const rects = parts.map((el) => el.getBoundingClientRect());
          const minLeft = Math.min(...rects.map((r) => r.left));
          const minTop = Math.min(...rects.map((r) => r.top));
          const maxRight = Math.max(...rects.map((r) => r.right));
          const maxBottom = Math.max(...rects.map((r) => r.bottom));

          const wrap = document.createElement("div");
          wrap.className = "tab-ghost tab-ghost-group";
          wrap.style.width = `${maxRight - minLeft}px`;
          wrap.style.height = `${maxBottom - minTop}px`;

          parts.forEach((el, i) => {
            const clone = el.cloneNode(true) as HTMLElement;
            clone.classList.remove(
              "tab-drop-left",
              "tab-drop-right",
              "group-chip-drop",
            );
            clone.querySelector(".tab-drop-anchor")?.remove();
            clone.style.position = "absolute";
            clone.style.left = `${rects[i].left - minLeft}px`;
            clone.style.top = `${rects[i].top - minTop}px`;
            clone.style.width = `${rects[i].width}px`;
            clone.style.height = `${rects[i].height}px`;
            clone.style.margin = "0";
            wrap.appendChild(clone);
          });

          // Dim member pills at their source positions, just like the
          // chip itself (so the whole run reads as "lifted").
          for (const el of memberEls) el.classList.add("group-member-dragging");

          ghost = wrap;
          ghostOriginX = minLeft;
          ghostOriginY = minTop;
          ghost.style.left = `${ghostOriginX}px`;
          ghost.style.top = `${ghostOriginY}px`;
          document.body.appendChild(ghost);
          void vertical; // currently unused, layout is absolute either way
        } else {
          // Wrap the clone in a `.tab-ghost` div (same shape as the group
          // path) rather than tagging the `.tab-btn` clone itself. A clone
          // that is *also* a `.tab-btn` inherits per-theme overrides — e.g.
          // CRT's `body.tab-style-crt .tab-btn { background: transparent }`
          // (specificity 0,2,1) beats `.tab-ghost` (0,1,0), making the
          // picked-up card invisible. The wrapper isn't a `.tab-btn`, so its
          // card chrome (bg/border/shadow) survives in every tab theme.
          const rect = sourceEl.getBoundingClientRect();
          const wrap = document.createElement("div");
          wrap.className = "tab-ghost";
          wrap.style.width = `${rect.width}px`;
          wrap.style.height = `${rect.height}px`;
          const clone = sourceEl.cloneNode(true) as HTMLElement;
          clone.classList.remove("tab-drop-left", "tab-drop-right", "group-chip-drop");
          clone.querySelector(".tab-drop-anchor")?.remove();
          clone.style.position = "absolute";
          clone.style.left = "0";
          clone.style.top = "0";
          clone.style.width = `${rect.width}px`;
          clone.style.height = `${rect.height}px`;
          clone.style.margin = "0";
          wrap.appendChild(clone);
          ghost = wrap;
          ghostOriginX = rect.left;
          ghostOriginY = rect.top;
          ghost.style.left = `${ghostOriginX}px`;
          ghost.style.top = `${ghostOriginY}px`;
          document.body.appendChild(ghost);
        }
      }
    };

    const updateIndicators = (clientX: number, clientY: number): {
      kind: "pill" | "chip" | null;
      el: HTMLElement | null;
      side: "left" | "right";
    } => {
      this.tabbarHost
        .querySelectorAll(".tab-drop-left, .tab-drop-right, .group-chip-drop")
        .forEach((el) => {
          el.classList.remove(
            "tab-drop-left",
            "tab-drop-right",
            "group-chip-drop",
          );
          el.querySelector(".tab-drop-anchor")?.remove();
        });

      const vertical = document.body.classList.contains("tabbar-left");
      const sideOf = (rect: DOMRect): "left" | "right" =>
        vertical
          ? clientY < rect.top + rect.height / 2
            ? "left"
            : "right"
          : clientX < rect.left + rect.width / 2
            ? "left"
            : "right";

      const target = document.elementFromPoint(clientX, clientY) as
        | HTMLElement
        | null;
      const chip = target?.closest<HTMLElement>(".group-chip") ?? null;
      if (chip) {
        const groupId = chip.dataset.groupId;
        if (
          groupId &&
          !(src.kind === "group" && src.id === groupId) &&
          !(src.kind === "tab" &&
            this.tabs.find((t) => t.id === src.id)?.groupId === groupId)
        ) {
          const side = sideOf(chip.getBoundingClientRect());
          if (src.kind === "group") {
            // Group → group: show the same left/right rail + anchor
            // used for tab pills, so the drop target reads identically
            // to a tab reorder.
            chip.classList.add(side === "left" ? "tab-drop-left" : "tab-drop-right");
            const anchor = document.createElement("span");
            anchor.className = "tab-drop-anchor";
            chip.appendChild(anchor);
          } else {
            // Tab → chip: add-to-group, full-chip highlight.
            chip.classList.add("group-chip-drop");
          }
          return { kind: "chip", el: chip, side };
        }
      }

      const pill = target?.closest<HTMLElement>(".tab-btn") ?? null;
      if (pill) {
        const tabId = pill.dataset.tabId;
        if (!tabId) return { kind: null, el: null, side: "left" };
        const tab = this.tabs.find((t) => t.id === tabId);
        if (!tab) return { kind: null, el: null, side: "left" };
        if (src.kind === "tab" && src.id === tabId) {
          return { kind: null, el: null, side: "left" };
        }
        if (src.kind === "group" && tab.groupId === src.id) {
          return { kind: null, el: null, side: "left" };
        }
        const side = sideOf(pill.getBoundingClientRect());
        pill.classList.add(side === "left" ? "tab-drop-left" : "tab-drop-right");
        // Anchor dot at top of the indicator — visual cue for landing point.
        const anchor = document.createElement("span");
        anchor.className = "tab-drop-anchor";
        pill.appendChild(anchor);
        return { kind: "pill", el: pill, side };
      }
      return { kind: null, el: null, side: "left" };
    };

    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!activated) {
        if (dx * dx + dy * dy < 5 * 5) return;
        activate();
      }
      if (ghost) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(2deg) scale(0.96)`;
      }
      updateIndicators(ev.clientX, ev.clientY);
    };

    const onUp = (ev: PointerEvent): void => {
      if (!activated) {
        cleanup();
        return;
      }
      const drop = updateIndicators(ev.clientX, ev.clientY);
      if (drop.kind === "chip" && drop.el) {
        const groupId = drop.el.dataset.groupId!;
        if (src.kind === "tab") {
          this.addTabToGroup(src.id, groupId);
        } else if (src.kind === "group" && src.id !== groupId) {
          this.moveGroupRelativeToGroup(src.id, groupId, drop.side);
        }
      } else if (drop.kind === "pill" && drop.el) {
        const tabId = drop.el.dataset.tabId!;
        const tab = this.tabs.find((t) => t.id === tabId);
        if (!tab) {
          cleanup();
          return;
        }
        if (src.kind === "tab" && src.id !== tabId) {
          this.reorder(src.id, tabId, drop.side);
        } else if (src.kind === "group" && tab.groupId !== src.id) {
          this.moveGroupRelativeToTab(src.id, tabId, drop.side);
        }
      }
      cleanup();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  hasTabs(): boolean {
    return this.tabs.length > 0;
  }

  /// "AOM is alive" proactive step: when AOM transitions on, every
  /// tab with a mission attached AND no user-set name gets renamed
  /// to a slug derived from the mission file. Pure derived rename —
  /// no model call, no backend hop. Makes the tab bar instantly
  /// readable ("docs-hub", "mission-tracking") instead of a wall of
  /// "zsh 1, zsh 2, zsh 3". User-set names are NEVER overwritten.
  applyMissionTabNames(): void {
    let touched = false;
    for (const tab of this.tabs) {
      const mission = activePane(tab).mission;
      if (!mission) continue;
      if (tab.customName && tab.customName.trim().length > 0) continue;
      const slug = slugFromMissionPath(mission.path);
      if (!slug) continue;
      tab.customName = slug;
      touched = true;
    }
    if (touched) {
      this.renderTabbar();
      // Names that just changed may belong to AOM-excluded tabs; the
      // popover keys on `name` so push to keep its labels current.
      this.pushExcludedToStatusBar();
    }
  }

  /// Re-sync every tab's per-session Operator + mission state from
  /// the backend. Called after the AOM toggle so tabs auto-enabled
  /// by AOM (or reverted on aom_stop) immediately reflect the new
  /// state, and after `mission-changed` events so tooltips match
  /// disk content.
  async refreshAllOperatorState(): Promise<void> {
    for (const tab of this.tabs) {
      const pane = activePane(tab);
      const sessionId = pane.sessionId;
      if (!sessionId) continue;
      const enabled = await isOperatorEnabled(sessionId as SessionId).catch(
        () => pane.operatorEnabled,
      );
      const live = enabled
        ? await isOperatorLive(sessionId as SessionId).catch(() => pane.operatorLive)
        : false;
      const excluded = enabled
        ? await isAomExcluded(sessionId as SessionId).catch(() => pane.aomExcluded)
        : false;
      const mission = await getSessionMission(sessionId as SessionId).catch(
        () => pane.mission,
      );
      const wasEnabled = pane.operatorEnabled;
      pane.operatorEnabled = enabled;
      pane.operatorLive = live;
      pane.aomExcluded = excluded;
      pane.mission = mission;
      // Auto-spawn a Familiar when the operator transitions OFF→ON,
      // gated on the user's familiars-enabled setting (BYOK).
      // Failures are non-fatal — the operator stays enabled either way.
      if (!wasEnabled && enabled) {
        try {
          const s = await getSettings();
          if (s.familiars_enabled) {
            await ensureFamiliarFor(sessionId);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("ensureFamiliarFor failed", err);
        }
      }
    }
    this.renderTabbar();
    this.pushExcludedToStatusBar();
    // Re-push the active tab's mission + operator state too — file
    // watcher / AOM auto-enable cycles can change either without a
    // tab activation.
    this.emitActiveMission();
    this.emitActiveOperator();
    this.emitActiveSpawn();
  }

  /// Push the active tab's identity (name + group + colors) to the
  /// status bar. Safe to call any time the tab strip changes — does
  /// nothing if no listener is attached.
  private emitActiveTab(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) {
      this.onActiveTabChange?.(null);
      this.onActiveSessionChange?.(null);
      scoreSetCurrentSession(null, null, null, this.activeWorkspaceName);
      return;
    }
    const group = tab.groupId ? this.groups.get(tab.groupId) ?? null : null;
    this.onActiveTabChange?.({
      name: tabDisplayName(tab),
      color: tab.color,
      groupName: group?.name ?? null,
      groupColor: group?.color ?? null,
    });
    const pane = tab ? activePane(tab) : null;
    this.onActiveSessionChange?.(pane?.sessionId ?? null);
    scoreSetCurrentSession(
      pane?.sessionId ?? null,
      pane?.cwd ?? null,
      group?.name ?? null,
      this.activeWorkspaceName,
    );
  }

  /// Push the active tab's mission to whoever is listening (status bar).
  /// Safe to call any time mission state may have shifted.
  private emitActiveMission(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    const pane = tab ? activePane(tab) : null;
    this.onActiveMissionChange?.(pane?.mission ?? null, pane?.sessionId ?? null);
  }

  /// Same idea as emitActiveMission but for Operator state. Called
  /// after activation, after toggleOperator/toggleOperatorLive, and
  /// after AOM bulk-refreshes the per-tab state.
  private emitActiveOperator(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) {
      this.onActiveOperatorChange?.(null, null);
      this.onActiveOperatorEntityChange?.(null);
      return;
    }
    const pane = activePane(tab);
    this.onActiveOperatorChange?.(
      { enabled: pane.operatorEnabled, live: pane.operatorLive },
      pane.sessionId,
    );
    const opEntity = pane.operator ? (this.operatorCache.get(pane.operator) ?? null) : null;
    this.onActiveOperatorEntityChange?.(opEntity);
  }

  /// Emit the active tab's bound spawn_id to whoever is listening.
  private emitActiveSpawn(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    const pane = tab ? activePane(tab) : null;
    this.onActiveSpawnChange?.(pane?.spawn_id ?? null);
  }

  /// Returns the spawn_id bound to the currently active tab, or null.
  activeSpawnId(): string | null {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    const pane = tab ? activePane(tab) : null;
    return pane?.spawn_id ?? null;
  }

  /// Bind (or unbind) a spawn to the active tab in-memory, persist, and
  /// fire onActiveSpawnChange. No-op when there is no active tab.
  setActiveSpawnId(spawnId: string | null): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return;
    activePane(tab).spawn_id = spawnId;
    this.scheduleSave();
    this.emitActiveSpawn();
  }

  /// Focus the active tab's terminal. Public so overlays (Recall
  /// palette, etc.) can return keyboard focus to xterm after they
  /// inject — without this the next keystroke lands on the overlay
  /// or wherever browser focus drifted.
  focusActive(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return;
    if (tab.kind === "pi") {
      // Pi tabs focus their own textarea; nothing for the terminal path.
      const ta = tab.pane.querySelector<HTMLTextAreaElement>(".pi-chat-textarea");
      ta?.focus();
      return;
    }
    try {
      tab.term?.focus();
    } catch {
      /* term may be disposed mid-call */
    }
  }

  /// Select all output in the active tab's terminal. Wired to the ⌘A
  /// menu route in main.ts (the native Select All can't reach xterm's
  /// buffer). No-op for Pi tabs, which have no terminal.
  selectAllActiveTerminal(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab || tab.kind === "pi") return;
    try {
      tab.term?.selectAll();
    } catch {
      /* term may be disposed mid-call */
    }
  }

  /// Refit the active tab's terminal. Public so main.ts can call it
  /// after the settings page closes (workspace was hidden + restored).
  refitActive(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return;
    if (tab.kind === "pi") return; // no terminal to refit
    const term = tab.term;
    const fit = tab.fit;
    if (!term || !fit) return;
    requestAnimationFrame(() => {
      // Drop any active selection before reflowing: xterm caches selection
      // by buffer coords, and fit() can change cols/rows, leaving the
      // highlight rectangle floating on the wrong row after resize.
      try {
        term.clearSelection();
      } catch {
        /* ignore */
      }
      try {
        fit.fit();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("fit failed on refitActive", err);
      }
      const sessId = activePane(tab).sessionId;
      if (sessId) void resizeSession(sessId as SessionId, term.cols, term.rows).catch(() => {});
      term.focus();
    });
  }

  /// Dispose and recreate the WebGL addon on every tab. Used when DPR
  /// changes (monitor switch / scaling change) — the existing texture
  /// atlas was sized for the old DPR and renders garbled otherwise.
  rebuildWebglAtlases(): void {
    for (const tab of this.tabs) {
      if (tab.kind === "pi" || !tab.term) continue;
      const term = tab.term;
      if (tab.webgl) {
        try {
          tab.webgl.dispose();
        } catch {
          /* ignore */
        }
        try {
          const next = new WebglAddon();
          term.loadAddon(next);
          tab.webgl = next;
        } catch {
          tab.webgl = null;
        }
      } else {
        // DOM/canvas renderer: invalidate the glyph atlas by nudging
        // fontSize. xterm has no public clearTextureAtlas for non-WebGL
        // renderers, but option setters force a renderer re-measure.
        try {
          const size = term.options.fontSize ?? DEFAULT_FONT_SIZE;
          term.options.fontSize = size + 0.0001;
          term.options.fontSize = size;
        } catch {
          /* ignore */
        }
      }
      requestAnimationFrame(() => {
        try {
          tab.fit?.fit();
        } catch {
          /* ignore */
        }
        term.refresh(0, term.rows - 1);
        const sid = activePane(tab).sessionId;
        if (sid) void resizeSession(sid as SessionId, term.cols, term.rows).catch(() => {});
      });
    }
  }

  /// Push terminal font/size into every open tab. Called from main.ts
  /// when the user saves Settings (no restart needed).
  ///
  /// xterm.js caches glyph metrics + a WebGL texture atlas based on the
  /// current font. Changing fontFamily/fontSize without invalidating
  /// these caches makes new glyphs render against the OLD cell width —
  /// the visible result is "spread out" characters. To fix:
  ///   1. Wait for `document.fonts.ready` so the browser has actually
  ///      loaded the new font before xterm measures it.
  ///   2. Set options.
  ///   3. Clear the WebGL texture atlas if the addon exposes it.
  ///   4. Refit (recomputes cols/rows from new cell dims).
  ///   5. Resync the backend PTY.
  applyTerminalSettings(cfg: TerminalConfig): void {
    const family = cfg.font_family || DEFAULT_FONT_FAMILY;
    const baseSize = cfg.font_size || DEFAULT_FONT_SIZE;
    const size = baseSize * zoom.level();

    void document.fonts.ready.then(() => {
      // Secondary split panes keep their own xterm on pane.xterm; the
      // main loop below only touches tab.term (the first pane). Mirror
      // the font onto any second pane so a Settings save reaches both
      // halves of a split. These panes are basic (no ligatures/webgl),
      // so only the font options + a refit are needed.
      for (const tab of this.tabs) {
        for (const pane of tab.panes) {
          const pterm = pane.xterm;
          if (!pterm || pterm === tab.term) continue;
          try {
            pterm.options.fontFamily = family;
            pterm.options.fontSize = size;
            pterm.options.letterSpacing = scaledLetterSpacing(cfg.letter_spacing ?? 0);
            pterm.options.lineHeight = cfg.line_height ?? 1.2;
            const fit = paneFitAddons.get(pterm);
            if (fit) {
              fit.fit();
              if (pane.sessionId) {
                void resizeSession(pane.sessionId as SessionId, pterm.cols, pterm.rows).catch(() => {});
              }
            }
          } catch {
            /* ignore */
          }
        }
      }
      for (const tab of this.tabs) {
        if (tab.kind === "pi" || !tab.term) continue;
        const term = tab.term;
        try {
          term.options.fontFamily = family;
          term.options.fontSize = size;
          term.options.letterSpacing = scaledLetterSpacing(cfg.letter_spacing ?? 0);
          term.options.lineHeight = cfg.line_height ?? 1.2;

          // Ligatures pipeline: canvas renderer + custom font-ligatures
          // joiner. Both must be installed/disposed together.
          const wantLigaturesLive = !!cfg.ligatures;
          if (wantLigaturesLive && !tab.canvas) {
            try {
              const c = new CanvasAddon();
              term.loadAddon(c);
              tab.canvas = c;
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn("canvas load failed", err);
            }
            if (tab.canvas) {
              void attachLigatures(term, family).then((h) => {
                if (h) tab.ligatures = h;
              });
            }
          } else if (!wantLigaturesLive && (tab.canvas || tab.ligatures)) {
            try {
              tab.ligatures?.dispose();
            } catch {
              /* ignore */
            }
            tab.ligatures = null;
            try {
              tab.canvas?.dispose();
            } catch {
              /* ignore */
            }
            tab.canvas = null;
          } else if (wantLigaturesLive && tab.canvas && !tab.ligatures) {
            // Font family changed while already in canvas mode: re-attach
            // ligatures against the new font.
            void attachLigatures(term, family).then((h) => {
              if (h) tab.ligatures = h;
            });
          }

          // Surefire WebGL refresh: dispose the addon + load a fresh
          // one. clearTextureAtlas() alone is a silent no-op in xterm
          // 5.x when the font changes after open(); the dispose-and-
          // recreate dance forces a full atlas rebuild against the
          // new font metrics.
          if (tab.webgl) {
            try {
              tab.webgl.dispose();
            } catch {
              /* ignore */
            }
            try {
              const next = new WebglAddon();
              tab.term.loadAddon(next);
              tab.webgl = next;
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn(
                "WebGL recreate failed; falling back to canvas",
                err,
              );
              tab.webgl = null;
            }
          }

          requestAnimationFrame(() => {
            try {
              tab.fit?.fit();
            } catch {
              /* ignore */
            }
            term.refresh(0, term.rows - 1);
            const sid2 = activePane(tab).sessionId;
            if (sid2) void resizeSession(sid2 as SessionId, term.cols, term.rows).catch(() => {});
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("apply terminal settings failed for tab", tab.id, err);
        }
      }
    });
  }

  closeActive(): void {
    if (this.activeId) this.closeTab(this.activeId);
  }

  /// Close the active tab unconditionally (escape hatch for ⌘⇧W).
  closeActiveTab(): void {
    if (this.activeId) this.closeTab(this.activeId);
  }

  /// ⌘W semantic when split-panes flag is ON:
  /// - Split tab → collapse the active pane (kill its PTY, unmount DOM).
  /// - Single-pane tab → close the whole tab.
  async closePaneByIdx(tab: Tab, paneIdx: 0 | 1): Promise<void> {
    if (!tab) return;
    if (tab.layout.kind === "single") {
      await this.closeTab(tab.id);
      return;
    }
    const result = await closePaneAction(tab, paneIdx, {
      killSession: async (sid) => {
        try {
          await closeSession(sid as SessionId);
        } catch {
          /* ignore */
        }
      },
      unmountPaneFromDom: (t, idx) => this.unmountSecondPaneDom(t as Tab, idx),
      focusPane: (t, idx) => this.focusPaneDom(t as Tab, idx),
    });
    if (result === "close-tab") {
      await this.closeTab(tab.id);
      return;
    }
    // D14 — after collapsing to single-pane, reset the border to pane 0.
    this.updateActivePaneClass(tab);
    this.scheduleSave();
    // F3 — remove the split glyph from tabbar after pane is closed.
    this.renderTabbar();
  }

  async closeActivePaneOrTab(): Promise<void> {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return;
    await this.closePaneByIdx(tab, tab.layout.activePaneIdx);
  }

  private unmountSecondPaneDom(tab: Tab, paneIdx: 0 | 1): void {
    const pane = tab.panes[paneIdx];
    // Remove the pane-host element.
    if (pane?.el) {
      pane.el.remove();
      pane.el = null;
    }
    // Dispose xterm to release WebGL context and listeners.
    if (pane?.xterm) {
      try { pane.xterm.dispose(); } catch { /* ignore */ }
      pane.xterm = null;
    }
    // Dispose piView if present.
    (pane?.piView as unknown as { dispose?: () => void } | null)?.dispose?.();

    const block = tab.terminalBlock;
    // Remove the pane-splitter sibling.
    block.querySelector(".pane-splitter")?.remove();
    // Reverse what mountSecondPaneDom did to the block dataset / style.
    // mountSecondPaneDom: sets data-split, deletes data-layout, sets --pane-ratio + --pane-complement.
    // After collapse we want the block to look like a single-pane block again.
    delete block.dataset.split;
    block.dataset.layout = "single";
    block.style.removeProperty("--pane-ratio");
    block.style.removeProperty("--pane-complement");
  }

  /// Backend session id (Ulid string) for whichever tab is currently
  /// in the foreground, or null when no tabs exist.
  activeSessionId(): SessionId | null {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    return (tab ? activePane(tab).sessionId : null) as SessionId | null;
  }

  /// Returns the sessionId of the currently active tab that belongs to
  /// `groupId`, or null if no tab in that group is active.
  activeSessionInGroup(groupId: string): string | null {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab || tab.groupId !== groupId) return null;
    return activePane(tab).sessionId;
  }

  /// Count of tabs that AOM is currently driving — operator-enabled
  /// tabs (AOM auto-enables on every non-excluded tab on start, and
  /// reverts on stop, so this count IS the AOM-active set while AOM
  /// is on).
  aomActiveTabCount(): number {
    return this.tabs.filter((t) => activePane(t).operatorEnabled).length;
  }

  /// Most recent cwd reported by the active session via OSC 7
  /// (`cwd_changed`). Used by the Recall palette so the backend
  /// can apply its cwd bonus.
  activeCwd(): string | null {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    return tab ? activePane(tab).cwd : null;
  }

  /// Snapshot of every open shell tab — feeds the multi-source mention
  /// picker's "Sessions" tab. Pi tabs are skipped (no PTY blocks).
  /// `shell` and `block_count` aren't tracked in TabManager yet, so we
  /// emit safe placeholders the picker can render around.
  listOpenSessions(): import("../teammate/mention-sources").OpenSessionInfo[] {
    return this.tabs
      .filter((t) => t.kind === "shell")
      .map((t, idx) => {
        const pane = activePane(t);
        return {
          session_id: (pane.sessionId ?? "").toString(),
          short_id:   (pane.sessionId ?? "").toString().slice(-6),
          cwd:        pane.cwd,
          tab_index:  idx + 1,
          shell:      "zsh",
          last_command: null,
          block_count:  0,
        };
      });
  }

  /// True when at least one browser tab is open. Drives the titlebar globe's
  /// toggle/active state (the globe targets a tab, not a rail panel).
  hasBrowserTab(): boolean {
    return this.tabs.some((t) => t.kind === "browser");
  }

  /// Id of the first open browser tab, or null. Used by the globe toggle to
  /// close an existing browser tab instead of spawning another.
  firstBrowserTabId(): string | null {
    return this.tabs.find((t) => t.kind === "browser")?.id ?? null;
  }

  /// Kind of the active tab. Pi tabs do not have the terminal-owned
  /// Blocks/Files rail; callers use this to avoid selecting a per-shell
  /// sidebar that cannot render for the current pane.
  activeKind(): "shell" | "pi" | "browser" | null {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    return tab?.kind ?? null;
  }

  /// Name of the agent executor currently running in the active tab
  /// (claude/copilot/codex/opencode/…), or null when the shell is idle
  /// or running a non-agent command. ⌘P/Recall is suppressed while
  /// this is non-null — agent TUIs don't have a shell prompt to insert
  /// history into.
  activeExecutor(): string | null {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    return tab ? activePane(tab).executor : null;
  }

  /// ⌘F handler — opens the in-terminal finder for the active tab.
  /// No-op on Pi tabs (no xterm buffer to search) and during the brief
  /// window before the finder is constructed.
  openFinder(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab || tab.kind !== "shell") return;
    tab.finder?.open();
  }

  /// Open `path` in the active tab's editor and (optionally) jump to a
  /// specific 1-based line. Used by the global search palette: clicking
  /// a hit routes through here so the editor pane swaps into view, the
  /// file loads, and the textarea scrolls to the matched line.
  /// No-ops when there's no active tab.
  openFileAtLine(path: string, line?: number): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return;
    if (tab.kind === "pi") return; // Pi tabs have no editor
    tab.openEditor?.(path, line !== undefined ? { line } : undefined);
  }

  activateByIndex(index: number): void {
    const tab = this.tabs[index];
    if (tab) this.activate(tab.id);
  }

  /// Lookup tab metadata by the last-6-char session id stored on
  /// historical rows (operator decisions, blocks). For OPEN tabs returns
  /// `open: true` plus the live display name + current mission. For
  /// CLOSED tabs falls back to the localStorage cache so the panel can
  /// still render "zsh 2" instead of `…3BDWPP`. Null only when the
  /// short id has never been seen on this machine.
  tabBySessionShort(short: string): {
    displayName: string;
    missionPath: string | null;
    open: boolean;
  } | null {
    const tab = this.tabs.find((t) => activePane(t).sessionId?.slice(-6) === short);
    if (tab) {
      return {
        displayName: tabDisplayName(tab),
        missionPath: activePane(tab).mission?.path ?? null,
        open: true,
      };
    }
    const cached = this.sessionNameCache.get(short);
    if (cached) {
      return { displayName: cached.name, missionPath: null, open: false };
    }
    return null;
  }

  /// Stamp `short → name` in the cache. Idempotent; called on tab
  /// create, rename, and just before close so the most current name
  /// survives the session.
  private rememberSessionName(sessionId: string, name: string): void {
    const short = sessionId.slice(-6);
    this.sessionNameCache.set(short, { name, ts: Date.now() });
    saveSessionNameCache(this.sessionNameCache);
    // Mirror to the backend so AOM startup can build a mnemonic
    // `covenant-{tab-slug}-{ulid6}` Claude session name.
    void setTabTitle(sessionId as SessionId, name).catch((err) => {
      console.warn("setTabTitle failed", err);
    });
    // Tell the notch overlay the *display* label (group › tab) so the
    // pill shows "COVENANT › notch" instead of just "notch". AOM keeps
    // using the bare name above for slug generation.
    const tab = this.tabs.find((t) => activePane(t).sessionId === sessionId);
    const group = tab?.groupId ? this.groups.get(tab.groupId) : null;
    const label = group ? `${group.name} › ${name}` : name;
    void notchSetLabel(sessionId as SessionId, label).catch(() => {});
  }

  /// 3.6 — focus the tab whose backend session matches `sessionId`. Used
  /// by the OS-notification click handler so clicking an "Operator paused"
  /// popup brings the user back to the originating tab. No-op if the tab
  /// has been closed since the notification fired.
  activateBySessionId(sessionId: SessionId): boolean {
    const tab = this.tabs.find((t) => activePane(t).sessionId === sessionId);
    if (!tab) return false;
    this.activate(tab.id);
    return true;
  }

  /// Focus a tab by the last-6-chars session short used in operator
  /// decision rows (which only persist `session_id_short`). Returns false
  /// if no live tab matches — the originating session has been closed.
  activateBySessionShort(short: string): boolean {
    const tab = this.tabs.find((t) => activePane(t).sessionId?.slice(-6) === short);
    if (!tab) return false;
    this.activate(tab.id);
    return true;
  }

  /// Per-session hints for the Convergence snapshot — one per live pane,
  /// across every tab (split tabs contribute both panes). Public + typed
  /// so the convergence bridge never reaches into private fields through
  /// an unchecked cast; that cast silently broke when Phase C moved
  /// `sessionId` from `Tab` onto `Pane`. See spec 2026-06-06.
  listSessionHints(): SessionHint[] {
    return sessionHintsFromTabs(this.tabs);
  }

  activateRelative(delta: number): void {
    if (this.tabs.length === 0) return;
    const currentIdx = this.tabs.findIndex((t) => t.id === this.activeId);
    if (currentIdx < 0) {
      this.activate(this.tabs[0].id);
      return;
    }
    const len = this.tabs.length;
    const nextIdx = ((currentIdx + delta) % len + len) % len;
    this.activate(this.tabs[nextIdx].id);
  }

  /// Spawn a new tab. `opts` is used by the persistence restore path
  /// to recreate a tab as it was: pre-existing custom name, color,
  /// group, and a `cwd` that the spawned shell will `cd` into on its
  /// first prompt. For brand-new tabs (the `+` button, ⌘T), opts is
  /// undefined and the shell starts in `$HOME`.
  async createTab(opts?: {
    customName?: string | null;
    color?: string | null;
    groupId?: string | null;
    cwd?: string | null;
    initialCommand?: string | null;
    // Restore path uses this when spawning many tabs in parallel: each
    // createTab still self-pushes/wires, but activation + tabbar render
    // are deferred to the caller so they happen ONCE in manifest order.
    skipActivate?: boolean;
    /// Stable scrollback key from a previous run. Brand-new tabs leave
    /// this undefined and a fresh key is generated.
    replayKey?: string | null;
  }): Promise<Tab | null> {
    const id = crypto.randomUUID();
    const replayKey = opts?.replayKey ?? id.replace(/-/g, "").slice(0, 26);
    // Keep the shared spawn counter advancing (pi/browser tabs share it),
    // even though shell tabs now title themselves from the cwd basename.
    this.nextSeq++;

    const pane = document.createElement("div");
    pane.className = "tab-pane";
    pane.dataset.tabId = id;

    const termHost = document.createElement("div");
    termHost.className = "tab-terminal";

    const terminalBlock = document.createElement("div");
    terminalBlock.className = "terminal-block";
    terminalBlock.dataset.layout = "single";

    const paneHost0 = document.createElement("div");
    paneHost0.className = "pane-host";
    paneHost0.appendChild(termHost);
    terminalBlock.appendChild(paneHost0);
    pane.appendChild(terminalBlock);

    // Splitter between terminal and editor. Hidden when the editor is
    // closed. When the editor opens, the user can drag this to resize
    // the terminal/editor split; persists per-window in localStorage so
    // the next open recovers the last layout.
    const editorSplitter = document.createElement("div");
    editorSplitter.className = "editor-splitter";
    editorSplitter.hidden = true;
    editorSplitter.title = "Drag to resize";
    pane.appendChild(editorSplitter);

    const editorHost = document.createElement("div");
    editorHost.className = "editor-host";
    editorHost.hidden = true;
    pane.appendChild(editorHost);

    const blocksHost = document.createElement("div");
    blocksHost.className = "tab-blocks blocks-host";
    // Pre-apply the persisted collapsed state so the sidebar column
    // renders at its final width (28px or 240px) from the first paint.
    // Without this, the pane briefly shows the default 240px column and
    // animates to 28px once BlockManager's constructor (which runs later,
    // after async terminal setup) adds the class — visible as a flicker
    // for every tab restored during a workspace switch.
    if (localStorage.getItem("covenant.blocks-sidebar-collapsed") === "1") {
      blocksHost.classList.add("blocks-collapsed");
    }
    pane.appendChild(blocksHost);

    // Keep the new pane hidden until activate() reveals it. hideAllPanes
    // only iterates this.tabs (the new tab isn't pushed yet), so without
    // this the freshly appended pane would be visible during the ~hundreds
    // of ms of async setup below.
    pane.hidden = true;
    this.hideAllPanes();
    this.workspace.appendChild(pane);

    // Read terminal font/size from settings each spawn so a Save in
    // ⌘, applies on the next new tab without restart. Existing tabs
    // are updated live via applyTerminalSettings().
    const termCfg = await getSettings()
      .then((s) => s.terminal)
      .catch(() => null);
    const term = new Terminal(buildTerminalOptions(termCfg));
    const fit = new FitAddon();
    term.loadAddon(fit);
    const handleLinkClick = (uri: string): void => {
      const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) ? uri : `http://${uri}`;
      if (this.experimentalInternalBrowser) {
        void this.openBrowserTab(target);
      } else {
        void openUrl(target).catch((err) => console.error("openUrl failed", err));
      }
    };
    term.loadAddon(new WebLinksAddon((_e, uri) => handleLinkClick(uri)));
    // Cmd+F search — addon paints decorations for every match; the
    // floating finder UI is created right after term.open() so it can
    // mount inside the tab's pane.
    const search = new SearchAddon();
    term.loadAddon(search);
    // Bare host:port (e.g. `localhost:54725`, `127.0.0.1:3000`) — the
    // default addon only catches schemed URLs, so register a second
    // matcher and prepend http:// at click time.
    const bareHostPortRe =
      /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s)<>"']*)?/g;
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1)?.translateToString(true);
        if (!line) return callback(undefined);
        const links: { range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate: () => void }[] = [];
        let m: RegExpExecArray | null;
        bareHostPortRe.lastIndex = 0;
        while ((m = bareHostPortRe.exec(line)) !== null) {
          const start = m.index + 1;
          const end = m.index + m[0].length;
          links.push({
            range: { start: { x: start, y }, end: { x: end, y } },
            text: m[0],
            activate: () => handleLinkClick(m![0]),
          });
        }
        callback(links);
      },
    });
    term.open(termHost);
    // Suppress the macOS WebView native context menu (Cut/Copy/Paste/
    // Show Writing Tools/…) on right-click inside the terminal. xterm
    // doesn't preventDefault on contextmenu itself, so the OS menu
    // would otherwise pop over whatever right-click handling we wire
    // up later. Scoped to the terminal host so the rest of the app
    // (file tree, tab strip, inputs) keeps its native menus intact.
    termHost.addEventListener("contextmenu", (e) => e.preventDefault());
    // WebGL addon disabled — its glyph atlas doesn't pick up
    // fontFamily changes from term.options reliably, and both
    // WebGL and Canvas addons produce garbled glyphs when
    // allowTransparency is on (required for vibrancy).
    // DOM renderer is the only one that works correctly here.
    const webgl: WebglAddon | null = null;
    // Opt-in ligatures pipeline. Character joiners require the canvas
    // (or webgl) renderer; the DOM renderer ignores them. The ligature
    // ranges come from font-ligatures parsing the user's actual TTF —
    // see ../terminal/ligatures.ts. The async font-bytes fetch races
    // with tab creation; we kick it off here but only store the
    // handle once the tab object exists (see `this.tabs.push(tab)`
    // below — `attachLigaturesLater` runs after).
    let canvas: CanvasAddon | null = null;
    const ligatures: LigatureHandle | null = null;
    if (termCfg?.ligatures) {
      try {
        canvas = new CanvasAddon();
        term.loadAddon(canvas);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("canvas addon failed; ligatures disabled", err);
        canvas = null;
      }
    }
    const wantLigatures = !!(termCfg?.ligatures && canvas);
    const ligatureFontStack = termCfg?.font_family || DEFAULT_FONT_FAMILY;
    fit.fit();
    // Re-fit once webfonts have actually loaded: the initial fit above
    // measures glyphs against fallback metrics, which can leave term.rows
    // one too high once the real font lands and cell height grows. The
    // overflow rows render under the status bar (clipped by `overflow:
    // hidden`) but stay selectable — the symptom of "scroll won't reach
    // the bottom".
    void document.fonts.ready.then(() => {
      try {
        fit.fit();
      } catch {
        /* ignore — tab may already be disposed */
      }
    });

    const initialCwd =
      opts?.cwd ??
      (opts?.groupId ? this.groups.get(opts.groupId)?.rootDir ?? null : null) ??
      this.activeWorkspaceRootDir?.() ??
      null;

    let blocks: BlockManager | null = null;
    let recall: RecallManager | null = null;
    // Closure-captured so onSessionEvent (set BEFORE spawn returns)
    // can update the tab's cwd as `cwd_changed` events arrive.
    const tabRef: { current: Tab | null } = { current: null };
    const paneId = `p-${crypto.randomUUID()}`;
    let sessionId: SessionId;
    // Closure flag for the optional initial-command injection. We
    // write the command on the FIRST prompt_start (i.e. once the
    // shell has finished its rc-file work and shown a usable prompt).
    let initialCmdPending: string | null = opts?.initialCommand ?? null;
    // Replay persisted scrollback into xterm BEFORE the live channel
    // attaches. Brand-new tabs see an empty array; reopened tabs see
    // the last ~2 MiB of bytes from their previous session.
    try {
      const tail = await replayScrollback(replayKey);
      if (tail.byteLength > 0) {
        term.write(tail);
      }
    } catch (err) {
      console.warn("replay_scrollback failed", err);
    }
    try {
      sessionId = await spawnSession(
        {
          onOutput: (chunk) => {
            term.write(chunk);
            if (tabRef.current?.pane.hidden) tabRef.current.wroteWhileHidden = true;
          },
          onSessionEvent: (event) => {
            blocks?.handleEvent(event);
            // Track which agentic executor (if any) is running in this
            // tab — the status-bar brand chip reads it for the active
            // tab. Detection mirrors the Rust `detect_executor` so the
            // operator panel and the bar agree on the name.
            if (event.kind === "block_started") {
              const next = detectExecutor(event.command);
              if (tabRef.current) {
                const p = tabRef.current.panes[0];
                if (p.executor !== next) {
                  p.executor = next;
                  if (tabRef.current.id === this.activeId && tabRef.current.layout.activePaneIdx === 0) {
                    this.statusBar?.setExecutor(next);
                    this.onActiveExecutorChange?.(next);
                  }
                  // Tear down any Recall popup the moment an executor
                  // takes over the PTY: its buffer is now stale shell
                  // input that no longer maps to a prompt.
                  if (next) recall?.notifyPromptStart();
                  // Drop any pulse dot left over from a pre-agent dev
                  // tool; while an executor owns the PTY, the chip is
                  // the canonical "running" indicator.
                  if (next && p.busyProc) {
                    p.busyProc = null;
                    this.renderTabBusyDot(tabRef.current);
                  }
                }
              }
            } else if (event.kind === "block_finished") {
              if (tabRef.current) {
                const p = tabRef.current.panes[0];
                if (p.executor !== null) {
                  p.executor = null;
                  if (tabRef.current.id === this.activeId && tabRef.current.layout.activePaneIdx === 0) {
                    this.statusBar?.setExecutor(null);
                    this.onActiveExecutorChange?.(null);
                  }
                }
              }
            }
            // Recall reacts to two flavors of session event:
            //   - prompt_start: shell drew a fresh prompt → reset
            //     our shadow input buffer.
            //   - cwd_changed: keep the cwd hint up to date so the
            //     backend can apply its cwd bonus.
            if (event.kind === "prompt_start") {
              recall?.notifyPromptStart();
              if (initialCmdPending !== null) {
                const cmd = initialCmdPending;
                initialCmdPending = null;
                const enc = new TextEncoder();
                void writeToSession(sessionId, enc.encode(`${cmd}\n`)).catch(
                  (err) => console.error("initial command write failed", err),
                );
              }
            } else if (event.kind === "agent_idle_waiting") {
              if (tabRef.current) {
                const idleState = {
                  agent: event.agent,
                  sinceMs: Date.now() - event.quiet_ms,
                  promptText: event.prompt_text,
                };
                tabRef.current.panes[0].idleAgent = idleState;
                this.renderTabBadge(tabRef.current);
              }
            } else if (event.kind === "agent_resumed") {
              if (tabRef.current) {
                tabRef.current.panes[0].idleAgent = null;
                this.renderTabBadge(tabRef.current);
              }
            } else if (event.kind === "foreground_changed") {
              if (tabRef.current) {
                // Agent CLIs (copilot/claude/codex/…) routinely spawn
                // dev-tool subprocesses (`node`, `next`, `npm`, …) that
                // briefly own the PTY foreground. Those slip past the
                // Rust allowlist and light the pulse dot, but the
                // executor chip already conveys "agent running here" —
                // doubling up is just noise. Keep the dot strictly for
                // user-initiated dev tools.
                const pFg = tabRef.current.panes[0];
                const isAgent = !!pFg.executor;
                pFg.busyProc = event.busy && !isAgent ? event.name : null;
                this.renderTabBusyDot(tabRef.current);
              }
            } else if (event.kind === "title_suggested") {
              // AI-generated activity label. Only update the auto title;
              // a user-set customName always wins (see tabDisplayName).
              if (tabRef.current && event.title.trim().length > 0) {
                tabRef.current.defaultTitle = event.title.trim();
                this.renderTabbar();
              }
            } else if (event.kind === "cwd_changed") {
              if (tabRef.current) {
                tabRef.current.panes[0].cwd = event.cwd ?? "";
              }
              this.onAnyTabContextChange?.(event.cwd);
              recall?.setCwd(event.cwd);
              if (tabRef.current?.structure?.isVisible()) {
                void tabRef.current.structure.setCwd(event.cwd);
              }
              this.scheduleSave();
              // Status bar: only push when this tab is the visible one AND
              // pane[0] is the active pane. If the user focused pane[1],
              // pane[0]'s cwd change must not overwrite the bar.
              if (
                tabRef.current &&
                tabRef.current.id === this.activeId &&
                tabRef.current.layout.activePaneIdx === 0
              ) {
                this.onActiveContextChange?.(event.cwd);
                this.emitActiveTab();
              }
            }
          },
        },
        // Persistence-restored cwd is set on the SHELL itself before
        // spawn — no visible `cd <path>` line, no bogus block. If
        // the dir is gone, backend silently falls back to $HOME.
        // Fallback: when no explicit cwd, inherit the group's rootDir
        // (if any) so all tabs in a configured group share a default.
        {
          initialCwd,
          replayKey,
          paneId,
        },
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("spawn_session failed", err);
      term.dispose();
      this.workspace.removeChild(pane);
      if (!opts?.skipActivate && this.activeId)
        this.activate(this.activeId, { skipIfSame: false });
      return null;
    }
    blocks = new BlockManager(blocksHost, sessionId);
    recall = new RecallManager(
      blocksHost,
      (data) => writeToSession(sessionId, data),
      {
        onShouldShow: (show) => {
          // Contextual swap: while Recall has results, it claims the
          // entire sidebar regardless of whether Blocks or Files
          // (StructureTree) is currently active. On hide, restore
          // whichever view the user had selected.
          // The blocks-host width stays the same either way, so no
          // terminal refit needed.
          const t = tabRef.current;
          const view = t?.sidebarView ?? "blocks";
          if (show) {
            blocks!.hide();
            t?.structure?.hide();
            recall!.show();
          } else {
            if (view === "recall") return; // user pinned recall — keep it
            recall!.hide();
            if (view === "blocks") blocks!.show();
            else t?.structure?.show();
          }
        },
        focusTerminal: () => {
          // After a Recall click injects, give xterm focus back so the
          // next keystroke (typically Enter) lands on the prompt — not
          // on the Recall list item that was just clicked.
          try {
            term.focus();
          } catch {
            /* term may have been disposed mid-click race */
          }
        },
      },
    );

    // Sidebar nav strip — sits at the top of the sidebar column. Two
    // entries: Blocks (default) and Structure. Recall stays contextual.
    const navEl = document.createElement("nav");
    navEl.className = "sidebar-nav";

    // Title-on-left, icon-only switch on the right. The title reflects
    // the active view; tooltips/aria-label carry the label for icons.
    const navTitle = document.createElement("span");
    navTitle.className = "sidebar-nav-title";
    navTitle.textContent = "Blocks";

    const navSwitch = document.createElement("div");
    navSwitch.className = "sidebar-nav-switch";

    const navBlocks = document.createElement("button");
    navBlocks.type = "button";
    navBlocks.className = "sidebar-nav-btn sidebar-nav-active";
    navBlocks.setAttribute("aria-label", "Blocks");
    navBlocks.innerHTML = Icons.terminal({ size: 14 });
    attachTooltip(navBlocks, "Blocks");

    const navStructure = document.createElement("button");
    navStructure.type = "button";
    navStructure.className = "sidebar-nav-btn";
    navStructure.setAttribute("aria-label", "Files");
    navStructure.innerHTML = Icons.folder({ size: 14 });
    attachTooltip(navStructure, "Files");

    const navRecall = document.createElement("button");
    navRecall.type = "button";
    navRecall.className = "sidebar-nav-btn";
    navRecall.setAttribute("aria-label", "Recall");
    navRecall.innerHTML = Icons.history({ size: 14 });
    attachTooltip(navRecall, "Recall");

    navSwitch.appendChild(navBlocks);
    navSwitch.appendChild(navStructure);
    navSwitch.appendChild(navRecall);
    navEl.appendChild(navTitle);
    navEl.appendChild(navSwitch);
    blocksHost.insertBefore(navEl, blocksHost.firstChild);

    // Editor splitter: when the editor is open, the pane uses a 4-col
    // grid `<terminal> <splitter> <editor> <sidebar>`. The user drags
    // `editorSplitter` to set the terminal column width in pixels;
    // we persist it in localStorage and re-apply on every editor open.
    // CSS handles the default ratio when no override is set.
    const SPLITTER_PREF_KEY = "covenant.editor.terminal-width";
    const sidebarWidth = (): number => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue("--right-sidebar-w");
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 ? n : 240;
    };
    const TERMINAL_MIN = 200;
    const EDITOR_MIN = 280;
    const SPLITTER_PX = 4;
    const PANE_SPLITTER_PX = 4;  // pane-splitter thickness (must match CSS in styles.css)

    const applyTerminalWidth = (px: number | null): void => {
      if (px === null) {
        pane.style.gridTemplateColumns = "";
        return;
      }
      const sidebar = sidebarWidth();
      const horizontalSplit =
        tabRef.current?.layout.kind === "split" &&
        tabRef.current.layout.orientation === "horizontal";
      const terminalBlockMin = horizontalSplit
        ? 2 * TERMINAL_MIN + PANE_SPLITTER_PX
        : TERMINAL_MIN;
      const clamped = Math.max(
        terminalBlockMin,
        Math.min(px, pane.offsetWidth - sidebar - EDITOR_MIN - SPLITTER_PX),
      );
      pane.style.gridTemplateColumns =
        `${clamped}px ${SPLITTER_PX}px 1fr ${sidebar}px`;
    };

    const persistedTerminalWidth = (): number | null => {
      try {
        const v = localStorage.getItem(SPLITTER_PREF_KEY);
        if (v === null) return null;
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    };

    editorSplitter.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = termHost.offsetWidth;
      // Disable text selection + show resize cursor globally during drag
      // so the cursor doesn't flicker between col-resize and text-select
      // when the mouse moves over the editor / terminal panes.
      const prevUserSelect = document.body.style.userSelect;
      const prevCursor = document.body.style.cursor;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      // Disable pointer events on the panes so the mouse stays glued to
      // the splitter — without this the cursor "snags" on xterm or the
      // editor textarea (each captures pointer events) and the drag
      // feels janky/stuck. setPointerCapture is the modern equivalent
      // but pointer-events:none is a stronger lock that also prevents
      // accidental clicks landing inside the panes mid-drag.
      pane.classList.add("editor-splitter-dragging");
      try {
        editorSplitter.setPointerCapture(e.pointerId);
      } catch {
        /* not all browsers support; pointer-events:none above is the fallback */
      }

      // Batch style updates to one per animation frame. Without this,
      // a mousemove storm (200+/s on macOS Retina) triggers a reflow
      // on every event — the grid + xterm + file tree all relayout
      // and the drag feels like it's dragging through molasses.
      let pendingX: number | null = null;
      let rafScheduled = false;
      const flush = () => {
        rafScheduled = false;
        if (pendingX === null) return;
        const next = startWidth + (pendingX - startX);
        pendingX = null;
        applyTerminalWidth(next);
      };

      const onMove = (ev: PointerEvent) => {
        pendingX = ev.clientX;
        if (!rafScheduled) {
          rafScheduled = true;
          requestAnimationFrame(flush);
        }
      };
      const onUp = (ev: PointerEvent) => {
        document.body.style.userSelect = prevUserSelect;
        document.body.style.cursor = prevCursor;
        pane.classList.remove("editor-splitter-dragging");
        try {
          editorSplitter.releasePointerCapture(ev.pointerId);
        } catch {
          /* ignore */
        }
        editorSplitter.removeEventListener("pointermove", onMove);
        editorSplitter.removeEventListener("pointerup", onUp);
        editorSplitter.removeEventListener("pointercancel", onUp);
        // Make sure any in-flight rAF lands before we read the final value.
        if (pendingX !== null) flush();
        // Persist the final settled width — read back from the inline
        // style so we save the CLAMPED value, not the raw drag delta.
        const m = pane.style.gridTemplateColumns.match(/^(\d+)px/);
        if (m) {
          try {
            localStorage.setItem(SPLITTER_PREF_KEY, m[1]);
          } catch {
            /* ignore */
          }
        }
        // xterm needs to remeasure cells after the column width changed.
        requestAnimationFrame(() => {
          try {
            fit.fit();
          } catch {
            /* ignore */
          }
        });
      };
      // pointer events on the splitter itself — capture ensures we
      // get them even when the cursor leaves the splitter element.
      editorSplitter.addEventListener("pointermove", onMove);
      editorSplitter.addEventListener("pointerup", onUp);
      editorSplitter.addEventListener("pointercancel", onUp);
    });

    const showSplitter = (visible: boolean): void => {
      editorSplitter.hidden = !visible;
      if (visible) {
        applyTerminalWidth(persistedTerminalWidth());
      } else {
        applyTerminalWidth(null);
      }
    };

    const editor = new StructureEditor(editorHost, {
      toast: (msg, severity) => {
        if (severity === "error") console.error(msg);
        pushInfoToast({ message: msg });
      },
      onClose: () => {
        editorHost.hidden = true;
        showSplitter(false);
        refitAfterLayoutTransition();
        structure.setActivePath(null);
      },
      onOpenPath: (path) => openEditor(path),
      onApplySpec: (path) => {
        void (async () => {
          const tab = this.tabs.find((t) => t.id === this.activeId);
          if (!tab) return;
          try {
            await this.setMissionPathForActiveTab(path);
            const name = path.split("/").pop() ?? path;
            window.dispatchEvent(
              new CustomEvent("toast", {
                detail: { message: `Spec attached: ${name}`, severity: "info" },
              }),
            );
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("apply spec failed", err);
          }
        })();
      },
    });

    // Refit the terminal twice: once on the next rAF (for the
    // first frame of the grid transition) and again on transitionend
    // (when the columns have fully settled at their target widths).
    // Skipping the second refit leaves xterm with stale cell metrics
    // because the rAF measurement happens before the 220ms tween
    // finishes, so the final terminal size never gets remeasured.
    const refitAfterLayoutTransition = (): void => {
      requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      });
      const onEnd = (ev: TransitionEvent) => {
        if (ev.target !== pane) return;
        if (ev.propertyName !== "grid-template-columns") return;
        pane.removeEventListener("transitionend", onEnd);
        try {
          fit.fit();
          void resizeSession(sessionId, term.cols, term.rows);
        } catch {
          /* ignore */
        }
      };
      pane.addEventListener("transitionend", onEnd);
    };

    // Single source of truth for "open this path in the editor".
    // Used both by the file-tree click and the global-search-palette
    // jump path (via `tab.openEditor` exposed below). Centralizing
    // the dance — editor host visibility, splitter restore, file
    // load, terminal refit — keeps the two callers in lockstep.
    const openEditor = (path: string, opts?: { line?: number }): void => {
      editorHost.hidden = false;
      // Editor now overlays the terminal (CSS position:absolute) — no
      // splitter, no grid reflow, no terminal refit needed on open.
      showSplitter(false);
      void editor.open(path, opts);
      structure.setActivePath(path);
    };

    const structure = new StructureTree(
      blocksHost,
      (path) => openEditor(path),
      (change) => {
        // React to filesystem mutations from the tree's context menu.
        // If the open editor is pointing at the affected path, reroute
        // it (rename) or close it (trash) so the user isn't left with
        // a stale view.
        const open = editor.getCurrentPath();
        if (!open) return;
        if (change.kind === "rename" && open === change.oldPath) {
          openEditor(change.newPath);
        } else if (change.kind === "trash" && open === change.path) {
          editor.close();
        }
      },
    );

    // Native OS file drag-drop: drop files from Finder onto the tree to
    // copy them into the targeted folder.
    attachFileDrop(structure);

    const switchSidebar = (view: "blocks" | "structure" | "recall") => {
      const t = tabRef.current;
      if (t) t.sidebarView = view;
      navBlocks.classList.toggle("sidebar-nav-active", view === "blocks");
      navStructure.classList.toggle("sidebar-nav-active", view === "structure");
      navRecall.classList.toggle("sidebar-nav-active", view === "recall");
      // Every switch hides all three first so Recall (which can also
      // auto-show contextually while typing) never visually stacks on
      // top of Blocks/Files when the user flips views.
      blocks!.hide();
      structure.hide();
      recall!.hide();
      if (view === "blocks") {
        navTitle.textContent = "Blocks";
        blocks!.show();
      } else if (view === "structure") {
        navTitle.textContent = "Files";
        structure.show();
        if (t) { const twCwd = activePane(t).cwd; if (twCwd) void structure.setCwd(twCwd); }
      } else {
        navTitle.textContent = "Recall";
        recall!.show();
        // Pinned-Recall: focus the search input so the user can type
        // immediately after clicking the button.
        recall!.focusSearch();
      }
    };

    navBlocks.addEventListener("click", () => switchSidebar("blocks"));
    navStructure.addEventListener("click", () => switchSidebar("structure"));
    navRecall.addEventListener("click", () => switchSidebar("recall"));

    // Global view switch from the title bar. Every tab listens, but
    // only the active tab is visible — UI looks correct either way.
    window.addEventListener("sidebar-view:set", (e) => {
      const v = (e as CustomEvent<{ view: "blocks" | "structure" | "recall" }>).detail.view;
      switchSidebar(v);
    });

    // Refit + resize after the BlockManager has applied its collapsed
    // class — the sidebar width can change the terminal area, so xterm
    // needs to remeasure.
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
    });

    await resizeSession(sessionId, term.cols, term.rows).catch((e) =>
      // eslint-disable-next-line no-console
      console.error("initial resize failed", e),
    );

    const encoder = new TextEncoder();
    const dataDispose = term.onData((data) => {
      // Forward to the PTY, then to Recall's shadow buffer. Order
      // matters only insofar as we want the keystroke to land in
      // the shell first; Recall's response is best-effort.
      void writeToSession(sessionId, encoder.encode(data)).catch((e) =>
        // eslint-disable-next-line no-console
        console.error("write failed", e),
      );
      // Suppress Recall while an agent executor (claude/copilot/codex/
      // opencode/…) holds the PTY. Their TUIs don't run a shell prompt,
      // so the suggestion popup is just noise overlaying the agent UI.
      if (!tabRef.current || !activePane(tabRef.current).executor) {
        recall?.notifyInput(data);
      }
    });
    // Shift+Enter → Alt+Enter (`\x1b\r`). xterm.js's default for
    // Shift+Enter is the same as Enter (just `\r`), which submits in
    // CLI agents like Claude Code / Codex. Sending ESC+CR is the
    // widely-accepted "newline without submit" sequence those agents
    // recognize. Returning false stops xterm from also sending `\r`.
    term.attachCustomKeyEventHandler((ev) => {
      // Ctrl+1..9 is a global quick-spawn shortcut (handled in main.ts).
      // Let it bubble to the window handler instead of sending a stray
      // control char to the PTY.
      if (
        ev.type === "keydown" &&
        ev.ctrlKey &&
        !ev.metaKey &&
        !ev.altKey &&
        !ev.shiftKey &&
        /^[1-9]$/.test(ev.key)
      ) {
        return false;
      }
      if (
        ev.type === "keydown" &&
        ev.key === "Enter" &&
        ev.shiftKey &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        !ev.altKey
      ) {
        void writeToSession(sessionId, encoder.encode("\x1b\r")).catch((e) =>
          // eslint-disable-next-line no-console
          console.error("shift-enter write failed", e),
        );
        ev.preventDefault();
        return false;
      }
      return true;
    });

    const resizeDispose = term.onResize(({ cols, rows }) => {
      void resizeSession(sessionId, cols, rows).catch((e) =>
        // eslint-disable-next-line no-console
        console.error("resize failed", e),
      );
    });

    // Refit when the terminal container itself resizes — not just the
    // window. Status bar / AOM banner / sidebar / docs overlay all change
    // termHost's size without firing window `resize`. Without this, xterm
    // keeps stale rows and the viewport stops short of the bottom (user
    // can't scroll to last line). rAF-debounced to coalesce bursts.
    let rafId: number | null = null;
    // Last host size this observer acted on. 0x0 means the pane was
    // display:none — the next non-zero pass is a reveal (tab switch),
    // which activate() already fits/nudges; re-nudging here repainted
    // the terminal right after it became visible (visible flicker).
    let lastRoWidth = 0;
    let lastRoHeight = 0;
    const ro = new ResizeObserver(() => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const roWidth = termHost.offsetWidth;
        const roHeight = termHost.offsetHeight;
        const revealing = lastRoWidth === 0 || lastRoHeight === 0;
        lastRoWidth = roWidth;
        lastRoHeight = roHeight;
        if (roWidth === 0 || roHeight === 0) return;
        try {
          fit.fit();
        } catch {
          /* ignore — tab may be hidden or disposing */
          return;
        }
        // Second pass on the next frame: layout transitions (status bar
        // mounting, splitter settle, sidebar collapse) can shift the
        // terminal's effective height by a sub-cell amount after the
        // first fit. Without this, the bottom row sometimes renders
        // under the status bar — invisible but selectable.
        requestAnimationFrame(() => {
          const prevCols = term.cols;
          const prevRows = term.rows;
          try {
            fit.fit();
          } catch {
            return;
          }
          // If fit() resolved to the same dimensions (sub-cell change),
          // nudge to force xterm to re-sync its viewport scroll area —
          // but never on a reveal, where activate() owns the refit.
          const dimsChanged = term.cols !== prevCols || term.rows !== prevRows;
          if (shouldRoNudge({ revealing, dimsChanged, rows: prevRows })) {
            try {
              term.resize(prevCols, prevRows - 1);
              term.resize(prevCols, prevRows);
            } catch {
              /* ignore */
            }
          }
          void resizeSession(sessionId, term.cols, term.rows).catch((e) =>
            // eslint-disable-next-line no-console
            console.error("resize failed (RO)", e),
          );
        });
      });
    });
    ro.observe(termHost);
    const roDispose = {
      dispose: () => {
        ro.disconnect();
        if (rafId !== null) cancelAnimationFrame(rafId);
      },
    };

    // DPR change refit. Moving the window between displays (Retina ↔
    // external) — or the user changing system zoom — shifts
    // devicePixelRatio without firing window `resize` or the
    // ResizeObserver. xterm's glyph cache then drifts a fraction of a
    // cell, term.rows stays stale, and the scrollbar tops out a row or
    // two above the real bottom until the next manual resize.
    let dprMql: MediaQueryList | null = null;
    const watchDpr = (): void => {
      dprMql?.removeEventListener("change", onDprChange);
      dprMql = window.matchMedia(
        `(resolution: ${window.devicePixelRatio}dppx)`,
      );
      dprMql.addEventListener("change", onDprChange);
    };
    const onDprChange = (): void => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      void resizeSession(sessionId, term.cols, term.rows).catch(() => {});
      term.refresh(0, term.rows - 1);
      watchDpr(); // re-arm against the new DPR
    };
    watchDpr();
    const dprDispose = {
      dispose: () => dprMql?.removeEventListener("change", onDprChange),
    };

    // Last-resort viewport re-sync on wheel. Catches drift cases no
    // observer fires for (data written while hidden, font reflow mid-
    // stream, hidden-tab writes wrapped against stale metrics).
    //
    // Important: do NOT resize on every "scrollTop didn't change" wheel
    // event. At the top/bottom of a large scrollback that is a normal
    // boundary condition; resizing there makes the terminal look like it
    // is re-rendering and can trap the user away from the bottom. Only
    // intervene when the viewport has room to move in the wheel direction.
    let wheelRefitTimer: ReturnType<typeof setTimeout> | null = null;
    // Cache the viewport element — querySelector on every 60-120 Hz
    // wheel tick is wasteful. The element is stable after term.open().
    const cachedVp = termHost.querySelector<HTMLElement>(".xterm-viewport");
    const onWheelStuck = (ev: WheelEvent): void => {
      if (ev.deltaY === 0) return;
      const vp = cachedVp;
      if (!vp) return;

      const before = vp.scrollTop;
      const maxBefore = Math.max(0, vp.scrollHeight - vp.clientHeight);
      const wantsDown = ev.deltaY > 0;
      const atBoundary = wantsDown ? before >= maxBefore - 2 : before <= 2;
      if (atBoundary) return;

      // Trackpads emit high-frequency sub-line deltas (1–10px at ~120Hz).
      // xterm accumulates those internally and scrolls once a full line is
      // reached. If we treat "viewport didn't move yet" as stuck and inject
      // term.scrollLines(±1) on top, the next xterm flush double-scrolls →
      // visible vibration. Only intervene for deltas big enough that a real
      // line *should* have moved.
      const pxPerLineNow = term.rows > 0 ? vp.clientHeight / term.rows : 16;
      if (Math.abs(ev.deltaY) < pxPerLineNow) return;

      // Check after xterm/browser wheel handling has had a chance to
      // update the viewport.
      requestAnimationFrame(() => {
        const after = vp.scrollTop;
        if (before !== after) return; // scroll worked — viewport is fine

        const maxAfter = Math.max(0, vp.scrollHeight - vp.clientHeight);
        const nowAtBoundary = wantsDown ? after >= maxAfter - 2 : after <= 2;
        if (nowAtBoundary) return;

        // Debounce a geometry rebuild. We used to also inject
        // term.scrollLines() here to "rescue" missed deltas, but on slow
        // trackpad scrolling xterm's internal sub-line accumulator hadn't
        // flushed yet — the injection raced with xterm's own flush a frame
        // later and produced a double-step flicker. The rebuild fallback
        // alone is enough for the genuinely-stuck cases this exists for.
        requestAnimationFrame(() => {
          if (vp.scrollTop !== before) return;
          if (wheelRefitTimer !== null) return;
          wheelRefitTimer = setTimeout(() => { wheelRefitTimer = null; }, 750);

          const { cols, rows } = term;
          const keepTop = vp.scrollTop;
          try {
            fit.fit();
          } catch {
            /* ignore */
          }
          // If fit() didn't change dimensions, nudge to force re-sync,
          // then restore the user's scroll position as closely as the new
          // scroll area allows.
          if (term.cols === cols && term.rows === rows && rows > 1) {
            try {
              term.resize(cols, rows - 1);
              term.resize(cols, rows);
              vp.scrollTop = Math.min(
                keepTop,
                Math.max(0, vp.scrollHeight - vp.clientHeight),
              );
            } catch {
              /* ignore */
            }
          }
        });
      });
    };
    termHost.addEventListener("wheel", onWheelStuck, { passive: true });
    const wheelDispose = {
      dispose: () => {
        termHost.removeEventListener("wheel", onWheelStuck);
        if (wheelRefitTimer !== null) clearTimeout(wheelRefitTimer);
      },
    };

    // Pick up the backend's per-session enabled state (driven by
    // settings.operator.enabled_default at attach() time). Live always
    // starts off — even if enabled_default flipped on, the user must
    // explicitly opt into live before any byte gets typed. AOM excluded
    // is read fresh: backend defaults a new tab to `aom_active_now`
    // (true if AOM is running, so the new tab is born manual) and the
    // manifest restore path (later, in restoreFromManifest) overwrites
    // with the persisted value for tabs being re-spawned at boot.
    const operatorEnabled = await isOperatorEnabled(sessionId).catch(() => false);
    const operatorLive = await isOperatorLive(sessionId).catch(() => false);
    const aomExcluded = await isAomExcluded(sessionId).catch(() => false);
    const mission = await getSessionMission(sessionId).catch(() => null);

    const tab: Tab = {
      id,
      kind: "shell",
      defaultTitle: cwdBasename(initialCwd),
      customName: opts?.customName ?? null,
      color: opts?.color ?? null,
      groupId: opts?.groupId ?? null,
      pane,
      termHost,
      blocksHost,
      term,
      fit,
      webgl,
      canvas,
      ligatures,
      search,
      blocks,
      recall,
      structure,
      editor,
      openEditor,
      wroteWhileHidden: true,
      sidebarView: "blocks",
      disposers: [dataDispose, resizeDispose, roDispose, dprDispose, wheelDispose],
      specBadge: null,
      panes: [] as unknown as [Pane],
      layout: { kind: "single", activePaneIdx: 0 },
      terminalBlock,
    };

    const pane0Shell: Pane = {
      id: paneId,
      kind: "terminal",
      sessionId,
      cwd: initialCwd ?? "",
      mission,
      operator: null,
      blocks: [],
      xterm: term,
      piView: null,
      executor: null,
      operatorEnabled,
      operatorLive,
      operatorSolo: false,
      aomExcluded,
      observer_ids: [],
      spawn_id: null,
      idleAgent: null,
      busyProc: null,
      replayKey,
      el: paneHost0,
    };
    tab.panes = [pane0Shell];
    assertLayoutValid(tab);

    // D14 — active-pane border: wire pane-0 focus for shell tabs via focusin.
    // xterm focuses an internal textarea; the event bubbles up through paneHost0.
    // Dynamic findIndex lookup so the correct index is used after a pane swap.
    const pane0FocusIn = (): void => {
      const t = tabRef.current;
      if (!t) return;
      const idx = t.panes.findIndex((p) => p.el === paneHost0);
      if (idx < 0) return;
      if (t.layout.activePaneIdx === idx) return;
      t.layout.activePaneIdx = idx as 0 | 1;
      this.updateActivePaneClass(t);
      this.onActiveContextChange?.(activePane(t).cwd);
      this.emitActiveMission();
    };
    paneHost0.addEventListener("focusin", pane0FocusIn);
    tab.disposers.push({ dispose: () => paneHost0.removeEventListener("focusin", pane0FocusIn) });

    // F2 — right-click context menu on pane-host 0 (shell tabs).
    tab.disposers.push(this.installPaneContextMenu(paneHost0, tab, 0));

    tabRef.current = tab;

    // Floating Cmd+F finder, scoped to this tab's pane. Created after
    // the tab object exists so dispose() can clean it up symmetrically.
    tab.finder = new TerminalFinder(pane, term, search);

    // Cmd+Click on file paths in terminal output → open in the tab's
    // editor split. Path detection is local to the visible line; we
    // resolve against the tab's *current* cwd (read at click time so
    // the user can `cd` and click into a path printed earlier).
    //
    // Only paths with at least one `/` separator (or a `./` / `../` /
    // absolute prefix) are matched, plus an optional trailing `:line`
    // or `:line:col`. Bare filenames like `README.md` are intentionally
    // skipped — too many false positives in agent prose.
    const PATH_RE =
      /(?:\.{0,2}\/)?[A-Za-z0-9_@.\-]+(?:\/[A-Za-z0-9_@.\-]+)+(?::\d+(?::\d+)?)?/g;
    const linkDispose = term.registerLinkProvider({
      provideLinks(y, callback) {
        const buf = term.buffer.active;
        const line = buf.getLine(y - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        // Stitch wrapped lines into a single logical line so paths that
        // overflow the terminal width are matched as a whole. xterm
        // exposes wrapping via `isWrapped` on continuation rows; we walk
        // back to the first non-wrapped row, then forward gathering all
        // continuations, and record each segment's screen-row + col span
        // so we can map regex match offsets back to per-row link ranges.
        let startY = y - 1;
        while (startY > 0) {
          const above = buf.getLine(startY);
          if (above && above.isWrapped) startY--;
          else break;
        }
        const segments: { y: number; start: number; text: string }[] = [];
        let cursor = startY;
        let fullText = "";
        while (true) {
          const row = buf.getLine(cursor);
          if (!row) break;
          if (cursor !== startY && !row.isWrapped) break;
          const segText = row.translateToString(true);
          segments.push({ y: cursor + 1, start: fullText.length, text: segText });
          fullText += segText;
          cursor++;
        }
        if (segments.length === 0) {
          callback(undefined);
          return;
        }
        const links = [] as Parameters<typeof callback>[0] extends
          | infer L
          | undefined
          ? L
          : never;
        const out: NonNullable<typeof links> = [];
        // Map an absolute offset in `fullText` to {y, x} (1-based) on a
        // specific screen row.
        const locate = (offset: number): { y: number; x: number } | null => {
          for (let i = segments.length - 1; i >= 0; i--) {
            const s = segments[i];
            if (offset >= s.start) {
              return { y: s.y, x: offset - s.start + 1 };
            }
          }
          return null;
        };
        for (const m of fullText.matchAll(PATH_RE)) {
          const raw = m[0];
          const trimmed = raw.replace(/[.,;:)\]}>'"]+$/g, "");
          if (trimmed.length < 3) continue;
          const absStart = m.index ?? 0;
          const absEnd = absStart + trimmed.length; // exclusive
          // The current provideLinks call is for row `y` (1-based). Only
          // emit a link entry for the slice of the match that lies on this
          // row; xterm calls provideLinks once per row and stitches hover
          // highlighting across rows automatically when ranges line up.
          let rowStartOffset = -1;
          let rowEndOffset = -1;
          for (const s of segments) {
            if (s.y !== y) continue;
            rowStartOffset = s.start;
            rowEndOffset = s.start + s.text.length;
            break;
          }
          if (rowStartOffset < 0) continue;
          const sliceStart = Math.max(absStart, rowStartOffset);
          const sliceEnd = Math.min(absEnd, rowEndOffset);
          if (sliceEnd <= sliceStart) continue;
          const startPos = locate(sliceStart);
          const endPos = locate(sliceEnd - 1);
          if (!startPos || !endPos) continue;
          out.push({
            range: {
              start: { x: startPos.x, y: startPos.y },
              end: { x: endPos.x, y: endPos.y },
            },
            text: trimmed,
            activate: (event) => {
              // Require Cmd (mac) / Ctrl to open — otherwise plain
              // clicks would steal terminal selection from the user.
              if (!event.metaKey && !event.ctrlKey) return;
              const colonSplit = trimmed.match(/^(.*?)(?::(\d+)(?::\d+)?)?$/);
              const pathPart = colonSplit?.[1] ?? trimmed;
              const lineNum = colonSplit?.[2] ? Number(colonSplit[2]) : undefined;
              const cwd = tabRef.current ? (activePane(tabRef.current).cwd || null) : null;
              void resolveExistingPath(pathPart, cwd)
                .then((abs) => {
                  if (!abs) return;
                  tabRef.current?.openEditor?.(
                    abs,
                    lineNum !== undefined ? { line: lineNum } : undefined,
                  );
                })
                .catch(() => {
                  /* ignore — path didn't resolve */
                });
            },
          });
        }
        callback(out);
      },
    });
    tab.disposers.push(linkDispose);

    this.tabs.push(tab);
    if (wantLigatures) {
      void attachLigatures(term, ligatureFontStack).then((h) => {
        if (h) tab.ligatures = h;
      });
    }
    // If spawned into an existing group, splice the tab next to the
    // group's last member so grouped tabs stay contiguous in `tabs[]`.
    // Without this, renderTabbar opens a second shell for the new tab
    // and the group renders as two chips sharing one id — deleting
    // either removes both.
    if (tab.groupId) {
      const myIdx = this.tabs.length - 1;
      let lastGroupIdx = -1;
      for (let i = 0; i < myIdx; i++) {
        if (this.tabs[i].groupId === tab.groupId) lastGroupIdx = i;
      }
      if (lastGroupIdx >= 0 && lastGroupIdx + 1 !== myIdx) {
        const [moved] = this.tabs.splice(myIdx, 1);
        this.tabs.splice(lastGroupIdx + 1, 0, moved);
      }
    }
    this.rememberSessionName(sessionId, tabDisplayName(tab));
    // Route through activate() so the StatusBar callbacks
    // (onActiveContextChange, emitActiveMission, …) fire on the new
    // tab. Without this, the bar keeps showing the previous tab's
    // mission/cwd until the user switches tabs and back, since the
    // activate() path is where those callbacks live.
    if (!opts?.skipActivate) this.activate(id, { skipIfSame: false });
    this.scheduleSave();
    return tab;
  }

  /// Create a Pi RPC tab. Bypasses all xterm/blocks/recall/structure/
  /// editor setup — the pane hosts a PiChatView wired to a freshly-
  /// spawned `pi --mode rpc` session. The tab still participates in
  /// activation, grouping, drag-drop, tabbar render, and manifest
  /// persistence; xterm-touching methods early-return on `kind: "pi"`.
  async createPiTab(opts?: {
    customName?: string | null;
    color?: string | null;
    groupId?: string | null;
    cwd?: string | null;
    skipActivate?: boolean;
    provider?: string;
    model?: string;
  }): Promise<Tab | null> {
    const id = crypto.randomUUID();
    const replayKey = id.replace(/-/g, "").slice(0, 26);
    const seq = this.nextSeq++;

    const pane = document.createElement("div");
    pane.className = "tab-pane tab-pane-pi";
    pane.dataset.tabId = id;
    pane.hidden = true;
    this.hideAllPanes();
    this.workspace.appendChild(pane);

    let sessionId: SessionId;
    try {
      sessionId = await spawnPiSession({
        cwd: opts?.cwd ?? undefined,
        provider: opts?.provider,
        model: opts?.model,
      });
    } catch (err) {
      // Spawn failed — surface in-place and drop the pane so we don't
      // leave dangling DOM. Caller gets null; the tabbar stays clean.
      pane.remove();
      console.error("spawnPiSession failed", err);
      alert(`Could not start Pi: ${String(err)}`);
      return null;
    }

    const piTerminalBlock = document.createElement("div");
    piTerminalBlock.className = "terminal-block";
    piTerminalBlock.dataset.layout = "single";

    const piPaneHost0 = document.createElement("div");
    piPaneHost0.className = "pane-host";
    piTerminalBlock.appendChild(piPaneHost0);
    pane.appendChild(piTerminalBlock);

    const view = new PiChatView({ sessionId, host: piPaneHost0, cwd: opts?.cwd ?? null });

    const tab: Tab = {
      id,
      kind: "pi",
      defaultTitle: `pi ${seq}`,
      customName: opts?.customName ?? null,
      color: opts?.color ?? null,
      groupId: opts?.groupId ?? null,
      pane,
      piView: view,
      sidebarView: "blocks",
      disposers: [],
      specBadge: null,
      panes: [] as unknown as [Pane],
      layout: { kind: "single", activePaneIdx: 0 },
      terminalBlock: piTerminalBlock,
    };

    const pane0Pi: Pane = {
      id: `p-${sessionId}`,
      kind: "pi",
      sessionId,
      cwd: opts?.cwd ?? "",
      mission: null,
      operator: null,
      blocks: [],
      xterm: null,
      piView: view,
      executor: "pi",
      operatorEnabled: false,
      operatorLive: false,
      operatorSolo: false,
      aomExcluded: true, // Pi sessions never enter AOM (no shell to drive)
      observer_ids: [],
      spawn_id: null,
      idleAgent: null,
      busyProc: null,
      replayKey,
      el: piPaneHost0,
    };
    tab.panes = [pane0Pi];
    assertLayoutValid(tab);

    // D14 — active-pane border: wire pane-0 focus for Pi tabs via focusin
    // (PiChatView doesn't expose an onFocus signal; the textarea fires a
    // native focusin that bubbles up from inside piPaneHost0).
    // Dynamic findIndex lookup so the correct index is used after a pane swap.
    const piPane0FocusIn = (): void => {
      const idx = tab.panes.findIndex((p) => p.el === piPaneHost0);
      if (idx < 0) return;
      if (tab.layout.activePaneIdx === idx) return;
      tab.layout.activePaneIdx = idx as 0 | 1;
      this.updateActivePaneClass(tab);
      this.onActiveContextChange?.(activePane(tab).cwd);
      this.emitActiveMission();
    };
    piPaneHost0.addEventListener("focusin", piPane0FocusIn);
    tab.disposers.push({ dispose: () => piPaneHost0.removeEventListener("focusin", piPane0FocusIn) });

    // F2 — right-click context menu on pane-host 0 (Pi tabs).
    tab.disposers.push(this.installPaneContextMenu(piPaneHost0, tab, 0));

    this.tabs.push(tab);
    if (tab.groupId) {
      const myIdx = this.tabs.length - 1;
      let lastGroupIdx = -1;
      for (let i = 0; i < myIdx; i++) {
        if (this.tabs[i].groupId === tab.groupId) lastGroupIdx = i;
      }
      if (lastGroupIdx >= 0 && lastGroupIdx + 1 !== myIdx) {
        const [moved] = this.tabs.splice(myIdx, 1);
        this.tabs.splice(lastGroupIdx + 1, 0, moved);
      }
    }
    this.rememberSessionName(sessionId, tabDisplayName(tab));
    if (!opts?.skipActivate) this.activate(id, { skipIfSame: false });
    this.scheduleSave();
    return tab;
  }

  /// Open a new in-app browser tab hosting a native webview. Mirrors the
  /// "pi" tab shape: every xterm field is left undefined and a single
  /// inert stub pane satisfies the `panes`/`activePane` invariants so the
  /// generic iterate-all-tabs methods stay safe.
  async openBrowserTab(url = "", focusAddress = false): Promise<void> {
    const id = crypto.randomUUID();
    const replayKey = id.replace(/-/g, "").slice(0, 26);
    const seq = this.nextSeq++;

    const pane = document.createElement("div");
    pane.className = "tab-pane tab-pane-browser";
    pane.dataset.tabId = id;
    pane.hidden = true;
    this.hideAllPanes();
    this.workspace.appendChild(pane);

    const browserPane = new BrowserPane(id, url, (label) => this.setTabLabel(id, label));
    pane.appendChild(browserPane.host);

    // Shared favorites rail in the otherwise-empty grid column 4.
    const favRail = new FavoritesRail({ onOpen: (u) => void this.openBrowserTab(u) });
    pane.appendChild(favRail.el);
    favRail.mount();

    const browserBlock = document.createElement("div");
    browserBlock.className = "terminal-block";
    browserBlock.dataset.layout = "single";

    const stubPane: Pane = {
      id: `p-${id}`,
      kind: "terminal",
      sessionId: null,
      cwd: "",
      mission: null,
      operator: null,
      blocks: [],
      xterm: null,
      piView: null,
      executor: null,
      operatorEnabled: false,
      operatorLive: false,
      operatorSolo: false,
      aomExcluded: true,
      observer_ids: [],
      spawn_id: null,
      idleAgent: null,
      busyProc: null,
      replayKey,
      el: null,
    };

    const tab: Tab = {
      id,
      kind: "browser",
      defaultTitle: `browser ${seq}`,
      customName: null,
      color: null,
      groupId: null,
      pane,
      browser: browserPane,
      sidebarView: "blocks",
      disposers: [{ dispose: () => favRail.destroy() }],
      specBadge: null,
      panes: [stubPane],
      layout: { kind: "single", activePaneIdx: 0 },
      terminalBlock: browserBlock,
    };
    assertLayoutValid(tab);

    this.tabs.push(tab);
    this.renderTabbar();
    this.activate(id, { skipIfSame: false });
    browserPane.mounted();
    if (focusAddress) browserPane.focusAddress();
    this.scheduleSave();
  }

  /// Update a tab's displayed label. Used by BrowserPane to surface the
  /// loaded page's <title>. Sets the default title (preserving any
  /// user-set custom name) and re-renders the strip.
  setTabLabel(id: string, label: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.defaultTitle = label && label.trim().length > 0 ? label : tab.defaultTitle;
    this.renderTabbar();
  }

  /// Flip the per-session live flag. M-OP3: when on AND operator is
  /// enabled, the Operator's REPLY actions actually inject keystrokes
  /// into the PTY (after passing the safety blocklist).
  private async toggleOperatorLive(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const pane = activePane(tab);
    const sessionId = pane.sessionId;
    if (!sessionId) return;
    const next = !pane.operatorLive;
    try {
      await setOperatorLive(sessionId as SessionId, next);
      pane.operatorLive = next;
      this.renderTabbar();
      if (tab.id === this.activeId) this.emitActiveOperator();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("set_operator_live failed", err);
    }
  }

  public async toggleOperatorSolo(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const pane = activePane(tab);
    const sessionId = pane.sessionId;
    if (!sessionId) return;
    const next = !pane.operatorSolo;
    // Solo AOM has nothing to drive without an operator pinned to the tab.
    // Mirror the teardown guard in setTabOperator: don't arm operatorEnabled
    // (running border, fleet count) against an operator-less tab.
    if (next && !pane.operator) {
      pushInfoToast({ message: "Pin an operator to this tab first to start solo AOM." });
      return;
    }
    try {
      if (next) {
        await operatorSoloStart(sessionId as SessionId);
        pane.operatorEnabled = true;
      } else {
        await operatorSoloStop(sessionId as SessionId);
      }
      pane.operatorSolo = next;
      this.renderTabbar();
      if (tab.id === this.activeId) this.emitActiveOperator();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("operator_solo toggle failed", err);
    }
  }

  /// Pin (or unpin) an operator to a tab. Propagates to the backend,
  /// persists to the manifest, and re-renders the tab strip.
  public async setTabOperator(tabId: string, operatorId: string | null): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const pane = activePane(tab);
    const priorOperator = pane.operator;
    pane.operator = operatorId;
    // Promoting an existing observer to driver removes the duplicate entry —
    // observers and the primary writer must be disjoint.
    if (operatorId) {
      pane.observer_ids = stripObserverOnPromote(pane.observer_ids, operatorId);
    }
    const sessionId = pane.sessionId;
    if (sessionId) {
      await sessionSetOperator(sessionId as SessionId, operatorId);
      // Removing the operator must also tear down the M-OP3 enabled/live
      // flags. Without this, the per-session "operator engaged" bit stays
      // on, the tab keeps its running border, and the AOM-stop guard
      // below sees `pane.operatorEnabled === true` and refuses to stop
      // AOM — leaving single-tab AOM running against an orphaned tab.
      if (operatorId === null) {
        await setOperatorLive(sessionId as SessionId, false).catch(() => undefined);
        await setOperatorEnabled(sessionId as SessionId, false).catch(() => undefined);
        pane.operatorLive = false;
        pane.operatorEnabled = false;
      }
    }
    this.scheduleSave();
    // Refresh operator cache so the chip picks up any name/color updates.
    await this.refreshOperatorCache();
    this.renderTabbar();
    if (tab.id === this.activeId) {
      // Push the new pinned-entity to the status bar (and any other
      // wired listeners). emitActiveOperator drives both the
      // enabled/live state and the entity callback in one place.
      this.emitActiveOperator();
    }
    // Operator-off removes the tab from the AOM excluded list (the
    // pushExcludedToStatusBar filter requires operatorEnabled), and
    // operator-on while still aom_excluded re-adds it. Either way,
    // the chip count + popover need a refresh.
    this.pushExcludedToStatusBar();

    // If we just removed the operator and no other tabs have one, AOM
    // has nothing left to drive — stop it so the global indicator and
    // budget don't keep ticking against an empty fleet.
    if (operatorId === null) {
      const anyOperator = this.tabs.some((t) => {
        const p = activePane(t);
        return p.operatorEnabled || p.operator;
      });
      if (!anyOperator) {
        const aomOn = await aomStatus().then((s) => s.enabled).catch(() => false);
        if (aomOn) await aomStop().catch(() => undefined);
      }
    }
    // Removing the operator means the task it was driving in this tab has
    // no driver left. Cancel it so the work stops and Mibli's chat avatar
    // drops its working indicator — leaving the task `active` would keep the
    // header ring spinning for a task nobody is running.
    if (operatorId === null && priorOperator && sessionId) {
      await this.cancelTaskForUnboundSession(priorOperator, sessionId);
    }
    // Notify derived-state subscribers (e.g. teammate panel subtitle).
    this.emitTabOperatorChange();
  }

  /// Cancel the active task `operatorId` was driving in `sessionId`, if any.
  /// Used when the operator is unbound from a tab. No-op when the task is
  /// already finished/cancelled (so the cancel→unbind→close stop flow in the
  /// teammate panel doesn't double-cancel). The backend emits a
  /// TaskUpdate(Cancelled) that the teammate panel reacts to.
  private async cancelTaskForUnboundSession(
    operatorId: string,
    sessionId: string,
  ): Promise<void> {
    try {
      const tasks = await teammateListTasks(operatorId);
      const active = tasks.find(
        (t) =>
          t.spawned_session === sessionId &&
          (t.status === "active" || t.status === "blocked"),
      );
      if (active) await teammateCancelActiveTask(active.id);
    } catch (e) {
      console.error("cancelTaskForUnboundSession failed", e);
    }
  }

  /// All tabs the given operator is bound to — either as primary writer
  /// ("driver") or as a read-only "observer". Stable order = tab order.
  /// Used by the teammate panel to render its binding status line and
  /// the detach popover.
  public listTabsForOperator(
    operatorId: string,
  ): Array<{ tabId: string; tabName: string; role: "driver" | "observer" }> {
    const rows: Array<{ tabId: string; tabName: string; role: "driver" | "observer" }> = [];
    for (const t of this.tabs) {
      const tabName = (t.customName && t.customName.trim().length > 0)
        ? t.customName
        : t.defaultTitle;
      const p = activePane(t);
      if (p.operator === operatorId) {
        rows.push({ tabId: t.id, tabName, role: "driver" });
      } else if (p.observer_ids.includes(operatorId)) {
        rows.push({ tabId: t.id, tabName, role: "observer" });
      }
    }
    return rows;
  }

  /// Tabs that the given operator is NOT bound to (neither driver nor
  /// observer). Used by the teammate panel's "Observe this tab" picker.
  public listTabsAvailableForObserving(
    operatorId: string,
  ): Array<{ tabId: string; tabName: string }> {
    return this.tabs
      .filter((t) => { const p = activePane(t); return p.operator !== operatorId && !p.observer_ids.includes(operatorId); })
      .map((t) => ({
        tabId: t.id,
        tabName: (t.customName && t.customName.trim().length > 0)
          ? t.customName
          : t.defaultTitle,
      }));
  }

  /// Add an operator as a read-only observer of a tab. Idempotent. Refuses
  /// silently if the operator is already the primary writer (drivers shadow
  /// observers — call setTabOperator(null) first if you want to demote).
  public async addObserver(tabId: string, operatorId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const paneObs = activePane(tab);
    const next = computeAddObserver(paneObs.operator, paneObs.observer_ids, operatorId);
    if (next === paneObs.observer_ids) return; // no-op
    paneObs.observer_ids = next;
    this.scheduleSave();
    this.renderTabbar();
    this.emitTabOperatorChange();
  }

  /// Remove an operator from a tab's observer list. No-op if not present.
  public async removeObserver(tabId: string, operatorId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const paneRem = activePane(tab);
    const next = computeRemoveObserver(paneRem.observer_ids, operatorId);
    if (next === paneRem.observer_ids) return; // no-op
    paneRem.observer_ids = next;
    this.scheduleSave();
    this.renderTabbar();
    this.emitTabOperatorChange();
  }

  /// Look up a tab by its backend session id. Used by the OperatorPicker
  /// (⌘⇧O) to resolve the sessionId it receives back to a tab id so it
  /// can call setTabOperator.
  tabForSession(sessionId: SessionId): Tab | null {
    return this.tabs.find((t) => activePane(t).sessionId === sessionId) ?? null;
  }

  /// Public sibling of `promptAndSetMission` that takes a sessionId
  /// instead of a tabId. Lets external surfaces (status bar's
  /// "+ Mission" affordance) reuse the same prompt + set-mission
  /// flow as the tab context menu without leaking the tab-id
  /// abstraction.
  promptAndSetMissionForSession(sessionId: SessionId): void {
    const tab = this.tabs.find((t) => activePane(t).sessionId === sessionId);
    if (!tab) return;
    void this.promptAndSetMission(tab.id);
  }

  /// SessionId-keyed clear so the status bar's mission context menu
  /// can remove the active tab's mission without leaking tabIds.
  clearMissionForSession(sessionId: SessionId): void {
    const tab = this.tabs.find((t) => activePane(t).sessionId === sessionId);
    if (!tab) return;
    void this.clearMission(tab.id);
  }

  setMissionPicker(fn: (opts: MissionPageOpts) => Promise<PageResult>): void {
    this.missionPicker = fn;
  }

  /// Public entry point for ⌘M. Opens the mission page for the active tab.
  async openMissionForActive(): Promise<void> {
    if (!this.activeId) return;
    await this.promptAndSetMission(this.activeId);
  }

  /// Directly set a mission path on the currently active tab without
  /// prompting. Used by the post-publish toast "Open in Set Mission"
  /// action so the published spec is wired immediately.
  async setMissionPathForActiveTab(path: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return;
    const activeMissPane = activePane(tab);
    const activeMissSid = activeMissPane.sessionId;
    if (!activeMissSid) return;
    try {
      const info = await setSessionMission(activeMissSid as SessionId, {
        kind: "covenant",
        spec_path: path,
        plan_path: null,
      });
      activeMissPane.mission = info;
      this.renderTabbar();
      if (tab.id === this.activeId) this.emitActiveMission();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("setMissionPathForActiveTab failed", err);
    }
  }

  /**
   * 3.16 — flat snapshot of every tab's mission/operator state, used by
   * the spec-prompt module to filter candidates.
   */
  listTabSnapshots(): {
    id: string;
    cwd: string;
    hasMission: boolean;
    hasOperator: boolean;
  }[] {
    return this.tabs.map((t) => {
      const pane = activePane(t);
      return {
        id: t.id,
        cwd: pane.cwd,
        hasMission: !!pane.mission?.path,
        hasOperator: !!pane.operator,
      };
    });
  }

  /** 3.17 — returns the id of the currently-active tab, or null. */
  getActiveTabId(): string | null {
    return this.activeId ?? null;
  }

  /** 3.17 — human-readable label for a tab (for toast display). */
  getTabLabel(tabId: string): string {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return tabId;
    return tabDisplayName(tab);
  }

  /** 3.16 — read-only view of the active tab's id + mission state. */
  activeTabSnapshot(): { id: string; hasMission: boolean } | null {
    if (!this.activeId) return null;
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return null;
    return { id: tab.id, hasMission: !!activePane(tab).mission?.path };
  }

  /**
   * 3.16 — set mission for a specific tab id (not necessarily active).
   * Used by the spec-prompt toast: each open toast belongs to a specific
   * tab and must set the mission on THAT tab regardless of the user's
   * current focus.
   */
  async setMissionPathForTab(tabId: string, path: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const prevActive = this.activeId;
    if (this.activeId !== tabId) {
      this.activate(tabId);
    }
    try {
      await this.setMissionPathForActiveTab(path);
    } finally {
      if (prevActive && prevActive !== tabId) {
        this.activate(prevActive);
      }
    }
  }

  /// Open an inline modal that asks for a spec path, then attach
  /// the mission to the session. The user can either type a path or
  /// click "Browse…" for a native file picker. Errors (file not
  /// found, etc.) come back from the backend.
  private async promptAndSetMission(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const pickPane = activePane(tab);
    const repoRoot = pickPane.cwd || "."; // backend default; mission-picker handles "no specs dir"
    if (!this.missionPicker) return;
    const result = await this.missionPicker({
      repoRoot,
      currentMissionPath: pickPane.mission?.path ?? null,
      onBrowse: async () => {
        const start =
          pickPane.mission?.path ??
          (pickPane.cwd ? `${pickPane.cwd}/docs/specs` : undefined);
        const picked = await openDialog({
          title: "Pick mission spec",
          multiple: false,
          directory: false,
          defaultPath: start,
          filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
        });
        return typeof picked === "string" ? picked : null;
      },
    });

    if (result === null) return; // cancelled

    if (result.kind === "publishDraft") {
      window.dispatchEvent(
        new CustomEvent("drafts:open", {
          detail: { slug: result.slug, autoPublish: true },
        }),
      );
      return;
    }

    if (result.kind === "spawnTab") {
      // "plan ✗" → spawn a fresh tab whose first prompt receives the
      // writing-plans skill-invocation. User owns the session from there.
      await this.createTab({
        cwd: pickPane.cwd || null,
        initialCommand: result.initialCommand,
      });
      return;
    }

    if (result.kind === "newSuperpowersMission") {
      // Picker closed first; now prompt for the topic at body-level so
      // the modal isn't stacked behind the (already-gone) picker.
      const topic = await openNewSuperpowersTopicModal();
      if (!topic) return;
      await this.createTab({
        cwd: pickPane.cwd || null,
        initialCommand: `Use the brainstorming skill to design: ${topic}`,
      });
      return;
    }

    // result.kind === "set" | "setRef"
    const pickSid = pickPane.sessionId;
    if (!pickSid) return;
    try {
      const mref =
        result.kind === "setRef"
          ? result.mref
          : { kind: "covenant" as const, spec_path: result.path, plan_path: null };
      const info = await setSessionMission(pickSid as SessionId, mref);
      pickPane.mission = info;
      this.renderTabbar();
      if (tab.id === this.activeId) this.emitActiveMission();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("set_session_mission failed", err);
      alert(`Could not set mission: ${String(err)}`);
    }
  }

  private async clearMission(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const clearPane = activePane(tab);
    const clearSid = clearPane.sessionId;
    if (!clearSid) return;
    try {
      await clearSessionMission(clearSid as SessionId);
      clearPane.mission = null;
      this.renderTabbar();
      if (tab.id === this.activeId) this.emitActiveMission();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("clear_session_mission failed", err);
    }
  }

  /// Open the active tab's mission in a viewer-friendly way: the
  /// status-bar chip is the canonical entry point but the tab context
  /// menu also exposes "View mission…". Both paths converge here so
  /// behavior stays identical.
  private async viewMission(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const pane = activePane(tab);
    if (!pane.mission || !pane.sessionId) return;
    if (tab.id !== this.activeId) this.activate(tab.id);
    this.onMissionViewRequested?.(pane.mission, pane.sessionId as SessionId);
  }

  /// Wired by main.ts to route the menu entry to the StatusBar's
  /// already-built MissionViewerModal. Kept as a callback rather than
  /// importing the modal here so TabManager doesn't depend on the
  /// status bar.
  public onMissionViewRequested:
    | ((mission: MissionInfo, sessionId: SessionId) => void)
    | null = null;

  /// Wired by main.ts to open the OperatorPicker for the given session.
  /// Used by the context-menu "Set operator" entry so the user can pick
  /// an operator instead of getting silently enabled with the default.
  public onSetOperatorRequested:
    | ((sessionId: SessionId) => void)
    | null = null;

  /// Per-tab AOM opt-out toggle. M-OP5: while AOM is on, an excluded
  /// tab keeps its individual live setting + normal persona. Useful
  /// for leaving an exploratory shell strictly manual without having
  /// to disable Operator entirely.
  private async toggleAomExcluded(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const paneAom = activePane(tab);
    const sessionId = paneAom.sessionId;
    if (!sessionId) return;
    const next = !paneAom.aomExcluded;
    try {
      await setAomExcluded(sessionId as SessionId, next);
      paneAom.aomExcluded = next;
      this.renderTabbar();
      // Persist so the exclusion survives app restarts. Without this
      // the new aom_excluded field in TabManifestV1 would only see
      // values written by an unrelated tab op (rename, color, group)
      // that incidentally triggered scheduleSave.
      this.scheduleSave();
      this.pushExcludedToStatusBar();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("set_aom_excluded failed", err);
    }
  }

  /// Wrapper around toggleAomExcluded keyed off the currently active
  /// tab. Silent no-op when AOM is off, no active tab, or the active
  /// tab is not Operator-enabled.
  async toggleAomExcludedActive(): Promise<void> {
    if (!this.aomBanner?.isOn()) return;
    if (!this.activeId) return;
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab || !activePane(tab).operatorEnabled) return;
    await this.toggleAomExcluded(tab.id);
  }

  /// Set exclusion explicitly for a session (used by the AOM popover's
  /// per-tab Include action). Wraps backend + local state + tabbar
  /// render + StatusBar push. Idempotent — bails if state already
  /// matches.
  async setAomExcludedFor(sessionId: SessionId, excluded: boolean): Promise<void> {
    const tab = this.tabs.find((t) => activePane(t).sessionId === sessionId);
    if (!tab) return;
    const paneForExcl = activePane(tab);
    if (paneForExcl.aomExcluded === excluded) return;
    try {
      await setAomExcluded(sessionId, excluded);
      paneForExcl.aomExcluded = excluded;
      this.renderTabbar();
      this.scheduleSave();
      this.pushExcludedToStatusBar();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("setAomExcludedFor failed", err);
    }
  }

  /// "Include all" — invokes the bulk backend command, then refreshes
  /// every per-tab cache and re-renders. Used by the AOM popover when
  /// ≥2 tabs are excluded.
  async includeAllInAom(): Promise<void> {
    try {
      await clearAllAomExcluded();
      // The local sync MUST stay synchronous (no awaits in the loop)
      // — otherwise a mid-loop throw would leave backend & local
      // state diverged. Today the assignment can't throw, so the
      // catch below correctly captures only `clearAllAomExcluded`
      // failure where backend AND local are unchanged.
      for (const t of this.tabs) {
        activePane(t).aomExcluded = false;
      }
      this.renderTabbar();
      this.scheduleSave();
      this.pushExcludedToStatusBar();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("clearAllAomExcluded failed", err);
    }
  }

  /// Recompute the StatusBar exclusion list from current tab state and
  /// push. Three call sites — keep them in sync if the set can change
  /// from a new path:
  ///   1. `toggleAomExcluded` — user-initiated toggle (badge /
  ///      right-click / setAomExcludedFor / includeAllInAom).
  ///   2. `refreshAllOperatorState` — AOM banner transitions on/off.
  ///   3. `restoreFromManifest` — app launch with persisted exclusions.
  private pushExcludedToStatusBar(): void {
    const aomOn = this.aomBanner?.isOn() ?? false;
    if (!aomOn) {
      this.statusBar?.setExcludedTabs([]);
      return;
    }
    const list = this.tabs
      .filter((t) => { const p = activePane(t); return p.operatorEnabled && p.aomExcluded; })
      .map((t) => {
        const p = activePane(t);
        return {
          sessionId: p.sessionId ?? "",
          name: tabDisplayName(t),
          cwdShort: shortCwd(p.cwd),
        };
      });
    this.statusBar?.setExcludedTabs(list);
  }

  /// Persist current tab + group state to disk. Debounced so a burst
  /// of changes (drag reorder fires many tiny mutations) only writes
  /// once. Backend stores the JSON blob opaquely; schema lives here.
  private scheduleSave(): void {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
    }
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      if (this.onPersistRequest) {
        // WorkspaceManager owns the V2 envelope on disk; let it write.
        try {
          this.onPersistRequest();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("workspace persist callback failed", err);
        }
        return;
      }
      const body = JSON.stringify(this.serializeManifest());
      void tabManifestSave(body).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("tab_manifest_save failed", err);
      });
    }, 200);
  }

  /// Per-tab view for the global tab finder. Live titles (default_title
  /// resolves from runtime spawn sequence, not persisted in the manifest)
  /// + group/active info, indexed by position in the current tab list.
  snapshotForFinder(): Array<{
    index: number;
    title: string;
    groupId: string | null;
    isActive: boolean;
  }> {
    return this.tabs.map((t, index) => ({
      index,
      title: tabDisplayName(t),
      groupId: t.groupId,
      isActive: t.id === this.activeId,
    }));
  }

  /// Serialize current tab + group state into the manifest schema.
  /// Public so main.ts can call `tabManifestSave` on `beforeunload`
  /// for a synchronous final flush.
  serializeManifest(): TabManifestV1 {
    return {
      version: 1,
      active_index: this.activeId
        ? Math.max(
            0,
            this.tabs.findIndex((t) => t.id === this.activeId),
          )
        : 0,
      // Browser tabs are ephemeral (native webview, no PTY/session) and
      // the manifest schema only models "shell" | "pi" — skip them.
      tabs: this.tabs
        .filter((t): t is typeof t & { kind: "shell" | "pi" } => t.kind !== "browser")
        .map(serializeTab),
      groups: Array.from(this.groups.values()).map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        collapsed: g.collapsed,
        root_dir: g.rootDir,
      })),
    };
  }

  /// Recreate tabs + groups from a previously-saved manifest. Spawns
  /// fresh PTY sessions; cwd is set on the shell directly via the
  /// spawn options (no visible `cd` line). Missions are restored
  /// EXPLICITLY per persisted tab — the backend no longer auto-
  /// restores on cwd_changed (that leaked missions onto unrelated new
  /// tabs in the same dir). Falls back to a single fresh tab if
  /// anything goes wrong (corrupted file, version mismatch, etc).
  async restoreFromManifest(m: TabManifestV1): Promise<void> {
    if (m.version !== 1 || !Array.isArray(m.tabs) || m.tabs.length === 0) {
      await this.createTab();
      return;
    }
    // Restore groups first so tabs that reference them have a target.
    for (const g of m.groups ?? []) {
      this.groups.set(g.id, {
        id: g.id,
        name: g.name,
        color: g.color,
        collapsed: g.collapsed,
        rootDir: g.root_dir ?? null,
      });
    }
    // Normalise every tab into the new panes+layout shape so downstream
    // code (Phase B and beyond) can safely access t.panes[0].
    const tabs = m.tabs.map(liftLegacyTab);
    // Parallel spawns: fire every createTab at once and rebuild order
    // afterward. Each createTab still self-pushes to this.tabs, so the
    // final array reflects spawn-resolution order — we resort it to
    // manifest order before activating.
    const created = await Promise.all(
      tabs.map((t) => {
        if (t.kind === "pi") {
          // Pi tabs restore by spawning a fresh `pi --mode rpc` session.
          // Pi's own --session-dir would let us reattach to an existing
          // JSONL conversation; v1 just opens a clean session in the
          // persisted cwd. Real conversation restore needs Pi to confirm
          // its session-dir convention and ships in a follow-up.
          return this.createPiTab({
            customName: t.custom_name,
            color: t.color,
            groupId: t.group_id,
            cwd: t.cwd,
            skipActivate: true,
          });
        }
        return this.createTab({
          customName: t.custom_name,
          color: t.color,
          groupId: t.group_id,
          cwd: t.cwd,
          skipActivate: true,
          replayKey: t.replay_key ?? null,
        });
      }),
    );
    // Reorder this.tabs to match manifest order. Tabs that failed to
    // spawn (createTab returned null) are dropped from the manifest
    // slot but any other tabs already in this.tabs (shouldn't happen
    // under replaceFromManifest, which tore them down first) survive.
    const orderedIds = new Set(created.filter((t): t is Tab => !!t).map((t) => t.id));
    const before = this.tabs.filter((t) => !orderedIds.has(t.id));
    const ordered: Tab[] = [];
    for (const t of created) if (t) ordered.push(t);
    this.tabs.splice(0, this.tabs.length, ...before, ...ordered);
    this.renderTabbar();

    // Post-spawn setup (mission / operator / aom) in parallel across
    // all tabs. Each Promise handles its own errors so one bad mission
    // path doesn't abort the others.
    await Promise.all(
      tabs.map(async (t, i) => {
        const tab = created[i];
        if (!tab) return;
        const tasks: Promise<unknown>[] = [];
        const paneRestore = activePane(tab);
        const restoreSessionId = paneRestore.sessionId;
        if (t.mission_path && restoreSessionId) {
          tasks.push(
            setSessionMission(restoreSessionId as SessionId, {
              kind: "covenant",
              spec_path: t.mission_path,
              plan_path: null,
            })
              .then((info) => {
                paneRestore.mission = info;
              })
              .catch((err) => {
                console.warn(
                  `mission restore failed for ${t.mission_path}; tab restored without mission`,
                  err,
                );
              }),
          );
        }
        paneRestore.operator = t.operator_id ?? null;
        // Old manifests pre-observers default to []. Observers are a
        // frontend-only subscription, so no backend call is needed.
        paneRestore.observer_ids = Array.isArray(t.observer_ids) ? [...t.observer_ids] : [];
        if (paneRestore.operator && restoreSessionId) {
          tasks.push(
            sessionSetOperator(restoreSessionId as SessionId, paneRestore.operator).catch((e) => {
              console.warn("session_set_operator failed on restore", e);
            }),
          );
        }
        paneRestore.spawn_id = t.spawn_id ?? null;
        // Always pin the persisted value: backend default at attach time
        // depends on whether AOM is currently running, which drifts.
        const persistedExcluded = t.aom_excluded ?? false;
        if (restoreSessionId) {
          tasks.push(
            setAomExcluded(restoreSessionId as SessionId, persistedExcluded)
              .then(() => {
                paneRestore.aomExcluded = persistedExcluded;
              })
              .catch((err) => {
                console.warn("aom_excluded restore failed", err);
              }),
          );
        }
        await Promise.all(tasks);

        // E2 — restore second pane for split tabs. Must run after pane[0]
        // setup tasks above so the tab's layout is in a clean single state
        // before we mutate it to "split". Only fires when the persisted
        // layout was split and the second pane data is present.
        if (
          t.layout?.kind === "split" &&
          Array.isArray(t.panes) &&
          t.panes.length === 2 &&
          t.panes[1]
        ) {
          await this.restoreSecondPaneForTab(tab, t.panes[1], t.layout).catch((err) => {
            console.warn("E2: restoreSecondPaneForTab failed; tab restored as single-pane", err);
          });
        }
      }),
    );

    // Restore active selection.
    const idx = Math.min(m.active_index ?? 0, this.tabs.length - 1);
    if (this.tabs[idx]) {
      this.activate(this.tabs[idx].id, { skipIfSame: false });
    }
    this.pushExcludedToStatusBar();
  }

  /// Import flow: tear down every existing tab + group without the
  /// mind-loss confirm modal (the user already accepted at the settings
  /// import prompt) and rebuild from the supplied manifest. Throws on
  /// invalid manifest so callers can surface an error toast.
  async replaceFromManifest(
    m: TabManifestV1,
    opts?: { silent?: boolean; targetName?: string },
  ): Promise<void> {
    if (m.version !== 1 || !Array.isArray(m.tabs)) {
      throw new Error("invalid manifest");
    }
    this.inReplace = true;
    // First-boot restore passes `silent: true` so the workspace-switch
    // loader doesn't flash on app launch — that overlay is meant for
    // explicit user-driven workspace swaps, not for initial hydration.
    const showLoader = !opts?.silent;
    if (showLoader) {
      const label = document.getElementById("workspace-switch-name");
      if (label && opts?.targetName) label.textContent = opts.targetName;
      document.body.classList.add("workspace-switching");
    }
    try {
      const existing = this.tabs.slice();
      for (const t of existing) this.finalizeCloseTab(t.id);
      this.groups.clear();
      await this.restoreFromManifest(m);
    } finally {
      this.inReplace = false;
      if (showLoader) document.body.classList.remove("workspace-switching");
    }
    this.scheduleSave();
  }

  /// Detach the active workspace's tabs without closing PTYs or disposing
  /// xterm. The Tab objects + their data-event subscriptions stay alive in
  /// memory, so backend output keeps flowing into the xterm buffer while
  /// the user is in another workspace. `unhibernate(workspaceId)` restores
  /// them. The DOM panes are removed from the workspace container; xterm
  /// continues writing to its internal buffer (it doesn't need the DOM to
  /// accept term.write()).
  hibernate(workspaceId: string): void {
    if (this.hibernated.has(workspaceId)) {
      // Already hibernated (shouldn't happen — switchTo is the only
      // caller and it always pairs hibernate with the live workspace).
      // Be defensive: dispose the stale entry first to avoid a leak.
      this.disposeHibernated(workspaceId);
    }
    const tabs = this.tabs.slice();
    for (const tab of tabs) {
      if (tab.pane.parentElement === this.workspace) {
        this.workspace.removeChild(tab.pane);
      }
      tab.pane.hidden = true;
    }
    this.hibernated.set(workspaceId, {
      tabs,
      groups: new Map(this.groups),
      activeId: this.activeId,
    });
    // Suppress onAllTabsClosed during the transient empty state.
    this.inReplace = true;
    try {
      this.tabs.splice(0, this.tabs.length);
      this.groups.clear();
      this.activeId = null;
      this.renderTabbar();
    } finally {
      this.inReplace = false;
    }
  }

  /// Reattach a previously-hibernated workspace's tabs. Returns true if
  /// the workspace had stashed tabs and they were restored; false if no
  /// stash existed (caller should spawn from manifest instead).
  unhibernate(workspaceId: string): boolean {
    const stash = this.hibernated.get(workspaceId);
    if (!stash) return false;
    this.hibernated.delete(workspaceId);
    for (const tab of stash.tabs) {
      this.workspace.appendChild(tab.pane);
      tab.pane.hidden = true;
    }
    this.tabs.splice(0, this.tabs.length, ...stash.tabs);
    for (const [id, g] of stash.groups) this.groups.set(id, g);
    this.renderTabbar();
    if (stash.activeId && this.tabs.some((t) => t.id === stash.activeId)) {
      this.activate(stash.activeId, { skipIfSame: false });
    } else if (this.tabs[0]) {
      this.activate(this.tabs[0].id, { skipIfSame: false });
    }
    return true;
  }

  /// True if `workspaceId` has hibernated tabs waiting to be restored.
  hasHibernated(workspaceId: string): boolean {
    return this.hibernated.has(workspaceId);
  }

  /// Permanently tear down a hibernated workspace (PTYs closed, xterm
  /// disposed). Called when a workspace is deleted.
  disposeHibernated(workspaceId: string): void {
    const stash = this.hibernated.get(workspaceId);
    if (!stash) return;
    this.hibernated.delete(workspaceId);
    // Temporarily swap the stashed tabs into this.tabs so finalizeCloseTab
    // (which expects to find the tab by id) can do the full teardown.
    const live = this.tabs.slice();
    this.inReplace = true;
    try {
      this.tabs.splice(0, this.tabs.length, ...stash.tabs);
      for (const t of stash.tabs) {
        // Reattach pane so finalizeCloseTab's removeChild branch works.
        if (t.pane.parentElement !== this.workspace) {
          this.workspace.appendChild(t.pane);
        }
        this.finalizeCloseTab(t.id);
      }
      // Restore live tabs.
      this.tabs.splice(0, this.tabs.length, ...live);
    } finally {
      this.inReplace = false;
    }
  }

  closeTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = this.tabs[idx];
    // Spec 3.20 phase 6: peek for accumulated operator memory; if any,
    // open the MindLossModal before destroying the tab. On error or
    // when there's nothing to lose, fall through to direct close.
    const closeSid = activePane(tab).sessionId;
    if (closeSid) {
      void closeSessionCheck(closeSid as SessionId)
        .then((preview) => {
          if (preview) {
            openMindLossModal({
              preview,
              onConfirm: () => this.finalizeCloseTab(id),
              onCancel: () => {
                /* keep the tab — user backed out */
              },
            });
          } else {
            this.finalizeCloseTab(id);
          }
        })
        .catch(() => {
          this.finalizeCloseTab(id);
        });
    } else {
      this.finalizeCloseTab(id);
    }
  }

  private finalizeCloseTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;

    const tab = this.tabs[idx];
    // Stamp the final name in the cache before disposal so closed-tab
    // labels survive for the operator-decisions panel.
    const closePane = activePane(tab);
    const closeSessionId = closePane.sessionId;
    if (closeSessionId) this.rememberSessionName(closeSessionId, tabDisplayName(tab));
    // Belt-and-suspenders: unpin operator before closing. Backend also
    // unpins in close_session, but this keeps the in-process state clean.
    if (closeSessionId) {
      void sessionSetOperator(closeSessionId as SessionId, null).catch(() => {});
    }
    tab.specBadge?.destroy();
    tab.specBadge = null;
    for (const d of tab.disposers) d.dispose();
    // Browser tabs own a native webview, not a PTY. Tear it down and
    // skip the terminal/pane disposal path entirely.
    if (tab.kind === "browser") {
      tab.browser?.destroy();
      if (tab.pane.parentElement === this.workspace) {
        this.workspace.removeChild(tab.pane);
      }
      this.tabs.splice(idx, 1);
      if (this.tabs.length === 0) {
        this.activeId = null;
        this.renderTabbar();
        this.emitActiveTab();
        if (!this.inReplace) {
          this.scheduleSave();
          this.onAllTabsClosed();
        }
        return;
      }
      if (this.activeId === id) {
        const next = this.tabs[idx] ?? this.tabs[idx - 1];
        this.activeId = null;
        this.activate(next.id);
      } else {
        this.renderTabbar();
      }
      this.scheduleSave();
      return;
    }
    // Close EVERY pane's PTY and drop its scrollback log. Split tabs have
    // 2 panes; pre-split tabs have 1. Iterating here ensures the non-active
    // pane's PTY is not orphaned (bug #3) and its scrollback is deleted (bug #10).
    for (const p of tab.panes) {
      if (p.kind === "pi") {
        // PiSession owns its own backend lifecycle; PiChatView destroy
        // also fires closePiSession via closeSession().
        void p.piView?.closeSession().catch(() => {});
      } else {
        if (p.sessionId) void closeSession(p.sessionId as SessionId).catch(() => {});
        // Drop the persisted scrollback log — the tab is gone for good.
        // Workspace-switch teardown also flows through here, which is the
        // wrong behavior for those tabs (they reopen in another workspace).
        // Suppress during in-flight replace.
        if (!this.inReplace && p.replayKey) {
          void deleteScrollback(p.replayKey).catch(() => {});
        }
        p.xterm?.dispose();
      }
    }
    // tab.finder is a per-tab overlay (not per-pane in D14 v0); keep its dispose.
    tab.finder?.dispose();
    if (tab.pane.parentElement === this.workspace) {
      this.workspace.removeChild(tab.pane);
    }
    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) {
      this.activeId = null;
      this.renderTabbar();
      this.emitActiveTab();
      if (!this.inReplace) {
        // During workspace-switch teardown we transiently hit zero tabs;
        // suppress the "last tab closed → close window" callback and the
        // disk write that would clobber the in-flight manifest.
        this.scheduleSave();
        this.onAllTabsClosed();
      }
      return;
    }

    if (this.activeId === id) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1];
      this.activeId = null;
      this.activate(next.id);
    } else {
      this.renderTabbar();
    }
    this.scheduleSave();
  }

  activate(
    id: string,
    opts: { skipIfSame?: boolean } = { skipIfSame: true },
  ): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;

    // Clicking a tab should always reveal that tab's terminal content,
    // even when its file-editor drawer is open. Close the drawer first
    // so the re-click on the active tab still has a visible effect.
    if (this.activeId === id) {
      try {
        tab.editor?.close();
      } catch {
        /* ignore */
      }
      if (opts.skipIfSame !== false) return;
    }

    // Anti-flicker activation. The old sequence revealed the pane first
    // and then ran fit + an unconditional resize nudge + scrollToBottom
    // over the next two frames — users saw stale content paint, then
    // resize/scroll jumps. Now: the currently painted pane stays on
    // screen as the visual frame, the incoming pane is laid out
    // invisibly (visibility:hidden keeps real dimensions so fit() and
    // the WebGL renderer both work, unlike display:none), all geometry
    // work happens before it ever paints, and the swap is one clean
    // cross-cut on the next frame.
    const paintedId = pickPaintedPaneId(
      this.tabs.map((t) => ({
        id: t.id,
        hidden: t.pane.hidden,
        visibility: t.pane.style.visibility,
      })),
      id,
    );
    const prevPainted = paintedId
      ? this.tabs.find((t) => t.id === paintedId) ?? null
      : null;
    const deferSwap =
      tab.kind === "shell" && !!tab.term && !!tab.fit && !!prevPainted;

    for (const t of this.tabs) {
      if (t === tab) continue;
      if (deferSwap && t === prevPainted) continue;
      t.pane.hidden = true;
      t.pane.style.removeProperty("visibility");
      if (t.kind === "browser") t.browser?.hide();
    }
    tab.pane.hidden = false;
    if (deferSwap) tab.pane.style.visibility = "hidden";
    else tab.pane.style.removeProperty("visibility");

    this.activeId = id;
    this.renderTabbar();
    this.onTabActivated?.();
    this.onActiveContextChange?.(activePane(tab).cwd);
    this.emitActiveMission();
    this.emitActiveOperator();
    this.emitActiveSpawn();
    this.emitActiveTab();
    // D14 — refresh active-pane border when switching tabs.
    this.updateActivePaneClass(tab);
    const activatorExecutor = activePane(tab).executor;
    this.statusBar?.setExecutor(activatorExecutor);
    this.onActiveExecutorChange?.(activatorExecutor);

    if (tab.kind === "browser") {
      // Browser tabs have no xterm. Reveal the native webview (which
      // floats above the DOM and was hidden above).
      tab.browser?.show();
      return;
    }

    if (tab.kind === "pi") {
      // Pi tabs have no xterm to fit/resize; just hand focus to the
      // chat textarea so the next keystroke lands in the prompt.
      const ta = tab.pane.querySelector<HTMLTextAreaElement>(".pi-chat-textarea");
      ta?.focus();
      return;
    }

    const term = tab.term;
    const fit = tab.fit;
    if (!term || !fit) return;

    // Capture scroll pinning BEFORE any resize moves the viewport.
    const buf = term.buffer.active;
    const plan = computeActivationRefit({
      wroteWhileHidden: tab.wroteWhileHidden === true,
      viewportY: buf.viewportY,
      baseY: buf.baseY,
      rows: term.rows,
    });

    const doFit = (): void => {
      try {
        fit.fit();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("fit failed on activation", err);
      }
    };

    // First fit runs synchronously: the pane is back in layout
    // (hidden = false) so measurements are live, and resizing now means
    // the first painted frame already has correct geometry.
    doFit();
    if (plan.nudge) {
      // Re-sync xterm's viewport scroll area. Data written while the
      // pane was display:none updates the buffer, but xterm can't
      // measure the viewport div then — the internal scroll-area height
      // goes stale, and if fit() resolved to the same cols/rows the
      // resize was a no-op and never corrected it. Shrink one row and
      // grow back to force a real resize cycle with live geometry.
      const { cols, rows } = term;
      try {
        term.resize(cols, rows - 1);
        term.resize(cols, rows);
      } catch {
        /* ignore — terminal may be mid-dispose */
      }
      tab.wroteWhileHidden = false;
    }
    if (plan.scrollToBottom) term.scrollToBottom();
    const activateSessId = activePane(tab).sessionId;
    if (activateSessId) void resizeSession(activateSessId as SessionId, term.cols, term.rows).catch(() => {});

    requestAnimationFrame(() => {
      // Superseded by a later activate(), or the pane was hidden again
      // (settings page opened mid-switch) — the screen isn't ours.
      if (this.activeId !== id || tab.pane.hidden) return;
      // Drift pass: status bar / AOM banner / splitter can settle a
      // sub-cell height change after the synchronous fit. Without it,
      // term.rows can stay one too high and xterm renders rows under
      // the status bar — invisible but selectable.
      doFit();
      if (deferSwap) {
        tab.pane.style.removeProperty("visibility");
        if (prevPainted && prevPainted !== tab) {
          prevPainted.pane.hidden = true;
          prevPainted.pane.style.removeProperty("visibility");
          if (prevPainted.kind === "browser") prevPainted.browser?.hide();
        }
      }
      term.focus();
    });
  }

  // ─── Mutators for context-menu actions ──────────────

  private isRenamingTab(id: string): boolean {
    return this.renaming?.kind === "tab" && this.renaming.id === id;
  }

  private isRenamingGroup(id: string): boolean {
    return this.renaming?.kind === "group" && this.renaming.id === id;
  }

  private setGroupColor(groupId: string, color: string | null): void {
    const g = this.groups.get(groupId);
    if (!g) return;
    g.color = color;
    this.renderTabbar();
    const active = this.tabs.find((t) => t.id === this.activeId);
    if (active?.groupId === groupId) this.emitActiveTab();
    this.scheduleSave();
  }

  /// Open a native folder picker and set the group's default cwd for
  /// new tabs. Existing tabs are unaffected (their PTYs already live
  /// elsewhere). Returns the picked path, or null when cancelled/missing.
  async pickGroupRootDir(groupId: string): Promise<string | null> {
    const g = this.groups.get(groupId);
    if (!g) return null;
    const picked = await openDialog({
      title: `Root dir for group "${g.name}"`,
      multiple: false,
      directory: true,
      defaultPath: g.rootDir ?? undefined,
    });
    if (typeof picked !== "string") return null; // cancelled
    g.rootDir = picked;
    this.scheduleSave();
    return picked;
  }

  private clearGroupRootDir(groupId: string): void {
    const g = this.groups.get(groupId);
    if (!g) return;
    g.rootDir = null;
    this.scheduleSave();
  }

  private startTabRename(id: string): void {
    this.renaming = { kind: "tab", id };
    this.renderTabbar();
  }

  private startGroupRename(id: string): void {
    this.renaming = { kind: "group", id };
    this.renderTabbar();
  }

  private commitTabRename(id: string, value: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const previousCustomName = tab.customName;
    const trimmed = value.trim();
    const newCustomName = trimmed.length > 0 ? trimmed : null;
    tab.customName = newCustomName;
    const renamePane = activePane(tab);
    if (renamePane.sessionId) this.rememberSessionName(renamePane.sessionId, tabDisplayName(tab));
    this.renaming = null;
    this.renderTabbar();
    if (id === this.activeId) this.emitActiveTab();
    this.scheduleSave();
    // If this tab is in the AOM excluded list, the popover's name
    // field would otherwise stay stale until the next AOM transition.
    this.pushExcludedToStatusBar();

    if (
      newCustomName &&
      shouldForwardRename({
        executor: renamePane.executor,
        kind: tab.kind,
        previousCustomName,
        newCustomName,
      })
    ) {
      const renameSessId = renamePane.sessionId;
      if (renameSessId) void piSetSessionName(renameSessId as SessionId, newCustomName).catch((err) => {
        console.debug("piSetSessionName failed", { sessionId: renameSessId, err });
      });
    }
  }

  private commitGroupRename(id: string, value: string): void {
    const g = this.groups.get(id);
    if (!g) return;
    const trimmed = value.trim();
    g.name = trimmed.length > 0 ? trimmed : `group ${this.nextGroupSeq - 1}`;
    this.renaming = null;
    this.renderTabbar();
    const active = this.tabs.find((t) => t.id === this.activeId);
    if (active?.groupId === id) this.emitActiveTab();
    this.scheduleSave();
  }

  private cancelRename(): void {
    if (!this.renaming) return;
    this.renaming = null;
    this.renderTabbar();
  }

  // ─── Group ops ──────────────────────────────────────

  private createGroupFromTab(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const id = crypto.randomUUID();
    const seq = this.nextGroupSeq++;
    this.groups.set(id, {
      id,
      name: `group ${seq}`,
      color: null,
      collapsed: false,
      rootDir: null,
    });
    tab.groupId = id;
    // No reorder needed — tab stays where it is, becomes a single-
    // member group.
    this.renaming = { kind: "group", id };
    this.renderTabbar();
    this.scheduleSave();
  }

  /// Collapse every group at once. No-op if all groups are already
  /// collapsed (or there are no groups). Mutates DOM in place via the
  /// same path as the per-chip toggle so transitions stay smooth.
  collapseAllGroups(): void {
    for (const [id, g] of this.groups) {
      if (!g.collapsed) this.toggleGroupCollapsed(id);
    }
  }

  /// Inverse of collapseAllGroups — expands every collapsed group via the
  /// same in-place DOM path so transitions stay smooth.
  expandAllGroups(): void {
    for (const [id, g] of this.groups) {
      if (g.collapsed) this.toggleGroupCollapsed(id);
    }
  }

  /// True when there is at least one group and every group is collapsed.
  /// Drives the topbar collapse/expand toggle affordance.
  areAllGroupsCollapsed(): boolean {
    if (this.groups.size === 0) return false;
    for (const [, g] of this.groups) {
      if (!g.collapsed) return false;
    }
    return true;
  }

  private toggleGroupCollapsed(groupId: string): void {
    const g = this.groups.get(groupId);
    if (!g) return;
    g.collapsed = !g.collapsed;
    // CRITICAL: do NOT re-render the tabbar here. A full re-render
    // wipes innerHTML, killing any in-flight CSS transition and
    // causing the visible flicker the user reported. We mutate the
    // existing DOM in place — the only state that changes is the
    // chip's collapsed flag and each member pill's folded class.
    const memberCount = this.memberIndices(groupId).length;
    const chip = this.tabbarHost.querySelector<HTMLElement>(
      `.group-chip[data-group-id="${groupId}"]`,
    );
    if (chip) {
      chip.classList.toggle("group-chip-collapsed", g.collapsed);
      chip.classList.toggle(
        "group-chip-has-members",
        !g.collapsed && memberCount > 0,
      );
      // Sidebar tree-line CSS keys off the shell-collapsed class.
      const shell = chip.closest<HTMLElement>(".tab-group-shell");
      shell?.classList.toggle("tab-group-shell-collapsed", g.collapsed);
      const chev = chip.querySelector<HTMLElement>(".group-chip-chev");
      if (chev) {
        const title = g.collapsed ? "Expand group" : "Collapse group";
        chev.setAttribute("aria-label", title);
      }
      const countEl = chip.querySelector<HTMLElement>(".group-chip-count");
      if (countEl) countEl.textContent = String(memberCount);
    }
    for (const idx of this.memberIndices(groupId)) {
      const tab = this.tabs[idx];
      const pill = this.tabbarHost.querySelector<HTMLElement>(
        `.tab-btn[data-tab-id="${tab.id}"]`,
      );
      if (!pill) continue;
      pill.classList.toggle("tab-pill-folded", g.collapsed);
      // The first member's left-corner radius depends on whether the
      // chip below shows it as fused (only relevant in the horizontal
      // top-tabbar mode; harmless in vertical mode where the rule is
      // overridden by `body.tabbar-left .tab-grouped-first`).
      if (g.collapsed) pill.classList.remove("tab-grouped-first");
    }
    if (!g.collapsed) {
      // On unfold, re-tag the first visible member so the chip+pill
      // border fusion in horizontal mode is restored.
      const firstIdx = this.memberIndices(groupId)[0];
      if (firstIdx !== undefined) {
        const firstTab = this.tabs[firstIdx];
        const firstPill = this.tabbarHost.querySelector<HTMLElement>(
          `.tab-btn[data-tab-id="${firstTab.id}"]`,
        );
        firstPill?.classList.add("tab-grouped-first");
      }
    }
    // Sync snapshot so the next full renderTabbar() doesn't think a
    // transition is pending.
    this.lastCollapsed.set(groupId, g.collapsed);
    this.scheduleSave();
  }

  /// Tab indices belonging to a group, in their current `tabs[]` order.
  private memberIndices(groupId: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].groupId === groupId) out.push(i);
    }
    return out;
  }

  /// Move an entire group (all its members, in order) so the first member
  /// lands `side`-of `targetTabId`. Self-drop or no-op cases are silent.
  private moveGroupRelativeToTab(
    groupId: string,
    targetTabId: string,
    side: "left" | "right",
  ): void {
    const memberIds = new Set(
      this.tabs.filter((t) => t.groupId === groupId).map((t) => t.id),
    );
    if (memberIds.size === 0) return;
    if (memberIds.has(targetTabId)) return;

    const members = this.tabs.filter((t) => memberIds.has(t.id));
    const remaining = this.tabs.filter((t) => !memberIds.has(t.id));

    const targetIdx = remaining.findIndex((t) => t.id === targetTabId);
    if (targetIdx < 0) return;
    const insertAt = side === "right" ? targetIdx + 1 : targetIdx;
    remaining.splice(insertAt, 0, ...members);

    this.tabs.length = 0;
    this.tabs.push(...remaining);
    this.renderTabbar();
    this.scheduleSave();
  }

  /// Move an entire group so its members land `side`-of the entire
  /// target group's run.
  private moveGroupRelativeToGroup(
    movingId: string,
    targetGroupId: string,
    side: "left" | "right",
  ): void {
    if (movingId === targetGroupId) return;
    const targetMembers = this.tabs.filter((t) => t.groupId === targetGroupId);
    if (targetMembers.length === 0) return;
    const anchor =
      side === "right"
        ? targetMembers[targetMembers.length - 1]
        : targetMembers[0];
    this.moveGroupRelativeToTab(movingId, anchor.id, side);
  }

  private addTabToGroup(tabId: string, groupId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    const group = this.groups.get(groupId);
    if (!tab || !group) return;
    if (tab.groupId === groupId) return;

    tab.groupId = groupId;

    // Move the tab next to the last existing member of the group so
    // grouped tabs render as a single contiguous run.
    const myIdx = this.tabs.findIndex((t) => t.id === tabId);
    let lastGroupIdx = -1;
    for (let i = 0; i < this.tabs.length; i++) {
      if (i !== myIdx && this.tabs[i].groupId === groupId) lastGroupIdx = i;
    }
    if (lastGroupIdx >= 0) {
      const [moved] = this.tabs.splice(myIdx, 1);
      // After splice, indices in [lastGroupIdx+1, ..) shifted down by 1
      // if myIdx < lastGroupIdx; account for that.
      const insertAt =
        myIdx < lastGroupIdx ? lastGroupIdx : lastGroupIdx + 1;
      this.tabs.splice(insertAt, 0, moved);
    }
    this.renderTabbar();
    this.scheduleSave();
  }

  private removeTabFromGroup(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.groupId = null;
    // Empty groups persist intentionally — they're first-class containers
    // the user can drag tabs back into. Explicit removal happens via the
    // chip's context-menu "Delete group" / "Ungroup" actions.
    this.renderTabbar();
    this.flushTabbarLayout();
    this.scheduleSave();
  }

  /// Ungroup, with a lightweight confirm when the group has members (the
  /// tabs survive, so a simple yes/no is proportional). An empty group has
  /// nothing to lose, so it's removed directly.
  private confirmUngroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    const count = this.memberIndices(groupId).length;
    if (count === 0) {
      this.ungroup(groupId);
      return;
    }
    openConfirmPrompt({
      label: "Ungroup",
      message: `Ungroup "${group.name}"? The ${count} tab${
        count === 1 ? "" : "s"
      } stay open — they're just no longer grouped.`,
      confirmText: "Ungroup",
      onConfirm: () => this.ungroup(groupId),
    });
  }

  /// Destroy, gated behind a type-the-name confirm because it kills every
  /// member tab's shell and can't be undone. Falls back to a simple confirm
  /// for the (rare) unnamed group, where typing a blank name is meaningless.
  private confirmDestroyGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    const count = this.memberIndices(groupId).length;
    const name = group.name?.trim() ?? "";
    const message = `This closes all ${count} tab${
      count === 1 ? "" : "s"
    } in the group and ends their sessions. This can't be undone.`;
    if (name === "") {
      openConfirmPrompt({
        label: "Destroy group",
        message,
        confirmText: "Destroy",
        onConfirm: () => this.destroyGroup(groupId),
      });
      return;
    }
    openConfirmTyped({
      label: "Destroy group",
      message,
      expected: name,
      confirmText: "Destroy",
      onConfirm: () => this.destroyGroup(groupId),
    });
  }

  private ungroup(groupId: string): void {
    for (const t of this.tabs) {
      if (t.groupId === groupId) t.groupId = null;
    }
    this.groups.delete(groupId);
    this.renderTabbar();
    this.flushTabbarLayout();
    this.scheduleSave();
  }

  /// Destroy a group AND every tab inside it. Unlike ungroup (which just
  /// detaches the group wrapper and keeps the tabs), this closes each member
  /// tab (killing its shell) before removing the group.
  private destroyGroup(groupId: string): void {
    const members = this.tabs.filter((t) => t.groupId === groupId);
    for (const t of members) {
      this.closeTab(t.id);
    }
    this.groups.delete(groupId);
    this.renderTabbar();
    this.flushTabbarLayout();
    this.scheduleSave();
  }

  /// Force a reflow on the tabbar scroll container after a structural
  /// change (ungroup / remove-from-group). Without this, ungrouped tabs
  /// can render with stale layout — they keep their previous height/
  /// indent until the next window resize event. Reading offsetHeight is
  /// a synchronous reflow; the resize dispatch then re-arms any listeners
  /// (e.g. ResizeObservers on terminal panes) that depend on the tabbar
  /// width changing when the scrollbar appears/disappears.
  private flushTabbarLayout(): void {
    void this.tabbarHost.offsetHeight;
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  /// Create a brand-new empty group and immediately enter rename mode.
  /// Returns the new group id. Used by the ⌘⇧G shortcut and the empty-
  /// area "New group" context-menu entry on the tabbar.
  createEmptyGroup(): string {
    const id = crypto.randomUUID();
    const seq = this.nextGroupSeq++;
    this.groups.set(id, {
      id,
      name: `group ${seq}`,
      color: null,
      collapsed: false,
      rootDir: null,
    });
    this.renaming = { kind: "group", id };
    this.renderTabbar();
    this.scheduleSave();
    return id;
  }

  // ─── Drag reorder ───────────────────────────────────

  private reorder(fromId: string, toId: string, side: "left" | "right"): void {
    if (fromId === toId) return;
    const fromIdx = this.tabs.findIndex((t) => t.id === fromId);
    const toIdx = this.tabs.findIndex((t) => t.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;

    // When reordering across a group boundary, inherit the destination
    // tab's group so dragging into a group is intuitive.
    const moved = this.tabs[fromIdx];
    const target = this.tabs[toIdx];
    const oldGroupId = moved.groupId;
    moved.groupId = target.groupId;

    this.tabs.splice(fromIdx, 1);
    let insertAt = this.tabs.findIndex((t) => t.id === toId);
    if (side === "right") insertAt += 1;
    this.tabs.splice(insertAt, 0, moved);

    void oldGroupId;
    this.renderTabbar();
    this.scheduleSave();
  }

  // ─── Render ─────────────────────────────────────────

  private hideAllPanes(): void {
    for (const t of this.tabs) {
      t.pane.hidden = true;
      // Clear any visibility:hidden left by an in-flight activation so
      // the pane paints normally the next time something un-hides it.
      t.pane.style.removeProperty("visibility");
      // Native webviews float above the DOM and ignore `hidden`, so they
      // must be explicitly hidden when their tab is no longer in front.
      if (t.kind === "browser") t.browser?.hide();
    }
  }

  private renderTabbar(): void {
    this.tabbarHost.innerHTML = "";
    const transitions: Array<{ el: HTMLElement; collapsing: boolean }> = [];

    // Track open shell while iterating tabs.
    let currentShellGroupId: string | null = null;
    let currentShellBody: HTMLElement | null = null;

    const openShell = (group: TabGroup): HTMLElement => {
      const { shell, body } = createGroupShell({
        groupId: group.id,
        color: group.color ?? null,
        collapsed: group.collapsed,
      });
      this.tabbarHost.appendChild(shell);
      currentShellGroupId = group.id;
      currentShellBody = body;
      return body;
    };

    const closeShell = (): void => {
      currentShellGroupId = null;
      currentShellBody = null;
    };

    for (const tab of this.tabs) {
      // Ungrouped tab: close any open shell, append directly to host.
      if (!tab.groupId) {
        closeShell();
        const pillEl = this.renderTabPill(tab);
        this.tabbarHost.appendChild(pillEl);
        continue;
      }

      // Grouped tab: open a new shell if the group changed.
      if (tab.groupId !== currentShellGroupId) {
        closeShell();
        const group = this.groups.get(tab.groupId);
        if (!group) continue;
        const body = openShell(group);
        const memberCount = this.memberIndices(group.id).length;
        const chipEl = this.renderGroupChip(group, memberCount);
        body.appendChild(chipEl);
      }

      // Append member pill into current shell body.
      const group = this.groups.get(tab.groupId)!;
      const folded = group.collapsed;
      const wasCollapsed = this.lastCollapsed.get(group.id);
      const transitioning = wasCollapsed !== undefined && wasCollapsed !== folded;
      const pillEl = this.renderTabPill(tab);
      const initiallyFolded = transitioning ? wasCollapsed! : folded;
      if (initiallyFolded) pillEl.classList.add("tab-pill-folded");
      if (transitioning) {
        transitions.push({ el: pillEl, collapsing: folded });
      }
      currentShellBody!.appendChild(pillEl);
    }
    closeShell();

    // Empty groups (no members) render at the end as standalone shells
    // containing only the chip. Still valid drop targets.
    const usedGroupIds = new Set<string>();
    for (const t of this.tabs) if (t.groupId) usedGroupIds.add(t.groupId);
    for (const g of this.groups.values()) {
      if (usedGroupIds.has(g.id)) continue;
      const { shell, body } = createGroupShell({
        groupId: g.id,
        color: g.color ?? null,
        collapsed: g.collapsed,
      });
      body.appendChild(this.renderGroupChip(g, 0));
      this.tabbarHost.appendChild(shell);
    }

    // Sync the snapshot now that we've captured the prev state above.
    this.lastCollapsed.clear();
    for (const g of this.groups.values()) {
      this.lastCollapsed.set(g.id, g.collapsed);
    }

    if (transitions.length > 0) {
      // Force layout/style flush so the "from" state is committed
      // before we flip the class. A single rAF is not enough — the
      // browser will coalesce the class addition with the original
      // paint and skip the transition. Reading offsetWidth synchronously
      // forces a reflow with the initial styles applied.
      void this.tabbarHost.offsetWidth;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          for (const t of transitions) {
            t.el.classList.toggle("tab-pill-folded", t.collapsing);
          }
        });
      });
    }

    this.onAfterRender?.();
    positionGlassIndicator(this.tabbarHost);
  }

  /// Read-only snapshot of the tabbar's logical structure for the
  /// collapsed rail. Walks `tabs[]` in display order, opening a "group"
  /// item whenever the running groupId changes and emitting a "tab"
  /// item for each ungrouped tab.
  /// Reapply the xterm palette to every live terminal. Called by main.ts
  /// when the user toggles theme or the OS appearance changes under
  /// `system` mode. Cheap — xterm hot-swaps the theme without reflow.
  public applyTerminalTheme(): void {
    const theme = termTheme();
    for (const tab of this.tabs) {
      if (tab.kind !== "shell" || !tab.term) continue;
      tab.term.options.theme = theme;
    }
  }

  public getRailSnapshot(): RailSnapshot {
    const items: RailSnapshot["items"] = [];
    let currentGroupId: string | null = null;
    let currentGroupView: RailGroupView | null = null;

    for (const tab of this.tabs) {
      const tabView: RailTabView = {
        id: tab.id,
        name: tabDisplayName(tab),
        color: tab.color,
        active: tab.id === this.activeId,
        kind: tab.kind,
      };

      if (!tab.groupId) {
        currentGroupId = null;
        currentGroupView = null;
        items.push({ kind: "tab", tab: tabView });
        continue;
      }

      if (tab.groupId !== currentGroupId) {
        const group = this.groups.get(tab.groupId);
        if (!group) continue;
        currentGroupId = group.id;
        currentGroupView = {
          id: group.id,
          name: group.name,
          color: group.color,
          tabs: [],
        };
        items.push({ kind: "group", group: currentGroupView });
      }
      currentGroupView!.tabs.push(tabView);
    }
    return { items };
  }

  /// Group→session view for the Resources panel. Walks every tab's panes
  /// (split tabs have two) and collects their backend sessionIds, bucketed
  /// by tab group. Ungrouped tabs fall into a synthetic "Ungrouped" group
  /// so they still surface in the panel. `titleFor` resolves a sessionId
  /// back to its owning tab's display name.
  public resourcesGroupViews(): Array<{
    id: string;
    name: string;
    sessionIds: string[];
    titleFor: (sessionId: string) => string;
  }> {
    const sidToTitle = new Map<string, string>();
    const order: string[] = [];
    const buckets = new Map<string, { id: string; name: string; sessionIds: string[] }>();

    const bucketFor = (id: string, name: string) => {
      let b = buckets.get(id);
      if (!b) {
        b = { id, name, sessionIds: [] };
        buckets.set(id, b);
        order.push(id);
      }
      return b;
    };

    for (const tab of this.tabs) {
      const groupId = tab.groupId;
      const group = groupId ? this.groups.get(groupId) : null;
      const bucket = group
        ? bucketFor(group.id, group.name)
        : bucketFor("__ungrouped__", "Ungrouped");
      const title = tabDisplayName(tab);
      for (const pane of tab.panes) {
        const sid = pane.sessionId;
        if (!sid) continue;
        bucket.sessionIds.push(sid);
        sidToTitle.set(sid, title);
      }
    }

    const titleFor = (sid: string) => sidToTitle.get(sid) ?? sid;
    return order
      .map((id) => buckets.get(id)!)
      .filter((b) => b.sessionIds.length > 0)
      .map((b) => ({ id: b.id, name: b.name, sessionIds: b.sessionIds, titleFor }));
  }

  private renderGroupChip(group: TabGroup, memberCount: number): HTMLElement {
    const chip = document.createElement("div");
    chip.className = "group-chip";
    chip.dataset.groupId = group.id;
    if (group.color) {
      chip.classList.add("group-chip-colored");
      chip.style.setProperty("--group-color", group.color);
    }
    if (group.collapsed) chip.classList.add("group-chip-collapsed");
    if (this.dragging?.kind === "group" && this.dragging.id === group.id) {
      chip.classList.add("group-chip-dragging");
    }

    // Chevron — opt-in click target for fold toggle. CSS draws a
    // triangle pseudo-element that rotates between collapsed/expanded.
    const chevron = document.createElement("button");
    chevron.type = "button";
    chevron.className = "group-chip-chev";
    chevron.setAttribute(
      "aria-label",
      group.collapsed ? "Expand group" : "Collapse group",
    );
    chevron.innerHTML = Icons.chevronRight({ size: 12 });
    chevron.addEventListener("mousedown", (e) => e.stopPropagation());
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleGroupCollapsed(group.id);
    });
    chip.appendChild(chevron);

    if (this.isRenamingGroup(group.id)) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "group-chip-input";
      input.value = group.name;
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          this.commitGroupRename(group.id, input.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.cancelRename();
        }
      });
      input.addEventListener("blur", () => {
        if (this.isRenamingGroup(group.id)) {
          this.commitGroupRename(group.id, input.value);
        }
      });
      input.addEventListener("click", (e) => e.stopPropagation());
      chip.appendChild(input);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      const label = document.createElement("span");
      label.className = "group-chip-label";
      label.textContent = group.name;
      chip.appendChild(label);
      // Always render the count span; visibility is driven by the
      // `group-chip-collapsed` class via CSS. Rendering unconditionally
      // means in-place collapse/expand toggles (which don't re-render
      // the chip) keep the badge consistent.
      const count = document.createElement("span");
      count.className = "group-chip-count";
      count.textContent = String(memberCount);
      chip.appendChild(count);

    }

    chip.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".group-chip-chev")) return;
      e.preventDefault();
      this.startGroupRename(group.id);
    });

    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openGroupContextMenu(group, e.clientX, e.clientY);
    });

    // ── Drag (move whole group) ──
    this.installChipPointerDrag(chip, group.id);

    return chip;
  }

  private renderTabPill(tab: Tab): HTMLElement {
    // Destroy any previous badge subscription before rebuilding the pill.
    tab.specBadge?.destroy();
    tab.specBadge = null;

    // <div role=button> instead of <button> so we can nest <input> for
    // the inline rename (button > input is invalid HTML).
    const pill = document.createElement("div");
    pill.setAttribute("role", "button");
    pill.tabIndex = 0;
    pill.className = `tab-btn ${tab.id === this.activeId ? "active" : ""}`;
    pill.dataset.tabId = tab.id;
    // Both the property AND the attribute — some webkit builds only
    // honor one or the other for div elements.
    // No native HTML5 draggable — we use pointer events instead
    // (see installTabPointerDrag).

    if (tab.color) {
      pill.classList.add("tab-colored");
      pill.style.setProperty("--tab-color", tab.color);
    }

    if (tab.groupId) {
      pill.classList.add("tab-grouped");
      const group = this.groups.get(tab.groupId);
      if (group?.color) {
        pill.style.setProperty("--group-color", group.color);
        pill.classList.add("tab-group-colored");
      }
    }

    // Per-tab Operator badge. Reintroduced after the spec
    // 2026-05-04-aom-exclusion-visibility — during AOM the user needs
    // an at-a-glance view of which tabs are getting hijacked vs which
    // are kept manual. The badge is interactive (toggles exclusion)
    // only while AOM is running; otherwise it's decorative.
    // Operator/AOM state is signalled entirely by the pill border now:
    //   - operator on, AOM off  → colored tab border (per-tab color)
    //   - operator on, AOM on, driving this tab → animated gradient ring
    //   - operator on, AOM on, excluded → muted/dashed "disabled" ring
    // Toggling exclusion happens via the context menu.
    const pillPane = activePane(tab);
    if (pillPane.operatorEnabled) {
      const aomOn = this.aomBanner?.isOn() ?? false;
      const excluded = pillPane.aomExcluded;
      // Single-tab AOM: a tab where the operator is live counts as
      // "AOM driving here" even when the global banner is off — that's
      // how teammate-confirmed tasks light up without forcing the global
      // toggle on every other tab.
      const drivingHere =
        (aomOn && !excluded) || pillPane.operatorLive || pillPane.operatorSolo === true;
      if (drivingHere) pill.classList.add("tab-aom-active");
      else if (aomOn && excluded) pill.classList.add("tab-aom-excluded");
    }

    // Operator chip renders to the LEFT of the title so the avatar is the
    // first thing the eye lands on when a tab has a pinned operator.
    // TODO(task-17): consider swapping the inner avatar for
    // `renderOperatorChip(op, 'sm')` once we have a chip variant that
    // omits the name label — the tab pill cannot afford a second name
    // beside the title, and chip currently always includes name.
    // Stack of operator avatars on the LEFT of the tab title. The
    // primary writer (driver) renders first at full size with its XP
    // ring + level badge; observers stack behind it, smaller and faded,
    // overlapping ~50%. Beyond MAX_VISIBLE we collapse to a "+N" pill so
    // the tab name never gets pushed out.
    const stackedIds: string[] = [
      ...(pillPane.operator ? [pillPane.operator] : []),
      ...pillPane.observer_ids,
    ];
    if (stackedIds.length > 0) {
      const MAX_VISIBLE = 3;
      const visible = stackedIds.slice(0, MAX_VISIBLE);
      const overflow = stackedIds.length - visible.length;
      const stack = document.createElement("span");
      stack.className = "tab-op-stack tab-op-chip-leading";

      for (const id of visible) {
        const op = this.operatorCache.get(id) ?? null;
        if (!op) continue;
        const isDriver = pillPane.operator === id;
        const chip = document.createElement("span");
        chip.className =
          "tab-op-chip " + (isDriver ? "tab-op-chip--driver" : "tab-op-chip--observer");
        const xp = op.xp ?? 0;
        const level = operatorLevelFromXp(xp);
        const xpProgress = Math.max(0, Math.min(1, (xp % 100) / 100));
        // Driver gets XP ring + level badge; observers are visually quieter
        // so they don't compete with the writer in a stacked pill.
        if (isDriver) {
          chip.innerHTML =
            `<span class="tab-op-avatar-wrap" data-operator-id="${op.id}" ` +
                  `style="--xp-progress:${xpProgress.toFixed(3)};">` +
              `<svg class="tab-op-xp-ring" viewBox="0 0 24 24" aria-hidden="true">` +
                `<circle class="track" cx="12" cy="12" r="11"/>` +
                `<circle class="fill"  cx="12" cy="12" r="11"/>` +
              `</svg>` +
              `${renderAvatarHtml(op.emoji, 18)}` +
              `<span class="tab-op-level" data-operator-id="${op.id}">${level}</span>` +
            `</span>`;
        } else {
          chip.innerHTML =
            `<span class="tab-op-avatar-wrap" data-operator-id="${op.id}">` +
              `${renderAvatarHtml(op.emoji, 18)}` +
            `</span>`;
        }
        attachTooltip(
          chip,
          isDriver
            ? `${op.name} — driving · Lv ${level} · ${xp} XP`
            : `${op.name} — observing`,
        );
        stack.appendChild(chip);
      }

      if (overflow > 0) {
        const more = document.createElement("span");
        more.className = "tab-op-stack__more";
        more.textContent = `+${overflow}`;
        stack.appendChild(more);
      }

      pill.appendChild(stack);
    }

    // Theme lead slot (hidden by default). CRT lights it as a terminal prompt:
    // "$" for loose tabs, ├─/└─ tree connectors for grouped members (via CSS).
    const lead = document.createElement("span");
    lead.className = "tab-lead";
    lead.setAttribute("aria-hidden", "true");
    pill.appendChild(lead);

    if (this.isRenamingTab(tab.id)) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "tab-label-input";
      // The webview otherwise auto-capitalizes / autocorrects tab names
      // like a regular text field — undesirable for identifiers like
      // "ui", "engatel-cargo", branch names, etc.
      input.autocapitalize = "off";
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("autocorrect", "off");
      input.value = tab.customName ?? tab.defaultTitle;
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          this.commitTabRename(tab.id, input.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.cancelRename();
        }
      });
      input.addEventListener("blur", () => {
        if (this.isRenamingTab(tab.id)) {
          this.commitTabRename(tab.id, input.value);
        }
      });
      input.addEventListener("click", (e) => e.stopPropagation());
      pill.appendChild(input);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      // Browser tabs get a leading globe glyph + a marker class so they
      // read as web pages, not shell sessions, in the tab strip.
      if (tab.kind === "browser") {
        pill.classList.add("tab-btn-browser");
        const glyph = document.createElement("span");
        glyph.className = "tab-browser-glyph";
        glyph.setAttribute("aria-hidden", "true");
        glyph.innerHTML = Icons.globe({ size: 12 });
        pill.appendChild(glyph);
      }
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = tabDisplayName(tab);
      pill.appendChild(label);
    }

    // Theme caret slot (hidden by default). CRT shows a blinking phosphor
    // caret on the active row.
    const caret = document.createElement("span");
    caret.className = "tab-caret";
    caret.setAttribute("aria-hidden", "true");
    pill.appendChild(caret);

    // Spec-pending badge. Mounted here so it sits before the close button.
    tab.specBadge = mountSpecBadge(
      pill,
      tab.id,
      getSpecPromptState(),
      () => this.listTabSnapshots(),
      {
        setMissionForTab: (tabId, path) => this.setMissionPathForTab(tabId, path),
        openSpec: async (path) => { this.openFileAtLine(path); },
      },
    );

    // F3 — split glyph: appears only when the tab has a split layout and
    // the experimental flag is on.
    const splitGlyph = this.buildSplitGlyph(tab);
    if (splitGlyph) pill.appendChild(splitGlyph);

    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "Close tab (⌘W)";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(tab.id);
    });
    pill.appendChild(close);

    pill.addEventListener("click", (e) => {
      if (this.isRenamingTab(tab.id)) return;
      if ((e.target as HTMLElement).closest(".tab-close")) return;
      this.activate(tab.id);
    });

    pill.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".tab-close")) return;
      e.preventDefault();
      this.startTabRename(tab.id);
    });

    pill.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void this.openTabContextMenu(tab, e.clientX, e.clientY);
    });

    // ── Drag and drop ──
    this.installTabPointerDrag(pill, tab.id);

    // 3.14 — re-apply escalation dot on (re)render so a strip rebuild
    // doesn't drop it while the session is still blocked.
    const pillPaneLate = activePane(tab);
    if (pillPaneLate.sessionId && this.blockedSessionIds.has(pillPaneLate.sessionId)) {
      this.applyEscalationDot(pill, true);
    }

    // Re-apply busy dot on rebuild so tab activation (which rebuilds the
    // strip) doesn't drop it until the next foreground_changed event.
    // Pill isn't in the DOM yet here — attach directly. Executor tabs
    // skip the dot (the chip already conveys "agent running here").
    if (pillPaneLate.busyProc && tab.kind !== "pi" && !pillPaneLate.executor) {
      const dot = document.createElement("span");
      dot.className = "tab-busy-dot";
      dot.title = `${pillPaneLate.busyProc} running`;
      pill.insertBefore(dot, pill.firstChild);
    }

    // Same idea for the agent-idle badge: re-attach on rebuild, before
    // the close button so it sits beside the label.
    if (pillPaneLate.idleAgent) {
      const badge = document.createElement("span");
      badge.className = "tab-idle-badge";
      badge.title = pillPaneLate.idleAgent.promptText ?? `${pillPaneLate.idleAgent.agent} waiting`;
      pill.insertBefore(badge, close);
    }

    return pill;
  }

  private async openTabContextMenu(
    tab: Tab,
    x: number,
    y: number,
  ): Promise<void> {
    // Pull AOM state at open time so the menu reflects reality. Two
    // RPCs per right-click is cheap; subscribing globally would force
    // an extra layer for marginal benefit. We also re-sync
    // `tab.aomExcluded` because the backend resets it on every
    // `aom_start` and the cached value here can be stale.
    const aomOn = await aomStatus()
      .then((s) => s.enabled)
      .catch(() => false);
    const ctxPane = activePane(tab);
    const ctxSessionId = ctxPane.sessionId;
    if (ctxPane.operatorEnabled && ctxSessionId) {
      ctxPane.aomExcluded = await isAomExcluded(ctxSessionId as SessionId).catch(
        () => ctxPane.aomExcluded,
      );
    }

    const items: Parameters<ContextMenu["show"]>[2] = [
      {
        label: "Rename",
        icon: Icons.pencil(),
        onClick: () => this.startTabRename(tab.id),
      },
      { divider: true },
    ];

    // Group operations. Collapse "Move to <group>" into a single
    // submenu so the context menu stays compact as workspaces grow.
    const otherGroups = Array.from(this.groups.values()).filter(
      (g) => g.id !== tab.groupId,
    );
    if (otherGroups.length > 0) {
      items.push({
        label: "Move to group…",
        icon: Icons.arrowRight(),
        submenu: otherGroups.map((g) => ({
          label: g.name,
          icon: Icons.arrowRight(),
          onClick: () => this.addTabToGroup(tab.id, g.id),
        })),
      });
    }
    items.push({
      label: "New group from this tab",
      icon: Icons.plus(),
      onClick: () => this.createGroupFromTab(tab.id),
    });
    if (tab.groupId) {
      items.push({
        label: "Remove from group",
        icon: Icons.folderMinus(),
        onClick: () => this.removeTabFromGroup(tab.id),
      });
    }

    // Mission + Operator are terminal-only — a browser tab has no PTY
    // session (sessionId is null), so these would silently no-op. Skip
    // the whole block for kind:"browser" instead of showing dead items.
    if (tab.kind !== "browser") {
    items.push({ divider: true });
    if (ctxPane.mission) {
      items.push({
        label: "View mission…",
        icon: Icons.lightbulb(),
        onClick: () => this.viewMission(tab.id),
      });
    }
    items.push({
      label: ctxPane.mission ? "Change mission…" : "Set mission…",
      icon: Icons.pencil(),
      onClick: () => this.promptAndSetMission(tab.id),
    });
    if (ctxPane.mission) {
      items.push({
        label: "Clear mission",
        icon: Icons.x(),
        onClick: () => this.clearMission(tab.id),
      });
    }
    items.push({ divider: true });
    items.push({
      label: (ctxPane.operatorEnabled || ctxPane.operator) ? "Remove operator" : "Set operator",
      icon: Icons.headphones(),
      onClick: () => {
        if (ctxPane.operatorEnabled || ctxPane.operator) {
          // Unpin + disable in one shot. setTabOperator(null) flips
          // operatorEnabled off and clears the avatar chip.
          void this.setTabOperator(tab.id, null);
        } else if (ctxSessionId) {
          this.onSetOperatorRequested?.(ctxSessionId as SessionId);
        }
      },
    });
    if (ctxPane.operatorEnabled) {
      if (aomOn) {
        // While AOM is global, the per-tab Live toggle is moot —
        // AOM forces live=true on every included tab. Surface that
        // truth in a disabled informational item, plus the per-tab
        // exclusion toggle so the user can leave specific tabs out
        // of AOM without disabling Operator.
        items.push({
          label: ctxPane.aomExcluded
            ? "Operator: dry-run (excluded from AOM)"
            : "Operator: AOM is driving this tab (LIVE)",
          icon: Icons.headphones(),
          disabled: true,
          onClick: () => {
            /* informational only */
          },
        });
        items.push({
          label: ctxPane.aomExcluded
            ? "Include in AOM"
            : "Exclude from AOM (keep this tab manual)",
          icon: Icons.headphones(),
          onClick: () => this.toggleAomExcluded(tab.id),
        });
      } else {
        // Normal day-mode: the per-tab Live toggle decides typing.
        items.push({
          label: ctxPane.operatorLive
            ? "Operator: stop typing (back to dry-run)"
            : "Operator: start typing into this tab (LIVE)",
          icon: Icons.headphones(),
          danger: !ctxPane.operatorLive,
          onClick: () => this.toggleOperatorLive(tab.id),
        });
        items.push({
          label: ctxPane.operatorSolo
            ? "Operator: stop autonomous (this tab)"
            : "Operator: go autonomous (this tab) — solo AOM",
          icon: Icons.headphones(),
          danger: !ctxPane.operatorSolo,
          onClick: () => this.toggleOperatorSolo(tab.id),
        });
      }
    }
    // Remote control: per-tab arming gate for the RC channel. Off by
    // default; injecting remote input requires this to be on.
    if (ctxSessionId) {
      let armed = false;
      try {
        armed = await getRemoteArmed(ctxSessionId as SessionId);
      } catch {
        /* best-effort; assume disarmed */
      }
      items.push({ divider: true });
      items.push({
        label: armed ? "Disable remote control" : "Allow remote control",
        icon: Icons.link2(),
        onClick: async () => {
          try {
            await setRemoteArmed(ctxSessionId as SessionId, !armed);
          } catch (e) {
            console.error("toggle remote arming failed", e);
          }
        },
      });
    }
    } // end terminal-only (mission + operator) block
    // Saved commands (per-group) and prompts (global) as submenus, targeting
    // this tab's active-pane session. Best-effort: a fetch failure or empty
    // list just omits that entry. Capped so a big library stays usable.
    if (ctxSessionId) {
      const cap = TabManager.PANE_MENU_SECTION_CAP;
      const encoder = new TextEncoder();
      const sid = ctxSessionId as SessionId;
      let commands: Command[] = [];
      let prompts: Prompt[] = [];
      try {
        if (tab.groupId) {
          commands = (await projectNotesApi.snapshot(tab.groupId)).commands;
        }
      } catch {
        /* omit */
      }
      try {
        prompts = await promptsApi.list();
      } catch {
        /* omit */
      }

      const sub: MenuItem[] = [];
      if (commands.length > 0) {
        const rows: MenuItem[] = commands.slice(0, cap).map((c) => ({
          label: c.title,
          // Paste without newline (Commands semantics) — user hits Enter.
          onClick: () => {
            void writeToSession(sid, encoder.encode(c.command));
          },
        }));
        if (commands.length > cap) {
          rows.push({ label: `+${commands.length - cap} more in panel`, disabled: true });
        }
        sub.push({ label: "Run command…", icon: Icons.terminal(), submenu: rows });
      }
      if (prompts.length > 0) {
        const rows: MenuItem[] = prompts.slice(0, cap).map((p) => ({
          label: p.title,
          // Bracketed paste + submit (Prompts semantics).
          onClick: () => {
            void sendPromptToSession(sid, p.body);
          },
        }));
        if (prompts.length > cap) {
          rows.push({ label: `+${prompts.length - cap} more in panel`, disabled: true });
        }
        sub.push({ label: "Run prompt…", icon: Icons.zap(), submenu: rows });
      }
      if (sub.length > 0) {
        items.push({ divider: true });
        items.push(...sub);
      }
    }

    items.push({ divider: true });
    items.push({
      label: "Close tab",
      icon: Icons.x(),
      danger: true,
      onClick: () => this.closeTab(tab.id),
    });

    this.menu.show(x, y, items);
  }

  private openGroupContextMenu(group: TabGroup, x: number, y: number): void {
    const wsList = this.listWorkspaces?.() ?? [];
    const others = wsList.filter((w) => !w.active);
    const moveSubmenu = others.length === 0
      ? [{ label: "(no other workspaces)", disabled: true }]
      : others.map((w) => ({
          label: w.name,
          onClick: () => {
            void this.moveGroupToWorkspace?.(group.id, w.id);
          },
        }));
    this.menu.show(x, y, [
      {
        label: "New tab in group",
        icon: Icons.plus(),
        onClick: () => {
          if (group.collapsed) this.toggleGroupCollapsed(group.id);
          void this.createTab({ groupId: group.id, color: group.color });
        },
      },
      { divider: true },
      {
        label: "Open notes (⌘⇧J)",
        icon: Icons.clipboard(),
        onClick: () =>
          this.onOpenProjectNotes?.(group.id, group.name, group.color ?? null),
      },
      {
        label: "Rename group",
        icon: Icons.pencil(),
        onClick: () => this.startGroupRename(group.id),
      },
      {
        label: group.rootDir
          ? `Root dir: ${shortCwd(group.rootDir)}`
          : "Set root dir…",
        icon: Icons.folder(),
        onClick: () => void this.pickGroupRootDir(group.id),
      },
      ...(group.rootDir
        ? [
            {
              label: "Clear root dir",
              icon: Icons.folderMinus(),
              onClick: () => this.clearGroupRootDir(group.id),
            },
          ]
        : []),
      {
        label: group.collapsed ? "Expand group" : "Collapse group",
        icon: Icons.folder(),
        onClick: () => this.toggleGroupCollapsed(group.id),
      },
      { divider: true },
      {
        swatches: COLOR_SWATCHES.map((sw) => ({
          color: sw.color,
          title: sw.title,
          onClick: () => this.setGroupColor(group.id, sw.color),
        })),
      },
      {
        swatches: COLOR_SWATCHES_PASTEL.map((sw) => ({
          color: sw.color,
          title: sw.title,
          onClick: () => this.setGroupColor(group.id, sw.color),
        })),
        pastelRow: true,
      },
      { divider: true },
      {
        label: "Move to workspace…",
        icon: Icons.folder(),
        submenu: moveSubmenu,
      },
      { divider: true },
      {
        label: this.memberIndices(group.id).length === 0 ? "Delete group" : "Ungroup",
        icon: Icons.folderMinus(),
        danger: true,
        onClick: () => this.confirmUngroup(group.id),
      },
      ...(this.memberIndices(group.id).length > 0
        ? [
            {
              label: "Destroy group",
              icon: Icons.trash(),
              danger: true,
              onClick: () => this.confirmDestroyGroup(group.id),
            },
          ]
        : []),
    ]);
  }

  // F3 — split glyph helpers ------------------------------------------------

  /// Returns a span element containing the split glyph + tooltip, or null
  /// when the glyph should not be shown (flag off or tab is not split).
  private buildSplitGlyph(tab: Tab): HTMLElement | null {
    if (!this.splitPanesEnabled || tab.layout.kind !== "split") return null;
    const glyph = document.createElement("span");
    glyph.className = "tab-chip-split-glyph";
    glyph.innerHTML =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' +
      '<rect x="2" y="3" width="12" height="10" rx="1.5"/>' +
      '<line x1="8" y1="3" x2="8" y2="13"/>' +
      "</svg>";
    glyph.setAttribute("aria-label", "split tab");
    attachTooltip(glyph, this.paneTooltipText(tab));
    return glyph;
  }

  /// Builds the tooltip string for a split tab, listing each pane's short
  /// cwd and operator/kind, with ● marking the active pane.
  private paneTooltipText(tab: Tab): string {
    const lines: string[] = [];
    tab.panes.forEach((p, idx) => {
      const cwdShort = p.cwd ? p.cwd.split("/").slice(-2).join("/") : "(no cwd)";
      const op = p.operator ?? p.kind;
      const tag = idx === tab.layout.activePaneIdx ? "● " : "  ";
      lines.push(`${tag}${idx === 0 ? "first" : "second"}: ${cwdShort} (${op})`);
    });
    return lines.join("\n");
  }
}


/// Derive a short tab-name slug from a mission spec path:
///   /docs/specs/3.5-docs-hub.md → "docs-hub"
///   /specs/mission-tracking.md  → "mission-tracking"
///   /work/My Notes.md           → "my-notes"
///   /weird/.md                  → "" (caller should skip)
///
/// Strips: directory + extension, leading "<digits>(.<digits>)*-",
/// non-slug chars (keep [a-z0-9-]), then collapses runs of "-".
function slugFromMissionPath(path: string): string {
  const file = path.split("/").pop() ?? path;
  const stem = file.replace(/\.(md|markdown)$/i, "");
  const noPrefix = stem.replace(/^\d+(\.\d+)*[-_\s]+/, "");
  const slug = noPrefix
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug;
}

function shortCwd(cwd: string | null): string {
  if (!cwd) return "";
  // /Users/<name>/ → ~/  (Linux: /home/<name>/ → ~/). Cheap regex,
  // no need for an env round-trip — process.env.HOME isn't available
  // in the Tauri webview anyway. Windows path normalization is
  // deferred per CLAUDE.md M8 (Windows is post-M5 work).
  let p = cwd.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
  if (p.length > 30) p = "…" + p.slice(p.length - 29);
  return p;
}
