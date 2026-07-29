import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { attachTooltip, computeTooltipPos } from "./tooltip";

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

describe("computeTooltipPos", () => {
  const rect = (left: number, top: number, w: number, h: number) => ({
    left,
    top,
    width: w,
    bottom: top + h,
  });

  test("centers above the target at zoom 1", () => {
    const p = computeTooltipPos(rect(500, 300, 40, 20), 100, 30, 1200, 800);
    expect(p.below).toBe(false);
    expect(p.left).toBe(500 + 20 - 50); // target center minus half tooltip
    expect(p.top).toBe(300 - 30 - 8);
  });

  test("flips below when there is no room above", () => {
    const p = computeTooltipPos(rect(500, 10, 40, 20), 100, 30, 1200, 800);
    expect(p.below).toBe(true);
    expect(p.top).toBe(30 + 8);
  });

  test("clamps to the right edge at zoom 1", () => {
    const p = computeTooltipPos(rect(1180, 300, 20, 20), 120, 30, 1200, 800);
    expect(p.left + 120).toBeLessThanOrEqual(1200 - 8);
  });

  test("keeps an oversized tooltip inside the viewport on the right", () => {
    // Right-rail anchor + tip wider than remaining space: prefer the
    // right clamp, then re-clamp left so we never go negative.
    const p = computeTooltipPos(rect(1100, 300, 40, 20), 340, 60, 1200, 800);
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + 340).toBeLessThanOrEqual(1200 - 8);
  });

  test("stays glued to a bottom status-bar badge", () => {
    // Native page zoom keeps rects and the viewport in one CSS-px space,
    // so the tooltip sits directly on the badge at any zoom level.
    const p = computeTooltipPos(rect(700, 880, 60, 24), 200, 30, 1000, 1000);
    expect(p.below).toBe(false);
    expect(p.top).toBe(880 - 30 - 8); // directly above the badge, layout px
    expect(p.left).toBe(700 + 30 - 100); // centered on the badge
  });
});

describe("computeTooltipPos — right placement", () => {
  // A sidebar anchor: 11px eye glyph near the left edge, viewport 1400×900.
  const eye = { top: 300, bottom: 311, left: 120, width: 11 };

  test("sits beside the anchor, vertically centred on it", () => {
    const p = computeTooltipPos(eye, 300, 120, 1400, 900, "right");
    expect(p.left).toBe(139); // 120 + 11 + 8
    expect(p.top).toBe(245.5); // centre 305.5 − 120/2
    expect(p.below).toBe(false);
  });

  test("flips to the left side when the right edge is too close", () => {
    const nearRight = { top: 300, bottom: 311, left: 1300, width: 11 };
    const p = computeTooltipPos(nearRight, 300, 120, 1400, 900, "right");
    expect(p.left).toBe(992); // 1300 − 8 − 300
  });

  test("falls back to above/below when neither side fits", () => {
    const p = computeTooltipPos(eye, 1300, 120, 1400, 900, "right");
    expect(p.left).toBe(8); // clamped by the auto path, not placed beside
  });

  test("a tall tip on the FIRST group aligns its top to the row, not to the viewport", () => {
    // The real geometry the dev build reported: eye 58px from the top,
    // 146px-tall tip. Centring puts it at −10, so it used to slam to 8 and
    // the title sat 18px above the row it described.
    const firstGroup = { top: 58, bottom: 69, left: 120, width: 11 };
    const p = computeTooltipPos(firstGroup, 340, 146, 1400, 900, "right");
    expect(p.top).toBe(52); // 58 − 6, title level with the eye
    expect(p.top).toBeGreaterThan(8);
  });

  test("still clamps when even the aligned edge won't fit", () => {
    const veryTop = { top: 10, bottom: 21, left: 120, width: 11 };
    const p = computeTooltipPos(veryTop, 340, 146, 1400, 900, "right");
    expect(p.top).toBe(8);
  });

  test("a tall tip on the LAST row aligns its bottom to the row", () => {
    const lastRow = { top: 840, bottom: 851, left: 120, width: 11 };
    const p = computeTooltipPos(lastRow, 340, 146, 1400, 900, "right");
    expect(p.top).toBe(711); // 851 + 6 − 146, bottom level with the eye
  });

  test("clamps to the viewport instead of running off the bottom", () => {
    const low = { top: 880, bottom: 891, left: 120, width: 11 };
    const p = computeTooltipPos(low, 300, 120, 1400, 900, "right");
    expect(p.top).toBe(772); // 900 − 8 − 120
  });

  test("leaves auto placement untouched", () => {
    const p = computeTooltipPos(eye, 300, 120, 1400, 900);
    expect(p.top).toBe(172); // above: 300 − 120 − 8
  });
});
