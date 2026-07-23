import { describe, it, expect, vi, beforeEach } from "vitest";

// The surface fetches repo data on open; stub the api so the test is shell-only.
vi.mock("../api", () => ({
  gitRepoSummary: vi.fn(async () => ({
    repo_name: "r", repo_root: "/r", current_branch: "main", detached_head: null,
    dirty_count: 0, branches: [], worktrees: [], default_branch: "main",
  })),
  worktreeSizes: vi.fn(async () => []),
}));

import { WorktreesSurface } from "./index";

describe("WorktreesSurface", () => {
  beforeEach(() => { document.body.innerHTML = ""; document.body.className = ""; });

  it("opens, mounts a frame, toggles the body class, and closes on Escape", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const surface = new WorktreesSurface(host);

    expect(surface.isOpen).toBe(false);
    await surface.open("/r");
    expect(surface.isOpen).toBe(true);
    expect(host.querySelector(".wt-frame")).not.toBeNull();
    expect(document.body.classList.contains("worktrees-fullscreen")).toBe(true);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(surface.isOpen).toBe(false);
    expect(host.innerHTML).toBe("");
    expect(document.body.classList.contains("worktrees-fullscreen")).toBe(false);
  });
});
