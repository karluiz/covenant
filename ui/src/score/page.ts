import type { ScoreFilter, Summary, DailyCell, GroupCell } from "./api";
import * as api from "./api";
import type { ModelSource } from "./api";
import { displayGroupName, renderRepoBars, renderBranchList, renderGroupBars, renderSessions } from "./breakdowns";
import { DEFAULT_GROUP_VIEW, type GroupView } from "./leaderboard";
import { renderAgentBars, renderSpecsCard, renderModelsCard } from "./usage";
import { getCurrentUser, setCurrentUser } from "./user";
import { runDeviceFlow } from "./signin";
import { attachTooltip } from "../tooltip/tooltip";
import { Icons } from "../icons";
import { scoreSignout, scoreSyncNow, scoreSyncStatus, scoreTokenScope } from "./api";

interface State {
  filter: ScoreFilter;
  mounted: boolean;
  modelSource?: ModelSource;
  /// Last-fetched group rows + the card-local view (sort/topN/search). Kept on
  /// State so the leaderboard's sort/filter survive page refreshes and re-render
  /// without refetching when only the view changes.
  groups: GroupCell[];
  groupView: GroupView;
}

const TEMPLATE = /* html */ `
  <div class="covenant-page">
    <div class="pulse-hero">
      <div class="pulse-hero-top">
        <div class="cov-stats" data-role="stats"><div class="cov-skel cov-skel-stat"></div><div class="cov-skel cov-skel-stat"></div><div class="cov-skel cov-skel-stat"></div><div class="cov-skel cov-skel-stat"></div><div class="cov-skel cov-skel-stat"></div></div>
        <div class="cov-filters" data-role="filters"></div>
      </div>
      <div class="cov-heatmap-card">
        <h4>Activity · last 12 months <span class="hint">click a cell to filter by day</span></h4>
        <div class="cov-heatmap" data-role="heatmap"><div class="cov-skel cov-skel-heat"></div></div>
        <div class="cov-legend">Less <span class="cov-cell"></span><span class="cov-cell l1"></span><span class="cov-cell l2"></span><span class="cov-cell l3"></span><span class="cov-cell l4"></span> More</div>
      </div>
    </div>
    <div class="pulse-grid">
      <div class="cov-card">
        <h4 data-role="repos-title">By repo <span class="hint">click to drill in</span></h4>
        <div data-role="repos"><div class="cov-skel cov-skel-block"></div></div>
        <div class="cov-card-foot">
          <span class="seg-key seg-p"></span> prompts &nbsp; <span class="seg-key seg-c"></span> commits
        </div>
      </div>
      <div class="cov-card">
        <h4 data-role="branches-title">Top branches <span class="hint">pick a repo</span></h4>
        <div data-role="branches"><div class="cov-skel cov-skel-block"></div></div>
      </div>
      <div class="cov-card">
        <h4>By group <span class="hint">Covenant tab groups</span></h4>
        <div data-role="groups"><div class="cov-skel cov-skel-block"></div></div>
      </div>
      <div class="cov-card">
        <h4>By operator <span class="hint">click to filter</span></h4>
        <div data-role="agents"><div class="cov-skel cov-skel-block"></div></div>
      </div>
      <div class="cov-card">
        <h4>Specs</h4>
        <div data-role="specs"><div class="cov-skel cov-skel-block"></div></div>
      </div>
      <div class="cov-card">
        <h4>Token usage · per model</h4>
        <div data-role="models"><div class="cov-skel cov-skel-block"></div></div>
      </div>
      <div class="cov-card cov-card--wide">
        <h4>Recent sessions</h4>
        <div data-role="sessions"><div class="cov-skel cov-skel-block"></div></div>
      </div>
    </div>
    <div class="cov-sync" data-role="sync"></div>
  </div>
`;

export function mountCovenantPage(host: HTMLElement): void {
  if (host.dataset.mounted === "true") {
    const state = (host as unknown as { __cov: State }).__cov;
    void refresh(host, state);
    return;
  }
  host.innerHTML = TEMPLATE;
  host.dataset.mounted = "true";
  const state: State = {
    filter: { range: "all" },
    mounted: true,
    groups: [],
    groupView: { ...DEFAULT_GROUP_VIEW },
  };
  (host as unknown as { __cov: State }).__cov = state;
  void refresh(host, state);
}

async function refresh(host: HTMLElement, state: State): Promise<void> {
  // Error boundary: a single failing query (a busy SQLite lock under heavy
  // external polling, malformed data, etc.) must never tear down the whole
  // page — render a visible banner instead of leaving a blank/half view.
  try {
    await refreshInner(host, state);
  } catch (err) {
    console.error("[covenant] score refresh failed", err);
    const page = host.querySelector<HTMLElement>(".covenant-page");
    if (page) {
      let banner = page.querySelector<HTMLElement>("[data-role=refresh-error]");
      if (!banner) {
        banner = document.createElement("div");
        banner.dataset.role = "refresh-error";
        banner.className = "cov-error-banner";
        page.prepend(banner);
      }
      banner.textContent = `Couldn't load metrics: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

async function refreshInner(host: HTMLElement, state: State): Promise<void> {
  host.querySelector<HTMLElement>("[data-role=refresh-error]")?.remove();
  const filtersHost = host.querySelector<HTMLElement>("[data-role=filters]")!;
  const statsHost = host.querySelector<HTMLElement>("[data-role=stats]")!;
  const heatmapHost = host.querySelector<HTMLElement>("[data-role=heatmap]")!;
  const reposHost = host.querySelector<HTMLElement>("[data-role=repos]")!;
  const branchesHost = host.querySelector<HTMLElement>("[data-role=branches]")!;
  const branchesTitle = host.querySelector<HTMLElement>("[data-role=branches-title]")!;
  const groupsHost = host.querySelector<HTMLElement>("[data-role=groups]")!;
  const agentsHost = host.querySelector<HTMLElement>("[data-role=agents]")!;
  const specsHost  = host.querySelector<HTMLElement>("[data-role=specs]")!;
  const modelsHost = host.querySelector<HTMLElement>("[data-role=models]")!;
  const sessionsHost = host.querySelector<HTMLElement>("[data-role=sessions]")!;
  const syncHost = host.querySelector<HTMLElement>("[data-role=sync]")!;

  const [summary, heatmap, repos, groups, sessions, user, agents, specs] = await Promise.all([
    api.scoreSummaryFiltered(state.filter),
    api.scoreHeatmapFiltered(state.filter),
    api.scoreBreakdownRepos(state.filter),
    api.scoreBreakdownGroups(state.filter),
    api.scoreRecentSessions(10),
    getCurrentUser(),
    api.scoreBreakdownAgents(state.filter),
    api.scoreBreakdownSpecs(state.filter),
  ]);

  renderFilters(filtersHost, state, host);
  renderStats(statsHost, summary, heatmap);
  renderHeatmap(heatmapHost, heatmap, (day) => {
    state.filter.day = day;
    void refresh(host, state);
  });
  const reposTitleEl = host.querySelector<HTMLElement>("[data-role=repos-title]")!;
  reposTitleEl.innerHTML = `${escHtml(reposTitle(state.filter))} <span class="hint">click to drill in</span>`;
  renderRepoBars(reposHost, repos, state.filter.repo ?? null, (repo) => {
    state.filter.repo = repo;
    state.filter.branch = null;
    void refresh(host, state);
  });

  if (state.filter.repo) {
    const branches = await api.scoreBreakdownBranches(state.filter.repo, state.filter);
    branchesTitle.innerHTML = `${escHtml(state.filter.repo)} · top branches <span class="hint">last ${rangeLabel(state.filter)}</span>`;
    renderBranchList(branchesHost, state.filter.repo, branches, (b) => {
      state.filter.branch = b;
      void refresh(host, state);
    });
  } else {
    branchesTitle.innerHTML = `Top branches <span class="hint">pick a repo</span>`;
    branchesHost.innerHTML = `<div class="cov-empty">Pick a repo to see top branches</div>`;
  }

  // Cache the fetched rows; the leaderboard re-renders itself on sort/topN/
  // search changes (no refetch), and drills the whole page on row click.
  state.groups = groups;
  const renderGroups = (): void => {
    renderGroupBars(
      groupsHost,
      state.groups,
      state.groupView,
      (groupName) => {
        state.filter.group_name = groupName;
        void refresh(host, state);
      },
      (next) => {
        state.groupView = next;
        renderGroups();
      },
    );
  };
  renderGroups();
  renderAgentBars(agentsHost, agents, (agent) => {
    state.filter.agent = agent;
    void refresh(host, state);
  });
  renderSpecsCard(specsHost, specs);

  const modelSource: ModelSource = state.modelSource ?? "internal";
  const models = await api.scoreBreakdownModels(state.filter, modelSource);
  renderModelsCard(modelsHost, modelSource, models, (next) => {
    state.modelSource = next;
    void refresh(host, state);
  });

  renderSessions(sessionsHost, sessions);
  renderSync(syncHost, user, host, state);
}

// ── Filter chips ─────────────────────────────────────────────────────────────

function renderFilters(host: HTMLElement, state: State, page: HTMLElement): void {
  host.innerHTML = "";
  host.appendChild(
    chipButton(`Range: ${rangeLabel(state.filter)}`, () => {
      state.filter.range =
        state.filter.range === "all" ? "last30d" :
        state.filter.range === "last30d" ? "last7d" : "all";
      void refresh(page, state);
    }),
  );
  if (state.filter.repo) {
    host.appendChild(
      chipDismiss(`Repo: ${state.filter.repo}`, () => {
        state.filter.repo = null;
        state.filter.branch = null;
        void refresh(page, state);
      }),
    );
  }
  if (state.filter.branch) {
    host.appendChild(
      chipDismiss(`Branch: ${state.filter.branch}`, () => {
        state.filter.branch = null;
        void refresh(page, state);
      }),
    );
  }
  if (state.filter.group_name) {
    host.appendChild(
      chipDismiss(`Group: ${displayGroupName(state.filter.group_name)}`, () => {
        state.filter.group_name = null;
        void refresh(page, state);
      }),
    );
  }
  if (state.filter.day) {
    host.appendChild(
      chipDismiss(`Day: ${state.filter.day}`, () => {
        state.filter.day = null;
        void refresh(page, state);
      }),
    );
  }
  if (state.filter.agent) {
    host.appendChild(
      chipDismiss(`Agent: ${state.filter.agent}`, () => {
        state.filter.agent = null;
        void refresh(page, state);
      }),
    );
  }
}

function chipButton(label: string, onClick: () => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cov-chip active";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function chipDismiss(label: string, onDismiss: () => void): HTMLElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cov-chip";
  btn.innerHTML = `${escHtml(label)} <span class="x">✕</span>`;
  btn.addEventListener("click", onDismiss);
  return btn;
}

// ── Stat cards ────────────────────────────────────────────────────────────────

function renderStats(host: HTMLElement, summary: Summary, cells: DailyCell[]): void {
  // Baseline: mean prompts/day over the 30 days BEFORE today. Comparing
  // against an honest recent average (not lifetime-total ÷ streak) keeps the
  // delta meaningful — today excluded so a partial day doesn't dilute it.
  const todayKey = new Date().toISOString().slice(0, 10);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffKey = cutoff.toISOString().slice(0, 10);
  const prior30 = cells
    .filter((c) => c.day >= cutoffKey && c.day < todayKey)
    .reduce((sum, c) => sum + c.prompts, 0);
  const avg = prior30 / 30;
  let arrow = "";
  if (summary.today_prompts > 0 && avg > 0) {
    const pct = Math.round(((summary.today_prompts - avg) / avg) * 100);
    const up = pct >= 0;
    arrow = `<span class="cov-stat-delta ${up ? "is-up" : "is-down"}">${up ? "▲ +" : "▽ "}${pct}% vs 30d avg</span>`;
  }
  host.innerHTML = `
    <div class="cov-stat cov-stat--hero cov-stat--momentum">
      <div class="v">${summary.current_streak}d</div>
      <div class="l">Current streak <span class="cov-flame">${Icons.flame({ size: 12 })}</span></div>
    </div>
    <div class="cov-stat cov-stat--momentum">
      <div class="v">${summary.today_prompts.toLocaleString()}</div>
      <div class="l">Today ${arrow}</div>
    </div>
    <div class="cov-stat">
      <div class="v">${summary.total_prompts.toLocaleString()}</div>
      <div class="l">Total prompts</div>
    </div>
    <div class="cov-stat">
      <div class="v">${summary.total_commits.toLocaleString()}</div>
      <div class="l">Total commits</div>
    </div>
    <div class="cov-stat">
      <div class="v">${summary.total_tokens.toLocaleString()}</div>
      <div class="l">Total tokens</div>
    </div>
  `;
}

// ── Heatmap ───────────────────────────────────────────────────────────────────

/// Ceiling the intensity scale is measured against: the 90th percentile
/// of active days, not the raw max, so one outlier day (a 500-commit
/// rebase) doesn't flatten every other day to the lightest shade.
/// Exported for tests.
export function intensityCeiling(counts: number[]): number {
  const active = counts.filter((n) => n > 0).sort((a, b) => a - b);
  if (active.length === 0) return 0;
  // Nearest-rank p90: ceil(0.9 * n) - 1. Using floor(0.9 * n) indexes
  // the max itself at n = 10, which is exactly the outlier we exclude.
  const idx = Math.min(active.length - 1, Math.max(0, Math.ceil(active.length * 0.9) - 1));
  return active[idx]!;
}

/// Relative intensity: quartile of `ceiling` rather than fixed absolute
/// thresholds. The old 5/15/40 scale was tuned for prompts back when
/// `collect_oneshot` recorded every internal call (~1900/day). Since
/// 406822b8 a prompt means a human submission, and the combined
/// prompt+commit volume it now plots has no stable scale to hardcode —
/// a relative scale re-tunes itself instead of saturating or going flat.
export function intensityClass(count: number, ceiling: number): string {
  if (count === 0 || ceiling === 0) return "";
  const q = Math.ceil((count / ceiling) * 4);
  return `l${Math.max(1, Math.min(4, q))}`;
}

function renderHeatmap(
  host: HTMLElement,
  cells: DailyCell[],
  onClick: (day: string) => void,
): void {
  host.innerHTML = "";
  // Plot prompts AND commits. The payload always carried both; graphing
  // prompts alone left "ACTIVITY" blank on a profile with 33k commits.
  const byDay = new Map<string, { prompts: number; commits: number }>();
  for (const c of cells) byDay.set(c.day, { prompts: c.prompts, commits: c.commits });
  const ceiling = intensityCeiling(cells.map((c) => c.prompts + c.commits));

  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 52 * 7 - today.getDay());

  for (let week = 0; week < 53; week++) {
    for (let day = 0; day < 7; day++) {
      const d = new Date(start);
      d.setDate(start.getDate() + week * 7 + day);
      const key = d.toISOString().slice(0, 10);
      const stats = byDay.get(key);
      const prompts = stats?.prompts ?? 0;
      const commits = stats?.commits ?? 0;
      const count = prompts + commits;
      const cell = document.createElement("div");
      const cls = intensityClass(count, ceiling);
      cell.className = `cov-cell${cls ? " " + cls : ""}`;
      attachTooltip(cell, {
        title: d.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        subtitle: key,
        meta:
          count === 0
            ? "No activity"
            : [
                prompts > 0 ? `${prompts} prompt${prompts === 1 ? "" : "s"}` : null,
                commits > 0 ? `${commits} commit${commits === 1 ? "" : "s"}` : null,
              ]
                .filter(Boolean)
                .join(" · "),
      });
      cell.dataset.day = key;
      cell.addEventListener("click", () => onClick(key));
      host.appendChild(cell);
    }
  }
}

// ── Sync card ─────────────────────────────────────────────────────────────────

function renderSync(
  host: HTMLElement,
  user: import("./api").User | null,
  page: HTMLElement,
  state: State,
): void {
  host.innerHTML = "";

  if (!user) {
    const wrap = document.createElement("div");
    wrap.className = "cov-sync";
    wrap.innerHTML = `
      <div class="l"><b>Not connected</b>Sign in to sync across devices and see your public profile.</div>
      <button type="button" class="btn cov-signin-btn">Sign in with GitHub</button>
    `;
    wrap.querySelector(".cov-signin-btn")!.addEventListener("click", async () => {
      const u = await runDeviceFlow();
      if (u) void refresh(page, state);
    });
    host.appendChild(wrap);
    return;
  }

  const syncStatusP = scoreSyncStatus().catch(() => null);
  const wrap = document.createElement("div");
  wrap.className = "cov-sync";
  wrap.innerHTML = `
    <div class="l">
      <b>Synced as @${escHtml(user.login)}</b>
      <span class="cov-sync-status">Checking sync status…</span>
    </div>
    <div style="display:flex;gap:8px">
      <button type="button" class="btn ghost cov-sync-now-btn">Sync now</button>
      <button type="button" class="btn ghost cov-disconnect-btn">Disconnect</button>
    </div>
  `;
  host.appendChild(wrap);

  void syncStatusP.then((sync) => {
    const statusEl = wrap.querySelector<HTMLElement>(".cov-sync-status");
    if (statusEl) statusEl.textContent = formatSync(sync);
  });

  wrap.querySelector(".cov-sync-now-btn")!.addEventListener("click", async () => {
    const statusEl = wrap.querySelector<HTMLElement>(".cov-sync-status");
    if (statusEl) statusEl.textContent = "Syncing…";
    try {
      await scoreSyncNow();
      void refresh(page, state);
    } catch (err) {
      if (statusEl) statusEl.textContent = `Sync failed: ${String(err)}`;
    }
  });

  wrap.querySelector(".cov-disconnect-btn")!.addEventListener("click", async () => {
    await scoreSignout();
    setCurrentUser(null); // invalidate the in-memory cache so refresh shows signed-out
    void refresh(page, state);
  });

  // Operators need repo scope; tokens minted before this feature carry
  // none. Offer a one-click re-connect (device flow overwrites the token).
  scoreTokenScope().then((scope) => {
    const hasRepo = (scope ?? "")
      .split(",")
      .map((s) => s.trim())
      .includes("repo");
    if (hasRepo) return;
    if (host.querySelector(".cov-sync-reauth")) return;
    const cta = document.createElement("div");
    cta.className = "cov-sync cov-sync-reauth";
    cta.innerHTML = `
      <div class="l"><b>Operators need repo access</b>Re-connect GitHub so operators can read and write issues and pull requests.</div>
      <button type="button" class="btn cov-reauth-btn">Re-connect GitHub</button>
    `;
    cta.querySelector(".cov-reauth-btn")!.addEventListener("click", async () => {
      const u = await runDeviceFlow();
      if (u) void refresh(page, state);
    });
    host.appendChild(cta);
  }).catch(() => { /* scope unknown — stay quiet */ });
}

function formatSync(sync: import("./api").SyncStatus | null): string {
  if (!sync || !sync.signed_in) return "Not synced";
  if (sync.last_synced_at_ms === 0) return "Pending first sync…";
  const ageMs = Date.now() - sync.last_synced_at_ms;
  const ageMin = Math.floor(ageMs / 60000);
  const ageStr =
    ageMin === 0 ? "just now" :
    ageMin < 60 ? `${ageMin}m ago` :
    `${Math.floor(ageMin / 60)}h ago`;
  if (sync.pending_events > 0) return `Synced ${ageStr} · ${sync.pending_events} pending`;
  return `Synced ${ageStr}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rangeLabel(filter: ScoreFilter): string {
  if (filter.range === "last30d") return "30 days";
  if (filter.range === "last7d") return "7 days";
  return "all time";
}

/// The "By repo" card heading must reflect the active range — the breakdown
/// query uses the page filter, so a hardcoded "last 30d" lies under "all".
export function reposTitle(filter: ScoreFilter): string {
  return `By repo · ${rangeLabel(filter)}`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
