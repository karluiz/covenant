# Rename Tip — Design

**Date:** 2026-05-13
**Status:** Approved, ready for implementation plan

## Problem

When the user is working in a tab with an executor agent (e.g. Claude Code) but has not renamed the tab, work risks being lost in the shuffle: the default tab name (`zsh`, `Tab 3`, cwd-derived) carries no signal about *what* is being worked on. In AOM mode the operator auto-renames the tab, so the problem only exists when working manually without AOM and without an assigned operator.

We already surface contextual tips (e.g. spec-detection). This adds a complementary tip suggesting `/rename` once the executor has produced real work.

## Goals

- Suggest `/rename` exactly once per session, only when there is actual work worth preserving.
- Silent when AOM or an operator is handling the tab.
- One-click rename from the tip; one-click dismiss with no nagging.
- Unify the "did the user (or AOM on their behalf) intentionally name this tab?" signal via a single flag.

## Non-goals (YAGNI)

- Re-prompting after dismissal within the same session.
- Suggesting concrete names (operator/AOM territory).
- Persisting `rename_tip_dismissed` across sessions.

## Trigger conditions

All must hold to emit the tip:

- Tab has an active executor agent (reuse existing PTY fg-proc / idle heuristics).
- Tab is **not** in AOM mode.
- Tab has **no** operator assigned.
- `tab.renamed_by_user == false`.
- A `BlockFinished` event just fired for this tab from the executor (first one counts; we don't gate on exit code or duration in v1 — simplest signal first).
- `tab.rename_tip_dismissed == false`.
- `tab.rename_tip_already_emitted_this_session == false` (one-shot per session).

## Data model

Add to the `Tab` model (in `crates/session/`):

- `renamed_by_user: bool` — **persisted** in SQLite. Defaults to `false` on tab creation. Set to `true` by:
  - User invoking `/rename` (or ⌘R inline rename).
  - AOM auto-renaming the tab.
- `rename_tip_dismissed: bool` — **in-memory only**. Resets on app restart.
- `rename_tip_already_emitted_this_session: bool` — **in-memory only**.

SQLite migration: add `renamed_by_user INTEGER NOT NULL DEFAULT 0` to the tabs table.

## Tauri commands

- `mark_tab_renamed(tab_id)` — called by `/rename`, ⌘R inline rename, and AOM auto-rename. Sets `renamed_by_user = true` and persists.
- `dismiss_rename_tip(tab_id)` — sets `rename_tip_dismissed = true` in memory.

## Detector

Lives in `crates/agent/src/tips/rename_tip.rs` alongside other tip detectors (mirror the spec-detection tip module).

Pseudocode:

```rust
on SessionEvent::BlockFinished { session, .. } => {
    let tab = tabs.get_mut(session);
    if tab.has_executor_active()
        && !tab.aom_mode
        && tab.operator.is_none()
        && !tab.renamed_by_user
        && !tab.rename_tip_dismissed
        && !tab.rename_tip_already_emitted_this_session
    {
        emit_tip(Tip::RenameSuggested { tab_id: tab.id });
        tab.rename_tip_already_emitted_this_session = true;
    }
}
```

## UI

Reuse the existing tip toast component (the one used by spec-detection):

- **Text:** *"Working on something? Rename this tab so you don't lose track."*
- **Primary button:** "Rename" → opens inline rename (same flow as ⌘R / `/rename`).
- **Secondary button:** "Dismiss" → calls `dismiss_rename_tip`.

If the user renames the tab through *any* path while the tip is visible, the tip auto-dismisses (reactive on `renamed_by_user → true`).

Frontend listener: Tauri event `tip://rename-suggested/{tab_id}`.

## Tests

1. New tab + executor active + first `BlockFinished` → tip emitted.
2. Tab already renamed manually → no tip.
3. Tab in AOM mode → no tip.
4. Tab with operator assigned → no tip.
5. Tip dismissed → not re-emitted in the same session.
6. Second `BlockFinished` after a tip was emitted → no re-emit (one-shot).
7. AOM auto-rename sets `renamed_by_user = true` (unified signal).
8. `/rename` via command palette sets `renamed_by_user = true`.
9. SQLite migration: existing tabs get `renamed_by_user = false` on upgrade.

## Out of scope

- Persistent dismissal across restarts.
- Time- or block-count-based re-prompting.
- Suggested names (operator/AOM owns naming intelligence).
