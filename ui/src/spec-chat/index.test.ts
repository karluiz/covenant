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
    repo_root: null,
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

describe("mountSpecChat — entrance logic", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = makeHost();
  });

  it("1. No in-progress drafts: open shows the entrance welcome, not the immersive", async () => {
    const listDrafts = vi.fn().mockResolvedValue([]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const { factory, latestInstance } = makeMockImmersiveFactory();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, mountImmersive: factory });
    ctrl.open();

    // Entrance is always shown so the user can pick AI vs. blank — even with no cards.
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).not.toBeNull());
    expect(host.querySelectorAll(".spec-entrance-card").length).toBe(0);
    expect(host.querySelector(".spec-entrance-cta")).not.toBeNull();
    expect(host.querySelector(".spec-entrance-blank")).not.toBeNull();
    expect(latestInstance()).toBeUndefined();
    expect(ctrl.isOpen()).toBe(true);
  });

  it("2. With 2 in-progress drafts: entrance visible with both labels", async () => {
    const draft1 = makeDraft({ id: "d1", messages: [{ role: "User", content: "Alpha project spec" }] });
    const draft2 = makeDraft({ id: "d2", messages: [{ role: "User", content: "Beta project spec" }] });
    const listDrafts = vi.fn().mockResolvedValue([draft1, draft2]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();
    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished });

    ctrl.open();
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).not.toBeNull());

    const cards = host.querySelectorAll<HTMLElement>(".spec-entrance-card-summary");
    const texts = Array.from(cards).map((c) => c.textContent ?? "");

    expect(texts.some((t) => t.includes("Alpha project spec"))).toBe(true);
    expect(texts.some((t) => t.includes("Beta project spec"))).toBe(true);
  });

  it("3. Clicking 'Resume X' removes entrance and mounts the immersive surface", async () => {
    const draft = makeDraft({ id: "resume-me" });
    const listDrafts = vi.fn().mockResolvedValue([draft]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const { factory, latestOpts, latestInstance } = makeMockImmersiveFactory();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, mountImmersive: factory });
    ctrl.open();

    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).not.toBeNull());

    const card = host.querySelector<HTMLElement>(".spec-entrance-card");
    expect(card).not.toBeNull();
    card!.click();

    // Entrance disappears; immersive is mounted with the correct draftId
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).toBeNull());
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
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).not.toBeNull());

    const blankBtn = host.querySelector<HTMLButtonElement>(".spec-entrance-blank");

    expect(blankBtn).not.toBeNull();
    blankBtn!.click();

    expect(deps.openBlankWizard).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).toBeNull());
    expect(ctrl.isOpen()).toBe(false);
  });

  it("5. onPublish fires openWizardWithBody and specAuthorMarkPublished", async () => {
    const listDrafts = vi.fn().mockResolvedValue([]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const { factory, latestOpts, latestInstance } = makeMockImmersiveFactory();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, mountImmersive: factory });
    ctrl.open();

    // Reach the immersive via the entrance CTA (empty state no longer auto-opens it).
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance-cta")).not.toBeNull());
    host.querySelector<HTMLButtonElement>(".spec-entrance-cta")!.click();

    await vi.waitFor(() => expect(latestInstance()).toBeDefined());

    // The controller should have set onPublish on the immersive opts
    expect(latestOpts()?.onPublish).toBeDefined();

    // Fire the publish callback directly — simulates user clicking "Review & publish"
    latestOpts()!.onPublish!("# My Spec\n", "test-draft-id");

    // The wizard also receives the Canon-context toggle the immersive was
    // opened with (off unless the entrance turned it on).
    expect(deps.openWizardWithBody).toHaveBeenCalledWith("# My Spec\n", {
      canonContext: false,
    });
    expect(markPublished).toHaveBeenCalledWith("test-draft-id");
    // Controller closes itself after publish
    expect(ctrl.isOpen()).toBe(false);
  });

  it("6b. Escape dismisses the entrance overlay", async () => {
    const draft = makeDraft();
    const listDrafts = vi.fn().mockResolvedValue([draft]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished });
    ctrl.open();
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).not.toBeNull());

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).toBeNull());
    expect(ctrl.isOpen()).toBe(false);
  });

  it("7a. Deleting the only draft keeps the entrance open in its empty welcome state", async () => {
    const draft = makeDraft({ id: "d1" });
    const listDrafts = vi.fn().mockResolvedValue([draft]);
    const deleteDraft = vi.fn().mockResolvedValue(undefined);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();
    const { factory, latestInstance } = makeMockImmersiveFactory();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, deleteDraft, mountImmersive: factory });
    ctrl.open();

    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).not.toBeNull());

    const delBtn = host.querySelector<HTMLButtonElement>(".spec-entrance-card-del");
    expect(delBtn).not.toBeNull();
    delBtn!.click();

    await vi.waitFor(() => expect(deleteDraft).toHaveBeenCalledWith("d1"));
    // The card disappears but the entrance stays — no jump to the AI creator.
    await vi.waitFor(() => expect(host.querySelectorAll(".spec-entrance-card").length).toBe(0));
    expect(host.querySelector(".spec-entrance")).not.toBeNull();
    expect(latestInstance()).toBeUndefined();
  });

  it("7b. Deleting one of multiple drafts keeps entrance open", async () => {
    const draft1 = makeDraft({ id: "d1", messages: [{ role: "User", content: "Alpha" }] });
    const draft2 = makeDraft({ id: "d2", messages: [{ role: "User", content: "Beta" }] });
    const listDrafts = vi.fn().mockResolvedValue([draft1, draft2]);
    const deleteDraft = vi.fn().mockResolvedValue(undefined);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, deleteDraft });
    ctrl.open();

    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).not.toBeNull());

    // Delete first draft
    const delBtns = host.querySelectorAll<HTMLButtonElement>(".spec-entrance-card-del");
    delBtns[0]!.click();

    await vi.waitFor(() => expect(deleteDraft).toHaveBeenCalledWith("d1"));
    // Remaining draft card should still exist
    const rows = host.querySelectorAll<HTMLElement>(".spec-entrance-card");
    expect(rows.length).toBe(1);
  });

  it("6c. Backdrop click on the entrance dismisses it", async () => {
    const draft = makeDraft();
    const listDrafts = vi.fn().mockResolvedValue([draft]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished });
    ctrl.open();
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).not.toBeNull());

    const entrance = host.querySelector(".spec-entrance") as HTMLElement;
    entrance.click();

    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).toBeNull());
    expect(ctrl.isOpen()).toBe(false);
  });

  it("6. Closing via the immersive onClose resets controller state so it can reopen", async () => {
    const listDrafts = vi.fn().mockResolvedValue([]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const { factory, latestOpts, latestInstance } = makeMockImmersiveFactory();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished, mountImmersive: factory });
    // Click the CTA on the live (non-fading) entrance — a dismissed entrance
    // lingers in the DOM during its exit fade but is inert.
    const clickLiveCta = (): void =>
      host.querySelector<HTMLButtonElement>(".spec-entrance:not(.closing) .spec-entrance-cta")!.click();

    ctrl.open();
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance:not(.closing) .spec-entrance-cta")).not.toBeNull());
    clickLiveCta();
    await vi.waitFor(() => expect(latestInstance()).toBeDefined());

    // User closes the immersive surface via its own onClose
    latestOpts()!.onClose!();
    expect(ctrl.isOpen()).toBe(false);

    // Reopening must mount a fresh immersive (via the entrance CTA again)
    const prevInstance = latestInstance();
    ctrl.open();
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance:not(.closing) .spec-entrance-cta")).not.toBeNull());
    clickLiveCta();
    await vi.waitFor(() => expect(latestInstance()).not.toBe(prevInstance));
    expect(ctrl.isOpen()).toBe(true);
  });

  it("Esc dismiss keeps the host visible for the exit fade, then hides it", async () => {
    const draft = makeDraft();
    const listDrafts = vi.fn().mockResolvedValue([draft]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished });
    ctrl.open();
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).not.toBeNull());

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(ctrl.isOpen()).toBe(false);
    expect(host.hidden).toBe(false); // fade still playing
    await vi.waitFor(() => expect(host.hidden).toBe(true));
  });

  it("reopening during the exit fade is not clobbered by the deferred hide", async () => {
    const draft = makeDraft();
    const listDrafts = vi.fn().mockResolvedValue([draft]);
    const markPublished = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps();

    const ctrl = mountSpecChat(host, deps, { listDrafts, markPublished });
    ctrl.open();
    await vi.waitFor(() => expect(host.querySelector(".spec-entrance")).not.toBeNull());

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    ctrl.open(); // reopen while the old root is still fading

    await vi.waitFor(() => expect(ctrl.isOpen()).toBe(true));
    // Wait past the fade window; the stale hide must have been skipped.
    await new Promise((r) => setTimeout(r, 400));
    expect(host.hidden).toBe(false);
  });
});
