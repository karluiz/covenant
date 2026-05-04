---
spec: ../specs/2026-05-04-operator-no-mission-enhancements-design.md
---

# Operator no-mission enhancements: /color + /effort — Plan (revised C)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Scope:** Ship `/color` and `/effort` as tab-level controls (slash + dropdowns + persistence). Always-rename is dropped from this plan — it requires `tab_rename` IPC + Claude detection that don't exist yet; tracked separately.

**No Claude-only gate**: dropdowns are always visible. `/effort` for non-Claude tabs is best-effort (writes the slash to PTY; if the shell doesn't understand it the user sees the literal — acceptable, matches what the user would have typed).

**Tech Stack:** Rust (one new Tauri command), TypeScript (schema, slash parser, dropdowns).

**Spec:** `docs/superpowers/specs/2026-05-04-operator-no-mission-enhancements-design.md`

---

## Reality check (verified against worktree)

- Operator state struct is `Attached` (private to `operator.rs`), not `AttachmentState`. No `agent_kind` field.
- `crates/app/src/tab_manifest.rs` is a dumb JSON blob store; schema lives in `ui/src/tabs/manager.ts` (`SerializedTab` / `TabManifestV1`).
- `inject_to_session` at `operator.rs:~2166` is `async fn` private. We expose a thin Tauri command around it (or a sibling helper) for `/effort`.
- `tabSetColor` already has a backend path: tabs have a `color` field on the manifest. We add a Tauri command + TS wrapper for runtime updates.

---

## File Structure

- `crates/app/src/operator.rs` — **MODIFY**: add `pub fn write_to_session(&self, id, bytes)` thin wrapper around the existing PTY writer. Keep `inject_to_session` private.
- `crates/app/src/lib.rs` — **MODIFY**: register `tab_set_color` and `tab_set_effort` Tauri commands.
- `ui/src/tabs/manager.ts` — **MODIFY**: extend `SerializedTab` with optional `color_source?: "user" | "agent" | "default"` and `effort_level?: string`. On restore, replay `/effort` after `prompt_start`.
- `ui/src/api.ts` — **MODIFY**: typed wrappers `tabSetColor`, `tabSetEffort`.
- `ui/src/operator/panel.ts` — **MODIFY**: add Color + Effort dropdowns; parse `/color` and `/effort` in input handler.
- Tests: vitest for slash parser; Rust unit test for the new command's input validation.

---

## Task 1: `tab_set_color` Tauri command

**Files:** `crates/app/src/lib.rs`, `ui/src/api.ts`

- [ ] **Step 1 — failing test**: Rust unit test asserts the validator accepts `red|blue|green|yellow|purple|orange|pink|cyan|default` and rejects `"#ff0000"` and `"hotpink"`.
- [ ] **Step 2 — implement** `#[tauri::command] async fn tab_set_color(session_id: String, color: String) -> Result<(), String>`. Validates and emits a Tauri event `tab://color-changed` with `{ session_id, color }`. (Persistence is frontend-driven — TS will catch the event and update its in-memory tab + persist via existing manifest save.)
- [ ] **Step 3 — TS wrapper** `tabSetColor(sessionId, color)` in `api.ts`.
- [ ] **Step 4 — green**.

---

## Task 2: `tab_set_effort` Tauri command (PTY write)

**Files:** `crates/app/src/operator.rs`, `crates/app/src/lib.rs`, `ui/src/api.ts`

- [ ] **Step 1 — failing test**: assert the validator accepts `low|medium|high|xhigh|max|auto` only.
- [ ] **Step 2 — implement**: `tab_set_effort(session_id, level)` calls a new public helper `operator::write_text_to_session(&handle, id, "/effort {level}\n")`. The helper reuses the existing PTY writer used by `inject_to_session`.
- [ ] **Step 3 — TS wrapper** `tabSetEffort(sessionId, level)`.
- [ ] **Step 4 — green**.

---

## Task 3: Manifest schema (TS-only)

**Files:** `ui/src/tabs/manager.ts`

- [ ] **Step 1**: extend `SerializedTab` with `color_source?: "user" | "agent" | "default"` and `effort_level?: string` (both optional → backward compat).
- [ ] **Step 2**: when applying color from manifest, treat `color_source: "user"` as sticky (overrides any default theme color).
- [ ] **Step 3 — manual smoke**: load an old manifest, confirm no errors.

---

## Task 4: Slash parser

**Files:** `ui/src/operator/panel.ts` + new `panel.test.ts` (or co-located).

- [ ] **Step 1 — failing test**: `parseSlashCommand("/color red")` → `{ kind: "color", value: "red" }`; `/effort xhigh` → effort variant; unknown values → `null`; non-slash → `null`.
- [ ] **Step 2 — implement** as pure function.
- [ ] **Step 3 — wire** into the panel input submit handler. On match: call `tabSetColor` / `tabSetEffort`, mark `color_source = "user"` for color, persist manifest, short-circuit (do NOT forward to PTY).
- [ ] **Step 4 — green**.

---

## Task 5: Color + Effort dropdowns

**Files:** `ui/src/operator/panel.ts`, `ui/src/styles.css`

- [ ] **Step 1**: add two compact `<select>` elements in the panel header (always visible; no Claude gate).
- [ ] **Step 2**: change handlers call the wrappers; color sets `color_source = "user"`.
- [ ] **Step 3**: minimal CSS — single line, aligned with existing header chips. Manual smoke only.

---

## Task 6: Restore `/effort` on tab reload

**Files:** `ui/src/tabs/manager.ts`

- [ ] **Step 1**: in the `prompt_start` (OSC 133 A) handler that already fires `initialCommand`, also fire `tabSetEffort(sessionId, effort_level)` if the manifest has one.
- [ ] **Step 2 — manual smoke**: set effort=high, restart app, confirm Claude reports high effort.

---

## Task 7: Docs

- [ ] Update `docs/next-features.md`: mark `/color` and `/effort` shipped; note always-rename deferred.
- [ ] Bump version + one-line CHANGELOG entry.

---

## Validation checklist

- [ ] `/color red` typed in operator panel turns the chip red; persists across restart.
- [ ] Color dropdown writes the same as `/color`.
- [ ] `/effort xhigh` writes literal `/effort xhigh\n` to the session PTY (visible in Claude UI).
- [ ] Effort persists across restart (replayed on `prompt_start`).
- [ ] Effort dropdown matches `/effort`.
- [ ] Old manifests (no new fields) load fine.
- [ ] All existing tests still pass.

---

## Out of scope (deferred)

- Always-rename even without mission → needs `tab_rename` IPC + `agent_kind` detection. Separate spec.
- `ColorSource` "Agent vs User" rule → no agent-side IPC in this plan; revisit when an agent tool exists.
- Per-mission default color/effort.
