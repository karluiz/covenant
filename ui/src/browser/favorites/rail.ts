// The favorites rail: a shared bookmarks tree mounted into the browser pane's grid
// column 4. Renders folders/links from the shared store, supports collapse, rename,
// delete, new-folder, and pointer-based drag to reorder / re-nest.
//
// DnD is pointer-based on purpose: HTML5 drag-and-drop is swallowed in the Tauri
// webview (see memory: html5-dnd-swallowed), so we replicate the tab-strip approach.

import type { FavNode } from "../../api";
import { ContextMenu } from "../../menu/context-menu";
import { attachTooltip } from "../../tooltip/tooltip";
import { faviconEl } from "./favicon";
import { favoritesStore } from "./store";

export interface RailOptions {
  /** Open a favorite URL — wired to the tab manager's new-browser-tab. */
  onOpen: (url: string) => void;
}

type DropZone = "before" | "after" | "inside";

const DRAG_THRESHOLD = 4;
const INDENT_BASE = 8;
const INDENT_STEP = 14;

export class FavoritesRail {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly menu: ContextMenu;
  private unsubscribe?: () => void;

  // Drag state.
  private dragId: string | null = null;
  private dragGhost: HTMLElement | null = null;
  private dropTarget: { id: string; zone: DropZone } | null = null;
  private pointerStart: { x: number; y: number } | null = null;
  private pendingDragId: string | null = null;

  constructor(private readonly opts: RailOptions) {
    this.el = document.createElement("div");
    this.el.className = "fav-rail";
    this.el.innerHTML = `
      <div class="fav-rail-header">
        <span class="fav-rail-title">Favorites</span>
        <button class="fav-rail-add" type="button" aria-label="New folder">+</button>
      </div>
      <div class="fav-rail-body"></div>`;
    this.body = this.el.querySelector(".fav-rail-body") as HTMLElement;
    this.menu = new ContextMenu(this.el);

    const addBtn = this.el.querySelector(".fav-rail-add") as HTMLButtonElement;
    attachTooltip(addBtn, "New folder");
    addBtn.addEventListener("click", () => void this.promptNewFolder(null));

    // Right-click empty space → new folder at root.
    this.body.addEventListener("contextmenu", (e) => {
      if (e.target === this.body) {
        e.preventDefault();
        this.menu.show(e.clientX, e.clientY, [
          { label: "New folder", onClick: () => this.promptNewFolder(null) },
        ]);
      }
    });
  }

  mount(): void {
    this.unsubscribe = favoritesStore.subscribe(() => this.render());
  }

  destroy(): void {
    this.unsubscribe?.();
    this.menu.dismiss?.();
    this.removeGhost();
  }

  private render(): void {
    const open = this.body.scrollTop;
    this.body.replaceChildren();
    const tree = favoritesStore.tree;
    if (tree.length === 0) {
      const empty = document.createElement("div");
      empty.className = "fav-empty";
      empty.textContent = "Star a page to add it here.";
      this.body.appendChild(empty);
      return;
    }
    for (const node of tree) this.renderNode(node, 0);
    this.body.scrollTop = open;
  }

  private renderNode(node: FavNode, depth: number): void {
    const row = document.createElement("div");
    row.className = `fav-row fav-${node.kind}`;
    row.dataset.id = node.id;
    row.dataset.kind = node.kind;
    row.style.paddingLeft = `${INDENT_BASE + depth * INDENT_STEP}px`;

    if (node.kind === "folder") {
      const chevron = document.createElement("span");
      chevron.className = "fav-chevron";
      chevron.textContent = node.collapsed ? "▸" : "▾";
      chevron.addEventListener("click", (e) => {
        e.stopPropagation();
        void favoritesStore.setCollapsed(node.id, !node.collapsed);
      });
      row.appendChild(chevron);

      const icon = document.createElement("span");
      icon.className = "fav-folder-icon";
      icon.textContent = "▤";
      row.appendChild(icon);
    } else {
      row.appendChild(faviconEl(node.url ?? "", node.title));
    }

    const label = document.createElement("span");
    label.className = "fav-label";
    label.textContent = node.title;
    row.appendChild(label);

    if (node.kind === "link" && node.url) attachTooltip(row, { title: node.title, subtitle: node.url });

    row.addEventListener("click", () => {
      if (node.kind === "folder") void favoritesStore.setCollapsed(node.id, !node.collapsed);
      else if (node.url) this.opts.onOpen(node.url);
    });
    row.addEventListener("contextmenu", (e) => this.showRowMenu(e, node));
    row.addEventListener("pointerdown", (e) => this.onPointerDown(e, node));

    this.body.appendChild(row);

    if (node.kind === "folder" && !node.collapsed) {
      for (const child of node.children) this.renderNode(child, depth + 1);
    }
  }

  // --- Context menu ---------------------------------------------------------

  private showRowMenu(e: MouseEvent, node: FavNode): void {
    e.preventDefault();
    e.stopPropagation();
    const items = [];
    if (node.kind === "link" && node.url) {
      const url = node.url;
      items.push({ label: "Open", onClick: () => this.opts.onOpen(url) });
    } else {
      items.push({ label: "New folder inside", onClick: () => this.promptNewFolder(node.id) });
    }
    items.push({ label: "Rename", onClick: () => this.startRename(node) });
    items.push({ divider: true });
    items.push({ label: "Delete", danger: true, onClick: () => void favoritesStore.remove(node.id) });
    this.menu.show(e.clientX, e.clientY, items);
  }

  private async promptNewFolder(parentId: string | null): Promise<void> {
    await favoritesStore.addFolder(parentId, "New folder");
    // Rename inline once the row exists.
    requestAnimationFrame(() => {
      const rows = Array.from(this.body.querySelectorAll<HTMLElement>('.fav-folder'));
      const last = rows[rows.length - 1];
      const id = last?.dataset.id;
      if (id) {
        const node = favoritesStore.find(id);
        if (node) this.startRename(node);
      }
    });
  }

  private startRename(node: FavNode): void {
    const row = this.body.querySelector<HTMLElement>(`[data-id="${node.id}"]`);
    const label = row?.querySelector<HTMLElement>(".fav-label");
    if (!row || !label) return;
    const input = document.createElement("input");
    input.className = "fav-rename-input";
    input.value = node.title;
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (save: boolean) => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (save && next && next !== node.title) void favoritesStore.rename(node.id, next);
      else this.render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit(true);
      else if (e.key === "Escape") commit(false);
    });
    input.addEventListener("blur", () => commit(true));
  }

  // --- Drag and drop (pointer-based) ---------------------------------------

  private onPointerDown(e: PointerEvent, node: FavNode): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.classList.contains("fav-chevron") || target.tagName === "INPUT") return;
    this.pendingDragId = node.id;
    this.pointerStart = { x: e.clientX, y: e.clientY };
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.pointerStart) return;
    if (!this.dragId) {
      const dx = e.clientX - this.pointerStart.x;
      const dy = e.clientY - this.pointerStart.y;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      this.beginDrag(e);
    }
    this.updateDrop(e);
  };

  private beginDrag(e: PointerEvent): void {
    this.dragId = this.pendingDragId;
    const node = this.dragId ? favoritesStore.find(this.dragId) : null;
    const ghost = document.createElement("div");
    ghost.className = "fav-drag-ghost";
    ghost.textContent = node?.title ?? "";
    document.body.appendChild(ghost);
    this.dragGhost = ghost;
    this.moveGhost(e);
    this.body.classList.add("fav-dragging");
  }

  private updateDrop(e: PointerEvent): void {
    this.moveGhost(e);
    this.clearDropMarkers();
    const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const row = el?.closest<HTMLElement>(".fav-row");
    if (!row || !this.body.contains(row)) {
      this.dropTarget = null;
      return;
    }
    const id = row.dataset.id!;
    if (id === this.dragId) {
      this.dropTarget = null;
      return;
    }
    const rect = row.getBoundingClientRect();
    const rel = (e.clientY - rect.top) / rect.height;
    const isFolder = row.dataset.kind === "folder";
    let zone: DropZone;
    if (isFolder) zone = rel < 0.3 ? "before" : rel > 0.7 ? "after" : "inside";
    else zone = rel < 0.5 ? "before" : "after";
    this.dropTarget = { id, zone };
    row.classList.add(`fav-drop-${zone}`);
  }

  private onPointerUp = (): void => {
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    const drag = this.dragId;
    const drop = this.dropTarget;
    this.removeGhost();
    this.clearDropMarkers();
    this.body.classList.remove("fav-dragging");
    this.dragId = null;
    this.pendingDragId = null;
    this.pointerStart = null;
    this.dropTarget = null;
    if (drag && drop) void this.applyDrop(drag, drop);
  };

  private async applyDrop(dragId: string, drop: { id: string; zone: DropZone }): Promise<void> {
    const target = favoritesStore.find(drop.id);
    if (!target) return;
    let newParent: string | null;
    let afterId: string | null = null;
    let beforeId: string | null = null;

    if (drop.zone === "inside") {
      newParent = target.id;
      const kids = favoritesStore.childrenOf(target.id).filter((n) => n.id !== dragId);
      afterId = kids[kids.length - 1]?.id ?? null;
    } else {
      newParent = target.parent_id;
      const sibs = favoritesStore.childrenOf(newParent).filter((n) => n.id !== dragId);
      const idx = sibs.findIndex((n) => n.id === target.id);
      if (drop.zone === "before") {
        beforeId = target.id;
        afterId = sibs[idx - 1]?.id ?? null;
      } else {
        afterId = target.id;
        beforeId = sibs[idx + 1]?.id ?? null;
      }
    }
    // Backend rejects moving a node into its own subtree; swallow and resync.
    try {
      await favoritesStore.move(dragId, newParent, afterId, beforeId);
    } catch {
      await favoritesStore.load();
    }
  }

  private moveGhost(e: PointerEvent): void {
    if (this.dragGhost) {
      this.dragGhost.style.left = `${e.clientX + 12}px`;
      this.dragGhost.style.top = `${e.clientY + 12}px`;
    }
  }

  private removeGhost(): void {
    this.dragGhost?.remove();
    this.dragGhost = null;
  }

  private clearDropMarkers(): void {
    for (const r of this.body.querySelectorAll(".fav-drop-before, .fav-drop-after, .fav-drop-inside")) {
      r.classList.remove("fav-drop-before", "fav-drop-after", "fav-drop-inside");
    }
  }
}
