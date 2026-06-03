// Singleton client mirror of the favorites tree. All browser tabs share one instance,
// so a mutation in one rail re-renders every mounted rail. Mutations round-trip through
// the backend and reload the full tree (it's small) to stay authoritative.

import { favorites, type FavNode } from "../../api";

type Listener = () => void;

class FavoritesStore {
  private nodes: FavNode[] = [];
  private listeners = new Set<Listener>();
  private loaded = false;
  private loading: Promise<void> | null = null;

  get tree(): FavNode[] {
    return this.nodes;
  }

  /** Subscribe to tree changes. Triggers an initial load on first subscriber. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    if (!this.loaded) void this.load();
    else fn();
    return () => {
      this.listeners.delete(fn);
    };
  }

  async load(): Promise<void> {
    // Coalesce concurrent loads (multiple rails mounting at once).
    if (this.loading) return this.loading;
    this.loading = (async () => {
      this.nodes = await favorites.tree();
      this.loaded = true;
      this.loading = null;
      this.emit();
    })();
    return this.loading;
  }

  async addLink(parentId: string | null, title: string, url: string): Promise<void> {
    await favorites.add(parentId, "link", title, url);
    await this.reload();
  }

  async addFolder(parentId: string | null, title: string): Promise<void> {
    await favorites.add(parentId, "folder", title, null);
    await this.reload();
  }

  async rename(id: string, title: string): Promise<void> {
    await favorites.rename(id, title);
    await this.reload();
  }

  async remove(id: string): Promise<void> {
    await favorites.delete(id);
    await this.reload();
  }

  async move(
    id: string,
    newParentId: string | null,
    afterId: string | null,
    beforeId: string | null,
  ): Promise<void> {
    await favorites.move(id, newParentId, afterId, beforeId);
    await this.reload();
  }

  async setCollapsed(id: string, collapsed: boolean): Promise<void> {
    await favorites.setCollapsed(id, collapsed);
    await this.reload();
  }

  /** Ordered children of a parent (`null` = root). */
  childrenOf(parentId: string | null): FavNode[] {
    if (parentId === null) return this.nodes;
    return this.find(parentId)?.children ?? [];
  }

  find(id: string): FavNode | null {
    const walk = (list: FavNode[]): FavNode | null => {
      for (const n of list) {
        if (n.id === id) return n;
        const hit = walk(n.children);
        if (hit) return hit;
      }
      return null;
    };
    return walk(this.nodes);
  }

  private async reload(): Promise<void> {
    this.loading = null;
    await this.load();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export const favoritesStore = new FavoritesStore();
