import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the Tauri-backed API surface BEFORE importing the SUT so the
// import-time bindings inside WorkspaceManager resolve to the stub.
const saveSpy = vi.fn(async (_body: string) => {});
vi.mock("../api", () => ({
  tabManifestSave: (body: string) => saveSpy(body),
}));

import { WorkspaceManager } from "./manager";
import type { TabManifestV1 } from "../tabs/manager";

interface MockTabManagerState {
  manifest: TabManifestV1;
  replaceCalls: TabManifestV1[];
  createTabCalls: number;
  hibernated: Map<string, TabManifestV1>;
}

function makeMockTabManager(initial?: TabManifestV1): {
  manager: any;
  state: MockTabManagerState;
} {
  const state: MockTabManagerState = {
    manifest: initial ?? { version: 1, active_index: 0, tabs: [], groups: [] },
    replaceCalls: [],
    createTabCalls: 0,
    hibernated: new Map(),
  };
  const manager = {
    serializeManifest(): TabManifestV1 {
      return JSON.parse(JSON.stringify(state.manifest));
    },
    async replaceFromManifest(m: TabManifestV1): Promise<void> {
      state.replaceCalls.push(JSON.parse(JSON.stringify(m)));
      state.manifest = JSON.parse(JSON.stringify(m));
    },
    setActiveWorkspaceName(_name: string): void {
      /* noop */
    },
    // Hibernation stash mirrors the real TabManager: hibernate stows the
    // live body and clears it; unhibernate restores it; restoreFromManifest
    // *appends* (the real impl preserves existing live tabs).
    hibernate(id: string): void {
      state.hibernated.set(id, JSON.parse(JSON.stringify(state.manifest)));
      state.manifest = { version: 1, active_index: 0, tabs: [], groups: [] };
    },
    unhibernate(id: string): boolean {
      const stash = state.hibernated.get(id);
      if (!stash) return false;
      state.hibernated.delete(id);
      state.manifest = JSON.parse(JSON.stringify(stash));
      return true;
    },
    hasHibernated(id: string): boolean {
      return state.hibernated.has(id);
    },
    disposeHibernated(id: string): void {
      state.hibernated.delete(id);
    },
    async restoreFromManifest(m: TabManifestV1): Promise<void> {
      state.replaceCalls.push(JSON.parse(JSON.stringify(m)));
      for (const g of m.groups ?? []) state.manifest.groups.push(JSON.parse(JSON.stringify(g)));
      for (const t of m.tabs ?? []) state.manifest.tabs.push(JSON.parse(JSON.stringify(t)));
    },
    async createTab(): Promise<void> {
      state.createTabCalls += 1;
      state.manifest.tabs.push({
        custom_name: null,
        cwd: null,
        color: null,
        group_id: null,
        mission_path: null,
        operator_id: null,
      } as TabManifestV1["tabs"][number]);
    },
    activeSessionId(): string | null {
      return state.manifest.tabs.length > 0 ? "sess-stub" : null;
    },
    setOnPersistRequest(_cb: (() => void) | null): void {
      /* noop for tests */
    },
    snapshotGroupForMove(groupId: string) {
      const g = state.manifest.groups.find((sg) => sg.id === groupId);
      if (!g) return null;
      const tabs = state.manifest.tabs.filter((t) => t.group_id === groupId);
      return JSON.parse(JSON.stringify({ group: g, tabs }));
    },
    removeGroupAndTabs(groupId: string): void {
      state.manifest.tabs = state.manifest.tabs.filter(
        (t) => t.group_id !== groupId,
      );
      state.manifest.groups = state.manifest.groups.filter(
        (g) => g.id !== groupId,
      );
    },
    snapshotForFinder() {
      return state.manifest.tabs.map((t, index) => ({
        index,
        title: t.custom_name ?? `Tab ${index + 1}`,
        groupId: t.group_id ?? null,
        isActive: index === state.manifest.active_index,
      }));
    },
  };
  return { manager, state };
}

describe("WorkspaceManager.boot — migration", () => {
  beforeEach(() => saveSpy.mockClear());

  it("falls back to a fresh Default workspace on null input", async () => {
    const { manager, state } = makeMockTabManager();
    const ws = new WorkspaceManager(manager);
    await ws.boot(null);
    const list = ws.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Default");
    expect(list[0].active).toBe(true);
    // Boot must guarantee at least one tab in the active workspace.
    expect(state.createTabCalls).toBeGreaterThanOrEqual(1);
  });

  it("falls back to Default on malformed JSON", async () => {
    const { manager } = makeMockTabManager();
    const ws = new WorkspaceManager(manager);
    await ws.boot("not json {{{");
    expect(ws.list()).toHaveLength(1);
    expect(ws.list()[0].name).toBe("Default");
  });

  it("migrates a legacy V1 manifest into a single Default workspace", async () => {
    const v1: TabManifestV1 = {
      version: 1,
      active_index: 0,
      tabs: [
        {
          custom_name: "alpha",
          cwd: "/tmp",
          color: null,
          group_id: null,
          mission_path: null,
          operator_id: null,
        },
      ],
      groups: [],
    };
    const { manager, state } = makeMockTabManager();
    const ws = new WorkspaceManager(manager);
    await ws.boot(JSON.stringify(v1));
    const list = ws.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Default");
    // The V1 tab should have been restored via replaceFromManifest.
    expect(state.replaceCalls.length).toBeGreaterThan(0);
    const last = state.replaceCalls[state.replaceCalls.length - 1];
    expect(last.tabs).toHaveLength(1);
    expect(last.tabs[0].custom_name).toBe("alpha");
  });

  it("loads a V2 envelope as-is", async () => {
    const v2 = {
      version: 2,
      active_workspace_id: "ws-b",
      workspaces: [
        {
          id: "ws-a",
          name: "Alpha",
          color: null,
          root_dir: null,
          created_at: 1,
          last_used_at: 1,
          active_index: 0,
          tabs: [],
          groups: [],
        },
        {
          id: "ws-b",
          name: "Beta",
          color: "#22c55e",
          root_dir: null,
          created_at: 2,
          last_used_at: 2,
          active_index: 0,
          tabs: [],
          groups: [],
        },
      ],
    };
    const { manager } = makeMockTabManager();
    const ws = new WorkspaceManager(manager);
    await ws.boot(JSON.stringify(v2));
    const list = ws.list();
    expect(list).toHaveLength(2);
    expect(list.find((w) => w.id === "ws-b")?.active).toBe(true);
  });
});

describe("WorkspaceManager.switchTo", () => {
  beforeEach(() => saveSpy.mockClear());

  it("serializes outgoing state into the source workspace and restores incoming", async () => {
    const { manager, state } = makeMockTabManager();
    const ws = new WorkspaceManager(manager);
    await ws.boot(null);
    const firstId = ws.list()[0].id;
    const secondId = ws.create("Second");

    // Simulate the user adding work to the first workspace.
    state.manifest.tabs.push({
      custom_name: "first-tab",
      cwd: "/work",
      color: null,
      group_id: null,
      mission_path: null,
      operator_id: null,
    } as TabManifestV1["tabs"][number]);

    await ws.switchTo(secondId);
    expect(ws.list().find((w) => w.id === secondId)?.active).toBe(true);

    // Switching back restores the work we left in the first ws. The warm
    // path comes back via the hibernation stash (PTYs survive), so assert
    // on the live state rather than a manifest re-spawn.
    await ws.switchTo(firstId);
    expect(state.manifest.tabs.some((t) => t.custom_name === "first-tab")).toBe(true);
  });
});

describe("WorkspaceManager.moveGroupTo", () => {
  beforeEach(() => saveSpy.mockClear());

  it("moves a group and its tabs into the target workspace, clearing the source", async () => {
    const { manager, state } = makeMockTabManager();
    const ws = new WorkspaceManager(manager);
    await ws.boot(null);
    const sourceId = ws.list()[0].id;
    const targetId = ws.create("Target");

    // Seed the active (source) workspace with one group + 2 tabs in it
    // plus a sibling ungrouped tab that must stay behind.
    state.manifest.groups = [
      { id: "g1", name: "Project", color: null, collapsed: false, root_dir: "/work" },
    ];
    state.manifest.tabs = [
      {
        custom_name: "outsider",
        cwd: null,
        color: null,
        group_id: null,
        mission_path: null,
        operator_id: null,
      } as TabManifestV1["tabs"][number],
      {
        custom_name: "inside-a",
        cwd: "/work/a",
        color: "#7aa2f7",
        group_id: "g1",
        mission_path: null,
        operator_id: null,
        aom_excluded: true,
      } as TabManifestV1["tabs"][number],
      {
        custom_name: "inside-b",
        cwd: "/work/b",
        color: null,
        group_id: "g1",
        mission_path: null,
        operator_id: "op-x",
      } as TabManifestV1["tabs"][number],
    ];

    await ws.moveGroupTo("g1", targetId);

    // Source: group gone, only "outsider" remains.
    expect(state.manifest.groups).toHaveLength(0);
    expect(state.manifest.tabs.map((t) => t.custom_name)).toEqual(["outsider"]);

    // Target: gets the group + both tabs with metadata preserved.
    const v2 = ws.serializeV2();
    const target = v2.workspaces.find((w) => w.id === targetId)!;
    expect(target.groups).toHaveLength(1);
    expect(target.groups[0].id).toBe("g1");
    expect(target.groups[0].root_dir).toBe("/work");
    expect(target.tabs.map((t) => t.custom_name).sort()).toEqual([
      "inside-a",
      "inside-b",
    ]);
    const a = target.tabs.find((t) => t.custom_name === "inside-a")!;
    expect(a.cwd).toBe("/work/a");
    expect(a.color).toBe("#7aa2f7");
    expect(a.aom_excluded).toBe(true);
    const b = target.tabs.find((t) => t.custom_name === "inside-b")!;
    expect(b.operator_id).toBe("op-x");

    // Persisted.
    expect(saveSpy).toHaveBeenCalled();
    void sourceId;
  });

  it("spawns a fresh tab if moving empties the source workspace", async () => {
    const { manager, state } = makeMockTabManager();
    const ws = new WorkspaceManager(manager);
    await ws.boot(null);
    const targetId = ws.create("Target");

    state.manifest.groups = [
      { id: "g1", name: "Solo", color: null, collapsed: false },
    ];
    state.manifest.tabs = [
      {
        custom_name: "only",
        cwd: null,
        color: null,
        group_id: "g1",
        mission_path: null,
        operator_id: null,
      } as TabManifestV1["tabs"][number],
    ];

    const beforeCreate = state.createTabCalls;
    await ws.moveGroupTo("g1", targetId);

    // Source got cleared then refilled with one fresh tab.
    expect(state.createTabCalls).toBe(beforeCreate + 1);
  });

  it("is a no-op when target is the active workspace", async () => {
    const { manager, state } = makeMockTabManager();
    const ws = new WorkspaceManager(manager);
    await ws.boot(null);
    const sourceId = ws.list()[0].id;

    state.manifest.groups = [
      { id: "g1", name: "g", color: null, collapsed: false },
    ];
    state.manifest.tabs = [
      {
        custom_name: "x",
        cwd: null,
        color: null,
        group_id: "g1",
        mission_path: null,
        operator_id: null,
      } as TabManifestV1["tabs"][number],
    ];

    await ws.moveGroupTo("g1", sourceId);
    expect(state.manifest.groups).toHaveLength(1);
    expect(state.manifest.tabs).toHaveLength(1);
  });

  it("moved group survives switching into a target that was already hibernated", async () => {
    const { manager, state } = makeMockTabManager();
    const ws = new WorkspaceManager(manager);
    await ws.boot(null);
    const sourceId = ws.list()[0].id;
    const targetId = ws.create("Target");

    // Visit the target once (cold → live), then switch back so the target
    // is now held in the hibernation stash, not the persisted body. This is
    // the exact condition that used to drop the moved group.
    await ws.switchTo(targetId);
    await ws.switchTo(sourceId);
    expect(manager.hasHibernated(targetId)).toBe(true);

    // Seed the source with a group and move it into the hibernated target.
    state.manifest.groups = [
      { id: "g1", name: "Project", color: null, collapsed: false },
    ];
    state.manifest.tabs = [
      {
        custom_name: "moved",
        cwd: "/work",
        color: null,
        group_id: "g1",
        mission_path: null,
        operator_id: null,
      } as TabManifestV1["tabs"][number],
    ];
    await ws.moveGroupTo("g1", targetId);

    // Switching into the target must replay the moved group into its live
    // tabs — not silently swallow it via unhibernate.
    await ws.switchTo(targetId);
    expect(state.manifest.groups.map((g) => g.id)).toContain("g1");
    expect(state.manifest.tabs.map((t) => t.custom_name)).toContain("moved");
  });
});

describe("WorkspaceManager.listAllTabs", () => {
  beforeEach(() => saveSpy.mockClear());

  it("flattens active (live) + inactive (manifest) workspaces with group denorm", async () => {
    const v2 = {
      version: 2,
      active_workspace_id: "ws-a",
      workspaces: [
        {
          id: "ws-a",
          name: "Alpha",
          color: "#ef4444",
          root_dir: null,
          created_at: 1,
          last_used_at: 1,
          active_index: 1,
          tabs: [
            // These tabs will be overridden by the live TabManager state
            // since ws-a is active.
            { custom_name: "stale", cwd: null, color: null, group_id: null,
              mission_path: null, operator_id: null },
          ],
          groups: [],
        },
        {
          id: "ws-b",
          name: "Beta",
          color: null,
          root_dir: null,
          created_at: 2,
          last_used_at: 2,
          active_index: 0,
          tabs: [
            { custom_name: "named-b", cwd: null, color: null, group_id: "g-b",
              mission_path: null, operator_id: null },
            { custom_name: null, cwd: null, color: null, group_id: null,
              mission_path: null, operator_id: null },
          ],
          groups: [
            { id: "g-b", name: "MyGroup", color: "#22c55e", collapsed: false },
          ],
        },
      ],
    };
    const { manager, state } = makeMockTabManager();
    const ws = new WorkspaceManager(manager);
    await ws.boot(JSON.stringify(v2));

    // Replace live TabManager state for the active workspace.
    state.manifest = {
      version: 1,
      active_index: 0,
      tabs: [
        { custom_name: "live-a1", cwd: null, color: null, group_id: null,
          mission_path: null, operator_id: null },
        { custom_name: null, cwd: null, color: null, group_id: null,
          mission_path: null, operator_id: null },
      ],
      groups: [],
    };

    const rows = ws.listAllTabs();
    // 2 from active + 2 from inactive = 4
    expect(rows).toHaveLength(4);

    // Active workspace rows come first, in tabIndex order, with live titles.
    expect(rows[0].workspaceId).toBe("ws-a");
    expect(rows[0].workspaceActive).toBe(true);
    expect(rows[0].title).toBe("live-a1");
    expect(rows[0].isActiveTabInWorkspace).toBe(true);
    expect(rows[1].title).toBe("Tab 2");
    expect(rows[1].isActiveTabInWorkspace).toBe(false);

    // Inactive rows next, also in tabIndex order, with group denorm.
    expect(rows[2].workspaceId).toBe("ws-b");
    expect(rows[2].workspaceActive).toBe(false);
    expect(rows[2].title).toBe("named-b");
    expect(rows[2].groupId).toBe("g-b");
    expect(rows[2].groupName).toBe("MyGroup");
    expect(rows[2].groupColor).toBe("#22c55e");
    expect(rows[2].isActiveTabInWorkspace).toBe(true);
    expect(rows[3].title).toBe("Tab 2");
    expect(rows[3].groupName).toBeNull();
  });
});

describe("WorkspaceManager.delete", () => {
  beforeEach(() => saveSpy.mockClear());

  it("refuses to delete the last workspace", async () => {
    const { manager } = makeMockTabManager();
    const ws = new WorkspaceManager(manager);
    await ws.boot(null);
    const onlyId = ws.list()[0].id;
    await ws.delete(onlyId);
    expect(ws.list()).toHaveLength(1);
    expect(ws.list()[0].id).toBe(onlyId);
  });

  it("switches to most-recent then deletes when removing the active workspace", async () => {
    const { manager } = makeMockTabManager();
    const ws = new WorkspaceManager(manager);
    await ws.boot(null);
    const firstId = ws.list()[0].id;
    const secondId = ws.create("Second");
    // Make first ws more recent than second by switching to and from it.
    await ws.switchTo(secondId);
    await ws.switchTo(firstId);
    // Delete the active (first); should fall back to second.
    await ws.delete(firstId);
    const remaining = ws.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(secondId);
    expect(remaining[0].active).toBe(true);
  });
});
