/// Pure search/rank helpers for the global tab finder. DOM-free so we
/// can unit-test the filter logic in isolation.

export interface TabRow {
  workspaceId: string;
  workspaceName: string;
  workspaceColor: string | null;
  workspaceActive: boolean;
  groupId: string | null;
  groupName: string | null;
  groupColor: string | null;
  tabIndex: number;
  title: string;
  isActiveTabInWorkspace: boolean;
}

const MAX_RESULTS = 50;

type Tier = 0 | 1 | 2 | 3;

function tier(query: string, row: TabRow): Tier | null {
  const q = query;
  const title = row.title.toLowerCase();
  if (title.startsWith(q)) return 0;
  if (title.includes(q)) return 1;
  if ((row.groupName ?? "").toLowerCase().includes(q)) return 2;
  if (row.workspaceName.toLowerCase().includes(q)) return 3;
  return null;
}

export function filterAndRankTabs(query: string, rows: TabRow[]): TabRow[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const scored: Array<{ row: TabRow; tier: Tier; ord: number }> = [];
  rows.forEach((row, ord) => {
    const t = tier(q, row);
    if (t !== null) scored.push({ row, tier: t, ord });
  });
  scored.sort((a, b) => (a.tier - b.tier) || (a.ord - b.ord));
  return scored.slice(0, MAX_RESULTS).map((s) => s.row);
}
