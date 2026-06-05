use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// Per-tab browser history for back/forward state.
#[derive(Default)]
pub struct History {
    entries: Vec<String>,
    index: usize,
}

impl History {
    pub fn visit(&mut self, url: &str) {
        if self.entries.get(self.index).map(String::as_str) == Some(url) {
            return;
        }
        if !self.entries.is_empty() {
            self.entries.truncate(self.index + 1);
        }
        self.entries.push(url.to_string());
        self.index = self.entries.len() - 1;
    }
    pub fn can_go_back(&self) -> bool {
        self.index > 0 && !self.entries.is_empty()
    }
    pub fn can_go_forward(&self) -> bool {
        !self.entries.is_empty() && self.index + 1 < self.entries.len()
    }
    pub fn go_back(&mut self) -> Option<&str> {
        if self.can_go_back() {
            self.index -= 1;
            self.entries.get(self.index).map(String::as_str)
        } else {
            None
        }
    }
    pub fn go_forward(&mut self) -> Option<&str> {
        if self.can_go_forward() {
            self.index += 1;
            self.entries.get(self.index).map(String::as_str)
        } else {
            None
        }
    }
}

#[derive(Default)]
pub struct BrowserState {
    tabs: Mutex<HashMap<String, History>>,
}

#[derive(Clone, Serialize)]
pub struct NavPayload {
    pub url: String,
    pub title: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub loading: bool,
}

const BROWSER_LABEL_PREFIX: &str = "browser:";
fn label_for(tab_id: &str) -> String {
    format!("{BROWSER_LABEL_PREFIX}{tab_id}")
}

#[derive(serde::Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
pub async fn browser_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    url: String,
    bounds: Bounds,
) -> Result<(), String> {
    let window = app.get_window("main").ok_or("no main window")?;
    let parsed: url::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    let label = label_for(&tab_id);
    let app2 = app.clone();
    let tab_for_nav = tab_id.clone();
    let builder = tauri::webview::WebviewBuilder::new(label, WebviewUrl::External(parsed.clone()))
        .auto_resize()
        .on_navigation(move |u| {
            let _ = emit_browser_nav(&app2, &tab_for_nav, u.as_str(), true);
            true
        });
    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|e| e.to_string())?;
    state
        .tabs
        .lock()
        .map_err(|e| e.to_string())?
        .entry(tab_id)
        .or_default()
        .visit(parsed.as_str());
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
    url: String,
) -> Result<(), String> {
    let parsed: url::Url = url.parse().map_err(|e| format!("bad url: {e}"))?;
    if parsed.scheme() == "file" {
        return Err("file:// navigation is blocked".into());
    }
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("no webview")?;
    wv.navigate(parsed.clone()).map_err(|e| e.to_string())?;
    state
        .tabs
        .lock()
        .map_err(|e| e.to_string())?
        .entry(tab_id)
        .or_default()
        .visit(parsed.as_str());
    Ok(())
}

#[tauri::command]
pub fn browser_back(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("no webview")?;
    wv.eval("history.back()").map_err(|e| e.to_string())?;
    if let Ok(mut g) = state.tabs.lock() {
        if let Some(h) = g.get_mut(&tab_id) {
            h.go_back();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn browser_forward(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("no webview")?;
    wv.eval("history.forward()").map_err(|e| e.to_string())?;
    if let Ok(mut g) = state.tabs.lock() {
        if let Some(h) = g.get_mut(&tab_id) {
            h.go_forward();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn browser_reload(app: tauri::AppHandle, tab_id: String) -> Result<(), String> {
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("no webview")?;
    wv.eval("location.reload()").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_bounds(
    app: tauri::AppHandle,
    tab_id: String,
    bounds: Bounds,
) -> Result<(), String> {
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("no webview")?;
    wv.set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_show(app: tauri::AppHandle, tab_id: String) -> Result<(), String> {
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("no webview")?;
    wv.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_hide(app: tauri::AppHandle, tab_id: String) -> Result<(), String> {
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("no webview")?;
    wv.hide().map_err(|e| e.to_string())
}

/// Capture the current visible frame of a browser tab's native webview as
/// a PNG data URL. Used to "freeze" the page into a DOM <img> while a
/// context menu is open: the native webview is hidden (DOM can't paint
/// over it), the snapshot stands in, and the menu renders on top. macOS
/// only — returns an error elsewhere so the caller falls back to hide.
#[tauri::command]
pub async fn browser_snapshot(app: tauri::AppHandle, tab_id: String) -> Result<String, String> {
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("no webview")?;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<u8>>>();
    wv.with_webview(move |_pw| {
        #[cfg(target_os = "macos")]
        unsafe {
            use block2::RcBlock;
            use objc2::runtime::AnyObject;
            use std::cell::Cell;

            let webview = _pw.inner() as *mut AnyObject;
            // takeSnapshot's completion handler fires once, later, on the
            // main thread. Move the oneshot sender into a Cell so the
            // (Fn) block can take it on first invocation.
            let slot = Cell::new(Some(tx));
            let handler = RcBlock::new(move |image: *mut AnyObject, _err: *mut AnyObject| {
                let bytes = png_from_nsimage(image);
                if let Some(tx) = slot.take() {
                    let _ = tx.send(bytes);
                }
            });
            let nil = std::ptr::null::<AnyObject>();
            let _: () = objc2::msg_send![
                webview,
                takeSnapshotWithConfiguration: nil,
                completionHandler: &*handler,
            ];
            // Keep the block alive until the completion handler runs.
            std::mem::forget(handler);
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = tx.send(None);
        }
    })
    .map_err(|e| e.to_string())?;

    let bytes = rx
        .await
        .map_err(|e| e.to_string())?
        .ok_or("snapshot unavailable")?;
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/png;base64,{b64}"))
}

/// Convert an `NSImage*` to PNG bytes via NSBitmapImageRep. Returns None on
/// any null/failure along the chain.
#[cfg(target_os = "macos")]
unsafe fn png_from_nsimage(image: *mut objc2::runtime::AnyObject) -> Option<Vec<u8>> {
    use objc2::runtime::AnyObject;
    if image.is_null() {
        return None;
    }
    let tiff: *mut AnyObject = objc2::msg_send![image, TIFFRepresentation];
    if tiff.is_null() {
        return None;
    }
    let cls = objc2::class!(NSBitmapImageRep);
    let rep: *mut AnyObject = objc2::msg_send![cls, imageRepWithData: tiff];
    if rep.is_null() {
        return None;
    }
    // NSBitmapImageFileTypePNG = 4; nil properties is accepted.
    let nil = std::ptr::null::<AnyObject>();
    let png: *mut AnyObject =
        objc2::msg_send![rep, representationUsingType: 4usize, properties: nil];
    if png.is_null() {
        return None;
    }
    let len: usize = objc2::msg_send![png, length];
    // -[NSData bytes] returns `const void*` (encoding `^v`); declaring it as
    // `*const u8` trips objc2's debug type-encoding check, so take c_void.
    let ptr: *const std::ffi::c_void = objc2::msg_send![png, bytes];
    if ptr.is_null() || len == 0 {
        return None;
    }
    Some(std::slice::from_raw_parts(ptr as *const u8, len).to_vec())
}

#[tauri::command]
pub fn browser_close(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    tab_id: String,
) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label_for(&tab_id)) {
        let _ = wv.close();
    }
    if let Ok(mut g) = state.tabs.lock() {
        g.remove(&tab_id);
    }
    Ok(())
}

fn emit_browser_nav(
    app: &tauri::AppHandle,
    tab_id: &str,
    url: &str,
    loading: bool,
) -> tauri::Result<()> {
    use tauri::{Emitter, Manager};
    let (back, fwd) = app
        .try_state::<BrowserState>()
        .and_then(|s| {
            s.tabs.lock().ok().map(|g| {
                g.get(tab_id)
                    .map(|h| (h.can_go_back(), h.can_go_forward()))
                    .unwrap_or((false, false))
            })
        })
        .unwrap_or((false, false));
    let payload = NavPayload {
        url: url.to_string(),
        title: String::new(),
        can_go_back: back,
        can_go_forward: fwd,
        loading,
    };
    app.emit(&format!("browser://{tab_id}/nav"), payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn history_visit_and_back_forward() {
        let mut h = History::default();
        assert!(!h.can_go_back());
        h.visit("a");
        h.visit("b");
        assert!(h.can_go_back());
        assert!(!h.can_go_forward());
        assert_eq!(h.go_back(), Some("a"));
        assert!(h.can_go_forward());
        assert_eq!(h.go_forward(), Some("b"));
    }
    #[test]
    fn history_truncates_forward_on_new_branch() {
        let mut h = History::default();
        h.visit("a");
        h.visit("b");
        h.go_back();
        h.visit("c");
        assert!(!h.can_go_forward());
        assert_eq!(h.go_back(), Some("a"));
    }
    #[test]
    fn history_ignores_reload_of_same_url() {
        let mut h = History::default();
        h.visit("a");
        h.visit("a");
        assert!(!h.can_go_back());
    }
}
