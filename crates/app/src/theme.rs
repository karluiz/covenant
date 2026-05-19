use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri::window::{Effect, EffectState, EffectsBuilder};

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResolvedTheme {
    Dark,
    Light,
}

/// Swap NSVisualEffectView material for the main window. Dark keeps
/// `HudWindow` (the value set in tauri.conf.json); light switches to
/// `WindowBackground` which paints a light frosted surface matching
/// macOS's native light vibrancy.
#[tauri::command]
pub fn set_window_theme(app: AppHandle, mode: ResolvedTheme) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let effects = EffectsBuilder::new()
        .effect(match mode {
            ResolvedTheme::Dark => Effect::HudWindow,
            ResolvedTheme::Light => Effect::WindowBackground,
        })
        .state(EffectState::FollowsWindowActiveState)
        .build();
    win.set_effects(effects).map_err(|e| e.to_string())
}
