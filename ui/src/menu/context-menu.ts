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
  danger?: boolean;
  disabled?: boolean;
  /// Optional keyboard-shortcut hint shown right-aligned (e.g. "⌘T").
  shortcut?: string;
}

export class ContextMenu {
  private el: HTMLElement | null = null;
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(private readonly host: HTMLElement) {}

  show(x: number, y: number, items: MenuItem[]): void {
    this.dismiss();
    if (items.length === 0) return;

    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    for (const item of items) menu.appendChild(this.renderItem(item));

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    this.host.appendChild(menu);

    // Clamp inside viewport.
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 4) {
      menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    }
    if (rect.bottom > window.innerHeight - 4) {
      menu.style.top = `${window.innerHeight - rect.height - 8}px`;
    }

    this.el = menu;

    // Defer outside-click registration so the originating right-click
    // doesn't dismiss us immediately.
    setTimeout(() => {
      const handler = (e: MouseEvent): void => {
        if (this.el && !this.el.contains(e.target as Node)) {
          this.dismiss();
        }
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

  private renderItem(item: MenuItem): HTMLElement {
    if (item.divider) {
      const d = document.createElement("div");
      d.className = "ctx-divider";
      return d;
    }

    if (item.swatches) {
      const row = document.createElement("div");
      row.className = "ctx-swatch-row";
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

    if (item.onClick && !item.disabled) {
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
