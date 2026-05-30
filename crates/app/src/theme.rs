use serde::Deserialize;
use tauri::window::{Effect, EffectState, EffectsBuilder};
use tauri::{AppHandle, Emitter, Manager};

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
    // Mirror the resolved appearance into the Claude theme used for new
    // shells. Colorblind-friendly variants match the daltonized palette
    // Covenant ships with; see COVENANT_CLAUDE_THEME in spawn_session.
    if let Some(state) = app.try_state::<crate::AppState>() {
        let claude = match mode {
            ResolvedTheme::Dark => "dark-daltonized",
            ResolvedTheme::Light => "light-daltonized",
        };
        if let Ok(mut t) = state.claude_theme.lock() {
            *t = claude.to_string();
        }
    }

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
    win.set_effects(effects).map_err(|e| e.to_string())?;

    // Keep the floating notch webview visually aligned with the app
    // chrome. It may mount after this event; notch_ready also returns
    // the persisted mode for that cold-start path.
    let mode = match mode {
        ResolvedTheme::Dark => "dark",
        ResolvedTheme::Light => "light",
    };
    let _ = app.emit("notch:theme", serde_json::json!({ "mode": mode }));
    Ok(())
}
