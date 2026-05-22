import { ActivityTracker, type ActivityState } from "./activity";

/// Minimal surface area of a real TabManager that LivePool consumes.
/// Lets tests stub it without DOM/Tauri dependencies.
export interface PoolableTabManager {
  detach(): void;
  attach(tabbarParent: HTMLElement, workspaceParent: HTMLElement): void;
  dispose(): Promise<void>;
  serializeScrollback(): Map<string, string>;
  restoreScrollback(snapshots: Map<string, string>): void;
  serializeManifest(): unknown;
  replaceFromManifest(m: unknown, opts?: { silent?: boolean }): Promise<void>;
  onBlockFinished(cb: (ev: { tabId: string; exitCode: number }) => void): () => void;
}

export interface TabManagerFactory {
  create(workspaceId: string): PoolableTabManager;
  hosts(workspaceId: string): { tabbar: HTMLElement; workspace: HTMLElement };
}

interface LiveEntry {
  manager: PoolableTabManager;
  tracker: ActivityTracker;
  unsubscribeBlocks: () => void;
  unsubscribeActivity: () => void;
}

interface HibernatedEntry {
  scrollback: Map<string, string>;
  lastActivity: ActivityState;
}

/// Owns one TabManager per live workspace plus a Map of hibernated
/// scrollback snapshots. Enforces an LRU limit on live workspaces.
export class LivePool {
  private live = new Map<string, LiveEntry>();
  private hibernated = new Map<string, HibernatedEntry>();
  /// Most-recently-active at head.
  private lru: string[] = [];
  private liveLimit: number;
  private activeId: string | null = null;
  private activityListeners = new Set<(id: string, state: ActivityState) => void>();

  constructor(
    private readonly factory: TabManagerFactory,
    opts: { liveLimit?: number } = {},
  ) {
    this.liveLimit = clampLimit(opts.liveLimit ?? 5);
  }

  get size(): number {
    return this.live.size;
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  isHibernated(id: string): boolean {
    return this.hibernated.has(id);
  }

  active(): PoolableTabManager | null {
    if (!this.activeId) return null;
    return this.live.get(this.activeId)?.manager ?? null;
  }

  activityOf(id: string): ActivityState | null {
    const live = this.live.get(id);
    if (live) return live.tracker.state;
    const hib = this.hibernated.get(id);
    if (hib) return hib.lastActivity;
    return null;
  }

  /// Fires whenever any tracked workspace's activity state changes.
  /// Used by the switcher to re-render chip badges.
  onActivityChange(cb: (workspaceId: string, state: ActivityState) => void): () => void {
    this.activityListeners.add(cb);
    return () => { this.activityListeners.delete(cb); };
  }

  async setLimit(n: number): Promise<void> {
    this.liveLimit = clampLimit(n);
    await this.enforceLimit();
  }

  /// Register a pre-existing TabManager as a live entry. Used by main.ts
  /// at boot: the initial TabManager is constructed eagerly (so chips,
  /// spawn UI, etc. have something to read from before workspaces hydrate)
  /// and then adopted into the pool as the first active entry. After
  /// adoption, the pool owns its detach/attach/dispose lifecycle the
  /// same as any factory-created manager.
  adopt(id: string, manager: PoolableTabManager): void {
    if (this.live.has(id)) {
      throw new Error(`LivePool.adopt: id ${id} already live`);
    }
    const tracker = new ActivityTracker();
    const unsubscribeBlocks = manager.onBlockFinished((ev) => {
      if (this.activeId !== id) tracker.recordBlock({ exitCode: ev.exitCode });
    });
    const unsubscribeActivity = tracker.onChange((s) => {
      for (const l of this.activityListeners) l(id, s);
    });
    this.live.set(id, { manager, tracker, unsubscribeBlocks, unsubscribeActivity });
    this.touch(id);
    this.activeId = id;
  }

  async activate(id: string, manifest: unknown): Promise<PoolableTabManager> {
    if (this.activeId === id && this.live.has(id)) {
      return this.live.get(id)!.manager;
    }

    // Detach the outgoing manager (do NOT dispose it).
    if (this.activeId && this.live.has(this.activeId)) {
      this.live.get(this.activeId)!.manager.detach();
    }

    if (this.live.has(id)) {
      // Warm path: already live.
      this.touch(id);
      const entry = this.live.get(id)!;
      const hosts = this.factory.hosts(id);
      entry.manager.attach(hosts.tabbar, hosts.workspace);
      entry.tracker.reset();
      this.activeId = id;
      return entry.manager;
    }

    // Cold path: hibernated or never seen. Make room first.
    // Set activeId to the incoming id before enforcing so the previous active
    // workspace is eligible for LRU eviction when the pool is full.
    const prevActiveId = this.activeId;
    this.activeId = id;
    await this.enforceLimit(/*incoming=*/ 1);
    const manager = this.factory.create(id);
    try {
      await manager.replaceFromManifest(manifest);
    } catch (err) {
      // Roll back: leave the pool in a consistent state if spawn fails.
      await manager.dispose().catch(() => {});
      this.activeId = prevActiveId;
      throw err;
    }
    const hibern = this.hibernated.get(id);
    if (hibern) {
      manager.restoreScrollback(hibern.scrollback);
      this.hibernated.delete(id);
    }
    const tracker = new ActivityTracker();
    const unsubscribeBlocks = manager.onBlockFinished((ev) => {
      if (this.activeId !== id) tracker.recordBlock({ exitCode: ev.exitCode });
    });
    const unsubscribeActivity = tracker.onChange((s) => {
      for (const l of this.activityListeners) l(id, s);
    });
    this.live.set(id, { manager, tracker, unsubscribeBlocks, unsubscribeActivity });
    this.touch(id);
    return manager;
  }

  recordAgentNote(id: string): void {
    const entry = this.live.get(id);
    if (entry && this.activeId !== id) entry.tracker.recordAgentNote();
  }

  async hibernate(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (!entry) return;
    if (this.activeId === id) {
      throw new Error("cannot hibernate active workspace");
    }
    const scrollback = entry.manager.serializeScrollback();
    const lastActivity = { ...entry.tracker.state };
    entry.unsubscribeBlocks();
    entry.unsubscribeActivity();
    await entry.manager.dispose();
    this.live.delete(id);
    this.lru = this.lru.filter((x) => x !== id);
    this.hibernated.set(id, { scrollback, lastActivity });
  }

  /// Forget a workspace entirely (user deleted it). Drops it from
  /// both live and hibernated pools.
  async forget(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (entry) {
      entry.unsubscribeBlocks();
      entry.unsubscribeActivity();
      await entry.manager.dispose();
      this.live.delete(id);
    }
    this.hibernated.delete(id);
    this.lru = this.lru.filter((x) => x !== id);
    if (this.activeId === id) this.activeId = null;
  }

  private touch(id: string): void {
    this.lru = [id, ...this.lru.filter((x) => x !== id)];
  }

  private async enforceLimit(incoming = 0): Promise<void> {
    while (this.live.size + incoming > this.liveLimit) {
      // Evict the least-recently-used non-active live workspace.
      const victim = [...this.lru].reverse().find(
        (x) => x !== this.activeId && this.live.has(x),
      );
      if (!victim) break;
      await this.hibernate(victim);
    }
  }
}

function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return 5;
  return Math.max(1, Math.min(20, Math.floor(n)));
}
