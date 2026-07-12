import { describe, it, expect } from "vitest";
import { liftRow, liftClass, groupVerdict } from "./lift";

describe("liftRow", () => {
  it("computes a positive lift for a clean A/B", () => {
    const r = liftRow({ skill: "kyc", passed: 8, total: 10, baseline_passed: 6, baseline_total: 10 });
    expect(r.sign).toBe("pos");
    expect(r.pct).toBe(20); // 80% - 60%
    expect(r.label).toContain("+20");
    expect(r.label).toContain("80%");
    expect(r.label).toContain("60%");
  });

  it("flags negative lift", () => {
    const r = liftRow({ skill: "x", passed: 5, total: 10, baseline_passed: 7, baseline_total: 10 });
    expect(r.sign).toBe("neg");
    expect(r.pct).toBe(-20);
  });

  it("falls back to absolute pass-rate when the A/B is incomplete", () => {
    const r = liftRow({ skill: "x", passed: 8, total: 10, baseline_passed: 0, baseline_total: 0 });
    expect(r.sign).toBe("none");
    expect(r.label).toContain("80%"); // absolute only, no lift
  });
});

describe("groupVerdict", () => {
  it("summarizes average lift across clean-A/B skills", () => {
    const v = groupVerdict([
      { skill: "a", passed: 8, total: 10, baseline_passed: 6, baseline_total: 10 }, // +20
      { skill: "b", passed: 9, total: 10, baseline_passed: 5, baseline_total: 10 }, // +40
    ]);
    expect(v).toContain("+30"); // average
  });
});

describe("liftClass", () => {
  it("earning for positive clean-A/B lift", () => {
    const b = liftClass({ skill: "kyc", passed: 8, total: 10, baseline_passed: 6, baseline_total: 10 });
    expect(b.kind).toBe("earning");
    expect(b.text).toBe("+20 earning");
  });
  it("not-earning for zero or negative lift", () => {
    expect(liftClass({ skill: "x", passed: 5, total: 10, baseline_passed: 7, baseline_total: 10 }).kind).toBe("not-earning");
    expect(liftClass({ skill: "x", passed: 5, total: 10, baseline_passed: 7, baseline_total: 10 }).text).toBe("-20 not earning");
    expect(liftClass({ skill: "y", passed: 6, total: 10, baseline_passed: 6, baseline_total: 10 }).kind).toBe("not-earning"); // 0 lift
  });
  it("unmeasured when the A/B is incomplete", () => {
    expect(liftClass({ skill: "x", passed: 8, total: 10, baseline_passed: 0, baseline_total: 0 }).kind).toBe("unmeasured");
    expect(liftClass({ skill: "x", passed: 8, total: 10, baseline_passed: 0, baseline_total: 0 }).text).toBe("no baseline");
  });
});

describe("groupVerdict names prune candidates", () => {
  it("names the ≤0-lift skills", () => {
    const v = groupVerdict([
      { skill: "kyc", passed: 8, total: 10, baseline_passed: 6, baseline_total: 10 },   // +20
      { skill: "legacy-x", passed: 5, total: 10, baseline_passed: 7, baseline_total: 10 }, // -20
    ]);
    expect(v).toContain("legacy-x");
    expect(v).toContain("review");
    expect(v).not.toContain("kyc don"); // earning skills are not named as prune candidates
  });
});
