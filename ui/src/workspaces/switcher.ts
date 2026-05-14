// Workspace switcher: chip + popover.
//
// The chip lives in the tabbar brand row and shows the active workspace
// (color dot + name). Clicking it opens a popover with the full list,
// a "+ New workspace" affordance, and per-row right-click for rename /
// duplicate / set root dir / set color / delete.

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { pushInfoToast } from "../notifications/toast";
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
  /// Auto-names "Workspace N" — Tauri's webview suppresses window.prompt,
  /// so we skip it and let the user rename via the row context menu.
  async createAndSwitch(): Promise<void> {
    const existing = this.ws.list().length;
    const name = `Workspace ${existing + 1}`;
    const id = this.ws.create(name);
    await this.runSwitch(id, name);
  }

  /// Wraps switchTo with a busy state on the chip + a toast so the user
  /// has feedback during PTY teardown/respawn (can take a second).
  async runSwitch(id: string, name: string): Promise<void> {
    this.chip?.classList.add("workspace-chip-busy");
    pushInfoToast({ message: `Switching to ${name}…` });
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
    this.chip.title = `${active.name} — Workspaces (${KBD_PICK})`;
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

  private openPopover(): void {
    if (!this.chip) return;
    const pop = document.createElement("div");
    pop.className = "workspace-popover";
    this.popover = pop;

    const rect = this.chip.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    pop.style.left = `${rect.left}px`;
    pop.style.maxHeight = `${rect.top - 12}px`;
    pop.style.overflowY = "auto";
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
        const target = this.ws.list().find((w) => w.id === id);
        if (!target || target.active) { this.closePopover(); return; }
        this.closePopover();
        void this.runSwitch(id, target.name);
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

  /// Replace the row's name span with an input. window.prompt is
  /// suppressed by the Tauri webview, so renames happen inline.
  private startInlineRename(id: string): void {
    if (!this.popover) return;
    const row = this.popover.querySelector<HTMLElement>(
      `.workspace-row[data-id="${CSS.escape(id)}"]`,
    );
    const nameEl = row?.querySelector<HTMLElement>(".workspace-row-name");
    const ws = this.ws.list().find((w) => w.id === id);
    if (!row || !nameEl || !ws) return;
    const input = document.createElement("input");
    input.type = "text";
    input.value = ws.name;
    input.className = "workspace-row-rename";
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = (save: boolean): void => {
      const v = input.value.trim();
      if (save && v !== "" && v !== ws.name) this.ws.rename(id, v);
      else this.renderPopover();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", () => commit(true));
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
    // Clamp inside viewport (8px gutter). Prefer placing left of the
    // cursor when there's no room on the right.
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const PAD = 8;
    let left = x;
    let top = y;
    if (left + rect.width + PAD > vw) left = Math.max(PAD, x - rect.width);
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
