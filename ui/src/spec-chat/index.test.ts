import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountSpecChat } from "./index";
import type { SpecChatPanel } from "./panel";
import type { SpecDraftSummary, SpecDraftStatus } from "../api";
import type { SpecChatState } from "./state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHost(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function makeDraft(overrides: Partial<SpecDraftSummary> = {}): SpecDraftSummary {
  return {
    id: "draft-1",
    messages: [{ role: "User", content: "First user message for testing" }],
    partial_md: null,
    last_updated: new Date(Date.now() - 5 * 60_000).toISOString(),
    status: { InProgress: { phase: "goal" } } as SpecDraftStatus,
    ...overrides,
  };
}

function makeDeps() {
  return {
    openWizardWithBody: vi.fn(),
    openBlankWizard: vi.fn(),
  };
}

/** Creates a mock panel that records calls and exposes the onPublishRequest setter. */
function makeMockPanel(): { panel: SpecChatPanel; opened: boolean } {
  const record = { opened: false };
  const panel: SpecChatPanel = {
    onPublishRequest: null,
    onClose: null,
    isOpen: () => record.opened,
    open() { record.opened = true; },
    close() {
      record.opened = false;
      panel.onClose?.();
    },
  };
  return { panel, ...record };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mountSpecChat — chooser logic", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = makeHost();
  });

  it("1. No in-progress drafts: open mounts chat panel directly, no chooser", async () => {
    const listDrafts = vi.fn().mockResolvedValue([]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    let capturedPanel: SpecChatPanel | undefined;
    const mountPanel = (_h: HTMLElement, _s: SpecChatState): SpecChatPanel => {
      const { panel } = makeMockPanel();
      capturedPanel = panel;
      return panel;
    };
    const createState = (): SpecChatState => ({
      draftId: () => null,
      messages: () => [],
      awaitingAnswer: () => false,
      finalMarkdown: () => null,
      phase: () => null,
      submit: vi.fn().mockResolvedValue(undefined),
      restoreDraft: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
      onChange: vi.fn().mockReturnValue(() => {}),
    });

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, mountPanel, createState });
    ctrl.open();

    await vi.waitFor(() => expect(capturedPanel?.isOpen()).toBe(true));
    expect(host.querySelector(".spec-chat-chooser")).toBeNull();
    expect(ctrl.isOpen()).toBe(true);
  });

  it("2. With 2 in-progress drafts: chooser visible with both labels", async () => {
    const draft1 = makeDraft({ id: "d1", messages: [{ role: "User", content: "Alpha project spec" }] });
    const draft2 = makeDraft({ id: "d2", messages: [{ role: "User", content: "Beta project spec" }] });
    const listDrafts = vi.fn().mockResolvedValue([draft1, draft2]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();
    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished });

    ctrl.open();
    await vi.waitFor(() => expect(host.querySelector(".spec-chat-chooser")).not.toBeNull());

    const btns = host.querySelectorAll<HTMLButtonElement>(".spec-chat-chooser-btn");
    const texts = Array.from(btns).map((b) => b.textContent ?? "");

    expect(texts.some((t) => t.includes("Alpha project spec"))).toBe(true);
    expect(texts.some((t) => t.includes("Beta project spec"))).toBe(true);
  });

  it("3. Clicking 'Resume X' removes chooser and mounts the panel", async () => {
    const draft = makeDraft({ id: "resume-me" });
    const listDrafts = vi.fn().mockResolvedValue([draft]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    let capturedPanel: SpecChatPanel | undefined;
    const mountPanel = (_h: HTMLElement, _s: SpecChatState): SpecChatPanel => {
      const { panel } = makeMockPanel();
      capturedPanel = panel;
      return panel;
    };

    // Mock state with a restoreDraft that resolves immediately without calling invoke
    const createState = (): SpecChatState => ({
      draftId: () => "resume-me",
      messages: () => [],
      awaitingAnswer: () => false,
      finalMarkdown: () => null,
      phase: () => null,
      submit: vi.fn().mockResolvedValue(undefined),
      restoreDraft: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
      onChange: vi.fn().mockReturnValue(() => {}),
    });

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, mountPanel, createState });
    ctrl.open();

    await vi.waitFor(() => expect(host.querySelector(".spec-chat-chooser")).not.toBeNull());

    const resumeBtn = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".spec-chat-chooser-btn"),
    ).find((b) => b.textContent?.startsWith("Resume"));

    expect(resumeBtn).toBeDefined();
    resumeBtn!.click();

    // Chooser disappears; panel opens (restoreDraft resolves then wirePanel is called)
    await vi.waitFor(() => expect(host.querySelector(".spec-chat-chooser")).toBeNull());
    await vi.waitFor(() => expect(capturedPanel?.isOpen()).toBe(true));
    expect(ctrl.isOpen()).toBe(true);
  });

  it("4. Clicking 'Blank draft' calls deps.openBlankWizard and closes controller", async () => {
    const draft = makeDraft();
    const listDrafts = vi.fn().mockResolvedValue([draft]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();
    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished });

    ctrl.open();
    await vi.waitFor(() => expect(host.querySelector(".spec-chat-chooser")).not.toBeNull());

    const blankBtn = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".spec-chat-chooser-btn"),
    ).find((b) => b.textContent?.includes("Blank draft"));

    expect(blankBtn).toBeDefined();
    blankBtn!.click();

    expect(deps.openBlankWizard).toHaveBeenCalledOnce();
    expect(host.querySelector(".spec-chat-chooser")).toBeNull();
    expect(ctrl.isOpen()).toBe(false);
  });

  it("5. onPublishRequest fires openWizardWithBody and specAuthorMarkPublished", async () => {
    const listDrafts = vi.fn().mockResolvedValue([]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    let capturedPanel: SpecChatPanel | undefined;
    const mountPanel = (_h: HTMLElement, _s: SpecChatState): SpecChatPanel => {
      const { panel } = makeMockPanel();
      capturedPanel = panel;
      return panel;
    };
    const createState = (): SpecChatState => ({
      draftId: () => null,
      messages: () => [],
      awaitingAnswer: () => false,
      finalMarkdown: () => null,
      phase: () => null,
      submit: vi.fn().mockResolvedValue(undefined),
      restoreDraft: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
      onChange: vi.fn().mockReturnValue(() => {}),
    });

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, mountPanel, createState });
    ctrl.open();

    await vi.waitFor(() => expect(capturedPanel).toBeDefined());
    await vi.waitFor(() => expect(capturedPanel!.isOpen()).toBe(true));

    // The controller should have set onPublishRequest on the panel
    expect(capturedPanel!.onPublishRequest).not.toBeNull();

    // Fire the publish callback directly — simulates user clicking "Revisar y publicar"
    capturedPanel!.onPublishRequest!("# My Spec\n", "test-draft-id");

    expect(deps.openWizardWithBody).toHaveBeenCalledWith("# My Spec\n");
    expect(markPublished).toHaveBeenCalledWith("test-draft-id");
    // Controller closes itself after publish
    expect(ctrl.isOpen()).toBe(false);
  });

  it("6b. Escape dismisses the chooser overlay", async () => {
    const draft = makeDraft();
    const listDrafts = vi.fn().mockResolvedValue([draft]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished });
    ctrl.open();
    await vi.waitFor(() => expect(host.querySelector(".spec-chat-chooser")).not.toBeNull());

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(host.querySelector(".spec-chat-chooser")).toBeNull();
    expect(ctrl.isOpen()).toBe(false);
  });

  it("6c. Backdrop click on the chooser dismisses it", async () => {
    const draft = makeDraft();
    const listDrafts = vi.fn().mockResolvedValue([draft]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished });
    ctrl.open();
    await vi.waitFor(() => expect(host.querySelector(".spec-chat-chooser")).not.toBeNull());

    const chooser = host.querySelector(".spec-chat-chooser") as HTMLElement;
    chooser.click(); // click directly on chooser (backdrop), not on a button

    expect(host.querySelector(".spec-chat-chooser")).toBeNull();
    expect(ctrl.isOpen()).toBe(false);
  });

  it("6. Closing via the panel's own X resets controller state so it can reopen", async () => {
    const listDrafts = vi.fn().mockResolvedValue([]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    let capturedPanel: SpecChatPanel | undefined;
    const mountPanel = (_h: HTMLElement, _s: SpecChatState): SpecChatPanel => {
      const { panel } = makeMockPanel();
      capturedPanel = panel;
      return panel;
    };
    const createState = (): SpecChatState => ({
      draftId: () => null,
      messages: () => [],
      awaitingAnswer: () => false,
      finalMarkdown: () => null,
      phase: () => null,
      submit: vi.fn().mockResolvedValue(undefined),
      restoreDraft: vi.fn().mockResolvedValue(undefined),
      reset: vi.fn(),
      onChange: vi.fn().mockReturnValue(() => {}),
    });

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, mountPanel, createState });
    ctrl.open();
    await vi.waitFor(() => expect(ctrl.isOpen()).toBe(true));

    // User clicks the panel's own X — bypasses controller.close()
    capturedPanel!.close();
    expect(ctrl.isOpen()).toBe(false);

    // Reopening must mount a fresh panel
    capturedPanel = undefined;
    ctrl.open();
    await vi.waitFor(() => expect(capturedPanel).toBeDefined());
    expect(capturedPanel!.isOpen()).toBe(true);
    expect(ctrl.isOpen()).toBe(true);
  });
});
