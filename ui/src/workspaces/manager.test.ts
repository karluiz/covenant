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

    // Switching back should restore the work we left in the first ws.
    await ws.switchTo(firstId);
    const restored = state.replaceCalls[state.replaceCalls.length - 1];
    expect(restored.tabs.some((t) => t.custom_name === "first-tab")).toBe(true);
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
