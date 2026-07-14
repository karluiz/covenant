// First-run onboarding — a single welcome card. It introduces Covenant
// and lists the four keys worth knowing, then gets out of the way.
//
// It deliberately does NOT open other panels: a full-screen blurred
// scrim that launches features behind itself is unusable (the feature
// renders dimmed and unreachable underneath), and its global ESC
// handler used to swallow the keystroke meant for whatever panel it
// opened. One card, no choreography, no traps.
//
// Reuses the `release-overlay` / `release-card` chrome from the
// changelog + shortcuts modals so the look-and-feel is consistent.
// Persists completion in the Rust `Settings` struct
// (`onboarding_completed`, `onboarding_version`). A bump of
// `ONBOARDING_VERSION` re-shows the card for existing users.

import { openUrl } from "@tauri-apps/plugin-opener";
import { getSettings, type Settings } from "../api";
import { Icons } from "../icons";
import logoUrl from "../../assets/logo-app.svg";
import { detectOllama, adoptOllama } from "./ollama";
import { adoptFreeKey, GEMINI_KEY_URL, START_GUIDE_URL } from "./freekey";

/// Bump this whenever the card's content changes meaningfully. Existing
/// users with a lower stamped `onboarding_version` see it again once.
/// v2: replaced the broken 9-step panel-opening tour with one card.
export const ONBOARDING_VERSION = 2;

const STORAGE_KEY = "covenant.onboarding.completed";

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

  // Capture-phase ESC. xterm.js's hidden textarea stopPropagation()s
  // keydown on focus, so a bubble-phase handler on window would never
  // see it. Nothing else is open behind this card, so swallowing ESC is
  // safe — it just dismisses the card. (Same pattern as ReleasePanel.)
  private onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void this.finish("skip");
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

    const overlay = document.createElement("div");
    overlay.className = "release-overlay onboarding-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) void this.finish("abandon");
    });

    const card = document.createElement("div");
    card.className = "release-card onboarding-card";
    overlay.appendChild(card);

    this.mountHost.appendChild(overlay);
    this.modal = overlay;
    document.addEventListener("keydown", this.onKeydown, true);
    this.render();

    // Force a reflow so the card's initial state (opacity:0, scale:0.96)
    // is committed before we add `is-shown` — without this the browser
    // batches both states into a single paint and the entry transition
    // never plays. (Same pattern as AOM splash / command palette.)
    void overlay.offsetWidth;
    overlay.classList.add("is-shown");
  }

  close(): void {
    void this.finish("abandon");
  }

  // The four keys worth knowing on day one. Rendered as a compact list,
  // not a guided tour — we tell the user the shortcut, we don't drag a
  // scrim across the feature they can't reach. Each row carries a
  // plain-language line: "super-agent" / "spec" / "AOM" mean nothing
  // to someone who installed the app two minutes ago.
  private static readonly KEYS: Array<{
    keys: string;
    label: string;
    desc: string;
  }> = [
    {
      keys: "⌘K",
      label: "Ask the agent",
      desc: "Chat about anything happening in your terminal",
    },
    {
      keys: "⌘N",
      label: "Draft a spec",
      desc: "Turn an idea into a plan an agent can execute",
    },
    {
      keys: "⌘⇧A",
      label: "Go autonomous",
      desc: "AOM watches your sessions and acts on its own",
    },
    {
      keys: "⌘⇧K",
      label: "All shortcuts",
      desc: "The full keyboard map",
    },
  ];

  private render(): void {
    if (!this.modal) return;
    const card = this.modal.querySelector(".onboarding-card");
    if (!card) return;

    const rows = OnboardingPanel.KEYS.map(
      (k) =>
        `<li class="onboarding-key"><kbd>${esc(k.keys)}</kbd><span class="onboarding-key__text"><span class="onboarding-key__label">${esc(
          k.label,
        )}</span><span class="onboarding-key__desc">${esc(k.desc)}</span></span></li>`,
    ).join("");

    card.innerHTML = `
      <header class="onboarding-header">
        <span class="onboarding-eyebrow">Welcome</span>
        <button type="button" class="onboarding-skip" aria-label="Dismiss">Skip</button>
      </header>
      <div class="onboarding-body">
        <div class="onboarding-hero"><img src="${logoUrl}" alt="" draggable="false" /></div>
        <h2 class="onboarding-title">Meet Covenant</h2>
        <p class="onboarding-copy">An AI-native terminal that watches every command across your tabs and — on your terms — can act on them. A few keys to know:</p>
        <ul class="onboarding-keys">${rows}</ul>
        <div class="onboarding-provider" hidden></div>
      </div>
      <footer class="onboarding-footer">
        <div class="onboarding-actions">
          <button type="button" class="onboarding-secondary">View all shortcuts</button>
          <button type="button" class="onboarding-primary">${Icons.arrowRight(
            { size: 14 },
          )}<span>Got it</span></button>
        </div>
      </footer>
    `;

    card
      .querySelector<HTMLButtonElement>(".onboarding-primary")
      ?.addEventListener("click", () => void this.finish("complete"));
    card
      .querySelector<HTMLButtonElement>(".onboarding-secondary")
      ?.addEventListener("click", () => {
        this.handlers.openShortcuts();
        void this.finish("complete");
      });
    card
      .querySelector<HTMLButtonElement>(".onboarding-skip")
      ?.addEventListener("click", () => void this.finish("skip"));

    void this.offerProviderBootstrap();
  }

  /// Fresh installs have no LLM credentials, so nothing agentic works.
  /// Offer the two zero-COST paths: adopt a locally-running Ollama (if
  /// detected — free, local), and "use a free cloud key" (paste a key
  /// from a provider with a real free tier — we host nothing). Skipped
  /// silently when a provider is already configured — i.e. a version
  /// bump re-showing the card for an existing user.
  private async offerProviderBootstrap(): Promise<void> {
    let settings: Settings;
    try {
      settings = await getSettings();
    } catch {
      return;
    }
    if (hasConfiguredProvider(settings)) return;

    const models = await detectOllama();
    if (!this.modal) return;
    const host = this.modal.querySelector<HTMLElement>(".onboarding-provider");
    if (!host) return;

    // ponytail: adopt the first Ollama model; users with several pick
    // another in Settings → Providers. Add a model picker if it chafes.
    const ollama = models?.[0];
    const ollamaExtra =
      models && models.length > 1
        ? ` <span class="onboarding-provider__more">+${models.length - 1} more</span>`
        : "";
    const ollamaRow = ollama
      ? `<button type="button" class="onboarding-primary onboarding-provider__use" data-act="ollama"><span>Use Ollama · ${esc(ollama)}</span></button>${ollamaExtra}`
      : "";

    host.innerHTML = `
      <div class="onboarding-provider__title">One more thing</div>
      <p class="onboarding-provider__copy">Covenant needs a model to act. Pick a zero-setup option — or add your own key in Settings → Providers.</p>
      <div class="onboarding-provider__actions">
        ${ollamaRow}
        <button type="button" class="onboarding-secondary onboarding-provider__use" data-act="freekey"><span>Use a free cloud key</span></button>
        <a href="#" class="onboarding-provider__help" data-act="guide">How this works →</a>
      </div>
    `;
    host.hidden = false;

    if (ollama) {
      host
        .querySelector<HTMLButtonElement>('[data-act="ollama"]')
        ?.addEventListener("click", (e) =>
          this.runAdopt(e.currentTarget as HTMLButtonElement, () => adoptOllama(ollama)),
        );
    }
    host
      .querySelector<HTMLButtonElement>('[data-act="freekey"]')
      ?.addEventListener("click", () => this.renderFreeKeyForm(host));
    host
      .querySelector<HTMLAnchorElement>('[data-act="guide"]')
      ?.addEventListener("click", (e) => {
        e.preventDefault();
        void openUrl(START_GUIDE_URL);
      });
  }

  /// Swap the banner for a tiny paste-a-free-key form. Gemini's free tier
  /// needs no credit card and rides the existing openai_compat path, so a
  /// fresh install gets a hosted model with zero cost to us.
  private renderFreeKeyForm(host: HTMLElement): void {
    host.innerHTML = `
      <div class="onboarding-provider__title">Use a free cloud key</div>
      <p class="onboarding-provider__copy">Gemini's free tier needs no credit card. <a href="#" class="onboarding-provider__help" data-act="getkey">Get a free key →</a>, paste it below, and the agent runs on it — nothing to host.</p>
      <div class="onboarding-provider__row">
        <input class="onboarding-provider__key" type="password" placeholder="Paste your Gemini API key" autocomplete="off" spellcheck="false" />
        <button type="button" class="onboarding-primary onboarding-provider__use" data-act="savekey"><span>Save &amp; start</span></button>
      </div>
    `;

    host
      .querySelector<HTMLAnchorElement>('[data-act="getkey"]')
      ?.addEventListener("click", (e) => {
        e.preventDefault();
        void openUrl(GEMINI_KEY_URL);
      });

    const input = host.querySelector<HTMLInputElement>(".onboarding-provider__key");
    const save = host.querySelector<HTMLButtonElement>('[data-act="savekey"]');
    const submit = () => {
      const key = input?.value.trim();
      if (!key) {
        input?.focus();
        return;
      }
      this.runAdopt(save!, () => adoptFreeKey(key));
    };
    save?.addEventListener("click", submit);
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    setTimeout(() => input?.focus(), 0);
  }

  /// Shared button-state machine for a provider-adoption action: disable,
  /// show progress, finish the card on success, offer retry on failure.
  private runAdopt(btn: HTMLButtonElement, adopt: () => Promise<void>): void {
    const label = btn.querySelector("span")!;
    btn.disabled = true;
    label.textContent = "Setting up…";
    void adopt()
      .then(() => this.finish("complete"))
      .catch(() => {
        btn.disabled = false;
        label.textContent = "Retry";
      });
  }

  /// Close the card and optionally seal completion.
  ///
  /// - `"abandon"` — close without sealing (scrim click). Auto-show on
  ///   next launch still fires.
  /// - `"skip"` — close AND seal (Esc, Skip).
  /// - `"complete"` — close AND seal ("Got it" / "View all shortcuts").
  private async finish(mode: "abandon" | "skip" | "complete"): Promise<void> {
    if (this.modal) {
      document.removeEventListener("keydown", this.onKeydown, true);
      this.modal.remove();
      this.modal = null;
    }
    if (mode !== "abandon") await persistOnboardingCompleted();
  }
}

/// True when any provider already has a usable credential or endpoint.
/// A clean install seeds only a keyless Anthropic entry (api_key null,
/// base_url null), so this returns false there — which is exactly when
/// we want to offer Ollama. Pure, no DOM.
export function hasConfiguredProvider(
  settings: Pick<Settings, "providers"> | null,
): boolean {
  const providers = settings?.providers;
  if (!providers) return false;
  return Object.values(providers).some(
    (p) => Boolean(p.api_key?.trim()) || Boolean(p.base_url?.trim()),
  );
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
