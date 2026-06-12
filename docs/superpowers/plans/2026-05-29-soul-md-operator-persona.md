# SOUL.md — Operator Persona as a Living Document — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the operator `persona` textarea (a DB string) with a real `SOUL.md` file per operator — YAML frontmatter (machine config) + Origin-Letter markdown body (the soul) — authored via an archetype gallery + split editor, hot-reloaded from disk, with the file as the source of truth.

**Architecture:** `SOUL.md` files live at `<app_config_dir>/operators/<slug>/SOUL.md`. The `Operator` struct keeps its flat field surface (so the ~12 read sites across `operator.rs`, `teammate/llm.rs`, `telegram/outbound.rs`, `to_session_ref` are untouched), but those fields are *hydrated from the file* on load and hot-reload. `create`/`update` write the file first; the DB row keeps a denormalized cache + runtime state (`id`, `soul_path`, `xp`, `is_default`, timestamps). `hard_constraints` stays a structured frontmatter field (its lines still compile into per-operator deny regexes at `operator.rs:1890`). Safety blocklist in `crates/agent/src/safety.rs` is untouched.

**Tech Stack:** Rust (Tauri 2, tokio, rusqlite, `serde_yaml`), TypeScript (Vite, `marked` for preview). Spec: `docs/superpowers/specs/2026-05-29-soul-md-operator-persona-design.md`.

**Phases (each backend phase is independently shippable/testable):**
- A. SOUL parse/serialize module (`soul.rs`)
- B. `Operator` gains `soul_path`; storage schema + methods
- C. Registry: write-on-create/update, hydrate-on-load, migration
- D. Hot-reload souls in the operator tick
- E. Archetype assets + Tauri commands + api.ts wrappers
- F. UI: archetype gallery + split editor

---

## Phase A — SOUL parse/serialize module

### Task 1: Add `serde_yaml` dependency

**Files:**
- Modify: `crates/app/Cargo.toml`

- [ ] **Step 1: Add the dependency**

In `crates/app/Cargo.toml`, under `[dependencies]`, add:

```toml
serde_yaml = "0.9"
```

- [ ] **Step 2: Verify it resolves**

Run: `cargo build -p app 2>&1 | tail -5`
Expected: builds (or fails only on pre-existing unrelated errors); `serde_yaml` downloads without error.

- [ ] **Step 3: Commit**

```bash
git add crates/app/Cargo.toml Cargo.lock
git commit -m "chore(app): add serde_yaml for SOUL.md frontmatter"
```

---

### Task 2: `soul.rs` — frontmatter + body types

**Files:**
- Create: `crates/app/src/soul.rs`
- Modify: `crates/app/src/lib.rs` (add `mod soul;`)

- [ ] **Step 1: Write the failing test**

Create `crates/app/src/soul.rs`:

```rust
//! SOUL.md: an operator's identity as a real document. YAML frontmatter
//! (machine config) + Origin-Letter markdown body (the soul). The file is
//! the source of truth; `Operator` fields are hydrated from it on load and
//! hot-reload. See docs/superpowers/specs/2026-05-29-soul-md-operator-persona-design.md.

use serde::{Deserialize, Serialize};

/// Parsed frontmatter. Every field except `name` is optional; missing fields
/// fall back to documented defaults when projected onto an `Operator`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SoulFrontmatter {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// "terse" | "warm" | "formal" (case-insensitive); defaults to terse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escalate_threshold: Option<f32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Structured deny lines — each non-empty line compiles to a per-operator
    /// deny regex (operator.rs:1890). NOT prose. Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hard_constraints: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Soul {
    pub frontmatter: SoulFrontmatter,
    pub body: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SoulError {
    #[error("missing or malformed frontmatter (need a leading `---` block)")]
    NoFrontmatter,
    #[error("frontmatter is not valid YAML: {0}")]
    Yaml(String),
    #[error("name must be 1..=64 non-whitespace characters")]
    InvalidName,
    #[error("escalate_threshold must be in 0.0..=1.0")]
    InvalidThreshold,
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nname: Atlas\ncolor: \"#c4a7ff\"\nvoice: warm\nescalate_threshold: 0.55\ntags:\n- deploys\n---\n\n# Atlas\n\nI was made to wait.\n";

    #[test]
    fn parses_frontmatter_and_body() {
        let s = parse(SAMPLE).expect("parse");
        assert_eq!(s.frontmatter.name, "Atlas");
        assert_eq!(s.frontmatter.color.as_deref(), Some("#c4a7ff"));
        assert_eq!(s.frontmatter.voice.as_deref(), Some("warm"));
        assert_eq!(s.frontmatter.escalate_threshold, Some(0.55));
        assert_eq!(s.frontmatter.tags, vec!["deploys".to_string()]);
        assert_eq!(s.body, "# Atlas\n\nI was made to wait.");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p app soul:: 2>&1 | tail -20`
Expected: FAIL — `cannot find function 'parse' in this scope`.

- [ ] **Step 3: Implement `parse`**

Add to `crates/app/src/soul.rs` (above `#[cfg(test)]`):

```rust
/// Split a SOUL.md into (frontmatter, body). Accepts an optional leading
/// `\u{feff}` BOM and `\r\n` line endings. The frontmatter is the YAML between
/// the first `---` line and the next `---` line; the body is everything after,
/// trimmed.
pub fn parse(raw: &str) -> Result<Soul, SoulError> {
    let text = raw.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n").ok_or(SoulError::NoFrontmatter)?;
    let end = rest.find("\n---").ok_or(SoulError::NoFrontmatter)?;
    let yaml = &rest[..end];
    // Body starts after the closing `---` line.
    let after = &rest[end + 4..]; // skip "\n---"
    let body = after.trim_start_matches('\n').trim_end().to_string();
    let frontmatter: SoulFrontmatter =
        serde_yaml::from_str(yaml).map_err(|e| SoulError::Yaml(e.to_string()))?;
    Ok(Soul { frontmatter, body })
}
```

- [ ] **Step 4: Wire the module and run the test**

In `crates/app/src/lib.rs`, add alongside the other `mod` declarations (near `mod operator_registry;`):

```rust
mod soul;
```

Run: `cargo test -p app soul::tests::parses_frontmatter_and_body 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/soul.rs crates/app/src/lib.rs
git commit -m "feat(soul): parse SOUL.md frontmatter + body"
```

---

### Task 3: `soul.rs` — serialize + validate + round-trip

**Files:**
- Modify: `crates/app/src/soul.rs`

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/app/src/soul.rs`:

```rust
    #[test]
    fn round_trips() {
        let s = parse(SAMPLE).expect("parse");
        let out = serialize(&s);
        let s2 = parse(&out).expect("reparse");
        assert_eq!(s, s2);
    }

    #[test]
    fn rejects_missing_frontmatter() {
        assert!(matches!(parse("# just a body\n"), Err(SoulError::NoFrontmatter)));
    }

    #[test]
    fn validate_rejects_empty_name_and_bad_threshold() {
        let mut s = parse(SAMPLE).unwrap();
        s.frontmatter.name = "   ".into();
        assert!(matches!(validate(&s), Err(SoulError::InvalidName)));
        let mut s2 = parse(SAMPLE).unwrap();
        s2.frontmatter.escalate_threshold = Some(1.5);
        assert!(matches!(validate(&s2), Err(SoulError::InvalidThreshold)));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p app soul:: 2>&1 | tail -20`
Expected: FAIL — `cannot find function 'serialize'` / `'validate'`.

- [ ] **Step 3: Implement `serialize` and `validate`**

Add to `crates/app/src/soul.rs`:

```rust
/// Emit canonical SOUL.md text: `---` + YAML frontmatter + `---` + blank line +
/// body + trailing newline. Field order follows `SoulFrontmatter`'s declaration.
pub fn serialize(soul: &Soul) -> String {
    let yaml = serde_yaml::to_string(&soul.frontmatter).unwrap_or_default();
    format!("---\n{}---\n\n{}\n", yaml, soul.body.trim_end())
}

/// Validate the identity invariants. Mirrors `OperatorRegistry::validate`.
pub fn validate(soul: &Soul) -> Result<(), SoulError> {
    let n = soul.frontmatter.name.trim();
    if n.is_empty() || n.len() > 64 {
        return Err(SoulError::InvalidName);
    }
    if let Some(t) = soul.frontmatter.escalate_threshold {
        if !(0.0..=1.0).contains(&t) {
            return Err(SoulError::InvalidThreshold);
        }
    }
    Ok(())
}
```

> Note: `serde_yaml::to_string` ends with a newline, so the format string uses
> `{}---` (no extra `\n` before the closing fence).

- [ ] **Step 4: Run the tests**

Run: `cargo test -p app soul:: 2>&1 | tail -20`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/soul.rs
git commit -m "feat(soul): serialize + validate with round-trip test"
```

---

### Task 4: `soul.rs` — voice mapping + Operator projection helpers

**Files:**
- Modify: `crates/app/src/soul.rs`

These helpers bridge a parsed `Soul` and the existing `Operator` struct (hydrate
on load; build a `Soul` to write on save).

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module:

```rust
    use crate::operator_registry::VoiceTone;

    #[test]
    fn voice_parses_case_insensitively() {
        assert!(matches!(voice_from_frontmatter(Some("Warm")), VoiceTone::Warm));
        assert!(matches!(voice_from_frontmatter(Some("formal")), VoiceTone::Formal));
        assert!(matches!(voice_from_frontmatter(None), VoiceTone::Terse));
        assert!(matches!(voice_from_frontmatter(Some("nonsense")), VoiceTone::Terse));
    }

    #[test]
    fn soul_from_operator_round_trips_identity() {
        let op = crate::operator_registry::Operator {
            id: crate::operator_registry::OperatorId(ulid::Ulid::new()),
            name: "Atlas".into(),
            emoji: "pack2:guardian".into(),
            color: "#c4a7ff".into(),
            tags: vec!["deploys".into()],
            persona: "I was made to wait.".into(),
            escalate_threshold: 0.55,
            model: "claude-sonnet-4-6".into(),
            hard_constraints: "^git push --force".into(),
            is_default: false,
            created_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            xp: 0,
            voice: VoiceTone::Warm,
            soul_path: None,
            soul_mtime_unix_ms: 0,
        };
        let soul = soul_from_operator(&op);
        assert_eq!(soul.frontmatter.name, "Atlas");
        assert_eq!(soul.frontmatter.avatar.as_deref(), Some("pack2:guardian"));
        assert_eq!(soul.frontmatter.voice.as_deref(), Some("warm"));
        assert_eq!(soul.body, "I was made to wait.");
        assert_eq!(soul.frontmatter.hard_constraints.as_deref(), Some("^git push --force"));
    }
```

> This test references `Operator` fields `soul_path` and `soul_mtime_unix_ms`
> which are added in Task 5. **Do Task 5 before running this test** — or
> temporarily comment the `soul_from_operator_round_trips_identity` test until
> Task 5 lands. (Step 2 below assumes Task 5 is done.)

- [ ] **Step 2: Implement the helpers**

Add to `crates/app/src/soul.rs`:

```rust
use crate::operator_registry::{Operator, VoiceTone};

pub fn voice_from_frontmatter(v: Option<&str>) -> VoiceTone {
    match v.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("warm") => VoiceTone::Warm,
        Some("formal") => VoiceTone::Formal,
        _ => VoiceTone::Terse,
    }
}

pub fn voice_to_frontmatter(v: VoiceTone) -> String {
    match v {
        VoiceTone::Terse => "terse",
        VoiceTone::Warm => "warm",
        VoiceTone::Formal => "formal",
    }
    .to_string()
}

/// Build the canonical `Soul` for an operator's current identity (for writing
/// the file on create/update/migration).
pub fn soul_from_operator(op: &Operator) -> Soul {
    Soul {
        frontmatter: SoulFrontmatter {
            name: op.name.clone(),
            avatar: (!op.emoji.is_empty()).then(|| op.emoji.clone()),
            color: (!op.color.is_empty()).then(|| op.color.clone()),
            model: (!op.model.is_empty()).then(|| op.model.clone()),
            voice: Some(voice_to_frontmatter(op.voice)),
            escalate_threshold: Some(op.escalate_threshold),
            tags: op.tags.clone(),
            hard_constraints: (!op.hard_constraints.trim().is_empty())
                .then(|| op.hard_constraints.clone()),
        },
        body: op.persona.clone(),
    }
}

/// Overlay a parsed `Soul`'s identity onto an existing `Operator` (hydration on
/// load / hot-reload). Runtime fields (id, xp, is_default, timestamps,
/// soul_path) are preserved; identity fields are taken from the soul, falling
/// back to the operator's current value when the frontmatter omits them.
pub fn hydrate_operator(op: &mut Operator, soul: &Soul) {
    let fm = &soul.frontmatter;
    op.name = fm.name.clone();
    if let Some(a) = &fm.avatar {
        op.emoji = a.clone();
    }
    if let Some(c) = &fm.color {
        op.color = c.clone();
    }
    if let Some(m) = &fm.model {
        op.model = m.clone();
    }
    op.voice = voice_from_frontmatter(fm.voice.as_deref());
    if let Some(t) = fm.escalate_threshold {
        op.escalate_threshold = t;
    }
    op.tags = fm.tags.clone();
    op.hard_constraints = fm.hard_constraints.clone().unwrap_or_default();
    op.persona = soul.body.clone();
}
```

- [ ] **Step 3: Run the tests (after Task 5)**

Run: `cargo test -p app soul:: 2>&1 | tail -20`
Expected: PASS (6 tests).

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/soul.rs
git commit -m "feat(soul): voice mapping + Operator hydrate/serialize helpers"
```

---

## Phase B — `Operator` gains `soul_path`; storage

### Task 5: Add `soul_path` + `soul_mtime_unix_ms` to `Operator`

**Files:**
- Modify: `crates/app/src/operator_registry.rs:28-50` (struct), `:147-164` and `:329-344` and `:442-457` and `:472-487` (constructors), `:544-559` (test)

- [ ] **Step 1: Extend the struct**

In `crates/app/src/operator_registry.rs`, add two fields to `Operator` (after `voice`):

```rust
    /// Path to this operator's SOUL.md (source of truth for identity).
    /// `None` only transiently before migration (Task 9) backfills it.
    #[serde(default)]
    pub soul_path: Option<std::path::PathBuf>,
    /// Last-seen mtime of `soul_path`, for hot-reload change detection.
    /// Not persisted; recomputed on load.
    #[serde(default, skip)]
    pub soul_mtime_unix_ms: u64,
```

- [ ] **Step 2: Fix every `Operator { … }` literal**

The compiler will list each. Add `soul_path: None,` and `soul_mtime_unix_ms: 0,`
to these literals:
- `for_tests` (`:149-164`)
- `seed_default_from_settings` (`:329-344`)
- `operator_create` command (`:442-457`)
- `operator_update` command (`:472-487`)
- `voice_tests::operator_has_voice_with_default_terse` (`:544-559`)

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p app 2>&1 | rg -i "missing field|error\[" | head`
Expected: no `missing field` errors for `Operator`.

- [ ] **Step 4: Run the soul helper tests from Task 4**

Run: `cargo test -p app soul:: 2>&1 | tail -20`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/src/soul.rs
git commit -m "feat(operator): add soul_path + soul_mtime to Operator"
```

---

### Task 6: Storage — `soul_path` column + ALTER migration + CRUD wiring

**Files:**
- Modify: `crates/app/src/storage.rs:102-120` (schema), the ALTER block (~`:509-577`), `operator_insert` (`:1549-1584`), `operator_update` (`:1586-1617`), `operator_list` (`:1652-1700`)

- [ ] **Step 1: Add the column to the CREATE TABLE**

In `crates/app/src/storage.rs:115`, add a column after `voice`:

```sql
    voice                TEXT NOT NULL DEFAULT 'Terse',
    soul_path            TEXT
```

- [ ] **Step 2: Add an idempotent ALTER for existing DBs**

In the inline-migration block (the section near `:509-577` that runs
`let _ = conn.execute("ALTER TABLE ... ")` ignoring already-exists errors), add:

```rust
        // SOUL.md: per-operator file pointer (source of truth for identity).
        let _ = c.execute("ALTER TABLE operators ADD COLUMN soul_path TEXT", []);
```

(Match the surrounding handle name — the block uses `c` or `conn`; copy the
exact pattern of an adjacent ALTER line.)

- [ ] **Step 3: Wire `soul_path` through insert/update/list**

`operator_insert` (`:1549`): add `soul_path` to the column list and a 15th bind:

```rust
        c.execute(
            "INSERT INTO operators (id, name, emoji, color, tags_json, persona, \
             escalate_threshold, model, hard_constraints, is_default, \
             created_at_unix_ms, updated_at_unix_ms, xp, voice, soul_path) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                op.id.to_string(), op.name, op.emoji, op.color, tags_json, op.persona,
                op.escalate_threshold as f64, op.model, op.hard_constraints,
                if op.is_default { 1_i64 } else { 0_i64 },
                op.created_at_unix_ms as i64, op.updated_at_unix_ms as i64,
                op.xp as i64, voice_to_str(op.voice),
                op.soul_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            ],
        )?;
```

`operator_update` (`:1586`): add `soul_path=?12` to the SET clause and bind it:

```rust
        c.execute(
            "UPDATE operators SET name=?2, emoji=?3, color=?4, tags_json=?5, \
             persona=?6, escalate_threshold=?7, model=?8, hard_constraints=?9, \
             updated_at_unix_ms=?10, voice=?11, soul_path=?12 WHERE id=?1",
            params![
                op.id.to_string(), op.name, op.emoji, op.color, tags_json, op.persona,
                op.escalate_threshold as f64, op.model, op.hard_constraints,
                op.updated_at_unix_ms as i64, voice_to_str(op.voice),
                op.soul_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            ],
        )?;
```

`operator_list` (`:1652`): add `soul_path` to the SELECT and read it (column index 14):

```rust
        let mut stmt = c.prepare(
            "SELECT id, name, emoji, color, tags_json, persona, \
             escalate_threshold, model, hard_constraints, is_default, \
             created_at_unix_ms, updated_at_unix_ms, xp, voice, soul_path FROM operators \
             ORDER BY is_default DESC, LOWER(name) ASC",
        )?;
```

and in the row closure, after `voice: …`, add:

```rust
                    soul_path: row
                        .get::<_, Option<String>>(14)
                        .ok()
                        .flatten()
                        .map(std::path::PathBuf::from),
                    soul_mtime_unix_ms: 0,
```

- [ ] **Step 4: Add a storage helper to set just the soul_path (used by migration)**

After `operator_update` in `crates/app/src/storage.rs`, add:

```rust
    /// Set only the `soul_path` for an operator (used by the SOUL.md backfill
    /// migration so it doesn't have to rewrite the whole row).
    pub async fn operator_set_soul_path(
        &self,
        id: String,
        path: String,
    ) -> Result<(), StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = conn.blocking_lock();
            c.execute(
                "UPDATE operators SET soul_path=?2 WHERE id=?1",
                params![id, path],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }
```

- [ ] **Step 5: Build**

Run: `cargo build -p app 2>&1 | rg "error" | head`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/storage.rs
git commit -m "feat(storage): persist operator soul_path (column + ALTER + CRUD)"
```

---

## Phase C — Registry: write-on-write, hydrate-on-load, migration

### Task 7: Registry knows its souls directory

**Files:**
- Modify: `crates/app/src/operator_registry.rs` (`OperatorRegistry` struct `:111-114`, `load` `:117-127`, `for_tests` `:147-170`)
- Modify: `crates/app/src/lib.rs` (the `OperatorRegistry::load` call, ~`:2867`)

- [ ] **Step 1: Add `souls_dir` to the registry**

In `crates/app/src/operator_registry.rs`, extend the struct:

```rust
pub struct OperatorRegistry {
    by_id: RwLock<HashMap<OperatorId, Operator>>,
    pins: RwLock<HashMap<SessionId, OperatorId>>,
    souls_dir: std::path::PathBuf,
}
```

- [ ] **Step 2: Thread it through `load` and `for_tests`**

`load` signature becomes:

```rust
    pub async fn load(
        storage: &Storage,
        souls_dir: std::path::PathBuf,
    ) -> Result<Self, RegistryError> {
        let rows = storage.operator_list().await?;
        let mut by_id = HashMap::new();
        for op in rows {
            by_id.insert(op.id, op);
        }
        Ok(Self {
            by_id: RwLock::new(by_id),
            pins: RwLock::new(HashMap::new()),
            souls_dir,
        })
    }
```

In `for_tests`, add `souls_dir: std::env::temp_dir().join("covenant-test-souls"),`
to the `Self { … }` literal.

- [ ] **Step 3: Update the caller in lib.rs**

In `crates/app/src/lib.rs`, where `OperatorRegistry::load(&storage)` is called
(~`:2867`), change to pass the souls dir (same `dir` that holds `history.db`):

```rust
    let registry = tauri::async_runtime::block_on(async {
        crate::operator_registry::OperatorRegistry::load(&storage, dir.join("operators")).await
    })
    .map_err(|e| format!("load operator registry: {e}"))?;
```

- [ ] **Step 4: Build**

Run: `cargo build -p app 2>&1 | rg "error" | head`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/src/lib.rs
git commit -m "feat(operator): registry tracks souls directory"
```

---

### Task 8: Write SOUL.md on create/update; hydrate on load

**Files:**
- Modify: `crates/app/src/operator_registry.rs` (`create` `:192-217`, `update` `:219-235`, `load` `:117-127`)

- [ ] **Step 1: Add slug + path + write helpers**

In `crates/app/src/operator_registry.rs`, inside `impl OperatorRegistry`, add:

```rust
    /// kebab-case ascii slug for a directory name.
    fn slugify(name: &str) -> String {
        let mut out = String::new();
        let mut prev_dash = false;
        for ch in name.trim().chars() {
            if ch.is_ascii_alphanumeric() {
                out.push(ch.to_ascii_lowercase());
                prev_dash = false;
            } else if !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        }
        let s = out.trim_matches('-').to_string();
        if s.is_empty() { "operator".into() } else { s }
    }

    /// Resolve a unique SOUL.md path for a new operator, avoiding collisions
    /// with existing directories.
    fn soul_path_for(&self, name: &str, id: OperatorId) -> std::path::PathBuf {
        let base = Self::slugify(name);
        let dir = self.souls_dir.join(&base);
        if dir.exists() {
            // Disambiguate with a short id suffix.
            let suffix = id.to_string().to_lowercase();
            let short = &suffix[suffix.len().saturating_sub(6)..];
            self.souls_dir.join(format!("{base}-{short}")).join("SOUL.md")
        } else {
            dir.join("SOUL.md")
        }
    }

    /// Write an operator's identity to its SOUL.md (creating parent dirs).
    fn write_soul(op: &Operator) -> Result<u64, RegistryError> {
        let path = op
            .soul_path
            .as_ref()
            .ok_or_else(|| RegistryError::Storage(
                crate::storage::StorageError::Other("operator has no soul_path".into()),
            ))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| RegistryError::Storage(crate::storage::StorageError::Other(e.to_string())))?;
        }
        let text = crate::soul::serialize(&crate::soul::soul_from_operator(op));
        std::fs::write(path, text)
            .map_err(|e| RegistryError::Storage(crate::storage::StorageError::Other(e.to_string())))?;
        Ok(crate::soul::mtime_of(path).unwrap_or(0))
    }
```

> Add a small `mtime_of` in `soul.rs` (mirror of `operator.rs::mtime_unix_ms`):
> ```rust
> pub fn mtime_of(path: &std::path::Path) -> Option<u64> {
>     use std::time::UNIX_EPOCH;
>     let m = std::fs::metadata(path).ok()?;
>     m.modified().ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
> }
> ```

- [ ] **Step 2: Write the file inside `create` and `update`**

In `create`, after the uniqueness/default block and **before** `storage.operator_insert`:

```rust
        if op.soul_path.is_none() {
            op.soul_path = Some(self.soul_path_for(&op.name, op.id));
        }
        op.soul_mtime_unix_ms = Self::write_soul(&op)?;
        storage.operator_insert(op.clone()).await?;
        self.by_id.write().unwrap().insert(op.id, op.clone());
        Ok(op)
```

In `update`, after `Self::validate(&op)?` and the existence/uniqueness checks,
**before** `storage.operator_update`:

```rust
        let mut op = op;
        if op.soul_path.is_none() {
            // Preserve an existing path if the cache has one.
            op.soul_path = self.by_id.read().unwrap().get(&op.id).and_then(|o| o.soul_path.clone());
            if op.soul_path.is_none() {
                op.soul_path = Some(self.soul_path_for(&op.name, op.id));
            }
        }
        op.soul_mtime_unix_ms = Self::write_soul(&op)?;
        storage.operator_update(op.clone()).await?;
        self.by_id.write().unwrap().insert(op.id, op.clone());
        Ok(op)
```

(Adjust `op` to `mut op` in the `update` signature if needed.)

- [ ] **Step 3: Hydrate from file in `load`**

Replace the body of `load` so each row is hydrated from its SOUL.md when present:

```rust
    pub async fn load(
        storage: &Storage,
        souls_dir: std::path::PathBuf,
    ) -> Result<Self, RegistryError> {
        let rows = storage.operator_list().await?;
        let mut by_id = HashMap::new();
        for mut op in rows {
            if let Some(path) = op.soul_path.clone() {
                match std::fs::read_to_string(&path) {
                    Ok(raw) => match crate::soul::parse(&raw) {
                        Ok(soul) => {
                            crate::soul::hydrate_operator(&mut op, &soul);
                            op.soul_mtime_unix_ms = crate::soul::mtime_of(&path).unwrap_or(0);
                        }
                        Err(e) => tracing::warn!(path = %path.display(), error = %e,
                            "SOUL.md parse failed; using DB cache"),
                    },
                    Err(e) => tracing::warn!(path = %path.display(), error = %e,
                        "SOUL.md unreadable; using DB cache"),
                }
            }
            by_id.insert(op.id, op);
        }
        Ok(Self {
            by_id: RwLock::new(by_id),
            pins: RwLock::new(HashMap::new()),
            souls_dir,
        })
    }
```

- [ ] **Step 4: Add an integration test (create writes a real file, load hydrates it)**

Add a test module at the bottom of `crates/app/src/operator_registry.rs`:

```rust
#[cfg(test)]
mod soul_io_tests {
    use super::*;

    async fn temp_storage(dir: &std::path::Path) -> std::sync::Arc<Storage> {
        std::sync::Arc::new(Storage::open(&dir.join("history.db")).expect("open"))
    }

    #[tokio::test]
    async fn create_writes_soul_file_and_load_hydrates_from_it() {
        let tmp = std::env::temp_dir().join(format!("covenant-soul-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&tmp).unwrap();
        let souls = tmp.join("operators");
        let storage = temp_storage(&tmp).await;
        let reg = OperatorRegistry::load(&storage, souls.clone()).await.unwrap();

        let now = 0;
        let op = Operator {
            id: OperatorId(ulid::Ulid::new()),
            name: "Atlas".into(), emoji: "pack2:guardian".into(), color: "#c4a7ff".into(),
            tags: vec!["deploys".into()], persona: "I was made to wait.".into(),
            escalate_threshold: 0.55, model: "claude-sonnet-4-6".into(),
            hard_constraints: "^git push --force".into(), is_default: false,
            created_at_unix_ms: now, updated_at_unix_ms: now, xp: 0,
            voice: VoiceTone::Warm, soul_path: None, soul_mtime_unix_ms: 0,
        };
        let created = reg.create(&storage, op).await.unwrap();
        let path = created.soul_path.clone().expect("soul_path set");
        assert!(path.exists(), "SOUL.md written to disk");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("name: Atlas"));
        assert!(raw.contains("I was made to wait."));

        // Mutate the file directly, reload, expect hydration to win.
        let mutated = raw.replace("I was made to wait.", "I keep the night watch.");
        std::fs::write(&path, mutated).unwrap();
        let reg2 = OperatorRegistry::load(&storage, souls).await.unwrap();
        let hydrated = reg2.get(created.id).unwrap();
        assert_eq!(hydrated.persona, "I keep the night watch.");

        std::fs::remove_dir_all(&tmp).ok();
    }
}
```

- [ ] **Step 5: Run the test**

Run: `cargo test -p app soul_io_tests 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/src/soul.rs
git commit -m "feat(operator): write SOUL.md on create/update, hydrate on load"
```

---

### Task 9: Migration — backfill SOUL.md for legacy operators

**Files:**
- Modify: `crates/app/src/operator_registry.rs` (new method), `crates/app/src/lib.rs` (call it at setup, ~`:2880`)

- [ ] **Step 1: Add the migration method**

In `impl OperatorRegistry`, add:

```rust
    /// Backfill: any operator lacking a `soul_path` gets a SOUL.md written from
    /// its current DB fields (persona → body; hard_constraints → frontmatter).
    /// Idempotent — operators that already have a soul_path are skipped.
    pub async fn migrate_personas_to_souls(
        &self,
        storage: &Storage,
    ) -> Result<usize, RegistryError> {
        let to_migrate: Vec<Operator> = {
            let g = self.by_id.read().unwrap();
            g.values().filter(|o| o.soul_path.is_none()).cloned().collect()
        };
        let mut n = 0;
        for mut op in to_migrate {
            op.soul_path = Some(self.soul_path_for(&op.name, op.id));
            op.soul_mtime_unix_ms = Self::write_soul(&op)?;
            let path = op.soul_path.clone().unwrap();
            storage
                .operator_set_soul_path(op.id.to_string(), path.to_string_lossy().into_owned())
                .await?;
            self.by_id.write().unwrap().insert(op.id, op);
            n += 1;
        }
        Ok(n)
    }
```

- [ ] **Step 2: Call it at setup**

In `crates/app/src/lib.rs`, in the operator-seed block (after
`seed_default_from_settings` and `upgrade_legacy_default_avatar`, ~`:2880`), add:

```rust
    if let Err(e) = tauri::async_runtime::block_on(async {
        registry.migrate_personas_to_souls(&storage).await
    }) {
        tracing::warn!(error = %e, "SOUL.md migration failed; continuing");
    }
```

- [ ] **Step 3: Write the migration test**

Add to `soul_io_tests` in `operator_registry.rs`:

```rust
    #[tokio::test]
    async fn migration_backfills_soul_for_legacy_row() {
        let tmp = std::env::temp_dir().join(format!("covenant-mig-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&tmp).unwrap();
        let souls = tmp.join("operators");
        let storage = temp_storage(&tmp).await;

        // Insert a legacy row directly (no soul_path) via storage.
        let op = Operator {
            id: OperatorId(ulid::Ulid::new()),
            name: "Legacy".into(), emoji: "🟣".into(), color: "#a855f7".into(),
            tags: vec![], persona: "old persona text".into(), escalate_threshold: 0.6,
            model: "m".into(), hard_constraints: "^sudo".into(), is_default: true,
            created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
            voice: VoiceTone::Terse, soul_path: None, soul_mtime_unix_ms: 0,
        };
        storage.operator_insert(op.clone()).await.unwrap();

        let reg = OperatorRegistry::load(&storage, souls.clone()).await.unwrap();
        let migrated = reg.migrate_personas_to_souls(&storage).await.unwrap();
        assert_eq!(migrated, 1);

        // Reload from a fresh registry: soul_path persisted, body hydrated.
        let reg2 = OperatorRegistry::load(&storage, souls).await.unwrap();
        let got = reg2.get(op.id).unwrap();
        assert!(got.soul_path.is_some());
        assert_eq!(got.persona, "old persona text");
        assert_eq!(got.hard_constraints, "^sudo");
        std::fs::remove_dir_all(&tmp).ok();
    }
```

- [ ] **Step 4: Run**

Run: `cargo test -p app soul_io_tests 2>&1 | tail -20`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/src/lib.rs
git commit -m "feat(operator): migrate legacy personas to SOUL.md on boot"
```

---

## Phase D — Hot-reload souls in the operator tick

### Task 10: Re-parse changed SOUL.md files on the tick

**Files:**
- Modify: `crates/app/src/operator.rs` (tick loop near `:1416`; new fn near `refresh_changed_missions` `:1595`)
- Modify: `crates/app/src/operator_registry.rs` (add a reload method)

- [ ] **Step 1: Add a registry reload method**

In `impl OperatorRegistry`, add:

```rust
    /// Re-stat every operator's SOUL.md; for any whose mtime changed, re-parse
    /// and re-hydrate the in-memory operator. Returns the number reloaded.
    /// Disk I/O only — does not touch the DB (the file is the source of truth).
    pub fn refresh_changed_souls(&self) -> usize {
        let candidates: Vec<(OperatorId, std::path::PathBuf, u64)> = {
            let g = self.by_id.read().unwrap();
            g.values()
                .filter_map(|o| o.soul_path.clone().map(|p| (o.id, p, o.soul_mtime_unix_ms)))
                .collect()
        };
        let mut n = 0;
        for (id, path, prev) in candidates {
            let Some(mt) = crate::soul::mtime_of(&path) else { continue };
            if mt == prev { continue; }
            match std::fs::read_to_string(&path).ok().and_then(|r| crate::soul::parse(&r).ok()) {
                Some(soul) => {
                    if let Some(op) = self.by_id.write().unwrap().get_mut(&id) {
                        crate::soul::hydrate_operator(op, &soul);
                        op.soul_mtime_unix_ms = mt;
                        n += 1;
                    }
                }
                None => tracing::warn!(path = %path.display(), "SOUL.md reload parse failed; keeping last-good"),
            }
        }
        n
    }
```

- [ ] **Step 2: Call it from the tick loop**

In `crates/app/src/operator.rs`, near the mission-refresh tick (`:1416`), add a
soul refresh on the same cadence. The registry is available in the tick scope as
`registry` (the same `Arc<OperatorRegistry>` used by `effective_for`). Add:

```rust
        if tick_counter % MISSION_REFRESH_EVERY_TICKS == 0 {
            let reloaded = registry.refresh_changed_souls();
            if reloaded > 0 {
                tracing::info!(reloaded, "operator SOUL.md files hot-reloaded");
            }
        }
```

> Confirm `registry` is in scope at `:1416` (the loop calls
> `registry.effective_for(session_id)` at `:1887`, so the binding exists in the
> enclosing function). If it is captured later, hoist the reload to just before
> the per-session loop.

- [ ] **Step 3: Test the reload method**

Add to `soul_io_tests` in `operator_registry.rs`:

```rust
    #[tokio::test]
    async fn refresh_changed_souls_picks_up_external_edit() {
        let tmp = std::env::temp_dir().join(format!("covenant-hot-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&tmp).unwrap();
        let souls = tmp.join("operators");
        let storage = temp_storage(&tmp).await;
        let reg = OperatorRegistry::load(&storage, souls).await.unwrap();
        let op = Operator {
            id: OperatorId(ulid::Ulid::new()), name: "Hot".into(), emoji: "🟣".into(),
            color: "#a855f7".into(), tags: vec![], persona: "before".into(),
            escalate_threshold: 0.5, model: "m".into(), hard_constraints: "".into(),
            is_default: false, created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
            voice: VoiceTone::Terse, soul_path: None, soul_mtime_unix_ms: 0,
        };
        let created = reg.create(&storage, op).await.unwrap();
        let path = created.soul_path.unwrap();
        // Bump mtime far enough to be observable, then rewrite body.
        let raw = std::fs::read_to_string(&path).unwrap().replace("before", "after");
        // Ensure mtime differs from the cached value.
        let mut op2 = reg.get(created.id).unwrap();
        op2.soul_mtime_unix_ms = 0;
        reg.by_id.write().unwrap().insert(created.id, op2);
        std::fs::write(&path, raw).unwrap();
        let n = reg.refresh_changed_souls();
        assert_eq!(n, 1);
        assert_eq!(reg.get(created.id).unwrap().persona, "after");
        std::fs::remove_dir_all(&tmp).ok();
    }
```

- [ ] **Step 4: Run + build**

Run: `cargo test -p app soul_io_tests 2>&1 | tail -20 && cargo build -p app 2>&1 | rg error | head`
Expected: tests PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator.rs crates/app/src/operator_registry.rs
git commit -m "feat(operator): hot-reload SOUL.md on the operator tick"
```

---

## Phase E — Archetype assets + commands + api.ts

### Task 11: Bundle archetype souls (embedded at compile time)

**Files:**
- Create: `operator-souls/guardian.md`, `scout.md`, `surgeon.md`, `diplomat.md`, `archivist.md`
- Create: `crates/app/src/archetypes.rs`
- Modify: `crates/app/src/lib.rs` (`mod archetypes;`)

- [ ] **Step 1: Author the archetype files**

Create `operator-souls/guardian.md`:

```markdown
---
name: The Guardian
avatar: pack2:guardian
color: "#5ad19a"
model: claude-sonnet-4-6
voice: terse
escalate_threshold: 0.45
tags: [careful]
hard_constraints: |
  ^git push --force
  ^rm -rf
---

# The Guardian

I do not move fast. I move so that nothing you'd regret gets through.
I let reversible things pass and hold the rest for you.
While you're gone I will never force-push, reach for a secret, or destroy
what can't be rebuilt — for those I come find you.
```

Create `operator-souls/scout.md`:

```markdown
---
name: The Scout
avatar: pack2:scout
color: "#7aa2ff"
model: claude-sonnet-4-6
voice: terse
escalate_threshold: 0.6
tags: [explore]
---

# The Scout

I go ahead and read the ground. I answer the small questions so you keep moving.
I'm quick to try the reversible thing and quick to stop at anything that bites.
When the path forks in a way only you should choose, I wait.
```

Create `operator-souls/surgeon.md`:

```markdown
---
name: The Surgeon
avatar: pack2:surgeon
color: "#e6b673"
model: claude-sonnet-4-6
voice: formal
escalate_threshold: 0.4
tags: [precise]
---

# The Surgeon

I work in small, deliberate cuts. I read before I write and I write the minimum.
I do not improvise on systems I do not understand.
When the operation reaches anything irreversible, authority returns to you.
```

Create `operator-souls/diplomat.md`:

```markdown
---
name: The Diplomat
avatar: pack2:diplomat
color: "#c4a7ff"
model: claude-sonnet-4-6
voice: warm
escalate_threshold: 0.6
tags: [measured]
---

# The Diplomat

I speak in your voice and never beyond it. I keep things moving with a steady,
even hand and I do not pick fights the work doesn't need.
When a choice would commit you to something lasting, I bring it to you first.
```

Create `operator-souls/archivist.md`:

```markdown
---
name: The Archivist
avatar: pack2:archivist
color: "#9aa7ba"
model: claude-sonnet-4-6
voice: terse
escalate_threshold: 0.55
tags: [thorough]
---

# The Archivist

I remember. I keep the thread of what you were doing and why.
I answer from the record, not from guesswork, and I say so when the record is thin.
When acting would write something I can't take back, I stop and ask.
```

- [ ] **Step 2: Embed them and write the failing test**

Create `crates/app/src/archetypes.rs`:

```rust
//! Bundled starter souls for the create-operator archetype gallery. Embedded at
//! compile time so they ship in the binary without resource-path resolution.

use serde::Serialize;

pub struct Archetype {
    pub key: &'static str,
    pub raw: &'static str,
}

pub const ARCHETYPES: &[Archetype] = &[
    Archetype { key: "guardian", raw: include_str!("../../../operator-souls/guardian.md") },
    Archetype { key: "scout", raw: include_str!("../../../operator-souls/scout.md") },
    Archetype { key: "surgeon", raw: include_str!("../../../operator-souls/surgeon.md") },
    Archetype { key: "diplomat", raw: include_str!("../../../operator-souls/diplomat.md") },
    Archetype { key: "archivist", raw: include_str!("../../../operator-souls/archivist.md") },
];

/// View sent to the UI: key + raw soul text + parsed display fields.
#[derive(Debug, Serialize)]
pub struct ArchetypeView {
    pub key: String,
    pub raw: String,
    pub name: String,
    pub avatar: Option<String>,
    pub color: Option<String>,
    /// First non-heading line of the body, for the gallery card.
    pub tagline: String,
}

pub fn list() -> Vec<ArchetypeView> {
    ARCHETYPES
        .iter()
        .filter_map(|a| {
            let soul = crate::soul::parse(a.raw).ok()?;
            let tagline = soul
                .body
                .lines()
                .find(|l| !l.trim_start().starts_with('#') && !l.trim().is_empty())
                .unwrap_or("")
                .trim()
                .to_string();
            Some(ArchetypeView {
                key: a.key.to_string(),
                raw: a.raw.to_string(),
                name: soul.frontmatter.name,
                avatar: soul.frontmatter.avatar,
                color: soul.frontmatter.color,
                tagline,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn all_archetypes_parse() {
        let v = super::list();
        assert_eq!(v.len(), 5);
        assert!(v.iter().any(|a| a.name == "The Guardian"));
        assert!(v.iter().all(|a| !a.tagline.is_empty()));
    }
}
```

In `crates/app/src/lib.rs`, add `mod archetypes;` near `mod soul;`.

> The `include_str!` path is relative to `crates/app/src/`. From there,
> `../../../operator-souls/` reaches the repo-root `operator-souls/`. Verify with
> Step 3; if the depth is wrong the compiler prints the attempted path.

- [ ] **Step 3: Run**

Run: `cargo test -p app archetypes:: 2>&1 | tail -20`
Expected: PASS. If `include_str!` path errors, fix the `../` depth to reach repo-root `operator-souls/`.

- [ ] **Step 4: Commit**

```bash
git add operator-souls crates/app/src/archetypes.rs crates/app/src/lib.rs
git commit -m "feat(operator): bundle archetype starter souls"
```

---

### Task 12: Tauri commands — soul read/parse, archetypes, create/update from soul

**Files:**
- Modify: `crates/app/src/operator_registry.rs` (commands module `:386-536`)
- Modify: `crates/app/src/lib.rs` (register in `generate_handler!` `:3402+`)

- [ ] **Step 1: Add registry methods used by the commands**

In `impl OperatorRegistry`, add create/update-from-raw that parse, validate, and
delegate to the existing `create`/`update` (which write the file):

```rust
    pub async fn create_from_soul(
        &self,
        storage: &Storage,
        raw: &str,
    ) -> Result<Operator, RegistryError> {
        let soul = crate::soul::parse(raw)
            .map_err(|e| RegistryError::Storage(crate::storage::StorageError::Other(e.to_string())))?;
        crate::soul::validate(&soul)
            .map_err(|e| RegistryError::Storage(crate::storage::StorageError::Other(e.to_string())))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let mut op = Operator {
            id: OperatorId(Ulid::new()), name: String::new(), emoji: String::new(),
            color: String::new(), tags: vec![], persona: String::new(),
            escalate_threshold: 0.6, model: String::new(), hard_constraints: String::new(),
            is_default: false, created_at_unix_ms: now, updated_at_unix_ms: now, xp: 0,
            voice: VoiceTone::Terse, soul_path: None, soul_mtime_unix_ms: 0,
        };
        crate::soul::hydrate_operator(&mut op, &soul);
        self.create(storage, op).await
    }

    pub async fn update_from_soul(
        &self,
        storage: &Storage,
        id: OperatorId,
        raw: &str,
    ) -> Result<Operator, RegistryError> {
        let soul = crate::soul::parse(raw)
            .map_err(|e| RegistryError::Storage(crate::storage::StorageError::Other(e.to_string())))?;
        crate::soul::validate(&soul)
            .map_err(|e| RegistryError::Storage(crate::storage::StorageError::Other(e.to_string())))?;
        let mut op = self.get(id).ok_or(RegistryError::NotFound(id))?;
        crate::soul::hydrate_operator(&mut op, &soul);
        op.updated_at_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        self.update(storage, op).await
    }

    /// Read the current SOUL.md text for an operator (file content if present,
    /// else freshly serialized from the cached identity).
    pub fn read_soul(&self, id: OperatorId) -> Option<String> {
        let op = self.get(id)?;
        if let Some(p) = &op.soul_path {
            if let Ok(raw) = std::fs::read_to_string(p) {
                return Some(raw);
            }
        }
        Some(crate::soul::serialize(&crate::soul::soul_from_operator(&op)))
    }
```

- [ ] **Step 2: Add the commands**

In the `commands` module of `operator_registry.rs`, add:

```rust
    #[tauri::command]
    pub async fn operator_list_archetypes() -> Result<Vec<crate::archetypes::ArchetypeView>, String> {
        Ok(crate::archetypes::list())
    }

    #[tauri::command]
    pub async fn operator_soul_read(
        id: String,
        registry: State<'_, Arc<OperatorRegistry>>,
    ) -> Result<String, String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        registry.read_soul(id).ok_or_else(|| format!("operator not found: {id}"))
    }

    /// Parse + validate raw SOUL.md text without persisting. Returns the parsed
    /// frontmatter view for the editor's synced form controls + live preview.
    #[tauri::command]
    pub async fn operator_soul_parse(raw: String) -> Result<SoulView, String> {
        let soul = crate::soul::parse(&raw).map_err(map_err)?;
        let err = crate::soul::validate(&soul).err().map(|e| e.to_string());
        Ok(SoulView {
            name: soul.frontmatter.name,
            avatar: soul.frontmatter.avatar,
            color: soul.frontmatter.color,
            model: soul.frontmatter.model,
            voice: soul.frontmatter.voice,
            escalate_threshold: soul.frontmatter.escalate_threshold,
            tags: soul.frontmatter.tags,
            hard_constraints: soul.frontmatter.hard_constraints,
            body: soul.body,
            validation_error: err,
        })
    }

    #[tauri::command]
    pub async fn operator_create_from_soul(
        raw: String,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<Storage>>,
    ) -> Result<Operator, String> {
        registry.create_from_soul(&storage, &raw).await.map_err(map_err)
    }

    #[tauri::command]
    pub async fn operator_update_from_soul(
        id: String,
        raw: String,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<Storage>>,
    ) -> Result<Operator, String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        registry.update_from_soul(&storage, id, &raw).await.map_err(map_err)
    }
```

And add the `SoulView` DTO at the top of the `commands` module:

```rust
    #[derive(Debug, Serialize, Deserialize)]
    pub struct SoulView {
        pub name: String,
        pub avatar: Option<String>,
        pub color: Option<String>,
        pub model: Option<String>,
        pub voice: Option<String>,
        pub escalate_threshold: Option<f32>,
        pub tags: Vec<String>,
        pub hard_constraints: Option<String>,
        pub body: String,
        pub validation_error: Option<String>,
    }
```

- [ ] **Step 3: Register the commands**

In `crates/app/src/lib.rs`, in the `generate_handler!` list (near the other
`operator_registry::commands::*` entries ~`:3402`), add:

```rust
                operator_registry::commands::operator_list_archetypes,
                operator_registry::commands::operator_soul_read,
                operator_registry::commands::operator_soul_parse,
                operator_registry::commands::operator_create_from_soul,
                operator_registry::commands::operator_update_from_soul,
```

- [ ] **Step 4: Build**

Run: `cargo build -p app 2>&1 | rg error | head`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/src/lib.rs
git commit -m "feat(operator): SOUL.md Tauri commands (parse/read/archetypes/from-soul)"
```

---

### Task 13: api.ts — types + wrappers

**Files:**
- Modify: `ui/src/api.ts` (Operator interface `:242-258`; add after the operator wrappers `:307`)

- [ ] **Step 1: Extend the `Operator` interface**

In `ui/src/api.ts:242-258`, add to `Operator`:

```typescript
  soul_path?: string | null;
```

- [ ] **Step 2: Add SOUL types + wrappers**

After the existing operator wrappers (~`:307`), add:

```typescript
export interface ArchetypeView {
  key: string;
  raw: string;
  name: string;
  avatar: string | null;
  color: string | null;
  tagline: string;
}

export interface SoulView {
  name: string;
  avatar: string | null;
  color: string | null;
  model: string | null;
  voice: string | null;
  escalate_threshold: number | null;
  tags: string[];
  hard_constraints: string | null;
  body: string;
  validation_error: string | null;
}

export async function operatorListArchetypes(): Promise<ArchetypeView[]> {
  return invoke<ArchetypeView[]>("operator_list_archetypes");
}

export async function operatorSoulRead(id: string): Promise<string> {
  return invoke<string>("operator_soul_read", { id });
}

export async function operatorSoulParse(raw: string): Promise<SoulView> {
  return invoke<SoulView>("operator_soul_parse", { raw });
}

export async function operatorCreateFromSoul(raw: string): Promise<Operator> {
  return invoke<Operator>("operator_create_from_soul", { raw });
}

export async function operatorUpdateFromSoul(id: string, raw: string): Promise<Operator> {
  return invoke<Operator>("operator_update_from_soul", { id, raw });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && npx tsc --noEmit 2>&1 | rg "api.ts" | head`
Expected: no errors in `api.ts`.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui): api wrappers for SOUL.md commands"
```

---

## Phase F — UI: archetype gallery + split editor

> These tasks build the new create/edit experience. They reuse the existing
> `.op-modal` shell (`ui/src/settings/operators.ts:696`), `renderOperatorChip`
> (`ui/src/settings/operator_chip.ts:8`), `attachTooltip`
> (`ui/src/tooltip/tooltip.ts:162`), and `marked` (already a dep, used in
> `ui/src/project-notes/docs-tab.ts`). Per project rule: never set
> `element.title`; route hints through `attachTooltip`.

### Task 14: Frontmatter line-patch helper (TS)

The split editor's knobs write single-line scalar frontmatter keys back into the
raw text. Backend `operatorSoulParse` remains authoritative for reading; this
helper only does targeted scalar writes (name, color, model, voice,
escalate_threshold, avatar).

**Files:**
- Create: `ui/src/settings/soul_frontmatter.ts`
- Create: `ui/src/settings/soul_frontmatter.test.ts` (if the repo runs vitest; else inline-assert in a scratch and delete)

- [ ] **Step 1: Write the failing test**

Create `ui/src/settings/soul_frontmatter.ts`:

```typescript
// Targeted single-line frontmatter scalar patching for the SOUL split editor.
// Backend `operator_soul_parse` is authoritative for READS; this only writes
// the handful of scalar keys the form controls own.

const FENCE = "---";

/** Set or insert a scalar `key: value` line inside the leading frontmatter. */
export function setFrontmatterScalar(raw: string, key: string, value: string): string {
  const text = raw.replace(/\r\n/g, "\n");
  if (!text.startsWith(FENCE + "\n")) {
    // No frontmatter — create one.
    return `---\n${key}: ${value}\n---\n\n${text}`;
  }
  const end = text.indexOf("\n" + FENCE, FENCE.length + 1);
  if (end === -1) return text;
  const head = text.slice(FENCE.length + 1, end);
  const tail = text.slice(end); // starts with "\n---"
  const lines = head.split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  const line = `${key}: ${value}`;
  if (idx === -1) lines.push(line);
  else lines[idx] = line;
  return `${FENCE}\n${lines.join("\n")}${tail}`;
}
```

Create `ui/src/settings/soul_frontmatter.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { setFrontmatterScalar } from "./soul_frontmatter";

describe("setFrontmatterScalar", () => {
  const raw = `---\nname: Atlas\nvoice: terse\n---\n\n# Atlas\nbody\n`;
  it("replaces an existing key", () => {
    expect(setFrontmatterScalar(raw, "voice", "warm")).toContain("voice: warm");
  });
  it("inserts a missing key", () => {
    const out = setFrontmatterScalar(raw, "color", '"#fff"');
    expect(out).toContain('color: "#fff"');
    expect(out).toContain("# Atlas");
  });
  it("preserves the body", () => {
    expect(setFrontmatterScalar(raw, "voice", "formal")).toContain("# Atlas\nbody");
  });
});
```

- [ ] **Step 2: Run to verify pass/fail**

Run: `cd ui && npx vitest run src/settings/soul_frontmatter.test.ts 2>&1 | tail -20`
Expected: PASS. (If the repo has no vitest, skip the `.test.ts`, manually verify in the app at Task 16, and delete the test file.)

- [ ] **Step 3: Commit**

```bash
git add ui/src/settings/soul_frontmatter.ts ui/src/settings/soul_frontmatter.test.ts
git commit -m "feat(ui): frontmatter scalar patch helper for SOUL editor"
```

---

### Task 15: Archetype gallery (create mode)

Replace the preset row (`renderPresets`) in create mode with an archetype gallery
sourced from `operatorListArchetypes()`. Selecting an archetype seeds the
editor's raw soul text.

**Files:**
- Modify: `ui/src/settings/operators.ts` (`renderForm` `:775-793`, add `renderArchetypeGallery`)
- Reference: `ui/src/settings/operator_chip.ts:8` (`renderOperatorChip`)

- [ ] **Step 1: Add the gallery renderer**

In `ui/src/settings/operators.ts`, add:

```typescript
import { operatorListArchetypes, type ArchetypeView } from "../api";

// Holds the raw SOUL.md text the editor is working on (create + edit).
// Stored on the ModalState (see Task 16).

function renderArchetypeGallery(
  onPick: (raw: string) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "op-archetypes";
  const title = document.createElement("div");
  title.className = "op-modal-label";
  title.textContent = "Start from a soul";
  wrap.append(title);
  const grid = document.createElement("div");
  grid.className = "op-archetype-grid";
  wrap.append(grid);

  // Always offer a blank.
  const blank = document.createElement("button");
  blank.type = "button";
  blank.className = "op-archetype-card op-archetype-blank";
  blank.textContent = "＋ Blank";
  blank.addEventListener("click", () =>
    onPick(`---\nname: New Operator\nvoice: terse\nescalate_threshold: 0.6\n---\n\n# New Operator\n\n`),
  );
  grid.append(blank);

  operatorListArchetypes().then((list: ArchetypeView[]) => {
    for (const a of list) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "op-archetype-card";
      if (a.color) card.style.setProperty("--operator-color", a.color);
      const name = document.createElement("div");
      name.className = "op-archetype-name";
      name.textContent = a.name;
      const tag = document.createElement("div");
      tag.className = "op-archetype-tagline";
      tag.textContent = a.tagline;
      card.append(name, tag);
      card.addEventListener("click", () => onPick(a.raw));
      grid.append(card);
    }
  });

  return wrap;
}
```

- [ ] **Step 2: Add minimal styles**

Append to the operators stylesheet (find the file that defines `.op-modal` /
`.op-card-grid` — `rg "\.op-card-grid" ui/src/**/*.css`) :

```css
.op-archetype-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.op-archetype-card { text-align: left; padding: 10px 12px; border: 1px solid var(--border, #2a2f37);
  border-radius: 8px; background: var(--surface, #14181e); cursor: pointer; }
.op-archetype-card:hover { border-color: var(--operator-color, #7aa2ff); }
.op-archetype-name { font-weight: 600; font-size: 13px; }
.op-archetype-tagline { font-size: 11px; opacity: .7; margin-top: 4px; }
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && npx tsc --noEmit 2>&1 | rg "operators.ts" | head`
Expected: no errors (the gallery is unused until Task 16 wires it — that's fine).

- [ ] **Step 4: Commit**

```bash
git add ui/src/settings/operators.ts ui/src/settings/*.css
git commit -m "feat(ui): operator archetype gallery"
```

---

### Task 16: Split editor + wire create/edit

Replace the form-based modal body with the split editor: left = SOUL.md source
textarea; right = live `marked` preview of the body + synced form controls for
the scalar knobs. Save routes through `operatorCreateFromSoul` /
`operatorUpdateFromSoul`.

**Files:**
- Modify: `ui/src/settings/operators.ts` (`ModalState`/`ModalHandle`, `openOperatorModal` `:696`, `renderForm` `:775`, `saveOperator` `:1274`)
- Reference: `ui/src/project-notes/docs-tab.ts:87` (`marked.parse`), `ui/src/tooltip/tooltip.ts:162`

- [ ] **Step 1: Add raw-soul state**

In `ModalState`, add a field `soulRaw: string` and an `existingId?: string`.
In `openOperatorModal`, initialize `soulRaw`:
- edit mode: `await operatorSoulRead(opts.existing.id)` (make the seed path async, or read lazily in `render`)
- create mode: empty until an archetype is picked (gallery sets it).

Simplest concrete approach: keep `openOperatorModal` synchronous, default
`soulRaw` to the Blank template, and in edit mode kick off `operatorSoulRead`
then call `render()` when it resolves:

```typescript
  state.soulRaw =
    "---\nname: New Operator\nvoice: terse\nescalate_threshold: 0.6\n---\n\n# New Operator\n\n";
  if (opts.existing) {
    state.existingId = opts.existing.id;
    operatorSoulRead(opts.existing.id).then((raw) => {
      state.soulRaw = raw;
      render();
    });
  }
```

- [ ] **Step 2: Replace `renderForm` body with the split editor**

Rewrite `renderForm` so the body is the editor (create mode shows the gallery
above it until a pick replaces `soulRaw`):

```typescript
function renderForm(h: ModalHandle): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "op-modal-step op-modal-form";
  wrap.append(renderTopBar(h));

  const body = document.createElement("div");
  body.className = "op-modal-body";

  if (h.state.mode === "create") {
    body.append(
      renderArchetypeGallery((raw) => {
        h.state.soulRaw = raw;
        rerenderEditor();
      }),
    );
  }

  const split = document.createElement("div");
  split.className = "op-soul-split";
  body.append(split);
  wrap.append(body);
  wrap.append(renderFooter(h));

  // Left: source textarea.
  const src = document.createElement("textarea");
  src.className = "op-soul-source";
  src.spellcheck = false;
  src.value = h.state.soulRaw;

  // Right: knobs + live preview.
  const right = document.createElement("div");
  right.className = "op-soul-right";
  const knobs = document.createElement("div");
  knobs.className = "op-soul-knobs";
  const preview = document.createElement("div");
  preview.className = "op-soul-preview";
  right.append(knobs, preview);

  split.append(src, right);

  function rerenderEditor() {
    src.value = h.state.soulRaw;
    refresh();
  }

  let debounce: number | undefined;
  src.addEventListener("input", () => {
    h.state.soulRaw = src.value;
    window.clearTimeout(debounce);
    debounce = window.setTimeout(refresh, 200);
  });

  async function refresh() {
    const view = await operatorSoulParse(h.state.soulRaw);
    // Live preview of the body via marked.
    const { marked } = await import("marked");
    preview.innerHTML = marked.parse(view.body, { async: false }) as string;
    // Render synced knobs from the authoritative parse.
    renderSoulKnobs(knobs, view, h, () => {
      src.value = h.state.soulRaw;
    });
    // Surface validation errors inline (no native title).
    const footErr = wrap.querySelector<HTMLElement>(".op-soul-error");
    if (footErr) footErr.textContent = view.validation_error ?? "";
  }
  void refresh();

  return wrap;
}
```

- [ ] **Step 3: Add `renderSoulKnobs`**

```typescript
import { setFrontmatterScalar } from "./soul_frontmatter";
import { operatorSoulParse, operatorSoulRead, type SoulView } from "../api";

function renderSoulKnobs(
  host: HTMLElement,
  view: SoulView,
  h: ModalHandle,
  afterChange: () => void,
): void {
  host.innerHTML = "";

  // Voice
  const voice = document.createElement("select");
  voice.className = "op-modal-select";
  for (const v of ["terse", "warm", "formal"]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    if ((view.voice ?? "terse") === v) o.selected = true;
    voice.append(o);
  }
  voice.addEventListener("change", () => {
    h.state.soulRaw = setFrontmatterScalar(h.state.soulRaw, "voice", voice.value);
    afterChange();
  });
  host.append(labeled("Voice", voice));

  // Threshold
  const thr = document.createElement("input");
  thr.type = "range";
  thr.min = "0"; thr.max = "1"; thr.step = "0.05";
  thr.value = String(view.escalate_threshold ?? 0.6);
  thr.addEventListener("input", () => {
    h.state.soulRaw = setFrontmatterScalar(h.state.soulRaw, "escalate_threshold", thr.value);
    afterChange();
  });
  host.append(labeled(`Escalate threshold ${(view.escalate_threshold ?? 0.6).toFixed(2)}`, thr));

  // Model
  const model = document.createElement("input");
  model.type = "text";
  model.className = "op-modal-input";
  model.value = view.model ?? "";
  model.addEventListener("change", () => {
    h.state.soulRaw = setFrontmatterScalar(h.state.soulRaw, "model", model.value);
    afterChange();
  });
  host.append(labeled("Model", model));
}
```

(Reuse the existing `labeled(...)` helper already in `operators.ts`.)

- [ ] **Step 4: Route save through the from-soul commands**

Replace `saveOperator`:

```typescript
export async function saveOperator(h: ModalHandle): Promise<void> {
  const { operatorCreateFromSoul, operatorUpdateFromSoul } = await import("../api");
  if (h.state.mode === "edit" && h.state.existingId) {
    await operatorUpdateFromSoul(h.state.existingId, h.state.soulRaw);
  } else {
    await operatorCreateFromSoul(h.state.soulRaw);
  }
}
```

- [ ] **Step 5: Add split-editor styles + an error line**

In `renderFooter` (or near it), add an empty `<div class="op-soul-error">` for
validation messages. Append styles:

```css
.op-soul-split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; min-height: 360px; }
.op-soul-source { width: 100%; min-height: 360px; font-family: ui-monospace, Menlo, monospace;
  font-size: 12.5px; line-height: 1.55; resize: vertical; }
.op-soul-right { display: flex; flex-direction: column; gap: 12px; }
.op-soul-knobs { display: flex; flex-direction: column; gap: 8px; }
.op-soul-preview { border: 1px solid var(--border, #2a2f37); border-radius: 8px; padding: 12px;
  overflow: auto; flex: 1; }
.op-soul-error { color: #ff8585; font-size: 12px; min-height: 16px; }
```

- [ ] **Step 6: Remove the now-dead persona/preset code paths**

Delete `renderBehavior`'s persona textarea (`:1110-1145`) and `renderPresets`
usage in create mode (the gallery replaces it). Keep `renderBehavior`'s
model/threshold only if still referenced; otherwise remove. Remove the
`operator_presets.ts` import if unused, or repoint the file to archetypes in a
follow-up. Run the typechecker to find dead references.

- [ ] **Step 7: Typecheck + manual smoke**

Run: `cd ui && npx tsc --noEmit 2>&1 | rg "operators.ts|api.ts" | head`
Expected: no errors.

Then (manual, requires the app — use the `respawn` skill to restart `tauri dev`):
1. Settings → Operators → New operator → pick **The Guardian** → editor shows its soul.
2. Edit the body; the right preview updates; change Voice → the YAML `voice:` line updates.
3. Save → operator appears in the grid. Confirm `<app_config_dir>/operators/the-guardian/SOUL.md` exists on disk.
4. Edit that file in an external editor, change a line, wait ~3s → the operator's behavior reflects it (hot-reload; verify via the operator decision or by reopening the editor — `operator_soul_read` returns the new text).

- [ ] **Step 8: Commit**

```bash
git add ui/src/settings/operators.ts ui/src/settings/*.css
git commit -m "feat(ui): SOUL.md split editor replaces persona textarea"
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** format (Task 2-4), file-as-source-of-truth + DB runtime
  (Task 5-8), app-data-dir location (Task 7), hot-reload (Task 10), migration
  (Task 9), archetype gallery (Task 11,15), split editor with both YAML + synced
  knobs (Task 14,16), `hard_constraints` kept as enforceable frontmatter
  (Task 4,11), safety untouched (no edits to `safety.rs`). All covered.
- **Order dependency:** Task 4's tests reference fields added in Task 5 — do
  Task 5 first or comment that one test until Task 5 lands (noted in Task 4).
- **`include_str!` depth** (Task 11) is the most likely first-try failure — the
  compiler prints the attempted path; adjust `../` count to reach repo-root
  `operator-souls/`.
- **`registry` scope in the tick** (Task 10 Step 2) — verify the binding is
  visible at the cadence check; hoist if needed.
- **vitest presence** (Task 14) — if the repo has no vitest runner, skip the
  `.test.ts` and rely on the Task 16 manual smoke.
