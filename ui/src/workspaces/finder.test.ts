import { describe, expect, it } from "vitest";
import { filterAndRankTabs, type TabRow } from "./finder";

function row(p: Partial<TabRow>): TabRow {
  return {
    workspaceId: "ws-1",
    workspaceName: "Workspace 1",
    workspaceColor: null,
    workspaceActive: false,
    groupId: null,
    groupName: null,
    groupColor: null,
    tabIndex: 0,
    title: "tab",
    isActiveTabInWorkspace: false,
    ...p,
  };
}

describe("filterAndRankTabs", () => {
  it("returns empty when query is blank", () => {
    expect(filterAndRankTabs("", [row({})])).toEqual([]);
    expect(filterAndRankTabs("   ", [row({})])).toEqual([]);
  });

  it("matches title substring, case-insensitive", () => {
    const rows = [row({ title: "Migration" }), row({ title: "tests" })];
    expect(filterAndRankTabs("MIG", rows).map((r) => r.title)).toEqual(["Migration"]);
  });

  it("ranks title startsWith above title contains", () => {
    const rows = [
      row({ title: "run-migration", tabIndex: 0 }),
      row({ title: "migration-tests", tabIndex: 1 }),
    ];
    const out = filterAndRankTabs("migration", rows);
    expect(out.map((r) => r.title)).toEqual(["migration-tests", "run-migration"]);
  });

  it("ranks title hits above group hits above workspace hits", () => {
    const rows = [
      row({ title: "alpha", workspaceName: "banco" }),
      row({ title: "beta", groupName: "banco-group" }),
      row({ title: "banco", workspaceName: "other" }),
    ];
    const out = filterAndRankTabs("banco", rows).map((r) => r.title);
    expect(out).toEqual(["banco", "beta", "alpha"]);
  });

  it("caps results at 50", () => {
    const rows: TabRow[] = [];
    for (let i = 0; i < 80; i++) rows.push(row({ title: `tab-${i}`, tabIndex: i }));
    expect(filterAndRankTabs("tab", rows)).toHaveLength(50);
  });

  it("filters out non-matching rows", () => {
    const rows = [row({ title: "alpha" }), row({ title: "beta" })];
    expect(filterAndRankTabs("zzz", rows)).toEqual([]);
  });
});
