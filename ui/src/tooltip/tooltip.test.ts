import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { attachTooltip } from "./tooltip";

function mockRect(el: HTMLElement, r: { left: number; top: number; width: number; height: number }): void {
  el.getBoundingClientRect = () =>
    ({
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      right: r.left + r.width,
      bottom: r.top + r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function pointerAt(x: number, y: number): void {
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
}

function tooltipHost(): HTMLElement | null {
  return document.querySelector(".ck-tooltip");
}

describe("attachTooltip stuck-tooltip watchdog", () => {
  let target: HTMLElement;
  let detach: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    target = document.createElement("div");
    document.body.appendChild(target);
    mockRect(target, { left: 100, top: 100, width: 20, height: 20 });
    detach = attachTooltip(target, "hello");
  });

  afterEach(() => {
    detach();
    target.remove();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  function openTooltip(): void {
    pointerAt(110, 110);
    target.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(350);
    expect(tooltipHost()?.classList.contains("is-visible")).toBe(true);
  }

  test("stays visible while the pointer remains over the target", () => {
    openTooltip();
    vi.advanceTimersByTime(500);
    expect(tooltipHost()?.classList.contains("is-visible")).toBe(true);
  });

  test("hides when the target scrolls out from under a stationary cursor", () => {
    openTooltip();
    // Scroll moves the element away; no mouse event fires (cursor is still).
    mockRect(target, { left: 100, top: 400, width: 20, height: 20 });
    vi.advanceTimersByTime(100); // a few rAF ticks
    expect(tooltipHost()?.classList.contains("is-visible")).toBe(false);
  });

  test("hides when WebKit drops the mouseleave (pointer left, no event)", () => {
    openTooltip();
    pointerAt(500, 500);
    vi.advanceTimersByTime(100);
    expect(tooltipHost()?.classList.contains("is-visible")).toBe(false);
  });

  test("survives a sweep to an adjacent tooltip target (open timer in flight)", () => {
    openTooltip();
    const next = document.createElement("div");
    mockRect(next, { left: 130, top: 100, width: 20, height: 20 });
    document.body.appendChild(next);
    const detachNext = attachTooltip(next, "next");

    pointerAt(140, 110);
    target.dispatchEvent(new MouseEvent("mouseleave"));
    next.dispatchEvent(new MouseEvent("mouseenter"));
    // While the next tooltip's open timer is pending, the old one keeps
    // showing — the hover machinery owns the transition, not the watchdog.
    vi.advanceTimersByTime(200);
    expect(tooltipHost()?.classList.contains("is-visible")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(tooltipHost()?.textContent).toContain("next");

    detachNext();
    next.remove();
  });

  test("stays visible when opened with stale-outside coords (titlebar drag region)", () => {
    // macOS suppresses mousemove over a -webkit-app-region: drag ancestor, so
    // lastMouse is stale-outside the icon when mouseenter opens the tooltip.
    // The rect-watch must stay disarmed instead of hiding on the first frame.
    pointerAt(500, 500); // last known position, nowhere near the target
    target.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(350);
    expect(tooltipHost()?.classList.contains("is-visible")).toBe(true);
    vi.advanceTimersByTime(300); // several rAF ticks — must not self-hide
    expect(tooltipHost()?.classList.contains("is-visible")).toBe(true);
  });

  test("still hides when the target detaches from the DOM", () => {
    openTooltip();
    target.remove();
    vi.advanceTimersByTime(100);
    expect(tooltipHost()?.classList.contains("is-visible")).toBe(false);
  });
});
