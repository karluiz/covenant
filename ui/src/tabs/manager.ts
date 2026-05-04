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
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import {
  aomStatus,
  clearAllAomExcluded,
  clearSessionMission,
  closeSession,
  getBlockedSessionIds,
  getSessionMission,
  getSettings,
  isAomExcluded,
  isOperatorEnabled,
  isOperatorLive,
  operatorLevelFromXp,
  operatorList,
  resizeSession,
  resolveExistingPath,
  setAomExcluded,
  sessionSetOperator,
  setOperatorEnabled,
  setOperatorLive,
  setSessionMission,
  spawnSession,
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
import { StructureEditor } from "../structure/editor";
import { Icons } from "../icons";
import { ContextMenu, COLOR_SWATCHES } from "../menu/context-menu";
import { openNewSuperpowersTopicModal, type MissionPageOpts, type PageResult } from "../mission/page";
import { createGroupShell } from "./group-shell";
import { renderAvatarHtml } from "../operator/avatars";
import type { AomBanner } from "../aom/banner";

const DEFAULT_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const DEFAULT_FONT_SIZE = 13;

/// Background is fully transparent so the workspace #workspace surface
/// tint (controlled by body.bg-{solid,vibrant,translucent} via the
/// --surface-alpha custom property) shows through xterm. cursorAccent
/// stays opaque so the block cursor reads against any wallpaper.
const TERMINAL_THEME = {
  background: "rgba(0, 0, 0, 0)",
  foreground: "#d6d8db",
  cursor: "#7aa2f7",
  cursorAccent: "#0b0d10",
  selectionBackground: "#2a3148",
} as const;

function buildTerminalOptions(font: TerminalConfig | null): Record<string, unknown> {
  return {
    fontFamily: font?.font_family || DEFAULT_FONT_FAMILY,
    fontSize: font?.font_size || DEFAULT_FONT_SIZE,
    lineHeight: font?.line_height ?? 1.2,
    letterSpacing: font?.letter_spacing ?? 0,
    cursorBlink: true,
    cursorStyle: "block",
    allowProposedApi: true,
    /// xterm's DOM/canvas renderer paints theme.background opaquely
    /// unless this is on. Required for vibrancy to show through.
    allowTransparency: true,
    convertEol: false,
    scrollback: 10_000,
    theme: TERMINAL_THEME,
  };
}

interface Tab {
  id: string;
  sessionId: SessionId;
  /// Default name from the spawn sequence ("zsh 1"). Always present.
  defaultTitle: string;
  /// User-set name. When set, takes precedence over defaultTitle.
  customName: string | null;
  /// Hex color or null. Drives left-border + faint background tint.
  color: string | null;
  /// Group membership. Null = not in any group.
  groupId: string | null;
  /// Operator enabled on this tab — controls whether the backend's
  /// OperatorWatcher checks this session for prompts to answer.
  operatorEnabled: boolean;
  /// M-OP3 live mode. When true AND operatorEnabled is also true, the
  /// Operator actually types replies into this PTY (after passing the
  /// safety blocklist) instead of just logging dry-run decisions.
  /// Disabling the Operator on the backend also clears live, so this
  /// mirrors the server-side invariant.
  operatorLive: boolean;
  /// M-OP5 per-tab AOM opt-out. Only meaningful while AOM is on
  /// globally — when true, this tab is invisible to the AOM banner
  /// and keeps its per-tab live setting + normal persona. Persistent
  /// across AOM cycles AND app restarts (UI stores it in the tab
  /// manifest; restore path always calls setAomExcluded with the
  /// persisted value).
  aomExcluded: boolean;
  /// M-OP6 mission spec attached to this tab. When set, the Operator
  /// uses the spec content as authoritative scope — Out of scope →
  /// escalate, File boundaries → constraints. Tab badge surfaces this.
  mission: MissionInfo | null;
  pane: HTMLElement;
  termHost: HTMLElement;
  blocksHost: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  /// Held so applyTerminalSettings can call webgl.clearTextureAtlas()
  /// when the font changes — the addon caches glyph bitmaps separately
  /// from the terminal options.
  webgl: WebglAddon | null;
  blocks: BlockManager;
  recall: RecallManager;
  structure: StructureTree;
  editor: StructureEditor;
  /// All-in-one "open this file in the editor" entry point — handles
  /// un-hiding the editor host + splitter, restoring the persisted
  /// splitter width, opening the file, and refitting the terminal.
  /// Stored as a closure so it can capture the per-tab `showSplitter`
  /// helper without forcing every caller to know the dance.
  openEditor: (path: string, opts?: { line?: number }) => void;
  /// Which sidebar view is currently selected manually. Recall still
  /// overrides this when user is typing (existing behavior).
  sidebarView: "blocks" | "structure";
  /// Last cwd seen via OSC 7 / cwd_changed; passed to Recall so the
  /// backend can apply its cwd bonus.
  cwd: string | null;
  /// Operator pinned to this tab. Null = backend default (first operator
  /// in the registry). Persisted in the tab manifest; replayed on restore.
  operator_id: string | null;
  disposers: IDisposable[];
}

interface TabGroup {
  id: string;
  name: string;
  color: string | null;
  collapsed: boolean;
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

interface SerializedTab {
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
  /// AOM exclusion persisted for this tab. Optional for backward compat
  /// — old manifests that lack the field default to false on restore.
  aom_excluded?: boolean;
}

interface SerializedGroup {
  id: string;
  name: string;
  color: string | null;
  collapsed: boolean;
}

type RenameTarget =
  | { kind: "tab"; id: string }
  | { kind: "group"; id: string }
  | null;

type DragSource =
  | { kind: "tab"; id: string }
  | { kind: "group"; id: string }
  | null;

function tabDisplayName(t: Tab): string {
  return t.customName?.trim() || t.defaultTitle;
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

  /// 3.7 — fired whenever the *active* tab's cwd context changes:
  ///   - tab switched (new active tab → its cwd)
  ///   - active tab emitted cwd_changed (its new cwd)
  ///   - last tab closed (null)
  /// Set by main.ts to push updates into the StatusBar. Single
  /// listener — there's only one bar.
  public onActiveContextChange: ((cwd: string | null) => void) | null = null;

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

  constructor(
    private readonly tabbarHost: HTMLElement,
    private readonly workspace: HTMLElement,
    newTabBtn: HTMLElement,
    private readonly onAllTabsClosed: () => void,
  ) {
    this.menu = new ContextMenu(document.body);
    newTabBtn.addEventListener("click", () => {
      void this.createTab();
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
    window.addEventListener("resize", () => this.refitActive());
    window.addEventListener("beforeunload", () => {
      for (const tab of this.tabs) {
        void closeSession(tab.sessionId).catch(() => {});
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
      ids = await getBlockedSessionIds();
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
      if (!changed.has(tab.sessionId)) continue;
      const pill = this.tabbarHost.querySelector<HTMLElement>(
        `.tab-btn[data-tab-id="${tab.id}"]`,
      );
      if (pill) this.applyEscalationDot(pill, next.has(tab.sessionId));
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
      if (sourceEl) {
        sourceEl.classList.remove("tab-dragging", "group-chip-dragging");
        sourceEl = null;
      }
      this.dragging = null;
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
        ghost = sourceEl.cloneNode(true) as HTMLElement;
        ghost.classList.add("tab-ghost");
        const rect = sourceEl.getBoundingClientRect();
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        ghostOriginX = rect.left;
        ghostOriginY = rect.top;
        ghost.style.left = `${ghostOriginX}px`;
        ghost.style.top = `${ghostOriginY}px`;
        document.body.appendChild(ghost);
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
          chip.classList.add("group-chip-drop");
          const rect = chip.getBoundingClientRect();
          return {
            kind: "chip",
            el: chip,
            side: clientX < rect.left + rect.width / 2 ? "left" : "right",
          };
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
        const rect = pill.getBoundingClientRect();
        const side: "left" | "right" =
          clientX < rect.left + rect.width / 2 ? "left" : "right";
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
      if (!tab.mission) continue;
      if (tab.customName && tab.customName.trim().length > 0) continue;
      const slug = slugFromMissionPath(tab.mission.path);
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
      const enabled = await isOperatorEnabled(tab.sessionId).catch(
        () => tab.operatorEnabled,
      );
      const live = enabled
        ? await isOperatorLive(tab.sessionId).catch(() => tab.operatorLive)
        : false;
      const excluded = enabled
        ? await isAomExcluded(tab.sessionId).catch(() => tab.aomExcluded)
        : false;
      const mission = await getSessionMission(tab.sessionId).catch(
        () => tab.mission,
      );
      tab.operatorEnabled = enabled;
      tab.operatorLive = live;
      tab.aomExcluded = excluded;
      tab.mission = mission;
    }
    this.renderTabbar();
    this.pushExcludedToStatusBar();
    // Re-push the active tab's mission + operator state too — file
    // watcher / AOM auto-enable cycles can change either without a
    // tab activation.
    this.emitActiveMission();
    this.emitActiveOperator();
  }

  /// Push the active tab's identity (name + group + colors) to the
  /// status bar. Safe to call any time the tab strip changes — does
  /// nothing if no listener is attached.
  private emitActiveTab(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) {
      this.onActiveTabChange?.(null);
      return;
    }
    const group = tab.groupId ? this.groups.get(tab.groupId) ?? null : null;
    this.onActiveTabChange?.({
      name: tabDisplayName(tab),
      color: tab.color,
      groupName: group?.name ?? null,
      groupColor: group?.color ?? null,
    });
  }

  /// Push the active tab's mission to whoever is listening (status bar).
  /// Safe to call any time mission state may have shifted.
  private emitActiveMission(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    this.onActiveMissionChange?.(tab?.mission ?? null, tab?.sessionId ?? null);
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
    this.onActiveOperatorChange?.(
      { enabled: tab.operatorEnabled, live: tab.operatorLive },
      tab.sessionId,
    );
    const opEntity = tab.operator_id ? (this.operatorCache.get(tab.operator_id) ?? null) : null;
    this.onActiveOperatorEntityChange?.(opEntity);
  }

  /// Focus the active tab's terminal. Public so overlays (Recall
  /// palette, etc.) can return keyboard focus to xterm after they
  /// inject — without this the next keystroke lands on the overlay
  /// or wherever browser focus drifted.
  focusActive(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return;
    try {
      tab.term.focus();
    } catch {
      /* term may be disposed mid-call */
    }
  }

  /// Refit the active tab's terminal. Public so main.ts can call it
  /// after the settings page closes (workspace was hidden + restored).
  refitActive(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return;
    requestAnimationFrame(() => {
      try {
        tab.fit.fit();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("fit failed on refitActive", err);
      }
      void resizeSession(tab.sessionId, tab.term.cols, tab.term.rows).catch(
        () => {},
      );
      tab.term.focus();
    });
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
    const size = cfg.font_size || DEFAULT_FONT_SIZE;

    void document.fonts.ready.then(() => {
      for (const tab of this.tabs) {
        try {
          tab.term.options.fontFamily = family;
          tab.term.options.fontSize = size;
          tab.term.options.letterSpacing = cfg.letter_spacing ?? 0;
          tab.term.options.lineHeight = cfg.line_height ?? 1.2;

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
              tab.fit.fit();
            } catch {
              /* ignore */
            }
            tab.term.refresh(0, tab.term.rows - 1);
            void resizeSession(
              tab.sessionId,
              tab.term.cols,
              tab.term.rows,
            ).catch(() => {});
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

  /// Backend session id (Ulid string) for whichever tab is currently
  /// in the foreground, or null when no tabs exist.
  activeSessionId(): SessionId | null {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    return tab?.sessionId ?? null;
  }

  /// Count of tabs that AOM is currently driving — operator-enabled
  /// tabs (AOM auto-enables on every non-excluded tab on start, and
  /// reverts on stop, so this count IS the AOM-active set while AOM
  /// is on).
  aomActiveTabCount(): number {
    return this.tabs.filter((t) => t.operatorEnabled).length;
  }

  /// Most recent cwd reported by the active session via OSC 7
  /// (`cwd_changed`). Used by the Recall palette so the backend
  /// can apply its cwd bonus.
  activeCwd(): string | null {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    return tab?.cwd ?? null;
  }

  /// Open `path` in the active tab's editor and (optionally) jump to a
  /// specific 1-based line. Used by the global search palette: clicking
  /// a hit routes through here so the editor pane swaps into view, the
  /// file loads, and the textarea scrolls to the matched line.
  /// No-ops when there's no active tab.
  openFileAtLine(path: string, line?: number): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return;
    tab.openEditor(path, line !== undefined ? { line } : undefined);
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
    const tab = this.tabs.find((t) => t.sessionId.slice(-6) === short);
    if (tab) {
      return {
        displayName: tabDisplayName(tab),
        missionPath: tab.mission?.path ?? null,
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
  }

  /// 3.6 — focus the tab whose backend session matches `sessionId`. Used
  /// by the OS-notification click handler so clicking an "Operator paused"
  /// popup brings the user back to the originating tab. No-op if the tab
  /// has been closed since the notification fired.
  activateBySessionId(sessionId: SessionId): boolean {
    const tab = this.tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return false;
    this.activate(tab.id);
    return true;
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
  }): Promise<void> {
    const id = crypto.randomUUID();
    const seq = this.nextSeq++;

    const pane = document.createElement("div");
    pane.className = "tab-pane";
    pane.dataset.tabId = id;

    const termHost = document.createElement("div");
    termHost.className = "tab-terminal";
    pane.appendChild(termHost);

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
    blocksHost.className = "tab-blocks";
    pane.appendChild(blocksHost);

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
    term.open(termHost);
    // WebGL addon disabled temporarily — its glyph atlas doesn't pick
    // up font changes from term.options.fontFamily reliably. DOM/canvas
    // renderer respects the font option natively. M-OP perf hit is
    // negligible at terminal byte rates.
    const webgl: WebglAddon | null = null;
    fit.fit();

    let blocks: BlockManager | null = null;
    let recall: RecallManager | null = null;
    // Closure-captured so onSessionEvent (set BEFORE spawn returns)
    // can update the tab's cwd as `cwd_changed` events arrive.
    const tabRef: { current: Tab | null } = { current: null };
    let sessionId: SessionId;
    // Closure flag for the optional initial-command injection. We
    // write the command on the FIRST prompt_start (i.e. once the
    // shell has finished its rc-file work and shown a usable prompt).
    let initialCmdPending: string | null = opts?.initialCommand ?? null;
    try {
      sessionId = await spawnSession(
        {
          onOutput: (chunk) => term.write(chunk),
          onSessionEvent: (event) => {
            blocks?.handleEvent(event);
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
            } else if (event.kind === "cwd_changed") {
              if (tabRef.current) tabRef.current.cwd = event.cwd;
              recall?.setCwd(event.cwd);
              if (tabRef.current?.structure.isVisible()) {
                void tabRef.current.structure.setCwd(event.cwd);
              }
              this.scheduleSave();
              // Status bar: only push when this tab is the visible one.
              // Background tabs cd'ing don't shift what the user sees.
              if (tabRef.current && tabRef.current.id === this.activeId) {
                this.onActiveContextChange?.(event.cwd);
              }
            }
          },
        },
        // Persistence-restored cwd is set on the SHELL itself before
        // spawn — no visible `cd <path>` line, no bogus block. If
        // the dir is gone, backend silently falls back to $HOME.
        { initialCwd: opts?.cwd ?? null },
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("spawn_session failed", err);
      term.dispose();
      this.workspace.removeChild(pane);
      if (this.activeId) this.activate(this.activeId, { skipIfSame: false });
      return;
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
            t?.structure.hide();
            recall!.show();
          } else {
            recall!.hide();
            if (view === "blocks") blocks!.show();
            else t?.structure.show();
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

    // Icon + label nav. Earlier polish stripped to icon-only, but the
    // 14px monochrome glyphs against the dark surface read as blank
    // for the user — restoring the label keeps the button discoverable
    // while keeping the icon as a quick-scan affordance.
    const navBlocks = document.createElement("button");
    navBlocks.type = "button";
    navBlocks.className = "sidebar-nav-btn sidebar-nav-active";
    navBlocks.title = "Blocks";
    navBlocks.setAttribute("aria-label", "Blocks");
    navBlocks.innerHTML = `${Icons.terminal({ size: 13 })}<span>Blocks</span>`;

    const navStructure = document.createElement("button");
    navStructure.type = "button";
    navStructure.className = "sidebar-nav-btn";
    navStructure.title = "Files";
    navStructure.setAttribute("aria-label", "Files");
    navStructure.innerHTML = `${Icons.folder({ size: 13 })}<span>Files</span>`;

    const navDrafts = document.createElement("button");
    navDrafts.type = "button";
    navDrafts.className = "sidebar-nav-btn";
    navDrafts.title = "Drafts";
    navDrafts.setAttribute("aria-label", "Drafts");
    navDrafts.innerHTML = `${Icons.filePen({ size: 13 })}<span>Drafts</span>`;
    navDrafts.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("drafts:toggle"));
    });

    navEl.appendChild(navBlocks);
    navEl.appendChild(navStructure);
    navEl.appendChild(navDrafts);
    blocksHost.insertBefore(navEl, blocksHost.firstChild);

    // Editor splitter: when the editor is open, the pane uses a 4-col
    // grid `<terminal> <splitter> <editor> <sidebar>`. The user drags
    // `editorSplitter` to set the terminal column width in pixels;
    // we persist it in localStorage and re-apply on every editor open.
    // CSS handles the default ratio when no override is set.
    const SPLITTER_PREF_KEY = "covenant.editor.terminal-width";
    const SIDEBAR_WIDTH = 220; // matches CSS for the editor-open layout
    const TERMINAL_MIN = 200;
    const EDITOR_MIN = 280;
    const SPLITTER_PX = 4;

    const applyTerminalWidth = (px: number | null): void => {
      if (px === null) {
        pane.style.gridTemplateColumns = "";
        return;
      }
      const clamped = Math.max(
        TERMINAL_MIN,
        Math.min(px, pane.offsetWidth - SIDEBAR_WIDTH - EDITOR_MIN - SPLITTER_PX),
      );
      pane.style.gridTemplateColumns =
        `${clamped}px ${SPLITTER_PX}px 1fr ${SIDEBAR_WIDTH}px`;
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
        // eslint-disable-next-line no-console
        if (severity === "error") console.error(msg);
        // Existing toast/notification system can be wired here later.
      },
      onClose: () => {
        editorHost.hidden = true;
        showSplitter(false);
        refitAfterLayoutTransition();
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
      showSplitter(true);
      void editor.open(path, opts);
      refitAfterLayoutTransition();
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

    const switchSidebar = (view: "blocks" | "structure") => {
      const t = tabRef.current;
      if (t) t.sidebarView = view;
      if (view === "blocks") {
        navBlocks.classList.add("sidebar-nav-active");
        navStructure.classList.remove("sidebar-nav-active");
        structure.hide();
        blocks!.show();
      } else {
        navStructure.classList.add("sidebar-nav-active");
        navBlocks.classList.remove("sidebar-nav-active");
        blocks!.hide();
        structure.show();
        if (t?.cwd) void structure.setCwd(t.cwd);
      }
    };

    navBlocks.addEventListener("click", () => switchSidebar("blocks"));
    navStructure.addEventListener("click", () => switchSidebar("structure"));

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
      recall?.notifyInput(data);
    });
    // Shift+Enter → Alt+Enter (`\x1b\r`). xterm.js's default for
    // Shift+Enter is the same as Enter (just `\r`), which submits in
    // CLI agents like Claude Code / Codex. Sending ESC+CR is the
    // widely-accepted "newline without submit" sequence those agents
    // recognize. Returning false stops xterm from also sending `\r`.
    term.attachCustomKeyEventHandler((ev) => {
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
    const ro = new ResizeObserver(() => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (termHost.offsetWidth === 0 || termHost.offsetHeight === 0) return;
        try {
          fit.fit();
        } catch {
          /* ignore — tab may be hidden or disposing */
        }
      });
    });
    ro.observe(termHost);
    const roDispose = {
      dispose: () => {
        ro.disconnect();
        if (rafId !== null) cancelAnimationFrame(rafId);
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
      sessionId,
      defaultTitle: `zsh ${seq}`,
      customName: opts?.customName ?? null,
      color: opts?.color ?? null,
      groupId: opts?.groupId ?? null,
      operatorEnabled,
      operatorLive,
      aomExcluded,
      mission,
      pane,
      termHost,
      blocksHost,
      term,
      fit,
      webgl,
      blocks,
      recall,
      structure,
      editor,
      openEditor,
      sidebarView: "blocks",
      cwd: null,
      operator_id: null,
      disposers: [dataDispose, resizeDispose, roDispose],
    };
    tabRef.current = tab;

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
        const text = line.translateToString(true);
        const links = [] as Parameters<typeof callback>[0] extends
          | infer L
          | undefined
          ? L
          : never;
        const out: NonNullable<typeof links> = [];
        for (const m of text.matchAll(PATH_RE)) {
          const raw = m[0];
          // Trim trailing punctuation that often abuts a path in prose.
          const trimmed = raw.replace(/[.,;:)\]}>'"]+$/g, "");
          if (trimmed.length < 3) continue;
          const startCol = m.index ?? 0;
          out.push({
            range: {
              start: { x: startCol + 1, y },
              end: { x: startCol + trimmed.length, y },
            },
            text: trimmed,
            activate: (event) => {
              // Require Cmd (mac) / Ctrl to open — otherwise plain
              // clicks would steal terminal selection from the user.
              if (!event.metaKey && !event.ctrlKey) return;
              const colonSplit = trimmed.match(/^(.*?)(?::(\d+)(?::\d+)?)?$/);
              const pathPart = colonSplit?.[1] ?? trimmed;
              const lineNum = colonSplit?.[2] ? Number(colonSplit[2]) : undefined;
              const cwd = tabRef.current?.cwd ?? null;
              void resolveExistingPath(pathPart, cwd)
                .then((abs) => {
                  if (!abs) return;
                  tabRef.current?.openEditor(
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
    this.activate(id, { skipIfSame: false });
    this.scheduleSave();
  }

  /// Flip the per-session live flag. M-OP3: when on AND operator is
  /// enabled, the Operator's REPLY actions actually inject keystrokes
  /// into the PTY (after passing the safety blocklist).
  private async toggleOperatorLive(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const next = !tab.operatorLive;
    try {
      await setOperatorLive(tab.sessionId, next);
      tab.operatorLive = next;
      this.renderTabbar();
      if (tab.id === this.activeId) this.emitActiveOperator();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("set_operator_live failed", err);
    }
  }

  /// Pin (or unpin) an operator to a tab. Propagates to the backend,
  /// persists to the manifest, and re-renders the tab strip.
  public async setTabOperator(tabId: string, operatorId: string | null): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    tab.operator_id = operatorId;
    if (tab.sessionId) {
      await sessionSetOperator(tab.sessionId, operatorId);
      // Pinning an operator is the user's intent to *use* it on this
      // tab — flip the enabled flag to match. Unpinning (null) likewise
      // disables the watcher and clears live, mirroring toggleOperator.
      const shouldEnable = operatorId !== null;
      if (tab.operatorEnabled !== shouldEnable) {
        tab.operatorEnabled = shouldEnable;
        if (!shouldEnable) tab.operatorLive = false;
        try {
          await setOperatorEnabled(tab.sessionId, shouldEnable);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("set_operator_enabled failed", err);
        }
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
  }

  /// Look up a tab by its backend session id. Used by the OperatorPicker
  /// (⌘⇧O) to resolve the sessionId it receives back to a tab id so it
  /// can call setTabOperator.
  tabForSession(sessionId: SessionId): Tab | null {
    return this.tabs.find((t) => t.sessionId === sessionId) ?? null;
  }

  /// Public sibling of `promptAndSetMission` that takes a sessionId
  /// instead of a tabId. Lets external surfaces (status bar's
  /// "+ Mission" affordance) reuse the same prompt + set-mission
  /// flow as the tab context menu without leaking the tab-id
  /// abstraction.
  promptAndSetMissionForSession(sessionId: SessionId): void {
    const tab = this.tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    void this.promptAndSetMission(tab.id);
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
    try {
      const info = await setSessionMission(tab.sessionId, {
        kind: "covenant",
        spec_path: path,
        plan_path: null,
      });
      tab.mission = info;
      this.renderTabbar();
      if (tab.id === this.activeId) this.emitActiveMission();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("setMissionPathForActiveTab failed", err);
    }
  }

  /// Open an inline modal that asks for a spec path, then attach
  /// the mission to the session. The user can either type a path or
  /// click "Browse…" for a native file picker. Errors (file not
  /// found, etc.) come back from the backend.
  private async promptAndSetMission(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const repoRoot = tab.cwd ?? "."; // backend default; mission-picker handles "no specs dir"
    if (!this.missionPicker) return;
    const result = await this.missionPicker({
      repoRoot,
      currentMissionPath: tab.mission?.path ?? null,
      onBrowse: async () => {
        const start =
          tab.mission?.path ??
          (tab.cwd ? `${tab.cwd}/docs/specs` : undefined);
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
        cwd: tab.cwd ?? null,
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
        cwd: tab.cwd ?? null,
        initialCommand: `Use the brainstorming skill to design: ${topic}`,
      });
      return;
    }

    // result.kind === "set" | "setRef"
    try {
      const mref =
        result.kind === "setRef"
          ? result.mref
          : { kind: "covenant" as const, spec_path: result.path, plan_path: null };
      const info = await setSessionMission(tab.sessionId, mref);
      tab.mission = info;
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
    try {
      await clearSessionMission(tab.sessionId);
      tab.mission = null;
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
    if (!tab || !tab.mission) return;
    if (tab.id !== this.activeId) this.activate(tab.id);
    this.onMissionViewRequested?.(tab.mission, tab.sessionId);
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
    const next = !tab.aomExcluded;
    try {
      await setAomExcluded(tab.sessionId, next);
      tab.aomExcluded = next;
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
  /// tab. Used by the ⌘⇧E global shortcut. Silent no-op when AOM is
  /// off, no active tab, or the active tab is not Operator-enabled.
  async toggleAomExcludedActive(): Promise<void> {
    if (!this.aomBanner?.isOn()) return;
    if (!this.activeId) return;
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab || !tab.operatorEnabled) return;
    await this.toggleAomExcluded(tab.id);
  }

  /// Set exclusion explicitly for a session (used by the AOM popover's
  /// per-tab Include action). Wraps backend + local state + tabbar
  /// render + StatusBar push. Idempotent — bails if state already
  /// matches.
  async setAomExcludedFor(sessionId: SessionId, excluded: boolean): Promise<void> {
    const tab = this.tabs.find((t) => t.sessionId === sessionId);
    if (!tab) return;
    if (tab.aomExcluded === excluded) return;
    try {
      await setAomExcluded(sessionId, excluded);
      tab.aomExcluded = excluded;
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
        t.aomExcluded = false;
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
  ///   1. `toggleAomExcluded` — user-initiated toggle (badge / ⌘⇧E /
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
      .filter((t) => t.operatorEnabled && t.aomExcluded)
      .map((t) => ({
        sessionId: t.sessionId,
        name: tabDisplayName(t),
        cwdShort: shortCwd(t.cwd),
      }));
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
      const body = JSON.stringify(this.serializeManifest());
      void tabManifestSave(body).catch((err) => {
        // eslint-disable-next-line no-console
        console.error("tab_manifest_save failed", err);
      });
    }, 200);
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
      tabs: this.tabs.map((t) => ({
        custom_name: t.customName,
        cwd: t.cwd,
        color: t.color,
        group_id: t.groupId,
        mission_path: t.mission?.path ?? null,
        operator_id: t.operator_id,
        aom_excluded: t.aomExcluded,
      })),
      groups: Array.from(this.groups.values()).map((g) => ({
        id: g.id,
        name: g.name,
        color: g.color,
        collapsed: g.collapsed,
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
      });
    }
    // Sequential spawns — concurrent would race the order of tabs[].
    for (const t of m.tabs) {
      await this.createTab({
        customName: t.custom_name,
        color: t.color,
        groupId: t.group_id,
        cwd: t.cwd,
      });
      const created = this.tabs[this.tabs.length - 1];
      if (created && t.mission_path) {
        try {
          const info = await setSessionMission(created.sessionId, {
            kind: "covenant",
            spec_path: t.mission_path,
            plan_path: null,
          });
          created.mission = info;
        } catch (err) {
          // Spec file may have moved/been deleted since save — restore
          // the tab anyway, just without a mission.
          // eslint-disable-next-line no-console
          console.warn(
            `mission restore failed for ${t.mission_path}; tab restored without mission`,
            err,
          );
        }
      }
      if (created) {
        created.operator_id = t.operator_id ?? null;
        if (created.operator_id) {
          try {
            await sessionSetOperator(created.sessionId, created.operator_id);
          } catch (e) {
            console.warn("session_set_operator failed on restore", e);
          }
        }
      }
      if (created) {
        // Always call setAomExcluded with the persisted value (defaulting
        // to false if missing) — the backend's default at attach time
        // depends on whether AOM is currently running, so explicitly
        // pinning the value avoids subtle drift across restarts.
        const persistedExcluded = t.aom_excluded ?? false;
        try {
          await setAomExcluded(created.sessionId, persistedExcluded);
          created.aomExcluded = persistedExcluded;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("aom_excluded restore failed", err);
        }
      }
    }
    // Restore active selection.
    const idx = Math.min(m.active_index ?? 0, this.tabs.length - 1);
    if (this.tabs[idx]) {
      this.activate(this.tabs[idx].id, { skipIfSame: false });
    }
    this.pushExcludedToStatusBar();
  }

  closeTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;

    const tab = this.tabs[idx];
    // Stamp the final name in the cache before disposal so closed-tab
    // labels survive for the operator-decisions panel.
    this.rememberSessionName(tab.sessionId, tabDisplayName(tab));
    // Belt-and-suspenders: unpin operator before closing. Backend also
    // unpins in close_session, but this keeps the in-process state clean.
    if (tab.sessionId) {
      void sessionSetOperator(tab.sessionId, null).catch(() => {});
    }
    for (const d of tab.disposers) d.dispose();
    void closeSession(tab.sessionId).catch(() => {});
    tab.term.dispose();
    if (tab.pane.parentElement === this.workspace) {
      this.workspace.removeChild(tab.pane);
    }
    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) {
      this.activeId = null;
      this.renderTabbar();
      this.emitActiveTab();
      this.scheduleSave();
      this.onAllTabsClosed();
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
    if (opts.skipIfSame !== false && this.activeId === id) return;

    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;

    this.hideAllPanes();
    tab.pane.hidden = false;
    this.activeId = id;
    this.renderTabbar();
    this.onActiveContextChange?.(tab.cwd);
    this.emitActiveMission();
    this.emitActiveOperator();
    this.emitActiveTab();

    requestAnimationFrame(() => {
      try {
        tab.fit.fit();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("fit failed on activation", err);
      }
      void resizeSession(tab.sessionId, tab.term.cols, tab.term.rows).catch(
        () => {},
      );
      tab.term.focus();
    });
  }

  // ─── Mutators for context-menu actions ──────────────

  private isRenamingTab(id: string): boolean {
    return this.renaming?.kind === "tab" && this.renaming.id === id;
  }

  private isRenamingGroup(id: string): boolean {
    return this.renaming?.kind === "group" && this.renaming.id === id;
  }

  private setColor(id: string, color: string | null): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.color = color;
    this.renderTabbar();
    if (id === this.activeId) this.emitActiveTab();
    this.scheduleSave();
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
    const trimmed = value.trim();
    tab.customName = trimmed.length > 0 ? trimmed : null;
    this.rememberSessionName(tab.sessionId, tabDisplayName(tab));
    this.renaming = null;
    this.renderTabbar();
    if (id === this.activeId) this.emitActiveTab();
    this.scheduleSave();
    // If this tab is in the AOM excluded list, the popover's name
    // field would otherwise stay stale until the next AOM transition.
    this.pushExcludedToStatusBar();
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
    });
    tab.groupId = id;
    // No reorder needed — tab stays where it is, becomes a single-
    // member group.
    this.renaming = { kind: "group", id };
    this.renderTabbar();
    this.scheduleSave();
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
      const chev = chip.querySelector<HTMLElement>(".group-chip-chev");
      if (chev) {
        const title = g.collapsed ? "Expand group" : "Collapse group";
        chev.title = title;
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
    this.scheduleSave();
  }

  private ungroup(groupId: string): void {
    for (const t of this.tabs) {
      if (t.groupId === groupId) t.groupId = null;
    }
    this.groups.delete(groupId);
    this.renderTabbar();
    this.scheduleSave();
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
    chevron.title = group.collapsed ? "Expand group" : "Collapse group";
    chevron.setAttribute("aria-label", chevron.title);
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
    // <div role=button> instead of <button> so we can nest <input> for
    // the inline rename (button > input is invalid HTML).
    const pill = document.createElement("div");
    pill.setAttribute("role", "button");
    pill.tabIndex = 0;
    pill.className = `tab-btn ${tab.id === this.activeId ? "active" : ""}`;
    pill.dataset.tabId = tab.id;
    pill.title = tabDisplayName(tab);
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
    if (tab.operatorEnabled) {
      const aomOn = this.aomBanner?.isOn() ?? false;
      const excluded = tab.aomExcluded;
      const showOff = aomOn && excluded;
      const iconHtml = showOff
        ? Icons.botOff({ size: 12 })
        : Icons.bot({ size: 12 });
      const badge = document.createElement("button");
      badge.type = "button";
      badge.className = "tab-bot-badge";
      if (showOff) badge.classList.add("tab-bot-badge--excluded");
      if (!aomOn) badge.classList.add("tab-bot-badge--inert");
      badge.innerHTML = iconHtml;
      badge.title = aomOn
        ? showOff
          ? "Excluded from AOM (manual). Click or ⌘⇧E to include."
          : "AOM is driving this tab. Click or ⌘⇧E to exclude."
        : "Operator enabled";
      badge.setAttribute(
        "aria-label",
        aomOn
          ? showOff
            ? "Excluded from AOM"
            : "AOM driving this tab"
          : "Operator enabled",
      );
      badge.addEventListener("mousedown", (e) => e.stopPropagation());
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!aomOn) return; // inert when AOM is off
        void this.toggleAomExcluded(tab.id);
      });
      pill.appendChild(badge);
    }

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
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = tabDisplayName(tab);
      pill.appendChild(label);
    }

    // Operator chip — shows avatar of the pinned operator.
    // Only rendered when the tab has an operator_id that we have
    // cached; absent otherwise (no cache hit = chip stays hidden).
    if (tab.operator_id) {
      const op = this.operatorCache.get(tab.operator_id) ?? null;
      if (op) {
        const opChip = document.createElement("span");
        opChip.className = "tab-op-chip";
        const level = operatorLevelFromXp(op.xp ?? 0);
        opChip.title = `${op.name} — Lv ${level} · ${op.xp ?? 0} XP`;
        opChip.innerHTML =
          `<span class="tab-op-avatar-wrap">` +
            `${renderAvatarHtml(op.emoji, 18)}` +
            `<span class="tab-op-level" data-operator-id="${op.id}">${level}</span>` +
          `</span>`;
        pill.appendChild(opChip);
      }
    }

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
    if (this.blockedSessionIds.has(tab.sessionId)) {
      this.applyEscalationDot(pill, true);
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
    if (tab.operatorEnabled) {
      tab.aomExcluded = await isAomExcluded(tab.sessionId).catch(
        () => tab.aomExcluded,
      );
    }

    const items: Parameters<ContextMenu["show"]>[2] = [
      {
        label: "Rename",
        icon: Icons.pencil(),
        onClick: () => this.startTabRename(tab.id),
      },
      { divider: true },
      {
        swatches: COLOR_SWATCHES.map((sw) => ({
          color: sw.color,
          title: sw.title,
          onClick: () => this.setColor(tab.id, sw.color),
        })),
      },
      { divider: true },
    ];

    // Group operations. Show "Move to: <existing groups>" then "New
    // group from this tab" then "Remove from group" if applicable.
    const otherGroups = Array.from(this.groups.values()).filter(
      (g) => g.id !== tab.groupId,
    );
    for (const g of otherGroups) {
      items.push({
        label: `Move to "${g.name}"`,
        icon: Icons.arrowRight(),
        onClick: () => this.addTabToGroup(tab.id, g.id),
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

    items.push({ divider: true });
    if (tab.mission) {
      items.push({
        label: "View mission…",
        icon: Icons.lightbulb(),
        onClick: () => this.viewMission(tab.id),
      });
    }
    items.push({
      label: tab.mission ? "Change mission…" : "Set mission…",
      icon: Icons.pencil(),
      onClick: () => this.promptAndSetMission(tab.id),
    });
    if (tab.mission) {
      items.push({
        label: "Clear mission",
        icon: Icons.x(),
        onClick: () => this.clearMission(tab.id),
      });
    }
    items.push({ divider: true });
    items.push({
      label: (tab.operatorEnabled || tab.operator_id) ? "Remove operator" : "Set operator",
      icon: Icons.bot(),
      onClick: () => {
        if (tab.operatorEnabled || tab.operator_id) {
          // Unpin + disable in one shot. setTabOperator(null) flips
          // operatorEnabled off and clears the avatar chip.
          void this.setTabOperator(tab.id, null);
        } else {
          this.onSetOperatorRequested?.(tab.sessionId);
        }
      },
    });
    if (tab.operatorEnabled) {
      if (aomOn) {
        // While AOM is global, the per-tab Live toggle is moot —
        // AOM forces live=true on every included tab. Surface that
        // truth in a disabled informational item, plus the per-tab
        // exclusion toggle so the user can leave specific tabs out
        // of AOM without disabling Operator.
        items.push({
          label: tab.aomExcluded
            ? "Operator: dry-run (excluded from AOM)"
            : "Operator: AOM is driving this tab (LIVE)",
          icon: Icons.bot(),
          disabled: true,
          onClick: () => {
            /* informational only */
          },
        });
        items.push({
          label: tab.aomExcluded
            ? "Include in AOM"
            : "Exclude from AOM (keep this tab manual)",
          icon: Icons.bot(),
          onClick: () => this.toggleAomExcluded(tab.id),
        });
      } else {
        // Normal day-mode: the per-tab Live toggle decides typing.
        items.push({
          label: tab.operatorLive
            ? "Operator: stop typing (back to dry-run)"
            : "Operator: start typing into this tab (LIVE)",
          icon: Icons.bot(),
          danger: !tab.operatorLive,
          onClick: () => this.toggleOperatorLive(tab.id),
        });
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
        label: "Rename group",
        icon: Icons.pencil(),
        onClick: () => this.startGroupRename(group.id),
      },
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
      { divider: true },
      {
        label: this.memberIndices(group.id).length === 0 ? "Delete group" : "Ungroup",
        icon: Icons.folderMinus(),
        danger: true,
        onClick: () => this.ungroup(group.id),
      },
    ]);
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
