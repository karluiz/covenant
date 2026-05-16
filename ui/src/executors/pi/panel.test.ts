// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn().mockResolvedValue("sid-1"),
  close: vi.fn().mockResolvedValue(undefined),
  subscribe: vi.fn(async () => () => {}),
}));

vi.mock("../../api", () => ({
  spawnPiSession: mocks.spawn,
  closePiSession: mocks.close,
  subscribePiEvents: mocks.subscribe,
  // The view module pulls in these regardless of whether it uses them
  // at runtime; provide no-op stubs so the import doesn't blow up.
  piSendPrompt: vi.fn().mockResolvedValue(undefined),
  piAbort: vi.fn().mockResolvedValue(undefined),
  piSteer: vi.fn().mockResolvedValue(undefined),
  piFollowUp: vi.fn().mockResolvedValue(undefined),
}));

import { PiPanel } from "./panel";

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("PiPanel", () => {
  beforeEach(() => {
    mocks.spawn.mockClear();
    mocks.close.mockClear();
    document.body.innerHTML = "";
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1 as unknown as number;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens, spawns a session, mounts PiChatView", async () => {
    const panel = new PiPanel();
    await panel.open({ cwd: "/tmp" });
    expect(mocks.spawn).toHaveBeenCalledWith({
      cwd: "/tmp",
      provider: undefined,
      model: undefined,
    });
    expect(document.querySelector(".pi-panel-overlay")).toBeTruthy();
    // PiChatView applies its class to the host element it's given.
    expect(document.querySelector(".pi-panel-body.pi-chat-view")).toBeTruthy();
    expect(document.querySelector(".pi-chat-textarea")).toBeTruthy();
    expect(panel.isOpen()).toBe(true);
  });

  it("parallel open() calls don't double-spawn", async () => {
    const panel = new PiPanel();
    const a = panel.open();
    const b = panel.open();
    await Promise.all([a, b]);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it("close() tears down DOM and calls closePiSession", async () => {
    const panel = new PiPanel();
    await panel.open();
    await flush();
    await panel.close();
    await flush();
    // Allow setTimeout(150) cleanup to run.
    await new Promise((r) => setTimeout(r, 200));
    expect(document.querySelector(".pi-panel-overlay")).toBeNull();
    expect(mocks.close).toHaveBeenCalledWith("sid-1");
  });

  it("toggle() opens when closed, closes when open", async () => {
    const panel = new PiPanel();
    await panel.toggle();
    expect(panel.isOpen()).toBe(true);
    await panel.toggle();
    await new Promise((r) => setTimeout(r, 200));
    expect(document.querySelector(".pi-panel-overlay")).toBeNull();
  });

  it("surfaces spawn errors instead of mounting the view", async () => {
    mocks.spawn.mockRejectedValueOnce(new Error("pi not installed"));
    const panel = new PiPanel();
    await panel.open();
    const status = document.querySelector(".pi-panel-spawn-status");
    expect(status?.textContent).toMatch(/Could not start Pi/);
    expect(status?.getAttribute("data-kind")).toBe("error");
    expect(document.querySelector(".pi-chat-view")).toBeNull();
  });
});
