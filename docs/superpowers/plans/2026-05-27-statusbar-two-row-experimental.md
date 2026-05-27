# Two-row status bar behind experimental toggle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `experimental.statusbar_two_row` setting (default `true`) so users can revert the status bar to the original single-row layout via Settings → Experimental.

**Architecture:** Mirror the existing `experimental.split_panes` pattern end-to-end (backend bool + serde default + settings panel checkbox + `getExperimentalFlags` helper + `manager` wire). `StatusBar.setTwoRow(v)` toggles a single instance variable and calls the existing `render(this.lastDirCtx)` rebuild path. CSS introduces a `--statusbar-h` custom property and a `body.statusbar-single-row` class so two-row-only rules and dependent panel offsets reflow together.

**Tech Stack:** Rust (thiserror, serde, serde_json), TypeScript (strict), vitest + jsdom, CSS custom properties.

**Worktree:** `.claude/worktrees/statusbar-two-row-experimental-a/` on branch `feat/statusbar-two-row-experimental`. All work here.

**Spec:** `docs/superpowers/specs/2026-05-27-statusbar-two-row-experimental-design.md`.

**Commit policy:** ONE commit at the end (one feature, one commit per user preference). Tasks below describe progressive development but only Task 6 commits.

**Key fact found during planning:** `StatusBar` is a **singleton** (one `new StatusBar(statusBarHost)` at `ui/src/main.ts:867`), held by `TabManager.statusBar` at `ui/src/tabs/manager.ts:686`. The spec's loop-over-tabs language is wrong; `setStatusbarTwoRow` calls `this.statusBar?.setTwoRow(v)` directly.

---

## File Structure

- `crates/app/src/settings.rs` — add `statusbar_two_row` field, hand-written `Default`, three roundtrip tests
- `ui/src/api.ts` — extend `ExperimentalFlags` interface + helper destructure
- `ui/src/settings/panel.ts` — checkbox markup, DOM query, initial-state read, save-path write, extend `ExperimentalConfig` TS shape at line 123
- `ui/src/tabs/manager.ts` — `setStatusbarTwoRow(v)` method; extend `loadExperimentalFlags` to also read+apply this field
- `ui/src/main.ts` — wire the setting in the settings-changed handler at line 1141
- `ui/src/status/bar.ts` — `twoRow` field, `assembleSegments` split, `setTwoRow` method
- `ui/src/styles.css` — introduce `--statusbar-h`, scope two-row rules under `body:not(.statusbar-single-row)`, retire hardcoded 51px in `.pn-panel`
- `ui/src/project-notes/styles.css` — replace `bottom: 51px` (lines 22, 72) with `calc(var(--statusbar-h) + 1px)`
- `ui/src/status/bar.test.ts` — NEW. vitest+jsdom tests for setTwoRow assembly switch

---

## Task 1: Backend setting

**Files:**
- Modify: `crates/app/src/settings.rs:55-62` (ExperimentalConfig struct) + add `default_true` helper + replace derived Default with hand-written impl
- Modify: `crates/app/src/settings.rs:748-764` (tests module) — add 3 new tests

### Step 1: Add the failing tests first

Add inside the existing `mod tests` block (after the `experimental_split_panes_roundtrip` test at line 764):

```rust
    #[test]
    fn experimental_statusbar_two_row_defaults_true() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert!(s.experimental.statusbar_two_row);
    }

    #[test]
    fn experimental_statusbar_two_row_roundtrip() {
        let mut s = Settings::default();
        s.experimental.statusbar_two_row = false;
        let json = serde_json::to_string(&s).unwrap();
        let s2: Settings = serde_json::from_str(&json).unwrap();
        assert!(!s2.experimental.statusbar_two_row);
    }

    #[test]
    fn experimental_statusbar_two_row_missing_in_json_defaults_true() {
        // Older config.json files won't have the field. They must
        // roll over to two-row (the current shipped behavior) without
        // surprising the user.
        let json = r#"{
            "experimental": { "split_panes": false }
        }"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert!(s.experimental.statusbar_two_row);
    }
```

### Step 2: Run to confirm failure

```
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/statusbar-two-row-experimental-a
cargo test -p covenant settings::tests::experimental_statusbar_two_row 2>&1 | tail -15
```

Expected: compile error — `statusbar_two_row` field doesn't exist on `ExperimentalConfig`.

### Step 3: Add the field, hand-written Default, and serde-default helper

In `crates/app/src/settings.rs`, find the existing `ExperimentalConfig` (around line 55) and replace it. The current block is:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExperimentalConfig {
    /// Enable the split-panes UI (M-SP milestone). Off by default; flip
    /// to `true` in config.json to try the feature while it is being
    /// developed.
    #[serde(default)]
    pub split_panes: bool,
}
```

Replace with:

```rust
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperimentalConfig {
    /// Enable the split-panes UI (M-SP milestone). Off by default; flip
    /// to `true` in config.json to try the feature while it is being
    /// developed.
    #[serde(default)]
    pub split_panes: bool,

    /// Show identity + telemetry on the top row of the status bar and
    /// the operator / mission / AOM cluster on a shorter bottom row.
    /// Default `true` (the layout that shipped in 8aee4f5). Flip off
    /// to use the original single-row layout.
    #[serde(default = "default_true")]
    pub statusbar_two_row: bool,
}

impl Default for ExperimentalConfig {
    fn default() -> Self {
        Self {
            split_panes: false,
            statusbar_two_row: true,
        }
    }
}
```

The `#[derive(Default)]` is dropped because the field's correct default is `true`, not the bool zero-value. The hand-written `impl Default` and `#[serde(default = "default_true")]` together cover both `Settings::default()` (Rust-side) and `serde_json::from_str` of an existing config.json that lacks the field.

If `default_true` already exists elsewhere in the file (unlikely — grep first), reuse it; otherwise add it at module scope just above the struct.

### Step 4: Run all settings tests

```
cargo test -p covenant settings:: 2>&1 | tail -20
```

Expected: 3 new tests pass, plus all existing settings tests still green. The pre-existing `experimental_split_panes_defaults_false` test still passes because `split_panes` defaults to `false` in the hand-written `Default` impl.

### Step 5: Confirm covenant binary builds

```
cargo build -p covenant 2>&1 | tail -10
```

Expected: clean.

### Step 6: DO NOT COMMIT

Leave changes unstaged. Task 6 will commit everything together.

---

## Task 2: Frontend types + helper

**Files:**
- Modify: `ui/src/api.ts:1025-1032` — extend `ExperimentalFlags` + the helper destructure
- Modify: `ui/src/settings/panel.ts:123` — extend `ExperimentalConfig` TS shape

### Step 1: Extend `ExperimentalFlags` interface in `ui/src/api.ts`

Find this block at lines 1025-1032:

```typescript
export interface ExperimentalFlags {
  split_panes: boolean;
}

export async function getExperimentalFlags(): Promise<ExperimentalFlags> {
  const settings = await getSettings();
  return { split_panes: settings.experimental?.split_panes ?? false };
}
```

Replace with:

```typescript
export interface ExperimentalFlags {
  split_panes: boolean;
  statusbar_two_row: boolean;
}

export async function getExperimentalFlags(): Promise<ExperimentalFlags> {
  const settings = await getSettings();
  return {
    split_panes: settings.experimental?.split_panes ?? false,
    statusbar_two_row: settings.experimental?.statusbar_two_row ?? true,
  };
}
```

### Step 2: Extend `ExperimentalConfig` TS shape

Find this in `ui/src/settings/panel.ts` around line 123 (search for `experimental?: ExperimentalConfig`). The interface itself is declared near it — search up from line 123 for `interface ExperimentalConfig` or `type ExperimentalConfig`:

```
grep -n "interface ExperimentalConfig\|type ExperimentalConfig\|ExperimentalConfig {" ui/src/settings/panel.ts
```

When found, add the new field. If the interface looks like:

```typescript
interface ExperimentalConfig {
  split_panes: boolean;
}
```

Change to:

```typescript
interface ExperimentalConfig {
  split_panes: boolean;
  statusbar_two_row: boolean;
}
```

### Step 3: Typecheck

```
cd ui && npx tsc --noEmit 2>&1 | tail -10
```

Expected: clean (no errors). The pre-existing code that reads `experimental?.split_panes` still compiles; the new field is just added.

### Step 4: DO NOT COMMIT

---

## Task 3: Settings panel checkbox

**Files:**
- Modify: `ui/src/settings/panel.ts` around lines 516-528 (Experimental section markup), 760-768 (DOM query), 850-856 (initial-state read), 1270-1280 (save-path write)

### Step 1: Add the checkbox markup

In `ui/src/settings/panel.ts` find the Experimental section at line 516 — the existing block ends at line 528 with `</label>`. Insert a new `<label>` block AFTER the split-panes label (after line 528, before the section closing `</section>` tag at line 529):

Current end of the Experimental section:

```typescript
          <h4 class="settings-subsection-title">Experimental</h4>
          <label class="settings-field settings-field-row">
            <input type="checkbox" name="experimental_split_panes" />
            <span class="settings-label">Split panes</span>
            <small class="settings-hint">
              Allow splitting a tab into two panes side-by-side or stacked.
              Each pane gets its own session, mission, and operator.
              Shortcuts: <kbd>⌘D</kbd> split right,
              <kbd>⌘\</kbd> split down,
              <kbd>⌘[</kbd>/<kbd>⌘]</kbd> focus prev/next,
              <kbd>⌘⇧]</kbd> swap.
            </small>
          </label>
        </section>
```

Becomes:

```typescript
          <h4 class="settings-subsection-title">Experimental</h4>
          <label class="settings-field settings-field-row">
            <input type="checkbox" name="experimental_split_panes" />
            <span class="settings-label">Split panes</span>
            <small class="settings-hint">
              Allow splitting a tab into two panes side-by-side or stacked.
              Each pane gets its own session, mission, and operator.
              Shortcuts: <kbd>⌘D</kbd> split right,
              <kbd>⌘\</kbd> split down,
              <kbd>⌘[</kbd>/<kbd>⌘]</kbd> focus prev/next,
              <kbd>⌘⇧]</kbd> swap.
            </small>
          </label>
          <label class="settings-field settings-field-row">
            <input type="checkbox" name="experimental_statusbar_two_row" />
            <span class="settings-label">Two-row status bar</span>
            <small class="settings-hint">
              Split identity / telemetry across two rows of the status
              bar so a long mission filename doesn't crowd the runtime
              cluster off-screen. Uncheck for the original single-row
              layout.
            </small>
          </label>
        </section>
```

### Step 2: Add the DOM query

Find lines 766-768 (the `splitPanesInput` query):

```typescript
    const splitPanesInput = form.querySelector<HTMLInputElement>(
      'input[name="experimental_split_panes"]',
    )!;
```

Add immediately after:

```typescript
    const statusbarTwoRowInput = form.querySelector<HTMLInputElement>(
      'input[name="experimental_statusbar_two_row"]',
    )!;
```

### Step 3: Add the initial-state read

Find line 856 (`splitPanesInput.checked = !!this.current.experimental?.split_panes;`):

```typescript
    splitPanesInput.checked = !!this.current.experimental?.split_panes;
```

Add immediately after:

```typescript
    statusbarTwoRowInput.checked =
      this.current.experimental?.statusbar_two_row ?? true;
```

(`?? true` — not `!!` — because the default is `true`, not `false`. `!!undefined === false` would silently flip the default.)

### Step 4: Add the save-path write

Find the `experimental:` block at lines 1277-1279:

```typescript
        experimental: {
          split_panes: splitPanesInput.checked,
        },
```

Replace with:

```typescript
        experimental: {
          split_panes: splitPanesInput.checked,
          statusbar_two_row: statusbarTwoRowInput.checked,
        },
```

### Step 5: Typecheck

```
cd ui && npx tsc --noEmit 2>&1 | tail -10
```

Expected: clean.

### Step 6: DO NOT COMMIT

---

## Task 4: StatusBar conditional assembly + setTwoRow

**Files:**
- Modify: `ui/src/status/bar.ts` around lines 666-690 (the two-row assembly block at the end of `render`)
- Create: `ui/src/status/bar.test.ts`

### Step 1: Write the failing tests

Create `ui/src/status/bar.test.ts` with:

```typescript
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";

import { StatusBar } from "./bar";

describe("StatusBar.setTwoRow", () => {
  let host: HTMLDivElement;
  let bar: StatusBar;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    bar = new StatusBar(host);
    bar.setEnabled(true);
  });

  it("renders two .sb-row containers by default", () => {
    // Default state should be the two-row layout.
    const rows = host.querySelectorAll(".sb-row");
    expect(rows.length).toBe(2);
    expect(rows[0].classList.contains("sb-row--top")).toBe(true);
    expect(rows[1].classList.contains("sb-row--bot")).toBe(true);
  });

  it("setTwoRow(false) flattens to a single-row layout", () => {
    bar.setTwoRow(false);
    const rows = host.querySelectorAll(".sb-row");
    expect(rows.length).toBe(0);
    // The 4 segment groups (left/framing/center/right) should be
    // direct children of the host in the single-row layout.
    expect(host.children.length).toBeGreaterThanOrEqual(4);
  });

  it("setTwoRow(true) returns to the two-row layout", () => {
    bar.setTwoRow(false);
    bar.setTwoRow(true);
    const rows = host.querySelectorAll(".sb-row");
    expect(rows.length).toBe(2);
  });

  it("repeated setTwoRow with same value is a no-op", () => {
    // We can't easily spy on render() from outside, so this test just
    // confirms the result is stable across redundant calls.
    bar.setTwoRow(true);
    bar.setTwoRow(true);
    const rows = host.querySelectorAll(".sb-row");
    expect(rows.length).toBe(2);
  });
});
```

### Step 2: Confirm failure

```
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/statusbar-two-row-experimental-a
npx vitest run status/bar.test 2>&1 | tail -20
```

Expected: tests fail because `setTwoRow` doesn't exist yet.

If the tests fail because StatusBar can't be constructed in jsdom (missing dependency), examine the constructor; if it pulls in non-jsdom-safe modules, simplify the test by mocking those modules or stubbing the segments. If the test setup is genuinely impossible, STOP and report BLOCKED.

### Step 3: Add the `twoRow` field

In `ui/src/status/bar.ts`, find the existing private field declarations near the top of the class (around line 92+, search for `export class StatusBar {`). Add:

```typescript
  /// Layout mode. True = two-row (the shipped default). False = the
  /// original single-row layout. Toggled by `setTwoRow(v)` driven by
  /// the `experimental.statusbar_two_row` setting.
  private twoRow = true;
```

Place this alongside other UI-mode fields like `online`, `enabled`, etc.

### Step 4: Refactor the assembly block

In `ui/src/status/bar.ts`, find the two-row assembly block at lines 666-690. The current code is:

```typescript
    // Two-row layout (Proposal B). Top row keeps stable identity +
    // runtime telemetry; bottom row carries the ephemeral framing
    // (operator/mission/AOM) plus the trailing executor/telegram/score
    // cluster — so a long mission filename never crowds the cost/perf
    // numbers off-screen.
    const topRow = document.createElement("div");
    topRow.className = "sb-row sb-row--top";
    const botRow = document.createElement("div");
    botRow.className = "sb-row sb-row--bot";

    const topSpacer = document.createElement("div");
    topSpacer.className = "sb-spacer";
    const botSpacer = document.createElement("div");
    botSpacer.className = "sb-spacer";

    topRow.appendChild(left);
    topRow.appendChild(topSpacer);
    topRow.appendChild(center);

    botRow.appendChild(framing);
    botRow.appendChild(botSpacer);
    botRow.appendChild(right);

    this.host.appendChild(topRow);
    this.host.appendChild(botRow);
```

Replace with:

```typescript
    this.assembleSegments(left, framing, center, right);
```

Then add this private method elsewhere in the class (alongside other `private` helpers):

```typescript
  /// Append the four segment groups to `this.host` using the layout
  /// implied by `this.twoRow`.
  ///
  /// Two-row (default): top row carries identity (`left`) + runtime
  /// telemetry (`center`); bottom row carries ephemeral framing
  /// (`framing`) + trailing chrome (`right`). Bottom is shorter and
  /// dimmer per styles.css.
  ///
  /// Single-row (experimental.statusbar_two_row = false): the four
  /// groups appear flat under `this.host` in `left, framing, center,
  /// right` order — the original pre-8aee4f5 layout.
  private assembleSegments(
    left: HTMLElement,
    framing: HTMLElement,
    center: HTMLElement,
    right: HTMLElement,
  ): void {
    if (this.twoRow) {
      const topRow = document.createElement("div");
      topRow.className = "sb-row sb-row--top";
      const botRow = document.createElement("div");
      botRow.className = "sb-row sb-row--bot";
      const topSpacer = document.createElement("div");
      topSpacer.className = "sb-spacer";
      const botSpacer = document.createElement("div");
      botSpacer.className = "sb-spacer";
      topRow.appendChild(left);
      topRow.appendChild(topSpacer);
      topRow.appendChild(center);
      botRow.appendChild(framing);
      botRow.appendChild(botSpacer);
      botRow.appendChild(right);
      this.host.appendChild(topRow);
      this.host.appendChild(botRow);
    } else {
      this.host.appendChild(left);
      this.host.appendChild(framing);
      this.host.appendChild(center);
      this.host.appendChild(right);
    }
  }
```

### Step 5: Add the `setTwoRow` public method

Add as a public method alongside other public setters like `setEnabled`:

```typescript
  /// Switch between the two-row (default) and single-row status-bar
  /// layouts. Driven by the `experimental.statusbar_two_row` setting,
  /// pushed by `TabManager.setStatusbarTwoRow` on settings save and at
  /// boot. No-op if the value is unchanged.
  setTwoRow(v: boolean): void {
    if (this.twoRow === v) return;
    this.twoRow = v;
    document.body.classList.toggle("statusbar-single-row", !v);
    this.render(this.lastDirCtx);
  }
```

`render(this.lastDirCtx)` is the existing full-rebuild entry point — already used by 9+ other settings-style change paths (theme, version, hidden, etc.) inside `bar.ts`. It internally clears `this.host` and re-assembles every segment.

The `document.body.classList.toggle("statusbar-single-row", !v)` flips the CSS variable cascade (see Task 5) so dependent panels reflow at the same instant.

### Step 6: Confirm tests pass

```
npx vitest run status/bar.test 2>&1 | tail -15
```

Expected: 4 tests pass.

If `bar.test.ts` can't instantiate StatusBar cleanly (e.g. `__APP_VERSION__` global missing in jsdom), define it in the test setup:

```typescript
beforeEach(() => {
  (globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = "0.0.0-test";
  // ... existing setup
});
```

Vite injects `__APP_VERSION__` at build time; vitest with jsdom needs an explicit stub. If other globals are also missing, add them. Don't try to mock segment internals — the test asserts on the DOM shape, which is exactly what the integration we care about produces.

### Step 7: DO NOT COMMIT

---

## Task 5: CSS migration

**Files:**
- Modify: `ui/src/styles.css` — `--statusbar-h` variable, scope two-row rules, retire hardcoded 51px in `.pn-panel`
- Modify: `ui/src/project-notes/styles.css` lines 22, 72 — replace hardcoded 51px

### Step 1: Locate all hardcoded statusbar-height-dependent values

```
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/statusbar-two-row-experimental-a
grep -nE "bottom:\s*5[01]px|height:\s*50px|--statusbar" ui/src --include="*.css"
```

Note every match. The known ones from the spec:
- `ui/src/styles.css` — the recent `.statusbar` height bump (50px) and `.pn-panel` adjustment (51px) from commit `c2d8768`
- `ui/src/project-notes/styles.css:22` — `bottom: 51px` on `.pn-panel`
- `ui/src/project-notes/styles.css:72` — `bottom: 51px` on `.pn-panel.pn-fullscreen`

If the grep finds other consumers, apply the same treatment to each.

### Step 2: Introduce the `--statusbar-h` variable

In `ui/src/styles.css`, find the existing `:root` declaration (or add one near the top). Add:

```css
:root {
  /* ... existing vars ... */
  --statusbar-h: 50px;
}

body.statusbar-single-row {
  --statusbar-h: 26px;
}
```

If there's already a `:root` block, append `--statusbar-h: 50px;` inside it rather than creating a duplicate `:root`.

### Step 3: Scope the two-row CSS rules

Find the existing `.sb-row`, `.sb-row--top`, `.sb-row--bot`, and the `.statusbar` height: 50px rules added by commit `8aee4f5` / `c2d8768`. Wrap each with a parent selector so they only apply when NOT in single-row mode.

The cleanest pattern is:

```css
/* before */
.statusbar { height: 50px; }
.sb-row { /* ... */ }
.sb-row--top { /* ... */ }
.sb-row--bot { /* ... */ }
```

becomes:

```css
.statusbar { height: var(--statusbar-h); }
body:not(.statusbar-single-row) .sb-row { /* ... */ }
body:not(.statusbar-single-row) .sb-row--top { /* ... */ }
body:not(.statusbar-single-row) .sb-row--bot { /* ... */ }
```

The `.statusbar { height: var(--statusbar-h); }` change means the host element reflows automatically when the body class flips. The `.sb-row*` rules don't even need to fire in single-row mode because no `.sb-row` elements exist there (Task 4's `assembleSegments` skips them).

Scoping the `.sb-row*` rules is belt-and-suspenders — Task 4's `assembleSegments` doesn't create `.sb-row` elements in single-row mode, so technically the rules can't fire there. But the scoping documents intent and protects against future code that might leak `.sb-row` elements somewhere. Keep the scoping.

### Step 4: Update `.pn-panel` to use the variable

Find the `.pn-panel` rules. In `ui/src/styles.css` if there's an override from `c2d8768`, replace the hardcoded `51px` with `calc(var(--statusbar-h) + 1px)`. In `ui/src/project-notes/styles.css:22`:

```css
  bottom: 51px; /* status bar height (50px) + 1px top border */
```

becomes:

```css
  bottom: calc(var(--statusbar-h) + 1px); /* status bar height + 1px top border */
```

Same change at line 72 (`.pn-panel.pn-fullscreen`).

### Step 5: Apply same treatment to any other consumers found in Step 1

For each grep result, do the analogous swap. If a value is structurally unrelated to statusbar height (e.g. `bottom: 50px` on a completely different panel), leave it alone. Use judgment.

### Step 6: Smoke the build

```
cd ui && npx vite build 2>&1 | tail -10
```

Expected: build succeeds. CSS syntax errors will surface here.

If `vite build` is too slow, skip and rely on the dev server (the user can verify visually after the eventual commit).

### Step 7: DO NOT COMMIT

---

## Task 6: Manager + main.ts wire-up + final commit

**Files:**
- Modify: `ui/src/tabs/manager.ts` — add `setStatusbarTwoRow(v)`, extend `loadExperimentalFlags`
- Modify: `ui/src/main.ts:1141` — wire the setting in the settings-changed handler

### Step 1: Add `setStatusbarTwoRow` to `TabManager`

Find `setSplitPanesEnabled` at `ui/src/tabs/manager.ts:702`:

```typescript
  setSplitPanesEnabled(v: boolean): void {
    this.splitPanesEnabled = v;
    // D12 will wire `rebindSplitShortcuts()` here; for now this is a no-op.
  }
```

Add immediately after:

```typescript
  /// Driven by `experimental.statusbar_two_row` — toggles the status
  /// bar between the shipped two-row layout (true) and the original
  /// single-row layout (false). The StatusBar singleton is held at
  /// `this.statusBar`; we forward the value and the bar's `setTwoRow`
  /// triggers the existing render path + body-class flip.
  setStatusbarTwoRow(v: boolean): void {
    this.statusBar?.setTwoRow(v);
  }
```

### Step 2: Extend `loadExperimentalFlags`

Find `loadExperimentalFlags` at `ui/src/tabs/manager.ts:697-700`:

```typescript
  async loadExperimentalFlags(): Promise<void> {
    const f = await getExperimentalFlags();
    this.splitPanesEnabled = f.split_panes;
  }
```

Replace with:

```typescript
  async loadExperimentalFlags(): Promise<void> {
    const f = await getExperimentalFlags();
    this.splitPanesEnabled = f.split_panes;
    this.setStatusbarTwoRow(f.statusbar_two_row);
  }
```

This handles the boot path: when `manager.loadExperimentalFlags()` is called at startup (main.ts:1395), the persisted setting is read and applied immediately.

### Step 3: Wire into the settings-changed handler

Find `main.ts:1141`:

```typescript
    manager.setSplitPanesEnabled(next.experimental?.split_panes ?? false);
```

Add immediately after:

```typescript
    manager.setStatusbarTwoRow(next.experimental?.statusbar_two_row ?? true);
```

(Note `?? true` — the default is true.)

### Step 4: Final typecheck

```
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/statusbar-two-row-experimental-a/ui
npx tsc --noEmit 2>&1 | tail -10
```

Expected: clean.

### Step 5: Run all related tests

```
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/statusbar-two-row-experimental-a
cargo test -p covenant settings:: 2>&1 | tail -15
npx vitest run status/bar 2>&1 | tail -15
```

Expected: all settings tests green (including the 3 new ones), all 4 statusbar tests green.

### Step 6: Working-tree sanity check

```
git -C /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/statusbar-two-row-experimental-a status
```

Expected files (modified or new):
- M `crates/app/src/settings.rs`
- M `ui/src/api.ts`
- M `ui/src/main.ts`
- M `ui/src/settings/panel.ts`
- M `ui/src/status/bar.ts`
- ?? `ui/src/status/bar.test.ts`
- M `ui/src/styles.css`
- M `ui/src/project-notes/styles.css`
- M `ui/src/tabs/manager.ts`

If any OTHER files appear, STOP and report — don't commit unknown files.

### Step 7: Single commit

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/statusbar-two-row-experimental-a
git add crates/app/src/settings.rs ui/src/api.ts ui/src/main.ts ui/src/settings/panel.ts ui/src/status/bar.ts ui/src/status/bar.test.ts ui/src/styles.css ui/src/project-notes/styles.css ui/src/tabs/manager.ts
git commit -m "$(cat <<'EOF'
feat(statusbar): experimental toggle for single-row layout

The two-row status bar that shipped in 8aee4f5 splits identity /
telemetry across two rows so a long mission filename can't crowd
the runtime cluster off-screen. Some users prefer the original
single-row layout for density / muscle memory.

Adds `experimental.statusbar_two_row` (default `true`, so happy
users see no change). Settings → Experimental gets a "Two-row
status bar" checkbox; unchecking it returns the bar to the
pre-8aee4f5 flat-segment layout immediately, no respawn needed.

Mirrors the existing `experimental.split_panes` pattern end-to-end:
backend bool with hand-written Default + serde-default, frontend
checkbox + getExperimentalFlags helper extension, TabManager
forwards to the StatusBar singleton.

CSS introduces `--statusbar-h` so dependent panels (project-notes)
stop hardcoding 50/51px offsets and reflow automatically when the
body class flips.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Step 8: Verify the commit

```
git log --oneline -1
git show --stat HEAD | head -15
git status
```

Expected:
- New commit at HEAD
- 9 files in the commit
- Working tree clean
