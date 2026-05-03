import { getConvergenceSnapshot, type ConvergenceTileState } from "../api";
import { renderTile } from "./tile";

export interface TabMeta {
  sessionId: string;
  title: string;
  color: string | null;
}

export interface ConvergenceTabBridge {
  /** Tab order (left→right). Used as the tile sort order. */
  listTabs(): TabMeta[];
  /** Focus the tab whose session matches; returns true on success. */
  activateBySessionId(sessionId: string): boolean;
}

const POLL_MS = 1000;

export class ConvergenceOverlay {
  private root: HTMLElement | null = null;
  private grid: HTMLElement | null = null;
  private empty: HTMLElement | null = null;
  private pollHandle: number | null = null;
  private visible = false;

  constructor(private bridge: ConvergenceTabBridge) {}

  isVisible(): boolean {
    return this.visible;
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }

  open(): void {
    if (this.visible) return;
    this.mount();
    this.visible = true;
    void this.refresh();
    this.pollHandle = window.setInterval(() => void this.refresh(), POLL_MS);
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    if (this.pollHandle !== null) {
      window.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.root?.remove();
    this.root = null;
    this.grid = null;
    this.empty = null;
  }

  private mount(): void {
    const root = document.createElement("div");
    root.className = "convergence-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Convergence Mode");

    const exit = document.createElement("button");
    exit.type = "button";
    exit.className = "convergence-overlay__exit";
    exit.textContent = "Exit";
    exit.addEventListener("click", () => this.close());

    const grid = document.createElement("div");
    grid.className = "convergence-overlay__grid";
    grid.addEventListener("click", (e) => {
      const tile = (e.target as HTMLElement).closest<HTMLElement>(".convergence-tile");
      if (!tile?.dataset.sessionId) return;
      const ok = this.bridge.activateBySessionId(tile.dataset.sessionId);
      if (ok) this.close();
    });

    const empty = document.createElement("div");
    empty.className = "convergence-overlay__empty";
    empty.textContent = "No sessions";
    empty.hidden = true;

    root.append(exit, grid, empty);
    document.body.append(root);
    this.root = root;
    this.grid = grid;
    this.empty = empty;
  }

  private async refresh(): Promise<void> {
    if (!this.visible || !this.grid || !this.empty) return;
    let snap;
    try {
      snap = await getConvergenceSnapshot();
    } catch (err) {
      console.warn("convergence snapshot failed", err);
      return;
    }
    const tabs = this.bridge.listTabs();

    // Order = tab order. Drop tiles whose session no longer has a tab.
    const ordered: ConvergenceTileState[] = [];
    for (const t of tabs) {
      const tile = snap.tiles.find((x) => x.session_id === t.sessionId);
      if (!tile) continue;
      ordered.push({ ...tile, title: t.title, color: t.color });
    }

    if (ordered.length === 0) {
      this.grid.replaceChildren();
      this.empty.hidden = false;
      return;
    }
    this.empty.hidden = true;
    const frag = document.createDocumentFragment();
    for (const t of ordered) frag.append(renderTile(t));
    this.grid.replaceChildren(frag);
  }
}
