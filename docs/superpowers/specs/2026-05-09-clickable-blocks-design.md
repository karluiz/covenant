# Clickable Blocks — Design

**Date:** 2026-05-09
**Status:** Draft
**Scope:** Make the right-side Blocks panel actionable so users can re-execute prior commands. Currently blocks are display-only.

## Problem

The Blocks tab on the right panel lists historical commands (cmd, exit code, ULID, duration) from current and previous sessions in the cwd. They are not interactive — clicking does nothing — so they read as a passive log. The user's mental model for this panel is **passive recall** (complementary to ⌘P, which is active search), but recall is only useful if reaching back into history takes one gesture.

## Goal

Single gesture from a block in the panel to that command running (or being edited) in the active terminal, with a guardrail when the block's cwd differs from the active session's cwd.

## Non-goals

- Viewing full output for a block
- Copy / pin / favorite / send-to-operator
- Scroll-to-block in terminal buffer
- Right-click / context menu
- Keyboard navigation across the block list
- Persisting "don't ask again" preferences for the cwd guard

These are valid follow-ups, intentionally deferred.

## Behavior

### Click semantics

- **Single click** on a block row → insert the block's command into the active tab's prompt as editable text. No Enter. Focus moves to the terminal.
- **Double click** → same insert, followed by Enter (executes).
- **Hover** → row gets a subtle highlight and `cursor: pointer` to advertise interactivity.

Both current-session and previous-session blocks behave identically. Exit code does not affect behavior — failed commands are re-runnable too.

### CWD guard

Before inserting, compare `block.cwd` to the active session's current `cwd`.

- **Match:** insert immediately, no friction.
- **Mismatch:** show a confirm UI (small modal or inline toast — implementer's choice, whichever fits existing patterns) with the block's cwd shown and three options:
  1. **Insert** — insert the command as-is.
  2. **Insert with `cd`** — prepend `cd <block.cwd> && ` to the command, then insert.
  3. **Cancel** — abort.

The same dialog is used for both single-click (insert) and double-click (insert + run). The chosen action respects the original click intent: if the user double-clicked, "Insert" and "Insert with cd" both end with Enter; if single-clicked, neither auto-Enters.

### Insertion mechanics

Insertion writes the command bytes to the active session's PTY stdin without a trailing newline (single click) or with one (double click). If the prompt already has typed content, the implementation should clear it first via the same mechanism the recall palette uses — reuse, do not reinvent.

## Components touched

- `ui/src/blocks/manager.ts` — attach click + dblclick handlers to block rows; wire to active session.
- `ui/src/styles.css` — hover state + pointer cursor on block rows.
- `ui/src/tabs/manager.ts` (or wherever the active session + cwd is exposed) — read active `cwd`, expose insert helper if not already present.
- New small confirm UI — prefer extending an existing modal/toast component over adding a new one.

## Risks

- Double-click on a destructive command (e.g. an old `rm -rf`) re-runs it. Accepted: two deliberate clicks is sufficient intent. The operator blocklist does not apply here because this is direct user input, not agent action.
- Insertion racing with user typing in the terminal. Mitigation: clear current prompt before insert, same as recall.

## Testing

- Unit: cwd comparison helper (match / mismatch / mismatch-with-trailing-slash).
- Integration: click a previous-session block in the same cwd → command appears in prompt, no Enter. Double-click → command executes. Click block from different cwd → guard appears; each option produces the right PTY bytes.

## Open questions

None blocking. Confirm UI pattern (modal vs toast) is left to the implementer based on existing UI conventions.
