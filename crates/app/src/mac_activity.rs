//! macOS: hold an NSProcessInfo activity assertion for the process lifetime.
//!
//! 0.11.13 field data (mainLagMs on the repaint vital + live `sample`(1)
//! captures) shows that after a few minutes of not touching Covenant, work
//! posted to the native main thread runs 1-2s late while every process sits
//! idle — the shape of kernel timer coalescing / priority decay on an app the
//! system considers inactive, not of anything being busy. The switch freeze,
//! the beachball and the late Tauri evals are all downstream of those delayed
//! wakeups. NSAppSleepDisabled (the defaults key) was tried live and changed
//! nothing — it is not the same mechanism.
//!
//! The canonical opt-out is a real activity assertion: UserInitiated (minus
//! idle-system-sleep — a terminal must never keep the Mac awake) plus
//! LatencyCritical, which tells the kernel this process needs precise timer
//! delivery. iTerm2 holds the equivalent assertion for the same reason.
//!
//! ponytail: candidate fix, verdict pending — if the idle-bucket repaint p50
//! does not collapse in the next release's vitals, this comes out (same
//! contract as mac_render.rs and render-heartbeat.ts).

/// NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical.
pub const ACTIVITY_OPTIONS: u64 = (0x00FF_FFFF & !(1u64 << 20)) | 0xFF_0000_0000;

#[cfg(target_os = "macos")]
pub fn begin_latency_critical_activity() {
    use objc2::class;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use std::ffi::c_void;

    unsafe {
        let process_info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let bytes = b"terminal responsiveness (prevent timer coalescing)";
        let alloc: *mut AnyObject = msg_send![class!(NSString), alloc];
        // 4 = NSUTF8StringEncoding
        let reason: *mut AnyObject = msg_send![
            alloc,
            initWithBytes: bytes.as_ptr() as *const c_void,
            length: bytes.len(),
            encoding: 4usize
        ];
        let token: *mut AnyObject = msg_send![
            process_info,
            beginActivityWithOptions: ACTIVITY_OPTIONS,
            reason: reason
        ];
        // Retain and never release: the assertion holds for the whole process
        // lifetime, matching how terminal emulators use it.
        let _held: *mut AnyObject = msg_send![token, retain];
        tracing::info!("latency-critical activity assertion taken");
    }
}

#[cfg(not(target_os = "macos"))]
pub fn begin_latency_critical_activity() {}

#[cfg(test)]
mod tests {
    use super::ACTIVITY_OPTIONS;

    const IDLE_SYSTEM_SLEEP_DISABLED: u64 = 1 << 20;
    const LATENCY_CRITICAL: u64 = 0xFF_0000_0000;

    #[test]
    fn assertion_is_latency_critical_but_allows_system_sleep() {
        assert_eq!(ACTIVITY_OPTIONS & LATENCY_CRITICAL, LATENCY_CRITICAL);
        // A terminal must never keep the machine awake.
        assert_eq!(ACTIVITY_OPTIONS & IDLE_SYSTEM_SLEEP_DISABLED, 0);
        // Still a user-initiated-class assertion (low 24 bits mostly set).
        assert_ne!(ACTIVITY_OPTIONS & 0x00FF_FFFF, 0);
    }
}
