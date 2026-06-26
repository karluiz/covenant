// First-run onboarding wizard — 4 steps that push the user to the
// features that drive adoption (API key, super-agent ⌘K, keyboard
// shortcuts) and reuses the `release-overlay` / `release-card` chrome
// from the changelog + shortcuts modals so the look-and-feel is
// consistent with the rest of the app.
//
// Persists completion in the Rust `Settings` struct
// (`onboarding_completed`, `onboarding_version`). A bump of
// `ONBOARDING_VERSION` re-shows the wizard for users who already
// completed an older version of it.

import { getSettings, type Settings } from "../api";

/// Bump this whenever the wizard's content changes meaningfully. Existing
/// users with a lower stamped `onboarding_version` will see the wizard
/// again on the next launch.
export const ONBOARDING_VERSION = 1;

const STORAGE_KEY = "covenant.onboarding.completed";

type Step = {
  title: string;
  body: string;
  cta: { label: string; run: () => void; persist: boolean } | null;
  secondary: { label: string; run: () => void } | null;
};

export type OnboardingHandlers = {
  openSettingsProviders: () => Promise<void> | void;
  openShortcuts: () => void;
  openAgentPanel: () => void;
  /// Open the OSC 133 blocks rail on the right. The rail is folded by
  /// default on first paint so users never see it unless they ask.
  openBlocksRail: () => void;
  /// Play a one-shot preview of the AOM entry splash with a synthetic
  /// status. The wizard does NOT actually engage AOM — the real
  /// engage is bound to ⌘⇧A, surfaced in the step copy.
  previewAomSplash: () => void;
  /// Open the Project Notes drawer for the active group.
  openProjectNotes: () => void;
  /// Open the Spec-chat entrance (the "Constellation" canvas for AI
  /// spec drafting → mission).
  openSpecChat: () => void;
  /// Open the spawns picker so the user can see configured executors
  /// (Claude Code, Codex, Pi, etc.) and quick-spawn one.
  openSpawnsPicker: () => void;
};

/// Returns true when the wizard should auto-open. False on a clean
/// install, on version bumps, or when the user has previously completed
/// the current version. Pure function — no DOM, easy to unit-test.
export function shouldShowOnboarding(
  settings: Pick<Settings, "onboarding_completed" | "onboarding_version"> | null,
): boolean {
  const completed = settings?.onboarding_completed ?? false;
  const stamped = settings?.onboarding_version ?? 0;
  if (!completed) return true;
  if (stamped < ONBOARDING_VERSION) return true;
  return false;
}

/// Mark the wizard as completed at the current `ONBOARDING_VERSION`.
/// We mirror the value in `localStorage` as a fast-path guard for the
/// `welcome-hint` overlay (it runs before the backend roundtrip) and
/// persist the canonical state in the Rust `Settings` struct via
/// `set_settings`. We re-read the current settings before writing so we
/// don't clobber unrelated fields the user might have changed.
export async function persistOnboardingCompleted(): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* private mode / storage full — fine to skip */
  }
  try {
    const current = await getSettings();
    await invokeSetSettings({
      ...current,
      onboarding_completed: true,
      onboarding_version: ONBOARDING_VERSION,
    });
  } catch (err) {
    // The Rust side may be unreachable in iframe previews / tests.
    // localStorage flag is the next-best signal.
    // eslint-disable-next-line no-console
    console.warn("covenant: failed to persist onboarding completion", err);
  }
}

/// Re-arm the wizard (Settings → "Show tour again"). Clears the
/// completion flag locally so the welcome-hint also comes back.
export async function resetOnboarding(): Promise<void> {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* fine */
  }
  try {
    const current = await getSettings();
    await invokeSetSettings({
      ...current,
      onboarding_completed: false,
      onboarding_version: 0,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("covenant: failed to reset onboarding", err);
  }
}

async function invokeSetSettings(settings: Settings): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_settings", { settings });
}

export class OnboardingPanel {
  private modal: HTMLElement | null = null;
  private stepIndex = 0;

  // Capture-phase ESC + arrow keys. xterm.js's hidden textarea
  // stopPropagation()s keydown on focus, so a bubble-phase handler on
  // window would never see them. Same pattern as ReleasePanel /
  // ShortcutsPanel.
  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void this.finish(false);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      this.next();
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      this.prev();
    }
  };

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly handlers: OnboardingHandlers,
  ) {}

  isOpen(): boolean {
    return this.modal !== null;
  }

  open(): void {
    if (this.isOpen()) return;
    this.stepIndex = 0;

    const overlay = document.createElement("div");
    overlay.className = "release-overlay onboarding-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) void this.finish(false);
    });

    const card = document.createElement("div");
    card.className = "release-card onboarding-card";
    overlay.appendChild(card);

    this.mountHost.appendChild(overlay);
    this.modal = overlay;
    document.addEventListener("keydown", this.onKeydown, true);
    this.renderStep();
  }

  close(): void {
    void this.finish(true);
  }

  private next(): void {
    const steps = this.buildSteps();
    if (this.stepIndex < steps.length - 1) {
      this.stepIndex += 1;
      this.renderStep();
    } else {
      void this.finish(true);
    }
  }

  private prev(): void {
    if (this.stepIndex > 0) {
      this.stepIndex -= 1;
      this.renderStep();
    }
  }

  private buildSteps(): Step[] {
    const h = this.handlers;
    return [
      {
        title: "Welcome to Covenant",
        body: "Covenant is an AI-native terminal that watches every command you run across all tabs, can answer questions about what's going on, and — under your explicit policy — can type on your behalf. A short tour will get you from install to first magic moment in nine steps.",
        cta: { label: "Take the tour", run: () => this.next(), persist: false },
        secondary: { label: "Skip for now", run: () => void this.finish(false) },
      },
      {
        title: "Connect a model provider",
        body: "Covenant is BYOK: you bring your own Anthropic, OpenAI, OpenRouter, or local-Ollama key. The super-agent, Operator decisions, and AOM all use whatever you configure here.",
        cta: {
          label: "Open Settings → Providers",
          run: () => {
            void h.openSettingsProviders();
            void this.finish(true);
          },
          persist: true,
        },
        secondary: { label: "Back", run: () => this.prev() },
      },
      {
        title: "Meet the super-agent",
        body: "Press ⌘K from anywhere to ask natural-language questions about your sessions, errors, and recent commands. The agent streams an explanation and proposes the next command when it makes sense.",
        cta: {
          label: "Open super-agent (⌘K)",
          run: () => {
            h.openAgentPanel();
            void this.finish(true);
          },
          persist: true,
        },
        secondary: { label: "Back", run: () => this.prev() },
      },
      {
        title: "See the Blocks sidebar",
        body: "Every command you run becomes a structured block in the right rail — exit-code color, click-to-copy, right-click actions, and an inline fix-proposal from the agent when something fails. The rail is folded by default so first paint stays calm.",
        cta: {
          label: "Open Blocks rail",
          run: () => {
            h.openBlocksRail();
            void this.finish(true);
          },
          persist: true,
        },
        secondary: { label: "Back", run: () => this.prev() },
      },
      {
        title: "Try AOM in preview",
        body: "AOM (Autonomous Operator Mode) is Covenant's overnight posture: a single ⌘⇧A engage turns the Operator loose across all tabs under a USD budget cap, then writes a morning report. We'll preview the engage splash now — AOM itself stays off until you press ⌘⇧A for real.",
        cta: {
          label: "Preview AOM splash",
          run: () => {
            h.previewAomSplash();
          },
          persist: false,
        },
        secondary: { label: "Back", run: () => this.prev() },
      },
      {
        title: "Open Project Notes",
        body: "Project Notes (⌘⇧J) is a per-group scratchpad with five tabs: Commands, Prompts, Notes, Docs, and Drafts. The Drafts tab is the on-ramp to Spec-chat — every spec you publish lands here as a draft that becomes a tab mission.",
        cta: {
          label: "Open Project Notes",
          run: () => {
            h.openProjectNotes();
            void this.finish(true);
          },
          persist: true,
        },
        secondary: { label: "Back", run: () => this.prev() },
      },
      {
        title: "Draft a spec with AI",
        body: "Press ⌘N to open the Spec-chat entrance — a guided dialogue where the model helps you turn a vague goal into a structured spec (Goal, Acceptance criteria, Complexity, etc.). Published specs become tab missions the Operator uses to gate its decisions.",
        cta: {
          label: "Open Spec-chat (⌘N)",
          run: () => {
            h.openSpecChat();
            void this.finish(true);
          },
          persist: true,
        },
        secondary: { label: "Back", run: () => this.prev() },
      },
      {
        title: "Spawn an executor",
        body: "The Spawns chip in the titlebar launches Claude Code, Codex, Pi, or any other configured executor into the active PTY. Click the caret to pick, click the play button to quick-run. Ctrl+1..9 are the keyboard shortcuts.",
        cta: {
          label: "Open spawns picker",
          run: () => {
            h.openSpawnsPicker();
            void this.finish(true);
          },
          persist: true,
        },
        secondary: { label: "Back", run: () => this.prev() },
      },
      {
        title: "Learn the keyboard",
        body: "Everything in Covenant is reachable from the keyboard. The shortcuts modal groups them by Navigation, Tabs, Panels, Operator & AI, AOM, and Misc — open it any time.",
        cta: {
          label: "Show all shortcuts",
          run: () => {
            h.openShortcuts();
            void this.finish(true);
          },
          persist: true,
        },
        secondary: { label: "Back", run: () => this.prev() },
      },
    ];
  }

  private renderStep(): void {
    if (!this.modal) return;
    const steps = this.buildSteps();
    const step = steps[this.stepIndex]!;
    const total = steps.length;
    const card = this.modal.querySelector(".onboarding-card");
    if (!card) return;

    const dots = steps
      .map(
        (_, i) =>
          `<span class="onboarding-dot${
            i === this.stepIndex ? " is-active" : ""
          }"></span>`,
      )
      .join("");

    const cta = step.cta
      ? `<button type="button" class="onboarding-primary settings-save">${esc(
          step.cta.label,
        )}</button>`
      : "";
    const secondary = step.secondary
      ? `<button type="button" class="onboarding-secondary settings-cancel">${esc(
          step.secondary.label,
        )}</button>`
      : "";

    card.innerHTML = `
      <header class="release-header">
        <div>
          <h2>${esc(step.title)}</h2>
          <small class="release-subtitle">Step ${this.stepIndex + 1} of ${total} · ${
            this.stepIndex + 1 === total ? "last step" : "use ← → to navigate"
          }</small>
        </div>
        <button type="button" class="release-close onboarding-skip" aria-label="Skip onboarding">Skip</button>
      </header>
      <div class="release-body onboarding-body">
        <p>${esc(step.body)}</p>
      </div>
      <footer class="onboarding-footer">
        <div class="onboarding-dots">${dots}</div>
        <div class="onboarding-actions">${secondary}${cta}</div>
      </footer>
    `;

    card
      .querySelector<HTMLButtonElement>(".onboarding-primary")
      ?.addEventListener("click", () => step.cta?.run());
    card
      .querySelector<HTMLButtonElement>(".onboarding-secondary")
      ?.addEventListener("click", () => step.secondary?.run());
    card
      .querySelector<HTMLButtonElement>(".onboarding-skip")
      ?.addEventListener("click", () => void this.finish(false));
  }

  private async finish(closeHost: boolean): Promise<void> {
    if (this.modal) {
      document.removeEventListener("keydown", this.onKeydown, true);
      this.modal.remove();
      this.modal = null;
    }
    if (closeHost) await persistOnboardingCompleted();
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
