// Tab manager: each tab owns one backend Session, its own xterm.js
// Terminal, and its own BlockManager. Switching tabs hides inactive
// panes via the [hidden] attribute — terminals are never re-mounted on
// activation, satisfying the CLAUDE.md TS conventions.
//
// M-UX1 adds: rename (double-click or context menu), color (right-click
// → swatches), and drag-reorder. All metadata is in-memory only —
// persistence ties to session restoration which is its own arch change
// (M7+ scope).

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
import { ContextMenu, COLOR_SWATCHES } from "../menu/context-menu";

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
  /// Default name from the spawn sequence ("zsh 1"). Always present.
  defaultTitle: string;
  /// User-set name. When set, takes precedence over defaultTitle.
  customName: string | null;
  /// Hex color or null. Drives left-border + faint background tint.
  color: string | null;
  pane: HTMLElement;
  termHost: HTMLElement;
  blocksHost: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  blocks: BlockManager;
  disposers: IDisposable[];
}

function tabDisplayName(t: Tab): string {
  return t.customName?.trim() || t.defaultTitle;
}

export class TabManager {
  private readonly tabs: Tab[] = [];
  private activeId: string | null = null;
  private nextSeq = 1;
  private readonly menu: ContextMenu;
  private renamingId: string | null = null;
  private draggingId: string | null = null;

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
      defaultTitle: `zsh ${seq}`,
      customName: null,
      color: null,
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

  private setColor(id: string, color: string | null): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.color = color;
    this.renderTabbar();
  }

  private startRename(id: string): void {
    if (this.renamingId === id) return;
    this.renamingId = id;
    this.renderTabbar();
  }

  private commitRename(id: string, value: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const trimmed = value.trim();
    tab.customName = trimmed.length > 0 ? trimmed : null;
    this.renamingId = null;
    this.renderTabbar();
  }

  private cancelRename(): void {
    if (!this.renamingId) return;
    this.renamingId = null;
    this.renderTabbar();
  }

  // ─── Drag reorder ───────────────────────────────────

  private reorder(fromId: string, toId: string, side: "left" | "right"): void {
    if (fromId === toId) return;
    const fromIdx = this.tabs.findIndex((t) => t.id === fromId);
    const toIdx = this.tabs.findIndex((t) => t.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;

    const [moved] = this.tabs.splice(fromIdx, 1);
    let insertAt = this.tabs.findIndex((t) => t.id === toId);
    if (side === "right") insertAt += 1;
    this.tabs.splice(insertAt, 0, moved);
    this.renderTabbar();
  }

  // ─── Render ─────────────────────────────────────────

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
      this.tabbarHost.appendChild(this.renderTabPill(tab));
    }
  }

  private renderTabPill(tab: Tab): HTMLElement {
    // <div role=button> instead of <button> so we can nest <input> for
    // the inline rename (button > input is invalid HTML).
    const pill = document.createElement("div");
    pill.role = "button";
    pill.tabIndex = 0;
    pill.className = `tab-btn ${tab.id === this.activeId ? "active" : ""}`;
    pill.dataset.tabId = tab.id;
    pill.title = tabDisplayName(tab);
    pill.draggable = true;

    if (tab.color) {
      pill.classList.add("tab-colored");
      pill.style.setProperty("--tab-color", tab.color);
    }

    if (this.renamingId === tab.id) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "tab-label-input";
      input.value = tab.customName ?? tab.defaultTitle;
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          this.commitRename(tab.id, input.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.cancelRename();
        }
      });
      input.addEventListener("blur", () => {
        if (this.renamingId === tab.id) {
          this.commitRename(tab.id, input.value);
        }
      });
      input.addEventListener("click", (e) => e.stopPropagation());
      pill.appendChild(input);
      // Focus + select-all on next tick so the input is in the DOM.
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
      if (this.renamingId === tab.id) return;
      // Ignore clicks that originated on the close button (handled above).
      if ((e.target as HTMLElement).closest(".tab-close")) return;
      this.activate(tab.id);
    });

    pill.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".tab-close")) return;
      e.preventDefault();
      this.startRename(tab.id);
    });

    pill.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openTabContextMenu(tab, e.clientX, e.clientY);
    });

    // ── Drag and drop ──
    pill.addEventListener("dragstart", (e) => {
      if (this.renamingId === tab.id) {
        e.preventDefault();
        return;
      }
      this.draggingId = tab.id;
      pill.classList.add("tab-dragging");
      e.dataTransfer?.setData("text/plain", tab.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });

    pill.addEventListener("dragend", () => {
      this.draggingId = null;
      pill.classList.remove("tab-dragging");
      this.tabbarHost
        .querySelectorAll(".tab-drop-left, .tab-drop-right")
        .forEach((el) => el.classList.remove("tab-drop-left", "tab-drop-right"));
    });

    pill.addEventListener("dragover", (e) => {
      if (!this.draggingId || this.draggingId === tab.id) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = pill.getBoundingClientRect();
      const side: "left" | "right" =
        e.clientX < rect.left + rect.width / 2 ? "left" : "right";
      pill.classList.toggle("tab-drop-left", side === "left");
      pill.classList.toggle("tab-drop-right", side === "right");
    });

    pill.addEventListener("dragleave", () => {
      pill.classList.remove("tab-drop-left", "tab-drop-right");
    });

    pill.addEventListener("drop", (e) => {
      e.preventDefault();
      const fromId = this.draggingId;
      pill.classList.remove("tab-drop-left", "tab-drop-right");
      if (!fromId || fromId === tab.id) return;
      const rect = pill.getBoundingClientRect();
      const side: "left" | "right" =
        e.clientX < rect.left + rect.width / 2 ? "left" : "right";
      this.reorder(fromId, tab.id, side);
    });

    return pill;
  }

  private openTabContextMenu(tab: Tab, x: number, y: number): void {
    this.menu.show(x, y, [
      { label: "Rename", onClick: () => this.startRename(tab.id) },
      { divider: true },
      {
        swatches: COLOR_SWATCHES.map((sw) => ({
          color: sw.color,
          title: sw.title,
          onClick: () => this.setColor(tab.id, sw.color),
        })),
      },
      { divider: true },
      {
        label: "Close tab",
        danger: true,
        onClick: () => this.closeTab(tab.id),
      },
    ]);
  }
}
