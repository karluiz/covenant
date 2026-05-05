# Convergence Redesign (Inbox + Roster) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat-grid Convergence overlay (3.8) with a two-pane Inbox + Roster layout: escalations on the left with a multi-line reply composer, sessions grouped by operator on the right with disclosure carets, filter chips, and explicit click semantics.

**Architecture:** Backend snapshot is restructured from a flat `tiles: Vec<TileState>` into `roster: Vec<OperatorRosterEntry>` (sessions grouped by operator id, unassigned tabs filtered out) plus `escalations: Vec<EscalationCard>` (flat list of blocked sessions, oldest-first). The Convergence overlay is rewritten as two columns wired to those collections. Existing reply pipe (`submit_convergence_reply`) is reused unchanged.

**Tech Stack:** Rust + Tauri 2 (backend), TypeScript + xterm.js (frontend), no new dependencies.

**Spec:** `docs/specs/3.8.1-convergence-redesign.md`

---

## File Structure

### Modify

- `crates/app/src/convergence.rs` — replace `ConvergenceSnapshot.tiles` with `roster` + `escalations`. Add `OperatorRosterEntry`, `SessionSummary`, `EscalationCard`. Drop sessions whose tab has no assigned operator (input must carry that signal). Add `operator_id`/`operator_name`/`operator_avatar`/`tab_title`/`tab_color` fields to `SessionInput`.
- `crates/app/src/lib.rs` — extend `SessionInput` construction with operator + tab metadata (read from existing `state.operator` and tab manifest). Update `get_blocked_session_ids` to read `snap.escalations` instead of `snap.tiles`.
- `ui/src/api.ts` — replace `ConvergenceTileState`/`ConvergenceSnapshot` types with `OperatorRosterEntry`, `SessionSummary`, `EscalationCard`, `ConvergenceSnapshot { roster, escalations }`.
- `ui/src/convergence/overlay.ts` — rewrite as two-column controller managing Inbox active card, keyboard nav, filter chip state. Snapshot consumption switches to `roster` + `escalations`.
- `ui/src/convergence/tile.ts` — replace `renderTile`/`updateTile` with `renderInboxCard`, `renderRosterRow`, `renderRosterSubRow`. Keep file ≤ 320 lines.
- `ui/src/convergence/tabs-bridge.ts` — extend `TabMeta` to include `operatorId`. The bridge is no longer the source of truth for filtering; backend filters. Bridge still supplies title/color and an `activateBySessionId(id, opts: { keepOverlayOpen })` so double-click can keep the overlay open.
- `ui/src/styles.css` — append redesigned styles, remove obsolete `.convergence-overlay__grid` + `.convergence-tile` styles.

### DO NOT touch

- `crates/agent/`, `crates/blocks/`, `crates/session/`, `crates/pty/`.
- `crates/app/src/operator.rs`, `aom.rs`, `safety.rs`, `settings.rs`, `storage.rs`.
- `ui/src/operator/`, `ui/src/aom/`, `ui/src/recall/`, `ui/src/blocks/`, `ui/src/structure/`, `ui/src/tabs/`, `ui/src/settings/`.

---

## Conventions

- **One commit per task** (per Karluiz preference — not per TDD step). Each task ends with a single `git commit` step.
- **Test-first** within each task: failing test → impl → green → commit.
- **Quality gates** between tasks: `cargo check -p covenant` and `npx tsc --noEmit` must pass before commit.

---

## Task 1: Backend snapshot — new types and grouping

Restructure the snapshot output. Drop the legacy `tiles` field entirely. The single consumer in this repo is the Convergence overlay (rewritten in Task 5–6) and `get_blocked_session_ids` (updated in Task 2).

**Files:**
- Modify: `crates/app/src/convergence.rs`

- [ ] **Step 1: Extend `SessionInput` with operator + tab metadata**

Open `crates/app/src/convergence.rs`. Replace the existing `SessionInput` struct (around line 156) with:

```rust
pub struct SessionInput {
    pub session_id: SessionId,
    pub op_state: Arc<StdMutex<OperatorState>>,
    /// Tab title (already-resolved customName→defaultTitle in caller).
    pub tab_title: String,
    /// Optional tab color stripe.
    pub tab_color: Option<String>,
    /// `None` → tab has no assigned operator → snapshot will drop it.
    pub operator_id: Option<String>,
    /// Display name of the operator (e.g. "Raven"). Required when
    /// `operator_id` is `Some`; pass empty string only if unknown.
    pub operator_name: Option<String>,
    /// Operator avatar (emoji or short string). Optional.
    pub operator_avatar: Option<String>,
}
```

- [ ] **Step 2: Add new output types**

Below `ConvergenceTileState`, replace the `ConvergenceSnapshot` definition with:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub tab_title: String,
    pub tab_color: Option<String>,
    pub status: TileStatus,
    pub vendor: Vendor,
    pub raw_command_label: Option<String>,
    pub last_command: Option<String>,
    pub last_output_line: Option<String>,
    pub last_decision_action: Option<String>,
    pub last_decision_rationale: Option<String>,
    pub mission_name: Option<String>,
    pub cost_usd: Option<f64>,
    pub budget_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OperatorRosterEntry {
    pub operator_id: String,
    pub operator_name: String,
    pub operator_avatar: Option<String>,
    pub sessions: Vec<SessionSummary>,
    /// Convenience: any session in the entry has TileStatus::Blocked.
    pub has_escalation: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EscalationCard {
    pub session_id: String,
    pub tab_title: String,
    pub tab_color: Option<String>,
    pub operator_id: String,
    pub operator_name: String,
    pub operator_avatar: Option<String>,
    pub vendor: Vendor,
    pub raw_command_label: Option<String>,
    /// The operator's open question — `last_decision_rationale` of the
    /// escalating decision, full text (no truncation in backend).
    pub question: Option<String>,
    pub mission_name: Option<String>,
    /// Unix ms of the escalating decision row, used by the UI for
    /// "2m ago" labels and oldest-first sort.
    pub escalated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvergenceSnapshot {
    pub roster: Vec<OperatorRosterEntry>,
    pub escalations: Vec<EscalationCard>,
}
```

Keep `ConvergenceTileState` defined for now — the snapshot builder uses it as an intermediate shape (see Step 3). It is no longer serialized to the frontend.

- [ ] **Step 3: Rewrite `build_convergence_snapshot`**

Replace the existing `build_convergence_snapshot` body. Keep the same async signature and arguments. New behavior:

```rust
pub async fn build_convergence_snapshot(
    sessions: Vec<SessionInput>,
    operator: &OperatorWatcher,
    storage: &Storage,
    aom: &AomHandle,
) -> ConvergenceSnapshot {
    let recent = storage
        .list_operator_decisions(200)
        .await
        .unwrap_or_default();
    let by_short = index_decisions_by_short_id(&recent);

    let aom_state = aom.read().await;
    let aom_enabled = aom_state.enabled;
    let aom_budget = aom_state.budget_usd;
    let aom_started_ms = aom_state.started_at_unix_ms;
    drop(aom_state);

    let now = Instant::now();

    // First pass: build per-session summaries, dropping tabs without
    // an assigned operator.
    struct Built {
        operator_id: String,
        operator_name: String,
        operator_avatar: Option<String>,
        summary: SessionSummary,
        // Carried forward into EscalationCard when status == Blocked.
        question: Option<String>,
        escalated_at_unix_ms: u64,
    }

    let mut built: Vec<Built> = Vec::with_capacity(sessions.len());
    for s in sessions {
        let Some(op_id) = s.operator_id.clone() else {
            continue; // unassigned → not in convergence
        };
        let op_name = s.operator_name.clone().unwrap_or_default();
        let op_avatar = s.operator_avatar.clone();

        let id_str = s.session_id.to_string();
        let short = shorten6(&id_str);

        let (last_byte_at, bytes_total, last_decision_at_bytes_total, tail_bytes) = {
            let st = s.op_state.lock().expect("op_state poisoned");
            (st.last_byte_at, st.bytes_total, st.last_decision_at_bytes_total, st.snapshot_tail(8 * 1024))
        };

        let last = by_short.get(short.as_str()).copied();
        let last_action = last.map(|d| d.action.as_str());
        let cmd_for_vendor = last.and_then(|d| d.in_flight_command.as_deref());
        let vendor = detect_vendor(cmd_for_vendor);
        let raw_command_label = matches!(vendor, Vendor::Unknown)
            .then(|| cmd_for_vendor.map(|c| c.chars().take(40).collect::<String>()))
            .flatten();

        let is_thinking = operator.is_thinking(s.session_id).await;
        let status = decide_status(
            is_thinking,
            &StatusInputs { last_byte_at, bytes_total, last_decision_at_bytes_total, last_decision_action: last_action, now },
        );

        let op_enabled = operator.is_enabled(s.session_id).await;
        let aom_excluded = operator.is_aom_excluded(s.session_id).await;
        let enrolled = aom_enabled && op_enabled && !aom_excluded;
        let cost_usd = if enrolled { Some(sum_cost_for_short(&recent, &short, aom_started_ms)) } else { None };

        let summary = SessionSummary {
            session_id: id_str,
            tab_title: s.tab_title,
            tab_color: s.tab_color,
            status,
            vendor,
            raw_command_label,
            last_command: last.and_then(|d| d.in_flight_command.clone()),
            last_output_line: last_non_empty_line(&tail_bytes, 160),
            last_decision_action: last.map(|d| d.action.clone()),
            last_decision_rationale: last.and_then(|d| d.rationale.clone()),
            mission_name: mission_name_from_path(last.and_then(|d| d.mission_path.as_deref())),
            cost_usd,
            budget_usd: if enrolled { Some(aom_budget) } else { None },
        };

        built.push(Built {
            operator_id: op_id,
            operator_name: op_name,
            operator_avatar: op_avatar,
            question: last.and_then(|d| d.rationale.clone()),
            escalated_at_unix_ms: last.map(|d| d.timestamp_unix_ms).unwrap_or(0),
            summary,
        });
    }

    // Second pass: build escalations list (oldest-first).
    let mut escalations: Vec<EscalationCard> = built
        .iter()
        .filter(|b| matches!(b.summary.status, TileStatus::Blocked))
        .map(|b| EscalationCard {
            session_id: b.summary.session_id.clone(),
            tab_title: b.summary.tab_title.clone(),
            tab_color: b.summary.tab_color.clone(),
            operator_id: b.operator_id.clone(),
            operator_name: b.operator_name.clone(),
            operator_avatar: b.operator_avatar.clone(),
            vendor: b.summary.vendor,
            raw_command_label: b.summary.raw_command_label.clone(),
            question: b.question.clone(),
            mission_name: b.summary.mission_name.clone(),
            escalated_at_unix_ms: b.escalated_at_unix_ms,
        })
        .collect();
    escalations.sort_by_key(|e| e.escalated_at_unix_ms);

    // Third pass: group sessions by operator_id, preserving insertion order.
    let mut roster: Vec<OperatorRosterEntry> = Vec::new();
    for b in built {
        if let Some(entry) = roster.iter_mut().find(|e| e.operator_id == b.operator_id) {
            if matches!(b.summary.status, TileStatus::Blocked) {
                entry.has_escalation = true;
            }
            entry.sessions.push(b.summary);
        } else {
            let has_escalation = matches!(b.summary.status, TileStatus::Blocked);
            roster.push(OperatorRosterEntry {
                operator_id: b.operator_id,
                operator_name: b.operator_name,
                operator_avatar: b.operator_avatar,
                sessions: vec![b.summary],
                has_escalation,
            });
        }
    }

    // Sort roster: any-escalation first, then by name (stable on ties).
    roster.sort_by(|a, b| match (a.has_escalation, b.has_escalation) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.operator_name.cmp(&b.operator_name),
    });

    ConvergenceSnapshot { roster, escalations }
}
```

- [ ] **Step 4: `cargo check` to ensure types compile (tests will fail in Task 2)**

Run: `cargo check -p covenant`
Expected: PASS — old tests in this file may not yet reference new types, but the binary won't compile without `lib.rs` updates. If `cargo check` fails ONLY because `lib.rs` reads `snap.tiles`, that's expected and resolved in Task 2. Otherwise fix.

If the only error is `no field 'tiles' on type 'ConvergenceSnapshot'` from `lib.rs::get_blocked_session_ids`, leave it — Task 2 fixes that.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/convergence.rs
git commit -m "refactor(convergence): split snapshot into roster + escalations

Replaces ConvergenceSnapshot.tiles with roster (sessions grouped by
operator id, unassigned tabs dropped) and escalations (flat list of
blocked sessions, oldest-first). Spec 3.8.1 Task 1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend snapshot — tests + lib.rs wiring

Add Rust unit tests for grouping/filtering/sorting and update the two `lib.rs` consumers (`get_convergence_snapshot` Tauri command and `get_blocked_session_ids`) to construct the new `SessionInput` and read `snap.escalations`.

**Files:**
- Modify: `crates/app/src/convergence.rs` (add tests at bottom)
- Modify: `crates/app/src/lib.rs` (update both consumers)

- [ ] **Step 1: Write failing tests for grouping + filtering + sorting**

Append to the `#[cfg(test)] mod tests` block in `convergence.rs`. These tests target a new pure helper `group_into_roster` plus the existing snapshot end-to-end is exercised separately. Add the helper extraction first:

Refactor: pull the second/third passes of `build_convergence_snapshot` into a private pure function so it can be tested without spinning up `OperatorWatcher`/`Storage`/`AomHandle`. Above the existing `build_convergence_snapshot`, add:

```rust
// Test-visible inputs for the grouping/escalations passes.
struct BuiltRow {
    operator_id: String,
    operator_name: String,
    operator_avatar: Option<String>,
    summary: SessionSummary,
    question: Option<String>,
    escalated_at_unix_ms: u64,
}

fn assemble_snapshot(built: Vec<BuiltRow>) -> ConvergenceSnapshot {
    let mut escalations: Vec<EscalationCard> = built
        .iter()
        .filter(|b| matches!(b.summary.status, TileStatus::Blocked))
        .map(|b| EscalationCard {
            session_id: b.summary.session_id.clone(),
            tab_title: b.summary.tab_title.clone(),
            tab_color: b.summary.tab_color.clone(),
            operator_id: b.operator_id.clone(),
            operator_name: b.operator_name.clone(),
            operator_avatar: b.operator_avatar.clone(),
            vendor: b.summary.vendor,
            raw_command_label: b.summary.raw_command_label.clone(),
            question: b.question.clone(),
            mission_name: b.summary.mission_name.clone(),
            escalated_at_unix_ms: b.escalated_at_unix_ms,
        })
        .collect();
    escalations.sort_by_key(|e| e.escalated_at_unix_ms);

    let mut roster: Vec<OperatorRosterEntry> = Vec::new();
    for b in built {
        if let Some(entry) = roster.iter_mut().find(|e| e.operator_id == b.operator_id) {
            if matches!(b.summary.status, TileStatus::Blocked) {
                entry.has_escalation = true;
            }
            entry.sessions.push(b.summary);
        } else {
            let has_escalation = matches!(b.summary.status, TileStatus::Blocked);
            roster.push(OperatorRosterEntry {
                operator_id: b.operator_id,
                operator_name: b.operator_name,
                operator_avatar: b.operator_avatar,
                sessions: vec![b.summary],
                has_escalation,
            });
        }
    }

    roster.sort_by(|a, b| match (a.has_escalation, b.has_escalation) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.operator_name.cmp(&b.operator_name),
    });

    ConvergenceSnapshot { roster, escalations }
}
```

Then update `build_convergence_snapshot`'s second/third passes to call `assemble_snapshot(built)` instead of inlining them. Replace everything after the first-pass `built.push(...)` loop with:

```rust
    assemble_snapshot(
        built
            .into_iter()
            .map(|b| BuiltRow {
                operator_id: b.operator_id,
                operator_name: b.operator_name,
                operator_avatar: b.operator_avatar,
                summary: b.summary,
                question: b.question,
                escalated_at_unix_ms: b.escalated_at_unix_ms,
            })
            .collect(),
    )
```

(Keep the local `Built` struct in `build_convergence_snapshot`; it's identical in shape to `BuiltRow` but lives in the function for clarity. The mapping is one-to-one.)

Now add the tests:

```rust
    fn summary(session: &str, status: TileStatus) -> SessionSummary {
        SessionSummary {
            session_id: session.into(),
            tab_title: format!("tab-{session}"),
            tab_color: None,
            status,
            vendor: Vendor::Unknown,
            raw_command_label: None,
            last_command: None,
            last_output_line: None,
            last_decision_action: None,
            last_decision_rationale: None,
            mission_name: None,
            cost_usd: None,
            budget_usd: None,
        }
    }

    fn row(op: &str, op_name: &str, session: &str, status: TileStatus, esc_ms: u64) -> BuiltRow {
        BuiltRow {
            operator_id: op.into(),
            operator_name: op_name.into(),
            operator_avatar: None,
            summary: summary(session, status),
            question: matches!(status, TileStatus::Blocked).then(|| "q?".into()),
            escalated_at_unix_ms: esc_ms,
        }
    }

    #[test]
    fn roster_groups_same_operator_across_sessions() {
        let snap = assemble_snapshot(vec![
            row("op-frontend", "frontend", "s1", TileStatus::Working, 0),
            row("op-backend",  "backend",  "s2", TileStatus::Idle,    0),
            row("op-frontend", "frontend", "s3", TileStatus::Idle,    0),
        ]);
        // Two operators total; frontend has 2 sessions.
        assert_eq!(snap.roster.len(), 2);
        let frontend = snap.roster.iter().find(|r| r.operator_id == "op-frontend").unwrap();
        assert_eq!(frontend.sessions.len(), 2);
        assert!(snap.roster.iter().any(|r| r.operator_id == "op-backend"));
    }

    #[test]
    fn roster_sorts_escalating_operators_first() {
        let snap = assemble_snapshot(vec![
            row("op-a", "alpha",   "s1", TileStatus::Working, 0),
            row("op-b", "bravo",   "s2", TileStatus::Blocked, 100),
            row("op-c", "charlie", "s3", TileStatus::Idle,    0),
        ]);
        assert_eq!(snap.roster[0].operator_id, "op-b");
        assert!(snap.roster[0].has_escalation);
        // Remaining are sorted by name.
        assert_eq!(snap.roster[1].operator_name, "alpha");
        assert_eq!(snap.roster[2].operator_name, "charlie");
    }

    #[test]
    fn escalations_are_oldest_first() {
        let snap = assemble_snapshot(vec![
            row("op-a", "alpha", "s-new", TileStatus::Blocked, 500),
            row("op-b", "bravo", "s-old", TileStatus::Blocked, 100),
            row("op-c", "char",  "s-mid", TileStatus::Blocked, 300),
        ]);
        let order: Vec<_> = snap.escalations.iter().map(|e| e.session_id.as_str()).collect();
        assert_eq!(order, vec!["s-old", "s-mid", "s-new"]);
    }

    #[test]
    fn escalations_only_include_blocked_status() {
        let snap = assemble_snapshot(vec![
            row("op-a", "alpha", "s1", TileStatus::Working, 0),
            row("op-b", "bravo", "s2", TileStatus::Blocked, 100),
            row("op-c", "char",  "s3", TileStatus::AwaitingInput, 200),
        ]);
        assert_eq!(snap.escalations.len(), 1);
        assert_eq!(snap.escalations[0].session_id, "s2");
    }
```

- [ ] **Step 2: Run tests to verify they fail (build error or assertion)**

Run: `cargo test -p covenant convergence::tests --lib`
Expected: COMPILE ERROR (`build_convergence_snapshot` body still references the old `built` struct), OR the new tests don't link because `assemble_snapshot` isn't defined yet.

If the helper extraction is done correctly the new tests should pass on first run — that's also acceptable. The point is the test code is in the file.

- [ ] **Step 3: Update `lib.rs` callers — construct new `SessionInput` fields**

In `crates/app/src/lib.rs`, find the `get_convergence_snapshot` Tauri command (search for `fn get_convergence_snapshot`). It builds `Vec<convergence::SessionInput>` from `state.sessions`. Replace each `.map(|(id, ms)| convergence::SessionInput { ... })` site (there are two — one here, one in `get_blocked_session_ids` around line 1048) with the operator-aware construction:

```rust
let inputs: Vec<convergence::SessionInput> = {
    let sessions = state.sessions.lock().await;
    let mut out = Vec::with_capacity(sessions.len());
    for (id, ms) in sessions.iter() {
        // Operator metadata. None means unassigned; snapshot drops it.
        let op = state.operator.get_assigned_operator(*id).await;
        let (operator_id, operator_name, operator_avatar) = match op {
            Some(o) => (Some(o.id.clone()), Some(o.name.clone()), o.emoji.clone()),
            None => (None, None, None),
        };
        // Tab metadata. The tab manager owns title/color; the
        // backend reads via state.tabs.lookup(*id) (see tab manifest).
        let (tab_title, tab_color) = state
            .tabs
            .read()
            .await
            .lookup(*id)
            .map(|t| (t.title.clone(), t.color.clone()))
            .unwrap_or_else(|| (String::from("untitled"), None));

        out.push(convergence::SessionInput {
            session_id: *id,
            op_state: ms.op_state.clone(),
            tab_title,
            tab_color,
            operator_id,
            operator_name,
            operator_avatar,
        });
    }
    out
};
```

**Important:** The exact API names (`state.operator.get_assigned_operator`, `state.tabs.read().await.lookup`) may not match what's already in the codebase. Before writing the above, run:

```bash
rg -n "fn get_assigned_operator|assigned_operator|fn lookup|tabs:" crates/app/src/operator.rs crates/app/src/lib.rs | head -30
```

If the helper does not exist verbatim:
- For operator: there must already be a way to read the operator assigned to a session (used by the existing tile builder via `is_enabled`/`is_thinking`). Use whatever read accessor exists; if only an id is exposed, look up the operator's display name + avatar through the operator registry / settings store. **Do NOT add a new public surface to `operator.rs`** — if the data is not reachable read-only, ESCALATE rather than widening the module.
- For tab metadata: the backend already persists a tab manifest (search `tab_manifest_load`/`tab_manifest_save`). If runtime tab title/color is only in the frontend, fall back to passing those from the UI: extend the `get_convergence_snapshot` Tauri command signature to accept `tabs: Vec<TabHint { session_id, title, color }>` and merge in the backend. Document the chosen approach inline in the function.

Pick the path that requires the fewest changes outside the agreed file boundaries. Commit message must call out which path was taken.

- [ ] **Step 4: Update `get_blocked_session_ids` to read `snap.escalations`**

Replace its tail (currently filtering `snap.tiles`):

```rust
Ok(snap.escalations.into_iter().map(|e| e.session_id).collect())
```

The `inputs` construction must mirror the same pattern used in Step 3 (factor it into a small private helper `build_session_inputs(&state).await -> Vec<SessionInput>` to avoid duplication — define it just above `get_convergence_snapshot`).

- [ ] **Step 5: Run all tests + check**

Run: `cargo test -p covenant && cargo check -p covenant`
Expected: PASS. If `get_blocked_session_ids` callers in TS still compile (they read a `string[]`, not the snapshot shape, so they should), nothing else changes.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/convergence.rs crates/app/src/lib.rs
git commit -m "feat(convergence): wire roster + escalations through Tauri commands

build_convergence_snapshot now drops unassigned tabs and groups by
operator. Adds unit tests for grouping, escalation ordering, and
sort-on-escalation. get_blocked_session_ids reads snap.escalations.
Spec 3.8.1 Task 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Frontend types + tabs-bridge

Update `api.ts` to mirror the new backend shape and extend the tabs-bridge with double-click semantics. The bridge no longer filters tabs — backend does that.

**Files:**
- Modify: `ui/src/api.ts`
- Modify: `ui/src/convergence/tabs-bridge.ts`

- [ ] **Step 1: Replace types in `api.ts`**

Open `ui/src/api.ts` around line 731. Replace the `ConvergenceTileState` and `ConvergenceSnapshot` interfaces with:

```typescript
export interface SessionSummary {
  session_id: string;
  tab_title: string;
  tab_color: string | null;
  status: TileStatus;
  vendor: Vendor;
  raw_command_label: string | null;
  last_command: string | null;
  last_output_line: string | null;
  last_decision_action: string | null;
  last_decision_rationale: string | null;
  mission_name: string | null;
  cost_usd: number | null;
  budget_usd: number | null;
}

export interface OperatorRosterEntry {
  operator_id: string;
  operator_name: string;
  operator_avatar: string | null;
  sessions: SessionSummary[];
  has_escalation: boolean;
}

export interface EscalationCard {
  session_id: string;
  tab_title: string;
  tab_color: string | null;
  operator_id: string;
  operator_name: string;
  operator_avatar: string | null;
  vendor: Vendor;
  raw_command_label: string | null;
  question: string | null;
  mission_name: string | null;
  escalated_at_unix_ms: number;
}

export interface ConvergenceSnapshot {
  roster: OperatorRosterEntry[];
  escalations: EscalationCard[];
}
```

Leave `getConvergenceSnapshot` and `submitConvergenceReply` signatures unchanged — only the return type shape differs.

The old `ConvergenceTileState` export must be removed. After saving, run:

```bash
rg -n "ConvergenceTileState" ui/src/
```

If anything outside `ui/src/convergence/` still references it, ESCALATE — that means an unexpected consumer leaked from the spec's file boundaries.

- [ ] **Step 2: Extend `TabMeta` and bridge with `keepOverlayOpen` option**

Open `ui/src/convergence/tabs-bridge.ts`. Replace `TabMeta` (defined in `overlay.ts`) usage by extending it. First, in `overlay.ts`, change:

```typescript
export interface TabMeta {
  sessionId: string;
  title: string;
  color: string | null;
  operatorAvatar: string | null;
  operatorName: string | null;
}

export interface ConvergenceTabBridge {
  listTabs(): TabMeta[];
  activateBySessionId(sessionId: string): boolean;
}
```

to:

```typescript
export interface TabMeta {
  sessionId: string;
  title: string;
  color: string | null;
}

export interface ConvergenceTabBridge {
  listTabs(): TabMeta[];
  /** When `keepOverlayOpen` is true, the overlay caller will not close
   * itself after focusing — used by the double-click "keep open" UX. */
  activateBySessionId(sessionId: string, opts?: { keepOverlayOpen?: boolean }): boolean;
}
```

Operator avatar/name now come from the snapshot directly, so they leave `TabMeta`.

In `tabs-bridge.ts`, simplify `makeTabsBridge` — drop the operator cache entirely (operator metadata is in `snap.roster` now):

```typescript
import type { TabManager } from "../tabs/manager";
import type { ConvergenceTabBridge } from "./overlay";

interface TabManagerInternal {
  tabs: ReadonlyArray<{
    sessionId: string;
    defaultTitle: string;
    customName: string | null;
    color: string | null;
  }>;
}

export function makeTabsBridge(manager: TabManager): ConvergenceTabBridge {
  const internal = manager as unknown as TabManagerInternal;
  return {
    listTabs: () =>
      internal.tabs.map((t) => ({
        sessionId: t.sessionId,
        title: (t.customName?.trim() || t.defaultTitle) ?? "untitled",
        color: t.color,
      })),
    activateBySessionId: (id, _opts) =>
      manager.activateBySessionId(id as Parameters<typeof manager.activateBySessionId>[0]),
  };
}
```

The `_opts` parameter is ignored at the bridge level — `keepOverlayOpen` is honored by the *overlay* (it just doesn't call `close()`). The signature is preserved so future bridges can react if they need to.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: tsc will emit errors in `overlay.ts` and `tile.ts` because they still reference the old types. **Leave them** — Tasks 4–6 rewrite those files. Verify the only errors are in those two files. If errors leak elsewhere, ESCALATE.

- [ ] **Step 4: Commit (deferred)**

Do NOT commit yet — types are inconsistent until Tasks 4–6 land. Continue to Task 4 with the working tree dirty. (This is the one exception to the one-commit-per-task rule, called out explicitly so the executor doesn't get confused.)

---

## Task 4: Inbox column

Build the left column: list of `EscalationCard`, active-card highlight, multi-line reply textarea (auto-grow 2–8 lines), scope selector, `↑`/`↓`/`⌘↵` keyboard navigation, submit-and-advance.

**Files:**
- Modify: `ui/src/convergence/tile.ts` (replace exports)
- Modify: `ui/src/convergence/overlay.ts` (Inbox state + render)

- [ ] **Step 1: Replace `tile.ts` with three render functions**

Wholesale replace `ui/src/convergence/tile.ts` with three exported renderers. Total target ≤ 320 lines.

```typescript
import type { EscalationCard, OperatorRosterEntry, SessionSummary } from "../api";

type SubmitFn = (
  sessionId: string,
  text: string,
  scope: "one-shot" | "mission" | "global",
) => Promise<void>;

// =============== Inbox ===============

export interface InboxCardCallbacks {
  onActivate: (sessionId: string) => void;
  onSubmit: SubmitFn;
}

export function renderInboxCard(
  card: EscalationCard,
  isActive: boolean,
  cb: InboxCardCallbacks,
): HTMLElement {
  const root = document.createElement("article");
  root.className = "cv-inbox-card";
  root.dataset.sessionId = card.session_id;
  if (isActive) root.classList.add("cv-inbox-card--active");
  root.tabIndex = 0;

  // Header: avatar + tab title + ESCALATED + time
  const header = document.createElement("header");
  header.className = "cv-inbox-card__header";
  const avatar = document.createElement("span");
  avatar.className = "cv-avatar";
  avatar.textContent = card.operator_avatar ?? "👤";
  const title = document.createElement("strong");
  title.className = "cv-inbox-card__title";
  title.textContent = `${card.operator_name} · ${card.tab_title}`;
  const pill = document.createElement("span");
  pill.className = "cv-pill cv-pill--escalated";
  pill.textContent = "ESCALATED";
  const meta = document.createElement("span");
  meta.className = "cv-inbox-card__meta";
  meta.textContent = formatAgo(card.escalated_at_unix_ms);
  header.append(avatar, title, pill, meta);

  // Question
  const question = document.createElement("p");
  question.className = "cv-inbox-card__question";
  question.textContent = card.question ?? "(no question text)";

  root.append(header, question);

  // Reply composer (only on active card)
  if (isActive) {
    root.append(renderReplyComposer(card.session_id, cb.onSubmit));
  }

  root.addEventListener("click", (e) => {
    // Ignore clicks inside the reply composer.
    if ((e.target as HTMLElement).closest(".cv-reply")) return;
    cb.onActivate(card.session_id);
  });

  return root;
}

function renderReplyComposer(sessionId: string, onSubmit: SubmitFn): HTMLElement {
  const wrap = document.createElement("form");
  wrap.className = "cv-reply";
  wrap.addEventListener("submit", (e) => e.preventDefault());

  const textarea = document.createElement("textarea");
  textarea.className = "cv-reply__textarea";
  textarea.placeholder = "Reply to operator…";
  textarea.rows = 2;
  textarea.addEventListener("input", () => autoGrow(textarea));

  const controls = document.createElement("div");
  controls.className = "cv-reply__controls";
  const scope = document.createElement("select");
  scope.className = "cv-reply__scope";
  for (const v of ["one-shot", "mission", "global"]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    scope.append(o);
  }
  const send = document.createElement("button");
  send.type = "button";
  send.className = "cv-reply__send";
  send.textContent = "Send ⌘↵";

  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    await onSubmit(
      sessionId,
      text,
      scope.value as "one-shot" | "mission" | "global",
    );
    textarea.value = "";
    autoGrow(textarea);
  };

  send.addEventListener("click", () => void submit());
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  });

  controls.append(scope, send);
  wrap.append(textarea, controls);
  return wrap;
}

function autoGrow(ta: HTMLTextAreaElement): void {
  // Auto-grow up to 8 lines (≈ 8 * line-height); scroll past that.
  ta.style.height = "auto";
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  const max = lh * 8;
  ta.style.height = Math.min(ta.scrollHeight, max) + "px";
  ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
}

function formatAgo(unixMs: number): string {
  if (!unixMs) return "just now";
  const seconds = Math.max(0, Math.floor((Date.now() - unixMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// =============== Roster (stub for Task 5) ===============

export interface RosterRowCallbacks {
  onFocus: (sessionId: string, keepOpen: boolean) => void;
  onToggleExpand: (operatorId: string) => void;
}

export function renderRosterRow(
  _entry: OperatorRosterEntry,
  _expanded: boolean,
  _cb: RosterRowCallbacks,
): HTMLElement {
  // Implemented in Task 5.
  const placeholder = document.createElement("div");
  placeholder.textContent = "(roster row — implemented in Task 5)";
  return placeholder;
}

export function renderRosterSubRow(
  _summary: SessionSummary,
  _cb: RosterRowCallbacks,
): HTMLElement {
  // Implemented in Task 5.
  return document.createElement("div");
}
```

- [ ] **Step 2: Add Inbox state + render to `overlay.ts`**

Replace `overlay.ts` body. Keep `ConvergenceOverlay` class name and `toggle()/open()/close()/isVisible()` public API. New private state:

- `private activeEscalationId: string | null` — currently-selected Inbox card.
- `private snap: ConvergenceSnapshot | null` — last snapshot, kept for keyboard nav.
- DOM refs: `inboxEl`, `rosterEl`.

Replace `mount()` to create two columns (use placeholders for filter chips/roster body until Task 5):

```typescript
private mount(): void {
  const root = document.createElement("div");
  root.className = "convergence-overlay";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Convergence Mode");

  const header = document.createElement("div");
  header.className = "convergence-overlay__header";
  const title = document.createElement("h1");
  title.className = "convergence-overlay__title";
  title.textContent = "CONVERGENCE";
  const exit = document.createElement("button");
  exit.type = "button";
  exit.className = "modal-cancel-btn";
  exit.title = "Close (Esc)";
  exit.innerHTML = `<span>Exit</span><kbd class="modal-kbd">Esc</kbd>`;
  exit.addEventListener("click", () => this.close());
  header.append(title, exit);

  const grid = document.createElement("div");
  grid.className = "cv-grid";

  const inbox = document.createElement("section");
  inbox.className = "cv-inbox";

  const roster = document.createElement("section");
  roster.className = "cv-roster";

  const empty = document.createElement("div");
  empty.className = "convergence-overlay__empty";
  empty.textContent = "No operators assigned";
  empty.hidden = true;

  grid.append(inbox, roster);
  root.append(header, grid, empty);
  document.body.append(root);

  this.root = root;
  this.inboxEl = inbox;
  this.rosterEl = roster;
  this.empty = empty;

  // Keyboard: ↑/↓ moves active card (only when no textarea focus or
  // the textarea is empty); ⌘↵ submit handled inside composer.
  this.escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest(".cv-reply")) {
        e.preventDefault(); e.stopPropagation();
        active.blur();
        return;
      }
      e.preventDefault(); e.stopPropagation();
      this.close();
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const active = document.activeElement as HTMLElement | null;
      const insideTextarea = active?.tagName === "TEXTAREA";
      if (insideTextarea) {
        const ta = active as HTMLTextAreaElement;
        if (ta.value.length > 0) return; // let caret movement happen
      }
      e.preventDefault();
      this.moveActive(e.key === "ArrowDown" ? 1 : -1);
    }
  };
  document.addEventListener("keydown", this.escHandler, { capture: true });
}
```

Add `moveActive` and Inbox renderer:

```typescript
private moveActive(delta: number): void {
  const list = this.snap?.escalations ?? [];
  if (list.length === 0) return;
  const idx = list.findIndex((e) => e.session_id === this.activeEscalationId);
  const next = (idx === -1 ? 0 : idx + delta + list.length) % list.length;
  this.activeEscalationId = list[next].session_id;
  this.renderInbox();
}

private renderInbox(): void {
  if (!this.inboxEl || !this.snap) return;
  const list = this.snap.escalations;
  this.inboxEl.replaceChildren();

  const headerRow = document.createElement("div");
  headerRow.className = "cv-inbox__header";
  headerRow.textContent =
    list.length > 0 ? `Inbox · ${list.length} awaiting you` : "Inbox";
  this.inboxEl.append(headerRow);

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cv-inbox__empty";
    empty.textContent = "Nothing awaiting you";
    this.inboxEl.append(empty);
    this.activeEscalationId = null;
    return;
  }

  if (
    !this.activeEscalationId ||
    !list.some((e) => e.session_id === this.activeEscalationId)
  ) {
    this.activeEscalationId = list[0].session_id;
  }

  for (const card of list) {
    this.inboxEl.append(
      renderInboxCard(
        card,
        card.session_id === this.activeEscalationId,
        {
          onActivate: (sid) => {
            this.activeEscalationId = sid;
            this.renderInbox();
          },
          onSubmit: this.submitReply.bind(this),
        },
      ),
    );
  }
}
```

Update `refresh()` to call `renderInbox()` (Roster goes into Task 5):

```typescript
private async refresh(): Promise<void> {
  if (!this.visible || !this.inboxEl || !this.rosterEl || !this.empty) return;
  try {
    this.snap = await getConvergenceSnapshot();
  } catch (err) {
    console.warn("convergence snapshot failed", err);
    return;
  }
  if (this.snap.roster.length === 0 && this.snap.escalations.length === 0) {
    this.inboxEl.replaceChildren();
    this.rosterEl.replaceChildren();
    this.empty.hidden = false;
    return;
  }
  this.empty.hidden = true;
  this.renderInbox();
  // Roster rendering: Task 5.
}
```

Drop the old `tiles` Map and the click-on-grid handler. Imports change:

```typescript
import {
  getConvergenceSnapshot,
  submitConvergenceReply,
  type ConvergenceSnapshot,
} from "../api";
import { renderInboxCard } from "./tile";
```

- [ ] **Step 3: Manual smoke + tsc**

Run: `npx tsc --noEmit`
Expected: PASS for the Inbox path. Roster section will be empty because Task 5 hasn't built it. Briefly run the dev server to verify the overlay opens and an escalation card renders with a working textarea (manual). If you cannot reach an escalation manually, defer manual smoke until Task 7 (the spec's Acceptance criteria are checked there).

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts ui/src/convergence/tile.ts ui/src/convergence/overlay.ts ui/src/convergence/tabs-bridge.ts
git commit -m "feat(convergence): Inbox column with multi-line reply composer

EscalationCard list with active-card highlight, ↑/↓ keyboard nav, and
auto-growing textarea (2–8 lines) + scope selector. Backend types
mirrored in api.ts. Roster column lands in Task 5. Spec 3.8.1 Tasks 3–4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Roster column

Build the right column: per-operator rows, expandable sub-rows, filter chips, click semantics (single vs double vs caret).

**Files:**
- Modify: `ui/src/convergence/tile.ts` (replace `renderRosterRow`/`renderRosterSubRow` stubs)
- Modify: `ui/src/convergence/overlay.ts` (add `renderRoster`, filter state, double-click handling)

- [ ] **Step 1: Implement roster renderers**

Replace the two stubs in `tile.ts`:

```typescript
export function renderRosterRow(
  entry: OperatorRosterEntry,
  expanded: boolean,
  cb: RosterRowCallbacks,
): HTMLElement {
  const root = document.createElement("article");
  root.className = "cv-roster-row";
  if (entry.has_escalation) root.classList.add("cv-roster-row--escalated");
  root.dataset.operatorId = entry.operator_id;

  const head = document.createElement("div");
  head.className = "cv-roster-row__head";
  const avatar = document.createElement("span");
  avatar.className = "cv-avatar";
  avatar.textContent = entry.operator_avatar ?? "👤";
  const name = document.createElement("strong");
  name.className = "cv-roster-row__name";
  name.textContent = entry.operator_name;
  const count = document.createElement("span");
  count.className = "cv-roster-row__count";
  count.textContent =
    entry.sessions.length > 1 ? `${entry.sessions.length} sessions` : "";
  const caret = document.createElement("button");
  caret.type = "button";
  caret.className = "cv-roster-row__caret";
  caret.setAttribute("aria-label", expanded ? "Collapse" : "Expand");
  caret.textContent = expanded ? "▾" : "▸";
  if (entry.sessions.length <= 1) caret.style.visibility = "hidden";
  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    cb.onToggleExpand(entry.operator_id);
  });
  head.append(avatar, name, count, caret);
  root.append(head);

  // Single-session: head row is itself clickable (focuses that session).
  if (entry.sessions.length === 1) {
    const only = entry.sessions[0];
    head.addEventListener("click", () => cb.onFocus(only.session_id, false));
    head.addEventListener("dblclick", () => cb.onFocus(only.session_id, true));
    head.classList.add("cv-roster-row__head--clickable");
    const status = document.createElement("span");
    status.className = `cv-pill cv-pill--${only.status}`;
    status.textContent = only.status;
    head.insertBefore(status, caret);
  }

  if (expanded && entry.sessions.length > 1) {
    const sub = document.createElement("div");
    sub.className = "cv-roster-row__sub";
    for (const s of entry.sessions) sub.append(renderRosterSubRow(s, cb));
    root.append(sub);
  }
  return root;
}

export function renderRosterSubRow(
  summary: SessionSummary,
  cb: RosterRowCallbacks,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "cv-roster-sub";
  row.dataset.sessionId = summary.session_id;

  const dot = document.createElement("span");
  dot.className = `cv-status-dot cv-status-dot--${summary.status}`;
  const title = document.createElement("span");
  title.className = "cv-roster-sub__title";
  title.textContent = summary.tab_title;
  const status = document.createElement("span");
  status.className = "cv-roster-sub__status";
  status.textContent =
    summary.status === "blocked"
      ? "escalated"
      : summary.last_command
      ? `${summary.status} · ${summary.last_command.slice(0, 40)}`
      : summary.status;

  row.append(dot, title, status);
  row.addEventListener("click", () => cb.onFocus(summary.session_id, false));
  row.addEventListener("dblclick", () => cb.onFocus(summary.session_id, true));
  return row;
}
```

- [ ] **Step 2: Add roster + filter state to overlay**

Add private state to `ConvergenceOverlay`:

```typescript
private filter: "all" | "escalated" | "working" | "idle" = "all";
private expanded = new Set<string>(); // operator ids
```

Add `renderRoster`:

```typescript
private renderRoster(): void {
  if (!this.rosterEl || !this.snap) return;
  this.rosterEl.replaceChildren();

  const header = document.createElement("div");
  header.className = "cv-roster__header";
  const label = document.createElement("span");
  label.className = "cv-roster__label";
  label.textContent = `Roster · ${this.snap.roster.length} operators`;
  const chips = document.createElement("div");
  chips.className = "cv-roster__chips";
  for (const v of ["all", "escalated", "working", "idle"] as const) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "cv-chip" + (this.filter === v ? " cv-chip--active" : "");
    chip.textContent = v;
    chip.addEventListener("click", () => {
      this.filter = v;
      this.renderRoster();
    });
    chips.append(chip);
  }
  header.append(label, chips);
  this.rosterEl.append(header);

  const filtered = this.snap.roster.filter((entry) => {
    if (this.filter === "all") return true;
    if (this.filter === "escalated") return entry.has_escalation;
    return entry.sessions.some((s) => s.status === this.filter);
  });

  for (const entry of filtered) {
    // Auto-expand any operator with an escalation; otherwise honor user toggle.
    const expanded = entry.has_escalation || this.expanded.has(entry.operator_id);
    this.rosterEl.append(
      renderRosterRow(entry, expanded, {
        onFocus: (sid, keepOpen) => {
          const ok = this.bridge.activateBySessionId(sid, { keepOverlayOpen: keepOpen });
          if (ok && !keepOpen) this.close();
        },
        onToggleExpand: (opId) => {
          if (this.expanded.has(opId)) this.expanded.delete(opId);
          else this.expanded.add(opId);
          this.renderRoster();
        },
      }),
    );
  }
}
```

Update `refresh()` to also call `this.renderRoster()`. Update imports in `overlay.ts`:

```typescript
import { renderInboxCard, renderRosterRow } from "./tile";
```

- [ ] **Step 3: tsc + commit**

Run: `npx tsc --noEmit`
Expected: PASS.

```bash
git add ui/src/convergence/tile.ts ui/src/convergence/overlay.ts
git commit -m "feat(convergence): Roster column with filter chips and click semantics

Per-operator rows with disclosure caret for multi-session operators,
auto-expand on escalation, filter chips (all/escalated/working/idle),
single-click = focus + close, double-click = focus + keep open,
caret-only = toggle. Spec 3.8.1 Task 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Styles + responsive layout

Append redesigned CSS, remove obsolete tile-grid styles. Targets `min-width: 960px` two-column, stacks below.

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Locate and remove obsolete styles**

Run:
```bash
rg -n "convergence-overlay__grid|convergence-tile" ui/src/styles.css | head -5
```

Delete the matching rule blocks (the old grid layout + tile styles). Preserve `.convergence-overlay`, `.convergence-overlay__header`, `.convergence-overlay__title`, and `.convergence-overlay__empty` — those still apply.

- [ ] **Step 2: Append new styles**

Append at the end of `ui/src/styles.css`:

```css
/* ===== Convergence v2 (spec 3.8.1) ===== */
.cv-grid {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 0;
  height: calc(100% - 64px);
  overflow: hidden;
}
@media (max-width: 960px) {
  .cv-grid { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; }
}

.cv-inbox, .cv-roster {
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cv-inbox { border-right: 1px solid var(--border-subtle); }
.cv-roster { background: var(--bg-overlay); }

.cv-inbox__header, .cv-roster__header {
  font-size: 11px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--text-muted);
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.cv-inbox__empty {
  color: var(--text-muted);
  font-style: italic;
  padding: 24px 0;
}

.cv-inbox-card {
  background: var(--bg-card);
  border: 1px solid var(--border-subtle);
  border-left: 3px solid var(--danger);
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  opacity: 0.7;
  transition: opacity 120ms ease;
}
.cv-inbox-card:hover { opacity: 0.9; }
.cv-inbox-card--active {
  opacity: 1;
  background: var(--bg-card-active, var(--bg-card));
  cursor: default;
}
.cv-inbox-card__header {
  display: flex; align-items: center; gap: 8px; margin-bottom: 6px;
}
.cv-inbox-card__title { font-size: 13px; }
.cv-inbox-card__meta {
  margin-left: auto; font-size: 10px; color: var(--text-muted);
}
.cv-inbox-card__question {
  font-size: 12px; line-height: 1.45; color: var(--text-secondary);
  margin: 0 0 10px 0;
}

.cv-reply {
  display: flex; gap: 8px; align-items: flex-end;
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
  border-radius: 8px; padding: 8px 10px;
}
.cv-reply__textarea {
  flex: 1; background: transparent; border: 0; resize: none; outline: none;
  color: var(--text-primary); font: inherit; font-size: 13px;
  min-height: calc(1.4em * 2);
}
.cv-reply__controls { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
.cv-reply__scope {
  background: var(--bg-card); border: 1px solid var(--border-subtle);
  color: var(--text-secondary); font-size: 11px; padding: 3px 6px; border-radius: 6px;
}
.cv-reply__send {
  background: var(--accent); color: white; border: 0;
  font-size: 11px; padding: 6px 12px; border-radius: 6px; cursor: pointer;
}

.cv-roster__chips { display: flex; gap: 4px; }
.cv-chip {
  background: transparent; border: 0; color: var(--text-muted);
  font-size: 10px; padding: 3px 8px; border-radius: 10px; cursor: pointer;
  letter-spacing: 0.05em;
}
.cv-chip--active { background: var(--bg-card); color: var(--text-primary); }

.cv-roster-row {
  background: var(--bg-card); border: 1px solid var(--border-subtle);
  border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
}
.cv-roster-row--escalated { border-left: 3px solid var(--danger); }
.cv-roster-row__head { display: flex; align-items: center; gap: 9px; }
.cv-roster-row__head--clickable { cursor: pointer; }
.cv-roster-row__name { font-size: 13px; flex: 1; }
.cv-roster-row__count { font-size: 10px; color: var(--text-muted); }
.cv-roster-row__caret {
  background: transparent; border: 0; color: var(--text-muted);
  font-size: 14px; cursor: pointer; padding: 2px 4px;
}
.cv-roster-row__sub { display: flex; flex-direction: column; gap: 5px; padding-left: 31px; }
.cv-roster-sub {
  display: flex; align-items: center; gap: 8px; font-size: 11px; cursor: pointer;
}
.cv-roster-sub__title { color: var(--text-primary); }
.cv-roster-sub__status { color: var(--text-muted); margin-left: auto; }

.cv-status-dot {
  width: 6px; height: 6px; border-radius: 50%; display: inline-block;
  background: var(--text-muted);
}
.cv-status-dot--working { background: #5fff8a; }
.cv-status-dot--blocked { background: var(--danger); }
.cv-status-dot--awaiting-input { background: #ffcf5f; }

.cv-pill {
  font-size: 10px; padding: 2px 7px; border-radius: 10px;
  letter-spacing: 0.06em; background: var(--bg-card-active, var(--bg-card));
  color: var(--text-muted);
}
.cv-pill--escalated, .cv-pill--blocked { background: rgba(232,90,90,0.12); color: var(--danger); }
.cv-pill--working { color: #5fff8a; }

.cv-avatar {
  width: 22px; height: 22px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--bg-card-active, var(--bg-card));
  font-size: 13px; flex-shrink: 0;
}
```

If `--danger` is not defined elsewhere in `ui/src/styles.css` (`rg -n -- '--danger:' ui/src/styles.css`), add it next to the other accent tokens at the top of the file (look for `--accent:`):

```css
  --danger: #e85a5a;
```

Single token — no other new colors.

- [ ] **Step 3: Manual visual smoke**

Run the dev server (`npm run tauri dev` from `ui/`, or whatever the repo's standard is). Open Convergence (`⌘⇧M`) with a few tabs assigned to operators and at least one escalated session. Verify:

1. Two columns render with the proportions in the spec.
2. The escalated card on the left shows the question and a working textarea.
3. The roster on the right shows operators grouped (test by assigning the same operator to two tabs).
4. Filter chips switch the roster contents.
5. Single click on a roster row → focus + close. Double click → focus + keep open. Click on the caret of a multi-session row toggles expansion only.
6. `↑`/`↓` moves the active Inbox card; `⌘↵` submits.
7. `Esc` blurs the textarea first, then closes.

If a check fails, fix in this task before committing. Document in the commit body any check that could not be verified manually.

- [ ] **Step 4: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(convergence): styles for Inbox + Roster two-pane layout

Two-column grid (1.3fr / 1fr, stacks under 960px), escalation accent
via single new --danger token, filter chip + roster row + reply
composer styles. Removes obsolete tile-grid CSS. Spec 3.8.1 Task 6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Cleanup + acceptance pass

Final pass: walk the spec's acceptance criteria with the running app, fix anything missed, remove dead code.

- [ ] **Step 1: Spec walkthrough**

Open `docs/specs/3.8.1-convergence-redesign.md`. For each `- [ ]` checkbox in the Acceptance criteria section, verify in the running app and fix any failures inline. Common gotchas to expect:

- Empty-state copy ("No operators assigned" vs "Nothing awaiting you") — they are different strings in different places.
- Caret hit area must NOT bubble to row click. Verify `e.stopPropagation()` in `caret.addEventListener`.
- When the user submits a reply and the active card was the only escalation, the Inbox should fall back to the "Nothing awaiting you" state on the next 1 s tick (no manual refresh needed).
- After unassigning an operator from a tab mid-session, that tab should disappear from both columns within 1.5 s.

- [ ] **Step 2: Dead code sweep**

```bash
rg -n "ConvergenceTileState|convergence-tile|convergence-overlay__grid" ui/ crates/
```

Expected: zero hits. If any remain, delete (file boundaries already say "replace, do not parallel").

- [ ] **Step 3: Quality gates**

Run:
```bash
cargo test -p covenant
cargo check -p covenant
npx tsc --noEmit
```

All three must pass.

- [ ] **Step 4: Commit (only if anything changed)**

```bash
git add -A
git commit -m "chore(convergence): acceptance pass + dead code sweep

Spec 3.8.1 Task 7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If nothing changed, skip the commit — Task 6 was complete.

---

## Spec coverage check

| Spec acceptance criterion | Task |
|---|---|
| `⌘⇧M` toggles overlay, two-Esc behavior | 4 (overlay mount) |
| Two-column grid 1.3fr/1fr, stacks <960px | 6 |
| 1 s snapshot poll, ≤1.5 s update | 4 (refresh loop, unchanged) |
| Empty state "No operators assigned" | 4 (refresh) + 6 (style) |
| Vibrancy via `--bg-overlay`, no new tokens beyond `--danger` | 6 |
| Drop unassigned tabs | 1 (snapshot builder) |
| Roster groups by operator id, sub-rows on N>1 | 1 (snapshot) + 5 (renderer) |
| Auto-expand on escalation; otherwise user toggle | 5 (`renderRoster`) |
| Filter chips all/escalated/working/idle | 5 |
| Roster sort: escalation first, then activity, then name | 1 (snapshot) — activity tiebreak by escalated_at_unix_ms reuse; name tiebreak in `assemble_snapshot` |
| Inbox one card per escalated session | 1 + 4 |
| Inbox header `N awaiting you`, fallback empty | 4 |
| Active card highlight, ↑/↓ nav, click to activate | 4 |
| Reply: multi-line auto-grow 2–8, scope, ⌘↵, advance | 4 |
| Roster row contents (avatar/name/N sessions chip/caret) | 5 |
| Sub-row content + truncation | 5 |
| Click semantics: single/double/caret | 5 (renderer) + bridge accepts `keepOverlayOpen` (3) |
| Cost footer when AOM-enrolled | 1 (carried in `SessionSummary`); UI rendering — **gap** |
| `cargo check` + `tsc` clean | 7 |
| Backend unit tests | 2 |
| No new color tokens beyond `--danger` | 6 |

**Identified gap:** the cost footer in roster sub-rows is not explicitly rendered in Task 5. Mitigation: in Task 5 Step 1, add to `renderRosterSubRow` after the `status` span:

```typescript
if (summary.cost_usd != null && summary.budget_usd != null) {
  const cost = document.createElement("span");
  cost.className = "cv-roster-sub__cost";
  cost.textContent = `$${summary.cost_usd.toFixed(2)} / $${summary.budget_usd.toFixed(2)}`;
  row.append(cost);
}
```

And add a CSS rule in Task 6:
```css
.cv-roster-sub__cost { font-size: 10px; color: var(--text-muted); margin-left: 8px; }
```

The executor must apply both edits when reaching those tasks.
