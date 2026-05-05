import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SpecChatState, ChatMessage } from "./state";
import type { SpecPhase } from "../api";
import { mountSpecChatPanel } from "./panel";

function makeMockState() {
  let messages: ChatMessage[] = [];
  let awaiting = false;
  let finalMd: string | null = null;
  let phase: SpecPhase | null = null;
  let draftId: string | null = null;
  const listeners = new Set<() => void>();
  const fire = () => {
    for (const cb of listeners) cb();
  };

  const submitMock = vi.fn<[string], Promise<void>>().mockResolvedValue(undefined);

  const state: SpecChatState = {
    draftId: () => draftId,
    messages: () => messages,
    awaitingAnswer: () => awaiting,
    finalMarkdown: () => finalMd,
    phase: () => phase,
    submit: submitMock,
    restoreDraft: vi.fn<[string], Promise<void>>().mockResolvedValue(undefined),
    reset: vi.fn(),
    onChange(cb: () => void) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };

  return {
    state,
    submitMock,
    set(patch: {
      messages?: ChatMessage[];
      awaiting?: boolean;
      finalMd?: string | null;
      phase?: SpecPhase | null;
      draftId?: string | null;
    }) {
      if (patch.messages !== undefined) messages = patch.messages;
      if (patch.awaiting !== undefined) awaiting = patch.awaiting;
      if ("finalMd" in patch) finalMd = patch.finalMd ?? null;
      if ("phase" in patch) phase = patch.phase ?? null;
      if ("draftId" in patch) draftId = patch.draftId ?? null;
      fire();
    },
  };
}

describe("mountSpecChatPanel", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("open() adds root to host; close() removes it", () => {
    const { state } = makeMockState();
    const panel = mountSpecChatPanel(host, state);

    expect(panel.isOpen()).toBe(false);
    panel.open();
    expect(panel.isOpen()).toBe(true);
    expect(host.querySelector(".spec-chat-panel")).not.toBeNull();

    panel.close();
    expect(panel.isOpen()).toBe(false);
    expect(host.querySelector(".spec-chat-panel")).toBeNull();
  });

  it("state onChange with a new assistant message → DOM contains message text", () => {
    const { state, set } = makeMockState();
    const panel = mountSpecChatPanel(host, state);
    panel.open();

    set({ messages: [{ role: "assistant", content: "Hello from agent" }] });

    const msgs = host.querySelectorAll(".spec-chat-msg-assistant");
    expect(msgs.length).toBe(1);
    expect((msgs[0] as HTMLElement).textContent).toBe("Hello from agent");
  });

  it("while awaitingAnswer === true → textarea is disabled", () => {
    const { state, set } = makeMockState();
    const panel = mountSpecChatPanel(host, state);
    panel.open();

    set({ awaiting: true });

    const textarea = host.querySelector<HTMLTextAreaElement>(".spec-chat-input");
    expect(textarea?.disabled).toBe(true);
  });

  it("pressing Enter (without Shift) calls state.submit; Shift+Enter does not", async () => {
    const { state, submitMock } = makeMockState();
    const panel = mountSpecChatPanel(host, state);
    panel.open();

    const textarea = host.querySelector<HTMLTextAreaElement>(".spec-chat-input")!;
    textarea.value = "hello";

    // Shift+Enter — should NOT submit
    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
    });
    textarea.dispatchEvent(shiftEnter);
    expect(submitMock).not.toHaveBeenCalled();

    // Plain Enter — should submit
    const plainEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: false,
      bubbles: true,
    });
    textarea.dispatchEvent(plainEnter);
    // submitMock is async; give it a tick
    await Promise.resolve();
    expect(submitMock).toHaveBeenCalledWith("hello");
  });

  it("when finalMarkdown is set → input-row hidden, publish button visible; clicking fires onPublishRequest", async () => {
    const { state, set } = makeMockState();
    const panel = mountSpecChatPanel(host, state);
    panel.onPublishRequest = vi.fn();
    panel.open();

    set({ finalMd: "# My spec", draftId: "draft-123" });

    const inputRow = host.querySelector<HTMLElement>(".spec-chat-input-row");
    const finalRow = host.querySelector<HTMLElement>(".spec-chat-final");
    expect(inputRow?.hidden).toBe(true);
    expect(finalRow?.hidden).toBe(false);

    const publishBtn = host.querySelector<HTMLButtonElement>(".spec-chat-publish")!;
    publishBtn.click();

    expect(panel.onPublishRequest).toHaveBeenCalledWith("# My spec", "draft-123");
  });
});
