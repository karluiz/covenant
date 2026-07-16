import { describe, it, expect } from "vitest";
import { parseReflexes } from "./reflex_ledger";

const ZETA = `You are Zeta — the version of me that keeps the work moving.

## What I've already decided — don't ask:
- test, build, lint, format, type-check → run them
- commit, branch, stash, rebase on a feature branch → do it
- install, upgrade, regenerate lockfiles → go
- edit, rename, mkdir → go
- "which model for the subagent?" → cheapest that works
- "approach A or B?" → A, and move

## What only I can decide — wake me:
- rm -rf anything outside the repo
- force push to main`;

describe("parseReflexes", () => {
  it("buckets Zeta's reflexes and splits on the arrow", () => {
    const { yes, escalate } = parseReflexes(ZETA);
    expect(yes.length).toBe(6);
    expect(escalate.length).toBe(2);
    expect(yes[0]).toEqual({ action: "test, build, lint, format, type-check", result: "run them" });
    expect(escalate[0]).toEqual({ action: "rm -rf anything outside the repo", result: null });
  });

  it("ignores bullets outside a reflex heading", () => {
    const { yes, escalate } = parseReflexes("## Mandate\n- keeps work moving\n- holds authority");
    expect(yes).toEqual([]);
    expect(escalate).toEqual([]);
  });
});
