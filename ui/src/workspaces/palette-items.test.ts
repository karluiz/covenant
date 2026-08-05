import { describe, expect, it, vi } from "vitest";
import { buildSections, flattenSections, type PaletteAction } from "./palette-items";
import type { WorkspaceView } from "./manager";
import type { TabRow } from "./finder";

function ws(p: Partial<WorkspaceView>): WorkspaceView {
  return {
    id: "ws-1", name: "Workspace", color: null, root_dir: null,
    active: false, tab_count: 0, last_used_at: 0, ...p,
  };
}
function row(p: Partial<TabRow>): TabRow {
  return {
    workspaceId: "ws-1", workspaceName: "Workspace 1", workspaceColor: null,
    workspaceActive: false, groupId: null, groupName: null, groupColor: null,
    tabIndex: 0, tabId: "tab-1", title: "tab", isActiveTabInWorkspace: false,
    lastActiveAt: null, ...p,
  };
}
const noop = () => {};
function action(id: string): PaletteAction {
  return { id, title: id, run: noop };
}

describe("buildSections", () => {
  it("empty query: recent workspaces first, current-workspace tabs, no actions", () => {
    const workspaces = [
      ws({ id: "a", name: "alpha", last_used_at: 100 }),
      ws({ id: "b", name: "beta", last_used_at: 300, active: true }),
      ws({ id: "c", name: "gamma", last_used_at: 200 }),
    ];
    const tabs = [
      row({ workspaceId: "b", workspaceActive: true, title: "here-1", tabIndex: 0 }),
      row({ workspaceId: "a", workspaceActive: false, title: "elsewhere", tabIndex: 0 }),
    ];
    const s = buildSections("", { workspaces, tabs, actions: [action("New workspace")], activeWorkspaceId: "b" });
    expect(s.workspaces.map((i) => i.title)).toEqual(["beta", "gamma", "alpha"]);
    expect(s.tabs.map((i) => i.title)).toEqual(["here-1"]);
    expect(s.actions).toEqual([]);
  });

  it("marks the active workspace and active tab as current", () => {
    const workspaces = [ws({ id: "a", name: "alpha" }), ws({ id: "b", name: "beta" })];
    const tabs = [
      row({ workspaceId: "b", workspaceActive: true, isActiveTabInWorkspace: true, title: "active", tabIndex: 0 }),
      row({ workspaceId: "b", workspaceActive: true, isActiveTabInWorkspace: false, title: "other", tabIndex: 1 }),
    ];
    const s = buildSections("", { workspaces, tabs, actions: [], activeWorkspaceId: "b" });
    const cur = Object.fromEntries(s.workspaces.map((i) => [i.title, !!i.current]));
    expect(cur).toEqual({ alpha: false, beta: true });
    expect(s.tabs.map((i) => [i.title, !!i.current])).toEqual([["active", true], ["other", false]]);
  });

  it("non-empty query: fuzzy match across kinds, drops non-matches", () => {
    const workspaces = [ws({ id: "a", name: "migration" }), ws({ id: "b", name: "scratch" })];
    const tabs = [row({ title: "run-migrate", tabIndex: 1 }), row({ title: "tests", tabIndex: 2 })];
    const actions = [action("Migrate up"), action("Close tab")];
    const s = buildSections("mig", { workspaces, tabs, actions, activeWorkspaceId: "a" });
    expect(s.workspaces.map((i) => i.title)).toEqual(["migration"]);
    expect(s.tabs.map((i) => i.title)).toEqual(["run-migrate"]);
    expect(s.actions.map((i) => i.title)).toEqual(["Migrate up"]);
  });

  it("ranks higher fuzzy score first within a section", () => {
    const tabs = [
      row({ title: "xmigration", tabIndex: 0 }),
      row({ title: "migrate", tabIndex: 1 }),
    ];
    const s = buildSections("mig", { workspaces: [], tabs, actions: [], activeWorkspaceId: "a" });
    expect(s.tabs.map((i) => i.title)).toEqual(["migrate", "xmigration"]);
  });

  it("caps each section", () => {
    const tabs: TabRow[] = [];
    for (let i = 0; i < 20; i++) tabs.push(row({ title: `tab-${i}`, tabIndex: i }));
    const s = buildSections("tab", { workspaces: [], tabs, actions: [], activeWorkspaceId: "a" });
    expect(s.tabs).toHaveLength(8);
  });

  it("empty query: recent lists recently activated tabs, newest first, excluding the current tab", () => {
    const tabs = [
      row({ workspaceId: "b", workspaceActive: true, title: "current", tabIndex: 0, isActiveTabInWorkspace: true, lastActiveAt: 900 }),
      row({ workspaceId: "b", workspaceActive: true, title: "older", tabIndex: 1, lastActiveAt: 100 }),
      row({ workspaceId: "b", workspaceActive: true, title: "newer", tabIndex: 2, lastActiveAt: 500 }),
      row({ workspaceId: "b", workspaceActive: true, title: "never", tabIndex: 3, lastActiveAt: null }),
    ];
    const s = buildSections("", { workspaces: [], tabs, actions: [], activeWorkspaceId: "b" });
    expect(s.recent.map((i) => i.title)).toEqual(["newer", "older"]);
    // Recent tabs don't repeat in the Tabs section.
    expect(s.tabs.map((i) => i.title)).toEqual(["current", "never"]);
  });

  it("non-empty query: recent section is empty", () => {
    const tabs = [row({ title: "match", tabIndex: 0, lastActiveAt: 100 })];
    const s = buildSections("mat", { workspaces: [], tabs, actions: [], activeWorkspaceId: "ws-1" });
    expect(s.recent).toEqual([]);
    expect(s.tabs.map((i) => i.title)).toEqual(["match"]);
  });

  it("tab items expose the group name separately for uppercase CSS rendering", () => {
    const tabs = [row({ workspaceName: "pandoras", groupName: "fReelance", title: "data", tabIndex: 0 })];
    const s = buildSections("data", { workspaces: [], tabs, actions: [], activeWorkspaceId: "ws-1" });
    expect(s.tabs[0].subtitle).toBe("pandoras");
    expect(s.tabs[0].subtitleGroup).toBe("fReelance");
  });

  it("tab item run switches workspace then activates index", async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    const activate = vi.fn();
    const tabs = [row({ workspaceId: "other", title: "t", tabIndex: 3 })];
    const s = buildSections("t", {
      workspaces: [], tabs, actions: [], activeWorkspaceId: "cur",
      switchWorkspace: switchTo, activateTab: activate,
    });
    await s.tabs[0].run();
    expect(switchTo).toHaveBeenCalledWith("other");
    expect(activate).toHaveBeenCalledWith(3);
  });

  describe("row-scoped verbs", () => {
    const hooks = {
      renameWorkspace: vi.fn(),
      deleteWorkspace: vi.fn(),
      renameTab: vi.fn(),
      closeTab: vi.fn(),
      createWorkspace: vi.fn(),
    };

    it("a workspace row renames and deletes itself — not 'the current one'", async () => {
      const s = buildSections("alph", {
        workspaces: [ws({ id: "a", name: "alpha" })], tabs: [], actions: [],
        activeWorkspaceId: "other", ...hooks,
      });
      const item = s.workspaces[0];
      item.rename?.("renamed");
      await item.destroy?.();
      expect(hooks.renameWorkspace).toHaveBeenCalledWith("a", "renamed");
      expect(hooks.deleteWorkspace).toHaveBeenCalledWith("a");
      expect(item.destroyVerb).toBe("delete");
    });

    it("a blocked workspace carries the reason instead of a no-op destroy", () => {
      const s = buildSections("alph", {
        workspaces: [ws({ id: "a", name: "alpha" })], tabs: [], actions: [],
        activeWorkspaceId: "a", ...hooks,
        deleteBlocked: () => "last workspace",
      });
      expect(s.workspaces[0].destroy).toBeUndefined();
      expect(s.workspaces[0].destroyBlocked).toBe("last workspace");
    });

    it("a live tab row closes that tab; a background one is gated with a reason", () => {
      const tabs = [
        row({ workspaceActive: true, tabId: "t-live", title: "live", tabIndex: 0 }),
        row({ workspaceActive: false, tabId: null, title: "live-cold", tabIndex: 1 }),
      ];
      const s = buildSections("live", {
        workspaces: [], tabs, actions: [], activeWorkspaceId: "ws-1", ...hooks,
      });
      const [live, cold] = s.tabs;
      void live.destroy?.();
      expect(hooks.closeTab).toHaveBeenCalledWith(tabs[0]);
      expect(live.destroyVerb).toBe("close");
      expect(cold.destroy).toBeUndefined();
      expect(cold.destroyBlocked).toBe("switch to that workspace first");
      expect(cold.rename).toBeUndefined();
    });

    it("offers create when the query names no workspace, and never steals ⏎ from a match", () => {
      const workspaces = [ws({ id: "a", name: "alpha" })];
      const s = buildSections("alp", { workspaces, tabs: [], actions: [], activeWorkspaceId: "a", ...hooks });
      expect(s.create).toHaveLength(1);
      expect(s.create[0].title).toContain("alp");
      // Create is last in traversal order, so ⏎ still switches to alpha.
      expect(flattenSections(s)[0].kind).toBe("workspace");
    });

    it("no create row when the query is exactly an existing name", () => {
      const workspaces = [ws({ id: "a", name: "Alpha" })];
      const s = buildSections("alpha", { workspaces, tabs: [], actions: [], activeWorkspaceId: "a", ...hooks });
      expect(s.create).toEqual([]);
    });

    it("create runs with the typed name", async () => {
      const s = buildSections("fresh-repo", { workspaces: [], tabs: [], actions: [], activeWorkspaceId: "a", ...hooks });
      await s.create[0].run();
      expect(hooks.createWorkspace).toHaveBeenCalledWith("fresh-repo");
    });
  });

  it("tab item run skips switch when already in workspace", async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    const activate = vi.fn();
    const tabs = [row({ workspaceId: "cur", title: "t", tabIndex: 2 })];
    const s = buildSections("t", {
      workspaces: [], tabs, actions: [], activeWorkspaceId: "cur",
      switchWorkspace: switchTo, activateTab: activate,
    });
    await s.tabs[0].run();
    expect(switchTo).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith(2);
  });
});
