import { describe, expect, it, vi } from "vitest";
import { LruIdlePolicy } from "./lru";

describe("LruIdlePolicy", () => {
  it("evicts the LRU idle server when a touch would exceed cap", () => {
    const stop = vi.fn();
    const policy = new LruIdlePolicy({ cap: 2, idleMs: 1000, stop });

    policy.touch(1, 0);
    policy.touch(2, 1);
    policy.release(1, 2); // server 1 has no more open docs, goes idle
    policy.touch(3, 3); // 3 live servers > cap(2) → evict LRU idle (1)

    expect(stop).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("does not evict a server that still has open docs, even over cap", () => {
    const stop = vi.fn();
    const policy = new LruIdlePolicy({ cap: 1, idleMs: 1000, stop });

    policy.touch(1, 0);
    policy.touch(2, 1); // both active, over cap but nothing idle to evict

    expect(stop).not.toHaveBeenCalled();
  });

  it("evicts the LEAST recently used idle server, not just any idle one", () => {
    const stop = vi.fn();
    const policy = new LruIdlePolicy({ cap: 2, idleMs: 1000, stop });

    policy.touch(1, 0);
    policy.touch(2, 1);
    policy.release(1, 2);
    policy.release(2, 2);
    // Re-touch 2 so it's more recently used than 1, even though both
    // are idle at release time.
    policy.touch(2, 3);
    policy.touch(3, 4); // over cap → evict LRU idle among {1 (idle), 2 (active)} = 1

    expect(stop).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("sweep stops servers idle longer than idleMs but leaves fresh ones running", () => {
    const stop = vi.fn();
    const policy = new LruIdlePolicy({ cap: 4, idleMs: 100, stop });

    policy.touch(1, 0);
    policy.touch(2, 0);
    policy.release(1, 0); // idle starting at t=0
    policy.release(2, 50); // idle starting at t=50

    policy.sweep(90); // neither exceeds idleMs=100 yet
    expect(stop).not.toHaveBeenCalled();

    policy.sweep(101); // server 1 has been idle 101ms > 100
    expect(stop).toHaveBeenCalledExactlyOnceWith(1);

    policy.sweep(151); // server 2 has now been idle 101ms > 100
    expect(stop).toHaveBeenCalledWith(2);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("touch after release re-marks the server active so sweep leaves it alone", () => {
    const stop = vi.fn();
    const policy = new LruIdlePolicy({ cap: 4, idleMs: 100, stop });

    policy.touch(1, 0);
    policy.release(1, 0);
    policy.touch(1, 10); // active again before idleMs elapses

    policy.sweep(200); // would have been idle 200ms if release had stuck
    expect(stop).not.toHaveBeenCalled();
  });

  it("remove forgets a server so it's neither evicted nor swept", () => {
    const stop = vi.fn();
    const policy = new LruIdlePolicy({ cap: 4, idleMs: 100, stop });

    policy.touch(1, 0);
    policy.release(1, 0);
    policy.remove(1);

    policy.sweep(200);
    expect(stop).not.toHaveBeenCalled();
  });
});
