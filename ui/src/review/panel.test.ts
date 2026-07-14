import { describe, expect, it } from "vitest";
import { groupByHeading } from "./panel";
import type { ReviewComment } from "./api";

function comment(id: number, anchorHeading: string | null): ReviewComment {
  return {
    id,
    version: 1,
    anchorHeading,
    parentId: null,
    authorName: "reviewer",
    body: "body",
    resolved: false,
    createdAt: new Date(2026, 0, id).toISOString(),
  };
}

describe("groupByHeading", () => {
  it("puts the unanchored bucket first, then follows heading order", () => {
    const roots = [comment(1, "Goal"), comment(2, null), comment(3, "Title")];
    const groups = groupByHeading(roots, ["Title", "Goal"]);
    expect(groups.map((g) => g.heading)).toEqual([null, "Title", "Goal"]);
    expect(groups[0].items).toEqual([roots[1]]);
    expect(groups[1].items).toEqual([roots[2]]);
    expect(groups[2].items).toEqual([roots[0]]);
  });

  it("skips headings with no comments", () => {
    const roots = [comment(1, "Goal")];
    const groups = groupByHeading(roots, ["Title", "Goal", "Non-Goals"]);
    expect(groups.map((g) => g.heading)).toEqual(["Goal"]);
  });

  it("appends headings no longer present in the doc at the end", () => {
    const roots = [comment(1, "Renamed Section"), comment(2, "Goal")];
    const groups = groupByHeading(roots, ["Goal"]);
    expect(groups.map((g) => g.heading)).toEqual(["Goal", "Renamed Section"]);
  });

  it("returns no groups for an empty comment list", () => {
    expect(groupByHeading([], ["Title"])).toEqual([]);
  });
});
