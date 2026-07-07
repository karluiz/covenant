import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./palette";

function makeManager(over: Record<string, unknown> = {}) {
  return {
    list: () => [
      { id: "a", name: "alpha", color: null, root_dir: null, active: true, tab_count: 2, last_used_at: 300 },
      { id: "b", name: "beta", color: null, root_dir: null, active: false, tab_count: 1, last_used_at: 100 },
    ],
    listAllTabs: () => [
      { workspaceId: "a", workspaceName: "alpha", workspaceColor: null, workspaceActive: true, groupId: null, groupName: null, groupColor: null, tabIndex: 0, title: "editor", isActiveTabInWorkspace: true, lastActiveAt: null },
    ],
    activeId_: () => "a",
    switchTo: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockReturnValue("c"),
    rename: vi.fn(),
    ...over,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CommandPalette", () => {
  function mk(over = {}) {
    const m = makeManager(over);
    const tm = { activateByIndex: vi.fn(), closeActiveTab: vi.fn() };
    const p = new CommandPalette(document.body, m as never, tm as never, []);
    return { p, m, tm };
  }

  it("opens with an overlay and focused input", () => {
    const { p } = mk();
    p.open();
    expect(document.querySelector(".command-palette-overlay")).toBeTruthy();
    expect(document.activeElement?.classList.contains("command-palette-input")).toBe(true);
    p.close();
  });

  it("empty query shows workspace section ordered by recency", () => {
    const { p } = mk();
    p.open();
    const titles = [...document.querySelectorAll(".command-palette-item .cp-title")].map((e) => e.textContent);
    expect(titles).toContain("alpha");
    expect(titles).toContain("beta");
    p.close();
  });

  it("typing filters and Enter runs the selected item", () => {
    const { p, m } = mk();
    p.open();
    const input = document.querySelector<HTMLInputElement>(".command-palette-input")!;
    input.value = "beta";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(m.switchTo).toHaveBeenCalledWith("b");
  });

  it("first Esc clears query, second Esc closes", () => {
    const { p } = mk();
    p.open();
    const input = document.querySelector<HTMLInputElement>(".command-palette-input")!;
    input.value = "x";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(input.value).toBe("");
    expect(document.querySelector(".command-palette-overlay")).toBeTruthy();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".command-palette-overlay")).toBeFalsy();
  });

  it("ArrowDown moves selection across the flat list", () => {
    const { p } = mk();
    p.open();
    const input = document.querySelector<HTMLInputElement>(".command-palette-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    const active = document.querySelectorAll(".command-palette-item.active");
    expect(active).toHaveLength(1);
    p.close();
  });
});
