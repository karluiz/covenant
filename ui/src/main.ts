// M2 entry point. Boots the TabManager with one initial tab, wires
// keyboard shortcuts (⌘T new, ⌘W close, ⌘1..9 jump, ⌘Shift+[ /]
// prev/next), and closes the app window when the last tab is gone.

import "@xterm/xterm/css/xterm.css";
import "./styles/operator_chip.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { dismissBootSplash } from "./boot-splash";
import { attachTooltip } from "./tooltip/tooltip";
import { runUpdateCheck } from "./updater/check";
import { showUpdateBanner } from "./updater/banner";
import { AgentPanel } from "./agent/panel";
import { AomActivityFeed } from "./aom/activity-feed";
import { AomBanner } from "./aom/banner";
import { installConnectivityBridge } from "./aom/connectivity";
import { playAomEntrySplash, playAomExitSplash } from "./aom/entry-splash";
import { AomReportPanel } from "./aom/report";
import {
  startSpecPrompts,
  ensureDetectorForRepo,
  getPendingSpecCandidateForTab,
  getSpecPromptState,
} from "./aom/spec-prompt";
import { installSpecLinkInterceptor } from "./aom/spec-link-menu";
import type { SessionId, SpecCandidate } from "./api";
import { AfkOverlay } from "./aom/afk";
import { Icons } from "./icons";
import { findSpecs, findRecentCommands, getSettings, getVitals, injectCommand, killSessionForeground, onTeammateMessage, onVitalsUpdate, operatorList, readBlockExcerpt, readSessionExcerpt, setOperatorEnabled, setOperatorLive, setWindowTheme, structureFindFiles, structureReadFile, tabManifestLoad, teammateAttachSessionToTask, teammateCancelActiveTask, teammateCancelTaskProposal, teammateClearForOperator, teammateConfirmTask, teammateEditTaskProposal, teammateListMessages, teammateListTasks, teammateSendText, writeToSession, zshAutosuggestionsStatus } from "./api";
import { resolveTheme, watchSystemTheme, type ThemeMode } from "./theme/mode";
import type { Settings, WindowBackground, TabStyle } from "./api";
import { DocsPanel } from "./docs/panel";
import { DraftsPanel } from "./drafts/panel";
import { MissionPage } from "./mission/page";
import { pushInfoToast, setSharedToastHost, ToastHost } from "./notifications/toast";
import { OperatorPanel } from "./operator/panel";
import { RecallPalette } from "./recall/palette";
import { ReleasePanel } from "./release/panel";
import { ShortcutsPanel } from "./shortcuts/panel";
import { GlobalSearchPalette } from "./search/palette";
import { SettingsPanel } from "./settings/panel";
import { CapabilitiesPanel } from "./capabilities/panel";
import { StatusBar } from "./status/bar";
import { TabManager, type TabManifestV1 } from "./tabs/manager";
import { activePane } from "./tabs/pane";
import { WorkspaceManager } from "./workspaces/manager";
import { WorkspaceSwitcher } from "./workspaces/switcher";

/// Module-level reference to the singleton TabManager. Assigned during
/// boot() and used by project-notes paste helper to resolve the active
/// session in a group without a Tauri round-trip.
export let tabsManager: TabManager | null = null;
export let workspacesManager: WorkspaceManager | null = null;
import { CollapsedRail } from "./tabs/collapsed-rail";
import { ConvergenceOverlay } from "./convergence/overlay";
import { makeTabsBridge } from "./convergence/tabs-bridge";
import { zoom } from "./zoom";
import { OperatorPicker } from "./operator/picker";
import { mountSpecChat } from "./spec-chat/index";
import { getPiPanel } from "./executors/pi/panel";
import { ProjectNotesPanel } from "./project-notes/panel";
import { SpawnsChip } from "./spawns/chip";
import { listSpawns } from "./spawns/api";
import { TeammatePanel } from "./teammate/panel";

type LastCallChoice = "use" | "without" | "cancel";

function showAomLastCallModal(cand: SpecCandidate): Promise<LastCallChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "spec-lastcall-overlay";
    const fileName = cand.path.split("/").pop() ?? cand.path;
    const escape = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    overlay.innerHTML = `
      <div class="spec-lastcall-modal">
        <h3>Detectamos <code>${escape(fileName)}</code></h3>
        <p>${escape(cand.goal_snippet)}</p>
        <p>¿Usarlo como misión antes de dormir?</p>
        <div class="spec-lastcall-actions">
          <button data-choice="use">Use it</button>
          <button data-choice="without">Engage without mission</button>
          <button data-choice="cancel">Cancel</button>
        </div>
      </div>
    `;
    const close = (choice: LastCallChoice) => {
      overlay.remove();
      resolve(choice);
    };
    overlay.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
        "button[data-choice]",
      );
      if (!btn) return;
      close(btn.dataset.choice as LastCallChoice);
    });
    document.body.appendChild(overlay);
  });
}

/// Set body class controlling --surface-alpha. Adds `bg-{kind}` and
/// removes the other two so toggling at runtime is idempotent.
function applyWindowBackground(kind: WindowBackground): void {
  const body = document.body;
  body.classList.remove("bg-solid", "bg-vibrant", "bg-translucent");
  body.classList.add(`bg-${kind}`);
}

let unwatchSystem: (() => void) | null = null;

/// Single source of truth for theme application. Resolves system mode,
/// flips the body class, calls the Rust effect swap, and reapplies the
/// xterm palette to every live terminal. Idempotent.
async function applyTheme(
  mode: ThemeMode,
  tabs: { applyTerminalTheme: () => void },
): Promise<void> {
  const resolved = resolveTheme(mode);
  const body = document.body;
  body.classList.toggle("theme-light", resolved === "light");
  body.classList.toggle("theme-dark", resolved === "dark");

  unwatchSystem?.();
  unwatchSystem = null;
  if (mode === "system") {
    unwatchSystem = watchSystemTheme((t) => {
      body.classList.toggle("theme-light", t === "light");
      body.classList.toggle("theme-dark", t === "dark");
      tabs.applyTerminalTheme();
      void setWindowTheme(t).catch(() => {});
    });
  }

  tabs.applyTerminalTheme();
  await setWindowTheme(resolved).catch(() => {});
}

/// Toggle the vertical-tabbar layout. CSS does the heavy lifting via
/// `body.tabbar-left`; the rest of the app stays layout-agnostic.
function applyTabbarPosition(pos: "top" | "left" | undefined): void {
  document.body.classList.toggle("tabbar-left", pos === "left");
}

/// Cosmetic tab skin. Like the theme/background toggles, this only
/// flips a body class — `body.tab-style-forge` — and CSS reskins the
/// pills + group chips in both horizontal and vertical layouts. The
/// default ("classic") carries no class so the shipped look is the
/// no-class baseline.
function applyTabStyle(style: TabStyle | undefined): void {
  document.body.classList.toggle("tab-style-forge", style === "forge");
}

/// Override the chrome font stack. Empty / null restores the default
/// defined in `:root { --ui-font: ... }`. Setting any string replaces
/// the variable for the whole document — every UI element that uses
/// `var(--ui-font)` updates instantly via CSS cascade.
function applyUiFont(stack: string | null | undefined): void {
  const root = document.documentElement;
  if (stack && stack.trim() !== "") {
    root.style.setProperty("--ui-font", stack);
  } else {
    root.style.removeProperty("--ui-font");
  }
}

const TABBAR_LEFT_COLLAPSED_KEY = "covenant.tabbar-left-collapsed";
const LEFT_SIDEBAR_WIDTH_KEY = "covenant.left-sidebar-width";
const RIGHT_SIDEBAR_WIDTH_KEY = "covenant.right-sidebar-width";
const LEFT_SIDEBAR_DEFAULT = 232;
const RIGHT_SIDEBAR_DEFAULT = 240;
const LEFT_SIDEBAR_MIN = 180;
const LEFT_SIDEBAR_MAX = 420;
const RIGHT_SIDEBAR_MIN = 180;
const RIGHT_SIDEBAR_MAX = 520;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function readStoredPx(key: string, fallback: number, min: number, max: number): number {
  const raw = localStorage.getItem(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? clamp(n, min, max) : fallback;
}

function setRootPx(name: string, px: number): void {
  document.documentElement.style.setProperty(name, `${Math.round(px)}px`);
}

function applyStoredSidebarWidths(): void {
  setRootPx(
    "--tabbar-w-expanded",
    readStoredPx(LEFT_SIDEBAR_WIDTH_KEY, LEFT_SIDEBAR_DEFAULT, LEFT_SIDEBAR_MIN, LEFT_SIDEBAR_MAX),
  );
  setRootPx(
    "--right-sidebar-w",
    readStoredPx(RIGHT_SIDEBAR_WIDTH_KEY, RIGHT_SIDEBAR_DEFAULT, RIGHT_SIDEBAR_MIN, RIGHT_SIDEBAR_MAX),
  );
}

function installSidebarResizers(layout: HTMLElement, manager: TabManager): void {
  const mk = (id: string): HTMLElement => {
    const el = document.createElement("div");
    el.id = id;
    el.className = "sidebar-resizer";
    el.setAttribute("role", "separator");
    el.setAttribute("aria-orientation", "vertical");
    layout.appendChild(el);
    return el;
  };
  const left = mk("left-sidebar-resizer");
  const right = mk("right-sidebar-resizer");

  const beginDrag = (
    e: PointerEvent,
    side: "left" | "right",
  ): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const key = side === "left" ? LEFT_SIDEBAR_WIDTH_KEY : RIGHT_SIDEBAR_WIDTH_KEY;
    const cssName = side === "left" ? "--tabbar-w-expanded" : "--right-sidebar-w";
    const min = side === "left" ? LEFT_SIDEBAR_MIN : RIGHT_SIDEBAR_MIN;
    const max = side === "left" ? LEFT_SIDEBAR_MAX : RIGHT_SIDEBAR_MAX;
    const fallback = side === "left" ? LEFT_SIDEBAR_DEFAULT : RIGHT_SIDEBAR_DEFAULT;
    const startWidth = readStoredPx(key, fallback, min, max);
    const prevSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.classList.add("sidebar-resizing");
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    let current = startWidth;
    const apply = (w: number): void => {
      current = clamp(w, min, max);
      setRootPx(cssName, current);
      if (side === "right") {
        document.querySelectorAll<HTMLElement>(".tab-pane").forEach((pane) => {
          const cols = pane.style.gridTemplateColumns;
          if (!cols) return;
          pane.style.gridTemplateColumns = cols.replace(/(\S+\s+\S+\s+\S+\s+)\d+(?:\.\d+)?px$/, `$1${Math.round(current)}px`);
        });
      }
      // Intentionally do NOT refit/resize the PTY during the drag — xterm's
      // canvas stretches via CSS, and per-frame fit()+resizeSession() makes
      // the shell repaint and the WebGL layer flash. We refit once on pointerup.
    };
    const onMove = (ev: PointerEvent): void => {
      const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
      apply(startWidth + delta);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      document.body.classList.remove("sidebar-resizing");
      document.body.style.userSelect = prevSelect;
      document.body.style.cursor = prevCursor;
      localStorage.setItem(key, String(Math.round(current)));
      manager.refitActive();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
  };

  left.addEventListener("pointerdown", (e) => beginDrag(e, "left"));
  right.addEventListener("pointerdown", (e) => beginDrag(e, "right"));
}

/// Toggle the collapsed state of the vertical tabbar. Only meaningful
/// when `body.tabbar-left` is active; in top mode the fold chevron is
/// hidden by CSS so the body class is harmless.
function applyTabbarCollapsed(collapsed: boolean): void {
  document.body.classList.toggle("tabbar-left-collapsed", collapsed);
  const btn = document.getElementById("tabbar-fold");
  if (btn) {
    const t = collapsed ? "Expand sidebar" : "Collapse sidebar";
    btn.removeAttribute("title");
    btn.setAttribute("aria-label", t);
    btn.innerHTML = collapsed
      ? Icons.panelLeftOpen({ size: 16 })
      : Icons.panelLeftClose({ size: 16 });
  }
}

function applyBlocksCollapsed(collapsed: boolean): void {
  document.body.classList.toggle("blocks-globally-collapsed", collapsed);
  const btn = document.getElementById("tabbar-fold-right");
  if (btn) {
    const t = collapsed ? "Expand right sidebar" : "Collapse right sidebar";
    btn.removeAttribute("title");
    btn.setAttribute("aria-label", t);
    btn.innerHTML = collapsed
      ? Icons.panelRightOpen({ size: 16 })
      : Icons.panelRightClose({ size: 16 });
  }
}

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`missing #${id} element`);
  return el;
}

/// Wait until Tauri's IPC bridge (`window.__TAURI_INTERNALS__`) is
/// injected into the webview. With `withGlobalTauri: true` it should
/// be present from the first frame, but Vite's HMR sometimes races
/// against Tauri's bootstrap on macOS WebKit. Up to 1s polling.
async function waitForTauri(): Promise<void> {
  if (typeof window === "undefined") return;
  const w = window as unknown as Record<string, unknown>;
  for (let i = 0; i < 50; i++) {
    if (w.__TAURI_INTERNALS__ || w.__TAURI__) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  // Diagnostic: show what's actually on window so we can tell whether
  // we're in Safari, vite-only, or a broken Tauri context.
  const tauriKeys = Object.keys(w).filter((k) =>
    k.toUpperCase().includes("TAURI"),
  );
  const ua = (navigator as Navigator | undefined)?.userAgent ?? "?";
  throw new Error(
    `Tauri IPC bridge not available. Tauri-related globals: ${
      tauriKeys.length ? tauriKeys.join(", ") : "(none)"
    }. UA: ${ua}`,
  );
}

function isMacPlatform(): boolean {
  // Tauri 2 doesn't expose platform synchronously to the webview, so
  // sniff UA. Reasonable since our bundle currently targets macOS.
  return /Mac|iPod|iPhone|iPad/i.test(navigator.userAgent);
}

const MOD_KEY = isMacPlatform() ? "⌘" : "Ctrl+";

const AUTOSUGGEST_HINT_KEY = "covenant.autosuggest-hint-shown";

async function maybeHintAutosuggestions(toasts: ToastHost): Promise<void> {
  if (localStorage.getItem(AUTOSUGGEST_HINT_KEY) === "1") return;
  let status: { found: boolean };
  try {
    status = await zshAutosuggestionsStatus();
  } catch {
    return;
  }
  if (status.found) {
    // Don't nag if the user already has it. Burn the flag so a
    // future uninstall doesn't re-trigger on the next launch either —
    // we offer the hint exactly once, then trust the user.
    localStorage.setItem(AUTOSUGGEST_HINT_KEY, "1");
    return;
  }
  toasts.pushInfo({
    message:
      "Inline autocomplete unavailable. Click to copy install command (brew install zsh-autosuggestions).",
    onClick: () => {
      void navigator.clipboard.writeText("brew install zsh-autosuggestions");
      localStorage.setItem(AUTOSUGGEST_HINT_KEY, "1");
    },
  });
}

function formatBudgetDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

async function boot(): Promise<void> {
  await waitForTauri();

  // Window title carries the running version — visible in the macOS
  // top bar + app switcher so it's clear which build is which when
  // multiple installs coexist (DMG vs `tauri dev`).
  try {
    await getCurrentWindow().setTitle(`Covenant v${__APP_VERSION__}`);
  } catch {
    /* setTitle can race with the window's first frame on cold boot —
       not fatal, the static title from tauri.conf.json shows in the
       interim. */
  }

  // UI zoom — apply the persisted level BEFORE the first layout pass
  // so the user doesn't see a flash at 100% when their saved zoom is
  // 120%. Also subscribes the TabManager later (after it's created)
  // so xterm refits when the user changes zoom mid-session.
  zoom.init();

  // Apply persisted window-background mode as early as possible so the
  // first paint already reflects the user's choice (no flash from the
  // CSS default). Falls back to "vibrant" if settings unreachable.
  // Also captures status_bar_enabled on the same round trip so the bar
  // can be wired with the right initial visibility.
  let initialSettings: Settings | null = null;
  try {
    initialSettings = await invoke<Settings>("get_settings");
    applyWindowBackground(initialSettings.window?.background ?? "vibrant");
    applyTabbarPosition(initialSettings.tabbar_position ?? "top");
    applyTabStyle(initialSettings.window?.tab_style ?? "classic");
    applyUiFont(initialSettings.ui_font_family);
  } catch {
    applyWindowBackground("vibrant");
    applyTabbarPosition("top");
    applyTabStyle("classic");
    applyUiFont(null);
  }
  // Set the theme class before the TabManager exists so first-run chrome
  // (especially the boot splash) immediately gets the light/dark skin.
  // applyTheme() runs again below once terminals are available.
  const initialThemeMode = (initialSettings?.window?.theme ?? "system") as ThemeMode;
  const initialResolvedTheme = resolveTheme(initialThemeMode);
  document.body.classList.toggle("theme-light", initialResolvedTheme === "light");
  document.body.classList.toggle("theme-dark", initialResolvedTheme === "dark");
  applyTabbarCollapsed(localStorage.getItem(TABBAR_LEFT_COLLAPSED_KEY) === "1");
  applyStoredSidebarWidths();

  const tabbar = requireEl<HTMLElement>("tabs");
  tabbar.addEventListener("wheel", (e) => {
    if (document.body.classList.contains("tabbar-left")) return;
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (dx === 0) return;
    tabbar.scrollLeft += dx;
    e.preventDefault();
  }, { passive: false });
  const workspace = requireEl<HTMLElement>("workspace");
  const newTabBtn = requireEl<HTMLElement>("new-tab");
  const newGroupBtn = requireEl<HTMLButtonElement>("new-group");
  const tabbarFoldBtn = requireEl<HTMLButtonElement>("tabbar-fold");
  attachTooltip(tabbarFoldBtn, "Toggle left sidebar");

  tabbarFoldBtn.addEventListener("click", () => {
    const next = !document.body.classList.contains("tabbar-left-collapsed");
    applyTabbarCollapsed(next);
    localStorage.setItem(TABBAR_LEFT_COLLAPSED_KEY, next ? "1" : "0");
    // xterm needs to remeasure cells after the column width animation.
    setTimeout(() => manager.refitActive(), 320);
  });

  const collapseAllBtn = requireEl<HTMLButtonElement>("tabbar-collapse-all");
  collapseAllBtn.innerHTML = Icons.chevronsDownUp({ size: 16 });
  attachTooltip(collapseAllBtn, "Collapse all groups");
  // Titlebar Blocks/Files/Activity view switch — dispatches a global event each
  // tab listens to. Active class on the buttons mirrors the active view.
  const viewBlocksBtn = document.getElementById("titlebar-view-blocks");
  const viewFilesBtn = document.getElementById("titlebar-view-files");
  const viewActivityBtn = document.getElementById("titlebar-view-activity");
  const viewRecallBtn = document.getElementById("titlebar-view-recall");
  type SidebarTitlebarView = "blocks" | "structure" | "activity" | "recall";
  const ACTIVITY_KEY = "covenant.sidebar-view-activity";
  const BLOCKS_GLOBAL_KEY = "covenant.blocks-globally-collapsed";
  let activeSidebarTitlebarView: SidebarTitlebarView =
    localStorage.getItem(ACTIVITY_KEY) === "1" ? "activity" : "blocks";
  const syncSidebarTitlebarButtons = (view: SidebarTitlebarView): void => {
    activeSidebarTitlebarView = view;
    viewBlocksBtn?.classList.toggle("titlebar-view-active", view === "blocks");
    viewFilesBtn?.classList.toggle("titlebar-view-active", view === "structure");
    viewActivityBtn?.classList.toggle("titlebar-view-active", view === "activity");
    viewRecallBtn?.classList.toggle("titlebar-view-active", view === "recall");
    document.body.classList.toggle("sidebar-view-activity", view === "activity");
  };
  if (viewBlocksBtn && viewFilesBtn && viewActivityBtn) {
    viewBlocksBtn.innerHTML = Icons.terminal({ size: 14 });
    viewFilesBtn.innerHTML = Icons.folder({ size: 14 });
    viewActivityBtn.innerHTML = Icons.zap({ size: 14 });
    if (viewRecallBtn) viewRecallBtn.innerHTML = Icons.history({ size: 14 });
    attachTooltip(viewBlocksBtn, "Blocks");
    attachTooltip(viewFilesBtn, "Files");
    attachTooltip(viewActivityBtn, "Activity");
    if (viewRecallBtn) attachTooltip(viewRecallBtn, "Recall");
    // Activity is a global view (not per-tab) so we only forward
    // blocks/structure to the tab-level listener. When activity is
    // selected we just flip the body class; the global aside renders
    // itself.
    const setView = (view: SidebarTitlebarView): void => {
      syncSidebarTitlebarButtons(view);
      if (view !== "activity") {
        localStorage.removeItem(ACTIVITY_KEY);
        window.dispatchEvent(
          new CustomEvent("sidebar-view:set", { detail: { view } }),
        );
      } else {
        localStorage.setItem(ACTIVITY_KEY, "1");
      }
    };
    const pickView = (view: SidebarTitlebarView): void => {
      const wasProjectNotesOpen = document.body.classList.contains("project-notes-open");
      const wasCollapsed = document.body.classList.contains("blocks-globally-collapsed");
      if (view !== "activity" && manager.activeKind() === "pi") {
        pushInfoToast({
          message: "Blocks and Files are available on terminal tabs. Switch to a shell tab first.",
        });
        return;
      }
      window.dispatchEvent(new CustomEvent("project-notes:close"));
      window.dispatchEvent(new CustomEvent("teammate:close"));

      // Treat each titlebar view icon as a toggle: clicking the already-open
      // rail closes it, clicking any other icon swaps that same rail in place.
      if (!wasProjectNotesOpen && !wasCollapsed && activeSidebarTitlebarView === view) {
        applyBlocksCollapsed(true);
        localStorage.setItem(BLOCKS_GLOBAL_KEY, "1");
        setTimeout(() => manager.refitActive(), 320);
        return;
      }

      if (wasCollapsed) {
        applyBlocksCollapsed(false);
        localStorage.removeItem(BLOCKS_GLOBAL_KEY);
        setTimeout(() => manager.refitActive(), 320);
      }
      setView(view);
    };
    viewBlocksBtn.addEventListener("click", () => pickView("blocks"));
    viewFilesBtn.addEventListener("click", () => pickView("structure"));
    viewActivityBtn.addEventListener("click", () => pickView("activity"));
    viewRecallBtn?.addEventListener("click", () => pickView("recall"));
    window.addEventListener("sidebar-view:active", (e) => {
      const v = (e as CustomEvent<{ view: "blocks" | "structure" }>).detail.view;
      // Teammate panel owns the right rail. Do not light two titlebar view
      // buttons at once.
      if (document.body.classList.contains("sidebar-view-teammate")) return;
      // Tabs only know about blocks/structure — respect the activity
      // override if it's currently active.
      if (document.body.classList.contains("sidebar-view-activity")) return;
      // Project Notes temporarily owns the right rail. Track the tab's
      // underlying view, but do not light two titlebar view buttons at once.
      if (document.body.classList.contains("project-notes-open")) {
        activeSidebarTitlebarView = v;
        return;
      }
      syncSidebarTitlebarButtons(v);
    });
    // Restore titlebar state on reload.
    syncSidebarTitlebarButtons(activeSidebarTitlebarView);
  }

  const teammatePanelHost = requireEl<HTMLElement>("teammate-panel");
  const teammatePanel = new TeammatePanel(teammatePanelHost, {
    listMessages: teammateListMessages,
    sendText: teammateSendText,
    listOperators: operatorList,
    onMessage: onTeammateMessage,
    getActiveSessionId: () => {
      const sid = manager.activeSessionId();
      return sid ? sid.toString() : null;
    },
    getActiveSessionCwd: () => manager.activeCwd(),
    mentionSources: {
      findFiles:          structureFindFiles,
      listOperators:      operatorList,
      listOpenSessions:   () => manager.listOpenSessions(),
      findRecentCommands,
      findSpecs,
    },
    readFile:           structureReadFile,
    readBlockExcerpt,
    readSessionExcerpt,
    spawnTabForTask: async (task, overrides) => {
      // Inherit cwd + group from the active tab's workspace so the
      // spawned tab visually belongs to the same stripe and lands in
      // the project's root dir — not a generic home/root shell.
      // Overrides win (used by Continue to recover original metadata
      // post-restart, when the active tab may be unrelated).
      const group = manager.activeGroup();
      const cwd = overrides?.cwd ?? group?.rootDir ?? manager.activeCwd();
      const groupId = overrides?.groupId ?? group?.id ?? null;
      const color = overrides?.color ?? group?.color ?? null;
      const tab = await manager.createTab({
        customName: `${task.title.slice(0, 32)}`,
        cwd,
        groupId,
        color,
      });
      if (!tab) throw new Error("createTab returned null");
      const pane = activePane(tab);
      return {
        sessionId: (pane.sessionId ?? "").toString(),
        cwd: pane.cwd || cwd,
        groupId: tab.groupId ?? groupId,
        color: tab.color ?? color,
      };
    },
    isSessionAlive: (sessionId) => !!manager.tabForSession(sessionId as SessionId),
    unbindOperatorFromTab: async (sessionId) => {
      const tab = manager.tabForSession(sessionId as SessionId);
      if (!tab) return;
      // Flip AOM off at the tab level FIRST — setTabOperator(null)
      // doesn't touch operatorEnabled, so leaving it true keeps the
      // tab visible in the AOM count even though it has no operator.
      const pane = activePane(tab);
      if (pane.sessionId) {
        await setOperatorLive(pane.sessionId as SessionId, false).catch(() => undefined);
        await setOperatorEnabled(pane.sessionId as SessionId, false).catch(() => undefined);
      }
      await manager.setTabOperator(tab.id, null);
      await manager.refreshAllOperatorState().catch(() => undefined);
    },
    confirmTask: teammateConfirmTask,
    cancelTaskProposal: teammateCancelTaskProposal,
    editTaskProposal: teammateEditTaskProposal,
    attachSessionToTask: teammateAttachSessionToTask,
    listTasks: teammateListTasks,
    clearForOperator: teammateClearForOperator,
    focusTabBySessionId: (sessionId) => manager.activateBySessionId(sessionId as SessionId),
    getActiveExecutor: () => manager.activeExecutor(),
    bindOperatorToTab: async (sessionId, operatorId) => {
      const tab = manager.tabForSession(sessionId as SessionId);
      if (!tab) return;
      await manager.setTabOperator(tab.id, operatorId);
      const pane = activePane(tab);
      if (pane.sessionId) {
        await setOperatorEnabled(pane.sessionId as SessionId, true);
        await setOperatorLive(pane.sessionId as SessionId, true);
      }
      // Re-read backend state into the tab + repaint ring/status bar.
      await manager.refreshAllOperatorState();
    },
    openSpec: (path) => manager.openFileAtLine(path),
    cancelActiveTask: teammateCancelActiveTask,
    closeTabBySessionId: (sessionId) => {
      const tab = manager.tabForSession(sessionId as SessionId);
      if (tab) manager.closeTab(tab.id);
    },
  });
  const teammateBtn = document.getElementById("titlebar-view-teammate");

  /// Close the teammate rail if open. Safe to call from any toggle that
  /// claims the right rail — the right rail is a single slot, no two
  /// panels should ever render together.
  const closeTeammateIfOpen = (): void => {
    if (!document.body.classList.contains("sidebar-view-teammate")) return;
    document.body.classList.remove("sidebar-view-teammate");
    teammatePanelHost.setAttribute("hidden", "");
    teammatePanel.close();
    teammateBtn?.classList.remove("titlebar-view-active");
  };
  window.addEventListener("teammate:close", () => closeTeammateIfOpen());

  if (teammateBtn) {
    teammateBtn.innerHTML = Icons.messageCircle({ size: 14 });
    attachTooltip(teammateBtn, "Teammate chat");
    teammateBtn.addEventListener("click", async () => {
      const wasOpen = document.body.classList.contains("sidebar-view-teammate");

      if (wasOpen) {
        closeTeammateIfOpen();
        // Restore the previous tabs-view button highlight (blocks/files/activity).
        syncSidebarTitlebarButtons(activeSidebarTitlebarView);
        return;
      }

      // Opening teammate claims the right rail — make every competing panel
      // step aside first.
      window.dispatchEvent(new CustomEvent("project-notes:close"));
      document.body.classList.remove("sidebar-view-activity");
      document
        .querySelectorAll("#app-titlebar-right .titlebar-view-active")
        .forEach((b) => b.classList.remove("titlebar-view-active"));

      document.body.classList.add("sidebar-view-teammate");
      teammateBtn.classList.add("titlebar-view-active");
      teammatePanelHost.removeAttribute("hidden");

      const ops = await operatorList();
      const def = ops.find((o) => o.is_default) ?? ops[0];
      if (def) {
        await teammatePanel.openFor(def);
      } else {
        teammatePanelHost.innerHTML =
          `<div class="teammate-panel-empty">No hay operadores configurados. Andá a Settings → Operators.</div>`;
      }
    });
  }

  const projectNotesBtn = document.getElementById("titlebar-project-notes");
  if (projectNotesBtn) {
    projectNotesBtn.innerHTML = Icons.clipboard({ size: 16 });
    attachTooltip(projectNotesBtn, "Project notes");
    projectNotesBtn.addEventListener("click", () => {
      if (activeProjectNotesPanel) {
        activeProjectNotesPanel.close();
        return;
      }
      if (document.body.classList.contains("blocks-globally-collapsed")) {
        applyBlocksCollapsed(false);
        localStorage.removeItem(BLOCKS_GLOBAL_KEY);
        setTimeout(() => manager.refitActive(), 320);
      }
      const g = manager.activeGroup();
      // openProjectNotes() closes competing right-rail panels.
      if (g) openProjectNotes(g.id, g.name, g.color ?? null);
    });
  }

  const foldRightBtn = document.getElementById("tabbar-fold-right");
  if (foldRightBtn) {
    attachTooltip(foldRightBtn, "Toggle right sidebar");
    applyBlocksCollapsed(localStorage.getItem(BLOCKS_GLOBAL_KEY) === "1");
    foldRightBtn.addEventListener("click", () => {
      const next = !document.body.classList.contains("blocks-globally-collapsed");
      if (next && activeProjectNotesPanel) activeProjectNotesPanel.close();
      applyBlocksCollapsed(next);
      if (next) localStorage.setItem(BLOCKS_GLOBAL_KEY, "1");
      else localStorage.removeItem(BLOCKS_GLOBAL_KEY);
      setTimeout(() => manager.refitActive(), 320);
    });
  }
  collapseAllBtn.addEventListener("click", () => {
    manager.collapseAllGroups();
  });

  // Programmatic window drag from the custom title bar. `position:
  // fixed` overlays don't always trigger `-webkit-app-region: drag`
  // reliably, so we forward mousedown explicitly via Tauri's
  // startDragging API.
  const titlebarEl = document.getElementById("app-titlebar");
  if (titlebarEl) {
    titlebarEl.addEventListener("mousedown", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("button") || t.closest("a"))) return;
      if (e.button !== 0) return;
      e.preventDefault();
      void getCurrentWindow().startDragging();
    });
    titlebarEl.addEventListener("dblclick", (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("button") || t.closest("a"))) return;
      void getCurrentWindow()
        .isMaximized()
        .then((m) => (m ? getCurrentWindow().unmaximize() : getCurrentWindow().maximize()));
    });
    // Reflect fullscreen state via a body class so the title bar can
    // drop the traffic-light gutter (macOS hides the lights in fs).
    const syncFullscreen = (): void => {
      void getCurrentWindow()
        .isFullscreen()
        .then((fs) => document.body.classList.toggle("app-fullscreen", !!fs));
    };
    syncFullscreen();
    void getCurrentWindow().onResized(() => syncFullscreen());
  }

  // Render the new-tab button with its keyboard hint visible inline,
  // adapted to the host platform's modifier symbol.
  newTabBtn.innerHTML = `
    <span class="new-tab-plus">${Icons.terminal({ size: 14 })}</span>
    <kbd class="new-tab-kbd">${MOD_KEY}T</kbd>
  `;
  attachTooltip(newTabBtn, `New tab (${MOD_KEY}T)`);

  newGroupBtn.innerHTML = `
    <span class="new-tab-plus">${Icons.folderPlus({ size: 14 })}</span>
    <kbd class="new-tab-kbd">${MOD_KEY}⇧G</kbd>
  `;
  attachTooltip(newGroupBtn, `New group (${MOD_KEY}⇧G)`);

  const manager = new TabManager(tabbar, workspace, newTabBtn, () => {
    // Closing the last tab quits the app — matches iTerm/Terminal.app.
    void getCurrentWindow().close();
  });
  tabsManager = manager;
  installSidebarResizers(requireEl<HTMLElement>("layout"), manager);

  const publishActivityActiveSession = (): void => {
    const sessionId = manager.activeSessionId();
    const tabId = manager.getActiveTabId();
    const tabName = tabId ? manager.getTabLabel(tabId) : null;
    const group = manager.activeGroup();
    const tabLabel = tabName ? (group ? `${group.name} › ${tabName}` : tabName) : null;
    window.dispatchEvent(
      new CustomEvent("ui:active-session", {
        detail: {
          session_id: sessionId,
          agent: manager.activeExecutor(),
          tab_label: tabLabel,
        },
      }),
    );
  };

  // Initial theme apply now that the TabManager exists. Settings may have
  // been unreachable at the early boot block above — fall back to "system".
  void applyTheme(initialThemeMode, manager);

  // Late-binding ref so the spawns chip onAdd callback can open Settings
  // even though SettingsPanel is instantiated further down in boot().
  const settingsRef: { panel: SettingsPanel | null } = { panel: null };

  // Spawns chip — titlebar chip + popover wired to backend.
  const spawnsMount = document.getElementById("spawns-chip-mount");
  if (spawnsMount) {
    const runSpawn = (id: string): void => {
      void (async () => {
        const sid = manager.activeSessionId();
        if (!sid) return;
        const specs = await listSpawns();
        const spec = specs.find((s) => s.id === id);
        if (!spec || !spec.command) return;
        const cmdline = [spec.command, ...spec.args].join(" ") + "\n";
        const bytes = new TextEncoder().encode(cmdline);
        await writeToSession(sid, bytes);
        manager.setActiveSpawnId(spec.id);
        void chip.refresh();
      })();
    };
    const chip = new SpawnsChip(spawnsMount, {
      list: listSpawns,
      getBoundId: () => manager.activeSpawnId(),
      onSelect: runSpawn,
      onRun: runSpawn,
      onAdd: () => { void settingsRef.panel?.open("spawns"); },
    });
    manager.onActiveSpawnChange = (_spawnId) => {
      void chip.refresh();
    };
    void chip.refresh();
  }

  // Construct the WorkspaceManager up-front so listeners wired before
  // boot() (settings import/export, switcher chip) can reference it.
  // Actual tab restoration happens later in workspaceManager.boot().
  const workspaceManager = new WorkspaceManager(manager);
  workspacesManager = workspaceManager;

  // Thread workspace context into the TabManager so the group context
  // menu can populate the "Move to workspace…" submenu and createTab
  // can fall back to the active workspace's root_dir when no tab/group
  // cwd is set.
  manager.setWorkspaceCatalog(
    () => workspaceManager.list().map((w) => ({ id: w.id, name: w.name, active: w.active })),
    (groupId, wsId) => workspaceManager.moveGroupTo(groupId, wsId),
  );
  manager.setActiveWorkspaceRootDirGetter(() => workspaceManager.getActive().root_dir);

  // Mount the workspace switcher chip into its own row above the
  // Covenant wordmark so the brand text isn't truncated. Chip
  // auto-rerenders via WorkspaceManager.onChange.
  const tabbarActions = document.getElementById("tabbar-actions");
  const switcher = new WorkspaceSwitcher(workspaceManager, manager);
  if (tabbarActions) switcher.mount(tabbarActions);

  newGroupBtn.addEventListener("click", () => {
    manager.createEmptyGroup();
  });

  // Collapsed rail (variant 6). Active only in vertical-tabbar +
  // collapsed mode; CSS handles visibility, the component just keeps
  // its DOM in sync with the manager's render cycle.
  const railHost = requireEl<HTMLElement>("tabbar-rail");
  new CollapsedRail(railHost, {
    snapshot: () => manager.getRailSnapshot(),
    selectTab: (id) => manager.activate(id),
    setOnAfterRender: (cb) => {
      manager.onAfterRender = cb;
    },
  });

  const convergence = new ConvergenceOverlay(makeTabsBridge(manager));

  // 3.7 status bar — bottom of #layout. Hidden when status_bar_enabled
  // is false (collapses the third grid row). TabManager pushes the
  // active-tab cwd on activation + cwd_changed.
  const statusBarHost = requireEl<HTMLElement>("status-bar");
  const statusBar = new StatusBar(statusBarHost);
  statusBar.setEnabled(initialSettings?.status_bar_enabled ?? true);
  // Activity sidebar — single global instance, rendered into the right
  // column when the user picks the Activity view (and always available
  // when fullscreen hides the floating notch). Same D-combo layout as
  // the mockup: active-agent header + chronological activity stream.
  const activityHost = document.getElementById("activity-sidebar");
  if (activityHost instanceof HTMLElement) {
    void import("./inline-notch").then((m) => {
      m.mountInlineNotch(activityHost);
      publishActivityActiveSession();
    });
  }
  manager.onActiveContextChange = (cwd) => {
    statusBar.setCwd(cwd);
    if (cwd) void ensureDetectorForRepo(cwd);
  };
  manager.onAnyTabContextChange = (cwd) => {
    if (cwd) void ensureDetectorForRepo(cwd);
  };
  manager.onActiveTabChange = (info) => {
    statusBar.setActiveTab(info);
  };
  // Tell the vitals aggregator which session's snapshot should drive
  // the status-bar cluster. Other sessions' summariser / fix-proposer
  // bursts still accumulate per-session in the backend — they just
  // don't paint until the user switches to that tab.
  manager.onActiveSessionChange = (sessionId) => {
    void invoke("set_active_session_for_vitals", { sessionId });
    publishActivityActiveSession();
  };
  manager.onActiveMissionChange = (mission, sessionId) =>
    statusBar.setMission(mission, sessionId);
  // Mirror the active tab's Operator state into the status bar — the
  // per-tab pill icon was removed in favor of this single chip so the
  // tab strip stays minimal.
  manager.onActiveOperatorChange = (state, sessionId) =>
    statusBar.setOperator(state, sessionId);
  manager.onActiveOperatorEntityChange = (op) =>
    statusBar.setOperatorEntity(op);
  manager.onActiveExecutorChange = () => publishActivityActiveSession();
  // Tab context-menu "View mission…" reuses the same modal as the
  // status-bar chip — keep the rendering in one place.
  manager.onMissionViewRequested = (mission, sessionId) =>
    void statusBar.openMissionFor(mission, sessionId);
  let closeWorkspacePagesForMission: () => void = () => {};
  const openMissionFromStatusBar = (sessionId: SessionId): void => {
    closeWorkspacePagesForMission();
    manager.promptAndSetMissionForSession(sessionId);
  };
  // Inverse direction: the "+ Set mission" affordance the status bar
  // surfaces on project-like cwds clicks back into TabManager so the
  // file-picker prompt is a single shared flow with the tab menu.
  statusBar.onMissionSetRequested = openMissionFromStatusBar;
  statusBar.onMissionEditRequested = openMissionFromStatusBar;
  statusBar.onMissionClearRequested = (sessionId) =>
    manager.clearMissionForSession(sessionId);
  statusBar.onOpenGitWorktree = (path, label) => {
    void manager.createTab({ cwd: path, customName: label });
  };

  // Post-publish toast "Open in Set Mission" fires this event with the
  // published spec path so we can wire it directly into the active tab
  // without going through the file-picker prompt.
  window.addEventListener("mission:set", (e) => {
    const detail = (e as CustomEvent<{ path: string }>).detail;
    void manager.setMissionPathForActiveTab(detail.path);
  });

  // Project Notes panel — singleton right sidebar, opened from group-chip or ⌘⇧J.
  let activeProjectNotesPanel: ProjectNotesPanel | null = null;
  let projectNotesReturnView: SidebarTitlebarView | null = null;
  window.addEventListener("project-notes:close", () => activeProjectNotesPanel?.close());

  function openProjectNotes(
    groupId: string,
    groupLabel: string,
    groupColor: string | null,
    opts?: { defaultTab?: "commands" | "notes" | "docs" | "drafts" },
  ): void {
    if (activeProjectNotesPanel) activeProjectNotesPanel.close();
    // Project Notes claims the right rail — close any competing panel
    // first so two never render together.
    window.dispatchEvent(new CustomEvent("teammate:close"));
    projectNotesReturnView = activeSidebarTitlebarView;
    document.body.classList.add("project-notes-open");
    document.body.classList.remove("sidebar-view-activity");
    projectNotesBtn?.classList.add("titlebar-view-active");
    viewBlocksBtn?.classList.remove("titlebar-view-active");
    viewFilesBtn?.classList.remove("titlebar-view-active");
    viewActivityBtn?.classList.remove("titlebar-view-active");
    teammateBtn?.classList.remove("titlebar-view-active");
    const groupRootDir = manager.groupRootDirFor(groupId);
    activeProjectNotesPanel = new ProjectNotesPanel({
      groupId,
      groupLabel,
      groupColor,
      groupRootDir,
      defaultTab: opts?.defaultTab,
      onClose: () => {
        activeProjectNotesPanel = null;
        document.body.classList.remove("project-notes-open");
        projectNotesBtn?.classList.remove("titlebar-view-active");
        const restoreView = projectNotesReturnView ?? activeSidebarTitlebarView;
        projectNotesReturnView = null;
        syncSidebarTitlebarButtons(restoreView);
      },
      onOpenFile: (absolutePath) => {
        manager.openFileAtLine(absolutePath);
        activeProjectNotesPanel?.close();
      },
      onOpenWizard: (_repoRoot) => {
        // Keep the Project Notes drawer open underneath — the spec-chat
        // overlay is fixed/z-index 10100, so it sits on top. Closing the
        // drawer here would also restore the previous sidebar view
        // (usually Blocks), which felt like the wizard "vanished".
        window.dispatchEvent(new CustomEvent("spec-chat:open"));
      },
      onSetRootDir: (gid) => manager.pickGroupRootDir(gid),
    }).mount(document.body);
  }

  manager.setOptions({
    onOpenProjectNotes: openProjectNotes,
  });

  void listen<{ repoRoot: string; slug: string; title: string }>("draft:saved", (e) => {
    const { repoRoot, slug, title } = e.payload;
    if (activeProjectNotesPanel) {
      const openGroupId = activeProjectNotesPanel.groupId;
      const openRoot = manager.groupRootDirFor(openGroupId);
      if (openRoot === repoRoot) {
        const g = manager.activeGroup();
        if (g && g.id === openGroupId) {
          openProjectNotes(g.id, g.name, g.color ?? null, { defaultTab: "drafts" });
        }
      }
    }
    pushInfoToast({
      message: `Draft saved: ${title}`,
      onClick: () => {
        manager.openFileAtLine(`${repoRoot}/docs/specs/${slug}.md`);
      },
    });
  });

  document.addEventListener("keydown", (e) => {
    // ⌘⇧J — open Project Notes panel for the active group.
    // (⌘⇧N is the Notch overlay global shortcut; ⌘M is the Mission picker.)
    if (e.metaKey && e.shiftKey && !e.altKey && (e.key === "j" || e.key === "J")) {
      const g = manager.activeGroup();
      if (g) {
        e.preventDefault();
        openProjectNotes(g.id, g.name, g.color ?? null);
      }
    }
  });

  // 3.16 — spec auto-detect → propose mission. Subscribe to backend
  // `spec:candidate` events and render a floating toast for tabs whose
  // cwd matches the candidate's repo root and which have no mission yet.
  void startSpecPrompts({
    listTabs: () => manager.listTabSnapshots(),
    getActiveTabId: () => manager.getActiveTabId(),
    setMissionForTab: (tabId, path) => manager.setMissionPathForTab(tabId, path),
    getTabLabel: (tabId) => manager.getTabLabel(tabId),
  });

  installSpecLinkInterceptor({
    getActiveTabId: () => manager.getActiveTabId(),
    listTabsForRepo: (repoRoot) => {
      const tabs = manager.listTabSnapshots();
      return tabs
        .filter((t) => !repoRoot || t.cwd.startsWith(repoRoot))
        .map((t) => ({
          id: t.id,
          label: manager.getTabLabel(t.id),
          cwd: t.cwd,
          hasMission: t.hasMission,
        }));
    },
    setMissionForTab: (tabId, path) => manager.setMissionPathForTab(tabId, path),
    openSpec: async (path) => { manager.openFileAtLine(path); },
    revealInFinder: async (path) => {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
    },
  });

  for (const tab of manager.listTabSnapshots()) {
    if (tab.cwd) void ensureDetectorForRepo(tab.cwd);
  }
  const initialCwd = manager.activeCwd();
  if (initialCwd) void ensureDetectorForRepo(initialCwd);

  const settingsPage = requireEl<HTMLElement>("settings-page");
  const settings = new SettingsPanel(settingsPage, workspace);
  settingsRef.panel = settings;
  const capabilitiesPage = requireEl<HTMLElement>("capabilities-page");
  const capabilities = new CapabilitiesPanel(capabilitiesPage, workspace);
  capabilities.onClosed = () => manager.refitActive();
  // Pi RPC overlay — singleton, lazy-spawns the backend session on first
  // open. Wired only as a keybinding entry (⌘⌥P) for PI-5; PI-6 will
  // promote it to a first-class TabKind.
  getPiPanel();
  const agent = new AgentPanel(document.body, () => manager.activeSessionId());
  const operatorPage = requireEl<HTMLElement>("operator-page");
  const operator = new OperatorPanel(operatorPage, workspace, manager);
  operator.onClosed = () => {
    manager.refitActive();
  };
  const release = new ReleasePanel(document.body);
  const shortcutsPanel = new ShortcutsPanel(document.body);
  statusBar.onVersionChipClick = () => release.toggle();
  // Statusbar Covenant chip click → open Settings, covenant tab.
  window.addEventListener("covenant:open-covenant-settings", () => {
    if (docsPanel.isOpen()) docsPanel.close();
    if (draftsPanel.isOpen()) draftsPanel.close();
    if (operator.isOpen()) operator.close();
    void settings.open("covenant");
  });
  // Statusbar Telegram pill click → open Settings, scroll to Telegram section.
  window.addEventListener("covenant:open-telegram-settings", () => {
    if (docsPanel.isOpen()) docsPanel.close();
    if (draftsPanel.isOpen()) draftsPanel.close();
    if (operator.isOpen()) operator.close();
    void settings.open().then(() => {
      // Defer so the panel is mounted before we look up the section.
      requestAnimationFrame(() => {
        const sec = document.getElementById("sec-telegram");
        sec?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  });
  // Auto-show "What's new" on the first launch after a version bump.
  // Compares the persisted last-seen version with the running one;
  // if missing or different, pop the modal once. Marked seen on close.
  if (ReleasePanel.lastSeenVersion() !== __APP_VERSION__) {
    release.openWhatsNew();
  }
  const recallPalette = new RecallPalette(
    document.body,
    () => manager.activeSessionId(),
    () => manager.activeCwd(),
    (sessionId, command) => injectCommand(sessionId, command),
    () => manager.focusActive(),
  );

  const searchPalette = new GlobalSearchPalette(document.body, {
    cwd: () => manager.activeCwd(),
    open: (path, line) => manager.openFileAtLine(path, line),
  });

  // Cmd+/- changes the zoom level — re-run the full apply pipeline so
  // every open tab's xterm fontSize scales, the WebGL atlas is rebuilt,
  // fit() recomputes cols/rows, and the PTY is resized. A plain refit
  // isn't enough: pointer/selection coords get out of sync if the cell
  // metrics shift without xterm being told.
  zoom.onChange(() => {
    void getSettings()
      .then((s) => manager.applyTerminalSettings(s.terminal))
      .catch(() => undefined);
  });

  // Live-apply terminal font/size and window background to open tabs
  // whenever settings save. Background mode swaps a body class — pure
  // CSS reflow, no need to re-init xterm.
  settings.onSaved = (next) => {
    manager.applyTerminalSettings(next.terminal);
    applyWindowBackground(next.window?.background ?? "vibrant");
    void applyTheme((next.window?.theme ?? "system") as ThemeMode, manager);
    applyTabbarPosition(next.tabbar_position ?? "top");
    applyTabStyle(next.window?.tab_style ?? "classic");
    applyUiFont(next.ui_font_family);
    statusBar.setEnabled(next.status_bar_enabled ?? true);
    manager.setSplitPanesEnabled(next.experimental?.split_panes ?? false);
    manager.setStatusbarTwoRow(next.experimental?.statusbar_two_row ?? true);
    // Layout reflowed → xterm cells need re-measuring.
    manager.refitActive();
  };

  // When the settings page closes, the workspace becomes visible again.
  // Refit the active terminal in case anything reflowed in the meantime
  // (window resize, etc.) so xterm cell metrics stay accurate.
  settings.onClosed = () => {
    manager.refitActive();
  };
  // Workspace import/export round-trips a single V1 manifest (current
  // workspace contents). Keeps existing exported JSON files working —
  // the V2 envelope on disk is a wrapper, not a new export format.
  settings.onExportWorkspace = () => workspaceManager.exportActive();
  settings.onImportWorkspace = async (parsed) => {
    await workspaceManager.importIntoActive(parsed as TabManifestV1);
  };

  const toasts = new ToastHost(document.body, {
    onClick: (finding) => {
      // Route a clicked toast into the agent panel so the user can
      // ask follow-ups about the cross-session pattern.
      agent.openWithSeed(`Re cross-session finding: ${finding.message}\n\n`);
    },
  });
  await toasts.start();
  setSharedToastHost(toasts);

  // One-shot zsh-autosuggestions hint. Recall (sidebar) covers the
  // "search past commands" case; autosuggestions covers inline ghost
  // text. Show this once per install — gated by localStorage.
  void maybeHintAutosuggestions(toasts);

  // Autonomous Operator Mode banner. Mounted on document.body so it
  // floats above the workspace; hydrate so an already-on AOM (hot
  // reload, second window) shows the banner immediately. The
  // onChange listener fires on every transition (start/stop, including
  // the budget-hit auto-stop) so the tab bar refreshes per-tab badges
  // for tabs AOM auto-enabled or auto-reverted.
  // AOM offline detection — install BEFORE the banner hydrates so the
  // first render already reflects connectivity state. Idempotent on
  // hot-reload. Backend `set_connectivity` is a no-op when state is
  // unchanged.
  installConnectivityBridge();

  const aomBanner = new AomBanner(document.body);
  manager.setAomBanner(aomBanner);
  manager.setStatusBar(statusBar);
  // Headless: the banner owns state + polling, but the chip in the
  // status bar handles all rendering. Without this we'd get both
  // the floating pill AND the chip on screen at once.
  aomBanner.setHeadless(true);
  aomBanner.onUpdate((status) => statusBar.setAom(status));

  // Vitals: backend pushes an update on each LLM call + 1Hz when active.
  // Initial paint from get_vitals so the cluster appears immediately if
  // there's been activity before the UI was ready.
  void getVitals().then((v) => statusBar.setVitals(v)).catch(() => {
    /* backend not ready yet — first push will populate */
  });
  void onVitalsUpdate((v) => statusBar.setVitals(v));
  aomBanner.onChange((status) => {
    void manager.refreshAllOperatorState().then(() => {
      // "AOM is alive" — the moment the user enters AOM, derive
      // tab names from each tab's mission so the tab bar instantly
      // reads as the work being done. User-set names are preserved.
      // Only on the OFF→ON transition; on stop we leave names as-is
      // (user might want to keep them after the run).
      if (status.enabled) manager.applyMissionTabNames();
    });
  });
  void aomBanner.hydrate();

  // Mini activity feed — ephemeral cards that pop in for each
  // operator-decision / startup-action event. Makes AOM feel ALIVE
  // without forcing the user to keep ⌘O open. Mounted on body so
  // cards float above the workspace at bottom-right.
  const aomFeed = new AomActivityFeed(document.body);
  void aomFeed.start();

  // Morning report panel — what you read when AOM ended. Auto-opens
  // after a budget-hit auto-stop; otherwise reachable from the AOM
  // panel.
  const aomReportPanel = new AomReportPanel(document.body);
  const afk = new AfkOverlay(document.body, {
    manager,
    openReport: () => void aomReportPanel.open(),
    onExit: () => manager.refitActive(),
  });
  aomBanner.setEnterAfkHandler(() => afk.open());
  // Wire the status-bar chip's popover Stop/AFK buttons. Same
  // semantics as the (now hidden) banner buttons: Stop toggles
  // AOM off, AFK opens the overlay.
  statusBar.bindAomActions({
    onStop: () => void aomBanner.toggle(),
    onAfk: () => afk.open(),
    onIncludeTab: (sessionId) => {
      void manager.setAomExcludedFor(sessionId, false);
    },
    onIncludeAll: () => {
      void manager.includeAllInAom();
    },
  });
  const docsPage = requireEl<HTMLElement>("docs-page");
  const docsPanel = new DocsPanel(docsPage, workspace);
  docsPanel.onClosed = () => {
    manager.refitActive();
  };

  const draftsPage = requireEl<HTMLElement>("drafts-page");
  const draftsPanel = new DraftsPanel(draftsPage, workspace);
  draftsPanel.getRepoRoot = () => manager.activeCwd() ?? ".";
  draftsPanel.onClosed = () => {
    manager.refitActive();
  };
  const missionPageHost = requireEl<HTMLElement>("mission-page");
  const missionPanel = new MissionPage(missionPageHost, workspace);
  missionPanel.onClosed = () => { manager.refitActive(); };
  manager.setMissionPicker((opts) => missionPanel.open(opts));

  // Selecting a tab implies "show me this terminal" — dismiss any
  // fullscreen overlay panel so the terminal pane is actually visible.
  manager.onTabActivated = () => {
    if (capabilities.isOpen()) capabilities.close();
    if (settings.isOpen()) settings.close();
    // Note: don't dismiss the release modal here. It's a centered
    // "what's new" dialog auto-shown on version bump — during boot,
    // tab restoration fires onTabActivated and would close it the
    // moment it appeared. The user closes it via ×, ESC, or backdrop.
    if (shortcutsPanel.isOpen()) shortcutsPanel.close();
    if (aomReportPanel.isOpen()) aomReportPanel.close();
    if (docsPanel.isOpen()) docsPanel.close();
    if (draftsPanel.isOpen()) draftsPanel.close();
    if (missionPanel.isOpen()) missionPanel.close();
    if (operator.isOpen()) operator.close();
    if (specChat.isOpen()) specChat.close();
  };

  const specChatPage = requireEl<HTMLElement>("spec-chat-page");
  const specChat = mountSpecChat(specChatPage, {
    openWizardWithBody: (body) => {
      draftsPanel.open({ slug: null, initialBody: body });
    },
    openBlankWizard: () => {
      draftsPanel.open({ slug: null });
    },
    getCwd: () => manager.activeCwd() ?? null,
  });

  closeWorkspacePagesForMission = () => {
    // Always call Settings.close(), even when isOpen() is still false:
    // Settings.open() awaits backend/subpanel work before flipping open,
    // and close() invalidates that pending async open so it cannot paint
    // over the mission picker later.
    settings.close();
    if (docsPanel.isOpen()) docsPanel.close();
    if (draftsPanel.isOpen()) draftsPanel.close();
    if (operator.isOpen()) operator.close();
    if (capabilities.isOpen()) capabilities.close();
    if (specChat.isOpen()) specChat.close();
  };

  window.addEventListener("spec-chat:open", () => specChat.open());

  // Open the spec-author wizard for a given repoRoot (no slug → fresh draft).
  // Fired by ProjectNotesPanel's "+ New spec (AI-assisted)" button.
  window.addEventListener("drafts:open-wizard", (e: Event) => {
    const detail = (e as CustomEvent<{ repoRoot?: string; slug?: string | null }>).detail;
    draftsPanel.open({ repoRoot: detail?.repoRoot, slug: detail?.slug ?? null });
  });
  // Existing event: open the wizard pre-loaded with a specific slug
  // (used by the spec-chat flow). Kept for back-compat.
  window.addEventListener("drafts:open", (e: Event) => {
    const detail = (e as CustomEvent<{ slug: string; autoPublish?: boolean }>).detail;
    if (!detail || typeof detail.slug !== "string") return;
    draftsPanel.open({ slug: detail.slug, autoPublish: detail.autoPublish });
  });

  // Auto-stop notification: when the Operator hits the AOM budget,
  // it emits this event with stats. Surface as a non-dismissable
  // info toast so morning-you sees what happened — the banner is
  // already gone (AOM auto-stopped), this is the explanation.
  void listen<{
    spent_usd: number;
    budget_usd: number;
    decisions_count: number;
    duration_ms: number;
  }>("aom-budget-hit", (event) => {
    const p = event.payload;
    const dur = formatBudgetDuration(p.duration_ms);
    toasts.pushInfo({
      message: `AOM auto-stopped: spent $${p.spent_usd.toFixed(
        2,
      )} of $${p.budget_usd.toFixed(2)} budget over ${dur} (${p.decisions_count} decisions). Click for report.`,
      onClick: () => {
        void aomReportPanel.open();
      },
    });
    // syncFromBackend hides the banner AND fires onChange listeners
    // → TabManager refreshes per-tab Operator badges (the auto-revert
    // already happened backend-side).
    void aomBanner.syncFromBackend();
  });

  // 3.12 — operators-experience-and-level: live XP updates flow from
  // the backend after each Operator decision. We patch the tab manager's
  // operator cache in place so the tab chip's "Lv N" badge tracks
  // progress without waiting for the next operatorList refresh.
  void listen<{ operator_id: string; xp: number; awarded: number }>(
    "operator-xp-updated",
    (event) => {
      const { operator_id, xp } = event.payload;
      manager.applyOperatorXpUpdate(operator_id, xp);
    },
  );

  // Mission file watcher fires this when a spec file changes on disk
  // and the backend hot-reloads the content. Refresh tab tooltips so
  // the preview text matches the new content without a right-click.
  void listen<{ session_id: string; path: string }>(
    "mission-changed",
    () => {
      void manager.refreshAllOperatorState();
    },
  );

  // Workspaces V2: load the persisted envelope (or migrate from V1, or
  // fall back to a single Default workspace). WorkspaceManager owns
  // restoration into the TabManager and all subsequent disk writes.
  try {
    const body = await tabManifestLoad();
    await workspaceManager.boot(body);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("workspace boot failed; starting fresh", err);
    await workspaceManager.boot(null);
  }

  // beforeunload flush: best-effort sync of the V2 envelope when the
  // window closes. The Tauri command is async so it may not always land
  // before teardown — the debounced save during normal use is what
  // really keeps us durable. Still, this is the missing piece referenced
  // by the older comment in tabs/manager.ts and worth wiring for real.
  window.addEventListener("beforeunload", () => {
    void workspaceManager.saveAll();
  });

// Populate operator cache once the backend is up and tabs are
  // restored — chips in the tab strip and status bar need this.
  void manager.refreshOperatorCache();

  // Load experimental feature flags (e.g. split_panes) once settings
  // are available. Defaults to false until this resolves.
  void manager.loadExperimentalFlags();

  // ⌘⇧O Operator Picker (Plan 3 Task 5)
  const operatorPicker = new OperatorPicker(document.body);
  operatorPicker.onAssigned = async (sessionId, op) => {
    const tab = manager.tabForSession(sessionId);
    if (tab) await manager.setTabOperator(tab.id, op.id);
  };
  // TODO: open directly to Operators pane when openTo API is added to SettingsPanel
  operatorPicker.onNewRequested = () => { settings.toggle(); };
  // TODO: scroll to specific operator row when openTo API is added to SettingsPanel
  operatorPicker.onEditRequested = (_op) => { settings.toggle(); };
  statusBar.onOperatorChipClick = (sid) => { void operatorPicker.open(sid); };
  manager.onSetOperatorRequested = (sid) => { void operatorPicker.open(sid); };

  // ⌘⇧O → open operator picker for the active session.
  window.addEventListener("keydown", (e) => {
    if (e.metaKey && e.shiftKey && (e.key === "O" || e.key === "o")) {
      e.preventDefault();
      const sid = manager.activeSessionId();
      if (sid) void operatorPicker.open(sid);
      return;
    }
  });

  // Workspaces shortcuts.
  //   ⌘⇧P  — toggle workspace picker (⌘⇧O was already the Operator
  //          picker, so the spec's preferred binding was relocated).
  //   ⌘⌥T  — global tab finder: opens the switcher with the search
  //          input focused so the user can type to filter tabs across
  //          all workspaces. macOS substitutes ⌥T with the dead-key
  //          "†"; accept both. Separate from ⌘⇧P so the picker and
  //          the finder have distinct muscle memory.
  //   ⌘⌥N — new workspace (⌘⇧N is the Notch overlay, ⌘⇧J is Project Notes, ⌘N is spec-chat).
  window.addEventListener("keydown", (e) => {
    if (e.metaKey && e.shiftKey && !e.altKey && (e.key === "P" || e.key === "p")) {
      e.preventDefault();
      switcher.togglePopover();
      return;
    }
    if (e.metaKey && e.altKey && !e.shiftKey && (e.key === "t" || e.key === "T" || e.key === "†")) {
      e.preventDefault();
      switcher.togglePopover();
      return;
    }
    if (e.metaKey && e.altKey && !e.shiftKey && (e.key === "n" || e.key === "N" || e.key === "˜")) {
      // macOS substitutes ⌥N with "˜" (dead-key for n-with-tilde); accept both.
      e.preventDefault();
      void switcher.createAndSwitch();
      return;
    }
  });

  window.addEventListener("keydown", async (e) => {
    // ⌘= / ⌘+ → zoom in, ⌘- → zoom out, ⌘0 → reset (browser convention).
    // Match both the unshifted (`=`, `-`, `0`) and the shifted (`+`)
    // variants so US and intl keyboards both work. Refits the active
    // terminal after each change so xterm cell metrics stay accurate.
    if (e.metaKey && !e.shiftKey && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoom.zoomIn();
      return;
    }
    if (e.metaKey && e.shiftKey && (e.key === "+" || e.key === "=")) {
      e.preventDefault();
      zoom.zoomIn();
      return;
    }
    if (e.metaKey && !e.shiftKey && e.key === "-") {
      e.preventDefault();
      zoom.zoomOut();
      return;
    }
    if (e.metaKey && !e.shiftKey && e.key === "0") {
      e.preventDefault();
      zoom.reset();
      return;
    }
    // ⌘, → settings (macOS Preferences convention). Open or toggle.
    if (e.metaKey && !e.shiftKey && e.key === ",") {
      e.preventDefault();
      // Settings, docs, and drafts share the workspace grid cell — only
      // one can be visible. Close the others before opening settings.
      if (docsPanel.isOpen()) docsPanel.close();
      if (draftsPanel.isOpen()) draftsPanel.close();
      if (operator.isOpen()) operator.close();
      void settings.toggle();
      return;
    }
    // ⌘⇧. → force-kill foreground process tree of the active tab.
    // For when Ctrl+C is swallowed (npm run dev, docker, watchers).
    // Sends SIGTERM to the PTY's foreground pgrp, escalates to SIGKILL
    // after 500ms. The shell itself survives (different pgrp).
    if (e.metaKey && e.shiftKey && e.key === ".") {
      e.preventDefault();
      const sid = manager.activeSessionId();
      if (sid) {
        void killSessionForeground(sid).catch((err) =>
          // eslint-disable-next-line no-console
          console.error("kill_session_foreground failed", err),
        );
      }
      return;
    }
    // ⌘K → super-agent panel.
    if (e.metaKey && !e.shiftKey && e.key === "k") {
      e.preventDefault();
      agent.toggle();
      return;
    }
    // ⌘O → operator decisions page. Shares the workspace cell with
    // settings/docs/drafts/mission — close the others before opening.
    if (e.metaKey && !e.shiftKey && e.key === "o") {
      e.preventDefault();
      if (!operator.isOpen()) {
        if (settings.isOpen()) settings.close();
        if (docsPanel.isOpen()) docsPanel.close();
        if (draftsPanel.isOpen()) draftsPanel.close();
        if (missionPanel.isOpen()) missionPanel.close();
      }
      void operator.toggle();
      return;
    }
    // ⌘P → Recall palette (search command history explicitly).
    // Suppressed while an agent executor (claude/copilot/codex/…) owns
    // the PTY: their TUIs don't read shell history.
    if (e.metaKey && !e.shiftKey && e.key === "p") {
      e.preventDefault();
      if (!manager.activeExecutor()) {
        recallPalette.toggle();
      }
      return;
    }
    // ⌘F → in-terminal finder (Apple Terminal-style). Floating bar
    // pinned to the active tab's pane; Esc closes. If CodeMirror or
    // the structure preview already handled ⌘F, leave editor search in
    // control instead of stacking the terminal finder above it.
    if (e.metaKey && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
      const target = e.target as HTMLElement | null;
      if (e.defaultPrevented || target?.closest(".structure-editor, .cm-editor")) return;
      e.preventDefault();
      manager.openFinder();
      return;
    }
    // ⌘⇧F → search palette. Default mode is content (grep); Tab inside
    // the overlay toggles to fuzzy filename mode.
    if (e.metaKey && e.shiftKey && (e.key === "F" || e.key === "f")) {
      e.preventDefault();
      searchPalette.toggle();
      return;
    }
    // ⌘N → spec-chat panel.
    if (e.metaKey && !e.shiftKey && (e.key === "n" || e.key === "N")) {
      e.preventDefault();
      if (settings.isOpen()) settings.close();
      if (docsPanel.isOpen()) docsPanel.close();
      if (draftsPanel.isOpen()) draftsPanel.close();
      specChat.open();
      return;
    }
    // ⌘M → mission picker page (toggle).
    if (e.metaKey && !e.shiftKey && (e.key === "M" || e.key === "m")) {
      e.preventDefault();
      if (missionPanel.isOpen()) {
        missionPanel.close();
      } else {
        closeWorkspacePagesForMission();
        void manager.openMissionForActive();
      }
      return;
    }
    // ⌘⇧M → Convergence Mode overlay (spec 3.8). Toggles full-window.
    if (e.metaKey && e.shiftKey && (e.key === "M" || e.key === "m")) {
      e.preventDefault();
      convergence.toggle();
      return;
    }
    // ⌘⇧G → create a new empty tab group (no member tab needed).
    if (e.metaKey && e.shiftKey && (e.key === "G" || e.key === "g")) {
      e.preventDefault();
      manager.createEmptyGroup();
      return;
    }
    // ⌘⇧K → Keyboard shortcuts modal (read-only list).
    if (e.metaKey && e.shiftKey && (e.key === "K" || e.key === "k")) {
      e.preventDefault();
      shortcutsPanel.toggle();
      return;
    }
    // ⌘⇧I → Capabilities panel (Skills / Commands / Hooks / MCPs across
    // Claude / Copilot / opencode / Shared). Cmd+Shift+K was already taken
    // by the Shortcuts modal, so the spec's keybinding was relocated to I.
    if (e.metaKey && e.shiftKey && (e.key === "I" || e.key === "i")) {
      e.preventDefault();
      void capabilities.toggle(manager.activeCwd());
      return;
    }
    // ⌘⌥⇧P — create a permanent Pi tab in the tabbar.
    if (e.metaKey && e.altKey && e.shiftKey && (e.key === "P" || e.key === "p" || e.key === "π")) {
      e.preventDefault();
      void manager.createPiTab({ cwd: manager.activeCwd() ?? null });
      return;
    }
    // ⌘⇧A — pure AOM toggle: off ↔ on.
    //
    // Earlier this shortcut layered AFK in between (off→on→AFK→off),
    // but in practice the second press to stop AOM was muscle-memory
    // and got hijacked into opening AFK. AFK is now reachable only
    // from the AOM chip's popover (`bindAomActions.onAfk`) — that's
    // where the dedicated affordance lives, so the keyboard stays
    // simple and predictable.
    //
    // If AFK happens to be open when AOM gets stopped, we close AFK
    // first so there's no orphan overlay sitting over a stopped AOM.
    if (e.metaKey && e.shiftKey && (e.key === "A" || e.key === "a")) {
      e.preventDefault();
      if (aomBanner.isOn()) {
        if (afk.isOpen()) afk.close();
        // Snapshot the run stats BEFORE the toggle resolves — the
        // backend keeps started_at/decisions/cost stamped after stop,
        // but reading them post-toggle is also safe. We capture pre-
        // toggle so a race with a poll tick that arrives mid-stop
        // can't blank out the splash data.
        const finalStatus = aomBanner.getStatus();
        void aomBanner.toggle().then(() => {
          if (!aomBanner.isOn()) {
            void playAomExitSplash(finalStatus);
          }
        });
      } else {
        // OFF→ON path. Spec 3.16 last-call: if active tab has no mission
        // but the spec detector emitted a candidate for it within the last
        // 10 minutes, ask before dropping into AOM. "Cancel" aborts the
        // engage entirely; "Use it" sets the mission first; "Engage without
        // mission" falls through unchanged.
        const active = manager.activeTabSnapshot();
        let proceed = true;
        if (active && !active.hasMission) {
          const cand = getPendingSpecCandidateForTab(active.id);
          if (cand) {
            const choice = await showAomLastCallModal(cand);
            if (choice === "cancel") {
              proceed = false;
            } else if (choice === "use") {
              try {
                await manager.setMissionPathForTab(active.id, cand.path);
                getSpecPromptState().acceptOnTab(active.id, cand.path);
              } catch (err) {
                console.error("setMissionPathForTab failed", err);
              }
            } else {
              // "without" — record dismissal so we don't re-prompt this run.
              getSpecPromptState().dismiss(active.id, cand.path);
            }
          }
        }
        if (proceed) {
          void aomBanner.toggle().then(() => {
            if (aomBanner.isOn()) {
              void playAomEntrySplash(aomBanner.getStatus());
            }
          });
        }
      }
      return;
    }
    // ⌘⇧E — toggle AOM exclusion for the active tab. Silent no-op
    // when AOM is off; the badge is the discoverable affordance and
    // the shortcut just shaves a click for users who know it exists.
    if (e.metaKey && e.shiftKey && (e.key === "E" || e.key === "e")) {
      e.preventDefault();
      void manager.toggleAomExcludedActive();
      return;
    }
    // ⌘⇧R → AOM morning report. Read-only digest of the most recent
    // AOM session. Doesn't depend on AOM being active.
    if (e.metaKey && e.shiftKey && (e.key === "R" || e.key === "r")) {
      e.preventDefault();
      aomReportPanel.toggle();
      return;
    }
    // ⌘⇧V → release log / version history. Same modal that auto-pops
    // on a fresh-version launch.
    if (e.metaKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
      e.preventDefault();
      release.toggle();
      return;
    }
    // ⌘D → split right (add a second pane to the right). Gated inside manager.
    if (e.metaKey && !e.shiftKey && !e.altKey && (e.key === "d" || e.key === "D")) {
      e.preventDefault();
      void manager.splitActivePane("horizontal");
      return;
    }
    // ⌘\ → split down (add a second pane below). Gated inside manager.
    if (e.metaKey && !e.shiftKey && !e.altKey && e.key === "\\") {
      e.preventDefault();
      void manager.splitActivePane("vertical");
      return;
    }
    // ⌘[ / ⌘] → focus previous / next pane. Gated inside manager.
    if (e.metaKey && !e.shiftKey && !e.altKey && e.key === "[") {
      e.preventDefault();
      manager.focusOtherPane();
      return;
    }
    if (e.metaKey && !e.shiftKey && !e.altKey && e.key === "]") {
      e.preventDefault();
      manager.focusOtherPane();
      return;
    }
    // ⌘⇧] → swap panes. Gated inside manager.
    if (e.metaKey && e.shiftKey && !e.altKey && (e.key === "}" || e.key === "]")) {
      e.preventDefault();
      manager.swapActivePanes();
      return;
    }
    // ⌘⇧D → open ProjectNotesPanel for the active group on the drafts tab.
    if (e.metaKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
      const g = manager.activeGroup();
      if (g) {
        e.preventDefault();
        openProjectNotes(g.id, g.name, g.color ?? null, { defaultTab: "drafts" });
      }
      return;
    }
    // ⌘? (Shift+/) and ⌘/ both toggle the in-app docs hub. Two
    // bindings because "?" requires Shift on most layouts; ⌘/ is the
    // shift-free alias.
    if (e.metaKey && (e.key === "?" || e.key === "/")) {
      e.preventDefault();
      // Mutually exclusive with settings and drafts — see ⌘, branch above.
      if (settings.isOpen()) settings.close();
      if (draftsPanel.isOpen()) draftsPanel.close();
      if (operator.isOpen()) operator.close();
      docsPanel.toggle();
      return;
    }
    // Esc closes any open modal first; only routes to terminal if none.
    if (e.key === "Escape") {
      if (convergence.isVisible()) {
        e.preventDefault();
        convergence.close();
        return;
      }
      if (afk.isOpen()) {
        e.preventDefault();
        afk.close();
        return;
      }
      if (missionPanel.isOpen()) {
        e.preventDefault();
        missionPanel.close();
        return;
      }
      if (settings.isOpen()) {
        e.preventDefault();
        settings.close();
        return;
      }
      if (capabilities.isOpen()) {
        e.preventDefault();
        capabilities.close();
        return;
      }
      if (agent.isOpen()) {
        e.preventDefault();
        agent.close();
        return;
      }
      if (operator.isOpen()) {
        e.preventDefault();
        operator.close();
        return;
      }
      if (recallPalette.isOpen()) {
        e.preventDefault();
        recallPalette.close();
        return;
      }
      if (searchPalette.isOpen()) {
        e.preventDefault();
        searchPalette.close();
        return;
      }
      if (aomReportPanel.isOpen()) {
        e.preventDefault();
        aomReportPanel.close();
        return;
      }
      if (release.isOpen()) {
        e.preventDefault();
        release.close();
        return;
      }
      if (shortcutsPanel.isOpen()) {
        e.preventDefault();
        shortcutsPanel.close();
        return;
      }
      if (docsPanel.isOpen()) {
        e.preventDefault();
        docsPanel.close();
        return;
      }
      if (draftsPanel.isOpen()) {
        e.preventDefault();
        draftsPanel.close();
        return;
      }
    }

    if (!e.metaKey) return;

    if (!e.shiftKey && e.key === "t") {
      e.preventDefault();
      void manager.createTab();
      return;
    }

    if (!e.shiftKey && e.key === "w") {
      e.preventDefault();
      if (manager.canSplitPanes()) {
        void manager.closeActivePaneOrTab();
      } else {
        manager.closeActiveTab();
      }
      return;
    }

    // ⌘⇧W — unconditional close tab (escape hatch even in split tabs).
    if (e.shiftKey && e.key === "W") {
      e.preventDefault();
      manager.closeActiveTab();
      return;
    }

    // ⌘1..⌘9: jump to tab N (1-indexed).
    if (!e.shiftKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      manager.activateByIndex(Number(e.key) - 1);
      return;
    }

    // ⌘Shift+[ → prev, ⌘Shift+] → next (also Ctrl+Tab style).
    if (e.shiftKey && e.key === "{") {
      e.preventDefault();
      manager.activateRelative(-1);
      return;
    }
    if (e.shiftKey && e.key === "}") {
      e.preventDefault();
      manager.activateRelative(1);
      return;
    }
  });
}

async function startupUpdateCheck(): Promise<void> {
  const currentVersion = await getVersion();
  const result = await runUpdateCheck({ currentVersion, silent: true });
  if (result.kind === "available") {
    showUpdateBanner(result.update);
  }
  // "uptodate" and "error" are silent on boot.
}

void boot()
  .then(() => {
    dismissBootSplash();
    void startupUpdateCheck();
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("covenant boot failed", err);
    const workspace = document.getElementById("workspace");
    // When the app's own index.html is loaded inside a sandboxed iframe
    // (e.g. our own HTML preview panel), the Tauri IPC bridge is absent
    // by design. Show a friendly placeholder instead of the raw error.
    const inIframe = window.parent !== window;
    if (workspace) {
      workspace.textContent = inIframe
        ? "This is the Covenant app shell — preview it inside Tauri, not in the HTML preview."
        : `boot failed: ${String(err)}`;
    }
    // Clear the splash even on failure so the error message is visible.
    dismissBootSplash();
  });
