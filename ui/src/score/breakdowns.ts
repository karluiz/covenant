import type { RepoCell, BranchCell, GroupCell, SessionRow } from "./api";

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

export function renderGroupBars(host: HTMLElement, rows: GroupCell[]): void {
  host.innerHTML = "";
  if (rows.length === 0) {
    host.innerHTML = `<div class="cov-empty">No group data</div>`;
    return;
  }
  const maxP = Math.max(...rows.map((r) => r.prompts), 1);
  rows.forEach((row, i) => {
    const color = PALETTE[i % PALETTE.length];
    const pPct = (row.prompts / maxP) * 100;
    const el = document.createElement("div");
    el.className = "bar-row";
    const ws = row.workspace
      ? `<span class="ws-tag" style="color:${color}">${escHtml(row.workspace)}</span>`
      : "";
    el.innerHTML = `
      <div class="name"><span class="dotc" style="background:${color}"></span>${escHtml(displayGroupName(row.group_name))}${ws}</div>
      <div class="bar"><div class="seg-p" style="width:${pPct.toFixed(1)}%;background:${color}"></div></div>
      <div class="meta">${row.prompts} prompts</div>
    `;
    host.appendChild(el);
  });
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
