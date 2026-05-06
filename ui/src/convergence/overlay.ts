import {
  getConvergenceSnapshot,
  submitConvergenceReply,
  type ConvergenceSnapshot,
} from "../api";
import { Icons } from "../icons";
import { renderInboxCard, renderRosterRow } from "./tile";

export interface TabMeta {
  sessionId: string;
  title: string;
  color: string | null;
}

export interface ConvergenceTabBridge {
  listTabs(): TabMeta[];
  activateBySessionId(sessionId: string, opts?: { keepOverlayOpen?: boolean }): boolean;
}

const POLL_MS = 1000;

export class ConvergenceOverlay {
  private root: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private inboxEl: HTMLElement | null = null;
  private rosterEl: HTMLElement | null = null;
  private empty: HTMLElement | null = null;
  private pollHandle: number | null = null;
  private visible = false;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private snap: ConvergenceSnapshot | null = null;
  private activeEscalationId: string | null = null;
  private filter: "all" | "escalated" | "working" | "idle" = "all";
  private expanded = new Set<string>();

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
    this.gridEl = null;
    this.inboxEl = null;
    this.rosterEl = null;
    this.empty = null;
    this.snap = null;
    this.activeEscalationId = null;
    this.filter = "all";
    this.expanded.clear();
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
    grid.className = "cv-grid";
    const inbox = document.createElement("section");
    inbox.className = "cv-inbox";
    const roster = document.createElement("section");
    roster.className = "cv-roster";
    grid.append(inbox, roster);

    const empty = document.createElement("div");
    empty.className = "convergence-overlay__empty";
    empty.hidden = true;
    empty.innerHTML = `
      <div class="convergence-overlay__empty-icon">${Icons.link2({ size: 56 })}</div>
      <div class="convergence-overlay__empty-title">Nothing to converge</div>
      <div class="convergence-overlay__empty-body">
        Convergence aggregates escalations and operator status across every tab.<br/>
        Enable an operator on a tab (⌘O) to populate this view.
      </div>
      <kbd class="convergence-overlay__empty-hint">⌘⇧M to toggle convergence</kbd>
    `;

    root.append(header, grid, empty);
    document.body.append(root);

    this.root = root;
    this.gridEl = grid;
    this.inboxEl = inbox;
    this.rosterEl = roster;
    this.empty = empty;

    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest(".cv-reply")) {
          e.preventDefault();
          e.stopPropagation();
          active.blur();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        this.close();
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.tagName === "TEXTAREA") {
          const ta = active as HTMLTextAreaElement;
          if (ta.value.length > 0) return; // let caret movement happen
        }
        e.preventDefault();
        this.moveActive(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    document.addEventListener("keydown", this.escHandler, { capture: true });
  }

  private moveActive(delta: number): void {
    const list = this.snap?.escalations ?? [];
    if (list.length === 0) return;
    const idx = list.findIndex((e) => e.session_id === this.activeEscalationId);
    const next = (idx === -1 ? 0 : idx + delta + list.length) % list.length;
    this.activeEscalationId = list[next].session_id;
    this.renderInbox();
  }

  private async refresh(): Promise<void> {
    if (!this.visible || !this.inboxEl || !this.rosterEl || !this.empty) return;
    const tabs = this.bridge.listTabs().map((t) => ({
      session_id: t.sessionId,
      title: t.title,
      color: t.color,
    }));
    try {
      this.snap = await getConvergenceSnapshot(tabs);
    } catch (err) {
      console.warn("convergence snapshot failed", err);
      return;
    }
    if (this.snap.roster.length === 0 && this.snap.escalations.length === 0) {
      this.inboxEl.replaceChildren();
      this.rosterEl.replaceChildren();
      this.empty.hidden = false;
      if (this.gridEl) this.gridEl.hidden = true;
      return;
    }
    this.empty.hidden = true;
    if (this.gridEl) this.gridEl.hidden = false;
    this.renderInbox();
    this.renderRoster();
  }

  private renderInbox(): void {
    if (!this.inboxEl || !this.snap) return;
    const list = this.snap.escalations;
    this.inboxEl.replaceChildren();

    const headerRow = document.createElement("div");
    headerRow.className = "cv-inbox__header";
    headerRow.textContent =
      list.length > 0 ? `Inbox · ${list.length} awaiting you` : "Inbox";
    this.inboxEl.append(headerRow);

    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cv-inbox__empty";
      empty.innerHTML = `
        <div class="cv-inbox__empty-icon">${Icons.bot({ size: 32 })}</div>
        <div class="cv-inbox__empty-title">All clear</div>
        <div class="cv-inbox__empty-body">No operators are awaiting your input.</div>
      `;
      this.inboxEl.append(empty);
      this.activeEscalationId = null;
      return;
    }

    if (
      !this.activeEscalationId ||
      !list.some((e) => e.session_id === this.activeEscalationId)
    ) {
      this.activeEscalationId = list[0].session_id;
    }

    for (const card of list) {
      this.inboxEl.append(
        renderInboxCard(card, card.session_id === this.activeEscalationId, {
          onActivate: (sid) => {
            this.activeEscalationId = sid;
            this.renderInbox();
          },
          onSubmit: this.submitReply.bind(this),
        }),
      );
    }
  }

  private renderRoster(): void {
    if (!this.rosterEl || !this.snap) return;
    this.rosterEl.replaceChildren();

    const header = document.createElement("div");
    header.className = "cv-roster__header";
    const label = document.createElement("span");
    label.className = "cv-roster__label";
    label.textContent = `Roster · ${this.snap.roster.length} operators`;
    const chips = document.createElement("div");
    chips.className = "cv-roster__chips";
    for (const v of ["all", "escalated", "working", "idle"] as const) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "cv-chip" + (this.filter === v ? " cv-chip--active" : "");
      chip.textContent = v;
      chip.addEventListener("click", () => {
        this.filter = v;
        this.renderRoster();
      });
      chips.append(chip);
    }
    header.append(label, chips);
    this.rosterEl.append(header);

    const filtered = this.snap.roster.filter((entry) => {
      if (this.filter === "all") return true;
      if (this.filter === "escalated") return entry.has_escalation;
      return entry.sessions.some((s) => s.status === this.filter);
    });

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cv-roster__empty";
      empty.innerHTML = `
        No operators match <code>${this.filter}</code>.
        <button type="button" class="cv-roster__empty-reset">Show all</button>
      `;
      const resetBtn = empty.querySelector<HTMLButtonElement>(".cv-roster__empty-reset");
      resetBtn?.addEventListener("click", () => {
        this.filter = "all";
        this.renderRoster();
      });
      this.rosterEl.append(empty);
      return;
    }

    for (const entry of filtered) {
      const expanded = entry.has_escalation || this.expanded.has(entry.operator_id);
      this.rosterEl.append(
        renderRosterRow(entry, expanded, {
          onFocus: (sid, keepOpen) => {
            const ok = this.bridge.activateBySessionId(sid, { keepOverlayOpen: keepOpen });
            if (ok && !keepOpen) this.close();
          },
          onToggleExpand: (opId) => {
            if (this.expanded.has(opId)) this.expanded.delete(opId);
            else this.expanded.add(opId);
            this.renderRoster();
          },
        }),
      );
    }
  }

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
