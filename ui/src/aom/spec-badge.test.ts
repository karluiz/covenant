import { beforeEach, describe, expect, it } from "vitest";
import { createSpecPromptState } from "./spec-prompt-state";
import { mountSpecBadge } from "./spec-badge";

const noopHost = {
  setMissionForTab: async () => {},
  openSpec: async () => {},
};

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
    ], noopHost);
    expect(host.querySelector(".spec-badge")?.classList.contains("hidden")).toBe(true);
  });

  it("shows count when pending exists", () => {
    const state = createSpecPromptState();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const tabs = [{ id: "t1", cwd: "/repo", hasMission: false, hasOperator: true }];
    mountSpecBadge(host, "t1", state, () => tabs, noopHost);
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

  it("opens popover on click and assigns spec to tab", async () => {
    const state = createSpecPromptState();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const tabs = [{ id: "t1", cwd: "/repo", hasMission: false, hasOperator: true }];
    let assigned: { tabId: string; path: string } | null = null;
    mountSpecBadge(host, "t1", state, () => tabs, {
      setMissionForTab: async (tabId, path) => { assigned = { tabId, path }; },
      openSpec: async () => {},
    });
    state.recordCandidate(
      { path: "/repo/docs/specs/a.md", repo_root: "/repo", source: "covenant", goal_snippet: "goal", title: null },
      Date.now(),
    );
    (host.querySelector(".spec-badge") as HTMLButtonElement).click();
    const item = document.querySelector(".spec-badge-popover .spec-badge-set") as HTMLButtonElement;
    expect(item).toBeTruthy();
    item.click();
    await Promise.resolve();
    expect(assigned).toEqual({ tabId: "t1", path: "/repo/docs/specs/a.md" });
  });
});
