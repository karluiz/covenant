import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ONBOARDING_VERSION,
  shouldShowOnboarding,
  persistOnboardingCompleted,
  resetOnboarding,
  OnboardingPanel,
} from "./panel";

const STORAGE_KEY = "covenant.onboarding.completed";

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
    const calls: string[] = [];
    const panel = new OnboardingPanel(document.body, {
      openSettingsProviders: () => {
        calls.push("providers");
      },
      openShortcuts: () => {
        calls.push("shortcuts");
      },
      openAgentPanel: () => {
        calls.push("agent");
      },
    });
    panel.open();
    expect(panel.isOpen()).toBe(true);
    const card = document.querySelector(".onboarding-card");
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Welcome to Covenant");
    expect(card?.querySelector(".onboarding-primary")).not.toBeNull();
    expect(card?.querySelector(".onboarding-skip")).not.toBeNull();
  });

  it("arrow keys navigate between steps", () => {
    const panel = new OnboardingPanel(document.body, {
      openSettingsProviders: () => undefined,
      openShortcuts: () => undefined,
      openAgentPanel: () => undefined,
    });
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
    const panel = new OnboardingPanel(document.body, {
      openSettingsProviders: () => undefined,
      openShortcuts: () => undefined,
      openAgentPanel: () => undefined,
    });
    panel.open();
    expect(panel.isOpen()).toBe(true);

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    // The handler is async (writes localStorage / settings). Wait a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(panel.isOpen()).toBe(false);
  });

  it("step 2 CTA opens Settings → Providers and persists completion", async () => {
    let providersOpened = 0;
    const panel = new OnboardingPanel(document.body, {
      openSettingsProviders: () => {
        providersOpened += 1;
      },
      openShortcuts: () => undefined,
      openAgentPanel: () => undefined,
    });
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
    expect(providersOpened).toBe(1);
    expect(panel.isOpen()).toBe(false);
    // localStorage guard written even without Tauri.
    expect(localStorage.getItem(STORAGE_KEY)).toBe("1");
  });
});
