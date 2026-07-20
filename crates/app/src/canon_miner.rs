//! Tauri surface for the Canon Context Miner: start/stop mining runs and
//! compile accepted findings into a skill package.

use karl_agent::context_miner::{
    run_miner, MinerDepth, MinerEvent, MinerOpts, MinerSink,
};
use karl_canon::compile::{
    write_command_entry, write_memory_entry, write_skill_package, write_subagent_entry,
    CompiledFinding,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use ulid::Ulid;

/// Registry of in-flight mining runs, keyed by run id, so a `canon_mine_stop`
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

/// Resolve the Context Miner inference role to a streaming dispatcher, honoring
/// the full provider routing (Anthropic / OpenAI-compat / Azure) via the shared
/// `build_role_dispatcher`. The miner's `emit_finding` tool roster is injected
/// in the provider's own tool format.
fn build_miner_dispatcher(
    settings: &crate::settings::Settings,
) -> Result<Box<dyn karl_agent::spec_author::stream::StreamingDispatcher>, String> {
    use karl_agent::context_miner::{miner_tool_specs, miner_tool_specs_openai};
    crate::build_role_dispatcher(
        settings,
        crate::settings::Role::ContextMiner,
        Some(miner_tool_specs()),
        Some(miner_tool_specs_openai()),
    )
}

#[tauri::command]
pub async fn canon_mine_start(
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
    let topic = format!("canon://miner/{run_id}");
    let sink = EmitSink {
        app: app.clone(),
        topic,
    };
    let runs_clone: MinerRuns = (*runs).clone();
    let run_id_task = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = run_miner(dispatcher.as_ref(), &root, &opts, &cancel, &sink).await;
        // RunDone is already emitted by run_miner on every exit path.
        runs_clone.remove(&run_id_task);
    });
    Ok(run_id)
}

#[tauri::command]
pub async fn canon_mine_stop(runs: State<'_, MinerRuns>, run_id: String) -> Result<(), String> {
    runs.stop(&run_id);
    Ok(())
}

// ponytail: no lifetimes, owned clones at curation scale
#[derive(Default)]
pub(crate) struct KindGroups {
    pub skills: Vec<CompiledFinding>,
    pub memory: Vec<CompiledFinding>,
    pub commands: Vec<CompiledFinding>,
    pub agents: Vec<CompiledFinding>,
}

pub(crate) fn split_by_kind(findings: &[CompiledFinding]) -> KindGroups {
    let mut g = KindGroups::default();
    for f in findings {
        match f.kind.as_str() {
            "memory" => g.memory.push(f.clone()),
            "command" => g.commands.push(f.clone()),
            "subagent" => g.agents.push(f.clone()),
            _ => g.skills.push(f.clone()),
        }
    }
    g
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompileReport {
    pub skills: Option<String>,
    pub memory: Vec<String>,
    pub commands: Vec<String>,
    pub agents: Vec<String>,
}

#[tauri::command]
pub async fn canon_compile_findings(
    repo_root: String,
    skill_name: String,
    findings: Vec<CompiledFinding>,
    overwrite: bool,
) -> Result<CompileReport, String> {
    let root = PathBuf::from(&repo_root);
    tokio::task::spawn_blocking(move || {
        let g = split_by_kind(&findings);
        let mut report = CompileReport::default();
        if !g.skills.is_empty() {
            let dir = write_skill_package(&root, &skill_name, None, &g.skills, overwrite)
                .map_err(|e| e.to_string())?;
            report.skills = Some(dir.to_string_lossy().into_owned());
        }
        let strvec = |v: Vec<std::path::PathBuf>| {
            v.into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        };
        if !g.memory.is_empty() {
            report.memory =
                strvec(write_memory_entry(&root, &g.memory, overwrite).map_err(|e| e.to_string())?);
        }
        if !g.commands.is_empty() {
            report.commands =
                strvec(write_command_entry(&root, &g.commands, overwrite).map_err(|e| e.to_string())?);
        }
        if !g.agents.is_empty() {
            report.agents =
                strvec(write_subagent_entry(&root, &g.agents, overwrite).map_err(|e| e.to_string())?);
        }
        Ok::<_, String>(report)
    })
    .await
    .map_err(|e| e.to_string())?
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

    #[test]
    fn split_by_kind_groups_findings() {
        use karl_canon::compile::CompiledFinding;
        let f = |kind: &str| CompiledFinding {
            category: "pattern".into(), title: format!("t {kind}"),
            body_md: "b".into(), evidence: vec![], confidence: "high".into(), kind: kind.into(),
        };
        let all = vec![f("skill"), f("memory"), f("memory"), f("command"), f("subagent")];
        let g = super::split_by_kind(&all);
        assert_eq!(g.skills.len(), 1);
        assert_eq!(g.memory.len(), 2);
        assert_eq!(g.commands.len(), 1);
        assert_eq!(g.agents.len(), 1);
    }
}
