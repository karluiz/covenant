//! Native main-thread lag probe — the discriminator the switch vitals lack.
//!
//! Real vitals data (0.11.4-0.11.11) pins the slow first-switch-after-idle to
//! frame production: `frame1Ms` accounts for essentially the whole repaint gap
//! while JS timers stay punctual (`gapStarvedMs` near zero), the window is
//! focused and visible, and `queuedMs` is small (the click itself was serviced
//! promptly). Disabling WKWebView occlusion detection (0.11.10) did not
//! flatten the tail — 20% of repaints >1.5s in 0.11.10 vs 26-39% before.
//!
//! Two stories still fit and the webview cannot tell them apart:
//!   A. The NATIVE main thread (Tauri/UI process) blocks for 1-2s after the
//!      switch — WebKit relays display-link ticks through the UI process, so
//!      rAF starves in the content process while its own loop stays free.
//!      This is also exactly a beachball, which the user reports seeing.
//!   B. WebKit's compositor/GPU process is slow re-materializing layers for a
//!      pane that sat display:none — the UI process stays healthy.
//!
//! This probe measures A directly: a helper thread posts a closure to the
//! main thread every 100ms and records how late it ran. The frontend attaches
//! the worst lag observed across the activation→repaint span to the `repaint`
//! vital (`detail.mainLagMs`). Next release's data decides: lag ≈ frame1 → A
//! (then `sample Covenant` during a repro names the blocking call); lag ≈ 0 →
//! B, and the fix moves to keeping WebKit's rendering pipeline warm instead.
//!
//! Caveat, deliberate: posting 10×/s wakes the main runloop. If the stall is
//! the runloop *sleeping* rather than blocked, shipping this probe may itself
//! shrink the tail — which would be equally diagnostic.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TICK_MS: u64 = 100;
/// Keep ~1 min of samples — vitals query the span right after the repaint
/// frame, so anything older is dead weight.
const WINDOW_MS: i64 = 60_000;

/// Ring of (posted-at epoch ms, observed lag ms). Pure so the windowing
/// logic is testable without a live main thread.
pub struct LagRing {
    samples: VecDeque<(i64, f64)>,
}

impl LagRing {
    pub fn new() -> Self {
        Self {
            samples: VecDeque::new(),
        }
    }

    pub fn push(&mut self, posted_at_ms: i64, lag_ms: f64) {
        self.samples.push_back((posted_at_ms, lag_ms));
        while let Some(&(ts, _)) = self.samples.front() {
            if posted_at_ms - ts > WINDOW_MS {
                self.samples.pop_front();
            } else {
                break;
            }
        }
    }

    /// Worst lag whose blocked span [posted_at, posted_at + lag] intersects
    /// [start_ms, end_ms]. Intersection, not containment: a block that began
    /// before the switch and released during it is exactly the case under
    /// investigation.
    pub fn max_in(&self, start_ms: i64, end_ms: i64) -> Option<f64> {
        self.samples
            .iter()
            .filter(|(ts, lag)| *ts <= end_ms && ts + *lag as i64 >= start_ms)
            .map(|(_, lag)| *lag)
            .max_by(f64::total_cmp)
    }
}

impl Default for LagRing {
    fn default() -> Self {
        Self::new()
    }
}

fn ring() -> &'static Mutex<LagRing> {
    static RING: OnceLock<Mutex<LagRing>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(LagRing::new()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn spawn_probe(app: tauri::AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("main-lag-probe".into())
        .spawn(move || loop {
            let posted_at = now_ms();
            let posted = Instant::now();
            let res = app.run_on_main_thread(move || {
                let lag_ms = posted.elapsed().as_secs_f64() * 1000.0;
                if let Ok(mut r) = ring().lock() {
                    r.push(posted_at, lag_ms);
                }
            });
            if res.is_err() {
                // App shutting down — the main runloop is gone.
                return;
            }
            std::thread::sleep(Duration::from_millis(TICK_MS));
        });
    if let Err(e) = spawned {
        tracing::warn!(?e, "could not spawn the main-lag probe thread");
    }
}

/// Worst native main-thread lag (ms) observed across [start_ms, end_ms]
/// (epoch ms, same clock as JS `Date.now()`). Null when no sample intersects
/// the span — e.g. first 100ms after boot.
#[tauri::command]
pub async fn main_lag_window(start_ms: i64, end_ms: i64) -> Result<Option<f64>, String> {
    Ok(ring()
        .lock()
        .map_err(|e| e.to_string())?
        .max_in(start_ms, end_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_in_picks_worst_intersecting_sample() {
        let mut r = LagRing::new();
        r.push(1_000, 5.0);
        r.push(1_100, 2_000.0); // blocked 1_100..3_100
        r.push(3_200, 8.0);
        assert_eq!(r.max_in(1_500, 2_000), Some(2_000.0));
        assert_eq!(r.max_in(0, 10_000), Some(2_000.0));
    }

    #[test]
    fn max_in_counts_block_that_released_inside_the_window() {
        let mut r = LagRing::new();
        // Posted before the switch, ran 1.5s late — released at 2_500.
        r.push(1_000, 1_500.0);
        assert_eq!(r.max_in(2_000, 3_000), Some(1_500.0));
        // Fully over before the window starts → no hit.
        assert_eq!(r.max_in(2_600, 3_000), None);
    }

    #[test]
    fn max_in_empty_and_disjoint_windows_are_none() {
        let mut r = LagRing::new();
        assert_eq!(r.max_in(0, 100), None);
        r.push(5_000, 3.0);
        assert_eq!(r.max_in(0, 100), None);
    }

    #[test]
    fn push_evicts_samples_older_than_the_window() {
        let mut r = LagRing::new();
        r.push(0, 1.0);
        r.push(WINDOW_MS + 1, 2.0);
        assert_eq!(r.max_in(0, 10), None);
        assert_eq!(r.max_in(WINDOW_MS, WINDOW_MS + 2), Some(2.0));
    }
}
