import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("returns 0 for empty query", () => {
    expect(fuzzyScore("foo/bar.rs", "")).toBe(0);
  });
  it("returns null when query is not a subsequence", () => {
    expect(fuzzyScore("foo.rs", "zzz")).toBeNull();
  });
  it("prefers basename prefix over deep midpath", () => {
    const a = fuzzyScore("b/api.ts", "api")!;
    const b = fuzzyScore("a/api-helpers/zzz.ts", "api")!;
    expect(a).toBeGreaterThan(b);
  });
  it("is case-insensitive", () => {
    expect(fuzzyScore("README.md", "rEAd")).not.toBeNull();
  });
  it("matches basename prefix even when an earlier mid-path char would consume the query", () => {
    // 'api' as basename of crates/app/src/api.ts: greedy from 0 would
    // consume 'a' in 'crates', 'p' in 'app', 'i' in 'src' — missing the
    // basename prefix. The two-pass approach must still credit the
    // basename hit.
    const deep = fuzzyScore("crates/app/src/api.ts", "api")!;
    const shallow = fuzzyScore("api.ts", "api")!;
    // Both should be strong; deep should not exceed shallow.
    expect(deep).not.toBeNull();
    expect(shallow).toBeGreaterThanOrEqual(deep);
  });
});
