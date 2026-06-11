// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.handlers.set(name, handler);
    return Promise.resolve(() => {
      mocks.handlers.delete(name);
    });
  }),
  disarmAllRemote: vi.fn(() => Promise.resolve()),
  setRemoteAllowOpen: vi.fn(() => Promise.resolve()),
  getRemoteAllowOpen: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("../api", () => ({
  disarmAllRemote: mocks.disarmAllRemote,
  setRemoteAllowOpen: mocks.setRemoteAllowOpen,
  getRemoteAllowOpen: mocks.getRemoteAllowOpen,
}));

vi.mock("../tooltip/tooltip", () => ({
  attachTooltip: vi.fn(),
}));

import { mountRemotePresenceDot } from "./presence-dot";

function mount(): { dot: HTMLElement; pop: HTMLElement } {
  document.body.innerHTML = `
    <header id="app-titlebar">
      <div id="app-titlebar-center">
        <span id="app-titlebar-brand">COVENANT</span>
      </div>
    </header>`;
  mountRemotePresenceDot(document);
  const dot = document.getElementById("rc-presence-dot");
  const pop = document.getElementById("rc-presence-popover");
  if (!dot || !pop) throw new Error("dot or popover not mounted");
  return { dot, pop };
}

function firePresence(count: unknown): void {
  const handler = mocks.handlers.get("rc://web-presence");
  if (!handler) throw new Error("rc://web-presence handler was not registered");
  handler({ payload: count });
}

function hover(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
}

function unhover(el: HTMLElement): void {
  el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
}

const isOpen = (pop: HTMLElement) => pop.classList.contains("rc-presence-popover-open");

beforeEach(() => {
  vi.useFakeTimers();
  mocks.handlers.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("mountRemotePresenceDot", () => {
  it("mounts the dot into the titlebar center, hidden at count 0", () => {
    const { dot } = mount();
    expect(dot.parentElement?.id).toBe("app-titlebar-center");
    expect(dot.style.display).toBe("none");
  });

  it("shows the dot and updates the label when presence arrives", () => {
    const { dot, pop } = mount();
    firePresence(2);
    expect(dot.style.display).not.toBe("none");
    expect(pop.textContent).toContain("remote · 2");
  });

  it("ignores non-numeric payloads (treats as 0)", () => {
    const { dot } = mount();
    firePresence(1);
    firePresence("garbage");
    expect(dot.style.display).toBe("none");
  });

  it("opens the popover on dot hover and closes after the grace timeout", () => {
    const { dot, pop } = mount();
    firePresence(1);
    hover(dot);
    expect(isOpen(pop)).toBe(true);
    unhover(dot);
    expect(isOpen(pop)).toBe(true); // still open during grace
    vi.advanceTimersByTime(250);
    expect(isOpen(pop)).toBe(false);
  });

  it("stays open when the pointer travels into the popover within the grace period", () => {
    const { dot, pop } = mount();
    firePresence(1);
    hover(dot);
    unhover(dot);
    vi.advanceTimersByTime(100);
    hover(pop);
    vi.advanceTimersByTime(500);
    expect(isOpen(pop)).toBe(true);
  });

  it("click pins the popover open across hover-out; second click closes", () => {
    const { dot, pop } = mount();
    firePresence(1);
    hover(dot);
    dot.click();
    unhover(dot);
    vi.advanceTimersByTime(500);
    expect(isOpen(pop)).toBe(true); // pinned
    dot.click();
    expect(isOpen(pop)).toBe(false);
  });

  it("Escape closes a pinned popover", () => {
    const { dot, pop } = mount();
    firePresence(1);
    dot.click();
    expect(isOpen(pop)).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(isOpen(pop)).toBe(false);
  });

  it("pointerdown outside closes a pinned popover", () => {
    const { dot, pop } = mount();
    firePresence(1);
    dot.click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(isOpen(pop)).toBe(false);
  });

  it("hides the dot and closes the popover when count drops to 0", () => {
    const { dot, pop } = mount();
    firePresence(1);
    dot.click();
    firePresence(0);
    expect(dot.style.display).toBe("none");
    expect(isOpen(pop)).toBe(false);
  });

  it("Disable all calls disarmAllRemote", () => {
    const { pop } = mount();
    firePresence(1);
    const kill = pop.querySelector<HTMLButtonElement>(".rc-presence-kill");
    kill?.click();
    expect(mocks.disarmAllRemote).toHaveBeenCalledOnce();
  });

  it("Disable all confirms visually, then closes the popover", async () => {
    const { dot, pop } = mount();
    firePresence(1);
    dot.click(); // pin open
    const kill = pop.querySelector<HTMLButtonElement>(".rc-presence-kill");
    if (!kill) throw new Error("kill button missing");
    kill.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(kill.textContent).toBe("Disarmed ✓");
    expect(kill.disabled).toBe(true);
    expect(kill.classList.contains("rc-presence-kill-done")).toBe(true);
    expect(isOpen(pop)).toBe(true); // confirmation visible before close
    await vi.advanceTimersByTimeAsync(1200);
    expect(isOpen(pop)).toBe(false);
  });

  it("Disable all resets to idle after the confirmation closes", async () => {
    const { dot, pop } = mount();
    firePresence(1);
    dot.click();
    const kill = pop.querySelector<HTMLButtonElement>(".rc-presence-kill");
    if (!kill) throw new Error("kill button missing");
    kill.click();
    await vi.advanceTimersByTimeAsync(1200);
    hover(dot); // reopen
    expect(kill.textContent).toBe("Disable all");
    expect(kill.disabled).toBe(false);
    expect(kill.classList.contains("rc-presence-kill-done")).toBe(false);
  });

  it("Disable all shows a retryable failure state when the command rejects", async () => {
    mocks.disarmAllRemote.mockRejectedValueOnce(new Error("relay down"));
    const { dot, pop } = mount();
    firePresence(1);
    dot.click();
    const kill = pop.querySelector<HTMLButtonElement>(".rc-presence-kill");
    if (!kill) throw new Error("kill button missing");
    kill.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(kill.textContent).toBe("Failed — retry");
    expect(kill.disabled).toBe(false);
    expect(isOpen(pop)).toBe(true); // stays open so the user can retry
    await vi.advanceTimersByTimeAsync(2000);
    expect(isOpen(pop)).toBe(true); // no auto-close on failure
  });

  it("new-tabs checkbox calls setRemoteAllowOpen with its state", () => {
    const { pop } = mount();
    firePresence(1);
    const cb = pop.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (!cb) throw new Error("checkbox missing");
    cb.checked = true;
    cb.dispatchEvent(new Event("change"));
    expect(mocks.setRemoteAllowOpen).toHaveBeenCalledWith(true);
  });

  it("is a no-op when mounted twice", () => {
    mount();
    mountRemotePresenceDot(document);
    expect(document.querySelectorAll("#rc-presence-dot").length).toBe(1);
  });
});
