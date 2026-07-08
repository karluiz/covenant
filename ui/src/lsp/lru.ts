// Pure LRU + idle-shutdown policy for live LSP servers. Deliberately
// clock-free (every method takes `now` as a parameter, never calls
// Date.now()/Math.random() itself) so it stays unit-testable with a
// fake clock and matches the deterministic-render constraint used
// elsewhere in this codebase. The caller (LspManager) is the one
// allowed to read the real clock.
export interface LruIdlePolicyOpts {
  cap: number;
  idleMs: number;
  stop: (id: number) => void;
}

export class LruIdlePolicy {
  private readonly cap: number;
  private readonly idleMs: number;
  private readonly stop: (id: number) => void;

  // Live server ids in least-recently-used → most-recently-used order.
  // A server stays in this list whether it's currently active (has open
  // docs) or idle (no open docs, not yet swept) — `idleSince` is what
  // distinguishes the two.
  private mru: number[] = [];
  // serverId → timestamp it became idle (absent while active).
  private idleSince = new Map<number, number>();

  constructor(opts: LruIdlePolicyOpts) {
    this.cap = opts.cap;
    this.idleMs = opts.idleMs;
    this.stop = opts.stop;
  }

  /// Mark `id` as used just now: becomes most-recently-used and, if it
  /// was idle, becomes active again. May evict the LRU idle server if
  /// this pushes the live count over `cap`.
  touch(id: number, now: number): void {
    this.idleSince.delete(id);
    const i = this.mru.indexOf(id);
    if (i !== -1) this.mru.splice(i, 1);
    this.mru.push(id);
    this.evictIfOverCap(now);
  }

  private evictIfOverCap(_now: number): void {
    if (this.mru.length <= this.cap) return;
    for (let i = 0; i < this.mru.length; i++) {
      const id = this.mru[i];
      if (this.idleSince.has(id)) {
        this.mru.splice(i, 1);
        this.idleSince.delete(id);
        this.stop(id);
        return;
      }
    }
    // ponytail: cap is soft when all servers have open docs; a hard cap
    // would kill an in-use server.
  }

  /// `id`'s last open doc just closed — it becomes idle as of `now`.
  release(id: number, now: number): void {
    if (this.mru.includes(id)) this.idleSince.set(id, now);
  }

  /// Stop every server that's been idle longer than `idleMs`.
  sweep(now: number): void {
    for (const [id, since] of [...this.idleSince]) {
      if (now - since <= this.idleMs) continue;
      this.idleSince.delete(id);
      const i = this.mru.indexOf(id);
      if (i !== -1) this.mru.splice(i, 1);
      this.stop(id);
    }
  }

  /// `id` is gone (e.g. dropped by the manager already) — forget it.
  remove(id: number): void {
    this.idleSince.delete(id);
    const i = this.mru.indexOf(id);
    if (i !== -1) this.mru.splice(i, 1);
  }
}
