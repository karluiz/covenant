# ACP Executor Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-executor ACP launch configuration (trust level Ask/Balanced/YOLO + model + thinking budget + env + args) in Settings → Harnesses, with a live per-tab trust chip.

**Architecture:** Config lives in `Settings.acp_executors` (config.json). `spawn_acp_session` translates trust to each adapter's native mechanism (claude → `permissions.defaultMode` in the isolated CLAUDE_CONFIG_DIR; copilot → `--allow-all-tools`; opencode → `OPENCODE_PERMISSION` env) and the client-side `PermissionResolver` becomes trust-aware as universal safety net. A per-session `Arc<RwLock<AcpTrust>>` lets `acp_set_trust` retarget a live session.

**Tech Stack:** Rust (tauri command layer `crates/app`, policy/session `crates/agent`), TypeScript (settings UI, ACP tab view), vitest + cargo test.

**Spec:** `docs/superpowers/specs/2026-07-13-acp-executor-config-design.md`

## Global Constraints

- Work happens in a git worktree (superpowers:using-git-worktrees). Stage files explicitly — NEVER `git add -A` (worktree has a node_modules symlink that must not be committed).
- Rust: no `unwrap()` outside `#[cfg(test)]`; `thiserror` in lib crates.
- UI: sharp corners (`border-radius: 0`), `attachTooltip` never `element.title`, inline SVG never emoji, English copy, True Dark elevation = neutral lifts.
- `npm test` (vitest) runs from repo ROOT, not `ui/`. `cargo test -p <crate>` for Rust.
- Conventional Commits; one feature-coherent commit per task.
- Existing behavior preserved: copilot interactive tabs keep allow-all by DEFAULT (trust Yolo when unconfigured); operator/headless path (`crates/agent/src/acp/run.rs`) untouched.

---

### Task 1: `AcpTrust` + YOLO resolution in policy.rs

**Files:**
- Modify: `crates/agent/src/acp/policy.rs`
- Modify: `crates/agent/src/acp/mod.rs` (re-export, if policy items are re-exported there — check `pub use`)

**Interfaces:**
- Produces: `pub enum AcpTrust { Ask, Balanced, Yolo }` (Copy, serde snake_case, `Default` = Balanced) and `pub fn resolve_yolo(req: &PermissionRequest) -> String`. Task 2 stores `AcpTrust` in settings; Task 4 uses both in the resolver.

- [ ] **Step 1: Write failing tests** — append to the `tests` module in `policy.rs`:

```rust
#[test]
fn yolo_allows_dangerous_execute_without_persisting() {
    // YOLO allows what Balanced denies…
    let r = req("execute", Some("sudo rm -rf /tmp/x"));
    assert_eq!(resolve_yolo(&r), "allow_once");
    // …but still never picks a persistent grant.
    let mut only_always = req("edit", None);
    only_always.options = serde_json::from_value(serde_json::json!([
        { "optionId": "aa", "kind": "allow_always", "name": "Always allow" }
    ]))
    .expect("fixture parses");
    assert_eq!(resolve_yolo(&only_always), "");
}

#[test]
fn trust_default_is_balanced() {
    assert_eq!(AcpTrust::default(), AcpTrust::Balanced);
    // Wire format is snake_case lowercase words.
    assert_eq!(serde_json::to_string(&AcpTrust::Yolo).expect("ser"), "\"yolo\"");
    let t: AcpTrust = serde_json::from_str("\"ask\"").expect("de");
    assert_eq!(t, AcpTrust::Ask);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p karl-agent yolo_allows -- --nocapture` — Expected: compile error (`resolve_yolo`, `AcpTrust` not found).

- [ ] **Step 3: Implement** — in `policy.rs`, above `resolve_headless`:

```rust
/// Per-session trust level for interactive ACP tabs. `Ask` defers every
/// permission request to the user; `Balanced` is the historical hybrid
/// (edits/reads/safe commands auto-allowed); `Yolo` auto-allows
/// everything — the native equivalent of --dangerously-skip-permissions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpTrust {
    Ask,
    #[default]
    Balanced,
    Yolo,
}

/// YOLO: allow everything. Shares `pick_option`'s floor — never selects
/// an "always" option (no grant outlives the session), degrades to ""
/// (caller defers to the user) when only alien/persistent options exist.
pub fn resolve_yolo(req: &PermissionRequest) -> String {
    pick_option(req, true)
}
```

Check `crates/agent/src/acp/mod.rs`: if it re-exports policy items (`pub use policy::…`), add `AcpTrust` and `resolve_yolo` to the list.

- [ ] **Step 4: Run tests**

Run: `cargo test -p karl-agent acp::policy` — Expected: all PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/acp/policy.rs crates/agent/src/acp/mod.rs
git commit -m "feat(acp): AcpTrust levels + resolve_yolo in permission policy"
```

---

### Task 2: `AcpExecutorConfig` in settings

**Files:**
- Modify: `crates/app/src/settings.rs`

**Interfaces:**
- Consumes: `karl_agent::acp::policy::AcpTrust` (Task 1; adjust path to the actual re-export).
- Produces: `pub struct AcpExecutorConfig { trust: AcpTrust, model: Option<String>, thinking_tokens: Option<u32>, env: Vec<(String, String)>, args: Vec<String> }` (Clone, Default, serde with `#[serde(default)]` on every field); `Settings.acp_executors: HashMap<String, AcpExecutorConfig>`; `Settings::acp_executor(&self, executor: &str) -> AcpExecutorConfig`. Task 4 calls the accessor; Task 6 reads/writes the map over the settings wire.

- [ ] **Step 1: Write failing tests** — in `settings.rs`'s test module (create `#[cfg(test)] mod acp_executor_tests` if none fits):

```rust
#[test]
fn acp_executor_defaults() {
    let s: Settings = serde_json::from_str("{}").expect("empty settings parse");
    // Unconfigured copilot preserves the historical hard-coded
    // --allow-all-tools behavior; everyone else starts Balanced.
    assert_eq!(s.acp_executor("copilot").trust, AcpTrust::Yolo);
    assert_eq!(s.acp_executor("claude").trust, AcpTrust::Balanced);
    assert_eq!(s.acp_executor("pi").trust, AcpTrust::Balanced);
}

#[test]
fn acp_executor_roundtrip() {
    let json = r#"{ "acp_executors": { "claude": {
        "trust": "yolo", "model": "claude-sonnet-4.6",
        "thinking_tokens": 8192,
        "env": [["FOO", "bar"]], "args": ["--hide-claude-auth"]
    } } }"#;
    let s: Settings = serde_json::from_str(json).expect("parse");
    let c = s.acp_executor("claude");
    assert_eq!(c.trust, AcpTrust::Yolo);
    assert_eq!(c.model.as_deref(), Some("claude-sonnet-4.6"));
    assert_eq!(c.thinking_tokens, Some(8192));
    assert_eq!(c.env, vec![("FOO".to_string(), "bar".to_string())]);
    assert_eq!(c.args, vec!["--hide-claude-auth".to_string()]);
    // Round-trips through save format.
    let back: Settings =
        serde_json::from_str(&serde_json::to_string(&s).expect("ser")).expect("de");
    assert_eq!(back.acp_executor("claude").trust, AcpTrust::Yolo);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p karl-app acp_executor` — Expected: compile error (missing type/field). (Confirm the app crate's package name via `crates/app/Cargo.toml` `name =`; use it for `-p`.)

- [ ] **Step 3: Implement** — in `settings.rs`, near the other config structs:

```rust
pub use karl_agent::acp::policy::AcpTrust; // adjust to actual module path

/// Launch configuration for one interactive ACP executor
/// ("claude" | "copilot" | "opencode" | "pi"). Missing entries fall back
/// to `Settings::acp_executor`'s per-executor defaults.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AcpExecutorConfig {
    #[serde(default)]
    pub trust: AcpTrust,
    /// Default model for new sessions (claude: isolated settings.json;
    /// others: best-effort session/set_model after session/new).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Thinking budget in tokens — claude only (MAX_THINKING_TOKENS).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_tokens: Option<u32>,
    /// Extra env for the adapter process; applied LAST so it can
    /// override trust-derived entries (e.g. OPENCODE_PERMISSION).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<(String, String)>,
    /// Extra CLI args appended after the adapter's own args.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
}
```

Add the field to `Settings`:

```rust
    /// Per-executor ACP launch config (Settings → Harnesses → ACP agents).
    #[serde(default)]
    pub acp_executors: HashMap<String, AcpExecutorConfig>,
```

And the accessor on `impl Settings` (find the existing `impl Settings` block):

```rust
    pub fn acp_executor(&self, executor: &str) -> AcpExecutorConfig {
        self.acp_executors.get(executor).cloned().unwrap_or_else(|| AcpExecutorConfig {
            // Copilot ACP tabs have always launched --allow-all-tools;
            // keep that status quo until the user says otherwise.
            trust: if executor == "copilot" { AcpTrust::Yolo } else { AcpTrust::Balanced },
            ..AcpExecutorConfig::default()
        })
    }
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p karl-app acp_executor` — Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/settings.rs
git commit -m "feat(settings): per-executor AcpExecutorConfig with copilot-yolo default"
```

---

### Task 3: Copilot launch profile becomes explicit (allow-all moves out)

**Files:**
- Modify: `crates/agent/src/acp/session.rs:69-76` (copilot arm of `for_executor`) and `:872-900` (`for_executor_profiles` test)

**Interfaces:**
- Produces: `for_executor("copilot", cwd)` now returns `agent_args: Some(vec!["--acp", "--add-dir", <cwd>])` — WITHOUT `--allow-all-tools`. Task 4 appends that flag only when trust is Yolo.
- The `None` branch inside `AcpSession::spawn` (`session.rs:266-282`) is NOT touched — `run.rs::run_task` (operator/headless path) still relies on it.

- [ ] **Step 1: Update the test first** — in `for_executor_profiles` (session.rs:872), replace the copilot assertions with:

```rust
        let c = AcpSpawnOpts::for_executor("copilot", cwd.clone()).unwrap();
        assert_eq!(c.program, None);
        let copilot_args = c.agent_args.expect("copilot profile is explicit");
        assert_eq!(
            copilot_args,
            vec!["--acp".to_string(), "--add-dir".to_string(), cwd.to_string_lossy().into_owned()]
        );
        assert!(
            !copilot_args.iter().any(|a| a == "--allow-all-tools"),
            "allow-all is trust-derived now, not baked into the profile"
        );
```

(Keep whatever other copilot assertions exist that still hold, e.g. `extra_args` empty.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p karl-agent for_executor_profiles` — Expected: FAIL (`agent_args` is `None`).

- [ ] **Step 3: Implement** — replace the copilot arm in `for_executor`:

```rust
            // Interactive-tab profile. Explicit agent_args (no
            // --allow-all-tools here): the app layer appends it only when
            // the executor's configured trust is Yolo. The legacy `None`
            // branch in `spawn` keeps allow-all for the headless
            // operator path (run.rs), which has its own deny-biased
            // resolver semantics and predates trust config.
            "copilot" => Ok(Self {
                cwd: cwd.clone(),
                program: None,
                extra_args: Vec::new(),
                agent_args: Some(vec![
                    "--acp".to_string(),
                    "--add-dir".to_string(),
                    cwd.to_string_lossy().into_owned(),
                ]),
                env: Vec::new(),
            }),
```

(Note `cwd` is both moved into the struct and read for the arg — bind `let cwd_arg = cwd.to_string_lossy().into_owned();` before constructing if the borrow checker complains.)

- [ ] **Step 4: Run tests**

Run: `cargo test -p karl-agent` — Expected: all PASS (spawn-double tests use `agent_args: None` and are unaffected).

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/acp/session.rs
git commit -m "refactor(acp): copilot tab profile explicit; allow-all-tools becomes trust-derived"
```

---

### Task 4: Spawn wiring — trust-aware resolver + native mapping + config prep

**Files:**
- Modify: `crates/app/src/acp_commands.rs` — `hybrid_resolver` (:492), `prepare_claude_acp_config` (:401), `spawn_acp_session` (:508-545 region and the `SpawnAcpResult` build), `AcpTabSession` (:201), `SpawnAcpResult` (:376)

**Interfaces:**
- Consumes: `Settings::acp_executor` (Task 2), `resolve_yolo`/`AcpTrust` (Task 1), explicit copilot profile (Task 3).
- Produces: `AcpTabSession.trust: Arc<std::sync::RwLock<AcpTrust>>` (Task 5's `acp_set_trust` writes it); `SpawnAcpResult.trust: AcpTrust` (serialized `"ask" | "balanced" | "yolo"` — Task 7 reads it FE-side); `prepare_claude_acp_config(base, cfg)` new signature.

- [ ] **Step 1: Write failing test for the settings.json patcher** — in `acp_commands.rs`'s test module (create one if absent):

```rust
#[cfg(test)]
mod claude_config_tests {
    use super::*;
    use crate::settings::{AcpExecutorConfig, AcpTrust};

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
```

If `tempfile` is not already a dev-dependency of the app crate, add it to `crates/app/Cargo.toml` `[dev-dependencies]` (check first — several crates in this workspace already use it).

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p karl-app patches_default_mode` — Expected: compile error (signature takes 1 arg).

- [ ] **Step 3: Implement the patcher** — change `prepare_claude_acp_config` signature to `fn prepare_claude_acp_config(base: &std::path::Path, cfg: &crate::settings::AcpExecutorConfig) -> Result<PathBuf, String>` and replace the settings.json block (`:410-413`) with:

```rust
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
            crate::settings::AcpTrust::Yolo => "bypassPermissions",
            _ => "default",
        };
        let perms = obj
            .entry("permissions")
            .or_insert_with(|| json!({}));
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
    std::fs::write(&settings, rendered).map_err(|e| format!("settings.json: {e}"))?;
```

- [ ] **Step 4: Run the patcher test**

Run: `cargo test -p karl-app patches_default_mode` — Expected: PASS. (spawn_acp_session won't compile yet if you changed the signature — fix the call site in the same task, next step.)

- [ ] **Step 5: Wire trust through spawn** — in `spawn_acp_session`, after `let executor = …` (:522):

```rust
    let cfg = { state.settings.lock().await.acp_executor(&executor) };
    let mut spawn_opts = AcpSpawnOpts::for_executor(&executor, cwd.clone())?;

    // Trust → native mechanism. YOLO is enforced adapter-side where
    // possible so permission requests aren't even generated; the
    // trust-aware resolver below covers whatever still leaks through.
    if cfg.trust == crate::settings::AcpTrust::Yolo {
        match executor.as_str() {
            "copilot" => {
                if let Some(args) = spawn_opts.agent_args.as_mut() {
                    args.push("--allow-all-tools".to_string());
                }
            }
            "opencode" => {
                // ponytail: allow-all blob; verify the schema against the
                // installed opencode (1.14.x) before shipping — if the env
                // var is unsupported the client resolver still yolos.
                spawn_opts.env.push((
                    "OPENCODE_PERMISSION".to_string(),
                    r#"{"edit":"allow","bash":"allow","webfetch":"allow"}"#.to_string(),
                ));
            }
            _ => {}
        }
    }

    if executor == "claude" {
        // (existing base/app_config_dir code stays)
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
            spawn_opts.env.push(("MAX_THINKING_TOKENS".to_string(), tokens.to_string()));
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
```

Verify against opencode before finishing this step: `OPENCODE_PERMISSION='{"edit":"allow","bash":"allow","webfetch":"allow"}' opencode run "echo hi" 2>&1 | head` should not error on the env var (also check https://opencode.ai/docs/permissions/ if ambiguous). If the schema differs, fix the blob here and note it in the commit message.

- [ ] **Step 6: Make the resolver trust-aware** — replace `hybrid_resolver` (:492):

```rust
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
                let allows = req
                    .options
                    .iter()
                    .any(|o| o.option_id == choice && o.kind.to_ascii_lowercase().contains("allow"));
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
```

Import `resolve_yolo` next to the existing `policy::resolve_headless` import (:26) and `AcpTrust` from `crate::settings`.

- [ ] **Step 7: Store trust on the tab + return it** — add to `AcpTabSession` (:201):

```rust
    /// Per-session trust level; written by `acp_set_trust`, read by the
    /// resolver closure on every permission request.
    trust: Arc<std::sync::RwLock<AcpTrust>>,
```

Set `trust: trust.clone()` at the construction site (:667). Add to `SpawnAcpResult` (:376):

```rust
    /// Effective trust level the session launched with.
    pub trust: AcpTrust,
```

and populate it (`trust: cfg.trust`) where the result is built. Best-effort default model for non-claude executors — after the point where the spawn fn extracts `currentModelId` from `session/new` (search `currentModelId`, ~:283 helper used near the result build):

```rust
    if let Some(want) = cfg.model.as_deref() {
        if model.as_deref() != Some(want) {
            // Best-effort: copilot/opencode honor session/set_model;
            // claude already got the model via its settings.json.
            let _ = session
                .request(
                    "session/set_model",
                    json!({ "sessionId": acp_session_id, "modelId": want }),
                )
                .await;
        }
    }
```

(Anchor: place it right before `SpawnAcpResult` is constructed, where `model` and `acp_session_id` are both in scope; adjust variable names to what's there.)

- [ ] **Step 8: Full compile + tests**

Run: `cargo test -p karl-app && cargo test -p karl-agent` — Expected: PASS. Then `cargo clippy -p karl-app -p karl-agent --all-targets` — Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add crates/app/src/acp_commands.rs crates/app/Cargo.toml Cargo.lock
git commit -m "feat(acp): trust-aware spawn — native yolo mapping, config-driven env/args/model"
```

---

### Task 5: `acp_set_trust` command + FE API wrappers

**Files:**
- Modify: `crates/app/src/acp_commands.rs` (new command next to `acp_set_model` :1104)
- Modify: `crates/app/src/lib.rs` (invoke_handler list — search `acp_set_model` and add the sibling)
- Modify: `ui/src/api.ts` (wrapper next to `acpSetModel` :2831; `Settings` interface; `SpawnAcpResult`-equivalent type — search `spawnAcpSession` for the result type and add `trust`)

**Interfaces:**
- Consumes: `AcpTabSession.trust` (Task 4).
- Produces: Rust `acp_set_trust(session_id: String, trust: AcpTrust)`; TS `acpSetTrust(sessionId: SessionId, trust: AcpTrust): Promise<void>`, `type AcpTrust = "ask" | "balanced" | "yolo"`, `Settings.acp_executors?: Record<string, AcpExecutorConfig>` with `interface AcpExecutorConfig { trust: AcpTrust; model?: string | null; thinking_tokens?: number | null; env?: [string, string][]; args?: string[] }`. Tasks 6 and 7 consume the TS types.

- [ ] **Step 1: Implement the command** — after `acp_set_model`:

```rust
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
    if let Ok(mut g) = tab.trust.write() {
        *g = trust;
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
```

Register in `lib.rs`: find the `invoke_handler![…]` (or `generate_handler!`) entry `acp_commands::acp_set_model` and add `acp_commands::acp_set_trust` beside it.

- [ ] **Step 2: Compile check**

Run: `cargo check -p karl-app` — Expected: clean.

- [ ] **Step 3: FE types + wrapper** — in `ui/src/api.ts`:

```ts
export type AcpTrust = "ask" | "balanced" | "yolo";

export interface AcpExecutorConfig {
  trust: AcpTrust;
  model?: string | null;
  thinking_tokens?: number | null;
  env?: [string, string][];
  args?: string[];
}

export async function acpSetTrust(sessionId: SessionId, trust: AcpTrust): Promise<void> {
  return invoke<void>("acp_set_trust", { sessionId, trust });
}
```

Add `acp_executors?: Record<string, AcpExecutorConfig>;` to the `Settings` interface (search `export interface Settings` / the type used by `getSettings`). Add `trust: AcpTrust;` to the spawn result type used by `spawnAcpSession`.

- [ ] **Step 4: Typecheck**

Run: `npm run build` (from repo root; it type-checks) — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/acp_commands.rs crates/app/src/lib.rs ui/src/api.ts
git commit -m "feat(acp): acp_set_trust command + FE api wrappers"
```

---

### Task 6: Harnesses → "ACP agents" settings section

**Files:**
- Create: `ui/src/settings/acp_agents.ts`
- Create: `ui/src/settings/acp_agents.test.ts`
- Modify: `ui/src/settings/spawns.ts` (call the new section at the end of `renderSpawnsTab`, :162)
- Modify: `ui/src/styles.css` (or the settings stylesheet the spawns section uses — follow where `.spawns-md-*` classes live)

**Interfaces:**
- Consumes: `getSettings` / `setSettings` / `AcpTrust` / `AcpExecutorConfig` from `../api` (Task 5).
- Produces: `export async function renderAcpAgentsSection(host: HTMLElement): Promise<void>`.

- [ ] **Step 1: Write failing tests** — `ui/src/settings/acp_agents.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api", () => ({
  getSettings: vi.fn(),
  setSettings: vi.fn(),
}));
vi.mock("../tooltip/tooltip", () => ({ attachTooltip: vi.fn() }));

import { getSettings, setSettings } from "../api";
import { renderAcpAgentsSection } from "./acp_agents";

const settings = (over: object = {}) => ({ acp_executors: {}, ...over }) as never;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await renderAcpAgentsSection(host);
  return host;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.mocked(getSettings).mockReset().mockResolvedValue(settings());
  vi.mocked(setSettings).mockReset().mockResolvedValue(undefined);
});

describe("renderAcpAgentsSection", () => {
  it("renders one card per ACP executor with default trust selected", async () => {
    const host = await mount();
    const cards = host.querySelectorAll(".acp-agent-card");
    expect(cards.length).toBe(4); // claude, copilot, opencode, pi
    // copilot's unconfigured default is yolo (status quo), claude's is balanced
    const copilot = host.querySelector('[data-executor="copilot"]');
    expect(copilot?.querySelector('.acp-trust-seg [data-trust="yolo"][aria-pressed="true"]')).toBeTruthy();
    const claude = host.querySelector('[data-executor="claude"]');
    expect(claude?.querySelector('.acp-trust-seg [data-trust="balanced"][aria-pressed="true"]')).toBeTruthy();
  });

  it("persists a trust change via setSettings", async () => {
    const host = await mount();
    const yolo = host.querySelector<HTMLButtonElement>(
      '[data-executor="claude"] .acp-trust-seg [data-trust="yolo"]',
    );
    yolo?.click();
    await flush();
    expect(setSettings).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(setSettings).mock.calls[0][0] as {
      acp_executors: Record<string, { trust: string }>;
    };
    expect(saved.acp_executors.claude.trust).toBe("yolo");
  });

  it("shows thinking budget input only on the claude card", async () => {
    const host = await mount();
    expect(host.querySelector('[data-executor="claude"] .acp-thinking-input')).toBeTruthy();
    expect(host.querySelector('[data-executor="copilot"] .acp-thinking-input')).toBeNull();
  });

  it("hides the model input for pi", async () => {
    const host = await mount();
    expect(host.querySelector('[data-executor="pi"] .acp-model-input')).toBeNull();
    expect(host.querySelector('[data-executor="opencode"] .acp-model-input')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- acp_agents` (repo root) — Expected: FAIL (module not found).

- [ ] **Step 3: Implement `acp_agents.ts`:**

```ts
/// Settings → Harnesses → "ACP agents": per-executor launch config for
/// interactive ACP tabs (trust level, default model, thinking budget,
/// env, extra args). Persists into Settings.acp_executors; the Rust
/// spawn path translates trust to each adapter's native mechanism.
import {
  getSettings,
  setSettings,
  type AcpExecutorConfig,
  type AcpTrust,
} from "../api";
import { brandIconSvg } from "../icons/brands";
import { attachTooltip } from "../tooltip/tooltip";

interface AcpExecutorMeta {
  id: string;
  label: string;
  /// Adapter exposes MAX_THINKING_TOKENS (claude only).
  thinking: boolean;
  /// Adapter accepts a default model.
  model: boolean;
}

const EXECUTORS: AcpExecutorMeta[] = [
  { id: "claude", label: "Claude", thinking: true, model: true },
  { id: "copilot", label: "Copilot", thinking: false, model: true },
  { id: "opencode", label: "Opencode", thinking: false, model: true },
  { id: "pi", label: "Pi", thinking: false, model: false },
];

const TRUST_LEVELS: { id: AcpTrust; label: string; tip: string }[] = [
  { id: "ask", label: "Ask", tip: "Every permission request is deferred to you" },
  { id: "balanced", label: "Balanced", tip: "Edits, reads and safe commands auto-allowed; the rest ask" },
  { id: "yolo", label: "YOLO", tip: "Everything auto-allowed — equivalent to --dangerously-skip-permissions" },
];

/// Mirror of Settings::acp_executor's Rust-side defaults.
const defaultCfg = (id: string): AcpExecutorConfig => ({
  trust: id === "copilot" ? "yolo" : "balanced",
});

export async function renderAcpAgentsSection(host: HTMLElement): Promise<void> {
  const section = document.createElement("div");
  section.className = "acp-agents";
  section.innerHTML = `
    <div class="acp-agents-title">ACP agents</div>
    <div class="acp-agents-sub">Launch configuration for chat-tab agents. Trust maps to each adapter's native permission mechanism.</div>
    <div class="acp-agents-cards"></div>
  `;
  host.appendChild(section);
  const cardsHost = section.querySelector<HTMLElement>(".acp-agents-cards");
  if (!cardsHost) return;

  const settings = await getSettings();
  const configs: Record<string, AcpExecutorConfig> = {};
  for (const ex of EXECUTORS) {
    configs[ex.id] = { ...defaultCfg(ex.id), ...(settings.acp_executors?.[ex.id] ?? {}) };
  }

  const persist = async (): Promise<void> => {
    // Read-modify-write on fresh settings so we never clobber a
    // concurrent change from another settings tab.
    const fresh = await getSettings();
    fresh.acp_executors = { ...(fresh.acp_executors ?? {}), ...configs };
    await setSettings(fresh);
  };

  for (const ex of EXECUTORS) {
    const cfg = configs[ex.id];
    const card = document.createElement("div");
    card.className = "acp-agent-card";
    card.dataset.executor = ex.id;

    const head = document.createElement("div");
    head.className = "acp-agent-head";
    const badge = document.createElement("span");
    badge.className = "acp-agent-brand";
    badge.innerHTML = brandIconSvg(ex.label, 14) ?? "";
    const name = document.createElement("span");
    name.className = "acp-agent-name";
    name.textContent = ex.label;
    head.append(badge, name);
    card.appendChild(head);

    // Trust segmented control.
    const seg = document.createElement("div");
    seg.className = "acp-trust-seg";
    for (const lvl of TRUST_LEVELS) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.trust = lvl.id;
      b.textContent = lvl.label;
      if (lvl.id === "yolo") b.classList.add("acp-trust-yolo");
      b.setAttribute("aria-pressed", String(cfg.trust === lvl.id));
      attachTooltip(b, lvl.tip);
      b.addEventListener("click", () => {
        cfg.trust = lvl.id;
        for (const other of seg.querySelectorAll("button")) {
          other.setAttribute("aria-pressed", String(other === b));
        }
        void persist();
      });
      seg.appendChild(b);
    }
    card.appendChild(seg);

    const fields = document.createElement("div");
    fields.className = "acp-agent-fields";

    if (ex.model) {
      const model = document.createElement("input");
      model.type = "text";
      model.className = "acp-model-input";
      model.placeholder = "default model (blank = adapter default)";
      model.value = cfg.model ?? "";
      model.addEventListener("change", () => {
        cfg.model = model.value.trim() || null;
        void persist();
      });
      fields.appendChild(model);
    }

    if (ex.thinking) {
      const thinking = document.createElement("input");
      thinking.type = "number";
      thinking.className = "acp-thinking-input";
      thinking.placeholder = "thinking budget (tokens)";
      thinking.min = "0";
      if (cfg.thinking_tokens != null) thinking.value = String(cfg.thinking_tokens);
      thinking.addEventListener("change", () => {
        const n = parseInt(thinking.value, 10);
        cfg.thinking_tokens = Number.isFinite(n) && n > 0 ? n : null;
        void persist();
      });
      fields.appendChild(thinking);
    }

    // ponytail: env + args as single free-text inputs (KEY=VALUE per
    // line / whitespace-split args); upgrade to row editors if quoting
    // ever matters.
    const env = document.createElement("textarea");
    env.className = "acp-env-input";
    env.rows = 2;
    env.placeholder = "env — KEY=VALUE per line";
    env.value = (cfg.env ?? []).map(([k, v]) => `${k}=${v}`).join("\n");
    env.addEventListener("change", () => {
      cfg.env = env.value
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1)] as [string, string];
        });
      void persist();
    });
    fields.appendChild(env);

    const args = document.createElement("input");
    args.type = "text";
    args.className = "acp-args-input";
    args.placeholder = "extra adapter args";
    args.value = (cfg.args ?? []).join(" ");
    args.addEventListener("change", () => {
      cfg.args = args.value.split(/\s+/).filter(Boolean);
      void persist();
    });
    fields.appendChild(args);

    card.appendChild(fields);
    cardsHost.appendChild(card);
  }
}
```

Wire into `spawns.ts`: at the end of `renderSpawnsTab` (after the master-detail is mounted), add:

```ts
  const { renderAcpAgentsSection } = await import("./acp_agents");
  await renderAcpAgentsSection(host);
```

(Static import at top of file is also fine if it doesn't create a cycle — prefer static: `import { renderAcpAgentsSection } from "./acp_agents";` then `await renderAcpAgentsSection(host);`.)

- [ ] **Step 4: Run tests**

Run: `npm test -- acp_agents` and `npm test -- spawns` — Expected: PASS (spawns tests must not break; if `renderSpawnsTab` now awaits the new section, its tests need the `../api` mock — add `vi.mock("../api", () => ({ getSettings: vi.fn().mockResolvedValue({}), setSettings: vi.fn() }))` to `spawns.test.ts` if it fails on the import).

- [ ] **Step 5: Styles** — in the stylesheet where `.spawns-md-*` live (`ui/src/styles.css`), add (adapting token names to the file's existing vars):

```css
/* Harnesses → ACP agents */
.acp-agents { margin-top: 24px; }
.acp-agents-title { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.7; }
.acp-agents-sub { font-size: 11px; opacity: 0.5; margin: 4px 0 10px; }
.acp-agents-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }
.acp-agent-card { border: 1px solid var(--border, rgba(255,255,255,0.08)); padding: 10px; border-radius: 0; }
.acp-agent-head { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.acp-trust-seg { display: inline-flex; border: 1px solid var(--border, rgba(255,255,255,0.08)); }
.acp-trust-seg button { appearance: none; border: 0; background: transparent; padding: 4px 10px; font: inherit; font-size: 11px; cursor: pointer; border-radius: 0; }
.acp-trust-seg button[aria-pressed="true"] { background: rgba(255,255,255,0.10); }
.acp-trust-seg button.acp-trust-yolo[aria-pressed="true"] { background: rgba(255,171,64,0.18); color: #ffab40; }
.acp-agent-fields { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.acp-agent-fields input, .acp-agent-fields textarea { appearance: none; border-radius: 0; background: transparent; border: 1px solid var(--border, rgba(255,255,255,0.08)); color: inherit; font: inherit; font-size: 12px; padding: 4px 6px; }
```

(True Dark rule: neutral lifts only; the amber on YOLO is a warning accent, same family as the momentum amber — acceptable per DESIGN.md warning affordances. If DESIGN.md's hard rules say otherwise, use the existing danger/warning token.)

- [ ] **Step 6: Full FE check**

Run: `npm run build && npm test` (repo root) — Expected: clean typecheck, all tests pass (main has some pre-existing failures per repo memory — compare against a baseline `git stash` run if unsure; new failures only are blockers).

- [ ] **Step 7: Commit**

```bash
git add ui/src/settings/acp_agents.ts ui/src/settings/acp_agents.test.ts ui/src/settings/spawns.ts ui/src/settings/spawns.test.ts ui/src/styles.css
git commit -m "feat(settings): ACP agents section in Harnesses — trust/model/thinking/env/args per executor"
```

---

### Task 7: Per-tab trust chip in the ACP view

**Files:**
- Modify: `ui/src/executors/acp/view.ts` (header template ~:726 where `.acp-model-chip` lives; chip wiring ~:772; the spawn-result → view plumbing wherever `SpawnAcpResult.model` is consumed — search `spawnAcpSession(` in `ui/src` to find the call site and follow how `model` reaches the view)
- Modify: `ui/src/executors/acp/acp.css` (or wherever `.acp-model-chip` styles live — grep)
- Modify: `ui/src/executors/acp/view.test.ts` (add chip tests following the file's existing harness pattern)

**Interfaces:**
- Consumes: `acpSetTrust`, `AcpTrust` from `../../api` (Task 5); initial trust from the spawn result (Task 4).
- Produces: `.acp-trust-chip` button + `.acp-trust-menu` in the tab header; `--yolo` modifier class for the warning state.

- [ ] **Step 1: Write failing tests** — in `view.test.ts`, following its existing mount pattern (reuse its mocks; add `acpSetTrust: vi.fn()` to the `../../api` mock):

```ts
it("renders the trust chip with the launch trust and yolo warning styling", async () => {
  // mount with trust: "yolo" via the same options path the model uses
  const view = await mountView({ trust: "yolo" });
  const chip = view.host.querySelector<HTMLButtonElement>(".acp-trust-chip");
  expect(chip).toBeTruthy();
  expect(chip?.textContent).toContain("YOLO");
  expect(chip?.classList.contains("acp-trust-chip--yolo")).toBe(true);
});

it("switching trust calls acpSetTrust and updates the chip", async () => {
  const view = await mountView({ trust: "balanced" });
  view.host.querySelector<HTMLButtonElement>(".acp-trust-chip")?.click();
  const yoloItem = view.host.querySelector<HTMLButtonElement>('.acp-trust-menu [data-trust="yolo"]');
  yoloItem?.click();
  await flush();
  expect(acpSetTrust).toHaveBeenCalledWith(expect.anything(), "yolo");
  expect(view.host.querySelector(".acp-trust-chip--yolo")).toBeTruthy();
});
```

(Adapt `mountView`/`flush` to the file's actual helpers — read the top of `view.test.ts` first and mirror how existing tests construct the view and its options. If the view's constructor options don't currently include spawn-result fields, add `trust` next to wherever `model` enters.)

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- executors/acp/view` — Expected: FAIL (no `.acp-trust-chip`).

- [ ] **Step 3: Implement** — in `view.ts`:

1. Header template (:726 region): after the model chip button add

```html
        <button type="button" class="acp-trust-chip"></button>
        <div class="acp-trust-menu" role="listbox" hidden></div>
```

2. Fields + wiring (mirror `modelChipEl` exactly — member, `requireChild`, outside-click close):

```ts
  private trustChipEl!: HTMLButtonElement;
  private trustMenuEl!: HTMLElement;
  private trust: AcpTrust = "balanced";

  private static readonly TRUST_LABELS: Record<AcpTrust, string> = {
    ask: "ASK",
    balanced: "BALANCED",
    yolo: "YOLO",
  };

  private renderTrustChip(): void {
    this.trustChipEl.textContent = AcpChatView.TRUST_LABELS[this.trust];
    this.trustChipEl.classList.toggle("acp-trust-chip--yolo", this.trust === "yolo");
  }

  private openTrustMenu(): void {
    this.trustMenuEl.innerHTML = "";
    for (const t of ["ask", "balanced", "yolo"] as AcpTrust[]) {
      const item = document.createElement("button");
      item.type = "button";
      item.dataset.trust = t;
      item.setAttribute("role", "option");
      item.textContent = AcpChatView.TRUST_LABELS[t];
      if (t === "yolo") item.classList.add("acp-trust-menu-yolo");
      item.addEventListener("click", () => {
        this.trust = t;
        this.renderTrustChip();
        this.trustMenuEl.hidden = true;
        void acpSetTrust(this.sessionId, t);
      });
      this.trustMenuEl.appendChild(item);
    }
    this.trustMenuEl.style.left = `${this.trustChipEl.offsetLeft}px`;
    this.trustMenuEl.hidden = false;
  }
```

Wire in the same place `modelChipEl` is wired (:772): `requireChild` both elements, `click` on the chip toggles `openTrustMenu()`/hide, extend the existing outside-click handler (:571) to also close the trust menu. Class name of the view (`AcpChatView`) — confirm and adjust. Initialize `this.trust` from the constructor option added in Step 1's plumbing and call `renderTrustChip()` where the model chip first renders (:1119 region). Tooltip: `attachTooltip(this.trustChipEl, "Trust level — YOLO skips all permission prompts")`.

3. Plumb `trust` from the spawn result into the view constructor at the `spawnAcpSession` call site (same path `result.model` takes).

- [ ] **Step 4: Styles** — next to `.acp-model-chip` rules:

```css
.acp-trust-chip { /* copy the .acp-model-chip base look */ }
.acp-trust-chip--yolo { color: #ffab40; border-color: rgba(255,171,64,0.5); }
.acp-trust-menu { /* copy .acp-model-menu base look */ }
.acp-trust-menu .acp-trust-menu-yolo { color: #ffab40; }
```

(Literally copy the existing chip/menu rules and adjust selectors — visual consistency with the model chip is the requirement, not these exact properties.)

- [ ] **Step 5: Run tests**

Run: `npm test -- executors/acp/view` — Expected: PASS, no regressions in the file's other tests.

- [ ] **Step 6: Commit**

```bash
git add ui/src/executors/acp/view.ts ui/src/executors/acp/view.test.ts ui/src/executors/acp/acp.css
git commit -m "feat(acp): per-tab trust chip — live Ask/Balanced/YOLO switch"
```

---

### Task 8: Whole-feature verification

**Files:** none new — verification only.

- [ ] **Step 1: Full test suites**

```bash
cargo test -p karl-agent -p karl-app
cargo clippy --workspace --all-targets
cargo fmt --all -- --check
npm run build && npm test
```

Expected: all green (modulo pre-existing main failures — diff against baseline).

- [ ] **Step 2: Live verify (use the `verify` skill / respawn tauri dev)**

1. Settings → Harnesses shows "ACP agents" with 4 cards; copilot pre-selected YOLO, claude Balanced.
2. Set claude → YOLO. Confirm `~/Library/Application Support/com.karluiz.covenant/claude-acp/settings.json` gets `permissions.defaultMode: "bypassPermissions"` after opening a NEW claude ACP tab, and that a command runs without a permission prompt. Confirm the file's other keys survived.
3. New claude tab shows amber YOLO chip; switching it to Balanced makes the next risky command prompt again (session/set_mode flip).
4. Copilot tab still runs tools without prompting (default preserved).
5. Env escape hatch: add `FOO=bar` to claude env, spawn, and in the chat ask the agent to `echo $FOO` → `bar`.

- [ ] **Step 3: Reconcile the manual workaround**

The user's hand-edited `claude-acp/settings.json` (set 2026-07-13 to bypassPermissions) is now derived state: after this ships, set claude's trust in the UI instead. Verify a Balanced claude spawn rewrites `defaultMode` back to `"default"`.

- [ ] **Step 4: Update memory + finish**

Update `reference_claude_acp_bypass_permissions.md` memory (the settings.json key is now derived from Harnesses config). Then use superpowers:finishing-a-development-branch.
