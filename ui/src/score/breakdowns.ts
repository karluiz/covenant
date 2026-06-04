import type { RepoCell, BranchCell, GroupCell, SessionRow } from "./api";
import {
  buildLeaderboard,
  nextSort,
  nextTopN,
  type GroupView,
  type GroupSort,
  type Leaderboard,
  type LeaderRow,
} from "./leaderboard";
import { attachTooltip } from "../tooltip/tooltip";

const PALETTE = ["#5eead4", "#f59e0b", "#8b5cf6", "#ef4444", "#3b82f6", "#ec4899", "#10b981", "#f97316"];

export function renderRepoBars(
  host: HTMLElement,
  rows: RepoCell[],
  selected: string | null,
  onSelect: (repo: string) => void,
): void {
  host.innerHTML = "";
  if (rows.length === 0) {
    host.innerHTML = `<div class="cov-empty">No repo data for this period</div>`;
    return;
  }
  const maxTotal = Math.max(...rows.map((r) => r.prompts + r.commits), 1);
  rows.forEach((row, i) => {
    const color = PALETTE[i % PALETTE.length];
    const pPct = (row.prompts / maxTotal) * 100;
    const cPct = (row.commits / maxTotal) * 100;
    const isActive = selected === row.repo;

    const el = document.createElement("div");
    el.className = `bar-row${isActive ? " active" : ""}`;
    el.innerHTML = `
      <div class="name">
        <span class="dotc" style="background:${color}"></span>
        ${escHtml(row.repo)}
      </div>
      <div class="bar">
        <div class="seg-p" style="width:${pPct.toFixed(1)}%"></div>
        <div class="seg-c" style="width:${cPct.toFixed(1)}%"></div>
      </div>
      <div class="meta">${row.prompts}p · ${row.commits}c</div>
    `;
    el.querySelector(".name")!.addEventListener("click", () => onSelect(row.repo));
    host.appendChild(el);
  });
}

export function renderBranchList(
  host: HTMLElement,
  _repo: string,
  rows: BranchCell[],
  onSelect: (b: string) => void,
): void {
  host.innerHTML = "";
  if (rows.length === 0) {
    host.innerHTML = `<div class="cov-empty">No branch data</div>`;
    return;
  }
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "branch";
    el.innerHTML = `
      <div class="b-name"><span class="ico">⎇</span>${escHtml(row.branch)}</div>
      <div class="b-meta"><b>${row.prompts}</b> · ${row.commits}c</div>
    `;
    el.addEventListener("click", () => onSelect(row.branch));
    host.appendChild(el);
  }
}

/// "By group" card — Ranked Leaderboard.
///
/// Bars encode share-of-total (scaled so the leader fills the track), with an
/// average reference line, explicit rank, and a running cumulative (Pareto) %.
/// Sort / Top-N / search are client-side over the already-DESC GroupCell[]
/// (see buildLeaderboard); clicking a row drills the whole page into that group.
/// The workspace lives in its own fixed swatch column + footer legend, so it
/// can never overflow the name and collide with the bar (the old ws-tag bug).
export function renderGroupBars(
  host: HTMLElement,
  cells: GroupCell[],
  view: GroupView,
  onSelect: (groupName: string) => void,
  onView: (next: GroupView) => void,
): void {
  // Preserve the search box's focus + caret across the re-render it triggers.
  const active = document.activeElement as HTMLElement | null;
  const searchFocused = !!active && active.classList.contains("lb-search");
  const caret = searchFocused ? (active as HTMLInputElement).selectionStart : null;

  host.innerHTML = "";
  if (cells.length === 0) {
    host.innerHTML = `<div class="cov-empty">No group data</div>`;
    return;
  }

  const lb = buildLeaderboard(cells, view);

  // One hue per workspace (by subtotal rank) for the swatch column + legend.
  const wsColor = new Map<string, string>();
  lb.workspaces.forEach((w, i) => wsColor.set(w.name, PALETTE[i % PALETTE.length]!));

  host.appendChild(buildLbControls(view, onView));

  const summary = document.createElement("div");
  summary.className = "lb-summary";
  summary.textContent =
    `${lb.count} ${lb.count === 1 ? "group" : "groups"} · ` +
    `${lb.grandTotal.toLocaleString()} prompts · avg ${Math.round(lb.avg)}`;
  host.appendChild(summary);

  const list = document.createElement("div");
  list.className = "lb-list";
  if (lb.rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cov-empty";
    empty.textContent = `No groups match “${view.query.trim()}”.`;
    list.appendChild(empty);
  } else {
    for (const row of lb.rows) list.appendChild(buildLbRow(row, lb, wsColor, onSelect));
  }
  host.appendChild(list);

  host.appendChild(buildLbFooter(lb, view, wsColor, onView));

  if (searchFocused) {
    const next = host.querySelector<HTMLInputElement>(".lb-search");
    if (next) {
      next.focus();
      if (caret != null) {
        try { next.setSelectionRange(caret, caret); } catch { /* ignore */ }
      }
    }
  }
}

const SORT_LABEL: Record<GroupSort, string> = {
  prompts: "Prompts",
  name: "Name",
  workspace: "Workspace",
};

function buildLbControls(view: GroupView, onView: (n: GroupView) => void): HTMLElement {
  const controls = document.createElement("div");
  controls.className = "lb-controls";

  controls.appendChild(
    lbCtl(`Sort: ${SORT_LABEL[view.sort]}`, () => onView({ ...view, sort: nextSort(view.sort) })),
  );
  controls.appendChild(
    lbCtl(view.topN === "all" ? "All" : `Top ${view.topN}`, () =>
      onView({ ...view, topN: nextTopN(view.topN) }),
    ),
  );

  const search = document.createElement("input");
  search.type = "search";
  search.className = "lb-search";
  search.placeholder = "filter groups…";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.value = view.query;
  search.addEventListener("input", () => onView({ ...view, query: search.value }));
  controls.appendChild(search);

  return controls;
}

function lbCtl(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "lb-ctl";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function buildLbRow(
  row: LeaderRow,
  lb: Leaderboard,
  wsColor: Map<string, string>,
  onSelect: (groupName: string) => void,
): HTMLElement {
  const color = PALETTE[(row.rank - 1) % PALETTE.length];
  const wsFill = row.workspace ? wsColor.get(row.workspace) ?? "#6c8088" : null;

  const el = document.createElement("button");
  el.type = "button";
  el.className = "lb-row";
  el.innerHTML = `
    <span class="lb-rank">${row.rank}</span>
    <span class="lb-name">
      <span class="lb-dot" style="background:${color}"></span>
      <span class="lb-gname">${escHtml(displayGroupName(row.group_name))}</span>
    </span>
    <span class="lb-ws${wsFill ? "" : " empty"}"${wsFill ? ` style="background:${wsFill}"` : ""}>${wsFill ? "" : "—"}</span>
    <span class="lb-bar">
      <span class="lb-fill" style="width:${row.barPct.toFixed(1)}%;background:${color}"></span>
      <span class="lb-avg" style="left:${clampPct(lb.avgPct).toFixed(1)}%"></span>
      <span class="lb-share">${fmtPct(row.share, 1)}</span>
    </span>
    <span class="lb-meta"><b>${row.prompts.toLocaleString()}</b><span class="lb-cum">${fmtPct(row.cumulative, 0)}</span></span>
  `;
  el.addEventListener("click", () => onSelect(row.group_name));

  const nameEl = el.querySelector<HTMLElement>(".lb-gname");
  if (nameEl) {
    attachTooltip(nameEl, {
      title: displayGroupName(row.group_name),
      subtitle: row.workspace ?? "No workspace",
      meta: `#${row.rank} · ${row.prompts.toLocaleString()} prompts · ${fmtPct(row.share, 1)} of total`,
    });
  }
  const wsEl = el.querySelector<HTMLElement>(".lb-ws");
  if (wsEl) attachTooltip(wsEl, { title: row.workspace ?? "No workspace" });

  return el;
}

function buildLbFooter(
  lb: Leaderboard,
  view: GroupView,
  wsColor: Map<string, string>,
  onView: (n: GroupView) => void,
): HTMLElement {
  const foot = document.createElement("div");
  foot.className = "lb-foot";

  const legend = document.createElement("div");
  legend.className = "lb-legend";
  for (const w of lb.workspaces) {
    const item = document.createElement("span");
    item.className = "lb-legend-item";
    item.innerHTML = `<span class="lb-sw" style="background:${wsColor.get(w.name)}"></span>${escHtml(w.name)}`;
    legend.appendChild(item);
  }
  if (lb.rows.some((r) => !r.workspace) || lb.count > lb.workspaces.length) {
    const none = document.createElement("span");
    none.className = "lb-legend-item lb-legend-none";
    none.innerHTML = `<span class="lb-sw empty">—</span>none`;
    legend.appendChild(none);
  }
  foot.appendChild(legend);

  const showing = document.createElement("div");
  showing.className = "lb-showing";
  showing.append(`showing ${lb.shown} of ${lb.matched}`);
  if (lb.hidden > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "lb-more";
    more.textContent = `+${lb.hidden} more`;
    more.addEventListener("click", () => onView({ ...view, topN: "all" }));
    showing.append(" · ", more);
  }
  foot.appendChild(showing);

  return foot;
}

function fmtPct(frac: number, dp: number): string {
  return `${(frac * 100).toFixed(dp)}%`;
}

function clampPct(p: number): number {
  return p < 0 ? 0 : p > 100 ? 100 : p;
}

export function renderSessions(host: HTMLElement, rows: SessionRow[]): void {
  host.innerHTML = "";
  if (rows.length === 0) {
    host.innerHTML = `<div class="cov-empty">No sessions yet</div>`;
    return;
  }
  for (const row of rows) {
    const el = document.createElement("div");
    el.className = "session";
    const when = relativeDate(row.start_ts);
    const dur = formatDuration(row.end_ts - row.start_ts);
    const repo = row.repo
      ? `<span class="repo">${escHtml(row.repo)}</span>`
      : `<span class="repo dim">—</span>`;
    const branch = row.branch
      ? `<span class="slash">/</span><span class="branch">${escHtml(row.branch)}</span>`
      : "";
    const group = row.group_name
      ? `<span class="group">${escHtml(displayGroupName(row.group_name))}</span>`
      : "";
    el.innerHTML = `
      <div class="when">${when}</div>
      <div class="what">
        <div class="what-line">${repo}${branch}</div>
        ${group ? `<div class="what-meta">${group}</div>` : ""}
      </div>
      <div class="nums"><b>${row.prompts}</b> prompts</div>
      <div class="nums"><b>${row.commits}</b> commits · ${dur}</div>
    `;
    host.appendChild(el);
  }
}

export function displayGroupName(name: string): string {
  return name
    .split(/(\s+|-|_)/)
    .map((part) => {
      if (/^(\s+|-|_)$/u.test(part) || part === "") return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join("");
}

function relativeDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((todayStart.getTime() - dStart.getTime()) / 86400000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diffDays === 0) return `today · ${hm}`;
  if (diffDays === 1) return `yest · ${hm}`;
  return `${diffDays}d ago · ${hm}`;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "—";
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, "0")}m`;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
