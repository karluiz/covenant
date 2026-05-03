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

import { aomStatus, listOperatorDecisions, type OperatorDecisionRow } from "../api";
import { detectExecutor } from "../executor";
import type { TabManager } from "../tabs/manager";

const LIMIT = 200;

type ActionFilter = "all" | "reply" | "wait" | "escalate";

interface FilterState {
  action: ActionFilter;
  session: string | "all";
  executedOnly: boolean;
}

const PREF_KEY = "covenant.operator-panel.filter";

function loadPrefs(): FilterState {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return { action: "all", session: "all", executedOnly: false };
    const p = JSON.parse(raw) as Partial<FilterState>;
    return {
      action: (p.action ?? "all") as ActionFilter,
      session: p.session ?? "all",
      executedOnly: !!p.executedOnly,
    };
  } catch {
    return { action: "all", session: "all", executedOnly: false };
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

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly manager: TabManager,
  ) {}

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
    await Promise.all([this.refresh(), this.refreshSubtitle()]);

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

    this.listEl.innerHTML = visible
      .map((r) => this.renderRow(r))
      .join("");
  }

  private renderRow(r: OperatorDecisionRow): string {
    const age = humanizeAge(Date.now() - r.timestamp_unix_ms);
    const cmd = r.in_flight_command
      ? `<code>${escapeHtml(truncate(r.in_flight_command, 60))}</code>`
      : `<span class="op-muted">(no in-flight command)</span>`;

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
    const missionChip = missionPath
      ? `<span class="op-chip op-chip-mission" title="${missionFromSnapshot ? "Mission at decision time" : "Tab's current mission (no snapshot)"}: ${escapeAttr(missionPath)}">${escapeHtml(missionBasename(missionPath))}</span>`
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

    return `
      <div class="op-row">
        <div class="op-row-head">
          ${actionBadge}
          ${executorChip}
          ${cmd}
          <span class="op-meta">${tabChip}${missionChip} · ${escapeHtml(age)}</span>
        </div>
        ${replyLine}
        ${rationale}
        ${excerpt}
      </div>
    `;
  }
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

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
