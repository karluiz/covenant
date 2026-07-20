import { describe, expect, test } from "vitest";
import { reposTitle, intensityCeiling, intensityClass } from "./page";

describe("heatmap intensity", () => {
  test("empty and all-zero data yield no ceiling and no shading", () => {
    expect(intensityCeiling([])).toBe(0);
    expect(intensityCeiling([0, 0, 0])).toBe(0);
    expect(intensityClass(0, 0)).toBe("");
    expect(intensityClass(5, 0)).toBe("");
  });

  test("a single outlier day does not flatten the rest to l1", () => {
    // p90 ignores the 500-commit rebase, so ordinary days keep gradient.
    const counts = [4, 6, 8, 10, 12, 14, 16, 18, 20, 500];
    const ceiling = intensityCeiling(counts);
    expect(ceiling).toBeLessThan(500);
    expect(intensityClass(4, ceiling)).toBe("l1");
    expect(intensityClass(20, ceiling)).toBe("l4");
    // The outlier still clamps to the top shade rather than overflowing.
    expect(intensityClass(500, ceiling)).toBe("l4");
  });

  test("re-tunes across scales instead of saturating", () => {
    // The pre-406822b8 regime (~1900 machine prompts/day) and the
    // post-fix one (~139 human prompts/day) must both show gradient.
    for (const peak of [1900, 139]) {
      const ceiling = intensityCeiling([peak / 4, peak / 2, peak]);
      expect(intensityClass(peak, ceiling)).toBe("l4");
      expect(intensityClass(peak / 4, ceiling)).toBe("l1");
    }
  });

  test("any nonzero count is visible", () => {
    // One prompt on a 500-commit-ceiling profile must not render as empty.
    expect(intensityClass(1, 500)).toBe("l1");
  });
});

describe("reposTitle", () => {
  test("reflects the all-time filter instead of a hardcoded 30d", () => {
    expect(reposTitle({ range: "all" })).toBe("By repo · all time");
  });

  test("reflects 30d and 7d ranges", () => {
    expect(reposTitle({ range: "last30d" })).toBe("By repo · 30 days");
    expect(reposTitle({ range: "last7d" })).toBe("By repo · 7 days");
  });
});
