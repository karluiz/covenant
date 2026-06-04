// Collapsed sidebar rail (variant 6).
//
// Active only in vertical-tabbar mode (`body.tabbar-left`) when the
// user has folded the sidebar (`body.tabbar-left-collapsed`). Visibility
// is governed entirely by CSS — this component always builds its DOM
// from the TabManager snapshot; the rail is hidden in any other mode.
//
// Layout: one column, top to bottom in `tabs[]` display order.
//   • Group → vertical color stripe (the group color) + a stack of
//     small "cells", one per member tab. Active cell glows.
//   • Ungrouped tab → a single cell using the tab's own color (or a
//     neutral default when no color is set).
//   • Hover on a group / cell → a small peek panel slides in to the
//     right with the group/tab name (and member list for groups).
// Click on cell → select that tab. Click on group stripe → activate
// the first tab of that group. Either way the rail leaves the sidebar
// collapsed; the user expands manually with the chevron.

import type {
  RailSnapshot,
  RailGroupView,
  RailTabView,
} from "./manager";

const NEUTRAL_COLOR = "rgba(255,255,255,0.35)";

export interface CollapsedRailDeps {
  /// Snapshot accessor — called on every rebuild.
  snapshot: () => RailSnapshot;
  /// Activate a tab by id (delegates to TabManager.activate).
  selectTab: (tabId: string) => void;
  /// Subscribe to renders. The component sets this once at construction
  /// and the manager invokes it after each `renderTabbar()`.
  setOnAfterRender: (cb: (() => void) | null) => void;
}

export class CollapsedRail {
  private readonly host: HTMLElement;
  private readonly deps: CollapsedRailDeps;

  constructor(host: HTMLElement, deps: CollapsedRailDeps) {
    this.host = host;
    this.deps = deps;
    this.host.classList.add("tabbar-rail");
    this.deps.setOnAfterRender(() => this.render());
    this.render();
  }

  destroy(): void {
    this.deps.setOnAfterRender(null);
    this.host.innerHTML = "";
  }

  private render(): void {
    const snap = this.deps.snapshot();
    this.host.innerHTML = "";
    for (const item of snap.items) {
      if (item.kind === "group") {
        this.host.appendChild(this.renderGroup(item.group));
      } else {
        this.host.appendChild(this.renderLooseTab(item.tab));
      }
    }
  }

  private renderGroup(group: RailGroupView): HTMLElement {
    const color = group.color ?? NEUTRAL_COLOR;
    const wrap = document.createElement("div");
    wrap.className = "tabbar-rail-group";
    wrap.style.setProperty("--rail-color", color);

    const stripe = document.createElement("div");
    stripe.className = "tabbar-rail-stripe";
    wrap.appendChild(stripe);

    const cells = document.createElement("div");
    cells.className = "tabbar-rail-cells";
    for (const t of group.tabs) {
      cells.appendChild(this.renderCell(t, color));
    }
    wrap.appendChild(cells);

    wrap.appendChild(this.renderPeek(group.name, group.tabs, color));

    // Click on stripe (background) → select first tab in group.
    wrap.addEventListener("click", (e) => {
      // Cells handle their own clicks; only fire when the click hit
      // the stripe / wrap padding.
      if (e.target instanceof HTMLElement && e.target.closest(".tabbar-rail-cell")) {
        return;
      }
      if (group.tabs.length > 0) this.deps.selectTab(group.tabs[0].id);
    });

    return wrap;
  }

  private renderLooseTab(tab: RailTabView): HTMLElement {
    const color = tab.color ?? NEUTRAL_COLOR;
    const wrap = document.createElement("div");
    wrap.className = "tabbar-rail-loose";
    wrap.style.setProperty("--rail-color", color);
    // No group-level peek for ungrouped tabs — the per-cell peek
    // already surfaces the tab name on hover and a second bubble
    // would just stack on top of it.
    wrap.appendChild(this.renderCell(tab, color));
    return wrap;
  }

  private renderCell(tab: RailTabView, color: string): HTMLElement {
    // Wrap so the per-tab peek can be a sibling of the button —
    // gives us a clean `:hover` selector and avoids the native
    // `title` tooltip racing with the custom one.
    const wrap = document.createElement("div");
    wrap.className = "tabbar-rail-cell-wrap";

    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "tabbar-rail-cell";
    if (tab.active) cell.classList.add("active");
    // Browser tabs aren't shells — flag them so CSS can render a globe
    // glyph instead of the terminal-style cell, and so they don't read
    // as a terminal session in the rail.
    if (tab.kind === "browser") cell.classList.add("tabbar-rail-cell-browser");
    cell.style.setProperty("--rail-color", color);
    cell.setAttribute("aria-label", tab.name);
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deps.selectTab(tab.id);
    });

    const peek = document.createElement("div");
    peek.className = "tabbar-rail-cell-peek";
    peek.style.setProperty("--rail-color", color);
    peek.textContent = tab.name;

    wrap.appendChild(cell);
    wrap.appendChild(peek);
    return wrap;
  }

  private renderPeek(
    title: string,
    tabs: RailTabView[],
    color: string,
  ): HTMLElement {
    const peek = document.createElement("div");
    peek.className = "tabbar-rail-peek";
    peek.style.setProperty("--rail-color", color);

    const name = document.createElement("div");
    name.className = "tabbar-rail-peek-name";
    name.textContent = title;
    peek.appendChild(name);

    if (tabs.length > 1) {
      const list = document.createElement("ul");
      list.className = "tabbar-rail-peek-list";
      for (const t of tabs) {
        const li = document.createElement("li");
        li.textContent = t.name;
        if (t.active) li.classList.add("active");
        list.appendChild(li);
      }
      peek.appendChild(list);
    }
    return peek;
  }
}
