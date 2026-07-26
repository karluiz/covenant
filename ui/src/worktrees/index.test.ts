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
  worktreeDetail: vi.fn(async () => ({
    last_subject: "s", insertions: 3, deletions: 1,
    base_branch: "main", ahead: 2, behind: 5,
    commits_ahead: [
      { subject: "feat: second", unix: 1_700_000_100 },
      { subject: "feat: first", unix: 1_700_000_000 },
    ],
  })),
  gitChanges: vi.fn(async () => ({
    staged: [],
    unstaged: [{ path: "src/a.ts", oldPath: null, status: "modified", added: 3, removed: 1, binary: false }],
  })),
  worktreeReclaim: (...args: [string, string[]]) => reclaimMock(...args),
  explainChanges: vi.fn(async () => "Adds a thing."),
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
    // Reclaim runs one call per path so the button can show n/N progress.
    await vi.waitFor(() => expect(reclaimMock).toHaveBeenCalledTimes(2));
    expect(reclaimMock).toHaveBeenNthCalledWith(1, "/r", ["/r/.covenant/worktrees/a"]);
    expect(reclaimMock).toHaveBeenNthCalledWith(2, "/r", ["/r/.covenant/worktrees/b"]);
    surface.close();
  });

  it("detail panel renders sync chips, commits ahead, diffstat rows, and presence", async () => {
    summary.worktrees = [
      wt({ path: "/r", branch: "main", is_main: true, current: true, state: "active" }),
      wt({ path: "/r/.covenant/worktrees/a", branch: "agent/a", state: "active", dirty_count: 1, last_commit_unix: 1_700_000_100 }),
    ];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const surface = new WorktreesSurface(host, {
      onOpenTab: () => {}, onResumeAgent: () => {}, getOccupiedCwds: () => new Set(),
      getTabForCwd: (p) => (p === "/r/.covenant/worktrees/a" ? { id: "t1", label: "agent tab" } : null),
      onGoToTab: vi.fn(),
    });
    await surface.open("/r");

    // Select the linked worktree; loadDetail resolves async.
    const row = [...host.querySelectorAll<HTMLElement>(".wt-row")]
      .find((r) => r.textContent?.includes("agent-a") || r.dataset.path?.endsWith("/a"))!;
    row.click();
    await vi.waitFor(() => expect(host.querySelector(".wt-d-commit")).not.toBeNull());

    const chips = [...host.querySelectorAll(".wt-d-chip")].map((c) => c.textContent);
    expect(chips.some((c) => c?.includes("2 ahead"))).toBe(true);
    expect(chips.some((c) => c?.includes("5 behind main"))).toBe(true);

    const commits = [...host.querySelectorAll(".wt-d-commit-subject")].map((c) => c.textContent);
    expect(commits).toEqual(["feat: second", "feat: first"]);

    const file = host.querySelector(".wt-d-filerow");
    expect(file?.textContent).toContain("src/a.ts");
    expect(file?.textContent).toContain("+3");

    expect(host.querySelector(".wt-d-session-text")?.textContent).toContain("agent tab");
    surface.close();
  });
});
