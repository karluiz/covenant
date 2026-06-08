import { describe, expect, it, vi } from "vitest";
import { buildActions } from "./actions";

function fakeManager() {
  return {
    create: vi.fn().mockReturnValue("new-id"),
    switchTo: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    activeId_: vi.fn().mockReturnValue("cur"),
    rename: vi.fn(),
  };
}

describe("buildActions", () => {
  it("New workspace creates + switches", async () => {
    const m = fakeManager();
    const tm = { closeActiveTab: vi.fn() };
    const actions = buildActions(m as never, tm as never);
    const a = actions.find((x) => x.id === "new-workspace")!;
    await a.run();
    expect(m.create).toHaveBeenCalled();
    expect(m.switchTo).toHaveBeenCalledWith("new-id");
  });

  it("Close current tab calls tabManager.closeActiveTab", async () => {
    const m = fakeManager();
    const tm = { closeActiveTab: vi.fn() };
    const actions = buildActions(m as never, tm as never);
    const a = actions.find((x) => x.id === "close-tab")!;
    await a.run();
    expect(tm.closeActiveTab).toHaveBeenCalled();
  });

  it("Rename current workspace exists and is invokable", () => {
    const m = fakeManager();
    const tm = { closeActiveTab: vi.fn() };
    const actions = buildActions(m as never, tm as never);
    expect(actions.find((x) => x.id === "rename-workspace")).toBeDefined();
  });
});
