import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountSpecChat } from "./index";
import type { SpecDraftSummary, SpecDraftStatus } from "../api";
import type { ImmersiveOpts, ImmersiveInstance } from "./immersive";

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

/**
 * Build a mock immersive factory and return both the factory fn and a ref to the
 * latest captured opts (populated on first call).
 */
function makeMockImmersiveFactory(): {
  factory: (opts: ImmersiveOpts) => ImmersiveInstance;
  latestOpts: () => ImmersiveOpts | undefined;
  latestInstance: () => ImmersiveInstance | undefined;
} {
  let capturedOpts: ImmersiveOpts | undefined;
  let capturedInstance: ImmersiveInstance | undefined;

  const factory = (opts: ImmersiveOpts): ImmersiveInstance => {
    capturedOpts = opts;
    let isOpen = true;
    const inst: ImmersiveInstance = {
      submit: vi.fn(),
      close: () => {
        isOpen = false;
        opts.onClose?.();
      },
    };
    // Expose isOpen via a non-standard property so tests can inspect it.
    (inst as unknown as { isOpen: () => boolean }).isOpen = () => isOpen;
    capturedInstance = inst;
    return inst;
  };

  return {
    factory,
    latestOpts: () => capturedOpts,
    latestInstance: () => capturedInstance,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mountSpecChat — chooser logic", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = makeHost();
  });

  it("1. No in-progress drafts: open mounts immersive directly, no chooser", async () => {
    const listDrafts = vi.fn().mockResolvedValue([]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const { factory, latestInstance } = makeMockImmersiveFactory();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, mountImmersive: factory });
    ctrl.open();

    await vi.waitFor(() => expect(latestInstance()).toBeDefined());
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

  it("3. Clicking 'Resume X' removes chooser and mounts the immersive surface", async () => {
    const draft = makeDraft({ id: "resume-me" });
    const listDrafts = vi.fn().mockResolvedValue([draft]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const { factory, latestOpts, latestInstance } = makeMockImmersiveFactory();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, mountImmersive: factory });
    ctrl.open();

    await vi.waitFor(() => expect(host.querySelector(".spec-chat-chooser")).not.toBeNull());

    const resumeBtn = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".spec-chat-chooser-btn"),
    ).find((b) => b.textContent?.startsWith("Resume"));

    expect(resumeBtn).toBeDefined();
    resumeBtn!.click();

    // Chooser disappears; immersive is mounted with the correct draftId
    await vi.waitFor(() => expect(host.querySelector(".spec-chat-chooser")).toBeNull());
    await vi.waitFor(() => expect(latestInstance()).toBeDefined());
    expect(latestOpts()?.draftId).toBe("resume-me");
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

  it("5. onPublish fires openWizardWithBody and specAuthorMarkPublished", async () => {
    const listDrafts = vi.fn().mockResolvedValue([]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const { factory, latestOpts, latestInstance } = makeMockImmersiveFactory();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, mountImmersive: factory });
    ctrl.open();

    await vi.waitFor(() => expect(latestInstance()).toBeDefined());

    // The controller should have set onPublish on the immersive opts
    expect(latestOpts()?.onPublish).toBeDefined();

    // Fire the publish callback directly — simulates user clicking "Review & publish"
    latestOpts()!.onPublish!("# My Spec\n", "test-draft-id");

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

  it("6. Closing via the immersive onClose resets controller state so it can reopen", async () => {
    const listDrafts = vi.fn().mockResolvedValue([]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const { factory, latestOpts, latestInstance } = makeMockImmersiveFactory();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, mountImmersive: factory });
    ctrl.open();
    await vi.waitFor(() => expect(ctrl.isOpen()).toBe(true));

    // User closes the immersive surface via its own onClose
    latestOpts()!.onClose!();
    expect(ctrl.isOpen()).toBe(false);

    // Reopening must mount a fresh immersive
    const prevInstance = latestInstance();
    ctrl.open();
    await vi.waitFor(() => expect(latestInstance()).not.toBe(prevInstance));
    expect(ctrl.isOpen()).toBe(true);
  });
});
