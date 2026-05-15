# Familiar Panel Redesign

**Date:** 2026-05-15
**Status:** Approved — ready for implementation plan

## Problem

The current Familiar UI (`Roster`, `ui/src/familiars/roster.ts`) is a full-screen fixed overlay (`position: fixed; inset: 0`) with a near-opaque background (`rgba(20,20,24,0.97)`). Symptoms:

- The 3% transparency causes the underlying tab sidebar and Settings panel to ghost through, creating visual noise (see user report 2026-05-15).
- The overlay covers the entire app, so the user cannot see the operator session while chatting with its Familiar — which contradicts the product model (Familiar observes what the operator is doing).
- The 3-column grid (220 / 1fr / 320) floats with no chrome anchoring it to the rest of the terminal.

## Goal

Replace the overlay with a persistent right-side panel that lives alongside the workspace, scoped to the active tab's Familiar.

## Design

### Layout

The main layout changes from `[sidebar | workspace]` to `[sidebar | workspace | familiar-panel]` (horizontal flex/grid). The panel is fixed width 380px (minimum 320px, not user-resizable in V1). When closed, `display: none` — the workspace reclaims all remaining width with no residual strip.

### Panel structure (open, 380px wide)

```
┌─ Familiar 01KRMM ────────────── ✕ ┐  header: familiar name + close
├─ Chat │ Status │ Audit ───────────┤  tab strip (one active)
├──────────────────────────────────┤
│                                  │
│  (active tab content)            │  Chat: log + input
│                                  │  Status: rolling summary, cost, missions
│                                  │  Audit: directives log
├──────────────────────────────────┤
│ Talk to your Familiar… (⌘↵)      │  input (only on Chat tab)
└──────────────────────────────────┘
```

Background `var(--bg-elevated)` (fully opaque), left border `1px solid var(--border)`. No transparency.

### Per-workspace binding

The panel follows the active tab. On tab activation:

1. Resolve `familiar = familiars.find(f => f.session_id === activeTab.sessionId)`.
2. If found: update header label, call `chat.setFamiliar(id)`, `snapshot.setFamiliar(id)`, `audit.setFamiliar(id)`.
3. If not found: show empty state ("No Familiar for this tab — open Settings → Familiars to create one"), hide tab strip.

No roster, no multi-familiar selector. To talk to a different Familiar, switch tabs.

### Toggle

- `⌘⇧L` toggles open/closed (reuses existing shortcut from `shortcuts/registry.ts:51`).
- Status bar Familiar indicator (`status_indicator.ts`) currently dispatches `familiars:open`; the handler in `main.ts:1169` becomes a toggle instead of a one-way show.
- State persisted in localStorage as `familiar-panel-open: boolean`. Default closed.
- Active sub-tab persisted as `familiar-panel-tab: "chat" | "status" | "audit"`. Default `chat`.

### Resize behavior

Opening/closing the panel changes the workspace width. Dispatch `window.dispatchEvent(new Event('resize'))` after toggle so existing xterm fit path re-fits visible terminals.

## Components

### New: `ui/src/familiars/panel.ts` — `FamiliarPanel`

Replaces `Roster`. Responsibilities:

- Mount into right-side container (`<aside id="familiar-panel">` in `index.html`).
- Render header (familiar name + close button) and tab strip.
- Show one sub-view at a time using existing components.
- `bindToSession(sessionId: string | null)`: re-binds sub-views to the Familiar for that session, or shows empty state.
- `toggle()`, `show()`, `hide()` with localStorage persistence.
- Wire `ChatPanel.onApprovedDirective` to deliver directives via `onDeliverDirective` host hook (same contract as today's `Roster`, `roster.ts:44-49`).

### Reused unchanged

`chat.ts`, `snapshot.ts`, `audit_log.ts`, `api.ts`, `directive_card.ts`.

### Deleted

- `ui/src/familiars/roster.ts` — replaced.
- `ui/src/familiars/list.ts` — no roster, no list.
- CSS: `#familiars-roster.roster`, `.roster-left/.roster-center/.roster-right/.roster-close`, `.familiar-row*`, `.familiar-list-empty`, `.familiar-name`, `.familiar-session`, `.familiar-dot` (review usage before removing `.familiar-dot` — status indicator may share it).

### Modified

- `ui/src/main.ts` — instantiate `FamiliarPanel` instead of `Roster`; subscribe to active-tab change event; convert `familiars:open` handler (line 1169) to `panel.toggle()`.
- `index.html` — add `<aside id="familiar-panel" class="familiar-panel hidden"></aside>` as a sibling of the workspace container. Make the root layout horizontal flex/grid.
- `ui/src/styles.css` — new rules: `.familiar-panel`, `.familiar-panel__header`, `.familiar-panel__tabs`, `.familiar-panel__tab`, `.familiar-panel__tab--active`, `.familiar-panel__body`, `.familiar-panel__empty`. Remove old roster rules.
- `ui/src/tabs/manager.ts` — confirm or add an event for active-tab change that the panel can subscribe to.
- `ui/src/familiars/status_indicator.ts` — no code change; `familiars:open` is now toggle-semantic via the updated handler.

## Edge cases

- **Draft in chat input on tab switch:** input clears. The draft belonged to the previous Familiar; preserving it would risk sending to the wrong session. The chat log itself is server-side and re-hydrates on return. V2 may add per-familiar drafts in localStorage.
- **Panel open with no active tab** (all tabs closed): `bindToSession(null)` → empty state "Open a tab to see its Familiar." Panel stays open.
- **Tab has no Familiar enabled:** empty state with CTA linking to Settings → Familiars. Creating a Familiar from the panel is out of scope for V1.
- **Multiple xterms re-fit:** dispatch synthetic resize event after toggle.

## Testing

- Unit (`panel.test.ts`): DOM mock; `bindToSession` with existing familiar updates header and delegates to sub-views; `bindToSession(null)` shows empty state; `toggle()` flips `hidden` class and writes to localStorage; sub-tab switch persists.
- Integration: mock `Familiars.list()`, simulate active-tab change event, assert panel re-binds.
- Manual: visual check of layout, panel collapse, xterm re-fit on toggle, directive delivery path.

## Out of scope (V1)

- Multi-familiar simultaneous view / roster picker.
- Creating a Familiar from inside the panel.
- Drag-to-resize panel width.
- Persisted chat drafts per Familiar.
- Slide animation on toggle (instantaneous is fine).

## Migration notes

This removes the overlay-style Familiar UI entirely. Anyone relying on the `Roster` class or its DOM (`#familiars-roster`) needs to migrate to `FamiliarPanel`. The public host hook (`onDeliverDirective`) keeps the same signature, so call sites in `main.ts` change only the type name.
