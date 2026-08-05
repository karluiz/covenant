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

  it("empty query shows workspaces as a tile strip ordered by recency", () => {
    const { p } = mk();
    p.open();
    const names = [...document.querySelectorAll(".cp-tile .cp-tile-name")].map((e) => e.textContent);
    expect(names).toEqual(["alpha", "beta"]);
    const listTitles = [...document.querySelectorAll(".command-palette-item .cp-title")].map((e) => e.textContent);
    expect(listTitles).not.toContain("alpha");
    p.close();
  });

  it("⌘digit switches to the Nth most-recent workspace", () => {
    const { p, m } = mk();
    p.open();
    const input = document.querySelector<HTMLInputElement>(".command-palette-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "2", metaKey: true }));
    expect(m.switchTo).toHaveBeenCalledWith("b");
    expect(document.querySelector(".command-palette-overlay")).toBeFalsy();
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

  // The row grammar. jsdom isn't macOS, so `modHeld` is Ctrl and
  // `appModHeld` is Ctrl+Shift — the chords the footer prints there too.
  describe("row grammar", () => {
    function query(text: string) {
      const input = document.querySelector<HTMLInputElement>(".command-palette-input")!;
      input.value = text;
      input.dispatchEvent(new Event("input"));
      return input;
    }

    it("⌘E renames the row under the cursor, in place, without closing", () => {
      const { p, m } = mk();
      p.open();
      const input = query("beta");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true }));
      const edit = document.querySelector<HTMLInputElement>(".cp-rename-input")!;
      expect(edit).toBeTruthy();
      expect(edit.value).toBe("beta");
      expect(document.querySelector(".command-palette-overlay")).toBeTruthy();
      edit.value = "renamed";
      edit.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(m.rename).toHaveBeenCalledWith("b", "renamed");
      expect(document.querySelector(".cp-rename-input")).toBeFalsy();
      p.close();
    });

    it("esc in the rename input reverts and keeps the palette open", () => {
      const { p, m } = mk();
      p.open();
      const input = query("beta");
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "e", ctrlKey: true }));
      const edit = document.querySelector<HTMLInputElement>(".cp-rename-input")!;
      edit.value = "nope";
      edit.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(m.rename).not.toHaveBeenCalled();
      expect(document.querySelector(".command-palette-overlay")).toBeTruthy();
      p.close();
    });

    it("⌘⌫ deletes the focused workspace through the host policy, palette stays open", () => {
      const deleteWorkspace = vi.fn();
      const m = makeManager();
      const tm = { activateByIndex: vi.fn(), closeActiveTab: vi.fn() };
      const p = new CommandPalette(document.body, m as never, tm as never, [], undefined, {
        deleteWorkspace,
        deleteBlocked: () => null,
      });
      p.open();
      const input = query("beta");
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Backspace", ctrlKey: true, shiftKey: true }),
      );
      expect(deleteWorkspace).toHaveBeenCalledWith("b");
      expect(document.querySelector(".command-palette-overlay")).toBeTruthy();
      p.close();
    });

    it("a blocked delete shows the reason in the footer instead of firing", () => {
      const deleteWorkspace = vi.fn();
      const m = makeManager();
      const tm = { activateByIndex: vi.fn(), closeActiveTab: vi.fn() };
      const p = new CommandPalette(document.body, m as never, tm as never, [], undefined, {
        deleteWorkspace,
        deleteBlocked: () => "last workspace",
      });
      p.open();
      const input = query("beta");
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Backspace", ctrlKey: true, shiftKey: true }),
      );
      expect(deleteWorkspace).not.toHaveBeenCalled();
      expect(document.querySelector(".cp-footer")!.textContent).toContain("last workspace");
      p.close();
    });

    it("the footer teaches the verbs of the focused row kind", () => {
      const { p } = mk();
      p.open();
      query("beta");
      const footer = () => document.querySelector(".cp-footer")!.textContent!;
      expect(footer()).toContain("switch");
      expect(footer()).toContain("rename");
      p.close();
    });

    it("a query naming no workspace offers create, and ⌘⏎ takes it", async () => {
      const { p, m } = mk();
      p.open();
      const input = query("santander");
      const titles = [...document.querySelectorAll(".command-palette-item .cp-title")].map(
        (e) => e.textContent,
      );
      expect(titles.some((t) => t?.includes("Create workspace"))).toBe(true);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
      await Promise.resolve();
      expect(m.create).toHaveBeenCalledWith("santander");
    });
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
