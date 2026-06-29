# Customizable Toolbar & Sidebar Indicators

**Date:** 2026-06-29
**Status:** Approved design, ready for plan
**Surface:** Appearance settings → new "Indicators" block

## Problem

Covenant's titlebar-right cluster has ~11 rail-toggle buttons, the bottom
status bar has ~5 chips, and the left titlebar has a couple of widgets. Users
who don't use Beacon / CDLC / Tasker / etc. can't hide those affordances. We
want a single place in **Appearance** to choose which indicators are shown.

## Approach: one settings field + a static registry + one injected stylesheet

Rejected: one boolean `Settings` field per indicator (the existing
`status_bar_enabled` pattern). At ~18 indicators × ~7 edit-sites each that's
~130 lines of copy-paste and a struct field per item. Not worth it.

Chosen: **registry-driven, CSS-applied.**

1. **Settings:** add a single `hidden_indicators: Vec<String>` (TS
   `string[]`), default empty. Absence from the list = visible. One field.
2. **Registry** (`ui/src/indicators.ts`, the only new file): a flat list of
   every toggleable indicator — `{ id, label, group, selector }`.
3. **Appearance UI:** one new block that renders the registry as grouped
   checkboxes (looped, not hand-written). Checked = visible.
4. **Apply:** `applyIndicatorVisibility(hidden)` builds **one `<style>` tag**
   with `selector { display: none !important }` rules for the hidden ids, and
   replaces it on the document. Called in `settings.onSaved` and at boot.

Why CSS injection instead of `el.hidden`: the status bar re-renders its chips
on every state change (`StatusBar.render()` rebuilds the DOM), so any JS-set
`hidden` flag would be wiped. A stylesheet keyed on stable class/id selectors
survives re-renders with zero per-render wiring. This is the same reason it
also covers runtime-mounted titlebar widgets uniformly.

## The registry

```ts
// ui/src/indicators.ts
export interface Indicator {
  id: string;        // stable key persisted in settings.hidden_indicators
  label: string;     // shown in the Appearance checklist
  group: string;     // checklist section header
  selector: string;  // CSS selector for the DOM element(s) to hide
}

export const INDICATORS: Indicator[] = [
  // Titlebar (right cluster)
  { id: "blocks",    label: "Blocks",         group: "Titlebar",    selector: "#titlebar-view-blocks" },
  { id: "files",     label: "Files",          group: "Titlebar",    selector: "#titlebar-view-files" },
  { id: "activity",  label: "Activity",       group: "Titlebar",    selector: "#titlebar-view-activity" },
  { id: "recall",    label: "Recall",         group: "Titlebar",    selector: "#titlebar-view-recall" },
  { id: "notes",     label: "Project notes",  group: "Titlebar",    selector: "#titlebar-project-notes" },
  { id: "teammate",  label: "Teammate chat",  group: "Titlebar",    selector: "#titlebar-view-teammate" },
  { id: "tasker",    label: "Tasker",         group: "Titlebar",    selector: "#titlebar-tasker" },
  { id: "resources", label: "Resources",      group: "Titlebar",    selector: "#titlebar-resources" },
  { id: "beacon",    label: "Beacon",         group: "Titlebar",    selector: "#titlebar-beacon" },
  { id: "cdlc",      label: "CDLC",           group: "Titlebar",    selector: "#titlebar-cdlc" },
  { id: "browser",   label: "Browser",        group: "Titlebar",    selector: "#titlebar-browser" },

  // Left titlebar widgets
  { id: "spawns",    label: "Spawns chip",       group: "Left",     selector: "#spawns-chip-mount" },
  { id: "workspace", label: "Workspace switcher", group: "Left",    selector: "#workspace-switcher-row" }, // selector added in impl

  // Status bar chips (selectors already stable in bar.ts)
  { id: "sb-git",      label: "Git",      group: "Status bar", selector: ".status-git" },
  { id: "sb-operator", label: "Operator", group: "Status bar", selector: ".status-chip-operator" },
  { id: "sb-mission",  label: "Mission",  group: "Status bar", selector: ".status-mission" },
  { id: "sb-executor", label: "Executor", group: "Status bar", selector: ".status-executor" },
  { id: "sb-aom",      label: "AOM",      group: "Status bar", selector: ".status-aom" },
];
```

Adding a future indicator = one array entry. No other code changes.

## Apply function

```ts
// ui/src/indicators.ts
const STYLE_ID = "indicator-overrides";

export function buildIndicatorCss(hidden: string[]): string {
  const ids = new Set(hidden);
  return INDICATORS
    .filter((i) => ids.has(i.id))
    .map((i) => `${i.selector}{display:none!important}`)
    .join("\n");
}

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

Unknown ids in `hidden` (e.g. a removed indicator) are ignored by the filter —
forward/backward compatible.

## Wiring (existing patterns, file:line from current tree)

| Step | File | What |
|---|---|---|
| Settings struct | `crates/app/src/settings.rs` (~256) | add `hidden_indicators: Vec<String>` with `#[serde(default)]`; default `Vec::new()` in the `Default` impl (~608) |
| TS type | `ui/src/settings/panel.ts` (~138) | add `hidden_indicators: string[]` to `Settings` |
| Appearance markup | `ui/src/settings/panel.ts` `#sec-appearance` (439–826) | new "Indicators" block; render checkboxes by looping `INDICATORS` grouped by `group` |
| Query + load | `panel.ts` (~1206 / ~1320) | read `hidden_indicators ?? []`; set each checkbox `.checked = !hidden.includes(id)` |
| Save | `panel.ts` (~1905) | collect unchecked ids into `next.hidden_indicators` |
| Apply on save | `ui/src/main.ts` `settings.onSaved` (1631–1645) | `applyIndicatorVisibility(next.hidden_indicators ?? [])` |
| Apply at boot | `ui/src/main.ts` (~1227, near `statusBar.setEnabled`) | `applyIndicatorVisibility(initialSettings?.hidden_indicators ?? [])` |
| Left selector | `ui/src/main.ts` (~1197) | give the workspace-switcher row a stable `id="workspace-switcher-row"` |

## Edge cases / decisions

- **Hiding a titlebar button while its panel is open:** the panel stays open;
  only the toggle affordance disappears. Acceptable for v1. `ponytail:`
  comment at the apply site noting force-close is the upgrade if anyone asks.
- **`status_bar_enabled` stays as-is** (whole-bar off switch). Per-chip hiding
  layers on top: a hidden chip inside a shown bar just doesn't paint.
- **Core nav excluded** from the registry: `#tabbar-fold`,
  `#tabbar-collapse-all`, the right-rail fold — not indicators.
- **Empty `hidden_indicators`** (default / new users) → empty stylesheet →
  everything visible. No behavior change on upgrade.

## Testing

One runnable unit test (`ui/src/indicators.test.ts`):

- `buildIndicatorCss([])` → `""`.
- `buildIndicatorCss(["beacon","sb-git"])` → contains
  `#titlebar-beacon{display:none!important}` and `.status-git{...}`, and
  nothing for unlisted ids.
- `buildIndicatorCss(["nonexistent"])` → `""` (unknown id ignored).
- Registry integrity: every `id` is unique.

Manual: toggle a few off in Appearance, save, confirm they vanish from
titlebar + status bar live; reopen settings to confirm state round-trips;
restart app to confirm persistence.

## Out of scope

- Reordering indicators (only show/hide).
- Per-workspace or per-tab indicator sets (global only).
- Telegram / score / version status chips (trivial to add later as registry
  entries; left out to match the requested git/operator/mission/executor/AOM set).
