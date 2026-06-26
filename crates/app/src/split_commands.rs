//! Thin Tauri command surface for split-pane actions. The real state
//! lives in the UI and the existing PTY/Session crates; these commands
//! exist for typed API symmetry and future server-side enforcement.

#![allow(dead_code)] // TODO(D7+): wired up once the UI calls these commands.

use ulid::Ulid;

#[tauri::command]
pub async fn split_pane(
    _tab_id: String,
    _orientation: String,
    _source_pane_idx: u8,
) -> Result<String, String> {
    // The UI generates the new PaneId and calls spawn_session with it.
    // This command exists for symmetry / future server-side state.
    Ok(Ulid::new().to_string())
}

#[tauri::command]
pub async fn close_pane(_tab_id: String, _pane_idx: u8) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn focus_pane(_tab_id: String, _pane_idx: u8) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn swap_panes(_tab_id: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn set_pane_orientation(_tab_id: String, _orientation: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn set_pane_ratio(_tab_id: String, _ratio: f32) -> Result<(), String> {
    Ok(())
}
