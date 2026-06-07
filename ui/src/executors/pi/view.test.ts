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
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    extUi: vi.fn().mockResolvedValue(undefined),
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
  piSteer: mocks.steer,
  piFollowUp: mocks.followUp,
  piExtensionUiResponse: mocks.extUi,
}));

const sendPromptMock = mocks.sendPrompt;
const abortMock = mocks.abort;
const closePiSessionMock = mocks.closeSession;
const fireEvent = (event: unknown): void => {
  if (!mocks.state.lastHandler) throw new Error("no handler registered");
  mocks.state.lastHandler(event);
};
const lastHandlerExists = (): boolean => mocks.state.lastHandler !== null;

import { PiChatView, assistantText, extractToolText } from "./view";

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
    mocks.steer.mockClear();
    mocks.followUp.mockClear();
    mocks.extUi.mockClear();
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

  it("mounts header, message list, empty state, and input", () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    expect(host.querySelector(".pi-chat-header")).toBeTruthy();
    expect(host.querySelector(".pi-chat-messages")).toBeTruthy();
    expect(host.querySelector(".pi-chat-empty")?.textContent).toContain("not a terminal");
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
    expect(host.querySelector<HTMLElement>(".pi-chat-empty")?.hidden).toBe(true);
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

  it("restores the reader's scroll offset instead of snapping to top while scrolled up", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    const messages = host.querySelector<HTMLElement>(".pi-chat-messages")!;
    // jsdom reports 0 for layout metrics; fake a tall, scrolled-up viewport.
    Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(messages, "clientHeight", { configurable: true, value: 400 });

    fireEvent({ type: "agent_start" });
    fireEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first chunk " },
    });
    await flush();

    // Reader scrolls up to read earlier output.
    messages.scrollTop = 200;
    messages.dispatchEvent(new Event("scroll"));

    // The webview yanks scrollTop to 0 when the next delta replaces children.
    messages.scrollTop = 0;
    fireEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "second chunk" },
    });
    await flush();

    // Without the fix scrollTop stays at 0 (snapped to top); with it the
    // reader's parked offset is restored.
    expect(messages.scrollTop).toBe(200);
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

  it("renders tool_execution_* lifecycle and updates body", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({ type: "agent_start" });
    fireEvent({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "ls -la" },
    });
    let card = host.querySelector(".pi-tool");
    expect(card?.classList.contains("pi-tool-running")).toBe(true);
    expect(host.querySelector(".pi-tool-name")?.textContent).toBe("bash");

    fireEvent({
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "ls -la" },
      partialResult: { content: [{ type: "text", text: "Cargo.toml\n" }] },
    });
    expect(host.querySelector(".pi-tool-body")?.textContent).toBe("Cargo.toml\n");

    fireEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "Cargo.toml\nsrc/\n" }] },
      isError: false,
    });
    card = host.querySelector(".pi-tool");
    expect(card?.classList.contains("pi-tool-done")).toBe(true);
    expect(host.querySelector(".pi-tool-body")?.textContent).toBe("Cargo.toml\nsrc/\n");
  });

  it("marks tool as error when isError true", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({ type: "agent_start" });
    fireEvent({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "false" },
    });
    fireEvent({
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "exit 1" }] },
      isError: true,
    });
    expect(host.querySelector(".pi-tool")?.classList.contains("pi-tool-error")).toBe(true);
  });

  it("falls back to JSON when tool result has no text content", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({ type: "agent_start" });
    fireEvent({
      type: "tool_execution_start",
      toolCallId: "c",
      toolName: "weather",
      args: {},
    });
    fireEvent({
      type: "tool_execution_end",
      toolCallId: "c",
      toolName: "weather",
      result: { temp_c: 23 },
    });
    expect(host.querySelector(".pi-tool-body")?.textContent).toMatch(/"temp_c": 23/);
  });

  it("renders thinking_delta into a collapsible block", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({ type: "agent_start" });
    fireEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Let me " },
    });
    fireEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "think." },
    });
    expect(host.querySelector(".pi-thinking-body")?.textContent).toBe("Let me think.");
  });

  it("shows queue indicator when queue_update has pending items", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    const queue = host.querySelector(".pi-chat-queue") as HTMLElement;
    expect(queue.hidden).toBe(true);
    fireEvent({ type: "queue_update", steering: ["focus harder"], followUp: ["wrap up"] });
    expect(queue.hidden).toBe(false);
    expect(queue.textContent).toContain("steering (1)");
    expect(queue.textContent).toContain("follow-up (1)");
    fireEvent({ type: "queue_update", steering: [], followUp: [] });
    expect(queue.hidden).toBe(true);
  });

  it("hides queue and clears tools on agent_end", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({ type: "agent_start" });
    fireEvent({ type: "queue_update", steering: ["x"], followUp: [] });
    fireEvent({
      type: "tool_execution_start",
      toolCallId: "c",
      toolName: "x",
      args: {},
    });
    fireEvent({ type: "agent_end", messages: [] });
    const queue = host.querySelector(".pi-chat-queue") as HTMLElement;
    expect(queue.hidden).toBe(true);
  });

  it("Steer button is hidden idle, visible while busy, and sends piSteer", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    const steerBtn = host.querySelector<HTMLButtonElement>(".pi-chat-steer")!;
    expect(steerBtn.hidden).toBe(true);
    fireEvent({ type: "agent_start" });
    expect(steerBtn.hidden).toBe(false);
    const ta = host.querySelector<HTMLTextAreaElement>(".pi-chat-textarea")!;
    ta.value = "focus on tests";
    steerBtn.click();
    await flush();
    expect(mocks.steer).toHaveBeenCalledWith("s1", "focus on tests");
    expect(host.querySelector(".pi-msg-system")?.textContent).toContain("steer:");
  });

  it("Follow-up button sends piFollowUp", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({ type: "agent_start" });
    const followBtn = host.querySelector<HTMLButtonElement>(".pi-chat-followup")!;
    const ta = host.querySelector<HTMLTextAreaElement>(".pi-chat-textarea")!;
    ta.value = "then commit";
    followBtn.click();
    await flush();
    expect(mocks.followUp).toHaveBeenCalledWith("s1", "then commit");
  });

  it("Steer with empty input flashes placeholder and does NOT call piSteer", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({ type: "agent_start" });
    const steerBtn = host.querySelector<HTMLButtonElement>(".pi-chat-steer")!;
    steerBtn.click();
    await flush();
    expect(mocks.steer).not.toHaveBeenCalled();
    const ta = host.querySelector<HTMLTextAreaElement>(".pi-chat-textarea")!;
    expect(ta.classList.contains("pi-chat-textarea-flash")).toBe(true);
  });

  it("renders a select extension dialog and dispatches piExtensionUiResponse", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({
      type: "extension_ui_request",
      id: "u1",
      method: "select",
      title: "Pick one",
      options: ["Allow", "Block"],
    });
    expect(host.querySelector(".pi-ext-dialog")).toBeTruthy();
    const allow = host.querySelectorAll<HTMLButtonElement>(".pi-ext-option")[0];
    allow.click();
    await flush();
    expect(mocks.extUi).toHaveBeenCalledWith("s1", "u1", { value: "Allow" });
    expect(host.querySelector(".pi-ext-dialog")).toBeNull();
  });

  it("Select Cancel sends cancelled:true", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({
      type: "extension_ui_request",
      id: "u2",
      method: "select",
      title: "Pick",
      options: ["A", "B"],
    });
    host.querySelector<HTMLButtonElement>(".pi-ext-cancel")!.click();
    await flush();
    expect(mocks.extUi).toHaveBeenCalledWith("s1", "u2", { cancelled: true });
  });

  it("Confirm dialog OK sends confirmed:true", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({
      type: "extension_ui_request",
      id: "u3",
      method: "confirm",
      title: "Proceed?",
      message: "This will delete the file.",
    });
    host.querySelector<HTMLButtonElement>(".pi-ext-ok")!.click();
    await flush();
    expect(mocks.extUi).toHaveBeenCalledWith("s1", "u3", { confirmed: true });
  });

  it("Confirm dialog Cancel sends confirmed:false (not cancelled)", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({
      type: "extension_ui_request",
      id: "u4",
      method: "confirm",
      title: "Proceed?",
    });
    host.querySelector<HTMLButtonElement>(".pi-ext-cancel")!.click();
    await flush();
    expect(mocks.extUi).toHaveBeenCalledWith("s1", "u4", { confirmed: false });
  });

  it("notify-class methods append a system note without prompting", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({
      type: "extension_ui_request",
      id: "u5",
      method: "notify",
      message: "Blocked dangerous command",
    });
    expect(host.querySelector(".pi-ext-dialog")).toBeNull();
    const note = host.querySelector(".pi-msg-system")?.textContent;
    expect(note).toContain("Blocked dangerous command");
    expect(mocks.extUi).not.toHaveBeenCalled();
  });

  it("Unsupported blocking methods auto-cancel with a system note", async () => {
    const host = mountHost();
    new PiChatView({ sessionId: "s1" as never, host });
    await flush();
    fireEvent({
      type: "extension_ui_request",
      id: "u6",
      method: "editor",
      title: "Edit",
      prefill: "Line 1",
    });
    await flush();
    expect(mocks.extUi).toHaveBeenCalledWith("s1", "u6", { cancelled: true });
    const note = host.querySelector(".pi-msg-system-error")?.textContent;
    expect(note).toMatch(/editor.*not yet supported/);
  });
});

describe("extractToolText()", () => {
  it("returns concatenated text from content array", () => {
    expect(
      extractToolText({
        content: [
          { type: "text", text: "a " },
          { type: "image", url: "x" },
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a b");
  });
  it("returns null for non-text payloads", () => {
    expect(extractToolText({ temp: 1 })).toBeNull();
    expect(extractToolText(null)).toBeNull();
    expect(extractToolText("string")).toBeNull();
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
