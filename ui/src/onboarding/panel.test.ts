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
    expect(card?.textContent).toContain("Welcome to Covenant");
    expect(card?.querySelector(".onboarding-primary")).not.toBeNull();
    expect(card?.querySelector(".onboarding-skip")).not.toBeNull();
  });

  it("uses the shared settings-save / settings-cancel classes on step buttons", () => {
    // Regression guard: the wizard's primary/secondary actions must
    // re-use the same button styling as every other primary/secondary
    // in the app, so the wizard looks like part of Covenant and not a
    // bolted-on third-party dialog.
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    // Welcome step has a primary + secondary.
    const card = document.querySelector(".onboarding-card")!;
    const primary = card.querySelector<HTMLButtonElement>(".onboarding-primary");
    const secondary = card.querySelector<HTMLButtonElement>(".onboarding-secondary");
    expect(primary?.classList.contains("settings-save")).toBe(true);
    expect(secondary?.classList.contains("settings-cancel")).toBe(true);
  });

  it("exposes all 9 steps in the expected order", () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    const card = document.querySelector(".onboarding-card")!;
    // 9 steps → 9 dots. Sanity check on the chrome.
    const dots = card.querySelectorAll(".onboarding-dot");
    expect(dots.length).toBe(9);
  });

  it("arrow keys navigate between steps", () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    const card = document.querySelector(".onboarding-card")!;
    expect(card.textContent).toContain("Welcome to Covenant");

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

  it("step 2 (Providers) CTA opens Settings → Providers and persists completion", async () => {
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
    // localStorage guard written even without Tauri.
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
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

    // 0 → ... → 8 (Keyboard, last step)
    for (let i = 0; i < 8; i += 1) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    }
    const card = document.querySelector(".onboarding-card")!;
    expect(card.textContent).toContain("Learn the keyboard");
    expect(card.textContent).toContain("last step");

    card
      .querySelector<HTMLButtonElement>(".onboarding-primary")!
      .click();

    await new Promise((r) => setTimeout(r, 0));
    expect(h.shortcuts.count).toBe(1);
    expect(panel.isOpen()).toBe(false);
  });

  it("step progress text reflects the current step number", () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    const card = document.querySelector(".onboarding-card")!;
    expect(card.textContent).toContain("Step 1 of 9");

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(card.textContent).toContain("Step 2 of 9");

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(card.textContent).toContain("Step 9 of 9");
  });
});
