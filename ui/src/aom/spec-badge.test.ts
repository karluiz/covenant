import { beforeEach, describe, expect, it } from "vitest";
import { createSpecPromptState } from "./spec-prompt-state";
import { mountSpecBadge } from "./spec-badge";

describe("spec badge", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("hidden when no pending candidates", () => {
    const state = createSpecPromptState();
    const host = document.createElement("div");
    document.body.appendChild(host);
    mountSpecBadge(host, "t1", state, () => [
      { id: "t1", cwd: "/repo", hasMission: false, hasOperator: true },
    ]);
    expect(host.querySelector(".spec-badge")?.classList.contains("hidden")).toBe(true);
  });

  it("shows count when pending exists", () => {
    const state = createSpecPromptState();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const tabs = [{ id: "t1", cwd: "/repo", hasMission: false, hasOperator: true }];
    mountSpecBadge(host, "t1", state, () => tabs);
    state.recordCandidate(
      { path: "/repo/docs/specs/a.md", repo_root: "/repo", source: "covenant", goal_snippet: "g", title: null },
      Date.now(),
    );
    state.recordCandidate(
      { path: "/repo/docs/specs/b.md", repo_root: "/repo", source: "covenant", goal_snippet: "g", title: null },
      Date.now(),
    );
    const badge = host.querySelector(".spec-badge") as HTMLElement;
    expect(badge.classList.contains("hidden")).toBe(false);
    expect(badge.textContent).toContain("2");
  });
});
