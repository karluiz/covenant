import {
  getConvergenceSnapshot,
  setOperatorEnabled,
  submitConvergenceReply,
  type ConvergenceSnapshot,
} from "../api";
import type { SessionId } from "../api";
import { Icons } from "../icons";
import { formatChord } from "../platform";
import { escalationIndex, sortAgents } from "./model";
import { renderAgentCard, type ReplyScope } from "./tile";

export interface TabMeta {
  sessionId: string;
  title: string;
  color: string | null;
}

export interface ConvergenceTabBridge {
  listTabs(): TabMeta[];
  activateBySessionId(sessionId: string, opts?: { keepOverlayOpen?: boolean }): boolean;
}

type Filter = "all" | "needs you" | "working" | "idle";
const POLL_MS = 1000;

export class ConvergenceOverlay {
  private root: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private empty: HTMLElement | null = null;
  private reconnectEl: HTMLElement | null = null;
  private pollHandle: number | null = null;
  private visible = false;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private snap: ConvergenceSnapshot | null = null; // last-good
  private filter: Filter = "all";
  private activeSessionId: string | null = null;

  constructor(private bridge: ConvergenceTabBridge) {}

  isVisible(): boolean { return this.visible; }
  toggle(): void { if (this.visible) this.close(); else this.open(); }

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
    if (this.pollHandle !== null) { window.clearInterval(this.pollHandle); this.pollHandle = null; }
    if (this.escHandler !== null) {
      document.removeEventListener("keydown", this.escHandler, { capture: true });
      this.escHandler = null;
    }
    this.root?.remove();
    this.root = this.gridEl = this.summaryEl = this.empty = this.reconnectEl = null;
    this.snap = null;
    this.filter = "all";
    this.activeSessionId = null;
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
    exit.className = "release-close";
    exit.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    exit.setAttribute("aria-label", "Exit Convergence Mode");
    exit.addEventListener("click", () => this.close());
    header.append(title, exit);

    const strip = document.createElement("div");
    strip.className = "mc-strip";
    const summary = document.createElement("div");
    summary.className = "mc-strip__summary";
    const reconnect = document.createElement("span");
    reconnect.className = "mc-reconnecting";
    reconnect.textContent = "reconnecting…";
    reconnect.hidden = true;
    const filters = document.createElement("div");
    filters.className = "mc-strip__filters";
    for (const f of ["all", "needs you", "working", "idle"] as const) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "mc-fchip" + (this.filter === f ? " mc-fchip--on" : "");
      chip.textContent = f;
      chip.dataset.filter = f;
      chip.addEventListener("click", () => { this.filter = f; this.render(); });
      filters.append(chip);
    }
    strip.append(summary, reconnect, filters);

    const grid = document.createElement("div");
    grid.className = "mc-grid";

    const empty = document.createElement("div");
    empty.className = "convergence-overlay__empty";
    empty.hidden = true;
    empty.innerHTML = `
      <div class="convergence-overlay__empty-icon">${Icons.link2({ size: 56 })}</div>
      <div class="convergence-overlay__empty-title">No agents running</div>
      <div class="convergence-overlay__empty-body">
        Convergence shows every agent across your tabs.<br/>
        Run an executor in any terminal (claude, codex, …) or open an ACP chat — it appears here automatically.
      </div>
      <kbd class="convergence-overlay__empty-hint">${formatChord(["mod", "shift", "M"])} to toggle convergence</kbd>`;

    root.append(header, strip, grid, empty);
    document.body.append(root);

    this.root = root;
    this.gridEl = grid;
    this.summaryEl = summary;
    this.empty = empty;
    this.reconnectEl = reconnect;

    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest(".mc-reply")) { e.preventDefault(); e.stopPropagation(); active.blur(); return; }
        e.preventDefault(); e.stopPropagation(); this.close(); return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.tagName === "TEXTAREA" && (active as HTMLTextAreaElement).value.length > 0) return;
        e.preventDefault();
        this.moveActive(e.key === "ArrowDown" ? 1 : -1);
      }
      if (e.key === "Enter" && this.activeSessionId) {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest(".mc-reply") || active?.closest("button, input, select, textarea")) return;
        this.bridge.activateBySessionId(this.activeSessionId);
        this.close();
      }
    };
    document.addEventListener("keydown", this.escHandler, { capture: true });
  }

  /// Test seam — drives one refresh and resolves when render is done.
  refreshForTest(): Promise<void> { return this.refresh(); }

  private async refresh(): Promise<void> {
    if (!this.visible) return;
    const tabs = this.bridge.listTabs().map((t) => ({
      session_id: t.sessionId, title: t.title, color: t.color,
    }));
    try {
      const next = await getConvergenceSnapshot(tabs);
      if (!this.visible) return; // close() raced during the await — discard
      this.snap = next;
      if (this.reconnectEl) this.reconnectEl.hidden = true;
    } catch (err) {
      console.warn("convergence snapshot failed", err);
      if (this.reconnectEl) this.reconnectEl.hidden = false;
      if (!this.snap) this.renderEmptyError();
      return;
    }
    this.render();
  }

  private visibleAgents() {
    if (!this.snap) return [];
    const sorted = sortAgents(this.snap.agents, this.snap.escalations);
    return sorted.filter((card) => {
      switch (this.filter) {
        case "all": return true;
        case "needs you": return card.status === "blocked";
        case "working": return card.status === "working";
        case "idle": return card.status === "idle";
      }
    });
  }

  private render(): void {
    if (!this.gridEl || !this.empty || !this.summaryEl || !this.snap) return;
    const agents = this.snap.agents;
    if (agents.length === 0) {
      this.gridEl.replaceChildren();
      this.gridEl.hidden = true;
      this.empty.hidden = false;
      this.summaryEl.textContent = "";
      return;
    }
    this.empty.hidden = true;
    this.gridEl.hidden = false;

    const needs = agents.filter((a) => a.status === "blocked").length;
    const working = agents.filter((a) => a.status === "working").length;
    const idle = agents.filter((a) => a.status === "idle").length;
    const cost = agents.reduce((acc, a) => acc + (a.cost_usd ?? 0), 0);
    this.summaryEl.innerHTML =
      `<b>${agents.length}</b> agents · ` +
      (needs ? `<b class="mc-strip__alert">${needs} needs you</b> · ` : "") +
      `${working} working · ${idle} idle` +
      (cost >= 0.005 ? ` · <b>$${cost.toFixed(2)}</b>` : "");

    this.root?.querySelectorAll<HTMLElement>(".mc-fchip").forEach((c) => {
      c.classList.toggle("mc-fchip--on", c.dataset.filter === this.filter);
    });

    const esc = escalationIndex(this.snap.escalations);
    const list = this.visibleAgents();
    if (!this.activeSessionId || !list.some((a) => a.session_id === this.activeSessionId)) {
      this.activeSessionId = list[0]?.session_id ?? null;
    }
    this.gridEl.replaceChildren();
    if (list.length === 0) {
      const none = document.createElement("div");
      none.className = "mc-grid__empty";
      none.innerHTML = `No agents match <code>${this.filter}</code>. <button type="button" class="mc-grid__reset">Show all</button>`;
      none.querySelector(".mc-grid__reset")?.addEventListener("click", () => { this.filter = "all"; this.render(); });
      this.gridEl.append(none);
      return;
    }
    for (const card of list) {
      const el = renderAgentCard(card, esc.get(card.session_id), {
        onFocus: (sid, keepOpen) => {
          const ok = this.bridge.activateBySessionId(sid, { keepOverlayOpen: keepOpen });
          if (ok && !keepOpen) this.close();
        },
        onSubmit: this.submitReply.bind(this),
        onStop: this.stopOperator.bind(this),
      });
      if (card.session_id === this.activeSessionId) el.classList.add("mc-card--active");
      this.gridEl.append(el);
    }
  }

  private renderEmptyError(): void {
    if (!this.gridEl || !this.empty || !this.summaryEl) return;
    this.empty.hidden = true;
    this.gridEl.hidden = false;
    this.summaryEl.textContent = "";
    this.gridEl.replaceChildren();
    const err = document.createElement("div");
    err.className = "mc-grid__empty";
    err.innerHTML = `Couldn't load agent status. <button type="button" class="mc-grid__reset">Retry</button>`;
    err.querySelector(".mc-grid__reset")?.addEventListener("click", () => void this.refresh());
    this.gridEl.append(err);
  }

  private moveActive(delta: number): void {
    const list = this.visibleAgents();
    if (list.length === 0) return;
    const idx = list.findIndex((a) => a.session_id === this.activeSessionId);
    const next = (idx === -1 ? 0 : idx + delta + list.length) % list.length;
    this.activeSessionId = list[next].session_id;
    this.render();
  }

  /// Disable the operator on this session. Fire-and-forget; the next 1s
  /// poll re-renders the card without its operator badge (the card stays —
  /// it's still an agent session).
  private stopOperator(sessionId: string): void {
    void setOperatorEnabled(sessionId as SessionId, false).catch((err) =>
      console.warn("[convergence] stopOperator failed", sessionId, err),
    );
    void this.refresh();
  }

  async submitReply(sessionId: string, text: string, scope: ReplyScope): Promise<void> {
    try {
      await submitConvergenceReply(sessionId, text, scope);
    } catch (err) {
      console.warn("[convergence] submitReply failed", err);
    }
  }
}
