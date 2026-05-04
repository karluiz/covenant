import {
  getConvergenceSnapshot,
  submitConvergenceReply,
  type ConvergenceTileState,
} from "../api";
import { renderTile, updateTile } from "./tile";

export interface TabMeta {
  sessionId: string;
  title: string;
  color: string | null;
  operatorAvatar: string | null;
  operatorName: string | null;
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
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private tiles = new Map<string, HTMLElement>();

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
    if (this.escHandler !== null) {
      document.removeEventListener("keydown", this.escHandler, { capture: true });
      this.escHandler = null;
    }
    this.root?.remove();
    this.root = null;
    this.grid = null;
    this.empty = null;
    this.tiles.clear();
  }

  private mount(): void {
    const root = document.createElement("div");
    root.className = "convergence-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Convergence Mode");

    const header = document.createElement("div");
    header.className = "convergence-overlay__header";

    const title = document.createElement("h1");
    title.className = "convergence-overlay__title";
    title.textContent = "CONVERGENCE";

    const exit = document.createElement("button");
    exit.type = "button";
    exit.className = "modal-cancel-btn";
    exit.title = "Close (Esc)";
    exit.innerHTML = `<span>Exit</span><kbd class="modal-kbd">Esc</kbd>`;
    exit.addEventListener("click", () => this.close());

    header.append(title, exit);

    const grid = document.createElement("div");
    grid.className = "convergence-overlay__grid";
    grid.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      // Skip if the click landed inside a tile's reply form.
      if (target.closest(".convergence-tile__reply")) return;
      const tile = target.closest<HTMLElement>(".convergence-tile");
      if (!tile?.dataset.sessionId) return;
      const ok = this.bridge.activateBySessionId(tile.dataset.sessionId);
      if (ok) this.close();
    });
    grid.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const target = e.target as HTMLElement;
      if (target.closest(".convergence-tile__reply")) return;
      const tile = target.closest<HTMLElement>(".convergence-tile");
      if (!tile?.dataset.sessionId) return;
      e.preventDefault();
      const ok = this.bridge.activateBySessionId(tile.dataset.sessionId);
      if (ok) this.close();
    });

    const empty = document.createElement("div");
    empty.className = "convergence-overlay__empty";
    empty.textContent = "No sessions";
    empty.hidden = true;

    root.append(header, grid, empty);
    document.body.append(root);
    this.root = root;
    this.grid = grid;
    this.empty = empty;

    // Two-step Esc on reply form: first Esc blurs the focused input/select,
    // second Esc (when nothing in reply is focused) closes the overlay.
    this.escHandler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".convergence-tile__reply")) {
        e.preventDefault();
        e.stopPropagation();
        active.blur();
        return;
      }
    };
    document.addEventListener("keydown", this.escHandler, { capture: true });
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
    const ordered: { state: ConvergenceTileState; tab: TabMeta }[] = [];
    for (const t of tabs) {
      const tile = snap.tiles.find((x) => x.session_id === t.sessionId);
      if (!tile) continue;
      ordered.push({
        state: { ...tile, title: t.title, color: t.color },
        tab: t,
      });
    }

    if (ordered.length === 0) {
      this.grid.replaceChildren();
      this.tiles.clear();
      this.empty.hidden = false;
      return;
    }
    this.empty.hidden = true;
    const submit = this.submitReply.bind(this);

    // Build/update tiles, tracking which session ids are still present.
    const present = new Set<string>();
    for (const { state, tab } of ordered) {
      present.add(state.session_id);
      let el = this.tiles.get(state.session_id);
      if (el && el.parentNode === this.grid) {
        updateTile(el, state, tab, submit);
      } else {
        el = renderTile(state, tab, submit);
        this.tiles.set(state.session_id, el);
        this.grid.append(el);
      }
    }

    // Drop tiles whose session vanished.
    for (const [id, el] of this.tiles) {
      if (!present.has(id)) {
        el.remove();
        this.tiles.delete(id);
      }
    }

    // Reorder only if the current DOM order differs from the desired order.
    // Avoids touching the DOM on the common steady-state tick.
    const children = this.grid.children;
    let needsReorder = children.length !== ordered.length;
    if (!needsReorder) {
      for (let i = 0; i < ordered.length; i++) {
        if (children[i] !== this.tiles.get(ordered[i].state.session_id)) {
          needsReorder = true;
          break;
        }
      }
    }
    if (needsReorder) {
      for (const { state } of ordered) {
        const el = this.tiles.get(state.session_id);
        if (el) this.grid.append(el);
      }
    }
  }

  /**
   * Forwards the resolution to the backend's operator resolution
   * channel. Tile UX (clear + blur) is handled in the tile's submit
   * handler; on error we log only — toasts arrive in a later task.
   */
  async submitReply(
    sessionId: string,
    text: string,
    scope: "one-shot" | "mission" | "global",
  ): Promise<void> {
    try {
      await submitConvergenceReply(sessionId, text, scope);
    } catch (err) {
      console.warn("[convergence] submitReply failed", err);
    }
  }
}
