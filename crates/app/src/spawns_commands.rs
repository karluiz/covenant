use crate::spawns_store::{SpawnSpec, SpawnStore};
use std::sync::Arc;
use tauri::State;

pub struct SpawnsState(pub Arc<SpawnStore>);

#[tauri::command]
pub fn spawns_list(state: State<'_, SpawnsState>) -> Result<Vec<SpawnSpec>, String> {
    state.0.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn spawns_upsert(state: State<'_, SpawnsState>, spec: SpawnSpec) -> Result<(), String> {
    state.0.upsert(spec).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn spawns_delete(state: State<'_, SpawnsState>, id: String) -> Result<(), String> {
    state.0.delete(&id).map_err(|e| e.to_string())
}
