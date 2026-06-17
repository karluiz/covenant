# Inter-Operator Handoff — Skill-Based Routing Design

> Revises the addressing contract of `2026-06-16-inter-operator-handoff-design.md`
> (and the merged Plan 1 backend). Sequencing: this lands **before** the UI auto-spawn
> (`2026-06-16-inter-operator-handoff-ui-design.md`, Plan 2) matters, because without it
> a handoff cannot reliably reach the right operator.

## Problem

Plan 1 (merged, v0.8.87) addresses handoffs **by operator name**:

- `handoff_task` requires `to_operator: "<exact name>"` — a free-form string, not even an
  enum (`crates/app/src/teammate/tools.rs:654`).
- **The delegating LLM is never shown the roster.** `build_system_prompt` (`llm.rs:176`)
  injects only the operator's *own* name + persona. To name a peer the model must
  guess/hallucinate; the router then case-insensitively name-matches
  (`handoff.rs:28`) and rejects on miss.
- `Operator.tags: Vec<String>` already exists as a natural skillset carrier and is
  **entirely unused in logic** — cosmetic only (`operator_registry.rs:34`).

Net: autonomous handoff can't reliably target anyone. A delegator should describe *what
capability the work needs*, not memorize who's on the team.

## Principle

A handoff is worth doing only on a **specialty mismatch** — a self-contained sub-task a
peer is better placed to do. Since specialty is *why* you delegate, specialty is *how* you
should choose the target. The delegator declares the **need**; the system resolves the
**worker**. Names become an implementation detail (rename-safe).

## Decisions (locked)

1. **Skills = the existing `tags` field.** Treat `Operator.tags` as the operator's
   skillset. No schema migration (already persisted in SOUL.md frontmatter + DB). The
   operator editor UI relabels "Tags" → "Skills".
2. **The tool advertises available skills as a dynamic enum.** `handoff_task`'s
   `required_skills` field carries an `enum` computed at call-build time = the
   case-normalized union of all operators' tags. The LLM picks capabilities that *exist* —
   no roster injection, no hallucinated skills, negligible token cost.
3. **Best-overlap matching, require ≥1.** Score each candidate by the count of requested
   skills it covers (case-insensitive). Reject only if no operator overlaps at all
   (`NoCapableOperator`). Forgiving when tags are sparse.
4. **Selection rank = (available, overlap score, XP), self excluded.** Among operators with
   overlap ≥ 1 and id ≠ delegator: prefer **available** (not `OperatorState::OnTask`), then
   **higher overlap score**, then **higher XP**. Availability outranks raw score so the
   handoff routes to someone who can *start now* rather than a perfect-but-busy peer (which
   the busy gate would otherwise reject). The delegator is excluded from candidates, so
   self-handoff cannot be selected.

## Changes

### 1. Tool contract — `handoff_task` (`teammate/tools.rs`)

Replace the `to_operator` property with `required_skills`. Make the def take the available
skill vocabulary so the enum is dynamic:

```rust
pub fn handoff_task_tool_def(available_skills: &[String]) -> Value
```

- `required_skills`: `{ "type": "array", "items": { "type": "string", "enum": [<available_skills>] }, "minItems": 1, "description": "The capabilities the work needs. The system routes to the best-suited available teammate — you do NOT name anyone." }`
- Keep `brief`, `deliverable`, `executor`, `context`.
- **Empty vocabulary → omit the tool.** If the roster has zero tags across all operators,
  `handoff_task` is excluded from the tool roster entirely (skill routing is impossible
  with no skills; this also nudges the user to tag operators). The roster builder
  (`all_tool_defs`) must therefore be passed the available-skills slice and conditionally
  include the tool.

### 2. Types (`teammate/types.rs`)

`HandoffRequest` swaps the name for skills:

```rust
pub struct HandoffRequest {
    pub required_skills: Vec<String>,   // was: to_operator: String
    pub brief: String,
    pub deliverable: String,
    pub executor: String,
    #[serde(default)]
    pub context: Option<String>,
}
```

### 3. Extraction (`teammate/llm.rs`)

`extract_handoff_from_content` (and the OpenAI-tool-calls sibling) parse `required_skills`
as a string array instead of `to_operator`. Threading: `all_tool_defs` gains an
`available_skills: &[String]` parameter (derived from `registry.list()` tag-union at the
dispatch site) so the dynamic enum + conditional inclusion work.

### 4. Router resolution (`teammate/handoff.rs`)

`resolve(roster, name)` becomes a skill matcher:

```rust
fn resolve_by_skills(
    roster: &[Operator],
    required: &[String],
    from: OperatorId,
    is_available: &dyn Fn(OperatorId) -> bool,   // runtime: not OnTask
) -> Option<OperatorId>
```

- Normalize skills to lowercase for comparison.
- Candidates: `o.id != from` AND `overlap(o.tags, required) >= 1`.
- Rank lexicographically by `(is_available(o.id) as u8, overlap_count, o.xp)` descending;
  return the top, or `None` if no candidate overlaps.
- `route()` passes the chosen id into the existing safety gate as `to: Option<OperatorId>`.
  The chain/depth/cycle logic is unchanged. The gate's busy check still fires if *every*
  candidate was busy (the ranked pick is then the least-bad and gets `ReceiverBusy`).

### 5. Safety gate (`teammate/handoff_safety.rs`)

Rename the `UnknownOperator` reject to `NoCapableOperator` (semantics: `to == None` now
means "no operator overlaps the requested skills," not "name didn't resolve"). Message:
`"no available teammate has the requested skills"`. `decide()` is otherwise unchanged
(`to: None` → `Err(NoCapableOperator)` is the same branch). Self-handoff stays as a
defensive invariant even though resolution already excludes self.

### 6. System prompt (`teammate/llm.rs`)

Update the `handoff_task` blurb: "delegate a self-contained sub-task by the **capabilities
it needs** — the system routes to the best-suited available teammate; you do not name
anyone. Use when a peer's skills fit the work better than yours."

### 7. `HandoffRouted` event (`teammate/commands.rs`)

Unchanged for the UI plan — after resolution we still have the chosen `to_operator` id,
which is what the Plan 2 listener consumes. (Optional, deferrable: add `matched_skills` to
the payload for future Convergence UI; not required here.)

### 8. UI (operator editor)

Relabel the existing tags input as **"Skills"** with helper text explaining these drive
inter-operator routing. No data change (still writes `tags`). This is the only frontend
touch in this change set.

## Data flow

```
delegator LLM  ──handoff_task{ required_skills:["rust","migrations"], brief, deliverable, executor }──▶
   extract_handoff_from_content → HandoffRequest
   route():
     resolve_by_skills(roster, required, from, is_available)  ── overlap≥1, rank (avail,score,xp), self-excluded
        │
        ├─ Some(id) → safety gate (depth/cycle/chain/busy) → persist edge + create task → Accepted
        └─ None     → gate sees to=None → NoCapableOperator → persist rejected edge → Rejected
```

## Error / edge handling

- **No tags anywhere** → `handoff_task` tool omitted; the delegator simply can't delegate
  (correct — there's nothing to route on).
- **Empty `required_skills`** (LLM ignores `minItems`) → treated as zero overlap →
  `NoCapableOperator`.
- **Skill the LLM invents** → impossible if the enum is enforced; if a provider ignores the
  enum, the unknown skill yields zero overlap with any operator → `NoCapableOperator`.
- **All capable operators busy** → ranked pick returns a busy operator → existing
  `ReceiverBusy` reject (retry later). Consistent with Plan 1.

## Testing

Unit (`-p covenant_lib`):

1. `resolve_by_skills` — picks highest overlap; excludes the delegator even if it's the
   best match; tie-break prefers available over busy at equal score; tie-break prefers
   higher XP at equal score+availability; returns `None` on zero overlap.
2. Case-insensitive overlap (`"Rust"` tag matches `"rust"` request).
3. `handoff_task_tool_def(skills)` — `required_skills.items.enum` equals the deduped
   normalized union; tool omitted when `skills` is empty (assert at the `all_tool_defs`
   level).
4. `extract_handoff_from_content` — parses a `required_skills` array; ignores other tools;
   absent/empty array handled.
5. Router — happy path routes to the best-suited available operator and creates the
   task+edge; `NoCapableOperator` path persists a rejected edge with `task_id = None`.
6. Safety gate — `to: None` → `NoCapableOperator`; existing depth/cycle/chain/busy tests
   updated for the rename.

Regression: existing teammate suite stays green (`cargo test -p covenant_lib teammate::`),
keeping the test-gotchas in mind (narrow filters; telegram long-poll hangs under broad runs).

## Sequencing

1. **This change set** (skill routing) — backend + the one operator-editor relabel.
2. **Plan 2 UI auto-spawn** — unaffected by the addressing change (consumes a resolved
   `to_operator` id from the event). Can proceed in parallel or after.

## Out of scope

- Surfacing matched skills / routing rationale in the Convergence UI (future).
- Skill taxonomy / validation beyond free-form tags (YAGNI; the dynamic enum already
  constrains the LLM to skills that exist).
- Weighting skills (e.g. "primary" vs "secondary"); flat overlap count is sufficient v1.

## Self-review notes

- **Reuses, doesn't migrate:** `tags` is the carrier; no storage/SOUL change. Lowest-risk
  path to making skills functional.
- **The dynamic enum is the key move:** it gives the LLM the team's capability vocabulary
  without a roster, names, or token bloat, and makes hallucinated targets structurally
  impossible.
- **Availability-first selection** is a deliberate, flagged refinement of "score primary":
  it makes the feature actually route to someone who can start, instead of rejecting on a
  busy perfect-match. Called out in Decision 4 for review.
- **Gate stays pure:** the only safety change is a rename (`UnknownOperator` →
  `NoCapableOperator`); the depth/cycle/chain/busy discipline from Plan 1 is untouched.
