# Superpowers-compatible Missions (design)

> Extends `docs/specs/3.1-master-operator-mission.md` to make the per-tab
> mission interoperable with the Superpowers spec/plan workflow that
> executor agents (Claude Code with the `superpowers:*` skills) already
> follow. Implementation will be decomposed by `writing-plans` into
> actionable sub-specs under `docs/specs/`.

## Goal

Let a tab's mission point to a **Superpowers spec+plan pair** (not just a
single Covenant markdown), so an executor agent attached to that tab
sees both the design contract and the live TDD task list, and can mark
progress + append notes on the plan as it works — without losing
compatibility with the existing Covenant `docs/specs/*.md` format.

## Non-goals (v1)

- **Bidirectional conversion** between Covenant and Superpowers spec
  formats. Both coexist; the picker shows them in separate sections.
- **Auto-running `writing-plans`** to generate a plan from a spec. The
  picker offers a button that spawns a Claude Code tab with the right
  prompt; the user drives the skill.
- **Multiple plans per spec.** A spec binds to at most one plan in v1.
- **Mission persistence across app restarts.** Inherited from 3.1's
  open question; still in-memory per session.
- **Bulk migration** of existing `docs/specs/*.md` to Superpowers
  format.
- **Cross-tab mission awareness.** Each tab's mission is independent
  (consistent with 3.2 multi-operator non-goals).

## Domain model

### `MissionRef`

Replaces the current single `PathBuf` mission attachment.

```rust
pub struct MissionRef {
    pub kind: MissionKind,           // Covenant | Superpowers
    pub spec_path: PathBuf,          // always present
    pub plan_path: Option<PathBuf>,  // None for Covenant; optional for Superpowers
}

pub enum MissionKind { Covenant, Superpowers }
```

### Plan resolution

Given a spec under `docs/superpowers/specs/`, the plan is resolved in
this order:

1. **Frontmatter lookup**: scan `docs/superpowers/plans/*.md` for any
   plan whose YAML frontmatter contains `spec: <relative-or-absolute
   path that resolves to spec_path>`.
2. **Filename convention fallback**: if no frontmatter match, look for
   `docs/superpowers/plans/<same-date-prefix>-<same-slug>.md` (the
   spec's filename without the trailing `-design`).
3. **None**: no plan attached. Mission is still valid; runtime emits a
   `plan ✗` hint.

Resolution runs at attach time AND on file-watcher events for the
`docs/superpowers/plans/` directory while a mission is active, so a
plan that appears later auto-binds.

### Plan state (read-write append, in-place)

The operator can mutate an attached plan only via two narrow
operations:

- `mark_plan_task(session_id, task_index, done: bool)` — flips
  `- [ ]` ↔ `- [x]` on the Nth top-level task line.
- `append_plan_note(session_id, task_index, note: String)` — inserts
  a `> note: <text>` line directly under the indicated task.

Both reuse the existing mtime conflict detection from mission editing
(if the file has been touched since the operator last read it, the op
fails with a conflict surfaced as a toast). **The operator may not**
insert new tasks, reorder, or delete content — those cases ESCALATE
through the 3.14 escalation visibility surface.

## Runtime / prompt injection

The operator's system prompt receives two structured blocks instead of
the current opaque concatenation:

```
<mission-spec kind="superpowers" path="docs/superpowers/specs/...-design.md">
  …raw spec.md contents, ANSI-free…
</mission-spec>

<mission-plan status="3/8" path="docs/superpowers/plans/...md">
  …raw plan.md contents, including current [x]/[ ] state and notes…
</mission-plan>
```

Cache placement (relevant to the prompt-caching strategy in `CLAUDE.md`):

- `<mission-spec>` is appended to the **stable cached segment** of the
  system prompt (alongside the persona). It changes rarely.
- `<mission-plan>` is placed in the **mutable segment** alongside the
  per-session rolling summary. Re-cached only when the operator (or
  the user) edits it.

If `plan_path` is `None`, only `<mission-spec>` is injected, with a
trailing comment:

```
<!-- no plan attached; ESCALATE before executing TDD steps -->
```

For `kind="covenant"` missions, only `<mission-spec>` is injected
(this preserves today's behavior bit-for-bit).

## Picker UX

Extends 3.11. The mission picker grows two sections under a single
modal:

**Section: Covenant specs**

- Source: `docs/specs/*.md` (excluding `_template.md`, `drafts/`).
- Each row: filename, goal line preview, `kind: Covenant` badge.
- Selecting a row attaches `MissionRef { Covenant, spec_path, None }`.

**Section: Superpowers**

- Source: `docs/superpowers/specs/*.md`, paired with plan via the
  resolution rules above.
- Each row represents the **pair**, not two separate entries:
  - Filename of the spec (date prefix + slug).
  - Two badges: `spec ✓` (always), and `plan ✓` or `plan ✗`.
  - `plan ✗` rows have a tooltip *"No plan yet — click to generate via
    writing-plans"* and clicking the badge spawns a Claude Code tab
    pre-populated with: `Use the writing-plans skill to create the
    plan for <spec_path>`. The picker stays open; file watcher will
    refresh when the plan lands.
- Selecting a row attaches `MissionRef { Superpowers, spec_path,
  plan_path }`.

**Picker header button: `+ New Superpowers mission`**

- Opens a small input modal asking for the topic ("what do you want to
  brainstorm?").
- Spawns a new Covenant tab whose initial prompt is:
  ```
  Use the brainstorming skill to design: <topic>
  ```
- File watcher on `docs/superpowers/specs/` automatically surfaces the
  resulting spec in the picker once committed.

## Mission chip

The tab-strip / statusbar chip (per 3.1 and 3.7) becomes
`kind`-aware:

- Background color tied to `kind` (Covenant uses today's accent;
  Superpowers uses a distinct color from the palette — TBD in
  implementation, defer to existing palette tokens).
- Label: `<slug>` truncated, prefixed by an icon (`📋` for Covenant,
  `🧭` for Superpowers — using existing emoji set, not new assets).
- Tooltip: full spec path + plan status (`3/8 done` or `no plan`).
- Click → opens the mission overlay (`⌘M`) which now shows both spec
  and plan paths side by side, plus a "View plan progress" link that
  expands an inline checklist (read-only in the overlay; mutations
  happen via the operator at runtime).

## File boundaries

- **Create**:
  - `crates/app/src/mission.rs` (~250 lines) — `MissionRef`,
    `MissionKind`, plan resolution (frontmatter + filename fallback),
    `mark_plan_task` / `append_plan_note` with mtime conflict
    detection, file-watcher integration for `docs/superpowers/plans/`.
  - `ui/src/operator/superpowers-picker.ts` (~180 lines) —
    Superpowers section of the picker, badge rendering, "+ New
    Superpowers mission" flow, file-watcher subscription.
- **Touch**:
  - `crates/app/src/operator.rs` (~60 lines) — extend `set_mission` /
    `get_mission` signatures to carry `MissionRef`; rewire prompt
    composition to emit the two structured blocks.
  - `ui/src/operator/picker.ts` (~80 lines) — host both sections,
    keyboard nav across them.
  - `ui/src/operator/panel.ts` (~30 lines) — kind-aware chip
    rendering and overlay's "view plan progress" panel.
  - `ui/src/api.ts` (~50 lines) — typed wrappers for the new mission
    commands (`set_mission(MissionRef)`, `mark_plan_task`,
    `append_plan_note`, `resolve_plan_for_spec`).
  - `crates/app/src/lib.rs` (~30 lines) — register the new Tauri
    commands.
- **DO NOT touch**:
  - `crates/app/src/safety.rs`, `aom.rs`, `settings.rs` — orthogonal.
  - `ui/src/aom/`, `ui/src/recall/`, `ui/src/blocks/`,
    `ui/src/settings/` — orthogonal surfaces.
  - The Covenant spec format / template (`docs/specs/_template.md`).

## Complexity

`medium` — 2–3 AOM sessions. Backend pairing logic + watcher + UI
section + prompt composition rewiring. Reuses 3.1 backend, mtime
conflict logic from mission editing, and the existing picker shell
from 3.11.

## Open questions

- **`plan ✗` attach behavior**: should attaching a spec without a
  plan be allowed (current design: yes, with hint), or blocked until
  a plan exists? ESCALATE for user decision before implementation.
- **Auto-commit on `mark_plan_task`**: when the operator flips a
  checkbox or appends a note, commit immediately to git, or leave the
  file dirty and surface "mission has uncommitted progress" in the
  statusbar? Recommended: dirty + statusbar hint, but ESCALATE if
  unclear at run time.
- **Spec rename/delete while attached**: if the spec file the plan
  points to is renamed or removed mid-mission, what happens?
  Recommended: detach the mission and surface a toast; ESCALATE if
  this conflicts with in-flight operator work.
- **Plan-only attach**: should the picker allow attaching a plan
  whose spec has been deleted/missing? Current design: no — pair
  resolution requires a valid spec. ESCALATE if a use case appears.

## AOM run notes

(empty — populated by user / agent during or after the run)
