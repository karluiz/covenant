# Achievements & Reputation (MVP A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the achievement badge engine + a Metrics "Achievements" section, backed by local-first SQLite, with one real emitter (spec/note creation → `cartographer`) so the feature is demonstrable end-to-end.

**Architecture:** Extend the existing `crates/score` subsystem. A new SQLite migration (v4) adds `achievement_facts`, `achievement_progress`, and `achievement_awards` tables. A pure, deterministic count-based rule engine (`achievements.rs`) records idempotent facts, advances tiered progress, and inserts award rows for newly crossed tiers. Static Rust definitions are the source of truth and serialize to the UI. Tauri commands expose catalog/summary/progress/awards. The Metrics page (`ui/src/score`) gains an Achievements card.

**Tech Stack:** Rust (rusqlite + thiserror + serde + serde_json + chrono), Tauri 2 commands, TypeScript + Vite + xterm.js UI, Vitest for UI tests.

**Scope boundary (from spec §18.1 / §20):** This plan is **MVP A only**. It ships the engine, the 10-badge catalog definitions, the Metrics UI, and exactly one wired emitter. It does **not** touch command-safety policy, provider dispatch, PTY parsing, teammate runtime, or project-memory ranking. Operator/orchestrator compact badges and the remaining fact emitters are MVP B (separate plan). Server sync is deferred (Tier 0 local-only).

**Key MVP-A simplification:** The spec's `AchievementRule` enum is reduced to a single count-based rule: each definition declares one `trigger_kind` (the fact kind that advances it) plus a `min_verification` gate. Sequence rules (red-to-green, "docs before edit") are NOT implemented here — those badges' definitions ship, but their emitters/sequence logic arrive in MVP B. The engine loops every definition matching a fact's `kind`, so multiple badges can share a trigger.

---

## File Structure

**Create (Rust):**
- `crates/score/src/achievements.rs` — serializable types, static catalog, verification ranking, pure tier math, the rule engine entrypoint, metadata allowlisting.
- `crates/score/tests/achievements.rs` — integration tests against the public `ScoreStore` API.

**Create (TS):**
- `ui/src/score/achievements.ts` — typed API wrappers + the Achievements section renderer (pure HTML builders kept exported for testing).
- `ui/src/score/achievements.test.ts` — Vitest tests for the pure HTML builders.

**Modify (Rust):**
- `crates/score/Cargo.toml` — add `serde_json` dependency.
- `crates/score/src/store.rs` — v4 migration; fact insert (dedupe); progress/award upsert + queries; recompute helper.
- `crates/score/src/lib.rs` — `mod achievements;` + re-exports; public `record_achievement_fact` / `recompute_achievements`; wire spec creation → `cartographer` fact.
- `crates/app/src/score_commands.rs` — 6 Tauri command wrappers.
- `crates/app/src/lib.rs` — register the 6 commands.

**Modify (TS):**
- `ui/src/score/page.ts` — add an Achievements card to the template + a render call in `refresh`.
- `ui/src/score/styles.css` — `.cov-ach-*` badge grid + reputation bar styles.

Each file keeps one responsibility: `achievements.rs` is all engine logic and is the single source of truth for catalog/tiers; `store.rs` only gains SQL; `lib.rs` only gains thin public wrappers + one emitter hook.

---

## Task 1: SQLite v4 migration for achievement tables

**Files:**
- Modify: `crates/score/src/store.rs` (the migration function that runs `PRAGMA user_version` upgrades; v3 block is the last one today)
- Test: `crates/score/tests/achievements.rs` (Create)

- [ ] **Step 1: Write the failing test**

Create `crates/score/tests/achievements.rs`:

```rust
use karl_score::ScoreStore;
use tempfile::tempdir;

#[test]
fn open_runs_v4_migration_and_creates_achievement_tables() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    // table_exists is a test-only helper we add on the store.
    assert!(store.table_exists("achievement_facts").unwrap());
    assert!(store.table_exists("achievement_progress").unwrap());
    assert!(store.table_exists("achievement_awards").unwrap());
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-score --test achievements open_runs_v4_migration_and_creates_achievement_tables`
Expected: FAIL — `no method named table_exists` / migration absent.

- [ ] **Step 3: Add the `table_exists` helper and the v4 migration**

In `crates/score/src/store.rs`, add this public helper method to the `impl ScoreStore` block (near the other query methods):

```rust
/// Test/diagnostic helper: does a table exist in the schema?
pub fn table_exists(&self, name: &str) -> Result<bool> {
    let c = self.conn.lock().unwrap();
    let count: i64 = c.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
        params![name],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}
```

Locate the migration function (the one with the existing `if version < 3 { ... }` block and a trailing `PRAGMA user_version = 3`). Immediately after the v3 block — and before/at the final `user_version` set — add:

```rust
if version < 4 {
    c.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS achievement_facts (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          ts_ms          INTEGER NOT NULL,
          day            TEXT NOT NULL,
          kind           TEXT NOT NULL,
          subject_type   TEXT NOT NULL,
          subject_id     TEXT,
          repo           TEXT,
          branch         TEXT,
          group_name     TEXT,
          session_id     TEXT,
          task_id        TEXT,
          verification   TEXT,
          dedupe_key     TEXT UNIQUE,
          metadata_json  TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_achievement_facts_kind
          ON achievement_facts(kind, ts_ms);
        CREATE INDEX IF NOT EXISTS idx_achievement_facts_subject
          ON achievement_facts(subject_type, subject_id, ts_ms);
        CREATE INDEX IF NOT EXISTS idx_achievement_facts_repo
          ON achievement_facts(repo, ts_ms);
        CREATE INDEX IF NOT EXISTS idx_achievement_facts_task
          ON achievement_facts(task_id, kind);

        CREATE TABLE IF NOT EXISTS achievement_progress (
          achievement_id TEXT NOT NULL,
          subject_type   TEXT NOT NULL,
          subject_id     TEXT,
          subject_key    TEXT NOT NULL DEFAULT '',
          scope_type     TEXT NOT NULL,
          scope_id       TEXT,
          scope_key      TEXT NOT NULL DEFAULT '',
          tier           INTEGER NOT NULL DEFAULT 0,
          progress       INTEGER NOT NULL DEFAULT 0,
          target         INTEGER NOT NULL DEFAULT 0,
          updated_at_ms  INTEGER NOT NULL,
          PRIMARY KEY (achievement_id, subject_type, subject_key, scope_type, scope_key)
        );

        CREATE TABLE IF NOT EXISTS achievement_awards (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          achievement_id TEXT NOT NULL,
          tier           INTEGER NOT NULL,
          title          TEXT NOT NULL,
          subject_type   TEXT NOT NULL,
          subject_id     TEXT,
          subject_key    TEXT NOT NULL DEFAULT '',
          scope_type     TEXT NOT NULL,
          scope_id       TEXT,
          scope_key      TEXT NOT NULL DEFAULT '',
          repo           TEXT,
          branch         TEXT,
          earned_at_ms   INTEGER NOT NULL,
          seen_at_ms     INTEGER,
          details_json   TEXT NOT NULL DEFAULT '{}',
          UNIQUE (achievement_id, tier, subject_type, subject_key, scope_type, scope_key)
        );
        ",
    )?;
}
```

Then bump the final version set to `c.pragma_update(None, \"user_version\", 4)?;` (match the exact call style already used for v3 — if the file uses `c.execute(\"PRAGMA user_version = 3\", [])?;`, change that literal to `4`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-score --test achievements open_runs_v4_migration_and_creates_achievement_tables`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/store.rs crates/score/tests/achievements.rs
git commit -m "feat(score): add v4 migration for achievement tables"
```

---

## Task 2: Achievement types + verification ranking (pure)

**Files:**
- Create: `crates/score/src/achievements.rs`
- Modify: `crates/score/Cargo.toml`
- Modify: `crates/score/src/lib.rs` (add `mod achievements;` + re-exports)
- Test: inline `#[cfg(test)]` in `crates/score/src/achievements.rs`

- [ ] **Step 1: Add `serde_json` to the score crate**

In `crates/score/Cargo.toml`, under `[dependencies]`, add (match the version style of sibling deps):

```toml
serde_json = "1"
```

- [ ] **Step 2: Write the failing test (verification ranking + tier math)**

Create `crates/score/src/achievements.rs` with the types and tests. Start by writing only the test module at the bottom — but since the types don't exist yet, write the full type block AND the tests together is not TDD; instead write the test first referencing the API we will build:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verification_rank_orders_levels() {
        assert!(verification_rank(Verification::None) < verification_rank(Verification::CommandPassed));
        assert_eq!(verification_rank(Verification::CommandPassed), verification_rank(Verification::UserAccepted));
        assert!(verification_rank(Verification::ReleaseEvent) > verification_rank(Verification::CommandPassed));
    }

    #[test]
    fn tier_for_progress_picks_highest_reached() {
        let tiers = [1u32, 5, 25, 100, 500];
        assert_eq!(tier_for(&tiers, 0), 0);
        assert_eq!(tier_for(&tiers, 1), 1);
        assert_eq!(tier_for(&tiers, 4), 1);
        assert_eq!(tier_for(&tiers, 5), 2);
        assert_eq!(tier_for(&tiers, 600), 5);
    }

    #[test]
    fn next_target_returns_next_tier_or_caps() {
        let tiers = [1u32, 5, 25, 100, 500];
        assert_eq!(next_target(&tiers, 0), 1);
        assert_eq!(next_target(&tiers, 1), 5);
        assert_eq!(next_target(&tiers, 5), 500); // capped at last
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p karl-score achievements::tests`
Expected: FAIL — module/types/functions not defined.

- [ ] **Step 4: Write the types and pure helpers**

Add to the top of `crates/score/src/achievements.rs` (above the test module):

```rust
//! Achievement engine: serializable types, static catalog, and the pure,
//! deterministic count-based rule engine. This module is the single source of
//! truth for badge definitions and tier targets.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verification {
    None,
    SelfReport,
    CommandPassed,
    UserAccepted,
    CommitObserved,
    ReleaseEvent,
}

impl Verification {
    pub fn as_str(self) -> &'static str {
        match self {
            Verification::None => "none",
            Verification::SelfReport => "self_report",
            Verification::CommandPassed => "command_passed",
            Verification::UserAccepted => "user_accepted",
            Verification::CommitObserved => "commit_observed",
            Verification::ReleaseEvent => "release_event",
        }
    }
}

/// Monotonic rank used only to gate achievements. command_passed,
/// user_accepted, and commit_observed are treated as equivalent "external
/// evidence" (rank 2) per spec §7.
pub fn verification_rank(v: Verification) -> u8 {
    match v {
        Verification::None => 0,
        Verification::SelfReport => 1,
        Verification::CommandPassed | Verification::UserAccepted | Verification::CommitObserved => 2,
        Verification::ReleaseEvent => 3,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AchievementCategory {
    Craft,
    Safety,
    Reliability,
    Orchestration,
    Memory,
    Focus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AchievementRarity {
    Common,
    Uncommon,
    Rare,
    Epic,
    Legendary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubjectKind {
    Operator,
    Orchestrator,
    Project,
    User,
    System,
}

impl SubjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SubjectKind::Operator => "operator",
            SubjectKind::Orchestrator => "orchestrator",
            SubjectKind::Project => "project",
            SubjectKind::User => "user",
            SubjectKind::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    Global,
    Repo,
    Operator,
    Orchestrator,
}

impl ScopeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScopeKind::Global => "global",
            ScopeKind::Repo => "repo",
            ScopeKind::Operator => "operator",
            ScopeKind::Orchestrator => "orchestrator",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Dimension {
    Craft,
    Safety,
    Reliability,
    Orchestration,
    Memory,
    Focus,
}

impl Dimension {
    pub fn as_str(self) -> &'static str {
        match self {
            Dimension::Craft => "craft",
            Dimension::Safety => "safety",
            Dimension::Reliability => "reliability",
            Dimension::Orchestration => "orchestration",
            Dimension::Memory => "memory",
            Dimension::Focus => "focus",
        }
    }
    pub const ALL: [Dimension; 6] = [
        Dimension::Craft,
        Dimension::Safety,
        Dimension::Reliability,
        Dimension::Orchestration,
        Dimension::Memory,
        Dimension::Focus,
    ];
}

/// Points per tier index (1-based tier -> points). Index 0 unused.
pub const TIER_POINTS: [u32; 6] = [0, 10, 25, 60, 150, 400];

#[derive(Debug, Clone)]
pub struct TierDef {
    pub tier: u8,
    pub label: &'static str,
    pub target: u32,
    pub title_unlocked: Option<&'static str>,
}

#[derive(Debug, Clone)]
pub struct Definition {
    pub id: &'static str,
    pub title: &'static str,
    pub summary: &'static str,
    pub category: AchievementCategory,
    pub rarity: AchievementRarity,
    pub subject: SubjectKind,
    pub scope: ScopeKind,
    pub hidden: bool,
    /// The fact kind that advances this achievement (MVP-A count rule).
    pub trigger_kind: &'static str,
    /// Minimum verification level required for the fact to count.
    pub min_verification: Verification,
    pub tiers: &'static [TierDef],
    pub reputation: &'static [Dimension],
}

/// Highest tier (1-based) reached for a given progress count; 0 if none.
pub fn tier_for(targets: &[u32], progress: u32) -> u8 {
    let mut t = 0u8;
    for (i, target) in targets.iter().enumerate() {
        if progress >= *target {
            t = (i + 1) as u8;
        } else {
            break;
        }
    }
    t
}

/// Target count for the tier after `current_tier`; caps at the last target.
pub fn next_target(targets: &[u32], current_tier: u8) -> u32 {
    let idx = current_tier as usize; // next tier's 0-based index
    if idx < targets.len() {
        targets[idx]
    } else {
        *targets.last().unwrap_or(&0)
    }
}
```

- [ ] **Step 5: Wire the module into the crate**

In `crates/score/src/lib.rs`, add near the other `mod`/`pub use` lines:

```rust
mod achievements;
pub use achievements::{
    AchievementCategory, AchievementRarity, Definition as AchievementDefinition, Dimension,
    ScopeKind, SubjectKind, TierDef, Verification,
};
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test -p karl-score achievements::tests`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add crates/score/Cargo.toml crates/score/src/achievements.rs crates/score/src/lib.rs
git commit -m "feat(score): achievement types + verification ranking + tier math"
```

---

## Task 3: Static catalog (10 MVP badges) + serializable DTO

**Files:**
- Modify: `crates/score/src/achievements.rs`
- Test: inline `#[cfg(test)]` in `crates/score/src/achievements.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `achievements.rs`:

```rust
#[test]
fn catalog_has_ten_mvp_badges_with_valid_tiers() {
    let cat = catalog();
    assert_eq!(cat.len(), 10);
    // ids are unique
    let mut ids: Vec<&str> = cat.iter().map(|d| d.id).collect();
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 10);
    // every definition has ascending tier targets and 1..=5 tier numbers
    for d in cat {
        assert!(!d.tiers.is_empty());
        let mut prev = 0u32;
        for (i, t) in d.tiers.iter().enumerate() {
            assert_eq!(t.tier as usize, i + 1);
            assert!(t.target > prev, "{} targets must ascend", d.id);
            prev = t.target;
        }
    }
}

#[test]
fn catalog_serializes_to_json_for_ui() {
    let dtos = catalog_dtos();
    let json = serde_json::to_string(&dtos).unwrap();
    assert!(json.contains("\"clean_run\""));
    assert!(json.contains("\"cartographer\""));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-score achievements::tests::catalog`
Expected: FAIL — `catalog` / `catalog_dtos` not defined.

- [ ] **Step 3: Add the catalog + serializable DTOs**

Add to `achievements.rs` (above the test module). First a small tier-builder macro-free helper using `const` arrays:

```rust
// ---- Tier target presets (spec §6.1) ----
const COMMON: [u32; 5] = [1, 5, 25, 100, 500];
const FINISHER: [u32; 5] = [1, 10, 50, 250, 1000];
const HARD: [u32; 5] = [1, 3, 10, 25, 100];
const MASTERY: [u32; 5] = [1, 3, 10, 30, 100];

const LABELS: [&str; 5] = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];

const fn tiers(targets: &'static [u32; 5], titles: [Option<&'static str>; 5]) -> [TierDef; 5] {
    [
        TierDef { tier: 1, label: LABELS[0], target: targets[0], title_unlocked: titles[0] },
        TierDef { tier: 2, label: LABELS[1], target: targets[1], title_unlocked: titles[1] },
        TierDef { tier: 3, label: LABELS[2], target: targets[2], title_unlocked: titles[2] },
        TierDef { tier: 4, label: LABELS[3], target: targets[3], title_unlocked: titles[3] },
        TierDef { tier: 5, label: LABELS[4], target: targets[4], title_unlocked: titles[4] },
    ]
}

const NO_TITLES: [Option<&str>; 5] = [None, None, None, None, None];

// Static tier arrays (must be `static` so &'static slices are valid).
static T_CLEAN_RUN: [TierDef; 5] = tiers(&COMMON, NO_TITLES);
static T_FINISHER: [TierDef; 5] =
    tiers(&FINISHER, [None, Some("Reliable Finisher"), None, None, None]);
static T_GUARDIAN: [TierDef; 5] =
    tiers(&COMMON, [None, Some("Guardian"), None, None, None]);
static T_SECRET_KEEPER: [TierDef; 5] = tiers(&COMMON, NO_TITLES);
static T_SPEC_KEEPER: [TierDef; 5] =
    tiers(&COMMON, [None, Some("Spec Keeper"), None, None, None]);
static T_BUILD_STEWARD: [TierDef; 5] = tiers(&COMMON, NO_TITLES);
static T_CARTOGRAPHER: [TierDef; 5] =
    tiers(&MASTERY, [None, Some("Cartographer"), None, None, None]);
static T_COMMAND_LIBRARIAN: [TierDef; 5] = tiers(&MASTERY, NO_TITLES);
static T_RECOVERY_ARTIST: [TierDef; 5] =
    tiers(&HARD, [Some("Recovery Artist"), None, None, None, None]);
static T_GOOD_DELEGATE: [TierDef; 5] = tiers(&HARD, NO_TITLES);

use AchievementCategory as C;
use AchievementRarity as R;
use Dimension as D;
use ScopeKind as Sc;
use SubjectKind as Su;
use Verification as V;

/// The full MVP-A catalog. Static, deterministic, the source of truth.
pub fn catalog() -> &'static [Definition] {
    static CATALOG: [Definition; 10] = [
        Definition {
            id: "clean_run",
            title: "Clean Run",
            summary: "Verified task completed with no failed command blocks.",
            category: C::Craft, rarity: R::Uncommon, subject: Su::Operator, scope: Sc::Operator,
            hidden: false, trigger_kind: "clean_run", min_verification: V::CommandPassed,
            tiers: &T_CLEAN_RUN, reputation: &[D::Craft, D::Reliability],
        },
        Definition {
            id: "finisher",
            title: "The Finisher",
            summary: "Task completed with verification or user acceptance.",
            category: C::Reliability, rarity: R::Common, subject: Su::Operator, scope: Sc::Operator,
            hidden: false, trigger_kind: "task_verified", min_verification: V::UserAccepted,
            tiers: &T_FINISHER, reputation: &[D::Reliability],
        },
        Definition {
            id: "guardian",
            title: "Guardian",
            summary: "A risky action was blocked, confirmed, or safely rewritten.",
            category: C::Safety, rarity: R::Rare, subject: Su::System, scope: Sc::Global,
            hidden: false, trigger_kind: "risky_action_handled", min_verification: V::None,
            tiers: &T_GUARDIAN, reputation: &[D::Safety],
        },
        Definition {
            id: "secret_keeper",
            title: "Secret Keeper",
            summary: "Secret-like material was redacted before storage or dispatch.",
            category: C::Safety, rarity: R::Uncommon, subject: Su::System, scope: Sc::Global,
            hidden: false, trigger_kind: "secret_redacted", min_verification: V::None,
            tiers: &T_SECRET_KEEPER, reputation: &[D::Safety],
        },
        Definition {
            id: "spec_keeper",
            title: "Spec Keeper",
            summary: "Read or created a spec before the first code edit in a task.",
            category: C::Craft, rarity: R::Uncommon, subject: Su::Operator, scope: Sc::Repo,
            hidden: false, trigger_kind: "spec_before_edit", min_verification: V::None,
            tiers: &T_SPEC_KEEPER, reputation: &[D::Craft, D::Memory],
        },
        Definition {
            id: "build_steward",
            title: "Build Steward",
            summary: "Build/lint/test command passed after task changes.",
            category: C::Craft, rarity: R::Common, subject: Su::Operator, scope: Sc::Repo,
            hidden: false, trigger_kind: "build_command_passed", min_verification: V::CommandPassed,
            tiers: &T_BUILD_STEWARD, reputation: &[D::Craft],
        },
        Definition {
            id: "cartographer",
            title: "Cartographer",
            summary: "A useful project note/spec/summary was created or updated.",
            category: C::Memory, rarity: R::Common, subject: Su::Project, scope: Sc::Repo,
            hidden: false, trigger_kind: "project_note_created", min_verification: V::None,
            tiers: &T_CARTOGRAPHER, reputation: &[D::Memory],
        },
        Definition {
            id: "command_librarian",
            title: "Command Librarian",
            summary: "A test/build/lint/dev command was learned and stored for the repo.",
            category: C::Memory, rarity: R::Uncommon, subject: Su::Project, scope: Sc::Repo,
            hidden: false, trigger_kind: "project_command_learned", min_verification: V::None,
            tiers: &T_COMMAND_LIBRARIAN, reputation: &[D::Memory, D::Craft],
        },
        Definition {
            id: "recovery_artist",
            title: "Recovery Artist",
            summary: "A failed/blocked task was recovered and later completed.",
            category: C::Orchestration, rarity: R::Rare, subject: Su::Orchestrator, scope: Sc::Global,
            hidden: false, trigger_kind: "task_recovered", min_verification: V::None,
            tiers: &T_RECOVERY_ARTIST, reputation: &[D::Orchestration, D::Reliability],
        },
        Definition {
            id: "good_delegate",
            title: "Good Delegate",
            summary: "Split a larger task into subtasks and delegated at least one successfully.",
            category: C::Orchestration, rarity: R::Uncommon, subject: Su::Orchestrator, scope: Sc::Global,
            hidden: false, trigger_kind: "orchestrator_task_delegated", min_verification: V::None,
            tiers: &T_GOOD_DELEGATE, reputation: &[D::Orchestration],
        },
    ];
    &CATALOG
}

pub fn definition(id: &str) -> Option<&'static Definition> {
    catalog().iter().find(|d| d.id == id)
}

// ---- Serializable DTOs for the UI ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TierDto {
    pub tier: u8,
    pub label: String,
    pub target: u32,
    pub title_unlocked: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefinitionDto {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub category: AchievementCategory,
    pub rarity: AchievementRarity,
    pub subject: SubjectKind,
    pub scope: ScopeKind,
    pub hidden: bool,
    pub min_verification: Verification,
    pub tiers: Vec<TierDto>,
    pub reputation: Vec<Dimension>,
}

impl From<&Definition> for DefinitionDto {
    fn from(d: &Definition) -> Self {
        DefinitionDto {
            id: d.id.to_string(),
            title: d.title.to_string(),
            summary: d.summary.to_string(),
            category: d.category,
            rarity: d.rarity,
            subject: d.subject,
            scope: d.scope,
            hidden: d.hidden,
            min_verification: d.min_verification,
            tiers: d
                .tiers
                .iter()
                .map(|t| TierDto {
                    tier: t.tier,
                    label: t.label.to_string(),
                    target: t.target,
                    title_unlocked: t.title_unlocked.map(|s| s.to_string()),
                })
                .collect(),
            reputation: d.reputation.to_vec(),
        }
    }
}

pub fn catalog_dtos() -> Vec<DefinitionDto> {
    catalog().iter().map(DefinitionDto::from).collect()
}
```

Add to the `pub use achievements::{...}` line in `lib.rs`: `DefinitionDto, TierDto`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-score achievements::tests::catalog`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/achievements.rs crates/score/src/lib.rs
git commit -m "feat(score): static 10-badge MVP catalog + serializable DTOs"
```

---

## Task 4: Metadata allowlisting (privacy)

**Files:**
- Modify: `crates/score/src/achievements.rs`
- Test: inline `#[cfg(test)]`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
#[test]
fn sanitize_metadata_drops_forbidden_keys() {
    let raw = serde_json::json!({
        "command_kind": "test",
        "exit_code": 0,
        "files_changed": 4,
        "operator_id": "athena",
        "risk_kind": "destructive_command",
        "raw_output": "rm -rf / ; sk-secret-LEAK",
        "prompt": "do the thing",
        "ansi": "\u{1b}[31m",
        "file_contents": "...whole file..."
    });
    let clean = sanitize_metadata(&raw);
    let v: serde_json::Value = serde_json::from_str(&clean).unwrap();
    let obj = v.as_object().unwrap();
    assert!(obj.contains_key("command_kind"));
    assert!(obj.contains_key("exit_code"));
    assert!(obj.contains_key("files_changed"));
    assert!(obj.contains_key("operator_id"));
    assert!(obj.contains_key("risk_kind"));
    assert!(!obj.contains_key("raw_output"));
    assert!(!obj.contains_key("prompt"));
    assert!(!obj.contains_key("ansi"));
    assert!(!obj.contains_key("file_contents"));
}

#[test]
fn sanitize_metadata_non_object_becomes_empty() {
    assert_eq!(sanitize_metadata(&serde_json::json!("hello")), "{}");
    assert_eq!(sanitize_metadata(&serde_json::json!(null)), "{}");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-score achievements::tests::sanitize`
Expected: FAIL — `sanitize_metadata` not defined.

- [ ] **Step 3: Implement the allowlist**

Add to `achievements.rs`:

```rust
/// Allowlisted top-level metadata keys (spec §8.3). Anything else is dropped.
pub const METADATA_ALLOWLIST: [&str; 9] = [
    "command_kind",
    "exit_code",
    "files_changed",
    "operator_id",
    "risk_kind",
    "verification",
    "note_id",
    "task_id",
    "language",
];

/// Keep only allowlisted keys from a metadata object; serialize to compact
/// JSON. Non-objects collapse to "{}". Never persist raw output/prompts/secrets.
pub fn sanitize_metadata(value: &serde_json::Value) -> String {
    let mut out = serde_json::Map::new();
    if let Some(obj) = value.as_object() {
        for key in METADATA_ALLOWLIST {
            if let Some(v) = obj.get(key) {
                out.insert(key.to_string(), v.clone());
            }
        }
    }
    serde_json::to_string(&serde_json::Value::Object(out)).unwrap_or_else(|_| "{}".to_string())
}
```

Add `sanitize_metadata, METADATA_ALLOWLIST` to the `pub use achievements::{...}` line in `lib.rs`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-score achievements::tests::sanitize`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/achievements.rs crates/score/src/lib.rs
git commit -m "feat(score): metadata allowlisting for achievement facts"
```

---

## Task 5: Fact input type + scope/subject derivation (pure)

**Files:**
- Modify: `crates/score/src/achievements.rs`
- Test: inline `#[cfg(test)]`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:

```rust
#[test]
fn derive_scope_maps_kinds_to_keys() {
    let fact = AchievementFact {
        ts_ms: 1,
        kind: "x".into(),
        subject_type: "operator".into(),
        subject_id: Some("athena".into()),
        repo: Some("karlTerminal".into()),
        branch: None,
        group_name: None,
        session_id: None,
        task_id: None,
        verification: Verification::None,
        dedupe_key: Some("k".into()),
        metadata: serde_json::json!({}),
    };
    assert_eq!(derive_scope(ScopeKind::Global, &fact), (None, String::new()));
    assert_eq!(
        derive_scope(ScopeKind::Repo, &fact),
        (Some("karlTerminal".into()), "karlTerminal".into())
    );
    assert_eq!(
        derive_scope(ScopeKind::Operator, &fact),
        (Some("athena".into()), "athena".into())
    );
}

#[test]
fn subject_key_uses_subject_id_or_empty() {
    let mut fact = AchievementFact {
        ts_ms: 1, kind: "x".into(), subject_type: "system".into(), subject_id: None,
        repo: None, branch: None, group_name: None, session_id: None, task_id: None,
        verification: Verification::None, dedupe_key: Some("k".into()),
        metadata: serde_json::json!({}),
    };
    assert_eq!(subject_key(&fact), "");
    fact.subject_id = Some("athena".into());
    assert_eq!(subject_key(&fact), "athena");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-score achievements::tests::derive_scope achievements::tests::subject_key`
Expected: FAIL — `AchievementFact` / `derive_scope` / `subject_key` not defined.

- [ ] **Step 3: Implement the fact type + derivation**

Add to `achievements.rs`:

```rust
/// Input to the rule engine. Built by emitters; `metadata` is sanitized on
/// insert. `dedupe_key` should be stable (spec §9.4); if None, the store
/// synthesizes a conservative key.
#[derive(Debug, Clone)]
pub struct AchievementFact {
    pub ts_ms: i64,
    pub kind: String,
    pub subject_type: String,
    pub subject_id: Option<String>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub group_name: Option<String>,
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub verification: Verification,
    pub dedupe_key: Option<String>,
    pub metadata: serde_json::Value,
}

/// Subject key: the non-null DB key for progress/award PKs.
pub fn subject_key(fact: &AchievementFact) -> String {
    fact.subject_id.clone().unwrap_or_default()
}

/// Returns (scope_id, scope_key) for a definition's scope kind given a fact.
pub fn derive_scope(scope: ScopeKind, fact: &AchievementFact) -> (Option<String>, String) {
    match scope {
        ScopeKind::Global => (None, String::new()),
        ScopeKind::Repo => {
            let id = fact.repo.clone();
            let key = id.clone().unwrap_or_default();
            (id, key)
        }
        ScopeKind::Operator | ScopeKind::Orchestrator => {
            let id = fact.subject_id.clone();
            let key = id.clone().unwrap_or_default();
            (id, key)
        }
    }
}
```

Add `AchievementFact` to the `pub use achievements::{...}` line in `lib.rs`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-score achievements::tests`
Expected: PASS (all achievements unit tests).

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/achievements.rs crates/score/src/lib.rs
git commit -m "feat(score): achievement fact type + scope/subject derivation"
```

---

## Task 6: Store — fact insert with dedupe + progress/award rows

**Files:**
- Modify: `crates/score/src/store.rs`
- Modify: `crates/score/src/achievements.rs` (add award DTO + progress row struct)
- Test: `crates/score/tests/achievements.rs`

- [ ] **Step 1: Add the persisted DTOs**

In `achievements.rs`, add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressRow {
    pub achievement_id: String,
    pub subject_type: String,
    pub subject_id: Option<String>,
    pub scope_type: String,
    pub scope_id: Option<String>,
    pub tier: u8,
    pub progress: u32,
    pub target: u32,
    pub next_tier: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AwardRow {
    pub id: i64,
    pub achievement_id: String,
    pub tier: u8,
    pub title: String,
    pub subject_type: String,
    pub subject_id: Option<String>,
    pub scope_type: String,
    pub scope_id: Option<String>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub earned_at_ms: i64,
    pub seen_at_ms: Option<i64>,
}
```

Add `ProgressRow, AwardRow` to the `pub use achievements::{...}` line in `lib.rs`.

- [ ] **Step 2: Write the failing test (dedupe + single award)**

Add to `crates/score/tests/achievements.rs`:

```rust
use karl_score::{AchievementFact, Verification};
use serde_json::json;

fn fact(kind: &str, subject: &str, dk: &str, v: Verification) -> AchievementFact {
    AchievementFact {
        ts_ms: 1_700_000_000_000,
        kind: kind.into(),
        subject_type: "operator".into(),
        subject_id: Some(subject.into()),
        repo: Some("karlTerminal".into()),
        branch: Some("main".into()),
        group_name: None,
        session_id: Some("sess1".into()),
        task_id: Some("task1".into()),
        verification: v,
        dedupe_key: Some(dk.into()),
        metadata: json!({"operator_id": subject, "raw_output": "SECRET"}),
    }
}

#[test]
fn first_finisher_fact_awards_tier_one_and_dedupes() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();

    let awards = store
        .record_achievement_fact(&fact("task_verified", "athena", "task_verified:task1:athena", Verification::UserAccepted))
        .unwrap();
    assert_eq!(awards.len(), 1);
    assert_eq!(awards[0].achievement_id, "finisher");
    assert_eq!(awards[0].tier, 1);

    // duplicate dedupe_key -> no fact, no new award
    let again = store
        .record_achievement_fact(&fact("task_verified", "athena", "task_verified:task1:athena", Verification::UserAccepted))
        .unwrap();
    assert!(again.is_empty());

    // stored metadata must not contain forbidden keys
    let metas = store.debug_fact_metadata("finisher_check").unwrap_or_default();
    // (helper added below queries by dedupe; here we just assert via awards/progress)
    let prog = store.achievement_progress(None).unwrap();
    let finisher = prog.iter().find(|p| p.achievement_id == "finisher").unwrap();
    assert_eq!(finisher.progress, 1);
    assert_eq!(finisher.tier, 1);
    let _ = metas;
}

#[test]
fn verification_gate_blocks_low_evidence_facts() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    // finisher requires user_accepted (rank 2); self_report (rank 1) must not count
    let awards = store
        .record_achievement_fact(&fact("task_verified", "athena", "dk1", Verification::SelfReport))
        .unwrap();
    assert!(awards.is_empty());
    let prog = store.achievement_progress(None).unwrap();
    assert!(prog.iter().all(|p| p.achievement_id != "finisher"));
}
```

> Note: remove the `debug_fact_metadata` line if you don't add that helper; the metadata-allowlist guarantee is already unit-tested in Task 4. Keep the test focused on awards/progress.

Simplify the first test's tail to drop `debug_fact_metadata`:

```rust
    let prog = store.achievement_progress(None).unwrap();
    let finisher = prog.iter().find(|p| p.achievement_id == "finisher").unwrap();
    assert_eq!(finisher.progress, 1);
    assert_eq!(finisher.tier, 1);
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p karl-score --test achievements first_finisher_fact`
Expected: FAIL — `record_achievement_fact` / `achievement_progress` not defined.

- [ ] **Step 4: Implement the engine in `store.rs`**

Add `use crate::achievements::{self, AchievementFact, AwardRow, ProgressRow};` to the top of `store.rs` (alongside existing `use crate::...`). Then add to `impl ScoreStore`:

```rust
/// Record an achievement fact and advance any matching definitions.
/// Idempotent on `dedupe_key`. Returns awards newly earned by this fact.
pub fn record_achievement_fact(&self, fact: &AchievementFact) -> Result<Vec<AwardRow>> {
    let inserted = self.insert_achievement_fact(fact)?;
    if !inserted {
        return Ok(Vec::new());
    }
    self.advance_for_fact(fact)
}

/// Insert the fact row; returns false if a duplicate dedupe_key was ignored.
fn insert_achievement_fact(&self, fact: &AchievementFact) -> Result<bool> {
    let day = day_from_ms_local(fact.ts_ms);
    let dedupe = fact.dedupe_key.clone().unwrap_or_else(|| {
        format!(
            "{}:{}:{}",
            fact.kind,
            fact.subject_id.as_deref().unwrap_or("-"),
            fact.ts_ms
        )
    });
    let meta = achievements::sanitize_metadata(&fact.metadata);
    let c = self.conn.lock().unwrap();
    let rows = c.execute(
        "INSERT OR IGNORE INTO achievement_facts
         (ts_ms, day, kind, subject_type, subject_id, repo, branch, group_name,
          session_id, task_id, verification, dedupe_key, metadata_json)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![
            fact.ts_ms,
            day,
            fact.kind,
            fact.subject_type,
            fact.subject_id,
            fact.repo,
            fact.branch,
            fact.group_name,
            fact.session_id,
            fact.task_id,
            fact.verification.as_str(),
            dedupe,
            meta,
        ],
    )?;
    Ok(rows > 0)
}

/// Evaluate every definition whose trigger matches the fact and whose
/// verification gate is satisfied; bump progress and insert crossed-tier awards.
fn advance_for_fact(&self, fact: &AchievementFact) -> Result<Vec<AwardRow>> {
    let mut new_awards = Vec::new();
    for def in achievements::catalog() {
        if def.trigger_kind != fact.kind {
            continue;
        }
        if achievements::verification_rank(fact.verification)
            < achievements::verification_rank(def.min_verification)
        {
            continue;
        }
        let subj_key = achievements::subject_key(fact);
        let (scope_id, scope_key) = achievements::derive_scope(def.scope, fact);
        let targets: Vec<u32> = def.tiers.iter().map(|t| t.target).collect();

        // read prior progress/tier
        let (prev_progress, prev_tier) = self.read_progress(
            def.id,
            fact.subject_type.as_str(),
            &subj_key,
            def.scope.as_str(),
            &scope_key,
        )?;
        let new_progress = prev_progress + 1;
        let new_tier = achievements::tier_for(&targets, new_progress);
        let target = achievements::next_target(&targets, new_tier);

        self.upsert_progress(
            def.id,
            &fact.subject_type,
            fact.subject_id.as_deref(),
            &subj_key,
            def.scope.as_str(),
            scope_id.as_deref(),
            &scope_key,
            new_tier,
            new_progress,
            target,
            fact.ts_ms,
        )?;

        if new_tier > prev_tier {
            for t in (prev_tier + 1)..=new_tier {
                let tier_def = &def.tiers[(t - 1) as usize];
                let title = tier_def.title_unlocked.unwrap_or(def.title);
                if let Some(award) = self.insert_award(
                    def.id,
                    t,
                    title,
                    &fact.subject_type,
                    fact.subject_id.as_deref(),
                    &subj_key,
                    def.scope.as_str(),
                    scope_id.as_deref(),
                    &scope_key,
                    fact.repo.as_deref(),
                    fact.branch.as_deref(),
                    fact.ts_ms,
                )? {
                    new_awards.push(award);
                }
            }
        }
    }
    Ok(new_awards)
}

fn read_progress(
    &self,
    achievement_id: &str,
    subject_type: &str,
    subject_key: &str,
    scope_type: &str,
    scope_key: &str,
) -> Result<(u32, u8)> {
    let c = self.conn.lock().unwrap();
    let row = c
        .query_row(
            "SELECT progress, tier FROM achievement_progress
             WHERE achievement_id=?1 AND subject_type=?2 AND subject_key=?3
               AND scope_type=?4 AND scope_key=?5",
            params![achievement_id, subject_type, subject_key, scope_type, scope_key],
            |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, i64>(1)? as u8)),
        )
        .optional()?;
    Ok(row.unwrap_or((0, 0)))
}

#[allow(clippy::too_many_arguments)]
fn upsert_progress(
    &self,
    achievement_id: &str,
    subject_type: &str,
    subject_id: Option<&str>,
    subject_key: &str,
    scope_type: &str,
    scope_id: Option<&str>,
    scope_key: &str,
    tier: u8,
    progress: u32,
    target: u32,
    now_ms: i64,
) -> Result<()> {
    let c = self.conn.lock().unwrap();
    c.execute(
        "INSERT INTO achievement_progress
         (achievement_id, subject_type, subject_id, subject_key,
          scope_type, scope_id, scope_key, tier, progress, target, updated_at_ms)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(achievement_id, subject_type, subject_key, scope_type, scope_key)
         DO UPDATE SET tier=?8, progress=?9, target=?10, updated_at_ms=?11",
        params![
            achievement_id, subject_type, subject_id, subject_key,
            scope_type, scope_id, scope_key, tier as i64, progress as i64, target as i64, now_ms
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_award(
    &self,
    achievement_id: &str,
    tier: u8,
    title: &str,
    subject_type: &str,
    subject_id: Option<&str>,
    subject_key: &str,
    scope_type: &str,
    scope_id: Option<&str>,
    scope_key: &str,
    repo: Option<&str>,
    branch: Option<&str>,
    now_ms: i64,
) -> Result<Option<AwardRow>> {
    let c = self.conn.lock().unwrap();
    let rows = c.execute(
        "INSERT OR IGNORE INTO achievement_awards
         (achievement_id, tier, title, subject_type, subject_id, subject_key,
          scope_type, scope_id, scope_key, repo, branch, earned_at_ms)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![
            achievement_id, tier as i64, title, subject_type, subject_id, subject_key,
            scope_type, scope_id, scope_key, repo, branch, now_ms
        ],
    )?;
    if rows == 0 {
        return Ok(None);
    }
    let id = c.last_insert_rowid();
    Ok(Some(AwardRow {
        id,
        achievement_id: achievement_id.to_string(),
        tier,
        title: title.to_string(),
        subject_type: subject_type.to_string(),
        subject_id: subject_id.map(|s| s.to_string()),
        scope_type: scope_type.to_string(),
        scope_id: scope_id.map(|s| s.to_string()),
        repo: repo.map(|s| s.to_string()),
        branch: branch.map(|s| s.to_string()),
        earned_at_ms: now_ms,
        seen_at_ms: None,
    }))
}
```

> If `optional()` is not in scope, add `use rusqlite::OptionalExtension;` to `store.rs` (it is the standard import for `.optional()`).

We still need `achievement_progress(None)` for the test — implement the query in Task 7. For now, to make THIS task's test compile, also add the minimal query (it belongs logically with Task 7 but the test references it):

```rust
/// All progress rows, optionally filtered by subject_id.
pub fn achievement_progress(&self, subject_id: Option<&str>) -> Result<Vec<ProgressRow>> {
    let c = self.conn.lock().unwrap();
    let mut stmt = c.prepare(
        "SELECT achievement_id, subject_type, subject_id, scope_type, scope_id,
                tier, progress, target
         FROM achievement_progress
         WHERE (?1 IS NULL OR subject_id = ?1)
         ORDER BY achievement_id",
    )?;
    let rows = stmt
        .query_map(params![subject_id], |r| {
            let tier: i64 = r.get(5)?;
            Ok(ProgressRow {
                achievement_id: r.get(0)?,
                subject_type: r.get(1)?,
                subject_id: r.get(2)?,
                scope_type: r.get(3)?,
                scope_id: r.get(4)?,
                tier: tier as u8,
                progress: r.get::<_, i64>(6)? as u32,
                target: r.get::<_, i64>(7)? as u32,
                next_tier: if tier >= 5 { None } else { Some(tier as u8 + 1) },
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p karl-score --test achievements`
Expected: PASS (all integration tests so far).

- [ ] **Step 6: Commit**

```bash
git add crates/score/src/store.rs crates/score/src/achievements.rs crates/score/src/lib.rs crates/score/tests/achievements.rs
git commit -m "feat(score): count-based rule engine with dedupe + tiered awards"
```

---

## Task 7: Store — summary, awards, mark-seen queries

**Files:**
- Modify: `crates/score/src/store.rs`
- Modify: `crates/score/src/achievements.rs` (add `SummaryDto`, `ReputationBar`)
- Test: `crates/score/tests/achievements.rs`

- [ ] **Step 1: Add summary DTOs**

In `achievements.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReputationBar {
    pub dimension: String,
    pub points: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AchievementSummary {
    pub total_awards: u32,
    pub highlighted_title: Option<String>,
    pub rare_count: u32,
    pub reputation: Vec<ReputationBar>,
}

/// Compute reputation points + highlighted title from a set of awards.
/// Points for a tier are split evenly across the definition's dimensions.
pub fn summarize(awards: &[AwardRow]) -> AchievementSummary {
    use std::collections::HashMap;
    let mut points: HashMap<&'static str, u32> = HashMap::new();
    let mut rare_count = 0u32;
    let mut best: Option<(u32, String)> = None; // (points-at-award, title)

    for a in awards {
        let Some(def) = definition(&a.achievement_id) else { continue };
        if matches!(def.rarity, AchievementRarity::Rare | AchievementRarity::Epic | AchievementRarity::Legendary) {
            rare_count += 1;
        }
        let tier_pts = TIER_POINTS.get(a.tier as usize).copied().unwrap_or(0);
        let dims = def.reputation;
        if !dims.is_empty() {
            let share = tier_pts / dims.len() as u32;
            for d in dims {
                *points.entry(d.as_str()).or_insert(0) += share;
            }
        }
        // a title is "highlighted" if this tier unlocked one; pick the highest-point one
        if let Some(tier_def) = def.tiers.get((a.tier as usize).saturating_sub(1)) {
            if let Some(title) = tier_def.title_unlocked {
                if best.as_ref().map(|(p, _)| tier_pts > *p).unwrap_or(true) {
                    best = Some((tier_pts, title.to_string()));
                }
            }
        }
    }

    let reputation = Dimension::ALL
        .iter()
        .map(|d| ReputationBar {
            dimension: d.as_str().to_string(),
            points: points.get(d.as_str()).copied().unwrap_or(0),
        })
        .collect();

    AchievementSummary {
        total_awards: awards.len() as u32,
        highlighted_title: best.map(|(_, t)| t),
        rare_count,
        reputation,
    }
}
```

Add `AchievementSummary, ReputationBar` to the `pub use achievements::{...}` line in `lib.rs`.

- [ ] **Step 2: Write the failing test**

Add to `crates/score/tests/achievements.rs`:

```rust
#[test]
fn summary_and_awards_and_mark_seen() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();

    // earn finisher tier I and II (targets 1, 10 -> need 10 facts; we force via 10 distinct dedupe keys)
    for i in 0..10 {
        store
            .record_achievement_fact(&fact(
                "task_verified",
                "athena",
                &format!("dk{i}"),
                Verification::UserAccepted,
            ))
            .unwrap();
    }

    let awards = store.achievement_awards(None).unwrap();
    // tier I at progress 1, tier II at progress 10
    assert!(awards.iter().any(|a| a.achievement_id == "finisher" && a.tier == 1));
    assert!(awards.iter().any(|a| a.achievement_id == "finisher" && a.tier == 2));

    let summary = store.achievement_summary().unwrap();
    assert_eq!(summary.highlighted_title.as_deref(), Some("Reliable Finisher"));
    let rel = summary.reputation.iter().find(|r| r.dimension == "reliability").unwrap();
    assert!(rel.points > 0);

    // mark the first award seen
    let first = awards[0].id;
    assert!(awards[0].seen_at_ms.is_none());
    store.achievement_mark_seen(first, 123).unwrap();
    let after = store.achievement_awards(None).unwrap();
    assert_eq!(after.iter().find(|a| a.id == first).unwrap().seen_at_ms, Some(123));
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p karl-score --test achievements summary_and_awards`
Expected: FAIL — `achievement_awards` / `achievement_summary` / `achievement_mark_seen` not defined.

- [ ] **Step 4: Implement the queries in `store.rs`**

```rust
/// All award rows, optionally filtered by subject_id, newest first.
pub fn achievement_awards(&self, subject_id: Option<&str>) -> Result<Vec<AwardRow>> {
    let c = self.conn.lock().unwrap();
    let mut stmt = c.prepare(
        "SELECT id, achievement_id, tier, title, subject_type, subject_id,
                scope_type, scope_id, repo, branch, earned_at_ms, seen_at_ms
         FROM achievement_awards
         WHERE (?1 IS NULL OR subject_id = ?1)
         ORDER BY earned_at_ms DESC, id DESC",
    )?;
    let rows = stmt
        .query_map(params![subject_id], |r| {
            Ok(AwardRow {
                id: r.get(0)?,
                achievement_id: r.get(1)?,
                tier: r.get::<_, i64>(2)? as u8,
                title: r.get(3)?,
                subject_type: r.get(4)?,
                subject_id: r.get(5)?,
                scope_type: r.get(6)?,
                scope_id: r.get(7)?,
                repo: r.get(8)?,
                branch: r.get(9)?,
                earned_at_ms: r.get(10)?,
                seen_at_ms: r.get(11)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Summary across all awards (reputation bars, highlighted title, counts).
pub fn achievement_summary(&self) -> Result<achievements::AchievementSummary> {
    let awards = self.achievement_awards(None)?;
    Ok(achievements::summarize(&awards))
}

/// Mark a single award as seen (for toast de-duplication).
pub fn achievement_mark_seen(&self, award_id: i64, now_ms: i64) -> Result<()> {
    let c = self.conn.lock().unwrap();
    c.execute(
        "UPDATE achievement_awards SET seen_at_ms=?2 WHERE id=?1",
        params![award_id, now_ms],
    )?;
    Ok(())
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p karl-score --test achievements summary_and_awards`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/score/src/store.rs crates/score/src/achievements.rs crates/score/src/lib.rs crates/score/tests/achievements.rs
git commit -m "feat(score): achievement summary/awards/mark-seen queries"
```

---

## Task 8: Store — recompute from facts (idempotent, preserves timeline)

**Files:**
- Modify: `crates/score/src/store.rs`
- Test: `crates/score/tests/achievements.rs`

- [ ] **Step 1: Write the failing test**

Add to `crates/score/tests/achievements.rs`:

```rust
#[test]
fn recompute_is_idempotent_and_preserves_award_ids() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    for i in 0..5 {
        store
            .record_achievement_fact(&fact(
                "task_verified",
                "athena",
                &format!("rk{i}"),
                Verification::UserAccepted,
            ))
            .unwrap();
    }
    let before = store.achievement_awards(None).unwrap();
    let before_ids: Vec<i64> = before.iter().map(|a| a.id).collect();

    store.recompute_achievements().unwrap();

    let after = store.achievement_awards(None).unwrap();
    let after_ids: Vec<i64> = after.iter().map(|a| a.id).collect();
    // award rows are not duplicated and ids are preserved
    assert_eq!(before_ids, after_ids);

    // progress matches replayed facts (5 task_verified -> finisher progress 5, tier 1)
    let prog = store.achievement_progress(None).unwrap();
    let f = prog.iter().find(|p| p.achievement_id == "finisher").unwrap();
    assert_eq!(f.progress, 5);
    assert_eq!(f.tier, 1);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-score --test achievements recompute_is_idempotent`
Expected: FAIL — `recompute_achievements` not defined.

- [ ] **Step 3: Implement recompute**

Recompute clears progress (recomputable), replays facts to rebuild progress, and lets the award `UNIQUE` constraint keep existing award rows (preserving ids + `earned_at_ms`). New tiers crossed during replay still insert.

```rust
/// Recompute progress from all stored facts. Award rows are preserved (their
/// UNIQUE constraint dedups), so the earned timeline and ids are stable.
pub fn recompute_achievements(&self) -> Result<()> {
    // 1) wipe progress (it is derivable)
    {
        let c = self.conn.lock().unwrap();
        c.execute("DELETE FROM achievement_progress", [])?;
    }
    // 2) replay facts oldest-first, reusing the same advance logic
    let facts = self.all_facts_for_replay()?;
    for f in facts {
        // advance_for_fact reads progress, bumps it, and INSERT-OR-IGNOREs awards
        let _ = self.advance_for_fact(&f)?;
    }
    Ok(())
}

/// Load all facts as AchievementFact for replay (oldest first).
fn all_facts_for_replay(&self) -> Result<Vec<AchievementFact>> {
    let c = self.conn.lock().unwrap();
    let mut stmt = c.prepare(
        "SELECT ts_ms, kind, subject_type, subject_id, repo, branch, group_name,
                session_id, task_id, verification, dedupe_key, metadata_json
         FROM achievement_facts ORDER BY ts_ms ASC, id ASC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            let verification_s: Option<String> = r.get(9)?;
            let v = parse_verification(verification_s.as_deref());
            let meta_s: String = r.get(11)?;
            let metadata: serde_json::Value =
                serde_json::from_str(&meta_s).unwrap_or_else(|_| serde_json::json!({}));
            Ok(AchievementFact {
                ts_ms: r.get(0)?,
                kind: r.get(1)?,
                subject_type: r.get(2)?,
                subject_id: r.get(3)?,
                repo: r.get(4)?,
                branch: r.get(5)?,
                group_name: r.get(6)?,
                session_id: r.get(7)?,
                task_id: r.get(8)?,
                verification: v,
                dedupe_key: r.get(10)?,
                metadata,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}
```

Add a free helper near the top of `store.rs` (or in `achievements.rs` and import it):

```rust
fn parse_verification(s: Option<&str>) -> crate::achievements::Verification {
    use crate::achievements::Verification as V;
    match s {
        Some("self_report") => V::SelfReport,
        Some("command_passed") => V::CommandPassed,
        Some("user_accepted") => V::UserAccepted,
        Some("commit_observed") => V::CommitObserved,
        Some("release_event") => V::ReleaseEvent,
        _ => V::None,
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-score --test achievements recompute_is_idempotent`
Expected: PASS.

- [ ] **Step 5: Run the full score test suite**

Run: `cargo test -p karl-score`
Expected: PASS (existing + all achievement tests). Confirms existing Score behavior is unchanged.

- [ ] **Step 6: Commit**

```bash
git add crates/score/src/store.rs crates/score/tests/achievements.rs
git commit -m "feat(score): idempotent achievement recompute preserving award timeline"
```

---

## Task 9: Public lib API + wire one real emitter (spec → cartographer)

**Files:**
- Modify: `crates/score/src/lib.rs`
- Modify: `crates/score/tests/achievements.rs`

- [ ] **Step 1: Write the failing test (public emitter + spec hook)**

Add to `crates/score/tests/achievements.rs`:

```rust
#[test]
fn record_project_note_fact_advances_cartographer() {
    use karl_score::record_achievement_fact_for_test;
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    let awards = record_achievement_fact_for_test(
        &store,
        &fact("project_note_created", "karlTerminal", "note:/repo:n1", Verification::None),
    )
    .unwrap();
    assert!(awards.iter().any(|a| a.achievement_id == "cartographer" && a.tier == 1));
}
```

> Why a `_for_test` shim: the production emitter goes through the global recorder slot (`slot()`), which is process-global and awkward in tests. The shim records directly against a provided store, exercising the same `record_achievement_fact` path.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-score --test achievements record_project_note_fact`
Expected: FAIL — `record_achievement_fact_for_test` not defined.

- [ ] **Step 3: Add public API to `lib.rs`**

Add to `crates/score/src/lib.rs`:

```rust
use crate::achievements::AchievementFact;

/// Public emitter used by all fact sources. Routes through the global score
/// store slot. Awards are dropped here (MVP A has no toast wiring yet — that
/// is MVP B). Failures are logged, never propagated.
pub fn record_achievement_fact(fact: &AchievementFact) {
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            if let Err(e) = store.record_achievement_fact(fact) {
                tracing::warn!(target: "score", error = %e, kind = %fact.kind, "record_achievement_fact failed");
            }
        }
    }
}

/// Dev/diagnostic recompute over the global store.
pub fn recompute_achievements() {
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            if let Err(e) = store.recompute_achievements() {
                tracing::warn!(target: "score", error = %e, "recompute_achievements failed");
            }
        }
    }
}

/// Test-only shim: record a fact directly against a given store.
pub fn record_achievement_fact_for_test(
    store: &ScoreStore,
    fact: &AchievementFact,
) -> Result<Vec<crate::achievements::AwardRow>, ScoreError> {
    store.record_achievement_fact(fact)
}
```

> Match `slot()` / `ScoreError` / `Result` to the names actually used in `lib.rs`. If `ScoreError` is re-exported from `store`, import accordingly.

- [ ] **Step 4: Wire the spec-creation emitter**

Find where spec creation is recorded today (the path that calls `store.append_spec(...)` and returns `true` for a newly-created spec — likely `record_spec*` in `lib.rs` or the `spec_watcher`). At the point a NEW spec row is confirmed inserted, emit a `project_note_created` fact. Add right after the successful `append_spec` returns `true`:

```rust
// Achievement fact: a new spec/note contributes to Cartographer (project memory).
if newly_created {
    let ctx = /* the same Context already resolved above */;
    let dedupe = format!("project_note_created:{}:{}", ctx.repo.as_deref().unwrap_or("-"), path);
    record_achievement_fact(&AchievementFact {
        ts_ms: now,
        kind: "project_note_created".into(),
        subject_type: "project".into(),
        subject_id: ctx.repo.clone(),
        repo: ctx.repo.clone(),
        branch: ctx.branch.clone(),
        group_name: ctx.group_name.clone(),
        session_id: None,
        task_id: None,
        verification: crate::achievements::Verification::None,
        dedupe_key: Some(dedupe),
        metadata: serde_json::json!({ "note_id": path }),
    });
}
```

> Adapt variable names (`now`, `ctx`, `path`, `newly_created`) to the actual spec-recording function. The key requirement: emit exactly once per newly-created spec, keyed by repo + path so re-scans don't double-count.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p karl-score --test achievements record_project_note_fact`
Expected: PASS.

- [ ] **Step 6: Run the full crate build + tests**

Run: `cargo test -p karl-score && cargo build -p karl-score`
Expected: PASS / build clean.

- [ ] **Step 7: Commit**

```bash
git add crates/score/src/lib.rs crates/score/tests/achievements.rs
git commit -m "feat(score): public achievement emitter + wire spec creation to cartographer"
```

---

## Task 10: Tauri commands

**Files:**
- Modify: `crates/app/src/score_commands.rs`
- Modify: `crates/app/src/lib.rs` (register handlers)
- Test: manual (compile + invoke from UI in Task 12)

- [ ] **Step 1: Add the command wrappers**

In `crates/app/src/score_commands.rs`, add imports for the new types and these commands (mirror the existing `score_summary` pattern exactly):

```rust
use karl_score::{
    AchievementSummary, AwardRow, DefinitionDto, ProgressRow,
};

#[tauri::command]
pub fn score_achievement_catalog() -> Vec<DefinitionDto> {
    karl_score::achievement_catalog_dtos()
}

#[tauri::command]
pub fn score_achievement_summary(state: State<'_, ScoreState>) -> Result<AchievementSummary, String> {
    state.0.achievement_summary().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_achievement_progress(
    state: State<'_, ScoreState>,
    subject_id: Option<String>,
) -> Result<Vec<ProgressRow>, String> {
    state
        .0
        .achievement_progress(subject_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_achievement_awards(
    state: State<'_, ScoreState>,
    subject_id: Option<String>,
) -> Result<Vec<AwardRow>, String> {
    state
        .0
        .achievement_awards(subject_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_achievement_mark_seen(
    state: State<'_, ScoreState>,
    award_id: i64,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    state
        .0
        .achievement_mark_seen(award_id, now)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_achievement_recompute(state: State<'_, ScoreState>) -> Result<(), String> {
    state.0.recompute_achievements().map_err(|e| e.to_string())
}
```

`score_achievement_catalog` needs a free function in `karl_score`. Add to `crates/score/src/lib.rs`:

```rust
/// Serialized catalog for the UI (copy + targets, single source of truth).
pub fn achievement_catalog_dtos() -> Vec<crate::achievements::DefinitionDto> {
    crate::achievements::catalog_dtos()
}
```

> `chrono` is already a dependency of the app crate (used elsewhere). If not imported in this file, add `use chrono;` or call `karl_score`'s time helper if one exists.

- [ ] **Step 2: Register the commands**

In `crates/app/src/lib.rs`, inside the `tauri::generate_handler![...]` block (next to the other `score_commands::*` entries), add:

```rust
            score_commands::score_achievement_catalog,
            score_commands::score_achievement_summary,
            score_commands::score_achievement_progress,
            score_commands::score_achievement_awards,
            score_commands::score_achievement_mark_seen,
            score_commands::score_achievement_recompute,
```

- [ ] **Step 3: Build the app crate**

Run: `cargo build -p karl-app`
Expected: compiles cleanly (no unused-import or missing-symbol errors).

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/score_commands.rs crates/app/src/lib.rs crates/score/src/lib.rs
git commit -m "feat(app): Tauri commands for achievement catalog/summary/progress/awards"
```

---

## Task 11: Frontend API wrappers + pure HTML builders (with tests)

**Files:**
- Create: `ui/src/score/achievements.ts`
- Create: `ui/src/score/achievements.test.ts`

- [ ] **Step 1: Write the failing test (pure builders)**

Create `ui/src/score/achievements.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { tierLabel, badgeCardHtml, type AchievementAward, type AchievementDefinition } from "./achievements";

const def: AchievementDefinition = {
  id: "finisher",
  title: "The Finisher",
  summary: "Task completed with verification or user acceptance.",
  category: "reliability",
  rarity: "common",
  subject: "operator",
  scope: "operator",
  hidden: false,
  min_verification: "user_accepted",
  tiers: [
    { tier: 1, label: "Bronze", target: 1, title_unlocked: null },
    { tier: 2, label: "Silver", target: 10, title_unlocked: "Reliable Finisher" },
  ],
  reputation: ["reliability"],
};

const award: AchievementAward = {
  id: 1,
  achievement_id: "finisher",
  tier: 2,
  title: "Reliable Finisher",
  subject_type: "operator",
  subject_id: "athena",
  scope_type: "operator",
  scope_id: "athena",
  repo: "karlTerminal",
  branch: "main",
  earned_at_ms: 1_700_000_000_000,
  seen_at_ms: null,
};

describe("tierLabel", () => {
  it("maps tier numbers to roman labels", () => {
    expect(tierLabel(1)).toBe("I");
    expect(tierLabel(2)).toBe("II");
    expect(tierLabel(5)).toBe("V");
    expect(tierLabel(0)).toBe("");
  });
});

describe("badgeCardHtml", () => {
  it("renders the definition title and earned tier", () => {
    const html = badgeCardHtml(def, award);
    expect(html).toContain("The Finisher");
    expect(html).toContain("II");
    expect(html).toContain("cov-ach-card");
  });

  it("masks hidden unearned badges", () => {
    const hidden = { ...def, hidden: true };
    const html = badgeCardHtml(hidden, undefined);
    expect(html).toContain("Hidden");
    expect(html).not.toContain("The Finisher");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npm test -- achievements`
Expected: FAIL — module `./achievements` not found.

- [ ] **Step 3: Implement `achievements.ts`**

Create `ui/src/score/achievements.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export type AchievementCategory =
  | "craft" | "safety" | "reliability" | "orchestration" | "memory" | "focus";
export type AchievementRarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export type SubjectKind = "operator" | "orchestrator" | "project" | "user" | "system";
export type ScopeKind = "global" | "repo" | "operator" | "orchestrator";
export type Dimension =
  | "craft" | "safety" | "reliability" | "orchestration" | "memory" | "focus";
export type Verification =
  | "none" | "self_report" | "command_passed" | "user_accepted" | "commit_observed" | "release_event";

export interface AchievementTier {
  tier: number;
  label: string;
  target: number;
  title_unlocked: string | null;
}

export interface AchievementDefinition {
  id: string;
  title: string;
  summary: string;
  category: AchievementCategory;
  rarity: AchievementRarity;
  subject: SubjectKind;
  scope: ScopeKind;
  hidden: boolean;
  min_verification: Verification;
  tiers: AchievementTier[];
  reputation: Dimension[];
}

export interface AchievementProgress {
  achievement_id: string;
  subject_type: string;
  subject_id: string | null;
  scope_type: string;
  scope_id: string | null;
  tier: number;
  progress: number;
  target: number;
  next_tier: number | null;
}

export interface AchievementAward {
  id: number;
  achievement_id: string;
  tier: number;
  title: string;
  subject_type: string;
  subject_id: string | null;
  scope_type: string;
  scope_id: string | null;
  repo: string | null;
  branch: string | null;
  earned_at_ms: number;
  seen_at_ms: number | null;
}

export interface ReputationBar {
  dimension: string;
  points: number;
}

export interface AchievementSummary {
  total_awards: number;
  highlighted_title: string | null;
  rare_count: number;
  reputation: ReputationBar[];
}

// ---- API wrappers ----

export async function scoreAchievementCatalog(): Promise<AchievementDefinition[]> {
  return invoke<AchievementDefinition[]>("score_achievement_catalog");
}
export async function scoreAchievementSummary(): Promise<AchievementSummary> {
  return invoke<AchievementSummary>("score_achievement_summary");
}
export async function scoreAchievementProgress(subjectId?: string): Promise<AchievementProgress[]> {
  return invoke<AchievementProgress[]>("score_achievement_progress", { subjectId: subjectId ?? null });
}
export async function scoreAchievementAwards(subjectId?: string): Promise<AchievementAward[]> {
  return invoke<AchievementAward[]>("score_achievement_awards", { subjectId: subjectId ?? null });
}
export async function scoreAchievementMarkSeen(awardId: number): Promise<void> {
  return invoke<void>("score_achievement_mark_seen", { awardId });
}
export async function scoreAchievementRecompute(): Promise<void> {
  return invoke<void>("score_achievement_recompute");
}

// ---- Pure HTML builders (tested) ----

const ROMAN = ["", "I", "II", "III", "IV", "V"];
export function tierLabel(tier: number): string {
  return ROMAN[tier] ?? "";
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;");
}

/** A single badge card. `award` is the highest earned award for this def, if any. */
export function badgeCardHtml(def: AchievementDefinition, award?: AchievementAward): string {
  const earned = !!award;
  if (def.hidden && !earned) {
    return `<div class="cov-ach-card hidden"><div class="cov-ach-name">Hidden</div>
      <div class="cov-ach-sum">Reveal by earning it.</div></div>`;
  }
  const tier = award?.tier ?? 0;
  const ring = earned ? ` t${tier}` : " locked";
  const tierBadge = earned ? `<span class="cov-ach-tier">${tierLabel(tier)}</span>` : "";
  return `<div class="cov-ach-card${ring}" data-id="${esc(def.id)}">
    <div class="cov-ach-head">
      <span class="cov-ach-name">${esc(def.title)}</span>${tierBadge}
    </div>
    <div class="cov-ach-sum">${esc(def.summary)}</div>
    <div class="cov-ach-meta">${esc(def.category)} · ${esc(def.rarity)}</div>
  </div>`;
}

/** Reputation bars block. */
export function reputationBarsHtml(bars: ReputationBar[]): string {
  const max = Math.max(1, ...bars.map((b) => b.points));
  return bars
    .map(
      (b) => `<div class="cov-rep-row"><span class="cov-rep-name">${esc(b.dimension)}</span>
        <span class="cov-rep-track"><span class="cov-rep-fill" style="width:${Math.round((b.points / max) * 100)}%"></span></span>
        <span class="cov-rep-pts">${b.points}</span></div>`,
    )
    .join("");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && npm test -- achievements`
Expected: PASS (tierLabel + badgeCardHtml tests).

- [ ] **Step 5: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/score/achievements.ts ui/src/score/achievements.test.ts
git commit -m "feat(ui): achievement API wrappers + tested badge/reputation HTML builders"
```

---

## Task 12: Wire the Achievements section into the Metrics page

**Files:**
- Modify: `ui/src/score/achievements.ts` (add the section renderer)
- Modify: `ui/src/score/page.ts`

- [ ] **Step 1: Add the section renderer to `achievements.ts`**

Append:

```ts
/** Render the full Achievements section into a host element. */
export async function renderAchievementsSection(host: HTMLElement): Promise<void> {
  const [catalog, summary, awards] = await Promise.all([
    scoreAchievementCatalog(),
    scoreAchievementSummary(),
    scoreAchievementAwards(),
  ]);

  // highest earned tier per achievement id
  const best = new Map<string, AchievementAward>();
  for (const a of awards) {
    const cur = best.get(a.achievement_id);
    if (!cur || a.tier > cur.tier) best.set(a.achievement_id, a);
  }

  const title = summary.highlighted_title
    ? `<span class="cov-ach-title">${esc(summary.highlighted_title)}</span>`
    : "";

  const grid = catalog
    .map((d) => badgeCardHtml(d, best.get(d.id)))
    .join("");

  host.innerHTML = `
    <div class="cov-ach-summary">
      <div class="cov-ach-stat"><span class="v">${summary.total_awards}</span><span class="l">badges</span></div>
      <div class="cov-ach-stat"><span class="v">${summary.rare_count}</span><span class="l">rare+</span></div>
      <div class="cov-ach-headline">${title}</div>
    </div>
    <div class="cov-rep">${reputationBarsHtml(summary.reputation)}</div>
    <div class="cov-ach-grid">${grid}</div>
  `;
}
```

- [ ] **Step 2: Add the card to the page template**

In `ui/src/score/page.ts`, in the `TEMPLATE` string, add a new card (place it after the `agents` card / before specs to match the spec's section order intent):

```html
    <div class="cov-card">
        <h4>Achievements</h4>
        <div data-role="achievements"></div>
    </div>
```

- [ ] **Step 3: Call the renderer from `refresh`**

In `page.ts`, import at the top:

```ts
import { renderAchievementsSection } from "./achievements";
```

In the `refresh` function, after the existing section renders (e.g. after agents are rendered), add:

```ts
  const achHost = host.querySelector<HTMLElement>('[data-role="achievements"]');
  if (achHost) {
    await renderAchievementsSection(achHost);
  }
```

> `renderAchievementsSection` does its own fetches, so it does not need to join the existing `Promise.all`. If `refresh` is not `async`, wrap in `void renderAchievementsSection(achHost);`.

- [ ] **Step 4: Typecheck + build the UI**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: clean typecheck, successful Vite build.

- [ ] **Step 5: Commit**

```bash
git add ui/src/score/achievements.ts ui/src/score/page.ts
git commit -m "feat(ui): add Achievements section to Metrics page"
```

---

## Task 13: Badge grid + reputation bar styling

**Files:**
- Modify: `ui/src/score/styles.css`

- [ ] **Step 1: Add styles**

Append to `ui/src/score/styles.css` (match the existing `.cov-*` dark palette — brand teal `#5eead4`, card bg `#131a1e`, border `#1c252b`):

```css
/* ---- Achievements ---- */
.cov-ach-summary {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 12px;
}
.cov-ach-stat { display: flex; flex-direction: column; }
.cov-ach-stat .v { font-size: 22px; font-weight: 700; color: #5eead4; }
.cov-ach-stat .l { font-size: 11px; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.04em; }
.cov-ach-headline { margin-left: auto; }
.cov-ach-title {
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(94, 234, 212, 0.12);
  color: #5eead4;
  font-size: 12px;
  font-weight: 600;
}

.cov-rep { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
.cov-rep-row { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.cov-rep-name { width: 96px; text-transform: capitalize; opacity: 0.8; }
.cov-rep-track { flex: 1; height: 8px; background: #1c252b; border-radius: 999px; overflow: hidden; }
.cov-rep-fill { display: block; height: 100%; background: #5eead4; }
.cov-rep-pts { width: 44px; text-align: right; opacity: 0.7; }

.cov-ach-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}
.cov-ach-card {
  border: 1px solid #1c252b;
  border-radius: 10px;
  padding: 12px;
  background: #0f1518;
  opacity: 0.55;
  transition: opacity 0.15s ease;
}
.cov-ach-card.t1, .cov-ach-card.t2, .cov-ach-card.t3,
.cov-ach-card.t4, .cov-ach-card.t5 { opacity: 1; }
.cov-ach-card.t3 { border-color: #5eead4; }
.cov-ach-card.t4 { border-color: #7dd3fc; }
.cov-ach-card.t5 { border-color: #c4b5fd; box-shadow: 0 0 0 1px rgba(196, 181, 253, 0.3); }
.cov-ach-card.hidden { font-style: italic; opacity: 0.4; }
.cov-ach-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cov-ach-name { font-weight: 600; font-size: 13px; }
.cov-ach-tier {
  font-size: 11px;
  font-weight: 700;
  color: #0f1518;
  background: #5eead4;
  border-radius: 6px;
  padding: 1px 6px;
}
.cov-ach-sum { font-size: 12px; opacity: 0.7; margin: 6px 0; line-height: 1.35; }
.cov-ach-meta { font-size: 11px; opacity: 0.5; text-transform: capitalize; }

body.theme-light .cov-ach-card { background: #f4f7f7; border-color: #d9e2e2; }
body.theme-light .cov-rep-track { background: #d9e2e2; }
```

- [ ] **Step 2: Visual check**

Run the app (`npm run tauri:dev` or the project's `respawn`), open Metrics, confirm: the Achievements card renders, locked badges are dimmed, the `cartographer` badge advances after a spec/note is created (create a file under `docs/specs/` to trigger the spec watcher), reputation bars render.

Expected: section renders without console errors; creating a new spec increments Cartographer (may require a Metrics refresh / reopen).

- [ ] **Step 3: Commit**

```bash
git add ui/src/score/styles.css
git commit -m "feat(ui): badge grid + reputation bar styling for achievements"
```

---

## Task 14: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Rust tests**

Run: `cargo test -p karl-score`
Expected: all pass (existing Score tests + achievement unit + integration tests).

- [ ] **Step 2: App build**

Run: `cargo build -p karl-app`
Expected: clean.

- [ ] **Step 3: UI tests + typecheck + build**

Run: `cd ui && npm test && npx tsc --noEmit && npm run build`
Expected: all pass.

- [ ] **Step 4: Acceptance spot-check against spec §19 (MVP-A subset)**

Confirm and check off:
- [ ] Facts stored in `score.sqlite` with repo/branch/group/session/task attribution columns present.
- [ ] Fact metadata is allowlisted (Task 4 test) — no raw output/prompts/ANSI/secrets.
- [ ] Recompute preserves the award timeline (Task 8 test).
- [ ] Duplicate facts don't duplicate progress/awards (Task 6 test).
- [ ] Static definitions serialize to the frontend (`score_achievement_catalog`).
- [ ] Count-based tiers advance on facts; newly crossed tiers insert awards exactly once.
- [ ] Hidden achievements are masked until earned (Task 11 test).
- [ ] Metrics has an Achievements section with summary, reputation, and badge grid.
- [ ] Achievements are cosmetic — no permission/policy code touched.
- [ ] Existing Score summary/heatmap/usage behavior unchanged (full `cargo test -p karl-score` green).

- [ ] **Step 5: Commit any final fixes, then hand off**

```bash
git add -A
git commit -m "test(achievements): MVP-A verification pass green"
```

---

## Out of scope (follow-up plans)

- **MVP B:** operator/orchestrator compact title+badge UI; wire the remaining emitters (`task_completed`/`task_verified`, `risky_action_handled`, `secret_redacted`, `build_command_passed`, `task_recovered`, `orchestrator_task_delegated`); per-operator progress filters; sequence rules (`red_to_green`, "docs before edit"); earned-badge toasts + `metrics.achievements.celebrations` setting.
- **MVP C:** project/repo mastery page; hidden badges (`phoenix`, `zero_panic`, `one_shot`, etc.); user-pinned titles; project-memory/familiar emitters.
- **Deferred:** server sync tiers 1–3; export; settings UI (`metrics.achievements.*`); detail pages with "recent evidence".

## Open spec questions to resolve before MVP B (spec §22)

These do not block MVP A but should be locked before identity surfaces ship: system name (`Achievements` vs branded), default-on vs Metrics-gated, project scope key (path vs remote URL vs hash), and which exact escalation/result "helpful" feedback events MVP B needs.
```