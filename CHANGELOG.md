# Changelog

All notable changes to Covenant.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Each version section may include any of: **Added**, **Changed**, **Fixed**,
**Removed**.

## 0.2.4 — 2026-05-04

Per-tab AOM exclusion visibility. The existing `aom_excluded` per-tab
opt-out (M-OP5) was invisible — no shortcut, no badge on the tab, no
status-bar surface — and got reset on every `aom_start` so users had
to re-mark their manual tabs each time. This release surfaces the
feature with a discoverable badge, a keyboard shortcut, an aggregated
status-bar suffix with a popover, and persistent storage across both
AOM cycles and app restarts.

### Added

- **Per-tab `bot` / `bot-off` badge** on every Operator-enabled tab
  pill. Decorative when AOM is off; click during AOM toggles
  exclusion. Slashed (`bot-off`) variant signals "AOM is running on
  the rest, this tab is staying manual".
- **`⌘⇧E` shortcut** — toggle AOM exclusion for the active tab.
  Silent no-op when AOM is off, no active tab, or active tab has
  Operator disabled.
- **AOM status-bar suffix** — when ≥1 tab is excluded, the AOM chip
  reads `· N excluded`. Click opens a popover listing each excluded
  tab (name + short cwd) with a per-tab Include button, plus an
  "Include all in AOM" bulk action when ≥2 are excluded.
- **Manifest persistence** — `aom_excluded` survives app restarts via
  an additive `aom_excluded?: boolean` field on `TabManifestV1` (no
  schema bump). Restore always calls `setAomExcluded` with the
  persisted value.
- **`clear_all_aom_excluded` Tauri command** — backs the popover's
  "Include all" action.

### Changed

- **`aom_start` no longer resets `aom_excluded`** — exclusion is now
  a persistent property of the tab, surviving AOM stop/start cycles.
- **`enable_all_for_aom` skips excluded tabs** — AOM doesn't
  auto-claim Operator on a tab the user marked manual.
- **`set_aom_excluded(true)` clears `enabled_by_aom`** — claiming a
  tab mid-AOM survives `aom_stop`'s auto-revert (the tab keeps its
  Operator state per the user's explicit choice).

### Fixed

- Stale doc comments on `Attached.aom_excluded`, `set_aom_excluded`,
  `clear_all_aom_excluded`, `Tab.aomExcluded`, the `attach()` block,
  and `setAomExcluded` (api.ts) — all referenced the removed
  per-`aom_start` reset.
- Tab rename + Operator-toggle paths now refresh the AOM popover so
  excluded-list labels stay current without waiting for the next AOM
  transition.

### Internal

- Spec at `docs/superpowers/specs/2026-05-04-aom-exclusion-visibility-design.md`,
  plan at `docs/superpowers/plans/2026-05-04-aom-exclusion-visibility.md`.
- 21 commits on `feat/aom-exclusion-visibility`. Includes one revert
  + plan correction where Task 5 misidentified its target.

## 0.2.3 — 2026-05-04

Persona composer release. Editing an operator's authorization charter
now happens in a generous fullscreen-ish modal instead of a 14-row
textarea, with six shipped templates one click away.

### Added

- **Persona composer modal** — click the new expand icon in
  `Settings → Operators` next to the persona textarea to open an
  85vw × 85vh editor. Backdrop click is intentionally inert (prevents
  accidental data loss); Esc and the `Cancel ⎋` button discard, ⌘S
  saves and closes. Save writes back through the existing textarea
  via an `input` event so dirty-tracking activates unchanged.
- **Six operator persona templates** (Cautious senior, YOLO autopilot,
  Spec-driven, Read-only auditor, Junior pair, Debugger). Loading a
  template into a non-empty editor prompts a single `confirm()` —
  no second-modal-on-modal.
- **`Icons.maximize`** — Lucide `maximize-2` SVG, used as the
  composer trigger.

### Changed

- **Convergence overlay's Exit button** uses the new shared
  `.modal-cancel-btn` + `.modal-kbd` classes (extracted from the
  former `.convergence-overlay__exit*` rules). The Persona composer's
  Cancel button reuses the same styling so future modals land
  homogenized for free.

### Internal

- New tests: `persona-templates.test.ts` (4) and `persona-composer.test.ts`
  (10) covering DOM structure, template loading with/without confirm,
  Save/Esc/⌘S keyboard paths, backdrop inertness, and listener cleanup
  on close.
- Spec: `docs/superpowers/specs/2026-05-04-persona-composer-modal-design.md`
- Plan: `docs/superpowers/plans/2026-05-04-persona-composer-modal.md`
- Phase 2 (AI compose/refine) intentionally deferred to a separate spec.

## 0.2.2 — 2026-05-04

Polish + premium-feel release. Boot now runs through a branded splash
so the cold-start beat reads "ready" instead of "blank window," the
status bar surfaces the actual runtime version of the cwd, and the
operator context menu finally lets you remove a pinned operator.

### Added

- **Boot splash screen** — branded `COVENANT` overlay with a pulsing
  accent orb, expanding rings, and a `Booting…` ellipsis. Paints on
  the first frame (inlined in `index.html`) and fades out once tabs
  finish restoring. Honors `prefers-reduced-motion`. Reuses the
  AOM-splash animation framework but in the cool/accent palette so
  it never reads as the AOM danger splash.
- **Runtime version in status bar** — the runtime segment now shows
  a real version (`node 20.11.1`, `python 3.12.4`, …) even when the
  manifest doesn't declare one. Detection chain: manifest →
  version files (`.nvmrc`, `.node-version`, `.python-version`,
  `.ruby-version`, `rust-toolchain[.toml]`, `.tool-versions`) →
  binary lookup (`node -v`, `python3 --version`, `rustc --version`,
  `go version`, `ruby --version`). Cached per-cwd so the subprocess
  only runs once per directory per cache window.

### Changed

- **Tab context menu — operator entry**:
  - "Enable operator" renamed to **Set operator**, matching the
    status-bar chip and the `⌘⇧O` picker.
  - When an operator is pinned, the entry becomes **Remove operator**
    and unpins + disables the watcher in a single action (avatar
    chip disappears, watcher stops).
  - Picking an operator from the picker now also enables the watcher
    — pinning IS the user's intent to use it.
- **Disable operator render is now optimistic** — the agent icon
  disappears from the tab immediately, before the backend round-trip
  resolves.
- **Sidebar "Covenant" brand** restyled to match the CONVERGENCE
  header: uppercase, wide letter-spacing, muted color.
- **Convergence overlay's Exit button** now shows an `Esc` kbd hint.

### Fixed

- **Collapsed tab groups no longer add phantom space** per folded
  member. Replaced `.tab-group-body` `gap` with `margin-top` so the
  existing `.tab-pill-folded` zero-margin rule actually wins.

### Internal

- Persona composer modal — design spec + implementation plan landed;
  build pending.
- Per-tab AOM exclusion visibility — implementation plan landed
  (backend, icons, tab pill, `⌘⇧E`, manifest, status-bar popover);
  build pending.

## 0.2.1 — 2026-05-04

Sidebar polish release. Tab groups get a clearer visual identity, the
color palette doubles, and a dedicated "new group" button joins the
sidebar footer.

### Added

- **New-group button** in the sidebar footer alongside `+ ⌘T` —
  creates an empty tab group via `⌘⇧G` (no member tab needed).
- **6 new color swatches** for tabs and groups: lime, teal, cyan,
  indigo, magenta, slate (palette grew from 8 to 14). Picker row
  wraps to a second line when needed.

### Changed

- **Tab group visual identity** — replaced the per-tab left-edge color
  line and the chip top-stripe with a single 3px lateral stripe per
  group. The stripe stretches over header + members when expanded and
  shrinks to header height when collapsed. Each group is wrapped in a
  `.tab-group-shell` flex container (`createGroupShell` helper) so the
  rendering is testable in isolation.
- **New-tab button** uses the terminal icon instead of a `+`, paired
  with the `⌘T` kbd hint.

### Fixed

- `.new-tab-kbd` and `.new-tab-plus` styles were scoped to `#new-tab`
  only, so the new-group button rendered an unstyled `kbd`. Unscoped
  to apply to both buttons.

### Internal

- Added `vitest.config.ts` with jsdom environment + `jsdom` dev dep so
  DOM helpers can be unit-tested. New `ui/src/tabs/group-shell.test.ts`
  covers the shell helper. Test count: 86 passing (was 30).
- Removed dead CSS: `.group-chip::before`, `.tab-grouped::after`,
  `.tab-grouped-first`, and the matching `body.tabbar-left` overrides.
- `.superpowers/` brainstorm artifacts now ignored.

## 0.2.0 — 2026-05-03

Convergence-centric release. The overlay matures into the primary
multi-session command room and gains a memory loop: when you reply to
an escalated operator from convergence, the answer is captured as a
learned decision so the operator stops asking the same question twice.

### Added

- **Operator XP & level (spec 3.12)**: each completed decision awards
  XP, operators level up linearly, and a `Lv N` badge renders on the
  tab chip and operator panel. Persisted in SQLite; AFK-friendly
  visible progress across long autonomous runs.
- **Convergence Mode 2.0 (spec 3.8)**:
  - Rebound to **⌘⇧M** (`⌘⇧O` is now the operator picker).
  - **CONVERGENCE** header at the top of the overlay.
  - **Operator avatar** on every tile (per-tab assignment).
  - **Vendor badge** per tile — heuristic detection of the foreground
    AI CLI in each tab (`claude`, `copilot`, `opencode`, `aider`,
    `codex`, with `npx` unwrap; falls back to the truncated raw
    command when unknown).
  - **Mission line** on tiles (`📍 <mission-name>`) when a mission is
    attached; hidden otherwise.
  - **Reply box** on `blocked` tiles — single-line input + scope
    selector (`one-shot` / `mission` / `global`) + Send. Submitting
    unblocks the escalated session immediately and (for non-one-shot
    scopes) persists the answer as a memory.
  - **Real per-tab AOM cost** in the footer when the tab is enrolled
    (was a `$0.00` placeholder).
  - **`operator-thinking` 5th status** — tile flips to italic blue
    while an LLM call is in flight for that session.
  - **Two-step Esc** on the reply form: first Esc blurs the input,
    second Esc closes the overlay.
- **Operator Learning (spec 3.13)**: convergence replies become
  reusable memories.
  - Local SQLite store (`operator_memories` + `operator_memory_vec`)
    with the **`sqlite-vec`** extension.
  - Local **`fastembed-rs`** embedder (BGE-small, 384-dim) — no API
    keys, no network at inference time. Model auto-downloads on first
    use.
  - Hybrid retrieval: vector cosine + tag/keyword rescore on top-20
    candidates, then top-8 injected into the operator's system prompt
    under `## Learned decisions` (empty list is byte-identical to
    pre-3.13 prompt — prefix cache stays warm).
  - When an applied memory matches, the operator replies instead of
    escalating; the decision row records `applied_memory: <id>`
    (with `(shadowed: <ids>)` audit trail when ties exist).
  - Hand-edit acceptance: edit/delete rows directly in SQLite — the
    operator picks up changes on the next decision (no in-process
    cache, no restart).
- **Escalation visibility (spec 3.14)**:
  - Pulsing red dot on the tab chip whenever that session is in the
    `blocked` state — visible without opening convergence.
  - Backed by a lightweight `get_blocked_session_ids` Tauri command
    polled at 1 Hz, independent of overlay visibility.

### Changed

- Convergence tiles update **in place** on each 1 Hz poll instead of
  rebuilding the DOM — kills avatar flicker, preserves reply-box
  focus and typed text across ticks.
- AOM cost on tiles is now a real per-tab sum from
  `operator_decisions.cost_usd` (windowed to the current AOM run).

### Performance

- Convergence reply unblock no longer waits on the embedder cold
  start; persistence runs in a detached task while the resolution
  channel sends immediately.
- Operator decision tick short-circuits the retrieval embed + vector
  search when no memories match the active scope.

### Fixed

- Convergence empty state ("No sessions") was showing alongside tiles
  when present — `display: grid` was overriding the `[hidden]`
  attribute.

### Notes

- `fastembed-rs` pulls in `ort` (ONNX Runtime). The pyke prebuilt is
  **statically linked** in our build; no extra dylibs ship in the
  bundle and standard codesign suffices for notarization. See
  `docs/superpowers/notes/fastembed-notarization.md`.

## 0.1.0 — 2026-05-03

First captured release. Snapshot of where the app is today; future
versions will list deltas.

### Added

- AI-native terminal foundation: Tauri 2 + Rust + xterm.js.
- Multi-tab sessions with drag/fold groups, color, rename, manifest
  restore on relaunch.
- OSC 133 block parser; per-block exit code, duration, command, output.
- Operator (M-OP1..M-OP6): per-session enable/live, persona, dry-run
  pipeline, safety blocklist, mission spec attach.
- Autonomous Operator Mode (AOM) with budget cap, decisions counter,
  morning report, AFK overlay (⌘⇧A).
- Status bar with git, runtime, mission, AOM chip.
- Operator decisions panel (⌘O) with action filters, tab dropdown,
  executor and mission chips, grouping of consecutive identical
  decisions, snapshot of mission/executor at decision time.
- Recall command palette (⌘P) with zsh history import.
- Global content search (⌘⇧F).
- Convergence Mode overlay (⌘⇧O) — every open session as a live tile.
- Structure file tree + minimal editor with terminal split.
- Settings (⌘,), Docs hub (⌘/), Agent panel (⌘K).
- UI zoom (⌘= / ⌘− / ⌘0).

### Fixed

- New tab opening kept the previous tab's mission/agent chip visible
  until manual switch — `createTab` now routes through `activate`.
- Operator submit (Enter) sometimes failed against Claude Code's
  TUI — body and submit byte are now sent in two PTY writes ~60 ms
  apart so the trailing CR registers as a discrete keystroke.

### Changed

- AOM lives as a chip in the status bar; the floating banner is
  headless (state still polls).
- Operator persona gained an explicit *executor-recommended path*
  directive: when the executor presents its own recommendation
  before asking, default is REPLY confirming.
