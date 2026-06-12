# Operator GitHub Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operators get read/write GitHub access (issues + PRs) on the user's repos via the stored OAuth token, gated by a per-operator `Off | ReadOnly | ReadWrite` setting.

**Architecture:** Re-auth the existing GitHub OAuth Device Flow with `scope=repo` and persist the granted scope in the Keychain. Add a `github_access` field to `Operator` (registry + SQLite + dedicated set command, NOT in SOUL frontmatter — same pattern as `is_default`). New `crates/app/src/teammate/github_tools.rs` module with specific-endpoint tools (no generic API tool); tools are registered conditionally by access level in both LLM dispatch paths (Anthropic + OpenAI-compat), which get a shared `execute_tool` helper to kill the existing 2× duplicated match.

**Tech Stack:** Rust (reqwest, serde, rusqlite, keyring, mockito for tests), TypeScript (vanilla DOM UI), Tauri 2 IPC.

**Spec:** `docs/superpowers/specs/2026-06-12-operator-github-tools-design.md`

**Worktree:** `.claude/worktrees/operator-github-tools` (branch `worktree-operator-github-tools`). Run all commands from the worktree root.

**Testing gotchas (from project memory):**
- NEVER run broad `cargo test -p covenant` — telegram long-poll tests hang. Always use narrow filters as written in each task. If a test run hangs, `pkill -f covenant_lib` and re-run narrower.
- macOS has no `timeout` command.
- Commit granularity: one commit per task (NOT per TDD step).

---

### Task 1: Device flow requests `repo` scope; granted scope persisted in Keychain

**Files:**
- Modify: `crates/score/src/auth.rs`
- Modify: `crates/score/tests/auth.rs`
- Modify: `crates/app/src/score_auth_commands.rs`
- Modify: `crates/app/src/lib.rs` (command registration, near line 4087)

- [ ] **Step 1: Write the failing test** — in `crates/score/tests/auth.rs`, modify `start_device_flow_parses_response` to assert the request body carries the scope:

```rust
#[tokio::test]
async fn start_device_flow_parses_response() {
    let mut server = mockito::Server::new_async().await;
    let _m = server
        .mock("POST", "/login/device/code")
        .match_body(mockito::Matcher::AllOf(vec![
            mockito::Matcher::UrlEncoded("client_id".into(), karl_score::auth::GITHUB_CLIENT_ID.into()),
            mockito::Matcher::UrlEncoded("scope".into(), "repo".into()),
        ]))
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(
            r#"{
            "device_code": "abc123",
            "user_code": "WDJB-MJHT",
            "verification_uri": "https://github.com/login/device",
            "interval": 5,
            "expires_in": 900
        }"#,
        )
        .create_async()
        .await;
    let resp = start_device_flow(&server.url()).await.unwrap();
    assert_eq!(resp.user_code, "WDJB-MJHT");
    assert_eq!(resp.interval, 5);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl-score --test auth start_device_flow -- --nocapture`
(If the package name differs, check `crates/score/Cargo.toml` `[package] name` and substitute.)
Expected: FAIL — mockito 501 because the body matcher doesn't match (no `scope` param sent).

- [ ] **Step 3: Implement** — in `crates/score/src/auth.rs`:

3a. Change the form in `start_device_flow` (line ~114):

```rust
        .form(&[("client_id", GITHUB_CLIENT_ID), ("scope", "repo")])
```

3b. Add a scope Keychain entry next to the existing constants (line ~10):

```rust
pub const KEYCHAIN_SCOPE_USERNAME: &str = "github-token-scope";
```

3c. Add helpers next to `store_token_in_keychain` (line ~166):

```rust
pub fn store_scope_in_keychain(scope: &str) -> Result<(), AuthError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_SCOPE_USERNAME)?;
    entry.set_password(scope)?;
    Ok(())
}

pub fn load_scope_from_keychain() -> Result<Option<String>, AuthError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_SCOPE_USERNAME)?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_scope_from_keychain() -> Result<(), AuthError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_SCOPE_USERNAME)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}
```

3d. Clear scope on signout (`signout`, line ~210):

```rust
pub fn signout(store: &ScoreStore) -> Result<(), AuthError> {
    delete_token_from_keychain()?;
    delete_scope_from_keychain()?;
    delete_jwt()?;
    session::clear(store)?;
    Ok(())
}
```

3e. In `crates/app/src/score_auth_commands.rs`, persist the granted scope on success and expose a read command. Replace the `Success` arm of `score_signin_poll`:

```rust
        DeviceTokenResponse::Success { access_token, scope, .. } => {
            let user =
                auth::finalize_signin(GITHUB_API_BASE, &auth::backend_url(), &access_token, &store)
                    .await
                    .map_err(|e| e.to_string())?;
            // Best-effort: scope is advisory metadata; signin must not fail on it.
            if let Err(e) = auth::store_scope_in_keychain(&scope) {
                tracing::warn!(error = %e, "failed to persist github token scope");
            }
            Ok(Some(user))
        }
```

And add at the end of the file:

```rust
/// Granted OAuth scopes of the stored GitHub token (comma-separated, as
/// reported by GitHub at sign-in). `None` when signed out or pre-scope token.
#[tauri::command]
pub async fn score_token_scope() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(auth::load_scope_from_keychain)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
```

3f. Register `score_auth_commands::score_token_scope,` in the `invoke_handler` list in `crates/app/src/lib.rs`, next to `score_auth_commands::score_signin_start` (line ~4087).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl-score --test auth` then `cargo check -p covenant`
Expected: all auth tests PASS; check clean.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/auth.rs crates/score/tests/auth.rs crates/app/src/score_auth_commands.rs crates/app/src/lib.rs
git commit -m "feat(auth): request repo scope in device flow, persist granted scope"
```

---

### Task 2: `GithubAccess` on `Operator` — registry, storage, set command

**Files:**
- Modify: `crates/app/src/operator_registry.rs`
- Modify: `crates/app/src/storage.rs`
- Modify: `crates/app/src/lib.rs` (register command near line 4000)

- [ ] **Step 1: Write the failing tests**

1a. In `crates/app/src/operator_registry.rs` tests module (find `#[cfg(test)]` at the bottom; create the test alongside existing ones):

```rust
    #[test]
    fn legacy_operator_json_defaults_github_access_off() {
        // Serialized before the github_access field existed.
        let json = serde_json::json!({
            "id": "01HZX5K9PXVQJ8F2M3N4P5Q6R7",
            "name": "Legacy", "emoji": "🤖", "color": "#6B7280",
            "tags": [], "persona": "p", "escalate_threshold": 0.6,
            "model": "claude-sonnet-4-6", "hard_constraints": "",
            "is_default": false, "created_at_unix_ms": 0, "updated_at_unix_ms": 0
        });
        let op: Operator = serde_json::from_value(json).unwrap();
        assert_eq!(op.github_access, GithubAccess::Off);
    }
```

1b. In `crates/app/src/storage.rs` tests (next to the existing operator roundtrip test at line ~4109, reusing its setup pattern for constructing a Storage + Operator — copy how that test builds `s` and an operator):

```rust
    #[tokio::test]
    async fn operator_github_access_roundtrip_and_set() {
        let s = test_storage().await; // use the same constructor the neighboring operator tests use
        let mut op = sample_operator("GhTest"); // ditto: reuse/adapt the neighboring helper or inline literal
        op.github_access = crate::operator_registry::GithubAccess::ReadOnly;
        s.operator_insert(op.clone()).await.unwrap();
        let listed = s.operator_list().await.unwrap();
        let got = listed.iter().find(|o| o.id == op.id).unwrap();
        assert_eq!(got.github_access, crate::operator_registry::GithubAccess::ReadOnly);

        s.operator_set_github_access(op.id.to_string(), crate::operator_registry::GithubAccess::ReadWrite)
            .await
            .unwrap();
        let listed = s.operator_list().await.unwrap();
        let got = listed.iter().find(|o| o.id == op.id).unwrap();
        assert_eq!(got.github_access, crate::operator_registry::GithubAccess::ReadWrite);
    }
```

(Adapt `test_storage()` / `sample_operator()` to whatever the existing tests at storage.rs:4100+ actually use — read them first; do not invent new fixtures if equivalents exist.)

- [ ] **Step 2: Run tests to verify they fail to compile**

Run: `cargo test -p covenant --lib operator_github_access 2>&1 | head -30` and `cargo test -p covenant --lib legacy_operator_json 2>&1 | head -30`
Expected: compile error — `github_access`/`GithubAccess` don't exist.

- [ ] **Step 3: Implement**

3a. `crates/app/src/operator_registry.rs` — add the enum above `pub struct Operator` (line ~28):

```rust
/// What the operator may do with the user's GitHub account. Gates which
/// `gh_*` tools are registered at dispatch time — `Off` operators never
/// even see them. Registry-only (NOT SOUL frontmatter), like `is_default`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum GithubAccess {
    #[default]
    Off,
    ReadOnly,
    ReadWrite,
}
```

3b. Add the field to `Operator` (after `voice`):

```rust
    /// GitHub access level for the `gh_*` tools. Defaults Off.
    #[serde(default)]
    pub github_access: GithubAccess,
```

3c. Fix the `Operator { ... }` struct literal in `create_from_soul` (line ~413) — add `github_access: GithubAccess::Off,`. The compiler will flag any other literals; fix all the same way.

3d. Add the registry method next to `set_default` (line ~473):

```rust
    pub async fn set_github_access(
        &self,
        storage: &Storage,
        id: OperatorId,
        access: GithubAccess,
    ) -> Result<(), RegistryError> {
        if !self.by_id.read().unwrap().contains_key(&id) {
            return Err(RegistryError::NotFound(id));
        }
        storage.operator_set_github_access(id.to_string(), access).await?;
        if let Some(op) = self.by_id.write().unwrap().get_mut(&id) {
            op.github_access = access;
        }
        Ok(())
    }
```

3e. Add the Tauri command in the `commands` module, next to `operator_set_default`:

```rust
    #[tauri::command]
    pub async fn operator_set_github_access(
        id: String,
        access: GithubAccess,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<Storage>>,
    ) -> Result<(), String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        registry.set_github_access(&storage, id, access).await.map_err(map_err)
    }
```

3f. Register `operator_registry::commands::operator_set_github_access,` in `crates/app/src/lib.rs` next to `operator_set_default` (line ~4000).

3g. `crates/app/src/storage.rs`:

- Migration, appended after the existing operator ALTERs (line ~584 region, same `let _ =` idempotent pattern):

```rust
        let _ = conn.execute(
            "ALTER TABLE operators ADD COLUMN github_access TEXT NOT NULL DEFAULT 'Off'",
            [],
        );
```

- Converters next to `voice_to_str`/`voice_from_str`:

```rust
fn github_access_to_str(a: crate::operator_registry::GithubAccess) -> &'static str {
    match a {
        crate::operator_registry::GithubAccess::Off => "Off",
        crate::operator_registry::GithubAccess::ReadOnly => "ReadOnly",
        crate::operator_registry::GithubAccess::ReadWrite => "ReadWrite",
    }
}

fn github_access_from_str(s: &str) -> crate::operator_registry::GithubAccess {
    match s {
        "ReadOnly" => crate::operator_registry::GithubAccess::ReadOnly,
        "ReadWrite" => crate::operator_registry::GithubAccess::ReadWrite,
        _ => crate::operator_registry::GithubAccess::Off,
    }
}
```

- `operator_insert` (line ~1669): add `github_access` to the column list and `?16`, with `github_access_to_str(op.github_access),` appended to `params![]`.
- `operator_update` (line ~1707): add `github_access=?13` to the SET clause and `github_access_to_str(op.github_access),` to `params![]`.
- `operator_list` (line ~1791): add `github_access` to the SELECT (16th column, index 15) and to the row mapping:

```rust
                        github_access: row
                            .get::<_, String>(15)
                            .map(|s| github_access_from_str(&s))
                            .unwrap_or_default(),
```

- New storage fn next to `operator_set_default` (line ~1764):

```rust
    pub async fn operator_set_github_access(
        &self,
        id: String,
        access: crate::operator_registry::GithubAccess,
    ) -> Result<(), StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = conn.blocking_lock();
            let n = c.execute(
                "UPDATE operators SET github_access=?2 WHERE id=?1",
                params![id, github_access_to_str(access)],
            )?;
            if n == 0 {
                return Err(StorageError::Other(format!("operator id {id} not found")));
            }
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p covenant --lib operator_github_access && cargo test -p covenant --lib legacy_operator_json && cargo test -p covenant --lib operator_ 2>&1 | tail -20`
Expected: new tests PASS, existing operator storage/registry tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/src/storage.rs crates/app/src/lib.rs
git commit -m "feat(operators): per-operator GithubAccess level (Off/ReadOnly/ReadWrite)"
```

---

### Task 3: `github_tools.rs` — client, tools, defs, access gating

**Files:**
- Modify: `crates/app/src/teammate/tools.rs` (ToolEnv gains `github`)
- Create: `crates/app/src/teammate/github_tools.rs`
- Modify: `crates/app/src/teammate/mod.rs` (add `pub mod github_tools;`)
- Modify: `crates/app/Cargo.toml` (add `mockito = "1"` to `[dev-dependencies]` if not present)

- [ ] **Step 1: ToolEnv plumbing** — in `crates/app/src/teammate/tools.rs`, add to the struct (after `active_screen`):

```rust
    /// GitHub API context, present only when the operator's
    /// `github_access != Off` AND a token exists in the Keychain.
    /// Absence means the `gh_*` tools were never registered.
    pub github: Option<GithubCtx>,
```

Add next to `ToolEnv`:

```rust
/// Token + access level + API base for the `gh_*` tools. `api_base` is
/// "https://api.github.com" in production; tests point it at mockito.
#[derive(Debug, Clone)]
pub struct GithubCtx {
    pub token: String,
    pub access: crate::operator_registry::GithubAccess,
    pub api_base: String,
}
```

Update `ToolEnv::new` to set `github: None`, and add a builder:

```rust
    /// Attach GitHub API access (builder style).
    pub fn with_github(mut self, github: Option<GithubCtx>) -> Self {
        self.github = github;
        self
    }
```

Run: `cargo check -p covenant 2>&1 | head -20` — fix any struct-literal sites the compiler flags (there is one in `commands.rs` via `ToolEnv::new`, which already goes through `new()`, so expect zero or trivial fallout).

- [ ] **Step 2: Write the failing tests** — create `crates/app/src/teammate/github_tools.rs` with ONLY the test module first (module body empty otherwise), and register `pub mod github_tools;` in `crates/app/src/teammate/mod.rs`. Add `mockito = "1"` to `[dev-dependencies]` in `crates/app/Cargo.toml` if missing.

```rust
//! GitHub tools for operators (`gh_*`). Specific endpoints only — by
//! design there is NO generic "call any GitHub API" tool. Read tools
//! are registered for ReadOnly+; write tools for ReadWrite only, and
//! handlers re-check access as defense in depth.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operator_registry::GithubAccess;
    use crate::teammate::tools::{GithubCtx, ToolEnv};

    fn env_with(api_base: String, access: GithubAccess) -> ToolEnv {
        ToolEnv::new(std::env::temp_dir(), 1024).with_github(Some(GithubCtx {
            token: "tok".into(),
            access,
            api_base,
        }))
    }

    #[test]
    fn tool_defs_gated_by_access() {
        assert!(github_tool_defs(GithubAccess::Off).is_empty());
        let ro: Vec<String> = github_tool_defs(GithubAccess::ReadOnly)
            .iter().map(|d| d["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(ro, vec!["gh_list_repos", "gh_list_issues", "gh_get_issue", "gh_list_prs", "gh_get_pr"]);
        let rw: Vec<String> = github_tool_defs(GithubAccess::ReadWrite)
            .iter().map(|d| d["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(rw, vec![
            "gh_list_repos", "gh_list_issues", "gh_get_issue", "gh_list_prs", "gh_get_pr",
            "gh_create_issue", "gh_comment", "gh_create_pr", "gh_update_issue_state",
        ]);
    }

    #[tokio::test]
    async fn list_issues_filters_prs_and_caps_fields() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/repos/karluiz/covenant/issues")
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("state".into(), "open".into()),
            ]))
            .match_header("authorization", "Bearer tok")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[
                {"number": 7, "title": "Real issue", "state": "open",
                 "user": {"login": "karluiz"}, "comments": 2,
                 "updated_at": "2026-06-01T00:00:00Z", "labels": []},
                {"number": 8, "title": "Actually a PR", "state": "open",
                 "user": {"login": "karluiz"}, "comments": 0,
                 "updated_at": "2026-06-01T00:00:00Z", "labels": [],
                 "pull_request": {"url": "x"}}
            ]"#)
            .create_async()
            .await;
        let env = env_with(server.url(), GithubAccess::ReadOnly);
        let out = gh_list_issues(&env, &serde_json::json!({"owner": "karluiz", "repo": "covenant"}))
            .await
            .unwrap();
        assert!(out.contains("Real issue"));
        assert!(!out.contains("Actually a PR"));
    }

    #[tokio::test]
    async fn unauthorized_maps_to_reconnect_hint() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/repos/o/r/issues")
            .match_query(mockito::Matcher::Any)
            .with_status(401)
            .with_body(r#"{"message":"Bad credentials"}"#)
            .create_async()
            .await;
        let env = env_with(server.url(), GithubAccess::ReadOnly);
        let err = gh_list_issues(&env, &serde_json::json!({"owner": "o", "repo": "r"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("re-connect"));
    }

    #[tokio::test]
    async fn create_issue_posts_and_returns_url() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/repos/o/r/issues")
            .match_body(mockito::Matcher::PartialJson(serde_json::json!({"title": "T"})))
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(r#"{"number": 42, "html_url": "https://github.com/o/r/issues/42", "state": "open", "title": "T"}"#)
            .create_async()
            .await;
        let env = env_with(server.url(), GithubAccess::ReadWrite);
        let out = gh_create_issue(&env, &serde_json::json!({"owner": "o", "repo": "r", "title": "T"}))
            .await
            .unwrap();
        assert!(out.contains("issues/42"));
    }

    #[tokio::test]
    async fn write_tool_rejected_for_readonly_ctx() {
        let env = env_with("http://127.0.0.1:9".into(), GithubAccess::ReadOnly);
        let err = gh_create_issue(&env, &serde_json::json!({"owner": "o", "repo": "r", "title": "T"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("read-only"));
    }

    #[tokio::test]
    async fn body_truncation_marks_cut() {
        let long = "x".repeat(5000);
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/repos/o/r/issues/1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::json!({
                "number": 1, "title": "t", "state": "open", "body": long,
                "user": {"login": "u"}, "comments": 0,
                "updated_at": "2026-06-01T00:00:00Z", "labels": []
            }).to_string())
            .create_async()
            .await;
        // get_issue also fetches comments
        let _m2 = server
            .mock("GET", "/repos/o/r/issues/1/comments")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("[]")
            .create_async()
            .await;
        let env = env_with(server.url(), GithubAccess::ReadOnly);
        let out = gh_get_issue(&env, &serde_json::json!({"owner": "o", "repo": "r", "number": 1}))
            .await
            .unwrap();
        assert!(out.contains("(truncated)"));
        assert!(out.len() < 4000);
    }
}
```

- [ ] **Step 3: Run tests to verify they fail to compile**

Run: `cargo test -p covenant --lib github_tools 2>&1 | head -20`
Expected: compile errors — none of the functions exist yet.

- [ ] **Step 4: Implement the module** — fill `github_tools.rs` above the test module:

```rust
use serde::Deserialize;
use serde_json::Value;

use super::tools::{GithubCtx, ToolEnv, ToolError};
use crate::operator_registry::GithubAccess;

const MAX_LIST_ITEMS: usize = 30;
const MAX_BODY_CHARS: usize = 2000;
const MAX_COMMENTS: usize = 10;
const MAX_PR_FILES: usize = 50;
const MAX_PATCH_CHARS: usize = 400;

fn parse_args<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, ToolError> {
    serde_json::from_value(args.clone()).map_err(|e| ToolError::InvalidArgs(e.to_string()))
}

fn ctx(env: &ToolEnv) -> Result<&GithubCtx, ToolError> {
    env.github
        .as_ref()
        .ok_or_else(|| ToolError::CommandFailed("GitHub access is not enabled for this operator".into()))
}

fn require_write(c: &GithubCtx) -> Result<(), ToolError> {
    if c.access == GithubAccess::ReadWrite {
        Ok(())
    } else {
        Err(ToolError::CommandFailed(
            "this operator has read-only GitHub access; write operations are disabled".into(),
        ))
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}… (truncated)")
    }
}

fn map_github_error(status: u16, body: &str) -> ToolError {
    match status {
        401 => ToolError::CommandFailed(
            "github: token invalid or expired — ask the user to re-connect GitHub in Settings".into(),
        ),
        403 => ToolError::CommandFailed(
            "github: forbidden or rate-limited — wait and retry, or ask the user to re-connect \
             GitHub so the token carries repo scope"
                .into(),
        ),
        404 => ToolError::CommandFailed(
            "github: not found — check owner/repo/number; private repos need repo scope (re-connect GitHub)".into(),
        ),
        s => ToolError::CommandFailed(format!("github: HTTP {s}: {}", truncate(body, 300))),
    }
}

async fn gh_request(
    c: &GithubCtx,
    method: reqwest::Method,
    path_and_query: &str,
    body: Option<Value>,
) -> Result<Value, ToolError> {
    let url = format!("{}{}", c.api_base.trim_end_matches('/'), path_and_query);
    let client = reqwest::Client::new();
    let mut req = client
        .request(method, &url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "covenant-client")
        .bearer_auth(&c.token);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| ToolError::CommandFailed(format!("github request failed: {e}")))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(map_github_error(status, &text));
    }
    serde_json::from_str(&text)
        .map_err(|e| ToolError::CommandFailed(format!("github: invalid JSON in response: {e}")))
}

fn render(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| "{}".into())
}
```

Then the read tools:

```rust
// ── read tools ───────────────────────────────────────────────────────

pub async fn gh_list_repos(env: &ToolEnv, _args: &Value) -> Result<String, ToolError> {
    let c = ctx(env)?;
    let v = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/user/repos?sort=pushed&per_page={MAX_LIST_ITEMS}"),
        None,
    )
    .await?;
    let items: Vec<Value> = v
        .as_array()
        .map(|a| {
            a.iter()
                .take(MAX_LIST_ITEMS)
                .map(|r| {
                    serde_json::json!({
                        "full_name": r["full_name"],
                        "private": r["private"],
                        "default_branch": r["default_branch"],
                        "open_issues": r["open_issues_count"],
                        "pushed_at": r["pushed_at"],
                        "description": truncate(r["description"].as_str().unwrap_or(""), 120),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(render(&Value::Array(items)))
}

#[derive(Debug, Deserialize)]
struct RepoArgs {
    owner: String,
    repo: String,
    #[serde(default)]
    state: Option<String>,
}

fn issue_summary(r: &Value) -> Value {
    serde_json::json!({
        "number": r["number"],
        "title": r["title"],
        "state": r["state"],
        "author": r["user"]["login"],
        "comments": r["comments"],
        "updated_at": r["updated_at"],
        "labels": r["labels"].as_array().map(|ls| ls.iter().map(|l| l["name"].clone()).collect::<Vec<_>>()).unwrap_or_default(),
    })
}

pub async fn gh_list_issues(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: RepoArgs = parse_args(args)?;
    let state = a.state.as_deref().unwrap_or("open");
    let c = ctx(env)?;
    let v = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/repos/{}/{}/issues?state={state}&per_page={MAX_LIST_ITEMS}", a.owner, a.repo),
        None,
    )
    .await?;
    let items: Vec<Value> = v
        .as_array()
        .map(|arr| {
            arr.iter()
                // The issues endpoint returns PRs too; a PR carries `pull_request`.
                .filter(|r| r.get("pull_request").is_none())
                .take(MAX_LIST_ITEMS)
                .map(issue_summary)
                .collect()
        })
        .unwrap_or_default();
    Ok(render(&Value::Array(items)))
}

#[derive(Debug, Deserialize)]
struct NumberArgs {
    owner: String,
    repo: String,
    number: u64,
}

pub async fn gh_get_issue(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: NumberArgs = parse_args(args)?;
    let c = ctx(env)?;
    let issue = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/repos/{}/{}/issues/{}", a.owner, a.repo, a.number),
        None,
    )
    .await?;
    let comments = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/repos/{}/{}/issues/{}/comments?per_page={MAX_COMMENTS}", a.owner, a.repo, a.number),
        None,
    )
    .await
    .unwrap_or(Value::Array(vec![]));
    let mut out = issue_summary(&issue);
    out["body"] = Value::String(truncate(issue["body"].as_str().unwrap_or(""), MAX_BODY_CHARS));
    out["recent_comments"] = Value::Array(
        comments
            .as_array()
            .map(|arr| {
                arr.iter()
                    .take(MAX_COMMENTS)
                    .map(|cm| {
                        serde_json::json!({
                            "author": cm["user"]["login"],
                            "created_at": cm["created_at"],
                            "body": truncate(cm["body"].as_str().unwrap_or(""), 500),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    );
    Ok(render(&out))
}

pub async fn gh_list_prs(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: RepoArgs = parse_args(args)?;
    let state = a.state.as_deref().unwrap_or("open");
    let c = ctx(env)?;
    let v = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/repos/{}/{}/pulls?state={state}&per_page={MAX_LIST_ITEMS}", a.owner, a.repo),
        None,
    )
    .await?;
    let items: Vec<Value> = v
        .as_array()
        .map(|arr| {
            arr.iter()
                .take(MAX_LIST_ITEMS)
                .map(|r| {
                    serde_json::json!({
                        "number": r["number"],
                        "title": r["title"],
                        "state": r["state"],
                        "author": r["user"]["login"],
                        "head": r["head"]["ref"],
                        "base": r["base"]["ref"],
                        "draft": r["draft"],
                        "updated_at": r["updated_at"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(render(&Value::Array(items)))
}

pub async fn gh_get_pr(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: NumberArgs = parse_args(args)?;
    let c = ctx(env)?;
    let pr = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/repos/{}/{}/pulls/{}", a.owner, a.repo, a.number),
        None,
    )
    .await?;
    let files = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/repos/{}/{}/pulls/{}/files?per_page={MAX_PR_FILES}", a.owner, a.repo, a.number),
        None,
    )
    .await
    .unwrap_or(Value::Array(vec![]));
    let out = serde_json::json!({
        "number": pr["number"],
        "title": pr["title"],
        "state": pr["state"],
        "author": pr["user"]["login"],
        "head": pr["head"]["ref"],
        "base": pr["base"]["ref"],
        "draft": pr["draft"],
        "mergeable": pr["mergeable"],
        "additions": pr["additions"],
        "deletions": pr["deletions"],
        "changed_files": pr["changed_files"],
        "body": truncate(pr["body"].as_str().unwrap_or(""), MAX_BODY_CHARS),
        "files": files.as_array().map(|arr| arr.iter().take(MAX_PR_FILES).map(|f| serde_json::json!({
            "filename": f["filename"],
            "status": f["status"],
            "additions": f["additions"],
            "deletions": f["deletions"],
            "patch_excerpt": truncate(f["patch"].as_str().unwrap_or(""), MAX_PATCH_CHARS),
        })).collect::<Vec<_>>()).unwrap_or_default(),
    });
    Ok(render(&out))
}
```

Then the write tools:

```rust
// ── write tools (ReadWrite only; re-checked here as defense in depth) ─

#[derive(Debug, Deserialize)]
struct CreateIssueArgs {
    owner: String,
    repo: String,
    title: String,
    #[serde(default)]
    body: Option<String>,
}

pub async fn gh_create_issue(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: CreateIssueArgs = parse_args(args)?;
    let c = ctx(env)?;
    require_write(c)?;
    let v = gh_request(
        c,
        reqwest::Method::POST,
        &format!("/repos/{}/{}/issues", a.owner, a.repo),
        Some(serde_json::json!({"title": a.title, "body": a.body.unwrap_or_default()})),
    )
    .await?;
    Ok(render(&serde_json::json!({
        "created": true,
        "number": v["number"],
        "url": v["html_url"],
    })))
}

#[derive(Debug, Deserialize)]
struct CommentArgs {
    owner: String,
    repo: String,
    number: u64,
    body: String,
}

pub async fn gh_comment(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: CommentArgs = parse_args(args)?;
    let c = ctx(env)?;
    require_write(c)?;
    let v = gh_request(
        c,
        reqwest::Method::POST,
        &format!("/repos/{}/{}/issues/{}/comments", a.owner, a.repo, a.number),
        Some(serde_json::json!({"body": a.body})),
    )
    .await?;
    Ok(render(&serde_json::json!({"created": true, "url": v["html_url"]})))
}

#[derive(Debug, Deserialize)]
struct CreatePrArgs {
    owner: String,
    repo: String,
    title: String,
    head: String,
    base: String,
    #[serde(default)]
    body: Option<String>,
}

pub async fn gh_create_pr(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: CreatePrArgs = parse_args(args)?;
    let c = ctx(env)?;
    require_write(c)?;
    let v = gh_request(
        c,
        reqwest::Method::POST,
        &format!("/repos/{}/{}/pulls", a.owner, a.repo),
        Some(serde_json::json!({
            "title": a.title, "head": a.head, "base": a.base,
            "body": a.body.unwrap_or_default(),
        })),
    )
    .await?;
    Ok(render(&serde_json::json!({
        "created": true,
        "number": v["number"],
        "url": v["html_url"],
    })))
}

#[derive(Debug, Deserialize)]
struct UpdateIssueStateArgs {
    owner: String,
    repo: String,
    number: u64,
    /// "open" or "closed"
    state: String,
}

pub async fn gh_update_issue_state(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: UpdateIssueStateArgs = parse_args(args)?;
    if a.state != "open" && a.state != "closed" {
        return Err(ToolError::InvalidArgs("state must be 'open' or 'closed'".into()));
    }
    let c = ctx(env)?;
    require_write(c)?;
    let v = gh_request(
        c,
        reqwest::Method::PATCH,
        &format!("/repos/{}/{}/issues/{}", a.owner, a.repo, a.number),
        Some(serde_json::json!({"state": a.state})),
    )
    .await?;
    Ok(render(&serde_json::json!({
        "number": v["number"],
        "state": v["state"],
        "url": v["html_url"],
    })))
}
```

Then defs + gating + the dispatch adapter:

```rust
// ── tool definitions + access gating ─────────────────────────────────

fn read_defs() -> Vec<Value> {
    vec![
        serde_json::json!({
            "name": "gh_list_repos",
            "description": "List the user's GitHub repositories (most recently pushed first). \
                            Use to discover owner/repo names before other gh_ tools.",
            "input_schema": {"type": "object", "properties": {}, "additionalProperties": false}
        }),
        serde_json::json!({
            "name": "gh_list_issues",
            "description": "List issues in a GitHub repository (PRs excluded).",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo"],
                "additionalProperties": false,
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                    "state": {"type": "string", "enum": ["open", "closed", "all"], "description": "Default: open."}
                }
            }
        }),
        serde_json::json!({
            "name": "gh_get_issue",
            "description": "Read one issue: title, state, body (truncated) and recent comments.",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo", "number"],
                "additionalProperties": false,
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                    "number": {"type": "integer"}
                }
            }
        }),
        serde_json::json!({
            "name": "gh_list_prs",
            "description": "List pull requests in a GitHub repository.",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo"],
                "additionalProperties": false,
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                    "state": {"type": "string", "enum": ["open", "closed", "all"], "description": "Default: open."}
                }
            }
        }),
        serde_json::json!({
            "name": "gh_get_pr",
            "description": "Read one pull request: metadata, body (truncated), changed files with patch excerpts.",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo", "number"],
                "additionalProperties": false,
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                    "number": {"type": "integer"}
                }
            }
        }),
    ]
}

fn write_defs() -> Vec<Value> {
    vec![
        serde_json::json!({
            "name": "gh_create_issue",
            "description": "Create a GitHub issue. Returns its number and URL.",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo", "title"],
                "additionalProperties": false,
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                    "title": {"type": "string"},
                    "body": {"type": "string"}
                }
            }
        }),
        serde_json::json!({
            "name": "gh_comment",
            "description": "Comment on a GitHub issue or pull request (same endpoint for both).",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo", "number", "body"],
                "additionalProperties": false,
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                    "number": {"type": "integer"},
                    "body": {"type": "string"}
                }
            }
        }),
        serde_json::json!({
            "name": "gh_create_pr",
            "description": "Open a pull request from an existing branch. The branch must already be pushed.",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo", "title", "head", "base"],
                "additionalProperties": false,
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                    "title": {"type": "string"},
                    "head": {"type": "string", "description": "Source branch name."},
                    "base": {"type": "string", "description": "Target branch, usually the default branch."},
                    "body": {"type": "string"}
                }
            }
        }),
        serde_json::json!({
            "name": "gh_update_issue_state",
            "description": "Close or reopen a GitHub issue.",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo", "number", "state"],
                "additionalProperties": false,
                "properties": {
                    "owner": {"type": "string"},
                    "repo": {"type": "string"},
                    "number": {"type": "integer"},
                    "state": {"type": "string", "enum": ["open", "closed"]}
                }
            }
        }),
    ]
}

/// Tool definitions visible to an operator at this access level.
pub fn github_tool_defs(access: GithubAccess) -> Vec<Value> {
    match access {
        GithubAccess::Off => vec![],
        GithubAccess::ReadOnly => read_defs(),
        GithubAccess::ReadWrite => {
            let mut v = read_defs();
            v.extend(write_defs());
            v
        }
    }
}

/// Dispatch adapter for the LLM tool loop. Returns `None` when `name`
/// is not a github tool (caller falls through to its unknown-tool arm).
pub async fn execute_github_tool(
    env: &ToolEnv,
    name: &str,
    input: &Value,
) -> Option<Result<String, ToolError>> {
    Some(match name {
        "gh_list_repos" => gh_list_repos(env, input).await,
        "gh_list_issues" => gh_list_issues(env, input).await,
        "gh_get_issue" => gh_get_issue(env, input).await,
        "gh_list_prs" => gh_list_prs(env, input).await,
        "gh_get_pr" => gh_get_pr(env, input).await,
        "gh_create_issue" => gh_create_issue(env, input).await,
        "gh_comment" => gh_comment(env, input).await,
        "gh_create_pr" => gh_create_pr(env, input).await,
        "gh_update_issue_state" => gh_update_issue_state(env, input).await,
        _ => return None,
    })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p covenant --lib github_tools`
Expected: all 6 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/teammate/github_tools.rs crates/app/src/teammate/tools.rs crates/app/src/teammate/mod.rs crates/app/Cargo.toml Cargo.lock
git commit -m "feat(teammate): gh_* GitHub tools module with access-gated defs"
```

---

### Task 4: Wire tools into both dispatch loops + system prompt

**Files:**
- Modify: `crates/app/src/teammate/llm.rs`

- [ ] **Step 1: Extract the shared tool executor.** Both loops currently duplicate an identical `match name.as_str()` (Anthropic at line ~563, OpenAI at line ~789). Add ONE helper above `dispatch_reply_with_tools`:

```rust
/// Execute one tool call. Shared by the Anthropic and OpenAI loops so the
/// tool roster only exists in one place. `propose_task` is NOT handled
/// here — both loops fast-path it before reaching this.
async fn execute_tool(
    tool_env: &ToolEnv,
    name: &str,
    input: &serde_json::Value,
) -> (String, bool, Option<String>) {
    use crate::teammate::github_tools;
    let res: Result<String, ToolError> = match name {
        "read_file" => tools::read_file(tool_env, input),
        "list_directory" => tools::list_directory(tool_env, input),
        "search_files" => tools::search_files(tool_env, input),
        "git_status" => tools::git_status(tool_env, input),
        "git_diff" => tools::git_diff(tool_env, input),
        "run_command" => tools::run_command(tool_env, input),
        "read_terminal_screen" => tools::read_terminal_screen(tool_env, input),
        "propose_task" => {
            return (
                "propose_task already considered; respond with text now.".into(),
                false,
                Some("propose_task in non-leading position".into()),
            )
        }
        other => match github_tools::execute_github_tool(tool_env, other, input).await {
            Some(r) => r,
            None => {
                return (
                    format!("unknown tool: {other}"),
                    false,
                    Some(format!("unknown tool: {other}")),
                )
            }
        },
    };
    match res {
        Ok(text) => (text, true, None),
        Err(e) => (format!("error: {e}"), false, Some(e.to_string())),
    }
}

/// Full tool-definition roster for this dispatch: the 8 base tools plus
/// whatever GitHub access the ToolEnv carries.
fn all_tool_defs(tool_env: &ToolEnv) -> Vec<serde_json::Value> {
    let mut defs = vec![
        tools::read_file_tool_def(),
        tools::list_directory_tool_def(),
        tools::search_files_tool_def(),
        tools::git_status_tool_def(),
        tools::git_diff_tool_def(),
        tools::run_command_tool_def(),
        tools::read_terminal_screen_tool_def(),
        tools::propose_task_tool_def(),
    ];
    if let Some(g) = &tool_env.github {
        defs.extend(crate::teammate::github_tools::github_tool_defs(g.access));
    }
    defs
}
```

- [ ] **Step 2: Use it in the Anthropic loop.** Replace the `let tools = vec![ ... ];` block (line ~515) with:

```rust
    let tools = all_tool_defs(&tool_env);
```

Replace the whole `let (out_text, ok, err) = match name.as_str() { ... };` block inside the loop (lines ~563–606) with:

```rust
                let (out_text, ok, err) = execute_tool(&tool_env, &name, &input).await;
```

- [ ] **Step 3: Use it in the OpenAI loop.** Replace the `let tools_oa: Vec<serde_json::Value> = [ ... ]` array literal (line ~731) with:

```rust
    let tools_oa: Vec<serde_json::Value> = all_tool_defs(&tool_env)
        .iter()
        .map(openai_http::convert_tool_def)
        .collect();
```

Replace its duplicated match block (lines ~789–828) with the same one-liner:

```rust
                let (out_text, ok, err) = execute_tool(&tool_env, &name, &input).await;
```

- [ ] **Step 4: System prompt.** In `build_system_prompt` (the tool docs block around llm.rs:190–290), append a GitHub section to the tools documentation, emitted only when the operator has access. Find where the prompt string for tools is assembled and add:

```rust
    if operator.github_access != crate::operator_registry::GithubAccess::Off {
        let write_line = if operator.github_access
            == crate::operator_registry::GithubAccess::ReadWrite
        {
            " You may also write: `gh_create_issue`, `gh_comment`, `gh_create_pr`, \
             `gh_update_issue_state` (close/reopen). State plainly what you changed, \
             with the URL."
        } else {
            " Your GitHub access is READ-ONLY: you cannot create or modify anything."
        };
        prompt.push_str(&format!(
            "\n\n# GitHub access\n\
             You can act on the user's GitHub account via `gh_*` tools: `gh_list_repos`, \
             `gh_list_issues`, `gh_get_issue`, `gh_list_prs`, `gh_get_pr`.{write_line} \
             Never guess owner/repo names — discover them with `gh_list_repos` or read \
             `git remote -v` via `run_command`.\n"
        ));
    }
```

(Adapt the variable name `prompt` to whatever `build_system_prompt` actually accumulates into — read the function first. If `build_system_prompt` builds one literal string, append this as a `format!` segment conditioned the same way.)

- [ ] **Step 5: Write the roster test** — in `llm.rs`'s `#[cfg(test)]` module (create one near the bottom if none exists):

```rust
    #[test]
    fn github_tools_registered_by_access_level() {
        use crate::operator_registry::GithubAccess;
        use crate::teammate::tools::{GithubCtx, ToolEnv};
        let base = ToolEnv::new(std::env::temp_dir(), 1024);
        assert_eq!(all_tool_defs(&base).len(), 8);

        let ro = ToolEnv::new(std::env::temp_dir(), 1024).with_github(Some(GithubCtx {
            token: "t".into(),
            access: GithubAccess::ReadOnly,
            api_base: "x".into(),
        }));
        assert_eq!(all_tool_defs(&ro).len(), 8 + 5);

        let rw = ToolEnv::new(std::env::temp_dir(), 1024).with_github(Some(GithubCtx {
            token: "t".into(),
            access: GithubAccess::ReadWrite,
            api_base: "x".into(),
        }));
        let names: Vec<&str> = all_tool_defs(&rw)
            .iter()
            .map(|d| d["name"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(names.len(), 8 + 9);
        assert!(names.contains(&"gh_create_issue"));
    }
```

- [ ] **Step 6: Run tests**

Run: `cargo test -p covenant --lib github_tools_registered && cargo test -p covenant --lib teammate:: 2>&1 | tail -15`
Expected: new test PASS; existing teammate tests unaffected.

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/teammate/llm.rs
git commit -m "feat(teammate): register gh_* tools by access level in both dispatch paths"
```

---

### Task 5: Load the token into ToolEnv at dispatch time

**Files:**
- Modify: `crates/app/src/teammate/commands.rs` (ToolEnv construction, line ~235)

- [ ] **Step 1: Implement.** Replace:

```rust
            let tool_env = crate::teammate::tools::ToolEnv::new(root, 200 * 1024)
                .with_screen(active_screen);
```

with:

```rust
            let tool_env = crate::teammate::tools::ToolEnv::new(root, 200 * 1024)
                .with_screen(active_screen);
            // GitHub access: attach the stored token only when this operator
            // is allowed to use it. Keychain reads are sync — keep them off
            // the async thread.
            let tool_env = if operator.github_access
                != crate::operator_registry::GithubAccess::Off
            {
                match tokio::task::spawn_blocking(karl_score::auth::load_token_from_keychain).await
                {
                    Ok(Ok(Some(token))) => tool_env.with_github(Some(
                        crate::teammate::tools::GithubCtx {
                            token,
                            access: operator.github_access,
                            api_base: karl_score::auth::GITHUB_API_BASE.to_string(),
                        },
                    )),
                    Ok(Ok(None)) => {
                        tracing::warn!(
                            operator_id = %operator.id,
                            "operator has github access but no token in keychain; gh_* tools disabled"
                        );
                        tool_env
                    }
                    Ok(Err(e)) => {
                        tracing::warn!(error = %e, "keychain read failed; gh_* tools disabled");
                        tool_env
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "keychain task panicked; gh_* tools disabled");
                        tool_env
                    }
                }
            } else {
                tool_env
            };
```

(`operator` is already in scope at this point — it is passed to `dispatch_reply_with_tools` ten lines below. Verify `karl_score` is the dependency name used by `crates/app` — `score_auth_commands.rs` imports `karl_score::auth`, so it is.)

- [ ] **Step 2: Verify it compiles and nothing else broke**

Run: `cargo check -p covenant && cargo test -p covenant --lib teammate:: 2>&1 | tail -10`
Expected: clean check; teammate tests PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/teammate/commands.rs
git commit -m "feat(teammate): attach keychain GitHub token to ToolEnv per operator access"
```

---

### Task 6: UI — GithubAccess type, API wrapper, creator control

**Files:**
- Modify: `ui/src/api.ts` (Operator interface at line ~264)
- Modify: `ui/src/settings/operators.ts` (ModalState line ~648, save hook line ~119)
- Test: `ui/src/settings/operators.test.ts`

- [ ] **Step 1: Write the failing test** — in `ui/src/settings/operators.test.ts`, following the file's existing patterns for constructing modal state (read the top of the file for how existing tests open/build the modal; mock `operatorSoulRead` the same way neighboring tests do):

```ts
describe("github access control", () => {
  it("defaults to Off in create mode", () => {
    const h = openOperatorModal({ mode: "create" });
    expect(h.state.githubAccess).toBe("Off");
    h.el.remove();
  });

  it("seeds from the existing operator in edit mode", () => {
    const existing = makeOperator({ github_access: "ReadWrite" }); // adapt to the file's existing operator fixture helper
    const h = openOperatorModal({ mode: "edit", existing });
    expect(h.state.githubAccess).toBe("ReadWrite");
    h.el.remove();
  });

  it("setGithubAccess updates state", () => {
    const h = openOperatorModal({ mode: "create" });
    h.setGithubAccess("ReadOnly");
    expect(h.state.githubAccess).toBe("ReadOnly");
    h.el.remove();
  });
});
```

(If the test file has no operator fixture helper, build a full `Operator` object literal inline with `github_access: "ReadWrite"`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/settings/operators.test.ts` (from repo root)
Expected: FAIL — `githubAccess`/`setGithubAccess` don't exist.

- [ ] **Step 3: Implement**

3a. `ui/src/api.ts` — next to `VoiceTone` (line ~253):

```ts
/// Per-operator GitHub access level. Gates which gh_* tools the
/// operator's LLM dispatch registers. Mirrors Rust `GithubAccess`.
export type GithubAccess = "Off" | "ReadOnly" | "ReadWrite";
```

Add to `interface Operator` (after `xp`):

```ts
  github_access: GithubAccess;
```

Add the wrapper next to `operatorSetDefault`:

```ts
export async function operatorSetGithubAccess(
  id: string,
  access: GithubAccess,
): Promise<void> {
  return invoke<void>("operator_set_github_access", { id, access });
}
```

3b. `ui/src/settings/operators.ts`:

- Import `GithubAccess` and `operatorSetGithubAccess` from `../api`.
- `ModalState` gains:

```ts
  /// GitHub access level. Registry-side (not SOUL); persisted via the
  /// dedicated operator_set_github_access command after save, same
  /// pattern as setAsDefault.
  githubAccess: GithubAccess;
```

- Seed it in `openOperatorModal` when building `state`:

```ts
    githubAccess: opts.existing?.github_access ?? "Off",
```

- `ModalHandle` gains `setGithubAccess(a: GithubAccess): void;` and the handle implements:

```ts
    setGithubAccess(a) { state.githubAccess = a; render(); },
```

- Render a 3-state segmented control in the behaviour/controls section of the modal (place it after the escalate-threshold slider; match the existing control markup/classes in that section — reuse whatever segmented/button-group pattern the voice control uses):

```ts
        <div class="opc-field">
          <label>GitHub access</label>
          <div class="opc-segmented" data-gh-access>
            ${(["Off", "ReadOnly", "ReadWrite"] as const).map((lvl) => `
              <button type="button" data-gh="${lvl}"
                      class="${state.githubAccess === lvl ? "active" : ""}">
                ${lvl === "Off" ? "Off" : lvl === "ReadOnly" ? "Read-only" : "Read & write"}
              </button>`).join("")}
          </div>
          <p class="opc-hint">Lets this operator list and read issues/PRs${""
            }; read &amp; write also creates issues, comments and opens PRs as you.</p>
        </div>
```

Wire clicks where the section's other listeners are bound:

```ts
    el.querySelectorAll<HTMLButtonElement>("[data-gh]").forEach((btn) => {
      btn.addEventListener("click", () => h.setGithubAccess(btn.dataset.gh as GithubAccess));
    });
```

(Adapt class names `opc-field`/`opc-segmented`/`opc-hint` to the classes the surrounding section actually uses — inspect the rendered markup of the escalate-threshold field and mirror it. All copy in English. Do NOT use `element.title`; if a tooltip is wanted use `attachTooltip` from `ui/src/tooltip/tooltip.ts`.)

- Persist after save, in the save wrapper at line ~119–127, right after the `operatorSetDefault` call:

```ts
            const prevAccess = handle.state.existing?.github_access ?? "Off";
            if (saved.id && handle.state.githubAccess !== prevAccess) {
              try { await operatorSetGithubAccess(saved.id, handle.state.githubAccess); } catch (e) {
                console.warn("operator_set_github_access failed", e);
              }
            }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run ui/src/settings/operators.test.ts && npx tsc --noEmit -p .`
(Use the tsconfig the `build` script uses; if `tsc` alone is what `npm run build` runs, run `npx tsc` with no args.)
Expected: tests PASS, no type errors. NOTE: adding `github_access` to `interface Operator` may surface other files constructing `Operator` literals (tests/fixtures) — add `github_access: "Off"` to each until `tsc` is clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/settings/operators.ts ui/src/settings/operators.test.ts
git commit -m "feat(ui): GitHub access control in operator creator"
```

---

### Task 7: UI — re-connect CTA on the score page

**Files:**
- Modify: `ui/src/score/api.ts`
- Modify: `ui/src/score/page.ts` (`renderSync`, line ~351)

- [ ] **Step 1: API wrapper** — in `ui/src/score/api.ts`:

```ts
/// Comma-separated OAuth scopes granted to the stored GitHub token,
/// or null when signed out / signed in before scopes were recorded.
export async function scoreTokenScope(): Promise<string | null> {
  return invoke<string | null>("score_token_scope");
}
```

- [ ] **Step 2: CTA** — in `ui/src/score/page.ts`, import `scoreTokenScope`, and at the END of the signed-in branch of `renderSync` (after the `cov-disconnect-btn` listener, line ~409) add:

```ts
  // Operators need repo scope; tokens minted before this feature carry
  // none. Offer a one-click re-connect (device flow overwrites the token).
  void scoreTokenScope().then((scope) => {
    const hasRepo = (scope ?? "")
      .split(",")
      .map((s) => s.trim())
      .includes("repo");
    if (hasRepo) return;
    const cta = document.createElement("div");
    cta.className = "cov-sync cov-sync-reauth";
    cta.innerHTML = `
      <div class="l"><b>Operators need repo access</b>Re-connect GitHub so operators can read and write issues and pull requests.</div>
      <button type="button" class="btn cov-reauth-btn">Re-connect GitHub</button>
    `;
    cta.querySelector(".cov-reauth-btn")!.addEventListener("click", async () => {
      const u = await runDeviceFlow();
      if (u) void refresh(page, state);
    });
    host.appendChild(cta);
  }).catch(() => { /* scope unknown — stay quiet */ });
```

(`runDeviceFlow`, `refresh`, `page`, `state`, `host` are all already in scope in `renderSync` — see the signed-out branch at line ~366 for the same pattern.)

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit -p .` (or the project's typecheck command) and `npx vitest run ui/src/score 2>/dev/null || true` (only if score tests exist).
Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/score/api.ts ui/src/score/page.ts
git commit -m "feat(ui): re-connect GitHub CTA when token lacks repo scope"
```

---

### Task 8: Final verification sweep

- [ ] **Step 1: Rust** — run the narrow filters (NOT the full suite — telegram tests hang):

```bash
cargo test -p karl-score --test auth
cargo test -p covenant --lib github_tools
cargo test -p covenant --lib operator_
cargo test -p covenant --lib teammate::
cargo check -p covenant
```

Expected: all PASS / clean. Known pre-existing failures on main (context::tests version tests without node/rust env) are NOT regressions — compare against `git stash` baseline only if something unexpected fails.

- [ ] **Step 2: UI** — `npx vitest run ui/src/settings/operators.test.ts && npx tsc --noEmit -p .` (adapt to the build script's tsc invocation). Expected: PASS.

- [ ] **Step 3: Spec compliance check** — re-read `docs/superpowers/specs/2026-06-12-operator-github-tools-design.md` section by section and confirm each landed: scope=repo (T1), scope persisted + CTA (T1, T7), GithubAccess field + serde default + UI control (T2, T6), 5 read + 4 write tools with caps and error mapping (T3), conditional registration both paths + system prompt section (T4), token plumbing with tracing warn (T5), no token in logs/results (T3 — verify `gh_request` never prints `c.token`).

- [ ] **Step 4: Update memory/notes** — nothing to do in-repo; final state reported to the user. In-app verification (sign-in re-auth, live tool calls against api.github.com) is deliberately deferred to a manual session — note it in the completion report.
