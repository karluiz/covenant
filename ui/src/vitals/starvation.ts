/// Event-loop starvation sampling for the window right after a tab reveal —
/// the stretch the activation metric itself cannot see, where a repaint or a
/// write backlog can still leave the terminal frozen.
///
/// The measurement is only meaningful while the window is actually visible:
/// WebKit throttles background timers to ~1s and suspends rAF entirely when
/// the window is occluded, which turns an idle app into a fake multi-second
/// stall (observed live: "spikes" pegged at 1013/965/963ms — the throttle
/// interval, not the main thread). When that happens the sample is
/// unmeasurable, so we report `null` rather than fabricate a number.

export interface StarvationProbeOptions {
  tickMs?: number;
  ticks?: number;
  /// Injected for tests; defaults to the real clock / scheduler / visibility.
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
  isVisible?: () => boolean;
}

const defaultIsVisible = (): boolean =>
  typeof document === "undefined" ? true : document.visibilityState === "visible";

export function probePostRevealStarvation(
  onDone: (starvedMs: number | null) => void,
  opts: StarvationProbeOptions = {},
): void {
  const tickMs = opts.tickMs ?? 50;
  const ticks = opts.ticks ?? 20;
  const now = opts.now ?? (() => performance.now());
  const schedule = opts.schedule ?? ((fn, ms) => void window.setTimeout(fn, ms));
  const isVisible = opts.isVisible ?? defaultIsVisible;

  let starved = 0;
  let last = now();
  let n = 0;
  const tick = (): void => {
    if (!isVisible()) {
      onDone(null); // throttled/suspended — unmeasurable, never guess
      return;
    }
    const t = now();
    starved += Math.max(0, t - last - tickMs);
    last = t;
    if (++n >= ticks) {
      onDone(Math.round(starved));
      return;
    }
    schedule(tick, tickMs);
  };
  schedule(tick, tickMs);
}
