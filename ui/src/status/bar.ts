// 3.7 Status Bar — bottom-of-window context strip.
//
// Shows up to three read-only segments derived from the active tab:
//   • git     — repo basename + branch (or DETACHED@<sha>)
//   • runtime — language + declared version (node, python, rust, go, ruby)
//   • mission — spec basename when one is attached. Clickable: opens a
//               modal with the full spec text.
//
// Detection for git/runtime happens in the Rust backend on a worker
// pool; this file is a thin renderer that re-fetches whenever the
// active tab's cwd changes. Mission state is pushed in by TabManager
// via setMission — no polling.
//
// We coalesce rapid back-to-back fetches (cwd_changed bursts during a
// shell init are common) by tagging each request with a monotonically
// increasing ticket and ignoring stale results.

import type { DirContext, MissionInfo, SessionId } from "../api";
import { getDirContext, getSessionMissionContent } from "../api";
import { Icons } from "../icons";

const GIT_BRANCH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

const CPU_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></svg>';

export class StatusBar {
  private enabled = true;
  private currentCwd: string | null = null;
  private currentMission: MissionInfo | null = null;
  private currentSessionId: SessionId | null = null;
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

function missionSegment(mission: MissionInfo, onClick: () => void): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "status-segment status-mission";
  el.title = `Mission: ${mission.path}\n\n${mission.content_preview}\n\nClick to view full spec`;
  el.setAttribute("aria-label", `Mission: ${mission.path}. Click to view full spec.`);

  const icon = document.createElement("span");
  icon.className = "status-icon";
  icon.innerHTML = Icons.lightbulb({ size: 12 });
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
