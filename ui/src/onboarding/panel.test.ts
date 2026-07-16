import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ONBOARDING_VERSION,
  shouldShowOnboarding,
  persistOnboardingCompleted,
  resetOnboarding,
  hasConfiguredProvider,
  OnboardingPanel,
  type OnboardingHandlers,
} from "./panel";

const STORAGE_KEY = "covenant.onboarding.completed";

describe("hasConfiguredProvider", () => {
  it("is false for a clean install (keyless anthropic only)", () => {
    expect(
      hasConfiguredProvider({
        providers: { anthropic: { kind: "anthropic", label: "Anthropic", api_key: null, base_url: null } },
      } as never),
    ).toBe(false);
  });
  it("is false with no providers", () => {
    expect(hasConfiguredProvider({ providers: undefined } as never)).toBe(false);
  });
  it("is true once a key is set", () => {
    expect(
      hasConfiguredProvider({
        providers: { anthropic: { kind: "anthropic", label: "Anthropic", api_key: "sk-x" } },
      } as never),
    ).toBe(true);
  });
  it("is true once a local endpoint is configured", () => {
    expect(
      hasConfiguredProvider({
        providers: { ollama: { kind: "openai_compat", label: "Ollama", base_url: "http://localhost:11434/v1" } },
      } as never),
    ).toBe(true);
  });
});

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

  it("renders a single welcome card with primary + skip + shortcut list", () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    expect(panel.isOpen()).toBe(true);
    const card = document.querySelector(".onboarding-card");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Meet Covenant");
    expect(card?.querySelector(".onboarding-primary")).not.toBeNull();
    expect(card?.querySelector(".onboarding-skip")).not.toBeNull();
    // Hero renders the real app mark (logo-app.svg) as an <img>.
    expect(card?.querySelector(".onboarding-hero img")).not.toBeNull();
    // The four keys are listed as <kbd> rows — no panel-opening choreography.
    expect(card?.querySelectorAll(".onboarding-key").length).toBe(4);
    // jsdom's UA is never an Apple one, so the card spells the modifier
    // out. Asserting the glyph here would only ever pass on macOS.
    expect(card?.textContent).toContain("CtrlK");
  });


  it("adds is-shown to the overlay so the card's entry transition plays", () => {
    // Regression guard: the card has `opacity: 0` by default and only
    // becomes visible via the `.onboarding-overlay.is-shown .onboarding-card`
    // rule. Forgetting to add `is-shown` makes the user see the scrim
    // with the backdrop blur and nothing else. open() MUST add the class.
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    const overlay = document.querySelector(".onboarding-overlay");
    expect(overlay?.classList.contains("is-shown")).toBe(true);
    const card = document.querySelector<HTMLElement>(".onboarding-card");
    const computed = card ? getComputedStyle(card).opacity : null;
    expect(computed).toBe("1");
  });

  it("buttons keep their bespoke classes (not shared settings pills)", () => {
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

  it("'Got it' seals completion and closes the card", async () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    document
      .querySelector<HTMLButtonElement>(".onboarding-primary")!
      .click();
    await new Promise((r) => setTimeout(r, 0));
    expect(panel.isOpen()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("'View all shortcuts' opens the shortcuts modal and seals completion", async () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    document
      .querySelector<HTMLButtonElement>(".onboarding-secondary")!
      .click();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.shortcuts.count).toBe(1);
    expect(panel.isOpen()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("Escape closes the card and seals completion (skip)", async () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    expect(panel.isOpen()).toBe(true);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(panel.isOpen()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("Skip button closes the card and seals completion", async () => {
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();
    document.querySelector<HTMLButtonElement>(".onboarding-skip")!.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(panel.isOpen()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
  });

  it("clicking outside the card abandons without sealing", async () => {
    // Click on the scrim (not the card) means "dismiss for now" — keep
    // the completion flag clear so the card auto-shows again.
    const h = makeHandlers();
    const panel = new OnboardingPanel(document.body, h);
    panel.open();

    const overlay = document.querySelector(".onboarding-overlay")!;
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(panel.isOpen()).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
