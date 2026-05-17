import { describe, it, expect, beforeEach, vi } from "vitest";
import { DraftsTab } from "./drafts-tab";

vi.mock("../drafts/api", () => ({
  draftsApi: {
    list: vi.fn(),
  },
}));

import { draftsApi } from "../drafts/api";

describe("DraftsTab", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    vi.clearAllMocks();
  });

  it("renders empty state when group has no rootDir", async () => {
    new DraftsTab({
      groupId: "g1",
      groupRootDir: null,
      onOpenFile: () => {},
      onOpenWizard: () => {},
    }).mount(host);
    await Promise.resolve();
    expect(host.textContent).toContain("Set a root dir");
    expect(draftsApi.list).not.toHaveBeenCalled();
  });

  it("lists drafts returned by the API", async () => {
    (draftsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { slug: "foo", title: "Foo spec", updated_at: "2026-05-16T12:00:00Z" },
      { slug: "bar", title: "Bar spec", updated_at: "2026-05-15T12:00:00Z" },
    ]);
    new DraftsTab({
      groupId: "g1",
      groupRootDir: "/repo",
      onOpenFile: () => {},
      onOpenWizard: () => {},
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    const items = host.querySelectorAll(".pn-drafts-item");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("Foo spec");
  });

  it("calls onOpenFile with absolute spec path when an item is clicked", async () => {
    (draftsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { slug: "foo", title: "Foo spec", updated_at: "2026-05-16T12:00:00Z" },
    ]);
    const opened: string[] = [];
    new DraftsTab({
      groupId: "g1",
      groupRootDir: "/repo",
      onOpenFile: (path) => opened.push(path),
      onOpenWizard: () => {},
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    (host.querySelector(".pn-drafts-item") as HTMLElement).click();
    expect(opened).toEqual(["/repo/docs/specs/foo.md"]);
  });

  it("calls onOpenWizard when '+ New spec' is clicked", async () => {
    (draftsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    let openedRoot: string | null = null;
    new DraftsTab({
      groupId: "g1",
      groupRootDir: "/repo",
      onOpenFile: () => {},
      onOpenWizard: (root) => { openedRoot = root; },
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    (host.querySelector(".pn-drafts-new") as HTMLElement).click();
    expect(openedRoot).toBe("/repo");
  });

  it("re-renders when refresh() is called", async () => {
    const mock = draftsApi.list as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce([
      { slug: "foo", title: "Foo", updated_at: "2026-05-16T12:00:00Z" },
    ]);
    const tab = new DraftsTab({
      groupId: "g1",
      groupRootDir: "/repo",
      onOpenFile: () => {},
      onOpenWizard: () => {},
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelectorAll(".pn-drafts-item").length).toBe(1);

    mock.mockResolvedValueOnce([
      { slug: "foo", title: "Foo", updated_at: "2026-05-16T12:00:00Z" },
      { slug: "bar", title: "Bar", updated_at: "2026-05-16T13:00:00Z" },
    ]);
    await tab.refresh();
    expect(host.querySelectorAll(".pn-drafts-item").length).toBe(2);
  });
});
