# Capabilities panel — Covenant-first reframe

**Date:** 2026-07-01
**Status:** Approved design, pending implementation plan
**Scope:** `ui/src/capabilities/panel.ts` (the full-page `CapabilitiesPanel`), `crates/cdlc`, `crates/app`. Does NOT touch the group-scoped `ui/src/cdlc/panel.ts` (`CdlcPanel`).

## Problem

The Capabilities panel treats **Covenant as one tool among 7 peers** in the `TOOL` sidebar (listed last), while the banner claims "CDLC is the source of truth." The UI contradicts its own message. The intended mental model is **author in Covenant first, then project to executors** — Covenant is the origin; Claude / Codex / Pi / Copilot / opencode are projection targets, not independently-authored peers.

The user confirmed: executors stay **editable as today** (no capability removed), but Covenant is elevated to the default home, and each executor shows a **synced / stale / not-projected** badge so the source-of-truth relationship is legible.

## Design

### 1. Sidebar: SOURCE vs PROJECTIONS

The single `TOOL` nav group splits into two labeled groups:

```
SOURCE
▸ Covenant            edited 2m ago     ← default on open, elevated style
PROJECTIONS
  Claude    ✓ synced
  Codex     ⚠ stale
  Pi        ✓ synced
  Copilot   — not projected
  opencode  ✓ synced
  Shared    (not installed)
```

- `CapabilitiesPanel.activeTool` default changes from `"claude"` to `"covenant"`; default section from `"skills"` to `"config"` (Manifest).
- Covenant renders alone under **SOURCE**, elevated, with an `edited Xm ago` timestamp = mtime of the newest file under `.covenant/cdlc/` plus the manifest.
- Executors render under **PROJECTIONS** with a status badge. `Shared` stays as-is (`not installed`) — it is not a projection target.
- Pure `renderNav` reorder + CSS. Per-executor editing logic is untouched.

### 2. Projection status (backend)

Refactor `crates/cdlc/src/project.rs` to separate generation from writing, so status and projection share one generator (no duplicated "what should be written" logic):

```
plan(repo) -> Vec<PlannedWrite { executor, path, content }>   // generates, does not write
project(repo) = plan(repo).for_each(write)                    // reuses plan
```

New command `cdlc_projection_status(repo) -> Vec<{ executor, state }>`:
- For each executor, take its `PlannedWrite`s and compare against disk:
  - none of its target files exist → `not_projected`
  - all exist and match byte-for-byte → `synced`
  - exist but differ (source changed, or the projected file was hand-edited) → `stale`

**Shared-block caveat:** the concatenated managed block lives in `AGENTS.md` (read by codex + opencode) and `.github/copilot-instructions.md` (copilot). Status maps by destination file, so `codex` and `opencode` share `AGENTS.md`'s state — they cannot get independent badges without splitting that file, which is out of scope. File-per-item executors (Claude, Pi, opencode-agents) get independent states.

Panel calls `cdlc_projection_status` in `refresh()` and paints badges in three states reusing the rail-homologation status palette.

### 3. Projection action + header

The "CDLC is the source of truth… [Project to executors →]" banner becomes a persistent status header above the list (Covenant tab only, as today):

```
CDLC is the source of truth.   4 synced · 1 stale · 1 never          [ Project → ]
```

- Summary (`4 synced · 1 stale · 1 never`) derives from `cdlc_projection_status`.
- `[ Project → ]` keeps calling `cdlcExport` (all-at-once; the write backend is unchanged). After projecting → `refresh()` → badges flip to synced.
- Button is accented when ≥1 stale/never; calm (ghost) when all synced — a visual "nothing to project" signal.

**Out of scope (add if requested):**
- Per-executor individual re-projection — flow is Covenant→all; a stale executor is fixed by the global button.
- Visual diff of what is stale — the badge suffices; the central list already shows content.

### 4. Files touched

| File | Change |
|---|---|
| `crates/cdlc/src/project.rs` | extract `plan()`; `project()` reuses it; add `projection_status()` |
| `crates/app/src/lib.rs` (or `capabilities_commands.rs`) | command `cdlc_projection_status` + handler registration |
| `ui/src/api.ts` | wrapper `cdlcProjectionStatus`; fix `CapabilityListItem.tool` union that omits `"covenant"` |
| `ui/src/capabilities/panel.ts` | default `covenant`; `renderNav` two groups SOURCE/PROJECTIONS + badges + timestamp; header summary |
| `ui/src/styles.css` | nav groups, 3-state badges, header summary |

### Tests

- Rust: `plan()` output equals what `project()` writes (dry-run == real, on a temp repo); `projection_status()` returns synced / stale / not_projected correctly on a temp repo.
- TS: add a nav-grouping assertion (SOURCE = covenant, PROJECTIONS = rest) if render is testable without heavy DOM; otherwise rely on the Rust tests.

### Non-goals

- The group-scoped `CdlcPanel` (`ui/src/cdlc/panel.ts`) is not touched.
- No new dependencies.
- No change to the projection *write* semantics — only a read-only status view plus the existing all-at-once export.
