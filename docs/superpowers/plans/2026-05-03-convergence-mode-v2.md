# Convergence Mode (3.8) v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/specs/3.8-convergence-mode.md` (binding).
**Branch:** `feature/3.8-convergence-mode-v2` (fresh worktree).
**Strategy:** v1 scaffold is already merged on `main` (status classifier, aggregator, overlay, tile, styles, `⌘⌥O` shortcut). This plan **extends** that — every spec acceptance criterion that already passes is unchanged; new criteria (avatar, vendor badge, reply box, AOM cost wiring, ⌘⇧M, 5th status) drive the tasks.

---

## Investigation summary (key findings)

1. **v1 code is on `main`**: `crates/app/src/convergence.rs` (~265 lines, 7 unit tests, cost stubbed `Some(0.0)`), `ui/src/convergence/{overlay,tile,tabs-bridge}.ts`, `ui/src/styles.css:5672+`, `ui/src/main.ts:548–552` (current shortcut `⌘⌥O`). Everything from spec acceptance items (1)–(5) and the toggle/Esc/empty-state/click-to-focus is shipped.
2. **No `resolution` event exists in code.** Specs 3.8 + 3.13 reference it; nothing implements it. Only path today is private `inject_operator_reply()` in `crates/app/src/operator.rs:1853`.
3. **Operator avatar/name per tab** is already exposed: Tauri command `session_get_operator` (`crates/app/src/operator_registry.rs:465`), wrapped in `ui/src/api.ts:668`. Frontend can read per-tile without backend changes.
4. **Per-tab AOM cost** is summable from `OperatorDecisionRow.cost_usd` (`crates/app/src/storage.rs:199`) filtered by `session_id_short` and `timestamp_unix_ms >= aom.started_at`. Current aggregator returns `0.0` placeholder.
5. **Vendor input** = `OperatorDecisionRow.in_flight_command` (already pulled in aggregator at line 138). Live `OperatorWatcher.in_flight.command` (`operator.rs:1106`) may not have a public reader — task-time check.
6. **TabManager** exposes `activateBySessionId` (`ui/src/tabs/manager.ts:856`); already used by `tabs-bridge`.
7. **`⌘⇧M` is unused** today; `⌘⇧O` is operator picker; `⌘⌥O` is the current convergence shortcut to be replaced.

---

## ESCALATE-0 (BEFORE any code) — Reply pipe ownership

Spec 3.8 says replies go through a "structured `resolution` event — same path 3.13 will use." Neither exists. Three options:

1. **Tauri command `submit_convergence_reply` + small new `pub` helper in `operator.rs`** (e.g., `pub async fn submit_resolution(...)`). Smallest code path. **Widens `operator.rs`'s public surface — spec forbids without explicit user sign-off.**
2. **Promote `inject_to_session` (operator.rs:1823) to `pub`** and call from `lib.rs`. Also widens.
3. **Internal channel `convergence://resolution` the operator decision loop subscribes to.** Net-new infra inside `operator.rs`, but does not extend the public *type* surface — only an internal subscriber added. Closest to what 3.13 implies.

**Recommendation: option 3** (or option 1 with explicit permission). Block all reply-touching tasks (7, 8) until user picks.

---

## Task 1 — Switch shortcut to `⌘⇧M`

**Files:** `ui/src/main.ts` (≤10 lines net).

- [ ] Step 1: Replace the `⌘⌥O` branch (`main.ts:548–552`) with `⌘⇧M` (`e.metaKey && e.shiftKey && (e.key === "M" || e.key === "m")`).
- [ ] Step 2: Update inline comment.
- [ ] Step 3: Smoke: `npm run dev`, press `⌘⇧M` — overlay opens. `⌘⇧O` still opens operator picker.
- **Commit:** `feat(convergence): rebind overlay to ⌘⇧M per spec 3.8`
- **Verify:** `npx tsc --noEmit` clean.

---

## Task 2 — Vendor detector (TDD, pure function)

**Files:** `crates/app/src/convergence.rs` (≤280 incl. tests).

- [ ] Step 1: Add `pub enum Vendor { Claude, Copilot, Opencode, Aider, Codex, Unknown }` with `#[serde(rename_all = "kebab-case")]`.
- [ ] Step 2: Failing tests first:
  - `claude` → Claude
  - `claude --dangerously-skip-permissions` → Claude
  - `claude-code` → Claude
  - `copilot --yolo` → Copilot
  - `opencode` → Opencode
  - `aider --model gpt-4` → Aider
  - `codex` → Codex
  - `npx aider` → Aider (npx unwrap)
  - `npx @anthropic-ai/claude-code` → Claude
  - `vim foo.rs` → Unknown
  - `None` → Unknown
- [ ] Step 3: Implement `pub fn detect_vendor(cmd: Option<&str>) -> Vendor`: trim, split first whitespace, if leading token == `npx`, recurse on remainder; match prefix against vendor table.
- [ ] Step 4: Add `pub vendor: Vendor` and `pub raw_command_label: Option<String>` to `ConvergenceTileState`.
- **Commit:** `feat(convergence): vendor detector with npx unwrap`
- **Verify:** `cargo test -p covenant convergence::tests`

---

## Task 3 — Wire vendor + last-command into aggregator

**Files:** `crates/app/src/convergence.rs` (≤280).

- [ ] Step 1: Source the vendor input in priority:
  - (a) `OperatorDecisionRow.in_flight_command` already pulled at line 138 — use when present.
  - (b) Fallback: live `OperatorWatcher.in_flight.command`. **Check** at task start whether `OperatorWatcher` exposes a public reader. If not → **ESCALATE** (no silent widening).
- [ ] Step 2: Pass to `detect_vendor()`; assign `vendor` and `raw_command_label = (vendor == Unknown).then(|| truncated)`.
- [ ] Step 3: Add integration-style test: snapshot for a decision-bearing session reports the right vendor.
- **Commit:** `feat(convergence): populate vendor + raw command on tiles`
- **Verify:** `cargo test -p covenant`

---

## Task 4 — Per-tab AOM cost (real values)

**Files:** `crates/app/src/convergence.rs` (≤280).

- [ ] Step 1: When `enrolled` is true, sum `cost_usd` across `OperatorDecisionRow` rows whose `session_id_short` matches AND whose `timestamp_unix_ms >= aom.started_at_unix_ms`. **ESCALATE** if `AomStatus` lacks `started_at_unix_ms` — do not widen `aom.rs`.
- [ ] Step 2: Replace `cost_usd: Some(0.0)` placeholder with real sum.
- [ ] Step 3: Unit test with synthetic rows asserting per-session sum and time-window filter.
- **Commit:** `feat(convergence): real per-tab AOM cost from decision rows`
- **Verify:** `cargo test -p covenant convergence`

---

## Task 5 — Tile header: operator avatar

**Files:** `ui/src/convergence/tile.ts` (≤240), `ui/src/convergence/overlay.ts` (≤240), `ui/src/convergence/tabs-bridge.ts`.

- [ ] Step 1: Extend `TabMeta` with `operatorAvatar: string | null` and `operatorName: string | null`. `tabs-bridge` fetches via cached `sessionGetOperator(sessionId)` per tab; cache by sessionId, refresh on snapshot tick (1 s).
- [ ] Step 2: In `renderTile`, prepend an avatar `<span>` to the head row (before stripe/title). Tooltip carries the operator name.
- [ ] Step 3: Reuse `--muted` for tooltip text. No new tokens.
- **Commit:** `feat(convergence): tile header shows per-tab operator avatar`
- **Verify:** `npx tsc --noEmit`; manual: open overlay, confirm avatar present per tab.

---

## Task 6 — Vendor badge

**Files:** `ui/src/convergence/tile.ts` (≤240), `ui/src/styles.css` (append, total spec budget ≤260 added).

- [ ] Step 1: Add `Vendor` type to `ui/src/api.ts` and extend `ConvergenceTileState` typing.
- [ ] Step 2: In `renderTile`, render `<span class="convergence-tile__vendor" data-vendor="claude|copilot|opencode|aider|codex|unknown">` between header and pill. For `unknown`, show truncated `raw_command_label`.
- [ ] Step 3: CSS: vendor badge uses `--muted` background + `--accent` border for known vendors; plain `--muted` border for unknown. No new tokens.
- **Commit:** `feat(convergence): vendor badge per tile`
- **Verify:** `npx tsc --noEmit`; visual smoke for each vendor.

---

## Task 7 — Reply box rendering on `blocked` tiles

**Files:** `ui/src/convergence/tile.ts` (≤240), `ui/src/convergence/overlay.ts` (≤240), `ui/src/styles.css` (append).

- [ ] Step 1: When `state.status === "blocked"`, append a `.convergence-tile__reply` form below cost footer: `<input type="text">` + `<select>` (`one-shot`|`mission`|`global`, default `one-shot`) + `<button>Send</button>`. Stop click bubbling so the form doesn't focus the tab.
- [ ] Step 2: In overlay grid click handler (`overlay.ts:72`), ignore clicks whose target is inside `.convergence-tile__reply`.
- [ ] Step 3: On Enter inside input or Send click → call `overlay.submitReply(sessionId, text, scope)`. Implementation in Task 8.
- **Commit:** `feat(convergence): reply box UI on blocked tiles`
- **Verify:** `npx tsc --noEmit`; manual: form interaction does not exit overlay.

---

## Task 8 — Reply pipe wiring (depends on ESCALATE-0)

**Files:** `crates/app/src/lib.rs` (≤40 added), `ui/src/api.ts` (≤50), `ui/src/convergence/overlay.ts`.

- [ ] Step 1: Per ESCALATE-0 resolution, register Tauri command `submit_convergence_reply(session_id, text, scope) -> Result<(), String>`.
- [ ] Step 2: After successful submit, emit Tauri event `convergence_reply_submitted` carrying `{session_id, scope, text_hash}` (NOT raw text — 3.13 will subscribe and persist). Hash via `std::collections::hash_map::DefaultHasher`; no new crates.
- [ ] Step 3: `ui/src/api.ts`: typed `submitConvergenceReply(...)` wrapper.
- [ ] Step 4: `overlay.ts.submitReply` calls wrapper, on success clears + hides form locally; next snapshot tick will confirm via `status` flipping out of `blocked`.
- **Commit:** `feat(convergence): submit_convergence_reply Tauri command + event emit`
- **Verify:** `cargo check -p covenant`; `npx tsc --noEmit`; manual: cause an escalation, type a reply, confirm executor session resumes.

---

## Task 9 — Polish: layering, vibrancy, two-step Esc

**Files:** `ui/src/styles.css` (append), `ui/src/convergence/overlay.ts`.

- [ ] Step 1: Verify CSS uses `--bg-overlay` (not hardcoded). Switch if drifted.
- [ ] Step 2: Confirm grid is `repeat(auto-fit, minmax(280px, 1fr))`, gap 16, padding 24. Adjust if drifted.
- [ ] Step 3: Confirm z-index above tab strip and sidebar — match AFK overlay's z-index variable.
- [ ] Step 4: With reply box focused, first Esc blurs (active element → blur); second Esc closes overlay. Add `keydown` listener inside form that blurs on Esc and stops propagation.
- **Commit:** `chore(convergence): polish layering, vibrancy, two-step Esc`
- **Verify:** `npx tsc --noEmit`; manual checks.

---

## Task 10 — Spec self-review + verification

- [ ] Step 1: Walk every spec "Acceptance criteria" checkbox against code.
- [ ] Step 2: Run `cargo check -p covenant`, `cargo test -p covenant`, `npx tsc --noEmit`.
- [ ] Step 3: Verify line caps:
  - `crates/app/src/convergence.rs` ≤ 280 incl. tests
  - `ui/src/convergence/overlay.ts` ≤ 240
  - `ui/src/convergence/tile.ts` ≤ 240
  - `ui/src/styles.css` ≤ 260 lines added relative to merge-base
  - `ui/src/main.ts` ≤ 30 lines added
  - `crates/app/src/lib.rs` ≤ 40 lines added
  - `ui/src/api.ts` ≤ 50 lines added
- [ ] Step 4: If any cap exceeded, refactor in place — do NOT split modules (spec forbids new files beyond the three creates).
- [ ] **ESCALATE-1**: spec mandates 5th status `operator-thinking` (currently deferred in v1 code). Either (a) ship without with user sign-off, or (b) add a follow-up task surfacing "operator decision in flight" from `OperatorWatcher` (likely needs new public reader → escalate first).
- **Commit:** `chore(3.8): final spec audit + line-cap cleanup`
- **Verify:** All gates green.

---

## Self-review checklist (acceptance → task mapping)

| Spec acceptance | Task |
|---|---|
| `⌘⇧M` toggle | 1 |
| `⌘⇧O` unchanged | 1 (no-touch verified) |
| Grid auto-fit/16/24 | 9 |
| 1.5 s update via 1 s poll | already on `main` |
| Click tile → focus + exit | already on `main` (overlay.ts:72) |
| Esc / Exit close; reply-aware Esc | 9 |
| Empty state | 9 (audit; mostly on `main`) |
| Vibrancy `--bg-overlay` | 9 |
| (1) Header + tab title + color stripe | already on `main` |
| (1) Operator avatar | 5 |
| (2) Vendor badge incl. unknown | 2, 6 |
| (3) Status pill (5 states) | already on `main` (4 states); 5th → ESCALATE-1 in 10 |
| (4) Last decision | already on `main` |
| (5) Last cmd + last output line | already on `main` |
| (6) Reply box on blocked, scope selector, send | 7, 8 |
| (6a) Reply unblocks session | 8 |
| (6b) Form closes | 7 + 8 |
| (6c) Emits `convergence_reply_submitted` | 8 |
| (7) Cost footer iff AOM enrolled | 4 (real values) + already on `main` (gating) |
| `cargo check` clean | 10 |
| `tsc --noEmit` clean | 10 |
| Status + vendor unit tests | 2 (vendor); already on `main` (status) |
| No new color tokens | 6, 9 |

---

## Embedded ESCALATE checkpoints

1. **ESCALATE-0** (pre-task, blocking): reply-submit path. 3 options enumerated. Recommend option 3.
2. **ESCALATE in Task 3**: live `in_flight.command` reader on `OperatorWatcher` may need new public surface.
3. **ESCALATE in Task 4**: `aom.started_at_unix_ms` may need to be exposed on `AomStatus`.
4. **ESCALATE-1 in Task 10**: 5th status `operator-thinking` is deferred in code; spec requires it.
