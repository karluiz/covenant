//! macOS: keep WebKit producing frames for the main window.
//!
//! Measured symptom (user's real app, v0.11.7/0.11.8 vitals, 37 switches):
//! after the tab-switch work finishes in 11-22ms, the FIRST animation frame
//! takes 1.3-2.0s to arrive — `frame1Ms` accounts for essentially the whole
//! `repaint` — while the event loop stays healthy (`gapStarvedMs` 5-137ms
//! against a 2s gap). Timers punctual + rAF dead means the process is not
//! throttled (App Nap would slow the timers too); WebKit has stopped its
//! rendering update cycle for the view. It correlates with idleness: slow
//! switches follow a median 18s without activity versus 6s for fast ones, and
//! the worst one followed 122s.
//!
//! WKWebView suspends rendering updates when AppKit reports the window as
//! occluded, which is exactly that shape — and resuming is not immediate.
//! `_setWindowOcclusionDetectionEnabled:` turns that off. It is private API,
//! so every call is gated on `respondsToSelector:` and the whole thing is a
//! silent no-op if Apple ever renames it. Distribution is Developer ID, not
//! the App Store, so private API use is a compatibility risk only.
//!
//! ponytail: candidate mitigation, not a proven fix — the hypothesis is the
//! best fit for the data but has not been confirmed. The Vitals `repaint`
//! tail (>900ms samples, ~1/3 of switches before this) is the regression
//! test: if it does not flatten, this comes back out rather than staying as
//! cargo cult.

/// Whether the occlusion-detection opt-out should be attempted at all.
/// Split out so the policy is unit-testable without a live webview.
pub fn should_disable_occlusion_detection(target_os_is_macos: bool, responds: bool) -> bool {
    target_os_is_macos && responds
}

#[cfg(target_os = "macos")]
pub fn keep_rendering_while_occluded(win: &tauri::WebviewWindow) {
    use objc2::runtime::{AnyObject, Sel};
    use objc2::sel;

    let res = win.with_webview(|pw| unsafe {
        let webview = pw.inner() as *mut AnyObject;
        let selector: Sel = sel!(_setWindowOcclusionDetectionEnabled:);
        let responds: bool = objc2::msg_send![webview, respondsToSelector: selector];
        if !should_disable_occlusion_detection(true, responds) {
            tracing::warn!(
                "WKWebView has no _setWindowOcclusionDetectionEnabled: — leaving \
                 occlusion throttling on (frames may stall after the window is idle)"
            );
            return;
        }
        let _: () = objc2::msg_send![webview, _setWindowOcclusionDetectionEnabled: false];
        tracing::info!("occlusion-driven render throttling disabled for the main webview");
    });
    if let Err(e) = res {
        tracing::warn!(
            ?e,
            "could not reach the main webview to disable occlusion throttling"
        );
    }
}

#[cfg(not(target_os = "macos"))]
pub fn keep_rendering_while_occluded(_win: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_when_the_selector_is_gone() {
        // Apple renaming the private selector must degrade to a no-op, never
        // to an unrecognised-selector crash.
        assert!(!should_disable_occlusion_detection(true, false));
    }

    #[test]
    fn skips_off_macos() {
        assert!(!should_disable_occlusion_detection(false, true));
    }

    #[test]
    fn applies_only_when_macos_and_the_selector_exists() {
        assert!(should_disable_occlusion_detection(true, true));
    }
}
