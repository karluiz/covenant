// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the backend list call BEFORE importing tree.ts so the module
// picks up the mock at import time.
vi.mock("../api", () => ({
  structureListDir: vi.fn(),
  structureMoveInto: vi.fn(),
  // Default: no git info, so renderBranch stays hidden. Tests that assert the
  // chip override this per-call. The branch-chip describe (runs last) resets it.
  getDirContext: vi.fn().mockResolvedValue({ git: null, runtime: null }),
  // Default: not enough worktrees to grow the selector. Selector tests override.
  gitRepoSummary: vi.fn().mockResolvedValue({ worktrees: [] }),
}));

import { StructureTree, isShareableAsGist } from "./tree";
import { structureListDir, structureMoveInto, getDirContext, gitRepoSummary } from "../api";

const listDirMock = structureListDir as unknown as ReturnType<typeof vi.fn>;
const moveIntoMock = structureMoveInto as unknown as ReturnType<typeof vi.fn>;
const dirCtxMock = getDirContext as unknown as ReturnType<typeof vi.fn>;
const repoSummaryMock = gitRepoSummary as unknown as ReturnType<typeof vi.fn>;

function entry(path: string, name: string, kind: "file" | "dir") {
  return { path, name, kind, is_symlink: false };
}

async function flush() {
  // Drain microtasks so awaited expand() chains resolve before assertion.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("StructureTree.setActivePath", () => {
  let host: HTMLDivElement;
  let tree: StructureTree;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    listDirMock.mockReset();
    // Clear localStorage so expanded-path state from a previous test
    // doesn't bleed into this one (jsdom shares localStorage within a suite).
    localStorage.clear();
    // jsdom doesn't implement scrollIntoView. Stub on the prototype
    // before each test so reveal logic can call it without throwing.
    Element.prototype.scrollIntoView = vi.fn();
    tree = new StructureTree(host, () => undefined);
  });

  it("clears active class when called with null", async () => {
    listDirMock.mockResolvedValueOnce([
      entry("/cwd/a.md", "a.md", "file"),
      entry("/cwd/b.md", "b.md", "file"),
    ]);
    await tree.setCwd("/cwd");
    await flush();
    tree.setActivePath("/cwd/a.md");
    await flush();
    const aRow = host.querySelector(
      '[data-kind="file"] .structure-row',
    ) as HTMLElement | null;
    expect(aRow?.classList.contains("is-active")).toBe(true);

    tree.setActivePath(null);
    expect(aRow?.classList.contains("is-active")).toBe(false);
  });

  it("is a no-op when called with the same path twice", async () => {
    listDirMock.mockResolvedValueOnce([entry("/cwd/a.md", "a.md", "file")]);
    await tree.setCwd("/cwd");
    await flush();

    tree.setActivePath("/cwd/a.md");
    await flush();
    const callsAfterFirst = (Element.prototype.scrollIntoView as ReturnType<
      typeof vi.fn
    >).mock.calls.length;
    tree.setActivePath("/cwd/a.md");
    await flush();
    expect(
      (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBe(callsAfterFirst);
  });

  it("does nothing when the path is outside cwd", async () => {
    listDirMock.mockResolvedValueOnce([entry("/cwd/a.md", "a.md", "file")]);
    await tree.setCwd("/cwd");
    await flush();
    tree.setActivePath("/other/somewhere.md");
    await flush();
    const rows = host.querySelectorAll(".structure-row.is-active");
    expect(rows.length).toBe(0);
  });

  it("applies class to an already-loaded leaf without expanding", async () => {
    listDirMock.mockResolvedValueOnce([entry("/cwd/a.md", "a.md", "file")]);
    await tree.setCwd("/cwd");
    await flush();
    const expandCallsBefore = listDirMock.mock.calls.length;
    tree.setActivePath("/cwd/a.md");
    await flush();
    expect(listDirMock.mock.calls.length).toBe(expandCallsBefore);
    const aRow = host.querySelector(
      '[data-kind="file"] .structure-row',
    ) as HTMLElement | null;
    expect(aRow?.classList.contains("is-active")).toBe(true);
  });

  it("auto-expands a collapsed ancestor to reach the target leaf", async () => {
    listDirMock
      .mockResolvedValueOnce([entry("/cwd/deep", "deep", "dir")])
      .mockResolvedValueOnce([entry("/cwd/deep/file.md", "file.md", "file")]);
    await tree.setCwd("/cwd");
    await flush();
    tree.setActivePath("/cwd/deep/file.md");
    await flush();
    expect(listDirMock).toHaveBeenCalledTimes(2);
    const leaf = Array.from(host.querySelectorAll(".structure-row")).find(
      (r) => r.textContent?.includes("file.md"),
    );
    expect(leaf?.classList.contains("is-active")).toBe(true);
  });

  it("clears active state when cwd changes", async () => {
    listDirMock
      .mockResolvedValueOnce([entry("/cwd/a.md", "a.md", "file")])
      .mockResolvedValueOnce([entry("/cwd2/b.md", "b.md", "file")]);
    await tree.setCwd("/cwd");
    await flush();
    tree.setActivePath("/cwd/a.md");
    await flush();
    await tree.setCwd("/cwd2");
    await flush();
    expect(host.querySelectorAll(".is-active").length).toBe(0);
  });

  it("re-applies active class after a refresh", async () => {
    // Initial list + later refresh both return the same file.
    listDirMock
      .mockResolvedValueOnce([entry("/cwd/a.md", "a.md", "file")])
      .mockResolvedValueOnce([entry("/cwd/a.md", "a.md", "file")]);
    await tree.setCwd("/cwd");
    await flush();
    tree.setActivePath("/cwd/a.md");
    await flush();

    await tree.refresh();
    await flush();

    const row = host.querySelector(
      '[data-kind="file"] .structure-row',
    ) as HTMLElement | null;
    expect(row?.classList.contains("is-active")).toBe(true);
  });

  it("aborts an in-flight reveal when refresh interleaves", async () => {
    // First setCwd: returns one dir "deep".
    // The reveal will call expand() which returns deep's children.
    // Meanwhile we trigger a refresh that rebuilds the root list.
    // After everything settles, the active path's row should be marked
    // exactly once — not on a stale detached node.
    let resolveExpand: (v: typeof deepChildren) => void = () => undefined;
    const deepChildren = [entry("/cwd/deep/file.md", "file.md", "file")];
    const deepChildrenPromise = new Promise<typeof deepChildren>((res) => {
      resolveExpand = res;
    });

    listDirMock
      // initial setCwd
      .mockResolvedValueOnce([entry("/cwd/deep", "deep", "dir")])
      // expand("deep") triggered by reveal — held until we release it
      .mockReturnValueOnce(deepChildrenPromise as never)
      // refresh's root listing (re-runs while reveal is paused)
      .mockResolvedValueOnce([entry("/cwd/deep", "deep", "dir")])
      // refresh re-expands "deep" (because expandedPaths now includes it)
      .mockResolvedValueOnce([entry("/cwd/deep/file.md", "file.md", "file")]);

    await tree.setCwd("/cwd");
    await flush();

    // Kick off the reveal — its expand will hang on deepChildrenPromise.
    tree.setActivePath("/cwd/deep/file.md");
    await flush();

    // Refresh now, while the reveal is mid-await.
    const refreshDone = tree.refresh();

    // Release the reveal's expand. It should bail (revealGen bumped by refresh).
    resolveExpand(deepChildren);
    await refreshDone;
    await flush();

    const matchingRows = Array.from(
      host.querySelectorAll(".structure-row.is-active"),
    );
    expect(matchingRows.length).toBe(1);
    // The single marked row should be in the LIVE DOM (attached to host).
    expect(host.contains(matchingRows[0])).toBe(true);
  });
});

describe("StructureTree internal drag-to-move", () => {
  let host: HTMLDivElement;
  let tree: StructureTree;
  let changes: Array<
    | { kind: "rename"; oldPath: string; newPath: string }
    | { kind: "trash"; path: string }
  >;

  beforeEach(async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    listDirMock.mockReset();
    moveIntoMock.mockReset();
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    changes = [];
    tree = new StructureTree(host, () => undefined, (c) => changes.push(c));
    tree.show();
    listDirMock.mockResolvedValueOnce([
      entry("/cwd/a.md", "a.md", "file"),
      entry("/cwd/dir", "dir", "dir"),
    ]);
    await tree.setCwd("/cwd");
    await flush();
  });

  // The pointer-drag plumbing relies on document.elementFromPoint for
  // hit-testing, which jsdom doesn't implement (no layout). So we exercise
  // the two pieces it composes: resolveDropTarget (DOM-closest, works in
  // jsdom) and moveEntry (the move + reroute + refresh logic).

  it("resolveDropTarget maps a folder row to itself", () => {
    const folderRow = host.querySelector<HTMLElement>(
      '[data-path="/cwd/dir"] .structure-row',
    )!;
    const target = tree.resolveDropTarget(folderRow);
    expect(target?.dir).toBe("/cwd/dir");
  });

  it("resolveDropTarget maps a file row to its parent folder", () => {
    const fileRow = host.querySelector<HTMLElement>(
      '[data-path="/cwd/a.md"] .structure-row',
    )!;
    expect(tree.resolveDropTarget(fileRow)?.dir).toBe("/cwd");
  });

  it("resolveDropTarget maps empty tree space to the cwd root", () => {
    expect(tree.resolveDropTarget(tree.element)?.dir).toBe("/cwd");
  });

  it("moveEntry moves a file into a folder and reroutes the open editor", async () => {
    moveIntoMock.mockResolvedValueOnce(["/cwd/dir/a.md"]);
    listDirMock.mockResolvedValue([]); // refresh after move

    await (tree as unknown as {
      moveEntry(src: string, dest: string): Promise<void>;
    }).moveEntry("/cwd/a.md", "/cwd/dir");

    expect(moveIntoMock).toHaveBeenCalledWith(["/cwd/a.md"], "/cwd/dir");
    expect(changes).toContainEqual({
      kind: "rename",
      oldPath: "/cwd/a.md",
      newPath: "/cwd/dir/a.md",
    });
  });

  it("moveEntry is a no-op into the folder it already lives in", async () => {
    await (tree as unknown as {
      moveEntry(src: string, dest: string): Promise<void>;
    }).moveEntry("/cwd/a.md", "/cwd");
    expect(moveIntoMock).not.toHaveBeenCalled();
  });
});

describe("isShareableAsGist", () => {
  it("hides gist actions for binaries, keeps them for text", () => {
    expect(isShareableAsGist("/cwd/logo.PNG")).toBe(false);
    expect(isShareableAsGist("/cwd/app.wasm")).toBe(false);
    expect(isShareableAsGist("/cwd/notes.md")).toBe(true);
    expect(isShareableAsGist("/cwd/Makefile")).toBe(true);
    expect(isShareableAsGist("/cwd/.gitignore")).toBe(true);
  });
});

describe("StructureTree worktree pin", () => {
  let host: HTMLDivElement;
  let tree: StructureTree;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    listDirMock.mockReset();
    listDirMock.mockResolvedValue([entry("/wt/a.md", "a.md", "file")]);
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    tree = new StructureTree(host, () => undefined);
  });

  it("setCwd while pinned records the cwd but does not re-root", async () => {
    await tree.setCwd("/main");
    await flush();
    await tree.pinTo("/wt");
    await flush();
    await tree.setCwd("/main/sub");
    await flush();
    // Tree still rooted at the pinned path: listDir was never asked for /main/sub.
    const calls = listDirMock.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("/main/sub");
    expect(tree.pinned).toBe("/wt");
  });

  it("unpin re-roots to the last terminal cwd", async () => {
    await tree.setCwd("/main");
    await flush();
    await tree.pinTo("/wt");
    await flush();
    await tree.setCwd("/main/sub"); // recorded while pinned
    await tree.unpin();
    await flush();
    const calls = listDirMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("/main/sub");
    expect(tree.pinned).toBeNull();
  });

  it("refresh failure while pinned auto-unpins back to terminal cwd", async () => {
    await tree.setCwd("/main");
    await flush();
    listDirMock.mockRejectedValueOnce(new Error("gone"));
    await tree.pinTo("/wt-deleted");
    await flush();
    expect(tree.pinned).toBeNull();
    // Fell back to re-listing the terminal cwd.
    const calls = listDirMock.mock.calls.map((c) => c[0]);
    expect(calls.filter((c) => c === "/main").length).toBeGreaterThanOrEqual(2);
  });
});

describe("StructureTree worktree selector header", () => {
  let host: HTMLDivElement;
  let tree: StructureTree;

  const twoWorktrees = {
    worktrees: [
      { path: "/repo", branch: "main", is_main: true },
      { path: "/repo/.covenant/worktrees/wt-a", branch: "agent/wt-a", is_main: false },
    ],
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    listDirMock.mockReset();
    listDirMock.mockResolvedValue([entry("/repo/a.md", "a.md", "file")]);
    repoSummaryMock.mockReset();
    repoSummaryMock.mockResolvedValue({ worktrees: [] });
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    tree = new StructureTree(host, () => undefined);
  });

  it("keeps the plain label when the repo has one worktree", async () => {
    repoSummaryMock.mockResolvedValue({ worktrees: [{ path: "/repo", branch: "main", is_main: true }] });
    await tree.setCwd("/repo");
    await flush();
    const label = host.querySelector(".structure-cwd")!;
    expect(label.classList.contains("structure-cwd-selector")).toBe(false);
  });

  it("upgrades the label to a selector when the repo has sibling worktrees", async () => {
    repoSummaryMock.mockResolvedValue(twoWorktrees);
    await tree.setCwd("/repo");
    await flush();
    const label = host.querySelector(".structure-cwd")!;
    expect(label.classList.contains("structure-cwd-selector")).toBe(true);
    expect(label.querySelector(".structure-cwd-chevron")).not.toBeNull();
  });

  it("shows the pin indicator while pinned", async () => {
    repoSummaryMock.mockResolvedValue(twoWorktrees);
    await tree.setCwd("/repo");
    await flush();
    await tree.pinTo("/repo/.covenant/worktrees/wt-a");
    await flush();
    expect(host.querySelector(".structure-cwd-pin")).not.toBeNull();
  });

  it("renders the dropdown main-first with badge + branch hint, and checks Follow terminal when unpinned", async () => {
    // Deliberately NOT main-first: linked worktree before main.
    repoSummaryMock.mockResolvedValue({
      worktrees: [
        { path: "/repo/.covenant/worktrees/wt-a", branch: "agent/wt-a", is_main: false },
        { path: "/repo", branch: "main", is_main: true },
      ],
    });
    await tree.setCwd("/repo");
    await flush();
    const label = host.querySelector<HTMLElement>(".structure-cwd")!;
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const items = document.body.querySelectorAll<HTMLElement>(".ctx-menu .ctx-item");
    expect(items.length).toBe(3); // Follow terminal, main, wt-a

    const [followRow, mainRow, wtRow] = Array.from(items);

    expect(followRow.querySelector(".ctx-item-label")?.textContent).toBe(
      "Follow terminal",
    );
    // Not pinned — Follow terminal carries the check icon.
    expect(followRow.querySelector(".ctx-item-icon svg")).not.toBeNull();

    // Sorted main-first despite the input order above.
    expect(mainRow.querySelector(".ctx-item-label")?.textContent).toBe("repo");
    expect(mainRow.querySelector(".ctx-item-badge")?.textContent).toBe("MAIN");
    // The currently-viewed root ("/repo") carries the check icon.
    expect(mainRow.querySelector(".ctx-item-icon svg")).not.toBeNull();

    expect(wtRow.querySelector(".ctx-item-label")?.textContent).toBe("wt-a");
    expect(wtRow.querySelector(".ctx-item-badge")).toBeNull();
    expect(wtRow.querySelector(".ctx-item-shortcut")?.textContent).toBe("agent/wt-a");
    expect(wtRow.querySelector(".ctx-item-icon")).toBeNull();

    (tree as unknown as { contextMenu: { dismiss(): void } }).contextMenu.dismiss();
  });

  it("moves the check off Follow terminal and onto the pinned worktree once pinned", async () => {
    repoSummaryMock.mockResolvedValue({
      worktrees: [
        { path: "/repo/.covenant/worktrees/wt-a", branch: "agent/wt-a", is_main: false },
        { path: "/repo", branch: "main", is_main: true },
      ],
    });
    await tree.setCwd("/repo");
    await flush();

    await tree.pinTo("/repo/.covenant/worktrees/wt-a");
    await flush();

    const label = host.querySelector<HTMLElement>(".structure-cwd")!;
    label.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const items = document.body.querySelectorAll<HTMLElement>(".ctx-menu .ctx-item");
    expect(items.length).toBe(3);
    const followRow = items[0];
    const wtRow = items[2];

    // Pinned — Follow terminal no longer carries the check icon.
    expect(followRow.querySelector(".ctx-item-icon")).toBeNull();
    // The pinned worktree row carries it instead.
    expect(wtRow.querySelector(".ctx-item-icon svg")).not.toBeNull();

    (tree as unknown as { contextMenu: { dismiss(): void } }).contextMenu.dismiss();
  });
});

describe("StructureTree branch chip", () => {
  let host: HTMLDivElement;
  let tree: StructureTree;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    listDirMock.mockReset();
    dirCtxMock.mockReset();
    repoSummaryMock.mockReset();
    repoSummaryMock.mockResolvedValue({ worktrees: [] });
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    tree = new StructureTree(host, () => undefined);
  });

  it("shows the branch name for a repo cwd", async () => {
    listDirMock.mockResolvedValueOnce([entry("/wt/a.md", "a.md", "file")]);
    dirCtxMock.mockResolvedValueOnce({ git: { repo_name: "covenant", branch: "agent/css-fixes-0722-wez" }, runtime: null });
    await tree.setCwd("/wt");
    await flush();
    const chip = host.querySelector(".structure-branch-name");
    expect(chip?.textContent).toBe("agent/css-fixes-0722-wez");
    expect(host.querySelector<HTMLElement>(".structure-branch")?.hidden).toBe(false);
  });

  it("stays hidden when the cwd is not a git repo", async () => {
    listDirMock.mockResolvedValueOnce([entry("/plain/a.md", "a.md", "file")]);
    dirCtxMock.mockResolvedValueOnce({ git: null, runtime: null });
    await tree.setCwd("/plain");
    await flush();
    expect(host.querySelector<HTMLElement>(".structure-branch")?.hidden).toBe(true);
  });

  it("drops a stale branch result after a re-root", async () => {
    listDirMock.mockResolvedValue([entry("/x/a.md", "a.md", "file")]);
    // First cwd resolves slowly; second resolves before it.
    let resolveFirst: (v: unknown) => void = () => undefined;
    dirCtxMock.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    dirCtxMock.mockResolvedValueOnce({ git: { repo_name: "r", branch: "second" }, runtime: null });
    await tree.setCwd("/wt-one");
    await tree.setCwd("/wt-two");
    await flush();
    // Now the stale first probe resolves — it must NOT overwrite the chip.
    resolveFirst({ git: { repo_name: "r", branch: "first" }, runtime: null });
    await flush();
    expect(host.querySelector(".structure-branch-name")?.textContent).toBe("second");
  });
});
