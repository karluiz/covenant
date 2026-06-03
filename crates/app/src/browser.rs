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
