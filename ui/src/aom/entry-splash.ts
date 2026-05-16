// Brief takeover animation that plays when the user enters AOM
// (⌘⇧A from off → on). Communicates a hard mode change: the Operator
// is now driving every tab autonomously, the budget is ticking.
//
// Fires from the keyboard handler in main.ts AFTER `aomBanner.toggle()`
// resolves with `enabled: true` AND the previous state was off — so it
// never fires on app boot (hydrate restoring an already-on AOM) or on
// programmatic stops/auto-stops. Pure UI; no backend coupling.
//
// Honors `prefers-reduced-motion`: collapses the dramatic scale +
// glow + cascade into a quiet 350ms opacity flash so users who've
// opted out of motion don't get hit with a takeover splash.

import type { AomStatus } from "../api";
import { Icons } from "../icons";

/// Total wall-clock time of the splash, including in/hold/out.
/// Tuned to feel like a "beat" — long enough to register the mode
/// change AND read the budget meta line, short enough that toggling
/// AOM repeatedly doesn't feel like punishment. The cascade itself
/// takes ~420ms (icon → headline → sub → meta with staggered delays);
/// we want a real "settled" window after that so the meta line
/// ("$10 budget · …") is actually readable, not glimpsed.
const FULL_DURATION_MS = 1700;
const REDUCED_DURATION_MS = 500;

/// How long to hold the fully-settled splash on screen after the
/// cascade-in finishes, before the exit transition starts. With the
/// cascade ending at ~420ms post-mount, a 1100ms hold gives ~700ms
/// of stable readable view — enough for the eye to land on the meta
/// line without forcing a re-read.
const FULL_HOLD_MS = 1100;
const FULL_EXIT_MS = 280;

let activeOverlay: HTMLElement | null = null;

/// Play the entry splash. Idempotent: if a splash is already on
/// screen (rapid double-tap), the existing one is dismissed first
/// so we never stack two overlays.
export function playAomEntrySplash(status: AomStatus): Promise<void> {
  // Tear down any in-flight splash before mounting a new one.
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }

  const reduced = prefersReducedMotion();
  const duration = reduced ? REDUCED_DURATION_MS : FULL_DURATION_MS;

  const overlay = document.createElement("div");
  overlay.className = `aom-splash${reduced ? " aom-splash-reduced" : ""}`;
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.innerHTML = `
    <div class="aom-splash-scrim" aria-hidden="true"></div>
    <div class="aom-splash-card">
      <div class="aom-splash-icon">${Icons.zap({ size: 64 })}</div>
      <div class="aom-splash-headline">AOM ENGAGED</div>
      <div class="aom-splash-sub">Autonomous Operator Mode</div>
      <div class="aom-splash-meta">
        ${formatBudget(status.budget_usd)} budget · all tabs included · <kbd>⌘⇧A</kbd> to stop
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activeOverlay = overlay;

  // Force a reflow so the initial state (opacity:0, scale:0.7) is
  // committed before we add the `is-shown` class — without this the
  // browser would batch both states into a single paint and skip the
  // transition entirely.
  void overlay.offsetWidth;
  overlay.classList.add("is-shown");

  return new Promise<void>((resolve) => {
    // Hold, then schedule the exit transition. Reduced-motion users
    // get a flat shorter hold (no cascade, less to register) so the
    // splash doesn't outstay its welcome.
    const holdMs = reduced ? duration - 220 : FULL_HOLD_MS;
    const exitMs = reduced ? 220 : FULL_EXIT_MS;
    window.setTimeout(() => {
      overlay.classList.add("is-leaving");
      window.setTimeout(() => {
        if (activeOverlay === overlay) activeOverlay = null;
        overlay.remove();
        resolve();
      }, exitMs);
    }, holdMs);
  });
}

/// Synchronous accessor for active state — exported in case the
/// caller wants to skip wiring something behind a splash that's
/// currently playing (e.g. focusing the terminal).
export function isAomSplashPlaying(): boolean {
  return activeOverlay !== null;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function formatBudget(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  // Avoid trailing zeros for whole-dollar values: "$10" not "$10.00".
  return usd === Math.floor(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/// Exit splash — mirror of `playAomEntrySplash` for the off-transition.
/// Visual identity: muted/cool (no coral, no pulse) so the eye reads
/// "we're back to normal mode". Meta line summarizes the run that
/// just ended: duration · decisions · spent.
///
/// Wired only to the user-initiated stop (⌘⇧A with AOM on). The
/// auto-stop-on-budget path stays with its existing toast (which
/// click-routes to the morning report) — adding a splash there too
/// would be two surfaces for the same event.
export function playAomExitSplash(status: AomStatus): Promise<void> {
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }

  const reduced = prefersReducedMotion();

  const overlay = document.createElement("div");
  overlay.className = `aom-splash aom-splash-exit${reduced ? " aom-splash-reduced" : ""}`;
  overlay.setAttribute("role", "status");
  overlay.setAttribute("aria-live", "polite");
  overlay.innerHTML = `
    <div class="aom-splash-scrim" aria-hidden="true"></div>
    <div class="aom-splash-card">
      <div class="aom-splash-icon">${Icons.zap({ size: 64 })}</div>
      <div class="aom-splash-headline">AOM STOPPED</div>
      <div class="aom-splash-sub">${formatRunSummary(status)}</div>
      <div class="aom-splash-meta">
        See the AOM panel for the morning report.
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  activeOverlay = overlay;

  void overlay.offsetWidth;
  overlay.classList.add("is-shown");

  return new Promise<void>((resolve) => {
    // Slightly shorter hold than entry — closure is easier to register
    // than a mode change. Still long enough to read the run summary.
    const holdMs = reduced ? REDUCED_DURATION_MS - 220 : 850;
    const exitMs = reduced ? 220 : FULL_EXIT_MS;
    window.setTimeout(() => {
      overlay.classList.add("is-leaving");
      window.setTimeout(() => {
        if (activeOverlay === overlay) activeOverlay = null;
        overlay.remove();
        resolve();
      }, exitMs);
    }, holdMs);
  });
}

/// "Ran 14m · 23 decisions · $4.21 spent". Falls back gracefully when
/// any field is missing — a no-decisions run is still useful info.
function formatRunSummary(status: AomStatus): string {
  const parts: string[] = [];
  if (status.started_at_unix_ms > 0) {
    parts.push(`Ran ${formatDuration(Date.now() - status.started_at_unix_ms)}`);
  }
  const decisions = status.decisions_count;
  parts.push(
    decisions === 0
      ? "no decisions"
      : `${decisions} decision${decisions === 1 ? "" : "s"}`,
  );
  parts.push(`${formatCost(status.accumulated_cost_usd)} spent`);
  return parts.join(" · ");
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}

function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  // Sub-cent runs round to "$0" which reads odd — show 2 decimals
  // for anything > 0 so even a $0.03 run is faithful.
  return `$${usd.toFixed(2)}`;
}
