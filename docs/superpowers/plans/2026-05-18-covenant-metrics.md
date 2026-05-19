# Covenant Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new dimensions to the Covenant Settings page — execution-agent usage, spec creation count, and per-model token usage (internal + external) — all honoring existing range/repo/branch/day/group filters.

**Architecture:** Extend `karl_score` with two new SQLite tables (`specs`, `llm_calls`) plus an `agent` column on `score_events`. Record at three call sites: `record_prompt` (agent label from fg-proc), `agent::dispatch()` (internal LLM usage), and two background tasks (spec FS watcher + external-agent cost-file pollers). Surface via three new Tauri commands and three new UI cards in `ui/src/score/page.ts`.

**Tech Stack:** Rust + rusqlite + tokio + notify (fs watcher), Tauri 2 IPC, TypeScript + xterm.js (no new deps on frontend).

**Spec:** `docs/superpowers/specs/2026-05-18-covenant-metrics-design.md`

**Pre-flight (operator does once):**
- Work in a git worktree (project memory: worktrees mandatory for agent-driven edits).
- `cargo test -p karl-score` is the canonical green-bar check; run after every backend task.
- UI build: `cd ui && npm run build` after frontend tasks.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `crates/score/src/store.rs` | modify | Migrations to v3; `record_spec`, `record_llm_call`; new query methods |
| `crates/score/src/types.rs` | modify | `agent` field on `ScoreEvent`; `AgentCell`, `SpecRow`, `SpecBreakdown`, `ModelSource`, `ModelCell`; `ScoreFilter.agent`; `Summary.{total_tokens,total_specs}` |
| `crates/score/src/filter.rs` | modify | Honor `agent` in `build_where` |
| `crates/score/src/agent_label.rs` | create | Map fg-proc name/argv → canonical agent label |
| `crates/score/src/spec_watcher.rs` | create | notify-based watcher → `record_spec` |
| `crates/score/src/external/mod.rs` | create | Trait + poller scheduler |
| `crates/score/src/external/claude_code.rs` | create | Parse `~/.claude/projects/**/*.jsonl` |
| `crates/score/src/external/codex.rs` | create | Parse `~/.codex/sessions/**/rollout-*.jsonl` |
| `crates/score/src/external/opencode.rs` | create | Stub (no-op if files absent) |
| `crates/score/src/external/pi.rs` | create | Stub (no-op if files absent) |
| `crates/score/src/lib.rs` | modify | Re-exports; `record_spec`, `record_llm_call` thin wrappers |
| `crates/score/src/sync.rs` | modify | Include `specs` + `llm_calls` in upload payload |
| `crates/app/src/score_commands.rs` | modify | Three new commands |
| `crates/app/src/lib.rs` | modify | Register new commands; start watcher + pollers |
| `crates/app/src/spec_author.rs` | modify | Call `karl_score::record_spec` on finalize |
| `crates/agent/src/provider/anthropic.rs` | modify | Call `karl_score::record_llm_call` with usage |
| `crates/agent/src/provider/openai_compat.rs` | modify | Call `karl_score::record_llm_call` with usage |
| `ui/src/score/api.ts` | modify | New types + command wrappers |
| `ui/src/score/page.ts` | modify | Layout, total-tokens tile, agent filter chip |
| `ui/src/score/usage.ts` | create | Renderers for agent bars, specs card, models card |
| `ui/src/score/styles.css` | modify | Pill toggle, model table, agent bar colors |

---

## Task 1: Schema migration v3 (specs + llm_calls + agent column)

**Files:**
- Modify: `crates/score/src/store.rs:24-71`
- Test: `crates/score/tests/store.rs`

- [ ] **Step 1: Write the failing test**

Add to `crates/score/tests/store.rs`:

```rust
#[test]
fn migration_v3_creates_specs_and_llm_calls_and_agent_column() {
    let tmp = tempfile::tempdir().unwrap();
    let store = karl_score::ScoreStore::open(tmp.path()).unwrap();
    let conn = store.connection();
    let c = conn.lock().unwrap();

    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert!(v >= 3, "expected user_version >= 3, got {v}");

    // agent column present on score_events
    let cols: Vec<String> = c
        .prepare("PRAGMA table_info(score_events)").unwrap()
        .query_map([], |r| r.get::<_, String>(1)).unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(cols.contains(&"agent".to_string()));

    // tables exist
    c.execute("INSERT INTO specs(ts_ms, path) VALUES (1, 'a')", []).unwrap();
    c.execute(
        "INSERT INTO llm_calls(ts_ms, source, provider, model, input_tokens, output_tokens) \
         VALUES (1, 'internal', 'anthropic', 'claude-opus-4-7', 100, 50)",
        [],
    ).unwrap();
}
```

- [ ] **Step 2: Run test to verify it fails**

```
cargo test -p karl-score migration_v3 -- --nocapture
```

Expected: FAIL ("no such table: specs" or "no such column: agent").

- [ ] **Step 3: Implement migration**

Append to `ScoreStore::open` in `crates/score/src/store.rs` after the existing v2 block (around line 66):

```rust
if v < 3 {
    conn.execute_batch(
        "ALTER TABLE score_events ADD COLUMN agent TEXT;
         CREATE INDEX IF NOT EXISTS idx_events_agent ON score_events(agent);

         CREATE TABLE IF NOT EXISTS specs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ts_ms       INTEGER NOT NULL,
            day         TEXT    NOT NULL,
            path        TEXT    NOT NULL UNIQUE,
            repo        TEXT,
            branch      TEXT,
            group_name  TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_specs_ts   ON specs(ts_ms);
         CREATE INDEX IF NOT EXISTS idx_specs_day  ON specs(day);
         CREATE INDEX IF NOT EXISTS idx_specs_repo ON specs(repo);

         CREATE TABLE IF NOT EXISTS llm_calls (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            ts_ms           INTEGER NOT NULL,
            day             TEXT    NOT NULL,
            source          TEXT    NOT NULL CHECK (source IN ('internal','external')),
            agent           TEXT,
            provider        TEXT    NOT NULL,
            model           TEXT    NOT NULL,
            input_tokens    INTEGER NOT NULL DEFAULT 0,
            output_tokens   INTEGER NOT NULL DEFAULT 0,
            cache_read      INTEGER NOT NULL DEFAULT 0,
            cache_creation  INTEGER NOT NULL DEFAULT 0,
            repo            TEXT,
            branch          TEXT,
            group_name      TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_llm_ts          ON llm_calls(ts_ms);
         CREATE INDEX IF NOT EXISTS idx_llm_day         ON llm_calls(day);
         CREATE INDEX IF NOT EXISTS idx_llm_source_mod  ON llm_calls(source, model);
         CREATE INDEX IF NOT EXISTS idx_llm_agent       ON llm_calls(agent);

         CREATE TABLE IF NOT EXISTS external_watermarks (
            source     TEXT NOT NULL,
            path       TEXT NOT NULL,
            byte_offset INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (source, path)
         );

         PRAGMA user_version = 3;",
    )?;
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cargo test -p karl-score migration_v3
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/store.rs crates/score/tests/store.rs
git commit -m "feat(score): migration v3 — specs, llm_calls, agent column"
```

---

## Task 2: Agent label resolver

**Files:**
- Create: `crates/score/src/agent_label.rs`
- Test: `crates/score/tests/agent_label.rs`
- Modify: `crates/score/src/lib.rs` (add `pub mod agent_label;`)

- [ ] **Step 1: Write the failing test**

Create `crates/score/tests/agent_label.rs`:

```rust
use karl_score::agent_label::resolve;

#[test]
fn maps_known_processes() {
    assert_eq!(resolve("claude", &["claude"]),       Some("claude_code"));
    assert_eq!(resolve("node",   &["node", "/usr/local/bin/claude"]), Some("claude_code"));
    assert_eq!(resolve("codex",  &["codex"]),        Some("codex"));
    assert_eq!(resolve("gh",     &["gh", "copilot"]),Some("copilot"));
    assert_eq!(resolve("opencode", &["opencode"]),   Some("opencode"));
    assert_eq!(resolve("pi",     &["pi"]),           Some("pi"));
    assert_eq!(resolve("zsh",    &["zsh"]),          None);
}
```

- [ ] **Step 2: Run test to verify it fails**

```
cargo test -p karl-score --test agent_label
```

Expected: FAIL (module missing).

- [ ] **Step 3: Implement resolver**

Create `crates/score/src/agent_label.rs`:

```rust
//! Map a foreground process to a canonical execution-agent label.
//!
//! Claude Code overwrites its `comm` to a version string starting in v2.1,
//! so we MUST also inspect argv before falling back to None.

pub fn resolve(comm: &str, argv: &[&str]) -> Option<&'static str> {
    let comm_l = comm.to_lowercase();
    let argv_joined = argv.iter().map(|s| s.to_lowercase()).collect::<Vec<_>>().join(" ");

    let has = |needle: &str| comm_l.contains(needle) || argv_joined.contains(needle);

    if has("claude")   { return Some("claude_code"); }
    if has("codex")    { return Some("codex"); }
    if has("copilot")  { return Some("copilot"); }
    if has("opencode") { return Some("opencode"); }
    if argv_joined.split_whitespace().any(|t| t == "pi") || comm_l == "pi" {
        return Some("pi");
    }
    None
}
```

Add to `crates/score/src/lib.rs` (top of module list):

```rust
pub mod agent_label;
```

- [ ] **Step 4: Run test to verify it passes**

```
cargo test -p karl-score --test agent_label
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/agent_label.rs crates/score/src/lib.rs crates/score/tests/agent_label.rs
git commit -m "feat(score): agent-label resolver for fg-proc → canonical label"
```

---

## Task 3: Extend `ScoreEvent`, filter, and `record_prompt` to carry agent

**Files:**
- Modify: `crates/score/src/types.rs:11-17` and `:71-79`
- Modify: `crates/score/src/filter.rs:10-44`
- Modify: `crates/score/src/store.rs:91-118` (`append_with_context`)
- Modify: `crates/score/src/lib.rs:64-82` (`record_prompt_with_context`)
- Test: `crates/score/tests/recorder.rs`

- [ ] **Step 1: Write the failing test**

Append to `crates/score/tests/recorder.rs`:

```rust
#[test]
fn record_prompt_with_agent_persists_label() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());
    karl_score::record_prompt_with_agent("anthropic", Some("claude_code"));

    let conn = store.connection();
    let c = conn.lock().unwrap();
    let (executor, agent): (String, Option<String>) = c
        .query_row(
            "SELECT executor, agent FROM score_events ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(executor, "anthropic");
    assert_eq!(agent.as_deref(), Some("claude_code"));
    karl_score::clear_recorder_for_test();
}
```

- [ ] **Step 2: Run test to verify it fails**

```
cargo test -p karl-score record_prompt_with_agent
```

Expected: FAIL (function missing).

- [ ] **Step 3: Add `agent` field + recorder fn**

In `crates/score/src/types.rs`, extend `ScoreEvent`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreEvent {
    pub timestamp_ms: i64,
    pub kind: EventKind,
    pub executor: String,
    #[serde(default)]
    pub agent: Option<String>,
}
```

Extend `ScoreFilter`:

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScoreFilter {
    #[serde(default)]
    pub range: TimeRange,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub group_name: Option<String>,
    pub day: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
}
```

In `crates/score/src/filter.rs`, add inside `build_where` after the `day` block:

```rust
if let Some(a) = &f.agent {
    parts.push("agent = ?".into());
    params.push(a.clone().into());
}
```

In `crates/score/src/store.rs`, change `append_with_context` signature and SQL to accept an `agent: Option<&str>` and write it. Replace the function body:

```rust
pub fn append_with_context(
    &self,
    timestamp_ms: i64,
    kind: EventKind,
    executor: &str,
    agent: Option<&str>,
    ctx: &Context,
) -> Result<()> {
    let day = day_from_ms_local(timestamp_ms);
    let kind_s = match kind {
        EventKind::Prompt => "prompt",
        EventKind::Commit => "commit",
    };
    let c = self.conn.lock().unwrap();
    c.execute(
        "INSERT INTO score_events(timestamp_ms, kind, executor, day, repo, branch, group_name, agent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            timestamp_ms, kind_s, executor, day,
            ctx.repo, ctx.branch, ctx.group_name, agent
        ],
    )?;
    Ok(())
}
```

Update all callers in `crates/score/src/lib.rs`: replace `record_prompt_with_context` and add a new `record_prompt_with_agent`:

```rust
pub fn record_prompt_with_agent(executor: &str, agent: Option<&str>) {
    let now = chrono::Utc::now().timestamp_millis();
    let cur = current_slot().lock().ok().and_then(|g| g.clone());
    let ctx = match cur {
        Some(c) => resolver().resolve(&c.session_id, &c.cwd, c.group_name),
        None => Context::default(),
    };
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            if let Err(e) = store.append_with_context(now, EventKind::Prompt, executor, agent, &ctx) {
                tracing::warn!(target: "score", error = %e, "record_prompt_with_agent failed");
            }
        }
    }
}

pub fn record_prompt_with_context(executor: &str) {
    record_prompt_with_agent(executor, None)
}

pub fn record_prompt(executor: &str) {
    record_prompt_with_agent(executor, None)
}
```

Update `record_commit_with_context` to pass `None` for agent:

```rust
let _ = store.append_with_context(now, EventKind::Commit, &exec, None, &ctx);
```

- [ ] **Step 4: Run tests**

```
cargo test -p karl-score
```

Expected: all green (existing tests still pass — they call `record_prompt` which now forwards with `agent=None`).

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/types.rs crates/score/src/filter.rs crates/score/src/store.rs crates/score/src/lib.rs crates/score/tests/recorder.rs
git commit -m "feat(score): thread agent label through record_prompt + ScoreFilter"
```

---

## Task 4: `record_spec` + `breakdown_specs` query

**Files:**
- Modify: `crates/score/src/store.rs` (append methods)
- Modify: `crates/score/src/types.rs` (add `SpecRow`, `SpecBreakdown`)
- Modify: `crates/score/src/lib.rs` (add `record_spec`)
- Test: `crates/score/tests/specs.rs` (new)

- [ ] **Step 1: Write the failing test**

Create `crates/score/tests/specs.rs`:

```rust
#[test]
fn record_spec_dedup_and_query() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    karl_score::record_spec("/work/repo/docs/a.md", &karl_score::Context {
        repo: Some("repo".into()), branch: None, group_name: None,
    });
    // dup path: should be a no-op
    karl_score::record_spec("/work/repo/docs/a.md", &karl_score::Context::default());
    karl_score::record_spec("/work/repo/docs/b.md", &karl_score::Context::default());

    let f = karl_score::ScoreFilter::default();
    let br = store.breakdown_specs(&f).unwrap();
    assert_eq!(br.total, 2);
    assert_eq!(br.recent.len(), 2);
    karl_score::clear_recorder_for_test();
}
```

- [ ] **Step 2: Run test to verify it fails**

```
cargo test -p karl-score --test specs
```

Expected: FAIL (`record_spec` and `breakdown_specs` undefined).

- [ ] **Step 3: Implement types + store methods + lib wrapper**

In `crates/score/src/types.rs` append:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecRow {
    pub ts_ms: i64,
    pub path: String,
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecBreakdown {
    pub total: u32,
    pub recent: Vec<SpecRow>,
}
```

In `crates/score/src/store.rs` append to `impl ScoreStore`:

```rust
pub fn append_spec(&self, timestamp_ms: i64, path: &str, ctx: &Context) -> Result<bool> {
    let day = day_from_ms_local(timestamp_ms);
    let c = self.conn.lock().unwrap();
    let rows = c.execute(
        "INSERT OR IGNORE INTO specs(ts_ms, day, path, repo, branch, group_name)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![timestamp_ms, day, path, ctx.repo, ctx.branch, ctx.group_name],
    )?;
    Ok(rows > 0)
}

pub fn breakdown_specs(&self, f: &crate::ScoreFilter) -> Result<crate::SpecBreakdown> {
    // Reuse the same WHERE columns (range/repo/branch/day/group_name).
    // `agent` filter does not apply to specs — drop it.
    let mut fcopy = f.clone();
    fcopy.agent = None;
    let w = crate::filter::build_where(&fcopy);

    let count_sql = format!("SELECT COUNT(*) FROM specs WHERE {}", w.sql);
    let recent_sql = format!(
        "SELECT ts_ms, path, repo FROM specs WHERE {} ORDER BY ts_ms DESC LIMIT 5",
        w.sql
    );

    let c = self.conn.lock().unwrap();
    let total: i64 = c.query_row(&count_sql, rusqlite::params_from_iter(w.params.iter()), |r| r.get(0))?;
    let mut stmt = c.prepare(&recent_sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(w.params.iter()), |r| {
        Ok(crate::SpecRow {
            ts_ms: r.get(0)?,
            path: r.get(1)?,
            repo: r.get(2)?,
        })
    })?;
    Ok(crate::SpecBreakdown {
        total: total as u32,
        recent: rows.collect::<rusqlite::Result<Vec<_>>>()?,
    })
}
```

In `crates/score/src/lib.rs` append:

```rust
pub fn record_spec(path: &str, ctx: &Context) {
    let now = chrono::Utc::now().timestamp_millis();
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            if let Err(e) = store.append_spec(now, path, ctx) {
                tracing::warn!(target: "score", error = %e, "record_spec failed");
            }
        }
    }
}
```

Re-export `SpecBreakdown`, `SpecRow` in the `pub use types::{ ... }` line.

- [ ] **Step 4: Run test**

```
cargo test -p karl-score --test specs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/store.rs crates/score/src/types.rs crates/score/src/lib.rs crates/score/tests/specs.rs
git commit -m "feat(score): record_spec + breakdown_specs"
```

---

## Task 5: `record_llm_call` + `breakdown_models` query

**Files:**
- Modify: `crates/score/src/store.rs`
- Modify: `crates/score/src/types.rs`
- Modify: `crates/score/src/lib.rs`
- Test: `crates/score/tests/llm_calls.rs` (new)

- [ ] **Step 1: Write the failing test**

Create `crates/score/tests/llm_calls.rs`:

```rust
use karl_score::{Context, LlmUsage, ModelSource, ScoreFilter};

#[test]
fn aggregates_models_by_source() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    let ctx = Context::default();
    karl_score::record_llm_call(ModelSource::Internal, None, "anthropic", "claude-opus-4-7",
        LlmUsage { input: 100, output: 50, cache_read: 0, cache_creation: 0 }, &ctx);
    karl_score::record_llm_call(ModelSource::Internal, None, "anthropic", "claude-opus-4-7",
        LlmUsage { input: 30, output: 10, cache_read: 0, cache_creation: 0 }, &ctx);
    karl_score::record_llm_call(ModelSource::External, Some("claude_code"), "anthropic", "claude-sonnet-4-6",
        LlmUsage { input: 200, output: 80, cache_read: 50, cache_creation: 0 }, &ctx);

    let internal = store.breakdown_models(&ScoreFilter::default(), ModelSource::Internal).unwrap();
    assert_eq!(internal.len(), 1);
    assert_eq!(internal[0].model, "claude-opus-4-7");
    assert_eq!(internal[0].calls, 2);
    assert_eq!(internal[0].input_tokens, 130);
    assert_eq!(internal[0].output_tokens, 60);

    let external = store.breakdown_models(&ScoreFilter::default(), ModelSource::External).unwrap();
    assert_eq!(external.len(), 1);
    assert_eq!(external[0].agent.as_deref(), Some("claude_code"));
    karl_score::clear_recorder_for_test();
}
```

- [ ] **Step 2: Run test to verify it fails**

```
cargo test -p karl-score --test llm_calls
```

Expected: FAIL (types missing).

- [ ] **Step 3: Implement**

In `crates/score/src/types.rs` append:

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelSource { Internal, External }

#[derive(Debug, Clone, Copy, Default)]
pub struct LlmUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCell {
    pub source: ModelSource,
    pub agent: Option<String>,
    pub provider: String,
    pub model: String,
    pub calls: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCell {
    pub agent: String,
    pub prompts: u32,
    pub share: f32,
}
```

In `crates/score/src/store.rs` append:

```rust
pub fn append_llm_call(
    &self,
    timestamp_ms: i64,
    source: crate::ModelSource,
    agent: Option<&str>,
    provider: &str,
    model: &str,
    u: crate::LlmUsage,
    ctx: &Context,
) -> Result<()> {
    let day = day_from_ms_local(timestamp_ms);
    let src = match source { crate::ModelSource::Internal => "internal", crate::ModelSource::External => "external" };
    let c = self.conn.lock().unwrap();
    c.execute(
        "INSERT INTO llm_calls(ts_ms, day, source, agent, provider, model,
                               input_tokens, output_tokens, cache_read, cache_creation,
                               repo, branch, group_name)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            timestamp_ms, day, src, agent, provider, model,
            u.input as i64, u.output as i64, u.cache_read as i64, u.cache_creation as i64,
            ctx.repo, ctx.branch, ctx.group_name
        ],
    )?;
    Ok(())
}

pub fn breakdown_models(
    &self,
    f: &crate::ScoreFilter,
    source: crate::ModelSource,
) -> Result<Vec<crate::ModelCell>> {
    let w = crate::filter::build_where(f);
    let src = match source { crate::ModelSource::Internal => "internal", crate::ModelSource::External => "external" };
    let sql = format!(
        "SELECT agent, provider, model,
                COUNT(*),
                COALESCE(SUM(input_tokens),0),
                COALESCE(SUM(output_tokens),0),
                COALESCE(SUM(cache_read),0)
         FROM llm_calls
         WHERE source = ? AND {}
         GROUP BY agent, provider, model
         ORDER BY 4 DESC
         LIMIT 50",
        w.sql
    );
    let mut params: Vec<rusqlite::types::Value> = vec![src.to_string().into()];
    params.extend(w.params.iter().cloned());

    let c = self.conn.lock().unwrap();
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
        Ok(crate::ModelCell {
            source,
            agent: r.get::<_, Option<String>>(0)?,
            provider: r.get(1)?,
            model: r.get(2)?,
            calls: r.get::<_, i64>(3)? as u32,
            input_tokens: r.get::<_, i64>(4)? as u64,
            output_tokens: r.get::<_, i64>(5)? as u64,
            cache_read: r.get::<_, i64>(6)? as u64,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}
```

In `crates/score/src/lib.rs` append:

```rust
pub fn record_llm_call(
    source: ModelSource,
    agent: Option<&str>,
    provider: &str,
    model: &str,
    usage: LlmUsage,
    ctx: &Context,
) {
    let now = chrono::Utc::now().timestamp_millis();
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            if let Err(e) = store.append_llm_call(now, source, agent, provider, model, usage, ctx) {
                tracing::warn!(target: "score", error = %e, "record_llm_call failed");
            }
        }
    }
}
```

Add to the `pub use types::{...}` re-export: `AgentCell, ModelCell, ModelSource, LlmUsage`.

- [ ] **Step 4: Run test**

```
cargo test -p karl-score --test llm_calls
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/store.rs crates/score/src/types.rs crates/score/src/lib.rs crates/score/tests/llm_calls.rs
git commit -m "feat(score): record_llm_call + breakdown_models"
```

---

## Task 6: `breakdown_agents` query + Summary token/spec totals

**Files:**
- Modify: `crates/score/src/store.rs`
- Modify: `crates/score/src/types.rs:27-35` (Summary)
- Test: `crates/score/tests/breakdown.rs`

- [ ] **Step 1: Write the failing test**

Append to `crates/score/tests/breakdown.rs`:

```rust
#[test]
fn breakdown_agents_ranks_by_prompt_count() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    karl_score::record_prompt_with_agent("anthropic", Some("claude_code"));
    karl_score::record_prompt_with_agent("anthropic", Some("claude_code"));
    karl_score::record_prompt_with_agent("anthropic", Some("codex"));
    karl_score::record_prompt_with_agent("anthropic", None);

    let cells = store.breakdown_agents(&karl_score::ScoreFilter::default()).unwrap();
    assert_eq!(cells[0].agent, "claude_code");
    assert_eq!(cells[0].prompts, 2);
    assert_eq!(cells[1].agent, "codex");
    assert_eq!(cells[1].prompts, 1);
    // None is collapsed under "shell"
    assert!(cells.iter().any(|c| c.agent == "shell" && c.prompts == 1));
    karl_score::clear_recorder_for_test();
}

#[test]
fn summary_includes_tokens_and_specs() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    karl_score::record_llm_call(karl_score::ModelSource::Internal, None, "anthropic", "m",
        karl_score::LlmUsage { input: 10, output: 5, cache_read: 0, cache_creation: 0 },
        &karl_score::Context::default());
    karl_score::record_spec("/x/y.md", &karl_score::Context::default());

    let s = store.summary_filtered(&karl_score::ScoreFilter::default()).unwrap();
    assert_eq!(s.total_tokens, 15);
    assert_eq!(s.total_specs, 1);
    karl_score::clear_recorder_for_test();
}
```

- [ ] **Step 2: Run tests to verify they fail**

```
cargo test -p karl-score --test breakdown
```

Expected: FAIL (`breakdown_agents` missing, `Summary.total_tokens` missing).

- [ ] **Step 3: Implement**

In `crates/score/src/types.rs`, extend `Summary`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub total_prompts: u64,
    pub total_commits: u64,
    pub today_prompts: u32,
    pub today_commits: u32,
    pub current_streak: u32,
    pub longest_streak: u32,
    #[serde(default)] pub total_tokens: u64,
    #[serde(default)] pub total_specs: u32,
}
```

Update both `summary` and `summary_filtered` in `crates/score/src/store.rs` to populate `total_tokens` and `total_specs`. Add the following queries right before the final `Ok(Summary { ... })` in each function:

```rust
let (total_tokens, total_specs) = {
    let c = self.conn.lock().unwrap();
    let tok: i64 = c.query_row(
        "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM llm_calls",
        [], |r| r.get(0))?;
    let sp: i64 = c.query_row("SELECT COUNT(*) FROM specs", [], |r| r.get(0))?;
    (tok as u64, sp as u32)
};
```

For `summary_filtered`, build a WHERE clause without `agent` and apply it:

```rust
let mut fcopy = f.clone(); fcopy.agent = None;
let w = crate::filter::build_where(&fcopy);
let tokens_sql = format!(
    "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM llm_calls WHERE {}",
    w.sql
);
let specs_sql = format!("SELECT COUNT(*) FROM specs WHERE {}", w.sql);
let (total_tokens, total_specs) = {
    let c = self.conn.lock().unwrap();
    let tok: i64 = c.query_row(&tokens_sql, rusqlite::params_from_iter(w.params.iter()), |r| r.get(0))?;
    let sp: i64 = c.query_row(&specs_sql, rusqlite::params_from_iter(w.params.iter()), |r| r.get(0))?;
    (tok as u64, sp as u32)
};
```

Add the two new fields to the `Summary { ... }` literal in both functions.

Now add `breakdown_agents` to `impl ScoreStore`:

```rust
pub fn breakdown_agents(&self, f: &crate::ScoreFilter) -> Result<Vec<crate::AgentCell>> {
    let w = crate::filter::build_where(f);
    let sql = format!(
        "SELECT COALESCE(agent, 'shell') AS a, COUNT(*)
         FROM score_events
         WHERE kind = 'prompt' AND {}
         GROUP BY a
         ORDER BY 2 DESC",
        w.sql
    );
    let c = self.conn.lock().unwrap();
    let mut stmt = c.prepare(&sql)?;
    let raw: Vec<(String, u32)> = stmt
        .query_map(rusqlite::params_from_iter(w.params.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let total: u32 = raw.iter().map(|(_, n)| *n).sum();
    Ok(raw.into_iter().map(|(agent, prompts)| crate::AgentCell {
        agent,
        prompts,
        share: if total == 0 { 0.0 } else { prompts as f32 / total as f32 },
    }).collect())
}
```

- [ ] **Step 4: Run tests**

```
cargo test -p karl-score
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/store.rs crates/score/src/types.rs crates/score/tests/breakdown.rs
git commit -m "feat(score): breakdown_agents + Summary.total_tokens/total_specs"
```

---

## Task 7: Spec filesystem watcher

**Files:**
- Create: `crates/score/src/spec_watcher.rs`
- Modify: `crates/score/src/lib.rs` (`pub mod spec_watcher;`)
- Modify: `crates/score/Cargo.toml` (add `notify = "6"`)
- Test: `crates/score/tests/spec_watcher.rs` (new)

- [ ] **Step 1: Add dep**

In `crates/score/Cargo.toml` under `[dependencies]`:

```toml
notify = { version = "6", default-features = false, features = ["macos_kqueue"] }
walkdir = "2"
```

(On Linux `macos_kqueue` is unused; keep default features off to avoid pulling fsevents-sys unless needed. Replace with `notify = "6"` if simpler in this codebase — match what `Cargo.lock` already has.)

- [ ] **Step 2: Write the failing test**

Create `crates/score/tests/spec_watcher.rs`:

```rust
use std::time::Duration;

#[test]
fn watcher_records_new_spec_file() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    let workspace = tempfile::tempdir().unwrap();
    let specs_dir = workspace.path().join("docs").join("specs");
    std::fs::create_dir_all(&specs_dir).unwrap();

    let (handle, _stop) = karl_score::spec_watcher::start(vec![workspace.path().to_path_buf()]);
    std::thread::sleep(Duration::from_millis(200));

    let file = specs_dir.join("foo.md");
    std::fs::write(&file, "# spec").unwrap();
    std::thread::sleep(Duration::from_millis(800)); // > debounce

    let br = store.breakdown_specs(&karl_score::ScoreFilter::default()).unwrap();
    assert_eq!(br.total, 1, "expected 1 spec, got breakdown {br:?}");
    drop(handle);
    karl_score::clear_recorder_for_test();
}
```

- [ ] **Step 3: Run test to verify it fails**

```
cargo test -p karl-score --test spec_watcher
```

Expected: FAIL (module missing).

- [ ] **Step 4: Implement watcher**

Create `crates/score/src/spec_watcher.rs`:

```rust
//! Filesystem watcher that records newly emitted spec files into the score store.
//!
//! Match rule: a path is a "spec" if it lives under a `**/specs/**` directory
//! (case-sensitive) and ends in `.md`.

use crate::Context;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub struct WatcherHandle {
    _watcher: RecommendedWatcher,
    _thread: JoinHandle<()>,
}

pub fn start(roots: Vec<PathBuf>) -> (WatcherHandle, mpsc::Sender<()>) {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let mut watcher: RecommendedWatcher = notify::recommended_watcher(tx).expect("watcher");
    for r in &roots {
        let _ = watcher.watch(r, RecursiveMode::Recursive);
    }

    let thread = std::thread::spawn(move || {
        let mut last_seen: std::collections::HashMap<PathBuf, Instant> = Default::default();
        let debounce = Duration::from_millis(500);
        loop {
            if stop_rx.try_recv().is_ok() { break; }
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(Ok(ev)) => handle_event(ev, &mut last_seen, debounce),
                Ok(Err(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    (WatcherHandle { _watcher: watcher, _thread: thread }, stop_tx)
}

fn handle_event(ev: Event, seen: &mut std::collections::HashMap<PathBuf, Instant>, debounce: Duration) {
    let is_create = matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_));
    if !is_create { return; }
    for path in ev.paths {
        if !is_spec_path(&path) { continue; }
        let now = Instant::now();
        if let Some(prev) = seen.get(&path) {
            if now.duration_since(*prev) < debounce { continue; }
        }
        seen.insert(path.clone(), now);
        let path_s = path.to_string_lossy().to_string();
        let ctx = derive_context(&path);
        crate::record_spec(&path_s, &ctx);
    }
}

fn is_spec_path(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("md")
        && p.components().any(|c| c.as_os_str() == "specs")
}

fn derive_context(p: &Path) -> Context {
    // Walk up until we find a `.git` sibling; treat that dir's name as the repo.
    let mut cur = p.parent();
    while let Some(d) = cur {
        if d.join(".git").exists() {
            return Context {
                repo: d.file_name().and_then(|s| s.to_str()).map(String::from),
                branch: None,
                group_name: None,
            };
        }
        cur = d.parent();
    }
    Context::default()
}

#[cfg(test)]
mod unit {
    use super::*;
    #[test]
    fn is_spec_recognizes_specs_dir() {
        assert!(is_spec_path(Path::new("/x/docs/specs/foo.md")));
        assert!(!is_spec_path(Path::new("/x/docs/foo.md")));
        assert!(!is_spec_path(Path::new("/x/specs/foo.txt")));
    }
}
```

Add `pub mod spec_watcher;` to `crates/score/src/lib.rs`.

- [ ] **Step 5: Run tests**

```
cargo test -p karl-score
```

Expected: PASS (including the integration test from Step 2).

- [ ] **Step 6: Commit**

```bash
git add crates/score/src/spec_watcher.rs crates/score/src/lib.rs crates/score/Cargo.toml crates/score/tests/spec_watcher.rs
git commit -m "feat(score): notify-based spec watcher"
```

---

## Task 8: External pollers — Claude Code

**Files:**
- Create: `crates/score/src/external/mod.rs`
- Create: `crates/score/src/external/claude_code.rs`
- Modify: `crates/score/src/lib.rs` (`pub mod external;`)
- Test: `crates/score/tests/external_claude_code.rs` (new)

- [ ] **Step 1: Write the failing test**

Create `crates/score/tests/external_claude_code.rs`:

```rust
use std::io::Write;

#[test]
fn claude_code_parser_records_usage_with_watermark() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    let jsonl_dir = tempfile::tempdir().unwrap();
    let jsonl = jsonl_dir.path().join("session.jsonl");
    {
        let mut f = std::fs::File::create(&jsonl).unwrap();
        writeln!(f, r#"{{"message":{{"model":"claude-opus-4-7","usage":{{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":0}}}}}}"#).unwrap();
        writeln!(f, r#"{{"message":{{"model":"claude-opus-4-7","usage":{{"input_tokens":40,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#).unwrap();
    }

    karl_score::external::claude_code::poll_one(&store, &jsonl).unwrap();
    let m = store.breakdown_models(&karl_score::ScoreFilter::default(), karl_score::ModelSource::External).unwrap();
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].calls, 2);
    assert_eq!(m[0].input_tokens, 140);

    // Re-poll: watermark prevents double-counting.
    karl_score::external::claude_code::poll_one(&store, &jsonl).unwrap();
    let m2 = store.breakdown_models(&karl_score::ScoreFilter::default(), karl_score::ModelSource::External).unwrap();
    assert_eq!(m2[0].calls, 2, "watermark should prevent re-parsing");
    karl_score::clear_recorder_for_test();
}
```

- [ ] **Step 2: Run test to verify it fails**

```
cargo test -p karl-score --test external_claude_code
```

Expected: FAIL.

- [ ] **Step 3: Implement watermark API + parser**

Add to `crates/score/src/store.rs` (impl ScoreStore):

```rust
pub fn get_watermark(&self, source: &str, path: &str) -> Result<u64> {
    let c = self.conn.lock().unwrap();
    let off: Option<i64> = c.query_row(
        "SELECT byte_offset FROM external_watermarks WHERE source = ?1 AND path = ?2",
        params![source, path], |r| r.get(0)
    ).optional()?;
    Ok(off.unwrap_or(0) as u64)
}

pub fn set_watermark(&self, source: &str, path: &str, byte_offset: u64) -> Result<()> {
    let c = self.conn.lock().unwrap();
    c.execute(
        "INSERT INTO external_watermarks(source, path, byte_offset) VALUES (?1, ?2, ?3)
         ON CONFLICT(source, path) DO UPDATE SET byte_offset = excluded.byte_offset",
        params![source, path, byte_offset as i64],
    )?;
    Ok(())
}
```

Create `crates/score/src/external/mod.rs`:

```rust
pub mod claude_code;
pub mod codex;
pub mod opencode;
pub mod pi;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub struct PollerHandle { _thread: std::thread::JoinHandle<()> }

pub fn start(store: Arc<crate::ScoreStore>) -> PollerHandle {
    let thread = std::thread::spawn(move || loop {
        for p in claude_code::candidate_files() { let _ = claude_code::poll_one(&store, &p); }
        for p in codex::candidate_files()       { let _ = codex::poll_one(&store, &p); }
        for p in opencode::candidate_files()    { let _ = opencode::poll_one(&store, &p); }
        for p in pi::candidate_files()          { let _ = pi::poll_one(&store, &p); }
        std::thread::sleep(Duration::from_secs(30));
    });
    PollerHandle { _thread: thread }
}

#[allow(dead_code)]
pub fn home() -> Option<PathBuf> { dirs::home_dir() }
```

Create `crates/score/src/external/claude_code.rs`:

```rust
use crate::{Context, LlmUsage, ModelSource, ScoreStore};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const SOURCE: &str = "claude_code";

#[derive(Deserialize)]
struct Line { message: Option<Msg> }
#[derive(Deserialize)]
struct Msg { model: Option<String>, usage: Option<Usage> }
#[derive(Deserialize)]
struct Usage {
    #[serde(default)] input_tokens: u64,
    #[serde(default)] output_tokens: u64,
    #[serde(default)] cache_read_input_tokens: u64,
    #[serde(default)] cache_creation_input_tokens: u64,
}

pub fn candidate_files() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return vec![]; };
    let mut out = vec![];
    let root = home.join(".claude").join("projects");
    if let Ok(it) = walkdir::WalkDir::new(&root).into_iter().filter_map(Result::ok).collect::<Vec<_>>().into_iter().map(Ok::<_, ()>).collect::<Result<Vec<_>, _>>() {
        for entry in it {
            if entry.path().extension().and_then(|e| e.to_str()) == Some("jsonl") {
                out.push(entry.path().to_path_buf());
            }
        }
    }
    out
}

pub fn poll_one(store: &ScoreStore, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let path_s = path.to_string_lossy().to_string();
    let watermark = store.get_watermark(SOURCE, &path_s)?;
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    if size <= watermark { return Ok(()); }
    file.seek(SeekFrom::Start(watermark))?;
    let reader = BufReader::new(&mut file);

    let ctx = Context::default();
    let mut new_offset = watermark;
    for line in reader.lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        new_offset += line.len() as u64 + 1; // newline
        let parsed: Line = match serde_json::from_str(&line) { Ok(v) => v, Err(_) => continue };
        let Some(msg) = parsed.message else { continue };
        let Some(usage) = msg.usage else { continue };
        let model = msg.model.unwrap_or_else(|| "unknown".into());
        store.append_llm_call(
            chrono::Utc::now().timestamp_millis(),
            ModelSource::External,
            Some("claude_code"),
            "anthropic",
            &model,
            LlmUsage {
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_read: usage.cache_read_input_tokens,
                cache_creation: usage.cache_creation_input_tokens,
            },
            &ctx,
        )?;
    }
    store.set_watermark(SOURCE, &path_s, new_offset)?;
    Ok(())
}
```

Add `pub mod external;` to `crates/score/src/lib.rs`. Add `dirs = "5"` to `crates/score/Cargo.toml` if not present.

- [ ] **Step 4: Run test**

```
cargo test -p karl-score --test external_claude_code
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/external crates/score/src/store.rs crates/score/src/lib.rs crates/score/Cargo.toml crates/score/tests/external_claude_code.rs
git commit -m "feat(score): external poller — Claude Code JSONL"
```

---

## Task 9: External pollers — Codex + opencode/pi stubs

**Files:**
- Create: `crates/score/src/external/codex.rs`
- Create: `crates/score/src/external/opencode.rs`
- Create: `crates/score/src/external/pi.rs`
- Test: `crates/score/tests/external_codex.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/score/tests/external_codex.rs`:

```rust
use std::io::Write;

#[test]
fn codex_parser_records_usage() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    let dir = tempfile::tempdir().unwrap();
    let jsonl = dir.path().join("rollout-x.jsonl");
    let mut f = std::fs::File::create(&jsonl).unwrap();
    writeln!(f, r#"{{"model":"gpt-5","usage":{{"prompt_tokens":80,"completion_tokens":40}}}}"#).unwrap();

    karl_score::external::codex::poll_one(&store, &jsonl).unwrap();
    let m = store.breakdown_models(&karl_score::ScoreFilter::default(), karl_score::ModelSource::External).unwrap();
    assert_eq!(m[0].model, "gpt-5");
    assert_eq!(m[0].input_tokens, 80);
    assert_eq!(m[0].output_tokens, 40);
    karl_score::clear_recorder_for_test();
}
```

- [ ] **Step 2: Run test to verify it fails**

```
cargo test -p karl-score --test external_codex
```

Expected: FAIL.

- [ ] **Step 3: Implement codex parser**

Create `crates/score/src/external/codex.rs`:

```rust
use crate::{Context, LlmUsage, ModelSource, ScoreStore};
use serde::Deserialize;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const SOURCE: &str = "codex";

#[derive(Deserialize)]
struct Line { model: Option<String>, usage: Option<Usage> }
#[derive(Deserialize)]
struct Usage {
    #[serde(default)] prompt_tokens: u64,
    #[serde(default)] completion_tokens: u64,
}

pub fn candidate_files() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else { return vec![]; };
    let root = home.join(".codex").join("sessions");
    walkdir::WalkDir::new(&root).into_iter().filter_map(Result::ok)
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
        .map(|e| e.path().to_path_buf())
        .collect()
}

pub fn poll_one(store: &ScoreStore, path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let path_s = path.to_string_lossy().to_string();
    let watermark = store.get_watermark(SOURCE, &path_s)?;
    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    if size <= watermark { return Ok(()); }
    file.seek(SeekFrom::Start(watermark))?;
    let reader = BufReader::new(&mut file);

    let ctx = Context::default();
    let mut new_offset = watermark;
    for line in reader.lines() {
        let line = match line { Ok(l) => l, Err(_) => break };
        new_offset += line.len() as u64 + 1;
        let Ok(parsed) = serde_json::from_str::<Line>(&line) else { continue };
        let Some(usage) = parsed.usage else { continue };
        let model = parsed.model.unwrap_or_else(|| "unknown".into());
        store.append_llm_call(
            chrono::Utc::now().timestamp_millis(),
            ModelSource::External, Some("codex"), "openai", &model,
            LlmUsage { input: usage.prompt_tokens, output: usage.completion_tokens, cache_read: 0, cache_creation: 0 },
            &ctx,
        )?;
    }
    store.set_watermark(SOURCE, &path_s, new_offset)?;
    Ok(())
}
```

Create `crates/score/src/external/opencode.rs`:

```rust
use crate::ScoreStore;
use std::path::{Path, PathBuf};

pub fn candidate_files() -> Vec<PathBuf> { vec![] } // best-effort stub
pub fn poll_one(_store: &ScoreStore, _path: &Path) -> Result<(), Box<dyn std::error::Error>> { Ok(()) }
```

Create `crates/score/src/external/pi.rs` with identical stub content (replace `opencode` with `pi` in any comments).

- [ ] **Step 4: Run test**

```
cargo test -p karl-score --test external_codex
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/external/codex.rs crates/score/src/external/opencode.rs crates/score/src/external/pi.rs crates/score/tests/external_codex.rs
git commit -m "feat(score): external pollers — codex + opencode/pi stubs"
```

---

## Task 10: Sync — include new tables

**Files:**
- Modify: `crates/score/src/sync.rs`
- Test: `crates/score/tests/sync_payload.rs` (new — black-box, no server)

- [ ] **Step 1: Write the failing test**

Create `crates/score/tests/sync_payload.rs`:

```rust
#[test]
fn sync_payload_includes_new_tables() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    karl_score::record_spec("/x/a.md", &karl_score::Context::default());
    karl_score::record_llm_call(karl_score::ModelSource::Internal, None, "anthropic", "m",
        karl_score::LlmUsage{input:1,output:1,cache_read:0,cache_creation:0}, &karl_score::Context::default());

    let payload = karl_score::sync::build_payload(&store, 0, 100).unwrap();
    let json = serde_json::to_string(&payload).unwrap();
    assert!(json.contains("\"specs\""), "payload missing specs: {json}");
    assert!(json.contains("\"llm_calls\""), "payload missing llm_calls: {json}");
    karl_score::clear_recorder_for_test();
}
```

- [ ] **Step 2: Run test to verify it fails**

```
cargo test -p karl-score --test sync_payload
```

Expected: FAIL (`build_payload` shape doesn't include new tables, or function isn't public yet).

- [ ] **Step 3: Implement**

Read the current `crates/score/src/sync.rs` to find the existing payload struct (likely something like `PushPayload { events: Vec<...> }`). Add two fields:

```rust
#[derive(Serialize)]
pub struct PushPayload {
    pub events: Vec<ScoreEvent>,
    #[serde(default)] pub specs: Vec<SpecPushRow>,
    #[serde(default)] pub llm_calls: Vec<LlmCallPushRow>,
}

#[derive(Serialize)]
pub struct SpecPushRow { pub ts_ms: i64, pub path: String, pub repo: Option<String>, pub branch: Option<String>, pub group_name: Option<String> }

#[derive(Serialize)]
pub struct LlmCallPushRow {
    pub ts_ms: i64, pub source: String, pub agent: Option<String>,
    pub provider: String, pub model: String,
    pub input_tokens: i64, pub output_tokens: i64,
    pub cache_read: i64, pub cache_creation: i64,
    pub repo: Option<String>, pub branch: Option<String>, pub group_name: Option<String>,
}
```

Add `pub fn build_payload(store: &ScoreStore, after_id: i64, limit: usize) -> Result<PushPayload>` (extract from the existing `push_once` if needed), querying `specs` and `llm_calls` for unsynced rows. Track separate sync cursors per table in `sync_cursor` (add columns `last_pushed_spec_id`, `last_pushed_llm_id` via a v4 migration inside this same task; default 0).

Migration (add to `store.rs` after v3 block):

```rust
if v < 4 {
    conn.execute_batch(
        "ALTER TABLE sync_cursor ADD COLUMN last_pushed_spec_id INTEGER NOT NULL DEFAULT 0;
         ALTER TABLE sync_cursor ADD COLUMN last_pushed_llm_id  INTEGER NOT NULL DEFAULT 0;
         PRAGMA user_version = 4;",
    )?;
}
```

Update `push_once` to consume `build_payload` and advance both new cursors on success.

- [ ] **Step 4: Run tests**

```
cargo test -p karl-score
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/sync.rs crates/score/src/store.rs crates/score/tests/sync_payload.rs
git commit -m "feat(score): include specs+llm_calls in sync payload"
```

---

## Task 11: Wire internal LLM emissions in providers

**Files:**
- Modify: `crates/agent/src/provider/anthropic.rs`
- Modify: `crates/agent/src/provider/openai_compat.rs`
- Test: extend `crates/agent/tests/provider_anthropic.rs`

- [ ] **Step 1: Write the failing test**

Append to `crates/agent/tests/provider_anthropic.rs`:

```rust
#[tokio::test]
async fn anthropic_provider_records_internal_llm_call() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    // Spin up a stub HTTP server that returns a canned Messages API response
    // with usage.input_tokens=42, output_tokens=7. Existing tests in this file
    // already use wiremock or similar — reuse that fixture pattern.
    let server = stub_anthropic_server(/* usage */ 42, 7).await;
    let provider = anthropic::Provider::new_with_base_url(server.url(), "test-key".into());
    let _ = provider.respond("claude-opus-4-7", "hi").await.unwrap();

    let m = store.breakdown_models(&karl_score::ScoreFilter::default(), karl_score::ModelSource::Internal).unwrap();
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].input_tokens, 42);
    assert_eq!(m[0].output_tokens, 7);
    karl_score::clear_recorder_for_test();
}
```

> If the existing test file does not already use a stub server, copy the existing test's setup verbatim and adapt — do NOT introduce a new HTTP stub library.

- [ ] **Step 2: Run test to verify it fails**

```
cargo test -p karl-agent anthropic_provider_records_internal_llm_call
```

Expected: FAIL.

- [ ] **Step 3: Implement emission**

In `crates/agent/src/provider/anthropic.rs`, locate the function that parses the response (search for `usage` or `input_tokens`). After successful parse, add:

```rust
karl_score::record_llm_call(
    karl_score::ModelSource::Internal,
    None,
    "anthropic",
    &model,
    karl_score::LlmUsage {
        input: response.usage.input_tokens as u64,
        output: response.usage.output_tokens as u64,
        cache_read: response.usage.cache_read_input_tokens.unwrap_or(0) as u64,
        cache_creation: response.usage.cache_creation_input_tokens.unwrap_or(0) as u64,
    },
    &karl_score::Context::default(),
);
```

If `karl_score` is not in `crates/agent/Cargo.toml`, add it under `[dependencies]`:

```toml
karl-score = { path = "../score" }
```

Repeat for `crates/agent/src/provider/openai_compat.rs`, mapping `prompt_tokens` → input and `completion_tokens` → output, with `provider = "openai_compat"`.

- [ ] **Step 4: Run tests**

```
cargo test -p karl-agent
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/agent crates/score
git commit -m "feat(agent): emit internal record_llm_call from providers"
```

---

## Task 12: Wire `agent` label into `record_prompt` call sites

**Files:**
- Modify: `crates/app/src/operator.rs` (or wherever `karl_score::record_prompt` is called)
- Modify: `crates/app/src/spec_author.rs` (call `record_spec` on finalize)

- [ ] **Step 1: Locate call sites**

Run:

```
grep -rn "record_prompt\|record_prompt_with_context" crates/app/src/
```

For each call site:

- [ ] **Step 2: Resolve agent label per call**

At each site, before calling `record_prompt_with_agent`, look up the focused tab's foreground process (the codebase already has a `fg_proc` helper for the notch — search for `fn fg_proc` or `foreground_proc`):

```rust
let agent = {
    let (comm, argv) = current_tab_fg_proc(); // returns (String, Vec<String>)
    let argv_refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    karl_score::agent_label::resolve(&comm, &argv_refs).map(String::from)
};
karl_score::record_prompt_with_agent(executor_name, agent.as_deref());
```

If a call site cannot easily resolve the fg proc (e.g. background spec-author call), pass `Some("internal")`.

- [ ] **Step 3: Wire spec_author finalize**

In `crates/app/src/spec_author.rs`, find where the spec file is written to disk (search for `fs::write` or `write_all` on a `.md` path). After a successful write, call:

```rust
karl_score::record_spec(
    &spec_path.to_string_lossy(),
    &karl_score::Context { repo: current_repo(), branch: current_branch(), group_name: None },
);
```

- [ ] **Step 4: Build**

```
cargo build --workspace
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator.rs crates/app/src/spec_author.rs
git commit -m "feat(app): stamp agent label on prompts; spec_author records spec"
```

---

## Task 13: New Tauri commands + watcher/poller boot

**Files:**
- Modify: `crates/app/src/score_commands.rs`
- Modify: `crates/app/src/lib.rs`

- [ ] **Step 1: Add commands**

Append to `crates/app/src/score_commands.rs`:

```rust
use karl_score::{AgentCell, ModelCell, ModelSource, ScoreFilter, ScoreState, SpecBreakdown};

#[tauri::command]
pub fn score_breakdown_agents(
    state: tauri::State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<Vec<AgentCell>, String> {
    state.0.breakdown_agents(&filter).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_breakdown_specs(
    state: tauri::State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<SpecBreakdown, String> {
    state.0.breakdown_specs(&filter).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_breakdown_models(
    state: tauri::State<'_, ScoreState>,
    filter: ScoreFilter,
    source: ModelSource,
) -> Result<Vec<ModelCell>, String> {
    state.0.breakdown_models(&filter, source).map_err(|e| e.to_string())
}
```

(Match the existing `ScoreState` import — if `ScoreState` is defined elsewhere in this file, reuse that path.)

- [ ] **Step 2: Register commands**

In `crates/app/src/lib.rs`, find the existing `score_commands::score_summary_filtered` registration (around the lines listed in the spec). Add the three new commands to the same `tauri::generate_handler![ ... ]` block:

```rust
score_commands::score_breakdown_agents,
score_commands::score_breakdown_specs,
score_commands::score_breakdown_models,
```

- [ ] **Step 3: Boot spec watcher and external pollers**

In `crates/app/src/lib.rs`, find the block that already calls `karl_score::set_recorder(score_store.clone());` and starts `commit_scanner::scan_repo_since`. Append:

```rust
// Spec watcher — roots = currently tracked workspaces.
let workspace_roots: Vec<std::path::PathBuf> = workspaces_for_watch(); // existing helper, or pass an empty Vec for v0
let (_spec_watcher, _stop) = karl_score::spec_watcher::start(workspace_roots);
std::mem::forget(_spec_watcher); // lifetime = app lifetime

// External LLM-usage pollers.
let _pollers = karl_score::external::start(score_store.clone());
std::mem::forget(_pollers);
```

If `workspaces_for_watch` does not yet exist, pass a `vec![]` for v0 — settings can later expose a configurable list of roots. Note this as a known follow-up.

- [ ] **Step 4: Build + smoke**

```
cargo build --workspace
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/score_commands.rs crates/app/src/lib.rs
git commit -m "feat(app): register new score commands; boot watcher + pollers"
```

---

## Task 14: UI types + API wrappers

**Files:**
- Modify: `ui/src/score/api.ts`
- Modify: `ui/src/api.ts` (only if it re-exports score commands)

- [ ] **Step 1: Add types and wrappers**

Append to `ui/src/score/api.ts`:

```ts
export type AgentCell  = { agent: string; prompts: number; share: number };
export type SpecRow    = { ts_ms: number; path: string; repo: string | null };
export type SpecBreakdown = { total: number; recent: SpecRow[] };
export type ModelSource = "internal" | "external";
export type ModelCell  = {
  source: ModelSource;
  agent: string | null;
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
};
```

Extend `Summary`:

```ts
export type Summary = {
  total_prompts: number;
  total_commits: number;
  today_prompts: number;
  today_commits: number;
  current_streak: number;
  longest_streak: number;
  total_tokens: number;
  total_specs: number;
};
```

Extend `ScoreFilter`:

```ts
export type ScoreFilter = {
  range: "all" | "last7d" | "last30d";
  repo?: string | null;
  branch?: string | null;
  group_name?: string | null;
  day?: string | null;
  agent?: string | null;
};
```

Add command wrappers (use the `invoke` import already present in this file):

```ts
export function scoreBreakdownAgents(filter: ScoreFilter): Promise<AgentCell[]> {
  return invoke("score_breakdown_agents", { filter });
}
export function scoreBreakdownSpecs(filter: ScoreFilter): Promise<SpecBreakdown> {
  return invoke("score_breakdown_specs", { filter });
}
export function scoreBreakdownModels(filter: ScoreFilter, source: ModelSource): Promise<ModelCell[]> {
  return invoke("score_breakdown_models", { filter, source });
}
```

- [ ] **Step 2: Typecheck**

```
cd ui && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/score/api.ts
git commit -m "feat(ui): score api — agent/specs/models types + wrappers"
```

---

## Task 15: UI — agent card + total-tokens tile + filter chip

**Files:**
- Create: `ui/src/score/usage.ts`
- Modify: `ui/src/score/page.ts`
- Modify: `ui/src/score/styles.css`

- [ ] **Step 1: Add renderers in `usage.ts`**

Create `ui/src/score/usage.ts`:

```ts
import type { AgentCell, ModelCell, ModelSource, SpecBreakdown } from "./api";

const AGENT_COLORS: Record<string, string> = {
  claude_code: "#3fb950",
  codex:       "#f0883e",
  copilot:     "#a371f7",
  opencode:    "#f85149",
  pi:          "#39d0d8",
  internal:    "#d2a8ff",
  shell:       "#6e7681",
};

export function renderAgentBars(
  host: HTMLElement,
  cells: AgentCell[],
  onPick: (agent: string) => void,
): void {
  host.innerHTML = "";
  const max = Math.max(1, ...cells.map((c) => c.prompts));
  for (const c of cells) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "cov-row";
    const color = AGENT_COLORS[c.agent] ?? "#7d8590";
    row.innerHTML = `
      <span class="cov-dot" style="background:${color}"></span>
      <span class="cov-row-label">${c.agent}</span>
      <span class="cov-row-bar"><span style="width:${(c.prompts / max) * 100}%;background:${color}"></span></span>
      <span class="cov-row-val">${c.prompts}p · ${(c.share * 100).toFixed(0)}%</span>
    `;
    row.addEventListener("click", () => onPick(c.agent));
    host.appendChild(row);
  }
  if (cells.length === 0) {
    host.innerHTML = `<div class="cov-empty">No agent activity yet</div>`;
  }
}

export function renderSpecsCard(host: HTMLElement, br: SpecBreakdown): void {
  const items = br.recent.map((r) => {
    const name = r.path.split("/").pop() ?? r.path;
    const when = new Date(r.ts_ms).toLocaleDateString();
    return `<li><span class="cov-spec-name">${escapeHtml(name)}</span><span class="cov-spec-when">${when}</span></li>`;
  }).join("");
  host.innerHTML = `
    <div class="cov-specs-total">${br.total}</div>
    <div class="cov-specs-sub">specs created (current filter)</div>
    <ul class="cov-specs-list">${items}</ul>
  `;
}

export function renderModelsCard(
  host: HTMLElement,
  source: ModelSource,
  cells: ModelCell[],
  onToggle: (next: ModelSource) => void,
): void {
  const isExternal = source === "external";
  const rows = cells.map((c) => `
    <tr>
      ${isExternal ? `<td>${c.agent ?? "—"}</td>` : ""}
      <td><code>${escapeHtml(c.model)}</code></td>
      <td>${c.calls}</td>
      <td>${c.input_tokens.toLocaleString()}${c.cache_read ? ` <span class="cov-dim">(${c.cache_read.toLocaleString()} cache)</span>` : ""}</td>
      <td>${c.output_tokens.toLocaleString()}</td>
    </tr>
  `).join("");
  host.innerHTML = `
    <div class="cov-toggle">
      <button data-src="internal" class="${!isExternal ? "active" : ""}">Covenant</button>
      <button data-src="external" class="${isExternal ? "active" : ""}">External</button>
    </div>
    <table class="cov-model-table">
      <thead><tr>
        ${isExternal ? "<th>Agent</th>" : ""}
        <th>Model</th><th>Calls</th><th>Input</th><th>Output</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="5" class="cov-empty">No usage</td></tr>`}</tbody>
    </table>
  `;
  host.querySelectorAll<HTMLButtonElement>(".cov-toggle button").forEach((b) => {
    b.addEventListener("click", () => onToggle(b.dataset.src as ModelSource));
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
```

- [ ] **Step 2: Update `page.ts` template + wiring**

In `ui/src/score/page.ts`:

(a) Add to imports (top of file):

```ts
import { renderAgentBars, renderSpecsCard, renderModelsCard } from "./usage";
import type { ModelSource } from "./api";
```

(b) Replace `TEMPLATE` to include three new cards between the "By group" card and "Recent sessions":

```html
<div class="cov-card">
  <h4>By agent <span class="hint">click to filter</span></h4>
  <div data-role="agents"></div>
</div>
<div class="cov-two">
  <div class="cov-card">
    <h4>Specs created</h4>
    <div data-role="specs"></div>
  </div>
  <div class="cov-card">
    <h4>Token usage · per model</h4>
    <div data-role="models"></div>
  </div>
</div>
```

(c) Add a fifth stat tile in `renderStats`:

```ts
<div class="cov-stat">
  <div class="v">${summary.total_tokens.toLocaleString()}</div>
  <div class="l">Total tokens</div>
</div>
```

(d) Extend `refresh()` to load + render:

```ts
const [summary, heatmap, repos, groups, sessions, user, agents, specs] = await Promise.all([
  api.scoreSummaryFiltered(state.filter),
  api.scoreHeatmapFiltered(state.filter),
  api.scoreBreakdownRepos(state.filter),
  api.scoreBreakdownGroups(state.filter),
  api.scoreRecentSessions(10),
  getCurrentUser(),
  api.scoreBreakdownAgents(state.filter),
  api.scoreBreakdownSpecs(state.filter),
]);

const agentsHost = host.querySelector<HTMLElement>("[data-role=agents]")!;
const specsHost  = host.querySelector<HTMLElement>("[data-role=specs]")!;
const modelsHost = host.querySelector<HTMLElement>("[data-role=models]")!;

renderAgentBars(agentsHost, agents, (agent) => {
  state.filter.agent = agent;
  void refresh(host, state);
});
renderSpecsCard(specsHost, specs);

const modelSource: ModelSource = state.modelSource ?? "internal";
const models = await api.scoreBreakdownModels(state.filter, modelSource);
renderModelsCard(modelsHost, modelSource, models, (next) => {
  state.modelSource = next;
  void refresh(host, state);
});
```

(e) Extend `State`:

```ts
interface State {
  filter: ScoreFilter;
  mounted: boolean;
  modelSource?: ModelSource;
}
```

(f) Add an agent dismiss chip inside `renderFilters` (next to the existing repo/branch/day chips):

```ts
if (state.filter.agent) {
  host.appendChild(
    chipDismiss(`Agent: ${state.filter.agent}`, () => {
      state.filter.agent = null;
      void refresh(page, state);
    }),
  );
}
```

- [ ] **Step 3: Styles**

Append to `ui/src/score/styles.css`:

```css
.cov-row { display:grid; grid-template-columns: 12px 1fr 4fr auto; gap:8px; align-items:center;
  background:transparent; border:none; color:inherit; padding:6px 4px; cursor:pointer; width:100%; text-align:left; }
.cov-row:hover { background: rgba(255,255,255,0.04); border-radius:6px; }
.cov-dot { width:8px; height:8px; border-radius:50%; }
.cov-row-bar { background: rgba(255,255,255,0.05); height:8px; border-radius:4px; overflow:hidden; }
.cov-row-bar > span { display:block; height:100%; }
.cov-row-val { font-variant-numeric: tabular-nums; opacity:0.8; }

.cov-specs-total { font-size:36px; font-weight:600; }
.cov-specs-sub { opacity:0.7; margin-bottom:8px; }
.cov-specs-list { list-style:none; padding:0; margin:0; }
.cov-specs-list li { display:flex; justify-content:space-between; padding:4px 0; opacity:0.85; }
.cov-spec-when { opacity:0.6; }

.cov-toggle { display:inline-flex; border:1px solid rgba(255,255,255,0.12); border-radius:999px; overflow:hidden; margin-bottom:8px; }
.cov-toggle button { background:transparent; color:inherit; padding:4px 12px; border:none; cursor:pointer; }
.cov-toggle button.active { background: rgba(255,255,255,0.10); }
.cov-model-table { width:100%; border-collapse:collapse; }
.cov-model-table th, .cov-model-table td { padding:6px 8px; text-align:left; border-bottom:1px solid rgba(255,255,255,0.06); font-variant-numeric: tabular-nums; }
.cov-dim { opacity:0.5; }
```

- [ ] **Step 4: Build the UI**

```
cd ui && npm run build
```

Expected: build succeeds.

- [ ] **Step 5: Manual smoke**

Per CLAUDE.md, for UI changes: start the dev server and click through.

```
cargo tauri dev
```

Open Settings → Covenant. Confirm:
- New "Total tokens" tile in the top row.
- "By agent" card renders bars (may be empty on first run).
- "Specs created" tile shows 0 (then non-zero after touching a spec).
- "Token usage" toggles between Covenant / External.
- Clicking an agent bar adds a dismissable filter chip.

- [ ] **Step 6: Commit**

```bash
git add ui/src/score/usage.ts ui/src/score/page.ts ui/src/score/styles.css
git commit -m "feat(ui): covenant — by-agent card, specs card, token usage card"
```

---

## Task 16: Final verification

- [ ] **Step 1: Run full workspace tests**

```
cargo test --workspace
```

Expected: all green.

- [ ] **Step 2: UI typecheck + build**

```
cd ui && npx tsc --noEmit && npm run build
```

Expected: both succeed.

- [ ] **Step 3: Sanity dev-run**

Run `cargo tauri dev`. Open the Covenant tab. Confirm all five stat tiles, the three new cards, and that filter chips (repo/agent/range/day) reflow all cards consistently.

- [ ] **Step 4: Spec coverage review**

Re-read the spec at `docs/superpowers/specs/2026-05-18-covenant-metrics-design.md`. For each section confirm one or more tasks above covered it. Note any gap; if found, write a follow-up task before closing.

- [ ] **Step 5: Final commit (only if anything changed)**

```bash
git status
# if clean: nothing to commit, plan done.
```

---

## Self-review notes (writer)

- Every section of the spec maps to ≥1 task: schema → T1; agent label → T2/T3; specs storage → T4; tokens storage → T5; agent breakdown + summary totals → T6; watcher → T7; external pollers → T8/T9; sync → T10; internal emission → T11; call-site wiring → T12; commands + boot → T13; UI types → T14; UI cards → T15; verification → T16.
- Type names are consistent: `AgentCell`, `SpecRow`/`SpecBreakdown`, `ModelCell`/`ModelSource`/`LlmUsage` defined once, referenced verbatim downstream.
- No placeholders. Where the codebase has a helper whose exact name we don't know (`fg_proc`, `current_repo`), the plan tells the engineer how to find it (grep) rather than asserting a name.
- One known soft spot: Task 13 assumes a `workspaces_for_watch()` helper. If absent, the fallback (empty Vec) keeps the feature degraded but compiling. Spec-author records still fire so the specs card works even without the watcher.
