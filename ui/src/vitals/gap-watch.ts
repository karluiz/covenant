/// Measures event-loop health across an open-ended window — used for the gap
/// between activate()'s synchronous body and the frame in which the revealed
/// pane actually paints.
///
/// Why this exists: real 0.11.5 data shows that gap running 228ms at BEST and
/// up to 1379ms, with the synchronous work at ~15ms and post-reveal starvation
/// healthy. That leaves two very different causes which look identical from
/// outside — the main thread busy with rendering work (timers would also run
/// late), or frames not being produced while the loop stays responsive
/// (timers on time). This tells them apart.
///
/// Unlike `probePostRevealStarvation` this has no fixed tick budget: the
/// caller stops it when the paint frame arrives.

export interface GapWatchOptions {
  tickMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
}

export interface GapWatchResult {
  /// Total time the timer chain ran late — high means the main thread was
  /// busy, near-zero means frames stalled while the loop stayed free.
  starvedMs: number;
  /// Ticks observed. Zero means the gap was shorter than one tick.
  ticks: number;
}

export function startGapWatch(opts: GapWatchOptions = {}): { stop(): GapWatchResult } {
  const tickMs = opts.tickMs ?? 16;
  const now = opts.now ?? (() => performance.now());
  const schedule = opts.schedule ?? ((fn, ms) => void window.setTimeout(fn, ms));

  let starved = 0;
  let ticks = 0;
  let last = now();
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    const t = now();
    starved += Math.max(0, t - last - tickMs);
    last = t;
    ticks++;
    schedule(tick, tickMs);
  };
  schedule(tick, tickMs);

  return {
    stop(): GapWatchResult {
      stopped = true;
      return { starvedMs: Math.round(starved), ticks };
    },
  };
}
