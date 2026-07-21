//! Tauri surface for the Canon Context Miner: start/stop mining runs and
//! compile accepted findings into a skill package.

use karl_agent::context_miner::{run_miner, MinerDepth, MinerEvent, MinerOpts, MinerSink};
use karl_canon::compile::{
    write_command_entry, write_memory_entry, write_skill_package, write_subagent_entry,
    CompiledFinding,
};
use serde::{Deserialize, Serialize};
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

    let mut opts = MinerOpts::default_for(&focus);
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

/// A curated unit as the UI sends it back: the destination and its findings.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledUnit {
    pub kind: String,
    pub name: String,
    pub findings: Vec<CompiledFinding>,
}

/// The exact bytes this unit will be written as — the input to state
/// resolution and to the preview. Empty findings render empty.
///
/// ponytail: kinds other than "skill" render only `findings[0]` — a curated
/// unit is one destination file, and `emit_finding` already groups by unit
/// name upstream, so memory/command/subagent units carry exactly one finding
/// in practice. Skill units are the one kind that legitimately batches many
/// findings into a single SKILL.md.
pub(crate) fn render_unit(u: &CompiledUnit) -> String {
    if u.findings.is_empty() {
        return String::new();
    }
    if u.kind == "skill" {
        karl_canon::compile::render_skill_md(&karl_canon::compile::slugify(&u.name), &u.findings)
    } else {
        karl_canon::compile::render_md_entry(&u.findings[0])
    }
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompileReport {
    pub skills: Vec<String>,
    pub memory: Vec<String>,
    pub commands: Vec<String>,
    pub agents: Vec<String>,
}

#[tauri::command]
pub async fn canon_compile_units(
    repo_root: String,
    units: Vec<CompiledUnit>,
) -> Result<CompileReport, String> {
    let root = PathBuf::from(&repo_root);
    tokio::task::spawn_blocking(move || {
        let mut report = CompileReport::default();
        for u in &units {
            if u.findings.is_empty() {
                continue;
            }
            // The unit's slug is the only name in play: it is what
            // `canon_inventory_states` resolved state against, so the write
            // must land at that exact path, not at a path derived from the
            // finding's own title (a separate free-text string the model
            // authors in a different tool call).
            let slug = karl_canon::compile::slugify(&u.name);
            // The unit was resolved against Canon before the user pressed
            // Write, so every write is an intentional create-or-update.
            match u.kind.as_str() {
                "skill" => {
                    let dir = write_skill_package(&root, &slug, None, &u.findings, true)
                        .map_err(|e| e.to_string())?;
                    report.skills.push(dir.to_string_lossy().into_owned());
                }
                "command" => {
                    let path = write_command_entry(&root, &slug, &u.findings[0])
                        .map_err(|e| e.to_string())?;
                    report.commands.push(path.to_string_lossy().into_owned());
                }
                "subagent" => {
                    let path = write_subagent_entry(&root, &slug, &u.findings[0])
                        .map_err(|e| e.to_string())?;
                    report.agents.push(path.to_string_lossy().into_owned());
                }
                "memory" => {
                    let path = write_memory_entry(&root, &slug, &u.findings[0])
                        .map_err(|e| e.to_string())?;
                    report.memory.push(path.to_string_lossy().into_owned());
                }
                other => return Err(format!("unknown context kind: {other}")),
            }
        }
        Ok::<_, String>(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitStateRow {
    pub kind: String,
    pub slug: String,
    pub state: karl_canon::UnitState,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryReport {
    pub states: Vec<UnitStateRow>,
    pub detected: Vec<karl_canon::ContextUnit>,
}

#[tauri::command]
pub async fn canon_inventory_states(
    repo_root: String,
    units: Vec<CompiledUnit>,
) -> Result<InventoryReport, String> {
    let root = PathBuf::from(&repo_root);
    tokio::task::spawn_blocking(move || {
        let states = units
            .iter()
            .map(|u| {
                let slug = karl_canon::compile::slugify(&u.name);
                let state = karl_canon::resolve_state(&root, &u.kind, &slug, &render_unit(u));
                UnitStateRow {
                    kind: u.kind.clone(),
                    slug,
                    state,
                }
            })
            .collect();
        let detected = karl_canon::detected_rows(&root).map_err(|e| e.to_string())?;
        Ok::<_, String>(InventoryReport { states, detected })
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

    /// The slug rule is implemented three times: `canon::compile::slugify`,
    /// `agent::context_miner::unit_slug` (the `agent` crate deliberately does
    /// not depend on `canon`), and `slugify` in `ui/src/canon/miner/state.ts`.
    /// Drift between any two means the path a unit's state is RESOLVED against
    /// stops being the path it is WRITTEN to — badge lies, write clobbers.
    ///
    /// This list is duplicated verbatim as `SLUG_CORPUS` in
    /// `ui/src/canon/miner/state.test.ts`. Keep the two in sync: they are one
    /// corpus expressed in two languages, and every case below is a place the
    /// three implementations could plausibly diverge (the naive rules differ in
    /// whether they trim first, whether a leading separator emits a dash, and
    /// what counts as alphanumeric).
    const SLUG_CORPUS: &[(&str, &str)] = &[
        ("PTY Conventions", "pty-conventions"),
        ("retry budget", "retry-budget"),
        ("Foo/Bar baz", "foo-bar-baz"),
        ("  edge  ", "edge"),
        // Consecutive punctuation must collapse to a single dash.
        ("a!!!b", "a-b"),
        ("Rate limit -- per session", "rate-limit-per-session"),
        // Underscores are separators, not word characters.
        ("foo_bar_baz", "foo-bar-baz"),
        // Leading digits are legal in a slug.
        ("133 OSC markers", "133-osc-markers"),
        // Non-ASCII is dropped, and drops a separator in its place.
        ("café", "caf"),
        ("Ünïcödé", "n-c-d"),
        // Slugifies to empty — the case `write_md_entry` now rejects outright.
        ("!!!", ""),
        ("…", ""),
        // Leading / trailing separators are trimmed off the result.
        (" -foo- ", "foo"),
        ("--a--", "a"),
    ];

    #[test]
    fn slug_rules_agree_across_crates() {
        for (name, want) in SLUG_CORPUS {
            let canon = karl_canon::compile::slugify(name);
            let agent = karl_agent::context_miner::unit_slug(name);
            assert_eq!(canon, agent, "slug mismatch across crates for {name:?}");
            assert_eq!(canon, *want, "slug rule changed for {name:?}");
        }
    }

    #[test]
    fn render_for_state_matches_what_gets_written() {
        let f = CompiledFinding {
            category: "convention".into(),
            title: "Use tabs".into(),
            body_md: "Always use tabs.".into(),
            evidence: vec![],
            confidence: "high".into(),
            kind: "memory".into(),
        };
        let u = CompiledUnit {
            kind: "memory".into(),
            name: "Use tabs".into(),
            findings: vec![f.clone()],
        };
        assert_eq!(render_unit(&u), karl_canon::compile::render_md_entry(&f));

        let su = CompiledUnit {
            kind: "skill".into(),
            name: "PTY conventions".into(),
            findings: vec![f],
        };
        assert_eq!(
            render_unit(&su),
            karl_canon::compile::render_skill_md("pty-conventions", &su.findings)
        );
    }

    #[test]
    fn empty_unit_renders_empty_not_panics() {
        let u = CompiledUnit {
            kind: "memory".into(),
            name: "x".into(),
            findings: vec![],
        };
        assert_eq!(render_unit(&u), String::new());
    }

    /// The Critical bug: `canon_inventory_states` resolved state at
    /// `slugify(&u.name)` while `write_md_entries` (pre-fix) named the file
    /// from `slugify(&f.title)` — two independent free-text strings the model
    /// authors in two different tool calls. Reviewer-confirmed real-world
    /// divergence:
    ///   written_slug   = screen-all-customers-for-pep-status-before-onboarding
    ///   inventory_slug = pep-screening-policy
    /// A unit reporting `New` (pre-selected for writing) could clobber an
    /// unrelated file at the title-derived path, and a unit already on disk
    /// reported `New` forever because state was checked at a path nothing
    /// was ever written to. Write, then re-resolve, must report `Exists`.
    #[tokio::test]
    async fn write_then_resolve_reports_exists_not_new() {
        let tmp = std::env::temp_dir().join(format!("canon-roundtrip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_string_lossy().into_owned();

        let unit = CompiledUnit {
            kind: "memory".into(),
            name: "Screen all customers for PEP status before onboarding".into(),
            findings: vec![CompiledFinding {
                category: "domain_rule".into(),
                title: "PEP screening policy".into(),
                body_md: "Screen every onboarding customer against the PEP list.".into(),
                evidence: vec![],
                confidence: "high".into(),
                kind: "memory".into(),
            }],
        };

        canon_compile_units(root.clone(), vec![unit.clone()])
            .await
            .unwrap();

        let report = canon_inventory_states(root, vec![unit]).await.unwrap();
        assert_eq!(report.states.len(), 1);
        assert_eq!(
            report.states[0].state,
            karl_canon::UnitState::Exists,
            "unit written under its own name-derived slug must resolve as Exists, not New"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn unknown_kind_is_rejected() {
        let tmp = std::env::temp_dir().join(format!("canon-unkkind-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_string_lossy().into_owned();

        let unit = CompiledUnit {
            kind: "mcp".into(),
            name: "Not a real kind".into(),
            findings: vec![CompiledFinding {
                category: "convention".into(),
                title: "x".into(),
                body_md: "y".into(),
                evidence: vec![],
                confidence: "high".into(),
                kind: "mcp".into(),
            }],
        };

        let err = canon_compile_units(root, vec![unit]).await.unwrap_err();
        assert!(err.contains("unknown context kind"), "error: {err}");

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
