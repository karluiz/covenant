// M2 entry point. Boots the TabManager with one initial tab, wires
// keyboard shortcuts (⌘T new, ⌘W close, ⌘1..9 jump, ⌘Shift+[ /]
// prev/next), and closes the app window when the last tab is gone.

import "@xterm/xterm/css/xterm.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { runUpdateCheck } from "./updater/check";
import { showUpdateBanner } from "./updater/banner";

import { dismissBootSplash } from "./boot-splash";
import { AgentPanel } from "./agent/panel";
import { AomActivityFeed } from "./aom/activity-feed";
import { AomBanner } from "./aom/banner";
import { installConnectivityBridge, mountOfflinePill } from "./aom/connectivity";
import { playAomEntrySplash, playAomExitSplash } from "./aom/entry-splash";
import { AomReportPanel } from "./aom/report";
import {
  startSpecPrompts,
  ensureDetectorForRepo,
  getPendingSpecCandidateForTab,
  getSpecPromptState,
} from "./aom/spec-prompt";
import { installSpecLinkInterceptor } from "./aom/spec-link-menu";
import type { SpecCandidate } from "./api";
import { AfkOverlay } from "./aom/afk";
import { Icons } from "./icons";
import { injectCommand, killSessionForeground, tabManifestLoad, zshAutosuggestionsStatus } from "./api";
import type { Settings, WindowBackground } from "./api";
import { DocsPanel } from "./docs/panel";
import { DraftsPanel } from "./drafts/panel";
import { MissionPage } from "./mission/page";
import { setSharedToastHost, ToastHost } from "./notifications/toast";
import { OperatorPanel } from "./operator/panel";
import { RecallPalette } from "./recall/palette";
import { ReleasePanel } from "./release/panel";
import { ShortcutsPanel } from "./shortcuts/panel";
import { GlobalSearchPalette } from "./search/palette";
import { SettingsPanel } from "./settings/panel";
import { CapabilitiesPanel } from "./capabilities/panel";
import { StatusBar } from "./status/bar";
import { Roster } from "./familiars/roster";
import { FamiliarStatusIndicator } from "./familiars/status_indicator";
import { familiarFor, onFamiliarRegistryChange } from "./familiars/registry";
import { TabManager, type TabManifestV1 } from "./tabs/manager";

/// Module-level reference to the singleton TabManager. Assigned during
/// boot() and used by project-notes paste helper to resolve the active
/// session in a group without a Tauri round-trip.
export let tabsManager: TabManager | null = null;
import { CollapsedRail } from "./tabs/collapsed-rail";
import { ConvergenceOverlay } from "./convergence/overlay";
import { makeTabsBridge } from "./convergence/tabs-bridge";
import { zoom } from "./zoom";
import { OperatorPicker } from "./operator/picker";
import { mountSpecChat } from "./spec-chat/index";
import { ProjectNotesPanel } from "./project-notes/panel";

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

/// Toggle the vertical-tabbar layout. CSS does the heavy lifting via
/// `body.tabbar-left`; the rest of the app stays layout-agnostic.
function applyTabbarPosition(pos: "top" | "left" | undefined): void {
  document.body.classList.toggle("tabbar-left", pos === "left");
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

/// Toggle the collapsed state of the vertical tabbar. Only meaningful
/// when `body.tabbar-left` is active; in top mode the fold chevron is
/// hidden by CSS so the body class is harmless.
function applyTabbarCollapsed(collapsed: boolean): void {
  document.body.classList.toggle("tabbar-left-collapsed", collapsed);
  const btn = document.getElementById("tabbar-fold");
  if (btn) {
    const t = collapsed ? "Expand sidebar" : "Collapse sidebar";
    btn.title = t;
    btn.setAttribute("aria-label", t);
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
    applyUiFont(initialSettings.ui_font_family);
  } catch {
    applyWindowBackground("vibrant");
    applyTabbarPosition("top");
    applyUiFont(null);
  }
  applyTabbarCollapsed(localStorage.getItem(TABBAR_LEFT_COLLAPSED_KEY) === "1");

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

  // chevron-right SVG; CSS flips it 180° when expanded so it points
  // left ("click to collapse"). Collapsed state leaves it pointing
  // right ("click to expand"). Single SVG covers both states.
  tabbarFoldBtn.innerHTML = Icons.chevronRight({ size: 14 });
  tabbarFoldBtn.addEventListener("click", () => {
    const next = !document.body.classList.contains("tabbar-left-collapsed");
    applyTabbarCollapsed(next);
    localStorage.setItem(TABBAR_LEFT_COLLAPSED_KEY, next ? "1" : "0");
    // xterm needs to remeasure cells after the column width animation.
    setTimeout(() => manager.refitActive(), 320);
  });

  const collapseAllBtn = requireEl<HTMLButtonElement>("tabbar-collapse-all");
  collapseAllBtn.innerHTML = Icons.chevronsDownUp({ size: 14 });
  collapseAllBtn.addEventListener("click", () => {
    manager.collapseAllGroups();
  });

  // Render the new-tab button with its keyboard hint visible inline,
  // adapted to the host platform's modifier symbol.
  newTabBtn.innerHTML = `
    <span class="new-tab-plus">${Icons.terminal({ size: 14 })}</span>
    <kbd class="new-tab-kbd">${MOD_KEY}T</kbd>
  `;
  newTabBtn.title = `New tab (${MOD_KEY}T)`;

  newGroupBtn.innerHTML = `
    <span class="new-tab-plus">${Icons.folderPlus({ size: 14 })}</span>
    <kbd class="new-tab-kbd">${MOD_KEY}⇧G</kbd>
  `;
  newGroupBtn.title = `New group (${MOD_KEY}⇧G)`;

  const manager = new TabManager(tabbar, workspace, newTabBtn, () => {
    // Closing the last tab quits the app — matches iTerm/Terminal.app.
    void getCurrentWindow().close();
  });
  tabsManager = manager;

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
  // Familiar status dot — single instance, mounted on the status-bar
  // host. Rebound whenever the active tab changes (or the registry
  // updates for the currently-active session).
  const familiarIndicator = new FamiliarStatusIndicator(statusBarHost);
  const rebindFamiliarIndicator = (): void => {
    const sid = manager.activeSessionId();
    familiarIndicator.bind(sid ? familiarFor(sid) : null);
  };
  onFamiliarRegistryChange((sessionId) => {
    if (sessionId === manager.activeSessionId()) rebindFamiliarIndicator();
  });
  manager.onActiveContextChange = (cwd) => {
    statusBar.setCwd(cwd);
    if (cwd) void ensureDetectorForRepo(cwd);
  };
  manager.onActiveTabChange = (info) => {
    statusBar.setActiveTab(info);
    rebindFamiliarIndicator();
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
  // Tab context-menu "View mission…" reuses the same modal as the
  // status-bar chip — keep the rendering in one place.
  manager.onMissionViewRequested = (mission, sessionId) =>
    void statusBar.openMissionFor(mission, sessionId);
  // Inverse direction: the "+ Set mission" affordance the status bar
  // surfaces on project-like cwds clicks back into TabManager so the
  // file-picker prompt is a single shared flow with the tab menu.
  statusBar.onMissionSetRequested = (sessionId) =>
    manager.promptAndSetMissionForSession(sessionId);

  // Post-publish toast "Open in Set Mission" fires this event with the
  // published spec path so we can wire it directly into the active tab
  // without going through the file-picker prompt.
  window.addEventListener("mission:set", (e) => {
    const detail = (e as CustomEvent<{ path: string }>).detail;
    void manager.setMissionPathForActiveTab(detail.path);
  });

  // Project Notes panel — singleton overlay, opened from group-chip or ⌘⇧N.
  let activeProjectNotesPanel: ProjectNotesPanel | null = null;

  function openProjectNotes(
    groupId: string,
    groupLabel: string,
    groupColor: string | null,
  ): void {
    if (activeProjectNotesPanel) activeProjectNotesPanel.close();
    activeProjectNotesPanel = new ProjectNotesPanel({
      groupId,
      groupLabel,
      groupColor,
      onClose: () => {
        activeProjectNotesPanel = null;
      },
    }).mount(document.body);
  }

  manager.setOptions({
    onOpenProjectNotes: openProjectNotes,
  });

  document.addEventListener("keydown", (e) => {
    // ⌘⇧N — open Project Notes panel for the active group.
    // (⌘M is reserved for the Mission picker.)
    if (e.metaKey && e.shiftKey && !e.altKey && (e.key === "n" || e.key === "N")) {
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

  const initialCwd = manager.activeCwd();
  if (initialCwd) void ensureDetectorForRepo(initialCwd);

  const settingsPage = requireEl<HTMLElement>("settings-page");
  const settings = new SettingsPanel(settingsPage, workspace);
  const capabilitiesPage = requireEl<HTMLElement>("capabilities-page");
  const capabilities = new CapabilitiesPanel(capabilitiesPage, workspace);
  capabilities.onClosed = () => manager.refitActive();
  const agent = new AgentPanel(document.body, () => manager.activeSessionId());
  const operatorPage = requireEl<HTMLElement>("operator-page");
  const operator = new OperatorPanel(operatorPage, workspace, manager);
  operator.onClosed = () => {
    manager.refitActive();
  };
  const release = new ReleasePanel(document.body);
  const shortcutsPanel = new ShortcutsPanel(document.body);
  statusBar.onVersionChipClick = () => release.toggle();
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

  // Live-apply terminal font/size and window background to open tabs
  // whenever settings save. Background mode swaps a body class — pure
  // CSS reflow, no need to re-init xterm.
  settings.onSaved = (next) => {
    manager.applyTerminalSettings(next.terminal);
    applyWindowBackground(next.window?.background ?? "vibrant");
    applyTabbarPosition(next.tabbar_position ?? "top");
    applyUiFont(next.ui_font_family);
    statusBar.setEnabled(next.status_bar_enabled ?? true);
    // Layout reflowed → xterm cells need re-measuring.
    manager.refitActive();
  };

  // When the settings page closes, the workspace becomes visible again.
  // Refit the active terminal in case anything reflowed in the meantime
  // (window resize, etc.) so xterm cell metrics stay accurate.
  settings.onClosed = () => {
    manager.refitActive();
  };
  settings.onExportWorkspace = () => manager.serializeManifest();
  settings.onImportWorkspace = async (parsed) => {
    await manager.replaceFromManifest(parsed as TabManifestV1);
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
  // Free-standing offline indicator. Decoupled from the AOM banner
  // (Task 3 is refactoring it in parallel) so the offline UX ships
  // independently of phase rendering.
  mountOfflinePill(document.body);

  const aomBanner = new AomBanner(document.body);
  manager.setAomBanner(aomBanner);
  manager.setStatusBar(statusBar);
  // Headless: the banner owns state + polling, but the chip in the
  // status bar handles all rendering. Without this we'd get both
  // the floating pill AND the chip on screen at once.
  aomBanner.setHeadless(true);
  aomBanner.onUpdate((status) => statusBar.setAom(status));
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

  // Morning report panel — what you read when AOM ended. Bound to
  // ⌘⇧R, also auto-opens after a budget-hit auto-stop so you don't
  // have to remember the shortcut at 6am.
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
    if (release.isOpen()) release.close();
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
      draftsPanel.open();
      draftsPanel.openWizard(null, { initialBody: body });
    },
    openBlankWizard: () => {
      draftsPanel.open();
      draftsPanel.openWizard(null);
    },
  });

  window.addEventListener("spec-chat:open", () => specChat.open());

  window.addEventListener("drafts:toggle", () => draftsPanel.toggle());
  window.addEventListener("drafts:open", (e: Event) => {
    const detail = (e as CustomEvent<{ slug: string; autoPublish?: boolean }>).detail;
    if (!detail || typeof detail.slug !== "string") return;
    draftsPanel.open();
    draftsPanel.openWizard(detail.slug, { autoPublish: detail.autoPublish });
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

  // Restore tabs from the persisted manifest if there is one.
  // Falls back to a single fresh tab when:
  //   - no manifest exists yet (first run / cleared)
  //   - manifest fails to parse (bad JSON, schema bump)
  //   - manifest is structurally empty (no tabs array)
  // restoreFromManifest spawns each tab AND injects `cd <cwd>` on
  // its first prompt so the shell lands where it was last time.
  let restored = false;
  try {
    const body = await tabManifestLoad();
    if (body) {
      const parsed = JSON.parse(body);
      await manager.restoreFromManifest(parsed);
      restored = manager.activeSessionId() !== null;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("tab manifest restore failed; falling back to fresh tab", err);
  }
  if (!restored) {
    await manager.createTab();
  }

  // Tabs are mounted and the active terminal has its first paint
  // queued — fade out the boot splash. Wait one frame so xterm has
  // actually drawn before the splash leaves, otherwise on slow boots
  // the user briefly sees the empty workspace under the fading overlay.
  requestAnimationFrame(() => dismissBootSplash());

  // Populate operator cache once the backend is up and tabs are
  // restored — chips in the tab strip and status bar need this.
  void manager.refreshOperatorCache();

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

  window.addEventListener("keydown", async (e) => {
    // ⌘= / ⌘+ → zoom in, ⌘- → zoom out, ⌘0 → reset (browser convention).
    // Match both the unshifted (`=`, `-`, `0`) and the shifted (`+`)
    // variants so US and intl keyboards both work. Refits the active
    // terminal after each change so xterm cell metrics stay accurate.
    if (e.metaKey && !e.shiftKey && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoom.zoomIn();
      manager.refitActive();
      return;
    }
    if (e.metaKey && e.shiftKey && (e.key === "+" || e.key === "=")) {
      e.preventDefault();
      zoom.zoomIn();
      manager.refitActive();
      return;
    }
    if (e.metaKey && !e.shiftKey && e.key === "-") {
      e.preventDefault();
      zoom.zoomOut();
      manager.refitActive();
      return;
    }
    if (e.metaKey && !e.shiftKey && e.key === "0") {
      e.preventDefault();
      zoom.reset();
      manager.refitActive();
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
    if (e.metaKey && !e.shiftKey && e.key === "p") {
      e.preventDefault();
      recallPalette.toggle();
      return;
    }
    // ⌘⇧F → global file-content search across the active tab's cwd.
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
        if (settings.isOpen()) settings.close();
        if (docsPanel.isOpen()) docsPanel.close();
        if (draftsPanel.isOpen()) draftsPanel.close();
        if (operator.isOpen()) operator.close();
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
    // ⌘⇧L — toggle the Familiar roster (chat with the active tab's familiar).
    if (e.metaKey && e.shiftKey && (e.key === "L" || e.key === "l")) {
      e.preventDefault();
      roster.toggle();
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
    // ⌘⇧D → Drafts panel. Mutually exclusive with settings and docs.
    if (e.metaKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
      e.preventDefault();
      if (settings.isOpen()) settings.close();
      if (docsPanel.isOpen()) docsPanel.close();
      if (operator.isOpen()) operator.close();
      draftsPanel.toggle();
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
      manager.closeActive();
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

const roster = new Roster();
// Hook to deliver an approved directive into the operator session. The
// project's operator-input command is `write_to_session`, which accepts
// raw bytes; encode the rendered string as UTF-8.
roster.onDeliverDirective = async (sessionId, rendered) => {
  const bytes = new TextEncoder().encode(rendered);
  await invoke("write_to_session", { id: sessionId, data: Array.from(bytes) });
};

// Status-bar Familiar dot dispatches this on click to open the roster
// contextually for the active tab's bound Familiar.
document.addEventListener("familiars:open", () => roster.show());

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
