// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

// --- Module-level stubs for Tauri-bound dependencies ---------------------
// bar.ts imports telegramStatus, getDirContext, etc. which call
// @tauri-apps/api/core#invoke at import time or in the constructor.
// We stub the whole module so jsdom doesn't explode.
const worktreeReclaimMock = vi.fn();
const worktreeSizesMock = vi.fn();
const gitRepoSummaryMock = vi.fn();
const worktreeRelocateMock = vi.fn();
vi.mock("../api", () => ({
  telegramStatus: vi.fn().mockResolvedValue("disabled"),
  getDirContext: vi.fn().mockResolvedValue({ git: null, runtime: null }),
  aomStatus: vi.fn().mockResolvedValue(null),
  gitRepoSummary: (cwd: string) => gitRepoSummaryMock(cwd),
  gitSwitchBranch: vi.fn().mockResolvedValue(null),
  getSessionMissionContent: vi.fn().mockResolvedValue(null),
  getSessionPlanContent: vi.fn().mockResolvedValue(null),
  setSessionMissionContent: vi.fn().mockResolvedValue(null),
  worktreeReclaim: (cwd: string, paths: string[]) => worktreeReclaimMock(cwd, paths),
  worktreeSizes: (paths: string[]) => worktreeSizesMock(paths),
  worktreeRelocate: (cwd: string, path: string) => worktreeRelocateMock(cwd, path),
}));

vi.mock("../aom/connectivity", () => ({
  isOnline: vi.fn().mockReturnValue(true),
  subscribeOnline: vi.fn(),
}));

vi.mock("../score/chip", () => ({
  makeScoreChip: vi.fn(() => ({
    el: document.createElement("span"),
    refresh: vi.fn().mockResolvedValue(undefined),
    setOnClick: vi.fn(),
  })),
}));

vi.mock("../ui/markdown", () => ({
  renderMarkdown: vi.fn((s: string) => s),
}));

const pushConfirmToastMock = vi.fn();
const pushInfoToastMock = vi.fn();
vi.mock("../notifications/toast", () => ({
  pushConfirmToast: (t: unknown) => pushConfirmToastMock(t),
  pushInfoToast: (t: unknown) => pushInfoToastMock(t),
}));

// -------------------------------------------------------------------------
import { StatusBar } from "./bar";
import type { GitRepoSummary, GitWorktreeSummary, MissionInfo } from "../api";

describe("StatusBar.setTwoRow", () => {
  let host: HTMLDivElement;
  let bar: StatusBar;

  beforeEach(() => {
    (globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test";
    host = document.createElement("div");
    document.body.appendChild(host);
    bar = new StatusBar(host);
    // Force a transition so setEnabled actually fires render — `enabled`
    // defaults to true at runtime, so a redundant setEnabled(true) here
    // would early-return via the no-op guard.
    bar.setEnabled(false);
    bar.setEnabled(true);
  });

  it("renders two .sb-row containers by default", () => {
    const rows = host.querySelectorAll(".sb-row");
    expect(rows.length).toBe(2);
    expect(rows[0].classList.contains("sb-row--top")).toBe(true);
    expect(rows[1].classList.contains("sb-row--bot")).toBe(true);
  });

  it("setTwoRow(false) flattens to a single-row layout", () => {
    bar.setTwoRow(false);
    const rows = host.querySelectorAll(".sb-row");
    expect(rows.length).toBe(0);
    expect(host.children.length).toBeGreaterThanOrEqual(4);
  });

  it("setTwoRow(true) returns to the two-row layout", () => {
    bar.setTwoRow(false);
    bar.setTwoRow(true);
    const rows = host.querySelectorAll(".sb-row");
    expect(rows.length).toBe(2);
  });

  it("repeated setTwoRow with same value is a no-op", () => {
    bar.setTwoRow(true);
    bar.setTwoRow(true);
    const rows = host.querySelectorAll(".sb-row");
    expect(rows.length).toBe(2);
  });
});

describe("StatusBar workspace chip", () => {
  let host: HTMLDivElement;
  let bar: StatusBar;

  beforeEach(() => {
    (globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test";
    host = document.createElement("div");
    document.body.appendChild(host);
    bar = new StatusBar(host);
    bar.setEnabled(false);
    bar.setEnabled(true);
  });

  it("renders name + color dot and fires onWorkspaceChipClick", () => {
    const clicked = vi.fn();
    bar.onWorkspaceChipClick = clicked;
    bar.setWorkspace({ name: "Personal", color: "#ff0000" });
    const chip = host.querySelector<HTMLElement>(".status-workspace");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toContain("Personal");
    expect(chip!.querySelector(".status-ws-dot")).not.toBeNull();
    chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(clicked).toHaveBeenCalledOnce();
  });

  it("setWorkspace(null) removes the chip", () => {
    bar.setWorkspace({ name: "Personal", color: null });
    bar.setWorkspace(null);
    expect(host.querySelector(".status-workspace")).toBeNull();
  });
});

describe("StatusBar mission chip", () => {
  let host: HTMLDivElement;
  let bar: StatusBar;

  const mission = (path: string): MissionInfo => ({
    kind: "covenant",
    path,
    content_preview: "",
    loaded_at_unix_ms: 1,
    mtime_unix_ms: 1,
    plan: null,
  });

  beforeEach(() => {
    (globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test";
    host = document.createElement("div");
    document.body.appendChild(host);
    bar = new StatusBar(host);
    bar.setEnabled(false);
    bar.setEnabled(true);
  });

  it("renders a remove affordance inside the chip", () => {
    bar.setMission(mission("/repo/specs/2026-06-12-some-design.md"), "s1");
    const chip = host.querySelector("button.status-mission");
    expect(chip).not.toBeNull();
    const x = chip!.querySelector<HTMLElement>(".status-mission-remove");
    expect(x).not.toBeNull();
    expect(x!.getAttribute("role")).toBe("button");
    expect(x!.getAttribute("aria-label")).toBe("Remove spec");
  });

  it("clicking remove fires onMissionClearRequested without opening the spec", () => {
    const cleared = vi.fn();
    bar.onMissionClearRequested = cleared;
    bar.setMission(mission("/repo/specs/a.md"), "s1");
    const open = vi.spyOn(
      bar as unknown as { openMission: () => Promise<void> },
      "openMission",
    );
    const x = host.querySelector<HTMLElement>(".status-mission-remove")!;
    x.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(cleared).toHaveBeenCalledWith("s1");
    expect(open).not.toHaveBeenCalled();
  });
});

describe("mission chip context menu", () => {
  let host: HTMLDivElement;
  let bar: StatusBar;

  beforeEach(() => {
    (globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test";
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    bar = new StatusBar(host);
    bar.setEnabled(false);
    bar.setEnabled(true);
  });

  it("right-click opens the popover; Remove fires onMissionClearRequested", () => {
    const clear = vi.fn();
    bar.onMissionClearRequested = clear;
    bar.setMission(
      {
        kind: "covenant",
        path: "/tmp/spec.md",
        content_preview: "x",
        loaded_at_unix_ms: 1,
        mtime_unix_ms: 1,
        plan: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "sess-1" as any,
    );
    const chip = host.querySelector<HTMLElement>(".status-mission");
    expect(chip).toBeTruthy();
    chip!.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 500,
      }),
    );
    const menu = document.body.querySelector<HTMLElement>(".workspace-rowmenu");
    expect(menu).toBeTruthy();
    const remove = [...menu!.querySelectorAll<HTMLElement>("[data-action]")]
      .find((m) => m.dataset.action === "clear")!;
    remove.click();
    expect(clear).toHaveBeenCalledWith("sess-1");
  });
});

describe("git worktree popover — destructive click wiring", () => {
  let host: HTMLDivElement;
  let bar: StatusBar;
  const cwd = "/repo";

  // Flushes the microtask queue so a chain of `await`s inside a click
  // handler (worktreeSizes → pushConfirmToast, then later worktreeReclaim →
  // pushInfoToast) has settled before assertions run.
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const wt = (overrides: Partial<GitWorktreeSummary>): GitWorktreeSummary => ({
    path: "/repo/.covenant/worktrees/x",
    branch: "feat/x",
    head: "abc123",
    current: false,
    detached: false,
    bare: false,
    dirty_count: 0,
    state: "spent",
    merged: true,
    last_commit_unix: 1000,
    off_convention: false,
    is_main: false,
    ...overrides,
  });

  const summaryWith = (
    worktrees: GitWorktreeSummary[],
    overrides: Partial<GitRepoSummary> = {},
  ): GitRepoSummary => ({
    repo_name: "repo",
    repo_root: cwd,
    current_branch: "main",
    detached_head: null,
    dirty_count: 0,
    branches: [],
    worktrees,
    default_branch: "main",
    ...overrides,
  });

  // Opens the branch popover directly rather than driving it through the
  // full cwd-detection → render flow (that path is unrelated to what these
  // tests cover: the popover's own reclaim click wiring).
  const openPopover = (): void => {
    (bar as unknown as { currentCwd: string | null }).currentCwd = cwd;
    const anchor = document.createElement("span");
    document.body.appendChild(anchor);
    (bar as unknown as { openBranchPopover: (a: HTMLElement) => void }).openBranchPopover(anchor);
  };

  beforeEach(() => {
    (globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test";
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    bar = new StatusBar(host);
    bar.setEnabled(false);
    bar.setEnabled(true);
    worktreeReclaimMock.mockReset().mockResolvedValue([]);
    worktreeSizesMock.mockReset().mockResolvedValue([]);
    gitRepoSummaryMock.mockReset();
    worktreeRelocateMock.mockReset().mockResolvedValue("/repo/.covenant/worktrees/x");
    pushConfirmToastMock.mockReset();
    pushInfoToastMock.mockReset();
  });

  /// Clicks the single per-row action button rendered for `worktrees[0]`.
  const clickRowAction = async (worktrees: GitWorktreeSummary[]): Promise<HTMLButtonElement> => {
    gitRepoSummaryMock.mockResolvedValue(summaryWith(worktrees));
    openPopover();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const btn = document.querySelector<HTMLButtonElement>(".status-git-pop-wt-act");
    expect(btn).not.toBeNull();
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return btn!;
  };

  it("per-row reclaim does not delete until the confirm toast is confirmed", async () => {
    await clickRowAction([wt({ path: "/repo/stray", branch: "feat/gone", off_convention: true })]);

    expect(pushConfirmToastMock).toHaveBeenCalledOnce();
    expect(worktreeReclaimMock).not.toHaveBeenCalled();

    const toast = pushConfirmToastMock.mock.calls[0][0] as { onConfirm: () => void };
    toast.onConfirm();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worktreeReclaimMock).toHaveBeenCalledWith(cwd, ["/repo/stray"]);
  });

  it("per-row reclaim confirm warns that ignored files go with the directory", async () => {
    // The branch is provably merged, so committed work is never at risk —
    // the untracked/ignored files are the only thing the user can actually
    // lose, and the only reason this confirm exists at all.
    await clickRowAction([wt({ path: "/repo/stray", branch: "feat/gone" })]);

    const toast = pushConfirmToastMock.mock.calls[0][0] as { message: string };
    expect(toast.message).toMatch(/untracked and ignored files/i);
    expect(toast.message).toContain("main");
  });

  it("cancelling a per-row reclaim deletes nothing and re-enables the button", async () => {
    const btn = await clickRowAction([wt({ path: "/repo/stray", branch: "feat/gone" })]);
    expect(btn.disabled).toBe(true);

    const toast = pushConfirmToastMock.mock.calls[0][0] as { onCancel: () => void };
    toast.onCancel();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worktreeReclaimMock).not.toHaveBeenCalled();
    expect(btn.disabled).toBe(false);
  });

  it("relocate is not gated behind a confirm — it moves a checkout, it deletes nothing", async () => {
    await clickRowAction([
      wt({ path: "/repo/stray", branch: "feat/live", state: "active", merged: false, off_convention: true }),
    ]);

    expect(pushConfirmToastMock).not.toHaveBeenCalled();
    expect(worktreeRelocateMock).toHaveBeenCalledWith(cwd, "/repo/stray");
  });

  it("prune is not gated behind a confirm — the directory is already gone", async () => {
    await clickRowAction([
      wt({ path: "/repo/vanished", branch: "feat/vanished", state: "orphan", merged: false }),
    ]);

    expect(pushConfirmToastMock).not.toHaveBeenCalled();
    expect(worktreeReclaimMock).toHaveBeenCalledWith(cwd, ["/repo/vanished"]);
  });

  it("bulk reclaim does not call worktreeReclaim until the confirm toast is actually confirmed", async () => {
    gitRepoSummaryMock.mockResolvedValue(
      summaryWith([
        wt({ path: "/repo/.covenant/worktrees/a", branch: "a" }),
        wt({ path: "/repo/.covenant/worktrees/b", branch: "b" }),
      ]),
    );
    openPopover();
    await flush();

    const btn = document.querySelector<HTMLButtonElement>(".status-git-pop-reclaim-all");
    expect(btn).not.toBeNull();
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    // The confirm toast was requested, but nobody has confirmed it yet.
    expect(pushConfirmToastMock).toHaveBeenCalledOnce();
    expect(worktreeReclaimMock).not.toHaveBeenCalled();

    // Only actually invoking onConfirm — standing in for a real click on
    // the toast's confirm button — should trigger the destructive call.
    const toast = pushConfirmToastMock.mock.calls[0][0] as { onConfirm: () => void };
    toast.onConfirm();
    await flush();

    expect(worktreeReclaimMock).toHaveBeenCalledWith(cwd, [
      "/repo/.covenant/worktrees/a",
      "/repo/.covenant/worktrees/b",
    ]);
  });

  it("reports a partial failure honestly instead of as a full success", async () => {
    gitRepoSummaryMock.mockResolvedValue(
      summaryWith([
        wt({ path: "/repo/.covenant/worktrees/a", branch: "a" }),
        wt({ path: "/repo/.covenant/worktrees/b", branch: "b" }),
      ]),
    );
    worktreeReclaimMock.mockResolvedValue([
      { path: "/repo/.covenant/worktrees/a", removed: true, reason: null },
      { path: "/repo/.covenant/worktrees/b", removed: false, reason: "not spent (state: active)" },
    ]);
    openPopover();
    await flush();

    document
      .querySelector<HTMLButtonElement>(".status-git-pop-reclaim-all")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const toast = pushConfirmToastMock.mock.calls[0][0] as { onConfirm: () => void };
    toast.onConfirm();
    await flush();

    expect(pushInfoToastMock).toHaveBeenCalledOnce();
    const info = pushInfoToastMock.mock.calls[0][0] as { message: string };
    expect(info.message).toContain("refused 1");
    expect(info.message).not.toMatch(/^Reclaimed 2 worktree\(s\)\.$/);
  });

  it("escapes a double quote in a worktree path so it cannot break out of the data-path attribute", async () => {
    const evilPath = '/repo/.covenant/worktrees/weird"name';
    gitRepoSummaryMock.mockResolvedValue(
      summaryWith([wt({ path: evilPath, branch: "weird", state: "orphan", merged: false })]),
    );
    openPopover();
    await flush();

    // Orphan's default action is Prune, rendered as a .status-git-pop-wt-act
    // button — the same markup path a Spent/Reclaim row uses.
    const actBtn = document.querySelector<HTMLButtonElement>(".status-git-pop-wt-act");
    expect(actBtn).not.toBeNull();
    expect(actBtn!.dataset.path).toBe(evilPath);
  });

  it("bulk reclaim confirm copy names the repo's default branch, not the calling cwd's branch", async () => {
    // The calling cwd (`cwd = "/repo"`) is on a feature branch, but `merged`
    // (and thus reclaim eligibility) is computed against the repo's actual
    // default branch. The confirm copy must say THAT, not `current_branch`.
    gitRepoSummaryMock.mockResolvedValue(
      summaryWith(
        [wt({ path: "/repo/.covenant/worktrees/a", branch: "a" })],
        { current_branch: "feat/worktree-lifecycle", default_branch: "main" },
      ),
    );
    openPopover();
    await flush();

    document
      .querySelector<HTMLButtonElement>(".status-git-pop-reclaim-all")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    expect(pushConfirmToastMock).toHaveBeenCalledOnce();
    const toast = pushConfirmToastMock.mock.calls[0][0] as { message: string };
    // Pinned by position, not by trailing punctuation — the sentence after
    // the branch name is free to change.
    expect(toast.message).toMatch(/already in main\b/);
    expect(toast.message).not.toContain("feat/worktree-lifecycle");
  });

  it("Enter on a highlighted row whose default verb is destructive still opens, never reclaims/prunes/relocates", async () => {
    const opened = vi.fn();
    bar.onOpenGitWorktree = opened;
    gitRepoSummaryMock.mockResolvedValue(
      summaryWith([wt({ path: "/repo/.covenant/worktrees/a", branch: "a", state: "spent" })]),
    );
    openPopover();
    await flush();

    // Row's default verb is Reclaim, so it renders .status-git-pop-wt-act,
    // not .status-git-pop-open-wt.
    expect(document.querySelector(".status-git-pop-open-wt")).toBeNull();
    const actBtn = document.querySelector<HTMLButtonElement>(".status-git-pop-wt-act");
    expect(actBtn).not.toBeNull();
    expect(actBtn!.dataset.verb).toBe("reclaim");

    const search = document.querySelector<HTMLInputElement>(".status-git-pop-search-input")!;
    // Single matching row: the keydown handler auto-selects it without an
    // ArrowDown first (see `navRows().length === 1` fallback).
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flush();

    expect(opened).toHaveBeenCalledWith("/repo/.covenant/worktrees/a", "a");
    expect(worktreeReclaimMock).not.toHaveBeenCalled();
  });

  it("does not render a Relocate button for an off-convention worktree with a live occupying tab", async () => {
    bar.getOccupiedCwds = () => ["/elsewhere/stray-worktree"];
    gitRepoSummaryMock.mockResolvedValue(
      summaryWith([
        wt({
          path: "/elsewhere/stray-worktree",
          branch: "stray",
          state: "active",
          merged: false,
          off_convention: true,
        }),
      ]),
    );
    openPopover();
    await flush();

    const actBtn = document.querySelector<HTMLButtonElement>(".status-git-pop-wt-act");
    expect(actBtn).toBeNull();
    expect(document.body.textContent).not.toContain("Relocate");
  });

  it("still renders a Relocate button for an off-convention worktree with no occupying tab", async () => {
    bar.getOccupiedCwds = () => ["/repo"]; // some other, unrelated tab
    gitRepoSummaryMock.mockResolvedValue(
      summaryWith([
        wt({
          path: "/elsewhere/stray-worktree",
          branch: "stray",
          state: "active",
          merged: false,
          off_convention: true,
        }),
      ]),
    );
    openPopover();
    await flush();

    const actBtn = document.querySelector<HTMLButtonElement>(".status-git-pop-wt-act");
    expect(actBtn).not.toBeNull();
    expect(actBtn!.dataset.verb).toBe("relocate");
  });
});
