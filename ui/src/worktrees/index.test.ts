import { describe, it, expect, vi, beforeEach } from "vitest";

// The surface fetches repo data on open; stub the api so the test is DOM-only.
const summary = {
  repo_name: "r", repo_root: "/r", current_branch: "main", detached_head: null,
  dirty_count: 0, branches: [], worktrees: [] as unknown[], default_branch: "main",
};
const reclaimMock = vi.fn(async (_cwd: string, paths: string[]) =>
  paths.map((path) => ({ path, removed: true, reason: null })));
vi.mock("../api", () => ({
  gitRepoSummary: vi.fn(async () => summary),
  worktreeSizes: vi.fn(async () => []),
  devLiveWorktreeRoot: vi.fn(async () => null),
  worktreeDetail: vi.fn(async () => ({ last_subject: "s", insertions: 0, deletions: 0 })),
  gitChanges: vi.fn(async () => ({ staged: [], unstaged: [] })),
  worktreeReclaim: (...args: [string, string[]]) => reclaimMock(...args),
}));

// Confirm toasts render into app chrome outside the surface host; run
// onConfirm synchronously so the test stays DOM-only.
vi.mock("../notifications/toast", () => ({
  pushConfirmToast: (o: { onConfirm: () => void }) => o.onConfirm(),
  pushInfoToast: vi.fn(),
}));

import { WorktreesSurface } from "./index";

function wt(over: Record<string, unknown>): unknown {
  return {
    path: "/w", branch: "b", head: "abc", current: false, detached: false,
    bare: false, dirty_count: 0, state: "active", merged: false,
    last_commit_unix: null, off_convention: false, is_main: false, locked: null,
    ...over,
  };
}

function mount(): { host: HTMLElement; surface: WorktreesSurface } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const surface = new WorktreesSurface(host, {
    onOpenTab: () => {}, onResumeAgent: () => {}, getOccupiedCwds: () => new Set(),
  });
  return { host, surface };
}

describe("WorktreesSurface", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.body.className = "";
    summary.worktrees = [];
    reclaimMock.mockClear();
  });

  it("opens, mounts a frame, toggles the body class, and closes on Escape", async () => {
    const { host, surface } = mount();

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

  it("renders state group headers with a Reclaim all button on SPENT", async () => {
    summary.worktrees = [
      wt({ path: "/r", branch: "main", is_main: true, current: true, state: "active" }),
      wt({ path: "/r/.covenant/worktrees/a", branch: "agent/a", state: "spent", merged: true }),
      wt({ path: "/r/.covenant/worktrees/b", branch: "agent/b", state: "spent", merged: true }),
    ];
    const { host, surface } = mount();
    await surface.open("/r");

    const heads = [...host.querySelectorAll(".wt-group-head .wt-group-label")].map((el) => el.textContent);
    expect(heads).toEqual(["spent", "active"]);
    const meta = host.querySelector(".wt-group-head .wt-group-meta");
    expect(meta?.textContent).toContain("2 worktrees");

    const btn = host.querySelector<HTMLButtonElement>(".wt-group-reclaim");
    expect(btn).not.toBeNull();
    btn!.click();
    expect(reclaimMock).toHaveBeenCalledWith("/r", [
      "/r/.covenant/worktrees/a", "/r/.covenant/worktrees/b",
    ]);
    surface.close();
  });
});
