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

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicUsize, Ordering};
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

    /// (n, p50, max) over samples posted at/after `cutoff_ms` — the probe's
    /// periodic self-report.
    pub fn stats_since(&self, cutoff_ms: i64) -> (usize, f64, f64) {
        let mut v: Vec<f64> = self
            .samples
            .iter()
            .filter(|(ts, _)| *ts >= cutoff_ms)
            .map(|(_, l)| *l)
            .collect();
        if v.is_empty() {
            return (0, 0.0, 0.0);
        }
        v.sort_by(f64::total_cmp);
        let p50 = v[(v.len() - 1) / 2];
        let max = v.last().copied().unwrap_or(0.0);
        (v.len(), p50, max)
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

/// Instantaneous samples (mode class / priority), pruned like LagRing.
pub struct SampleRing<T> {
    samples: VecDeque<(i64, T)>,
}

impl<T: Copy> SampleRing<T> {
    pub fn new() -> Self {
        Self {
            samples: VecDeque::new(),
        }
    }

    pub fn push(&mut self, ts_ms: i64, v: T) {
        self.samples.push_back((ts_ms, v));
        while let Some(&(ts, _)) = self.samples.front() {
            if ts_ms - ts > WINDOW_MS {
                self.samples.pop_front();
            } else {
                break;
            }
        }
    }

    pub fn in_window(&self, start_ms: i64, end_ms: i64) -> Vec<T> {
        self.samples
            .iter()
            .filter(|(ts, _)| *ts >= start_ms && *ts <= end_ms)
            .map(|(_, v)| *v)
            .collect()
    }
}

impl<T: Copy> Default for SampleRing<T> {
    fn default() -> Self {
        Self::new()
    }
}

/// Mode classes: 0=default, 1=tracking, 2=not-running, 3=other.
pub fn classify_mode(mode: &str) -> u8 {
    match mode {
        "kCFRunLoopDefaultMode" => 0,
        "NSEventTrackingRunLoopMode" => 1,
        "<not-running>" => 2,
        _ => 3,
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeCounts {
    pub default: u32,
    pub tracking: u32,
    pub not_running: u32,
    pub other: u32,
}

pub fn count_modes(classes: &[u8]) -> ModeCounts {
    let mut c = ModeCounts::default();
    for k in classes {
        match k {
            0 => c.default += 1,
            1 => c.tracking += 1,
            2 => c.not_running += 1,
            _ => c.other += 1,
        }
    }
    c
}

fn mode_ring() -> &'static Mutex<SampleRing<u8>> {
    static RING: OnceLock<Mutex<SampleRing<u8>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(SampleRing::new()))
}

fn pri_ring() -> &'static Mutex<SampleRing<i32>> {
    static RING: OnceLock<Mutex<SampleRing<i32>>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(SampleRing::new()))
}

/// Inter-fire lateness of the main-runloop metronome timer (see `metro`).
fn timer_ring() -> &'static Mutex<LagRing> {
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

/// 0.11.14 field data: mainLag AND gcdLag are BOTH high during the idle-cold
/// switch (1199/1075ms) and both elevated even warm (184/79ms vs a healthy
/// <5ms) — with a LatencyCritical activity assertion held. No posted source
/// gets drained, yet clicks are processed and `sample`(1) shows the thread
/// waiting in mach_msg. The remaining story is runloop-MODE starvation: the
/// loop is awake but sitting in a mode that excludes the common-mode sources
/// (tao's and GCD's main-queue drain both). This sampler reads the main
/// runloop's current mode from the probe thread — CFRunLoopCopyCurrentMode is
/// documented thread-safe — and the probe logs a mode histogram + lag stats
/// every ~10s, so a dev build answers "which mode correlates with the lag"
/// from stdout alone, no user repro cycles.
#[cfg(target_os = "macos")]
mod cf {
    use std::ffi::c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFRunLoopGetCurrent() -> *mut c_void;
        pub fn CFRunLoopCopyCurrentMode(rl: *mut c_void) -> *mut c_void;
        pub fn CFStringGetCString(s: *mut c_void, buf: *mut u8, size: isize, enc: u32) -> u8;
        pub fn CFRelease(cf: *mut c_void);
    }
    pub const UTF8: u32 = 0x0800_0100;
}

static MAIN_RUNLOOP: AtomicUsize = AtomicUsize::new(0);
static MAIN_THREAD_PORT: AtomicUsize = AtomicUsize::new(0);
static LAST_METRO_FIRE: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

/// The runloop metronome — fix candidate AND discriminator in one.
///
/// 0.11.15 field data closed the matrix's first two branches: every idle-cold
/// stall runs in 100% kCFRunLoopDefaultMode at priority 47, with tao posts
/// and GCD main-queue blocks both undelivered for 1-2s. The wake-port
/// message delivery itself is being deferred (macOS Tahoe's UpdateCycle taps
/// the runloop and is the prime suspect). CFRunLoopTimers ride a DIFFERENT
/// kernel mechanism (mk_timer), so a 100ms repeating no-op timer in common
/// modes bets that timers are exempt: each fire forces a full runloop
/// iteration, draining whatever sources sat deferred — tao closures, GCD
/// blocks, and WebKit's display-link relay alike. If the bet is right, the
/// post-idle repaint collapses to ~350ms. Either way `timerLagMs` (the
/// timer's own inter-fire lateness) lands on the vital: punctual timers +
/// fixed switch → mechanism named; late timers → the whole loop is gated
/// and the timer is not the lever.
///
/// ponytail: 10 no-op fires/s on the main thread. If the next release's
/// vitals show it neither fixed nor discriminated, it comes out.
#[cfg(target_os = "macos")]
mod metro {
    use std::ffi::c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFRunLoopTimerCreate(
            alloc: *const c_void,
            fire_date: f64,
            interval: f64,
            flags: u64,
            order: i64,
            callout: extern "C" fn(*mut c_void, *mut c_void),
            context: *mut c_void,
        ) -> *mut c_void;
        pub fn CFRunLoopAddTimer(rl: *mut c_void, timer: *mut c_void, mode: *const c_void);
        pub static kCFRunLoopCommonModes: *const c_void;
        pub fn CFAbsoluteTimeGetCurrent() -> f64;
    }
}

const METRO_MS: i64 = 100;

#[cfg(target_os = "macos")]
extern "C" fn metronome_fire(_timer: *mut std::ffi::c_void, _info: *mut std::ffi::c_void) {
    let now = now_ms();
    let prev = LAST_METRO_FIRE.swap(now, Ordering::Relaxed);
    if prev != 0 {
        // Missed fires coalesce, so the inter-fire gap minus the interval is
        // how long the loop went without an iteration.
        let lag = ((now - prev - METRO_MS) as f64).max(0.0);
        if let Ok(mut r) = timer_ring().lock() {
            // Store span-aligned like the other rings: blocked [now-lag, now].
            r.push(now - lag as i64, lag);
        }
    }
}

#[cfg(target_os = "macos")]
fn capture_main_runloop() {
    let rl = unsafe { cf::CFRunLoopGetCurrent() };
    MAIN_RUNLOOP.store(rl as usize, Ordering::Relaxed);
    MAIN_THREAD_PORT.store(unsafe { mach::mach_thread_self() } as usize, Ordering::Relaxed);
    unsafe {
        let timer = metro::CFRunLoopTimerCreate(
            std::ptr::null(),
            metro::CFAbsoluteTimeGetCurrent() + 0.1,
            METRO_MS as f64 / 1000.0,
            0,
            0,
            metronome_fire,
            std::ptr::null_mut(),
        );
        if !timer.is_null() {
            metro::CFRunLoopAddTimer(rl, timer, metro::kCFRunLoopCommonModes);
            // Never released — lives as long as the main runloop does.
        }
    }
}

/// Reads the main thread's CURRENT scheduling priority (pth_curpri). A
/// healthy focused-app main thread sits at 46-47; kernel priority decay on an
/// unattended process drags it down — if the stall windows show a decayed
/// priority, the 1-2s wakeup delay is the scheduler, not the runloop.
#[cfg(target_os = "macos")]
mod mach {
    extern "C" {
        pub fn mach_thread_self() -> u32;
        pub fn thread_info(t: u32, flavor: u32, out: *mut i32, cnt: *mut u32) -> i32;
    }
    pub const THREAD_EXTENDED_INFO: u32 = 5;
    /// sizeof(thread_extended_info) / sizeof(natural_t) = 112/4.
    pub const THREAD_EXTENDED_INFO_COUNT: u32 = 28;
    /// Offset of pth_curpri in i32 words: 2×u64 + 5×i32 before it.
    pub const CURPRI_WORD: usize = 9;
}

fn main_thread_priority() -> Option<i32> {
    #[cfg(target_os = "macos")]
    {
        let port = MAIN_THREAD_PORT.load(Ordering::Relaxed) as u32;
        if port == 0 {
            return None;
        }
        let mut info = [0i32; mach::THREAD_EXTENDED_INFO_COUNT as usize];
        let mut cnt = mach::THREAD_EXTENDED_INFO_COUNT;
        let kr = unsafe {
            mach::thread_info(port, mach::THREAD_EXTENDED_INFO, info.as_mut_ptr(), &mut cnt)
        };
        if kr != 0 {
            return None;
        }
        Some(info[mach::CURPRI_WORD])
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn current_main_mode() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let rl = MAIN_RUNLOOP.load(Ordering::Relaxed);
        if rl == 0 {
            return None;
        }
        unsafe {
            let mode = cf::CFRunLoopCopyCurrentMode(rl as *mut _);
            if mode.is_null() {
                return Some("<not-running>".into());
            }
            let mut buf = [0u8; 128];
            let ok = cf::CFStringGetCString(mode, buf.as_mut_ptr(), buf.len() as isize, cf::UTF8);
            cf::CFRelease(mode);
            if ok == 0 {
                return Some("<unreadable>".into());
            }
            let end = buf.iter().position(|&b| b == 0).unwrap_or(0);
            Some(String::from_utf8_lossy(&buf[..end]).into_owned())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn spawn_probe(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(capture_main_runloop);
    }
    let spawned = std::thread::Builder::new()
        .name("main-lag-probe".into())
        .spawn(move || {
            let mut modes: HashMap<String, u32> = HashMap::new();
            let mut ticks: u64 = 0;
            loop {
                let posted_at = now_ms();
                if let Some(m) = current_main_mode() {
                    if let Ok(mut r) = mode_ring().lock() {
                        r.push(posted_at, classify_mode(&m));
                    }
                    *modes.entry(m).or_insert(0) += 1;
                }
                if let Some(pri) = main_thread_priority() {
                    if let Ok(mut r) = pri_ring().lock() {
                        r.push(posted_at, pri);
                    }
                }
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
                ticks += 1;
                // ~Every 10s: mode histogram + lag stats to the log. This is
                // the dev-build instrument — readable from stdout with the
                // app untouched, which is exactly the chronic-lag condition.
                if ticks % 100 == 0 {
                    let cutoff = now_ms() - 10_000;
                    let (tao_n, tao_p50, tao_max) = ring()
                        .lock()
                        .map(|r| r.stats_since(cutoff))
                        .unwrap_or((0, 0.0, 0.0));
                    let (gcd_n, gcd_p50, gcd_max) = gcd_ring()
                        .lock()
                        .map(|r| r.stats_since(cutoff))
                        .unwrap_or((0, 0.0, 0.0));
                    let pri_min = pri_ring()
                        .lock()
                        .ok()
                        .and_then(|r| r.in_window(cutoff, now_ms()).into_iter().min());
                    let (_, _, tim_max) = timer_ring()
                        .lock()
                        .map(|r| r.stats_since(cutoff))
                        .unwrap_or((0, 0.0, 0.0));
                    tracing::info!(
                        ?modes,
                        pri_min,
                        tim_max,
                        tao_n,
                        tao_p50,
                        tao_max,
                        gcd_n,
                        gcd_p50,
                        gcd_max,
                        "main-lag report"
                    );
                    modes.clear();
                }
                std::thread::sleep(Duration::from_millis(TICK_MS));
            }
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
    /// Runloop-mode histogram over the span (10Hz samples). None when the
    /// span had no samples. Both lag paths starving while `default`
    /// dominates → the loop isn't iterating (kernel wakeup delay); a
    /// `tracking`/`other`-heavy span → mode starvation after all.
    pub modes: Option<ModeCounts>,
    /// Lowest main-thread scheduling priority observed in the span. Healthy
    /// UI main thread is 46-47; a decayed value during the stall names the
    /// scheduler as the mechanism.
    pub min_pri: Option<i32>,
    /// Worst inter-fire lateness of the 100ms main-runloop metronome timer
    /// across the span. Punctual (near-zero) while main/gcd lag → timers are
    /// exempt from the wakeup deferral and the metronome is the fix; late →
    /// the whole loop is gated regardless of wake mechanism.
    pub timer: Option<f64>,
}

/// Worst native main-thread lag (ms) observed across [start_ms, end_ms]
/// (epoch ms, same clock as JS `Date.now()`), via both posting paths, plus
/// the runloop-mode histogram and worst main-thread priority for the span.
/// Fields are null when no sample intersects the span.
#[tauri::command]
pub async fn main_lag_window(start_ms: i64, end_ms: i64) -> Result<MainLagWindow, String> {
    let mode_samples = mode_ring()
        .lock()
        .map_err(|e| e.to_string())?
        .in_window(start_ms, end_ms);
    Ok(MainLagWindow {
        main: ring()
            .lock()
            .map_err(|e| e.to_string())?
            .max_in(start_ms, end_ms),
        gcd: gcd_ring()
            .lock()
            .map_err(|e| e.to_string())?
            .max_in(start_ms, end_ms),
        modes: if mode_samples.is_empty() {
            None
        } else {
            Some(count_modes(&mode_samples))
        },
        min_pri: pri_ring()
            .lock()
            .map_err(|e| e.to_string())?
            .in_window(start_ms, end_ms)
            .into_iter()
            .min(),
        timer: timer_ring()
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
    fn sample_ring_windows_and_evicts() {
        let mut r: SampleRing<i32> = SampleRing::new();
        r.push(1_000, 47);
        r.push(2_000, 20);
        let recent = r.in_window(1_500, 5_000);
        assert_eq!(recent, vec![20]);
        // A push a full window later evicts everything older.
        r.push(WINDOW_MS + 3_000, 46);
        assert_eq!(r.in_window(0, 2_500), Vec::<i32>::new());
        assert_eq!(r.in_window(WINDOW_MS, WINDOW_MS + 5_000), vec![46]);
    }

    #[test]
    fn mode_classification_and_counting() {
        let classes: Vec<u8> = [
            "kCFRunLoopDefaultMode",
            "kCFRunLoopDefaultMode",
            "NSEventTrackingRunLoopMode",
            "<not-running>",
            "SomeCustomMode",
        ]
        .iter()
        .map(|m| classify_mode(m))
        .collect();
        let c = count_modes(&classes);
        assert_eq!(
            (c.default, c.tracking, c.not_running, c.other),
            (2, 1, 1, 1)
        );
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
