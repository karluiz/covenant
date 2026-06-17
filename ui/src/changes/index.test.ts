import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  gitStage: vi.fn(), gitUnstage: vi.fn(),
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
});
