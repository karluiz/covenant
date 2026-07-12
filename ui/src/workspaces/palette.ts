/// Centered command palette — unified quick-switch across workspaces,
/// tabs, and actions. Modeled on RecallPalette (overlay/card, flat
/// cursor, mousemove-not-mouseenter highlight). Opening is delegated
/// here from the WorkspaceSwitcher chip + ⌘⌥T / ⌘⇧P keybindings.

import type { TabManager } from "../tabs/manager";
import type { WorkspaceManager } from "./manager";
import {
  buildSections,
  flattenSections,
  type PaletteAction,
  type PaletteItem,
  type Sections,
} from "./palette-items";

const SECTION_TITLES: Record<keyof Sections, string> = {
  recent: "Recent",
  workspaces: "Workspaces",
  tabs: "Tabs",
  actions: "Actions",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export class CommandPalette {
  private overlay: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private tilesEl: HTMLElement | null = null;
  private censusEl: HTMLElement | null = null;
  private query = "";
  private flat: PaletteItem[] = [];
  /// MRU top-5 workspaces, always available as ⌘1–5 targets even
  /// while a query filters the visible sections.
  private tiles: PaletteItem[] = [];
  private cursor = 0;

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly manager: WorkspaceManager,
    private readonly tabManager: TabManager,
    private readonly actions: PaletteAction[],
    private readonly focusTerminal?: () => void,
  ) {}

  isOpen(): boolean {
    return this.overlay !== null;
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen()) return;
    this.query = "";
    this.cursor = 0;
    this.render();
    this.refresh();
  }

  close(): void {
    if (!this.overlay) return;
    this.overlay.remove();
    this.overlay = null;
    this.inputEl = null;
    this.listEl = null;
    this.tilesEl = null;
    this.censusEl = null;
    this.flat = [];
    this.tiles = [];
    this.cursor = 0;
  }

  private render(): void {
    const overlay = document.createElement("div");
    overlay.className = "command-palette-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const card = document.createElement("div");
    card.className = "command-palette-card";
    card.innerHTML = `
      <div class="command-palette-input-row">
        <span class="cp-caret">›</span>
        <input type="text" class="command-palette-input"
               placeholder="Search workspaces, tabs, actions…"
               autocomplete="off" spellcheck="false" />
        <span class="cp-kbd">⌘⌥T</span>
      </div>
      <div class="cp-tiles" role="listbox"></div>
      <div class="command-palette-list" role="listbox"></div>
      <div class="cp-footer">
        <span class="cp-census"></span>
        <span class="cp-hints">
          <span class="cp-hint"><span class="cp-kbd">↑↓</span>navigate</span>
          <span class="cp-hint"><span class="cp-kbd">↵</span>open</span>
          <span class="cp-hint"><span class="cp-kbd">⌘1–5</span>workspace</span>
          <span class="cp-hint"><span class="cp-kbd">esc</span>close</span>
        </span>
      </div>
    `;
    overlay.appendChild(card);
    this.mountHost.appendChild(overlay);

    this.overlay = overlay;
    this.inputEl = card.querySelector<HTMLInputElement>(".command-palette-input")!;
    this.listEl = card.querySelector<HTMLElement>(".command-palette-list")!;
    this.tilesEl = card.querySelector<HTMLElement>(".cp-tiles")!;
    this.censusEl = card.querySelector<HTMLElement>(".cp-census")!;

    this.inputEl.addEventListener("input", () => {
      this.query = this.inputEl?.value ?? "";
      this.cursor = 0;
      this.refresh();
    });
    this.inputEl.addEventListener("keydown", (e) => this.onKey(e));
    this.inputEl.focus();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.query !== "") {
        this.query = "";
        if (this.inputEl) this.inputEl.value = "";
        this.cursor = 0;
        this.refresh();
      } else {
        this.close();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.move(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this.move(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const pick = this.flat[this.cursor];
      if (pick) void this.execute(pick);
      return;
    }
    if (e.metaKey && !e.altKey && e.key >= "1" && e.key <= "5") {
      const tile = this.tiles[Number(e.key) - 1];
      if (tile) {
        e.preventDefault();
        void this.execute(tile);
      }
      return;
    }
  }

  private move(delta: number): void {
    if (this.flat.length === 0) return;
    this.cursor = (this.cursor + delta + this.flat.length) % this.flat.length;
    this.highlight();
  }

  private highlight(): void {
    if (!this.listEl) return;
    this.listEl.querySelectorAll<HTMLElement>(".command-palette-item").forEach((el, i) => {
      el.classList.toggle("active", i === this.cursor);
      if (i === this.cursor) el.scrollIntoView?.({ block: "nearest" });
    });
  }

  private refresh(): void {
    const ctx = {
      workspaces: this.manager.list(),
      tabs: this.manager.listAllTabs(),
      actions: this.actions,
      activeWorkspaceId: this.manager.activeId_(),
      switchWorkspace: (id: string) => this.manager.switchTo(id),
      activateTab: (idx: number) => this.tabManager.activateByIndex(idx),
    };
    const browsing = this.query.trim() === "";
    const sections = buildSections(this.query, ctx);
    // Browsing: workspaces render as the ⌘1–5 tile strip, not list rows,
    // so the arrow cursor walks Recent → Tabs only. A query folds them
    // back into the ranked list.
    this.tiles = browsing ? sections.workspaces : buildSections("", ctx).workspaces;
    this.flat = browsing
      ? [...sections.recent, ...sections.tabs]
      : flattenSections(sections);
    if (this.cursor >= this.flat.length) this.cursor = 0;
    this.renderTiles(browsing);
    this.renderList(browsing ? { ...sections, workspaces: [] } : sections);
    if (this.censusEl) {
      const ws = ctx.workspaces.length;
      const tabs = ctx.tabs.length;
      this.censusEl.textContent = `${ws} ${ws === 1 ? "workspace" : "workspaces"} · ${tabs} ${tabs === 1 ? "tab" : "tabs"}`;
    }
  }

  private renderTiles(browsing: boolean): void {
    if (!this.tilesEl) return;
    this.tilesEl.hidden = !browsing || this.tiles.length === 0;
    if (this.tilesEl.hidden) return;
    this.tilesEl.innerHTML = this.tiles
      .map((w, i) => {
        const gc = w.color ? ` style="--gc:${escapeHtml(w.color)}"` : "";
        return `
        <div class="cp-tile${w.current ? " current" : ""}" role="option" data-tile="${i}"${gc}>
          <div class="cp-tile-name">${escapeHtml(w.title)}</div>
          <div class="cp-tile-meta"><span class="cp-tile-sub">${escapeHtml(w.subtitle ?? "")}</span><span class="cp-tile-kbd">⌘${i + 1}</span></div>
        </div>`;
      })
      .join("");
    this.tilesEl.querySelectorAll<HTMLElement>(".cp-tile").forEach((el) => {
      el.addEventListener("click", () => {
        const pick = this.tiles[Number(el.dataset.tile ?? "0")];
        if (pick) void this.execute(pick);
      });
    });
  }

  private renderList(sections: Sections): void {
    if (!this.listEl) return;
    if (this.flat.length === 0) {
      this.listEl.innerHTML = `<div class="command-palette-empty">No matches</div>`;
      return;
    }

    let flatIdx = 0;
    const order: Array<keyof Sections> = ["recent", "workspaces", "tabs", "actions"];
    let html = "";
    for (const key of order) {
      const items = sections[key];
      if (items.length === 0) continue;
      html += `<div class="command-palette-section-header"><span>${SECTION_TITLES[key]}</span><span class="cp-count">${items.length}</span></div>`;
      for (const item of items) {
        html += this.itemHtml(item, flatIdx);
        flatIdx++;
      }
    }
    this.listEl.innerHTML = html;

    this.listEl.querySelectorAll<HTMLElement>(".command-palette-item").forEach((el) => {
      const idx = Number(el.dataset.index ?? "0");
      el.addEventListener("mousemove", () => {
        if (idx === this.cursor) return;
        this.cursor = idx;
        this.highlight();
      });
      el.addEventListener("click", () => {
        const pick = this.flat[idx];
        if (pick) void this.execute(pick);
      });
    });
  }

  private itemHtml(item: PaletteItem, idx: number): string {
    const active = idx === this.cursor ? " active" : "";
    const gc = item.color ? ` style="--gc:${escapeHtml(item.color)}"` : "";
    const icon =
      item.kind === "action" ? `<span class="cp-icon">${escapeHtml(item.icon ?? "▸")}</span>` : "";
    const groupPart = item.subtitleGroup
      ? `${item.subtitle ? `<span class="cp-sub-sep">·</span>` : ""}<span class="cp-sub-group">${escapeHtml(item.subtitleGroup)}</span>`
      : "";
    const sub =
      item.subtitle || item.subtitleGroup
        ? `<span class="cp-sub">${item.subtitle ? escapeHtml(item.subtitle) : ""}${groupPart}</span>`
        : "";
    const badge = item.current ? `<span class="cp-current">current</span>` : "";
    const verb = item.kind === "workspace" ? "switch" : item.kind === "action" ? "run" : "open";
    return `
      <div class="command-palette-item${active}" role="option" data-index="${idx}"${gc}>
        <span class="cp-main">${icon}<span class="cp-title">${escapeHtml(item.title)}</span>${badge}</span>
        ${sub}
        <span class="cp-enter">↵ ${verb}</span>
      </div>`;
  }

  private async execute(item: PaletteItem): Promise<void> {
    this.close();
    try {
      await item.run();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("command palette action failed", err);
    }
    this.focusTerminal?.();
  }
}
