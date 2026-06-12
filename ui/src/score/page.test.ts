import { describe, expect, test } from "vitest";
import { reposTitle } from "./page";

describe("reposTitle", () => {
  test("reflects the all-time filter instead of a hardcoded 30d", () => {
    expect(reposTitle({ range: "all" })).toBe("By repo · all time");
  });

  test("reflects 30d and 7d ranges", () => {
    expect(reposTitle({ range: "last30d" })).toBe("By repo · 30 days");
    expect(reposTitle({ range: "last7d" })).toBe("By repo · 7 days");
  });
});
