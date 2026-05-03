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
import { AomReportPanel } from "./aom/report";
import { AfkOverlay } from "./aom/afk";
import { injectCommand, tabManifestLoad, zshAutosuggestionsStatus } from "./api";
import type { Settings, WindowBackground } from "./api";
import { DocsPanel } from "./docs/panel";
import { ToastHost } from "./notifications/toast";
import { OperatorPanel } from "./operator/panel";
import { RecallPalette } from "./recall/palette";
import { GlobalSearchPalette } from "./search/palette";
import { SettingsPanel } from "./settings/panel";
import { StatusBar } from "./status/bar";
import { TabManager } from "./tabs/manager";
import { zoom } from "./zoom";

/// Set body class controlling --surface-alpha. Adds `bg-{kind}` and
/// removes the other two so toggling at runtime is idempotent.
function applyWindowBackground(kind: WindowBackground): void {
  const body = document.body;
  body.classList.remove("bg-solid", "bg-vibrant", "bg-translucent");
  body.classList.add(`bg-${kind}`);
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
  } catch {
    applyWindowBackground("vibrant");
  }

  const tabbar = requireEl<HTMLElement>("tabs");
  const workspace = requireEl<HTMLElement>("workspace");
  const newTabBtn = requireEl<HTMLElement>("new-tab");

  // Render the new-tab button with its keyboard hint visible inline,
  // adapted to the host platform's modifier symbol.
  newTabBtn.innerHTML = `
    <span class="new-tab-plus">+</span>
    <kbd class="new-tab-kbd">${MOD_KEY}T</kbd>
  `;
  newTabBtn.title = `New tab (${MOD_KEY}T)`;

  const manager = new TabManager(tabbar, workspace, newTabBtn, () => {
    // Closing the last tab quits the app — matches iTerm/Terminal.app.
    void getCurrentWindow().close();
  });

  // 3.7 status bar — bottom of #layout. Hidden when status_bar_enabled
  // is false (collapses the third grid row). TabManager pushes the
  // active-tab cwd on activation + cwd_changed.
  const statusBar = new StatusBar(requireEl<HTMLElement>("status-bar"));
  statusBar.setEnabled(initialSettings?.status_bar_enabled ?? true);
  manager.onActiveContextChange = (cwd) => statusBar.setCwd(cwd);
  manager.onActiveMissionChange = (mission, sessionId) =>
    statusBar.setMission(mission, sessionId);
  // Tab context-menu "View mission…" reuses the same modal as the
  // status-bar chip — keep the rendering in one place.
  manager.onMissionViewRequested = (mission, sessionId) =>
    void statusBar.openMissionFor(mission, sessionId);

  const settingsPage = requireEl<HTMLElement>("settings-page");
  const settings = new SettingsPanel(settingsPage, workspace);
  const agent = new AgentPanel(document.body, () => manager.activeSessionId());
  const operator = new OperatorPanel(document.body);
  const recallPalette = new RecallPalette(
    document.body,
    () => manager.activeSessionId(),
    () => manager.activeCwd(),
    (sessionId, command) => injectCommand(sessionId, command),
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
    statusBar.setEnabled(next.status_bar_enabled ?? true);
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
    onExit: () => manager.refitActive(),
  });
  const docsPage = requireEl<HTMLElement>("docs-page");
  const docsPanel = new DocsPanel(docsPage, workspace);
  docsPanel.onClosed = () => {
    manager.refitActive();
  };

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
      // Settings and docs share the workspace grid cell — only one can
      // be visible. Close docs first if it's the one currently up.
      if (docsPanel.isOpen()) docsPanel.close();
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
    // ⌘⇧A — layered AOM/AFK toggle:
    //   AFK open        → close AFK (back to normal UI; AOM stays on)
    //   AOM on, AFK off → open AFK (Battery Mode)
    //   AOM off         → start AOM (auto-enables Operator on every
    //                     non-excluded tab; banner.onChange refreshes
    //                     per-tab badges).
    // Stopping AOM is done via the banner's Stop button (intentional —
    // a four-state shortcut would be too easy to mistrigger overnight).
    if (e.metaKey && e.shiftKey && (e.key === "A" || e.key === "a")) {
      e.preventDefault();
      if (afk.isOpen()) {
        afk.close();
      } else if (aomBanner.isOn()) {
        afk.open();
      } else {
        void aomBanner.toggle();
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
    // ⌘? (Shift+/) and ⌘/ both toggle the in-app docs hub. Two
    // bindings because "?" requires Shift on most layouts; ⌘/ is the
    // shift-free alias.
    if (e.metaKey && (e.key === "?" || e.key === "/")) {
      e.preventDefault();
      // Mutually exclusive with settings — see ⌘, branch above.
      if (settings.isOpen()) settings.close();
      docsPanel.toggle();
      return;
    }
    // Esc closes any open modal first; only routes to terminal if none.
    if (e.key === "Escape") {
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
      if (docsPanel.isOpen()) {
        e.preventDefault();
        docsPanel.close();
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
