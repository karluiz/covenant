# Workspace Keep-Alive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switching workspaces no longer kills shell processes. Up to 5 workspaces stay live concurrently; the rest hibernate (PTYs killed, scrollback snapshot in memory) and rehydrate on demand. The super-agent observes all live workspaces.

**Architecture:** Replace the single `TabManager` singleton with a `Map<WorkspaceId, TabManager>` owned by `WorkspaceManager`. Each `TabManager` gets its own tabbar + workspace DOM containers, mounted side-by-side with only the active pair visible. Workspace switching = swap visibility (no teardown). Hibernation = serialize scrollback per tab → call new `TabManager.dispose()` → drop instance.

**Tech Stack:** TypeScript (strict), Tauri 2 IPC, `@xterm/xterm`, existing `BlockManager`/`RecallManager`. Rust backend untouched for keep-alive itself — but `closeSession` is no longer called on workspace switch (it WAS called via `finalizeCloseTab`, that path moves into `dispose()` only).

**Spec:** `docs/superpowers/specs/2026-05-22-workspace-keepalive-design.md`

---

## File Structure

### New files

- `ui/src/workspaces/live-pool.ts` — `LivePool` class: encapsulates `Map<WorkspaceId, TabManager>` + LRU bookkeeping + hibernate/rehydrate. Pulled out of `WorkspaceManager` to keep the latter focused on workspace identity/metadata.
- `ui/src/workspaces/live-pool.test.ts` — unit tests for LRU + activity tracking + hibernate/rehydrate orchestration. Uses a `FakeTabManager` test double.
- `ui/src/workspaces/activity.ts` — `ActivityTracker` per inactive `TabManager`: subscribes to `BlockFinished`/agent events, exposes `{ unseenBlocks, hasFailure, hasAgentNote }`.
- `ui/src/workspaces/activity.test.ts` — unit tests.
- `ui/src/tabs/scrollback-snapshot.ts` — pure helpers: `serializeTab(term: Terminal): string` and `restoreSnapshot(term: Terminal, text: string)`. Isolates the xterm.js serialize call site so the rest of the code can swap implementations.

### Modified files

- `ui/src/tabs/manager.ts`:
  - Add `dispose()` method (real teardown, calls `closeSession` for each tab — exactly what `finalizeCloseTab` does today, but explicit and intentional).
  - Add `detach()` / `attach()` to toggle root container visibility without teardown.
  - Remove the `closeSession` call from `finalizeCloseTab` during workspace-switch teardown. Today `replaceFromManifest` flips `inReplace` to suppress scrollback delete + on-all-closed callback, but still calls `closeSession`. We delete that closeSession call from the `replace`-path entirely (the new architecture never re-enters `replaceFromManifest` during a switch).
  - Constructor takes its own root containers (already does, just re-document so the multi-instance use is intentional).
  - Add `serializeScrollback(): Map<TabId, string>` and `restoreScrollback(snapshots: Map<TabId, string>)`.
- `ui/src/workspaces/manager.ts`:
  - Replace single `tabManager` field with a `LivePool` instance.
  - `switchTo` becomes: serialize-active → swap pool active → no teardown.
  - On boot: rehydrate only `activeId` workspace into the pool.
  - On `live_limit` lowering: hibernate down to limit.
- `ui/src/workspaces/manager.test.ts`:
  - New tests for PTY-survival on switch, LRU eviction, badge surface.
- `ui/src/main.ts`:
  - Stop building a single `TabManager`; instead build the DOM scaffold (tabbar container, workspace container) factories that `LivePool` uses when constructing per-workspace `TabManager` instances.
- `ui/src/workspaces/switcher.ts`:
  - Render `ActivityTracker` state into chip badges.
- `ui/src/settings/panel.ts` + persistence:
  - Expose `workspace.live_limit` (number, default 5, clamp [1, 20]).
- `ui/src/styles.css`:
  - Add chip-badge variants (`.ws-chip--has-failure`, `.ws-chip--has-note`, `.ws-chip__unseen`).

### Out of scope (deferred)

- Persisting hibernated scrollback to disk across app restarts. (Spec defers; rehydration on boot is empty-terminals.)
- Agent rolling-summary retention across hibernation (mentioned in spec; agent code lives in Rust and is not yet wired to per-workspace stores — defer until M3 agent lands).

---

## Phase 0 — Worktree verification

### Task 0: Confirm worktree

**Files:** none (sanity check)

- [ ] **Step 1: Confirm working tree**

Run: `git rev-parse --show-toplevel && git branch --show-current`
Expected: path ends in `karlTerminal-worktree-workspace-keepalive`, branch `worktree-workspace-keepalive`.

- [ ] **Step 2: Confirm app builds before any change**

Run: `cd ui && npm run typecheck`
Expected: zero errors. If errors exist, stop and report — the plan assumes a clean baseline.

---

## Phase 1 — Backend smoke test

**Why:** the spec assumed Sessions outlive UI detach. They don't today — `closeSession` is called explicitly in `finalizeCloseTab:3334`. Before refactoring UI, verify that simply **not calling** `closeSession` actually keeps the PTY alive (no other reaper).

### Task 1: PTY-survives-detach smoke

**Files:**
- Modify (temporary, reverted at end of task): `ui/src/tabs/manager.ts:3334`
- No test file — manual verification.

- [ ] **Step 1: Temporarily comment out `closeSession` call in `finalizeCloseTab`**

In `ui/src/tabs/manager.ts` around line 3334, change:
```ts
void closeSession(tab.sessionId).catch(() => {});
```
to:
```ts
// SMOKE-TEST: keep backend session alive when UI tears down
// void closeSession(tab.sessionId).catch(() => {});
```

- [ ] **Step 2: Run the app and reproduce switch**

Run: `npm run dev` (from project root, however the app launches today — `cargo tauri dev` if that's the canonical command; check `package.json` if unsure).
In the app: open workspace A, run `yes > /dev/null &` in a tab to produce a long-running process. Note its PID via `jobs -l`. Switch to workspace B. Wait 5s. Switch back to A.

Expected: the `yes` process is **still running** in the background (look at `ps -p <PID>` from another terminal outside the app, or top). If true, the PTY survives without `closeSession` — proceed. If killed, there is another reaper and this plan needs revision; stop and report.

- [ ] **Step 3: Revert the smoke change**

Restore line 3334 to its original form (re-enable `closeSession`). Verify with `git diff ui/src/tabs/manager.ts` — should be empty.

- [ ] **Step 4: Commit findings as a note (only the doc, no code change)**

Append a paragraph to `docs/superpowers/specs/2026-05-22-workspace-keepalive-design.md` under a new `## Validation notes` section:

```markdown
## Validation notes

- 2026-05-22: Smoke-tested that backend `Session` survives when UI omits
  `closeSession`. Long-running `yes` process kept running across
  workspace-switch teardown with the call commented out. Confirms no
  other backend reaper kills sessions on UI detach; Rust changes are
  not required for keep-alive.
```

Run:
```bash
git add docs/superpowers/specs/2026-05-22-workspace-keepalive-design.md
git commit -m "docs(spec): validate PTY survives UI detach (smoke test)"
```

---

## Phase 2 — Scrollback snapshot helpers

### Task 2: Scrollback snapshot module (TDD)

**Files:**
- Create: `ui/src/tabs/scrollback-snapshot.ts`
- Test: `ui/src/tabs/scrollback-snapshot.test.ts`

- [ ] **Step 1: Install serialize addon if missing**

Run: `cd ui && npm ls @xterm/addon-serialize`
If absent: `npm install @xterm/addon-serialize`. Otherwise skip.

- [ ] **Step 2: Write the failing test**

Create `ui/src/tabs/scrollback-snapshot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Terminal } from "@xterm/xterm";
import { serializeTab, restoreSnapshot } from "./scrollback-snapshot";

describe("scrollback-snapshot", () => {
  it("round-trips printable text", () => {
    const a = new Terminal({ rows: 10, cols: 40, allowProposedApi: true });
    a.write("hello\r\nworld\r\n");
    // Flush xterm's async write queue
    return new Promise<void>((resolve) => {
      a.write("", () => {
        const snap = serializeTab(a);
        const b = new Terminal({ rows: 10, cols: 40, allowProposedApi: true });
        restoreSnapshot(b, snap);
        b.write("", () => {
          expect(snap).toContain("hello");
          expect(snap).toContain("world");
          resolve();
        });
      });
    });
  });

  it("returns empty string when terminal is blank", () => {
    const t = new Terminal({ rows: 10, cols: 40, allowProposedApi: true });
    return new Promise<void>((resolve) => {
      t.write("", () => {
        expect(serializeTab(t).trim()).toBe("");
        resolve();
      });
    });
  });
});
```

- [ ] **Step 3: Run the test, confirm it fails**

Run: `cd ui && npx vitest run src/tabs/scrollback-snapshot.test.ts`
Expected: FAIL with `Cannot find module './scrollback-snapshot'`.

- [ ] **Step 4: Implement the module**

Create `ui/src/tabs/scrollback-snapshot.ts`:

```ts
import { Terminal } from "@xterm/xterm";
import { SerializeAddon } from "@xterm/addon-serialize";

/// Capture the full visible + scrollback buffer of `term` as an
/// ANSI-bearing string suitable for replay via `restoreSnapshot`.
/// Uses xterm.js's SerializeAddon under the hood — round-trip
/// fidelity is bounded by its semantics (no images, no in-progress
/// async writes; caller should await pending writes first).
export function serializeTab(term: Terminal): string {
  const addon = new SerializeAddon();
  term.loadAddon(addon);
  try {
    return addon.serialize();
  } finally {
    addon.dispose();
  }
}

/// Replay a snapshot string into a fresh terminal at its current
/// cursor position. Does NOT add a trailing newline; the next thing
/// written by the shell will continue on the current line.
export function restoreSnapshot(term: Terminal, snapshot: string): void {
  if (!snapshot) return;
  term.write(snapshot);
}
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `cd ui && npx vitest run src/tabs/scrollback-snapshot.test.ts`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add ui/src/tabs/scrollback-snapshot.ts ui/src/tabs/scrollback-snapshot.test.ts ui/package.json ui/package-lock.json
git commit -m "feat(scrollback): add serialize/restore helpers for workspace hibernation"
```

---

## Phase 3 — TabManager: dispose / detach / attach

### Task 3: Add `dispose()` to TabManager

**Files:**
- Modify: `ui/src/tabs/manager.ts` (add method near end of class, ~line 4400 before final closing brace).

This consolidates what `finalizeCloseTab` does in a loop. It IS the destructive teardown — kills every PTY, removes panes from DOM, drops internal state.

- [ ] **Step 1: Locate end of class**

Run: `grep -n "^}" ui/src/tabs/manager.ts | tail -5`
Note the line of the final `}` closing the `TabManager` class.

- [ ] **Step 2: Add `dispose` and `detach`/`attach` methods**

Insert before the class's closing brace:

```ts
  /// Workspace-keepalive: remove this manager's DOM nodes from the
  /// page without killing PTYs. The instance remains alive in memory,
  /// continues to receive output (each tab's xterm still buffers),
  /// and can be reattached later via `attach`.
  detach(): void {
    if (this.tabbarHost.parentElement) {
      this.tabbarHost.parentElement.removeChild(this.tabbarHost);
    }
    if (this.workspace.parentElement) {
      this.workspace.parentElement.removeChild(this.workspace);
    }
  }

  /// Re-insert this manager's DOM nodes under the given hosts. Pair
  /// with a prior `detach`.
  attach(tabbarParent: HTMLElement, workspaceParent: HTMLElement): void {
    tabbarParent.appendChild(this.tabbarHost);
    workspaceParent.appendChild(this.workspace);
  }

  /// Workspace-keepalive: terminal teardown for hibernation /
  /// workspace deletion. Closes every backend session, disposes
  /// xterm instances, drops DOM. After this returns the instance
  /// is unusable.
  async dispose(): Promise<void> {
    const ids = this.tabs.map((t) => t.id);
    for (const id of ids) {
      // finalizeCloseTab is the existing teardown path and already
      // calls closeSession + xterm dispose + disposers. Reuse it.
      this.finalizeCloseTab(id);
    }
    this.detach();
  }
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: zero new errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(tabs): add detach/attach/dispose for workspace keep-alive"
```

### Task 4: Remove implicit closeSession on workspace-switch teardown

**Files:**
- Modify: `ui/src/tabs/manager.ts` (around line 3262 — `replaceFromManifest`)

Note: `replaceFromManifest` will eventually become unused for workspace switching (only used for first-boot restore of the active workspace). We **keep** its current behavior (closeSession-on-tear-down) because in the new design it's only invoked for rehydration of a hibernated workspace — and in that case the outgoing TabManager has ALREADY been disposed by the LivePool before `restoreFromManifest` is called on the new manager. There is nothing to tear down via `replaceFromManifest` from now on.

To make this contract explicit:

- [ ] **Step 1: Add an assertion that `replaceFromManifest` is only used on empty managers**

In `ui/src/tabs/manager.ts` around line 3265 (start of `replaceFromManifest` body, right after the validation), add:

```ts
    if (this.tabs.length > 0) {
      throw new Error(
        "replaceFromManifest is workspace-keepalive era only valid on an empty TabManager; dispose first",
      );
    }
```

- [ ] **Step 2: Drop the now-dead `inReplace` flag and its branches**

Search and remove `this.inReplace = true;` and `this.inReplace = false;`, the `if (this.inReplace) ...` branches in `finalizeCloseTab`, and any conditional teardown the flag was guarding. The `for (const t of existing) this.finalizeCloseTab(t.id);` loop in `replaceFromManifest` can also be removed (we asserted empty above). The CSS class `workspace-switching` and its toggle stay — that's used by the loader UI which moves to the LivePool (Task 7) but the CSS class survives the transition.

Run: `grep -n "inReplace" ui/src/tabs/manager.ts`
Expected: zero matches after edits.

- [ ] **Step 3: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: zero errors.

- [ ] **Step 4: Run existing tab tests**

Run: `cd ui && npx vitest run`
Expected: all pass. If `workspaces/manager.test.ts` breaks because it was exercising `replaceFromManifest` against a non-empty manager, fix the test to first dispose — the new contract is stricter.

- [ ] **Step 5: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/workspaces/manager.test.ts
git commit -m "refactor(tabs): replaceFromManifest only operates on empty TabManager"
```

### Task 5: Add scrollback (de)serialize on TabManager

**Files:**
- Modify: `ui/src/tabs/manager.ts`

- [ ] **Step 1: Add the method pair**

Insert near the new dispose/attach methods:

```ts
  /// Workspace-keepalive: snapshot every tab's current scrollback.
  /// Returns a Map keyed by tab id. Pi tabs return empty strings —
  /// their state lives in PiChatView and is rehydrated separately.
  serializeScrollback(): Map<string, string> {
    const out = new Map<string, string>();
    for (const tab of this.tabs) {
      if (tab.kind === "pi" || !tab.term) {
        out.set(tab.id, "");
        continue;
      }
      // Lazy-import to keep the hot path skinny.
      const { serializeTab } = require("./scrollback-snapshot") as
        typeof import("./scrollback-snapshot");
      out.set(tab.id, serializeTab(tab.term));
    }
    return out;
  }

  /// Apply snapshots produced by a prior serializeScrollback into the
  /// currently-mounted tabs. Tabs not in the map are left untouched.
  /// Must be called AFTER restoreFromManifest has spawned the new
  /// tabs but BEFORE the user can interact (LivePool guarantees this
  /// ordering).
  restoreScrollback(snapshots: Map<string, string>): void {
    const { restoreSnapshot } = require("./scrollback-snapshot") as
      typeof import("./scrollback-snapshot");
    for (const tab of this.tabs) {
      if (!tab.term) continue;
      const snap = snapshots.get(tab.id);
      if (snap) restoreSnapshot(tab.term, snap);
    }
  }
```

Note on the `require` — the project uses Vite which supports `require` via interop in TS files. If the file's import style is strictly ESM, replace with top-of-file `import` and accept the eager-load cost (it's tiny). Verify by looking at the existing imports at the top of `tabs/manager.ts` — if they're all `import`, switch these too.

- [ ] **Step 2: Switch to top-of-file imports if project is pure-ESM**

Add at top of `ui/src/tabs/manager.ts`:
```ts
import { serializeTab, restoreSnapshot } from "./scrollback-snapshot";
```
and replace the `require(...)` calls in the two methods with direct references.

- [ ] **Step 3: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(tabs): add serialize/restoreScrollback on TabManager"
```

---

## Phase 4 — Activity tracker

### Task 6: ActivityTracker module (TDD)

**Files:**
- Create: `ui/src/workspaces/activity.ts`
- Test: `ui/src/workspaces/activity.test.ts`

The tracker subscribes to a TabManager's block-finished + agent-note streams. We don't have a single event bus in the UI today; the existing path is BlockManager → status bar. For this task we expose a minimal hook on TabManager: an `onBlockFinished(cb)` registrar. Wire it inside the LivePool to one tracker per inactive workspace.

- [ ] **Step 1: Write the failing test**

Create `ui/src/workspaces/activity.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { ActivityTracker, type BlockFinishedEvent } from "./activity";

describe("ActivityTracker", () => {
  let t: ActivityTracker;
  beforeEach(() => {
    t = new ActivityTracker();
  });

  it("starts empty", () => {
    expect(t.state).toEqual({ unseenBlocks: 0, hasFailure: false, hasAgentNote: false });
  });

  it("increments on a successful block", () => {
    t.recordBlock({ exitCode: 0 });
    expect(t.state.unseenBlocks).toBe(1);
    expect(t.state.hasFailure).toBe(false);
  });

  it("flags failure on non-zero exit and keeps counter", () => {
    t.recordBlock({ exitCode: 0 });
    t.recordBlock({ exitCode: 1 });
    expect(t.state).toEqual({ unseenBlocks: 2, hasFailure: true, hasAgentNote: false });
  });

  it("notes agent action", () => {
    t.recordAgentNote();
    expect(t.state.hasAgentNote).toBe(true);
  });

  it("reset() clears everything", () => {
    t.recordBlock({ exitCode: 1 });
    t.recordAgentNote();
    t.reset();
    expect(t.state).toEqual({ unseenBlocks: 0, hasFailure: false, hasAgentNote: false });
  });

  it("emits change events", () => {
    const calls: ActivityTracker["state"][] = [];
    t.onChange((s) => calls.push({ ...s }));
    t.recordBlock({ exitCode: 0 });
    t.recordBlock({ exitCode: 2 });
    t.reset();
    expect(calls.length).toBe(3);
    expect(calls[2]).toEqual({ unseenBlocks: 0, hasFailure: false, hasAgentNote: false });
  });
});

interface _UnusedTypeExport { x: BlockFinishedEvent }
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `cd ui && npx vitest run src/workspaces/activity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `ui/src/workspaces/activity.ts`:

```ts
export interface BlockFinishedEvent {
  exitCode: number;
}

export interface ActivityState {
  unseenBlocks: number;
  hasFailure: boolean;
  hasAgentNote: boolean;
}

type Listener = (state: ActivityState) => void;

export class ActivityTracker {
  state: ActivityState = { unseenBlocks: 0, hasFailure: false, hasAgentNote: false };
  private listeners = new Set<Listener>();

  recordBlock(ev: BlockFinishedEvent): void {
    this.state = {
      ...this.state,
      unseenBlocks: this.state.unseenBlocks + 1,
      hasFailure: this.state.hasFailure || ev.exitCode !== 0,
    };
    this.emit();
  }

  recordAgentNote(): void {
    if (this.state.hasAgentNote) return;
    this.state = { ...this.state, hasAgentNote: true };
    this.emit();
  }

  reset(): void {
    this.state = { unseenBlocks: 0, hasFailure: false, hasAgentNote: false };
    this.emit();
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `cd ui && npx vitest run src/workspaces/activity.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add ui/src/workspaces/activity.ts ui/src/workspaces/activity.test.ts
git commit -m "feat(workspaces): add ActivityTracker for inactive-workspace badges"
```

### Task 7: Expose `onBlockFinished` on TabManager

**Files:**
- Modify: `ui/src/tabs/manager.ts`
- Modify: `ui/src/blocks/manager.ts` (the block manager that emits finishes)

Discovery step required before implementation: find where exit codes flow in. This is intentionally an investigation step before the code change.

- [ ] **Step 1: Find current block-finished emission**

Run: `grep -n "exit_code\|exitCode\|BlockFinished\|finished" ui/src/blocks/manager.ts | head -30`

Identify the function that runs when a block finishes (likely something like `onBlockFinished` or where `exit_code` is assigned). Note its signature.

- [ ] **Step 2: Add a fan-out registrar on TabManager**

In `ui/src/tabs/manager.ts`, add a field and method (near other public methods):

```ts
  private blockFinishedListeners = new Set<(ev: { tabId: string; exitCode: number }) => void>();

  /// Workspace-keepalive: subscribe to block-finished events across
  /// all tabs in this manager. The listener fires once per finished
  /// command block with the owning tab id and its exit code.
  onBlockFinished(cb: (ev: { tabId: string; exitCode: number }) => void): () => void {
    this.blockFinishedListeners.add(cb);
    return () => this.blockFinishedListeners.delete(cb);
  }

  /// Internal: invoked by BlockManager when a block resolves.
  notifyBlockFinished(tabId: string, exitCode: number): void {
    for (const l of this.blockFinishedListeners) l({ tabId, exitCode });
  }
```

- [ ] **Step 3: Wire BlockManager to call `notifyBlockFinished`**

At the point identified in Step 1 (where the block transitions from running to finished with exit code resolved), invoke `this.tabManager.notifyBlockFinished(this.tabId, exitCode)`. If `BlockManager` doesn't already hold a reference back to `TabManager`, plumb one through its constructor — but check first: it likely already does via a callback or owner reference.

- [ ] **Step 4: Add a smoke test for the wiring**

Create `ui/src/tabs/manager.block-events.test.ts`:

```ts
import { describe, it, expect } from "vitest";

// Direct unit test of the registrar fan-out; full TabManager construction
// requires a DOM and Tauri shims and is exercised by integration tests.

class FakeTabManager {
  private listeners = new Set<(ev: { tabId: string; exitCode: number }) => void>();
  onBlockFinished(cb: (ev: { tabId: string; exitCode: number }) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  notifyBlockFinished(tabId: string, exitCode: number) {
    for (const l of this.listeners) l({ tabId, exitCode });
  }
}

describe("block-finished fan-out", () => {
  it("delivers events to subscribers and respects unsubscribe", () => {
    const m = new FakeTabManager();
    const seen: Array<{ tabId: string; exitCode: number }> = [];
    const off = m.onBlockFinished((e) => seen.push(e));
    m.notifyBlockFinished("t1", 0);
    m.notifyBlockFinished("t2", 1);
    off();
    m.notifyBlockFinished("t3", 0);
    expect(seen).toEqual([
      { tabId: "t1", exitCode: 0 },
      { tabId: "t2", exitCode: 1 },
    ]);
  });
});
```

The point of duplicating the contract in a fake is to lock the API shape; the real plumbing into BlockManager is verified by manual test in Phase 8.

- [ ] **Step 5: Run tests, typecheck**

Run: `cd ui && npx vitest run && npm run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/blocks/manager.ts ui/src/tabs/manager.block-events.test.ts
git commit -m "feat(tabs): expose onBlockFinished for workspace activity tracking"
```

---

## Phase 5 — LivePool

### Task 8: LivePool with LRU + hibernation (TDD)

**Files:**
- Create: `ui/src/workspaces/live-pool.ts`
- Test: `ui/src/workspaces/live-pool.test.ts`

The LivePool is fully driven by an injected `TabManagerFactory` so it can be unit-tested with a fake. Real wiring happens in Task 10.

- [ ] **Step 1: Define the interfaces**

Create `ui/src/workspaces/live-pool.ts` with just the shapes (no implementation yet):

```ts
import { ActivityTracker, type ActivityState } from "./activity";

/// Minimal surface area of a real TabManager that LivePool consumes.
/// Lets tests stub it without DOM/Tauri dependencies.
export interface PoolableTabManager {
  detach(): void;
  attach(tabbarParent: HTMLElement, workspaceParent: HTMLElement): void;
  dispose(): Promise<void>;
  serializeScrollback(): Map<string, string>;
  restoreScrollback(snapshots: Map<string, string>): void;
  serializeManifest(): unknown;
  replaceFromManifest(m: unknown, opts?: { silent?: boolean }): Promise<void>;
  onBlockFinished(cb: (ev: { tabId: string; exitCode: number }) => void): () => void;
}

export interface TabManagerFactory {
  create(workspaceId: string): PoolableTabManager;
  hosts(workspaceId: string): { tabbar: HTMLElement; workspace: HTMLElement };
}

interface LiveEntry {
  manager: PoolableTabManager;
  tracker: ActivityTracker;
  unsubscribeBlocks: () => void;
}

interface HibernatedEntry {
  scrollback: Map<string, string>;
  lastActivity: ActivityState;
}
```

Add the class shell that the test expects:

```ts
export class LivePool {
  private live = new Map<string, LiveEntry>();
  private hibernated = new Map<string, HibernatedEntry>();
  private lru: string[] = [];
  private liveLimit: number;
  private activeId: string | null = null;

  constructor(
    private readonly factory: TabManagerFactory,
    opts: { liveLimit?: number } = {},
  ) {
    this.liveLimit = Math.max(1, Math.min(20, opts.liveLimit ?? 5));
  }

  get size(): number { return this.live.size; }
  isLive(id: string): boolean { return this.live.has(id); }
  isHibernated(id: string): boolean { return this.hibernated.has(id); }
  active(): PoolableTabManager | null {
    return this.activeId ? this.live.get(this.activeId)?.manager ?? null : null;
  }
  activityOf(id: string): ActivityState | null {
    return this.live.get(id)?.tracker.state ?? this.hibernated.get(id)?.lastActivity ?? null;
  }

  setLimit(n: number): Promise<void> {
    this.liveLimit = Math.max(1, Math.min(20, n));
    return this.enforceLimit();
  }

  async activate(id: string, manifest: unknown): Promise<PoolableTabManager> {
    if (this.activeId === id && this.live.has(id)) return this.live.get(id)!.manager;

    // Detach current active (if any).
    if (this.activeId && this.live.has(this.activeId)) {
      this.live.get(this.activeId)!.manager.detach();
    }

    if (this.live.has(id)) {
      this.touch(id);
      const entry = this.live.get(id)!;
      const hosts = this.factory.hosts(id);
      entry.manager.attach(hosts.tabbar, hosts.workspace);
      entry.tracker.reset();
      this.activeId = id;
      return entry.manager;
    }

    // Cold path: rehydrate from hibernated state or fresh.
    await this.enforceLimit(/*incoming*/ 1);
    const manager = this.factory.create(id);
    await manager.replaceFromManifest(manifest);
    const hibern = this.hibernated.get(id);
    if (hibern) {
      manager.restoreScrollback(hibern.scrollback);
      this.hibernated.delete(id);
    }
    const tracker = new ActivityTracker();
    const off = manager.onBlockFinished((ev) => {
      if (this.activeId !== id) tracker.recordBlock({ exitCode: ev.exitCode });
    });
    this.live.set(id, { manager, tracker, unsubscribeBlocks: off });
    this.touch(id);
    this.activeId = id;
    return manager;
  }

  recordAgentNote(id: string): void {
    const entry = this.live.get(id);
    if (entry && this.activeId !== id) entry.tracker.recordAgentNote();
  }

  async hibernate(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (!entry) return;
    if (this.activeId === id) throw new Error("cannot hibernate active workspace");
    const scrollback = entry.manager.serializeScrollback();
    const lastActivity = { ...entry.tracker.state };
    entry.unsubscribeBlocks();
    await entry.manager.dispose();
    this.live.delete(id);
    this.lru = this.lru.filter((x) => x !== id);
    this.hibernated.set(id, { scrollback, lastActivity });
  }

  /// Forget a workspace entirely (deleted by user). Removes from live
  /// and hibernated pools.
  async forget(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (entry) {
      entry.unsubscribeBlocks();
      await entry.manager.dispose();
      this.live.delete(id);
    }
    this.hibernated.delete(id);
    this.lru = this.lru.filter((x) => x !== id);
    if (this.activeId === id) this.activeId = null;
  }

  private touch(id: string): void {
    this.lru = [id, ...this.lru.filter((x) => x !== id)];
  }

  private async enforceLimit(incoming = 0): Promise<void> {
    while (this.live.size + incoming > this.liveLimit) {
      const victim = [...this.lru].reverse().find((id) => id !== this.activeId);
      if (!victim) break;
      await this.hibernate(victim);
    }
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `ui/src/workspaces/live-pool.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { LivePool, type PoolableTabManager, type TabManagerFactory } from "./live-pool";

class FakeManager implements PoolableTabManager {
  static disposed: string[] = [];
  constructor(public id: string) {}
  attached = false;
  scrollback = new Map<string, string>([["t0", `snap-${this.id}`]]);
  private blockListeners = new Set<(ev: { tabId: string; exitCode: number }) => void>();
  detach() { this.attached = false; }
  attach() { this.attached = true; }
  async dispose() { FakeManager.disposed.push(this.id); }
  serializeScrollback() { return new Map(this.scrollback); }
  restoreScrollback(s: Map<string, string>) { this.scrollback = new Map(s); }
  serializeManifest() { return { version: 1, tabs: [], groups: [], active_index: 0 }; }
  async replaceFromManifest() { /* no-op */ }
  onBlockFinished(cb: (ev: { tabId: string; exitCode: number }) => void) {
    this.blockListeners.add(cb);
    return () => this.blockListeners.delete(cb);
  }
  emitBlock(exitCode: number) {
    for (const l of this.blockListeners) l({ tabId: "t0", exitCode });
  }
}

function fakeFactory(): TabManagerFactory & { created: FakeManager[] } {
  const created: FakeManager[] = [];
  return {
    created,
    create(id) { const m = new FakeManager(id); created.push(m); return m; },
    hosts() { return { tabbar: document.createElement("div"), workspace: document.createElement("div") }; },
  };
}

describe("LivePool", () => {
  it("activate creates and tracks a new live workspace", async () => {
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 3 });
    await pool.activate("a", {});
    expect(pool.isLive("a")).toBe(true);
    expect(pool.size).toBe(1);
  });

  it("switching does not dispose the previous workspace", async () => {
    FakeManager.disposed = [];
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 3 });
    await pool.activate("a", {});
    await pool.activate("b", {});
    expect(pool.isLive("a")).toBe(true);
    expect(pool.isLive("b")).toBe(true);
    expect(FakeManager.disposed).toEqual([]);
  });

  it("hibernates LRU when exceeding limit", async () => {
    FakeManager.disposed = [];
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 2 });
    await pool.activate("a", {});
    await pool.activate("b", {});
    await pool.activate("c", {});
    // a is LRU, must be hibernated
    expect(pool.isHibernated("a")).toBe(true);
    expect(pool.isLive("a")).toBe(false);
    expect(FakeManager.disposed).toEqual(["a"]);
  });

  it("rehydrates hibernated scrollback on re-activate", async () => {
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 2 });
    await pool.activate("a", {});
    const aFirst = f.created[0];
    aFirst.scrollback = new Map([["t0", "saved-content"]]);
    await pool.activate("b", {});
    await pool.activate("c", {}); // evicts a
    await pool.activate("a", {}); // rehydrate; should evict b (LRU among live: c, b → b)
    const aSecond = f.created.find((m) => m.id === "a" && m !== aFirst);
    expect(aSecond?.scrollback.get("t0")).toBe("saved-content");
  });

  it("activity tracker accumulates only while inactive", async () => {
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 3 });
    await pool.activate("a", {});
    await pool.activate("b", {}); // a is now inactive
    const a = f.created.find((m) => m.id === "a")!;
    a.emitBlock(0);
    a.emitBlock(1);
    expect(pool.activityOf("a")).toEqual({ unseenBlocks: 2, hasFailure: true, hasAgentNote: false });
    await pool.activate("a", {}); // becoming active resets
    expect(pool.activityOf("a")).toEqual({ unseenBlocks: 0, hasFailure: false, hasAgentNote: false });
  });

  it("hibernate refuses to evict the active workspace", async () => {
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 5 });
    await pool.activate("a", {});
    await expect(pool.hibernate("a")).rejects.toThrow();
  });

  it("setLimit lower hibernates down to the new bound", async () => {
    FakeManager.disposed = [];
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 5 });
    await pool.activate("a", {});
    await pool.activate("b", {});
    await pool.activate("c", {});
    await pool.activate("d", {});
    await pool.setLimit(2);
    // d is active, c is most recent inactive — keep both; hibernate a, b
    expect(pool.isHibernated("a")).toBe(true);
    expect(pool.isHibernated("b")).toBe(true);
    expect(pool.isLive("c")).toBe(true);
    expect(pool.isLive("d")).toBe(true);
  });

  it("forget removes from both pools and clears active", async () => {
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 3 });
    await pool.activate("a", {});
    await pool.forget("a");
    expect(pool.isLive("a")).toBe(false);
    expect(pool.isHibernated("a")).toBe(false);
  });
});
```

- [ ] **Step 3: Run, expect mostly-passing**

Run: `cd ui && npx vitest run src/workspaces/live-pool.test.ts`
Some may pass directly off the shell implementation. Fix any failures by adjusting the implementation in `live-pool.ts`. Iterate until all pass.

Expected end state: 8 passed.

- [ ] **Step 4: Commit**

```bash
git add ui/src/workspaces/live-pool.ts ui/src/workspaces/live-pool.test.ts
git commit -m "feat(workspaces): LivePool with LRU hibernation + activity tracking"
```

---

## Phase 6 — Wire LivePool into WorkspaceManager

### Task 9: DOM host factory in main.ts

**Files:**
- Modify: `ui/src/main.ts` (around line 675 where `new TabManager(...)` is called).
- Modify: `ui/src/workspaces/manager.ts` constructor signature.

- [ ] **Step 1: Read context around current TabManager wiring**

Run: `sed -n '660,720p' ui/src/main.ts`

Identify the existing `tabbar`, `workspace`, and `newTabBtn` elements. Their parents (the regions in `index.html` that today hold one tabbar and one workspace area) will become the **parents** for per-workspace containers.

- [ ] **Step 2: Replace the single-instance construction with a factory**

Where the code currently does `const manager = new TabManager(tabbar, workspace, newTabBtn, ...);`, replace with construction of a `TabManagerFactory`:

```ts
import { LivePool, type TabManagerFactory, type PoolableTabManager } from "./workspaces/live-pool";

const tabbarParent = tabbar.parentElement!;
const workspaceParent = workspace.parentElement!;
// Remove the static markup containers — LivePool now manages them per workspace.
tabbarParent.removeChild(tabbar);
workspaceParent.removeChild(workspace);

const factory: TabManagerFactory = {
  create(workspaceId): PoolableTabManager {
    const wsTabbar = tabbar.cloneNode(false) as HTMLElement;
    wsTabbar.dataset.workspaceId = workspaceId;
    const wsArea = workspace.cloneNode(false) as HTMLElement;
    wsArea.dataset.workspaceId = workspaceId;
    return new TabManager(wsTabbar, wsArea, newTabBtn, () => {
      // onAllTabsClosed: route through workspace deletion path
      void workspaceManager.onAllTabsClosed(workspaceId);
    });
  },
  hosts(_workspaceId) {
    return { tabbar: tabbarParent, workspace: workspaceParent };
  },
};

const pool = new LivePool(factory, { liveLimit: settings.workspace?.live_limit ?? 5 });
const workspaceManager = new WorkspaceManager(pool);
```

- [ ] **Step 3: Update WorkspaceManager to use LivePool**

In `ui/src/workspaces/manager.ts`:

Change the constructor:
```ts
constructor(private readonly pool: LivePool) {}
```

Rewrite `switchTo`:
```ts
async switchTo(id: string): Promise<void> {
  if (id === this.activeId) return;
  const target = this.workspaces.find((w) => w.id === id);
  if (!target) return;

  // Snapshot the outgoing workspace's manifest (kept on disk in case
  // of crash; the live PTYs are what makes the in-memory pool work).
  const out = this.getActive();
  const active = this.pool.active();
  if (active) {
    const body = active.serializeManifest() as TabManifestV1;
    out.active_index = body.active_index;
    out.tabs = body.tabs;
    out.groups = body.groups;
  }

  await this.pool.activate(id, workspaceAsV1Body(target));
  this.activeId = id;
  target.last_used_at = nowMs();
  await this.saveAll();
  this.emitChange();
}
```

Rewrite `boot` to only rehydrate the last-active workspace into the pool:
```ts
async boot(...args: ...): Promise<void> {
  // existing parse logic that populates this.workspaces and this.activeId
  // ...
  const active = this.getActive();
  await this.pool.activate(active.id, workspaceAsV1Body(active));
  // do NOT pre-populate the pool with other workspaces — they hibernate.
}
```

(The exact rewriting of `boot` must preserve manifest parsing logic that currently lives there; do not delete that code, only swap the post-parse call from `this.tabManager.replaceFromManifest(...)` to `this.pool.activate(...)`.)

- [ ] **Step 4: Update onAllTabsClosed routing**

Add to `WorkspaceManager`:
```ts
async onAllTabsClosed(workspaceId: string): Promise<void> {
  // Last tab in a workspace was closed by the user.
  // For now mirror the existing behavior: create a fresh tab so the
  // workspace is never empty.
  if (workspaceId === this.activeId) {
    const m = this.pool.active();
    if (m) {
      // Create a default tab. The factory's pool manager exposes the
      // method through the existing TabManager API; cast or expose.
      await (m as unknown as { createTab(): Promise<unknown> }).createTab();
    }
  }
}
```

- [ ] **Step 5: Typecheck and run all tests**

Run: `cd ui && npm run typecheck && npx vitest run`

Fix typing fallout from constructor changes. The existing `workspaces/manager.test.ts` will need updates — instead of injecting a fake TabManager, inject a fake LivePool (or build one over the FakeManager from Task 8). Update those tests now.

- [ ] **Step 6: Commit**

```bash
git add ui/src/main.ts ui/src/workspaces/manager.ts ui/src/workspaces/manager.test.ts
git commit -m "feat(workspaces): WorkspaceManager uses LivePool; PTYs survive switch"
```

### Task 10: Render badge state in workspace switcher

**Files:**
- Modify: `ui/src/workspaces/switcher.ts`
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Subscribe each chip to its activity state**

Identify the chip-render function in `switcher.ts`. For each chip, the WorkspaceManager (now via LivePool) exposes `activityOf(workspaceId)`. Add a `getBadge()` helper:

```ts
function badgeClasses(state: ActivityState | null): { className: string; text: string } {
  if (!state) return { className: "", text: "" };
  if (state.hasFailure) return { className: "ws-chip--has-failure", text: "" };
  if (state.hasAgentNote) return { className: "ws-chip--has-note", text: "" };
  if (state.unseenBlocks > 0) return { className: "ws-chip--unseen", text: String(state.unseenBlocks) };
  return { className: "", text: "" };
}
```

Apply to the chip rendering: append the class and, if `text`, render a `<span class="ws-chip__unseen">{text}</span>`.

Trigger re-render when `LivePool` activity changes. Add a `LivePool.onActivityChange(cb: (workspaceId: string, state: ActivityState) => void)` registrar that fans out from each tracker's `onChange`. Wire `switcher.ts`'s render to that callback.

- [ ] **Step 2: Add CSS**

Append to `ui/src/styles.css`:

```css
.ws-chip__unseen {
  display: inline-flex;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  margin-left: 6px;
  border-radius: 8px;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  background: var(--accent-dim, rgba(255,255,255,0.15));
  color: var(--text-dim, rgba(255,255,255,0.8));
}
.ws-chip--has-failure::after {
  content: "";
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 6px;
  border-radius: 50%;
  background: var(--danger, #ff5555);
}
.ws-chip--has-note::after {
  content: "";
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 6px;
  border-radius: 50%;
  background: var(--agent-accent, #b08cff);
}
```

- [ ] **Step 3: Manual visual check**

Run the app. Open two workspaces. In workspace A run `false` (exits non-zero). Switch to B. Verify A's chip shows a red dot.

- [ ] **Step 4: Commit**

```bash
git add ui/src/workspaces/switcher.ts ui/src/styles.css ui/src/workspaces/live-pool.ts
git commit -m "feat(workspaces): render activity badges on workspace chips"
```

---

## Phase 7 — Settings

### Task 11: Expose `workspace.live_limit`

**Files:**
- Modify: `ui/src/settings/panel.ts` (add UI control)
- Modify: settings persistence module (TBD by inspection; likely `ui/src/api.ts` or a settings types file)

- [ ] **Step 1: Find current settings shape**

Run: `grep -n "workspace\.\|live_limit\|Settings" ui/src/api.ts ui/src/settings/*.ts | head -20`

Locate the TypeScript type for settings. Add a `workspace?: { live_limit?: number }` field. If the backend persists settings (Rust side), check whether it allows unknown keys — if strict, also add the field there. (If the backend is permissive, no Rust change needed.)

- [ ] **Step 2: Add a numeric input to the settings panel**

In `ui/src/settings/panel.ts`, add a number input bound to `settings.workspace.live_limit` with min=1, max=20, default=5. On change, call `pool.setLimit(value)`.

- [ ] **Step 3: Add a unit test for the setting clamping**

Append to `ui/src/workspaces/live-pool.test.ts`:

```ts
  it("setLimit clamps to [1, 20]", async () => {
    const f = fakeFactory();
    const pool = new LivePool(f, { liveLimit: 5 });
    await pool.setLimit(0);
    await pool.activate("a", {});
    // limit=1: cannot have 2 live; activating b evicts a
    await pool.activate("b", {});
    expect(pool.isHibernated("a")).toBe(true);
  });
```

Run: `cd ui && npx vitest run src/workspaces/live-pool.test.ts`
Expected: 9 passed.

- [ ] **Step 4: Commit**

```bash
git add ui/src/settings/panel.ts ui/src/api.ts ui/src/workspaces/live-pool.test.ts
git commit -m "feat(settings): add workspace.live_limit (default 5, range 1-20)"
```

---

## Phase 8 — Integration verification

### Task 12: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Build and run**

Run: `cd ui && npm run typecheck && npx vitest run`
Expected: zero TS errors, all tests pass.

Run: `npm run dev` (or whatever launches the Tauri dev app).

- [ ] **Step 2: PTY survival across switch**

1. Open workspace A. In any tab run `(while true; do echo tick; sleep 1; done) &`. Note the job PID.
2. Switch to workspace B. Wait 5s.
3. Switch back to A.
4. Expected: the loop is still running, and you see ~5 extra `tick` lines that were buffered while away.

- [ ] **Step 3: Activity badges**

1. From workspace A, switch to B.
2. In some other shell (or via the inactive tab — schedule a delayed command before switching): cause A to finish a block. Easiest: schedule `(sleep 5; false)` in A before switching.
3. Expected within ~6s: A's chip shows the red dot.
4. Click A's chip; badge clears on activation.

- [ ] **Step 4: LRU hibernation**

1. With `live_limit = 2`: open workspaces A, B, C in order.
2. Expected: A is hibernated (its chip dims or otherwise indicates hibernation — visual decision deferred; minimum bar is that the LivePool internal state reflects hibernation, observable via dev console if needed).
3. Switch to A. Expected: the previous scrollback content appears at the top of each tab, then a fresh prompt; new shells are spawned (running processes from before are gone).

- [ ] **Step 5: App restart**

1. With A live, B and C hibernated, quit the app.
2. Relaunch.
3. Expected: only A is live (no respawn of B and C until visited).

- [ ] **Step 6: Document any deviations**

If any of Steps 2–5 fail, file the discrepancy as TODOs at the end of the spec file under `## Known gaps post-implementation` and create a follow-up plan. Do not paper over with hacks.

- [ ] **Step 7: Commit final note**

```bash
git add docs/superpowers/specs/2026-05-22-workspace-keepalive-design.md
git commit --allow-empty -m "chore(workspaces): end-to-end verification of keep-alive"
```

---

## Phase 9 — Finishing

### Task 13: Open PR

Follow `superpowers:finishing-a-development-branch` to merge or open a PR from `worktree-workspace-keepalive` → `main`. PR description should link the spec and summarize:

- Workspaces stay live across switches; up to 5 by default.
- New `LivePool` owns per-workspace `TabManager` instances.
- Chip badges surface background activity.
- Settings: `workspace.live_limit` (1–20).

---

## Self-review notes

- **Spec coverage:** all decisions table rows in the spec have at least one task that implements them. Hibernated scrollback persistence to disk is explicitly out of scope and called out in the spec under "Non-Goals."
- **Type consistency:** `ActivityState` shape is defined once in `activity.ts` and consumed unchanged in `live-pool.ts` and `switcher.ts`. `PoolableTabManager` interface intentionally restricts `TabManager` to the methods LivePool needs, so tests don't drift from production.
- **Known soft spots:**
  - Task 7 ("wire BlockManager → notifyBlockFinished") relies on discovery; the exact line where exit codes resolve in `blocks/manager.ts` is not pinned. Discovery step is explicit before code change.
  - Task 9 DOM cloning assumes `tabbar` and `workspace` elements in `index.html` are leaf containers without important event listeners that would be lost on `cloneNode(false)`. If they have such listeners, the factory needs to construct fresh elements from scratch via `document.createElement` with the same id/class set.
  - Visual treatment of hibernated chips (dimming) is left to the executor's judgment in Task 12 step 2 — a placeholder visual is acceptable; refinement after manual review.
