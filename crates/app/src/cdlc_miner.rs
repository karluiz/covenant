//! Tauri surface for the CDLC Context Miner: start/stop mining runs and
//! compile accepted findings into a skill package.

use karl_agent::context_miner::{
    run_miner, MinerDepth, MinerEvent, MinerOpts, MinerSink,
};
use karl_cdlc::compile::{write_skill_package, CompiledFinding};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use ulid::Ulid;

/// Registry of in-flight mining runs, keyed by run id, so a `cdlc_mine_stop`
/// call can flip the cooperative-cancellation flag the spawned task polls.
/// Cloning is cheap (shares the inner map) so the spawned run task can hold
/// its own handle and remove its entry on completion.
#[derive(Clone)]
pub struct MinerRuns {
    inner: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl MinerRuns {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn insert(&self) -> (String, Arc<AtomicBool>) {
        let id = Ulid::new().to_string();
        let flag = Arc::new(AtomicBool::new(false));
        self.inner.lock().unwrap().insert(id.clone(), flag.clone());
        (id, flag)
    }

    fn stop(&self, id: &str) {
        if let Some(f) = self.inner.lock().unwrap().get(id) {
            f.store(true, Ordering::SeqCst);
        }
    }

    fn remove(&self, id: &str) {
        self.inner.lock().unwrap().remove(id);
    }
}

impl Default for MinerRuns {
    fn default() -> Self {
        Self::new()
    }
}

struct EmitSink {
    app: AppHandle,
    topic: String,
}
impl MinerSink for EmitSink {
    fn emit(&self, event: MinerEvent) {
        if let Err(e) = self.app.emit(&self.topic, &event) {
            tracing::warn!(error = %e, topic = %self.topic, "miner event emit failed");
        }
    }
}

/// Resolve the Spec Creator role to an Anthropic model + api key and build
/// the streaming dispatcher the miner drives. Mirrors the resolution in
/// `spec_author_stream_step` (crates/app/src/lib.rs), but the miner is
/// Anthropic-only by design — no OpenAI-compat / Azure Foundry branch.
fn build_miner_dispatcher(
    settings: &crate::settings::Settings,
) -> Result<karl_agent::spec_author::stream::AnthropicStreamingDispatcher, String> {
    use karl_agent::provider::ProviderKind;
    let route = settings
        .model_routes
        .get(&crate::settings::Role::SpecCreator)
        .ok_or("configure an Anthropic model for the Spec Creator role in Settings")?;
    let entry = settings
        .providers
        .get(&route.provider_id)
        .ok_or("configure an Anthropic model for the Spec Creator role in Settings")?;
    if entry.kind != ProviderKind::Anthropic {
        return Err("configure an Anthropic model for the Spec Creator role in Settings".into());
    }
    let api_key = entry
        .api_key
        .clone()
        .or_else(|| settings.anthropic_api_key.clone())
        .ok_or("configure an Anthropic model for the Spec Creator role in Settings")?;
    Ok(karl_agent::spec_author::stream::AnthropicStreamingDispatcher {
        api_key,
        model: route.model.clone(),
        tools: Some(karl_agent::context_miner::miner_tool_specs()),
    })
}

#[tauri::command]
pub async fn cdlc_mine_start(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    runs: State<'_, MinerRuns>,
    repo_root: String,
    skill_name: String,
    focus: String,
    thorough: bool,
) -> Result<String, String> {
    let root = PathBuf::from(&repo_root)
        .canonicalize()
        .map_err(|e| format!("repo root: {e}"))?;

    let dispatcher = {
        let settings = state.settings.lock().await;
        build_miner_dispatcher(&settings)?
    };

    let mut opts = MinerOpts::default_for(&skill_name, &focus);
    if thorough {
        opts.depth = MinerDepth::Thorough;
        opts.max_tool_calls = 240;
    }

    let (run_id, cancel) = runs.insert();
    let topic = format!("cdlc://miner/{run_id}");
    let sink = EmitSink {
        app: app.clone(),
        topic,
    };
    let runs_clone: MinerRuns = (*runs).clone();
    let run_id_task = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = run_miner(&dispatcher, &root, &opts, &cancel, &sink).await;
        // RunDone is already emitted by run_miner on every exit path.
        runs_clone.remove(&run_id_task);
    });
    Ok(run_id)
}

#[tauri::command]
pub async fn cdlc_mine_stop(runs: State<'_, MinerRuns>, run_id: String) -> Result<(), String> {
    runs.stop(&run_id);
    Ok(())
}

#[tauri::command]
pub async fn cdlc_compile_skill(
    repo_root: String,
    skill_name: String,
    findings: Vec<CompiledFinding>,
    overwrite: bool,
) -> Result<String, String> {
    let root = PathBuf::from(&repo_root);
    let dir = tokio::task::spawn_blocking(move || {
        write_skill_package(&root, &skill_name, None, &findings, overwrite)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_cancels_and_forgets() {
        let runs = MinerRuns::new();
        let (id, flag) = runs.insert();
        assert!(!flag.load(std::sync::atomic::Ordering::SeqCst));
        runs.stop(&id);
        assert!(flag.load(std::sync::atomic::Ordering::SeqCst));
        runs.remove(&id);
        // Stopping an unknown id is a no-op, not a panic.
        runs.stop("missing");
    }
}
