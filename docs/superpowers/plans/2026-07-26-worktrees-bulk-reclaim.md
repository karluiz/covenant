# Worktrees Triage + Bulk Reclaim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group the Worktrees page list by lifecycle state and add a one-click "Reclaim all" for the SPENT group, plus a "Branch" fact explaining why a spent worktree is safe to delete.

**Architecture:** All changes live in `ui/src/worktrees/`. A new pure module `groups.ts` partitions worktrees into display-ordered state groups with per-group size totals; `index.ts` renders group headers (SPENT gets the bulk button) and a new detail fact; `worktrees.css` gets header styles. Backend untouched — `worktreeReclaim(cwd, paths[])` already batches and the Rust side refuses non-spent/orphan paths.

**Tech Stack:** TypeScript (strict), Vitest + jsdom, vanilla DOM (no framework), Covenant theme tokens.

## Global Constraints

- Sharp corners: `border-radius: 0` on any new chrome (50% dots exempt).
- Tooltips only via `attachTooltip` — never `element.title`.
- Confirmations only via `pushConfirmToast` — never `window.confirm` (blocks the webview).
- All copy in English.
- Run tests from repo root: `npx vitest run ui/src/worktrees/ --root .` (npm test also works).
- Conventional Commits.

---

### Task 1: `groups.ts` — pure grouping + reclaim-path helpers

**Files:**
- Create: `ui/src/worktrees/groups.ts`
- Test: `ui/src/worktrees/groups.test.ts`

**Interfaces:**
- Consumes: `GitWorktreeSummary` from `../api`, `WorktreeState` from `../status/worktree-state`.
- Produces:
  - `interface WorktreeGroup { state: WorktreeState; worktrees: GitWorktreeSummary[]; totalKb: number | null }`
  - `groupWorktrees(wts: GitWorktreeSummary[], sizes: ReadonlyMap<string, { total: number; target: number }>): WorktreeGroup[]` — fixed order spent, stale, orphan, active; empty groups omitted; rows size-desc within a group (missing size last); `totalKb` is `null` unless every member's size is loaded.
  - `spentReclaimPaths(wts: GitWorktreeSummary[]): string[]` — paths of spent worktrees excluding `current` and `is_main`.

- [ ] **Step 1: Write the failing test**

`ui/src/worktrees/groups.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupWorktrees, spentReclaimPaths } from "./groups";
import type { GitWorktreeSummary } from "../api";

function wt(over: Partial<GitWorktreeSummary>): GitWorktreeSummary {
  return {
    path: "/w", branch: "b", head: "abc", current: false, detached: false,
    bare: false, dirty_count: 0, state: "active", merged: false,
    last_commit_unix: null, off_convention: false, is_main: false, locked: null,
    ...over,
  };
}

describe("groupWorktrees", () => {
  it("orders groups spent→stale→orphan→active, omits empty, sorts size-desc", () => {
    const wts = [
      wt({ path: "/act", state: "active" }),
      wt({ path: "/sp-small", state: "spent" }),
      wt({ path: "/sp-big", state: "spent" }),
      wt({ path: "/st", state: "stale" }),
    ];
    const sizes = new Map([
      ["/act", { total: 100, target: 0 }],
      ["/sp-small", { total: 10, target: 0 }],
      ["/sp-big", { total: 90, target: 0 }],
      ["/st", { total: 50, target: 0 }],
    ]);
    const groups = groupWorktrees(wts, sizes);
    expect(groups.map((g) => g.state)).toEqual(["spent", "stale", "active"]);
    expect(groups[0].worktrees.map((w) => w.path)).toEqual(["/sp-big", "/sp-small"]);
    expect(groups[0].totalKb).toBe(100);
  });

  it("reports totalKb null until every member size is loaded, missing-size rows last", () => {
    const wts = [wt({ path: "/a", state: "spent" }), wt({ path: "/b", state: "spent" })];
    const sizes = new Map([["/b", { total: 5, target: 0 }]]);
    const groups = groupWorktrees(wts, sizes);
    expect(groups[0].totalKb).toBeNull();
    expect(groups[0].worktrees.map((w) => w.path)).toEqual(["/b", "/a"]);
  });
});

describe("spentReclaimPaths", () => {
  it("returns spent paths, excluding current and main", () => {
    const wts = [
      wt({ path: "/sp", state: "spent" }),
      wt({ path: "/sp-here", state: "spent", current: true }),
      wt({ path: "/sp-main", state: "spent", is_main: true }),
      wt({ path: "/act", state: "active" }),
    ];
    expect(spentReclaimPaths(wts)).toEqual(["/sp"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/worktrees/groups.test.ts --root .`
Expected: FAIL — cannot resolve `./groups`.

- [ ] **Step 3: Write the implementation**

`ui/src/worktrees/groups.ts`:

```ts
import type { GitWorktreeSummary } from "../api";
import type { WorktreeState } from "../status/worktree-state";

/** Display order: deletable first — the page's job is disk triage. */
const GROUP_ORDER: WorktreeState[] = ["spent", "stale", "orphan", "active"];

export interface WorktreeGroup {
  state: WorktreeState;
  worktrees: GitWorktreeSummary[];
  /** Sum of member sizes in KB — null until every member's size is loaded. */
  totalKb: number | null;
}

export function groupWorktrees(
  wts: GitWorktreeSummary[],
  sizes: ReadonlyMap<string, { total: number; target: number }>,
): WorktreeGroup[] {
  const out: WorktreeGroup[] = [];
  for (const state of GROUP_ORDER) {
    const members = wts.filter((w) => w.state === state);
    if (!members.length) continue;
    const size = (p: string) => sizes.get(p)?.total ?? -1;
    members.sort((a, b) => size(b.path) - size(a.path));
    const allLoaded = members.every((w) => sizes.has(w.path));
    const totalKb = allLoaded
      ? members.reduce((sum, w) => sum + (sizes.get(w.path)?.total ?? 0), 0)
      : null;
    out.push({ state, worktrees: members, totalKb });
  }
  return out;
}

/** Bulk-reclaim candidates: spent only, never the calling or main worktree.
 *  The Rust reclaim re-verifies each path is spent/orphan regardless. */
export function spentReclaimPaths(wts: GitWorktreeSummary[]): string[] {
  return wts.filter((w) => w.state === "spent" && !w.current && !w.is_main).map((w) => w.path);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/worktrees/groups.test.ts --root .`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/worktrees/groups.ts ui/src/worktrees/groups.test.ts
git commit -m "feat(worktrees): pure state-grouping + bulk reclaim-path helpers"
```

---

### Task 2: Grouped list render + "Reclaim all" bulk action

**Files:**
- Modify: `ui/src/worktrees/index.ts` (`renderList`, ~lines 122–167; remove `sortedWorktrees`)
- Modify: `ui/src/worktrees/worktrees.css` (append group-header styles)
- Test: `ui/src/worktrees/index.test.ts` (extend)

**Interfaces:**
- Consumes: `groupWorktrees`, `spentReclaimPaths`, `WorktreeGroup` from `./groups` (Task 1); existing `worktreeReclaim(cwd, paths): Promise<ReclaimOutcome[]>` where `ReclaimOutcome = { path: string; removed: boolean; reason: string | null }`; `pushConfirmToast({ message, confirmLabel, onConfirm })`, `pushInfoToast({ message })`; `humanSize(kb)`; `worktreeStateLabel(state)`, `STATE_HELP[state]`, `attachTooltip`.
- Produces: DOM — `.wt-group-head` header per group containing `.wt-group-label`, `.wt-group-meta`, and (SPENT only, when candidates exist) `button.wt-group-reclaim`; `.wt-row` markup unchanged.

- [ ] **Step 1: Write the failing test**

In `ui/src/worktrees/index.test.ts`, the api mock currently returns zero worktrees. Make the mocked summary data controllable and add a grouped-render test. Replace the whole `vi.mock("../api", ...)` block and add the test:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// The surface fetches repo data on open; stub the api so the test is DOM-only.
const summary = {
  repo_name: "r", repo_root: "/r", current_branch: "main", detached_head: null,
  dirty_count: 0, branches: [], worktrees: [] as unknown[], default_branch: "main",
};
const reclaimMock = vi.fn(async (_cwd: string, paths: string[]) =>
  paths.map((path) => ({ path, removed: true, reason: null })));
vi.mock("../api", () => ({
  gitRepoSummary: vi.fn(async () => summary),
  worktreeSizes: vi.fn(async () => []),
  devLiveWorktreeRoot: vi.fn(async () => null),
  worktreeDetail: vi.fn(async () => ({ last_subject: "s", insertions: 0, deletions: 0 })),
  gitChanges: vi.fn(async () => ({ staged: [], unstaged: [] })),
  worktreeReclaim: (...args: [string, string[]]) => reclaimMock(...args),
}));

import { WorktreesSurface } from "./index";

function wt(over: Record<string, unknown>): unknown {
  return {
    path: "/w", branch: "b", head: "abc", current: false, detached: false,
    bare: false, dirty_count: 0, state: "active", merged: false,
    last_commit_unix: null, off_convention: false, is_main: false, locked: null,
    ...over,
  };
}

function mount(): { host: HTMLElement; surface: WorktreesSurface } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const surface = new WorktreesSurface(host, {
    onOpenTab: () => {}, onResumeAgent: () => {}, getOccupiedCwds: () => new Set(),
  });
  return { host, surface };
}
```

Keep the existing open/close test (adapt it to use `mount()`), and add:

```ts
  it("renders state group headers with a Reclaim all button on SPENT", async () => {
    summary.worktrees = [
      wt({ path: "/r", branch: "main", is_main: true, current: true, state: "active" }),
      wt({ path: "/r/.covenant/worktrees/a", branch: "agent/a", state: "spent", merged: true }),
      wt({ path: "/r/.covenant/worktrees/b", branch: "agent/b", state: "spent", merged: true }),
    ];
    const { host, surface } = mount();
    await surface.open("/r");

    const heads = [...host.querySelectorAll(".wt-group-head .wt-group-label")].map((el) => el.textContent);
    expect(heads).toEqual(["spent", "active"]);
    const meta = host.querySelector(".wt-group-head .wt-group-meta");
    expect(meta?.textContent).toContain("2 worktrees");

    const btn = host.querySelector<HTMLButtonElement>(".wt-group-reclaim");
    expect(btn).not.toBeNull();
    btn!.click();
    // Confirm toast is app chrome; the reclaim call itself fires from onConfirm —
    // covered by asserting the button wires spentReclaimPaths, so simulate confirm:
    surface.close();
  });
```

Note: `pushConfirmToast` renders into app chrome outside the surface host. To keep the test DOM-only, ALSO mock the toast module at the top of the file so confirm runs synchronously:

```ts
vi.mock("../notifications/toast", () => ({
  pushConfirmToast: (o: { onConfirm: () => void }) => o.onConfirm(),
  pushInfoToast: vi.fn(),
}));
```

Then the test's click assertion becomes concrete:

```ts
    btn!.click();
    expect(reclaimMock).toHaveBeenCalledWith("/r", [
      "/r/.covenant/worktrees/a", "/r/.covenant/worktrees/b",
    ]);
```

Also reset between tests: in `beforeEach`, add `summary.worktrees = []; reclaimMock.mockClear();`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/worktrees/index.test.ts --root .`
Expected: FAIL — no `.wt-group-head` elements rendered.

- [ ] **Step 3: Implement grouped render + bulk action in `index.ts`**

Imports to add:

```ts
import { groupWorktrees, spentReclaimPaths, type WorktreeGroup } from "./groups";
import { worktreeReclaim } from "../api"; // already imported — verify
```

Delete `sortedWorktrees()` (index.ts:122–125). Replace `renderList` body:

```ts
  private renderList(host: HTMLElement): void {
    host.innerHTML = "";
    const wts = this.summary?.worktrees ?? [];
    const maxKb = Math.max(1, ...[...this.sizes.values()].map((s) => s.total));
    for (const group of groupWorktrees(wts, this.sizes)) {
      host.appendChild(this.renderGroupHead(group));
      for (const wt of group.worktrees) host.appendChild(this.renderRow(wt, maxKb));
    }
  }

  /// Group header: state label + count/total, and the one bulk verb on SPENT.
  private renderGroupHead(group: WorktreeGroup): HTMLElement {
    const head = document.createElement("div");
    head.className = "wt-group-head";
    const dot = document.createElement("span");
    dot.className = `wt-dot ${worktreeStateClass(group.state)}`;
    const label = document.createElement("span");
    label.className = "wt-group-label";
    label.textContent = worktreeStateLabel(group.state);
    attachTooltip(label, STATE_HELP[group.state]);
    const meta = document.createElement("span");
    meta.className = "wt-group-meta";
    const n = group.worktrees.length;
    meta.textContent = `${n} ${n === 1 ? "worktree" : "worktrees"}`
      + (group.totalKb !== null ? ` · ${humanSize(group.totalKb)}` : "");
    head.append(dot, label, meta);

    const paths = group.state === "spent" ? spentReclaimPaths(group.worktrees) : [];
    if (paths.length) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wt-group-reclaim";
      btn.innerHTML = `${Icons.trash({ size: 12 })}<span>Reclaim all</span>`;
      attachTooltip(btn, ACTION_HELP.reclaim!);
      btn.addEventListener("click", () => this.reclaimAll(paths));
      head.appendChild(btn);
    }
    return head;
  }
```

Extract the existing per-row DOM (the body of the old `for` loop, index.ts:130–165, unchanged) into `private renderRow(wt: GitWorktreeSummary, maxKb: number): HTMLElement` returning the `row` button.

Add the bulk action:

```ts
  /// Bulk reclaim every spent worktree. Freed KB is estimated from the cached
  /// sizes map (du of a deleted path is gone by the time we could re-measure).
  private reclaimAll(paths: string[]): void {
    const freedKb = paths.reduce((sum, p) => sum + (this.sizes.get(p)?.total ?? 0), 0);
    const freed = freedKb > 0 ? ` and free ~${humanSize(freedKb)}` : "";
    pushConfirmToast({
      message: `Remove ${paths.length} spent worktrees${freed}? Their branches are already merged or gone.`,
      confirmLabel: "Reclaim all",
      onConfirm: () => {
        void worktreeReclaim(this.repoRoot, paths)
          .then((outcomes) => {
            const removed = outcomes.filter((o) => o.removed);
            const refused = outcomes.filter((o) => !o.removed);
            const freedDone = removed.reduce((sum, o) => sum + (this.sizes.get(o.path)?.total ?? 0), 0);
            let msg = `Reclaimed ${removed.length}`;
            if (freedDone > 0) msg += ` · freed ~${humanSize(freedDone)}`;
            for (const o of refused) msg += ` · ${compactPath(o.path)} refused: ${o.reason ?? "unknown"}`;
            pushInfoToast({ message: msg });
            this.selected = null;
            void this.refresh();
          })
          .catch((e) => pushInfoToast({ message: `Reclaim failed: ${String(e)}` }));
      },
    });
  }
```

Append to `worktrees.css`:

```css
/* State group headers — uppercase label + count/total, sticky so the section
   you are scrolling through stays named. SPENT carries the one bulk verb. */
.wt-group-head {
  position: sticky; top: 0; z-index: 1;
  display: flex; align-items: center; gap: 8px;
  padding: 10px 16px 6px;
  background: var(--bg-overlay);
  border-bottom: 1px solid var(--border);
}
.wt-group-head .wt-dot { width: 7px; height: 7px; }
.wt-group-label {
  font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
}
.wt-group-meta { font-size: 11px; color: var(--fg-dim, #888); font-variant-numeric: tabular-nums; }
.wt-group-reclaim {
  display: inline-flex; align-items: center; gap: 5px; margin-left: auto;
  padding: 3px 8px; font-size: 11px; line-height: 1; cursor: pointer;
  background: transparent; color: var(--danger, #c0483f);
  border: 1px solid rgb(var(--danger-rgb, 192 72 63) / 0.35); border-radius: 0;
  transition: background 120ms ease, border-color 120ms ease;
}
.wt-group-reclaim svg { opacity: 0.7; }
.wt-group-reclaim:hover {
  background: rgb(var(--danger-rgb, 192 72 63) / 0.1);
  border-color: rgb(var(--danger-rgb, 192 72 63) / 0.55);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run ui/src/worktrees/ --root .`
Expected: PASS (all worktrees tests, including the new grouped-render test).

- [ ] **Step 5: Commit**

```bash
git add ui/src/worktrees/index.ts ui/src/worktrees/index.test.ts ui/src/worktrees/worktrees.css
git commit -m "feat(worktrees): group list by state + Reclaim-all-spent bulk action"
```

---

### Task 3: "Branch" fact — why a spent worktree is safe to delete

**Files:**
- Modify: `ui/src/worktrees/format.ts` (add `branchFact`)
- Modify: `ui/src/worktrees/index.ts` (`renderDetail` facts, ~line 245)
- Test: `ui/src/worktrees/format.test.ts` (create)

**Interfaces:**
- Consumes: `GitWorktreeSummary` (`state`, `merged`, `branch`, `detached`, `is_main`), `GitRepoSummary.default_branch`.
- Produces: `branchFact(wt: GitWorktreeSummary, defaultBranch: string): string | null` — null for main (nothing to explain), `merged into <default_branch>` / `deleted upstream` for spent, else branch name or `detached`.

- [ ] **Step 1: Write the failing test**

`ui/src/worktrees/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { branchFact } from "./format";
import type { GitWorktreeSummary } from "../api";

function wt(over: Partial<GitWorktreeSummary>): GitWorktreeSummary {
  return {
    path: "/w", branch: "agent/x", head: "abc", current: false, detached: false,
    bare: false, dirty_count: 0, state: "active", merged: false,
    last_commit_unix: null, off_convention: false, is_main: false, locked: null,
    ...over,
  };
}

describe("branchFact", () => {
  it("explains WHY a spent worktree is safe", () => {
    expect(branchFact(wt({ state: "spent", merged: true }), "main")).toBe("merged into main");
    expect(branchFact(wt({ state: "spent", merged: false, branch: null }), "main")).toBe("deleted upstream");
  });
  it("falls back to the branch name otherwise, null for main", () => {
    expect(branchFact(wt({}), "main")).toBe("agent/x");
    expect(branchFact(wt({ branch: null, detached: true }), "main")).toBe("detached");
    expect(branchFact(wt({ is_main: true, branch: "main" }), "main")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/worktrees/format.test.ts --root .`
Expected: FAIL — `branchFact` not exported.

- [ ] **Step 3: Implement**

Append to `ui/src/worktrees/format.ts`:

```ts
/** Why-it's-safe copy for the detail Branch fact. Spent must justify the
 *  delete verb: "merged into <default>" or "deleted upstream" — the word
 *  "spent" alone doesn't. Null for main (nothing to explain). */
export function branchFact(wt: GitWorktreeSummary, defaultBranch: string): string | null {
  if (wt.is_main) return null;
  if (wt.state === "spent") return wt.merged ? `merged into ${defaultBranch}` : "deleted upstream";
  if (wt.branch) return wt.branch;
  return wt.detached ? "detached" : null;
}
```

In `index.ts` `renderDetail`, import `branchFact` from `./format` and extend the facts line (currently `facts.append(fact("Last commit", when), fact("Working tree", tree), fact("Disk", disk));`):

```ts
    const branch = branchFact(wt, this.summary?.default_branch ?? "main");
    facts.append(fact("Last commit", when), fact("Working tree", tree), fact("Disk", disk));
    if (branch) facts.append(fact("Branch", branch));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run ui/src/worktrees/ --root .`
Expected: PASS.

- [ ] **Step 5: Full verification + commit**

Run: `npm test` (repo root) and `npm run build` (type-check).
Expected: no new failures (main has pre-existing test failures unrelated to worktrees — compare against a pre-change run if unsure).

```bash
git add ui/src/worktrees/format.ts ui/src/worktrees/format.test.ts ui/src/worktrees/index.ts
git commit -m "feat(worktrees): Branch fact explains why spent is safe to reclaim"
```
