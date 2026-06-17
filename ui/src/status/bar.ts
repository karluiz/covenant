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
  GitRepoSummary,
  GitWorktreeSummary,
  MissionInfo,
  MissionPlanInfo,
  MissionSaveResult,
  Operator,
  SessionId,
  Vitals,
} from "../api";
import {
  aomStatus,
  getDirContext,
  getSessionMissionContent,
  gitRepoSummary,
  gitSwitchBranch,
  getSessionPlanContent,
  setSessionMissionContent,
  telegramStatus,
  type TelegramStatus,
} from "../api";
import { Icons } from "../icons";
import { brandIconSvg, telegramIconSvg } from "../icons/brands";
import { renderMarkdown } from "../release/markdown";
import { highlightMatches, clearMarks } from "./find-highlight";
import { isOnline, subscribeOnline } from "../aom/connectivity";
import { makeScoreChip, type ScoreChip } from "../score/chip";
import { attachTooltip } from "../tooltip/tooltip";
import { VitalsCluster } from "./vitals";
// TODO(task-17): integrate `renderOperatorChip` here once the LIVE
// badge + colored-dot composition can be expressed via the shared
// chip primitive. Today the status-bar operator chip carries a LIVE
// badge sibling that the shared chip doesn't model.

const GIT_BRANCH_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

// CPU_SVG removed with the runtime chip (node 25.2.1 etc). Tooling
// versions moved to About — they're not real-time signals.

/// Callbacks the AOM popover wires to its action buttons. All fields
/// are required now that TabManager is fully wired (Task 11).
export interface AomActions {
  onStop: () => void;
  onAfk: () => void;
  /// Re-include a single excluded tab. Implementer (TabManager)
  /// calls setAomExcluded(sessionId, false) and refreshes state.
  onIncludeTab: (sessionId: SessionId) => void;
  /// Re-include every excluded tab in one click. Implementer calls
  /// clear_all_aom_excluded.
  onIncludeAll: () => void;
}

/// Lightweight per-tab descriptor for the excluded-list popover.
export interface ExcludedTabInfo {
  sessionId: SessionId;
  name: string;
  /// Trimmed cwd for display. Empty string when no cwd.
  cwdShort: string;
}

/// Lightweight active-tab descriptor — just enough for the leading
/// status-bar chip. The full Tab type lives in the tabs module; we
/// only consume the few presentation fields here.
export interface ActiveTabInfo {
  name: string;
  color: string | null;
  groupName: string | null;
  groupColor: string | null;
}

export class StatusBar {
  private enabled = true;
  /// Layout mode. True = two-row (the shipped default). False = the
  /// original single-row layout. Toggled by `setTwoRow(v)` driven by
  /// the `experimental.statusbar_two_row` setting.
  private twoRow = true;
  private currentTab: ActiveTabInfo | null = null;
  private currentCwd: string | null = null;
  private currentMission: MissionInfo | null = null;
  private currentSessionId: SessionId | null = null;
  private currentExecutor: string | null = null;
  /// Per-active-tab Operator state. Null when no active tab OR the
  /// active tab has Operator off — collapses the chip in either case.
  /// `live` is meaningful only when `enabled: true` (backend invariant).
  private currentOperator: { enabled: boolean; live: boolean } | null = null;
  private currentAom: AomStatus | null = null;
  private branchPopover: HTMLElement | null = null;
  private branchPopoverTicket = 0;
  /// Tabs currently excluded from AOM. Pushed by TabManager whenever
  /// the set changes (toggle, AOM transition, restore). Empty when
  /// AOM is off OR no exclusions exist — both collapse the suffix.
  private excludedTabs: ExcludedTabInfo[] = [];
  private aomActions: AomActions | null = null;
  private aomPopover: HTMLElement | null = null;
  /// Pinned Operator entity for the active tab. Set via setOperatorEntity;
  /// separate from `currentOperator` (enabled/live booleans). Null when
  /// the active tab has no pinned operator (uses backend default) or when
  /// no tab is active.
  private currentOperatorEntity: Operator | null = null;
  private lastDirCtx: DirContext = { git: null, runtime: null };
  /// Monotonic; bumped on every fetch — late-arriving stale responses
  /// are dropped by comparing against this on completion.
  private fetchTicket = 0;
  private modal: MissionViewerModal | null = null;
  /// Last polled Telegram status. Drives the .tg-status pill class.
  private currentTgStatus: TelegramStatus = "disabled";
  private scoreChip: ScoreChip | null = null;
  private vitals: VitalsCluster | null = null;
  /// Network connectivity. Mirrors navigator.onLine via the AOM
  /// connectivity bridge. When false, the executor chip dims and
  /// gains a "no internet" reason tag; a standalone offline chip is
  /// surfaced when no executor is running.
  private online: boolean = isOnline();

  /// Wired by main.ts to TabManager. Fires when the user clicks the
  /// "+ Mission" affordance on the status bar (only shown when no
  /// mission is attached and the cwd looks like a project — git repo
  /// or detected runtime). Reuses the same prompt as the tab context
  /// menu's "Set mission…" so both routes end in one code path.
  public onMissionSetRequested: ((sessionId: SessionId) => void) | null = null;

  /// Right-click on the mission chip: change mission (reuses the same
  /// picker as "Set mission") or remove it. Wired by main.ts to
  /// TabManager so the behavior matches the tab context menu.
  public onMissionEditRequested: ((sessionId: SessionId) => void) | null = null;
  public onMissionClearRequested: ((sessionId: SessionId) => void) | null = null;

  /// Wired by main.ts. Fires when the user clicks the version chip;
  /// opens the release-log modal. Decoupling the StatusBar from the
  /// ReleasePanel directly so the bar stays a thin renderer.
  public onVersionChipClick: (() => void) | null = null;

  /// Wired by main.ts (Task 5 will hook this to an OperatorPicker).
  /// Fires when the user clicks the operator chip in the status bar.
  /// No-op stub until the picker is wired in Plan 3 Task 5.
  public onOperatorChipClick: ((sessionId: SessionId) => void) | null = null;

  /// Fired from the branch/worktree popover when the user wants a
  /// worktree in its own terminal tab.
  public onOpenGitWorktree: ((path: string, label: string) => void) | null = null;

  /// Fired from the git branch popover "View changes" action.
  /// Wired by main.ts to open the ChangesSurface for the active repo.
  public onViewChanges: (() => void) | null = null;

  constructor(private readonly host: HTMLElement) {
    this.host.classList.add("status-bar");
    this.host.setAttribute("role", "status");
    this.host.setAttribute("aria-live", "off");
    this.startTelegramPolling();
    subscribeOnline((online) => {
      if (this.online === online) return;
      this.online = online;
      this.render(this.lastDirCtx);
    });
    // If the active tab's operator gets deleted, drop the cached
    // entity immediately so the avatar disappears on the next render
    // (otherwise it sticks until the user switches tabs).
    window.addEventListener("operator:deleted", (ev: Event) => {
      const id = (ev as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      if (this.currentOperatorEntity?.id === id) {
        this.currentOperatorEntity = null;
        this.render(this.lastDirCtx);
      }
    });
  }

  private startTelegramPolling(): void {
    const tick = async (): Promise<void> => {
      try {
        const next = await telegramStatus();
        if (next !== this.currentTgStatus) {
          this.currentTgStatus = next;
          this.render(this.lastDirCtx);
        }
      } catch {
        /* backend not ready / command missing — leave as-is */
      }
    };
    void tick();
    window.setInterval(() => void tick(), 5000);
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

  /// Switch between the two-row (default) and single-row status-bar
  /// layouts. Driven by the `experimental.statusbar_two_row` setting,
  /// pushed by `TabManager.setStatusbarTwoRow` on settings save and at
  /// boot. No-op if the value is unchanged.
  setTwoRow(v: boolean): void {
    if (this.twoRow === v) return;
    this.twoRow = v;
    document.body.classList.toggle("statusbar-single-row", !v);
    this.render(this.lastDirCtx);
  }

  /// Pushed by TabManager when the active tab changes (or its
  /// name/color/group changes). Renders a leading chip so the user
  /// can always see which terminal is focused — useful when the
  /// vertical sidebar is collapsed and the tab strip isn't visible.
  setActiveTab(info: ActiveTabInfo | null): void {
    const a = this.currentTab;
    const b = info;
    const same =
      (a === null && b === null) ||
      (a !== null &&
        b !== null &&
        a.name === b.name &&
        a.color === b.color &&
        a.groupName === b.groupName &&
        a.groupColor === b.groupColor);
    if (same) return;
    this.currentTab = info;
    this.render(this.lastDirCtx);
  }

  /// Called by main.ts whenever the active tab changes OR the active
  /// tab emits a cwd_changed event. Null cwd → empty bar (no detection).
  setCwd(cwd: string | null): void {
    if (this.currentCwd === cwd) return;
    this.closeBranchPopover();
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

  setVitals(v: Vitals): void {
    if (!this.vitals) {
      // Lazy: defer creation until first event so the empty cluster
      // never paints before there's data to show.
      this.vitals = new VitalsCluster();
      // Re-render so the cluster appears in the center zone.
      this.render(this.lastDirCtx);
    }
    this.vitals.setVitals(v);
  }

  /// Pushed by TabManager when the active tab's running executor
  /// (claude / aider / opencode / ...) starts or ends — null clears
  /// the chip. Driven off block_started / block_finished + activate.
  setExecutor(name: string | null): void {
    if (this.currentExecutor === name) return;
    this.currentExecutor = name;
    this.render(this.lastDirCtx);
  }

  /// Pushed by TabManager whenever the active tab's Operator state
  /// changes (toggle, AOM auto-enable, tab switch). Replaces the
  /// per-tab pill icon that used to live on every tab. Null collapses
  /// the chip — no operator off "explicit" state, just absence.
  setOperator(
    state: { enabled: boolean; live: boolean } | null,
    sessionId: SessionId | null,
  ): void {
    // Normalize: when not enabled, treat as null. We don't show a chip
    // for "operator off" — that's the silent default.
    const next = state && state.enabled ? state : null;
    const sameState =
      (this.currentOperator?.enabled ?? null) === (next?.enabled ?? null) &&
      (this.currentOperator?.live ?? null) === (next?.live ?? null);
    const sameSession = this.currentSessionId === sessionId;
    if (sameState && sameSession) return;
    this.currentOperator = next;
    // currentSessionId is also tracked by setMission; only overwrite
    // when it's unset, otherwise we'd race the mission renderer.
    if (this.currentSessionId === null && sessionId !== null) {
      this.currentSessionId = sessionId;
    }
    this.render(this.lastDirCtx);
  }

  /// Pushed by TabManager when the active tab's pinned Operator entity
  /// changes (tab switch, setTabOperator, refreshOperatorCache). Null
  /// collapses the chip — no chip for "using default operator".
  setOperatorEntity(op: Operator | null): void {
    if (this.currentOperatorEntity?.id === op?.id) return;
    this.currentOperatorEntity = op;
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

  /// Pushed by TabManager whenever the per-tab exclusion set changes
  /// — on AOM start/stop transitions, on individual toggles, and on
  /// manifest restore. The chip suffix and popover read from this list.
  setExcludedTabs(tabs: ExcludedTabInfo[]): void {
    // Cheap identity check on length + per-tab sessionId/name/cwdShort.
    // sessionId-only would skip a popover refresh after a tab rename
    // — covered here so the popover stays accurate.
    const same =
      this.excludedTabs.length === tabs.length &&
      this.excludedTabs.every((t, i) => {
        const o = tabs[i];
        return (
          o !== undefined &&
          t.sessionId === o.sessionId &&
          t.name === o.name &&
          t.cwdShort === o.cwdShort
        );
      });
    if (same) return;
    this.excludedTabs = tabs;
    // Render the chip FIRST so the popover anchor is positioned
    // against the post-update chip width (the "(N excluded)" segment
    // grows/shrinks with N, shifting layout). If we refreshed the
    // popover first, its bounding-rect computation would use the
    // old chip and the popover could appear misaligned for one frame.
    this.render(this.lastDirCtx);
    if (this.aomPopover) {
      this.refreshExcludedListInPopover();
    }
  }

  private refreshExcludedListInPopover(): void {
    if (!this.aomPopover) return;
    const anchor = this.host.querySelector<HTMLElement>(".status-aom");
    this.closeAomPopover();
    if (anchor) this.openAomPopover(anchor);
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
        <span class="status-aom-pop-icon">${Icons.zap({ size: 14 })}</span>
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
      ${
        this.excludedTabs.length > 0
          ? `
        <div class="status-aom-pop-excluded">
          <div class="status-aom-pop-excluded-title">Excluded from AOM (${this.excludedTabs.length})</div>
          <ul class="status-aom-pop-excluded-list">
            ${this.excludedTabs
              .map(
                (t) => `
              <li>
                <span class="status-aom-pop-excluded-name">${escapeHtml(t.name)}</span>
                ${t.cwdShort ? `<span class="status-aom-pop-excluded-cwd">${escapeHtml(t.cwdShort)}</span>` : ""}
                <button type="button" class="status-aom-pop-excluded-btn" data-session-id="${t.sessionId}">Include</button>
              </li>
            `,
              )
              .join("")}
          </ul>
          ${
            this.excludedTabs.length >= 2
              ? `<button type="button" class="status-aom-pop-include-all">Include all in AOM</button>`
              : ""
          }
        </div>
      `
          : ""
      }
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
    pop.querySelectorAll<HTMLButtonElement>(".status-aom-pop-excluded-btn").forEach(
      (btn) => {
        btn.addEventListener("click", () => {
          const sid = btn.dataset.sessionId;
          if (!sid) return;
          this.aomActions?.onIncludeTab(sid as SessionId);
          this.closeAomPopover();
        });
      },
    );
    pop.querySelector<HTMLButtonElement>(".status-aom-pop-include-all")?.addEventListener(
      "click",
      () => {
        this.aomActions?.onIncludeAll();
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

    // Four-zone layout. Left = stable identity (workspace + git).
    // Framing = agent premise (operator + mission + AOM). Center =
    // adaptive context (currently the active executor — future: token
    // sparkline, suggestions, errors). Right = trailing vitals.
    const left = document.createElement("div");
    left.className = "sb-zone sb-left";
    const framing = document.createElement("div");
    framing.className = "sb-zone sb-framing";
    const center = document.createElement("div");
    center.className = "sb-zone sb-center";
    const right = document.createElement("div");
    right.className = "sb-zone sb-right";

    // ─── LEFT ────────────────────────────────────────────
    if (this.currentTab) left.appendChild(activeTabSegment(this.currentTab));
    if (ctx.git) {
      left.appendChild(this.gitSegment(ctx.git.repo_name, ctx.git.branch));
    }
    // Runtime (node 25.2.1 etc) dropped — vestigial tooling info, not
    // useful for an AI-native terminal's primary chrome. Lives in About.

    // ─── FRAMING ─────────────────────────────────────────
    if (this.currentOperatorEntity) {
      const opEntity = this.currentOperatorEntity;
      const sid = this.currentSessionId;
      const live = this.currentOperator?.live ?? false;
      const enabled = this.currentOperator?.enabled ?? false;
      const btn = document.createElement("button");
      btn.className = "status-chip status-chip-operator";
      if (live) btn.classList.add("is-live");
      else if (!enabled) btn.classList.add("is-off");
      attachTooltip(
        btn,
        live
          ? `Operator: ${opEntity.name} — LIVE (replies typed into this tab). Click to switch.`
          : enabled
            ? `Operator: ${opEntity.name} — dry-run (replies proposed, not typed). Click to switch.`
            : `Operator: ${opEntity.name} — off. Click to switch.`,
      );
      const liveBadge = live ? `<span class="status-chip-operator__live">LIVE</span>` : "";
      btn.innerHTML =
        `<span class="status-chip-operator__dot" style="background:${opEntity.color}"></span>` +
        `<span class="status-chip-operator__name">${escapeHtml(opEntity.name)}</span>` +
        liveBadge;
      btn.addEventListener("click", () => {
        if (sid) this.onOperatorChipClick?.(sid);
      });
      framing.appendChild(btn);
    } else if (this.currentSessionId) {
      const sid = this.currentSessionId;
      framing.appendChild(
        addOperatorSegment(() => this.onOperatorChipClick?.(sid)),
      );
    }
    if (this.currentMission && this.currentSessionId) {
      const sid = this.currentSessionId;
      framing.appendChild(
        missionSegment(
          this.currentMission,
          () => this.openMission(),
          (x, y) => this.openMissionContextMenu(x, y),
          () => this.onMissionClearRequested?.(sid),
        ),
      );
    } else if (
      this.currentSessionId &&
      (ctx.git !== null || ctx.runtime !== null)
    ) {
      const sid = this.currentSessionId;
      framing.appendChild(
        addMissionSegment(() => this.onMissionSetRequested?.(sid)),
      );
    }
    // Fallback OP chip — default-operator case (no pinned entity).
    if (
      !this.currentOperatorEntity &&
      this.currentOperator &&
      this.currentOperator.enabled
    ) {
      framing.appendChild(operatorSegment(this.currentOperator));
    }
    if (this.currentAom) {
      framing.appendChild(
        aomSegment(
          this.currentAom,
          this.excludedTabs.length,
          (anchor) => this.openAomPopover(anchor),
        ),
      );
    }

    // ─── CENTER ──────────────────────────────────────────
    // Vitals cluster owns the center zone on its own. The executor
    // chip used to live here too, but was moved into the right
    // cluster (immediately left of the Telegram icon) so the
    // currently-running agent reads naturally with the other
    // identity/connectivity affordances.
    if (this.vitals) {
      center.appendChild(this.vitals.el);
    }

    // ─── RIGHT ───────────────────────────────────────────
    if (this.currentExecutor) {
      right.appendChild(executorSegment(this.currentExecutor, this.online));
    } else if (!this.online) {
      right.appendChild(offlineSegment());
    }
    right.appendChild(telegramSegment(this.currentTgStatus));
    if (!this.scoreChip) {
      this.scoreChip = makeScoreChip();
      this.scoreChip.setOnClick(() => {
        window.dispatchEvent(new CustomEvent("covenant:open-covenant-settings"));
      });
    }
    void this.scoreChip.refresh();
    right.appendChild(this.scoreChip.el);
    right.appendChild(
      versionSegment(__APP_VERSION__, () => this.onVersionChipClick?.()),
    );

    this.assembleSegments(left, framing, center, right);
  }

  /// Append the four segment groups to `this.host` using the layout
  /// implied by `this.twoRow`.
  ///
  /// Two-row (default): top row carries identity (`left`) + runtime
  /// telemetry (`center`); bottom row carries ephemeral framing
  /// (`framing`) + trailing chrome (`right`). Bottom is shorter and
  /// dimmer per styles.css.
  ///
  /// Single-row (experimental.statusbar_two_row = false): the four
  /// groups appear flat under `this.host` in `left, framing, center,
  /// right` order — the original pre-8aee4f5 layout.
  private assembleSegments(
    left: HTMLElement,
    framing: HTMLElement,
    center: HTMLElement,
    right: HTMLElement,
  ): void {
    if (this.twoRow) {
      const topRow = document.createElement("div");
      topRow.className = "sb-row sb-row--top";
      const botRow = document.createElement("div");
      botRow.className = "sb-row sb-row--bot";
      const topSpacer = document.createElement("div");
      topSpacer.className = "sb-spacer";
      const botSpacer = document.createElement("div");
      botSpacer.className = "sb-spacer";
      topRow.appendChild(left);
      topRow.appendChild(topSpacer);
      topRow.appendChild(center);
      botRow.appendChild(framing);
      botRow.appendChild(botSpacer);
      botRow.appendChild(right);
      this.host.appendChild(topRow);
      this.host.appendChild(botRow);
    } else {
      this.host.appendChild(left);
      this.host.appendChild(framing);
      this.host.appendChild(center);
      this.host.appendChild(right);
    }
  }

  private gitSegment(repoName: string, branch: string): HTMLElement {
    const el = document.createElement("span");
    el.className = "status-segment status-git";
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `Git: ${repoName} on ${branch}. Click to switch branch or open a worktree.`);
    attachTooltip(el, {
      title: `${repoName} · ${branch}`,
      hint: "Click for branches + worktrees",
    });

    const icon = document.createElement("span");
    icon.className = "status-icon";
    icon.innerHTML = GIT_BRANCH_SVG;
    el.appendChild(icon);

    const text = document.createElement("span");
    text.className = "status-text";
    text.textContent = repoName;
    el.appendChild(text);

    const sec = document.createElement("span");
    sec.className = "status-secondary";
    sec.textContent = branch;
    el.appendChild(sec);

    el.addEventListener("click", () => this.openBranchPopover(el));
    el.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      this.openBranchPopover(el);
    });
    return el;
  }

  private openBranchPopover(anchor: HTMLElement): void {
    if (this.branchPopover) {
      this.closeBranchPopover();
      return;
    }
    const cwd = this.currentCwd;
    if (!cwd) return;

    const pop = document.createElement("div");
    pop.className = "status-git-popover";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "Git branch switcher and worktrees");
    pop.innerHTML = `<div class="status-git-pop-loading">Loading git context…</div>`;
    document.body.appendChild(pop);
    this.positionBranchPopover(pop, anchor);
    this.branchPopover = pop;

    const onDocClick = (e: MouseEvent): void => {
      if (!this.branchPopover) return;
      if (this.branchPopover.contains(e.target as Node)) return;
      if (anchor.contains(e.target as Node)) return;
      this.closeBranchPopover();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") this.closeBranchPopover();
    };
    setTimeout(() => {
      document.addEventListener("click", onDocClick);
      document.addEventListener("keydown", onKey);
    }, 0);
    (pop as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    };

    const ticket = ++this.branchPopoverTicket;
    void gitRepoSummary(cwd)
      .then((summary) => {
        if (ticket !== this.branchPopoverTicket || this.branchPopover !== pop) return;
        this.renderBranchPopoverSummary(pop, summary, cwd);
        this.positionBranchPopover(pop, anchor);
      })
      .catch((err) => {
        if (ticket !== this.branchPopoverTicket || this.branchPopover !== pop) return;
        this.renderBranchPopoverError(pop, String(err));
        this.positionBranchPopover(pop, anchor);
      });
  }

  private positionBranchPopover(pop: HTMLElement, anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const width = pop.offsetWidth || 420;
    const height = pop.offsetHeight || 240;
    const left = Math.min(
      Math.max(margin, rect.left),
      Math.max(margin, window.innerWidth - width - margin),
    );
    const above = rect.top - height - 6;
    const top = above >= margin ? above : Math.min(window.innerHeight - height - margin, rect.bottom + 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(margin, top)}px`;
  }

  private renderBranchPopoverSummary(pop: HTMLElement, summary: GitRepoSummary, cwd: string): void {
    const current = currentGitLabel(summary);
    const dirty = summary.dirty_count > 0
      ? `<span class="status-git-pop-dirty">${summary.dirty_count} changed</span>`
      : `<span class="status-git-pop-clean">clean</span>`;
    const sortedBranches = summary.branches
      .filter((b) => b.current || !b.worktree_path)
      .sort((a, b) => {
        if (a.current !== b.current) return a.current ? -1 : 1;
        return 0;
      });
    const branches = sortedBranches.length > 0
      ? sortedBranches.map((b) => {
        const inOtherWorktree = !!b.worktree_path && !b.current;
        const disabled = b.current || inOtherWorktree;
        const meta = [b.upstream, b.last_commit].filter(Boolean).join(" · ");
        const badge = b.current
          ? `<span class="status-git-pop-badge">current</span>`
          : inOtherWorktree
            ? `<span class="status-git-pop-badge">worktree</span>`
            : "";
        return `
          <button type="button" class="status-git-pop-row status-git-pop-branch${b.current ? " is-current" : ""}" data-branch="${escapeHtml(b.name)}" ${disabled ? "disabled" : ""}>
            <span class="status-git-pop-row-main">
              <span class="status-git-pop-row-name">${escapeHtml(b.name)}</span>
              ${meta ? `<span class="status-git-pop-row-meta">${escapeHtml(meta)}</span>` : ""}
            </span>
            ${badge}
          </button>`;
      }).join("")
      : `<div class="status-git-pop-empty">No local branches found.</div>`;

    const worktrees = summary.worktrees.length > 0
      ? summary.worktrees.map((wt) => {
        const label = worktreeLabel(wt);
        const state = wt.current ? "here" : wt.dirty_count > 0 ? `${wt.dirty_count} changed` : "clean";
        return `
          <div class="status-git-pop-row status-git-pop-worktree${wt.current ? " is-current" : ""}">
            <span class="status-git-pop-row-main">
              <span class="status-git-pop-row-name">${escapeHtml(label)}</span>
              <span class="status-git-pop-row-meta">${escapeHtml(compactPath(wt.path))}</span>
            </span>
            <span class="status-git-pop-badge">${escapeHtml(state)}</span>
            <button type="button" class="status-git-pop-open-wt" data-path="${escapeHtml(wt.path)}" data-label="${escapeHtml(label)}" ${wt.current ? "disabled" : ""}>${wt.current ? "Here" : "Open tab"}</button>
          </div>`;
      }).join("")
      : `<div class="status-git-pop-empty">No worktrees reported by git.</div>`;

    pop.innerHTML = `
      <div class="status-git-pop-header">
        <span class="status-git-pop-icon">${GIT_BRANCH_SVG}</span>
        <span class="status-git-pop-title">${escapeHtml(summary.repo_name)}</span>
        <span class="status-git-pop-current">${escapeHtml(current)}</span>
        ${dirty}
      </div>
      <div class="status-git-pop-root">${escapeHtml(compactPath(summary.repo_root))}</div>
      <div class="status-git-pop-search">
        <input type="search" class="status-git-pop-search-input" placeholder="Filter branches & worktrees…" autocomplete="off" spellcheck="false" />
      </div>
      <section class="status-git-pop-section" data-section="branches">
        <h3>Branches</h3>
        <div class="status-git-pop-list">${branches}</div>
        <div class="status-git-pop-empty status-git-pop-no-match" hidden>No matching branches.</div>
      </section>
      <section class="status-git-pop-section" data-section="worktrees">
        <h3>Worktrees</h3>
        <div class="status-git-pop-list">${worktrees}</div>
        <div class="status-git-pop-empty status-git-pop-no-match" hidden>No matching worktrees.</div>
      </section>
      <div class="status-git-pop-actions">
        <button type="button" class="status-git-pop-view-changes">View changes</button>
      </div>
    `;

    const search = pop.querySelector<HTMLInputElement>(".status-git-pop-search-input");
    if (search) {
      const applyFilter = (): void => {
        const q = search.value.trim().toLowerCase();
        pop.querySelectorAll<HTMLElement>("[data-section]").forEach((section) => {
          const rows = section.querySelectorAll<HTMLElement>(".status-git-pop-row");
          let visible = 0;
          rows.forEach((row) => {
            const text = (row.textContent || "").toLowerCase();
            const match = !q || text.includes(q);
            row.hidden = !match;
            if (match) visible++;
          });
          const empty = section.querySelector<HTMLElement>(".status-git-pop-no-match");
          if (empty) empty.hidden = visible > 0 || rows.length === 0;
        });
      };
      search.addEventListener("input", applyFilter);
      search.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && search.value) {
          e.stopPropagation();
          search.value = "";
          applyFilter();
        }
      });
      setTimeout(() => search.focus(), 0);
    }

    pop.querySelectorAll<HTMLButtonElement>(".status-git-pop-branch").forEach((btn) => {
      btn.addEventListener("click", () => {
        const branch = btn.dataset.branch;
        if (!branch || btn.disabled) return;
        void this.switchBranchFromPopover(cwd, branch, pop);
      });
    });
    pop.querySelectorAll<HTMLButtonElement>(".status-git-pop-open-wt").forEach((btn) => {
      btn.addEventListener("click", () => {
        const path = btn.dataset.path;
        const label = btn.dataset.label;
        if (!path || !label) return;
        this.onOpenGitWorktree?.(path, label);
        this.closeBranchPopover();
      });
    });
    pop.querySelector<HTMLButtonElement>(".status-git-pop-view-changes")?.addEventListener("click", () => {
      this.closeBranchPopover();
      this.onViewChanges?.();
    });
  }

  private renderBranchPopoverError(pop: HTMLElement, msg: string): void {
    pop.innerHTML = `
      <div class="status-git-pop-header">
        <span class="status-git-pop-icon">${GIT_BRANCH_SVG}</span>
        <span class="status-git-pop-title">Git</span>
      </div>
      <div class="status-git-pop-error">${escapeHtml(msg)}</div>
    `;
  }

  private async switchBranchFromPopover(cwd: string, branch: string, pop: HTMLElement): Promise<void> {
    pop.innerHTML = `<div class="status-git-pop-loading">Switching to ${escapeHtml(branch)}…</div>`;
    try {
      const summary = await gitSwitchBranch(cwd, branch);
      this.updateGitContextFromSummary(summary);
      this.closeBranchPopover();
      this.render(this.lastDirCtx);
      void this.refresh();
    } catch (err) {
      this.renderBranchPopoverError(pop, String(err));
    }
  }

  private updateGitContextFromSummary(summary: GitRepoSummary): void {
    const branch = currentGitLabel(summary);
    this.lastDirCtx = {
      ...this.lastDirCtx,
      git: {
        repo_name: summary.repo_name,
        branch,
      },
    };
  }

  private closeBranchPopover(): void {
    if (!this.branchPopover) return;
    const cleanup = (this.branchPopover as HTMLElement & { _cleanup?: () => void })._cleanup;
    cleanup?.();
    this.branchPopover.remove();
    this.branchPopover = null;
    this.branchPopoverTicket += 1;
  }

  private async openMission(): Promise<void> {
    const mission = this.currentMission;
    const sessionId = this.currentSessionId;
    if (!mission || !sessionId) return;
    await this.openMissionFor(mission, sessionId);
  }

  /// Right-click on the mission chip: small popover with "Change
  /// mission…" and "Remove mission". Reuses .workspace-rowmenu styles
  /// for visual consistency with the workspace switcher.
  private openMissionContextMenu(x: number, y: number): void {
    const sessionId = this.currentSessionId;
    if (!this.currentMission || !sessionId) return;
    const menu = document.createElement("div");
    menu.className = "workspace-rowmenu";
    menu.style.position = "fixed";
    menu.style.visibility = "hidden";
    menu.style.zIndex = "1001";
    menu.innerHTML = `
      <div class="workspace-rowmenu-item" data-action="edit">Change mission…</div>
      <div class="workspace-rowmenu-item workspace-rowmenu-danger" data-action="clear">Remove mission</div>
    `;
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const PAD = 8;
    let left = x;
    let top = y - rect.height;
    if (left + rect.width + PAD > vw) left = Math.max(PAD, x - rect.width);
    if (top < PAD) top = Math.min(y, vh - rect.height - PAD);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
    const cleanup = () => {
      menu.remove();
      document.removeEventListener("click", onAway, true);
    };
    const onAway = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) cleanup();
    };
    setTimeout(() => document.addEventListener("click", onAway, true), 0);
    menu.addEventListener("click", (e) => {
      const action = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")
        ?.dataset.action;
      if (!action) return;
      cleanup();
      if (action === "edit") this.onMissionEditRequested?.(sessionId);
      else if (action === "clear") this.onMissionClearRequested?.(sessionId);
    });
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

/// Leading active-tab chip. Renders the tab name with a small color
/// dot if the tab has a custom color; if grouped, prefixes the chip
/// with the group name in the group's color. Read-only — selecting
/// tabs still happens via the tabbar.
function activeTabSegment(info: ActiveTabInfo): HTMLElement {
  const el = document.createElement("span");
  el.className = "status-segment status-active-tab";
  attachTooltip(
    el,
    info.groupName ? `Active tab: ${info.groupName} / ${info.name}` : `Active tab: ${info.name}`,
  );

  if (info.color || info.groupColor) {
    const dot = document.createElement("span");
    dot.className = "status-tab-dot";
    dot.style.background = (info.color ?? info.groupColor) as string;
    el.appendChild(dot);
  }

  if (info.groupName) {
    const grp = document.createElement("span");
    grp.className = "status-tab-group";
    if (info.groupColor) {
      grp.style.color = info.groupColor;
    }
    grp.textContent = info.groupName;
    el.appendChild(grp);
    const sep = document.createElement("span");
    sep.className = "status-tab-sep";
    sep.textContent = "›";
    el.appendChild(sep);
  }

  const text = document.createElement("span");
  text.className = "status-text";
  text.textContent = info.name;
  el.appendChild(text);

  return el;
}

function aomSegment(
  aom: AomStatus,
  excludedCount: number,
  onClick: (anchor: HTMLElement) => void,
): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "status-segment status-aom";
  const ratio =
    aom.budget_usd > 0 ? aom.accumulated_cost_usd / aom.budget_usd : 0;
  if (ratio >= 0.8) el.classList.add("status-aom-warn");
  const aomLabel = `AOM running — ${aom.decisions_count} decisions, $${aom.accumulated_cost_usd.toFixed(3)} of $${aom.budget_usd.toFixed(2)} budget. Click for controls.`;
  el.setAttribute("aria-label", aomLabel);
  attachTooltip(el, {
    title: "AOM running",
    meta: `${aom.decisions_count} decisions · $${aom.accumulated_cost_usd.toFixed(3)} of $${aom.budget_usd.toFixed(2)}`,
    hint: "Click for controls",
  });

  const icon = document.createElement("span");
  icon.className = "status-icon";
  icon.innerHTML = Icons.zap({ size: 12 });
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

  if (excludedCount > 0) {
    const sep = document.createElement("span");
    sep.className = "status-segment-sep";
    sep.textContent = "·";
    el.appendChild(sep);

    const excl = document.createElement("span");
    excl.className = "status-secondary status-aom-excluded";
    excl.textContent = `${excludedCount} excluded`;
    el.appendChild(excl);
  }

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

function telegramSegment(status: TelegramStatus): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `status-segment status-tg tg-status tg-${status}`;
  const label =
    status === "ok"
      ? "Telegram connected"
      : status === "error"
        ? "Telegram error — last poll failed"
        : "Telegram disabled — click to configure";
  el.setAttribute("aria-label", label);
  attachTooltip(el, `${label}. Click to open Telegram settings.`);

  const icon = document.createElement("span");
  icon.className = "status-icon";
  icon.innerHTML = telegramIconSvg(12);
  el.appendChild(icon);

  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.dispatchEvent(new CustomEvent("covenant:open-telegram-settings"));
  });
  return el;
}

function versionSegment(version: string, onClick: () => void): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  const isDev = import.meta.env.DEV;
  el.className = isDev ? "status-segment status-version status-version-dev" : "status-segment status-version";
  el.setAttribute("aria-label", `Version ${version}${isDev ? " dev" : ""}. Open release log.`);
  attachTooltip(
    el,
    isDev
      ? `Covenant v${version} (dev build) — click for release log`
      : `Covenant v${version} — click for release log`,
  );

  const text = document.createElement("span");
  text.className = "status-text";
  text.textContent = isDev ? `v${version} [dev]` : `v${version}`;
  el.appendChild(text);

  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return el;
}

/// Operator state for the active tab — replaces the per-tab pill icon
/// that used to live on every tab. Two visual states:
///   - dry-run (enabled, !live): muted bot, label "OP"
///   - live (enabled & live):    warm bot with pulse, label "OP LIVE"
/// Tooltip carries the verbose explanation (we keep the chip terse).
/// No click target — toggling is still done from the tab context menu;
/// adding a status-bar click would duplicate the affordance and surface
/// menu chrome below the chip just to host two items.
function operatorSegment(state: { enabled: boolean; live: boolean }): HTMLElement {
  const el = document.createElement("span");
  const liveCls = state.live ? " status-operator-live" : "";
  el.className = `status-segment status-operator${liveCls}`;
  el.setAttribute(
    "aria-label",
    state.live ? "Operator live" : "Operator enabled, dry-run",
  );
  attachTooltip(
    el,
    state.live
      ? "Operator LIVE — replies will be typed into this tab"
      : "Operator enabled (dry-run) — replies are proposed, not typed",
  );

  const icon = document.createElement("span");
  icon.className = "status-icon";
  icon.innerHTML = Icons.headphones({ size: 12 });
  el.appendChild(icon);

  const text = document.createElement("span");
  text.className = "status-text";
  text.textContent = state.live ? "OP LIVE" : "OP";
  el.appendChild(text);

  return el;
}

/// Per-brand color + display label for known executor agents.
/// Detection is upstream (Rust `detect_executor`); we only style here.
/// Unknown agents fall back to the muted/default treatment so a new
/// CLI doesn't show up uncolored — it just shows up neutral.
function executorBrand(name: string): { color: string; label: string } | null {
  // Brand colors sourced from each vendor's primary mark on dark UI:
  //   Claude    — Anthropic "kraft" terracotta used across claude.ai
  //   Copilot   — GitHub primary blue (the same one used on github.com)
  //   opencode  — SST signature orange (opencode.ai / sst.dev palette)
  //   aider     — terminal lime, no official brand — picked to read as
  //               "shell-native" without colliding with codex green
  //   Cursor    — monochrome white (their brand is grayscale)
  //   Codex     — OpenAI teal-green (chatgpt.com / openai.com primary)
  //   Pi        — Pi's startup/help accent teal
  //   Hermes    — Nous Research amber/gold (nousresearch.com brand palette)
  switch (name.toLowerCase()) {
    case "claude":
      return { color: "#cc785c", label: "Claude" };
    case "copilot":
      return { color: "#0969da", label: "Copilot" };
    case "opencode":
      return { color: "#fb923c", label: "opencode" };
    case "aider":
      return { color: "#84cc16", label: "aider" };
    case "cursor":
      return { color: "#e5e7eb", label: "Cursor" };
    case "codex":
      return { color: "#10a37f", label: "Codex" };
    case "pi":
      return { color: "#8fd3c7", label: "Pi" };
    case "hermes":
      return { color: "#d4a857", label: "Hermes" };
    default:
      return null;
  }
}

function executorSegment(name: string, online: boolean = true): HTMLElement {
  const el = document.createElement("span");
  const brand = executorBrand(name);
  const offlineCls = online ? "" : " status-executor--offline";
  el.className = (brand
    ? "status-segment status-executor status-executor-brand"
    : "status-segment status-executor") + offlineCls;
  attachTooltip(
    el,
    online
      ? `Running ${brand?.label ?? name} in this tab`
      : `${brand?.label ?? name} unavailable — no internet`,
  );
  el.setAttribute(
    "aria-label",
    online
      ? `Executor: ${brand?.label ?? name}`
      : `Executor: ${brand?.label ?? name} (offline)`,
  );
  if (brand) {
    el.style.setProperty("--executor-brand", brand.color);
  }

  if (brand) {
    // Branded form: vendor SVG (or a pulsing color dot fallback if we
    // don't ship a glyph for this vendor) + brand-tinted name. The
    // SVG inherits color from --executor-brand via currentColor.
    const svg = brandIconSvg(name, 12);
    if (svg) {
      const iconWrap = document.createElement("span");
      iconWrap.className = "status-executor__icon";
      iconWrap.innerHTML = svg;
      el.appendChild(iconWrap);
    } else {
      const dot = document.createElement("span");
      dot.className = "status-executor__dot";
      el.appendChild(dot);
    }

    const text = document.createElement("span");
    text.className = "status-text";
    text.textContent = brand.label;
    el.appendChild(text);
  } else {
    // Fallback: keep the original bot+name treatment for unknown agents.
    const icon = document.createElement("span");
    icon.className = "status-icon";
    icon.innerHTML = Icons.bot({ size: 12 });
    el.appendChild(icon);

    const text = document.createElement("span");
    text.className = "status-text";
    text.textContent = name;
    el.appendChild(text);
  }
  if (!online) {
    const reason = document.createElement("span");
    reason.className = "status-executor__reason";
    reason.textContent = "no internet";
    el.appendChild(reason);
  }
  return el;
}

/// Standalone connectivity chip. Surfaced only when offline AND no
/// executor is running (otherwise the executor chip itself carries
/// the offline state via .status-executor--offline + reason tag).
function offlineSegment(): HTMLElement {
  const el = document.createElement("span");
  el.className = "status-segment status-offline";
  attachTooltip(el, "No internet connection — Claude unavailable");
  el.setAttribute("aria-label", "Offline — no internet connection");
  el.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 1l22 22"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>' +
    '<span class="status-text">no internet</span>';
  return el;
}

function missionSegment(
  mission: MissionInfo,
  onClick: () => void,
  onContextMenu: (x: number, y: number) => void,
  onRemove: () => void,
): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  // Kind-aware modifier so Superpowers missions read distinctly from
  // Covenant ones at a glance (different accent + icon).
  el.className = `status-segment status-mission status-mission--${mission.kind}`;
  const kindLabel = mission.kind === "superpowers" ? "Superpowers" : "Covenant";
  el.setAttribute(
    "aria-label",
    `${kindLabel} mission: ${mission.path}. Click to view full spec.`,
  );
  attachTooltip(el, {
    title: `${kindLabel} mission`,
    subtitle: mission.path,
    meta: mission.plan
      ? `${mission.plan.tasks_done}/${mission.plan.tasks_total} tasks done`
      : mission.kind === "superpowers"
        ? "no plan attached"
        : undefined,
    preview: mission.content_preview,
    hint: "Click to open spec",
  });

  const icon = document.createElement("span");
  icon.className = "status-icon";
  icon.innerHTML =
    mission.kind === "superpowers"
      ? Icons.sparkles({ size: 12 })
      : Icons.target({ size: 12 });
  el.appendChild(icon);

  const text = document.createElement("span");
  text.className = "status-text";
  // Truncation is CSS (max-width + ellipsis). The full basename stays in
  // the hover tooltip + aria-label so nothing is lost when it's clipped.
  text.textContent = basename(mission.path);
  el.appendChild(text);

  // Hover-revealed remove affordance. A <span role=button> rather than a
  // nested <button> (which is invalid inside the chip's <button>). Clicking
  // it clears the mission and must NOT bubble into the chip's open-spec
  // click — hence stopPropagation before onRemove.
  const remove = document.createElement("span");
  remove.className = "status-mission-remove";
  remove.setAttribute("role", "button");
  remove.setAttribute("tabindex", "0");
  remove.setAttribute("aria-label", "Remove mission");
  remove.innerHTML = Icons.x({ size: 11 });
  attachTooltip(remove, "Remove mission from this tab");
  const fireRemove = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    onRemove();
  };
  remove.addEventListener("click", fireRemove);
  remove.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fireRemove(e);
  });
  el.appendChild(remove);

  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e.clientX, e.clientY);
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
  attachTooltip(el, "Set mission for this tab — anchor scope and constraints");
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

/// Subtle "Set operator" affordance — sibling of addMissionSegment.
/// Shown when the active tab has no pinned Operator entity. Click
/// opens the OperatorPicker (⌘⇧O). Uses the bot icon to match the
/// operator visual vocabulary used elsewhere.
function addOperatorSegment(onClick: () => void): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "status-segment status-add-operator";
  attachTooltip(el, "Pin an Operator to this tab");
  el.setAttribute("aria-label", "Set operator");

  const icon = document.createElement("span");
  icon.className = "status-icon";
  icon.innerHTML = Icons.headphones({ size: 12 });
  el.appendChild(icon);

  const text = document.createElement("span");
  text.className = "status-text";
  text.textContent = "Set operator";
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

/// Build the plan-progress section skeleton (heading + empty list). The
/// list is filled in by `fillPlanSection` once the plan body resolves.
function renderPlanSection(plan: MissionPlanInfo): HTMLElement {
  const section = document.createElement("section");
  section.className = "mission-overlay-plan";

  const heading = document.createElement("h4");
  heading.textContent = `Plan progress (${plan.tasks_done}/${plan.tasks_total})`;
  section.appendChild(heading);

  const path = document.createElement("code");
  path.className = "mission-overlay-plan-path";
  path.textContent = plan.path;
  section.appendChild(path);

  const list = document.createElement("ul");
  list.className = "mission-overlay-plan-list";
  const loading = document.createElement("li");
  loading.className = "mission-overlay-plan-loading";
  loading.textContent = "Loading plan…";
  list.appendChild(loading);
  section.appendChild(list);
  return section;
}

/// Replace the placeholder list with one `<li>` per `- [ ]` / `- [x]`
/// line in the plan body. Lines outside that pattern are skipped — we
/// want a tight progress strip, not a full markdown render.
function fillPlanSection(section: HTMLElement, body: string | null): void {
  const list = section.querySelector<HTMLElement>(".mission-overlay-plan-list");
  if (!list) return;
  list.innerHTML = "";
  if (body === null) {
    const li = document.createElement("li");
    li.className = "mission-overlay-plan-empty";
    li.textContent = "(plan unavailable)";
    list.appendChild(li);
    return;
  }
  let appended = 0;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/^\s+/, "");
    const done = line.startsWith("- [x] ") || line.startsWith("- [X] ");
    const pending = line.startsWith("- [ ] ");
    if (!done && !pending) continue;
    const text = line.slice(6);
    const li = document.createElement("li");
    li.className = done ? "done" : "pending";
    li.textContent = (done ? "✓ " : "○ ") + text;
    list.appendChild(li);
    appended += 1;
  }
  if (appended === 0) {
    const li = document.createElement("li");
    li.className = "mission-overlay-plan-empty";
    li.textContent = "(no checklist tasks found)";
    list.appendChild(li);
  }
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

  /// In-modal find (⌘F / Ctrl+F), view mode only. `findOpen` survives a
  /// body re-render (Source⇄Rendered toggle) so the bar reappears and the
  /// query re-applies; `findMarks` are the live <mark> hits in doc order.
  private findOpen = false;
  private findBar: HTMLElement | null = null;
  private findInput: HTMLInputElement | null = null;
  private findMarks: HTMLElement[] = [];
  private findActive = -1;
  private findQuery = "";

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
    this.resetFind();
    this.overlay.remove();
    this.overlay = null;
    this.mission = null;
    this.content = "";
    this.sessionId = null;
    this.mode = "view";
    document.removeEventListener("keydown", this.escListener);
    document.removeEventListener("keydown", this.findKeyListener);
  }

  private escListener = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !this.overlay) return;
    // Find bar takes priority: Esc closes the find first, leaving the modal
    // open (only a second Esc closes the modal).
    if (this.findBar) {
      e.preventDefault();
      this.closeFind();
      return;
    }
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

  /// ⌘F / Ctrl+F opens (or focuses) the find bar in view mode. In edit
  /// mode we leave it to the textarea / native behavior.
  private findKeyListener = (e: KeyboardEvent): void => {
    if (!this.overlay || this.mode !== "view") return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
      e.preventDefault();
      this.openFind();
    }
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
    document.addEventListener("keydown", this.findKeyListener);
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
      attachTooltip(
        toggleBtn,
        showingRendered ? "Show raw markdown source" : "Show rendered markdown",
      );
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
      attachTooltip(
        editBtn,
        this.aomActive ? "Mission locked while AOM is running" : "Edit mission",
      );
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
    body.innerHTML = "";
    if (this.content.trim() === "") {
      const empty = document.createElement("div");
      empty.className = "mission-viewer-empty";
      empty.textContent = "spec file is empty";
      body.appendChild(empty);
    } else if (this.viewKind === "rendered") {
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

    // Plan progress strip — read-only summary appended below the spec
    // body when the mission has a paired plan file. Fetched lazily; we
    // render a placeholder section synchronously so layout doesn't shift
    // when the body resolves.
    if (this.mission?.plan && this.sessionId) {
      const section = renderPlanSection(this.mission.plan);
      body.appendChild(section);
      const sessionId = this.sessionId;
      const expectedMissionPath = this.mission.path;
      void getSessionPlanContent(sessionId)
        .then((planBody) => {
          // Bail if the modal has moved on (mission swapped or closed)
          // — we'd be writing into a stale node otherwise.
          if (!this.overlay || this.mission?.path !== expectedMissionPath) {
            return;
          }
          fillPlanSection(section, planBody);
        })
        .catch((err) => {
          console.error("get_session_plan_content failed", err);
          fillPlanSection(section, null);
        });
    }

    // The body innerHTML was wiped above, taking any open find bar + marks
    // with it. If find was open (e.g. user toggled Source⇄Rendered), rebuild
    // it and re-apply the query against the fresh content.
    if (this.findOpen) {
      this.findBar = null;
      this.findInput = null;
      this.findMarks = [];
      this.findActive = -1;
      this.mountFindBar();
      this.runFind(this.findQuery);
      requestAnimationFrame(() => this.findInput?.focus());
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
    this.resetFind();
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

  // ── In-modal find (⌘F / Ctrl+F) ──────────────────────────────────────────

  /// Open the find bar (or just refocus it if already open).
  private openFind(): void {
    if (this.mode !== "view") return;
    this.findOpen = true;
    if (!this.findBar) {
      this.mountFindBar();
      if (this.findQuery) this.runFind(this.findQuery);
    }
    requestAnimationFrame(() => {
      this.findInput?.focus();
      this.findInput?.select();
    });
  }

  /// Close the find bar and forget the query (next ⌘F starts fresh).
  private closeFind(): void {
    this.findQuery = "";
    this.resetFind();
  }

  /// Tear down highlights + bar and mark find as closed. Callers decide
  /// whether to also clear `findQuery` (closeFind does; close/enterEdit
  /// leave it, though the modal is going away anyway).
  private resetFind(): void {
    this.findOpen = false;
    clearMarks(this.findMarks);
    this.findMarks = [];
    this.findActive = -1;
    this.findBar?.remove();
    this.findBar = null;
    this.findInput = null;
  }

  private mountFindBar(): void {
    const body = this.bodyEl();
    if (!body || this.findBar) return;

    const bar = document.createElement("div");
    bar.className = "mv-find";
    bar.innerHTML = `
      <input class="mv-find-input" type="text" placeholder="Find in spec" spellcheck="false" autocomplete="off" autocapitalize="off" />
      <span class="mv-find-counter" aria-live="polite"></span>
      <button type="button" class="mv-find-nav" data-dir="prev" aria-label="Previous match">↑</button>
      <button type="button" class="mv-find-nav" data-dir="next" aria-label="Next match">↓</button>
      <button type="button" class="mv-find-close" aria-label="Close find">${Icons.x({ size: 12 })}</button>
    `;

    const input = bar.querySelector<HTMLInputElement>(".mv-find-input")!;
    input.value = this.findQuery;
    input.addEventListener("input", () => this.runFind(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.gotoFind(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        // Swallow so the modal's Esc handler doesn't also fire.
        e.preventDefault();
        e.stopPropagation();
        this.closeFind();
      }
    });

    bar
      .querySelector<HTMLButtonElement>('[data-dir=prev]')!
      .addEventListener("click", () => {
        this.gotoFind(-1);
        this.findInput?.focus();
      });
    bar
      .querySelector<HTMLButtonElement>('[data-dir=next]')!
      .addEventListener("click", () => {
        this.gotoFind(1);
        this.findInput?.focus();
      });
    bar
      .querySelector<HTMLButtonElement>(".mv-find-close")!
      .addEventListener("click", () => this.closeFind());

    body.insertBefore(bar, body.firstChild);
    this.findBar = bar;
    this.findInput = input;
    this.updateFindCounter();
  }

  /// Re-run the search for `query`: clear old marks, wrap new ones, select
  /// the first hit.
  private runFind(query: string): void {
    this.findQuery = query;
    clearMarks(this.findMarks);
    this.findMarks = [];
    const content = this.overlay?.querySelector<HTMLElement>(".mission-viewer-content");
    if (content && query) this.findMarks = highlightMatches(content, query);
    this.findActive = this.findMarks.length ? 0 : -1;
    this.updateFindActive(true);
    this.updateFindCounter();
  }

  private gotoFind(delta: number): void {
    if (this.findMarks.length === 0) return;
    const n = this.findMarks.length;
    this.findActive = (this.findActive + delta + n) % n;
    this.updateFindActive(true);
    this.updateFindCounter();
  }

  private updateFindActive(scroll: boolean): void {
    this.findMarks.forEach((m, i) =>
      m.classList.toggle("is-active", i === this.findActive),
    );
    if (scroll && this.findActive >= 0) {
      this.findMarks[this.findActive].scrollIntoView({ block: "center" });
    }
  }

  private updateFindCounter(): void {
    const el = this.findBar?.querySelector<HTMLElement>(".mv-find-counter");
    if (!el) return;
    if (!this.findQuery) el.textContent = "";
    else if (this.findMarks.length === 0) el.textContent = "0/0";
    else el.textContent = `${this.findActive + 1}/${this.findMarks.length}`;
  }

  private bodyEl(): HTMLElement | null {
    return this.overlay?.querySelector<HTMLElement>(".mission-viewer-body") ?? null;
  }
}

function currentGitLabel(summary: GitRepoSummary): string {
  if (summary.current_branch) return summary.current_branch;
  if (summary.detached_head) return `DETACHED@${summary.detached_head}`;
  return "DETACHED";
}

function worktreeLabel(wt: GitWorktreeSummary): string {
  if (wt.branch) return wt.branch;
  if (wt.detached && wt.head) return `DETACHED@${wt.head.slice(0, 7)}`;
  if (wt.bare) return `${basename(wt.path)} (bare)`;
  return basename(wt.path);
}

function compactPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
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
