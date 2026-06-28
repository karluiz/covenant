import { describe, it, expect, beforeEach, vi } from "vitest";
import { DraftsTab } from "./drafts-tab";
import type { SpecDraftSummary } from "../api";

function draft(over: Partial<SpecDraftSummary> = {}): SpecDraftSummary {
  return {
    id: "01ID",
    messages: [{ role: "User", content: "Build a thing" }],
    partial_md: null,
    last_updated: "2026-06-12T12:00:00Z",
    status: { InProgress: { phase: "Reading" } },
    repo_root: null,
    ...over,
  };
}

describe("DraftsTab", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    vi.clearAllMocks();
  });

  it("lists Spec Creator drafts returned by the API", async () => {
    const listDrafts = vi.fn().mockResolvedValue([
      draft({ id: "a", messages: [{ role: "User", content: "Foo spec" }] }),
      draft({ id: "b", messages: [{ role: "User", content: "Bar spec" }] }),
    ]);
    new DraftsTab({
      groupId: "g1",
      groupRootDir: null,
      onOpenDraft: () => {},
      onNewSpec: () => {},
      listDrafts,
      deleteDraft: vi.fn(),
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));

    const items = host.querySelectorAll(".rail-row");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("Foo spec");
  });

  it("passes the group root dir to the list API as the scope filter", async () => {
    const listDrafts = vi.fn().mockResolvedValue([]);
    new DraftsTab({
      groupId: "g1",
      groupRootDir: "/repo/proj",
      onOpenDraft: () => {},
      onNewSpec: () => {},
      listDrafts,
      deleteDraft: vi.fn(),
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    expect(listDrafts).toHaveBeenCalledWith("/repo/proj");
  });

  it("shows the empty state when there are no drafts", async () => {
    new DraftsTab({
      groupId: "g1",
      groupRootDir: null,
      onOpenDraft: () => {},
      onNewSpec: () => {},
      listDrafts: vi.fn().mockResolvedValue([]),
      deleteDraft: vi.fn(),
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    expect(host.textContent).toContain("No drafts yet");
  });

  it("falls back to 'Untitled draft' when there is no user message", async () => {
    new DraftsTab({
      groupId: "g1",
      groupRootDir: null,
      onOpenDraft: () => {},
      onNewSpec: () => {},
      listDrafts: vi.fn().mockResolvedValue([draft({ messages: [] })]),
      deleteDraft: vi.fn(),
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelector(".rail-name")?.textContent).toBe("Untitled draft");
  });

  it("calls onOpenDraft with the draft id when an item is clicked", async () => {
    const opened: string[] = [];
    new DraftsTab({
      groupId: "g1",
      groupRootDir: null,
      onOpenDraft: (id) => opened.push(id),
      onNewSpec: () => {},
      listDrafts: vi.fn().mockResolvedValue([draft({ id: "xyz" })]),
      deleteDraft: vi.fn(),
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    (host.querySelector(".rail-row") as HTMLElement).click();
    expect(opened).toEqual(["xyz"]);
  });

  it("deletes a draft via the trash button without opening it", async () => {
    const deleteDraft = vi.fn().mockResolvedValue(undefined);
    const opened: string[] = [];
    new DraftsTab({
      groupId: "g1",
      groupRootDir: null,
      onOpenDraft: (id) => opened.push(id),
      onNewSpec: () => {},
      listDrafts: vi.fn().mockResolvedValue([draft({ id: "kill-me" })]),
      deleteDraft,
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));

    (host.querySelector(".pn-drafts-del") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));

    expect(deleteDraft).toHaveBeenCalledWith("kill-me");
    expect(opened).toEqual([]); // click must not bubble to the item
    expect(host.querySelectorAll(".rail-row").length).toBe(0);
    expect(host.textContent).toContain("No drafts yet");
  });

  it("calls onNewSpec when '+ New spec' is clicked", async () => {
    let called = false;
    new DraftsTab({
      groupId: "g1",
      groupRootDir: null,
      onOpenDraft: () => {},
      onNewSpec: () => { called = true; },
      listDrafts: vi.fn().mockResolvedValue([]),
      deleteDraft: vi.fn(),
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    (host.querySelector(".rail-new") as HTMLElement).click();
    expect(called).toBe(true);
  });

  it("re-renders when refresh() is called", async () => {
    const listDrafts = vi
      .fn()
      .mockResolvedValueOnce([draft({ id: "a" })])
      .mockResolvedValueOnce([draft({ id: "a" }), draft({ id: "b" })]);
    const tab = new DraftsTab({
      groupId: "g1",
      groupRootDir: null,
      onOpenDraft: () => {},
      onNewSpec: () => {},
      listDrafts,
      deleteDraft: vi.fn(),
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelectorAll(".rail-row").length).toBe(1);

    await tab.refresh();
    expect(host.querySelectorAll(".rail-row").length).toBe(2);
  });
});
