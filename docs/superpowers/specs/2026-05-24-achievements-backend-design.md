# Achievements Backend — MVP Design

**Date:** 2026-05-24
**Branch:** `feat/achievements-backend`
**Scope:** Initial backend (tables + rule engine) for command-milestone achievements in Covenant. UI and notifications are out of scope.

## Goals

- Track user progress against a small, hard-coded catalog of command-milestone achievements.
- Persist unlock state in the existing `karl-score` SQLite database.
- Evaluate rules transactionally with the events that trigger them, so unlocks cannot be lost.
- Expose unlock state to the super-agent's world model and to the UI via the existing `ScoreStore` public API.

## Non-Goals (MVP)

- UI rendering of achievements (toasts, panel, badges).
- Push notifications, sounds, animations.
- User-editable rule catalog (JSON/TOML config).
- Remote sync of achievements.
- Categories beyond command milestones (sessions, agent interactions, error recovery — deferred).
- Retroactive unlock backfill across historic event data (an optional one-shot migration is described below but not required for MVP).

## Architecture

The backend lives entirely inside the existing `karl-score` crate. No new crates.

```
┌─────────────────────────────────────────────────────┐
│ karl-score crate                                    │
│  ┌─────────────┐    append/append_with_context      │
│  │ ScoreStore  │────────────┐                       │
│  └─────────────┘            │                       │
│         │                   ▼                       │
│         │            ┌──────────────┐               │
│         │            │ achievements │ evaluate()    │
│         │            │   module     │               │
│         │            └──────┬───────┘               │
│         │                   │                       │
│         ▼                   ▼                       │
│  ┌──────────────────────────────────┐               │
│  │ SQLite: achievements,            │               │
│  │         user_achievements        │               │
│  └──────────────────────────────────┘               │
└─────────────────────────────────────────────────────┘
              │ list / recent_unlocks
              ▼
       agent + app/UI consumers
```

## Data Model

Added to the `ScoreStore::open` migration block:

```sql
CREATE TABLE IF NOT EXISTS achievements (
  id           TEXT PRIMARY KEY,        -- stable rule id, e.g. "century_club"
  title        TEXT NOT NULL,
  description  TEXT NOT NULL,
  category     TEXT NOT NULL,           -- "commands" for MVP
  threshold    INTEGER,                 -- nullable for non-counting rules
  created_at   INTEGER NOT NULL         -- ms epoch when row inserted
);

CREATE TABLE IF NOT EXISTS user_achievements (
  achievement_id TEXT PRIMARY KEY REFERENCES achievements(id),
  unlocked_at    INTEGER NOT NULL,      -- ms epoch
  progress       INTEGER NOT NULL DEFAULT 0,
  trigger_event  TEXT                   -- optional descriptor of the unlocking event
);

CREATE INDEX IF NOT EXISTS idx_user_ach_unlocked ON user_achievements(unlocked_at);
```

On `ScoreStore::open`, after the migration runs, the catalog is upserted into the `achievements` table (`INSERT ... ON CONFLICT(id) DO UPDATE SET title=..., description=..., threshold=...`) so changes to the in-code catalog propagate to the DB without manual migrations.

## Rule Engine

`crates/score/src/achievements.rs`:

```rust
pub struct Rule {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub threshold: Option<i64>,
    pub eval: fn(&Connection) -> rusqlite::Result<Progress>,
}

pub struct Progress { pub current: i64, pub target: i64 }
impl Progress { pub fn unlocked(&self) -> bool { self.current >= self.target } }

pub struct Unlock {
    pub id: &'static str,
    pub unlocked_at: i64,
    pub progress: i64,
}

pub static CATALOG: &[Rule] = &[
    Rule { id: "first_command",     title: "Hello, World",      description: "Run your first command.",                  category: "commands", threshold: Some(1),   eval: eval_command_count_1 },
    Rule { id: "ten_commands",      title: "Getting Warmed Up", description: "Run 10 commands.",                         category: "commands", threshold: Some(10),  eval: eval_command_count_10 },
    Rule { id: "century_club",      title: "Century Club",      description: "Run 100 commands.",                        category: "commands", threshold: Some(100), eval: eval_command_count_100 },
    Rule { id: "distinct_tools_10", title: "Toolbelt",          description: "Use 10 distinct executors/CLIs.",          category: "commands", threshold: Some(10),  eval: eval_distinct_executors_10 },
];

/// Evaluates all rules that are not yet unlocked. Inserts new unlocks
/// inside the same transaction the caller is in (caller passes the tx).
/// Returns the set of newly-unlocked rule ids.
pub fn evaluate(tx: &Transaction, now_ms: i64, trigger: Option<&str>) -> rusqlite::Result<Vec<Unlock>>;
```

Each `eval_*` function runs a single `COUNT(*)` (or `COUNT(DISTINCT executor)`) over `score_events` filtered by event kind. Implementations are tiny and trivially testable.

### Integration with `ScoreStore::append*`

`append` and `append_with_context` are refactored to:

1. Open a transaction.
2. Insert into `score_events` (existing behavior).
3. Call `achievements::evaluate(&tx, now_ms, Some(event_desc))`.
4. For each `Unlock` returned, `INSERT OR IGNORE INTO user_achievements(...)`.
5. Commit the transaction.
6. Return `Vec<Unlock>` to the caller alongside the existing `Ok(())` (signature changes to `Result<Vec<Unlock>>`).

Existing callers either ignore the return value or forward it to the event bus.

### Backfill (optional, deferred)

A `ScoreStore::backfill_achievements()` method evaluates every rule against the full event history and inserts unlocks dated to the timestamp of the qualifying event. Useful for existing users who already have event history when the feature ships. Not required for MVP cut, but the method is small enough to include — design call: include it, leave it unused until M+1.

## Public API Additions

```rust
impl ScoreStore {
    pub fn list_achievements(&self) -> Result<Vec<AchievementView>>;
    pub fn recent_unlocks(&self, limit: u32) -> Result<Vec<UnlockedAchievement>>;
}

pub struct AchievementView {
    pub id: String,
    pub title: String,
    pub description: String,
    pub category: String,
    pub threshold: Option<i64>,
    pub unlocked_at: Option<i64>,
    pub progress: i64,
}

pub struct UnlockedAchievement {
    pub id: String,
    pub title: String,
    pub unlocked_at: i64,
}
```

`list_achievements()` LEFT JOINs `achievements` with `user_achievements` and computes live progress by calling each rule's `eval` function (cheap — single COUNT per rule, at most a handful of rules).

## Agent Integration

`crates/agent/src/context.rs` (or equivalent existing context-builder) gains:

```rust
pub fn achievements_summary(store: &ScoreStore) -> String;
```

Returns a short, deterministic string included in the **cached** portion of the system prompt:

```
Achievements: 3/4 unlocked. Latest: Century Club (100 commands, 2026-05-23).
```

The string is regenerated only when a new unlock happens (or on cold start), so the cache stays warm. No agent prompts are sent purely to refresh this.

## Event Bus

`crates/app` (or wherever the agent event bus lives) extends its event enum:

```rust
AchievementUnlocked { id: String, title: String, unlocked_at: i64 }
```

`Vec<Unlock>` returned from `ScoreStore::append*` is converted to these events and broadcast. The agent's world-model worker and any future UI listener subscribe to them.

## Testing

`tempfile`-backed `ScoreStore` per test. Cases:

- Empty store: no unlocks.
- `append` first command event → `first_command` unlocks; `unlocked_at` matches the event timestamp.
- Append 10 command events in one test run → `first_command` and `ten_commands` both unlocked exactly once.
- Re-running `evaluate` after an unlock does NOT create duplicate rows (`INSERT OR IGNORE`).
- `distinct_tools_10`: 9 events from same executor → not unlocked; 10th from new executor → unlocked.
- `list_achievements` returns the full catalog with correct `unlocked_at` / `progress`.
- Catalog upsert: changing a `title` in code and reopening the store updates the DB row.

## File Layout

```
crates/score/src/
  lib.rs              # re-export achievements module
  store.rs            # migration adds 2 tables + catalog upsert; append* return Vec<Unlock>
  achievements.rs     # NEW — Rule, Progress, Unlock, CATALOG, evaluate(), eval_* fns
  types.rs            # add AchievementView, UnlockedAchievement
```

Roughly one new file (`achievements.rs`, ~200 lines incl. tests) plus targeted edits in `store.rs` and `types.rs`.

## Risks & Mitigations

- **Append-path latency.** Evaluation runs N small COUNTs on every event. Mitigation: only evaluate rules that are not yet unlocked (cached set in `ScoreStore`; rebuilt on `open`).
- **Signature change to `append`/`append_with_context`.** Breaks existing callers. Mitigation: change call sites in the same PR; they all live in this repo.
- **Catalog drift between code and DB.** Mitigation: upsert on `open`; never trust DB title/description as source of truth.

## Out-of-Scope / Future

- Session, agent, and error-recovery categories (deferred per scope decision).
- UI: achievements panel, toasts, badges.
- User-editable rules.
- Remote sync.
- Backfill activation (method exists, not called from app).
