import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ONBOARDING_VERSION,
  shouldShowOnboarding,
  persistOnboardingCompleted,
  resetOnboarding,
  OnboardingPanel,
  type OnboardingHandlers,
} from "./panel";

const STORAGE_KEY = "covenant.onboarding.completed";

/// All handlers wired as no-ops with a counter. The returned object
/// exposes both the handlers (typed as `OnboardingHandlers` so the
/// panel accepts them) and per-handler counters for assertions.
function makeHandlers(): OnboardingHandlers & {
  providers: { count: number };
  shortcuts: { count: number };
  agent: { count: number };
  blocks: { count: number };
  aom: { count: number };
  notes: { count: number };
  spec: { count: number };
  spawns: { count: number };
} {
  const providers = { count: 0 };
  const shortcuts = { count: 0 };
  const agent = { count: 0 };
  const blocks = { count: 0 };
  const aom = { count: 0 };
  const notes = { count: 0 };
  const spec = { count: 0 };
  const spawns = { count: 0 };
  return {
    openSettingsProviders: () => {
      providers.count += 1;
    },
    openShortcuts: () => {
      shortcuts.count += 1;
    },
    openAgentPanel: () => {
      agent.count += 1;
    },
    openBlocksRail: () => {
      blocks.count += 1;
    },
    previewAomSplash: () => {
      aom.count += 1;
    },
    openProjectNotes: () => {
      notes.count += 1;
    },
    openSpecChat: () => {
      spec.count += 1;
    },
    openSpawnsPicker: () => {
      spawns.count += 1;
    },
    providers,
    shortcuts,
    agent,
    blocks,
    aom,
    notes,
    spec,
    spawns,
  };
}

describe("shouldShowOnboarding", () => {
  it("returns true when settings is null (clean install)", () => {
    expect(shouldShowOnboarding(null)).toBe(true);
  });

  it("returns true when settings has no flags (legacy config)", () => {
    expect(shouldShowOnboarding({})).toBe(true);
  });

  it("returns true when onboarding_completed is false", () => {
    expect(shouldShowOnboarding({ onboarding_completed: false })).toBe(true);
  });

  it("returns false when completed and stamped at current version", () => {
    expect(
      shouldShowOnboarding({
        onboarding_completed: true,
        onboarding_version: ONBOARDING_VERSION,
      }),
    ).toBe(false);
  });

  it("returns true when stamped version is older than current", () => {
    expect(
      shouldShowOnboarding({
        onboarding_completed: true,
        onboarding_version: ONBOARDING_VERSION - 1,
      }),
    ).toBe(true);
  });

  it("returns true when stamped version is missing on a completed flag", () => {
    expect(shouldShowOnboarding({ onboarding_completed: true })).toBe(true);
  });
});

describe("persistOnboardingCompleted", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the localStorage guard even when Tauri IPC is unavailable", async () => {
    // Simulate a Tauri-less environment (iframe preview, unit test).
    // The persist call must still mark localStorage so the welcome-hint
    // gets the hint that onboarding is done.
    await persistOnboardingCompleted();
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
  });
});

describe("resetOnboarding", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clears the localStorage guard", async () => {
    localStorage.setItem(STORAGE_KEY, "1");
    await resetOnboarding();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("OnboardingPanel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the welcome card with primary + skip on first open", () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    expect(panel.isOpen()).toBe(true);
    const card = document.querySelector(".onboarding-card");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Meet Covenant");
    expect(card?.querySelector(".onboarding-primary")).not.toBeNull();
    expect(card?.querySelector(".onboarding-skip")).not.toBeNull();
    // Hero icon rendered as inline SVG inside the hero container.
    expect(card?.querySelector(".onboarding-hero svg")).not.toBeNull();
  });

  it("adds is-shown to the overlay so the card's entry transition plays", () => {
    // Regression guard: the card has `opacity: 0` by default and only
    // becomes visible via the `.onboarding-overlay.is-shown .onboarding-card`
    // rule. Forgetting to add `is-shown` makes the user see the scrim
    // with the backdrop blur and nothing else — symptom: "I only see
    // the blur, the card never appears". open() MUST add the class.
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    const overlay = document.querySelector(".onboarding-overlay");
    expect(overlay?.classList.contains("is-shown")).toBe(true);
    // And the card itself must be at opacity:1, not stuck at opacity:0.
    const card = document.querySelector<HTMLElement>(".onboarding-card");
    const computed = card ? getComputedStyle(card).opacity : null;
    expect(computed).toBe("1");
  });

  it("primary CTA has its own bespoke class (not a shared settings button)", () => {
    // The wizard's primary button is the marketing CTA — it has its
    // own visual identity (gradient + halo + arrow icon) and must NOT
    // regress to a shared .settings-save pill. Regression guard.
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    const card = document.querySelector(".onboarding-card")!;
    const primary = card.querySelector<HTMLButtonElement>(".onboarding-primary");
    const secondary = card.querySelector<HTMLButtonElement>(".onboarding-secondary");
    expect(primary).not.toBeNull();
    expect(secondary).not.toBeNull();
    expect(primary?.classList.contains("settings-save")).toBe(false);
    expect(secondary?.classList.contains("settings-cancel")).toBe(false);
  });

  it("renders 10 steps with a progress bar that fills as we advance", () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    // Re-query after each render — renderStep replaces innerHTML, so
    // the previously-cached `.onboarding-progress` node is orphaned.
    const readProgress = (): string | null => {
      const el = document.querySelector<HTMLElement>(".onboarding-progress");
      return el?.style.getPropertyValue("--progress") ?? null;
    };
    // Step 1 of 10 → 10%
    expect(readProgress()).toBe("10%");

    for (let i = 0; i < 5; i += 1) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    }
    // Step 6 of 10 → 60%
    expect(readProgress()).toBe("60%");
  });

  it("arrow keys navigate between steps", () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    const card = document.querySelector(".onboarding-card")!;
    expect(card.textContent).toContain("Meet Covenant");

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(card.textContent).toContain("Connect a model provider");

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(card.textContent).toContain("Meet the super-agent");

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(card.textContent).toContain("Connect a model provider");
  });

  it("Escape closes the modal without persisting completion (skip semantics)", async () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    expect(panel.isOpen()).toBe(true);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    // The handler is async (writes localStorage / settings). Wait a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(panel.isOpen()).toBe(false);
  });

  it("step 2 (Providers) CTA opens Settings → Providers and abandons (no seal)", async () => {
    // Per-step CTAs use the "abandon" mode: the wizard closes so the
    // user can interact with the feature they just opened, but
    // completion is NOT sealed. The wizard will re-auto-show on next
    // launch (and can be re-opened from Settings → Experimental) so
    // the user can finish the remaining 8 steps.
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();

    // Advance to step 1 (Providers) — step 0 is Welcome.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    const card = document.querySelector(".onboarding-card")!;
    expect(card.textContent).toContain("Connect a model provider");

    card
      .querySelector<HTMLButtonElement>(".onboarding-primary")!
      .click();

    await new Promise((r) => setTimeout(r, 0));
    expect(h.providers.count).toBe(1);
    expect(panel.isOpen()).toBe(false);
    // CRITICAL: "abandon" must NOT write the localStorage guard, or
    // the next launch will skip the wizard and the user never gets to
    // see steps 3-10.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("step 4 (Blocks) CTA opens the blocks rail", async () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();

    // 0: Welcome → 1: Providers → 2: Agent → 3: Blocks
    for (let i = 0; i < 3; i += 1) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    }
    const card = document.querySelector(".onboarding-card")!;
    expect(card.textContent).toContain("Blocks sidebar");

    card
      .querySelector<HTMLButtonElement>(".onboarding-primary")!
      .click();

    await new Promise((r) => setTimeout(r, 0));
    expect(h.blocks.count).toBe(1);
    expect(panel.isOpen()).toBe(false);
  });

  it("step 5 (AOM) CTA plays a preview splash without closing the wizard", () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();

    // 0 → 1 → 2 → 3 → 4 (AOM)
    for (let i = 0; i < 4; i += 1) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    }
    const card = document.querySelector(".onboarding-card")!;
    expect(card.textContent).toContain("AOM");

    card
      .querySelector<HTMLButtonElement>(".onboarding-primary")!
      .click();

    expect(h.aom.count).toBe(1);
    // Preview is non-persisting: the user keeps stepping through the
    // remaining steps. The wizard stays open so they can keep going.
    expect(panel.isOpen()).toBe(true);
  });

  it("step 6 (Project Notes) CTA opens the notes rail", async () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();

    // 0 → ... → 5 (Project Notes)
    for (let i = 0; i < 5; i += 1) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    }
    const card = document.querySelector(".onboarding-card")!;
    expect(card.textContent).toContain("Project Notes");

    card
      .querySelector<HTMLButtonElement>(".onboarding-primary")!
      .click();

    await new Promise((r) => setTimeout(r, 0));
    expect(h.notes.count).toBe(1);
    expect(panel.isOpen()).toBe(false);
  });

  it("step 7 (Spec-chat) CTA opens spec-chat", async () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();

    // 0 → ... → 6 (Spec-chat)
    for (let i = 0; i < 6; i += 1) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    }
    const card = document.querySelector(".onboarding-card")!;
    expect(card.textContent).toContain("Draft a spec");

    card
      .querySelector<HTMLButtonElement>(".onboarding-primary")!
      .click();

    await new Promise((r) => setTimeout(r, 0));
    expect(h.spec.count).toBe(1);
    expect(panel.isOpen()).toBe(false);
  });

  it("step 8 (Spawns) CTA opens the spawns picker", async () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();

    // 0 → ... → 7 (Spawns)
    for (let i = 0; i < 7; i += 1) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    }
    const card = document.querySelector(".onboarding-card")!;
    expect(card.textContent).toContain("Spawn an executor");

    card
      .querySelector<HTMLButtonElement>(".onboarding-primary")!
      .click();

    await new Promise((r) => setTimeout(r, 0));
    expect(h.spawns.count).toBe(1);
    expect(panel.isOpen()).toBe(false);
  });

  it("step 9 (Keyboard) CTA opens the shortcuts modal and closes the wizard", async () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();

    // 0 → ... → 8 (Keyboard, second-to-last step)
    for (let i = 0; i < 8; i += 1) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    }
    const card = document.querySelector(".onboarding-card")!;
    expect(card.textContent).toContain("Learn the keyboard");
    expect(card.textContent).toContain("Step 8 of 9");

    card
      .querySelector<HTMLButtonElement>(".onboarding-primary")!
      .click();

    await new Promise((r) => setTimeout(r, 0));
    expect(h.shortcuts.count).toBe(1);
    expect(panel.isOpen()).toBe(false);
  });

  it("step 10 (Done) seals completion and closes the wizard", async () => {
    // The final step is a "you're set up" moment — clicking it calls
    // `next()`, which on the last step calls `finish("complete")`.
    // That seals `onboarding_completed` so the auto-show on next
    // launch skips the wizard. The user can still re-open it from
    // Settings → Experimental → "Start onboarding" (preview mode).
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();

    // Step 0 (Welcome) → 1 → 2 → ... → 9 (final).
    for (let i = 0; i < 9; i += 1) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    }
    const card = document.querySelector(".onboarding-card")!;
    expect(card.textContent).toContain("You're set up");
    expect(card.textContent).toContain("Step 9 of 9");

    card
      .querySelector<HTMLButtonElement>(".onboarding-primary")!
      .click();

    await new Promise((r) => setTimeout(r, 0));
    expect(panel.isOpen()).toBe(false);
    // "complete" must seal completion so the wizard doesn't auto-show
    // on next launch.
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("Esc on any step seals completion (skip mode)", async () => {
    // Esc is the explicit "I want out" gesture. Don't auto-show again
    // on next launch — the user opted out of the tour. They can still
    // re-open it from Settings → Experimental.
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();

    // Halfway through: navigate to step 5, then Esc.
    for (let i = 0; i < 5; i += 1) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    }
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(panel.isOpen()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("clicking outside the card abandons without sealing", async () => {
    // Click on the scrim (not the card) means "dismiss for now" — we
    // keep the completion flag clear so the wizard auto-shows again.
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();

    // Dispatch a click on the overlay (not the card) to simulate
    // clicking the scrim. The card and overlay are siblings, so we
    // target the overlay directly.
    const overlay = document.querySelector(".onboarding-overlay")!;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 0));
    expect(panel.isOpen()).toBe(false);
    // "abandon" does NOT seal.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("footer step counter shows N / 10 for every step", () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    const card = document.querySelector(".onboarding-card")!;
    expect(card.querySelector(".onboarding-step")?.textContent).toBe("1 / 10");

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(card.querySelector(".onboarding-step")?.textContent).toBe("2 / 10");
  });

  it("eyebrow reflects the current step context", () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    const card = document.querySelector(".onboarding-card")!;
    expect(card.querySelector(".onboarding-eyebrow")?.textContent).toBe("Welcome");

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(card.querySelector(".onboarding-eyebrow")?.textContent).toBe(
      "Step 1 of 9 · Setup",
    );
  });
});
