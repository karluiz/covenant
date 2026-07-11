# Operator-derived tab names follow inference — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route operator-derived tab names (mission slug, task title) into the auto title slot (`defaultTitle`) instead of pinning them in `customName`, so live tab-title inference keeps evolving the tab.

**Architecture:** Frontend-only. `tabDisplayName = customName || defaultTitle`; inference already writes `defaultTitle` (`title_suggested` handler) and already yields to `customName`. Moving the two derived-name writers to `defaultTitle` gives precedence `user rename > inference > derived seed` for free — no new state.

**Tech Stack:** TypeScript (strict), Vitest (jsdom), Tauri webview. Tests run from repo ROOT (`npm test`), never `ui/`.

## Global Constraints

- `strict: true`, no implicit any, no `as any` without a justifying comment.
- UI chrome copy is English; comments may be terse.
- Spec: `docs/superpowers/specs/2026-07-11-operator-tab-name-follows-inference-design.md`.
- Do **not** touch the executor session rename (`crates/app/src/operator.rs` `/rename`) — explicitly out of scope.
- **jsdom cannot spawn a tab** (`createTab` awaits a real PTY + xterm canvas → throws under jsdom; see `ui/src/tabs/manager.test.ts:4-7,77-84`). No new vitest test drives a live tab; the automated gate is `tsc --noEmit` + the existing `npm test` suite staying green, and behavioral verification is the in-app DOM-dump drive in Task 3.
- All agent code edits run in a git worktree (create it at execution time via `superpowers:using-git-worktrees`).

---

### Task 1: Mission slug seeds `defaultTitle`, not `customName`

**Files:**
- Modify: `ui/src/tabs/manager.ts:2506-2528` (`applyMissionTabNames`)

**Interfaces:**
- Consumes: `slugFromMissionPath(path: string): string` (`manager.ts:7641`, unchanged); `activePane(tab).mission`; `Tab.defaultTitle: string`, `Tab.customName: string | null`.
- Produces: nothing new — same method signature `applyMissionTabNames(): void`.

- [ ] **Step 1: Rewrite the method body to write the auto slot**

Replace the doc comment + body at `ui/src/tabs/manager.ts:2506`:

```ts
  /// "AOM is alive" proactive step: when AOM transitions on, every tab
  /// with a mission attached AND no user-set name gets its AUTO title
  /// (defaultTitle) seeded from a slug derived from the mission file.
  /// The seed is readable immediately ("docs-hub", "mission-tracking")
  /// and is then overwritten by live title inference (title_suggested),
  /// so the tab keeps evolving. A user-set customName is NEVER touched.
  applyMissionTabNames(): void {
    let touched = false;
    for (const tab of this.tabs) {
      const mission = activePane(tab).mission;
      if (!mission) continue;
      // A name the user set by hand always wins — don't seed over it.
      if (tab.customName && tab.customName.trim().length > 0) continue;
      const slug = slugFromMissionPath(mission.path);
      if (!slug) continue;
      // ponytail: seed the auto slot, not customName — inference owns
      // defaultTitle and yields to customName, so precedence is free.
      // May briefly regress an already-inferred title to the slug at
      // AOM-enable; the next titler tick corrects it.
      tab.defaultTitle = slug;
      touched = true;
    }
    if (touched) {
      this.renderTabbar();
      // Names that just changed may belong to AOM-excluded tabs; the
      // popover keys on `name` so push to keep its labels current.
      this.pushExcludedToStatusBar();
    }
  }
```

The only functional change from the original is `tab.defaultTitle = slug;` in
place of `tab.customName = slug;`. The guard still reads `customName`.

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors (exit 0, empty output).

- [ ] **Step 3: Regression suite stays green**

Run: `npm test` (from repo ROOT)
Expected: the existing `TabManager group active-org persistence` tests pass; no new failures.

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "fix(tabs): mission slug seeds defaultTitle, not customName

So live title inference keeps evolving the tab instead of being masked by
a pinned customName. User-set names still win.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `createTab` accepts a `defaultTitle` seed; task tabs use it

**Files:**
- Modify: `ui/src/tabs/manager.ts:3185-3198` (`createTab` opts type)
- Modify: `ui/src/tabs/manager.ts:4262` (tab construction)
- Modify: `ui/src/main.ts:734-739` (`spawnTabForTask`)

**Interfaces:**
- Consumes: `cwdBasename(initialCwd: string): string` (unchanged fallback).
- Produces: `createTab` opts gain `defaultTitle?: string | null` — an auto-slot seed applied at construction, overwritten later by inference. `customName` opt is unchanged and still pins.

- [ ] **Step 1: Add the opt to the `createTab` signature**

At `ui/src/tabs/manager.ts:3185`, add one field to the opts object type:

```ts
  async createTab(opts?: {
    customName?: string | null;
    /// Auto-slot seed for the tab name, shown until the first inferred
    /// title arrives (title_suggested overwrites it). Unlike customName,
    /// it does NOT pin — use this for derived names (task title, etc.).
    defaultTitle?: string | null;
    color?: string | null;
    groupId?: string | null;
    cwd?: string | null;
    initialCommand?: string | null;
    skipActivate?: boolean;
    replayKey?: string | null;
  }): Promise<Tab | null> {
```

- [ ] **Step 2: Seed `defaultTitle` at construction**

At `ui/src/tabs/manager.ts:4262`, change the `defaultTitle` initializer:

```ts
      defaultTitle: opts?.defaultTitle?.trim() || cwdBasename(initialCwd),
```

(Was `defaultTitle: cwdBasename(initialCwd),`. The `.trim() || …` keeps the
cwd-basename fallback and guarantees `defaultTitle` is never empty.)

- [ ] **Step 3: Point `spawnTabForTask` at the seed slot**

At `ui/src/main.ts:734`, change the `createTab` call:

```ts
    const tab = await manager.createTab({
      // Auto-slot seed, not a pin: the tab shows the task title until
      // live inference produces an activity label, then evolves.
      defaultTitle: task.title.slice(0, 32),
      cwd,
      groupId,
      color,
    });
```

(Was `customName: \`${task.title.slice(0, 32)}\`,`.)

- [ ] **Step 4: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors (exit 0). Confirms the new opt is wired at both the type
and the two call sites.

- [ ] **Step 5: Confirm the two call sites changed and no stray `customName` task pin remains**

Run: `grep -n "defaultTitle: opts?.defaultTitle\|defaultTitle: task.title\|customName: .*task.title" ui/src/tabs/manager.ts ui/src/main.ts`
Expected: the two new `defaultTitle:` lines present; the old
`customName: …task.title…` line absent.

- [ ] **Step 6: Regression suite stays green**

Run: `npm test` (from repo ROOT)
Expected: no new failures.

- [ ] **Step 7: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/main.ts
git commit -m "feat(tabs): createTab defaultTitle seed; task tabs use it

Task-spawned tabs seed the auto title slot instead of pinning customName,
so their name follows inference like any other tab.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: In-app verification (DOM dump)

**Files:**
- Temp only: a `// TEMP-VERIFY` snippet in `ui/src/main.ts` (reverted after) + a local node listener in the scratchpad.

**Interfaces:**
- Consumes: `TabManager.createTab({ defaultTitle })`, the `title_suggested` event path (`manager.ts:3521`), `tabDisplayName` (via the rendered tab label).
- Produces: evidence only — no committed code.

This is the substantive behavioral check jsdom can't do (Global Constraints).
It follows the repo's established recipe (osascript is blocked; boot snippet +
localhost POST — dev CSP is `null`). **Relaunch the dev binary** so the window
opens active, or the WKWebView timers stay suspended and the snippet never runs.

- [ ] **Step 1: Start a local listener** (scratchpad, port 9988) that writes each POST body to `verify-dump.json`.

- [ ] **Step 2: Add a `// TEMP-VERIFY` snippet** at the end of `ui/src/main.ts` that, ~3s after boot:
  1. `const tab = await manager.createTab({ defaultTitle: "seed-name-xyz" });`
  2. reads the rendered tab label (`tabbarHost` text) → expect it contains `seed-name-xyz`;
  3. dispatches the same session event the titler emits — locate the tab's session event handler and feed `{ kind: "title_suggested", title: "running tests" }` (or drive `manager` via the same path the summarizer uses);
  4. reads the tab label again → expect it now contains `running tests` (inference overwrote the seed);
  5. POSTs `{ seedShown, inferenceOverwrote, label1, label2 }` to `http://localhost:9988/verify`.

- [ ] **Step 3: Relaunch the dev app**

```bash
pkill -f "target/debug/covenant$"; npm run tauri:dev > /tmp/tauri-dev.log 2>&1 &
```

- [ ] **Step 4: Read the dump and assert**

Expected `verify-dump.json`: `seedShown: true` (tab showed `seed-name-xyz`) and
`inferenceOverwrote: true` (label became `running tests`). Together they prove
the derived name is a seed, not a pin.

- [ ] **Step 5: Revert the snippet + stop helpers**

```bash
# remove the TEMP-VERIFY block from ui/src/main.ts
pkill -f "verify-listener"; pkill -f "target/debug/covenant$"
grep -n "TEMP-VERIFY\|9988\|seed-name-xyz" ui/src/main.ts   # expect: no matches
```

No commit — verification leaves no code behind.

---

## Self-Review

**Spec coverage:**
- Change 1 (`applyMissionTabNames` → `defaultTitle`) → Task 1. ✅
- Change 2 (`createTab` `defaultTitle` opt) → Task 2 Steps 1-2. ✅
- Change 3 (`spawnTabForTask` seed) → Task 2 Step 3. ✅
- Behavior table (seed shows, inference overwrites, customName wins) → Task 1 guard + Task 3 verification. ✅
- Edge case: empty seed never blanks the name → Task 2 Step 2 `.trim() || cwdBasename`. ✅
- Edge case: `slugFromMissionPath` → "" skipped → Task 1 `if (!slug) continue`. ✅
- Non-goal: executor session rename untouched → Global Constraints; no task touches `operator.rs`. ✅
- Non-goal: no persistence migration → nothing migrates existing `custom_name`. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full before/after. Task 3
steps describe concrete actions with the exact recipe and assertions. ✅

**Type consistency:** `defaultTitle?: string | null` opt (Task 2 Step 1) matches
`Tab.defaultTitle: string` seeded via `?.trim() || cwdBasename(...)` (Step 2);
`spawnTabForTask` passes `defaultTitle: string` (Step 3). `applyMissionTabNames`
signature unchanged. ✅
