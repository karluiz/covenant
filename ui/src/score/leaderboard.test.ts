import { describe, it, expect } from "vitest";
import type { GroupCell } from "./api";
import {
  buildLeaderboard,
  nextSort,
  nextTopN,
  defaultGroupView,
  type GroupView,
} from "./leaderboard";

const CELLS: GroupCell[] = [
  { group_name: "Covenant", workspace: "PANDORAS", prompts: 455 },
  { group_name: "Groowcity", workspace: "PANDORAS", prompts: 123 },
  { group_name: "Workshop", workspace: "WORKSHOP", prompts: 67 },
  { group_name: "Wabot", workspace: "PANDORAS", prompts: 43 },
  { group_name: "Bo", workspace: null, prompts: 40 },
  { group_name: "Llmapps", workspace: null, prompts: 36 },
  { group_name: "Legacy", workspace: "WORKSPACE 7", prompts: 24 },
];

const GRAND = 455 + 123 + 67 + 43 + 40 + 36 + 24; // 788

function view(over: Partial<GroupView> = {}): GroupView {
  return { sort: "prompts", topN: "all", query: "", ...over };
}

describe("buildLeaderboard — totals", () => {
  it("computes grand total, count, average, maxPrompts", () => {
    const lb = buildLeaderboard(CELLS, view());
    expect(lb.grandTotal).toBe(GRAND);
    expect(lb.count).toBe(7);
    expect(lb.avg).toBeCloseTo(GRAND / 7, 5);
    expect(lb.maxPrompts).toBe(455);
  });

  it("handles an empty dataset without dividing by zero", () => {
    const lb = buildLeaderboard([], view());
    expect(lb.grandTotal).toBe(0);
    expect(lb.count).toBe(0);
    expect(lb.avg).toBe(0);
    expect(lb.rows).toHaveLength(0);
    expect(lb.maxPrompts).toBe(1);
  });
});

describe("buildLeaderboard — rank / share / cumulative", () => {
  it("ranks by prompts DESC starting at 1", () => {
    const lb = buildLeaderboard(CELLS, view());
    expect(lb.rows[0]).toMatchObject({ group_name: "Covenant", rank: 1 });
    expect(lb.rows[1]).toMatchObject({ group_name: "Groowcity", rank: 2 });
  });

  it("share is prompts / grandTotal", () => {
    const lb = buildLeaderboard(CELLS, view());
    expect(lb.rows[0]!.share).toBeCloseTo(455 / GRAND, 6);
  });

  it("cumulative is monotonic non-decreasing and ends at ~1", () => {
    const lb = buildLeaderboard(CELLS, view());
    const cum = lb.rows.map((r) => r.cumulative);
    for (let i = 1; i < cum.length; i++) expect(cum[i]!).toBeGreaterThanOrEqual(cum[i - 1]!);
    expect(cum[cum.length - 1]!).toBeCloseTo(1, 6);
    expect(lb.rows[0]!.cumulative).toBeCloseTo(455 / GRAND, 6);
  });

  it("bar percentage is scaled to the busiest group", () => {
    const lb = buildLeaderboard(CELLS, view());
    expect(lb.rows[0]!.barPct).toBeCloseTo(100, 5); // leader fills the track
    expect(lb.rows[1]!.barPct).toBeCloseTo((123 / 455) * 100, 5);
  });

  it("keeps rank/cumulative anchored to prompts order even when sorted by name", () => {
    const lb = buildLeaderboard(CELLS, view({ sort: "name" }));
    const covenant = lb.rows.find((r) => r.group_name === "Covenant")!;
    expect(covenant.rank).toBe(1); // still #1 by prompts despite alpha sort
  });
});

describe("buildLeaderboard — query filter", () => {
  it("filters by group name, case-insensitive", () => {
    const lb = buildLeaderboard(CELLS, view({ query: "shop" }));
    expect(lb.rows.map((r) => r.group_name)).toEqual(["Workshop"]);
    expect(lb.matched).toBe(1);
  });

  it("matches on workspace too", () => {
    const lb = buildLeaderboard(CELLS, view({ query: "pandoras" }));
    expect(lb.rows.map((r) => r.group_name).sort()).toEqual(
      ["Covenant", "Groowcity", "Wabot"].sort(),
    );
  });

  it("share stays anchored to the full grand total under a filter", () => {
    const lb = buildLeaderboard(CELLS, view({ query: "covenant" }));
    expect(lb.rows[0]!.share).toBeCloseTo(455 / GRAND, 6); // not 455/455
    expect(lb.grandTotal).toBe(GRAND);
  });
});

describe("buildLeaderboard — topN", () => {
  it("limits rows and reports the hidden count", () => {
    const lb = buildLeaderboard(CELLS, view({ topN: 3 }));
    expect(lb.shown).toBe(3);
    expect(lb.hidden).toBe(4);
    expect(lb.rows.map((r) => r.group_name)).toEqual(["Covenant", "Groowcity", "Workshop"]);
  });

  it("'all' shows everything with zero hidden", () => {
    const lb = buildLeaderboard(CELLS, view({ topN: "all" }));
    expect(lb.shown).toBe(7);
    expect(lb.hidden).toBe(0);
  });

  it("hidden reflects the matched set, not the full set", () => {
    const lb = buildLeaderboard(CELLS, view({ query: "pandoras", topN: 2 }));
    expect(lb.matched).toBe(3);
    expect(lb.shown).toBe(2);
    expect(lb.hidden).toBe(1);
  });
});

describe("buildLeaderboard — sort", () => {
  it("name sorts alphabetically", () => {
    const lb = buildLeaderboard(CELLS, view({ sort: "name" }));
    const names = lb.rows.map((r) => r.group_name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("workspace clusters the busiest workspace first and pushes null last", () => {
    const lb = buildLeaderboard(CELLS, view({ sort: "workspace" }));
    const names = lb.rows.map((r) => r.group_name);
    // PANDORAS (621) before WORKSHOP (67) before WORKSPACE 7 (24); null (Bo, Llmapps) last.
    expect(names.slice(0, 3)).toEqual(["Covenant", "Groowcity", "Wabot"]);
    expect(names.slice(-2).sort()).toEqual(["Bo", "Llmapps"]);
  });
});

describe("buildLeaderboard — workspace subtotals", () => {
  it("aggregates named workspaces DESC and excludes null", () => {
    const lb = buildLeaderboard(CELLS, view());
    expect(lb.workspaces.map((w) => w.name)).toEqual(["PANDORAS", "WORKSHOP", "WORKSPACE 7"]);
    expect(lb.workspaces[0]).toMatchObject({ name: "PANDORAS", prompts: 621, count: 3 });
    expect(lb.workspaces[0]!.share).toBeCloseTo(621 / GRAND, 6);
  });
});

describe("control cycles", () => {
  it("nextSort cycles prompts → name → workspace → prompts", () => {
    expect(nextSort("prompts")).toBe("name");
    expect(nextSort("name")).toBe("workspace");
    expect(nextSort("workspace")).toBe("prompts");
  });

  it("nextTopN cycles 8 → 12 → all → 8", () => {
    expect(nextTopN(8)).toBe(12);
    expect(nextTopN(12)).toBe("all");
    expect(nextTopN("all")).toBe(8);
  });

  it("defaultGroupView collapses long lists to Top 12", () => {
    expect(defaultGroupView(20).topN).toBe(12);
    expect(defaultGroupView(5).topN).toBe("all");
  });
});
