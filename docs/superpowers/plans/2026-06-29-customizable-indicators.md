# Customizable Toolbar & Sidebar Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Appearance setting that lets users hide individual titlebar buttons, status-bar chips, and left titlebar widgets.

**Architecture:** One persisted `hidden_indicators: string[]` setting + a static registry (`ui/src/indicators.ts`) mapping indicator id → CSS selector. A single injected `<style>` tag hides the selectors of hidden ids; it survives the status bar's frequent re-renders where `el.hidden` would not. Wired through the existing Appearance settings toggle pattern.

**Tech Stack:** Rust (serde Settings struct), TypeScript, vitest, xterm.js app (Tauri 2).

## Global Constraints

- TypeScript `strict: true`; no `as any` without a justifying comment.
- All UI chrome copy in English.
- No new dependencies.
- Conventional Commits; one commit per task.
- Frontend tests: `npm run test` (vitest) run from repo ROOT, not `ui/`.
- Rust tests: `cargo test -p covenant_lib` (the `app` crate's lib is `covenant_lib`).
- No `unwrap()` in Rust outside `#[cfg(test)]`/`main()`.

---

### Task 1: Backend — `hidden_indicators` settings field

**Files:**
- Modify: `crates/app/src/settings.rs` (struct ~257, `Default for Settings` impl ~608)

**Interfaces:**
- Produces: `Settings.hidden_indicators: Vec<String>` — serialized as JSON `string[]`, defaults to `[]`. Consumed by the frontend via the existing `get_settings`/`set_settings` commands.

- [ ] **Step 1: Write the failing test**

Add to the existing `#[cfg(test)]` module at the bottom of `crates/app/src/settings.rs`:

```rust
#[test]
fn hidden_indicators_defaults_empty_and_roundtrips() {
    // Missing field deserializes to an empty vec.
    let s: Settings = serde_json::from_str("{}").unwrap();
    assert!(s.hidden_indicators.is_empty());

    // Round-trips through JSON.
    let mut s2 = Settings::default();
    s2.hidden_indicators = vec!["beacon".to_string(), "sb-git".to_string()];
    let json = serde_json::to_string(&s2).unwrap();
    let back: Settings = serde_json::from_str(&json).unwrap();
    assert_eq!(back.hidden_indicators, vec!["beacon", "sb-git"]);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant_lib hidden_indicators_defaults_empty_and_roundtrips`
Expected: FAIL — `no field hidden_indicators on type Settings`.

- [ ] **Step 3: Add the struct field**

In `crates/app/src/settings.rs`, after the `notch_*` fields (around line 264), add:

```rust
    /// Ids of indicators (titlebar buttons, status-bar chips, left
    /// widgets) the user has hidden via Settings → Appearance →
    /// Indicators. Empty = everything visible. Ids are defined in the
    /// frontend registry `ui/src/indicators.ts`; unknown ids are ignored.
    #[serde(default)]
    pub hidden_indicators: Vec<String>,
```

- [ ] **Step 4: Add the Default impl entry**

In `impl Default for Settings` (around line 608, alongside `status_bar_enabled: default_status_bar_enabled(),`), add:

```rust
            hidden_indicators: Vec::new(),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p covenant_lib hidden_indicators_defaults_empty_and_roundtrips`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/settings.rs
git commit -m "feat(settings): add hidden_indicators field"
```

---

### Task 2: Frontend registry + CSS apply (`ui/src/indicators.ts`)

**Files:**
- Create: `ui/src/indicators.ts`
- Test: `ui/src/indicators.test.ts`

**Interfaces:**
- Produces:
  - `interface Indicator { id: string; label: string; group: string; selector: string }`
  - `const INDICATORS: Indicator[]`
  - `function buildIndicatorCss(hidden: string[]): string`
  - `function applyIndicatorVisibility(hidden: string[]): void`
- Consumed by: Task 3 (`INDICATORS` for the checklist) and Task 4 (`applyIndicatorVisibility`).

- [ ] **Step 1: Write the failing test**

Create `ui/src/indicators.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { INDICATORS, buildIndicatorCss } from "./indicators";

describe("buildIndicatorCss", () => {
  it("returns empty string for no hidden ids", () => {
    expect(buildIndicatorCss([])).toBe("");
  });

  it("emits a display:none rule per hidden id using its selector", () => {
    const css = buildIndicatorCss(["beacon", "sb-git"]);
    expect(css).toContain("#titlebar-beacon{display:none!important}");
    expect(css).toContain(".status-git{display:none!important}");
    // an unselected indicator is absent
    expect(css).not.toContain("#titlebar-view-blocks");
  });

  it("ignores unknown ids", () => {
    expect(buildIndicatorCss(["does-not-exist"])).toBe("");
  });
});

describe("INDICATORS registry", () => {
  it("has unique ids", () => {
    const ids = INDICATORS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- indicators`
Expected: FAIL — cannot resolve `./indicators`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/indicators.ts`:

```ts
// Registry of UI indicators the user can show/hide from
// Settings → Appearance → Indicators. Adding a new toggleable
// indicator is a single entry here — no other code changes.
//
// `selector` must target the indicator's root element(s). Hiding is
// applied via an injected stylesheet (see applyIndicatorVisibility)
// rather than el.hidden, because the status bar rebuilds its chip DOM
// on every render and would wipe a JS-set flag.

export interface Indicator {
  id: string;
  label: string;
  group: string;
  selector: string;
}

export const INDICATORS: Indicator[] = [
  // Titlebar (right cluster)
  { id: "blocks", label: "Blocks", group: "Titlebar", selector: "#titlebar-view-blocks" },
  { id: "files", label: "Files", group: "Titlebar", selector: "#titlebar-view-files" },
  { id: "activity", label: "Activity", group: "Titlebar", selector: "#titlebar-view-activity" },
  { id: "recall", label: "Recall", group: "Titlebar", selector: "#titlebar-view-recall" },
  { id: "notes", label: "Project notes", group: "Titlebar", selector: "#titlebar-project-notes" },
  { id: "teammate", label: "Teammate chat", group: "Titlebar", selector: "#titlebar-view-teammate" },
  { id: "tasker", label: "Tasker", group: "Titlebar", selector: "#titlebar-tasker" },
  { id: "resources", label: "Resources", group: "Titlebar", selector: "#titlebar-resources" },
  { id: "beacon", label: "Beacon", group: "Titlebar", selector: "#titlebar-beacon" },
  { id: "cdlc", label: "CDLC", group: "Titlebar", selector: "#titlebar-cdlc" },
  { id: "browser", label: "Browser", group: "Titlebar", selector: "#titlebar-browser" },

  // Left titlebar widgets
  { id: "spawns", label: "Spawns chip", group: "Left titlebar", selector: "#spawns-chip-mount" },
  { id: "workspace", label: "Workspace switcher", group: "Left titlebar", selector: ".workspace-chip" },

  // Status bar chips
  { id: "sb-git", label: "Git", group: "Status bar", selector: ".status-git" },
  { id: "sb-operator", label: "Operator", group: "Status bar", selector: ".status-chip-operator" },
  { id: "sb-mission", label: "Mission", group: "Status bar", selector: ".status-mission" },
  { id: "sb-executor", label: "Executor", group: "Status bar", selector: ".status-executor" },
  { id: "sb-aom", label: "AOM", group: "Status bar", selector: ".status-aom" },
];

const STYLE_ID = "indicator-overrides";

export function buildIndicatorCss(hidden: string[]): string {
  const ids = new Set(hidden);
  return INDICATORS.filter((i) => ids.has(i.id))
    .map((i) => `${i.selector}{display:none!important}`)
    .join("\n");
}

// ponytail: hiding a titlebar button while its panel is open just removes
// the toggle affordance; the panel stays until closed elsewhere. Force-close
// is the upgrade if anyone asks.
export function applyIndicatorVisibility(hidden: string[]): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = buildIndicatorCss(hidden);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- indicators`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/indicators.ts ui/src/indicators.test.ts
git commit -m "feat(indicators): registry + CSS visibility apply"
```

---

### Task 3: Appearance settings — Indicators checklist

**Files:**
- Modify: `ui/src/settings/panel.ts` — import (~top), `Settings` interface (~138), default object (~305), Appearance markup (~536, end of the notch block inside `#sec-appearance`), query (~1206), load (~1320), save (~1905)

**Interfaces:**
- Consumes: `INDICATORS` from `ui/src/indicators.ts`; `Settings.hidden_indicators` from Task 1.
- Produces: the saved `Settings` object now carries `hidden_indicators`, read by Task 4 via `onSaved`/`getSettings`.

- [ ] **Step 1: Add the import**

At the top of `ui/src/settings/panel.ts`, with the other imports:

```ts
import { INDICATORS } from "../indicators";
```

- [ ] **Step 2: Add the type field**

In the `Settings` interface (around line 138, near `status_bar_enabled: boolean;`):

```ts
  hidden_indicators: string[];
```

- [ ] **Step 3: Add to the default settings object**

In the default `Settings` literal (around line 305, near `status_bar_enabled: true,`):

```ts
        hidden_indicators: [],
```

- [ ] **Step 4: Add a checklist renderer + markup**

Near the top of `panel.ts` (module scope, after imports), add the renderer:

```ts
function renderIndicatorChecklist(): string {
  const groups = [...new Set(INDICATORS.map((i) => i.group))];
  return groups
    .map(
      (g) => `
        <div class="settings-indicator-group">
          <span class="settings-sublabel">${g}</span>
          ${INDICATORS.filter((i) => i.group === g)
            .map(
              (i) => `
            <label class="settings-checkbox-row">
              <input type="checkbox" data-indicator-id="${i.id}" />
              <span>${i.label}</span>
            </label>`,
            )
            .join("")}
        </div>`,
    )
    .join("");
}
```

Then in the Appearance section template, immediately after the "Done chime" `</label>` (around line 536), insert:

```ts
          <label class="settings-field">
            <span class="settings-label">Indicators</span>
            <div class="settings-indicator-list">
              ${renderIndicatorChecklist()}
            </div>
            <small class="settings-hint">
              Uncheck an indicator to hide it from the titlebar, status
              bar, or left toolbar. Hidden indicators stop rendering; the
              features themselves keep working.
            </small>
          </label>
```

- [ ] **Step 5: Query the checkboxes**

In the same block that queries `statusBarEnabled` (around line 1206), add:

```ts
    const indicatorChecks = form.querySelectorAll<HTMLInputElement>(
      "input[data-indicator-id]",
    );
```

- [ ] **Step 6: Load state into the checkboxes**

Where `statusBarEnabled.checked = ...` is set (around line 1320), add:

```ts
    const hidden = new Set(this.current.hidden_indicators ?? []);
    indicatorChecks.forEach((cb) => {
      cb.checked = !hidden.has(cb.dataset.indicatorId!);
    });
```

- [ ] **Step 7: Collect state on save**

In the `next: Settings` object built in the submit handler (around line 1905, near `status_bar_enabled: statusBarEnabled.checked,`), add:

```ts
        hidden_indicators: Array.from(indicatorChecks)
          .filter((cb) => !cb.checked)
          .map((cb) => cb.dataset.indicatorId!),
```

- [ ] **Step 8: Verify build + types**

Run: `npm run test` then `cd ui && npx tsc --noEmit && cd ..`
Expected: vitest green; tsc no errors.

- [ ] **Step 9: Commit**

```bash
git add ui/src/settings/panel.ts
git commit -m "feat(settings): Indicators checklist in Appearance"
```

---

### Task 4: Apply visibility at boot and on save (`ui/src/main.ts`)

**Files:**
- Modify: `ui/src/main.ts` — import (~top), boot apply (~1227), `settings.onSaved` (~1639)

**Interfaces:**
- Consumes: `applyIndicatorVisibility` from Task 2; `initialSettings.hidden_indicators` / `next.hidden_indicators` from Tasks 1 and 3.

- [ ] **Step 1: Add the import**

At the top of `ui/src/main.ts`, with the other imports:

```ts
import { applyIndicatorVisibility } from "./indicators";
```

- [ ] **Step 2: Apply at boot**

Right after `statusBar.setEnabled(initialSettings?.status_bar_enabled ?? true);` (around line 1227), add:

```ts
  applyIndicatorVisibility(initialSettings?.hidden_indicators ?? []);
```

- [ ] **Step 3: Apply on save**

Inside `settings.onSaved = (next) => {` (around line 1639, near `statusBar.setEnabled(next.status_bar_enabled ?? true);`), add:

```ts
    applyIndicatorVisibility(next.hidden_indicators ?? []);
```

- [ ] **Step 4: Verify build + types**

Run: `cd ui && npx tsc --noEmit && cd ..`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/main.ts
git commit -m "feat(indicators): apply visibility at boot and on save"
```

- [ ] **Step 6: Manual verification**

Run the app (`/respawn` or `npm run tauri:dev`). In Settings → Appearance →
Indicators: uncheck Beacon and Git, Save. Confirm the Beacon titlebar button
and the git status-bar chip disappear immediately. Reopen Settings → the two
boxes are still unchecked. Restart the app → they remain hidden. Re-check
both → they reappear.

---

## Self-Review Notes

- **Spec coverage:** settings field (Task 1), registry + CSS apply (Task 2), Appearance checklist grouped by surface (Task 3), boot + onSaved apply (Task 4). All spec sections covered.
- **Deviation from spec:** workspace switcher selector is `.workspace-chip` (verified in `ui/src/workspaces/switcher.ts:65`), not the spec's placeholder `#workspace-switcher-row`. No DOM changes needed anywhere — feature is purely additive.
- **Type consistency:** `hidden_indicators` (`Vec<String>` / `string[]`) and `applyIndicatorVisibility(hidden: string[])` used consistently across all four tasks.
- **CSS classes** `settings-indicator-group`, `settings-sublabel`, `settings-indicator-list` are new; they inherit usable defaults from existing `.settings-*` styles. Add targeted CSS in `ui/src/styles.css` only if spacing looks off during Task 4 manual verification (optional polish, not required for function).
```
