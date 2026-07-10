import { describe, it, expect } from "vitest";
import { liftRow, groupVerdict } from "./lift";

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
