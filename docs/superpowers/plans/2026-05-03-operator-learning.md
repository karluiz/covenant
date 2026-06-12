# 3.13 Operator Learning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Steps use `- [ ]` checkbox syntax.

**Spec:** `docs/specs/3.13-operator-learning.md` (binding).
**Depends on:** 3.8 Convergence Mode — shipped on `main` (commit `ac60299`).
**Branch:** `feature/3.13-operator-learning` (fresh worktree off `main`).

---

## Investigation summary

1. Reply pipe in place: `submit_convergence_reply` (`crates/app/src/lib.rs:740-773`) → `OperatorWatcher::resolution_sender()` (`operator.rs:467`) → `tick_loop` drain (`operator.rs:848-859`) → PTY inject. The `convergence_reply_submitted` event carries only `{session_id, scope, text_hash}` by design.
2. **`sqlite-vec` is NOT wired** anywhere. Cargo workspace pulls `rusqlite = "0.32"` with `bundled` only. v1 ships keyword/substring retrieval; embeddings are a follow-up.
3. **`crates/agent` is the Anthropic HTTP client only** — no SQLite. Spec's "create `crates/agent/src/memory.rs`" can't work without dragging `rusqlite` into the wire client. Module lives at `crates/app/src/memory.rs`.
4. **Spec contradiction**: acceptance bullets mention `~/.karl/operator-memory.jsonl`; "Resolved decisions" picks SQLite + `sqlite-vec`. Resolved-decisions wins. Hand-edit acceptance satisfied by `sqlite3` CLI; no JSONL.
5. `OperatorDecisionRow` (storage.rs:206) has no `applied_memory_id`. Add column via the established idempotent `ALTER TABLE` migration block (storage.rs:258-289).
6. Prompt builder: `build_system_prompt` (`operator.rs:1922-1958`). Inject `## Learned decisions` between mission and persona — empty list → byte-identical prefix → cache stays warm.
7. **Surprising/critical**: `tick_loop` drains the resolution channel BEFORE `run_tick` each tick. Persistence MUST happen in `submit_convergence_reply` BEFORE `resolution_sender().send`, so the next operator tick sees the new memory.

---

## Resolved design decisions

- **Module location**: `crates/app/src/memory.rs` (NOT `crates/agent/src/memory.rs`).
- **Persistence layer**: SQLite, single table `operator_memories`. No JSONL.
- **`OperatorDecisionRow` widening**: add `applied_memory_id INTEGER` column. In-scope for 3.13.
- **Capture path**: write memory inside `submit_convergence_reply` BEFORE `resolution_sender().send` (Path C). No `operator.rs` widening, no event payload change.
- **Retrieval (v1)**: hybrid. Vector cosine via `sqlite-vec` (top-N candidates) + keyword/tag rescoring. Fresh DB read per decision (no in-process cache → satisfies "hand-edit picked up next decision"). Embedder singleton lives in-process.
- **Embeddings**: `fastembed-rs` (local, BGE-small-en-v1.5). Zero network, ~30MB binary growth, model auto-downloads to `$XDG_CACHE_HOME/fastembed-rs/` on first use. No API keys.
- **Vector store**: `sqlite-vec` extension loaded at connection open. `operator_memory_vec` virtual table mirrors `operator_memories.id` and stores 384-dim float embeddings.

---

## Tasks

### Task 0 — Wire `sqlite-vec` + `fastembed-rs` deps

**Files:** `crates/app/Cargo.toml`, `crates/app/src/storage.rs` (connection setup), `crates/app/src/embedder.rs` (new, ≤80 lines).

- [ ] Add `sqlite-vec = "0.1"` (or latest) and `fastembed = "4"` (or latest) to `crates/app/Cargo.toml`. Confirm both build on macOS.
- [ ] In `Storage::open` (storage.rs), after opening the connection but before `SCHEMA` exec: call `unsafe { conn.load_extension_enable()?; sqlite_vec::sqlite3_vec_init...(...)?; conn.load_extension_disable()?; }` per `sqlite-vec` docs. Look at the crate README for the exact init pattern at task time — APIs vary by version.
- [ ] Smoke: query `SELECT vec_version();` after open; assert non-error.
- [ ] Create `crates/app/src/embedder.rs` exposing:
  ```rust
  pub struct Embedder { /* fastembed handle */ }
  impl Embedder {
      pub fn new() -> Result<Self>;          // initializes BGE-small (384 dim)
      pub fn embed(&self, text: &str) -> Result<Vec<f32>>;  // 384 floats
      pub const DIM: usize = 384;
  }
  ```
- [ ] Add `pub mod embedder;` to `lib.rs`. Hold a `OnceCell<Embedder>` (or `Arc<Embedder>` on `AppState`) — first-touch lazy init so app startup isn't blocked by model load.
- [ ] Unit test: embed two short strings, assert dims=384 and finite floats.
- **Commit:** `feat(memory): wire sqlite-vec extension + fastembed local embedder`
- **Verify:** `cargo test -p covenant embedder::tests`; `cargo run -p covenant` smoke (just open DB, no crash).

> ESCALATE if `sqlite-vec` cannot load on macOS (some signing/notarization wrinkles) — fall back to keyword-only and surface to user before continuing.

### Task 1 — SQLite schema for memories + decision-row column

**Files:** `crates/app/src/storage.rs`.

- [ ] Add to `SCHEMA`:
  ```sql
  CREATE TABLE IF NOT EXISTS operator_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT,
    scope TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '',
    created_at_unix_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_operator_memories_scope ON operator_memories(scope);
  CREATE INDEX IF NOT EXISTS idx_operator_memories_created ON operator_memories(created_at_unix_ms DESC);

  -- Vector index (sqlite-vec). Mirrors operator_memories.id.
  CREATE VIRTUAL TABLE IF NOT EXISTS operator_memory_vec USING vec0(
    embedding float[384]
  );
  ```
- [ ] Idempotent `ALTER TABLE operator_decisions ADD COLUMN applied_memory_id INTEGER` in migrations block.
- [ ] Add `pub applied_memory_id: Option<i64>` to `OperatorDecisionRow`; round-trip in `save_operator_decision` + `list_operator_decisions`.
- [ ] TDD tests: insert+list ordering DESC, scope filter, delete, decision-row round-trip.
- [ ] Add `Storage::insert_memory(pattern, decision, rationale, scope, tags, created_at, embedding: &[f32]) -> Result<i64>`. Inserts into both `operator_memories` and `operator_memory_vec` (using returned `id` as `rowid` in the vec table) atomically in a transaction.
- [ ] Add `Storage::list_memories(scopes: &[&str], limit)` — keyword path (no vector).
- [ ] Add `Storage::vector_search_memories(scopes: &[&str], query_embedding: &[f32], k: usize) -> Vec<(MemoryRow, f32 /* distance */)>` — joins `operator_memory_vec MATCH ? ORDER BY distance LIMIT k` with `operator_memories` and applies scope filter post-hoc.
- [ ] Add `Storage::delete_memory(id)` — deletes from both tables in a transaction.
- **Commit:** `feat(storage): operator_memories table + applied_memory_id on decisions`
- **Verify:** `cargo test -p covenant storage::tests`

### Task 2 — `memory.rs`: pattern extraction + retrieval scoring (TDD, pure)

**Files:** Create `crates/app/src/memory.rs` (≤180 lines), modify `lib.rs` (`mod memory;`).

- [ ] Failing tests first:
  - `extract_tags(text)` — lowercase, split non-alphanumeric, drop stopwords, dedup, cap 12.
  - `score_memory(memory, query_tags, query_text)` — 0 on scope mismatch; else `tag_overlap*2 + substring_hits`.
  - `retrieve(memories, ctx, k)` — top-k by score, `created_at` DESC tiebreak (proves "newest wins").
  - Empty list → empty result.
- [ ] Implement pure functions; no I/O.
- **Commit:** `feat(memory): pattern extraction + retrieval scoring (pure)`
- **Verify:** `cargo test -p covenant memory::tests`

### Task 3 — Capture: persist memory inside `submit_convergence_reply`

**Files:** `crates/app/src/lib.rs` (≤40 added lines).

- [ ] Before `resolution_sender().send(...)`, branch on `scope`:
  - `"one-shot"` → skip persistence.
  - `"global"` → insert with `scope = "global"`.
  - `"mission"` → backend resolves to `format!("mission:{}", current_mission_path)` for that session; if no mission attached, fall back to `"global"` and log a warn.
  - other → log warn, no persist; still send the resolution.
- [ ] `pattern` = latest `OperatorDecisionRow` for the session_id_short within last 5 min: `rationale + " | " + in_flight_command.unwrap_or("")`. If none, fallback to most recent row's rationale. If still none, empty string.
- [ ] `decision` = user's raw `text`.
- [ ] `tags` = `memory::extract_tags(format!("{pattern} {decision}"))` joined by spaces.
- [ ] `embedding = state.embedder.get_or_init().embed(format!("{pattern}\n{decision}"))?` — embed the combined pattern+decision so retrieval finds the row by either side.
- [ ] `state.storage.insert_memory(..., &embedding)`. On error: `tracing::warn!`, do NOT fail the command.
- [ ] Persistence runs BEFORE channel send.
- [ ] Event payload unchanged. No new public surface in `operator.rs`.
- **Commit:** `feat(memory): persist convergence replies as learned decisions`
- **Verify:** `cargo check -p covenant`; manual escalate→reply→`select * from operator_memories;`.

### Task 4 — Retrieval at decision time + prompt injection

**Files:** `crates/app/src/operator.rs` (touch `build_system_prompt` + call site near :1211; ≤40 net lines).

- [ ] `build_system_prompt` accepts `learned: &[MemorySummary]` (id + decision + pattern). Render `## Learned decisions` block ONLY if non-empty; placement: AFTER mission_block, BEFORE persona. Empty → empty string → byte-identical to pre-3.13.
- [ ] Block contents include: instruction to apply matching decisions and emit `applied_memory: <id>` in rationale.
- [ ] At call site: build query context (`cmd + tail last-line + cwd`), `query_tags = extract_tags(...)`, `scopes = ["global"]` plus `format!("mission:{}", path)` if attached, embed the query context, call `vector_search_memories(scopes, &query_emb, k=20)` to get top-20 candidates, then rescore via `memory::retrieve_hybrid(candidates, query_tags, query_text, k=8)` which combines vector distance + tag/substring score (see Task 6 for hybrid scoring).
- [ ] Memory load every tick; no in-process cache (deliberate — comment in code). Small table, indexed.
- [ ] Test: zero memories → output equals pre-3.13 baseline (snapshot-style `const EXPECTED: &str`); one memory → contains `## Learned decisions` exactly once.
- **Commit:** `feat(operator): inject learned decisions into system prompt`
- **Verify:** `cargo test -p covenant operator::tests`

### Task 5 — Apply-instead-of-escalate path

**Files:** `crates/app/src/operator.rs` (response parser around :2276 + decision-row save site).

- [ ] Parse `applied_memory: <id>` out of model rationale. Strip from saved rationale; store id in `applied_memory_id`.
- [ ] On parse fail (id not in DB / malformed): warn, save with `None`, do not block.
- [ ] Unit test: parser extracts id from `"Reason text. applied_memory: 42."` → id=42, rationale=`"Reason text."`
- **Commit:** `feat(operator): record applied_memory_id on decisions reusing a learned reply`
- **Verify:** `cargo test -p covenant`

### Task 6 — Conflict resolution: newest wins, shadowed audit

**Files:** `crates/app/src/memory.rs` + `operator.rs`.

- [ ] In `retrieve`, when scores tie: keep newer; collect older as shadowed.
- [ ] Return `(Vec<MemoryHit>, Vec<i64> /* shadowed_ids */)`.
- [ ] When operator applies winner X and shadowed is `[Y, Z]`, append to rationale (after stripping `applied_memory:` line): `applied_memory: X (shadowed: Y, Z)`. No new column — winner in column, full audit in rationale text.
- [ ] Test: same tags, different `created_at` → newer surfaces, older's id in shadow list.
- **Commit:** `feat(memory): newest-wins with shadowed-ids audit trail`
- **Verify:** `cargo test -p covenant memory::tests`

### Task 7 — Backend scope resolution wiring

**Files:** `crates/app/src/lib.rs` (small).

- [ ] Confirm UI sends `"one-shot" | "mission" | "global"` exactly. Backend resolves `"mission"` → `mission:<path>` per Task 3.
- [ ] Unit test for the scope-string mapping.
- **Commit:** `feat(memory): backend-side scope resolution for convergence replies`
- **Verify:** `cargo test -p covenant`; `npx tsc --noEmit`.

### Task 8 — Hand-edit flow doc

**Files:** none beyond commit body.

- [ ] Document: `sqlite3 <db_path> "DELETE FROM operator_memories WHERE id=…"` works; operator picks up changes next tick because retrieval has no cache (Task 4).
- [ ] Manual smoke (in commit body): escalate twice with same pattern, reply once with scope=global → second escalation auto-resolves; delete the row → next escalation re-escalates without restart.
- **Commit:** `docs(memory): hand-edit flow via sqlite3 (defers JSONL acceptance text)`

### Task 9 — Zero-memories regression test

**Files:** `crates/app/src/operator.rs` tests, `crates/app/src/storage.rs` tests.

- [ ] `build_system_prompt(..., &[])` → equals committed `EXPECTED` baseline string (snapshot test).
- [ ] Decision rows with `applied_memory_id = None` round-trip identical to pre-3.13 rows (covers migration on existing DBs).
- **Commit:** `test(memory): zero-memory prompt byte-identical to baseline`
- **Verify:** `cargo test -p covenant`

### Task 10 — E2E manual verification

- [ ] Clean DB. Trigger ESCALATE on deterministic mission.
- [ ] Convergence reply scope=global → row in `operator_memories`.
- [ ] Same trigger again → no re-escalate; new decision row has non-NULL `applied_memory_id` and rationale contains `applied_memory: <id>`.
- [ ] scope=mission → `mission:<absolute path>` in row.
- [ ] scope=one-shot → no row.
- [ ] Delete row via sqlite3 → next trigger re-escalates without restart.
- [ ] `cargo check -p covenant` + `cargo test -p covenant` + `npx tsc --noEmit` all green.

---

## Acceptance → task map

| Spec criterion | Task |
|---|---|
| Reply persists when scope ≠ one-shot | 3 |
| `## Learned decisions` injected, cache-friendly | 4, 9 |
| Operator applies instead of escalating; logs `applied_memory: <id>` | 4, 5 |
| Hand-edit picked up next decision, no restart | 4 (no cache), 8 |
| Zero memories → no regression | 4, 9 |
| Most-recent wins, loser logged | 6 |
| ESCALATED tile reply UI + scope selector | shipped in 3.8; verified Task 7 |
