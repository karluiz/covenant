/// Centered command palette — unified quick-switch across workspaces,
/// tabs, and actions. Modeled on RecallPalette (overlay/card, flat
/// cursor, mousemove-not-mouseenter highlight). Opening is delegated
/// here from the WorkspaceSwitcher chip + ⌘⌥T / ⌘⇧P keybindings.

import type { TabManager } from "../tabs/manager";
import { appModHeld, chordFor, formatChord, modHeld } from "../platform";
import type { WorkspaceManager } from "./manager";
import type { TabRow } from "./finder";
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
  create: "Create",
};

/// Row-verb chords. ⌫ goes on the app-modifier because off macOS the
/// primary modifier + Backspace is delete-word-backward inside an input —
/// taking it would break editing the query to delete a row.
const RENAME_CHORD = (): string => formatChord(["mod", "E"]);
const DESTROY_CHORD = (): string => chordFor(["mod", "⌫"], ["ctrl", "shift", "Bksp"]);
const CREATE_CHORD = (): string => formatChord(["mod", "enter"]);

/// What the palette can't do itself: the host owns delete severity, since
/// "is this expensive to lose" is a policy question, not a palette one.
export interface PaletteHooks {
  deleteWorkspace?: (id: string) => void | Promise<void>;
  deleteBlocked?: (id: string) => string | null;
}

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
  private hintsEl: HTMLElement | null = null;
  /// The create-from-query row, when the query names no workspace. Held
  /// separately so ⌘⏎ reaches it without scrolling to the last row.
  private createItem: PaletteItem | null = null;
  /// True while a row title is an input. Suppresses the row verbs so ⏎ and
  /// esc belong to the edit, not to the list.
  private renaming = false;

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly manager: WorkspaceManager,
    private readonly tabManager: TabManager,
    private readonly actions: PaletteAction[],
    private readonly focusTerminal?: () => void,
    private readonly hooks: PaletteHooks = {},
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
    this.hintsEl = null;
    this.flat = [];
    this.tiles = [];
    this.createItem = null;
    this.renaming = false;
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
        <span class="cp-kbd">${formatChord(["mod", "alt", "T"])}</span>
      </div>
      <div class="cp-tiles" role="listbox"></div>
      <div class="command-palette-list" role="listbox"></div>
      <div class="cp-footer">
        <span class="cp-census"></span>
        <span class="cp-hints"></span>
      </div>
    `;
    overlay.appendChild(card);
    this.mountHost.appendChild(overlay);

    this.overlay = overlay;
    this.inputEl = card.querySelector<HTMLInputElement>(".command-palette-input")!;
    this.listEl = card.querySelector<HTMLElement>(".command-palette-list")!;
    this.tilesEl = card.querySelector<HTMLElement>(".cp-tiles")!;
    this.censusEl = card.querySelector<HTMLElement>(".cp-census")!;
    this.hintsEl = card.querySelector<HTMLElement>(".cp-hints")!;

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
    // Row-scoped verbs — the target is always the row under the cursor,
    // never "the current workspace".
    if (modHeld(e) && e.key === "Enter") {
      e.preventDefault();
      if (this.createItem) void this.execute(this.createItem);
      return;
    }
    if (modHeld(e) && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      this.beginRename();
      return;
    }
    if (appModHeld(e) && e.key === "Backspace") {
      e.preventDefault();
      void this.destroyRow();
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

  /// Turn the focused row's title into an input, in place. The palette
  /// stays open and the list doesn't move — renaming is an edit of the row
  /// you're looking at, not a separate prompt.
  private beginRename(): void {
    if (this.renaming) return;
    const item = this.flat[this.cursor];
    const row = this.listEl?.querySelector<HTMLElement>(
      `.command-palette-item[data-index="${this.cursor}"]`,
    );
    const titleEl = row?.querySelector<HTMLElement>(".cp-title");
    if (!item?.rename || !row || !titleEl) return;

    this.renaming = true;
    row.classList.add("renaming");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cp-rename-input";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = item.title;
    titleEl.replaceWith(input);
    this.renderFooter();

    const finish = (commit: boolean): void => {
      if (!this.renaming) return;
      this.renaming = false;
      const v = input.value.trim();
      if (commit && v !== "" && v !== item.title) item.rename?.(v);
      // Rebuild from the source of truth rather than patching the row.
      this.refresh();
      this.inputEl?.focus();
    };

    input.addEventListener("keydown", (e) => {
      // The list's own handler lives on the query input; this one must not
      // reach the window-level shortcuts either.
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(false));
    input.focus();
    input.select();
  }

  /// Destroy the focused row: delete for a workspace (the host decides
  /// whether that means an undo window or a typed confirm), close for a
  /// tab. The palette stays open — you're working through a list.
  private async destroyRow(): Promise<void> {
    if (this.renaming) return;
    const item = this.flat[this.cursor];
    if (!item?.destroy) return;
    // Deleting the workspace you're standing in forces a switch, and the
    // incoming workspace takes terminal focus mid-rebuild — a palette left
    // open over that is a keystroke sink. Every other row keeps the list up.
    const leaves = item.kind === "workspace" && item.current === true;
    if (leaves) this.close();
    await item.destroy();
    if (!leaves) this.refresh();
  }

  private highlight(): void {
    if (!this.listEl) return;
    this.listEl.querySelectorAll<HTMLElement>(".command-palette-item").forEach((el, i) => {
      el.classList.toggle("active", i === this.cursor);
      if (i === this.cursor) el.scrollIntoView?.({ block: "nearest" });
    });
    // The footer is the only place the row verbs are taught, so it has to
    // follow the cursor.
    this.renderFooter();
  }

  /// Footer hints for whatever the cursor is on. A verb the row doesn't
  /// have is either absent or dimmed with its reason — never a live-looking
  /// key that does nothing.
  private renderFooter(): void {
    if (!this.hintsEl) return;
    const hint = (kbd: string, label: string, dim = false): string =>
      `<span class="cp-hint${dim ? " cp-hint-dim" : ""}"><span class="cp-kbd">${escapeHtml(kbd)}</span>${escapeHtml(label)}</span>`;

    if (this.renaming) {
      this.hintsEl.innerHTML =
        hint(formatChord(["enter"]), "save") + hint("esc", "revert");
      return;
    }

    const item = this.flat[this.cursor];
    const parts = [hint("↑↓", "navigate")];
    if (item) {
      const verb =
        item.kind === "workspace"
          ? "switch"
          : item.kind === "action"
            ? "run"
            : item.kind === "create"
              ? "create"
              : "open";
      parts.push(hint(formatChord(["enter"]), verb));
    }
    if (item?.rename) parts.push(hint(RENAME_CHORD(), "rename"));
    if (item?.destroy) parts.push(hint(DESTROY_CHORD(), item.destroyVerb ?? "delete"));
    else if (item?.destroyBlocked) parts.push(hint(DESTROY_CHORD(), item.destroyBlocked, true));
    if (this.createItem && item?.kind !== "create") {
      parts.push(hint(CREATE_CHORD(), "create"));
    }
    if (this.tiles.length > 0) parts.push(hint(formatChord(["mod", "1–5"]), "workspace"));
    parts.push(hint("esc", "close"));
    this.hintsEl.innerHTML = parts.join("");
  }

  private refresh(): void {
    const ctx = {
      workspaces: this.manager.list(),
      tabs: this.manager.listAllTabs(),
      actions: this.actions,
      activeWorkspaceId: this.manager.activeId_(),
      switchWorkspace: (id: string) => this.manager.switchTo(id),
      activateTab: (idx: number) => this.tabManager.activateByIndex(idx),
      renameWorkspace: (id: string, name: string) => this.manager.rename(id, name),
      deleteWorkspace: this.hooks.deleteWorkspace,
      deleteBlocked: this.hooks.deleteBlocked,
      renameTab: (row: TabRow, name: string) => {
        if (row.tabId) this.tabManager.setTabLabel(row.tabId, name);
      },
      closeTab: (row: TabRow) => {
        if (row.tabId) this.tabManager.closeTab(row.tabId);
      },
      createWorkspace: async (name: string) => {
        const id = this.manager.create(name);
        await this.manager.switchTo(id);
      },
    };
    const browsing = this.query.trim() === "";
    const sections = buildSections(this.query, ctx);
    // Browsing: workspaces render as the ⌘1–5 tile strip, not list rows,
    // so the arrow cursor walks Recent → Tabs only. A query folds them
    // back into the ranked list.
    this.tiles = browsing ? sections.workspaces : buildSections("", ctx).workspaces;
    this.createItem = sections.create[0] ?? null;
    this.flat = browsing
      ? [...sections.recent, ...sections.tabs]
      : flattenSections(sections);
    if (this.cursor >= this.flat.length) this.cursor = 0;
    this.renderTiles(browsing);
    this.renderList(browsing ? { ...sections, workspaces: [] } : sections);
    this.renderFooter();
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
          <div class="cp-tile-meta"><span class="cp-tile-sub">${escapeHtml(w.subtitle ?? "")}</span><span class="cp-tile-kbd">${formatChord(["mod", String(i + 1)])}</span></div>
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
    const order: Array<keyof Sections> = ["recent", "workspaces", "tabs", "actions", "create"];
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
      item.kind === "action" || item.kind === "create"
        ? `<span class="cp-icon">${escapeHtml(item.icon ?? "▸")}</span>`
        : "";
    const groupPart = item.subtitleGroup
      ? `${item.subtitle ? `<span class="cp-sub-sep">·</span>` : ""}<span class="cp-sub-group">${escapeHtml(item.subtitleGroup)}</span>`
      : "";
    const sub =
      item.subtitle || item.subtitleGroup
        ? `<span class="cp-sub">${item.subtitle ? escapeHtml(item.subtitle) : ""}${groupPart}</span>`
        : "";
    const badge = item.current ? `<span class="cp-current">current</span>` : "";
    const verb =
      item.kind === "workspace"
        ? "switch"
        : item.kind === "action"
          ? "run"
          : item.kind === "create"
            ? "create"
            : "open";
    return `
      <div class="command-palette-item cp-kind-${item.kind}${active}" role="option" data-index="${idx}"${gc}>
        <span class="cp-main">${icon}<span class="cp-title">${escapeHtml(item.title)}</span>${badge}</span>
        ${sub}
        <span class="cp-enter">${formatChord(["enter"])} ${verb}</span>
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
