// ⌘O — Operator decisions panel.
//
// Lists recent decisions the Operator has proposed. The subtitle adapts
// to the current mode: "AOM live" when AOM is active, "Dry-run" otherwise.
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

import { aomStatus, listOperatorDecisions, operatorList, type Operator, type OperatorDecisionRow } from "../api";
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
  private modal: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private subtitleEl: HTMLElement | null = null;
  private countersEl: HTMLElement | null = null;
  private filtersEl: HTMLElement | null = null;
  private unlisten: UnlistenFn | null = null;
  private rows: OperatorDecisionRow[] = [];
  private filter: FilterState = loadPrefs();
  /// Decision IDs (the head row of a collapsed group) the user has
  /// chosen to expand. Survives in-panel re-renders driven by streaming
  /// "operator-decision" events; cleared on close. Not persisted to
  /// localStorage — expansion is a transient view state.
  private expandedGroups: Set<number> = new Set();
  private operatorCache: Map<string, Operator> = new Map();

  constructor(
    private readonly mountHost: HTMLElement,
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
    await Promise.all([this.refresh(), this.refreshSubtitle(), this.refreshOperatorCache()]);

    // Auto-refresh on new decisions while the panel is open. Also
    // bounce the subtitle in case AOM toggled between events.
    this.unlisten = await listen("operator-decision", () => {
      void this.refresh();
      void this.refreshSubtitle();
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
      this.subtitleEl = null;
      this.countersEl = null;
      this.filtersEl = null;
    }
    this.expandedGroups.clear();
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
          <small class="operator-subtitle">checking mode…</small>
          <small class="operator-counters"></small>
        </div>
        <button type="button" class="operator-close" aria-label="Close">×</button>
      </header>
      <div class="operator-filters" role="toolbar" aria-label="Filters"></div>
      <div class="operator-list" tabindex="-1">loading…</div>
    `;

    card
      .querySelector<HTMLButtonElement>(".operator-close")!
      .addEventListener("click", () => this.close());

    this.mountHost.appendChild(overlay);
    this.modal = overlay;
    this.listEl = card.querySelector<HTMLElement>(".operator-list");
    this.subtitleEl = card.querySelector<HTMLElement>(".operator-subtitle");
    this.countersEl = card.querySelector<HTMLElement>(".operator-counters");
    this.filtersEl = card.querySelector<HTMLElement>(".operator-filters");
    this.renderFilters();
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
          <select class="operator-session-select">
            <option value="all">All tabs</option>
            ${sessionShorts
              .map((s) => {
                const info = this.manager.tabBySessionShort(s);
                const meta = sessionMeta.get(s)!;
                const label = formatSessionLabel(s, info, meta);
                const sel = this.filter.session === s ? " selected" : "";
                return `<option value="${escapeAttr(s)}"${sel}>${escapeHtml(label)}</option>`;
              })
              .join("")}
          </select>
        </label>
        <label class="operator-filter-label">
          Operator
          <select class="operator-operator-select" data-role="filter-operator">
            <option value="all">All operators</option>
            ${Array.from(this.operatorCache.values())
              .map((op) => {
                const sel = this.filter.operatorFilter === op.id ? " selected" : "";
                return `<option value="${escapeAttr(op.id)}"${sel}>${escapeHtml(op.emoji + " " + op.name)}</option>`;
              })
              .join("")}
          </select>
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

    this.filtersEl
      .querySelector<HTMLSelectElement>(".operator-session-select")!
      .addEventListener("change", (e) => {
        this.filter.session = (e.target as HTMLSelectElement).value;
        savePrefs(this.filter);
        this.renderList();
      });

    this.filtersEl
      .querySelector<HTMLSelectElement>(".operator-operator-select")!
      .addEventListener("change", (e) => {
        this.filter.operatorFilter = (e.target as HTMLSelectElement).value;
        savePrefs(this.filter);
        this.renderList();
      });

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
    const opLabel = r.operator_name
      ? (opCached ? `${opCached.emoji} ${r.operator_name}` : r.operator_name)
      : null;
    const operatorChip = opLabel
      ? `<span class="op-decision-chip" style="background:${escapeAttr(opColor)}" title="Operator: ${escapeAttr(opLabel)}">${escapeHtml(opLabel)}</span>`
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
