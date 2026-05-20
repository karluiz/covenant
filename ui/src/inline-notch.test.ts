// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.handlers.set(name, handler);
    return Promise.resolve(() => {
      mocks.handlers.delete(name);
    });
  }),
  invoke: vi.fn(() => Promise.resolve({})),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: mocks.listen,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("./tooltip/tooltip", () => ({
  attachTooltip: vi.fn(),
}));

import { mountInlineNotch } from "./inline-notch";

function mount(): HTMLElement {
  document.body.innerHTML = `<aside id="activity-sidebar"></aside>`;
  const host = document.getElementById("activity-sidebar")!;
  mountInlineNotch(host);
  return host;
}

function fireNotchState(payload: unknown): void {
  const handler = mocks.handlers.get("notch:state");
  if (!handler) throw new Error("notch:state handler was not registered");
  handler({ payload });
}

describe("mountInlineNotch", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    mocks.handlers.clear();
    mocks.listen.mockClear();
    mocks.invoke.mockClear();
  });

  it("shows the active Pi tab as idle before any phase event arrives", () => {
    const host = mount();

    window.dispatchEvent(
      new CustomEvent("ui:active-session", {
        detail: {
          session_id: "01J00000000000000000000000",
          agent: "pi",
          tab_label: "COVENANT › pi 1",
        },
      }),
    );

    expect(host.querySelector(".inline-notch-name")?.textContent).toContain("Pi");
    expect(host.querySelector(".inline-notch-name")?.textContent).toContain("COVENANT › pi 1");
    expect(host.querySelector(".inline-notch-sub")?.textContent).toContain("idle");
  });

  it("tracks Pi notch state events in the activity stream", () => {
    const host = mount();

    fireNotchState({
      kind: "executor_state_changed",
      session: "01J00000000000000000000000",
      agent: "pi",
      tab_label: "pi 1",
      phase: { kind: "thinking" },
    });

    expect(host.querySelector(".inline-notch-name")?.textContent).toContain("Pi");
    expect(host.querySelector(".inline-notch-sub")?.textContent).toContain("thinking");
    expect(host.querySelector(".inline-notch-stream")?.textContent).toContain("thinking");
    expect(host.querySelector(".inline-notch-stream")?.textContent).toContain("pi 1");
  });
});
