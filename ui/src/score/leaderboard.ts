import type { GroupCell } from "./api";

// ── Ranked-leaderboard model for the "By group" card ────────────────────────
//
// Pure, side-effect-free derivations over the GroupCell[] the backend already
// returns (sorted DESC by prompts). Everything here — rank, share-of-total,
// cumulative (Pareto) %, average, workspace subtotals — is computed client-side
// with no extra backend call. The renderer in breakdowns.ts consumes this.

export type GroupSort = "prompts" | "name" | "workspace";

export interface GroupView {
  sort: GroupSort;
  /** Max rows to display, or "all" to show every matched group. */
  topN: number | "all";
  /** Case-insensitive substring filter over group name + workspace. */
  query: string;
}

export interface LeaderRow {
  group_name: string;
  workspace: string | null;
  prompts: number;
  /** 1-based rank by prompts DESC — stable regardless of the active sort. */
  rank: number;
  /** prompts / grandTotal, 0..1. */
  share: number;
  /** Running share down the prompts-DESC order, 0..1 (the Pareto curve). */
  cumulative: number;
  /** prompts / maxPrompts * 100 — bar length, scaled so the leader reads full. */
  barPct: number;
}

export interface WorkspaceSubtotal {
  name: string;
  prompts: number;
  /** prompts / grandTotal, 0..1. */
  share: number;
  count: number;
}

export interface Leaderboard {
  rows: LeaderRow[];
  /** Σ prompts over ALL cells (not affected by query/topN). */
  grandTotal: number;
  /** Total group count over ALL cells. */
  count: number;
  /** Groups surviving the query filter (before topN). */
  matched: number;
  /** rows.length (after topN). */
  shown: number;
  /** matched - shown. */
  hidden: number;
  /** grandTotal / count. */
  avg: number;
  /** Max prompts among ALL cells (bar-scale anchor, ≥1). */
  maxPrompts: number;
  /** avg / maxPrompts * 100 — x-position of the average reference line. */
  avgPct: number;
  /** Named-workspace subtotals, DESC by prompts (drives legend + workspace sort). */
  workspaces: WorkspaceSubtotal[];
}

export const DEFAULT_GROUP_VIEW: GroupView = { sort: "prompts", topN: 12, query: "" };

export function defaultGroupView(cellCount: number): GroupView {
  return { sort: "prompts", topN: cellCount > 12 ? 12 : "all", query: "" };
}

/** Cycle order for the in-card Sort control. */
export function nextSort(s: GroupSort): GroupSort {
  return s === "prompts" ? "name" : s === "name" ? "workspace" : "prompts";
}

/** Cycle order for the in-card Top-N control. */
export function nextTopN(n: number | "all"): number | "all" {
  return n === 8 ? 12 : n === 12 ? "all" : 8;
}

export function buildLeaderboard(cells: GroupCell[], view: GroupView): Leaderboard {
  const count = cells.length;
  const grandTotal = cells.reduce((sum, c) => sum + c.prompts, 0);
  const maxPrompts = Math.max(1, ...cells.map((c) => c.prompts));
  const avg = count > 0 ? grandTotal / count : 0;
  const safeTotal = grandTotal > 0 ? grandTotal : 1;

  // Rank + cumulative are anchored to the prompts-DESC order over ALL cells, so
  // they stay meaningful even when the user re-sorts by name or workspace.
  const byPrompts = [...cells].sort(
    (a, b) => b.prompts - a.prompts || a.group_name.localeCompare(b.group_name),
  );
  const meta = new Map<string, { rank: number; cumulative: number }>();
  let running = 0;
  byPrompts.forEach((c, i) => {
    running += c.prompts;
    meta.set(c.group_name, { rank: i + 1, cumulative: running / safeTotal });
  });

  // Named-workspace subtotals (null = "Ungrouped", excluded from the legend).
  const wsTotals = new Map<string, { prompts: number; count: number }>();
  for (const c of cells) {
    if (!c.workspace) continue;
    const e = wsTotals.get(c.workspace) ?? { prompts: 0, count: 0 };
    e.prompts += c.prompts;
    e.count += 1;
    wsTotals.set(c.workspace, e);
  }
  const workspaces: WorkspaceSubtotal[] = [...wsTotals.entries()]
    .map(([name, e]) => ({ name, prompts: e.prompts, share: e.prompts / safeTotal, count: e.count }))
    .sort((a, b) => b.prompts - a.prompts || a.name.localeCompare(b.name));
  const wsRank = new Map(workspaces.map((w, i) => [w.name, i]));

  // Query filter.
  const q = view.query.trim().toLowerCase();
  const matchedCells = q
    ? cells.filter(
        (c) =>
          c.group_name.toLowerCase().includes(q) ||
          (c.workspace ?? "").toLowerCase().includes(q),
      )
    : [...cells];

  // Sort.
  const sorted = sortCells(matchedCells, view.sort, wsRank);

  // Top-N.
  const limit = view.topN === "all" ? sorted.length : Math.max(0, view.topN);
  const shownCells = sorted.slice(0, limit);

  const rows: LeaderRow[] = shownCells.map((c) => {
    const m = meta.get(c.group_name) ?? { rank: 0, cumulative: 0 };
    return {
      group_name: c.group_name,
      workspace: c.workspace,
      prompts: c.prompts,
      rank: m.rank,
      share: c.prompts / safeTotal,
      cumulative: m.cumulative,
      barPct: (c.prompts / maxPrompts) * 100,
    };
  });

  return {
    rows,
    grandTotal,
    count,
    matched: matchedCells.length,
    shown: rows.length,
    hidden: matchedCells.length - rows.length,
    avg,
    maxPrompts,
    avgPct: (avg / maxPrompts) * 100,
    workspaces,
  };
}

function sortCells(
  cells: GroupCell[],
  sort: GroupSort,
  wsRank: Map<string, number>,
): GroupCell[] {
  const out = [...cells];
  if (sort === "name") {
    out.sort((a, b) =>
      a.group_name.localeCompare(b.group_name, undefined, { sensitivity: "base" }),
    );
  } else if (sort === "workspace") {
    // Cluster by workspace subtotal (busiest workspace first); null last.
    // Within a workspace, keep prompts DESC.
    const key = (c: GroupCell): number =>
      c.workspace && wsRank.has(c.workspace) ? wsRank.get(c.workspace)! : Number.MAX_SAFE_INTEGER;
    out.sort(
      (a, b) =>
        key(a) - key(b) ||
        b.prompts - a.prompts ||
        a.group_name.localeCompare(b.group_name),
    );
  } else {
    // prompts (default)
    out.sort((a, b) => b.prompts - a.prompts || a.group_name.localeCompare(b.group_name));
  }
  return out;
}
