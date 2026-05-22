import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the Tauri-backed API surface BEFORE importing the SUT so the
// import-time bindings inside WorkspaceManager resolve to the stub.
const saveSpy = vi.fn(async (_body: string) => {});
vi.mock("../api", () => ({
  tabManifestSave: (body: string) => saveSpy(body),
}));

import { WorkspaceManager } from "./manager";
import type { TabManifestV1 } from "../tabs/manager";
import type { LivePool, PoolableTabManager } from "./live-pool";

/// Minimal LivePool fake. WorkspaceManager only reads `pool.active()` /
/// `pool.adopt(id, m)` / `pool.activate(id, manifest)` / `pool.forget(id)`,
/// so we don't need the LRU / hibernation machinery here — just track
/// which manager is currently "active" and route adopt/activate to the
/// underlying mock TabManager. Each test injects its own mock manager.
function makeFakePool(initialManager: any): LivePool {
  let active: any = null;
  const live = new Map<string, any>();
  const fake: Partial<LivePool> = {
    adopt(id: string, m: PoolableTabManager) {
      live.set(id, m);
      active = m;
    },
    async activate(id: string, manifest: unknown): Promise<PoolableTabManager> {
      // Tests reuse `initialManager` for every workspace (we don't have
      // multi-instance machinery here). To preserve per-workspace state
      // across switches, the fake replays the target workspace's manifest
      // into the shared manager on every activate — mirroring how the
      // real LivePool keeps per-id TabManagers alive with their own state.
      await initialManager.replaceFromManifest(manifest);
      live.set(id, initialManager);
      active = initialManager;
      return initialManager;
    },
    async forget(id: string): Promise<void> {
      // Only drop `active` if we forgot the workspace that's currently
      // active. Since the fake aliases every workspace to the same
      // initialManager, we can't compare by identity — track via the
      // map's last-known active id instead. Tests don't forget the
      // active workspace mid-flow (delete() switches first), so the
      // simplest correct behavior is to clear `live[id]` only.
      live.delete(id);
    },
    active(): PoolableTabManager | null {
      return active;
    },
    isLive: (id: string) => live.has(id),
    isHibernated: () => false,
    activityOf: () => null,
  };
  return fake as LivePool;
}

interface MockTabManagerState {
  manifest: TabManifestV1;
  replaceCalls: TabManifestV1[];
  createTabCalls: number;
}

function makeMockTabManager(initial?: TabManifestV1): {
  manager: any;
  state: MockTabManagerState;
} {
  const state: MockTabManagerState = {
    manifest: initial ?? { version: 1, active_index: 0, tabs: [], groups: [] },
    replaceCalls: [],
    createTabCalls: 0,
  };
  const manager = {
    serializeManifest(): TabManifestV1 {
      return JSON.parse(JSON.stringify(state.manifest));
    },
    async replaceFromManifest(m: TabManifestV1): Promise<void> {
      state.replaceCalls.push(JSON.parse(JSON.stringify(m)));
      state.manifest = JSON.parse(JSON.stringify(m));
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
    const ws = new WorkspaceManager(makeFakePool(manager), manager);
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
    const ws = new WorkspaceManager(makeFakePool(manager), manager);
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
    const ws = new WorkspaceManager(makeFakePool(manager), manager);
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
    const ws = new WorkspaceManager(makeFakePool(manager), manager);
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
    const ws = new WorkspaceManager(makeFakePool(manager), manager);
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

    // Switching back should restore the work we left in the first ws.
    await ws.switchTo(firstId);
    const restored = state.replaceCalls[state.replaceCalls.length - 1];
    expect(restored.tabs.some((t) => t.custom_name === "first-tab")).toBe(true);
  });
});

describe("WorkspaceManager.moveGroupTo", () => {
  beforeEach(() => saveSpy.mockClear());

  it("moves a group and its tabs into the target workspace, clearing the source", async () => {
    const { manager, state } = makeMockTabManager();
    const ws = new WorkspaceManager(makeFakePool(manager), manager);
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
    const ws = new WorkspaceManager(makeFakePool(manager), manager);
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
    const ws = new WorkspaceManager(makeFakePool(manager), manager);
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
    const ws = new WorkspaceManager(makeFakePool(manager), manager);
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
    const ws = new WorkspaceManager(makeFakePool(manager), manager);
    await ws.boot(null);
    const onlyId = ws.list()[0].id;
    await ws.delete(onlyId);
    expect(ws.list()).toHaveLength(1);
    expect(ws.list()[0].id).toBe(onlyId);
  });

  it("switches to most-recent then deletes when removing the active workspace", async () => {
    const { manager } = makeMockTabManager();
    const ws = new WorkspaceManager(makeFakePool(manager), manager);
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
