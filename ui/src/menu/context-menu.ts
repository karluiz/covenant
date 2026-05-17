// Lightweight floating context menu used by tabs and blocks.
//
// Built fresh each show() — items are described declaratively. Auto-
// dismisses on outside click or Escape. No keyboard navigation today
// (tab/arrows) — mouse-only is enough for these surfaces.

import { Icons } from "../icons";

export interface MenuItem {
  label?: string;
  /// Optional leading SVG icon (trusted HTML — pass `Icons.foo()`).
  icon?: string;
  onClick?: () => void | Promise<void>;
  divider?: boolean;
  /// Inline group of color/swatch buttons rendered as one row.
  swatches?: Array<{
    color: string | null;
    title: string;
    onClick: () => void;
  }>;
  /// When true, render this swatch row aligned under the colored swatches
  /// of the previous row (skipping the "no color" slot).
  pastelRow?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /// Optional keyboard-shortcut hint shown right-aligned (e.g. "⌘T").
  shortcut?: string;
  /// When set, clicking re-opens the menu populated with these items.
  /// Indicated to the user with a trailing chevron. `onClick` is ignored
  /// when `submenu` is provided.
  submenu?: MenuItem[];
}

export class ContextMenu {
  private el: HTMLElement | null = null;
  private submenuEl: HTMLElement | null = null;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(private readonly host: HTMLElement) {}

  show(x: number, y: number, items: MenuItem[]): void {
    this.dismiss();
    if (items.length === 0) return;

    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    for (const item of items) menu.appendChild(this.renderItem(item, menu));

    // Reserve room at the bottom for the macOS Dock, which overlays the
    // window and is invisible to the WebView (innerHeight includes the
    // area covered by the Dock). Without this, the last items render
    // behind the Dock with no visible scrollbar cue.
    const SAFE_BOTTOM = 90;
    const maxH = window.innerHeight - 16 - SAFE_BOTTOM;
    menu.style.maxHeight = `${maxH}px`;
    // Render off-screen first to measure final size without the
    // animation's initial scale(0.97) skewing the bounding rect.
    menu.style.left = `-9999px`;
    menu.style.top = `0px`;
    this.host.appendChild(menu);

    const rect = menu.getBoundingClientRect();
    const PAD = 8;
    // Prefer right of cursor; flip to the left (anchor menu's right
    // edge to cursor) when it would overflow the viewport. Matches
    // native macOS context-menu behavior near the right edge.
    let left = x;
    if (left + rect.width + PAD > window.innerWidth) {
      left = x - rect.width;
      if (left < PAD) left = Math.max(PAD, window.innerWidth - rect.width - PAD);
    }
    let top = y;
    if (top + rect.height + PAD > window.innerHeight - SAFE_BOTTOM) {
      top = Math.max(PAD, window.innerHeight - rect.height - SAFE_BOTTOM);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    this.el = menu;

    // Defer outside-click registration so the originating right-click
    // doesn't dismiss us immediately.
    setTimeout(() => {
      const handler = (e: MouseEvent): void => {
        const target = e.target as Node;
        const inMain = this.el?.contains(target) ?? false;
        const inSub = this.submenuEl?.contains(target) ?? false;
        if (!inMain && !inSub) this.dismiss();
      };
      this.outsideClickHandler = handler;
      document.addEventListener("mousedown", handler);
    }, 0);

    const esc = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.dismiss();
      }
    };
    this.escHandler = esc;
    document.addEventListener("keydown", esc);
  }

  dismiss(): void {
    if (this.submenuEl) {
      this.submenuEl.remove();
      this.submenuEl = null;
    }
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
    if (this.outsideClickHandler) {
      document.removeEventListener("mousedown", this.outsideClickHandler);
      this.outsideClickHandler = null;
    }
    if (this.escHandler) {
      document.removeEventListener("keydown", this.escHandler);
      this.escHandler = null;
    }
  }

  isOpen(): boolean {
    return this.el !== null;
  }

  private openSubmenu(
    triggerBtn: HTMLElement,
    items: MenuItem[],
    parentMenu: HTMLElement | undefined,
  ): void {
    if (items.length === 0) return;
    if (this.submenuEl) {
      this.submenuEl.remove();
      this.submenuEl = null;
    }

    const sub = document.createElement("div");
    sub.className = "ctx-menu ctx-submenu";
    for (const item of items) sub.appendChild(this.renderItem(item, sub));

    const SAFE_BOTTOM = 90;
    const maxH = window.innerHeight - 16 - SAFE_BOTTOM;
    sub.style.maxHeight = `${maxH}px`;
    // Render off-screen first so we can measure, then place adjacent
    // to the triggering item.
    sub.style.left = `-9999px`;
    sub.style.top = `0px`;
    this.host.appendChild(sub);

    const btnRect = triggerBtn.getBoundingClientRect();
    const parentRect = (parentMenu ?? triggerBtn).getBoundingClientRect();
    const subRect = sub.getBoundingClientRect();
    const PAD = 8;

    // Prefer right of the parent menu; flip to the left if it would
    // overflow the viewport.
    let left = parentRect.right;
    if (left + subRect.width + PAD > window.innerWidth) {
      left = parentRect.left - subRect.width;
    }
    left = Math.max(PAD, left);

    let top = btnRect.top;
    if (top + subRect.height + PAD > window.innerHeight - SAFE_BOTTOM) {
      top = Math.max(PAD, window.innerHeight - subRect.height - SAFE_BOTTOM);
    }

    sub.style.left = `${left}px`;
    sub.style.top = `${top}px`;
    this.submenuEl = sub;
  }

  private renderItem(item: MenuItem, parentMenu?: HTMLElement): HTMLElement {
    if (item.divider) {
      const d = document.createElement("div");
      d.className = "ctx-divider";
      return d;
    }

    if (item.swatches) {
      const row = document.createElement("div");
      row.className = "ctx-swatch-row";
      if (item.pastelRow) row.classList.add("ctx-swatch-row-pastel");
      for (const sw of item.swatches) {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "ctx-swatch";
        dot.title = sw.title;
        if (sw.color) {
          dot.style.background = sw.color;
        } else {
          dot.classList.add("ctx-swatch-none");
          dot.innerHTML = Icons.ban({ size: 11 });
        }
        dot.addEventListener("click", () => {
          sw.onClick();
          this.dismiss();
        });
        row.appendChild(dot);
      }
      return row;
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ctx-item";
    if (item.danger) btn.classList.add("ctx-item-danger");
    if (item.disabled) btn.disabled = true;

    if (item.icon) {
      const iconEl = document.createElement("span");
      iconEl.className = "ctx-item-icon";
      iconEl.innerHTML = item.icon;
      btn.appendChild(iconEl);
    }
    const labelEl = document.createElement("span");
    labelEl.className = "ctx-item-label";
    labelEl.textContent = item.label ?? "";
    btn.appendChild(labelEl);

    if (item.shortcut) {
      const kbd = document.createElement("span");
      kbd.className = "ctx-item-shortcut";
      kbd.textContent = item.shortcut;
      btn.appendChild(kbd);
    }

    if (item.submenu && !item.disabled) {
      const chev = document.createElement("span");
      chev.className = "ctx-item-shortcut";
      chev.textContent = "›";
      btn.appendChild(chev);
      btn.addEventListener("click", () => {
        const sub = item.submenu ?? [];
        this.openSubmenu(btn, sub, parentMenu);
      });
    } else if (item.onClick && !item.disabled) {
      btn.addEventListener("click", async () => {
        const cb = item.onClick;
        this.dismiss();
        if (cb) await cb();
      });
    }
    return btn;
  }
}

/// Standard tab/block accent palette. `null` = no color.
export const COLOR_SWATCHES: Array<{ color: string | null; title: string }> = [
  { color: null, title: "no color" },
  { color: "#f7768e", title: "red" },
  { color: "#ff9e64", title: "orange" },
  { color: "#e0af68", title: "yellow" },
  { color: "#c3e88d", title: "lime" },
  { color: "#9ece6a", title: "green" },
  { color: "#73daca", title: "teal" },
  { color: "#7dcfff", title: "cyan" },
  { color: "#7aa2f7", title: "blue" },
  { color: "#5c6bc0", title: "indigo" },
  { color: "#bb9af7", title: "purple" },
  { color: "#c678dd", title: "magenta" },
  { color: "#ff79c6", title: "pink" },
  { color: "#565f89", title: "slate" },
];

/// Soft pastel variants of the standard palette, rendered as a second row.
export const COLOR_SWATCHES_PASTEL: Array<{ color: string; title: string }> = [
  { color: "#ffb3ba", title: "red pastel" },
  { color: "#ffd1a4", title: "orange pastel" },
  { color: "#ffe9b3", title: "yellow pastel" },
  { color: "#e4f5c1", title: "lime pastel" },
  { color: "#c8e6a8", title: "green pastel" },
  { color: "#b3e6dc", title: "teal pastel" },
  { color: "#b9e3f5", title: "cyan pastel" },
  { color: "#b9c9f5", title: "blue pastel" },
  { color: "#b3b9e0", title: "indigo pastel" },
  { color: "#d8c7f5", title: "purple pastel" },
  { color: "#e4b9ee", title: "magenta pastel" },
  { color: "#ffc9e0", title: "pink pastel" },
  { color: "#aab0c2", title: "slate pastel" },
];
