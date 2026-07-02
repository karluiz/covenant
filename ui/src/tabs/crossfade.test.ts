// @vitest-environment jsdom
//
// Tab-switch crossfade choreography: both panes get their marker
// classes for the fade, the outgoing pane is released exactly once
// (animationend, animationcancel, or force-finish — never twice), and
// bubbled child animations can't end the fade early.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { playCrossfade } from "./crossfade";

function mountPanes(): { incoming: HTMLElement; outgoing: HTMLElement } {
  document.body.innerHTML = `
    <div class="tab-pane" id="in"><div class="child"></div></div>
    <div class="tab-pane" id="out"></div>
  `;
  return {
    incoming: document.getElementById("in")!,
    outgoing: document.getElementById("out")!,
  };
}

function fire(target: HTMLElement, type: string, animationName: string): void {
  target.dispatchEvent(
    Object.assign(new Event(type, { bubbles: true }), { animationName }),
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("playCrossfade", () => {
  it("marks both panes, cleans up and runs onDone on animationend", () => {
    const { incoming, outgoing } = mountPanes();
    const onDone = vi.fn();
    playCrossfade(incoming, outgoing, onDone);

    expect(incoming.classList.contains("pane-crosscut")).toBe(true);
    expect(outgoing.classList.contains("pane-crosscut-out")).toBe(true);
    expect(onDone).not.toHaveBeenCalled();

    fire(incoming, "animationend", "pane-crosscut");
    expect(incoming.classList.contains("pane-crosscut")).toBe(false);
    expect(outgoing.classList.contains("pane-crosscut-out")).toBe(false);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("ignores bubbled animationend from child animations", () => {
    const { incoming, outgoing } = mountPanes();
    const onDone = vi.fn();
    playCrossfade(incoming, outgoing, onDone);

    fire(incoming.querySelector<HTMLElement>(".child")!, "animationend", "some-child-anim");
    expect(onDone).not.toHaveBeenCalled();
    expect(incoming.classList.contains("pane-crosscut")).toBe(true);
  });

  it("runs onDone exactly once when force-finished then a stale event lands", () => {
    const { incoming, outgoing } = mountPanes();
    const onDone = vi.fn();
    const finish = playCrossfade(incoming, outgoing, onDone);

    finish(); // next activate() force-finishes
    fire(incoming, "animationend", "pane-crosscut"); // stale event

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(incoming.classList.contains("pane-crosscut")).toBe(false);
    expect(outgoing.classList.contains("pane-crosscut-out")).toBe(false);
  });

  it("completes on animationcancel (pane hidden mid-fade)", () => {
    const { incoming, outgoing } = mountPanes();
    const onDone = vi.fn();
    playCrossfade(incoming, outgoing, onDone);

    fire(incoming, "animationcancel", "pane-crosscut");
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(outgoing.classList.contains("pane-crosscut-out")).toBe(false);
  });
});
