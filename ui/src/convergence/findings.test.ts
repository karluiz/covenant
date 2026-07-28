// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { clearGroupFindings, groupFindings, recordGroupFinding } from "./findings";

const finding = (groupId: string, n: number) => ({
  groupId, operatorName: "Warden", message: `finding ${n}`, atUnixMs: n,
});

describe("group findings ring", () => {
  beforeEach(clearGroupFindings);

  it("keeps findings newest-first, scoped per group", () => {
    recordGroupFinding(finding("g1", 1));
    recordGroupFinding(finding("g2", 2));
    recordGroupFinding(finding("g1", 3));
    expect(groupFindings("g1").map((f) => f.message)).toEqual(["finding 3", "finding 1"]);
    expect(groupFindings("g2").map((f) => f.message)).toEqual(["finding 2"]);
  });

  it("caps at 20 per group, dropping the oldest", () => {
    for (let n = 1; n <= 25; n++) recordGroupFinding(finding("g1", n));
    const out = groupFindings("g1");
    expect(out).toHaveLength(20);
    expect(out[0].message).toBe("finding 25");
    expect(out[19].message).toBe("finding 6");
  });

  it("returns empty for a group that never produced one", () => {
    expect(groupFindings("nope")).toEqual([]);
  });
});
