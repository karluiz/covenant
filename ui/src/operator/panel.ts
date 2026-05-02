// ⌘O — Operator decisions panel.
//
// Lists recent decisions the Operator has proposed. M-OP2 is dry-run:
// every decision is persisted with executed=false so the user can review
// what the Operator WOULD do before M-OP3 lets it actually act.
//
// Auto-refreshes when the backend emits "operator-decision" via Tauri.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { listOperatorDecisions, type OperatorDecisionRow } from "../api";

const LIMIT = 80;

export class OperatorPanel {
  private modal: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private unlisten: UnlistenFn | null = null;

  constructor(private readonly mountHost: HTMLElement) {}

  isOpen(): boolean {
    return this.modal !== null;
  }

  async toggle(): Promise<void> {
    if (this.isOpen()) {
      this.close();
    } else {
      await this.open();
    }
  }

  async open(): Promise<void> {
    if (this.isOpen()) return;
    this.render();
    await this.refresh();

    // Auto-refresh on new decisions while the panel is open.
    this.unlisten = await listen("operator-decision", () => {
      void this.refresh();
    });
  }

  close(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    if (this.modal) {
      this.modal.remove();
      this.modal = null;
      this.listEl = null;
    }
  }

  private render(): void {
    const overlay = document.createElement("div");
    overlay.className = "operator-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const card = document.createElement("div");
    card.className = "operator-card";
    overlay.appendChild(card);

    card.innerHTML = `
      <header class="operator-header">
        <div>
          <h2>Operator decisions</h2>
          <small>Dry-run (M-OP2) — proposals only, nothing typed yet.</small>
        </div>
        <button type="button" class="operator-close" aria-label="Close">×</button>
      </header>
      <div class="operator-list" tabindex="-1">loading…</div>
    `;

    card
      .querySelector<HTMLButtonElement>(".operator-close")!
      .addEventListener("click", () => this.close());

    this.mountHost.appendChild(overlay);
    this.modal = overlay;
    this.listEl = card.querySelector<HTMLElement>(".operator-list");
  }

  private async refresh(): Promise<void> {
    if (!this.listEl) return;
    let rows: OperatorDecisionRow[];
    try {
      rows = await listOperatorDecisions(LIMIT);
    } catch (err) {
      this.listEl.textContent = `failed to load: ${String(err)}`;
      return;
    }

    if (rows.length === 0) {
      this.listEl.innerHTML = `
        <div class="operator-empty">
          No decisions yet. Enable the Operator on a tab (right-click →
          "Enable operator") and run an executor agent (claude, copilot,
          opencode, aider…) that pauses for input.
        </div>
      `;
      return;
    }

    this.listEl.innerHTML = rows.map(renderRow).join("");
  }
}

function renderRow(r: OperatorDecisionRow): string {
  const age = humanizeAge(Date.now() - r.timestamp_unix_ms);
  const cmd = r.in_flight_command
    ? `<code>${escapeHtml(truncate(r.in_flight_command, 60))}</code>`
    : `<span class="op-muted">(no in-flight command)</span>`;

  const actionBadge = renderActionBadge(r.action, r.executed);

  const replyLine = r.reply_text
    ? `<div class="op-reply"><span class="op-reply-label">would type</span><code>${escapeHtml(visualizeBytes(r.reply_text))}</code></div>`
    : "";

  const rationale = r.rationale
    ? `<div class="op-rationale">${escapeHtml(r.rationale)}</div>`
    : "";

  const excerpt = r.output_excerpt
    ? `<details class="op-excerpt"><summary>excerpt (${r.output_excerpt.length} chars)</summary><pre>${escapeHtml(r.output_excerpt)}</pre></details>`
    : "";

  return `
    <div class="op-row">
      <div class="op-row-head">
        ${actionBadge}
        ${cmd}
        <span class="op-meta">tab …${escapeHtml(r.session_id_short)} · ${escapeHtml(age)}</span>
      </div>
      ${replyLine}
      ${rationale}
      ${excerpt}
    </div>
  `;
}

function renderActionBadge(action: string, executed: boolean): string {
  const cls =
    action === "reply"
      ? "op-badge-reply"
      : action === "escalate"
        ? "op-badge-escalate"
        : "op-badge-wait";
  const label = executed ? action.toUpperCase() : `${action.toUpperCase()} (dry)`;
  return `<span class="op-badge ${cls}">${label}</span>`;
}

function visualizeBytes(s: string): string {
  // Render \n / \t / \r visibly so the user sees exactly what would be typed.
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
}

function humanizeAge(ms: number): string {
  if (ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
