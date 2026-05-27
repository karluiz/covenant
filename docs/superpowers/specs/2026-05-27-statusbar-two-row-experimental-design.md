# Two-row status bar behind an experimental toggle — design

Date: 2026-05-27
Branch: `feat/statusbar-two-row-experimental`
Worktree: `.claude/worktrees/statusbar-two-row-experimental-a/`

## Context

The two-row status bar shipped in `8aee4f5 feat(statusbar): two-row layout (proposal B)` and works well for users with long mission filenames that would otherwise crowd the runtime telemetry. But some users prefer the original single-row layout — it's denser and matches their muscle memory.

We need a per-user toggle so unhappy users can revert without losing access to the new layout's benefits if they change their mind later.

## Goal

Add a per-user setting that switches the status bar between the new two-row layout (default) and the original single-row layout, persisted via the existing settings system. Surfaced as a checkbox in the Settings → Experimental section.

## Non-goals

- Server-side sync of the preference (local settings only, like every other setting today).
- Deprecating or removing the two-row layout — it stays the default and the canonical implementation.
- A keyboard shortcut to toggle (settings checkbox is enough).
- A live preview / before-after diff inside the settings panel.
- Bundling other experimental features into this change.

---

## Architecture

The existing `ExperimentalConfig` pattern is the model:

- Backend: `crates/app/src/settings.rs:55-62` defines `ExperimentalConfig` with `split_panes: bool`.
- Frontend: `ui/src/settings/panel.ts:518` renders the checkbox; the panel's save path writes the field back.
- Wire-up: `ui/src/main.ts:1141` listens for settings changes and calls `manager.setSplitPanesEnabled(next.experimental?.split_panes ?? false)`.

We add `statusbar_two_row: bool` to that same struct (defaulting to `true`), a parallel checkbox, and a parallel `manager.setStatusbarTwoRow(v)` that walks every tab's `StatusBar` and rebuilds its assembly.

The DOM rebuild is cheap: `StatusBar` already does a full re-render on theme changes; we extend the same path. Toggling at runtime requires no respawn.

CSS uses a `--statusbar-h` custom property + a `body.statusbar-single-row` body class so the two-row-specific rules (`.sb-row--*`, height bump from 26→50px) only apply when the flag is on. Dependent panels that grew hardcoded `bottom: 51px` offsets (notably `.pn-panel` in `c2d8768`) get refactored to read the variable instead.

---

## Components

### `ExperimentalConfig.statusbar_two_row` (backend)

`crates/app/src/settings.rs`:

```rust
fn default_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExperimentalConfig {
    #[serde(default)]
    pub split_panes: bool,

    /// Show identity + telemetry on the top row and the operator /
    /// mission / AOM cluster on a shorter bottom row. Default on
    /// (the layout that shipped). Flip off to use the original
    /// single-row layout.
    #[serde(default = "default_true")]
    pub statusbar_two_row: bool,
}

impl Default for ExperimentalConfig {
    fn default() -> Self {
        Self { split_panes: false, statusbar_two_row: true }
    }
}
```

The `#[derive(Default)]` is dropped because the default for `statusbar_two_row` needs to be `true` (the layout users currently see), not the bool zero-value. The hand-written impl AND the `#[serde(default = "default_true")]` together cover both `Settings::default()` (Rust-side construction) and `serde::from_str` of an older config.json that lacks the field.

### Frontend type (`ui/src/api.ts`)

Mirror the backend shape. Find the existing `ExperimentalConfig` TS type (`ui/src/settings/panel.ts:123` declares it inline today — could stay there if it's only used by the panel). Add `statusbar_two_row?: boolean`.

### Settings panel (`ui/src/settings/panel.ts`)

- Initial-state reader (around line 856 — `splitPanesInput.checked = !!this.current.experimental?.split_panes`):
  ```ts
  twoRowInput.checked = this.current.experimental?.statusbar_two_row ?? true;
  ```
- Checkbox markup (around line 518):
  ```html
  <label class="settings-flag">
    <input type="checkbox" name="experimental_statusbar_two_row" />
    <span class="settings-flag-text">
      <strong>Two-row status bar</strong>
      <small>Split identity/telemetry across two rows. Uncheck for the original single-row layout.</small>
    </span>
  </label>
  ```
- Save path (around line 1277):
  ```ts
  experimental: {
    split_panes: splitPanesInput.checked,
    statusbar_two_row: twoRowInput.checked,
  },
  ```
- DOM query (around line 767):
  ```ts
  const twoRowInput = this.dialog.querySelector<HTMLInputElement>(
    'input[name="experimental_statusbar_two_row"]',
  )!;
  ```

### Manager (`ui/src/tabs/manager.ts`)

New method paralleling `setSplitPanesEnabled` (search for that to find its location):

```ts
setStatusbarTwoRow(v: boolean): void {
  document.body.classList.toggle("statusbar-single-row", !v);
  for (const t of this.tabs) {
    t.statusBar?.setTwoRow(v);
  }
}
```

The body class lets CSS (and any future external observer) react without a JS callback. The per-tab StatusBar update is what actually rebuilds the DOM. Existing tabs that haven't initialized a statusbar yet are no-ops via the optional chain.

### main.ts wire-up

At the existing settings-update site (`main.ts:1141`):

```ts
manager.setSplitPanesEnabled(next.experimental?.split_panes ?? false);
manager.setStatusbarTwoRow(next.experimental?.statusbar_two_row ?? true);
```

Same call at boot (around `main.ts:1393` where experimental flags are first loaded).

### StatusBar (`ui/src/status/bar.ts`)

Today the assembly block at lines 666-689 always appends two rows. Refactor:

```ts
private twoRow: boolean = true; // mutated by setTwoRow

// ... in constructor or wherever it builds segments:
this.assembleSegments(left, framing, center, right);

private assembleSegments(
  left: HTMLElement, framing: HTMLElement,
  center: HTMLElement, right: HTMLElement,
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

setTwoRow(v: boolean): void {
  if (this.twoRow === v) return;
  this.twoRow = v;
  this.render(this.lastDirCtx);
}
```

`StatusBar.render(ctx)` is the existing full-rebuild entry point — it's already called from every other settings-style change in `bar.ts` (theme, version, hidden toggle, etc., at lines 167, 217, 244, 253, 264, 289, 298, 339). It internally clears the host and re-assembles all segments. `setTwoRow` reuses it for free.

### CSS (`ui/src/styles.css`)

1. **Introduce the height variable.** Near the top of the file or alongside other root vars:
   ```css
   :root {
     --statusbar-h: 50px;
   }
   body.statusbar-single-row {
     --statusbar-h: 26px;
   }
   ```

2. **Scope the two-row rules** so they only apply when the body class is absent. Find the existing `.statusbar` rule (search for the recent `c2d8768` / `8aee4f5` changes). Wrap the row-specific rules:
   ```css
   body:not(.statusbar-single-row) .sb-row { /* existing two-row rules */ }
   ```

3. **Read the variable everywhere a hardcoded 50/51px lives.** Confirm with:
   ```bash
   grep -nE "bottom:[[:space:]]*5[01]px|height:[[:space:]]*50px" ui/src
   ```
   At minimum: `.pn-panel { bottom: calc(var(--statusbar-h) + 1px); }`, and the inline `top: 76px; /* tabbar (38) + ... */` in `ui/src/project-notes/styles.css:21` — if any of those values depend on statusbar height (the top one doesn't, but check).

### project-notes CSS (`ui/src/project-notes/styles.css`)

The recent commit hardcoded `bottom: 51px` at lines 22 and 72 (per `c2d8768`'s diff). Swap both to `bottom: calc(var(--statusbar-h) + 1px)`.

---

## Data flow

```
Settings save
   │
   ▼
backend Settings struct (persist to config.json)
   │
   ▼
settings-changed event → main.ts handler at :1141
   │
   ▼
manager.setStatusbarTwoRow(v)
   │
   ├── document.body.classList.toggle("statusbar-single-row", !v)
   │       └── CSS variable --statusbar-h flips → .pn-panel / other consumers reflow
   │
   └── for each tab: statusBar.setTwoRow(v)
           └── StatusBar re-assembles segments under host
```

No async, no race. Settings-update is fire-and-forget; the rebuild completes before the next paint.

---

## Testing

### Backend
`crates/app/src/settings.rs` — new test mirroring `experimental_split_panes_roundtrip`:

```rust
#[test]
fn experimental_statusbar_two_row_defaults_true() {
    let s = Settings::default();
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
    // Older config.json files won't have the field. They must roll over
    // to two-row (the current behavior) without surprising the user.
    let json = r#"{
        "experimental": { "split_panes": false }
    }"#;
    let s: Settings = serde_json::from_str(json).unwrap();
    assert!(s.experimental.statusbar_two_row);
}
```

The third test is the critical one — it asserts the migration story.

### Frontend
Create `ui/src/status/bar.test.ts` (or extend existing tests if any). Use jsdom:

- `setTwoRow(true)` on a fresh StatusBar produces a host with two children both having `class*="sb-row"`.
- `setTwoRow(false)` produces a host with `left/framing/center/right` directly as children, no `.sb-row--*` wrappers.
- Repeated calls to `setTwoRow(true)` (same value) don't re-rebuild (assert via a spy that segment-build code only runs once).

### Manual
- Boot the app → two-row visible by default.
- Open Settings → Experimental → uncheck "Two-row status bar" → save → status bar collapses to single-row immediately, `.pn-panel` (if visible) re-anchors to the lower bottom.
- Toggle back on → returns to two-row.
- Quit + restart → preference persists.

---

## Files touched (preview)

- `crates/app/src/settings.rs` — field + hand-written `Default` + three tests
- `ui/src/settings/panel.ts` — checkbox markup, DOM query, initial-state read, save-path write
- `ui/src/status/bar.ts` — `twoRow` field, `assembleSegments` split, `setTwoRow` method, rebuild trigger
- `ui/src/styles.css` — `--statusbar-h` variable, scope two-row rules under `body:not(.statusbar-single-row)`, update `.pn-panel` bottom to use the variable
- `ui/src/project-notes/styles.css` — replace `bottom: 51px` (two occurrences) with `calc(var(--statusbar-h) + 1px)`
- `ui/src/tabs/manager.ts` — `setStatusbarTwoRow(v)` method
- `ui/src/main.ts` — wire the setting at boot + on settings change

## Risks

- **Other consumers with hardcoded 50/51px offsets** — the grep at implementation time catches any I missed in this design. Each gets the same `calc(var(--statusbar-h) + 1px)` treatment.
- **A statusbar segment holds tooltip / popover state across rebuilds** — closing the open popover on `setTwoRow` is acceptable (settings save is an explicit user action, not a passive event).
- **First-launch race** — if `main.ts` reads experimental flags before settings has finished loading, the toggle could flicker. Existing `setSplitPanesEnabled` has the same risk; copy that pattern's timing exactly.
- **CSS specificity** — `body:not(.statusbar-single-row) .sb-row` is more specific than `.sb-row`. Confirm there's no other `.sb-row` rule elsewhere that needs to keep applying in single-row mode (there isn't today; the class is brand new from `8aee4f5`).
