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
}));

import { ChangesSurface } from "./index";

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

  it("re-pulls diff from staged side after staging the currently shown file", async () => {
    const gitFileDiff = vi.mocked(api.gitFileDiff);
    const gitStage = vi.mocked(api.gitStage);

    const s = new ChangesSurface(host);
    await s.open("/repo");

    // Simulate selecting the unstaged file — triggers showDiff(path, false)
    const row = [...host.querySelectorAll<HTMLElement>(".cd-file")]
      .find(r => r.textContent?.includes("f.txt"))!;
    row.click();
    // Wait for showDiff async (gitFileDiff call #1)
    await Promise.resolve();
    await Promise.resolve();

    const callsAfterSelect = gitFileDiff.mock.calls.length;
    expect(callsAfterSelect).toBeGreaterThanOrEqual(1);

    // Now stage via the rail's stage button — triggers stage(path)
    const stageBtn = row.querySelector<HTMLElement>(".cd-stage-btn")!;
    stageBtn.click();
    // Wait for stage async (gitStage + renderRail + showDiff re-pull)
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(gitStage).toHaveBeenCalledWith("/repo", "f.txt");

    // gitFileDiff must have been called again with staged=true for f.txt
    const secondDiffCall = gitFileDiff.mock.calls.slice(callsAfterSelect)
      .find(([, path, staged]) => path === "f.txt" && staged === true);
    expect(secondDiffCall).toBeDefined();
  });
});
