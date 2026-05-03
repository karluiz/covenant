// 3.7 Status Bar — bottom-of-window context strip.
//
// Shows the active tab's session-context chips:
//   • git      — repo basename + branch (or DETACHED@<sha>)
//   • runtime  — language + declared version (node, python, rust, …)
//   • mission  — spec basename when one is attached (clickable → modal)
//   • executor — running agent name (claude / aider / opencode / …)
//   • aom      — autonomous-operator status when active (clickable →
//                popover with Stop / AFK / live stats)
//
// Detection for git/runtime happens in the Rust backend on a worker
// pool; this file is a thin renderer that re-fetches whenever the
// active tab's cwd changes. Mission/executor/aom state is pushed in by
// callers (TabManager, AomBanner) — no polling here.
//
// We coalesce rapid back-to-back fetches (cwd_changed bursts during a
// shell init are common) by tagging each request with a monotonically
// increasing ticket and ignoring stale results.

import type { AomStatus, DirContext, MissionInfo, SessionId } from "../api";
import { getDirContext, getSessionMissionContent } from "../api";
import { Icons } from "../icons";

const GIT_BRANCH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

const CPU_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></svg>';

/// Callbacks the AOM popover wires to its action buttons.
export interface AomActions {
  onStop: () => void;
  onAfk: () => void;
}

export class StatusBar {
  private enabled = true;
  private currentCwd: string | null = null;
  private currentMission: MissionInfo | null = null;
  private currentSessionId: SessionId | null = null;
  private currentExecutor: string | null = null;
  private currentAom: AomStatus | null = null;
  private aomActions: AomActions | null = null;
  private aomPopover: HTMLElement | null = null;
  private lastDirCtx: DirContext = { git: null, runtime: null };
  /// Monotonic; bumped on every fetch — late-arriving stale responses
  /// are dropped by comparing against this on completion.
  private fetchTicket = 0;
  private modal: MissionViewerModal | null = null;

  constructor(private readonly host: HTMLElement) {
    this.host.classList.add("status-bar");
    this.host.setAttribute("role", "status");
    this.host.setAttribute("aria-live", "off");
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.host.hidden = !enabled;
    if (enabled) {
      // Re-render from whatever cwd we last saw so flipping back on
      // doesn't show a stale "no segments" state.
      void this.refresh();
    } else {
      this.host.innerHTML = "";
    }
  }

  /// Called by main.ts whenever the active tab changes OR the active
  /// tab emits a cwd_changed event. Null cwd → empty bar (no detection).
  setCwd(cwd: string | null): void {
    if (this.currentCwd === cwd) return;
    this.currentCwd = cwd;
    void this.refresh();
  }

  /// Pushed by TabManager whenever the active tab's mission changes:
  ///   - tab activated (its current mission)
  ///   - mission set/cleared on the active tab
  ///   - mission-changed event for the active tab (file watch)
  /// SessionId is required so the modal knows which session to query.
  setMission(mission: MissionInfo | null, sessionId: SessionId | null): void {
    const samePath = (this.currentMission?.path ?? null) === (mission?.path ?? null);
    const sameMtime =
      (this.currentMission?.loaded_at_unix_ms ?? null) ===
      (mission?.loaded_at_unix_ms ?? null);
    const sameSession = this.currentSessionId === sessionId;
    if (samePath && sameMtime && sameSession) return;

    this.currentMission = mission;
    this.currentSessionId = sessionId;
    this.render(this.lastDirCtx);
  }

  /// Pushed by TabManager when the active tab's running executor
  /// (claude / aider / opencode / ...) starts or ends — null clears
  /// the chip. Driven off block_started / block_finished + activate.
  setExecutor(name: string | null): void {
    if (this.currentExecutor === name) return;
    this.currentExecutor = name;
    this.render(this.lastDirCtx);
  }

  /// Bind the action handlers used by the AOM popover. Called once at
  /// boot — wires Stop/AFK so the chip's popover doesn't need to reach
  /// out to the global AomBanner / AfkOverlay itself.
  bindAomActions(actions: AomActions): void {
    this.aomActions = actions;
  }

  /// Pushed by AomBanner.onUpdate on every poll tick + transition.
  /// Hidden chip when status.enabled is false; otherwise renders a
  /// compact chip with duration + decisions + cost. The chip is
  /// clickable: opens a popover with the Stop + AFK buttons.
  setAom(status: AomStatus | null): void {
    // Treat "off" as no chip — null and {enabled:false} collapse.
    const next = status && status.enabled ? status : null;
    // Cheap bail-out when nothing meaningful changed: most poll ticks
    // change cost by fractions of a cent — re-render only when one of
    // the displayed fields actually moves enough to matter.
    if (
      this.currentAom === null && next === null
    ) {
      return;
    }
    if (
      this.currentAom &&
      next &&
      this.currentAom.started_at_unix_ms === next.started_at_unix_ms &&
      this.currentAom.decisions_count === next.decisions_count &&
      Math.abs(this.currentAom.accumulated_cost_usd - next.accumulated_cost_usd) < 0.0005 &&
      this.currentAom.budget_usd === next.budget_usd
    ) {
      // Even if nothing changed, the elapsed time keeps moving — so
      // refresh just the time text in place rather than re-rendering
      // the whole chip on every poll.
      this.refreshAomTimeInPlace();
      return;
    }
    this.currentAom = next;
    if (next === null) this.closeAomPopover();
    this.render(this.lastDirCtx);
  }

  private refreshAomTimeInPlace(): void {
    if (!this.currentAom) return;
    const timeEl = this.host.querySelector<HTMLElement>(".status-aom-time");
    if (timeEl) {
      timeEl.textContent = formatElapsed(
        Date.now() - this.currentAom.started_at_unix_ms,
      );
    }
    // Popover stats too, if open.
    const popTime = this.aomPopover?.querySelector<HTMLElement>(".status-aom-pop-time");
    if (popTime) {
      popTime.textContent = formatElapsed(
        Date.now() - this.currentAom.started_at_unix_ms,
      );
    }
  }

  private openAomPopover(anchor: HTMLElement): void {
    if (this.aomPopover || !this.currentAom) return;
    const aom = this.currentAom;
    const pop = document.createElement("div");
    pop.className = "status-aom-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "AOM controls");
    const ratio =
      aom.budget_usd > 0 ? aom.accumulated_cost_usd / aom.budget_usd : 0;
    const warnClass = ratio >= 0.8 ? " status-aom-pop-warn" : "";
    pop.innerHTML = `
      <div class="status-aom-pop-header">
        <span class="status-aom-pop-icon">${Icons.bot({ size: 14 })}</span>
        <span class="status-aom-pop-title">Autonomous Operator Mode</span>
      </div>
      <div class="status-aom-pop-grid">
        <div class="status-aom-pop-label">Running for</div>
        <div class="status-aom-pop-value status-aom-pop-time">${formatElapsed(Date.now() - aom.started_at_unix_ms)}</div>
        <div class="status-aom-pop-label">Decisions</div>
        <div class="status-aom-pop-value">${aom.decisions_count}</div>
        <div class="status-aom-pop-label">Cost</div>
        <div class="status-aom-pop-value${warnClass}">$${aom.accumulated_cost_usd.toFixed(3)} / $${aom.budget_usd.toFixed(2)}</div>
      </div>
      <div class="status-aom-pop-actions">
        <button type="button" class="status-aom-pop-btn status-aom-pop-afk">AFK mode</button>
        <button type="button" class="status-aom-pop-btn status-aom-pop-stop">Stop AOM</button>
      </div>
    `;
    document.body.appendChild(pop);
    // Position above the chip — anchored bottom-right of the chip,
    // popover bottom-edge sits on the chip's top edge.
    const rect = anchor.getBoundingClientRect();
    const popHeight = pop.offsetHeight;
    const popWidth = pop.offsetWidth;
    pop.style.left = `${Math.max(8, rect.right - popWidth)}px`;
    pop.style.top = `${rect.top - popHeight - 6}px`;

    pop.querySelector<HTMLButtonElement>(".status-aom-pop-stop")?.addEventListener(
      "click",
      () => {
        this.aomActions?.onStop();
        this.closeAomPopover();
      },
    );
    pop.querySelector<HTMLButtonElement>(".status-aom-pop-afk")?.addEventListener(
      "click",
      () => {
        this.aomActions?.onAfk();
        this.closeAomPopover();
      },
    );
    // Click outside / Escape closes.
    const onDocClick = (e: MouseEvent): void => {
      if (!this.aomPopover) return;
      if (this.aomPopover.contains(e.target as Node)) return;
      if (anchor.contains(e.target as Node)) return;
      this.closeAomPopover();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") this.closeAomPopover();
    };
    setTimeout(() => {
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
    }, 0);
    pop.dataset.cleanup = "1";
    (pop as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
    this.aomPopover = pop;
  }

  private closeAomPopover(): void {
    if (!this.aomPopover) return;
    const cleanup = (this.aomPopover as HTMLElement & { _cleanup?: () => void })._cleanup;
    cleanup?.();
    this.aomPopover.remove();
    this.aomPopover = null;
  }

  private async refresh(): Promise<void> {
    if (!this.enabled) return;
    const ticket = ++this.fetchTicket;
    const cwd = this.currentCwd;
    if (!cwd) {
      this.lastDirCtx = { git: null, runtime: null };
      this.render(this.lastDirCtx);
      return;
    }
    let ctx: DirContext;
    try {
      ctx = await getDirContext(cwd);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("get_dir_context failed", err);
      ctx = { git: null, runtime: null };
    }
    if (ticket !== this.fetchTicket) return; // a newer cwd has won
    this.lastDirCtx = ctx;
    this.render(ctx);
  }

  private render(ctx: DirContext): void {
    if (!this.enabled) return;
    this.host.innerHTML = "";

    if (ctx.git) {
      this.host.appendChild(
        segment(GIT_BRANCH_SVG, ctx.git.repo_name, ctx.git.branch),
      );
    }
    if (ctx.runtime) {
      this.host.appendChild(
        segment(CPU_SVG, ctx.runtime.language, ctx.runtime.version),
      );
    }
    if (this.currentMission && this.currentSessionId) {
      this.host.appendChild(
        missionSegment(this.currentMission, () => this.openMission()),
      );
    }
    if (this.currentExecutor) {
      this.host.appendChild(executorSegment(this.currentExecutor));
    }
    if (this.currentAom) {
      this.host.appendChild(
        aomSegment(this.currentAom, (anchor) => this.openAomPopover(anchor)),
      );
    }
  }

  private async openMission(): Promise<void> {
    const mission = this.currentMission;
    const sessionId = this.currentSessionId;
    if (!mission || !sessionId) return;
    await this.openMissionFor(mission, sessionId);
  }

  /// Public entry point for the modal — also called from the tab
  /// context menu's "View mission…" so both routes share the same
  /// loading/race semantics.
  async openMissionFor(mission: MissionInfo, sessionId: SessionId): Promise<void> {
    if (!this.modal) this.modal = new MissionViewerModal(document.body);
    this.modal.openLoading(mission);
    let content: string | null;
    try {
      content = await getSessionMissionContent(sessionId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("get_session_mission_content failed", err);
      this.modal.showError(String(err));
      return;
    }
    // Race guard: if the user closed the modal before the fetch
    // returned, don't pop it back open.
    if (!this.modal.isOpen()) return;
    this.modal.showContent(mission, content ?? "");
  }
}

function segment(iconSvg: string, primary: string, secondary: string | null): HTMLElement {
  const el = document.createElement("span");
  el.className = "status-segment";

  const icon = document.createElement("span");
  icon.className = "status-icon";
  icon.innerHTML = iconSvg;
  el.appendChild(icon);

  const text = document.createElement("span");
  text.className = "status-text";
  text.textContent = primary;
  el.appendChild(text);

  if (secondary && secondary.trim() !== "") {
    const sec = document.createElement("span");
    sec.className = "status-secondary";
    sec.textContent = secondary;
    el.appendChild(sec);
  }
  return el;
}

function aomSegment(
  aom: AomStatus,
  onClick: (anchor: HTMLElement) => void,
): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "status-segment status-aom";
  const ratio =
    aom.budget_usd > 0 ? aom.accumulated_cost_usd / aom.budget_usd : 0;
  if (ratio >= 0.8) el.classList.add("status-aom-warn");
  el.title = `AOM running — ${aom.decisions_count} decisions, $${aom.accumulated_cost_usd.toFixed(3)} of $${aom.budget_usd.toFixed(2)} budget. Click for controls.`;
  el.setAttribute("aria-label", el.title);

  const icon = document.createElement("span");
  icon.className = "status-icon";
  icon.innerHTML = Icons.bot({ size: 12 });
  el.appendChild(icon);

  const label = document.createElement("span");
  label.className = "status-text";
  label.textContent = "AOM";
  el.appendChild(label);

  const time = document.createElement("span");
  time.className = "status-secondary status-aom-time";
  time.textContent = formatElapsed(Date.now() - aom.started_at_unix_ms);
  el.appendChild(time);

  const cost = document.createElement("span");
  cost.className = "status-secondary";
  cost.textContent = `$${aom.accumulated_cost_usd.toFixed(3)}`;
  el.appendChild(cost);

  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(el);
  });
  return el;
}

function formatElapsed(ms: number): string {
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm === 0 ? `${h}h` : `${h}h${rm}m`;
}

function executorSegment(name: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "status-segment status-executor";
  el.title = `Running ${name} in this tab`;
  el.setAttribute("aria-label", `Executor: ${name}`);

  const icon = document.createElement("span");
  icon.className = "status-icon";
  icon.innerHTML = Icons.bot({ size: 12 });
  el.appendChild(icon);

  const text = document.createElement("span");
  text.className = "status-text";
  text.textContent = name;
  el.appendChild(text);

  return el;
}

function missionSegment(mission: MissionInfo, onClick: () => void): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "status-segment status-mission";
  el.title = `Mission: ${mission.path}\n\n${mission.content_preview}\n\nClick to view full spec`;
  el.setAttribute("aria-label", `Mission: ${mission.path}. Click to view full spec.`);

  const icon = document.createElement("span");
  icon.className = "status-icon";
  icon.innerHTML = Icons.target({ size: 12 });
  el.appendChild(icon);

  const text = document.createElement("span");
  text.className = "status-text";
  text.textContent = basename(mission.path);
  el.appendChild(text);

  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return el;
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/// Modal that shows the full mission spec text. Read-only — for editing
/// the user opens the file in their editor (path is shown in the header
/// so they can copy it).
class MissionViewerModal {
  private overlay: HTMLElement | null = null;

  constructor(private readonly mountHost: HTMLElement) {}

  isOpen(): boolean {
    return this.overlay !== null;
  }

  openLoading(mission: MissionInfo): void {
    this.ensureOverlay();
    this.renderHeader(mission);
    const body = this.bodyEl();
    if (body) body.innerHTML = `<div class="mission-viewer-empty">Loading…</div>`;
  }

  showContent(mission: MissionInfo, content: string): void {
    this.ensureOverlay();
    this.renderHeader(mission);
    const body = this.bodyEl();
    if (body) {
      if (content.trim() === "") {
        body.innerHTML = `<div class="mission-viewer-empty">spec file is empty</div>`;
      } else {
        body.innerHTML = "";
        const pre = document.createElement("pre");
        pre.className = "mission-viewer-content";
        pre.textContent = content;
        body.appendChild(pre);
      }
    }
  }

  showError(msg: string): void {
    if (!this.overlay) return;
    const body = this.bodyEl();
    if (body)
      body.innerHTML = `<div class="mission-viewer-empty">failed to load mission: ${escapeHtml(
        msg,
      )}</div>`;
  }

  close(): void {
    if (!this.overlay) return;
    this.overlay.remove();
    this.overlay = null;
    document.removeEventListener("keydown", this.escListener);
  }

  private escListener = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.overlay) {
      e.preventDefault();
      this.close();
    }
  };

  private ensureOverlay(): void {
    if (this.overlay) return;
    const overlay = document.createElement("div");
    overlay.className = "mission-viewer-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const card = document.createElement("div");
    card.className = "mission-viewer-card";
    card.innerHTML = `
      <header class="mission-viewer-header">
        <div class="mission-viewer-titles">
          <h2 class="mission-viewer-title">Mission</h2>
          <code class="mission-viewer-path"></code>
        </div>
        <button type="button" class="mission-viewer-close" aria-label="close">${Icons.x({
          size: 14,
        })}</button>
      </header>
      <div class="mission-viewer-body"></div>
    `;
    overlay.appendChild(card);
    this.mountHost.appendChild(overlay);
    this.overlay = overlay;

    const closeBtn = card.querySelector<HTMLButtonElement>(".mission-viewer-close");
    if (closeBtn) closeBtn.addEventListener("click", () => this.close());

    document.addEventListener("keydown", this.escListener);
  }

  private renderHeader(mission: MissionInfo): void {
    if (!this.overlay) return;
    const path = this.overlay.querySelector<HTMLElement>(".mission-viewer-path");
    if (path) path.textContent = mission.path;
  }

  private bodyEl(): HTMLElement | null {
    return this.overlay?.querySelector<HTMLElement>(".mission-viewer-body") ?? null;
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
