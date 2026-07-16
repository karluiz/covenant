import { chordKeys, type ChordKey } from "../platform";
import type { Terminal } from "@xterm/xterm";

const DISMISS_KEY = "covenant.welcome-hint-dismissed";
// Onboarding completion flips this key as well (see
// ui/src/onboarding/panel.ts → persistOnboardingCompleted). The hint is
// redundant once the user has gone through the 4-step wizard, so we
// suppress it on either signal.
const ONBOARDING_KEY = "covenant.onboarding.completed";

// Live hints, so non-keyboard activity (spawning an executor, running a
// command) can dismiss them too — onKey alone misses those paths.
const live = new Set<(persist: boolean) => void>();

/** Dismiss any visible welcome hint(s) without persisting. */
export function dismissWelcomeHint(): void {
  for (const remove of [...live]) remove(false);
}

// Curated for a fresh session — the few shortcuts worth knowing before you
// type anything. Modifier tokens resolve per-platform via `chordKeys`; the
// actual handlers key off metaKey on macOS — Windows key handling is M8.
const ROWS: { keys: ChordKey[]; label: string }[] = [
  { keys: ["mod", "K"], label: "ask the super-agent what's going on" },
  { keys: ["mod", "shift", "O"], label: "set an operator for this tab" },
  { keys: ["mod", "P"], label: "search history & recall commands" },
  { keys: ["mod", "M"], label: "set a spec for this session" },
  { keys: ["mod", "shift", "K"], label: "see all keyboard shortcuts" },
];

/**
 * Overlay a one-time Warp-style hint card on a freshly spawned terminal.
 * Non-blocking: the card ignores pointer events (only the dismiss link is
 * clickable) so terminal focus/typing pass straight through. It self-removes
 * on the first keystroke; "Don't show again" persists the dismissal.
 */
export function mountWelcomeHint(host: HTMLElement, term: Terminal): void {
  // Suppressed if the user has gone through the onboarding wizard OR
  // previously hit "Don't show again" on this hint.
  if (localStorage.getItem(DISMISS_KEY) === "1") return;
  if (localStorage.getItem(ONBOARDING_KEY) === "1") return;

  const card = document.createElement("div");
  card.className = "term-welcome";
  card.innerHTML = `
    <div class="term-welcome-title">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none"
          stroke="currentColor" stroke-width="1.4"/>
        <path d="M4 6l2.5 2L4 10" fill="none" stroke="currentColor"
          stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M8 10h4" stroke="currentColor" stroke-width="1.4"
          stroke-linecap="round"/>
      </svg>
      <span>New terminal session</span>
    </div>
    <ul class="term-welcome-rows">
      ${ROWS.map(
        (r) =>
          `<li><span class="term-welcome-keys">${chordKeys(r.keys)
            .map((k) => `<kbd>${k}</kbd>`)
            .join("")}</span><span class="term-welcome-label">${r.label}</span></li>`,
      ).join("")}
    </ul>
    <button type="button" class="term-welcome-dismiss">Don't show again</button>
  `;

  let disposed = false;
  let keyDisposable: { dispose(): void } | null = null;
  const remove = (persist: boolean): void => {
    if (disposed) return;
    disposed = true;
    live.delete(remove);
    if (persist) localStorage.setItem(DISMISS_KEY, "1");
    keyDisposable?.dispose();
    card.remove();
  };
  live.add(remove);

  card
    .querySelector(".term-welcome-dismiss")
    ?.addEventListener("click", () => remove(true));

  // First keystroke = user is working; get out of the way (no persist).
  keyDisposable = term.onKey(() => remove(false));

  host.appendChild(card);
}
