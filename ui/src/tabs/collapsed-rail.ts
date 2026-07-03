// Collapsed sidebar rail.
//
// Renders one of four user-selectable styles (Settings → Appearance →
// Folded sidebar): "legacy" (the original variant-6 pills, documented
// below), "glyph" (monogram tiles + group badges), "labels" (truncated
// names) and "spine" (segmented bars). The active style is read off the
// body class set by applyFoldedRailStyle().
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
import { currentFoldedRailStyle } from "./custom-style";

const NEUTRAL_COLOR = "rgba(255,255,255,0.35)";

/// First two alphanumeric characters of a name — the tile/badge
/// monogram. Falls back to a middot for names with no usable chars
/// (emoji-only, whitespace). Case is left alone; CSS decides.
export function monogram(name: string): string {
  const chars = name.match(/[\p{L}\p{N}]/gu);
  if (!chars || chars.length === 0) return "·";
  return chars.slice(0, 2).join("");
}

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
  /// Bound once so destroy() can unhook the style-change listener.
  private readonly onStyleChange = (): void => this.render();

  constructor(host: HTMLElement, deps: CollapsedRailDeps) {
    this.host = host;
    this.deps = deps;
    this.host.classList.add("tabbar-rail");
    this.deps.setOnAfterRender(() => this.render());
    // applyFoldedRailStyle announces style flips (settings live-preview,
    // boot) — the DOM shape differs per style, so rebuild.
    window.addEventListener("covenant:folded-rail-style", this.onStyleChange);
    this.render();
  }

  destroy(): void {
    this.deps.setOnAfterRender(null);
    window.removeEventListener("covenant:folded-rail-style", this.onStyleChange);
    this.host.innerHTML = "";
  }

  private render(): void {
    const snap = this.deps.snapshot();
    const style = currentFoldedRailStyle();
    this.host.innerHTML = "";
    for (const item of snap.items) {
      if (item.kind === "group") {
        this.host.appendChild(
          style === "glyph"
            ? this.renderGlyphGroup(item.group)
            : style === "labels"
              ? this.renderLabelsGroup(item.group)
              : style === "spine"
                ? this.renderSpineGroup(item.group)
                : this.renderGroup(item.group),
        );
      } else {
        this.host.appendChild(
          style === "glyph"
            ? this.renderGlyphLoose(item.tab)
            : style === "labels"
              ? this.renderLabelsLoose(item.tab)
              : style === "spine"
                ? this.renderSpineLoose(item.tab)
                : this.renderLooseTab(item.tab),
        );
      }
    }
  }

  // ─── Shared bits ──────────────────────────────────────

  /// Wraps an interactive element with the hover peek bubble the legacy
  /// rail already ships (`.tabbar-rail-cell-wrap` positioning + delayed
  /// `.tabbar-rail-cell-peek`) — every style reuses it for tab names.
  private wrapWithPeek(
    inner: HTMLElement,
    label: string,
    color: string,
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "tabbar-rail-cell-wrap";
    const peek = document.createElement("div");
    peek.className = "tabbar-rail-cell-peek";
    peek.style.setProperty("--rail-color", color);
    peek.textContent = label;
    wrap.appendChild(inner);
    wrap.appendChild(peek);
    return wrap;
  }

  private tabButton(tab: RailTabView, cls: string, color: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cls;
    if (tab.active) btn.classList.add("active");
    btn.style.setProperty("--rail-color", color);
    btn.setAttribute("aria-label", tab.name);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deps.selectTab(tab.id);
    });
    return btn;
  }

  /// Group header (badge / head / mono) — clicking activates the first
  /// tab of the group, same contract as the legacy stripe.
  private groupButton(group: RailGroupView, cls: string, color: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = cls;
    btn.style.setProperty("--rail-color", color);
    btn.setAttribute("aria-label", group.name);
    btn.addEventListener("click", () => {
      if (group.tabs.length > 0) this.deps.selectTab(group.tabs[0].id);
    });
    return btn;
  }

  // ─── Glyph rail (monogram tiles + group badge) ────────

  private renderGlyphGroup(group: RailGroupView): HTMLElement {
    const color = group.color ?? NEUTRAL_COLOR;
    const wrap = document.createElement("div");
    wrap.className = "tabbar-rail-glyph-group";
    wrap.style.setProperty("--rail-color", color);

    const badge = this.groupButton(group, "tabbar-rail-glyph-badge", color);
    badge.textContent = monogram(group.name);
    wrap.appendChild(this.wrapWithPeek(badge, group.name, color));

    for (const t of group.tabs) {
      wrap.appendChild(this.renderGlyphTile(t, color));
    }
    return wrap;
  }

  private renderGlyphLoose(tab: RailTabView): HTMLElement {
    return this.renderGlyphTile(tab, tab.color ?? NEUTRAL_COLOR);
  }

  private renderGlyphTile(tab: RailTabView, color: string): HTMLElement {
    const tile = this.tabButton(tab, "tabbar-rail-glyph-tile", color);
    if (tab.kind === "browser") {
      tile.classList.add("tabbar-rail-glyph-browser");
      tile.textContent = "🌐";
    } else if (tab.kind === "acp") {
      tile.classList.add("tabbar-rail-glyph-acp");
      tile.textContent = "⧉";
    } else {
      tile.textContent = monogram(tab.name);
    }
    return this.wrapWithPeek(tile, tab.name, color);
  }

  // ─── Labels rail (truncated names under group heads) ──

  private renderLabelsGroup(group: RailGroupView): HTMLElement {
    const color = group.color ?? NEUTRAL_COLOR;
    const wrap = document.createElement("div");
    wrap.className = "tabbar-rail-labels-group";
    wrap.style.setProperty("--rail-color", color);

    const head = this.groupButton(group, "tabbar-rail-labels-head", color);
    head.textContent = group.name;
    wrap.appendChild(head);

    for (const t of group.tabs) {
      wrap.appendChild(this.renderLabelsRow(t, color));
    }
    return wrap;
  }

  private renderLabelsLoose(tab: RailTabView): HTMLElement {
    const color = tab.color ?? NEUTRAL_COLOR;
    const wrap = document.createElement("div");
    wrap.className = "tabbar-rail-labels-group";
    wrap.style.setProperty("--rail-color", color);
    wrap.appendChild(this.renderLabelsRow(tab, color));
    return wrap;
  }

  private renderLabelsRow(tab: RailTabView, color: string): HTMLElement {
    const row = this.tabButton(tab, "tabbar-rail-labels-row", color);
    row.textContent =
      tab.kind === "browser" ? `🌐 ${tab.name}` : tab.kind === "acp" ? `⧉ ${tab.name}` : tab.name;
    return this.wrapWithPeek(row, tab.name, color);
  }

  // ─── Spine rail (segmented bar per group) ─────────────

  private renderSpineGroup(group: RailGroupView): HTMLElement {
    const color = group.color ?? NEUTRAL_COLOR;
    const wrap = document.createElement("div");
    wrap.className = "tabbar-rail-spine-group";
    wrap.style.setProperty("--rail-color", color);

    const mono = this.groupButton(group, "tabbar-rail-spine-mono", color);
    mono.textContent = monogram(group.name);
    wrap.appendChild(this.wrapWithPeek(mono, group.name, color));

    const bar = document.createElement("div");
    bar.className = "tabbar-rail-spine-bar";
    for (const t of group.tabs) {
      bar.appendChild(
        this.wrapWithPeek(
          this.tabButton(t, "tabbar-rail-spine-seg", color),
          t.name,
          color,
        ),
      );
    }
    wrap.appendChild(bar);
    return wrap;
  }

  private renderSpineLoose(tab: RailTabView): HTMLElement {
    const color = tab.color ?? NEUTRAL_COLOR;
    const wrap = document.createElement("div");
    wrap.className = "tabbar-rail-spine-group";
    wrap.style.setProperty("--rail-color", color);

    const mono = document.createElement("div");
    mono.className = "tabbar-rail-spine-mono";
    mono.textContent = tab.kind === "browser" ? "🌐" : tab.kind === "acp" ? "⧉" : "·";
    wrap.appendChild(mono);

    const bar = document.createElement("div");
    bar.className = "tabbar-rail-spine-bar";
    bar.appendChild(
      this.wrapWithPeek(
        this.tabButton(tab, "tabbar-rail-spine-seg", color),
        tab.name,
        color,
      ),
    );
    wrap.appendChild(bar);
    return wrap;
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
    // ACP tabs aren't shells either — flag them so CSS can render a
    // distinct marker instead of the terminal-style cell.
    if (tab.kind === "acp") cell.classList.add("tabbar-rail-cell-acp");
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
