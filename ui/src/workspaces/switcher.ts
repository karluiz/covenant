// Workspace switcher: chip + popover.
//
// The chip lives in the tabbar brand row and shows the active workspace
// (color dot + name). Clicking it opens a popover with the full list,
// a "+ New workspace" affordance, and per-row right-click for rename /
// duplicate / set root dir / set color / delete.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { TabManager } from "../tabs/manager";
import { attachTooltip } from "../tooltip/tooltip";
import { buildActions } from "./actions";
import { CommandPalette } from "./palette";
import { WorkspaceManager } from "./manager";

const KBD_PICK = "⌘⇧P";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const COLOR_OPTIONS: Array<{ name: string; value: string | null }> = [
  { name: "None", value: null },
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Green", value: "#22c55e" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Sky", value: "#0ea5e9" },
  { name: "Indigo", value: "#6366f1" },
  { name: "Purple", value: "#a855f7" },
  { name: "Pink", value: "#ec4899" },
];

export class WorkspaceSwitcher {
  private chip: HTMLButtonElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private palette: CommandPalette;

  constructor(
    private readonly ws: WorkspaceManager,
    tabManager: TabManager,
  ) {
    const actions = buildActions(ws, tabManager, (id) => this.startInlineRename(id));
    this.palette = new CommandPalette(document.body, ws, tabManager, actions);
  }

  /// Mount the chip into the given host element. Returns the chip so
  /// callers can position it (e.g. prepend vs append).
  mount(host: HTMLElement): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "workspace-chip";
    attachTooltip(btn, `Workspaces (${KBD_PICK})`);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.palette.toggle();
    });
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const active = this.ws.list().find((w) => w.active);
      if (active) this.showRowMenu(btn, active.id);
    });
    host.appendChild(btn);
    this.chip = btn;
    this.renderChip();
    this.unsubscribe = this.ws.onChange(() => {
      this.renderChip();
    });
    return btn;
  }

  destroy(): void {
    this.palette.close();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.chip?.parentElement) this.chip.parentElement.removeChild(this.chip);
    this.chip = null;
  }

  /// Open/close the command palette. Bound to ⌘⇧P and ⌘⌥T in main.ts.
  togglePopover(): void {
    this.palette.toggle();
  }

  /// Create a new workspace and switch to it. Bound to ⌘⌥N in main.ts.
  /// Auto-names "Workspace N" — Tauri's webview suppresses window.prompt,
  /// so we skip it and let the user rename via the row context menu.
  async createAndSwitch(): Promise<void> {
    const existing = this.ws.list().length;
    const name = `Workspace ${existing + 1}`;
    const id = this.ws.create(name);
    await this.runSwitch(id, name);
  }

  /// Wraps switchTo with a busy state on the chip. The workspace-switch
  /// overlay (orb + name) provides the user-facing feedback during PTY
  /// teardown/respawn, so no toast is needed.
  async runSwitch(id: string, _name: string): Promise<void> {
    this.chip?.classList.add("workspace-chip-busy");
    try {
      await this.ws.switchTo(id);
    } finally {
      this.chip?.classList.remove("workspace-chip-busy");
    }
  }

  private renderChip(): void {
    if (!this.chip) return;
    const active = this.ws.list().find((w) => w.active);
    if (!active) {
      this.chip.innerHTML = "";
      return;
    }
    attachTooltip(this.chip, `${active.name} — Workspaces (${KBD_PICK})`);
    const tint = active.color ? esc(active.color) : "currentColor";
    this.chip.innerHTML = `
      <span class="new-tab-plus">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none"
             stroke="${tint}" stroke-width="1.4" aria-hidden="true">
          <rect x="2.5" y="2.5" width="7" height="7" rx="1.4"></rect>
          <rect x="6.5" y="6.5" width="7" height="7" rx="1.4"></rect>
        </svg>
      </span>
      <kbd class="new-tab-kbd">${esc(KBD_PICK)}</kbd>
    `;
  }

  /// Rename a workspace via a minimal inline input anchored to the
  /// chip. The popover that previously hosted inline editing is gone;
  /// the Tauri webview suppresses window.prompt, so we float an input.
  private startInlineRename(id: string): void {
    const ws = this.ws.list().find((w) => w.id === id);
    if (!ws || !this.chip) return;
    const input = document.createElement("input");
    input.type = "text";
    input.value = ws.name;
    input.className = "workspace-row-rename workspace-chip-rename";
    document.body.appendChild(input);
    const r = this.chip.getBoundingClientRect();
    input.style.position = "fixed";
    input.style.left = `${r.left}px`;
    input.style.top = `${Math.max(8, r.top - 32)}px`;
    input.style.zIndex = "1002";
    input.focus();
    input.select();
    const commit = (save: boolean): void => {
      const v = input.value.trim();
      if (save && v !== "" && v !== ws.name) this.ws.rename(id, v);
      input.remove();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", () => commit(true));
  }

  /// Per-workspace context menu (rename / duplicate / root dir / color /
  /// delete). Public so a host (e.g. the command palette) can wire it to
  /// a row affordance; the inline popover that used to call it is gone.
  private showRowMenu(row: HTMLElement, id: string): void {
    // Minimalist contextual menu — keeps the dependency footprint of
    // the switcher self-contained rather than reusing ContextMenu which
    // would couple us to the tab manager's larger menu plumbing.
    const ws = this.ws.list().find((w) => w.id === id);
    if (!ws) return;
    const menu = document.createElement("div");
    menu.className = "workspace-rowmenu";
    menu.style.position = "fixed";
    menu.style.visibility = "hidden";
    menu.style.zIndex = "1001";
    const colorRows = COLOR_OPTIONS.map(
      (c) =>
        `<div class="workspace-rowmenu-color" data-color="${c.value ?? ""}">` +
        `<span class="workspace-rowmenu-swatch" style="background:${c.value ?? "transparent"};border:1px solid #888;"></span>` +
        `${esc(c.name)}</div>`,
    ).join("");
    menu.innerHTML = `
      <div class="workspace-rowmenu-item" data-action="rename">Rename…</div>
      <div class="workspace-rowmenu-item" data-action="duplicate">Duplicate</div>
      <div class="workspace-rowmenu-item" data-action="root-dir">Set root dir…</div>
      <div class="workspace-rowmenu-sub">Color
        <div class="workspace-rowmenu-colors">${colorRows}</div>
      </div>
      <div class="workspace-rowmenu-item workspace-rowmenu-danger" data-action="delete">Delete</div>
    `;
    document.body.appendChild(menu);
    // Anchor as a submenu: flush to the right edge of the workspace
    // popover, top-aligned with the clicked row. Fall back to the
    // popover's left side if there's no horizontal room on the right.
    const rect = menu.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const popRect = row.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const PAD = 8;
    const GAP = 6;
    let left = popRect.right + GAP;
    if (left + rect.width + PAD > vw) left = Math.max(PAD, popRect.left - rect.width - GAP);
    let top = rowRect.top;
    if (top + rect.height + PAD > vh) top = Math.max(PAD, vh - rect.height - PAD);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
    const cleanup = () => menu.remove();
    const onAway = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        cleanup();
        document.removeEventListener("click", onAway);
      }
    };
    setTimeout(() => document.addEventListener("click", onAway), 0);

    menu.addEventListener("click", (e) => {
      // Keep the popover open: the doc-level listener that closes it
      // treats anything outside .workspace-popover as "outside", and
      // this menu lives in document.body.
      e.stopPropagation();
      const target = e.target as HTMLElement;
      const colorEl = target.closest<HTMLElement>(".workspace-rowmenu-color");
      if (colorEl) {
        const raw = colorEl.dataset.color ?? "";
        this.ws.setColor(id, raw === "" ? null : raw);
        cleanup();
        return;
      }
      const item = target.closest<HTMLElement>("[data-action]");
      if (!item) return;
      const action = item.dataset.action;
      cleanup();
      if (action === "rename") {
        this.startInlineRename(id);
      } else if (action === "duplicate") {
        this.ws.duplicate(id);
      } else if (action === "root-dir") {
        void openDialog({
          title: `Root dir for workspace '${ws.name}'`,
          multiple: false,
          directory: true,
          defaultPath: ws.root_dir ?? undefined,
        }).then((picked) => {
          if (typeof picked === "string") this.ws.setRootDir(id, picked);
          else if (picked === null) this.ws.setRootDir(id, null);
        });
      } else if (action === "delete") {
        void this.ws.delete(id);
      }
    });
  }
}
