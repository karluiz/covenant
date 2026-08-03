import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRenderHeartbeat } from "./render-heartbeat";

describe("startRenderHeartbeat", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("mounts an invisible 1px composited element and flips its transform each tick", () => {
    const stop = startRenderHeartbeat(1000);
    const el = document.body.lastElementChild as HTMLElement;
    expect(el.style.width).toBe("1px");
    expect(el.style.pointerEvents).toBe("none");
    const before = el.style.transform;
    vi.advanceTimersByTime(1000);
    expect(el.style.transform).not.toBe(before);
    vi.advanceTimersByTime(1000);
    expect(el.style.transform).toBe(before);
    stop();
  });

  it("stop() removes the element and the timer", () => {
    const stop = startRenderHeartbeat(1000);
    const el = document.body.lastElementChild as HTMLElement;
    stop();
    expect(el.isConnected).toBe(false);
    const t = el.style.transform;
    vi.advanceTimersByTime(3000);
    expect(el.style.transform).toBe(t);
  });
});
