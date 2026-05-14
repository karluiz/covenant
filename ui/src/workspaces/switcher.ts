// Workspace switcher: chip + popover.
//
// The chip lives in the tabbar brand row and shows the active workspace
// (color dot + name). Clicking it opens a popover with the full list,
// a "+ New workspace" affordance, and per-row right-click for rename /
// duplicate / set root dir / set color / delete.

import { WorkspaceManager } from "./manager";

const KBD_NEW = "⌘⌥N";
const KBD_PICK = "⌘⇧P";

function relTime(ms: number): string {
  const dt = Date.now() - ms;
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

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
  private popover: HTMLElement | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly ws: WorkspaceManager) {}

  /// Mount the chip into the given host element. Returns the chip so
  /// callers can position it (e.g. prepend vs append).
  mount(host: HTMLElement): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "workspace-chip";
    btn.title = `Workspaces (${KBD_PICK})`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.togglePopover();
    });
    host.appendChild(btn);
    this.chip = btn;
    this.renderChip();
    this.unsubscribe = this.ws.onChange(() => {
      this.renderChip();
      if (this.popover) this.renderPopover();
    });
    return btn;
  }

  destroy(): void {
    this.closePopover();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.chip?.parentElement) this.chip.parentElement.removeChild(this.chip);
    this.chip = null;
  }

  /// Toggle the popover. Bound to ⌘⇧P in main.ts.
  togglePopover(): void {
    if (this.popover) this.closePopover();
    else this.openPopover();
  }

  /// Create a new workspace and switch to it. Bound to ⌘⌥N in main.ts.
  async createAndSwitch(): Promise<void> {
    const name = window.prompt("New workspace name", "Workspace");
    if (name === null) return;
    const id = this.ws.create(name);
    await this.ws.switchTo(id);
  }

  private renderChip(): void {
    if (!this.chip) return;
    const active = this.ws.list().find((w) => w.active);
    if (!active) {
      this.chip.innerHTML = "";
      return;
    }
    const dotStyle = active.color
      ? `background:${esc(active.color)};`
      : "background:var(--chip-dot, #888);";
    this.chip.innerHTML = `
      <span class="workspace-chip-dot" style="${dotStyle}"></span>
      <span class="workspace-chip-name">${esc(active.name)}</span>
      <span class="workspace-chip-caret">▾</span>
    `;
  }

  private openPopover(): void {
    if (!this.chip) return;
    const pop = document.createElement("div");
    pop.className = "workspace-popover";
    this.popover = pop;

    const rect = this.chip.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.left = `${rect.left}px`;
    pop.style.zIndex = "1000";

    document.body.appendChild(pop);
    this.renderPopover();

    const onDocClick = (e: MouseEvent) => {
      if (!this.popover) return;
      if (this.popover.contains(e.target as Node)) return;
      if (this.chip && this.chip.contains(e.target as Node)) return;
      this.closePopover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closePopover();
    };
    setTimeout(() => {
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
    }, 0);
    pop.dataset.cleanup = "1";
    (pop as HTMLElement & { __cleanup?: () => void }).__cleanup = () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }

  private closePopover(): void {
    if (!this.popover) return;
    const cleanup = (this.popover as HTMLElement & { __cleanup?: () => void }).__cleanup;
    cleanup?.();
    this.popover.remove();
    this.popover = null;
  }

  private renderPopover(): void {
    if (!this.popover) return;
    const list = this.ws.list();
    const rows = list
      .map((w) => {
        const dotStyle = w.color
          ? `background:${esc(w.color)};`
          : "background:var(--chip-dot, #888);";
        const activeCls = w.active ? " workspace-row-active" : "";
        return `
          <div class="workspace-row${activeCls}" data-id="${esc(w.id)}">
            <span class="workspace-row-dot" style="${dotStyle}"></span>
            <span class="workspace-row-name">${esc(w.name)}</span>
            <span class="workspace-row-meta">${w.tab_count} ${w.tab_count === 1 ? "tab" : "tabs"} · ${esc(relTime(w.last_used_at))}</span>
          </div>`;
      })
      .join("");
    this.popover.innerHTML = `
      <div class="workspace-popover-list">${rows}</div>
      <div class="workspace-popover-footer">
        <button type="button" class="workspace-new-btn">+ New workspace</button>
        <span class="workspace-popover-kbd">${esc(KBD_NEW)}</span>
      </div>
    `;

    for (const row of this.popover.querySelectorAll<HTMLElement>(".workspace-row")) {
      const id = row.dataset.id ?? "";
      row.addEventListener("click", () => {
        void this.ws.switchTo(id).then(() => this.closePopover());
      });
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.showRowMenu(e.clientX, e.clientY, id);
      });
    }
    this.popover
      .querySelector<HTMLButtonElement>(".workspace-new-btn")
      ?.addEventListener("click", () => {
        this.closePopover();
        void this.createAndSwitch();
      });
  }

  private showRowMenu(x: number, y: number, id: string): void {
    // Minimalist contextual menu — keeps the dependency footprint of
    // the switcher self-contained rather than reusing ContextMenu which
    // would couple us to the tab manager's larger menu plumbing.
    const ws = this.ws.list().find((w) => w.id === id);
    if (!ws) return;
    const menu = document.createElement("div");
    menu.className = "workspace-rowmenu";
    menu.style.position = "fixed";
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;
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
    const cleanup = () => menu.remove();
    const onAway = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        cleanup();
        document.removeEventListener("click", onAway);
      }
    };
    setTimeout(() => document.addEventListener("click", onAway), 0);

    menu.addEventListener("click", (e) => {
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
        const name = window.prompt("Rename workspace", ws.name);
        if (name !== null && name.trim() !== "") this.ws.rename(id, name);
      } else if (action === "duplicate") {
        this.ws.duplicate(id);
      } else if (action === "root-dir") {
        const dir = window.prompt(
          "Root directory (final-fallback cwd for new tabs)",
          ws.root_dir ?? "",
        );
        if (dir !== null) this.ws.setRootDir(id, dir.trim() === "" ? null : dir);
      } else if (action === "delete") {
        if (window.confirm(`Delete workspace '${ws.name}'? PTYs will be killed.`)) {
          void this.ws.delete(id);
        }
      }
    });
  }
}
