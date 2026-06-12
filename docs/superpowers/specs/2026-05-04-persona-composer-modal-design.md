# Persona Composer Modal — Design

**Date:** 2026-05-04
**Status:** Approved (design); pending implementation plan
**Phase:** 1 of 2 (Phase 2 = AI compose/refine, deferred to a separate spec)

## Problem

The operator's "Persona / authorization charter" field in `Settings → Operators` is the most semantically important text in the operator definition — it dictates how the operator escalates and what it answers autonomously. The current edit surface is a 14-row inline `<textarea>` packed alongside other fields. For a charter that often runs 40+ lines, the writing surface is cramped and there is no way to start from a known-good baseline.

## Goals

1. Give the user a generous writing surface for the persona text.
2. Offer a small set of curated templates so users don't start from a blank textarea.
3. Match the visual language of the existing Convergence overlay (modal chrome, `Esc` kbd hint), so a user who has used Convergence understands this modal at a glance.

Non-goals (Phase 2): AI compose/refine, user-saveable templates, import/export.

## UX

### Trigger

Add an "expand" icon button (`Icons.maximize` or similar Lucide glyph) inside the persona field's label row in `ui/src/settings/operators.ts:184`. Click opens the modal pre-loaded with whatever text is currently in the textarea.

### Modal layout

- **Size:** 85vw × 85vh, centered with `position: fixed`. Backdrop `rgba(0, 0, 0, 0.6)`.
- **Backdrop click:** does nothing (prevents accidental data loss). Closing requires Esc, the Cancel button, or Save.
- **Header row:** title `PERSONA / AUTHORIZATION CHARTER` (uppercase, wide-tracking, muted — matches `.convergence-overlay__title`). Right side: `[Save]` primary button + `[Cancel ⎋]` button (same chrome as Convergence Exit).
- **Templates row:** horizontal scrollable strip of pills, one per template. Pills show only the template name (e.g., `Cautious senior`). Click loads the template into the textarea.
- **Editor:** monospace textarea filling all remaining height. No max-width — uses full modal width minus padding.
- **Footer hint:** small muted text `⌘S save · ⎋ cancel`.

### Keyboard

- **Esc:** close modal, discarding any edits made since open. No confirm prompt (matches Convergence — fast exit is the priority).
- **⌘S / Cmd+S:** save (write current modal text back to the underlying textarea, fire the same `input` event the textarea would fire on user typing so the existing dirty-tracking and mtime-conflict detection in `OperatorsPane` activate unchanged) and close.
- **Enter inside textarea:** inserts newline (default textarea behavior).

### Save semantics

The modal does NOT call any backend save endpoint directly. It writes its text back to the original textarea and dispatches an `input` event. The existing save pipeline in `OperatorsPane` (which runs on field-change with debouncing and conflict detection per project memory) handles persistence. This isolates the modal from the operator persistence layer entirely.

### Cancel semantics

Cancel discards in-modal edits. The original textarea is untouched. No confirm dialog — same low-friction exit as Convergence.

### Loading a template

- If the textarea is empty (or contains only whitespace) when a template pill is clicked, replace immediately.
- If the textarea has non-whitespace content, show a native `confirm("Overwrite current persona?")`. On OK, replace; on Cancel, do nothing. No custom modal-on-modal — keep it boring.

## Templates (shipped, hardcoded)

Six templates in `ui/src/operator/persona-templates.ts`. Each is a `{ name: string; persona: string }` entry. Concrete content is finalized in the implementation plan; here are the intents:

1. **Cautious senior** — Current default (Mibli-like). ALWAYS-YES on routine, escalate on destruction or ambiguity.
2. **YOLO autopilot** — Answer yes on everything except hard-blocked destructive actions. Aggressive throughput, minimal escalation.
3. **Spec-driven** — Escalate when no documented plan covers the next step. Answer based on what the spec/plan says, not what the agent guesses.
4. **Read-only auditor** — Never inject keystrokes (always escalate), but produce written analysis on every block. Pure observer mode.
5. **Junior pair** — Conservative, asks more, explains decisions. Slower throughput, friendlier escalation messages.
6. **Debugger** — Test-failure focus, fail-fast, verbose escalation about which assertion failed and why.

Templates are read-only at the source level. Loading them only copies into the editor; users still save as their own operator.

## Architecture

### Files

- **New:** `ui/src/operator/persona-composer.ts`
  - Class `PersonaComposerModal` with `open(initial: string, onSave: (text: string) => void)`.
  - Owns its DOM (created on first `open`, destroyed on close, OR re-used as a hidden element).
  - Listens for window-level keydown while open (Esc, ⌘S). Cleans up on close.
- **New:** `ui/src/operator/persona-templates.ts`
  - Exports `export const OPERATOR_PERSONA_TEMPLATES: readonly { name: string; persona: string }[] = [...]`.
- **Modify:** `ui/src/settings/operators.ts`
  - Add the expand-icon button into the persona field block.
  - On click, instantiate / reuse a single `PersonaComposerModal`, call `open(textarea.value, (newText) => { textarea.value = newText; textarea.dispatchEvent(new Event("input", { bubbles: true })); })`.
- **Modify:** `ui/src/styles.css`
  - New `.persona-composer-*` rules (modal, backdrop, header, templates row, textarea, footer).
  - Refactor existing `.convergence-overlay__exit` + `.convergence-overlay__exit-kbd` into a shared base (`.modal-cancel-btn` + `.modal-kbd`) so the new modal and Convergence share styling automatically. Keep the `.convergence-overlay__exit*` selectors as aliases to avoid touching `convergence/overlay.ts`.

### Why a separate file rather than expanding `operators.ts`

`operators.ts` is the operator settings pane and already owns conflict detection, mtime locking, and field bindings. Adding a fullscreen modal class inline would conflate two responsibilities. The modal is a self-contained widget — input is `(initial, onSave)`, output is the saved text. It can be unit-tested in isolation.

### Testing

- `ui/src/operator/persona-composer.test.ts` — vitest jsdom tests:
  - Opening with initial text populates the textarea.
  - Clicking a template pill replaces text when initial is empty.
  - Clicking a template pill with non-empty text triggers confirm (mock `window.confirm`).
  - Save fires `onSave` with current text and removes modal from DOM.
  - Esc fires the cancel path (does NOT call `onSave`) and removes modal from DOM.
  - ⌘S triggers save.

## Out of Scope (deferred)

- **AI compose/refine** — Phase 2. Will get its own spec covering: which prompt strategy (one-shot generate / refine selection / chat), cost metering, prompt-injection guardrails, reuse vs. fork of the super-agent's Anthropic client.
- **User-saveable templates** — Not in v1. If demand emerges, add a "Save as template" action that persists to disk in a follow-up spec.
- **Markdown rendering / preview** — The persona is plain text consumed by an LLM; no rendering needed.
- **Diff against original** — Cancel discards everything; if users start losing work we add an undo-on-reopen, not a diff view.

## Acceptance

- Clicking the expand button next to the persona textarea opens a modal at 85% × 85% with the current text pre-loaded.
- The modal header reads `PERSONA / AUTHORIZATION CHARTER` in the same uppercase / wide-tracking style as the Convergence overlay's header. The Cancel button shows an `⎋` kbd styled identically to Convergence's Exit kbd.
- All 6 templates are loadable. Loading into a non-empty editor prompts a confirm.
- Esc and ⌘S work as documented. Backdrop click does nothing. Save dispatches an `input` event on the underlying textarea so existing dirty-tracking activates.
- The Convergence Exit button still looks and behaves identically (no visual regression from the kbd refactor).
