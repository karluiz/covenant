import { describe, it, expect } from "vitest";
import {
  createSpecPromptState,
  type TabSnapshot,
} from "./spec-prompt-state";
import type { SpecCandidate } from "../api";

const cand = (over: Partial<SpecCandidate> = {}): SpecCandidate => ({
  repo_root: "/tmp/repo",
  path: "/tmp/repo/docs/specs/3.16-foo.md",
  source: "covenant",
  title: "3.16 — Foo",
  goal_snippet: "Does the foo.",
  ...over,
});

const tab = (over: Partial<TabSnapshot> = {}): TabSnapshot => ({
  id: "t1",
  cwd: "/tmp/repo/sub",
  hasMission: false,
  hasOperator: true,
  ...over,
});

describe("specPromptState", () => {
  it("returns eligible tabs only (cwd ⊂ repo, no mission, has operator)", () => {
    const s = createSpecPromptState();
    const tabs = [
      tab({ id: "ok" }),
      tab({ id: "wrong-repo", cwd: "/elsewhere" }),
      tab({ id: "with-mission", hasMission: true }),
      tab({ id: "no-operator", hasOperator: false }),
    ];
    const elig = s.eligibleTabs(cand(), tabs);
    expect(elig.map((t) => t.id)).toEqual(["ok"]);
  });

  it("dismiss prevents future toasts for that tab/path", () => {
    const s = createSpecPromptState();
    const c = cand();
    s.recordCandidate(c, 1000);
    s.dismiss("t1", c.path);
    expect(s.isDismissed("t1", c.path)).toBe(true);
    expect(s.isDismissed("t2", c.path)).toBe(false);
  });

  it("getPendingForTab returns candidates within the 10-min window", () => {
    const s = createSpecPromptState();
    const c1 = cand({ path: "/r/a.md" });
    const c2 = cand({ path: "/r/b.md" });
    s.recordCandidate(c1, 0);
    s.recordCandidate(c2, 9 * 60 * 1000);

    const pending = s.getPendingForTab(
      tab(),
      [tab()],
      10 * 60 * 1000 - 1,
    );
    expect(pending.map((c) => c.path).sort()).toEqual(["/r/a.md", "/r/b.md"]);
  });

  it("getPendingForTab drops candidates older than 10 min", () => {
    const s = createSpecPromptState();
    const c = cand();
    s.recordCandidate(c, 0);
    const pending = s.getPendingForTab(tab(), [tab()], 11 * 60 * 1000);
    expect(pending).toEqual([]);
  });

  it("getPendingForTab excludes dismissed", () => {
    const s = createSpecPromptState();
    const c = cand();
    s.recordCandidate(c, 0);
    s.dismiss("t1", c.path);
    const pending = s.getPendingForTab(tab(), [tab()], 1000);
    expect(pending).toEqual([]);
  });

  it("acceptOnTab clears the candidate from pending for that tab", () => {
    const s = createSpecPromptState();
    const c = cand();
    s.recordCandidate(c, 0);
    s.acceptOnTab("t1", c.path);
    const pending = s.getPendingForTab(tab(), [tab()], 1000);
    expect(pending).toEqual([]);
  });
});
