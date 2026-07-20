//! Tauri command surface for interactive ACP (Agent Client Protocol,
//! `copilot --acp`) sessions.
//!
//! Bridge: each [`AcpSession`] runs its own broadcast bus internally. When
//! a session is spawned we start a forwarder task that subscribes to that
//! bus and re-emits every event on the Tauri channel
//! `session://{id}/acp`, using the same [`SessionId`] the rest of the app
//! already uses. Mirrors [`crate::pi_commands`].
//!
//! Lifecycle:
//!   1. `spawn_acp_session` returns a string-encoded [`SessionId`].
//!   2. Frontend subscribes to `session://{id}/acp`.
//!   3. Subsequent commands take the same session id (as a string) to
//!      address the session.
//!   4. `close_acp_session` shuts down the child + forwarder task and
//!      removes the registry entry.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use karl_agent::acp::{
    build_judge_prompt, parse_judge_reply, perception_decide,
    policy::{resolve_headless, resolve_yolo, AcpTrust},
    protocol::{
        AvailableCommand, ContentBlock, PermissionRequest, SessionNotification, SessionUpdate,
        ToolCallFields,
    },
    AcpError, AcpSession, AcpSessionEvent, AcpSpawnOpts, PerceptionDecision, PermissionDecision,
    PermissionResolver,
};
use karl_session::{ExecutorPhase, SessionId};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::settings::Settings;
use crate::AppState;

// ---------------------------------------------------------------------------
// Phase mapping
// ---------------------------------------------------------------------------

/// Map an ACP session event onto the notch's `ExecutorPhase` taxonomy.
/// Returns `None` for events that don't change the user-visible phase
/// (e.g. an unrecognized `session/update` kind) so the forwarder can skip
/// the hub call entirely.
pub(crate) fn acp_event_to_phase(ev: &AcpSessionEvent) -> Option<ExecutorPhase> {
    match ev {
        AcpSessionEvent::Update(n) => match &n.update {
            SessionUpdate::ToolCall(f) | SessionUpdate::ToolCallUpdate(f) => {
                Some(tool_call_phase(f))
            }
            SessionUpdate::AgentMessageChunk { .. } | SessionUpdate::AgentThoughtChunk { .. } => {
                Some(ExecutorPhase::Thinking)
            }
            // Command roster changes don't move the phase pill; replayed
            // user messages (session/load) aren't agent activity either.
            SessionUpdate::AvailableCommandsUpdate { .. }
            | SessionUpdate::UserMessageChunk { .. }
            | SessionUpdate::Unknown => None,
        },
        AcpSessionEvent::PermissionPending { .. } => Some(ExecutorPhase::Waiting {
            reason: "permission".to_string(),
        }),
        // Terminal — the forwarder handles this before it ever reaches
        // `acp_event_to_phase` (see the loop in `spawn_acp_session`), but
        // stay exhaustive rather than wildcard so a future variant can't
        // silently fall through un-mapped.
        AcpSessionEvent::Closed => None,
    }
}

/// Bucket a tool call into Writing / Running / Reading by its `kind`.
/// Any other (or missing) kind is treated as a heartbeat, not a distinct
/// phase — same rationale as pi's tool-update heartbeats.
fn tool_call_phase(f: &ToolCallFields) -> ExecutorPhase {
    match f.kind.as_deref() {
        Some("edit") => ExecutorPhase::Writing {
            file: tool_call_target(f),
        },
        Some("execute") => ExecutorPhase::Running {
            cmd: f.command().unwrap_or("command").to_string(),
        },
        Some("read") => ExecutorPhase::Reading {
            file: tool_call_target(f),
        },
        _ => ExecutorPhase::Thinking,
    }
}

/// Best-effort file target for an edit/read tool call: the diff path from
/// streamed content, else `rawInput.fileName`, else a placeholder.
fn tool_call_target(f: &ToolCallFields) -> String {
    f.content
        .iter()
        .find_map(|c| match c {
            ContentBlock::Diff { path, .. } => Some(path.clone()),
            _ => None,
        })
        .or_else(|| {
            f.raw_input
                .as_ref()
                .and_then(|v| v.get("fileName"))
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "file".to_string())
}

// ---------------------------------------------------------------------------
// Perception: auto-answer trivial + safe permission prompts
// ---------------------------------------------------------------------------

/// Max consecutive auto-answers before Perception hands back to the human —
/// mirrors the cap in `agent::acp::perception::decide`. A human click or an
/// escalation resets the streak.
pub(crate) const PERCEPTION_CAP: u32 = 5;

/// Result of running the Perception pipeline on one parked prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PerceptionOutcome {
    /// Auto-answer the prompt with `option_id` (side effects are the
    /// forwarder's job: `respond_permission` + audit emit).
    Answered { option_id: String, reason: String },
    /// Hand the prompt back to the human unchanged.
    Escalated,
}

/// Orchestrate one prompt: build the judge prompt → call the injected async
/// `judge` → parse → run the pure `perception_decide` core → map the result.
/// No I/O beyond `judge`, so it unit-tests with a stub closure. The real
/// judge (see `perception_judge`) returns `""` on ANY model error, which
/// parses to `Uncertain` → escalate, so a broken model can never widen the
/// safety envelope.
pub(crate) async fn perception_decide_async<F, Fut>(
    req: &PermissionRequest,
    consecutive: u32,
    cap: u32,
    judge: F,
) -> PerceptionOutcome
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = String>,
{
    let prompt = build_judge_prompt(req);
    let raw = judge(prompt).await;
    let verdict = parse_judge_reply(&raw, req);
    match perception_decide(req, &verdict, consecutive, cap) {
        PerceptionDecision::AutoAnswer { option_id, reason } => {
            PerceptionOutcome::Answered { option_id, reason }
        }
        PerceptionDecision::Escalate => PerceptionOutcome::Escalated,
    }
}

/// The real judge: one non-streaming Triage-route completion. Reuses the
/// same provider-resolution path as the summarizer / operator triage
/// (`resolve_route(Role::Triage)` → `provider::collect_oneshot`), so it
/// tracks the user's configured triage model instead of hardcoding
/// `DEFAULT_TRIAGE_MODEL`. Returns `String::new()` on NO route or ANY error
/// — the empty string parses to `Uncertain`, so the prompt safely escalates.
async fn perception_judge(settings: &Arc<Mutex<Settings>>, prompt: String) -> String {
    let resolved = {
        let s = settings.lock().await;
        match crate::provider_resolve::resolve_route(&s, crate::settings::Role::Triage) {
            Ok(r) => r,
            Err(e) => {
                tracing::debug!(?e, "perception: no triage route; escalating");
                return String::new();
            }
        }
    };
    let req = karl_agent::AskRequest {
        api_key: String::new(),
        model: resolved.model.clone(),
        system_prompt: String::new(),
        user_message: prompt,
        max_tokens: 128,
        thinking_budget: None,
        force_tool: None,
    };
    match karl_agent::provider::collect_oneshot(&*resolved.provider, req).await {
        Ok(resp) => resp.text,
        Err(e) => {
            tracing::warn!(?e, "perception: judge call failed; escalating");
            String::new()
        }
    }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// A live interactive ACP session plus the bits the command layer needs
/// beyond what `AcpSession` itself tracks.
struct AcpTabSession {
    session: Arc<AcpSession>,
    /// The wire-level `sessionId` returned by `session/new` — distinct
    /// from our own [`SessionId`] registry key. Mutex: `acp_load_session`
    /// (/resume picker) swaps it in-place on a live tab.
    acp_session_id: std::sync::Mutex<String>,
    /// Guards against overlapping `session/prompt` calls on the same
    /// session (ACP has no queueing of its own).
    in_flight: AtomicBool,
    /// Latest slash-command roster from `available_commands_update`,
    /// cached because the frontend's Tauri listener races the forwarder's
    /// first emits — the view fetches this via `acp_get_commands` after
    /// subscribing. std Mutex: held for a clone, never across an await.
    commands: std::sync::Mutex<Vec<AvailableCommand>>,
    /// Session working directory — the jail root for prompt attachments.
    cwd: PathBuf,
    /// Harness driving this tab (`claude` / `codex` / `copilot` / `pi` /
    /// `gemini`) — the same string handed to `register_external`. Used as
    /// the Covenant Score executor label when the user sends a prompt.
    executor: String,
    /// Model roster + current selection from `session/new`, kept in sync
    /// by `acp_set_model`. Same pull-based pattern as `commands`.
    models: std::sync::Mutex<AcpModels>,
    /// Flipped true by `acp_mark_ready` once the frontend's Tauri event
    /// listener is registered. The forwarder task holds its first emit
    /// until then — otherwise a `session/load` replay burst is emitted
    /// into the void and the transcript arrives with holes (the same
    /// race `commands`/`models` dodge via pull, but replay frames have
    /// no pull path).
    ready_tx: tokio::sync::watch::Sender<bool>,
    /// Consecutive Perception auto-answers with no intervening human click.
    /// The forwarder increments it per auto-answer and resets it to 0 on
    /// escalation; `acp_respond_permission` resets it when a human answers.
    /// Guards against an unbounded auto-answer streak (see `PERCEPTION_CAP`).
    /// Shared between the forwarder task and the command layer via the
    /// registry's `Arc<AcpTabSession>`.
    perception_consecutive: AtomicU32,
    /// Per-session trust level; written by `acp_set_trust` (Task 5) so a
    /// live tab can change trust without a restart. The `Arc` shared with
    /// `hybrid_resolver` at spawn time is the copy actually consulted per
    /// permission request; this field is that same `Arc`, kept on the tab
    /// so `acp_set_trust` can reach it.
    trust: Arc<std::sync::RwLock<AcpTrust>>,
    /// Mechanical transcript ring feeding the operator's terminal
    /// context (see `acp_world.rs`). std Mutex: short holds, never
    /// across an await — same pattern as `commands`/`models`.
    world: std::sync::Mutex<crate::acp_world::AcpWorldModel>,
}

impl AcpTabSession {
    /// Current wire-level ACP sessionId (swappable via `acp_load_session`).
    fn wire_id(&self) -> String {
        match self.acp_session_id.lock() {
            Ok(g) => g.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }
}

/// Model roster for the tab's picker. `available` comes from
/// `session/new`'s `models.availableModels` (id + display name; pricing
/// meta is passed through verbatim under `meta`).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModels {
    pub available: Vec<AcpModelInfo>,
    pub current: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpModelInfo {
    pub model_id: String,
    pub name: Option<String>,
    /// Wire extras (e.g. `_meta.copilotUsage` = "1x") — untyped passthrough.
    pub meta: Option<Value>,
}

fn parse_models(new_sess: &Value) -> AcpModels {
    let models = new_sess.get("models");
    let available = models
        .and_then(|m| m.get("availableModels"))
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    Some(AcpModelInfo {
                        model_id: m.get("modelId")?.as_str()?.to_string(),
                        name: m.get("name").and_then(Value::as_str).map(str::to_string),
                        meta: m.get("_meta").cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let current = models
        .and_then(|m| m.get("currentModelId"))
        .and_then(Value::as_str)
        .map(str::to_string);
    AcpModels { available, current }
}

/// Shared registry of live interactive ACP sessions. Held on [`AppState`].
///
/// `inner` is `Arc`-wrapped (unlike a bare `Mutex<HashMap<..>>>`) so a
/// cheap [`Clone`] of the whole registry can be moved into the forwarder
/// task spawned by [`spawn_acp_session`] — the same shape as
/// `state.notch_hub: Arc<NotchHub>` — letting that task remove its own
/// entry on session death without borrowing from a short-lived
/// `State<'_, AppState>`.
#[derive(Default, Clone)]
pub struct AcpRegistry {
    inner: Arc<Mutex<HashMap<SessionId, Arc<AcpTabSession>>>>,
}

impl AcpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    async fn insert(&self, id: SessionId, sess: Arc<AcpTabSession>) {
        self.inner.lock().await.insert(id, sess);
    }

    async fn get(&self, id: &SessionId) -> Option<Arc<AcpTabSession>> {
        self.inner.lock().await.get(id).cloned()
    }

    async fn remove(&self, id: &SessionId) -> Option<Arc<AcpTabSession>> {
        self.inner.lock().await.remove(id)
    }

    /// Clone every live tab's world-model state for the operator's
    /// terminal-context snapshot. Inner std locks are held per-tab for
    /// the clone only, never across an await.
    pub async fn snapshot_worlds(&self) -> Vec<AcpWorldSnapshot> {
        let g = self.inner.lock().await;
        g.iter()
            .map(|(id, tab)| {
                let w = match tab.world.lock() {
                    Ok(w) => w,
                    Err(poisoned) => poisoned.into_inner(),
                };
                AcpWorldSnapshot {
                    id: *id,
                    executor: w.executor.clone(),
                    turns: w.turns(),
                    in_flight: w.in_flight_text(),
                    last_prompt: w.last_user_prompt(),
                    cwd: tab.cwd.clone(),
                }
            })
            .collect()
    }
}

/// One ACP tab's world-model state, cloned out of the registry for the
/// operator's `# Terminal context` (see `teammate/world_snapshot.rs`).
#[derive(Debug, Clone)]
pub struct AcpWorldSnapshot {
    pub id: SessionId,
    pub executor: String,
    pub turns: Vec<(crate::acp_world::AcpRole, String)>,
    /// Agent text currently streaming (unflushed buffer), if any.
    pub in_flight: Option<String>,
    pub last_prompt: Option<String>,
    pub cwd: PathBuf,
}

// ---------------------------------------------------------------------------
// Frontend event payload
// ---------------------------------------------------------------------------

/// Payload emitted on `session://{id}/acp`. Tagged so the frontend can
/// dispatch on `type`; field names are camelCase to match the rest of the
/// Tauri event surface.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpTabEvent {
    /// Raw `session/update` notification, typed end-to-end (see the
    /// `Serialize` derives added to `protocol.rs`).
    Update {
        update: SessionNotification,
    },
    #[serde(rename_all = "camelCase")]
    PermissionPending {
        request_key: String,
        request: PermissionRequest,
    },
    #[serde(rename_all = "camelCase")]
    PromptDone {
        stop_reason: String,
    },
    SessionDead,
    /// Audit trail: Perception auto-answered a permission prompt on the
    /// operator's behalf (the prompt is NOT also forwarded as
    /// `PermissionPending`). The frontend renders this as a resolved,
    /// non-interactive chip.
    #[serde(rename_all = "camelCase")]
    PerceptionAutoAnswer {
        request_key: String,
        option_id: String,
        reason: String,
    },
}

// ---------------------------------------------------------------------------
// Spawn / close
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpawnAcpOpts {
    pub cwd: Option<String>,
    /// Wire-level ACP sessionId from a previous run. When set (and the
    /// agent advertises `loadSession`), the spawn resumes that session via
    /// `session/load` — copilot replays the whole transcript as ordinary
    /// `session/update` frames. Falls back to a fresh `session/new` if the
    /// load fails (expired/unknown session).
    pub resume_acp_session_id: Option<String>,
    /// Which agent drives this tab: "copilot" (default) or "pi". Resolved
    /// to a launch profile by `AcpSpawnOpts::for_executor`.
    pub executor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnAcpResult {
    pub session_id: String,
    /// Current model id reported by `session/new` (`models.currentModelId`),
    /// e.g. "claude-sonnet-4.6". Best-effort — None if the wire omits it.
    pub model: Option<String>,
    /// Wire-level ACP sessionId — persisted by the tab manifest so a later
    /// app restart can resume this conversation.
    pub acp_session_id: String,
    /// True when a requested resume actually loaded (vs fresh fallback).
    pub resumed: bool,
    /// Effective trust level the session launched with.
    pub trust: AcpTrust,
}

/// Prepare the isolated `CLAUDE_CONFIG_DIR` the claude ACP adapter runs
/// against. Needed because the adapter's pinned Agent SDK rejects newer
/// fields in the user's real `~/.claude/settings.json` (seen live:
/// `permissions.defaultMode: auto` → session/new dies). The dir gets:
/// - `settings.json` — `permissions.defaultMode` and `model` are derived
///   from `cfg` on every spawn; every other (hand-added) key is preserved
/// - `.claude.json` — minimal onboarding + oauthAccount copied from the
///   real state file (rewritten each spawn; cheap and tracks re-login)
/// - `.credentials.json` — the "Claude Code-credentials" Keychain item
///   (0600), same file the CLI itself uses on Linux. Re-copied on every
///   spawn so the token is as fresh as the last real Claude Code refresh.
/// Sync fs + `security`(1) — call inside spawn_blocking.
fn prepare_claude_acp_config(
    base: &std::path::Path,
    cfg: &crate::settings::AcpExecutorConfig,
) -> Result<PathBuf, String> {
    // The dir is SHARED by every claude tab (one path, no session id) and
    // settings.json below is a read-modify-write — two tabs spawning close
    // together could interleave and boot the adapter against the wrong
    // defaultMode (worst case: an unintended bypassPermissions). Serialize
    // the whole prepare. This only guards writers in THIS process — which
    // is sufficient, Covenant is the only writer. std Mutex is fine: sync
    // fn inside spawn_blocking, no awaits to hold it across.
    static PREP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = PREP_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    let dir = base.join("claude-acp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("claude-acp config dir: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }

    // settings.json: `permissions.defaultMode` and `model` are DERIVED
    // from the Harnesses ACP config on every spawn; every other key the
    // user hand-adds is preserved verbatim.
    let settings = dir.join("settings.json");
    let mut root: Value = std::fs::read_to_string(&settings)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    if let Some(obj) = root.as_object_mut() {
        let mode = match cfg.trust {
            AcpTrust::Yolo => "bypassPermissions",
            _ => "default",
        };
        let perms = obj.entry("permissions").or_insert_with(|| json!({}));
        if !perms.is_object() {
            *perms = json!({});
        }
        if let Some(p) = perms.as_object_mut() {
            p.insert("defaultMode".into(), json!(mode));
        }
        match &cfg.model {
            Some(m) => {
                obj.insert("model".into(), json!(m));
            }
            None => {
                obj.remove("model");
            }
        }
    }
    let rendered = serde_json::to_string_pretty(&root).map_err(|e| format!("settings.json: {e}"))?;
    // Atomic replace (tmp + rename, same pattern as settings::save) so a
    // reader — the adapter booting — never sees a half-written file.
    let tmp = dir.join("settings.json.tmp");
    std::fs::write(&tmp, rendered).map_err(|e| format!("settings.json: {e}"))?;
    std::fs::rename(&tmp, &settings).map_err(|e| format!("settings.json: {e}"))?;

    // The isolated config dir hides the user's real `~/.claude` from the
    // adapter, so user-level skills/commands/agents vanish from the slash
    // roster. Symlink them in — live view, no staleness.
    // ponytail: plugins/ not linked (adapter already owns that dir with its
    // own state); link it too if plugin-provided skills are wanted in ACP.
    #[cfg(unix)]
    if let Some(home) = dirs::home_dir() {
        let real = home.join(".claude");
        for sub in ["skills", "commands", "agents"] {
            let src = real.join(sub);
            let dst = dir.join(sub);
            if src.is_dir() && std::fs::symlink_metadata(&dst).is_err() {
                let _ = std::os::unix::fs::symlink(&src, &dst);
            }
        }
    }

    if let Some(home) = dirs::home_dir() {
        if let Ok(raw) = std::fs::read_to_string(home.join(".claude.json")) {
            if let Ok(full) = serde_json::from_str::<Value>(&raw) {
                let mut mini = serde_json::Map::new();
                for k in [
                    "hasCompletedOnboarding",
                    "lastOnboardingVersion",
                    "oauthAccount",
                ] {
                    if let Some(v) = full.get(k) {
                        mini.insert(k.to_string(), v.clone());
                    }
                }
                let _ = std::fs::write(
                    dir.join(".claude.json"),
                    serde_json::to_string(&Value::Object(mini)).unwrap_or_else(|_| "{}".into()),
                );
            }
        }
    }

    // Credentials: Keychain first (macOS), else the CLI's own file.
    let cred_path = dir.join(".credentials.json");
    let keychain = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .output();
    let cred = match keychain {
        Ok(out) if out.status.success() && !out.stdout.is_empty() => {
            Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        _ => dirs::home_dir()
            .and_then(|h| std::fs::read_to_string(h.join(".claude/.credentials.json")).ok()),
    };
    match cred {
        Some(c) => {
            std::fs::write(&cred_path, c).map_err(|e| format!("credentials copy: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    std::fs::set_permissions(&cred_path, std::fs::Permissions::from_mode(0o600));
            }
        }
        None if cred_path.exists() => { /* keep last-good copy */ }
        None => {
            return Err(
                "no Claude Code credentials found — run `claude` once and log in first".into(),
            )
        }
    }
    Ok(dir)
}

/// Trust-aware resolver for interactive tabs. Ask defers everything to
/// the user; Balanced silently grants policy-approved requests (the
/// historical hybrid); Yolo grants everything grantable. All levels
/// share the policy floor: never a persistent "always" grant, and an
/// unresolvable request always defers instead of guessing.
fn hybrid_resolver(trust: Arc<std::sync::RwLock<AcpTrust>>) -> PermissionResolver {
    Arc::new(move |req| {
        let level = trust.read().map(|g| *g).unwrap_or_default();
        match level {
            AcpTrust::Ask => PermissionDecision::Defer,
            AcpTrust::Balanced => {
                let choice = resolve_headless(req);
                let allows = req.options.iter().any(|o| {
                    o.option_id == choice && o.kind.to_ascii_lowercase().contains("allow")
                });
                if allows {
                    PermissionDecision::Select(choice)
                } else {
                    PermissionDecision::Defer
                }
            }
            AcpTrust::Yolo => {
                let choice = resolve_yolo(req);
                if choice.is_empty() {
                    PermissionDecision::Defer
                } else {
                    PermissionDecision::Select(choice)
                }
            }
        }
    })
}

#[tauri::command]
pub async fn spawn_acp_session(
    app: AppHandle,
    state: State<'_, AppState>,
    operator_registry: State<'_, Arc<crate::operator_registry::OperatorRegistry>>,
    opts: SpawnAcpOpts,
) -> Result<SpawnAcpResult, String> {
    let session_id = SessionId::new();

    let cwd = opts
        .cwd
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));

    let executor = opts.executor.clone().unwrap_or_else(|| "copilot".into());
    let cfg = { state.settings.lock().await.acp_executor(&executor) };
    let mut spawn_opts = AcpSpawnOpts::for_executor(&executor, cwd.clone())?;

    // Trust → native mechanism. YOLO is enforced adapter-side where
    // possible so permission requests aren't even generated; the
    // trust-aware resolver below covers whatever still leaks through.
    if cfg.trust == AcpTrust::Yolo {
        match executor.as_str() {
            "copilot" => {
                if let Some(args) = spawn_opts.agent_args.as_mut() {
                    args.push("--allow-all-tools".to_string());
                }
            }
            "opencode" => {
                // ponytail: allow-all blob; verified against the installed
                // opencode (1.14.39) — see task-4-report.md for the check.
                spawn_opts.env.push((
                    "OPENCODE_PERMISSION".to_string(),
                    r#"{"edit":"allow","bash":"allow","webfetch":"allow"}"#.to_string(),
                ));
            }
            _ => {}
        }
    }

    if executor == "claude" {
        let base = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("resolve app_config_dir: {e}"))?;
        let cfg_for_prep = cfg.clone();
        let cfg_dir = tokio::task::spawn_blocking(move || {
            prepare_claude_acp_config(&base, &cfg_for_prep)
        })
        .await
        .map_err(|e| format!("claude config prep: {e}"))??;
        spawn_opts.env.push((
            "CLAUDE_CONFIG_DIR".to_string(),
            cfg_dir.to_string_lossy().into_owned(),
        ));
        if let Some(tokens) = cfg.thinking_tokens {
            spawn_opts
                .env
                .push(("MAX_THINKING_TOKENS".to_string(), tokens.to_string()));
        }
    }

    // User escape hatches last: env can override trust-derived entries
    // (later duplicates win — Command::env replaces), args append after
    // the adapter's own.
    spawn_opts.env.extend(cfg.env.iter().cloned());
    match spawn_opts.agent_args.as_mut() {
        Some(args) => args.extend(cfg.args.iter().cloned()),
        None => spawn_opts.extra_args.extend(cfg.args.iter().cloned()),
    }

    let trust = Arc::new(std::sync::RwLock::new(cfg.trust));
    let session = AcpSession::spawn(spawn_opts, hybrid_resolver(trust.clone()))
        .await
        .map_err(|e| e.to_string())?;

    // Subscribe BEFORE the handshake: copilot broadcasts
    // `available_commands_update` right after `initialize`, and a tokio
    // broadcast send with zero receivers is dropped on the floor. This
    // receiver buffers those early frames until the forwarder (spawned
    // post-handshake, after notch registration) drains them.
    let rx = session.events();

    let init = match session
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } }
            }),
        )
        .await
    {
        Ok(v) => v,
        // Closed/ResponseCancelled here mean the child died (or its
        // stdout closed) before ever answering our first request —
        // almost always an old copilot binary that doesn't understand
        // `--acp`. Surface the stderr tail so the user sees why.
        Err(e @ (AcpError::Closed | AcpError::ResponseCancelled)) => {
            session.shutdown(Duration::from_secs(3)).await;
            let tail = session.stderr_tail();
            let tail = if tail.is_empty() {
                "(empty)".to_string()
            } else {
                tail
            };
            let hint = match executor.as_str() {
                "copilot" => " Hint: requires GitHub Copilot CLI >= 1.0.68 with ACP support (`copilot --acp`).",
                "pi" => " Hint: requires the pi-acp adapter (`npm i -g pi-acp`) and a configured `pi` binary.",
                "claude" => " Hint: requires npx + a logged-in Claude Code (`claude`); the adapter is @zed-industries/claude-agent-acp.",
                "opencode" => " Hint: requires opencode >= 1.14 (`opencode acp`) with configured providers.",
                _ => "",
            };
            return Err(format!(
                "{executor} ACP handshake failed ({e}). stderr: {tail}.{hint}"
            ));
        }
        Err(e) => {
            session.shutdown(Duration::from_secs(3)).await;
            return Err(e.to_string());
        }
    };

    // Resume path: `session/load` replays the whole prior transcript as
    // ordinary `session/update` frames, which buffer in `rx` (subscribed
    // pre-handshake) until the forwarder below drains them — the frontend
    // rebuilds the conversation with zero extra plumbing. Verified live
    // against copilot 1.0.68 (replay + context retention across process
    // kills). Failure (expired/unknown id, capability off) falls back to
    // a fresh `session/new` instead of erroring: a stale manifest must
    // never brick tab restore.
    // ponytail: rx buffers 1024 frames; a transcript longer than that
    // drops the oldest replay frames (copilot coalesces one frame per
    // message, so ~500 exchanges). Raise EVENT_CHANNEL_CAPACITY if hit.
    let can_load = init
        .pointer("/agentCapabilities/loadSession")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut resumed = false;
    let mut sess_val: Option<Value> = None;
    if let Some(prev) = opts
        .resume_acp_session_id
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        if can_load {
            match session
                .request(
                    "session/load",
                    json!({ "sessionId": prev, "cwd": cwd.to_string_lossy(), "mcpServers": [] }),
                )
                .await
            {
                Ok(v) => {
                    resumed = true;
                    sess_val = Some(v);
                }
                Err(e) => {
                    tracing::warn!(error = %e, "acp: session/load failed; starting fresh");
                }
            }
        } else {
            tracing::warn!("acp: resume requested but agent lacks loadSession; starting fresh");
        }
    }

    let (acp_session_id, sess_val) = if resumed {
        (
            opts.resume_acp_session_id.clone().unwrap_or_default(),
            sess_val.unwrap_or(Value::Null),
        )
    } else {
        let new_sess = match session
            .request(
                "session/new",
                json!({ "cwd": cwd.to_string_lossy(), "mcpServers": [] }),
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                session.shutdown(Duration::from_secs(3)).await;
                return Err(e.to_string());
            }
        };
        let id = new_sess
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            session.shutdown(Duration::from_secs(3)).await;
            return Err("acp: session/new did not return a sessionId".to_string());
        }
        (id, new_sess)
    };
    // Both session/new and session/load return the same `models` shape.
    let models = parse_models(&sess_val);
    let model = models.current.clone();
    let acp_session_id_out = acp_session_id.clone();

    let (ready_tx, ready_rx) = tokio::sync::watch::channel(false);
    let tab_session = Arc::new(AcpTabSession {
        session: session.clone(),
        acp_session_id: std::sync::Mutex::new(acp_session_id),
        in_flight: AtomicBool::new(false),
        commands: std::sync::Mutex::new(Vec::new()),
        cwd: cwd.clone(),
        executor: executor.clone(),
        models: std::sync::Mutex::new(models),
        ready_tx,
        perception_consecutive: AtomicU32::new(0),
        trust: trust.clone(),
        world: std::sync::Mutex::new(crate::acp_world::AcpWorldModel::new(executor.clone())),
    });
    let tab_for_task = tab_session.clone();

    // Registration must happen before the forwarder starts, or the first
    // events racing the forwarder's spawn can arrive at a hub with no
    // entry for this session and be silently dropped (see notch.rs
    // `register_external`/`set_phase`).
    let notch_hub = state.notch_hub.clone();
    notch_hub
        .register_external(session_id, executor.clone())
        .await;

    let mut rx = rx; // subscribed pre-handshake (see above) — buffered frames intact
    let app_for_task = app.clone();
    let notch_hub_task = notch_hub.clone();
    let registry_task = state.acp_sessions.clone();
    // Perception judge needs settings; `State<'_, AppState>` isn't `'static`
    // so capture the `Arc` before the `tokio::spawn`.
    let settings_for_task = state.settings.clone();
    // Perception activation is a live per-decision property of the session's
    // EFFECTIVE operator (pin → Default), looked up each PermissionPending.
    // Capture the registry `Arc` before the spawn (State isn't `'static`).
    let registry_for_task = (*operator_registry).clone();
    let topic = format!("session://{session_id}/acp");
    let topic_for_task = topic.clone();
    tokio::spawn(async move {
        // Shared teardown for both liveness signals below: the explicit
        // `AcpSessionEvent::Closed` broadcast by `read_loop` on a real
        // child exit (the reachable path — see the doc on that variant),
        // and `RecvError::Closed` (only reachable once this task's `Arc<
        // AcpSession>` clone — held indirectly via the registry entry —
        // is also dropped, e.g. by a `close_acp_session` race). Either
        // way: tell the frontend, drop the notch entry, and remove
        // ourselves from the registry so a later `close_acp_session` on
        // this id is a no-op instead of double-shutting-down a dead
        // session.
        async fn on_dead(
            app: &AppHandle,
            topic: &str,
            notch_hub: &Arc<crate::notch::NotchHub>,
            registry: &AcpRegistry,
            session_id: SessionId,
        ) {
            if let Err(e) = app.emit(topic, &AcpTabEvent::SessionDead) {
                tracing::warn!(?e, topic, "acp session-dead emit failed");
            }
            notch_hub.drop_session(&session_id).await;
            registry.remove(&session_id).await;
        }

        // Hold the first emit until the frontend has registered its Tauri
        // listener (`acp_mark_ready`): the resume replay burst arrives in
        // `rx` immediately, and anything emitted before the listener lands
        // is dropped by Tauri with no recovery. 5s escape hatch so a view
        // that never mounts (spawn-then-close race) can't wedge the notch
        // phases forever; events keep buffering in `rx` while we wait.
        let mut ready_rx = ready_rx;
        if !*ready_rx.borrow() {
            let _ = tokio::time::timeout(Duration::from_secs(5), ready_rx.wait_for(|ready| *ready))
                .await;
        }

        loop {
            let ev = match rx.recv().await {
                Ok(ev) => ev,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(skipped = n, topic = %topic_for_task, "acp event lag");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    on_dead(
                        &app_for_task,
                        &topic_for_task,
                        &notch_hub_task,
                        &registry_task,
                        session_id,
                    )
                    .await;
                    break;
                }
            };
            if let Some(phase) = acp_event_to_phase(&ev) {
                notch_hub_task.set_phase(session_id, phase).await;
            }
            // Cache the slash roster: the frontend's Tauri listener races
            // these first emits, so the view re-fetches via
            // `acp_get_commands` after subscribing. Also feed the tab's
            // world model (operator context) — a session/load replay
            // flows through here too, repopulating it after restart.
            if let AcpSessionEvent::Update(n) = &ev {
                match &n.update {
                    SessionUpdate::AvailableCommandsUpdate { available_commands } => {
                        match tab_for_task.commands.lock() {
                            Ok(mut c) => *c = available_commands.clone(),
                            Err(poisoned) => *poisoned.into_inner() = available_commands.clone(),
                        }
                    }
                    SessionUpdate::AgentMessageChunk { content } => {
                        if let Some(t) = content.as_text() {
                            match tab_for_task.world.lock() {
                                Ok(mut w) => w.on_agent_chunk(t),
                                Err(poisoned) => poisoned.into_inner().on_agent_chunk(t),
                            }
                        }
                    }
                    SessionUpdate::UserMessageChunk { content } => {
                        if let Some(t) = content.as_text() {
                            match tab_for_task.world.lock() {
                                Ok(mut w) => w.record_user(t),
                                Err(poisoned) => poisoned.into_inner().record_user(t),
                            }
                        }
                    }
                    SessionUpdate::ToolCall(f) => {
                        let title = f
                            .title
                            .as_deref()
                            .or_else(|| f.command())
                            .unwrap_or("tool call");
                        match tab_for_task.world.lock() {
                            Ok(mut w) => w.on_tool_call(title),
                            Err(poisoned) => poisoned.into_inner().on_tool_call(title),
                        }
                    }
                    _ => {}
                }
            }
            let payload = match ev {
                AcpSessionEvent::Update(n) => AcpTabEvent::Update { update: n },
                AcpSessionEvent::PermissionPending {
                    request_key,
                    request,
                } => {
                    // Live gate: Perception is on iff the session's effective
                    // operator (pin → Default) has it enabled. Re-read per
                    // prompt so toggling the operator takes effect immediately;
                    // independent of AOM.
                    let perception_on = registry_for_task.perception_enabled_for(session_id);
                    if perception_on {
                        // Real judge: one Triage-route completion; ANY error
                        // → "" → Uncertain → escalate (safe).
                        let settings = settings_for_task.clone();
                        let judge = |prompt: String| {
                            let settings = settings.clone();
                            async move { perception_judge(&settings, prompt).await }
                        };
                        let consec = tab_for_task.perception_consecutive.load(Ordering::Acquire);
                        match perception_decide_async(&request, consec, PERCEPTION_CAP, judge).await
                        {
                            PerceptionOutcome::Answered { option_id, reason } => {
                                // `respond_permission` takes references, so
                                // request_key/request survive a failure and can
                                // still be forwarded. Only a SUCCESSFUL answer
                                // counts: on Err we uphold escalate-on-failure —
                                // no counter bump, no false audit, and the prompt
                                // falls through to the human (below), never lost.
                                match tab_for_task
                                    .session
                                    .respond_permission(&request_key, &option_id)
                                    .await
                                {
                                    Ok(()) => {
                                        tab_for_task
                                            .perception_consecutive
                                            .fetch_add(1, Ordering::AcqRel);
                                        if let Err(e) = app_for_task.emit(
                                            &topic_for_task,
                                            &AcpTabEvent::PerceptionAutoAnswer {
                                                request_key,
                                                option_id,
                                                reason,
                                            },
                                        ) {
                                            tracing::warn!(
                                                ?e,
                                                topic = %topic_for_task,
                                                "acp perception auto-answer emit failed"
                                            );
                                        }
                                        // Handled headlessly — do NOT forward
                                        // the prompt to the UI.
                                        continue;
                                    }
                                    Err(e) => {
                                        tracing::warn!(
                                            ?e,
                                            "perception: respond_permission failed; \
                                             escalating prompt to human"
                                        );
                                        // Escalate: hand back to the human and
                                        // break the streak, exactly like the
                                        // Escalated path.
                                        tab_for_task
                                            .perception_consecutive
                                            .store(0, Ordering::Release);
                                        AcpTabEvent::PermissionPending {
                                            request_key,
                                            request,
                                        }
                                    }
                                }
                            }
                            PerceptionOutcome::Escalated => {
                                // Handing back breaks the auto-answer streak.
                                tab_for_task
                                    .perception_consecutive
                                    .store(0, Ordering::Release);
                                AcpTabEvent::PermissionPending {
                                    request_key,
                                    request,
                                }
                            }
                        }
                    } else {
                        AcpTabEvent::PermissionPending {
                            request_key,
                            request,
                        }
                    }
                }
                AcpSessionEvent::Closed => {
                    on_dead(
                        &app_for_task,
                        &topic_for_task,
                        &notch_hub_task,
                        &registry_task,
                        session_id,
                    )
                    .await;
                    break;
                }
            };
            if let Err(e) = app_for_task.emit(&topic_for_task, &payload) {
                tracing::warn!(?e, topic = %topic_for_task, "acp event emit failed");
            }
        }
    });

    // Best-effort default model. Fires for ANY executor whose reported
    // currentModelId differs from cfg.model — for claude that's normally
    // a no-op (the model was baked into its settings.json above, so the
    // ids match), and if they somehow differ the extra request is a
    // harmless second attempt. copilot/opencode honor `session/set_model`
    // directly. Errors are ignored — a picky adapter shouldn't fail the
    // whole spawn over this.
    if let Some(want) = cfg.model.as_deref() {
        if model.as_deref() != Some(want) {
            let _ = session
                .request(
                    "session/set_model",
                    json!({ "sessionId": acp_session_id_out.clone(), "modelId": want }),
                )
                .await;
        }
    }

    state.acp_sessions.insert(session_id, tab_session).await;
    Ok(SpawnAcpResult {
        session_id: session_id.to_string(),
        model,
        acp_session_id: acp_session_id_out,
        resumed,
        trust: cfg.trust,
    })
}

/// Idempotent by construction: `remove` on an id the forwarder task
/// already reaped (child died → `AcpSessionEvent::Closed` →
/// `on_dead`'s `registry.remove`, see `spawn_acp_session`) returns `None`
/// and we just skip the shutdown — no error. This matters for
/// `AcpChatView.restart()` on the frontend: by the time the user sees the
/// "Restart session" control the old session is already dead (that's why
/// the notice showed up), so the forwarder has typically already removed
/// it from the registry before `restart()` ever gets a chance to call
/// `close_acp_session` on the old id — and even if it raced ahead of the
/// forwarder, this being a silent no-op keeps that race harmless.
#[tauri::command]
pub async fn close_acp_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let id = parse_session_id(&session_id)?;
    if let Some(tab) = state.acp_sessions.remove(&id).await {
        tab.session.shutdown(Duration::from_secs(2)).await;
    }
    state.notch_hub.drop_session(&id).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

/// A pasted image riding the prompt: base64 payload (no data: prefix)
/// plus its mime type. Becomes an ACP `image` content block — both
/// copilot and pi-acp advertise `promptCapabilities.image`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpImageAttachment {
    pub mime_type: String,
    pub data: String,
}

#[tauri::command]
pub async fn acp_send_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    attachments: Option<Vec<String>>,
    images: Option<Vec<AcpImageAttachment>>,
) -> Result<(), String> {
    let (id, tab) = require(&state, &session_id).await?;

    // Build the prompt blocks BEFORE taking the in_flight flag: an
    // attachment error must not strand the flag set and brick the
    // composer. Attachments (@-mentions) become embedded `resource`
    // blocks — copilot advertised `promptCapabilities.embeddedContext`.
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    for rel in attachments.unwrap_or_default() {
        const ATTACHMENT_CAP: u64 = 256 * 1024;
        let root = tab.cwd.canonicalize().unwrap_or_else(|_| tab.cwd.clone());
        let canon = root
            .join(&rel)
            .canonicalize()
            .map_err(|e| format!("attachment {rel}: {e}"))?;
        if !canon.starts_with(&root) {
            return Err(format!("attachment escapes the session cwd: {rel}"));
        }
        let meta = tokio::fs::metadata(&canon)
            .await
            .map_err(|e| format!("attachment {rel}: {e}"))?;
        if !meta.is_file() {
            return Err(format!("attachment is not a file: {rel}"));
        }
        if meta.len() > ATTACHMENT_CAP {
            return Err(format!("attachment too large (>256 KiB): {rel}"));
        }
        let bytes = tokio::fs::read(&canon)
            .await
            .map_err(|e| format!("attachment {rel}: {e}"))?;
        blocks.push(json!({
            "type": "resource",
            "resource": {
                "uri": format!("file://{}", canon.display()),
                "mimeType": "text/plain",
                "text": String::from_utf8_lossy(&bytes),
            }
        }));
    }
    // Pasted images → ACP `image` blocks. Cap the base64 payload so a
    // screenshot can ride along but a 50 MB scan can't wedge the pipe.
    // ponytail: 8 MiB b64 ≈ 6 MiB raw; raise if real screenshots hit it.
    const IMAGE_B64_CAP: usize = 8 * 1024 * 1024;
    for (i, img) in images.unwrap_or_default().into_iter().enumerate() {
        if !img.mime_type.starts_with("image/") {
            return Err(format!(
                "image {i}: unsupported mime type {}",
                img.mime_type
            ));
        }
        if img.data.is_empty() {
            return Err(format!("image {i}: empty payload"));
        }
        if img.data.len() > IMAGE_B64_CAP {
            return Err(format!("image {i}: too large (>6 MiB)"));
        }
        blocks.push(json!({
            "type": "image",
            "mimeType": img.mime_type,
            "data": img.data,
        }));
    }

    if tab.in_flight.swap(true, Ordering::AcqRel) {
        return Err("acp: prompt already in flight".to_string());
    }

    // A real user prompt: the composer, past the in-flight guard (so a
    // double-send can't double-count). Labelled with the tab's executor,
    // the same string `register_external` uses.
    karl_score::record_prompt_with_agent(&tab.executor, Some(&tab.executor));

    // Feed the tab's world model (operator context). `text` was moved
    // into the first prompt block above.
    if let Some(t) = blocks[0].get("text").and_then(Value::as_str) {
        match tab.world.lock() {
            Ok(mut w) => w.record_user(t),
            Err(poisoned) => poisoned.into_inner().record_user(t),
        }
    }

    let topic = format!("session://{id}/acp");
    let notch_hub = state.notch_hub.clone();
    let acp_session_id = tab.wire_id();
    let session = tab.session.clone();
    let tab_for_flag = tab.clone();
    tokio::spawn(async move {
        let result = session
            .request(
                "session/prompt",
                json!({
                    "sessionId": acp_session_id,
                    "prompt": blocks
                }),
            )
            .await;
        let stop_reason = match result {
            Ok(v) => v
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            Err(e) => e.to_string(),
        };
        tab_for_flag.in_flight.store(false, Ordering::Release);
        // Turn boundary: fold the streamed chunks into one Agent turn.
        match tab_for_flag.world.lock() {
            Ok(mut w) => w.flush_agent_turn(),
            Err(poisoned) => poisoned.into_inner().flush_agent_turn(),
        }
        notch_hub
            .set_phase(
                id,
                ExecutorPhase::Done {
                    summary: Some(stop_reason.clone()),
                },
            )
            .await;
        if let Err(e) = app.emit(&topic, &AcpTabEvent::PromptDone { stop_reason }) {
            tracing::warn!(?e, topic = %topic, "acp prompt-done emit failed");
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn acp_respond_permission(
    state: State<'_, AppState>,
    session_id: String,
    request_key: String,
    option_id: String,
) -> Result<(), String> {
    let (_, tab) = require(&state, &session_id).await?;
    // A human click breaks the Perception auto-answer streak.
    tab.perception_consecutive.store(0, Ordering::Release);
    tab.session
        .respond_permission(&request_key, &option_id)
        .await
        .map_err(|e| e.to_string())
}

/// Frontend signal that its Tauri event listener for this session's
/// topic is registered — unblocks the forwarder's first emit (see the
/// ready gate in `spawn_acp_session`). Idempotent.
#[tauri::command]
pub async fn acp_mark_ready(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let (_, tab) = require(&state, &session_id).await?;
    let _ = tab.ready_tx.send(true);
    Ok(())
}

/// One-shot LLM tab title from the chat transcript — same titler the PTY
/// summarizer uses off the live screen (ACP tabs have neither). Returns
/// None when no summary route is configured; the frontend keeps its
/// prompt-derived fallback title in that case.
#[tauri::command]
pub async fn acp_suggest_title(
    state: State<'_, AppState>,
    session_id: String,
    transcript: String,
) -> Result<Option<String>, String> {
    let id = parse_session_id(&session_id)?;
    crate::summarizer::suggest_title_oneshot(id, &state.settings, &state.vitals, &transcript).await
}

/// Model roster + current selection for the tab's model picker.
#[tauri::command]
pub async fn acp_get_models(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<AcpModels, String> {
    let (_, tab) = require(&state, &session_id).await?;
    let models = match tab.models.lock() {
        Ok(m) => m.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    Ok(models)
}

/// Switch the session's model. Copilot implements `session/set_model`
/// (verified live vs 1.0.68); pi-acp doesn't — its model switch is the
/// spec's config-option surface: `session/set_config_option` with
/// `configId: "model"` (verified live vs pi-acp 0.0.31). Try the direct
/// method first and fall back on Method-not-found, so future executors
/// get whichever surface they implement without a per-executor table.
#[tauri::command]
pub async fn acp_set_model(
    state: State<'_, AppState>,
    session_id: String,
    model_id: String,
) -> Result<(), String> {
    let (_, tab) = require(&state, &session_id).await?;
    let direct = tab
        .session
        .request(
            "session/set_model",
            json!({ "sessionId": tab.wire_id(), "modelId": model_id }),
        )
        .await;
    match direct {
        Ok(_) => {}
        Err(e) if e.to_string().contains("Method not found") => {
            tab.session
                .request(
                    "session/set_config_option",
                    json!({
                        "sessionId": tab.wire_id(),
                        "configId": "model",
                        "value": model_id,
                    }),
                )
                .await
                .map_err(|e| e.to_string())?;
        }
        Err(e) => return Err(e.to_string()),
    }
    match tab.models.lock() {
        Ok(mut m) => m.current = Some(model_id),
        Err(poisoned) => poisoned.into_inner().current = Some(model_id),
    }
    Ok(())
}

/// Switch a live session's trust level. The resolver picks up the new
/// level on the next permission request; for adapters with native ACP
/// modes (claude) we also flip `session/set_mode` so the agent stops
/// generating requests at all in Yolo. Method-not-found is fine — most
/// adapters don't implement modes.
#[tauri::command]
pub async fn acp_set_trust(
    state: State<'_, AppState>,
    session_id: String,
    trust: AcpTrust,
) -> Result<(), String> {
    let (_, tab) = require(&state, &session_id).await?;
    match tab.trust.write() {
        Ok(mut g) => *g = trust,
        Err(poisoned) => *poisoned.into_inner() = trust,
    }
    let mode = match trust {
        AcpTrust::Yolo => "bypassPermissions",
        _ => "default",
    };
    let _ = tab
        .session
        .request(
            "session/set_mode",
            json!({ "sessionId": tab.wire_id(), "modeId": mode }),
        )
        .await;
    Ok(())
}

/// Latest slash-command roster for a session. The frontend calls this
/// once after subscribing to the event topic — the roster's initial
/// broadcast races the webview's `listen` registration, so a pull-based
/// read is the only race-free way to seed the autocomplete.
#[tauri::command]
pub async fn acp_get_commands(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<AvailableCommand>, String> {
    let (_, tab) = require(&state, &session_id).await?;
    let commands = match tab.commands.lock() {
        Ok(c) => c.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    Ok(commands)
}

/// One row of the /resume picker: a past conversation the agent can load.
/// Shape verified live on copilot 1.0.68, pi-acp 0.0.31 and
/// claude-agent-acp 0.23.1 — all return `{sessionId, cwd, title, updatedAt}`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionListing {
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

/// List the agent's stored past sessions (`session/list`) for the tab's cwd.
#[tauri::command]
pub async fn acp_list_sessions(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<AcpSessionListing>, String> {
    let (_, tab) = require(&state, &session_id).await?;
    let res = tab
        .session
        .request("session/list", json!({ "cwd": tab.cwd.to_string_lossy() }))
        .await
        .map_err(|e| e.to_string())?;
    let sessions = res
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(sessions
        .iter()
        .filter_map(|s| {
            Some(AcpSessionListing {
                session_id: s.get("sessionId")?.as_str()?.to_string(),
                cwd: s.get("cwd").and_then(Value::as_str).map(str::to_string),
                title: s.get("title").and_then(Value::as_str).map(str::to_string),
                updated_at: s
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect())
}

/// Load a past conversation into the live tab (`session/load`). The agent
/// replays the whole transcript as ordinary `session/update` frames through
/// the existing forwarder — the caller clears its view first and lets the
/// replay repopulate it. On success the tab's wire id is swapped so all
/// subsequent prompts/cancels/model-switches target the loaded session.
#[tauri::command]
pub async fn acp_load_session(
    state: State<'_, AppState>,
    session_id: String,
    acp_session_id: String,
) -> Result<AcpModels, String> {
    let (_, tab) = require(&state, &session_id).await?;
    if tab.in_flight.load(Ordering::Acquire) {
        return Err("acp: prompt in flight — wait for the turn to finish".into());
    }
    let res = tab
        .session
        .request(
            "session/load",
            json!({
                "sessionId": acp_session_id,
                "cwd": tab.cwd.to_string_lossy(),
                "mcpServers": [],
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
    match tab.acp_session_id.lock() {
        Ok(mut g) => *g = acp_session_id,
        Err(poisoned) => *poisoned.into_inner() = acp_session_id,
    }
    let models = parse_models(&res);
    // session/load may omit models (agent-dependent) — keep the old roster then.
    if !models.available.is_empty() || models.current.is_some() {
        match tab.models.lock() {
            Ok(mut m) => *m = models.clone(),
            Err(poisoned) => *poisoned.into_inner() = models.clone(),
        }
    }
    Ok(models)
}

#[tauri::command]
pub async fn acp_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let (_, tab) = require(&state, &session_id).await?;
    tab.session
        .notify("session/cancel", json!({ "sessionId": tab.wire_id() }))
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_session_id(session_id: &str) -> Result<SessionId, String> {
    session_id
        .parse::<SessionId>()
        .map_err(|e| format!("invalid acp session id {session_id:?}: {e}"))
}

async fn require(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(SessionId, Arc<AcpTabSession>), String> {
    let id = parse_session_id(session_id)?;
    let tab = state
        .acp_sessions
        .get(&id)
        .await
        .ok_or_else(|| format!("no acp session: {session_id}"))?;
    Ok((id, tab))
}

#[cfg(test)]
mod tests {
    use super::*;
    use karl_agent::acp::protocol::{PermissionRequest, ToolCallFields};

    fn notification(update_json: &str) -> SessionNotification {
        let raw = format!(r#"{{"sessionId":"s1","update":{update_json}}}"#);
        serde_json::from_str(&raw).expect("notification fixture parses")
    }

    #[test]
    fn edit_tool_call_maps_to_writing_with_diff_path() {
        let n = notification(
            r#"{"sessionUpdate":"tool_call","toolCallId":"t1","kind":"edit","content":[{"type":"diff","path":"/w/fib.py","newText":"x"}]}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Writing { file }) if file == "/w/fib.py"
        ));
    }

    #[test]
    fn edit_tool_call_falls_back_to_raw_input_file_name() {
        let n = notification(
            r#"{"sessionUpdate":"tool_call_update","toolCallId":"t1","kind":"edit","rawInput":{"fileName":"src/main.rs"}}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Writing { file }) if file == "src/main.rs"
        ));
    }

    #[test]
    fn execute_tool_call_maps_to_running_with_command() {
        let n = notification(
            r#"{"sessionUpdate":"tool_call","toolCallId":"t1","kind":"execute","rawInput":{"command":"cargo test"}}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Running { cmd }) if cmd == "cargo test"
        ));
    }

    #[test]
    fn read_tool_call_maps_to_reading() {
        let n = notification(
            r#"{"sessionUpdate":"tool_call_update","toolCallId":"t1","kind":"read","rawInput":{"fileName":"README.md"}}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Reading { file }) if file == "README.md"
        ));
    }

    #[test]
    fn message_chunk_maps_to_thinking() {
        let n = notification(
            r#"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Thinking)
        ));
    }

    #[test]
    fn thought_chunk_maps_to_thinking() {
        let n = notification(
            r#"{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Thinking)
        ));
    }

    #[test]
    fn unknown_update_kind_maps_to_none() {
        let n =
            notification(r#"{"sessionUpdate":"available_commands_update","availableCommands":[]}"#);
        let ev = AcpSessionEvent::Update(n);
        assert_eq!(acp_event_to_phase(&ev), None);
    }

    #[test]
    fn permission_pending_maps_to_waiting() {
        let req: PermissionRequest = serde_json::from_value(json!({
            "sessionId": "s1",
            "toolCall": { "toolCallId": "t1", "kind": "execute", "rawInput": { "command": "ls" } },
            "options": [{ "optionId": "allow_once", "kind": "allow_once" }]
        }))
        .expect("permission fixture parses");
        let ev = AcpSessionEvent::PermissionPending {
            request_key: "perm-0".into(),
            request: req,
        };
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Waiting { reason }) if reason == "permission"
        ));
    }

    /// Pins the frontend contract (`ui/src/api.ts` `AcpTabEvent`): exact
    /// JSON shape for every variant — snake_case `type` tag, camelCase
    /// field names. If this test needs to change, `ui/src/api.ts` needs a
    /// matching change.
    #[test]
    fn acp_tab_event_wire_shape() {
        let prompt_done = AcpTabEvent::PromptDone {
            stop_reason: "end_turn".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&prompt_done).expect("serialize"),
            json!({ "type": "prompt_done", "stopReason": "end_turn" })
        );

        let session_dead = AcpTabEvent::SessionDead;
        assert_eq!(
            serde_json::to_value(&session_dead).expect("serialize"),
            json!({ "type": "session_dead" })
        );

        let update = AcpTabEvent::Update {
            update: notification(
                r#"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}"#,
            ),
        };
        let update_value = serde_json::to_value(&update).expect("serialize");
        assert_eq!(update_value["type"], "update");
        assert_eq!(update_value["update"]["sessionId"], "s1");
        assert_eq!(
            update_value["update"]["update"]["sessionUpdate"],
            "agent_message_chunk"
        );

        let permission_pending = AcpTabEvent::PermissionPending {
            request_key: "perm-0".to_string(),
            request: serde_json::from_value(json!({
                "sessionId": "s1",
                "toolCall": { "toolCallId": "t1", "kind": "execute", "rawInput": { "command": "ls" } },
                "options": [{ "optionId": "allow_once", "kind": "allow_once" }]
            }))
            .expect("permission fixture parses"),
        };
        let permission_value = serde_json::to_value(&permission_pending).expect("serialize");
        assert_eq!(permission_value["type"], "permission_pending");
        assert_eq!(permission_value["requestKey"], "perm-0");
        assert_eq!(permission_value["request"]["sessionId"], "s1");
    }

    fn perm_req(kind: &str, cmd: Option<&str>, opts: &[(&str, &str)]) -> PermissionRequest {
        let options: Vec<Value> = opts
            .iter()
            .map(|(id, k)| json!({ "optionId": id, "kind": k }))
            .collect();
        let mut tool_call = json!({ "toolCallId": "t1", "kind": kind });
        if let Some(c) = cmd {
            tool_call["rawInput"] = json!({ "command": c });
        }
        serde_json::from_value(json!({
            "sessionId": "s1",
            "toolCall": tool_call,
            "options": options,
        }))
        .expect("permission fixture parses")
    }

    #[tokio::test]
    async fn perception_step_auto_answers_trivial_safe() {
        let req = perm_req(
            "read",
            None,
            &[("allow_once", "allow_once"), ("reject_once", "reject_once")],
        );
        let judge =
            |_p: String| async { r#"{"trivial":true,"option_id":"allow_once"}"#.to_string() };
        let out = perception_decide_async(&req, 0, PERCEPTION_CAP, judge).await;
        assert!(
            matches!(out, PerceptionOutcome::Answered { option_id, .. } if option_id == "allow_once")
        );
    }

    #[tokio::test]
    async fn perception_step_escalates_when_judge_uncertain() {
        let req = perm_req("read", None, &[("allow_once", "allow_once")]);
        let judge = |_p: String| async { r#"{"trivial":false}"#.to_string() };
        let out = perception_decide_async(&req, 0, PERCEPTION_CAP, judge).await;
        assert!(matches!(out, PerceptionOutcome::Escalated));
    }

    #[tokio::test]
    async fn perception_step_escalates_on_judge_error_empty_reply() {
        // The real judge returns "" on ANY model error — must escalate, not
        // auto-answer.
        let req = perm_req("read", None, &[("allow_once", "allow_once")]);
        let judge = |_p: String| async { String::new() };
        let out = perception_decide_async(&req, 0, PERCEPTION_CAP, judge).await;
        assert!(matches!(out, PerceptionOutcome::Escalated));
    }

    #[tokio::test]
    async fn perception_step_escalates_at_cap_even_if_trivial() {
        // Handback guard: at the cap, hand back regardless of the verdict.
        let req = perm_req("read", None, &[("allow_once", "allow_once")]);
        let judge =
            |_p: String| async { r#"{"trivial":true,"option_id":"allow_once"}"#.to_string() };
        let out = perception_decide_async(&req, PERCEPTION_CAP, PERCEPTION_CAP, judge).await;
        assert!(matches!(out, PerceptionOutcome::Escalated));
    }

    #[test]
    fn perception_auto_answer_wire_shape() {
        let ev = AcpTabEvent::PerceptionAutoAnswer {
            request_key: "perm-0".into(),
            option_id: "allow_once".into(),
            reason: "trivial + safe (read)".into(),
        };
        let v = serde_json::to_value(&ev).expect("serialize");
        assert_eq!(v["type"], "perception_auto_answer");
        assert_eq!(v["requestKey"], "perm-0");
        assert_eq!(v["optionId"], "allow_once");
        assert_eq!(v["reason"], "trivial + safe (read)");
    }

    /// `SessionUpdate` must survive Serialize → Deserialize with its
    /// internal tag intact, proving the `Serialize` derives added
    /// alongside the existing `Deserialize` ones in `protocol.rs` don't
    /// disturb the wire shape (`#[serde(other)] Unknown` in particular).
    #[test]
    fn session_update_serde_round_trip_preserves_tag() {
        let original = SessionUpdate::ToolCall(ToolCallFields {
            tool_call_id: "t1".into(),
            title: Some("Run fib.py".into()),
            kind: Some("execute".into()),
            status: Some("pending".into()),
            raw_input: Some(json!({ "command": "ls" })),
            raw_output: None,
            content: vec![],
        });

        let value = serde_json::to_value(&original).expect("serialize");
        assert_eq!(value["sessionUpdate"], "tool_call");
        assert_eq!(value["toolCallId"], "t1");

        let round_tripped: SessionUpdate = serde_json::from_value(value).expect("deserialize");
        match round_tripped {
            SessionUpdate::ToolCall(f) => {
                assert_eq!(f.tool_call_id, "t1");
                assert_eq!(f.kind.as_deref(), Some("execute"));
                assert_eq!(f.command(), Some("ls"));
            }
            other => panic!("wrong variant after round-trip: {other:?}"),
        }
    }
}

#[cfg(test)]
mod claude_config_tests {
    use super::*;
    use crate::settings::AcpExecutorConfig;

    #[test]
    fn patches_default_mode_and_model_preserving_other_keys() {
        let tmp = tempfile::tempdir().expect("tmpdir");
        // Pre-existing hand-edited file with a custom key.
        let dir = tmp.path().join("claude-acp");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(
            dir.join("settings.json"),
            r#"{ "statusLine": {"type":"command","command":"x"}, "permissions": {"deny":["Bash(rm:*)"]} }"#,
        )
        .expect("seed");

        let cfg = AcpExecutorConfig {
            trust: AcpTrust::Yolo,
            model: Some("claude-sonnet-4.6".into()),
            ..Default::default()
        };
        let out = prepare_claude_acp_config(tmp.path(), &cfg).expect("prep");
        let raw = std::fs::read_to_string(out.join("settings.json")).expect("read");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(v["permissions"]["defaultMode"], "bypassPermissions");
        assert_eq!(v["model"], "claude-sonnet-4.6");
        // Hand-added keys survive.
        assert_eq!(v["statusLine"]["type"], "command");
        assert_eq!(v["permissions"]["deny"][0], "Bash(rm:*)");

        // Downgrade to Balanced: mode derived back, model removed when unset.
        let cfg2 = AcpExecutorConfig::default();
        prepare_claude_acp_config(tmp.path(), &cfg2).expect("prep2");
        let v2: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("settings.json")).expect("read2"),
        )
        .expect("json2");
        assert_eq!(v2["permissions"]["defaultMode"], "default");
        assert!(v2.get("model").is_none());
        assert_eq!(v2["permissions"]["deny"][0], "Bash(rm:*)");
    }
}
