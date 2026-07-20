import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as api from "../api";

vi.mock("../api", () => ({
  gitChanges: vi.fn(async () => ({
    staged: [],
    unstaged: [{ path: "f.txt", oldPath: null, status: "modified", added: 1, removed: 0, binary: false }],
  })),
  gitFileDiff: vi.fn(async () => ({
    path: "f.txt", oldPath: null,
    body: { kind: "hunks", hunks: [{ oldStart: 1, newStart: 1, header: "", lines: [
      { kind: "add", oldNo: null, newNo: 1, text: "x" }] }] },
  })),
  gitStage: vi.fn(async () => ({
    staged: [{ path: "f.txt", oldPath: null, status: "modified", added: 1, removed: 0, binary: false }],
    unstaged: [],
  })),
  gitUnstage: vi.fn(async () => ({
    staged: [],
    unstaged: [{ path: "f.txt", oldPath: null, status: "modified", added: 1, removed: 0, binary: false }],
  })),
  gitStageHunk: vi.fn(async () => ({
    staged: [{ path: "f.txt", oldPath: null, status: "modified", added: 1, removed: 0, binary: false }],
    unstaged: [],
  })),
  gitUnstageHunk: vi.fn(async () => ({
    staged: [],
    unstaged: [{ path: "f.txt", oldPath: null, status: "modified", added: 1, removed: 0, binary: false }],
  })),
  gitCommit: vi.fn(async () => ({ staged: [], unstaged: [] })),
  generateCommitMessage: vi.fn(async () => "feat: subject\n\nbody line"),
  explainChanges: vi.fn(async () => "Adds `foo` to the parser."),
  gitRepoSummary: vi.fn(async () => ({
    repo_name: "repo", repo_root: "/repo", current_branch: "main",
    detached_head: null, dirty_count: 1,
    branches: [{ name: "main", current: true, upstream: "origin/main", last_commit: null, worktree_path: null }],
    worktrees: [],
  })),
}));

import { ChangesSurface } from "./index";

const tick = async (n = 4) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

describe("ChangesSurface", () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); });
  afterEach(() => { host.remove(); document.body.classList.remove("changes-fullscreen"); });

  it("opens, sets fullscreen flag, and renders the rail", async () => {
    const s = new ChangesSurface(host);
    await s.open("/repo");
    expect(s.isOpen).toBe(true);
    expect(document.body.classList.contains("changes-fullscreen")).toBe(true);
    expect(host.querySelector(".cd-file")).toBeTruthy();
  });

  it("shows the changeset overview until a file is selected", async () => {
    const s = new ChangesSurface(host);
    await s.open("/repo");
    expect(host.querySelector(".cd-overview")).toBeTruthy();
    expect(host.querySelector(".cd-ov-head")?.textContent).toMatch(/1 file changed/);
    expect(host.querySelectorAll(".cd-ov-row").length).toBe(1);
  });

  it("close clears the fullscreen flag", async () => {
    const s = new ChangesSurface(host);
    await s.open("/repo");
    s.close();
    expect(s.isOpen).toBe(false);
    expect(document.body.classList.contains("changes-fullscreen")).toBe(false);
  });

  it("Escape closes the surface even when xterm stops propagation", async () => {
    const s = new ChangesSurface(host);
    await s.open("/repo");
    // Bubble-phase listener that swallows Escape, like xterm behind the overlay.
    const swallow = (e: KeyboardEvent) => e.stopPropagation();
    document.addEventListener("keydown", swallow);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.removeEventListener("keydown", swallow);
    expect(s.isOpen).toBe(false);
  });

  it("Escape from an open diff returns to the overview; second Escape closes", async () => {
    const s = new ChangesSurface(host);
    await s.open("/repo");
    host.querySelector<HTMLElement>(".cd-file")!.click();
    await tick();
    expect(host.querySelector(".cd-diff-view")).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(s.isOpen).toBe(true);
    expect(host.querySelector(".cd-overview")).toBeTruthy();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(s.isOpen).toBe(false);
  });

  it("commits subject and body joined by a blank line", async () => {
    const gitCommit = vi.mocked(api.gitCommit);
    const s = new ChangesSurface(host);
    await s.open("/repo");

    const subj = host.querySelector<HTMLInputElement>(".cd-subj")!;
    const body = host.querySelector<HTMLTextAreaElement>(".cd-commit-body")!;
    subj.value = "feat: thing";
    subj.dispatchEvent(new Event("input"));
    body.value = "longer description";

    host.querySelector<HTMLButtonElement>(".cd-commit-btn")!.click();
    await tick();
    expect(gitCommit).toHaveBeenCalledWith("/repo", "feat: thing\n\nlonger description", false);
  });

  it("Summarize splits the generated message into subject and body", async () => {
    const s = new ChangesSurface(host);
    await s.open("/repo");
    host.querySelector<HTMLButtonElement>(".cd-summarize")!.click();
    await tick();
    expect(host.querySelector<HTMLInputElement>(".cd-subj")!.value).toBe("feat: subject");
    expect(host.querySelector<HTMLTextAreaElement>(".cd-commit-body")!.value).toBe("body line");
  });

  it("a missing API key renders an empty state that opens Providers, on both surfaces", async () => {
    const noKey = new Error("The Chat route has no API key. Set it in Settings → Providers.");
    vi.mocked(api.generateCommitMessage).mockRejectedValueOnce(noKey);
    vi.mocked(api.explainChanges).mockRejectedValueOnce(noKey);
    const opened = vi.fn();
    document.addEventListener("covenant:open-providers", opened);

    const s = new ChangesSurface(host);
    await s.open("/repo");

    host.querySelector<HTMLButtonElement>(".cd-summarize")!.click();
    await tick();
    expect(host.querySelector(".cd-commit-status--err")).toBeNull();
    host.querySelector<HTMLButtonElement>(".cd-status-fix")!.click();

    host.querySelector<HTMLButtonElement>(".cd-exp-btn")!.click();
    await tick();
    expect(host.querySelector(".cd-exp-error")).toBeNull();
    host.querySelector<HTMLButtonElement>(".cd-exp-empty .cd-exp-fix")!.click();

    expect(opened).toHaveBeenCalledTimes(2);
    document.removeEventListener("covenant:open-providers", opened);
  });

  it("Explain changes renders the markdown, and staging clears it", async () => {
    const s = new ChangesSurface(host);
    await s.open("/repo");

    host.querySelector<HTMLButtonElement>(".cd-exp-btn")!.click();
    await tick();
    const doc = host.querySelector<HTMLElement>(".cd-exp-doc")!;
    expect(doc.textContent).toContain("Adds foo to the parser.");
    expect(doc.querySelector("code")!.textContent).toBe("foo");

    // The explanation describes a diff that no longer exists once you stage.
    host.querySelector<HTMLButtonElement>(".cd-stage-btn")!.click();
    await tick();
    expect(host.querySelector(".cd-exp-doc")).toBeNull();
  });

  it("Stage hunk calls gitStageHunk with the hunk index and follows the file", async () => {
    const gitStageHunk = vi.mocked(api.gitStageHunk);
    const gitFileDiff = vi.mocked(api.gitFileDiff);
    const s = new ChangesSurface(host);
    await s.open("/repo");

    host.querySelector<HTMLElement>(".cd-file")!.click();
    await tick();
    const btn = host.querySelector<HTMLButtonElement>(".cd-hunk-stage")!;
    expect(btn.textContent).toBe("Stage hunk");

    const before = gitFileDiff.mock.calls.length;
    btn.click();
    await tick(6);
    expect(gitStageHunk).toHaveBeenCalledWith("/repo", "f.txt", 0);
    // File moved fully to staged — the diff re-pulls from the staged side.
    const repull = gitFileDiff.mock.calls.slice(before)
      .find(([, path, staged]) => path === "f.txt" && staged === true);
    expect(repull).toBeDefined();
  });

  it("re-pulls diff from staged side after staging the currently shown file", async () => {
    const gitFileDiff = vi.mocked(api.gitFileDiff);
    const gitStage = vi.mocked(api.gitStage);

    const s = new ChangesSurface(host);
    await s.open("/repo");

    // Simulate selecting the unstaged file — triggers showDiff(path, false)
    const row = [...host.querySelectorAll<HTMLElement>(".cd-file")]
      .find(r => r.textContent?.includes("f.txt"))!;
    row.click();
    await tick();

    const callsAfterSelect = gitFileDiff.mock.calls.length;
    expect(callsAfterSelect).toBeGreaterThanOrEqual(1);

    // Now stage via the rail's stage button — triggers stage(path)
    const stageBtn = row.querySelector<HTMLElement>(".cd-stage-btn")!;
    stageBtn.click();
    await tick(6);

    expect(gitStage).toHaveBeenCalledWith("/repo", "f.txt");

    // gitFileDiff must have been called again with staged=true for f.txt
    const secondDiffCall = gitFileDiff.mock.calls.slice(callsAfterSelect)
      .find(([, path, staged]) => path === "f.txt" && staged === true);
    expect(secondDiffCall).toBeDefined();
  });
});
