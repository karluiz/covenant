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

/// Second ring, fed via GCD's main queue instead of tao's run_on_main_thread.
/// 0.11.13 field data shows tao-posted closures running 1-2s late around the
/// idle-cold switch; whether that is the whole main thread (kernel timer
/// coalescing / priority decay) or tao's wake path specifically is the open
/// question. Both paths dispatch to the same thread, so: both lag → the
/// thread/runloop itself is throttled; tao high + GCD low → tao's wakeup is
/// the bottleneck and render-critical work should route around it.
fn gcd_ring() -> &'static Mutex<LagRing> {
    static RING: OnceLock<Mutex<LagRing>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(LagRing::new()))
}

#[cfg(target_os = "macos")]
mod gcd {
    use std::ffi::c_void;
    #[repr(C)]
    pub struct DispatchObject(c_void);
    extern "C" {
        pub static _dispatch_main_q: DispatchObject;
        pub fn dispatch_async_f(
            queue: *const DispatchObject,
            context: *mut c_void,
            work: extern "C" fn(*mut c_void),
        );
    }
}

#[cfg(target_os = "macos")]
fn post_gcd_probe(posted_at: i64, posted: Instant) {
    extern "C" fn record(ctx: *mut std::ffi::c_void) {
        // Safety: ctx is the Box we leak below, reconstituted exactly once.
        let (posted_at, posted) = *unsafe { Box::from_raw(ctx as *mut (i64, Instant)) };
        let lag_ms = posted.elapsed().as_secs_f64() * 1000.0;
        if let Ok(mut r) = gcd_ring().lock() {
            r.push(posted_at, lag_ms);
        }
    }
    let ctx = Box::into_raw(Box::new((posted_at, posted)));
    unsafe { gcd::dispatch_async_f(&gcd::_dispatch_main_q, ctx as *mut _, record) };
}

#[cfg(not(target_os = "macos"))]
fn post_gcd_probe(_posted_at: i64, _posted: Instant) {}

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
            post_gcd_probe(posted_at, posted);
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct MainLagWindow {
    /// Worst lag via tao's run_on_main_thread.
    pub main: Option<f64>,
    /// Worst lag via dispatch_async on the GCD main queue (macOS only).
    pub gcd: Option<f64>,
}

/// Worst native main-thread lag (ms) observed across [start_ms, end_ms]
/// (epoch ms, same clock as JS `Date.now()`), via both posting paths.
/// Fields are null when no sample intersects the span.
#[tauri::command]
pub async fn main_lag_window(start_ms: i64, end_ms: i64) -> Result<MainLagWindow, String> {
    Ok(MainLagWindow {
        main: ring()
            .lock()
            .map_err(|e| e.to_string())?
            .max_in(start_ms, end_ms),
        gcd: gcd_ring()
            .lock()
            .map_err(|e| e.to_string())?
            .max_in(start_ms, end_ms),
    })
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
