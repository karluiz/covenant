// Event detail drawer — a right-side slide-over that shows the full,
// structured detail of one Operator decision. Opened by clicking a row in
// the Activity tab; the narrow sidebar can't show untruncated output or all
// the context, so the drawer gives it room without covering the list.
//
// Self-contained: it owns its DOM, Esc/click-out handling, and teardown. The
// Activity view hands it a fully-normalized event plus the resolved origin
// chip and a focus callback; the drawer never reaches back into the view.

/* ── input shape (subset of ActEvent the drawer renders) ─────────── */

export interface EventDetail {
  ts: number;
  kindLabel: string;       // "escalated" | "typed" | "dry-run" | "waited" | …
  kindClass: string;       // drives the accent colour: escalated|typed|dry-run|waited
  cost: number;
  executed?: boolean;
  action: string;          // raw action ("reply" | "escalate" | "wait")
  replyText?: string | null;
  rationale?: string | null;
  escalation?: string | null;
  inFlightCommand?: string | null;
  outputExcerpt?: string | null;
  operatorName?: string | null;
  operatorId?: string | null;
}

/// Origin chip data + whether it's a live tab we can jump to.
export interface EventOrigin {
  /// Best human label already resolved by the view (tab / mission / executor).
  label: string | null;
  open: boolean;
  sessionShort: string;
}

export class EventDetailDrawer {
  private root: HTMLElement | null = null;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(
    private readonly mountHost: HTMLElement,
    /// Focus the live tab for a session short. Returns false if closed.
    private readonly focusSessionShort: (short: string) => boolean,
  ) {}

  isOpen(): boolean {
    return this.root !== null;
  }

  open(e: EventDetail, origin: EventOrigin): void {
    this.close();

    const root = document.createElement("div");
    root.className = "tp-evd-scrim";
    root.addEventListener("click", (ev) => {
      if (ev.target === root) this.close(); // click-out
    });

    const panel = document.createElement("aside");
    panel.className = `tp-evd tp-evd--${e.kindClass}`;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Event detail");
    panel.innerHTML = this.markup(e, origin);
    root.appendChild(panel);

    panel.querySelector<HTMLElement>(".tp-evd-close")
      ?.addEventListener("click", () => this.close());
    const jump = panel.querySelector<HTMLElement>("[data-evd-jump]");
    jump?.addEventListener("click", () => {
      this.focusSessionShort(origin.sessionShort);
      this.close();
    });

    this.escHandler = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        this.close();
      }
    };
    document.addEventListener("keydown", this.escHandler, { capture: true });

    this.mountHost.appendChild(root);
    this.root = root;
    // Trigger the slide-in transition on the next frame.
    requestAnimationFrame(() => panel.classList.add("tp-evd--in"));
  }

  close(): void {
    if (this.escHandler) {
      document.removeEventListener("keydown", this.escHandler, { capture: true });
      this.escHandler = null;
    }
    this.root?.remove();
    this.root = null;
  }

  private markup(e: EventDetail, origin: EventOrigin): string {
    const cost = e.cost > 0 ? `$${e.cost.toFixed(3)}` : "—";
    const when = absoluteTime(e.ts);
    const executedTag = e.action === "reply"
      ? `<span class="tp-evd-tag">${e.executed ? "executed" : "dry-run (not sent)"}</span>`
      : "";

    const originChip = origin.label
      ? `<span class="tp-evd-origin">${escapeHtml(origin.label)}${origin.open ? "" : ` <span class="tp-evd-origin-closed">closed</span>`}</span>`
      : "";
    const jumpBtn = origin.open
      ? `<button type="button" class="tp-evd-jump" data-evd-jump>Go to tab →</button>`
      : "";

    return `
      <header class="tp-evd-head">
        <div class="tp-evd-title">
          <span class="tp-evd-kind">${escapeHtml(e.kindLabel)}</span>
          <span class="tp-evd-cost">${escapeHtml(cost)}</span>
          <button type="button" class="tp-evd-close" aria-label="Close">✕</button>
        </div>
        <div class="tp-evd-sub">
          ${originChip}${jumpBtn}
        </div>
        <div class="tp-evd-when">${escapeHtml(when)}${executedTag}</div>
      </header>
      <div class="tp-evd-body">
        ${this.decisionSection(e)}
        ${this.executorSection(e)}
        ${this.operatorSection(e)}
      </div>
    `;
  }

  private decisionSection(e: EventDetail): string {
    // The primary text for this decision: the escalation message, the typed
    // reply, or the wait rationale — whichever the action produced.
    const blocks: string[] = [];
    if (e.escalation) blocks.push(field("Escalation", e.escalation));
    if (e.replyText) blocks.push(field("Reply", e.replyText, true));
    if (e.rationale) blocks.push(field("Rationale", e.rationale));
    if (blocks.length === 0) return "";
    return `<section class="tp-evd-sect">${blocks.join("")}</section>`;
  }

  private executorSection(e: EventDetail): string {
    const blocks: string[] = [];
    if (e.inFlightCommand) blocks.push(field("In-flight command", e.inFlightCommand, true));
    if (e.outputExcerpt) blocks.push(field("Executor output (tail)", e.outputExcerpt, true));
    if (blocks.length === 0) return "";
    return `<section class="tp-evd-sect"><h4 class="tp-evd-h">What the operator saw</h4>${blocks.join("")}</section>`;
  }

  private operatorSection(e: EventDetail): string {
    if (!e.operatorName && !e.operatorId) return "";
    const id = e.operatorId
      ? `<div class="tp-evd-meta">${escapeHtml(e.operatorId)}</div>`
      : "";
    return `
      <section class="tp-evd-sect">
        <h4 class="tp-evd-h">Operator</h4>
        <div class="tp-evd-op">${escapeHtml(e.operatorName ?? "—")}</div>
        ${id}
      </section>
    `;
  }
}

/* ── helpers ─────────────────────────────────────────────────────── */

function field(label: string, value: string, mono = false): string {
  return `
    <div class="tp-evd-field">
      <span class="tp-evd-label">${escapeHtml(label)}</span>
      <${mono ? "pre" : "p"} class="tp-evd-val${mono ? " tp-evd-val--mono" : ""}">${escapeHtml(value)}</${mono ? "pre" : "p"}>
    </div>
  `;
}

function absoluteTime(ts: number): string {
  if (!ts) return "unknown time";
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch {
    return String(ts);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
