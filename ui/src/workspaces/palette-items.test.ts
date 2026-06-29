import { describe, expect, it, vi } from "vitest";
import { buildSections, type PaletteAction } from "./palette-items";
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
    tabIndex: 0, title: "tab", isActiveTabInWorkspace: false, ...p,
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
