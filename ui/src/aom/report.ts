// Morning report panel — what the user sees after AOM ran overnight.
//
// Aggregates the most recent AOM session: header (when it ran, why it
// ended, $ spent vs budget), action breakdown (reply/executed/escalate),
// the escalations that need attention, and a per-tab digest (decisions,
// cost, recent commands).
//
// Read-only — the panel is for orientation, not action. If the user
// wants to inspect a specific decision, ⌘O has the full audit trail.

import { aomReport, type AomReport, type EscalationDigest, type PerTabDigest } from "../api";
import { Icons } from "../icons";
import { formatChord } from "../platform";

export class AomReportPanel {
  private modal: HTMLElement | null = null;
  // Capture-phase ESC: the global window-level handler runs in bubble
  // phase, but xterm.js swallows ESC when the terminal has focus, so it
  // never reaches window. Capturing on document while open guarantees
  // ESC closes the panel regardless of focus.
  private onEscKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  constructor(private readonly mountHost: HTMLElement) {}

  isOpen(): boolean {
    return this.modal !== null;
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else void this.open();
  }

  async open(): Promise<void> {
    if (this.isOpen()) return;
    this.render(null);
    let report: AomReport | null;
    try {
      report = await aomReport();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("aom_report failed", err);
      this.renderError(String(err));
      return;
    }
    this.render(report);
  }

  close(): void {
    if (!this.modal) return;
    document.removeEventListener("keydown", this.onEscKeydown, true);
    this.modal.remove();
    this.modal = null;
  }

  private render(report: AomReport | null): void {
    if (this.modal) {
      // Re-render in place: keep the overlay, swap the card body.
      const card = this.modal.querySelector<HTMLElement>(".aom-report-card");
      if (card) card.innerHTML = this.cardBody(report);
      this.wireClose();
      return;
    }

    const overlay = document.createElement("div");
    overlay.className = "aom-report-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const card = document.createElement("div");
    card.className = "aom-report-card";
    card.innerHTML = this.cardBody(report);
    overlay.appendChild(card);

    this.mountHost.appendChild(overlay);
    this.modal = overlay;
    document.addEventListener("keydown", this.onEscKeydown, true);

    // Close button — wired after every render since innerHTML rebuilt it.
    this.wireClose();
  }

  private renderError(msg: string): void {
    if (!this.modal) return;
    const card = this.modal.querySelector<HTMLElement>(".aom-report-card");
    if (card)
      card.innerHTML = `
      <header class="aom-report-header">
        <h2 class="aom-report-title">AOM Session Report</h2>
        <button type="button" class="aom-report-close" aria-label="close">${Icons.x({ size: 14 })}</button>
      </header>
      <div class="aom-report-empty">failed to load report: ${escapeHtml(msg)}</div>`;
    this.wireClose();
  }

  private wireClose(): void {
    if (!this.modal) return;
    const btn = this.modal.querySelector<HTMLButtonElement>(".aom-report-close");
    if (btn) btn.addEventListener("click", () => this.close());
  }

  private cardBody(report: AomReport | null): string {
    if (report === null) {
      // Two cases collapse to the same UI: still loading, or AOM has
      // never been started on this DB.
      return `
        <header class="aom-report-header">
          <h2 class="aom-report-title">AOM Session Report</h2>
          <button type="button" class="aom-report-close" aria-label="close">${Icons.x({ size: 14 })}</button>
        </header>
        <div class="aom-report-empty">no AOM session yet — press ${formatChord(["mod", "shift", "A"])} to start one</div>
      `;
    }

    const stopReason = stopReasonLabel(report);
    const dur = formatDuration(
      (report.ended_at_unix_ms ?? Date.now()) - report.started_at_unix_ms,
    );
    const startedAt = formatClock(report.started_at_unix_ms);
    const endedAt = report.ended_at_unix_ms
      ? formatClock(report.ended_at_unix_ms)
      : "running";
    const ab = report.action_breakdown;

    return `
      <header class="aom-report-header">
        <h2 class="aom-report-title">AOM Session Report</h2>
        <button type="button" class="aom-report-close" aria-label="close">${Icons.x({ size: 14 })}</button>
      </header>

      <section class="aom-report-summary">
        <div class="aom-report-row">
          <span class="aom-report-label">Window</span>
          <span class="aom-report-value">${startedAt} → ${endedAt} <span class="aom-report-muted">(${dur})</span></span>
        </div>
        <div class="aom-report-row">
          <span class="aom-report-label">Stopped</span>
          <span class="aom-report-value">${stopReason}</span>
        </div>
        <div class="aom-report-row">
          <span class="aom-report-label">Cost</span>
          <span class="aom-report-value">$${report.accumulated_cost_usd.toFixed(
            3,
          )} / $${report.budget_usd.toFixed(2)}</span>
        </div>
        <div class="aom-report-row">
          <span class="aom-report-label">Decisions</span>
          <span class="aom-report-value">${report.decisions_count} total ·
            <span class="aom-report-pill ok">${ab.executed_count} typed</span>
            <span class="aom-report-pill warn">${ab.escalate_count} escalated</span>
            <span class="aom-report-pill muted">${ab.wait_count} waited</span>
          </span>
        </div>
      </section>

      <section class="aom-report-section">
        <h3 class="aom-report-h3">Escalations needing attention (${report.escalations.length})</h3>
        ${
          report.escalations.length === 0
            ? `<div class="aom-report-empty-inline">none — clean run</div>`
            : `<ul class="aom-report-list">${report.escalations
                .map(renderEscalation)
                .join("")}</ul>`
        }
      </section>

      <section class="aom-report-section">
        <h3 class="aom-report-h3">Per-tab activity (${report.per_tab.length})</h3>
        ${
          report.per_tab.length === 0
            ? `<div class="aom-report-empty-inline">no tab-level activity recorded</div>`
            : `<ul class="aom-report-list">${report.per_tab.map(renderPerTab).join("")}</ul>`
        }
      </section>
    `;
  }
}

function renderEscalation(e: EscalationDigest): string {
  const when = formatRelative(Date.now() - e.timestamp_unix_ms);
  const cmd = e.in_flight_command
    ? `<div class="aom-report-meta">cmd: <code>${escapeHtml(e.in_flight_command)}</code></div>`
    : "";
  const why = e.rationale ?? e.reply_text ?? "(no rationale recorded)";
  return `
    <li class="aom-report-item escalate">
      <div class="aom-report-item-head">
        <span class="aom-report-warn-icon">${Icons.lightbulb({ size: 12 })}</span>
        <span class="aom-report-tab">tab …${escapeHtml(e.session_id_short)}</span>
        <span class="aom-report-when">${when}</span>
      </div>
      <div class="aom-report-rationale">${escapeHtml(why)}</div>
      ${cmd}
    </li>
  `;
}

function renderPerTab(t: PerTabDigest): string {
  const when = formatRelative(Date.now() - t.last_activity_unix_ms);
  const cmds =
    t.recent_commands.length === 0
      ? ""
      : `<ul class="aom-report-cmd-list">${t.recent_commands
          .map((c) => `<li><code>${escapeHtml(c)}</code></li>`)
          .join("")}</ul>`;
  return `
    <li class="aom-report-item">
      <div class="aom-report-item-head">
        <span class="aom-report-tab">tab …${escapeHtml(t.session_id_short)}</span>
        <span class="aom-report-when">last ${when}</span>
        <span class="aom-report-cost">$${t.cost_usd.toFixed(3)}</span>
        <span class="aom-report-decisions">${t.decisions_count} decision${
          t.decisions_count === 1 ? "" : "s"
        }</span>
      </div>
      ${cmds}
    </li>
  `;
}

function stopReasonLabel(r: AomReport): string {
  if (r.cost_cap_hit_at_unix_ms !== null) {
    return `<span class="aom-report-pill warn">budget hit</span>`;
  }
  if (r.ended_at_unix_ms === null) {
    return `<span class="aom-report-pill ok">still running</span>`;
  }
  return `<span class="aom-report-pill muted">user stopped</span>`;
}

function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

function formatRelative(ms: number): string {
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatClock(unixMs: number): string {
  const d = new Date(unixMs);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
