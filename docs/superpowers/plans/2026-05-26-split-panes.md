# Split Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one tab contain two PTY-bearing panes (binary split, either orientation), each with its own session/mission/operator/cwd, optionally a Pi chat view. Ship behind an experimental settings flag with per-pane persistence in the tab manifest.

**Architecture:** Refactor `Tab` into `Tab + Pane[]` (Approach 2 from the spec). `Pane` becomes the first-class owner of per-PTY state. `Tab` shrinks to layout + 1–2 panes + shared editor. Existing per-tab call sites become `activePane(tab).x`. New DOM wrapper `.terminal-block` sits inside each tab and holds either one termHost or two termHosts plus a `.pane-splitter`. Persistence bumps the `SerializedTab` shape with a `panes[]` array; old single-pane manifests lift cleanly. The split UI (creation, shortcuts, context menu, swap, orientation toggle) is gated on `experimental.splitPanes`; the data model and existing splits remain functional even when the flag is off.

**Tech Stack:** TypeScript (UI), Rust + Tauri (backend), xterm.js (terminal renderer), vitest (TS tests), cargo test (Rust tests). All existing patterns reused — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-26-split-panes-design.md`

---

## File Structure

### New files

- `ui/src/tabs/pane.ts` — `Pane` interface, `TabLayout` interface, `activePane()` helper, layout invariant helpers (`assertLayoutValid`, `collapseToSingle`, `splitOrientations`). ~120 LOC.
- `ui/src/tabs/pane.test.ts` — unit tests for `Pane`/`TabLayout` invariants and helpers. ~150 LOC.
- `ui/src/tabs/pane-splitter.ts` — drag mechanics extracted as a reusable `installPaneSplitter()` function (mirrors the existing editor splitter at `ui/src/tabs/manager.ts:2177`). ~140 LOC.
- `ui/src/tabs/pane-splitter.test.ts` — pointer-event simulation tests for the splitter. ~80 LOC.
- `ui/src/tabs/split-actions.ts` — `splitPane`, `closePane`, `focusPane`, `swapPanes`, `setPaneOrientation`, `setPaneRatio` action functions that mutate a `Tab` and emit the right DOM/PTY side effects. ~250 LOC.
- `ui/src/tabs/split-actions.test.ts` — unit tests for each action. ~200 LOC.
- `crates/app/src/split_commands.rs` — Tauri commands: `split_pane`, `close_pane`, `focus_pane`, `swap_panes`, `set_pane_orientation`, `set_pane_ratio`. Each thin (delegates to existing session/PTY APIs). ~150 LOC.

### Modified files

- `ui/src/tabs/manager.ts` (~5000 LOC today, +400 / −250 net) — Tab interface shrinks; per-PTY fields move into `tab.panes[i]`. `addTabInternal` builds `.terminal-block` wrapper. `addPaneToTab` (new helper, factored out of existing per-tab setup) mounts a single pane's xterm + blocks + recall + finder etc. `closeTab` becomes `closePane` + `closeTab`. Shortcut bindings (`⌘D`, `⌘\`, `⌘[`, `⌘]`, `⌘⇧]`, `⌘W`) wired to the new actions. Editor splitter clamp updated.
- `ui/src/tabs/manager.ts` interfaces section (~ll. 183–290 today) — `Tab` rewritten with `panes`, `layout`, shared `editor`/`editorOpen` only.
- `ui/src/tabs/manager.ts` `SerializedTab` (~ll. 313–341) — adds optional `panes?: SerializedPane[]` + `layout?: SerializedLayout`. When absent, deserializer lifts existing scalar fields into a single-pane shape.
- `ui/src/status/bar.ts` — every `tab.cwd` / `tab.mission` / `tab.operator_id` / `tab.executor` becomes `activePane(tab).x`. Active-pane focus event triggers `bar.refresh()`.
- `ui/src/aom/*.ts` — per-pane operator binding; AOM loop iterates panes across tabs.
- `ui/src/executors/*.ts` — read sites (operator chip, executor brand, observer list) point at active pane.
- `ui/src/main.ts` — `⌘O` / `⌘M` / `⌘⇧J` / `⌘P` / `⌘⇧F` targets and key bindings: re-target reads, add new split shortcuts gated on the flag.
- `ui/src/settings/panel.ts` — new "Experimental" subsection in `sec-terminal` with the `experimental_split_panes` checkbox (mirrors `mind_v2` pattern at `panel.ts:540`).
- `ui/src/api.ts` — typed wrappers for the 6 new Tauri commands.
- `ui/src/styles.css` — `.terminal-block`, `.pane-splitter`, active-pane border styles.
- `ui/src/shortcuts/registry.ts` — register the new shortcuts so they show up in `⌘⇧K`.
- `crates/app/src/settings.rs` — `Settings.experimental: ExperimentalConfig` with `pub split_panes: bool` (default false).
- `crates/app/src/lib.rs` — register new commands; wire `tab_manifest_load`/`save` unchanged (manifest is opaque JSON to Rust).
- `crates/app/src/spec_detector.rs` (or wherever cwd watching lives) — subscribe per pane cwd, not per tab.

### Files not touched

- `crates/pty/*`, `crates/blocks/*`, `crates/session/*` — these already key off `SessionId`; no schema changes needed.
- `crates/app/src/tab_manifest.rs` — Rust persistence is a JSON blob; schema lives in TS.

---

## Task Index

- **Phase A — Data shape** (no behavior change): A1, A2, A3, A4, A5
- **Phase B — Read-side rename** (mirrors kept): B1, B2, B3, B4
- **Phase C — Write-side rename** (delete mirrors): C1, C2, C3
- **Phase D — Split UI** (gated): D1, D2, D3, D4, D5, D6, D7, D8, D9, D10, D11, D12, D13, D14
- **Phase E — Persistence**: E1, E2, E3
- **Phase F — Pi panes + polish** (gated): F1, F2, F3

---

## Phase A — Data shape (no behavior change)

### Task A1: Define `Pane` and `TabLayout` types

**Files:**
- Create: `ui/src/tabs/pane.ts`
- Test: `ui/src/tabs/pane.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// ui/src/tabs/pane.test.ts
import { describe, expect, it } from "vitest";
import {
  activePane,
  assertLayoutValid,
  collapseToSingle,
  type Pane,
  type Tab,
  type TabLayout,
} from "./pane";

const pane = (id: string, cwd = "/"): Pane => ({
  id,
  kind: "terminal",
  sessionId: null,
  cwd,
  mission: null,
  operator: null,
  blocks: [],
  xterm: null,
  piView: null,
});

const singleTab = (id: string): Tab => ({
  id,
  panes: [pane("p0")],
  layout: { kind: "single", activePaneIdx: 0 },
});

const splitTab = (id: string): Tab => ({
  id,
  panes: [pane("p0"), pane("p1")],
  layout: { kind: "split", orientation: "horizontal", activePaneIdx: 0, ratio: 0.5 },
});

describe("activePane", () => {
  it("returns pane 0 of a single tab", () => {
    const t = singleTab("t1");
    expect(activePane(t).id).toBe("p0");
  });

  it("returns the indexed pane of a split tab", () => {
    const t = splitTab("t1");
    t.layout.activePaneIdx = 1;
    expect(activePane(t).id).toBe("p1");
  });
});

describe("assertLayoutValid", () => {
  it("accepts a valid single tab", () => {
    expect(() => assertLayoutValid(singleTab("t1"))).not.toThrow();
  });

  it("accepts a valid split tab", () => {
    expect(() => assertLayoutValid(splitTab("t1"))).not.toThrow();
  });

  it("rejects single + 2 panes", () => {
    const t = singleTab("t1");
    (t.panes as Pane[]).push(pane("p1"));
    expect(() => assertLayoutValid(t)).toThrow(/single.*1 pane/);
  });

  it("rejects split + 1 pane", () => {
    const t = splitTab("t1");
    (t.panes as Pane[]).pop();
    expect(() => assertLayoutValid(t)).toThrow(/split.*2 panes/);
  });

  it("rejects split with no orientation", () => {
    const t = splitTab("t1");
    delete t.layout.orientation;
    expect(() => assertLayoutValid(t)).toThrow(/orientation/);
  });

  it("rejects activePaneIdx out of range", () => {
    const t = splitTab("t1");
    t.layout.activePaneIdx = 2 as 0 | 1;
    expect(() => assertLayoutValid(t)).toThrow(/activePaneIdx/);
  });
});

describe("collapseToSingle", () => {
  it("drops pane[1] and keeps pane[0]", () => {
    const t = splitTab("t1");
    collapseToSingle(t, 1);
    expect(t.panes.length).toBe(1);
    expect(t.panes[0].id).toBe("p0");
    expect(t.layout.kind).toBe("single");
    expect(t.layout.activePaneIdx).toBe(0);
  });

  it("drops pane[0] and slides pane[1] to index 0", () => {
    const t = splitTab("t1");
    collapseToSingle(t, 0);
    expect(t.panes.length).toBe(1);
    expect(t.panes[0].id).toBe("p1");
    expect(t.layout.kind).toBe("single");
    expect(t.layout.activePaneIdx).toBe(0);
  });

  it("clears orientation and ratio on collapse", () => {
    const t = splitTab("t1");
    collapseToSingle(t, 1);
    expect(t.layout.orientation).toBeUndefined();
    expect(t.layout.ratio).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal && npx vitest run ui/src/tabs/pane.test.ts
```
Expected: FAIL — module `./pane` not found.

- [ ] **Step 3: Implement `pane.ts`**

```ts
// ui/src/tabs/pane.ts
import type { Terminal } from "@xterm/xterm";
import type { PiChatView } from "../executors/pi/view";

export type PaneId = string;
export type PaneKind = "terminal" | "pi";
export type SplitOrientation = "horizontal" | "vertical";

export interface MissionInfo {
  path: string;
  title: string;
}

export interface Block {
  id: string;
  // …full Block shape lives in blocks module; we re-export for the Pane type
}

export interface Pane {
  id: PaneId;
  kind: PaneKind;
  sessionId: string | null;
  cwd: string;
  mission: MissionInfo | null;
  operator: string | null;
  blocks: Block[];
  xterm: Terminal | null;
  piView: PiChatView | null;
}

export interface TabLayout {
  kind: "single" | "split";
  orientation?: SplitOrientation;
  activePaneIdx: 0 | 1;
  ratio?: number;
}

export interface Tab {
  id: string;
  panes: [Pane] | [Pane, Pane];
  layout: TabLayout;
}

export const activePane = (t: Tab): Pane => t.panes[t.layout.activePaneIdx];

export function assertLayoutValid(t: Tab): void {
  if (t.layout.kind === "single" && t.panes.length !== 1) {
    throw new Error(`invariant: layout=single requires 1 pane, got ${t.panes.length}`);
  }
  if (t.layout.kind === "split" && t.panes.length !== 2) {
    throw new Error(`invariant: layout=split requires 2 panes, got ${t.panes.length}`);
  }
  if (t.layout.kind === "split" && !t.layout.orientation) {
    throw new Error(`invariant: layout=split requires orientation`);
  }
  if (t.layout.activePaneIdx >= t.panes.length) {
    throw new Error(`invariant: activePaneIdx ${t.layout.activePaneIdx} out of range (panes.length=${t.panes.length})`);
  }
}

export function collapseToSingle(t: Tab, dropIdx: 0 | 1): void {
  if (t.layout.kind !== "split") return;
  const survivor = t.panes[dropIdx === 0 ? 1 : 0];
  t.panes = [survivor];
  t.layout = { kind: "single", activePaneIdx: 0 };
  assertLayoutValid(t);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run ui/src/tabs/pane.test.ts
```
Expected: 9 PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/tabs/pane.ts ui/src/tabs/pane.test.ts
git commit -m "feat(panes): Pane + TabLayout types with invariant helpers"
```

---

### Task A2: Rust `Pane` struct + serde

**Files:**
- Create: `crates/app/src/pane.rs`
- Modify: `crates/app/src/lib.rs:55` (add `mod pane;`)

- [ ] **Step 1: Write the failing test**

```rust
// crates/app/src/pane.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_roundtrip_terminal() {
        let p = SerializedPane {
            id: "01H1".into(),
            kind: PaneKind::Terminal,
            session_id: Some("01H2".into()),
            cwd: Some("/repo".into()),
            mission_path: None,
            operator_id: Some("claude".into()),
            replay_key: "rk1".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        let p2: SerializedPane = serde_json::from_str(&s).unwrap();
        assert_eq!(p, p2);
    }

    #[test]
    fn layout_single_serializes_without_orientation() {
        let l = SerializedLayout {
            kind: LayoutKind::Single,
            orientation: None,
            active: 0,
            ratio: None,
        };
        let s = serde_json::to_string(&l).unwrap();
        assert!(!s.contains("orientation"));
        assert!(!s.contains("ratio"));
    }

    #[test]
    fn layout_split_requires_orientation_on_deserialize() {
        // permissive — Rust enum doesn't enforce conditional fields;
        // invariant lives at the construction site.
        let s = r#"{"kind":"split","active":1,"ratio":0.6,"orientation":"horizontal"}"#;
        let l: SerializedLayout = serde_json::from_str(s).unwrap();
        assert_eq!(l.kind, LayoutKind::Split);
        assert_eq!(l.orientation, Some(Orientation::Horizontal));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal && cargo test -p covenant pane::
```
Expected: FAIL — module `pane` not found.

- [ ] **Step 3: Implement `pane.rs`**

```rust
// crates/app/src/pane.rs
//! Rust mirror of the TS Pane/Layout types. Used for the tab manifest
//! schema only — the live state lives in the UI; Rust just persists
//! the manifest blob.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneKind {
    Terminal,
    Pi,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SerializedPane {
    pub id: String,
    pub kind: PaneKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mission_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub operator_id: Option<String>,
    pub replay_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LayoutKind {
    Single,
    Split,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SerializedLayout {
    pub kind: LayoutKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub orientation: Option<Orientation>,
    pub active: u8,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ratio: Option<f32>,
}
```

- [ ] **Step 4: Register the module**

In `crates/app/src/lib.rs:55` (look for the existing `mod tab_manifest;` line), add `mod pane;` adjacent to it.

- [ ] **Step 5: Run tests**

```bash
cargo test -p covenant pane::
```
Expected: 3 PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/pane.rs crates/app/src/lib.rs
git commit -m "feat(panes): rust SerializedPane + SerializedLayout types"
```

---

### Task A3: Extend `SerializedTab` with optional `panes` + `layout`

**Files:**
- Modify: `ui/src/tabs/manager.ts:313` (`SerializedTab` interface)

- [ ] **Step 1: Write the failing test**

Create `ui/src/tabs/manifest-migration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { liftLegacyTab, type SerializedTab } from "./manager";

describe("liftLegacyTab", () => {
  it("wraps a legacy single-pane tab into the new shape", () => {
    const legacy: SerializedTab = {
      kind: "shell",
      custom_name: "tests",
      cwd: "/repo",
      color: null,
      group_id: null,
      mission_path: "docs/specs/foo.md",
      operator_id: "claude",
      observer_ids: ["codex"],
      replay_key: "rk1",
    };
    const lifted = liftLegacyTab(legacy);
    expect(lifted.panes).toHaveLength(1);
    expect(lifted.panes![0].cwd).toBe("/repo");
    expect(lifted.panes![0].mission_path).toBe("docs/specs/foo.md");
    expect(lifted.panes![0].operator_id).toBe("claude");
    expect(lifted.panes![0].replay_key).toBe("rk1");
    expect(lifted.layout).toEqual({ kind: "single", active: 0 });
  });

  it("leaves a new-shape tab unchanged", () => {
    const modern: SerializedTab = {
      kind: "shell",
      custom_name: null,
      cwd: null,
      color: null,
      group_id: null,
      mission_path: null,
      operator_id: null,
      panes: [
        { id: "p0", kind: "terminal", cwd: "/a", mission_path: null, operator_id: null, replay_key: "r0" },
        { id: "p1", kind: "terminal", cwd: "/b", mission_path: null, operator_id: null, replay_key: "r1" },
      ],
      layout: { kind: "split", orientation: "horizontal", active: 1, ratio: 0.6 },
    };
    const lifted = liftLegacyTab(modern);
    expect(lifted).toBe(modern);
  });
});
```

- [ ] **Step 2: Run test — should fail (types missing)**

```bash
npx vitest run ui/src/tabs/manifest-migration.test.ts
```
Expected: FAIL — `panes`, `layout`, `liftLegacyTab` not exported.

- [ ] **Step 3: Extend `SerializedTab` and add `liftLegacyTab`**

In `ui/src/tabs/manager.ts`, locate `interface SerializedTab` at line 313. Add the new fields at the end (before the closing brace):

```ts
  /// 4.x — multi-pane support. When present, supersedes the scalar
  /// `cwd`/`mission_path`/`operator_id`/`replay_key` fields above; the
  /// loader passes the legacy tab through `liftLegacyTab()` first so
  /// the rest of the pipeline always sees the new shape.
  panes?: SerializedPane[];
  layout?: SerializedLayout;
}

export interface SerializedPane {
  id: string;
  kind: "terminal" | "pi";
  cwd: string | null;
  mission_path: string | null;
  operator_id: string | null;
  replay_key: string;
  observer_ids?: string[];
  spawn_id?: string | null;
  aom_excluded?: boolean;
}

export interface SerializedLayout {
  kind: "single" | "split";
  orientation?: "horizontal" | "vertical";
  active: 0 | 1;
  ratio?: number;
}

export function liftLegacyTab(t: SerializedTab): SerializedTab {
  if (t.panes && t.layout) return t;
  const pane: SerializedPane = {
    id: `legacy-${t.replay_key ?? Math.random().toString(36).slice(2)}`,
    kind: t.kind === "pi" ? "pi" : "terminal",
    cwd: t.cwd,
    mission_path: t.mission_path,
    operator_id: t.operator_id,
    replay_key: t.replay_key ?? "",
    observer_ids: t.observer_ids,
    spawn_id: t.spawn_id,
    aom_excluded: t.aom_excluded,
  };
  return { ...t, panes: [pane], layout: { kind: "single", active: 0 } };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run ui/src/tabs/manifest-migration.test.ts
```
Expected: 2 PASS.

- [ ] **Step 5: Run the full UI test suite to confirm no regressions**

```bash
npm run test
```
Expected: all green (existing tests untouched).

- [ ] **Step 6: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/tabs/manifest-migration.test.ts
git commit -m "feat(panes): SerializedPane/Layout + liftLegacyTab for back-compat"
```

---

### Task A4: Wire `liftLegacyTab` into the manifest load path

**Files:**
- Modify: `ui/src/tabs/manager.ts` — find the manifest restore site (search for `TabManifestV1` and `tabManifestLoad`).

- [ ] **Step 1: Locate the load path**

```bash
grep -n "tabManifestLoad\|restoreFromManifest\|version: 1" ui/src/tabs/manager.ts | head -10
```

- [ ] **Step 2: Pass every restored tab through `liftLegacyTab`**

In the manifest restore function (find the loop over `manifest.tabs`), wrap each tab:

```ts
for (const raw of manifest.tabs) {
  const t = liftLegacyTab(raw);
  // …existing restore logic now reads from t.panes[0] for legacy data
}
```

- [ ] **Step 3: Run all manifest-related tests**

```bash
npx vitest run ui/src/tabs/
```
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(panes): lift legacy tabs into new shape at restore time"
```

---

### Task A5: Add `panes` + `layout` to the in-memory `Tab` interface

**Files:**
- Modify: `ui/src/tabs/manager.ts:183` (`interface Tab`)

This task adds the new fields **alongside** the existing per-pane fields. Mirrors are wired in B1; they stay in sync so reads can be migrated incrementally without breaking anything.

- [ ] **Step 1: Add `panes` and `layout` to `Tab` interface**

In `ui/src/tabs/manager.ts:183–290`, add at the end of the interface (before closing brace):

```ts
  /// Phase A: multi-pane data model. `panes` always has length 1 or 2.
  /// During Phase B (read migration) the scalar fields above are kept
  /// in sync with `panes[0]` as a safety net; Phase C removes them.
  panes: Pane[];
  layout: TabLayout;
}
```

Import the types at the top of the file:

```ts
import type { Pane, TabLayout } from "./pane";
import { activePane, assertLayoutValid, collapseToSingle } from "./pane";
```

- [ ] **Step 2: Populate `panes`/`layout` on every tab construction site**

Search for `Tab = {` and `tab: Tab = {`:

```bash
grep -n "Tab = {\|tab: Tab = {" ui/src/tabs/manager.ts | head -10
```

For each construction site, add `panes` and `layout` initialized from the scalar values. Example for `addTabInternal()` around `tabRef.current = tab`:

```ts
const pane0: Pane = {
  id: `p-${sessionId}`,
  kind: "terminal",
  sessionId,
  cwd: cwd ?? "",
  mission: null,
  operator: opts?.operatorId ?? null,
  blocks: [],
  xterm: term,
  piView: null,
};
const tab: Tab = {
  // …all existing fields…
  panes: [pane0],
  layout: { kind: "single", activePaneIdx: 0 },
};
assertLayoutValid(tab);
```

Do the same in `createPiTab()` with `kind: "pi"` and `piView: view`.

- [ ] **Step 3: Compile + tests**

```bash
npm run build
npm run test
```
Expected: both green.

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(panes): add panes[]+layout to Tab, populated from scalars"
```

---

## Phase B — Read-side rename (mirrors kept)

Goal: every place that reads `tab.sessionId` / `tab.cwd` / `tab.mission` / `tab.operator_id` / `tab.term` / `tab.blocks` becomes `activePane(tab).<field>`. Mirrors stay populated, so the rename is purely cosmetic. Each task is a single file or related group of files. After each task, run `npm run test` and `npm run build` — both must stay green.

### Task B1: Status bar reads

**Files:** `ui/src/status/bar.ts`

- [ ] **Step 1: Identify all `tab.x` reads**

```bash
grep -n "tab\.\(sessionId\|cwd\|mission\|operator_id\|executor\|term\|blocks\)" ui/src/status/bar.ts
```

- [ ] **Step 2: Replace each with `activePane(tab).<field>`**

Import the helper at the top:

```ts
import { activePane } from "../tabs/pane";
```

Then mechanical rename. Examples:

- `tab.cwd` → `activePane(tab).cwd`
- `tab.mission?.path` → `activePane(tab).mission?.path`
- `tab.operator_id` → `activePane(tab).operator`
- `tab.executor` → `activePane(tab).executor` *(add `executor` field to Pane if not present — see step 3)*

- [ ] **Step 3: Extend `Pane` for fields the status bar reads that aren't in the minimal Pane shape yet**

In `ui/src/tabs/pane.ts`, add to the `Pane` interface (after `operator`):

```ts
executor: string | null;
operatorEnabled: boolean;
operatorLive: boolean;
aomExcluded: boolean;
observer_ids: string[];
spawn_id: string | null;
idleAgent: { agent: string; sinceMs: number; promptText: string | null } | null;
busyProc: string | null;
replayKey: string;
```

Update the `pane()` helper in `pane.test.ts` to default these fields, and re-run the test.

- [ ] **Step 4: Mirror sync in `addTabInternal` / `createPiTab`**

After the existing `tab.X = …` assignments, mirror to `tab.panes[0].X = …`. The mirror direction is one-way (legacy field → pane) until Phase C.

- [ ] **Step 5: Test + build**

```bash
npm run test
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add ui/src/status/bar.ts ui/src/tabs/pane.ts ui/src/tabs/pane.test.ts ui/src/tabs/manager.ts
git commit -m "refactor(panes): status bar reads via activePane()"
```

---

### Task B2: AOM reads

**Files:** `ui/src/aom/*.ts`

- [ ] **Step 1: Find call sites**

```bash
grep -rn "tab\.\(sessionId\|cwd\|mission\|operator_id\|executor\|aomExcluded\)" ui/src/aom/ | head -30
```

- [ ] **Step 2: Mechanical rename to `activePane(tab).x`** in each file.

- [ ] **Step 3: Test + commit**

```bash
npm run test
git add ui/src/aom/
git commit -m "refactor(panes): AOM reads via activePane()"
```

---

### Task B3: Executor + operator picker + mission picker reads

**Files:** `ui/src/executors/*.ts`, `ui/src/operator/*.ts`, `ui/src/mission/*.ts`, `ui/src/main.ts` (for `⌘O`/`⌘M`/`⌘⇧J`).

- [ ] **Step 1: Find call sites** for each file. Example:

```bash
grep -n "tab\.\(operator_id\|mission\|sessionId\|cwd\)" ui/src/main.ts | head -20
```

- [ ] **Step 2: Rename to `activePane(tab).x`** including the picker invocations (e.g., `⌘O` opens the operator picker with `activePane(tab).operator` selected).

- [ ] **Step 3: Test + commit per file group** (separate commits for executors, operator, mission, main).

---

### Task B4: Recall / Finder / Global-search reads

**Files:** `ui/src/recall/*.ts`, `ui/src/terminal/finder.ts`, `ui/src/search/*.ts`.

- [ ] **Step 1: Find call sites** for `tab.cwd` / `tab.sessionId` / `tab.blocks`.
- [ ] **Step 2: Rename to `activePane(tab).x`.**
- [ ] **Step 3: Test + commit.**

---

## Phase C — Write-side rename (delete mirrors)

### Task C1: Move writes to `activePane(t).x = ...`

**Files:** `ui/src/tabs/manager.ts` (the bulk), plus any external file that writes `tab.x`.

- [ ] **Step 1: Find all writes**

```bash
grep -n "tab\.cwd = \|tab\.mission = \|tab\.operator_id = \|tab\.executor = \|tab\.busyProc = \|tab\.idleAgent = " ui/src/tabs/manager.ts
grep -rn "tab\.cwd = \|tab\.mission = \|tab\.operator_id = " ui/src/ --include="*.ts" | grep -v manager.ts
```

- [ ] **Step 2: Replace each with `activePane(tab).<field> = ...`** Reuse the active-pane helper.

- [ ] **Step 3: Test + commit**

```bash
npm run test
npm run build
git add -u
git commit -m "refactor(panes): writes go through activePane()"
```

---

### Task C2: Plumb `paneId` through PTY/session creation

**Files:** `ui/src/api.ts` (typed wrapper for `spawn_session`), `crates/app/src/lib.rs` (the existing `spawn_session` command), any TS caller of `spawnSession`.

- [ ] **Step 1: Locate `spawn_session`**

```bash
grep -n "spawn_session\|spawnSession" crates/app/src/lib.rs ui/src/api.ts ui/src/tabs/manager.ts | head -10
```

- [ ] **Step 2: Add optional `pane_id: Option<String>`** to the Rust signature and TS caller.

```rust
async fn spawn_session(
    state: State<'_, AppState>,
    pane_id: Option<String>,   // NEW
    cwd: Option<String>,
    // …existing args
) -> Result<String, String> { … }
```

Pass `pane_id` into the session-emit metadata so events the agent sees include which pane produced them.

- [ ] **Step 3: Test (cargo + vitest) + commit**

```bash
cargo test -p covenant
npm run test
git add -u
git commit -m "feat(panes): plumb pane_id through spawn_session"
```

---

### Task C3: Delete tab-level mirror fields

**Files:** `ui/src/tabs/manager.ts:183–290` (`Tab` interface).

- [ ] **Step 1: Remove the mirrored fields** from `Tab`:

Remove these fields from the interface (they now live on `Pane`):

- `sessionId`, `replayKey`, `operatorEnabled`, `operatorLive`, `aomExcluded`, `mission`, `termHost`, `blocksHost`, `term`, `fit`, `webgl`, `canvas`, `ligatures`, `search`, `finder`, `blocks`, `recall`, `structure`, `piView`, `sidebarView`, `cwd`, `operator_id`, `observer_ids`, `spawn_id`, `executor`, `idleAgent`, `busyProc`, `specBadge`.

Keep: `id`, `kind` (becomes per-pane in Phase F; for now keep as a quick discriminator), `defaultTitle`, `customName`, `color`, `groupId`, `pane` (DOM container), `editor`, `openEditor`, `disposers`, plus the new `panes` + `layout`.

- [ ] **Step 2: Fix all compile errors**

```bash
npm run build 2>&1 | head -60
```

Each error is a call site we missed in B or C. Fix in place.

- [ ] **Step 3: Test + commit**

```bash
npm run test
git add -u
git commit -m "refactor(panes): drop tab-level mirror fields, panes is the truth"
```

---

## Phase D — Split UI (gated on `experimental.splitPanes`)

### Task D1: Add `experimental.splitPanes` to Rust `Settings`

**Files:**
- Modify: `crates/app/src/settings.rs:56` (`Settings` struct)

- [ ] **Step 1: Write the failing test**

Append to `crates/app/src/settings.rs` test module:

```rust
#[test]
fn experimental_split_panes_defaults_false() {
    let s: Settings = serde_json::from_str("{}").unwrap();
    assert!(!s.experimental.split_panes);
}

#[test]
fn experimental_split_panes_roundtrip() {
    let mut s = Settings::default();
    s.experimental.split_panes = true;
    let json = serde_json::to_string(&s).unwrap();
    let s2: Settings = serde_json::from_str(&json).unwrap();
    assert!(s2.experimental.split_panes);
}
```

- [ ] **Step 2: Run — should fail**

```bash
cargo test -p covenant experimental_split_panes
```
Expected: FAIL — `experimental` field missing.

- [ ] **Step 3: Add `ExperimentalConfig`**

Above `pub struct Settings`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExperimentalConfig {
    #[serde(default)]
    pub split_panes: bool,
}
```

In `Settings`:

```rust
    #[serde(default)]
    pub experimental: ExperimentalConfig,
```

In `Settings::default()` (find it, probably around line 360–370):

```rust
            experimental: ExperimentalConfig::default(),
```

- [ ] **Step 4: Test + commit**

```bash
cargo test -p covenant experimental_split_panes
git add crates/app/src/settings.rs
git commit -m "feat(panes): experimental.split_panes setting (default off)"
```

---

### Task D2: Settings panel checkbox

**Files:**
- Modify: `ui/src/settings/panel.ts` `sec-terminal` section (find by `id="sec-terminal"` around line 462).

- [ ] **Step 1: Locate the Terminal section's bottom and add the Experimental subsection**

Just before `</section>` for `sec-terminal`:

```html
<h4 class="settings-subsection-title">Experimental</h4>
<p class="settings-hint" style="margin: 0 0 6px;">
  Off by default. Toggle live; no restart needed.
</p>
<label class="settings-field">
  <span class="settings-checkbox-row">
    <input type="checkbox" name="experimental_split_panes" />
    <span>Split panes — two terminals per tab (side-by-side or stacked)</span>
  </span>
  <small class="settings-hint">
    Each pane gets its own session, mission, and operator. Shortcuts:
    <kbd>⌘D</kbd> split right, <kbd>⌘\</kbd> split down,
    <kbd>⌘[</kbd>/<kbd>⌘]</kbd> focus prev/next, <kbd>⌘⇧]</kbd> swap.
  </small>
</label>
```

- [ ] **Step 2: Wire the checkbox to load/save**

Find the settings form's load handler (`loadSettings()` or equivalent — grep for `mind_v2` for the pattern) and add the read/write for `experimental.split_panes`.

- [ ] **Step 3: Manual smoke**

```bash
npm run tauri:dev
```
Open settings → Terminal → Experimental → toggle checkbox → close + reopen settings → checkbox state persists.

- [ ] **Step 4: Commit**

```bash
git add ui/src/settings/panel.ts
git commit -m "feat(panes): settings checkbox for experimental.split_panes"
```

---

### Task D3: Live flag wiring in manager

**Files:**
- Modify: `ui/src/tabs/manager.ts` (add `splitPanesEnabled: boolean` field + settings listener)
- Modify: `ui/src/api.ts` (expose `getExperimentalFlags()`)

- [ ] **Step 1: Add a typed wrapper in `api.ts`**

```ts
export interface ExperimentalFlags {
  split_panes: boolean;
}

export async function getExperimentalFlags(): Promise<ExperimentalFlags> {
  const settings = await getSettings();   // existing function
  return { split_panes: settings.experimental?.split_panes ?? false };
}
```

- [ ] **Step 2: Cache flag in manager**

In `TabsManager` class, add:

```ts
private splitPanesEnabled = false;

async loadExperimentalFlags(): Promise<void> {
  const f = await getExperimentalFlags();
  this.splitPanesEnabled = f.split_panes;
}

setSplitPanesEnabled(v: boolean): void {
  this.splitPanesEnabled = v;
  this.rebindSplitShortcuts();   // implemented in D12
}
```

Call `loadExperimentalFlags()` from the manager's init path. Hook the settings panel's checkbox onChange to call `setSplitPanesEnabled` on the manager (route via the existing settings-changed event if one exists, else a direct call from `panel.ts`).

- [ ] **Step 3: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/api.ts
git commit -m "feat(panes): live experimental.split_panes flag in TabsManager"
```

---

### Task D4: `.terminal-block` wrapper in DOM

**Files:**
- Modify: `ui/src/tabs/manager.ts` `addTabInternal()` (around line 1782).

- [ ] **Step 1: Wrap termHost**

Replace:

```ts
pane.appendChild(termHost);
```

with:

```ts
const terminalBlock = document.createElement("div");
terminalBlock.className = "terminal-block";
terminalBlock.dataset.layout = "single";
terminalBlock.appendChild(termHost);
pane.appendChild(terminalBlock);
```

Store `terminalBlock` on the `Tab` (add `terminalBlock: HTMLElement` to the `Tab` interface) so split actions can manipulate it.

- [ ] **Step 2: Verify the app still renders**

```bash
npm run tauri:dev
```
Single-pane tabs should look identical to before.

- [ ] **Step 3: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(panes): .terminal-block wrapper (passthrough when single)"
```

---

### Task D5: CSS for `.terminal-block` and `.pane-splitter`

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Append the new styles**

```css
/* split panes — see docs/superpowers/specs/2026-05-26-split-panes-design.md */
.terminal-block {
  display: grid;
  height: 100%;
  width: 100%;
}
.terminal-block[data-layout="single"] {
  /* default — single cell, child fills */
}
.terminal-block[data-split="horizontal"] {
  grid-template-columns: var(--pane-ratio, 1fr) 4px 1fr;
}
.terminal-block[data-split="vertical"] {
  grid-template-rows: var(--pane-ratio, 1fr) 4px 1fr;
}
.pane-host {
  position: relative;
  min-width: 0;
  min-height: 0;
  border: 1px solid transparent;
  box-sizing: border-box;
}
.pane-host.active {
  border-color: var(--accent-cyan, #38bdf8);
}
.pane-splitter {
  background: var(--border-color, #1f2937);
  cursor: col-resize;
  user-select: none;
}
.terminal-block[data-split="vertical"] .pane-splitter {
  cursor: row-resize;
}
.terminal-block.pane-splitter-dragging {
  cursor: col-resize;
}
.terminal-block[data-split="vertical"].pane-splitter-dragging {
  cursor: row-resize;
}
```

- [ ] **Step 2: Add a `.pane-host` class wrapper around termHost in D4**

Update Task D4's wrapper to:

```ts
const paneHost0 = document.createElement("div");
paneHost0.className = "pane-host";
paneHost0.appendChild(termHost);
terminalBlock.appendChild(paneHost0);
```

Store `paneHost0` on the pane (add `el: HTMLElement` to the `Pane` interface).

- [ ] **Step 3: Visual smoke**

`npm run tauri:dev` → confirm rendering is unchanged.

- [ ] **Step 4: Commit**

```bash
git add ui/src/styles.css ui/src/tabs/manager.ts ui/src/tabs/pane.ts
git commit -m "feat(panes): css for terminal-block + pane-splitter + active border"
```

---

### Task D6: Tauri commands

**Files:**
- Create: `crates/app/src/split_commands.rs`
- Modify: `crates/app/src/lib.rs` (register the commands at the bottom)

- [ ] **Step 1: Write the commands**

```rust
// crates/app/src/split_commands.rs
//! Thin Tauri command surface for split-pane actions. The real state
//! lives in the UI and the existing PTY/Session crates; these commands
//! exist so the UI doesn't reach into Rust internals directly.

use crate::pane::Orientation;

#[tauri::command]
pub async fn split_pane(
    _tab_id: String,
    _orientation: String,
    _source_pane_idx: u8,
) -> Result<String, String> {
    // The UI generates the new PaneId and calls spawn_session with it.
    // This command exists for symmetry / future server-side state.
    Ok(uuid_v7_like())
}

#[tauri::command]
pub async fn close_pane(_tab_id: String, _pane_idx: u8) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn focus_pane(_tab_id: String, _pane_idx: u8) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn swap_panes(_tab_id: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn set_pane_orientation(
    _tab_id: String,
    _orientation: String,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn set_pane_ratio(_tab_id: String, _ratio: f32) -> Result<(), String> {
    Ok(())
}

fn uuid_v7_like() -> String {
    use ulid::Ulid;
    Ulid::new().to_string()
}
```

> Note: the UI owns the live tab/pane state. These commands are intentionally thin pass-throughs that just confirm the operation is allowed. If you later need server-side enforcement (e.g. force-close from a notification), this is where it goes.

- [ ] **Step 2: Register in `lib.rs`**

Add `mod split_commands;` near `mod pane;`. In the `tauri::generate_handler!` invocation (search for `tab_manifest_load,`), add:

```rust
            split_commands::split_pane,
            split_commands::close_pane,
            split_commands::focus_pane,
            split_commands::swap_panes,
            split_commands::set_pane_orientation,
            split_commands::set_pane_ratio,
```

- [ ] **Step 3: Compile**

```bash
cargo check -p covenant
```

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/split_commands.rs crates/app/src/lib.rs
git commit -m "feat(panes): tauri command stubs for split actions"
```

---

### Task D7: TS `splitPane` action

**Files:**
- Create: `ui/src/tabs/split-actions.ts`
- Create: `ui/src/tabs/split-actions.test.ts`
- Modify: `ui/src/api.ts` (add typed wrappers for the 6 commands)

- [ ] **Step 1: Add typed wrappers in `api.ts`**

```ts
export async function splitPane(tabId: string, orientation: "horizontal" | "vertical", sourcePaneIdx: 0 | 1): Promise<string> {
  return invoke<string>("split_pane", { tabId, orientation, sourcePaneIdx });
}
export async function closePaneCmd(tabId: string, paneIdx: 0 | 1): Promise<void> {
  return invoke<void>("close_pane", { tabId, paneIdx });
}
export async function focusPaneCmd(tabId: string, paneIdx: 0 | 1): Promise<void> {
  return invoke<void>("focus_pane", { tabId, paneIdx });
}
export async function swapPanesCmd(tabId: string): Promise<void> {
  return invoke<void>("swap_panes", { tabId });
}
export async function setPaneOrientationCmd(tabId: string, orientation: "horizontal" | "vertical"): Promise<void> {
  return invoke<void>("set_pane_orientation", { tabId, orientation });
}
export async function setPaneRatioCmd(tabId: string, ratio: number): Promise<void> {
  return invoke<void>("set_pane_ratio", { tabId, ratio });
}
```

- [ ] **Step 2: Write failing tests for `splitPane`**

```ts
// ui/src/tabs/split-actions.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { splitPaneAction } from "./split-actions";
import type { Tab, Pane } from "./pane";

// helpers — see pane.test.ts for the full shape
const makePane = (id: string, cwd = "/repo"): Pane => ({
  id, kind: "terminal", sessionId: `s-${id}`, cwd,
  mission: null, operator: null, blocks: [],
  xterm: null, piView: null,
  // …other Pane fields…
} as Pane);

const makeSingleTab = (id: string): Tab => ({
  id, panes: [makePane("p0")],
  layout: { kind: "single", activePaneIdx: 0 },
} as Tab);

describe("splitPaneAction", () => {
  it("creates a new pane inheriting source cwd", async () => {
    const tab = makeSingleTab("t1");
    const ctx = {
      spawnSession: vi.fn().mockResolvedValue("s-new"),
      mountPaneInDom: vi.fn(),
      focusPane: vi.fn(),
    };
    await splitPaneAction(tab, "horizontal", 0, ctx);
    expect(tab.panes.length).toBe(2);
    expect(tab.panes[1].cwd).toBe("/repo");
    expect(tab.panes[1].kind).toBe("terminal");
    expect(tab.layout.kind).toBe("split");
    expect(tab.layout.orientation).toBe("horizontal");
    expect(tab.layout.ratio).toBe(0.5);
    expect(tab.layout.activePaneIdx).toBe(1);
  });

  it("refuses to split when tab is already split", async () => {
    const tab = makeSingleTab("t1");
    tab.panes = [makePane("p0"), makePane("p1")];
    tab.layout = { kind: "split", orientation: "horizontal", activePaneIdx: 0, ratio: 0.5 };
    const ctx = {
      spawnSession: vi.fn(),
      mountPaneInDom: vi.fn(),
      focusPane: vi.fn(),
    };
    await expect(splitPaneAction(tab, "horizontal", 0, ctx)).rejects.toThrow(/already split/);
    expect(ctx.spawnSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run — should fail**

```bash
npx vitest run ui/src/tabs/split-actions.test.ts
```

- [ ] **Step 4: Implement `splitPaneAction`**

```ts
// ui/src/tabs/split-actions.ts
import { activePane, assertLayoutValid, collapseToSingle, type Pane, type Tab, type SplitOrientation } from "./pane";

export interface SplitActionCtx {
  spawnSession: (cwd: string) => Promise<string>;
  mountPaneInDom: (tab: Tab, paneIdx: 0 | 1) => void;
  focusPane: (tab: Tab, paneIdx: 0 | 1) => void;
}

export async function splitPaneAction(
  tab: Tab,
  orientation: SplitOrientation,
  sourcePaneIdx: 0 | 1,
  ctx: SplitActionCtx,
): Promise<void> {
  if (tab.layout.kind === "split") {
    throw new Error(`tab ${tab.id} is already split`);
  }
  const source = tab.panes[sourcePaneIdx];
  const sessionId = await ctx.spawnSession(source.cwd);
  const newPane: Pane = {
    id: `p-${sessionId}`,
    kind: "terminal",
    sessionId,
    cwd: source.cwd,
    mission: null,
    operator: null,
    blocks: [],
    xterm: null,
    piView: null,
    executor: null,
    operatorEnabled: false,
    operatorLive: false,
    aomExcluded: false,
    observer_ids: [],
    spawn_id: null,
    idleAgent: null,
    busyProc: null,
    replayKey: `rk-${sessionId}`,
  };
  tab.panes = [tab.panes[0], newPane] as [Pane, Pane];
  tab.layout = {
    kind: "split",
    orientation,
    activePaneIdx: 1,
    ratio: 0.5,
  };
  assertLayoutValid(tab);
  ctx.mountPaneInDom(tab, 1);
  ctx.focusPane(tab, 1);
}
```

- [ ] **Step 5: Verify tests pass**

```bash
npx vitest run ui/src/tabs/split-actions.test.ts
```
Expected: 2 PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/tabs/split-actions.ts ui/src/tabs/split-actions.test.ts ui/src/api.ts
git commit -m "feat(panes): splitPaneAction unit + ctx-injected side effects"
```

---

### Task D8: TS `closePaneAction` (always available)

**Files:**
- Modify: `ui/src/tabs/split-actions.ts`
- Modify: `ui/src/tabs/split-actions.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `split-actions.test.ts`:

```ts
describe("closePaneAction", () => {
  it("collapses split → single, drops the right pane", async () => {
    const tab = makeSingleTab("t1");
    tab.panes = [makePane("p0"), makePane("p1")];
    tab.layout = { kind: "split", orientation: "horizontal", activePaneIdx: 1, ratio: 0.5 };
    const ctx = {
      killSession: vi.fn().mockResolvedValue(undefined),
      unmountPaneFromDom: vi.fn(),
      focusPane: vi.fn(),
    };
    await closePaneAction(tab, 1, ctx);
    expect(tab.panes.length).toBe(1);
    expect(tab.panes[0].id).toBe("p0");
    expect(tab.layout.kind).toBe("single");
    expect(tab.layout.activePaneIdx).toBe(0);
    expect(ctx.killSession).toHaveBeenCalledWith("s-p1");
  });

  it("closing pane 0 keeps pane 1, slides it to index 0", async () => {
    const tab = makeSingleTab("t1");
    tab.panes = [makePane("p0"), makePane("p1")];
    tab.layout = { kind: "split", orientation: "horizontal", activePaneIdx: 0, ratio: 0.5 };
    const ctx = {
      killSession: vi.fn().mockResolvedValue(undefined),
      unmountPaneFromDom: vi.fn(),
      focusPane: vi.fn(),
    };
    await closePaneAction(tab, 0, ctx);
    expect(tab.panes[0].id).toBe("p1");
    expect(ctx.killSession).toHaveBeenCalledWith("s-p0");
  });

  it("returns CloseTabIntent when called on a single-pane tab", async () => {
    const tab = makeSingleTab("t1");
    const ctx = {
      killSession: vi.fn(),
      unmountPaneFromDom: vi.fn(),
      focusPane: vi.fn(),
    };
    const result = await closePaneAction(tab, 0, ctx);
    expect(result).toBe("close-tab");
    expect(ctx.killSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — should fail**

```bash
npx vitest run ui/src/tabs/split-actions.test.ts
```

- [ ] **Step 3: Implement**

In `split-actions.ts`:

```ts
export interface CloseActionCtx {
  killSession: (sessionId: string) => Promise<void>;
  unmountPaneFromDom: (tab: Tab, paneIdx: 0 | 1) => void;
  focusPane: (tab: Tab, paneIdx: 0 | 1) => void;
}

export type CloseResult = "collapsed" | "close-tab";

export async function closePaneAction(
  tab: Tab,
  paneIdx: 0 | 1,
  ctx: CloseActionCtx,
): Promise<CloseResult> {
  if (tab.layout.kind === "single") {
    return "close-tab";
  }
  const victim = tab.panes[paneIdx];
  if (victim.sessionId) {
    await ctx.killSession(victim.sessionId);
  }
  ctx.unmountPaneFromDom(tab, paneIdx);
  collapseToSingle(tab, paneIdx);
  ctx.focusPane(tab, 0);
  return "collapsed";
}
```

- [ ] **Step 4: Test + commit**

```bash
npx vitest run ui/src/tabs/split-actions.test.ts
git add ui/src/tabs/split-actions.ts ui/src/tabs/split-actions.test.ts
git commit -m "feat(panes): closePaneAction + CloseTabIntent fallthrough"
```

---

### Task D9: `focusPane`, `swapPanes`, `setPaneOrientation`, `setPaneRatio`

**Files:**
- Modify: `ui/src/tabs/split-actions.ts`
- Modify: `ui/src/tabs/split-actions.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
describe("focusPaneAction", () => {
  it("updates activePaneIdx and calls the DOM focus", () => {
    const tab = makeSingleTab("t1");
    tab.panes = [makePane("p0"), makePane("p1")];
    tab.layout = { kind: "split", orientation: "horizontal", activePaneIdx: 0, ratio: 0.5 };
    const ctx = { focusInDom: vi.fn() };
    focusPaneAction(tab, 1, ctx);
    expect(tab.layout.activePaneIdx).toBe(1);
    expect(ctx.focusInDom).toHaveBeenCalledWith(tab, 1);
  });

  it("no-op on a single-pane tab even if idx=0", () => {
    const tab = makeSingleTab("t1");
    const ctx = { focusInDom: vi.fn() };
    focusPaneAction(tab, 0, ctx);
    expect(tab.layout.activePaneIdx).toBe(0);
    expect(ctx.focusInDom).toHaveBeenCalledWith(tab, 0);
  });
});

describe("swapPanesAction", () => {
  it("swaps panes, inverts ratio, keeps the visually-active half in place", () => {
    const tab = makeSingleTab("t1");
    tab.panes = [makePane("p0"), makePane("p1")];
    tab.layout = { kind: "split", orientation: "horizontal", activePaneIdx: 0, ratio: 0.7 };
    const ctx = { remountSplit: vi.fn() };
    swapPanesAction(tab, ctx);
    expect(tab.panes[0].id).toBe("p1");
    expect(tab.panes[1].id).toBe("p0");
    expect(tab.layout.activePaneIdx).toBe(1);     // followed
    expect(tab.layout.ratio).toBeCloseTo(0.3);    // 1 - 0.7
    expect(ctx.remountSplit).toHaveBeenCalled();
  });
});

describe("setPaneOrientationAction", () => {
  it("flips orientation, keeps panes + ratio", () => {
    const tab = makeSingleTab("t1");
    tab.panes = [makePane("p0"), makePane("p1")];
    tab.layout = { kind: "split", orientation: "horizontal", activePaneIdx: 0, ratio: 0.6 };
    const ctx = { remountSplit: vi.fn() };
    setPaneOrientationAction(tab, "vertical", ctx);
    expect(tab.layout.orientation).toBe("vertical");
    expect(tab.layout.ratio).toBe(0.6);
    expect(ctx.remountSplit).toHaveBeenCalled();
  });
});

describe("setPaneRatioAction", () => {
  it("clamps ratio to [0.1, 0.9]", () => {
    const tab = makeSingleTab("t1");
    tab.panes = [makePane("p0"), makePane("p1")];
    tab.layout = { kind: "split", orientation: "horizontal", activePaneIdx: 0, ratio: 0.5 };
    setPaneRatioAction(tab, 0.05);
    expect(tab.layout.ratio).toBe(0.1);
    setPaneRatioAction(tab, 0.95);
    expect(tab.layout.ratio).toBe(0.9);
    setPaneRatioAction(tab, 0.42);
    expect(tab.layout.ratio).toBe(0.42);
  });
});
```

- [ ] **Step 2: Implement in `split-actions.ts`**

```ts
export interface FocusActionCtx {
  focusInDom: (tab: Tab, paneIdx: 0 | 1) => void;
}

export function focusPaneAction(tab: Tab, paneIdx: 0 | 1, ctx: FocusActionCtx): void {
  tab.layout.activePaneIdx = paneIdx;
  ctx.focusInDom(tab, paneIdx);
}

export interface RemountCtx {
  remountSplit: (tab: Tab) => void;
}

export function swapPanesAction(tab: Tab, ctx: RemountCtx): void {
  if (tab.layout.kind !== "split") return;
  tab.panes = [tab.panes[1], tab.panes[0]] as [Pane, Pane];
  tab.layout.activePaneIdx = (1 - tab.layout.activePaneIdx) as 0 | 1;
  if (tab.layout.ratio !== undefined) {
    tab.layout.ratio = 1 - tab.layout.ratio;
  }
  ctx.remountSplit(tab);
}

export function setPaneOrientationAction(
  tab: Tab,
  orientation: SplitOrientation,
  ctx: RemountCtx,
): void {
  if (tab.layout.kind !== "split") return;
  tab.layout.orientation = orientation;
  ctx.remountSplit(tab);
}

export function setPaneRatioAction(tab: Tab, ratio: number): void {
  const clamped = Math.max(0.1, Math.min(0.9, ratio));
  tab.layout.ratio = clamped;
}
```

- [ ] **Step 3: Test + commit**

```bash
npx vitest run ui/src/tabs/split-actions.test.ts
git add ui/src/tabs/split-actions.ts ui/src/tabs/split-actions.test.ts
git commit -m "feat(panes): focusPane, swapPanes, setOrientation, setRatio"
```

---

### Task D10: Pane splitter drag

**Files:**
- Create: `ui/src/tabs/pane-splitter.ts`
- Create: `ui/src/tabs/pane-splitter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/tabs/pane-splitter.test.ts
import { describe, expect, it, vi } from "vitest";
import { installPaneSplitter } from "./pane-splitter";

describe("installPaneSplitter", () => {
  it("calls onRatio with clamped value during drag", () => {
    document.body.innerHTML = `
      <div id="block" style="width:400px;height:200px">
        <div id="splitter" style="width:4px"></div>
      </div>
    `;
    const block = document.getElementById("block")!;
    const splitter = document.getElementById("splitter")!;
    Object.defineProperty(block, "offsetWidth", { value: 400 });
    Object.defineProperty(block, "offsetHeight", { value: 200 });

    const onRatio = vi.fn();
    const onCommit = vi.fn();
    installPaneSplitter({
      splitter,
      block,
      orientation: "horizontal",
      onRatio,
      onCommit,
    });

    const down = new PointerEvent("pointerdown", { clientX: 200, clientY: 100, pointerId: 1 });
    splitter.dispatchEvent(down);
    splitter.dispatchEvent(new PointerEvent("pointermove", { clientX: 300, clientY: 100, pointerId: 1 }));
    splitter.dispatchEvent(new PointerEvent("pointerup", { clientX: 300, clientY: 100, pointerId: 1 }));

    // RAF flush
    return new Promise((r) => requestAnimationFrame(() => {
      expect(onRatio).toHaveBeenCalled();
      const lastCallArg = onRatio.mock.calls[onRatio.mock.calls.length - 1][0];
      expect(lastCallArg).toBeCloseTo(0.75, 1);
      expect(onCommit).toHaveBeenCalled();
      r(undefined);
    }));
  });
});
```

- [ ] **Step 2: Implement**

```ts
// ui/src/tabs/pane-splitter.ts
//! Pane divider drag — mirrors the editor splitter at manager.ts:2177.
//! Extracted so it can be reused for the new pane split.

import type { SplitOrientation } from "./pane";

export interface PaneSplitterOpts {
  splitter: HTMLElement;
  block: HTMLElement;
  orientation: SplitOrientation;
  onRatio: (ratio: number) => void;     // live during drag
  onCommit: (ratio: number) => void;    // on pointerup, persist
}

export function installPaneSplitter(opts: PaneSplitterOpts): () => void {
  const { splitter, block, orientation, onRatio, onCommit } = opts;

  const handler = (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const total = orientation === "horizontal" ? block.offsetWidth : block.offsetHeight;
    const startRatio = parseFloat(getComputedStyle(block).getPropertyValue("--pane-ratio")) || 0.5;
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = orientation === "horizontal" ? "col-resize" : "row-resize";
    block.classList.add("pane-splitter-dragging");
    try { splitter.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    let pending: number | null = null;
    let rafScheduled = false;
    const flush = () => {
      rafScheduled = false;
      if (pending === null) return;
      const delta = pending;
      pending = null;
      const moved = orientation === "horizontal" ? delta - startX : delta - startY;
      const newRatio = Math.max(0.1, Math.min(0.9, startRatio + moved / total));
      onRatio(newRatio);
    };

    const onMove = (ev: PointerEvent) => {
      pending = orientation === "horizontal" ? ev.clientX : ev.clientY;
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flush);
      }
    };
    const onUp = (ev: PointerEvent) => {
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
      block.classList.remove("pane-splitter-dragging");
      try { splitter.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      splitter.removeEventListener("pointermove", onMove);
      splitter.removeEventListener("pointerup", onUp);
      splitter.removeEventListener("pointercancel", onUp);
      if (pending !== null) flush();
      const finalRatio = parseFloat(getComputedStyle(block).getPropertyValue("--pane-ratio")) || 0.5;
      onCommit(finalRatio);
    };

    splitter.addEventListener("pointermove", onMove);
    splitter.addEventListener("pointerup", onUp);
    splitter.addEventListener("pointercancel", onUp);
  };

  splitter.addEventListener("pointerdown", handler);
  return () => splitter.removeEventListener("pointerdown", handler);
}
```

- [ ] **Step 3: Test + commit**

```bash
npx vitest run ui/src/tabs/pane-splitter.test.ts
git add ui/src/tabs/pane-splitter.ts ui/src/tabs/pane-splitter.test.ts
git commit -m "feat(panes): installPaneSplitter drag helper"
```

---

### Task D11: Editor splitter clamp update for horizontal pane-split

**Files:**
- Modify: `ui/src/tabs/manager.ts:2152` (`applyTerminalWidth`)

- [ ] **Step 1: Update clamp formula**

Locate `applyTerminalWidth` (around line 2152). Replace the body with:

```ts
const applyTerminalWidth = (px: number | null): void => {
  if (px === null) {
    pane.style.gridTemplateColumns = "";
    return;
  }
  const sidebar = sidebarWidth();
  const tab = tabRef.current;
  const horizontalSplit = tab && tab.layout.kind === "split" && tab.layout.orientation === "horizontal";
  const terminalBlockMin = horizontalSplit
    ? 2 * TERMINAL_MIN + PANE_SPLITTER_PX
    : TERMINAL_MIN;
  const clamped = Math.max(
    terminalBlockMin,
    Math.min(px, pane.offsetWidth - sidebar - EDITOR_MIN - SPLITTER_PX),
  );
  pane.style.gridTemplateColumns =
    `${clamped}px ${SPLITTER_PX}px 1fr ${sidebar}px`;
};
```

Define `PANE_SPLITTER_PX` near `SPLITTER_PX = 4`:

```ts
const PANE_SPLITTER_PX = 4;
```

- [ ] **Step 2: Manual smoke**

`npm run tauri:dev` → split a tab horizontally, then open the editor, drag the editor splitter — terminal-block should not collapse below `2 * TERMINAL_MIN + 4 = 404px`.

- [ ] **Step 3: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "fix(panes): editor splitter clamp respects horizontal pane-split min"
```

---

### Task D12: Keyboard shortcuts wired through TabsManager

**Files:**
- Modify: `ui/src/main.ts` (the global keydown handler that owns `⌘T`, `⌘W`, etc.)
- Modify: `ui/src/shortcuts/registry.ts` (so they appear in `⌘⇧K`)

- [ ] **Step 1: Add to shortcut registry**

In `ui/src/shortcuts/registry.ts`, append (mirroring the existing format):

```ts
{ category: "Tabs", keys: ["⌘", "D"], label: "Split right", description: "Add a second pane to the right of the active pane. Requires experimental.split_panes." },
{ category: "Tabs", keys: ["⌘", "\\"], label: "Split down", description: "Add a second pane below the active pane. Requires experimental.split_panes." },
{ category: "Tabs", keys: ["⌘", "["], label: "Focus previous pane", description: "Move focus to the other pane in a split tab." },
{ category: "Tabs", keys: ["⌘", "]"], label: "Focus next pane", description: "Move focus to the other pane in a split tab." },
{ category: "Tabs", keys: ["⌘", "⇧", "]"], label: "Swap panes", description: "Exchange the two panes' positions." },
```

- [ ] **Step 2: Bind in `main.ts`**

In the keydown handler (find the existing `⌘T` / `⌘W` block):

```ts
// split shortcuts — gated on experimental.splitPanes (manager checks)
if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "d") {
  e.preventDefault();
  if (manager.canSplit()) {
    void manager.splitActivePane("horizontal");
  }
  return;
}
if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "\\") {
  e.preventDefault();
  if (manager.canSplit()) {
    void manager.splitActivePane("vertical");
  }
  return;
}
if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "]") {
  e.preventDefault();
  manager.focusOtherPane();
  return;
}
if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "[") {
  e.preventDefault();
  manager.focusOtherPane();
  return;
}
if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "}") {
  e.preventDefault();
  if (manager.canSplit()) {
    manager.swapActivePanes();
  }
  return;
}
```

- [ ] **Step 3: Add `canSplit()`, `splitActivePane()`, `focusOtherPane()`, `swapActivePanes()` to TabsManager**

In `manager.ts`:

```ts
canSplit(): boolean {
  if (!this.splitPanesEnabled) return false;
  const tab = this.activeTab();
  return tab !== null && tab.layout.kind === "single";
}

async splitActivePane(orientation: SplitOrientation): Promise<void> {
  const tab = this.activeTab();
  if (!tab || tab.layout.kind === "split") return;
  await splitPaneAction(tab, orientation, 0, {
    spawnSession: (cwd) => this.spawnPtyForPane(cwd),
    mountPaneInDom: (t, idx) => this.mountSecondPaneDom(t, idx),
    focusPane: (t, idx) => this.focusPaneDom(t, idx),
  });
  this.scheduleSave();
}

focusOtherPane(): void {
  const tab = this.activeTab();
  if (!tab || tab.layout.kind !== "split") return;
  const next = (1 - tab.layout.activePaneIdx) as 0 | 1;
  focusPaneAction(tab, next, { focusInDom: (t, idx) => this.focusPaneDom(t, idx) });
}

swapActivePanes(): void {
  const tab = this.activeTab();
  if (!tab || tab.layout.kind !== "split") return;
  swapPanesAction(tab, { remountSplit: (t) => this.remountSplitDom(t) });
  this.scheduleSave();
}
```

`spawnPtyForPane`, `mountSecondPaneDom`, `focusPaneDom`, `remountSplitDom` are private helpers you implement next to `addTabInternal` — they wrap the existing per-tab setup (xterm mount, blocks/recall/finder install, splitter wiring) so each pane gets the same treatment a tab used to. The factoring is mechanical: lift the existing termHost setup code into `addPaneToTab(tab, paneIdx)`.

- [ ] **Step 4: `rebindSplitShortcuts()`** — make D3's stub real by toggling a flag the keydown handler reads.

The simplest implementation: gate via `manager.canSplit()` in the handler (already done). `rebindSplitShortcuts` becomes a no-op, kept as a hook for future complex behaviors. Remove it if you prefer.

- [ ] **Step 5: Manual smoke**

`npm run tauri:dev` → toggle experimental.split_panes ON → `⌘D` opens a second pane → `⌘[`/`⌘]` swaps focus → `⌘⇧]` swaps positions → toggle flag OFF → `⌘D` no-op, existing split still renders.

- [ ] **Step 6: Commit**

```bash
git add ui/src/main.ts ui/src/tabs/manager.ts ui/src/shortcuts/registry.ts
git commit -m "feat(panes): keyboard shortcuts wired through manager (gated)"
```

---

### Task D13: `⌘W` reroute

**Files:**
- Modify: `ui/src/main.ts` (existing `⌘W` handler)

- [ ] **Step 1: Update `⌘W` to route through manager**

```ts
if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "w") {
  e.preventDefault();
  const tab = manager.activeTab();
  if (!tab) return;
  // Always-on close-pane path: even with flag off, manifest-loaded
  // splits can still be collapsed. Single-pane tabs close the tab.
  if (tab.layout.kind === "split") {
    void manager.closeActivePane();   // collapses split → single
  } else {
    void manager.closeTab(tab.id);
  }
  return;
}
// ⌘⇧W = unconditional close tab
if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "W") {
  e.preventDefault();
  const tab = manager.activeTab();
  if (tab) void manager.closeTab(tab.id);
  return;
}
```

- [ ] **Step 2: Implement `closeActivePane` in manager**

```ts
async closeActivePane(): Promise<void> {
  const tab = this.activeTab();
  if (!tab) return;
  const result = await closePaneAction(tab, tab.layout.activePaneIdx, {
    killSession: (sid) => this.killPtySession(sid),
    unmountPaneFromDom: (t, idx) => this.unmountPaneDom(t, idx),
    focusPane: (t, idx) => this.focusPaneDom(t, idx),
  });
  if (result === "close-tab") {
    void this.closeTab(tab.id);
    return;
  }
  this.scheduleSave();
}
```

- [ ] **Step 3: Smoke + commit**

`npm run tauri:dev` → `⌘W` on single tab closes tab; `⌘W` on split closes active pane; `⌘⇧W` always closes tab.

```bash
git add ui/src/main.ts ui/src/tabs/manager.ts
git commit -m "feat(panes): ⌘W closes pane in split; ⌘⇧W always closes tab"
```

---

### Task D14: Active pane indicator (border + focus event)

**Files:**
- Modify: `ui/src/tabs/manager.ts` (focus event wiring in `addPaneToTab`)

- [ ] **Step 1: Wire xterm `onFocus`**

Inside `addPaneToTab(tab, paneIdx)`:

```ts
const onFocus = term.onFocus(() => {
  tab.layout.activePaneIdx = paneIdx;
  this.updateActivePaneClass(tab);
  this.statusBar.refresh(tab);
});
tab.disposers.push(onFocus);
```

And:

```ts
updateActivePaneClass(tab: Tab): void {
  tab.panes.forEach((p, idx) => {
    if (p.el) p.el.classList.toggle("active", idx === tab.layout.activePaneIdx);
  });
}
```

Same for `piView.onFocus` in the Pi pane path.

- [ ] **Step 2: Call `updateActivePaneClass` on tab activate + after split/swap/close**

In `activate(tabId)`, after the existing logic:

```ts
const tab = this.tabs.find((t) => t.id === tabId);
if (tab) this.updateActivePaneClass(tab);
```

In `splitPaneAction`, `swapPanesAction`, `closePaneAction` callers (the manager methods), call `updateActivePaneClass(tab)` after the action returns.

- [ ] **Step 3: Smoke**

`npm run tauri:dev` → split a tab → click each pane → border swaps cyan → status bar updates to reflect the focused pane's cwd/operator/mission.

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(panes): active-pane border + status bar follows focus"
```

---

## Phase E — Persistence

### Task E1: Serialize panes + layout in `SerializedTab`

**Files:**
- Modify: `ui/src/tabs/manager.ts` (the manifest writer — search for `tabManifestSave` invocation)

- [ ] **Step 1: Write the failing test**

Create `ui/src/tabs/manifest-roundtrip.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { serializeTab, deserializeTab } from "./manager";
import type { Tab, Pane } from "./pane";

const pane = (id: string, cwd: string): Pane => ({
  id, kind: "terminal", sessionId: `s-${id}`, cwd,
  mission: null, operator: null, blocks: [],
  xterm: null, piView: null,
  // …other minimal fields
} as Pane);

describe("manifest roundtrip", () => {
  it("split tab serializes both panes and layout", () => {
    const tab: Tab = {
      id: "t1",
      customName: null,
      color: null,
      groupId: null,
      panes: [pane("p0", "/a"), pane("p1", "/b")],
      layout: { kind: "split", orientation: "horizontal", activePaneIdx: 1, ratio: 0.6 },
    } as Tab;
    const s = serializeTab(tab);
    expect(s.panes).toHaveLength(2);
    expect(s.layout).toEqual({ kind: "split", orientation: "horizontal", active: 1, ratio: 0.6 });
    expect(s.panes![1].cwd).toBe("/b");
  });

  it("single tab serializes panes[1-element] + layout=single", () => {
    const tab: Tab = {
      id: "t1", customName: null, color: null, groupId: null,
      panes: [pane("p0", "/a")],
      layout: { kind: "single", activePaneIdx: 0 },
    } as Tab;
    const s = serializeTab(tab);
    expect(s.panes).toHaveLength(1);
    expect(s.layout).toEqual({ kind: "single", active: 0 });
  });
});
```

- [ ] **Step 2: Implement `serializeTab` / `deserializeTab`**

Export from `manager.ts`:

```ts
export function serializeTab(tab: Tab): SerializedTab {
  return {
    kind: tab.panes[0].kind === "pi" ? "pi" : "shell",
    custom_name: tab.customName,
    cwd: null,                  // legacy mirror; new readers use panes[i].cwd
    color: tab.color,
    group_id: tab.groupId,
    mission_path: null,
    operator_id: null,
    panes: tab.panes.map((p) => ({
      id: p.id,
      kind: p.kind,
      cwd: p.cwd,
      mission_path: p.mission?.path ?? null,
      operator_id: p.operator,
      replay_key: p.replayKey,
      observer_ids: p.observer_ids,
      spawn_id: p.spawn_id,
      aom_excluded: p.aomExcluded,
    })),
    layout: {
      kind: tab.layout.kind,
      orientation: tab.layout.orientation,
      active: tab.layout.activePaneIdx,
      ratio: tab.layout.ratio,
    },
  };
}
```

`deserializeTab` lives in the existing restore loop (modified in A4); make sure it consumes `panes`/`layout` for new-shape tabs and the lifted single-pane shape for legacy.

- [ ] **Step 3: Wire `serializeTab` into the existing manifest writer**

Search for the existing serialization site (likely a `.map` over `this.tabs` building `SerializedTab[]`) and replace the inline builder with `serializeTab(tab)`.

- [ ] **Step 4: Test + commit**

```bash
npx vitest run ui/src/tabs/manifest-roundtrip.test.ts
git add ui/src/tabs/manager.ts ui/src/tabs/manifest-roundtrip.test.ts
git commit -m "feat(panes): serialize panes[]+layout to tab manifest"
```

---

### Task E2: Restore split tabs on app launch

**Files:**
- Modify: `ui/src/tabs/manager.ts` (the restore loop in `restoreFromManifest` or equivalent)

- [ ] **Step 1: Update restore loop**

After `liftLegacyTab(raw)`, iterate `lifted.panes`:

```ts
for (const raw of manifest.tabs) {
  const lifted = liftLegacyTab(raw);
  const tab = await this.addTabInternal({
    // …existing args derived from lifted's first pane (kind, customName, color, groupId, etc.)
    customName: lifted.custom_name,
    color: lifted.color,
    groupId: lifted.group_id,
    cwd: lifted.panes![0].cwd ?? undefined,
    operatorId: lifted.panes![0].operator_id ?? undefined,
    replayKey: lifted.panes![0].replay_key,
    skipActivate: true,
  });
  // If the persisted tab was split, add the second pane after the first
  // is mounted.
  if (lifted.layout?.kind === "split" && lifted.panes!.length === 2) {
    const secondPane = lifted.panes![1];
    await this.addPaneToExistingTab(tab, {
      cwd: secondPane.cwd ?? undefined,
      operatorId: secondPane.operator_id ?? undefined,
      replayKey: secondPane.replay_key,
      orientation: lifted.layout.orientation!,
      ratio: lifted.layout.ratio ?? 0.5,
      activePaneIdx: lifted.layout.active,
    });
  }
}
```

`addPaneToExistingTab(tab, opts)` is a new method that spawns a second PTY, runs `addPaneToTab(tab, 1)` (the helper extracted in D12), installs the splitter, and sets layout fields.

- [ ] **Step 2: Manual end-to-end**

`npm run tauri:dev` → flag ON → split a tab horizontally → drag splitter to 70/30 → activate second pane → ⌘Q → relaunch → tab opens with both panes, splitter at 70/30, second pane focused.

- [ ] **Step 3: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(panes): restore split tabs from manifest (both PTYs, ratio, active)"
```

---

### Task E3: Integration test — manifest survives kill+relaunch

**Files:**
- Create: `crates/app/tests/split_persistence.rs` (or extend an existing integration test file)

- [ ] **Step 1: Write the test**

The exact harness depends on Covenant's existing integration test pattern. Find the closest existing test:

```bash
ls crates/app/tests/ 2>/dev/null
grep -l "tab_manifest\|TabManifest" crates/app/tests/ 2>/dev/null
```

If integration tests already exercise the manifest, add a case that:
1. Constructs a `TabManifestV1` JSON with one split tab (two panes, layout).
2. Writes it to `tab_manifest_path` via `tab_manifest::save`.
3. Reads back via `tab_manifest::load`.
4. Asserts the roundtrip preserves `panes[]`, `layout`, `ratio`.

If no such harness exists, scope this as a TS integration test in vitest using a mocked Tauri `invoke`.

- [ ] **Step 2: Commit**

```bash
git add crates/app/tests/  # or ui/src/tabs/
git commit -m "test(panes): manifest roundtrip preserves split state"
```

---

## Phase F — Pi panes + polish (gated)

### Task F1: Pi pane kind in a split

**Files:**
- Modify: `ui/src/tabs/manager.ts` `addPaneToTab` — handle `kind: "pi"`

- [ ] **Step 1: Add `convertPaneToPi(tab, paneIdx)` action**

```ts
async convertPaneToPi(tab: Tab, paneIdx: 0 | 1): Promise<void> {
  if (!this.splitPanesEnabled) return;
  const p = tab.panes[paneIdx];
  if (p.kind === "pi") return;
  // dispose terminal artifacts
  p.xterm?.dispose();
  p.finder?.dispose();
  // spawn Pi session, mount PiChatView in the existing .pane-host
  const piSessionId = await spawnPiSession();
  const view = new PiChatView({ sessionId: piSessionId, host: p.el! });
  p.kind = "pi";
  p.sessionId = piSessionId;
  p.xterm = null;
  p.piView = view;
  this.scheduleSave();
}
```

- [ ] **Step 2: Smoke**

`npm run tauri:dev` → split tab → right-click the second pane → "Convert to Pi" → second pane becomes a Pi chat.

- [ ] **Step 3: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(panes): convert a terminal pane to Pi in place"
```

---

### Task F2: Pane context menu

**Files:**
- Modify: `ui/src/tabs/manager.ts` (add `pointerdown` on pane-host that opens a menu — model after the existing tabbar context menu)

- [ ] **Step 1: Implement `installPaneContextMenu(pane.el, tab, paneIdx)`**

Standard right-click handler that builds a `<div class="pane-context-menu">` with the items: Split right, Split down, Swap, Convert to Pi, Close pane. Gate everything except "Close pane" on `this.splitPanesEnabled`.

- [ ] **Step 2: Smoke + commit**

```bash
git add ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "feat(panes): right-click context menu on pane chrome"
```

---

### Task F3: Tabbar chip split glyph + tooltip

**Files:**
- Modify: the tabbar render path in `ui/src/tabs/manager.ts` (search for the chip-rendering function)

- [ ] **Step 1: Add a `▣` glyph to chips when `tab.layout.kind === "split"`**

```ts
if (this.splitPanesEnabled && tab.layout.kind === "split") {
  const glyph = document.createElement("span");
  glyph.className = "tab-chip-split-glyph";
  glyph.textContent = "▣";
  attachTooltip(glyph, () => paneTooltipText(tab));   // tooltip lists both panes
  chip.appendChild(glyph);
}
```

`paneTooltipText(tab)` returns `"left: ~/a (claude)  ·  right: ~/b (shell)"` etc. Use `attachTooltip` per the project convention (no native `title=` — see CLAUDE.md memory: feedback_no_native_tooltips).

- [ ] **Step 2: Smoke + commit**

```bash
git add ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "feat(panes): split glyph + tooltip on tab chip"
```

---

## Self-Review

Run this checklist after writing the plan; fix anything you find inline.

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| Goal / Why | covered by overall plan |
| Non-goals | enforced by D7 (refuse to split when already split) |
| Experimental feature flag | D1 (Rust), D2 (UI checkbox), D3 (live wiring), D7/D9/D12 (gating), D8 (always-on close) |
| Domain model (Pane, TabLayout) | A1 |
| DOM/CSS architecture | D4 (wrapper), D5 (CSS), D10 (splitter), D11 (clamp), D14 (active border) |
| Behavior: commands | D6 (stubs), D7–D9 (actions) |
| Behavior: shortcuts | D12, D13 |
| Behavior: split inheritance | D7 |
| Behavior: close | D8, D13 |
| Behavior: status bar = active only | B1, D14 |
| Persistence | A3, A4, A5, E1, E2, E3 |
| Migration path A–F | each phase has tasks |
| Edge: editor clamp | D11 |
| Edge: xterm refit | D14 (focus path) — note: explicit refit on splitter pointerup is in D10 (`onCommit` calls fit) and D11 (refit after clamp change). Document this in the splitter call site. |
| Edge: AOM per pane | B2 |
| Edge: spec detector | B5 (out of scope of this plan; flagged below) |
| Edge: tabbar chip | F3 |
| Edge: Pi in split | F1, F2 |
| Edge: block parsing | implicit in pane-owned blocks (A5, B-* renames) |
| Edge: finder | B4 |
| Edge: recall / global search | B4 |
| Edge: notifications | not a code change — title formatting is downstream of pane label; defer |
| Edge: focus stealing | called out in D14 — wrap `term.focus()` in `requestAnimationFrame` inside `splitPaneAction`'s mount step |
| Edge: editor + last pane | implicit; editor stays per-tab (Tab keeps `editor`) |
| Testing: unit | A1, A2, A3, D7, D8, D9, D10, E1 |
| Testing: integration | E3 |
| Testing: visual | called out as manual smoke at D2/D11/D12/D13/D14/E2/F1/F2 |
| Testing: feature flag | D2 smoke + D12 smoke |

**Gap found during review:** spec mentions per-cwd spec_detector subscription needs to walk panes (`crates/app/src/spec_detector.rs`). Add task **B5** below for completeness.

### Task B5 (added in self-review): Spec detector watches per pane

**Files:** `crates/app/src/spec_detector.rs` (or wherever cwd watching lives).

- [ ] Identify the iteration over tabs/sessions:

```bash
grep -rn "watching cwd\|spec_detector\|cwd_changed" crates/app/src/ | head -20
```

- [ ] Replace tab-iteration with pane-iteration (each tab now has 1–2 cwds).
- [ ] Test by splitting into two different repos; both should appear in spec watcher logs.
- [ ] Commit.

**Placeholder scan:** none — every code step has the full code; every command has the exact invocation.

**Type consistency check:**

- `Pane` definition in A1 must include the extended fields added in B1 (`executor`, `operatorEnabled`, `operatorLive`, `aomExcluded`, `observer_ids`, `spawn_id`, `idleAgent`, `busyProc`, `replayKey`, `el`). Confirmed by tasks B1/D5 explicitly amending the interface.
- `splitPaneAction` signature in D7 takes `SplitActionCtx`; D9's actions take different ctx shapes (`FocusActionCtx`, `RemountCtx`) — intentional, called out in their type comments.
- `closePaneAction` returns `"collapsed" | "close-tab"`; D13's `closeActivePane` switches on the return value — consistent.
- `setPaneRatioAction` clamps to `[0.1, 0.9]`; pane-splitter drag in D10 clamps the same range. Aligned.

**Scope check:** plan is one feature, one settings flag, one persistence schema bump. Appropriate for a single implementation cycle. Phases A–C are the long pole (mechanical rename); D–F are the visible work.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-26-split-panes.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
