// @vitest-environment jsdom
//
// Rail slide choreography: collapse must animate OUT first and only
// snap (the grid change) on animationend; expand snaps first, then
// animates IN. Bubbled child animationend events must not end the
// slide early, and a re-toggle mid-slide force-finishes the pending
// snap instead of dropping it.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { slideRail, slideTabbar } from "./rail-slide";

function mountPanel(): HTMLElement {
  document.body.innerHTML = `
    <div class="tab-pane"><div class="tab-blocks"><div class="child"></div></div></div>
  `;
  const panel = document.querySelector<HTMLElement>(".tab-blocks")!;
  // jsdom has no layout — pretend the panel is rendered.
  Object.defineProperty(panel, "offsetWidth", { value: 240 });
  return panel;
}

function animEnd(target: HTMLElement, animationName: string): void {
  target.dispatchEvent(
    Object.assign(new Event("animationend", { bubbles: true }), { animationName }),
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
});

describe("slideRail", () => {
  it("collapse slides out first, snaps on animationend", () => {
    const panel = mountPanel();
    const snap = vi.fn();
    slideRail(true, snap);

    expect(panel.classList.contains("rail-slide-exit")).toBe(true);
    expect(snap).not.toHaveBeenCalled();

    animEnd(panel, "rail-slide-out");
    expect(panel.classList.contains("rail-slide-exit")).toBe(false);
    expect(snap).toHaveBeenCalledTimes(1);
  });

  it("ignores bubbled animationend from child animations", () => {
    const panel = mountPanel();
    const snap = vi.fn();
    slideRail(true, snap);

    animEnd(panel.querySelector<HTMLElement>(".child")!, "some-child-anim");
    expect(panel.classList.contains("rail-slide-exit")).toBe(true);
    expect(snap).not.toHaveBeenCalled();
  });

  it("expand snaps immediately, then slides in", () => {
    const panel = mountPanel();
    const snap = vi.fn();
    slideRail(false, snap);

    expect(snap).toHaveBeenCalledTimes(1);
    expect(panel.classList.contains("rail-slide-enter")).toBe(true);

    animEnd(panel, "rail-slide-in");
    expect(panel.classList.contains("rail-slide-enter")).toBe(false);
  });

  it("re-toggle mid-collapse force-finishes the pending snap", () => {
    const panel = mountPanel();
    const collapseSnap = vi.fn();
    const expandSnap = vi.fn();
    slideRail(true, collapseSnap); // exit anim pending
    slideRail(false, expandSnap); // user expands before animationend

    expect(collapseSnap).toHaveBeenCalledTimes(1);
    expect(expandSnap).toHaveBeenCalledTimes(1);
    expect(panel.classList.contains("rail-slide-exit")).toBe(false);
    expect(panel.classList.contains("rail-slide-enter")).toBe(true);
  });

  it("snaps directly when no panel is rendered", () => {
    document.body.innerHTML = `<div class="tab-pane" hidden><div class="tab-blocks"></div></div>`;
    const snap = vi.fn();
    slideRail(true, snap);
    expect(snap).toHaveBeenCalledTimes(1);
  });
});

describe("slideTabbar", () => {
  function mountTabbar(): HTMLElement {
    document.body.className = "tabbar-left";
    document.body.innerHTML = `<div id="tabbar-host"></div>`;
    const host = document.getElementById("tabbar-host")!;
    Object.defineProperty(host, "offsetWidth", { value: 232 });
    return host;
  }

  it("collapse slides out first, snaps on animationend", () => {
    const host = mountTabbar();
    const snap = vi.fn();
    slideTabbar(true, snap);

    expect(host.classList.contains("tabbar-slide-exit")).toBe(true);
    expect(snap).not.toHaveBeenCalled();

    animEnd(host, "tabbar-slide-out");
    expect(host.classList.contains("tabbar-slide-exit")).toBe(false);
    expect(snap).toHaveBeenCalledTimes(1);
  });

  it("snaps directly in top-tabs mode", () => {
    mountTabbar();
    document.body.className = "";
    const snap = vi.fn();
    slideTabbar(true, snap);
    expect(snap).toHaveBeenCalledTimes(1);
  });

  it("keeps pending state independent from slideRail", () => {
    const tabbar = mountTabbar();
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="tab-pane"><div class="tab-blocks"></div></div>`,
    );
    const rail = document.querySelector<HTMLElement>(".tab-blocks")!;
    Object.defineProperty(rail, "offsetWidth", { value: 240 });

    const railSnap = vi.fn();
    const tabbarSnap = vi.fn();
    slideRail(true, railSnap);
    slideTabbar(true, tabbarSnap); // must NOT force-finish the rail slide

    expect(railSnap).not.toHaveBeenCalled();
    expect(rail.classList.contains("rail-slide-exit")).toBe(true);
    expect(tabbar.classList.contains("tabbar-slide-exit")).toBe(true);
  });
});
