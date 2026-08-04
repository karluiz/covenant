//! macOS: keep the WindowServer importance donations flowing so the kernel
//! never gates this process — the fix the spindump finally licensed.
//!
//! Endgame evidence (sudo spindump -timeline during a live 2221ms stall,
//! macOS 26.3/25D125, saved in <app-data>/backups/covenant-stall-2026-08-03):
//!   * Main thread AND NSEventThread: `<4875ms gap with no samples, process
//!     frontmost, process unclamped, priority 47>` — blocked in mach_msg,
//!     never made runnable. The kernel withholds ALL receives from an
//!     idle-classified process; that is why every in-process wake attempt
//!     failed (tao source, GCD, mk_timer, self-posted NSEvents — see
//!     main_lag.rs for the falsification ledger).
//!   * The wake is `<process received importance donation from WindowServer>`
//!     — and only then does NSEventThread run PullEventsFromWindowServer,
//!     i.e. EVEN THE USER'S CLICK sits undelivered until the donation lands
//!     (queuedMs looked small only because DOM timestamps are stamped on
//!     arrival in WebContent).
//!
//! Countermeasure: don't fight the gate — never let it close. A GLOBAL
//! NSEvent monitor subscribes this process to session-wide mouse activity.
//! Every event the user produces anywhere (Chrome, Terminal, Finder) arrives
//! as a WindowServer message carrying an importance donation, so Covenant
//! stays interactive-classified the whole time the machine is in use, and
//! the first click after "idle" finds a warm process. Mouse-event global
//! monitors need no TCC permission (key events would — deliberately not
//! subscribed). The handler is a no-op: delivery is the medicine.
//!
//! Cost: our NSEventThread receives mouse-move traffic while the user works
//! in other apps — a no-op enqueue per event, no timers, nothing while the
//! whole machine is idle.
//!
//! This module previously held the user-event wake burst (0.11.18): posting
//! synthetic ApplicationDefined events after real input. Field data showed
//! self-posted events ride the same gated receive path — removed per its
//! own contract.
//!
//! ponytail: verdict rides the same vitals as ever — if post-idle repaints
//! don't collapse, this comes out and the fallback is a CGEventTap (TCC) or
//! the Apple Feedback (the spindump is a filed-ready repro).

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    use objc2::class;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    /// NSEventMask bits: leftMouseDown(1), rightMouseDown(3), mouseMoved(5),
    /// scrollWheel(22), otherMouseDown(25). Mouse only — key events would
    /// require Input Monitoring TCC approval.
    const MOUSE_MASK: u64 = (1 << 1) | (1 << 3) | (1 << 5) | (1 << 22) | (1 << 25);

    static SAW_FIRST_EVENT: AtomicBool = AtomicBool::new(false);

    /// Timestamps of handler runs, ~2 min of history. 0.11.21 field data:
    /// the keepalive rescued one 1-hour-idle switch (520ms) but most
    /// post-idle switches stayed gated. Whether those are COVERAGE gaps (no
    /// mouse events in the session before the switch — keyboard-only
    /// stretches are invisible to this mask) or TOTAL failure (events flowed
    /// and the gate closed anyway) decides the next move; the gap between
    /// the last handler run and the activation, attached to the vital as
    /// keepaliveGapMs, is that discriminator. Caveat recorded knowingly: the
    /// handler runs on the (gateable) main thread, so a huge gap can also
    /// mean \"handler starved\" — but a SMALL gap on a slow switch is
    /// unambiguous proof of total failure.
    fn event_ring() -> &'static Mutex<VecDeque<i64>> {
        static RING: OnceLock<Mutex<VecDeque<i64>>> = OnceLock::new();
        RING.get_or_init(|| Mutex::new(VecDeque::new()))
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// Most recent handler-run timestamp at or before `ts_ms`.
    pub fn last_event_before(ts_ms: i64) -> Option<i64> {
        let ring = event_ring().lock().ok()?;
        ring.iter().rev().find(|&&t| t <= ts_ms).copied()
    }

    /// Install the global monitor. Must run on the main thread.
    pub fn install() {
        unsafe {
            let handler = block2::RcBlock::new(|_event: *mut AnyObject| {
                // The WindowServer message that delivered this event already
                // donated importance — that's the fix. Record the run time
                // for the keepaliveGapMs discriminator.
                let now = now_ms();
                if let Ok(mut r) = event_ring().lock() {
                    r.push_back(now);
                    while r.front().is_some_and(|&t| now - t > 120_000) {
                        r.pop_front();
                    }
                }
                if !SAW_FIRST_EVENT.swap(true, Ordering::Relaxed) {
                    tracing::info!("donation keepalive: first global event received");
                }
            });
            let monitor: *mut AnyObject = msg_send![
                class!(NSEvent),
                addGlobalMonitorForEventsMatchingMask: MOUSE_MASK,
                handler: &*handler
            ];
            std::mem::forget(handler);
            if monitor.is_null() {
                tracing::warn!("global event monitor install failed — donation keepalive inactive");
            } else {
                tracing::info!("windowserver donation keepalive installed");
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::{install, last_event_before};

#[cfg(not(target_os = "macos"))]
pub fn install() {}

#[cfg(not(target_os = "macos"))]
pub fn last_event_before(_ts_ms: i64) -> Option<i64> {
    None
}
