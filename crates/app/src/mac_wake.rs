//! macOS: keep the main runloop hot for a short burst after any user event.
//!
//! Endgame of the idle-switch investigation (see main_lag.rs for the full
//! chain). 0.11.16 field data: on an unattended app, EVERY wakeup mechanism
//! for the main thread is deferred ~1-2s — tao's wake-port message
//! (mainLagMs 1412), GCD main-queue (gcdLagMs 1166) and even a repeating
//! CFRunLoopTimer riding mk_timer (timerLagMs 1390) — while the runloop sits
//! in kCFRunLoopDefaultMode at priority 47 and a sibling thread in the same
//! process ticks punctually. macOS (Tahoe's UpdateCycle being the prime
//! suspect) gates the main thread of inactive apps wholesale.
//!
//! The one exempt door, observed across every dataset since 0.11.4: user
//! input. `queuedMs` is small on every slow switch — the click always wakes
//! the main thread instantly, because WindowServer events arrive on the
//! event port, which the system never defers. So: an NSEvent local monitor
//! notices any real user event and opens a 3s window during which a helper
//! thread posts a synthetic ApplicationDefined NSEvent every 50ms (the exact
//! dummy shape tao itself posts to wake its loop). Each post forces a full
//! runloop iteration through the never-deferred event path, draining tao
//! closures, GCD blocks and WebKit's display-link relay — precisely across
//! the window where a tab switch needs frames. Zero activity otherwise.
//!
//! The synthetic events are ignored by tao's handler (same subtype as its
//! own dummy) and are filtered out of the monitor so they cannot re-arm the
//! burst themselves.
//!
//! ponytail: if the next vitals show post-idle repaints unchanged, the
//! event-port exemption theory is wrong too and this comes out (same
//! contract as mac_render.rs / render-heartbeat.ts / mac_activity.rs).

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use objc2::class;
    use objc2::msg_send;
    use objc2::rc::autoreleasepool;
    use objc2::runtime::AnyObject;

    /// How long one user event keeps the loop hot.
    const BURST_MS: i64 = 3_000;
    /// Post cadence during a burst — two frames at 60Hz reach WebKit fast
    /// enough that a switch never waits perceptibly.
    const POST_INTERVAL_MS: u64 = 50;
    /// NSEventTypeApplicationDefined.
    const APPLICATION_DEFINED: u64 = 15;

    static BURST_UNTIL: AtomicI64 = AtomicI64::new(0);
    static POSTER_RUNNING: AtomicBool = AtomicBool::new(false);

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    // Safety: matches CoreGraphics' CGPoint layout and encoding.
    unsafe impl objc2::Encode for CGPoint {
        const ENCODING: objc2::Encoding =
            objc2::Encoding::Struct("CGPoint", &[objc2::Encoding::Double, objc2::Encoding::Double]);
    }

    fn now_ms() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// tao's exact dummy-event shape (event_loop.rs post_dummy_event):
    /// ApplicationDefined + subtype WindowExposed(0). Its handler ignores it;
    /// AppKit treats it as a plain wake of the event loop.
    fn post_wake_event() {
        autoreleasepool(|_| unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let event: *mut AnyObject = msg_send![
                class!(NSEvent),
                otherEventWithType: APPLICATION_DEFINED,
                location: CGPoint { x: 0.0, y: 0.0 },
                modifierFlags: 0u64,
                timestamp: 0f64,
                windowNumber: 0isize,
                context: std::ptr::null_mut::<AnyObject>(),
                subtype: 0i16,
                data1: 0isize,
                data2: 0isize
            ];
            if !event.is_null() {
                let _: () = msg_send![app, postEvent: event, atStart: false];
            }
        });
    }

    fn ensure_poster() {
        if POSTER_RUNNING.swap(true, Ordering::Relaxed) {
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("main-wake-burst".into())
            .spawn(|| loop {
                while now_ms() < BURST_UNTIL.load(Ordering::Relaxed) {
                    post_wake_event();
                    std::thread::sleep(Duration::from_millis(POST_INTERVAL_MS));
                }
                POSTER_RUNNING.store(false, Ordering::Relaxed);
                // An event may have extended the window between the check and
                // the store — reclaim the poster role or exit for real.
                if now_ms() < BURST_UNTIL.load(Ordering::Relaxed)
                    && !POSTER_RUNNING.swap(true, Ordering::Relaxed)
                {
                    continue;
                }
                return;
            });
        if spawned.is_err() {
            POSTER_RUNNING.store(false, Ordering::Relaxed);
        }
    }

    /// Install the NSEvent local monitor. Must run on the main thread.
    pub fn install() {
        unsafe {
            let handler = block2::RcBlock::new(|event: *mut AnyObject| -> *mut AnyObject {
                let ty: u64 = msg_send![event, type];
                // Our own synthetic wakes (and tao's dummies) must not re-arm
                // the burst, or it never ends.
                if ty != APPLICATION_DEFINED {
                    BURST_UNTIL.store(now_ms() + BURST_MS, Ordering::Relaxed);
                    ensure_poster();
                }
                event
            });
            let mask: u64 = !0; // NSEventMaskAny
            let monitor: *mut AnyObject = msg_send![
                class!(NSEvent),
                addLocalMonitorForEventsMatchingMask: mask,
                handler: &*handler
            ];
            // Both live for the process lifetime.
            std::mem::forget(handler);
            if monitor.is_null() {
                tracing::warn!("NSEvent local monitor install failed — wake burst inactive");
            } else {
                tracing::info!("user-event wake burst installed");
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub use imp::install;

#[cfg(not(target_os = "macos"))]
pub fn install() {}
