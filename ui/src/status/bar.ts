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

import type {
  AomStatus,
  DirContext,
  MissionInfo,
  MissionSaveResult,
  SessionId,
} from "../api";
import {
  aomStatus,
  getDirContext,
  getSessionMissionContent,
  setSessionMissionContent,
} from "../api";
import { Icons } from "../icons";
import { renderMarkdown } from "../release/markdown";

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

  /// Wired by main.ts to TabManager. Fires when the user clicks the
  /// "+ Mission" affordance on the status bar (only shown when no
  /// mission is attached and the cwd looks like a project — git repo
  /// or detected runtime). Reuses the same prompt as the tab context
  /// menu's "Set mission…" so both routes end in one code path.
  public onMissionSetRequested: ((sessionId: SessionId) => void) | null = null;

  /// Wired by main.ts. Fires when the user clicks the version chip;
  /// opens the release-log modal. Decoupling the StatusBar from the
  /// ReleasePanel directly so the bar stays a thin renderer.
  public onVersionChipClick: (() => void) | null = null;

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
    } else if (
      this.currentSessionId &&
      // "Looks like a project" heuristic: backend already detected
      // either a git repo or a runtime manifest (package.json,
      // Cargo.toml, pyproject, …). We piggy-back on that signal so
      // there's no separate marker-file list to maintain here.
      (ctx.git !== null || ctx.runtime !== null)
    ) {
      const sid = this.currentSessionId;
      this.host.appendChild(
        addMissionSegment(() => this.onMissionSetRequested?.(sid)),
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
    // Version chip lives at the trailing edge — informational, click
    // opens the release log. Always rendered so the user always has a
    // glanceable "what build am I on" indicator.
    this.host.appendChild(
      versionSegment(__APP_VERSION__, () => this.onVersionChipClick?.()),
    );
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
    this.modal.showContent(mission, content ?? "", sessionId);
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

function versionSegment(version: string, onClick: () => void): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "status-segment status-version";
  el.title = `Covenant v${version} — click for release log (⌘⇧V)`;
  el.setAttribute("aria-label", `Version ${version}. Open release log.`);

  const text = document.createElement("span");
  text.className = "status-text";
  text.textContent = `v${version}`;
  el.appendChild(text);

  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return el;
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

/// Subtle "+ Mission" affordance shown only when the active tab has
/// no mission AND the cwd looks like a project. Lower opacity in
/// rest, full on hover, so it stays discoverable without competing
/// with real status segments.
function addMissionSegment(onClick: () => void): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "status-segment status-add-mission";
  el.title = "Set mission for this tab — anchor scope and constraints";
  el.setAttribute("aria-label", "Set mission");

  const icon = document.createElement("span");
  icon.className = "status-icon";
  icon.innerHTML = Icons.target({ size: 12 });
  el.appendChild(icon);

  const text = document.createElement("span");
  text.className = "status-text";
  text.textContent = "Set mission";
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

/// Modal that shows the full mission spec. Default mode is read-only;
/// click "Edit" to swap the content into a textarea (⌘S to save, Esc
/// to cancel). Editing is disabled while AOM is running — the
/// Operator is reading the spec on every tick, so changing it
/// mid-flight would surface inconsistent behavior silently.
///
/// On save, the backend rejects with a Conflict if the file's mtime
/// moved while we were editing (the user has it open in another
/// editor). We surface a banner with Reload (use disk content) and
/// Overwrite (force-write past the conflict).
const MISSION_VIEW_KIND_KEY = "covenant.mission-viewer.view-kind";

class MissionViewerModal {
  private overlay: HTMLElement | null = null;
  /// Source of truth for the on-disk file. Updated on showContent and
  /// after a successful save (we trust the backend's returned mtime).
  private mission: MissionInfo | null = null;
  private content = "";
  private sessionId: SessionId | null = null;
  private mode: "view" | "edit" = "view";
  /// View-mode toggle: "rendered" runs CHANGELOG-style markdown
  /// rendering (default — most missions are .md specs), "source" shows
  /// the raw file in a `<pre>`. Persisted in localStorage so the user
  /// keeps whichever view they prefer between opens.
  private viewKind: "rendered" | "source" = loadMissionViewKind();
  /// Cached at openLoading. Lets us decide synchronously whether to
  /// allow Edit. Re-checked on Edit click in case AOM started in between.
  private aomActive = false;

  constructor(private readonly mountHost: HTMLElement) {}

  isOpen(): boolean {
    return this.overlay !== null;
  }

  openLoading(mission: MissionInfo): void {
    this.mission = mission;
    this.content = "";
    this.sessionId = null;
    this.mode = "view";
    this.ensureOverlay();
    this.renderAll();
    const body = this.bodyEl();
    if (body) body.innerHTML = `<div class="mission-viewer-empty">Loading…</div>`;
    // Fire-and-forget: refresh AOM state so the Edit button reflects
    // reality by the time the content load resolves.
    void aomStatus()
      .then((s) => {
        this.aomActive = s.enabled;
        this.renderHeader();
      })
      .catch(() => {
        /* leave default false; backend will still gate on save */
      });
  }

  showContent(mission: MissionInfo, content: string, sessionId: SessionId): void {
    this.mission = mission;
    this.content = content;
    this.sessionId = sessionId;
    this.mode = "view";
    this.ensureOverlay();
    this.renderAll();
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
    this.mission = null;
    this.content = "";
    this.sessionId = null;
    this.mode = "view";
    document.removeEventListener("keydown", this.escListener);
  }

  private escListener = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !this.overlay) return;
    // In edit mode, Esc cancels back to view (matches the modal in
    // most editors); in view mode, it closes.
    if (this.mode === "edit") {
      e.preventDefault();
      this.cancelEdit();
      return;
    }
    e.preventDefault();
    this.close();
  };

  private ensureOverlay(): void {
    if (this.overlay) return;
    const overlay = document.createElement("div");
    overlay.className = "mission-viewer-overlay";
    overlay.addEventListener("click", (e) => {
      // Clicking the backdrop closes only in view mode — in edit
      // mode it would silently lose the user's in-progress edits.
      if (e.target === overlay && this.mode === "view") this.close();
    });

    const card = document.createElement("div");
    card.className = "mission-viewer-card";
    card.innerHTML = `
      <header class="mission-viewer-header">
        <div class="mission-viewer-titles">
          <h2 class="mission-viewer-title">Mission</h2>
          <code class="mission-viewer-path"></code>
        </div>
        <div class="mission-viewer-actions"></div>
      </header>
      <div class="mission-viewer-body"></div>
      <footer class="mission-viewer-footer" hidden></footer>
    `;
    overlay.appendChild(card);
    this.mountHost.appendChild(overlay);
    this.overlay = overlay;

    document.addEventListener("keydown", this.escListener);
  }

  /// Re-render header (title/path/buttons) AND body+footer from
  /// `this.mode` + state. Called whenever any of those change.
  private renderAll(): void {
    this.renderHeader();
    this.renderBody();
  }

  private renderHeader(): void {
    if (!this.overlay || !this.mission) return;
    const pathEl = this.overlay.querySelector<HTMLElement>(".mission-viewer-path");
    if (pathEl) pathEl.textContent = this.mission.path;

    const actions = this.overlay.querySelector<HTMLElement>(".mission-viewer-actions");
    if (!actions) return;
    actions.innerHTML = "";

    if (this.mode === "view") {
      // View-kind toggle: switches between rendered markdown and raw
      // source. Single button shows the OPPOSITE state's label so the
      // user reads it as "what clicking will do".
      const toggleBtn = document.createElement("button");
      toggleBtn.type = "button";
      toggleBtn.className = "mission-viewer-toggle";
      const showingRendered = this.viewKind === "rendered";
      toggleBtn.title = showingRendered
        ? "Show raw markdown source"
        : "Show rendered markdown";
      toggleBtn.textContent = showingRendered ? "Source" : "Rendered";
      toggleBtn.addEventListener("click", () => {
        this.viewKind = showingRendered ? "source" : "rendered";
        saveMissionViewKind(this.viewKind);
        this.renderAll();
      });
      actions.appendChild(toggleBtn);

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "mission-viewer-edit";
      editBtn.disabled = this.aomActive || this.sessionId === null;
      editBtn.title = this.aomActive
        ? "Mission locked while AOM is running"
        : "Edit mission";
      editBtn.innerHTML = `${Icons.pencil({ size: 12 })}<span>Edit</span>`;
      editBtn.addEventListener("click", () => this.enterEdit());
      actions.appendChild(editBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "mission-viewer-close";
    closeBtn.setAttribute("aria-label", "close");
    closeBtn.innerHTML = Icons.x({ size: 14 });
    closeBtn.addEventListener("click", () => {
      if (this.mode === "edit") this.cancelEdit();
      else this.close();
    });
    actions.appendChild(closeBtn);
  }

  private renderBody(): void {
    const body = this.bodyEl();
    if (!body) return;

    if (this.mode === "view") {
      this.renderViewBody(body);
      this.hideFooter();
      return;
    }
    this.renderEditBody(body);
    this.renderEditFooter();
  }

  private renderViewBody(body: HTMLElement): void {
    if (this.content.trim() === "") {
      body.innerHTML = `<div class="mission-viewer-empty">spec file is empty</div>`;
      return;
    }
    body.innerHTML = "";
    if (this.viewKind === "rendered") {
      const wrap = document.createElement("div");
      wrap.className = "mission-viewer-content mission-viewer-rendered markdown-body";
      wrap.innerHTML = renderMarkdown(this.content);
      body.appendChild(wrap);
    } else {
      const pre = document.createElement("pre");
      pre.className = "mission-viewer-content";
      pre.textContent = this.content;
      body.appendChild(pre);
    }
  }

  private renderEditBody(body: HTMLElement): void {
    body.innerHTML = "";
    const ta = document.createElement("textarea");
    ta.className = "mission-viewer-textarea";
    ta.value = this.content;
    ta.spellcheck = false;
    ta.autocapitalize = "off";
    ta.autocomplete = "off";
    ta.addEventListener("keydown", (e) => {
      // ⌘S / Ctrl+S → save without leaving the modal. We swallow it
      // so the browser's "save page" dialog never appears.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void this.save(ta.value);
      }
    });
    body.appendChild(ta);
    requestAnimationFrame(() => ta.focus());
  }

  private renderEditFooter(status?: string): void {
    if (!this.overlay) return;
    const footer = this.overlay.querySelector<HTMLElement>(".mission-viewer-footer");
    if (!footer) return;
    footer.hidden = false;
    footer.innerHTML = `
      <span class="mission-viewer-footer-hint">
        <kbd>⌘S</kbd> save · <kbd>Esc</kbd> cancel
      </span>
      <span class="mission-viewer-status" aria-live="polite">${escapeHtml(
        status ?? "",
      )}</span>
      <button type="button" class="mission-viewer-cancel">Cancel</button>
      <button type="button" class="mission-viewer-save">Save</button>
    `;
    footer
      .querySelector<HTMLButtonElement>(".mission-viewer-cancel")!
      .addEventListener("click", () => this.cancelEdit());
    footer
      .querySelector<HTMLButtonElement>(".mission-viewer-save")!
      .addEventListener("click", () => {
        const ta = this.overlay?.querySelector<HTMLTextAreaElement>(
          ".mission-viewer-textarea",
        );
        if (ta) void this.save(ta.value);
      });
  }

  private hideFooter(): void {
    const footer = this.overlay?.querySelector<HTMLElement>(
      ".mission-viewer-footer",
    );
    if (footer) {
      footer.hidden = true;
      footer.innerHTML = "";
    }
  }

  private enterEdit(): void {
    if (this.aomActive || this.sessionId === null) return;
    this.mode = "edit";
    this.renderAll();
  }

  private cancelEdit(): void {
    this.mode = "view";
    this.renderAll();
  }

  /// Persist; on Conflict, render an inline banner above the textarea
  /// with Reload (replace draft with disk content) / Overwrite (re-save
  /// past the conflict). The banner doesn't dismiss the user's draft —
  /// only Reload does.
  private async save(newContent: string, force = false): Promise<void> {
    if (!this.mission || !this.sessionId) return;
    this.setStatus("saving…");
    let result: MissionSaveResult;
    try {
      result = await setSessionMissionContent(
        this.sessionId,
        newContent,
        force ? 0 : this.mission.mtime_unix_ms,
      );
    } catch (err) {
      const msg = String(err);
      // Backend gates on AOM; surface it inline rather than as a
      // generic error so the user understands why.
      if (msg.includes("aom_active")) {
        this.aomActive = true;
        this.setStatus("AOM started — mission locked.");
        return;
      }
      this.setStatus(`save failed: ${msg}`);
      return;
    }

    if (result.kind === "saved") {
      this.mission = result.info;
      this.content = newContent;
      this.mode = "view";
      this.renderAll();
      return;
    }
    if (result.kind === "no_mission") {
      this.close();
      return;
    }
    // Conflict: keep the user's draft visible, surface a banner with
    // both options. The disk content is in `result.current_content`.
    this.showConflictBanner(result.current_content, result.actual_mtime_unix_ms);
  }

  private setStatus(msg: string): void {
    const el = this.overlay?.querySelector<HTMLElement>(
      ".mission-viewer-status",
    );
    if (el) el.textContent = msg;
  }

  private showConflictBanner(
    diskContent: string,
    diskMtime: number,
  ): void {
    const body = this.bodyEl();
    if (!body) return;
    // Insert the banner above the textarea; if one already exists,
    // replace it (the user might have ignored the first one).
    body.querySelector(".mission-viewer-conflict")?.remove();
    const banner = document.createElement("div");
    banner.className = "mission-viewer-conflict";
    banner.innerHTML = `
      <span class="mission-viewer-conflict-msg">
        File changed on disk while you were editing.
      </span>
      <button type="button" class="mission-viewer-conflict-reload">Reload from disk</button>
      <button type="button" class="mission-viewer-conflict-overwrite">Overwrite</button>
    `;
    body.insertBefore(banner, body.firstChild);

    banner
      .querySelector<HTMLButtonElement>(".mission-viewer-conflict-reload")!
      .addEventListener("click", () => {
        // Adopt the disk content + its mtime as the new baseline; the
        // user's draft is discarded by design (Reload is destructive
        // and the button label says so).
        this.content = diskContent;
        if (this.mission) this.mission = { ...this.mission, mtime_unix_ms: diskMtime };
        const ta = body.querySelector<HTMLTextAreaElement>(
          ".mission-viewer-textarea",
        );
        if (ta) ta.value = diskContent;
        banner.remove();
        this.setStatus("reloaded from disk");
      });
    banner
      .querySelector<HTMLButtonElement>(".mission-viewer-conflict-overwrite")!
      .addEventListener("click", () => {
        const ta = body.querySelector<HTMLTextAreaElement>(
          ".mission-viewer-textarea",
        );
        banner.remove();
        if (ta) void this.save(ta.value, true);
      });
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

function loadMissionViewKind(): "rendered" | "source" {
  try {
    const v = localStorage.getItem(MISSION_VIEW_KIND_KEY);
    return v === "source" ? "source" : "rendered";
  } catch {
    return "rendered";
  }
}

function saveMissionViewKind(kind: "rendered" | "source"): void {
  try {
    localStorage.setItem(MISSION_VIEW_KIND_KEY, kind);
  } catch {
    /* private mode / quota — leave the runtime value as the source of truth */
  }
}
