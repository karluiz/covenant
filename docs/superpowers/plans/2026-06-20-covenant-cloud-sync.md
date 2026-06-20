# Covenant Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Covenant Cloud" settings section that auto-pushes a per-user snapshot of workspaces, operators, specs, and (secret-stripped) preferences to the backend, restorable on demand across machines.

**Architecture:** Rust does all gather + secret-strip + HTTP + apply (JWT stays in the keychain); the frontend owns triggers (debounced auto-push from existing save paths; explicit confirmed restore). Server stores one JSONB row per `github_id`, last-write-wins. Two repos: `covenant-server` (endpoint, built+deployed first) then `karlTerminal` (desktop Rust + frontend).

**Tech Stack:** Rust/axum 0.7 + sqlx 0.8 (server); Rust/Tauri 2 + reqwest (desktop); TypeScript + xterm.js (frontend).

## Global Constraints

- **Secrets never leave the device.** Strip before upload, preserve-from-local on restore: `Settings.anthropic_api_key`, `Settings.sendgrid_api_key`, `ProviderEntry.api_key` (every entry in `Settings.providers`), `TelegramSettings.bot_token` (at `Settings.telegram.bot_token`). (CLAUDE.md pitfall #7.)
- **Restore never deletes** local operators or specs — upsert-by-ULID only.
- **Auth:** reuse `karl_score::auth::load_jwt()` and `karl_score::auth::backend_url()`. JWT must not reach the webview.
- **Server payload cap: 5 MB** on `PUT /sync/state`.
- **Backend base URL** default `https://forge.covenant.uno`, overridable via `COVENANT_BACKEND_URL`.
- **No `unwrap()`** outside tests/`main()`. Errors: `thiserror` in libs, `anyhow`/`String` at command boundary.
- **Conventional Commits**, one feature-relevant change per commit.
- **Tests run from repo root** (`cargo test`, `npx vitest`, `npx tsc --noEmit`), never from `ui/`.

## File Structure

**covenant-server:**
- Create `migrations/0004_cloud_sync.sql` — `user_sync_state` table.
- Create `src/cloud_state.rs` — `put_state` / `get_state` / `wipe_state` handlers.
- Modify `src/main.rs` — register module + route + per-route body limit.

**karlTerminal desktop (`crates/app`):**
- Create `crates/app/src/cloud_sync/mod.rs` — envelope types, gather, apply, HTTP.
- Create `crates/app/src/cloud_sync/secrets.rs` — pure strip/merge (heavily tested).
- Create `crates/app/src/cloud_sync/commands.rs` — Tauri commands.
- Modify `crates/app/src/settings.rs` — add `CloudSyncConfig` to `Settings`.
- Modify `crates/app/src/operator_registry.rs` — add `import()` upsert method.
- Modify `crates/app/src/lib.rs` — `mod cloud_sync;` + register commands.
- Modify `crates/app/Cargo.toml` — add `hostname` dep.

**karlTerminal frontend (`ui/src`):**
- Modify `ui/src/api.ts` — typed wrappers for the new commands.
- Modify `ui/src/settings/panel.ts` — nav entry + section markup.
- Create `ui/src/settings/cloud_sync.ts` — section render + handlers.
- Create `ui/src/settings/cloud_push.ts` — debounced `scheduleCloudPush()`.
- Modify `ui/src/workspaces/manager.ts`, operator save paths, spec save path, settings save — call `scheduleCloudPush()`.

---

## Task 1: Server endpoint (`/sync/state`)

**Files:**
- Create: `migrations/0004_cloud_sync.sql` (covenant-server)
- Create: `src/cloud_state.rs` (covenant-server)
- Modify: `src/main.rs` (covenant-server)

**Interfaces:**
- Consumes: `crate::error::{AppError, Result}`, `crate::jwt`, `crate::sync::bearer`, `AppState { pool, jwt_secret, .. }`.
- Produces: routes `PUT/GET/DELETE /sync/state`. PUT body = arbitrary JSON envelope; PUT response `{ "updated_at_ms": i64 }`; GET response `{ "state": <json>, "updated_at_ms": i64 } | 204`; DELETE → 204.

- [ ] **Step 1: Write the migration**

Create `migrations/0004_cloud_sync.sql`:
```sql
CREATE TABLE user_sync_state (
  github_id  BIGINT PRIMARY KEY REFERENCES users(github_id) ON DELETE CASCADE,
  state      JSONB NOT NULL,
  device     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2: Write the handler module**

Create `src/cloud_state.rs`:
```rust
use axum::{extract::State, http::HeaderMap, http::StatusCode, response::IntoResponse, Json};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::sync::bearer;
use crate::{jwt, AppState};

/// PUT /sync/state — upsert the caller's full sync blob. Body is the raw
/// envelope produced by the desktop; we store it verbatim and stamp our own
/// server time. `device` is lifted out of the envelope for the readout.
pub async fn put_state(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let token = bearer(&headers)?;
    let claims = jwt::verify(&state.jwt_secret, token)?;
    let device = body.get("device").and_then(|v| v.as_str());
    sqlx::query(
        "INSERT INTO user_sync_state(github_id, state, device, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (github_id) DO UPDATE
           SET state = EXCLUDED.state,
               device = EXCLUDED.device,
               updated_at = NOW()",
    )
    .bind(claims.sub)
    .bind(&body)
    .bind(device)
    .execute(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(json!({ "updated_at_ms": chrono::Utc::now().timestamp_millis() })))
}

/// GET /sync/state — return the caller's blob + server updated_at (epoch ms),
/// or 204 if they've never pushed.
pub async fn get_state(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<axum::response::Response> {
    let token = bearer(&headers)?;
    let claims = jwt::verify(&state.jwt_secret, token)?;
    let row: Option<(Value, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT state, updated_at FROM user_sync_state WHERE github_id = $1",
    )
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    match row {
        Some((state_json, updated_at)) => Ok(Json(json!({
            "state": state_json,
            "updated_at_ms": updated_at.timestamp_millis(),
        }))
        .into_response()),
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

/// DELETE /sync/state — wipe the caller's cloud copy.
pub async fn wipe_state(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<StatusCode> {
    let token = bearer(&headers)?;
    let claims = jwt::verify(&state.jwt_secret, token)?;
    sqlx::query("DELETE FROM user_sync_state WHERE github_id = $1")
        .bind(claims.sub)
        .execute(&state.pool)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    Ok(StatusCode::NO_CONTENT)
}
```

- [ ] **Step 3: Register module + route + body limit**

In `src/main.rs`, add `mod cloud_state;` near the other `mod` declarations. Add the route to the `Router` chain (before `.with_state(state)`), with a 5 MB body limit scoped to this route:
```rust
        .route(
            "/sync/state",
            axum::routing::put(cloud_state::put_state)
                .get(cloud_state::get_state)
                .delete(cloud_state::wipe_state)
                .layer(axum::extract::DefaultBodyLimit::max(5 * 1024 * 1024)),
        )
```

- [ ] **Step 4: Compile**

Run (from covenant-server root): `cargo check`
Expected: compiles clean (warnings OK). If `query_as` tuple decode complains about `Value`, confirm the `sqlx` `json` feature is on (it is, per Cargo.toml).

- [ ] **Step 5: Verify against a local DB (manual — repo has no DB test harness)**

This repo has only unit tests (no Postgres test fixture), so verification is a live round-trip. With a local Postgres and the server running (`DATABASE_URL=... JWT_SECRET=topsecret cargo run`), mint a token in a Rust scratch or reuse a real JWT, then:
```bash
# expect {"updated_at_ms":...}
curl -sS -X PUT localhost:8080/sync/state \
  -H "authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"schema_version":1,"device":"test","sections":{}}'
# expect {"state":{...},"updated_at_ms":...}
curl -sS localhost:8080/sync/state -H "authorization: Bearer $JWT"
# expect 204
curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE localhost:8080/sync/state -H "authorization: Bearer $JWT"
# expect 401
curl -sS -o /dev/null -w '%{http_code}\n' localhost:8080/sync/state
```

- [ ] **Step 6: Commit**

```bash
git add migrations/0004_cloud_sync.sql src/cloud_state.rs src/main.rs
git commit -m "feat: per-user /sync/state JSONB endpoint (PUT/GET/DELETE)"
```

> Deploy covenant-server (migration auto-applies on boot via `sqlx::migrate!`) before exercising the desktop side end-to-end.

---

## Task 2: Secret strip/merge (pure, desktop)

**Files:**
- Create: `crates/app/src/cloud_sync/secrets.rs`
- Test: same file, `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `serde_json::Value`, `crate::settings::Settings`.
- Produces:
  - `pub fn strip_secrets(prefs: &mut serde_json::Value)` — removes secret keys in place.
  - `pub fn merge_preferences(local: &Settings, cloud_prefs: &serde_json::Value) -> Settings` — cloud non-secret fields applied over local, local secrets preserved.

- [ ] **Step 1: Write the failing tests**

Create `crates/app/src/cloud_sync/secrets.rs`:
```rust
use crate::settings::Settings;
use serde_json::Value;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strip_removes_all_secret_paths() {
        let mut v = json!({
            "anthropic_api_key": "sk-ant-xxx",
            "sendgrid_api_key": "SG.yyy",
            "telegram": { "bot_token": "123:abc", "chat_id": "42", "enabled": true },
            "providers": { "azure": { "api_key": "az-secret", "label": "Azure" } },
            "ui_font_family": "Inter"
        });
        strip_secrets(&mut v);
        assert!(v.get("anthropic_api_key").is_none());
        assert!(v.get("sendgrid_api_key").is_none());
        assert!(v["telegram"].get("bot_token").is_none());
        assert_eq!(v["telegram"]["chat_id"], json!("42")); // non-secret kept
        assert!(v["providers"]["azure"].get("api_key").is_none());
        assert_eq!(v["providers"]["azure"]["label"], json!("Azure"));
        assert_eq!(v["ui_font_family"], json!("Inter"));
    }

    #[test]
    fn merge_keeps_local_secrets_takes_cloud_nonsecret() {
        let mut local = Settings::default();
        local.anthropic_api_key = Some("LOCAL-KEY".into());
        local.telegram.bot_token = "LOCAL-BOT".into();
        local.ui_font_family = Some("OldFont".into());

        // Cloud prefs = a stripped serialization with a changed non-secret field.
        let mut cloud = serde_json::to_value(&local).unwrap();
        strip_secrets(&mut cloud);
        cloud["ui_font_family"] = json!("NewFont");

        let merged = merge_preferences(&local, &cloud);
        assert_eq!(merged.anthropic_api_key.as_deref(), Some("LOCAL-KEY")); // secret kept
        assert_eq!(merged.telegram.bot_token, "LOCAL-BOT"); // nested secret kept
        assert_eq!(merged.ui_font_family.as_deref(), Some("NewFont")); // cloud applied
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p covenant cloud_sync::secrets`
Expected: FAIL — `strip_secrets` / `merge_preferences` not found.

- [ ] **Step 3: Implement**

Add above the test module in `secrets.rs`:
```rust
/// Remove every secret field from a serialized `Settings` JSON value, in place.
/// Keeps the surrounding non-secret structure intact.
pub fn strip_secrets(prefs: &mut Value) {
    let Some(obj) = prefs.as_object_mut() else { return };
    obj.remove("anthropic_api_key");
    obj.remove("sendgrid_api_key");
    if let Some(tg) = obj.get_mut("telegram").and_then(|v| v.as_object_mut()) {
        tg.remove("bot_token");
    }
    if let Some(providers) = obj.get_mut("providers").and_then(|v| v.as_object_mut()) {
        for (_id, p) in providers.iter_mut() {
            if let Some(po) = p.as_object_mut() {
                po.remove("api_key");
            }
        }
    }
}

/// Apply cloud (secret-free) preferences over the local Settings while
/// preserving this machine's secret fields. Strategy: start from local JSON,
/// capture local secrets, shallow-overwrite top-level keys from cloud (cloud
/// has no secret keys, so they survive), then re-inject the captured secrets.
/// Deserializing back into `Settings` validates and fills any missing field
/// with serde defaults.
pub fn merge_preferences(local: &Settings, cloud_prefs: &Value) -> Settings {
    let mut base = serde_json::to_value(local).unwrap_or(Value::Null);

    // Overwrite top-level non-secret keys from cloud.
    if let (Some(b), Some(c)) = (base.as_object_mut(), cloud_prefs.as_object()) {
        for (k, v) in c {
            b.insert(k.clone(), v.clone());
        }
    }

    // Re-inject local secrets (cloud never carried them; cloud's telegram/
    // providers objects just lack the secret subfields after the overwrite).
    if let Some(b) = base.as_object_mut() {
        b.insert(
            "anthropic_api_key".into(),
            serde_json::to_value(&local.anthropic_api_key).unwrap_or(Value::Null),
        );
        b.insert(
            "sendgrid_api_key".into(),
            serde_json::to_value(&local.sendgrid_api_key).unwrap_or(Value::Null),
        );
        if let Some(tg) = b.get_mut("telegram").and_then(|v| v.as_object_mut()) {
            tg.insert("bot_token".into(), Value::String(local.telegram.bot_token.clone()));
        }
        if let Some(providers) = b.get_mut("providers").and_then(|v| v.as_object_mut()) {
            for (id, p) in providers.iter_mut() {
                if let (Some(po), Some(local_p)) = (p.as_object_mut(), local.providers.get(id)) {
                    po.insert(
                        "api_key".into(),
                        serde_json::to_value(&local_p.api_key).unwrap_or(Value::Null),
                    );
                }
            }
        }
    }

    serde_json::from_value(base).unwrap_or_else(|_| local.clone())
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p covenant cloud_sync::secrets`
Expected: PASS (2 tests). Requires `mod cloud_sync;` declared — add it in Task 5 Step 1 if compiling standalone fails; for now declare a temporary `pub mod secrets;` under a `pub mod cloud_sync` in `lib.rs`.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/cloud_sync/secrets.rs crates/app/src/lib.rs
git commit -m "feat(cloud-sync): secret strip + preference merge (preserves local keys)"
```

---

## Task 3: Operator upsert-import method

**Files:**
- Modify: `crates/app/src/operator_registry.rs`
- Test: same file's test module

**Interfaces:**
- Consumes: `Storage`, `Operator`, existing `create`/`update`/`get`.
- Produces: `pub async fn import(&self, storage: &Storage, op: Operator, soul_md: &str) -> Result<Operator, RegistryError>` — upsert by `op.id`; assign a `soul_path` if missing; write `soul_md` to it verbatim; never deletes.

- [ ] **Step 1: Write the failing test**

In the `#[cfg(test)] mod tests` of `operator_registry.rs`, add (adapt helpers to the existing test setup that builds a `Storage` + registry):
```rust
#[tokio::test]
async fn import_inserts_then_updates_by_id_without_deleting_others() {
    let (reg, storage, _tmp) = test_registry().await; // existing test harness
    let existing = reg.list();
    let mut op = sample_operator("Imported"); // existing helper or inline-built Operator
    let id = op.id;
    // First import = insert.
    reg.import(&storage, op.clone(), "# SOUL\nbody").await.unwrap();
    assert!(reg.get(id).is_some());
    assert_eq!(reg.read_soul(id).unwrap(), "# SOUL\nbody");
    // Locally-present operators are untouched.
    for e in &existing { assert!(reg.get(e.id).is_some()); }
    // Second import with same id = update.
    op.name = "Renamed".into();
    reg.import(&storage, op, "# SOUL\nnew").await.unwrap();
    assert_eq!(reg.get(id).unwrap().name, "Renamed");
    assert_eq!(reg.read_soul(id).unwrap(), "# SOUL\nnew");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p covenant operator_registry::tests::import_inserts_then_updates`
Expected: FAIL — `import` not found. (If the test harness helpers `test_registry`/`sample_operator` don't exist, build the registry inline the way other tests in this file do — match the existing pattern verbatim.)

- [ ] **Step 3: Implement `import`**

Add to `impl OperatorRegistry`:
```rust
/// Upsert an operator from a synced snapshot: insert when its id is unknown,
/// otherwise update in place. Assigns a soul_path when the incoming operator
/// lacks one (synced operators have it stripped), then writes the provided
/// SOUL.md verbatim. Never deletes — operators absent from the snapshot are
/// left alone by the caller.
pub async fn import(
    &self,
    storage: &Storage,
    mut op: Operator,
    soul_md: &str,
) -> Result<Operator, RegistryError> {
    if op.soul_path.is_none() {
        op.soul_path = Some(self.soul_path_for(&op)); // see Step 3b
    }
    let saved = if self.get(op.id).is_some() {
        self.update(storage, op).await?
    } else {
        self.create(storage, op).await?
    };
    if let Some(path) = &saved.soul_path {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| RegistryError::Storage(crate::storage::StorageError::Other(e.to_string())))?;
        }
        std::fs::write(path, soul_md)
            .map_err(|e| RegistryError::Storage(crate::storage::StorageError::Other(e.to_string())))?;
    }
    Ok(saved)
}
```

- [ ] **Step 3b: Provide `soul_path_for` if absent**

If the file has no slug→path helper, add one mirroring how `create()` derives a path (kebab-case name under the souls dir, ULID suffix on collision). Reuse the exact existing slug logic — search this file for where `create` sets `soul_path` and extract it into:
```rust
fn soul_path_for(&self, op: &Operator) -> std::path::PathBuf {
    // EXTRACT the existing path-derivation used by create(); do not invent a
    // new scheme. self.souls_dir is the base souls directory.
    self.souls_dir.join(format!("{}", slugify(&op.name))).join("SOUL.md")
}
```
(If `create()` already assigns `soul_path` when `None`, skip 3b entirely and drop the `if op.soul_path.is_none()` block — let `create`/`update` own it. Verify which by reading `create()` before implementing.)

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p covenant operator_registry::tests::import_inserts_then_updates`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator_registry.rs
git commit -m "feat(cloud-sync): OperatorRegistry::import upsert-by-id (no delete)"
```

---

## Task 4: Envelope types, gather, apply, HTTP (desktop core)

**Files:**
- Create: `crates/app/src/cloud_sync/mod.rs`
- Modify: `crates/app/Cargo.toml` (add `hostname = "0.4"`)

**Interfaces:**
- Consumes: `secrets::{strip_secrets, merge_preferences}`, `OperatorRegistry::{list, read_soul, import}`, `karl_agent::spec_author::{list_drafts, save_draft, SpecDraft, home_covenant_dir}`, `crate::tab_manifest::{load, save}`, `crate::settings::{Settings, CloudSyncConfig}`, `karl_score::auth::{load_jwt, backend_url}`.
- Produces:
  - `pub struct SyncEnvelope { schema_version: u32, updated_at_ms: i64, device: String, sections: SyncSections }`
  - `pub struct SyncSections { workspaces: Option<Value>, operators: Option<Vec<OperatorExport>>, specs: Option<Vec<Value>>, preferences: Option<Value> }`
  - `pub struct OperatorExport { meta: Value, soul_md: String }`
  - `pub fn device_name() -> String`
  - `pub async fn build_envelope(ctx: &GatherCtx<'_>) -> SyncEnvelope`
  - `pub async fn apply_envelope(env: &SyncEnvelope, ctx: &ApplyCtx<'_>) -> ApplySummary`
  - `pub async fn push(env: &SyncEnvelope) -> Result<i64, String>` and `pub async fn pull() -> Result<Option<SyncEnvelope>, String>` and `pub async fn wipe() -> Result<(), String>`

- [ ] **Step 1: Add the dependency**

In `crates/app/Cargo.toml` `[dependencies]`, add:
```toml
hostname = "0.4"
```

- [ ] **Step 2: Write the envelope module**

Create `crates/app/src/cloud_sync/mod.rs`:
```rust
pub mod secrets;
pub mod commands;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::operator_registry::OperatorRegistry;
use crate::settings::{CloudSyncConfig, Settings};
use crate::storage::Storage;
use karl_score::auth;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncEnvelope {
    pub schema_version: u32,
    pub updated_at_ms: i64,
    pub device: String,
    pub sections: SyncSections,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SyncSections {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspaces: Option<Value>, // raw TabManifestV2 JSON
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operators: Option<Vec<OperatorExport>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specs: Option<Vec<Value>>, // raw SpecDraft JSON
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferences: Option<Value>, // Settings minus secrets
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OperatorExport {
    pub meta: Value, // serialized Operator, soul_path removed
    pub soul_md: String,
}

#[derive(Serialize, Default, Clone, Debug)]
pub struct ApplySummary {
    pub workspaces: bool,
    pub operators: usize,
    pub specs: usize,
    pub preferences: bool,
}

pub fn device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| std::env::consts::OS.to_string())
}

/// Everything the gather step reads from. Borrowed so commands can pass live
/// app state.
pub struct GatherCtx<'a> {
    pub cfg: &'a CloudSyncConfig,
    pub settings: &'a Settings,
    pub registry: &'a OperatorRegistry,
    pub tab_manifest_path: &'a std::path::Path,
    pub specs_base_dir: std::path::PathBuf,
}

pub fn build_envelope(ctx: &GatherCtx<'_>) -> SyncEnvelope {
    let mut sections = SyncSections::default();

    if ctx.cfg.workspaces {
        if let Ok(Some(body)) = crate::tab_manifest::load(ctx.tab_manifest_path) {
            sections.workspaces = serde_json::from_str::<Value>(&body).ok();
        }
    }
    if ctx.cfg.operators {
        let mut ops = Vec::new();
        for op in ctx.registry.list() {
            let mut meta = serde_json::to_value(&op).unwrap_or(Value::Null);
            if let Some(o) = meta.as_object_mut() {
                o.remove("soul_path"); // machine-specific; regenerated on import
            }
            let soul_md = ctx.registry.read_soul(op.id).unwrap_or_default();
            ops.push(OperatorExport { meta, soul_md });
        }
        sections.operators = Some(ops);
    }
    if ctx.cfg.specs {
        let drafts = karl_agent::spec_author::list_drafts(&ctx.specs_base_dir); // already capped at 20
        sections.specs = Some(
            drafts
                .iter()
                .filter_map(|d| serde_json::to_value(d).ok())
                .collect(),
        );
    }
    if ctx.cfg.preferences {
        let mut prefs = serde_json::to_value(ctx.settings).unwrap_or(Value::Null);
        secrets::strip_secrets(&mut prefs);
        sections.preferences = Some(prefs);
    }

    SyncEnvelope {
        schema_version: SCHEMA_VERSION,
        updated_at_ms: chrono::Utc::now().timestamp_millis(),
        device: device_name(),
        sections,
    }
}

/// Everything apply writes to.
pub struct ApplyCtx<'a> {
    pub settings: &'a Settings,
    pub registry: &'a OperatorRegistry,
    pub storage: &'a Storage,
    pub tab_manifest_path: &'a std::path::Path,
    pub specs_base_dir: std::path::PathBuf,
    /// Sink for the merged settings (the command persists + broadcasts it).
    pub merged_settings_out: &'a mut Option<Settings>,
}

pub async fn apply_envelope(env: &SyncEnvelope, ctx: &mut ApplyCtx<'_>) -> ApplySummary {
    let mut summary = ApplySummary::default();

    if let Some(ws) = &env.sections.workspaces {
        if let Ok(body) = serde_json::to_string(ws) {
            if crate::tab_manifest::save(ctx.tab_manifest_path, &body).is_ok() {
                summary.workspaces = true;
            }
        }
    }
    if let Some(ops) = &env.sections.operators {
        for ex in ops {
            // meta has no soul_path; deserialize then let import assign it.
            if let Ok(op) = serde_json::from_value::<crate::operator_registry::Operator>(ex.meta.clone()) {
                if ctx.registry.import(ctx.storage, op, &ex.soul_md).await.is_ok() {
                    summary.operators += 1;
                }
            }
        }
    }
    if let Some(specs) = &env.sections.specs {
        for s in specs {
            if let Ok(draft) = serde_json::from_value::<karl_agent::spec_author::SpecDraft>(s.clone()) {
                if karl_agent::spec_author::save_draft(&ctx.specs_base_dir, &draft).is_ok() {
                    summary.specs += 1;
                }
            }
        }
    }
    if let Some(cloud_prefs) = &env.sections.preferences {
        *ctx.merged_settings_out = Some(secrets::merge_preferences(ctx.settings, cloud_prefs));
        summary.preferences = true;
    }

    summary
}

// ---- HTTP ----

fn endpoint() -> String {
    format!("{}/sync/state", auth::backend_url())
}

pub async fn push(env: &SyncEnvelope) -> Result<i64, String> {
    let jwt = auth::load_jwt().map_err(|e| e.to_string())?.ok_or("not signed in")?;
    let resp = reqwest::Client::new()
        .put(endpoint())
        .header("User-Agent", "covenant-cloud-sync")
        .bearer_auth(&jwt)
        .json(env)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["updated_at_ms"].as_i64().unwrap_or(0))
}

pub async fn pull() -> Result<Option<SyncEnvelope>, String> {
    let jwt = auth::load_jwt().map_err(|e| e.to_string())?.ok_or("not signed in")?;
    let resp = reqwest::Client::new()
        .get(endpoint())
        .header("User-Agent", "covenant-cloud-sync")
        .bearer_auth(&jwt)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    let resp = resp.error_for_status().map_err(|e| e.to_string())?;
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let env = serde_json::from_value::<SyncEnvelope>(v["state"].clone()).map_err(|e| e.to_string())?;
    Ok(Some(env))
}

pub async fn wipe() -> Result<(), String> {
    let jwt = auth::load_jwt().map_err(|e| e.to_string())?.ok_or("not signed in")?;
    reqwest::Client::new()
        .delete(endpoint())
        .header("User-Agent", "covenant-cloud-sync")
        .bearer_auth(&jwt)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

- [ ] **Step 3: Write a round-trip unit test for build→serialize→deserialize**

Append to `mod.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips_through_json() {
        let env = SyncEnvelope {
            schema_version: SCHEMA_VERSION,
            updated_at_ms: 123,
            device: "dev".into(),
            sections: SyncSections {
                workspaces: Some(serde_json::json!({"version":2})),
                operators: None,
                specs: Some(vec![serde_json::json!({"id":"x"})]),
                preferences: None,
            },
        };
        let s = serde_json::to_string(&env).unwrap();
        let back: SyncEnvelope = serde_json::from_str(&s).unwrap();
        assert_eq!(back.schema_version, SCHEMA_VERSION);
        assert!(back.sections.workspaces.is_some());
        assert!(back.sections.operators.is_none());
        assert_eq!(back.sections.specs.unwrap().len(), 1);
    }
}
```

- [ ] **Step 4: Compile + test**

Run: `cargo test -p covenant cloud_sync::tests::envelope_round_trips`
Expected: PASS. (Depends on Task 5 adding `CloudSyncConfig`; if compiling now, temporarily add the struct per Task 5 Step 1 first.)

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/cloud_sync/mod.rs crates/app/Cargo.toml
git commit -m "feat(cloud-sync): envelope types, gather, apply, HTTP push/pull/wipe"
```

---

## Task 5: `CloudSyncConfig` + Tauri commands + registration

**Files:**
- Modify: `crates/app/src/settings.rs` (add `CloudSyncConfig`, field on `Settings`)
- Create: `crates/app/src/cloud_sync/commands.rs`
- Modify: `crates/app/src/lib.rs` (`mod cloud_sync;`, register commands)

**Interfaces:**
- Consumes: `AppState { settings, settings_path, storage, data_dir, .. }`, the operator registry handle (however commands currently reach it — match `operator_*` commands), `cloud_sync::{build_envelope, apply_envelope, push, pull, wipe, GatherCtx, ApplyCtx, device_name}`, `settings::save`.
- Produces these Tauri commands (snake_case = JS invoke names):
  - `cloud_sync_status() -> CloudSyncStatus { signed_in, enabled, workspaces, operators, specs, preferences, last_synced_ms: Option<i64>, device: Option<String> }`
  - `cloud_sync_set_config(cfg: CloudSyncConfig) -> ()`
  - `cloud_sync_push() -> i64` (updated_at_ms)
  - `cloud_sync_restore() -> ApplySummary`
  - `cloud_sync_wipe() -> ()`

- [ ] **Step 1: Add `CloudSyncConfig` to Settings**

In `settings.rs`, add near the other config structs:
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudSyncConfig {
    pub enabled: bool,
    pub workspaces: bool,
    pub operators: bool,
    pub specs: bool,
    pub preferences: bool,
}

impl Default for CloudSyncConfig {
    fn default() -> Self {
        // Opt-in: off until the user turns it on, but all categories pre-checked
        // so enabling is one click.
        Self { enabled: false, workspaces: true, operators: true, specs: true, preferences: true }
    }
}
```
Add to the `Settings` struct (with `#[serde(default)]` so old configs migrate cleanly):
```rust
    #[serde(default)]
    pub cloud_sync: CloudSyncConfig,
```

- [ ] **Step 2: Write the commands**

Create `crates/app/src/cloud_sync/commands.rs`:
```rust
use serde::Serialize;
use tauri::State;

use super::{apply_envelope, build_envelope, device_name, pull, push, wipe, ApplyCtx, ApplySummary, GatherCtx};
use crate::settings::{self, CloudSyncConfig};
use crate::AppState;
use karl_score::auth;

#[derive(Serialize)]
pub struct CloudSyncStatus {
    pub signed_in: bool,
    pub enabled: bool,
    pub workspaces: bool,
    pub operators: bool,
    pub specs: bool,
    pub preferences: bool,
    pub last_synced_ms: Option<i64>,
    pub device: Option<String>,
}

#[tauri::command]
pub async fn cloud_sync_status(state: State<'_, AppState>) -> Result<CloudSyncStatus, String> {
    let signed_in = auth::load_jwt().ok().flatten().is_some();
    let cfg = { state.settings.lock().await.cloud_sync.clone() };
    // last_synced/device come from a GET (cheap); tolerate offline.
    let (last_synced_ms, device) = match pull().await {
        Ok(Some(env)) => (Some(env.updated_at_ms), Some(env.device)),
        _ => (None, None),
    };
    Ok(CloudSyncStatus {
        signed_in,
        enabled: cfg.enabled,
        workspaces: cfg.workspaces,
        operators: cfg.operators,
        specs: cfg.specs,
        preferences: cfg.preferences,
        last_synced_ms,
        device,
    })
}

#[tauri::command]
pub async fn cloud_sync_set_config(state: State<'_, AppState>, cfg: CloudSyncConfig) -> Result<(), String> {
    let mut s = state.settings.lock().await;
    s.cloud_sync = cfg;
    settings::save(&state.settings_path, &s).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cloud_sync_push(state: State<'_, AppState>) -> Result<i64, String> {
    let env = {
        let s = state.settings.lock().await;
        let ctx = GatherCtx {
            cfg: &s.cloud_sync,
            settings: &s,
            registry: state.operator_registry(), // match the accessor used by operator_* cmds
            tab_manifest_path: &state.tab_manifest_path(), // see Step 3
            specs_base_dir: karl_agent::spec_author::home_covenant_dir().map_err(|e| e.to_string())?,
        };
        build_envelope(&ctx)
    };
    push(&env).await
}

#[tauri::command]
pub async fn cloud_sync_restore(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<ApplySummary, String> {
    let env = pull().await?.ok_or("nothing in cloud yet")?;
    let mut merged: Option<crate::settings::Settings> = None;
    let summary = {
        let s = state.settings.lock().await;
        let mut ctx = ApplyCtx {
            settings: &s,
            registry: state.operator_registry(),
            storage: &state.storage,
            tab_manifest_path: &state.tab_manifest_path(),
            specs_base_dir: karl_agent::spec_author::home_covenant_dir().map_err(|e| e.to_string())?,
            merged_settings_out: &mut merged,
        };
        apply_envelope(&env, &mut ctx).await
    };
    if let Some(new_settings) = merged {
        let mut s = state.settings.lock().await;
        *s = new_settings.clone();
        settings::save(&state.settings_path, &s).map_err(|e| e.to_string())?;
        // Reuse the same broadcast set_settings uses so the UI updates live.
        crate::emit_settings_updated(&app, &new_settings);
    }
    Ok(summary)
}

#[tauri::command]
pub async fn cloud_sync_wipe(_state: State<'_, AppState>) -> Result<(), String> {
    wipe().await
}
```

- [ ] **Step 3: Wire AppState accessors**

Read how `operator_*` commands reach the registry and how `tab_manifest_save` resolves its path; mirror those exactly. Add small helpers on `AppState` if they don't exist:
```rust
impl AppState {
    pub(crate) fn operator_registry(&self) -> &crate::operator_registry::OperatorRegistry { /* return the held handle */ }
    pub(crate) fn tab_manifest_path(&self) -> std::path::PathBuf { self.data_dir.join("tab_manifest.json") /* confirm vs existing tab_manifest_save */ }
}
```
If `emit_settings_updated` doesn't exist, factor the broadcast block out of the existing `set_settings` command into `pub(crate) fn emit_settings_updated(app: &tauri::AppHandle, s: &Settings)` and call it from both.

- [ ] **Step 4: Register module + commands**

In `lib.rs`: add `mod cloud_sync;` with the other modules. Add to the `tauri::generate_handler![ ... ]` list (after the `score_*` commands):
```rust
    cloud_sync::commands::cloud_sync_status,
    cloud_sync::commands::cloud_sync_set_config,
    cloud_sync::commands::cloud_sync_push,
    cloud_sync::commands::cloud_sync_restore,
    cloud_sync::commands::cloud_sync_wipe,
```
Remove the temporary `pub mod cloud_sync` stub from Task 2/4 if you added one.

- [ ] **Step 5: Compile + run the suite**

Run: `cargo test -p covenant cloud_sync`
Expected: PASS (secrets + envelope tests). Then `cargo check -p covenant` clean.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/settings.rs crates/app/src/cloud_sync/commands.rs crates/app/src/lib.rs
git commit -m "feat(cloud-sync): CloudSyncConfig + status/push/restore/wipe Tauri commands"
```

---

## Task 6: Frontend API wrappers

**Files:**
- Modify: `ui/src/api.ts`

**Interfaces:**
- Produces typed wrappers:
  - `CloudSyncConfig`, `CloudSyncStatus`, `CloudApplySummary` interfaces.
  - `cloudSyncStatus(): Promise<CloudSyncStatus>`
  - `cloudSyncSetConfig(cfg: CloudSyncConfig): Promise<void>`
  - `cloudSyncPush(): Promise<number>`
  - `cloudSyncRestore(): Promise<CloudApplySummary>`
  - `cloudSyncWipe(): Promise<void>`

- [ ] **Step 1: Add the wrappers**

In `ui/src/api.ts` (follow the existing `invoke` wrapper style):
```typescript
export interface CloudSyncConfig {
  enabled: boolean;
  workspaces: boolean;
  operators: boolean;
  specs: boolean;
  preferences: boolean;
}
export interface CloudSyncStatus extends CloudSyncConfig {
  signed_in: boolean;
  last_synced_ms: number | null;
  device: string | null;
}
export interface CloudApplySummary {
  workspaces: boolean;
  operators: number;
  specs: number;
  preferences: boolean;
}
export async function cloudSyncStatus(): Promise<CloudSyncStatus> {
  return invoke<CloudSyncStatus>("cloud_sync_status");
}
export async function cloudSyncSetConfig(cfg: CloudSyncConfig): Promise<void> {
  return invoke<void>("cloud_sync_set_config", { cfg });
}
export async function cloudSyncPush(): Promise<number> {
  return invoke<number>("cloud_sync_push");
}
export async function cloudSyncRestore(): Promise<CloudApplySummary> {
  return invoke<CloudApplySummary>("cloud_sync_restore");
}
export async function cloudSyncWipe(): Promise<void> {
  return invoke<void>("cloud_sync_wipe");
}
```

- [ ] **Step 2: Typecheck**

Run (from repo root): `npx tsc --noEmit`
Expected: no new errors referencing `api.ts`.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(cloud-sync): typed Tauri command wrappers"
```

---

## Task 7: Settings "Covenant Cloud" section

**Files:**
- Modify: `ui/src/settings/panel.ts` (nav link + section block)
- Create: `ui/src/settings/cloud_sync.ts` (render + handlers)

**Interfaces:**
- Consumes: the Task 6 API; `attachTooltip` (per repo convention, never `element.title`).
- Produces: `export function mountCloudSyncSection(root: HTMLElement): void` rendering account state, master toggle, 4 category checkboxes, "Back up now" + "Restore from cloud…" buttons, and a status line; wires each control to the API.

- [ ] **Step 1: Add nav entry + section container**

In `panel.ts`, after the Workspace nav link, add:
```html
      <a href="#sec-cloud" data-target="sec-cloud">Covenant Cloud</a>
```
After the Workspace `<section>`, add:
```html
        <section class="settings-section" id="sec-cloud">
          <h3 class="settings-section-title">Covenant Cloud</h3>
          <div id="cloud-sync-root"></div>
        </section>
```
Where the panel initializes sub-sections, call `mountCloudSyncSection(document.getElementById("cloud-sync-root")!)`.

- [ ] **Step 2: Implement the section**

Create `ui/src/settings/cloud_sync.ts`:
```typescript
import {
  cloudSyncStatus, cloudSyncSetConfig, cloudSyncPush, cloudSyncRestore,
  type CloudSyncConfig, type CloudSyncStatus,
} from "../api";

const CATS: { key: keyof CloudSyncConfig; label: string }[] = [
  { key: "workspaces", label: "Workspaces" },
  { key: "operators", label: "Operators" },
  { key: "specs", label: "Specs" },
  { key: "preferences", label: "Preferences" },
];

export function mountCloudSyncSection(root: HTMLElement): void {
  root.innerHTML = `
    <p class="settings-help">Back up your workspaces, operators, specs and
      preferences to your Covenant account. <strong>API keys and tokens are
      never uploaded.</strong></p>
    <div class="cloud-account" data-account></div>
    <label class="settings-field cloud-master">
      <input type="checkbox" data-k="enabled" /> <span>Sync to Covenant Cloud</span>
    </label>
    <div class="cloud-cats">
      ${CATS.map((c) => `<label class="settings-field"><input type="checkbox" data-k="${c.key}" /> <span>${c.label}</span></label>`).join("")}
    </div>
    <div class="cloud-actions">
      <button type="button" data-act="backup">Back up now</button>
      <button type="button" data-act="restore">Restore from cloud…</button>
    </div>
    <div class="cloud-status" data-status></div>
  `;

  const statusEl = root.querySelector("[data-status]") as HTMLElement;
  const accountEl = root.querySelector("[data-account]") as HTMLElement;

  const readCfg = (): CloudSyncConfig => ({
    enabled: (root.querySelector('[data-k="enabled"]') as HTMLInputElement).checked,
    workspaces: (root.querySelector('[data-k="workspaces"]') as HTMLInputElement).checked,
    operators: (root.querySelector('[data-k="operators"]') as HTMLInputElement).checked,
    specs: (root.querySelector('[data-k="specs"]') as HTMLInputElement).checked,
    preferences: (root.querySelector('[data-k="preferences"]') as HTMLInputElement).checked,
  });

  const paint = (s: CloudSyncStatus): void => {
    (root.querySelector('[data-k="enabled"]') as HTMLInputElement).checked = s.enabled;
    for (const c of CATS) {
      (root.querySelector(`[data-k="${c.key}"]`) as HTMLInputElement).checked = s[c.key];
    }
    if (!s.signed_in) {
      accountEl.textContent = "Sign in with GitHub (Metrics tab) to enable cloud sync.";
      statusEl.textContent = "✗ sign-in required";
      return;
    }
    accountEl.textContent = "";
    statusEl.textContent = s.last_synced_ms
      ? `✓ last synced from ${s.device ?? "?"} · ${new Date(s.last_synced_ms).toLocaleString()}`
      : "✓ signed in · not yet backed up";
  };

  const persist = (): void => void cloudSyncSetConfig(readCfg());

  root.querySelectorAll('input[type="checkbox"]').forEach((el) =>
    el.addEventListener("change", persist),
  );

  root.querySelector('[data-act="backup"]')?.addEventListener("click", async () => {
    statusEl.textContent = "⟳ syncing…";
    try { await cloudSyncPush(); paint(await cloudSyncStatus()); }
    catch (e) { statusEl.textContent = `✗ ${String(e)}`; }
  });

  root.querySelector('[data-act="restore"]')?.addEventListener("click", async () => {
    const ok = window.confirm(
      "Restore from cloud?\n\n• Workspaces will be REPLACED.\n• Operators and specs will be merged (no deletions).\n• Preferences will be merged; your local API keys are kept.",
    );
    if (!ok) return;
    statusEl.textContent = "⟳ restoring…";
    try {
      const sum = await cloudSyncRestore();
      statusEl.textContent = `✓ restored — ${sum.operators} operators, ${sum.specs} specs${sum.workspaces ? ", workspaces" : ""}${sum.preferences ? ", preferences" : ""}`;
    } catch (e) { statusEl.textContent = `✗ ${String(e)}`; }
  });

  void cloudSyncStatus().then(paint).catch(() => { statusEl.textContent = "✗ unavailable"; });
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/settings/panel.ts ui/src/settings/cloud_sync.ts
git commit -m "feat(cloud-sync): Covenant Cloud settings section"
```

---

## Task 8: Debounced auto-push wiring

**Files:**
- Create: `ui/src/settings/cloud_push.ts`
- Modify: `ui/src/workspaces/manager.ts` (after `saveAll()`), the operator create/update/delete paths, the spec save path, and the settings-save path.

**Interfaces:**
- Produces: `export function scheduleCloudPush(): void` — debounced ~5 s; no-op unless `enabled` + signed in; fire-and-forget with one silent retry.

- [ ] **Step 1: Implement the debouncer**

Create `ui/src/settings/cloud_push.ts`:
```typescript
import { cloudSyncStatus, cloudSyncPush } from "../api";

let timer: ReturnType<typeof setTimeout> | null = null;

/** Debounced background push. Safe to call from any save path; cheap no-op
 *  when sync is disabled or the user is signed out. Never throws to callers. */
export function scheduleCloudPush(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      try {
        const s = await cloudSyncStatus();
        if (!s.signed_in || !s.enabled) return;
        await cloudSyncPush();
      } catch {
        // one silent retry after 10s; then give up until the next change
        setTimeout(() => void cloudSyncPush().catch(() => {}), 10_000);
      }
    })();
  }, 5_000);
}
```

- [ ] **Step 2: Call it from the save paths**

Add `import { scheduleCloudPush } from "../settings/cloud_push";` (adjust relative path per file) and call `scheduleCloudPush();` at the end of:
- `WorkspaceManager.saveAll()` in `ui/src/workspaces/manager.ts`
- wherever operators are created/updated/deleted in the settings/operators flow
- wherever specs are saved (`specAuthorSaveMarkdown` call site / step completion)
- the settings-save handler (after a successful `setSettings`)

Example (manager.ts, end of `saveAll`):
```typescript
    await tabManifestSave(body);
    scheduleCloudPush();
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/settings/cloud_push.ts ui/src/workspaces/manager.ts ui/src/settings/operators.ts ui/src/settings/panel.ts
git commit -m "feat(cloud-sync): debounced auto-push from workspace/operator/spec/settings saves"
```

---

## Task 9: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Build the desktop app**

`npm run tauri:dev` from repo root; sign in via the Metrics tab so a JWT exists.

- [ ] **Step 2: Push**

Open Settings → Covenant Cloud → enable sync → "Back up now". Expect status "✓ last synced from `<host>` · `<time>`".

- [ ] **Step 3: Mutate + auto-push**

Create an operator and a spec draft; within ~5 s the background push fires (re-open the section, timestamp advanced).

- [ ] **Step 4: Restore round-trip**

Change a non-secret preference (e.g. UI font) and an operator name locally, then "Restore from cloud…", confirm. Expect: the operator name reverts to the cloud copy, the font reverts, and your **local API keys remain intact** (check Inference/Providers — keys still present).

- [ ] **Step 5: Secret-leak check**

In a terminal: `curl -sS $COVENANT_BACKEND_URL/sync/state -H "authorization: Bearer $JWT" | python3 -m json.tool | grep -iE 'api_key|bot_token|sk-ant'`
Expected: **no matches** (the cloud copy carries no secrets).

---

## Self-Review

- **Spec coverage:** sync model C (auto-push T4/T8 + manual restore T5/T7) ✓; secrets stripped+merged (T2, verified T9.5) ✓; four categories incl. specs (T4 build/apply) ✓; upsert-no-delete operators (T3) + specs (T4 save_draft is id-keyed, additive) ✓; server endpoint + 5 MB cap (T1) ✓; Settings UI (T7) ✓; conflict last-write-wins (server upsert, T1) ✓; "last synced from device" readout (T1 device col, T5 status, T7 paint) ✓; toggles in device-local Settings (T5 CloudSyncConfig) ✓.
- **Placeholders:** Task 3 Step 3b and Task 5 Step 3 intentionally say "match the existing accessor/path derivation" — these are *verify-then-mirror* instructions against named existing functions, not invented APIs; the implementer reads the cited function and copies its scheme. All other steps carry concrete code.
- **Type consistency:** `CloudSyncConfig` fields (enabled/workspaces/operators/specs/preferences) match across settings.rs (T5), commands status (T5), api.ts (T6), and UI (T7). `ApplySummary`/`CloudApplySummary` fields (workspaces:bool, operators:usize/number, specs, preferences) match T4/T5/T6/T7. `SyncEnvelope` fields identical in server-stored JSON (T1) and desktop (T4).

## Out of scope (per spec)

CRDT/field merge, exact-mirror deletes, real-time sync, syncing secrets/history.db/familiars/score.
