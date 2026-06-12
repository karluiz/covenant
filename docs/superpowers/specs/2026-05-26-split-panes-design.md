# Split panes — design spec

> Status: draft · Author: karluiz + claude · Date: 2026-05-26

## Goal

Let one tab contain two PTY-bearing panes side-by-side or stacked, each with its own session, mission, operator, and (optionally) Pi chat view. Binary only — no recursive tiling. Layout persists across app restart.

## Why

A tab today owns exactly one session. Multi-tab workflows like "edit + watch tests" force the user to alt-tab between tabs or chord through `⌘⇧[`/`⌘⇧]`. The super-agent already correlates across sessions; making two related sessions co-visible in one tab matches that mental model and shortens the loop.

## Non-goals (v1)

- Recursive tiling (3+ panes per tab via a binary tree)
- Drag-merge between tabs
- Per-pane zoom toggle
- Pane "broadcast input" (type once, both panes receive)
- Save/restore named layout templates per project

These are deliberately deferred so the v1 lands as a clean refactor + visible feature, not a tmux clone.

---

## Experimental feature flag

Ships behind a settings toggle so the refactor lands safely without forcing a new mental model on every user.

- **Setting key:** `experimental.splitPanes` (boolean, default `false`)
- **Settings UI:** new checkbox in the existing **Terminal** section (`ui/src/settings/panel.ts` `sec-terminal`), under a subsection heading **"Experimental"**, mirroring the `mind_v2` pattern at `panel.ts:540`. Hint copy: *"Allow splitting a tab into two panes side-by-side or stacked. Each pane gets its own session, mission, and operator."*
- **Backend storage:** part of the existing `Settings` struct serialized to `config.json`. Reload semantics match other settings (read at session start, observable via the settings event for live updates).

### Gating rules

The data-model refactor (Phases A–C) is **always on** — it's a pure rename with no user-visible change and no risk. Only the create/modify operations gate on the flag.

| Flag off | Flag on |
|---|---|
| `splitPane()` returns error / no-op | `splitPane()` works |
| `⌘D` / `⌘\` / `⌘⇧]` / `⌘[` / `⌘]` not bound | Shortcuts live |
| Pane context menu omits "Split right / down / Swap / Convert to Pi" | Menu items shown |
| Tabbar chip never shows the split glyph | Glyph appears for split tabs |
| `⌘W` always closes the tab | `⌘W` closes pane in split tabs, tab in single tabs |

### Loading split tabs while the flag is off

If a user splits a tab with the flag on, persists, then disables the flag, the manifest still contains a split. Behavior:

- **The split renders normally** — both panes mount, splitter is visible. We don't drop existing user state when a flag flips.
- **The user cannot create new splits or modify existing ones** (drag the divider, swap, convert kind). Splitter drag becomes inert; context menu offers only "Close pane".
- **Closing a pane is always allowed.** A user can collapse splits back to single tabs even with the flag off — gives them an escape route without re-enabling.

This means the data shape (`panes[]` array, `layout` object) is the canonical shape from day one. The flag controls *new operations*, not *data presence*.

---

## Domain model

`Pane` becomes a first-class type owning everything per-PTY today. `Tab` shrinks to a container of 1 or 2 panes plus layout metadata.

```ts
type PaneId = string;                    // ulid
type PaneKind = "terminal" | "pi";
type SplitOrientation = "horizontal" | "vertical";  // h = side-by-side, v = stacked

interface Pane {
  id: PaneId;
  kind: PaneKind;
  sessionId: SessionId | null;            // null only mid-spawn
  cwd: string;
  mission: MissionRef | null;             // AOM
  operator: OperatorRef | null;           // claude / codex / copilot / pi / hermes
  blocks: Block[];
  xterm: Terminal | null;                 // terminal kind only
  piView: PiChatView | null;              // pi kind only
}

interface TabLayout {
  kind: "single" | "split";
  orientation?: SplitOrientation;         // only when kind === "split"
  activePaneIdx: 0 | 1;
  ratio?: number;                          // 0..1, divider position (default 0.5)
}

interface Tab {
  id: TabId;
  title: string | null;
  color: string | null;
  groupId: string | null;
  layout: TabLayout;
  panes: [Pane] | [Pane, Pane];            // 1 or 2, no recursion
  editorOpen: boolean;
  editor: StructureEditor | null;
  editorRatio: number | null;              // existing splitter pref
}
```

**Invariants** (asserted at every mutation):

- `panes.length === 1 ↔ layout.kind === "single"`
- `layout.kind === "split" → layout.orientation !== undefined`
- `layout.activePaneIdx < panes.length`

**Active pane helper:**

```ts
const activePane = (t: Tab): Pane => t.panes[t.layout.activePaneIdx];
```

Status bar, AOM, `⌘O`, `⌘M`, `⌘⇧J`, `⌘P`, `⌘⇧F`, recall, finder, global search — all key off `activePane(t)`.

---

## DOM and CSS architecture

The tab's existing `pane` element keeps its grid for editor + sidebar. A new wrapper holds the panes:

```
tab.pane (grid: terminal-block | editor-splitter | editor-host | sidebar)
└── .terminal-block          ← NEW wrapper, occupies the terminal column
    ├── .pane-host[0]        ← termHost or piHost for pane 0
    ├── .pane-splitter       ← only when layout.kind === "split"
    └── .pane-host[1]        ← only when layout.kind === "split"
```

```css
.terminal-block { display: grid; }
.terminal-block[data-layout="single"]      { /* one cell; pane-host[0] fills */ }
.terminal-block[data-split="horizontal"]   { grid-template-columns: var(--pane-ratio, 1fr) 4px 1fr; }
.terminal-block[data-split="vertical"]     { grid-template-rows:    var(--pane-ratio, 1fr) 4px 1fr; }
```

`--pane-ratio` is set inline as `<n>fr` from `layout.ratio` (default `1fr` = 50/50). Drag mechanics on `.pane-splitter` copy the existing editor splitter logic at `ui/src/tabs/manager.ts:2177` — pointer capture, RAF-batched, body cursor lock — but the persisted value lives in `tab.layout.ratio` (saved to the workspace manifest, **not** localStorage, since it's per-tab).

**Active pane indicator** (critical because status bar = active-only — see Behavior contract):

- Active pane: 1px solid accent border (theme variable)
- Inactive pane: 1px solid transparent (preserves layout — no jump on focus change)
- `term.onFocus` / `piView.onFocus` → `setActivePane(idx)` → CSS toggle + status bar refresh

**xterm refit:** `ResizeObserver` on each `.pane-host` calls `fit.fit()` on its xterm, debounced via RAF (same coalescing pattern already used for tab-level refits). Splitter drag triggers one refit per pane on `pointerup`.

**Pi panes:** `.pane-host` is the same slot for either kind. Pi swaps in a `PiChatView` instead of an `xterm` instance — the wrapper is kind-agnostic.

---

## Behavior contract

### Tauri commands

```rust
pub fn split_pane(tab_id, orientation, source_pane_idx) -> PaneId;
pub fn close_pane(tab_id, pane_idx);                 // collapses to single if 2→1
pub fn focus_pane(tab_id, pane_idx);
pub fn swap_panes(tab_id);                            // 0↔1
pub fn set_pane_orientation(tab_id, orientation);    // re-orient existing split
pub fn set_pane_ratio(tab_id, ratio);                 // persisted to manifest
```

Existing per-session commands (`pty_write`, `pty_resize`, `spawn_session`, etc.) are unchanged — they key off `SessionId` already.

### Keyboard shortcuts

| Combo | Action |
|---|---|
| `⌘D` | Split right (horizontal) |
| `⌘\` | Split down (vertical) — chose `\` over `⌘⇧D` because the latter is bound to "Drafts tab" today |
| `⌘]` / `⌘[` | Focus next / previous pane |
| `⌘⇧]` | Swap panes (left↔right or top↔bottom) |
| `⌘W` | Close active pane (collapses split if 2→1; closes tab only if it was the last pane) |
| `⌘⇧W` | Close tab unconditionally (escape hatch, preserves the old `⌘W` semantics) |

`⌘D` is not currently bound — verified against `ui/src/shortcuts/registry.ts`.

### Split behavior

- New pane inherits source pane's `cwd` (matches tmux default; carries you into the same repo)
- New pane defaults to `kind: "terminal"`, no mission, no operator (clean slate)
- New PTY spawned with the same shell as source pane
- Focus moves to the new pane

### Close behavior

- `closePane(tab, 1)`: drop pane 1, layout → single, surviving pane is at idx 0
- `closePane(tab, 0)`: drop pane 0, pane 1 slides to idx 0, layout → single
- Either way: kill the PTY, dispose xterm/piView, broadcast `SessionClosed`
- `⌘W` on a single-pane tab: closes the tab (current behavior preserved)

### Status bar

Reflects active pane only. Other pane's state is not surfaced in the bar; the active-pane border on the pane chrome is the disambiguator. Click into the other pane to swap which one the bar describes.

### Persistence (workspace manifest schema bump)

```jsonc
{
  "tab_id": "01H...",
  "layout": { "kind": "split", "orientation": "horizontal", "active": 1, "ratio": 0.6 },
  "panes": [
    { "id": "...", "kind": "terminal", "session_id": "...", "cwd": "...",
      "mission": "docs/specs/foo.md", "operator": "claude" },
    { "id": "...", "kind": "terminal", "session_id": "...", "cwd": "...",
      "mission": null, "operator": null }
  ]
}
```

Old single-pane manifests read as `{ kind: "single" }` with one pane wrapping today's tab-level fields. The deserializer detects an absent `panes` array and lifts existing `cwd` / `mission` / `operator` / `session_id` into a single-pane shape.

---

## Migration path (phased)

Wide refactor; order keeps the tree green at every step.

**Phase A — Data shape (no behavior change):**

1. Add `Pane` interface (TS) + `Pane` struct (Rust, in `crates/app` or `crates/session`).
2. Add `Tab.panes` and `Tab.layout` alongside existing per-tab fields. Don't remove anything yet.
3. Wrap each existing tab as `{ layout: { kind: "single" }, panes: [{...lifted from tab}] }` on load. Manifest deserializer handles both shapes.
4. Tests: load old manifest → tab has single pane with correct fields. Save → new schema written.

**Phase B — Read-side rename:**

5. Every read of `tab.sessionId` / `tab.cwd` / `tab.mission` / `tab.operator` / `tab.xterm` / `tab.blocks` becomes `activePane(tab).<field>`.
6. Tab-level fields stay populated as mirrors of `pane[0]` during this phase as a safety net.
7. Status bar, AOM, `⌘O`, `⌘M`, `⌘⇧J`, `⌘P`, `⌘⇧F` all retargeted in one sweep.
8. Tests still green; nothing should behave differently.

**Phase C — Write-side rename:**

9. Every write (`tab.cwd = ...`, `tab.mission = ...`) moves to `activePane(tab).<field> = ...`.
10. Delete the tab-level mirror fields. Compile errors are the checklist.
11. PTY/session creation pipeline takes a `paneId` argument so events route to the right pane.

**Phase D — Split UI (gated on `experimental.splitPanes`):**

12. Add `experimental.splitPanes` setting (default `false`) + checkbox in the Terminal/Experimental settings section.
13. Add `.terminal-block` wrapper around the existing termHost in `addTabInternal()` (wrapper exists regardless of flag; it's just a passthrough when single).
14. Implement `splitPane(tab, orientation)`: create new `Pane`, spawn PTY, mount termHost in second cell, install splitter, focus new pane. **Guarded by the flag at entry.**
15. Implement `closePane`, `focusPane`, `swapPanes`, `setPaneOrientation`, `setPaneRatio`. `closePane` is always available (escape hatch when flag flips off); the rest are gated.
16. Wire keyboard shortcuts (`⌘D`, `⌘\`, `⌘]`, `⌘[`, `⌘⇧]`) **only when flag is on**. Shortcut registration listens to the settings change event so toggling the flag re-binds without restart.
17. `⌘W` reroute: in split tabs, closes the active pane; in single-pane tabs, closes the tab. When the flag is off, `⌘W` always closes the tab (the close-pane path is still reachable via context menu, so manifest-loaded splits remain collapsible).
18. Active-pane indicator CSS + focus event wiring.

**Phase E — Persistence:**

19. Manifest writer emits new schema for split tabs; single-pane tabs emit new schema too (no special case). One-way migration — old binaries cannot read the new manifest, which matches Covenant's existing no-downgrade policy.
20. Restart restores both PTYs, mounts termHosts in correct cells, re-installs splitter at saved ratio, restores `activePaneIdx`.
21. Test: split tab → kill app → reopen → both shells back, same cwds, same block history (per-pane block log restores correctly).

**Phase F — Pi panes + polish (gated):**

22. Allow `kind: "pi"` in a pane; mount `PiChatView` in the slot instead of xterm.
23. Pane context menu: "Split right", "Split down", "Swap", "Convert to Pi", "Close pane". All except "Close pane" are gated on the flag.
24. Tabbar chip split glyph + tooltip listing both panes' cwds/operators (gated).

Estimated diff: ~800–1500 LOC, ~70% in `ui/src/tabs/manager.ts` and ~30% spread across `ui/src/status/bar.ts`, `ui/src/aom/*`, `ui/src/executors/*`, manifest serde, plus new pane types/files.

---

## Edge cases and gotchas

- **Editor splitter clamp.** With a horizontal pane-split, the terminal-block needs `2 * TERMINAL_MIN + PANE_SPLITTER_PX` minimum width. The editor's `applyTerminalWidth()` clamp at `ui/src/tabs/manager.ts:2158` becomes:

  ```ts
  const terminalBlockMin = layout.kind === "split" && layout.orientation === "horizontal"
    ? 2 * TERMINAL_MIN + PANE_SPLITTER_PX
    : TERMINAL_MIN;
  const clamped = Math.max(
    terminalBlockMin,
    Math.min(px, pane.offsetWidth - sidebar - EDITOR_MIN - SPLITTER_PX),
  );
  ```

  Vertical splits don't affect editor clamp.

- **xterm refit collision.** Three resize events can collide when a split is created with the editor open: pane-block grid change, editor splitter clamp re-apply, ResizeObserver firing on both panes. Same RAF debounce pattern used in editor splitter drag works here — coalesce `fit.fit()` into one `requestAnimationFrame` per pane.

- **AOM per pane.** AOM today binds an operator to a session and watches its block stream. Becomes per-pane automatically once the rename lands — each pane has its own operator + mission, so each pane runs its own AOM loop. The morning report aggregator iterates all panes across all tabs instead of all tabs.

- **Spec detector.** Watches cwds. Now each pane has its own cwd, so the watcher subscribes to *each pane's cwd*, not the tab's. Already keyed by session in `crates/app/src/spec_detector` — small rename to walk panes.

- **Operator/executor binding.** Operators bind to `SessionId` already, not `TabId`. Mostly cosmetic for the executor layer. The UI renders the operator chip on the active pane's chrome instead of the tab chip.

- **Tabbar chip.** Stays as one chip per tab. If the tab has a split, a small `▣` glyph on the chip signals "this tab is split". Tooltip lists both panes' operators/cwds. Drag-drop on the tab moves the whole tab; drag-merge between tabs is v2.

- **Pi pane in split.** PiChatView's textarea `onFocus` → `setActivePane`. Pi panes store their repo context as `cwd` for consistency with terminal panes; displayed in status bar the same way.

- **Block parsing per pane.** Already per-session. Blocks live on `pane.blocks` instead of `tab.blocks`. The right sidebar's blocks view targets active pane's blocks.

- **Finder (`⌘F`).** Per-pane. Each pane has its own search addon and floating finder instance. Don't reset on pane focus change — keep finder open per-pane.

- **Recall (`⌘P`) and global search (`⌘⇧F`).** Active pane's cwd.

- **Notifications.** Already per-session. Title becomes `tab title › pane label` when the tab is split (pane label = cwd basename or operator name).

- **Focus stealing.** When `splitPane()` mounts a new termHost, xterm `term.focus()` fires before layout settles. Wrap in `requestAnimationFrame` to avoid focusing a 0-width terminal that then immediately resizes.

- **Last pane in a split with editor open.** The editor is tab-scoped. Closing the pane that owns the active-pane state shouldn't close the editor; it shifts `⌘O`/`⌘S` targets to the surviving pane. The editor's own dirty-state machinery handles save prompts.

---

## Testing

**Unit (vitest):**

- `Pane` and `TabLayout` shape invariants
- `splitPane()`: new pane has correct cwd inheritance, focus moves, layout flips to split, ratio defaults to 0.5
- `closePane(0)` and `closePane(1)` both collapse to single with the surviving pane at idx 0
- `swapPanes()`: indices flip, active follows, ratio inverts
- `setPaneOrientation()`: re-orient without losing focus or panes
- Manifest deserializer: old single-pane shape lifts into new shape; new shape round-trips

**Integration (Rust + harness):**

- Spawn tab → split → assert two `SessionId`s emit on the event bus
- Close pane → assert one `SessionClosed`, surviving session still produces output
- Manifest persistence: split tab, kill process, reopen, both PTYs respawn at correct cwds
- Per-pane operator binding: bind operator to pane 0, block on pane 1 → operator on pane 0 doesn't see it

**Visual (manual smoke for v1, automated later):**

- Editor splitter clamp with horizontal pane-split — drag editor splitter, terminal-block should not collapse below `2 * TERMINAL_MIN`
- Pane splitter drag is smooth, no xterm flicker
- Active-pane border swaps correctly on focus change
- Pi pane in split: keystrokes go to focused Pi, not the other
- `⌘W` on split-tab closes pane; on single-tab closes tab

**Feature flag (vitest + manual):**

- Flag off by default on fresh install — `splitPane()` returns error, shortcuts unbound, context menu omits split actions.
- Toggle flag on → shortcuts bind live, splits work; toggle off → shortcuts unbind live, existing splits still render and are still closable.
- Load a manifest containing a split tab with flag off → tab renders with both panes visible, splitter inert, close-pane works.
