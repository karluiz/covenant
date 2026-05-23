// ⌘O — Operator decisions page.
//
// Lists recent decisions the Operator has proposed. The subtitle adapts
// to the current mode: "AOM live" when AOM is active, "Dry-run" otherwise.
//
// Rendered as a full PAGE (mirrors settings/docs): shares row 2 of
// #layout with #workspace, replacing it while open. Esc closing is
// routed by main.ts's global keydown handler.
//
// Auto-refreshes when the backend emits "operator-decision" via Tauri.
// Also re-checks AOM status on each refresh so the subtitle stays in
// sync without needing a separate event subscription.
//
// Insight layer (frontend-only): per-row chips for tab display name,
// executor agent (parsed from in_flight_command), and the tab's CURRENT
// mission. Filter pills (action) + tab dropdown + executed-only toggle
// trim the list in memory; counters live next to the subtitle. Filter
// state is persisted in localStorage so the panel reopens as left.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { aomStatus, listOperatorDecisions, operatorLevelFromXp, operatorList, type MindUpdatedEvent, type Operator, type OperatorDecisionRow } from "../api";
import { renderAvatarHtml } from "./avatars";
import { CustomSelect } from "../ui/select";
import { detectExecutor } from "../executor";
import type { TabManager } from "../tabs/manager";

const LIMIT = 200;

type ActionFilter = "all" | "reply" | "wait" | "escalate";

interface FilterState {
  action: ActionFilter;
  session: string | "all";
  executedOnly: boolean;
  operatorFilter: string | "all";
}

const PREF_KEY = "covenant.operator-panel.filter";

function loadPrefs(): FilterState {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return { action: "all", session: "all", executedOnly: false, operatorFilter: "all" };
    const p = JSON.parse(raw) as Partial<FilterState>;
    return {
      action: (p.action ?? "all") as ActionFilter,
      session: p.session ?? "all",
      executedOnly: !!p.executedOnly,
      operatorFilter: p.operatorFilter ?? "all",
    };
  } catch {
    return { action: "all", session: "all", executedOnly: false, operatorFilter: "all" };
  }
}

function savePrefs(p: FilterState): void {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* quota / private mode — fine to skip */
  }
}

export class OperatorPanel {
  private isOpenState = false;
  /// Optional callback fired when the page closes (any reason). Used by
  /// main.ts to refit the active terminal once the workspace returns.
  public onClosed: (() => void) | null = null;
  private listEl: HTMLElement | null = null;
  private subtitleEl: HTMLElement | null = null;
  private countersEl: HTMLElement | null = null;
  private filtersEl: HTMLElement | null = null;
  private unlisten: UnlistenFn | null = null;
  private unlistenXp: UnlistenFn | null = null;
  /// Spec 3.20 phase 6: live mind snapshot for the currently-filtered
  /// session. Map keyed by full session_id (mind events carry the full
  /// id; we match on the trailing 6 chars used by the filter).
  private unlistenMind: UnlistenFn | null = null;
  private mindBySession: Map<string, MindUpdatedEvent> = new Map();
  private mindEl: HTMLElement | null = null;
  private rows: OperatorDecisionRow[] = [];
  private filter: FilterState = loadPrefs();
  /// Decision IDs (the head row of a collapsed group) the user has
  /// chosen to expand. Survives in-panel re-renders driven by streaming
  /// "operator-decision" events; cleared on close. Not persisted to
  /// localStorage — expansion is a transient view state.
  private expandedGroups: Set<number> = new Set();
  private operatorCache: Map<string, Operator> = new Map();
  /// Custom combobox mounted in place of the operator dropdown. Native
  /// options are text-only — pack-avatar PNGs can't render inside them —
  /// so we use a button + popover that supports avatars.
  private operatorCombo: AvatarCombobox | null = null;

  constructor(
    private readonly pageHost: HTMLElement,
    private readonly workspace: HTMLElement,
    private readonly manager: TabManager,
  ) {}

  private async refreshOperatorCache(): Promise<void> {
    try {
      const ops = await operatorList();
      this.operatorCache.clear();
      for (const op of ops) {
        this.operatorCache.set(op.id, op);
      }
      // Re-render filters after the cache is populated so the operator
      // dropdown reflects the current operator list.
      this.renderFilters();
    } catch {
      // Non-fatal — chips fall back to neutral color.
    }
  }

  isOpen(): boolean {
    return this.isOpenState;
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
    await Promise.all([this.refresh(), this.refreshSubtitle(), this.refreshOperatorCache()]);

    // Auto-refresh on new decisions while the panel is open. Also
    // bounce the subtitle in case AOM toggled between events.
    this.unlisten = await listen("operator-decision", () => {
      void this.refresh();
      void this.refreshSubtitle();
    });
    // 3.12 — patch the cached operator's XP in place so the per-row
    // "Lv N" badge updates live after every decision without a full
    // operatorList round-trip.
    this.unlistenXp = await listen<{ operator_id: string; xp: number }>(
      "operator-xp-updated",
      (event) => {
        const cached = this.operatorCache.get(event.payload.operator_id);
        if (cached) {
          cached.xp = event.payload.xp;
          this.render();
        }
      },
    );
    // Spec 3.20 phase 6: subscribe to mind-state updates so the mind
    // section stays live while the panel is open.
    this.unlistenMind = await listen<MindUpdatedEvent>(
      "operator-mind-updated",
      (event) => {
        this.mindBySession.set(event.payload.session_id, event.payload);
        this.renderMindSection();
      },
    );
  }

  close(): void {
    if (!this.isOpenState) return;
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    if (this.unlistenXp) {
      this.unlistenXp();
      this.unlistenXp = null;
    }
    if (this.unlistenMind) {
      this.unlistenMind();
      this.unlistenMind = null;
    }
    this.mindEl = null;
    if (this.operatorCombo) {
      this.operatorCombo.destroy();
      this.operatorCombo = null;
    }
    this.pageHost.innerHTML = "";
    this.pageHost.hidden = true;
    this.workspace.hidden = false;
    this.isOpenState = false;
    this.listEl = null;
    this.subtitleEl = null;
    this.countersEl = null;
    this.filtersEl = null;
    this.expandedGroups.clear();
    if (this.onClosed) this.onClosed();
  }

  private render(): void {
    this.pageHost.innerHTML = `
      <header class="operator-page-header">
        <div class="operator-page-titles">
          <h2>Operator decisions</h2>
          <small class="operator-subtitle">checking mode…</small>
          <small class="operator-counters"></small>
        </div>
        <button type="button" class="operator-close" aria-label="Close" title="Close (Esc)">×</button>
      </header>
      <div class="operator-filters" role="toolbar" aria-label="Filters"></div>
      <section class="operator-mind-section" hidden></section>
      <div class="operator-list" tabindex="-1">loading…</div>
    `;

    this.pageHost
      .querySelector<HTMLButtonElement>(".operator-close")!
      .addEventListener("click", () => this.close());

    this.workspace.hidden = true;
    this.pageHost.hidden = false;
    this.isOpenState = true;

    this.listEl = this.pageHost.querySelector<HTMLElement>(".operator-list");
    this.subtitleEl = this.pageHost.querySelector<HTMLElement>(".operator-subtitle");
    this.countersEl = this.pageHost.querySelector<HTMLElement>(".operator-counters");
    this.filtersEl = this.pageHost.querySelector<HTMLElement>(".operator-filters");
    this.mindEl = this.pageHost.querySelector<HTMLElement>(".operator-mind-section");
    this.renderFilters();
    this.renderMindSection();
  }

  /// Spec 3.20 phase 6: render the live mind for the currently-filtered
  /// session. Hidden when the filter is "all" (no single session in
  /// focus) or when no mind event has arrived yet for that session.
  private renderMindSection(): void {
    if (!this.mindEl) return;
    const sessionShort = this.filter.session;
    if (sessionShort === "all") {
      this.mindEl.hidden = true;
      this.mindEl.innerHTML = "";
      return;
    }
    // Match by trailing 6 chars (storage::shorten convention).
    let mind: MindUpdatedEvent | null = null;
    for (const [fullId, snap] of this.mindBySession) {
      if (fullId.endsWith(sessionShort)) {
        mind = snap;
        break;
      }
    }
    if (!mind) {
      this.mindEl.hidden = true;
      this.mindEl.innerHTML = "";
      return;
    }
    this.mindEl.hidden = false;
    const esc = mindEscape;
    const triedFailedHtml = mind.tried_failed.length
      ? `<details class="mind-tried-failed"><summary>Tried &amp; failed (${mind.tried_failed.length})</summary><ul>${mind.tried_failed.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></details>`
      : "";
    const recentHtml = mind.recent
      .map(
        (r) => `
          <details class="mind-turn">
            <summary>#${r.turn} · ${esc(r.action_kind)} ${esc((r.action_summary || "").slice(0, 60))}${r.executed ? "" : "<span class=\"blocked\">blocked</span>"}</summary>
            <div class="thought"><b>thought:</b> ${esc(r.thought)}</div>
            <div class="saw"><b>saw:</b> <pre>${esc(r.saw)}</pre></div>
          </details>
        `,
      )
      .join("");
    this.mindEl.innerHTML = `
      <div class="mind-block">
        <div class="mind-belief"><span class="label">Belief</span><span class="value">${esc(mind.belief || "—")}</span></div>
        <div class="mind-intent"><span class="label">Next intent</span><span class="value">${esc(mind.next_intent || "—")}</span></div>
        ${triedFailedHtml}
        <div class="mind-recent">
          <div class="label">Recent ${mind.recent.length} turn${mind.recent.length === 1 ? "" : "s"}</div>
          ${recentHtml}
        </div>
      </div>
    `;
  }

  /// Filter bar: action pills (All / Reply / Wait / Escalate), session
  /// dropdown (built from distinct rows), executed-only toggle. Counts
  /// in pill labels reflect the FULL row set so the user sees what's
  /// hiding behind a filter.
  private renderFilters(): void {
    if (!this.filtersEl) return;
    const actionCounts = countByAction(this.rows);
    // Order sessions by most-recent decision so the dropdown reads
    // chronologically. For each, snapshot the latest row's executor +
    // mission so closed-tab options carry context instead of just an
    // opaque short id.
    const sessionMeta = new Map<
      string,
      { executor: string | null; mission: string | null; latestMs: number }
    >();
    for (const r of this.rows) {
      const prev = sessionMeta.get(r.session_id_short);
      if (prev && prev.latestMs >= r.timestamp_unix_ms) continue;
      const executor =
        r.executor_name ??
        (r.in_flight_command ? detectExecutor(r.in_flight_command) : null);
      sessionMeta.set(r.session_id_short, {
        executor,
        mission: r.mission_path,
        latestMs: r.timestamp_unix_ms,
      });
    }
    const sessionShorts = Array.from(sessionMeta.entries())
      .sort((a, b) => b[1].latestMs - a[1].latestMs)
      .map(([s]) => s);

    const pill = (key: ActionFilter, label: string, n: number): string => {
      const active = this.filter.action === key ? " operator-pill-active" : "";
      return `<button type="button" class="operator-pill${active}" data-action="${key}">${label}<span class="operator-pill-count">${n}</span></button>`;
    };

    const sessionOptions = [
      { value: "all", label: "All tabs" },
      ...sessionShorts.map((s) => {
        const info = this.manager.tabBySessionShort(s);
        const meta = sessionMeta.get(s)!;
        return { value: s, label: formatSessionLabel(s, info, meta) };
      }),
    ];

    const total = this.rows.length;
    this.filtersEl.innerHTML = `
      <div class="operator-pills">
        ${pill("all", "All", total)}
        ${pill("reply", "Reply", actionCounts.reply)}
        ${pill("wait", "Wait", actionCounts.wait)}
        ${pill("escalate", "Escalate", actionCounts.escalate)}
      </div>
      <div class="operator-filter-controls">
        <label class="operator-filter-label">
          Tab
          <span data-role="session-select"></span>
        </label>
        <label class="operator-filter-label">
          Operator
          <span class="operator-operator-combo" data-role="operator-combo"></span>
        </label>
        <label class="operator-filter-toggle">
          <input type="checkbox" class="operator-executed-only"${this.filter.executedOnly ? " checked" : ""}>
          Executed only
        </label>
      </div>
    `;

    this.filtersEl
      .querySelectorAll<HTMLButtonElement>(".operator-pill")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.dataset.action as ActionFilter;
          this.filter.action = key;
          savePrefs(this.filter);
          this.renderFilters();
          this.renderList();
        });
      });

    const sessionSelect = new CustomSelect({
      className: "operator-session-select",
      ariaLabel: "Filter by tab",
      value: this.filter.session,
      options: sessionOptions,
    });
    this.filtersEl
      .querySelector<HTMLElement>('[data-role="session-select"]')!
      .replaceWith(sessionSelect.element);
    sessionSelect.element.addEventListener("change", () => {
      this.filter.session = sessionSelect.value;
      savePrefs(this.filter);
      this.renderList();
      this.renderMindSection();
    });

    // Custom operator combobox — supports avatar PNGs in both the
    // closed-state button and the popover list (native options can't).
    // Re-mounted on every renderFilters; the prior instance is destroyed
    // first so any open popover doesn't get orphaned on document.body.
    this.operatorCombo?.destroy();
    const comboHost = this.filtersEl.querySelector<HTMLElement>(
      '[data-role="operator-combo"]',
    );
    if (comboHost) {
      const opts: ComboOption[] = [
        { value: "all", label: "All operators", avatar: null },
        ...Array.from(this.operatorCache.values()).map((op) => ({
          value: op.id,
          label: op.name,
          avatar: op.emoji,
        })),
      ];
      this.operatorCombo = new AvatarCombobox(
        comboHost,
        opts,
        this.filter.operatorFilter,
        (value) => {
          this.filter.operatorFilter = value;
          savePrefs(this.filter);
          this.renderList();
        },
      );
    }

    this.filtersEl
      .querySelector<HTMLInputElement>(".operator-executed-only")!
      .addEventListener("change", (e) => {
        this.filter.executedOnly = (e.target as HTMLInputElement).checked;
        savePrefs(this.filter);
        this.renderList();
      });
  }

  /// Re-fetch AOM state and update the subtitle so it reflects whether
  /// decisions are being typed (AOM) or merely proposed (dry-run).
  /// Cheap call — we run it on every refresh so the panel never gets
  /// stuck showing the wrong mode after AOM toggles.
  private async refreshSubtitle(): Promise<void> {
    if (!this.subtitleEl) return;
    try {
      const status = await aomStatus();
      if (status.enabled) {
        this.subtitleEl.textContent =
          "AOM live — replies auto-submit on every Operator-included tab.";
        this.subtitleEl.classList.add("operator-subtitle-live");
      } else {
        this.subtitleEl.textContent =
          "Dry-run — proposals only. Enable Operator + Live (or AOM) on a tab to actually type.";
        this.subtitleEl.classList.remove("operator-subtitle-live");
      }
    } catch {
      // Don't blow up the panel for a missing aomStatus — leave whatever
      // subtitle was last shown.
    }
  }

  private async refresh(): Promise<void> {
    if (!this.listEl) return;
    try {
      this.rows = await listOperatorDecisions(LIMIT);
    } catch (err) {
      this.listEl.textContent = `failed to load: ${String(err)}`;
      return;
    }
    this.renderFilters();
    this.renderList();
  }

  /// Apply the current filter to `this.rows` and rebuild the list DOM.
  /// Counters in the subtitle reflect the *visible* slice so the user
  /// sees how the active filter narrowed the set.
  private renderList(): void {
    if (!this.listEl) return;

    const visible = this.rows.filter((r) => {
      if (this.filter.action !== "all" && r.action !== this.filter.action) {
        return false;
      }
      if (
        this.filter.session !== "all" &&
        r.session_id_short !== this.filter.session
      ) {
        return false;
      }
      if (this.filter.executedOnly && !r.executed) return false;
      if (
        this.filter.operatorFilter !== "all" &&
        r.operator_id !== this.filter.operatorFilter
      ) {
        return false;
      }
      return true;
    });

    if (this.countersEl) {
      const c = countByAction(visible);
      const parts: string[] = [];
      if (c.wait > 0) parts.push(`${c.wait} WAIT`);
      if (c.reply > 0) parts.push(`${c.reply} REPLY`);
      if (c.escalate > 0) parts.push(`${c.escalate} ESCALATE`);
      this.countersEl.textContent =
        visible.length === 0
          ? ""
          : `${visible.length} shown · ${parts.join(" · ")}`;
    }

    if (this.rows.length === 0) {
      this.listEl.innerHTML = `
        <div class="operator-empty">
          No decisions yet. Enable the Operator on a tab (right-click →
          "Enable operator") and run an executor agent (claude, copilot,
          opencode, aider…) that pauses for input.
        </div>
      `;
      return;
    }
    if (visible.length === 0) {
      this.listEl.innerHTML = `
        <div class="operator-empty">
          No decisions match the current filter.
        </div>
      `;
      return;
    }

    const groups = groupConsecutive(visible);
    this.listEl.innerHTML = groups
      .map((g) => this.renderGroup(g))
      .join("");

    // Delegated handler for the group expand/collapse toggle. Single
    // listener since we re-render the whole list on every refresh.
    this.listEl
      .querySelectorAll<HTMLElement>(".op-group-toggle")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const idStr = btn.dataset.headId;
          if (!idStr) return;
          const id = Number(idStr);
          if (this.expandedGroups.has(id)) this.expandedGroups.delete(id);
          else this.expandedGroups.add(id);
          this.renderList();
        });
      });
  }

  /// Render one group. count==1 → just the row. count>1 → the head row
  /// adorned with a `×N · last <age>` badge that toggles expansion;
  /// when expanded, the remaining rows render below (newer at top so
  /// they read chronologically against the head's "last" timestamp).
  private renderGroup(g: Group): string {
    if (g.rows.length === 1) return this.renderRow(g.rows[0], { groupBadge: "" });

    const head = g.rows[0];
    const expanded = this.expandedGroups.has(head.id);
    const lastAge = humanizeAge(Date.now() - head.timestamp_unix_ms);
    const badge = `
      <button
        type="button"
        class="op-group-toggle${expanded ? " op-group-toggle-open" : ""}"
        data-head-id="${head.id}"
        title="${expanded ? "Collapse" : "Show all"}"
      >
        ×${g.rows.length}<span class="op-group-toggle-age">last ${escapeHtml(lastAge)}</span>
      </button>
    `;

    const headHtml = this.renderRow(head, { groupBadge: badge });
    if (!expanded) return headHtml;
    const rest = g.rows
      .slice(1)
      .map((r) => this.renderRow(r, { groupBadge: "", inGroup: true }))
      .join("");
    return `${headHtml}<div class="op-group-rest">${rest}</div>`;
  }

  private renderRow(
    r: OperatorDecisionRow,
    opts: { groupBadge: string; inGroup?: boolean } = { groupBadge: "" },
  ): string {
    const age = humanizeAge(Date.now() - r.timestamp_unix_ms);

    const actionBadge = renderActionBadge(r.action, r.executed);
    // Prefer the executor name persisted at decision time (Phase B);
    // fall back to live detection for older rows that predate the
    // snapshot column.
    const executor =
      r.executor_name ??
      (r.in_flight_command ? detectExecutor(r.in_flight_command) : null);
    const executorChip = executor
      ? `<span class="op-chip op-chip-executor" title="Executor agent at decision time">${escapeHtml(executor)}</span>`
      : "";

    // Strip the executor binary (already shown in the chip) so the
    // command line carries only the args — short and readable. Falls
    // back to the full command when no executor was detected.
    const displayCmd = executor && r.in_flight_command
      ? stripExecutorBinary(r.in_flight_command, executor)
      : r.in_flight_command;
    const cmd =
      displayCmd && displayCmd.trim().length > 0
        ? `<code class="op-cmd" title="${escapeAttr(r.in_flight_command ?? "")}">${escapeHtml(truncate(displayCmd, 60))}</code>`
        : r.in_flight_command
          ? `<span class="op-muted">(no args)</span>`
          : `<span class="op-muted">(no in-flight command)</span>`;

    const tabInfo = this.manager.tabBySessionShort(r.session_id_short);
    const tabName = tabInfo
      ? escapeHtml(tabInfo.displayName)
      : `…${escapeHtml(r.session_id_short)}`;
    const isOpen = !!tabInfo?.open;
    const tabStale = isOpen ? "" : " op-chip-stale";
    const tabTitle = isOpen
      ? "Tab still open"
      : tabInfo
        ? "Tab closed (last-known name)"
        : "Tab unknown";
    const tabChip = `<span class="op-chip op-chip-tab${tabStale}" title="${tabTitle}">${tabName}</span>`;

    // Mission snapshot from the row first (faithful to "what mission
    // was loaded when this decision fired"); fall back to the tab's
    // current mission for old rows where the snapshot is null.
    const missionPath = r.mission_path ?? tabInfo?.missionPath ?? null;
    const missionFromSnapshot = r.mission_path !== null;
    // Hide the mission chip when its basename is identical to the tab
    // name — common when the tab is auto-named after the mission, and
    // the duplicate just adds visual noise. Path remains available in
    // the tab chip's tooltip via the row data.
    const missionBase = missionPath ? missionBasename(missionPath) : null;
    const missionRedundant =
      tabInfo !== null &&
      missionBase !== null &&
      tabInfo.displayName === missionBase;
    const missionChip = missionPath && !missionRedundant
      ? `<span class="op-chip op-chip-mission" title="${missionFromSnapshot ? "Mission at decision time" : "Tab's current mission (no snapshot)"}: ${escapeAttr(missionPath)}">${escapeHtml(missionBase ?? "")}</span>`
      : "";

    const opCached = r.operator_id ? this.operatorCache.get(r.operator_id) : null;
    const opColor = opCached?.color ?? "#6B7280";
    // Prefer the LIVE name from the cache so renames propagate to
    // historical rows. Fall back to the snapshot only when the operator
    // was deleted — keeps audit visibility for orphaned decisions.
    const opName = opCached?.name ?? r.operator_name ?? null;
    const opAvatarHtml = opCached ? renderAvatarHtml(opCached.emoji, 16) : "";
    const opXp = opCached?.xp ?? 0;
    const opLevel = opCached ? operatorLevelFromXp(opXp) : null;
    const opLevelChip = opLevel !== null
      ? `<span class="op-level" title="${escapeAttr(`${opXp} XP`)}">Lv ${opLevel}</span>`
      : "";
    const operatorChip = opName
      ? `<span class="op-decision-chip" style="background:${escapeAttr(opColor)}" title="Operator: ${escapeAttr(opName)} — Lv ${opLevel ?? "?"} · ${opXp} XP">${opAvatarHtml}<span>${escapeHtml(opName)}</span>${opLevelChip}</span>`
      : "";

    const replyLine = r.reply_text
      ? `<div class="op-reply"><span class="op-reply-label">would type</span><code>${escapeHtml(visualizeBytes(r.reply_text))}</code></div>`
      : "";

    const rationale = r.rationale
      ? `<div class="op-rationale">${escapeHtml(r.rationale)}</div>`
      : "";

    const excerpt = r.output_excerpt
      ? `<details class="op-excerpt"><summary>excerpt (${r.output_excerpt.length} chars)</summary><pre>${escapeHtml(r.output_excerpt)}</pre></details>`
      : "";

    const rowClass = `op-row${opts.inGroup ? " op-row-grouped" : ""}`;
    return `
      <div class="${rowClass}">
        <div class="op-row-head">
          ${actionBadge}
          ${operatorChip}
          ${executorChip}
          ${cmd}
          ${opts.groupBadge}
          <span class="op-meta">${tabChip}${missionChip} · ${escapeHtml(age)}</span>
        </div>
        ${replyLine}
        ${rationale}
        ${excerpt}
      </div>
    `;
  }
}

interface Group {
  rows: OperatorDecisionRow[];
}

/// Walk the visible rows once and collapse consecutive entries that
/// share `(session, action, command, executed)` into a single Group.
/// "Consecutive" matters: a Reply between two Waits does NOT collapse,
/// because the temporal narrative is what makes each row useful.
function groupConsecutive(rows: OperatorDecisionRow[]): Group[] {
  const out: Group[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && sameRun(last.rows[0], r)) {
      last.rows.push(r);
    } else {
      out.push({ rows: [r] });
    }
  }
  return out;
}

function sameRun(a: OperatorDecisionRow, b: OperatorDecisionRow): boolean {
  return (
    a.session_id_short === b.session_id_short &&
    a.action === b.action &&
    a.in_flight_command === b.in_flight_command &&
    a.executed === b.executed
  );
}

/// Drop the executor binary (and any `--flag` style "permission
/// boilerplate") that's already implied by the executor chip. Returns
/// just the args. We're conservative: we only strip an exact leading
/// match against the executor name — no path resolution, no alias
/// expansion. If the binary doesn't appear, return the original.
function stripExecutorBinary(cmd: string, executor: string): string {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) return trimmed;
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0].toLowerCase();
  // Match either "claude" or "/usr/local/bin/claude" — basename only.
  const slash = first.lastIndexOf("/");
  const firstBase = slash >= 0 ? first.slice(slash + 1) : first;
  if (firstBase !== executor.toLowerCase()) return trimmed;
  return tokens.slice(1).join(" ");
}

function countByAction(rows: OperatorDecisionRow[]): {
  reply: number;
  wait: number;
  escalate: number;
} {
  const c = { reply: 0, wait: 0, escalate: 0 };
  for (const r of rows) {
    if (r.action === "reply") c.reply++;
    else if (r.action === "wait") c.wait++;
    else if (r.action === "escalate") c.escalate++;
  }
  return c;
}

/// Build a readable label for the tab dropdown. Combines the tab's
/// display name (live, or last-known from the session-name cache for
/// closed tabs) with the executor + mission snapshot. Closed tabs get
/// a "·closed" suffix so the user knows the tab is gone.
function formatSessionLabel(
  shortId: string,
  info:
    | { displayName: string; missionPath: string | null; open: boolean }
    | null,
  meta: { executor: string | null; mission: string | null },
): string {
  const parts: string[] = [];
  if (info) {
    parts.push(info.displayName);
    // Mission: prefer the live one for open tabs (fresher); fall back
    // to the snapshot for closed tabs.
    const missionPath = info.open ? info.missionPath : meta.mission;
    if (missionPath) parts.push(missionBasename(missionPath));
    if (meta.executor) parts.push(meta.executor);
    if (!info.open) parts.push("closed");
  } else {
    if (meta.executor) parts.push(meta.executor);
    if (meta.mission) parts.push(missionBasename(meta.mission));
    parts.push(`…${shortId}`);
  }
  return parts.join(" · ");
}

function missionBasename(path: string): string {
  const slash = path.lastIndexOf("/");
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function renderActionBadge(action: string, executed: boolean): string {
  const cls =
    action === "reply"
      ? "op-badge-reply"
      : action === "escalate"
        ? "op-badge-escalate"
        : "op-badge-wait";
  // Dry-run state is conveyed by a CSS-driven dimming + a leading dot
  // pseudo-element (see styles.css `.op-badge-dry`) instead of a
  // verbose "(DRY)" text suffix on every row. Tooltip carries the
  // explicit word for screen readers and curious users.
  const dry = executed ? "" : " op-badge-dry";
  const title = executed ? "Executed" : "Dry-run — proposed only";
  return `<span class="op-badge ${cls}${dry}" title="${title}">${action.toUpperCase()}</span>`;
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

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

interface ComboOption {
  value: string;
  label: string;
  /// Raw avatar string from `Operator.emoji` — emoji char or `pack:<id>`.
  /// Null for synthetic options like "All operators" that have no avatar.
  avatar: string | null;
}

/// Lightweight combobox that supports avatar imagery (pack PNGs) in both
/// the closed-state button and the dropdown list. Drop-in replacement for
/// a native dropdown when options carry visual identity beyond plain text.
///
/// Lifetime: caller mounts into a host element and is responsible for
/// calling destroy() when the host is being torn down — the popover is
/// attached to document.body and won't be removed by host innerHTML.
class AvatarCombobox {
  private button: HTMLButtonElement;
  private popover: HTMLElement | null = null;
  private highlighted = 0;
  /// Bound handlers — kept on the instance so we can detach them on
  /// close without keeping reference juggling at every call site.
  private outsideClick: ((e: MouseEvent) => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private repositionHandler: (() => void) | null = null;

  constructor(
    private readonly host: HTMLElement,
    private options: ComboOption[],
    private value: string,
    private readonly onChange: (value: string) => void,
  ) {
    this.host.classList.add("avatar-combo");
    this.button = document.createElement("button");
    this.button.type = "button";
    this.button.className = "avatar-combo__button";
    this.button.setAttribute("aria-haspopup", "listbox");
    this.button.setAttribute("aria-expanded", "false");
    this.button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    });
    this.button.addEventListener("keydown", (e) => {
      // ArrowDown opens the popover and lands on the current value —
      // matches native dropdown behavior so keyboard users don't lose
      // muscle memory.
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!this.popover) this.open();
      }
    });
    this.host.appendChild(this.button);
    this.renderButton();
  }

  destroy(): void {
    this.close();
    this.button.remove();
    this.host.classList.remove("avatar-combo");
  }

  private currentOption(): ComboOption {
    return (
      this.options.find((o) => o.value === this.value) ?? this.options[0]!
    );
  }

  private renderButton(): void {
    const sel = this.currentOption();
    const avatarHtml =
      sel.avatar !== null
        ? renderAvatarHtml(sel.avatar, 16, "avatar-combo__avatar")
        : "";
    this.button.innerHTML =
      `${avatarHtml}` +
      `<span class="avatar-combo__label">${escapeHtml(sel.label)}</span>` +
      `<span class="avatar-combo__caret" aria-hidden="true">▾</span>`;
  }

  private toggle(): void {
    if (this.popover) this.close();
    else this.open();
  }

  private open(): void {
    if (this.popover) return;
    this.highlighted = Math.max(
      0,
      this.options.findIndex((o) => o.value === this.value),
    );

    const pop = document.createElement("div");
    pop.className = "avatar-combo__popover";
    pop.setAttribute("role", "listbox");
    document.body.appendChild(pop);
    this.popover = pop;
    this.renderPopover();
    this.position();

    this.button.setAttribute("aria-expanded", "true");

    this.outsideClick = (e: MouseEvent): void => {
      if (!this.popover) return;
      const target = e.target as Node;
      if (this.popover.contains(target)) return;
      if (this.button.contains(target)) return;
      this.close();
    };
    this.keyHandler = (e: KeyboardEvent): void => {
      if (!this.popover) return;
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          this.close();
          this.button.focus();
          break;
        case "ArrowDown":
          e.preventDefault();
          this.highlighted = Math.min(
            this.options.length - 1,
            this.highlighted + 1,
          );
          this.renderPopover();
          break;
        case "ArrowUp":
          e.preventDefault();
          this.highlighted = Math.max(0, this.highlighted - 1);
          this.renderPopover();
          break;
        case "Enter": {
          e.preventDefault();
          const opt = this.options[this.highlighted];
          if (opt) this.select(opt.value);
          break;
        }
      }
    };
    this.repositionHandler = (): void => this.position();

    // Defer attach so the click that opened us doesn't immediately close
    // via the document-level handler (same-tick bubble).
    setTimeout(() => {
      if (!this.popover) return;
      document.addEventListener("click", this.outsideClick!);
      document.addEventListener("keydown", this.keyHandler!);
      window.addEventListener("resize", this.repositionHandler!);
      window.addEventListener("scroll", this.repositionHandler!, true);
    }, 0);
  }

  private renderPopover(): void {
    if (!this.popover) return;
    this.popover.innerHTML = this.options
      .map((o, i) => {
        const cls =
          "avatar-combo__option" +
          (i === this.highlighted ? " is-highlighted" : "") +
          (o.value === this.value ? " is-selected" : "");
        const avatarHtml =
          o.avatar !== null
            ? renderAvatarHtml(o.avatar, 18, "avatar-combo__avatar")
            : `<span class="avatar-combo__avatar avatar-combo__avatar--blank" aria-hidden="true"></span>`;
        return (
          `<button type="button" class="${cls}" role="option" data-value="${escapeAttr(o.value)}" aria-selected="${o.value === this.value}">` +
          avatarHtml +
          `<span class="avatar-combo__label">${escapeHtml(o.label)}</span>` +
          `</button>`
        );
      })
      .join("");
    this.popover
      .querySelectorAll<HTMLButtonElement>("button.avatar-combo__option")
      .forEach((btn, i) => {
        btn.addEventListener("click", () => {
          this.highlighted = i;
          this.select(btn.dataset.value!);
        });
        btn.addEventListener("mouseenter", () => {
          this.highlighted = i;
          this.renderPopover();
        });
      });
  }

  private position(): void {
    if (!this.popover) return;
    const rect = this.button.getBoundingClientRect();
    // Default: drop down. Flip up when there's not enough room below.
    const popHeight = this.popover.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom;
    const dropUp = spaceBelow < popHeight + 8 && rect.top > popHeight + 8;
    this.popover.style.left = `${Math.max(8, rect.left)}px`;
    this.popover.style.top = dropUp
      ? `${rect.top - popHeight - 4}px`
      : `${rect.bottom + 4}px`;
    this.popover.style.minWidth = `${Math.max(rect.width, 160)}px`;
  }

  private close(): void {
    if (!this.popover) return;
    this.popover.remove();
    this.popover = null;
    this.button.setAttribute("aria-expanded", "false");
    if (this.outsideClick) {
      document.removeEventListener("click", this.outsideClick);
      this.outsideClick = null;
    }
    if (this.keyHandler) {
      document.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
    if (this.repositionHandler) {
      window.removeEventListener("resize", this.repositionHandler);
      window.removeEventListener("scroll", this.repositionHandler, true);
      this.repositionHandler = null;
    }
  }

  private select(value: string): void {
    if (this.value !== value) {
      this.value = value;
      this.renderButton();
      this.onChange(value);
    }
    this.close();
  }
}

function mindEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
