// Workspaces: top-level container above Groups → Tabs.
//
// A Workspace owns the same body as the legacy TabManifestV1 (active_index,
// tabs[], groups[]) plus user-facing metadata (name, color, optional rootDir).
// Multiple workspaces can exist simultaneously; only one is "active" at a
// time. Switching workspaces hibernates the outgoing one (its PTYs are
// killed) and respawns the incoming one from its manifest. Persisted as a
// V2 envelope so the existing single-manifest file remains a single file.

import { tabManifestSave } from "../api";
import { scheduleCloudPush } from "../settings/cloud_push";
import { TabManager, cwdBasename, type TabManifestV1 } from "../tabs/manager";
import type { TabRow } from "./finder";

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

// Arc-style workspace-switch slide. The overlay is a full-bleed card wearing
// the destination space's identity colour; it springs in to cover, the tab
// rebuild runs underneath, then it springs off the far side to reveal.
const COVER_EASE = "cubic-bezier(.4,0,.2,1)"; // decelerate, no overshoot — stays opaque
const REVEAL_EASE = "cubic-bezier(.32,1.06,.34,1)"; // snappy spring, slight overshoot

// Deterministic hue [0,360) from a workspace id, so each space keeps a
// stable identity colour with zero new UI or persistence.
function spaceHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

// Slide a group of panels through one WAAPI leg in lockstep, then commit the
// end state to inline style (and cancel, so a leftover forwards-fill can't
// override the next leg or the next switch).
async function slidePanels(
  els: HTMLElement[],
  frames: Keyframe[],
  duration: number,
  easing: string,
): Promise<void> {
  const anims = els.map((el) => el.animate(frames, { duration, easing, fill: "forwards" }));
  await Promise.all(anims.map((a) => a.finished));
  for (const a of anims) {
    try {
      a.commitStyles();
    } finally {
      a.cancel();
    }
  }
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
  /// Groups moved into a *hibernated* workspace this session. The move
  /// writes them into the target's persisted body (durable across
  /// restart), but `unhibernate` rebuilds from the in-memory stash and
  /// would otherwise never see them. We replay them after unhibernate.
  /// ponytail: in-session bridge only; persisted body is the durable copy.
  private pendingMoves: Map<string, TabManifestV1> = new Map();

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
        await this.tabManager.replaceFromManifest(workspaceAsV1Body(active), { silent: true });
        // replaceFromManifest with zero tabs leaves us empty; createTab.
        if (this.tabManager.activeSessionId() === null) {
          await this.tabManager.createTab();
        }
      } else {
        await this.tabManager.replaceFromManifest(workspaceAsV1Body(active), { silent: true });
      }
      this.tabManager.setActiveWorkspaceName(active.name);
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

  /// Public read-only accessor for the active workspace id. The finder
  /// needs it to decide whether selecting a row requires a workspace
  /// switch first.
  activeId_(): string {
    return this.activeId;
  }

  /// Flatten every workspace's tabs into a single TabRow list for the
  /// global finder. The active workspace contributes live titles via
  /// `TabManager.snapshotForFinder()`; inactive workspaces read from
  /// their persisted manifest body. Order: workspace-list order, then
  /// tabIndex within each workspace.
  listAllTabs(): TabRow[] {
    const rows: TabRow[] = [];
    for (const w of this.workspaces) {
      const isActiveWs = w.id === this.activeId;
      const groupById = new Map(w.groups.map((g) => [g.id, g]));
      if (isActiveWs) {
        const snap = this.tabManager.snapshotForFinder();
        for (const t of snap) {
          const g = t.groupId ? groupById.get(t.groupId) : null;
          rows.push({
            workspaceId: w.id,
            workspaceName: w.name,
            workspaceColor: w.color,
            workspaceActive: true,
            groupId: t.groupId,
            groupName: g?.name ?? null,
            groupColor: g?.color ?? null,
            tabIndex: t.index,
            title: t.title,
            isActiveTabInWorkspace: t.isActive,
            lastActiveAt: t.lastActiveAt,
          });
        }
      } else {
        w.tabs.forEach((t, i) => {
          const g = t.group_id ? groupById.get(t.group_id) : null;
          rows.push({
            workspaceId: w.id,
            workspaceName: w.name,
            workspaceColor: w.color,
            workspaceActive: false,
            groupId: t.group_id ?? null,
            groupName: g?.name ?? null,
            groupColor: g?.color ?? null,
            tabIndex: i,
            // Background workspaces don't have live TabManager state, so read
            // the persisted title: custom_name → default_title (the live
            // screen title captured at save) → cwd basename for pre-
            // default_title manifests. Never a meaningless "Tab N".
            title: t.custom_name ?? t.default_title ?? cwdBasename(t.cwd),
            isActiveTabInWorkspace: i === w.active_index,
            // ponytail: no per-tab timestamp persisted, so a background
            // workspace's MRU signal is the tab it was left on, dated by
            // when that workspace was last used. Recent thus mixes one row
            // per other workspace. Add a per-tab last_active_at to
            // SerializedTab if true cross-workspace per-tab MRU is needed.
            lastActiveAt: i === w.active_index ? w.last_used_at : null,
          });
        });
      }
    }
    return rows;
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
    scheduleCloudPush();
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

    // Snapshot current state into the outgoing workspace so a cold restart
    // restores the at-switch shape. Runtime state for the outgoing tabs
    // continues to live on their Tab objects while they're hibernated.
    const outgoingId = this.activeId;
    const out = this.getActive();
    const body = this.tabManager.serializeManifest();
    out.active_index = body.active_index;
    out.tabs = body.tabs;
    out.groups = body.groups;

    this.suspendPersist = true;

    // Arc-style directional slide: the real content column (tab strip +
    // terminal + status bar) slides OUT toward the current side, the tab
    // rebuild runs while it's off-screen, then the fresh column slides IN
    // from the destination side. The gap behind it wears the destination
    // space's auto-derived identity colour. Direction follows the
    // workspaces' order; xterm is a <canvas> we can't clone, so we move the
    // live element itself rather than a snapshot.
    const fromIdx = this.workspaces.findIndex((w) => w.id === outgoingId);
    const toIdx = this.workspaces.findIndex((w) => w.id === id);
    const dir = Math.sign(toIdx - fromIdx) || 1;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const layout = document.getElementById("layout");
    const panels = ["tabbar-host", "workspace", "status-bar"]
      .map((pid) => document.getElementById(pid))
      .filter((el): el is HTMLElement => !!el && !el.hidden);

    // Tint the gap the sliding column reveals with the destination colour.
    const hue = spaceHue(target.id);
    const tint = `hsl(${hue} 72% 66%)`;
    if (layout && !reduce) {
      layout.style.overflow = "hidden";
      layout.style.background =
        `radial-gradient(52% 62% at 82% 0%, color-mix(in srgb, ${tint} 34%, transparent), transparent 70%),` +
        `radial-gradient(54% 60% at 8% 100%, color-mix(in srgb, ${tint} 24%, transparent), transparent 66%),` +
        `var(--bg)`;
    }

    // Resolves once the tab the user lands on is live — the rest of the
    // workspace keeps spawning behind the reveal. On a cold workspace that
    // is ~1.3s instead of ~5.5s (concurrent `zsh -i` contend), and the gap
    // was pure black screen: the reveal used to wait for the last PTY.
    let activeReady = (): void => {};
    const activeTabLive = new Promise<void>((resolve) => (activeReady = resolve));

    const doRebuild = async (): Promise<void> => {
      // Detach outgoing tabs without killing PTYs.
      this.tabManager.hibernate(outgoingId);
      this.activeId = id;
      this.tabManager.setActiveWorkspaceName(target.name);
      target.last_used_at = nowMs();

      // If we already hibernated this workspace earlier in the session,
      // restore the live Tab objects — PTYs survived the switch.
      if (this.tabManager.unhibernate(id)) {
        // Restored from the in-memory stash — PTYs survived. Replay any
        // groups moved here while it was hibernated; restoreFromManifest
        // appends them to the live tabs without tearing the rest down.
        const pending = this.pendingMoves.get(id);
        if (pending) {
          this.pendingMoves.delete(id);
          await this.tabManager.restoreFromManifest(pending);
        }
        // Live tabs are already back on screen — nothing to wait for.
        activeReady();
      } else {
        // First time visiting this workspace this session: spawn from manifest.
        await this.tabManager.restoreFromManifest(workspaceAsV1Body(target), activeReady);
        if (this.tabManager.activeSessionId() === null) {
          await this.tabManager.createTab();
        }
      }
      // Belt and braces: a restore that spawned nothing must not strand the
      // reveal behind a promise nobody resolves.
      activeReady();
    };

    // Kick the rebuild off now so the PTYs spawn *during* the cover leg
    // instead of after it. It is awaited in full before this method returns
    // (see below) — only the reveal runs early.
    const rebuild = doRebuild();
    try {
      if (reduce || panels.length === 0) {
        await rebuild;
      } else {
        // OUT: live outgoing column slides off toward -dir.
        await slidePanels(
          panels,
          [{ transform: "translateX(0)" }, { transform: `translateX(${-dir * 100}%)` }],
          260,
          COVER_EASE,
        );
        // Wait for the tab the user will look at — not for every PTY. A
        // rebuild that throws rejects `rebuild`, so race against it too
        // rather than hanging off-screen forever.
        await Promise.race([activeTabLive, rebuild]);
        // IN: fresh column springs in from the destination side (+dir).
        await slidePanels(
          panels,
          [
            { transform: `translateX(${dir * 100}%)`, opacity: 0.85 },
            { transform: "translateX(0)", opacity: 1 },
          ],
          340,
          REVEAL_EASE,
        );
        // The remaining tabs hydrate while the column is already on screen,
        // but saveAll (below) rebuilds this workspace's body from the live
        // TabManager — persisting a half-spawned set would drop the tabs
        // still in flight. So the method still ends with the full restore.
        await rebuild;
      }
    } finally {
      for (const el of panels) {
        el.style.transform = "";
        el.style.opacity = "";
      }
      if (layout) {
        layout.style.overflow = "";
        layout.style.background = "";
      }
      this.suspendPersist = false;
    }
    await this.saveAll();
    this.emitChange();
  }

  rename(id: string, name: string): void {
    const ws = this.workspaces.find((w) => w.id === id);
    if (!ws) return;
    ws.name = name.trim() || ws.name;
    if (id === this.activeId) this.tabManager.setActiveWorkspaceName(ws.name);
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

    // If the target was visited this session its live state lives in the
    // TabManager hibernation stash, which unhibernate restores instead of
    // the persisted body above — so the moved group would vanish on switch.
    // Queue it to be replayed after unhibernate.
    if (this.tabManager.hasHibernated(targetWorkspaceId)) {
      const queued = this.pendingMoves.get(targetWorkspaceId);
      if (queued) {
        queued.groups.push(snapshot.group);
        for (const t of snapshot.tabs) queued.tabs.push(t);
      } else {
        this.pendingMoves.set(targetWorkspaceId, {
          version: 1,
          active_index: 0,
          groups: [snapshot.group],
          tabs: [...snapshot.tabs],
        });
      }
    }

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
    // If this workspace had been visited this session, its tabs are
    // hibernated in memory — close their PTYs now that the workspace
    // is gone for good.
    this.tabManager.disposeHibernated(id);
    this.pendingMoves.delete(id);
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
