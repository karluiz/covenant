# AOM per-tab exclusion: visibility & persistence

> Date: 2026-05-04
> Status: design approved, ready for plan
> Related: M-OP5 (per-tab AOM exclusion, already shipped backend + minimal UI)

## Problem

Global AOM mode is annoying because the user can't keep one tab manual
while another tab runs autonomously. The capability already exists
(`aom_excluded` per AttachmentState, M-OP5) but is invisible:

- No keyboard shortcut.
- No visual indicator on the tab itself — the only feedback is a
  context-menu label that flips on right-click.
- Discoverable only via right-click → "Exclude from AOM".
- Reset to `false` on every `aom_start`, so the user must re-mark
  exclusions after every restart of AOM.

The user did not know the feature existed. The fix is to surface it,
not to refactor AOM into a per-tab primitive.

## Why not a per-tab refactor

A full refactor (per-tab AOM state, per-tab budget, separate dispatch
loops) was considered and rejected. The pain ("AOM hijacks tabs I'm
working in") is fully solved by exclusion + visibility. The refactor
would touch ~150 lines across `aom.rs`, `operator.rs`, `convergence.rs`,
`notify.rs`, plus the entire UI layer — for no incremental user value
once exclusion is properly surfaced.

The single chokepoint at `operator.rs:1261` already gates AOM
participation per tab:

```rust
let effective_aom = aom_active && !aom_excluded;
let live = per_tab_live || effective_aom;
```

That logic is correct. We just need it to be reachable and persistent.

## Design summary

Five surgical changes:

1. **Backend**: stop resetting exclusions on `aom_start`; have
   `enable_all_for_aom` skip excluded tabs.
2. **Visual**: each Operator-enabled tab shows a `bot` icon; when AOM
   is running and the tab is excluded, icon swaps to `bot-off`.
3. **Activation**: click the icon (during AOM) toggles exclusion;
   `⌘⇧E` does the same on the active tab; right-click menu unchanged.
4. **Persistence**: add `aom_excluded` to `TabManifestV1`; restore it
   after `createTab` via `setAomExcluded`.
5. **Banner**: when ≥1 tab is excluded, banner appends `· N excluded`
   with a popover listing those tabs and an "Include all" action.

## § 1 — Backend (Rust)

| Change | File | Detail |
|---|---|---|
| Drop reset from `aom_start` | `crates/app/src/lib.rs:845` | Remove the `clear_all_aom_excluded()` call. The function stays alive — § 3.3 reuses it as an explicit user action. |
| `enable_all_for_aom` skips excluded | `crates/app/src/operator.rs:910-921` | Add `if att.aom_excluded { continue; }` so AOM does not auto-enable Operator on tabs the user marked manual. |
| (No new commands needed) | — | `set_aom_excluded` / `is_aom_excluded` already exist (`lib.rs:748-764`). |

## § 2 — Visual indicator (UI)

- Tab with `operatorEnabled=true`: render Lucide `bot` icon (~12px) at
  the leading edge of the tab label, color `accent` (mission blue).
- Tab with `operatorEnabled=true && aomEnabled && aomExcluded`: swap
  to `bot-off` (slashed bot), color `fg-muted`. Tooltip: `"Excluded
  from AOM (manual)"`.
- AOM off: `aomExcluded` has no visible effect; the bot icon stays in
  its normal variant. Reinforces that exclusion only matters during
  AOM.
- Click on the icon is interactive **only while AOM is on**. Calls
  `toggleAomExcluded(tab.id)`. Cursor pointer + hover state when
  interactive; otherwise decorative.
- Re-render trigger: `aomBanner.onChange()` already fires on
  start/stop. Add a tabbar re-render call there so the icon variant
  flips immediately.

## § 3 — Activation

- **`⌘⇧E`** in `ui/src/shortcuts/registry.ts`: toggles exclusion on
  the active tab. No-op (silent) if AOM is off or the active tab is
  not Operator-enabled.
- **Click on tab icon**: see § 2.
- **Right-click menu**: unchanged (`tabs/manager.ts:2531-2547`).
- **"Include all in AOM"** action in the AOM banner popover: appears
  only when ≥1 tab is excluded. Calls the existing
  `clear_all_aom_excluded()` backend command. This is the one place
  the user can wipe exclusions in bulk.
- Toggling exclusion does NOT trigger entry/exit splash. Splash is
  reserved for global AOM start/stop.

## § 4 — Persistence

- `TabManifestV1` (`tabs/manager.ts:1696-1720`) gains
  `aom_excluded: boolean` per tab. Manifest version stays `1` —
  additive, default `false` for old manifests.
- `serializeManifest()`: include `aom_excluded: t.aomExcluded`.
- `restoreFromManifest()`: after `createTab` and after restoring
  `mission_path` / `operator_id`, always call
  `setAomExcluded(created.sessionId, persisted ?? false)`. Calling
  unconditionally (instead of only when `true`) costs one extra IPC
  per tab and stays correct if the backend default ever changes —
  e.g., if AOM state becomes persistent across app restarts.
- New tab during AOM active: existing default at `lib.rs:354`
  (`aom_excluded = aom_active_now`) is correct — new tabs born during
  AOM start excluded. No change.

## § 5 — Banner / status bar

- `ui/src/aom/banner.ts`: when `excludedCount > 0`, render
  `· N excluded` after the existing `decisions` field.
  `excludedCount = tabs.filter(t => t.operatorEnabled && t.aomExcluded).length`.
  No backend call — frontend knows the state.
- The `· N excluded` segment is clickable and opens a popover listing
  the excluded tabs (name + short path) with an "Include" button per
  tab plus the "Include all" action from § 3.
- Status bar chip (`ui/src/status/bar.ts`): inline `(N excluded)` if
  there's room; otherwise the popover carries the detail.
- Recompute `excludedCount` on `aomBanner.onUpdate()` (existing 5s
  poll) and on every local `toggleAomExcluded()` for instant feedback.

## § 6 — Testing

**Backend testing strategy**:

The async `OperatorWatcher` methods (`enable_all_for_aom`,
`set_aom_excluded`, `clear_all_aom_excluded`) require a Tauri
`AppHandle` + `Storage` + `Notifier` to construct, and the codebase
does not yet have an async test fixture for them — existing
`operator.rs` tests are sync tests of pure parsing functions. Building
that fixture is out of scope for this small change.

Backend changes are verified by:
- `cargo check -p covenant` after each commit (signature + type
  enforcement).
- The existing decision-time gate (`effective_aom = aom_active &&
  !aom_excluded` at `operator.rs:1272`) is unchanged, so the
  behavior contract remains intact.
- Manual UI verification (below) covers the end-to-end paths.

If the codebase later adds an async test fixture for
`OperatorWatcher`, the obvious unit tests to add are:
- `enable_all_for_aom` skips tabs with `aom_excluded=true`.
- `aom_start` does not mutate `aom_excluded` on any session.
- `set_aom_excluded(true)` clears `enabled_by_aom` so AOM stop does
  not revert a tab the user claimed mid-AOM.

**UI (manual — no UI test framework in repo per CLAUDE.md)**:
1. Start AOM → every Operator-enabled tab shows `bot` icon.
2. `⌘⇧E` on active tab → icon flips to `bot-off`; banner gains
   `· 1 excluded`.
3. Click the slashed icon → flips back to `bot`; suffix disappears.
4. Quit and relaunch the app → restored tabs preserve their
   `aom_excluded` state across the manifest.
5. Right-click on excluded tab → "Include in AOM"; on included tab →
   "Exclude from AOM (keep this tab manual)".
6. With ≥2 excluded tabs, "Include all" in the banner popover clears
   all exclusions; banner suffix disappears.

**Convergence regression**: excluded tabs do not appear in the ⌘⇧O
overlay (existing filter at `convergence.rs:207`). Confirm visually.

**Cost accounting**: excluded tabs do not increment
`accumulated_cost_usd` (existing guard at `operator.rs:1516-1517`).
Confirm via the budget readout after a mixed run.

## Files affected

| File | Lines (est.) |
|---|---|
| `crates/app/src/lib.rs` | -1 (drop reset call) |
| `crates/app/src/operator.rs` | +2 in `enable_all_for_aom`; +1 unit test for skip; +1 unit test for no-reset |
| `ui/src/tabs/manager.ts` | +5 manifest field; +5 restore branch; +30 tabbar render of bot icon; +5 click handler |
| `ui/src/aom/banner.ts` | +20 (excluded suffix + popover) |
| `ui/src/status/bar.ts` | +5 (inline excluded count) |
| `ui/src/shortcuts/registry.ts` | +5 (`⌘⇧E` binding) |
| `ui/src/icons/index.ts` | +3 (export `botOff` icon) |
| `ui/src/styles.css` | +10 (icon hover/disabled states) |

Total: ~90 lines added, ~1 line removed. No new files. No schema bump.

## Acceptance criteria

- [ ] During AOM, every Operator-enabled tab shows a `bot` icon; an
      excluded tab shows `bot-off`. The variant updates within 1s of
      a toggle.
- [ ] `⌘⇧E` on the active tab toggles exclusion when AOM is on; is a
      silent no-op otherwise.
- [ ] Clicking the icon on a tab while AOM is on toggles its
      exclusion. The cursor / hover state make it discoverable.
- [ ] Stopping AOM and restarting it does NOT wipe per-tab exclusion
      state.
- [ ] Quitting and relaunching the app preserves per-tab exclusion
      state via the tab manifest.
- [ ] When ≥1 tab is excluded, the AOM banner shows `· N excluded`
      and exposes a popover with per-tab "Include" + global "Include
      all".
- [ ] AOM auto-enable does not touch a tab marked `aom_excluded`.
- [ ] Excluded tabs do not appear in the convergence overlay; do not
      contribute to `accumulated_cost_usd`.

## Out of scope

- Per-tab AOM budget. Cost cap stays global.
- Per-tab AOM start/stop (the global toggle remains the only AOM
  start/stop entry point).
- Renaming or restructuring `aom.rs` state.
- Reworking the entry/exit splash.
- Multi-window AOM coordination.
- Notification throttling per tab.

## Open questions

None. All decisions closed in brainstorming.

## Complexity

`small` — single AOM session is sufficient. Linear sequence: backend
two-line change → UI icon + handler → manifest field + restore →
banner suffix → tests.
