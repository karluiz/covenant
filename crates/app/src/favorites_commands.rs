//! Tauri commands for the browser favorites tree. Thin wrappers over the `store` crate;
//! the SQLite connection lives behind a `Mutex` because `rusqlite::Connection` is `!Sync`.

use std::sync::Mutex;

use store::{FavNode, Favorites};
use tauri::State;

pub struct FavoritesState(pub Mutex<Favorites>);

fn lock<'a>(state: &'a State<'_, FavoritesState>) -> std::sync::MutexGuard<'a, Favorites> {
    // A poisoned lock means a prior command panicked; recover the guard rather than
    // propagating the panic to every subsequent call.
    state.0.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command]
pub fn favorites_tree(state: State<'_, FavoritesState>) -> Result<Vec<FavNode>, String> {
    lock(&state).tree().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn favorites_add(
    state: State<'_, FavoritesState>,
    parent_id: Option<String>,
    kind: String,
    title: String,
    url: Option<String>,
) -> Result<FavNode, String> {
    lock(&state)
        .add(parent_id.as_deref(), &kind, &title, url.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn favorites_rename(
    state: State<'_, FavoritesState>,
    id: String,
    title: String,
) -> Result<(), String> {
    lock(&state).rename(&id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn favorites_move(
    state: State<'_, FavoritesState>,
    id: String,
    new_parent_id: Option<String>,
    after_id: Option<String>,
    before_id: Option<String>,
) -> Result<(), String> {
    lock(&state)
        .move_node(
            &id,
            new_parent_id.as_deref(),
            after_id.as_deref(),
            before_id.as_deref(),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn favorites_delete(state: State<'_, FavoritesState>, id: String) -> Result<(), String> {
    lock(&state).delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn favorites_set_collapsed(
    state: State<'_, FavoritesState>,
    id: String,
    collapsed: bool,
) -> Result<(), String> {
    lock(&state)
        .set_collapsed(&id, collapsed)
        .map_err(|e| e.to_string())
}
