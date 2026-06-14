# Titlebar right-cluster: toggle parity, equal weight, fold authority

**Date:** 2026-06-14
**Branch:** `worktree-titlebar-toggle-parity`
**Scope:** `#app-titlebar-right` only — the 8 view/panel buttons + the fold button shown in the screenshot. The left cluster (`tabbar-fold`, `tabbar-collapse-all`) is out of scope.

---

## Problem

The right-side titlebar cluster has eight icon buttons plus a fold/collapse button at the end. They are meant to read as one uniform row of toggles, but today they don't:

1. **Toggle parity** — every button should behave the same: click to show its thing + light up, click again to hide + dim. Today the **Browser/globe** button is a one-shot action (spawns a new browser tab every click, no on/off state).
2. **Equal weight** — no button should look heavier than its neighbors. Today **Project Notes** renders its icon at 16px while every sibling is 14px.
3. **Respect the fold** — the fold button at the end is the collapse control; all the toggles must coordinate with it. Today folding the rail leaves buttons still highlighted "on" while nothing is shown, and leaves some panels open.

### Root cause

There is **no single source of truth** for "what is the right rail currently showing." Eight separate click handlers each manually mutate `body` classes and reach into other buttons' `.titlebar-view-active` class, with **incomplete cross-coverage**. Concretely, on `main` @ `61ba7ba`:

| Symptom | Location |
|---|---|
| `pickView()` (blocks/files/activity/recall) closes Notes + Teammate but **forgets Tasker** | `ui/src/main.ts:551-552` |
| Teammate-open clears highlights but **doesn't close the Tasker body state** | `ui/src/main.ts:721-731` |
| `tabbar-fold-right` **only closes Project Notes** — leaves Teammate/Tasker open and leaves view buttons **still highlighted while the rail is hidden** | `ui/src/main.ts:821-828` |
| Browser/globe is a **pure action**, no toggle, no active state | `ui/src/main.ts:938-941` |
| Project Notes icon is **16px** vs siblings' 14px | `ui/src/main.ts:746` vs `519-522, 709, 778, 810` |

Patching each handler individually would re-create the same N-handlers-poking-each-other tangle. The fix is to centralize the rail's exclusivity into one owner.

---

## Goals

- Every button in `#app-titlebar-right` is the **same toggle**: click → open + light; click again → close + dim.
- All eight toggle icons are the **same visual weight** (14px, identical active treatment).
- The **fold button is the single collapse authority**: folding closes whatever is open and clears *all* highlights; clicking any toggle while folded unfolds and lights *only* that one.

## Non-goals

- The left titlebar cluster (`tabbar-fold`, `tabbar-collapse-all`) — untouched.
- Changing what any panel *does* once open (Notes/Teammate/Tasker/Browser internals unchanged).
- Persisting panel state (Teammate/Tasker/Notes) across reload — they remain ephemeral as today. Only the existing view persistence (`covenant.sidebar-view-activity`, `covenant.blocks-globally-collapsed`) is preserved.
- A generic reusable toggle-group widget (YAGNI for 8 buttons).

---

## Current button inventory (`#app-titlebar-right`, `ui/index.html:88-146`)

| Order | id | Icon | Today's behavior |
|---|---|---|---|
| 1 | `titlebar-view-blocks` | terminal `>_` (14px) | Rail **view** (exclusive among 1–4); click-active folds rail |
| 2 | `titlebar-view-files` | folder (14px) | Rail view |
| 3 | `titlebar-view-activity` | zap (14px) | Rail view (global; `body.sidebar-view-activity`) |
| 4 | `titlebar-view-recall` | history (14px) | Rail view |
| — | divider | | |
| 5 | `titlebar-project-notes` | clipboard (**16px**) | Exclusive panel toggle |
| 6 | `titlebar-view-teammate` | messageCircle (14px) | Exclusive panel toggle |
| 7 | `titlebar-tasker` | checklist (14px) | Exclusive panel toggle |
| 8 | `titlebar-browser` | globe (14px) | **Action** — opens new browser tab each click; `hidden` unless `experimental.internal_browser` |
| — | divider | | |
| end | `tabbar-fold-right` | panelRight (16px) | Collapse/expand the right rail |

---

## Design

### Overview

Introduce one controller that owns the right-rail "slot." Extract it to its own module so it is unit-testable in isolation, and feed it the existing open/close functions as adapters (the controller never knows panel internals — it only sequences them).

New file: **`ui/src/titlebar/right-rail.ts`**

```ts
// Targets that live IN the right rail. Browser is intentionally NOT here —
// it targets a main-area tab, not the rail (see "Browser exception").
export type RailTarget =
  | "blocks" | "structure" | "activity" | "recall"
  | "notes"  | "teammate"  | "tasker";

export interface RailAdapters {
  // Open the given target's panel/view. Implementations are the existing
  // functions in main.ts, lightly refactored to NOT also do exclusivity.
  open(target: RailTarget): void;
  // Close the given target's panel/view (idempotent).
  close(target: RailTarget): void;
  // Drive body.blocks-globally-collapsed + persist + refit.
  setFolded(folded: boolean): void;
  // Light exactly one titlebar button, or none when target is null.
  highlight(target: RailTarget | null): void;
}

export class RightRailController {
  private current: RailTarget | null;
  constructor(adapters: RailAdapters, initial: RailTarget | null) { ... }

  /** Click handler for every toggle button. */
  toggle(target: RailTarget): void {
    if (this.current === target) { this.setTarget(null); return; }
    this.setTarget(target);
  }

  /** Fold button: collapse what's open, or restore the last target. */
  toggleFold(): void {
    if (this.current !== null) { this.lastTarget = this.current; this.setTarget(null); }
    else { this.setTarget(this.lastTarget ?? "blocks"); }
  }

  /** The one mutation path. */
  private setTarget(next: RailTarget | null): void {
    if (this.current === next) return;
    if (this.current) this.adapters.close(this.current);   // close old
    if (next) this.adapters.open(next);                    // open new
    this.adapters.setFolded(next === null);                // fold authority
    this.adapters.highlight(next);                          // exactly one (or none)
    if (next) this.lastTarget = next;
    this.current = next;
  }

  /** External sync hook (e.g. tab-level view change forwards in). */
  syncTo(target: RailTarget | null): void { ... }
  get target(): RailTarget | null { return this.current; }
}
```

**Why this satisfies all three goals by construction:**

1. **Toggle parity** — every button's handler is `controller.toggle(target)`. One code path, identical semantics.
2. **Fold authority** — `setTarget(null)` is the only "folded" state; it always closes the old target *and* clears the highlight. The fold button routes through the same `setTarget`. Clicking any toggle while folded calls `setTarget(thatTarget)`, which unfolds and lights only it.
3. **Exclusivity** — `setTarget` closes `current` before opening `next`, so two panels can never co-exist and stale highlights can't linger. No handler needs to know about the others.

### Adapter wiring in `main.ts`

The existing functions become the adapter bodies, stripped of their ad-hoc exclusivity (the controller now owns that):

- `open("blocks"|"structure"|"activity"|"recall")` → existing `setView(view)` (dispatch `sidebar-view:set` / flip `body.sidebar-view-activity`).
- `open("notes")` → `openProjectNotes(group...)`; `close("notes")` → `activeProjectNotesPanel?.close()`.
- `open("teammate")` → existing open body (add `sidebar-view-teammate`, show host, `teammatePanel.openFor`); `close("teammate")` → `closeTeammateIfOpen()`.
- `open("tasker")` → existing open body; `close("tasker")` → `closeTaskerIfOpen()`.
- `setFolded(f)` → `applyBlocksCollapsed(f)` + `BLOCKS_GLOBAL_KEY` write + debounced `manager.refitActive()`.
- `highlight(t)` → clear `.titlebar-view-active` on all of `#app-titlebar-right`, then add it to the one button for `t` (or none).

Button click wiring collapses to:

```ts
viewBlocksBtn   → rail.toggle("blocks")
viewFilesBtn    → rail.toggle("structure")
viewActivityBtn → rail.toggle("activity")
viewRecallBtn   → rail.toggle("recall")
projectNotesBtn → rail.toggle("notes")
teammateBtn     → rail.toggle("teammate")
taskerBtn       → rail.toggle("tasker")
foldRightBtn    → rail.toggleFold()
```

The existing `pickView` "switch to a pi tab is disallowed" guard (`main.ts:545-550`) and the `sidebar-view:active` external-sync listener (`main.ts:574-589`) are preserved — the guard runs before `toggle()`, and the sync listener calls `rail.syncTo(view)` instead of poking classes directly.

### Browser exception (the one honest special case)

Per decision, the globe becomes a toggle too — but it targets a **main-area browser tab**, not the rail. TabManager already models `kind: "browser"` as a first-class tab (`tabs/manager.ts:229`). So:

- Add a small query/close pair to TabManager: `hasBrowserTab(): boolean` and `firstBrowserTabId(): TabId | null` (or reuse the existing tab list filter at `manager.ts:4842`). Close via existing `closeTab(id)`.
- `toggleBrowser()` in main.ts:
  - browser tab exists → `closeTab(id)` + dim globe.
  - none → `openBrowserTab("", true)` + light globe.
- The globe's active state mirrors "a browser tab exists," resynced on tab open/close/activate (hook the manager's existing tab-change notification; if none is exposed, light on open and dim on the close path — minimal viable sync, no new event bus).
- The globe is **not** a `RailTarget` and is **not** governed by the fold. Because the browser lives in a tab, folding the rail cannot and does not hide it. It still gets the identical toggle affordance, 14px weight, and `.titlebar-view-active` highlight so it reads as the same kind of button. **This asymmetry is intentional and documented.**

### Weight normalization

- Project Notes icon `Icons.clipboard({ size: 16 })` → `{ size: 14 }` (`main.ts:746`). All eight toggle icons now 14px.
- `.titlebar-view-active` is the single shared active style; ensure the globe button receives it (it currently never does).
- `tabbar-fold-right` keeps its 16px panel icon — it is the master control, separated by its own divider, deliberately distinct. (Micro-decision; trivially flippable to 14px if preferred.)

---

## Testing

The controller is a pure state machine (all side-effects via injected adapters), so it's unit-testable with a fake `RailAdapters` recording calls. New test `ui/src/titlebar/right-rail.test.ts` (jsdom, following the existing `board.test.ts` pattern), covering:

1. `toggle(A)` from folded → opens A, folds=false, highlight=A.
2. `toggle(B)` while A open → closes A, opens B, highlight=B (exclusivity, single highlight).
3. `toggle(A)` while A open → closes A, folds=true, highlight=null (toggle-off).
4. `toggleFold()` while A open → closes A, folds=true, highlight=null; remembers A.
5. `toggleFold()` while folded → restores A (last target), folds=false, highlight=A.
6. `toggle(B)` while folded → unfolds + opens only B (no stale A).
7. `syncTo(view)` updates highlight without re-opening.

Browser toggle is thin glue over TabManager; cover its open/close branch with a focused test if the manager helpers are mockable, otherwise verify manually in-app.

Manual in-app verification checklist (run before claiming done):
- Click each of the 8 buttons twice → opens then closes, exactly one lit at a time.
- Open any panel, click fold → panel closes, all dim.
- Fold, then click any toggle → unfolds, only that one lit.
- Open Tasker, then click Blocks → Tasker closes (the old bug).
- Globe → opens browser tab + lights; globe again → closes it + dims.
- Project Notes icon visually matches its neighbors' size.

---

## Risks & edge cases

- **`activity` is a global view** (not per-tab) and **`blocks`/`structure` are per-tab** — `setView` already handles this split; the adapter just delegates, no change.
- **pi tabs** can't show blocks/files — the existing guard stays in front of `toggle()`.
- **Reload restore** — on boot, construct the controller with `initial = folded ? null : activeSidebarTitlebarView`, preserving today's restore behavior.
- **Browser active-state sync** — if TabManager exposes no tab-change callback, the globe may briefly mis-light if a browser tab is closed via its own tab UI rather than the globe. Acceptable for v1; note as a follow-up. Prefer hooking an existing manager notification if one exists.
- **`sidebar-view:active` re-entrancy** — route external syncs through `syncTo()` (highlight-only) so they can't recursively trigger open/close.

## Out of scope / follow-ups

- Left cluster normalization.
- Persisting Teammate/Tasker/Notes across reload.
- A richer browser active-state (multi-tab awareness).
