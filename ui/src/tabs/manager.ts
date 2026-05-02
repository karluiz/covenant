// Tab manager: each tab owns one backend Session, its own xterm.js
// Terminal, and its own BlockManager. Switching tabs hides inactive
// panes via the [hidden] attribute — terminals are never re-mounted on
// activation, satisfying the CLAUDE.md TS conventions.
//
// Backend is unchanged from M1; spawn_session keys per Ulid, write/
// resize/close are session-scoped, and the per-session Channel<T>
// instances naturally fan out without any cross-talk on the Rust side.

import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

import {
  closeSession,
  resizeSession,
  spawnSession,
  writeToSession,
  type SessionId,
} from "../api";
import { BlockManager } from "../blocks/manager";

const TERMINAL_OPTIONS = {
  fontFamily:
    'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.2,
  cursorBlink: true,
  cursorStyle: "block",
  allowProposedApi: true,
  convertEol: false,
  scrollback: 10_000,
  theme: {
    background: "#0b0d10",
    foreground: "#d6d8db",
    cursor: "#7aa2f7",
    cursorAccent: "#0b0d10",
    selectionBackground: "#2a3148",
  },
} as const;

interface Tab {
  id: string;
  sessionId: SessionId;
  title: string;
  pane: HTMLElement;
  termHost: HTMLElement;
  blocksHost: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  blocks: BlockManager;
  disposers: IDisposable[];
}

export class TabManager {
  private readonly tabs: Tab[] = [];
  private activeId: string | null = null;
  private nextSeq = 1;

  constructor(
    private readonly tabbarHost: HTMLElement,
    private readonly workspace: HTMLElement,
    newTabBtn: HTMLElement,
    private readonly onAllTabsClosed: () => void,
  ) {
    newTabBtn.addEventListener("click", () => {
      void this.createTab();
    });
    window.addEventListener("resize", () => this.refitActive());
    window.addEventListener("beforeunload", () => {
      for (const tab of this.tabs) {
        void closeSession(tab.sessionId).catch(() => {});
      }
    });
  }

  hasTabs(): boolean {
    return this.tabs.length > 0;
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

  activateByIndex(index: number): void {
    const tab = this.tabs[index];
    if (tab) this.activate(tab.id);
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

  async createTab(): Promise<void> {
    const id = crypto.randomUUID();
    const seq = this.nextSeq++;

    const pane = document.createElement("div");
    pane.className = "tab-pane";
    pane.dataset.tabId = id;

    const termHost = document.createElement("div");
    termHost.className = "tab-terminal";
    pane.appendChild(termHost);

    const blocksHost = document.createElement("div");
    blocksHost.className = "tab-blocks";
    pane.appendChild(blocksHost);

    // Hide any previously-active pane BEFORE appending the new one,
    // so xterm.open() sees a visible container with proper dimensions.
    this.hideAllPanes();
    this.workspace.appendChild(pane);

    const term = new Terminal(TERMINAL_OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost);
    try {
      term.loadAddon(new WebglAddon());
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("WebGL renderer unavailable, using canvas fallback", err);
    }
    fit.fit();

    // BlockManager needs the backend SessionId to wire fix-suggestion
    // injection — but the id only exists after spawn. Construct lazily
    // once we have one.
    let blocks: BlockManager | null = null;
    let sessionId: SessionId;
    try {
      sessionId = await spawnSession({
        onOutput: (chunk) => term.write(chunk),
        onSessionEvent: (event) => blocks?.handleEvent(event),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("spawn_session failed", err);
      term.dispose();
      this.workspace.removeChild(pane);
      if (this.activeId) this.activate(this.activeId, { skipIfSame: false });
      return;
    }
    blocks = new BlockManager(blocksHost, sessionId);

    await resizeSession(sessionId, term.cols, term.rows).catch((e) =>
      // eslint-disable-next-line no-console
      console.error("initial resize failed", e),
    );

    const encoder = new TextEncoder();
    const dataDispose = term.onData((data) => {
      void writeToSession(sessionId, encoder.encode(data)).catch((e) =>
        // eslint-disable-next-line no-console
        console.error("write failed", e),
      );
    });
    const resizeDispose = term.onResize(({ cols, rows }) => {
      void resizeSession(sessionId, cols, rows).catch((e) =>
        // eslint-disable-next-line no-console
        console.error("resize failed", e),
      );
    });

    const tab: Tab = {
      id,
      sessionId,
      title: `zsh ${seq}`,
      pane,
      termHost,
      blocksHost,
      term,
      fit,
      blocks,
      disposers: [dataDispose, resizeDispose],
    };

    this.tabs.push(tab);
    this.activeId = id;
    this.renderTabbar();
    term.focus();
  }

  closeTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;

    const tab = this.tabs[idx];
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

    // Refit and resync size after the pane has reflowed.
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

  private hideAllPanes(): void {
    for (const t of this.tabs) {
      t.pane.hidden = true;
    }
  }

  private refitActive(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return;
    try {
      tab.fit.fit();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("fit failed on resize", err);
    }
  }

  private renderTabbar(): void {
    this.tabbarHost.innerHTML = "";
    for (const tab of this.tabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `tab-btn ${tab.id === this.activeId ? "active" : ""}`;
      btn.dataset.tabId = tab.id;
      btn.title = tab.title;

      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = tab.title;
      btn.appendChild(label);

      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "×";
      close.title = "Close tab (⌘W)";
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(tab.id);
      });
      btn.appendChild(close);

      btn.addEventListener("click", () => this.activate(tab.id));

      this.tabbarHost.appendChild(btn);
    }
  }
}
