// Workspaces: top-level container above Groups → Tabs.
//
// A Workspace owns the same body as the legacy TabManifestV1 (active_index,
// tabs[], groups[]) plus user-facing metadata (name, color, optional rootDir).
// Multiple workspaces can exist simultaneously; only one is "active" at a
// time. Switching workspaces hibernates the outgoing one (its PTYs are
// killed) and respawns the incoming one from its manifest. Persisted as a
// V2 envelope so the existing single-manifest file remains a single file.

import { tabManifestSave } from "../api";
import { TabManager, type TabManifestV1 } from "../tabs/manager";

export interface Workspace {
  id: string;
  name: string;
  color: string | null;
  root_dir: string | null;
  created_at: number;
  last_used_at: number;
  active_index: number;
  tabs: TabManifestV1["tabs"];
  groups: TabManifestV1["groups"];
}

export interface TabManifestV2 {
  version: 2;
  active_workspace_id: string;
  workspaces: Workspace[];
}

export interface WorkspaceView {
  id: string;
  name: string;
  color: string | null;
  root_dir: string | null;
  active: boolean;
  tab_count: number;
  last_used_at: number;
}

function nowMs(): number {
  return Date.now();
}

function newId(): string {
  // crypto.randomUUID is available in the Tauri webview (Chromium ≥ 92).
  return crypto.randomUUID();
}

function emptyWorkspace(name: string): Workspace {
  const t = nowMs();
  return {
    id: newId(),
    name,
    color: null,
    root_dir: null,
    created_at: t,
    last_used_at: t,
    active_index: 0,
    tabs: [],
    groups: [],
  };
}

function workspaceAsV1Body(ws: Workspace): TabManifestV1 {
  return {
    version: 1,
    active_index: ws.active_index,
    tabs: ws.tabs,
    groups: ws.groups,
  };
}

export class WorkspaceManager {
  private workspaces: Workspace[] = [];
  private activeId: string = "";
  private listeners: Set<() => void> = new Set();
  /// Set to true while boot() / switchTo() is restoring tabs so the
  /// debounced TabManager save callback doesn't race the swap and
  /// overwrite the incoming workspace's body with the still-empty
  /// outgoing state mid-flight.
  private suspendPersist = false;

  constructor(private readonly tabManager: TabManager) {}

  /// Boot from a raw JSON manifest blob (as returned by tabManifestLoad).
  /// Handles all three cases: null/missing, V1 legacy, V2 native. Always
  /// leaves the manager in a usable state — falls back to a single empty
  /// "Default" workspace on any parse / shape failure.
  async boot(rawJson: string | null): Promise<void> {
    this.suspendPersist = true;
    try {
      let parsed: unknown = null;
      if (rawJson) {
        try {
          parsed = JSON.parse(rawJson);
        } catch {
          parsed = null;
        }
      }
      const migrated = this.migrate(parsed);
      this.workspaces = migrated.workspaces;
      this.activeId = migrated.active_workspace_id;

      const active = this.getActive();
      // Wire TabManager's persistence callback to round-trip through us.
      this.tabManager.setOnPersistRequest(() => {
        if (this.suspendPersist) return;
        void this.saveAll();
      });

      if (active.tabs.length === 0) {
        // Empty workspace (fresh boot or migration-from-nothing). Spin
        // up one fresh tab via the standard createTab path.
        await this.tabManager.replaceFromManifest(workspaceAsV1Body(active));
        // replaceFromManifest with zero tabs leaves us empty; createTab.
        if (this.tabManager.activeSessionId() === null) {
          await this.tabManager.createTab();
        }
      } else {
        await this.tabManager.replaceFromManifest(workspaceAsV1Body(active));
      }
      active.last_used_at = nowMs();
    } finally {
      this.suspendPersist = false;
    }
    await this.saveAll();
    this.emitChange();
  }

  private migrate(parsed: unknown): TabManifestV2 {
    const fallback = (): TabManifestV2 => {
      const ws = emptyWorkspace("Default");
      return {
        version: 2,
        active_workspace_id: ws.id,
        workspaces: [ws],
      };
    };
    if (!parsed || typeof parsed !== "object") return fallback();
    const p = parsed as { version?: unknown };
    if (p.version === 2) {
      const v2 = parsed as TabManifestV2;
      if (
        Array.isArray(v2.workspaces) &&
        v2.workspaces.length > 0 &&
        typeof v2.active_workspace_id === "string"
      ) {
        const hasActive = v2.workspaces.some((w) => w.id === v2.active_workspace_id);
        return {
          version: 2,
          active_workspace_id: hasActive ? v2.active_workspace_id : v2.workspaces[0].id,
          workspaces: v2.workspaces,
        };
      }
      return fallback();
    }
    if (p.version === 1) {
      const v1 = parsed as TabManifestV1;
      const ws = emptyWorkspace("Default");
      ws.active_index = v1.active_index ?? 0;
      ws.tabs = Array.isArray(v1.tabs) ? v1.tabs : [];
      ws.groups = Array.isArray(v1.groups) ? v1.groups : [];
      return {
        version: 2,
        active_workspace_id: ws.id,
        workspaces: [ws],
      };
    }
    return fallback();
  }

  getActive(): Workspace {
    const ws = this.workspaces.find((w) => w.id === this.activeId);
    if (ws) return ws;
    // Should be impossible post-boot. Recreate.
    const fresh = emptyWorkspace("Default");
    this.workspaces = [fresh];
    this.activeId = fresh.id;
    return fresh;
  }

  list(): WorkspaceView[] {
    return this.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      color: w.color,
      root_dir: w.root_dir,
      active: w.id === this.activeId,
      tab_count: w.id === this.activeId
        ? this.tabManager.serializeManifest().tabs.length
        : w.tabs.length,
      last_used_at: w.last_used_at,
    }));
  }

  /// Build the on-disk V2 envelope. Pulls the *current* TabManager state
  /// into the active workspace's body so the snapshot is fresh.
  serializeV2(): TabManifestV2 {
    const body = this.tabManager.serializeManifest();
    const active = this.getActive();
    active.active_index = body.active_index;
    active.tabs = body.tabs;
    active.groups = body.groups;
    return {
      version: 2,
      active_workspace_id: this.activeId,
      workspaces: this.workspaces,
    };
  }

  async saveAll(): Promise<void> {
    try {
      const body = JSON.stringify(this.serializeV2());
      await tabManifestSave(body);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("workspaces saveAll failed", err);
    }
  }

  create(name: string): string {
    const ws = emptyWorkspace(name.trim() || "Untitled");
    this.workspaces.push(ws);
    void this.saveAll();
    this.emitChange();
    return ws.id;
  }

  async switchTo(id: string): Promise<void> {
    if (id === this.activeId) return;
    const target = this.workspaces.find((w) => w.id === id);
    if (!target) return;

    // Snapshot current state into the outgoing workspace before tearing
    // its PTYs down.
    const out = this.getActive();
    const body = this.tabManager.serializeManifest();
    out.active_index = body.active_index;
    out.tabs = body.tabs;
    out.groups = body.groups;

    this.suspendPersist = true;
    try {
      this.activeId = id;
      target.last_used_at = nowMs();
      if (target.tabs.length === 0) {
        // Replace clears existing; then spawn one fresh tab so the
        // incoming workspace isn't empty.
        await this.tabManager.replaceFromManifest(workspaceAsV1Body(target));
        if (this.tabManager.activeSessionId() === null) {
          await this.tabManager.createTab();
        }
      } else {
        await this.tabManager.replaceFromManifest(workspaceAsV1Body(target));
      }
    } finally {
      this.suspendPersist = false;
    }
    await this.saveAll();
    this.emitChange();
  }

  rename(id: string, name: string): void {
    const ws = this.workspaces.find((w) => w.id === id);
    if (!ws) return;
    ws.name = name.trim() || ws.name;
    void this.saveAll();
    this.emitChange();
  }

  setColor(id: string, color: string | null): void {
    const ws = this.workspaces.find((w) => w.id === id);
    if (!ws) return;
    ws.color = color;
    void this.saveAll();
    this.emitChange();
  }

  setRootDir(id: string, dir: string | null): void {
    const ws = this.workspaces.find((w) => w.id === id);
    if (!ws) return;
    ws.root_dir = dir;
    void this.saveAll();
    this.emitChange();
  }

  /// Move a group (and every tab belonging to it) from the active
  /// workspace into the target workspace. The group's PTYs in the
  /// active workspace are killed — PTYs don't survive the boundary;
  /// the target workspace will respawn them next time it becomes
  /// active. If the move empties the active workspace, a fresh tab
  /// is spawned so we never sit on a workspace with zero tabs.
  async moveGroupTo(groupId: string, targetWorkspaceId: string): Promise<void> {
    if (targetWorkspaceId === this.activeId) return;
    const target = this.workspaces.find((w) => w.id === targetWorkspaceId);
    if (!target) return;
    const snapshot = this.tabManager.snapshotGroupForMove(groupId);
    if (!snapshot) return;

    // Append into the target workspace's persisted body. Tabs keep their
    // original group_id since the group ulid travels with them.
    target.groups.push(snapshot.group);
    for (const t of snapshot.tabs) target.tabs.push(t);
    target.last_used_at = nowMs();

    // Tear down in the active workspace (kills PTYs, removes group).
    this.tabManager.removeGroupAndTabs(groupId);

    // If the active workspace has no tabs left, spawn one so we
    // don't sit on an empty workspace.
    if (this.tabManager.activeSessionId() === null) {
      await this.tabManager.createTab();
    }

    await this.saveAll();
    this.emitChange();
  }

  async delete(id: string): Promise<void> {
    if (this.workspaces.length <= 1) {
      // Refuse: at least one workspace must always exist.
      return;
    }
    const idx = this.workspaces.findIndex((w) => w.id === id);
    if (idx < 0) return;
    if (id === this.activeId) {
      // Switch to most-recently-used other workspace first.
      const next = this.workspaces
        .filter((w) => w.id !== id)
        .sort((a, b) => b.last_used_at - a.last_used_at)[0];
      if (next) {
        await this.switchTo(next.id);
      }
    }
    const realIdx = this.workspaces.findIndex((w) => w.id === id);
    if (realIdx >= 0) this.workspaces.splice(realIdx, 1);
    await this.saveAll();
    this.emitChange();
  }

  duplicate(id: string): string {
    const src = this.workspaces.find((w) => w.id === id);
    if (!src) return "";
    const copy: Workspace = JSON.parse(JSON.stringify(src));
    copy.id = newId();
    copy.name = `${src.name} (copy)`;
    copy.created_at = nowMs();
    copy.last_used_at = nowMs();
    this.workspaces.push(copy);
    void this.saveAll();
    this.emitChange();
    return copy.id;
  }

  /// Replace the currently-active workspace's body from an imported V1
  /// manifest. Used by the settings import path.
  async importIntoActive(m: TabManifestV1): Promise<void> {
    this.suspendPersist = true;
    try {
      await this.tabManager.replaceFromManifest(m);
    } finally {
      this.suspendPersist = false;
    }
    await this.saveAll();
    this.emitChange();
  }

  /// Export the currently-active workspace as a V1 manifest (the same
  /// shape the old export used). Keeps round-tripping with existing
  /// users' exported JSON files lossless.
  exportActive(): TabManifestV1 {
    return this.tabManager.serializeManifest();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emitChange(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("workspace listener threw", err);
      }
    }
  }
}
