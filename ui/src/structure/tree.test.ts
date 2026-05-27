// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the backend list call BEFORE importing tree.ts so the module
// picks up the mock at import time.
vi.mock("../api", () => ({
  structureListDir: vi.fn(),
}));

import { StructureTree } from "./tree";
import { structureListDir } from "../api";

const listDirMock = structureListDir as unknown as ReturnType<typeof vi.fn>;

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
