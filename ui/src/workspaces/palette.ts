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
  private query = "";
  private flat: PaletteItem[] = [];
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
    this.flat = [];
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
        <span class="command-palette-label">⌘⌥T</span>
        <input type="text" class="command-palette-input"
               placeholder="Search workspaces, tabs, actions…"
               autocomplete="off" spellcheck="false" />
      </div>
      <div class="command-palette-list" role="listbox"></div>
    `;
    overlay.appendChild(card);
    this.mountHost.appendChild(overlay);

    this.overlay = overlay;
    this.inputEl = card.querySelector<HTMLInputElement>(".command-palette-input")!;
    this.listEl = card.querySelector<HTMLElement>(".command-palette-list")!;

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
    const sections = buildSections(this.query, {
      workspaces: this.manager.list(),
      tabs: this.manager.listAllTabs(),
      actions: this.actions,
      activeWorkspaceId: this.manager.activeId_(),
      switchWorkspace: (id) => this.manager.switchTo(id),
      activateTab: (idx) => this.tabManager.activateByIndex(idx),
    });
    this.flat = flattenSections(sections);
    if (this.cursor >= this.flat.length) this.cursor = 0;
    this.renderList(sections);
  }

  private renderList(sections: Sections): void {
    if (!this.listEl) return;
    if (this.flat.length === 0) {
      this.listEl.innerHTML = `<div class="command-palette-empty">No matches</div>`;
      return;
    }

    let flatIdx = 0;
    const order: Array<keyof Sections> = ["workspaces", "tabs", "actions"];
    let html = "";
    for (const key of order) {
      const items = sections[key];
      if (items.length === 0) continue;
      html += `<div class="command-palette-section-header">${SECTION_TITLES[key]}</div>`;
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
    const dot =
      item.kind === "action"
        ? `<span class="cp-icon">${escapeHtml(item.icon ?? "▸")}</span>`
        : `<span class="cp-dot" style="background:${item.color ? escapeHtml(item.color) : "var(--chip-dot, #888)"}"></span>`;
    const sub = item.subtitle
      ? `<span class="cp-sub">${escapeHtml(item.subtitle)}</span>`
      : "";
    return `
      <div class="command-palette-item${active}" role="option" data-index="${idx}">
        ${dot}
        <span class="cp-title">${escapeHtml(item.title)}</span>
        ${sub}
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
