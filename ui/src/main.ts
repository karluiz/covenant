// M2 entry point. Boots the TabManager with one initial tab, wires
// keyboard shortcuts (⌘T new, ⌘W close, ⌘1..9 jump, ⌘Shift+[ /]
// prev/next), and closes the app window when the last tab is gone.

import "@xterm/xterm/css/xterm.css";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { AgentPanel } from "./agent/panel";
import { AomActivityFeed } from "./aom/activity-feed";
import { AomBanner } from "./aom/banner";
import { playAomEntrySplash, playAomExitSplash } from "./aom/entry-splash";
import { AomReportPanel } from "./aom/report";
import { AfkOverlay } from "./aom/afk";
import { Icons } from "./icons";
import { injectCommand, tabManifestLoad, zshAutosuggestionsStatus } from "./api";
import type { Settings, WindowBackground } from "./api";
import { DocsPanel } from "./docs/panel";
import { DraftsPanel } from "./drafts/panel";
import { setSharedToastHost, ToastHost } from "./notifications/toast";
import { OperatorPanel } from "./operator/panel";
import { RecallPalette } from "./recall/palette";
import { ReleasePanel } from "./release/panel";
import { ShortcutsPanel } from "./shortcuts/panel";
import { GlobalSearchPalette } from "./search/palette";
import { SettingsPanel } from "./settings/panel";
import { StatusBar } from "./status/bar";
import { TabManager } from "./tabs/manager";
import { ConvergenceOverlay } from "./convergence/overlay";
import { makeTabsBridge } from "./convergence/tabs-bridge";
import { zoom } from "./zoom";
import { OperatorPicker } from "./operator/picker";

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
  const workspace = requireEl<HTMLElement>("workspace");
  const newTabBtn = requireEl<HTMLElement>("new-tab");
  const newGroupBtn = requireEl<HTMLButtonElement>("new-group");
  const tabbarFoldBtn = requireEl<HTMLButtonElement>("tabbar-fold");

  // Lucide chevrons-left icon — flipped via CSS when the sidebar is
  // collapsed so a single SVG covers both states.
  tabbarFoldBtn.innerHTML = Icons.chevronRight({ size: 14 });
  tabbarFoldBtn.addEventListener("click", () => {
    const next = !document.body.classList.contains("tabbar-left-collapsed");
    applyTabbarCollapsed(next);
    localStorage.setItem(TABBAR_LEFT_COLLAPSED_KEY, next ? "1" : "0");
    // xterm needs to remeasure cells after the column width animation.
    setTimeout(() => manager.refitActive(), 320);
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

  newGroupBtn.addEventListener("click", () => {
    manager.createEmptyGroup();
  });

  const convergence = new ConvergenceOverlay(makeTabsBridge(manager));

  // 3.7 status bar — bottom of #layout. Hidden when status_bar_enabled
  // is false (collapses the third grid row). TabManager pushes the
  // active-tab cwd on activation + cwd_changed.
  const statusBar = new StatusBar(requireEl<HTMLElement>("status-bar"));
  statusBar.setEnabled(initialSettings?.status_bar_enabled ?? true);
  manager.onActiveContextChange = (cwd) => statusBar.setCwd(cwd);
  manager.onActiveTabChange = (info) => statusBar.setActiveTab(info);
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

  const settingsPage = requireEl<HTMLElement>("settings-page");
  const settings = new SettingsPanel(settingsPage, workspace);
  const agent = new AgentPanel(document.body, () => manager.activeSessionId());
  const operator = new OperatorPanel(document.body, manager);
  const release = new ReleasePanel(document.body);
  const shortcutsPanel = new ShortcutsPanel(document.body);
  statusBar.onVersionChipClick = () => release.toggle();
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
  const aomBanner = new AomBanner(document.body);
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

  // ⌘⇧O → open operator picker for the active session.
  window.addEventListener("keydown", (e) => {
    if (e.metaKey && e.shiftKey && (e.key === "O" || e.key === "o")) {
      e.preventDefault();
      const sid = manager.activeSessionId();
      if (sid) void operatorPicker.open(sid);
      return;
    }
  });

  window.addEventListener("keydown", (e) => {
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
      void settings.toggle();
      return;
    }
    // ⌘K → super-agent panel.
    if (e.metaKey && !e.shiftKey && e.key === "k") {
      e.preventDefault();
      agent.toggle();
      return;
    }
    // ⌘O → operator decisions panel.
    if (e.metaKey && !e.shiftKey && e.key === "o") {
      e.preventDefault();
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
        // OFF→ON: kick the entry splash AFTER the backend confirms
        // the toggle, so the budget the splash displays is the value
        // AOM actually started with (not whatever the UI cached). If
        // the toggle errors or doesn't actually flip on (race), skip
        // the splash entirely.
        void aomBanner.toggle().then(() => {
          if (aomBanner.isOn()) {
            void playAomEntrySplash(aomBanner.getStatus());
          }
        });
      }
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

void boot().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("covenant boot failed", err);
  const workspace = document.getElementById("workspace");
  if (workspace) workspace.textContent = `boot failed: ${String(err)}`;
});
