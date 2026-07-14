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

function rect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    width: 200,
    height,
    top,
    right: 200,
    bottom: top + height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("mountInlineNotch", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    mocks.handlers.clear();
    mocks.listen.mockClear();
    mocks.invoke.mockClear();
    vi.restoreAllMocks();
  });

  it("renders the Activity rail header and keeps the dot idle before any phase event", () => {
    const host = mount();

    expect(host.querySelector(".rail-title-label")?.textContent).toContain("Activity");

    window.dispatchEvent(
      new CustomEvent("ui:active-session", {
        detail: {
          session_id: "01J00000000000000000000000",
          agent: "pi",
          tab_label: "COVENANT › pi 1",
        },
      }),
    );

    const dot = host.querySelector(".rail-dot");
    expect(dot).toBeTruthy();
    // No phase event yet → the active session is idle → dot is not "is-run".
    expect(dot?.classList.contains("is-run")).toBe(false);
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

    // Active thinking executor lights the header status dot.
    expect(host.querySelector(".rail-dot")?.classList.contains("is-run")).toBe(true);
    const body = host.querySelector(".rail-body");
    expect(body?.textContent).toContain("thinking");
    expect(body?.textContent).toContain("pi 1");
    // Combined view composes "<agent> · <message>" into the rail name.
    expect(body?.querySelector(".rail-name")?.textContent).toContain("Pi");
  });

  it("keeps the activity stream anchored while new rows arrive", () => {
    const host = mount();
    const stream = host.querySelector<HTMLElement>(".rail-body")!;

    // One turn per session — spread across sessions so the stream holds
    // multiple rows for the anchor to latch onto.
    for (let i = 0; i < 5; i++) {
      fireNotchState({
        kind: "executor_state_changed",
        session: `01J0000000000000000000000${i}`,
        agent: "pi",
        tab_label: `pi ${i}`,
        phase: { kind: "running", cmd: `cmd-${i}` },
      });
    }

    const innerHtmlDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
    Object.defineProperty(stream, "innerHTML", {
      configurable: true,
      get(this: HTMLElement) {
        return innerHtmlDescriptor.get!.call(this);
      },
      set(this: HTMLElement, value: string) {
        innerHtmlDescriptor.set!.call(this, value);
        // Browsers can snap scrollTop back to 0 when we replace children;
        // simulate that so the test covers the manual restoration path.
        this.scrollTop = 0;
      },
    });

    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const el = this as HTMLElement;
      if (el.classList?.contains("rail-body")) return rect(0, 100);
      if (el.classList?.contains("rail-row")) {
        const parent = el.parentElement;
        const index = parent ? Array.from(parent.children).indexOf(el) : 0;
        return rect(index * 20 - stream.scrollTop, 20);
      }
      return rect(0, 0);
    });

    stream.scrollTop = 20;
    fireNotchState({
      kind: "executor_state_changed",
      session: "01J0000000000000000000000X",
      agent: "pi",
      tab_label: "pi new",
      phase: { kind: "running", cmd: "cmd-new" },
    });

    expect(stream.scrollTop).toBe(40);
  });
});
