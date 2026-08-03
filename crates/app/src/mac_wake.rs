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
    use std::sync::atomic::{AtomicBool, Ordering};

    use objc2::class;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    /// NSEventMask bits: leftMouseDown(1), rightMouseDown(3), mouseMoved(5),
    /// scrollWheel(22), otherMouseDown(25). Mouse only — key events would
    /// require Input Monitoring TCC approval.
    const MOUSE_MASK: u64 = (1 << 1) | (1 << 3) | (1 << 5) | (1 << 22) | (1 << 25);

    static SAW_FIRST_EVENT: AtomicBool = AtomicBool::new(false);

    /// Install the global monitor. Must run on the main thread.
    pub fn install() {
        unsafe {
            let handler = block2::RcBlock::new(|_event: *mut AnyObject| {
                // No-op on purpose: the WindowServer message that delivered
                // this event already donated importance — that's the fix.
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
pub use imp::install;

#[cfg(not(target_os = "macos"))]
pub fn install() {}
