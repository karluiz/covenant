// M2 entry point. Boots the TabManager with one initial tab, wires
// keyboard shortcuts (⌘T new, ⌘W close, ⌘1..9 jump, ⌘Shift+[ /]
// prev/next), and closes the app window when the last tab is gone.

import "@xterm/xterm/css/xterm.css";

import { getCurrentWindow } from "@tauri-apps/api/window";

import { AgentPanel } from "./agent/panel";
import { SettingsPanel } from "./settings/panel";
import { TabManager } from "./tabs/manager";

function requireEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null;
  if (!el) throw new Error(`missing #${id} element`);
  return el;
}

async function boot(): Promise<void> {
  const tabbar = requireEl<HTMLElement>("tabs");
  const workspace = requireEl<HTMLElement>("workspace");
  const newTabBtn = requireEl<HTMLElement>("new-tab");

  const manager = new TabManager(tabbar, workspace, newTabBtn, () => {
    // Closing the last tab quits the app — matches iTerm/Terminal.app.
    void getCurrentWindow().close();
  });

  const settings = new SettingsPanel(document.body);
  const agent = new AgentPanel(document.body, () => manager.activeSessionId());

  await manager.createTab();

  window.addEventListener("keydown", (e) => {
    // ⌘, → settings (macOS Preferences convention). Open or toggle.
    if (e.metaKey && !e.shiftKey && e.key === ",") {
      e.preventDefault();
      void settings.toggle();
      return;
    }
    // ⌘K → super-agent panel.
    if (e.metaKey && !e.shiftKey && e.key === "k") {
      e.preventDefault();
      agent.toggle();
      return;
    }
    // Esc closes any open modal first; only routes to terminal if none.
    if (e.key === "Escape") {
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
  console.error("karl-terminal boot failed", err);
  const workspace = document.getElementById("workspace");
  if (workspace) workspace.textContent = `boot failed: ${String(err)}`;
});
