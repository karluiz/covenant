# Covenant — Multi-Operator (design)

> Promotes the gating spec `docs/specs/3.2-multi-operator.md` into an
> actionable design. Resolves its open questions. Implementation will
> be decomposed by `writing-plans` into 2–3 actionable sub-specs under
> `docs/specs/`.

## Goal

Replace the single `Settings → Operator` charter with a roster of named
operators (each with its own persona, escalate threshold, model, tags,
color, emoji), and let the user pin one operator per tab so the
behavior of the autonomous orchestrator (AOM) on that tab is shaped by
that operator's identity — visible from the tab strip, the statusbar,
and the operator-decisions panel.

## Non-goals (v1)

- **Auto-routing by tags / mission / cwd.** Tags exist as metadata only
  (display, filtering, future use). Assignment is manual.
- **Inter-operator awareness or handoff.** Each operator decides in
  isolation per its assigned tab. No "operator X is also working on
  tab Y" context in prompts. Tracked as future work below.
- **Per-operator quota.** Single global daily token cap stays. Cost
  is *tracked* per `operator_id` from day 1 so per-operator caps are
  feasible later without migration pain.
- **Relaxing the safety blocklist per operator.** The blocklist in
  `crates/app/src/safety.rs` remains global and inviolable. Operators
  differ only by `escalate_threshold` and `hard_constraints` (their
  ALWAYS-ASK-ME extension), never by what is safety-blocked.
- **Conflict resolution between operators.** With one operator per
  tab, no conflict surface exists in v1.
- **AFK overlay redesign.** AFK gets an additive "active operators"
  chip strip in its header; the rest of 3.4 is unchanged.
- **Mission feature changes.** Mission attach (3.1) is orthogonal; a
  tab has both a mission *and* an operator, independently set.

## Domain model

### `Operator`

```rust
pub struct Operator {
    pub id: OperatorId,             // Ulid
    pub name: String,               // "Master Chief", "Sec-Op", "Default"
    pub emoji: String,              // single grapheme; default "🤖"
    pub color: String,              // hex, used for chips
    pub tags: Vec<String>,          // metadata only in v1
    pub persona: String,            // long charter (today's Operator textarea)
    pub escalate_threshold: f32,    // 0.0–1.0, confidence below which → ESCALATE
    pub model: ModelId,             // sonnet | opus | haiku (per-operator)
    pub hard_constraints: String,   // free-text ALWAYS-ASK-ME extension
    pub is_default: bool,           // exactly one row has this true
    pub created_at: DateTime,
    pub updated_at: DateTime,
}
```

Invariants:

- Exactly one operator has `is_default = true`. Cannot delete the
  default. Setting another as default flips the previous.
- `name` is unique (case-insensitive). Used in chips and ESCALATE
  copy.
- The global safety blocklist applies to every operator. The persona
  and `hard_constraints` can only *add* asks, never subtract from
  safety.

### Tab → operator pinning

Tab manifest gains a nullable `operator_id` column. Resolution at
runtime:

```
effective_operator(tab) = tab.operator_id ?? Operator::default()
```

Existing tabs without `operator_id` resolve to the migrated `Default`
operator transparently.

### Cost / decisions tracking

`operator_decisions` and the cost ledger gain `operator_id NOT NULL`.
Migration backfills existing rows with the `Default` operator's id
(see "Migration" below). The cost-footer remains aggregate; the
operator-decisions panel adds an "Operator" filter and per-row chip.

## Surfaces (UI)

1. **Statusbar (3.7)**: operator chip to the left of the mission chip.
   Format `{emoji} {name}`, background = operator color. Click opens
   the operator picker (`⌘⇧O`).

2. **Tab strip**: operator chip beside the mission chip in each tab.
   Truncates to initials (≤ 3 chars) when the name is long
   ("Master Chief" → "MC").

3. **Operator picker (`⌘⇧O`)**: command-palette style modal, mirroring
   the Recall picker (`⌘P`).
   - Filterable list of operators (name, tags).
   - Right-pane preview: persona (truncated), threshold, model, tags.
   - `Enter` assigns to the active tab.
   - `n` = "New operator…" → opens Settings → Operators with a draft.
   - `e` = edits the highlighted operator in Settings.
   - `Esc` closes.

4. **Settings → Operators (plural)**: replaces today's singular
   "Operator" pane.
   - Left: list of operators, default marked with ⭐.
   - Right: editor — name, emoji, color picker, tags (chip input),
     persona (large textarea), escalate_threshold (slider with numeric
     readout), model (dropdown), hard_constraints (textarea).
   - Buttons: Duplicate, Delete (disabled when row is default or
     last), Set as default.

5. **Operator-decisions panel (existing)**: each decision row shows
   the operator chip (emoji + colored background). New filter "By
   operator" alongside existing filters. Closed-tab snapshot also
   captures `operator_id` + `operator_name` so the chip survives tab
   close.

6. **AFK overlay (3.4)**: header gains "Active operators:" followed by
   chips of operators that have produced a decision in the current
   AOM session. Additive only — no other AFK changes.

7. **ESCALATE notifications**: prefix the existing copy with the
   operator's name, e.g. `[Sec-Op] needs you on tab 2 — <reason>`.

## AOM behavior

The AOM orchestrator loop is unchanged in shape. The only difference:
when a decision is generated for a tab, the runtime resolves
`effective_operator(tab)` and uses *that operator's* persona,
threshold, model, and `hard_constraints` for the prompt. Cost is
attributed to that operator.

Convergence Mode (3.8) tiles remain independent; each tile uses its
tab's operator. No cross-tile coordination.

## Storage

New table:

```sql
CREATE TABLE operators (
    id           TEXT PRIMARY KEY,        -- Ulid
    name         TEXT NOT NULL,
    emoji        TEXT NOT NULL DEFAULT '🤖',
    color        TEXT NOT NULL,
    tags         TEXT NOT NULL DEFAULT '[]',  -- JSON array
    persona      TEXT NOT NULL,
    escalate_threshold REAL NOT NULL,
    model        TEXT NOT NULL,
    hard_constraints   TEXT NOT NULL DEFAULT '',
    is_default   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX operators_default_unique
    ON operators(is_default) WHERE is_default = 1;
CREATE UNIQUE INDEX operators_name_ci
    ON operators(LOWER(name));
```

Tab manifest:

```sql
ALTER TABLE tab_manifest ADD COLUMN operator_id TEXT;  -- nullable, FK soft
```

Decisions / cost ledger:

```sql
ALTER TABLE operator_decisions ADD COLUMN operator_id TEXT;
ALTER TABLE cost_ledger        ADD COLUMN operator_id TEXT;
-- backfilled to Default's id, then made NOT NULL in a follow-up
-- migration once backfill is verified.
```

## Migration (one-shot at first boot post-upgrade)

1. Read existing `Settings → Operator` charter (persona, threshold,
   model) from the current settings store.
2. Insert one `operators` row: `name = "Default"`,
   `emoji = "🤖"`, `color = #6B7280` (neutral gray),
   `tags = []`, `persona = <existing charter>`,
   `escalate_threshold = <existing global>`,
   `model = <existing global>`,
   `hard_constraints = ""`, `is_default = 1`.
3. Backfill `operator_decisions.operator_id` and
   `cost_ledger.operator_id` with the new row's id (single UPDATE).
4. Leave `tab_manifest.operator_id` NULL on existing rows; runtime
   resolution falls back to default.
5. Remove the singular "Operator" pane from Settings; replace with
   "Operators".

The migration is idempotent: skip if an `operators` row already
exists.

## Decomposition into actionable specs

This design is too large for one AOM session. `writing-plans` should
decompose it into:

1. **Backend + storage**: `operators` table, CRUD Tauri commands,
   migration, decisions/ledger column additions, runtime
   `effective_operator(tab)` resolution, AOM dispatch using per-tab
   operator. ~medium.
2. **Settings → Operators UI**: replaces singular pane. CRUD surface
   only. ~small.
3. **Tab strip + statusbar + picker (`⌘⇧O`)**: chips, picker modal,
   ESCALATE copy update, AFK header chip strip,
   operator-decisions chip + filter. ~medium.

Sub-specs land under `docs/specs/3.2.*-...md` (or whatever numbering
`writing-plans` chooses) and individually become AOM-actionable.

## Future / WIP (v2+, explicitly out of v1)

- **Inter-operator awareness**: include "other active operators" in
  prompts so a Sec-Op can know a Dev-Default is editing tab 2.
- **Handoff protocol**: an operator can request another operator take
  over its tab, with the user confirming.
- **Auto-routing**: tags drive automatic assignment to new tabs based
  on cwd, mission content, or detected language.
- **Per-operator quota**: daily token budget per operator on top of
  the global cap; priority bands.
- **Conflict resolution**: relevant only if a tab can have multiple
  operators (not v1).

## Open questions

None remaining for v1. (All resolved in brainstorm 2026-05-03.)
