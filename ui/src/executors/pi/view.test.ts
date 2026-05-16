// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the most-recent event handler installed by subscribePiEvents
// so tests can drive the view by simulating backend events.
const mocks = vi.hoisted(() => {
  const state: { lastHandler: ((event: unknown) => void) | null } = {
    lastHandler: null,
  };
  return {
    state,
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    closeSession: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../api", () => ({
  subscribePiEvents: vi.fn(async (_id: string, handler: (e: unknown) => void) => {
    mocks.state.lastHandler = handler;
    return () => {
      mocks.state.lastHandler = null;
    };
  }),
  piSendPrompt: mocks.sendPrompt,
  piAbort: mocks.abort,
  closePiSession: mocks.closeSession,
}));

const sendPromptMock = mocks.sendPrompt;
const abortMock = mocks.abort;
const closePiSessionMock = mocks.closeSession;
const fireEvent = (event: unknown): void => {
  if (!mocks.state.lastHandler) throw new Error("no handler registered");
  mocks.state.lastHandler(event);
};
const lastHandlerExists = (): boolean => mocks.state.lastHandler !== null;

import { PiChatView, assistantText } from "./view";

function mountHost(): HTMLElement {
  document.body.innerHTML = `<div id="pi-host" style="height:400px;width:600px"></div>`;
  return document.getElementById("pi-host")!;
}

async function flush(): Promise<void> {
  // Microtask + rAF roundtrip — the view defers scroll/subscribe via
  // promises and rAF; tests want a settled DOM before asserting.
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("PiChatView", () => {
  beforeEach(() => {
    sendPromptMock.mockClear();
    abortMock.mockClear();
    closePiSessionMock.mockClear();
    mocks.state.lastHandler = null;
    // jsdom doesn't implement scrollTo or rAF scrolling; stub rAF to
    // run synchronously so scrollToBottom doesn't pollute timers.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1 as unknown as number;
    });
  });
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("mounts header, message list, and input", () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    expect(host.querySelector(".pi-chat-header")).toBeTruthy();
    expect(host.querySelector(".pi-chat-messages")).toBeTruthy();
    expect(host.querySelector(".pi-chat-textarea")).toBeTruthy();
    expect(host.querySelector(".pi-chat-send")).toBeTruthy();
  });

  it("sends a prompt and renders user bubble", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    const ta = host.querySelector<HTMLTextAreaElement>(".pi-chat-textarea")!;
    ta.value = "hello pi";
    host.querySelector<HTMLFormElement>("form.pi-chat-input")!.dispatchEvent(
      new Event("submit"),
    );
    await flush();
    expect(sendPromptMock).toHaveBeenCalledWith("s1", "hello pi");
    const userMsg = host.querySelector(".pi-msg-user .pi-msg-content");
    expect(userMsg?.textContent).toBe("hello pi");
  });

  it("streams text_delta events into the assistant bubble", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    // Simulate a turn: agent_start, then two deltas, then agent_end.
    fireEvent({ type: "agent_start" });
    fireEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello, " },
    });
    fireEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "world!" },
    });
    fireEvent({ type: "agent_end", messages: [] });
    await flush();
    const text = host.querySelector(".pi-msg-assistant .pi-msg-text")?.textContent;
    expect(text).toBe("Hello, world!");
  });

  it("falls back to turn_end message when no deltas streamed", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({ type: "agent_start" });
    fireEvent({
      type: "turn_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "one-shot reply" },
        ],
      },
      toolResults: [],
    });
    fireEvent({ type: "agent_end", messages: [] });
    await flush();
    const text = host.querySelector(".pi-msg-assistant .pi-msg-text")?.textContent;
    expect(text).toBe("one-shot reply");
  });

  it("toggles Abort visibility while busy", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    const abortBtn = host.querySelector<HTMLButtonElement>(".pi-chat-abort")!;
    expect(abortBtn.hidden).toBe(true);
    fireEvent({ type: "agent_start" });
    expect(abortBtn.hidden).toBe(false);
    fireEvent({ type: "agent_end", messages: [] });
    expect(abortBtn.hidden).toBe(true);
  });

  it("surfaces process_exited as a system note + exited status", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({ type: "process_exited", code: 137 });
    await flush();
    expect(host.querySelector(".pi-chat-status")?.getAttribute("data-state")).toBe(
      "exited",
    );
    expect(host.querySelector(".pi-msg-system-error")?.textContent).toMatch(
      /process exited/i,
    );
  });

  it("escapes html in user content", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    const ta = host.querySelector<HTMLTextAreaElement>(".pi-chat-textarea")!;
    ta.value = "<script>x()</script>";
    host.querySelector<HTMLFormElement>("form.pi-chat-input")!.dispatchEvent(
      new Event("submit"),
    );
    await flush();
    const userContent = host.querySelector(".pi-msg-user .pi-msg-content");
    expect(userContent?.innerHTML).not.toContain("<script>");
    expect(userContent?.textContent).toBe("<script>x()</script>");
  });

  it("destroy() unsubscribes and clears the host", async () => {
    const host = mountHost();
    const view = new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    view.destroy();
    expect(host.innerHTML).toBe("");
    expect(lastHandlerExists()).toBe(false);
  });
});

describe("assistantText()", () => {
  it("concatenates text content blocks and skips non-text", () => {
    const msg = {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "Hi. " },
        { type: "thinking" as const, thinking: "ignore me" },
        { type: "text" as const, text: "How are you?" },
      ],
    };
    expect(assistantText(msg)).toBe("Hi. How are you?");
  });
});
