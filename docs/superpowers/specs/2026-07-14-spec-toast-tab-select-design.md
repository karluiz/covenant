# Spec-prompt toast: tab selector

**Date:** 2026-07-14
**Status:** Approved

## Problem

The "New spec detected" toast picks its target tab with a heuristic (deepest
cwd → active tab → first eligible, `ui/src/aom/spec-prompt.ts`). In practice
the pick is frequently wrong and "Set as spec" lands the mission on the wrong
tab. The user has no way to redirect it.

## Design

Replace the static `→ <tab>` line in the toast with a `CustomSelect`
(`ui/src/ui/select.ts`, DESIGN.md rule 14) listing the eligible tabs
(same repo root, no mission — unchanged eligibility). The heuristic pick
stays as the pre-selected default.

Behavior:

1. `renderToast` computes `eligibleTabs(cand, host.listTabs())` at render
   time. With **more than one** eligible tab it renders the select; with one
   it keeps the plain text line.
2. Option labels come from `host.getTabLabel(id)`.
3. "Set as spec" reads the selected tab id → `acceptOnTab(selectedId)` +
   `setMissionForTab(selectedId)`. Tab closed in the meantime → existing
   `catch` logs it.
4. Dismiss and 📎-badge scoping (`recordCandidate`) are unchanged — they
   stay on the heuristic target.

No backend or `spec-prompt-state` changes. CSS: compact
`.spec-prompt-toast-target .ui-select__button` override (11px, tight
padding), same pattern as `.operator-session-select`.

## Testing

Vitest in `spec-prompt.test.ts`: with two eligible tabs, change the select
to the non-default tab, click "Set as spec", assert `setMissionForTab` was
called with the selected tab.
