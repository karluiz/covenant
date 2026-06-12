import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { sectionProgress, mountSpecEntrance } from "./entrance";
import type { EntranceCallbacks } from "./entrance";
import type { SpecDraftSummary, SpecDraftStatus } from "../api";

// ---------------------------------------------------------------------------
// sectionProgress
// ---------------------------------------------------------------------------

describe("sectionProgress", () => {
  it("returns all-false for null partial_md", () => {
    expect(sectionProgress(null)).toEqual([false, false, false, false, false, false]);
  });

  it("fills dots for present ## section headers", () => {
    const md = "## Goal\nDo the thing.\n\n## Acceptance criteria\n- works\n";
    expect(sectionProgress(md)).toEqual([true, false, true, false, false, false]);
  });

  it("matches headers case-insensitively and ignores ### subheadings", () => {
    const md = "## goal\nx\n### File boundaries\nnot a top-level section\n";
    expect(sectionProgress(md)).toEqual([true, false, false, false, false, false]);
  });

  it("fills all six for a complete spec", () => {
    const md = [
      "## Goal", "## Out of scope", "## Acceptance criteria",
      "## File boundaries", "## Complexity", "## Open questions",
    ].join("\nbody\n");
    expect(sectionProgress(md)).toEqual([true, true, true, true, true, true]);
  });
});

// ---------------------------------------------------------------------------
// mountSpecEntrance
// ---------------------------------------------------------------------------

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

function makeCallbacks(): EntranceCallbacks & {
  onResume: Mock<(draftId: string) => void>;
  onNew: Mock<() => void>;
  onBlank: Mock<() => void>;
  onDismiss: Mock<() => void>;
  deleteDraft: Mock<(id: string) => Promise<void>>;
  onEmptied: Mock<() => void>;
} {
  return {
    onResume: vi.fn<(draftId: string) => void>(),
    onNew: vi.fn<() => void>(),
    onBlank: vi.fn<() => void>(),
    onDismiss: vi.fn<() => void>(),
    deleteDraft: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    onEmptied: vi.fn<() => void>(),
  };
}

describe("mountSpecEntrance", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders brand, draft cards (max 3), CTA, and blank link", () => {
    const drafts = [1, 2, 3, 4, 5].map((n) =>
      makeDraft({ id: `d${n}`, messages: [{ role: "User", content: `Draft ${n}` }] }),
    );
    mountSpecEntrance(host, drafts, makeCallbacks());

    const root = host.querySelector(".spec-entrance");
    expect(root).not.toBeNull();
    expect(root!.querySelector(".spec-entrance-title")!.textContent).toBe("Spec Creator");
    expect(root!.querySelectorAll(".spec-entrance-card").length).toBe(3);
    expect(root!.querySelector(".spec-entrance-cta")!.textContent).toContain("Start a new spec");
    expect(root!.querySelector(".spec-entrance-blank")!.textContent).toContain("blank draft");
  });

  it("renders summary, meta, and progress dots on a card", () => {
    const draft = makeDraft({
      messages: [
        { role: "User", content: "Build the thing" },
        { role: "Assistant", content: "ok" },
      ],
      partial_md: "## Goal\nx\n## Out of scope\ny\n",
    });
    mountSpecEntrance(host, [draft], makeCallbacks());

    const card = host.querySelector(".spec-entrance-card")!;
    expect(card.querySelector(".spec-entrance-card-summary")!.textContent).toBe("Build the thing");
    expect(card.querySelector(".spec-entrance-card-meta")!.textContent).toContain("2 messages");
    const dots = card.querySelectorAll(".spec-entrance-card-dots .dot");
    expect(dots.length).toBe(6);
    expect(card.querySelectorAll(".spec-entrance-card-dots .dot.filled").length).toBe(2);
  });

  it("clicking a card fires onResume with the draft id", () => {
    const cb = makeCallbacks();
    mountSpecEntrance(host, [makeDraft({ id: "resume-me" })], cb);
    (host.querySelector(".spec-entrance-card") as HTMLElement).click();
    expect(cb.onResume).toHaveBeenCalledWith("resume-me");
  });

  it("CTA fires onNew; blank link fires onBlank", () => {
    const cb = makeCallbacks();
    mountSpecEntrance(host, [makeDraft()], cb);
    (host.querySelector(".spec-entrance-cta") as HTMLElement).click();
    expect(cb.onNew).toHaveBeenCalledOnce();
    (host.querySelector(".spec-entrance-blank") as HTMLElement).click();
    expect(cb.onBlank).toHaveBeenCalledOnce();
  });

  it("Escape fires onDismiss; after dismiss() the listener is gone", () => {
    const cb = makeCallbacks();
    const inst = mountSpecEntrance(host, [makeDraft()], cb);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(cb.onDismiss).toHaveBeenCalledTimes(1);

    inst.dismiss();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(cb.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("backdrop click fires onDismiss; clicks inside content do not", () => {
    const cb = makeCallbacks();
    mountSpecEntrance(host, [makeDraft()], cb);
    (host.querySelector(".spec-entrance") as HTMLElement).click();
    expect(cb.onDismiss).toHaveBeenCalledTimes(1);
    (host.querySelector(".spec-entrance-content") as HTMLElement).click();
    expect(cb.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("delete removes the card without resuming; deleting the last card fires onEmptied", async () => {
    const cb = makeCallbacks();
    mountSpecEntrance(
      host,
      [makeDraft({ id: "d1" }), makeDraft({ id: "d2" })],
      cb,
    );

    const delBtns = host.querySelectorAll<HTMLButtonElement>(".spec-entrance-card-del");
    delBtns[0]!.click();
    await vi.waitFor(() => expect(cb.deleteDraft).toHaveBeenCalledWith("d1"));
    expect(cb.onResume).not.toHaveBeenCalled();
    expect(host.querySelectorAll(".spec-entrance-card").length).toBe(1);
    expect(cb.onEmptied).not.toHaveBeenCalled();

    (host.querySelector(".spec-entrance-card-del") as HTMLElement).click();
    await vi.waitFor(() => expect(cb.onEmptied).toHaveBeenCalledOnce());
  });

  it("dismiss() removes the root after the exit fade", () => {
    vi.useFakeTimers();
    const inst = mountSpecEntrance(host, [makeDraft()], makeCallbacks());
    inst.dismiss();
    expect(host.querySelector(".spec-entrance")).not.toBeNull(); // still fading
    vi.advanceTimersByTime(400);
    expect(host.querySelector(".spec-entrance")).toBeNull();
  });

  it("interactions are inert during the exit fade", () => {
    const cb = makeCallbacks();
    const inst = mountSpecEntrance(host, [makeDraft()], cb);
    inst.dismiss();
    (host.querySelector(".spec-entrance-card") as HTMLElement).click();
    (host.querySelector(".spec-entrance-cta") as HTMLElement).click();
    (host.querySelector(".spec-entrance-blank") as HTMLElement).click();
    (host.querySelector(".spec-entrance") as HTMLElement).click();
    expect(cb.onResume).not.toHaveBeenCalled();
    expect(cb.onNew).not.toHaveBeenCalled();
    expect(cb.onBlank).not.toHaveBeenCalled();
    expect(cb.onDismiss).not.toHaveBeenCalled();
  });

  it("dismiss() is idempotent", () => {
    const cb = makeCallbacks();
    const inst = mountSpecEntrance(host, [makeDraft()], cb);
    inst.dismiss();
    expect(() => inst.dismiss()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Sky (canvas) guards — jsdom has no 2d context, so the real context is stubbed.
// ---------------------------------------------------------------------------

// Partial stub covering exactly the calls the sky makes; the cast is justified
// because jsdom provides no CanvasRenderingContext2D implementation at all.
function stub2d(): CanvasRenderingContext2D {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
}

describe("entrance sky", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("mounts without throwing when getContext returns null (jsdom default)", () => {
    expect(() => mountSpecEntrance(host, [makeDraft()], makeCallbacks())).not.toThrow();
  });

  it("prefers-reduced-motion renders a single static frame, no loop", () => {
    const ctx = stub2d();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));

    mountSpecEntrance(host, [makeDraft()], makeCallbacks());
    // Static frame draws synchronously exactly once; an animation loop would
    // draw zero times synchronously (rAF is async).
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
  });

  it("dismiss() cancels the animation loop", () => {
    const ctx = stub2d();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false }));
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame");

    const inst = mountSpecEntrance(host, [makeDraft()], makeCallbacks());
    inst.dismiss();
    expect(cancelSpy).toHaveBeenCalled();
  });
});
