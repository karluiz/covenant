# Structure Tree Worktree Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Files-tree header path a selector that pins the tree to any worktree (or main) without touching the terminal.

**Architecture:** All pin state lives inside `StructureTree` (`ui/src/structure/tree.ts`). `setCwd` is reinterpreted as "the terminal reports its cwd" — recorded always, ignored while pinned. The header label upgrades to a dropdown (existing `ContextMenu`) when `gitRepoSummary(cwd)` reports >1 worktree. `tabs/manager.ts` is untouched; both tree instances (terminal + ACP) inherit the feature.

**Tech Stack:** TypeScript strict, Vitest (jsdom), existing `ContextMenu`, existing Tauri command `git_repo_summary`.

**Spec:** `docs/superpowers/specs/2026-07-23-structure-tree-worktree-selector-design.md`

## Global Constraints

- Run tests from repo ROOT: `npm test -- ui/src/structure/tree.test.ts` (never from `ui/`).
- Sharp corners: any new chrome uses `border-radius: 0` (DESIGN.md).
- Icons are inline SVG via `Icons.*` — never emoji, never external assets.
- New interactive elements get tooltips via `attachTooltip`, never `element.title`.
- All UI copy in English.
- No `as any` without a justifying comment; TS strict mode.
- Commit granularity: one commit per task (user prefers feature-level commits, not per-TDD-step).
- Working directory for all commands: `/Users/carlosgallardoarenas/Sources/karlTerminal/.covenant/worktrees/agent-claude-0723-eyv`.

---

### Task 1: Pin state — `setCwd` refactor, `pinTo` / `unpin`, auto-unpin on refresh failure

**Files:**
- Modify: `ui/src/structure/tree.ts` (fields near line 127; `setCwd` at ~line 483; `refreshRoot` catch at ~line 620)
- Test: `ui/src/structure/tree.test.ts`

**Interfaces:**
- Consumes: existing private `refreshRoot()`, `renderHeader(cwd)`, `renderBranch(cwd)`, `loadExpanded(cwd)`.
- Produces: `async pinTo(path: string): Promise<void>`, `async unpin(): Promise<void>`, `getter pinned: string | null` (Task 2 reads these; `setCwd(cwd: string)` keeps its signature).

- [ ] **Step 1: Write failing tests**

Add a new `describe` block to `ui/src/structure/tree.test.ts` **before** the branch-chip describe (it must keep running last — see comment in the file's mock factory). Reuse the existing `entry()` / `flush()` helpers and mocks:

```ts
describe("StructureTree worktree pin", () => {
  let host: HTMLDivElement;
  let tree: StructureTree;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    listDirMock.mockReset();
    listDirMock.mockResolvedValue([entry("/wt/a.md", "a.md", "file")]);
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    tree = new StructureTree(host, () => undefined);
  });

  it("setCwd while pinned records the cwd but does not re-root", async () => {
    await tree.setCwd("/main");
    await flush();
    await tree.pinTo("/wt");
    await flush();
    await tree.setCwd("/main/sub");
    await flush();
    // Tree still rooted at the pinned path: listDir was never asked for /main/sub.
    const calls = listDirMock.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain("/main/sub");
    expect(tree.pinned).toBe("/wt");
  });

  it("unpin re-roots to the last terminal cwd", async () => {
    await tree.setCwd("/main");
    await flush();
    await tree.pinTo("/wt");
    await flush();
    await tree.setCwd("/main/sub"); // recorded while pinned
    await tree.unpin();
    await flush();
    const calls = listDirMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("/main/sub");
    expect(tree.pinned).toBeNull();
  });

  it("refresh failure while pinned auto-unpins back to terminal cwd", async () => {
    await tree.setCwd("/main");
    await flush();
    listDirMock.mockRejectedValueOnce(new Error("gone"));
    await tree.pinTo("/wt-deleted");
    await flush();
    expect(tree.pinned).toBeNull();
    // Fell back to re-listing the terminal cwd.
    const calls = listDirMock.mock.calls.map((c) => c[0]);
    expect(calls.filter((c) => c === "/main").length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- ui/src/structure/tree.test.ts`
Expected: FAIL — `tree.pinTo is not a function` (and the other two for the same reason).

- [ ] **Step 3: Implement pin state in `tree.ts`**

Add fields next to the other private state (near `refreshGen`, ~line 123):

```ts
  /// Worktree root the view is pinned to, or null when following the
  /// terminal's cwd. While pinned, `setCwd` records but does not re-root.
  private pinnedRoot: string | null = null;
  /// Last cwd the terminal reported — the root `unpin()` returns to.
  private lastTerminalCwd: string | null = null;
```

Replace the existing `setCwd` (~line 483) with a thin wrapper plus a private `reroot` holding the old body, and add `pinTo` / `unpin` / `pinned`:

```ts
  /// The terminal reports its cwd. Recorded always; while the view is
  /// pinned to another worktree the report does not re-root the tree.
  async setCwd(cwd: string): Promise<void> {
    this.lastTerminalCwd = cwd;
    if (this.pinnedRoot) return;
    await this.reroot(cwd);
  }

  /// Pin the view to a sibling worktree root. Shell cds stop re-rooting
  /// the tree until `unpin()`.
  async pinTo(path: string): Promise<void> {
    this.pinnedRoot = path;
    await this.reroot(path);
    if (this.cwd) this.renderHeader(this.cwd); // reroot may early-return; indicator must still update
  }

  /// Return to following the terminal's cwd.
  async unpin(): Promise<void> {
    this.pinnedRoot = null;
    if (this.lastTerminalCwd) await this.reroot(this.lastTerminalCwd);
    if (this.cwd) this.renderHeader(this.cwd);
  }

  get pinned(): string | null {
    return this.pinnedRoot;
  }

  /// Re-root the tree at `cwd`. Idempotent: passing the same cwd re-uses
  /// the existing expanded state from localStorage. Triggers a fresh
  /// `list_dir` against the new root.
  private async reroot(cwd: string): Promise<void> {
    if (this.cwd === cwd && this.nodes.length > 0) return;
    this.clearActive();
    this.activePath = null;
    this.cwd = cwd;
    this.expandedPaths = loadExpanded(cwd);
    this.renderHeader(cwd);
    this.renderBranch(cwd);
    await this.refreshRoot();
  }
```

In `refreshRoot`'s catch (~line 620), auto-unpin before showing the error:

```ts
    } catch (err) {
      if (gen !== this.refreshGen) return;
      // Pinned worktree vanished (pruned/deleted) — fall back to the terminal.
      if (this.pinnedRoot === cwd && this.lastTerminalCwd) {
        this.pinnedRoot = null;
        void this.reroot(this.lastTerminalCwd);
        return;
      }
      this.showError(String(err));
      return;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- ui/src/structure/tree.test.ts`
Expected: PASS, including all pre-existing tests in the file (the `setCwd` refactor must not break them).

- [ ] **Step 5: Commit**

```bash
git add ui/src/structure/tree.ts ui/src/structure/tree.test.ts
git commit -m "feat(structure): pinnable tree root — setCwd records, pinTo/unpin re-root"
```

---

### Task 2: Header selector — pin icon, chevron label, worktree dropdown, CSS

**Files:**
- Modify: `ui/src/icons/index.ts` (add `pin` icon, next to `check` at ~line 480)
- Modify: `ui/src/structure/tree.ts` (`renderHeader` at ~line 513; imports at top)
- Modify: `ui/src/styles.css` (after `.structure-cwd` at ~line 8667)
- Test: `ui/src/structure/tree.test.ts` (extend mock factory + new describe)

**Interfaces:**
- Consumes: `pinTo` / `unpin` / `pinned` from Task 1; `gitRepoSummary(cwd): Promise<GitRepoSummary>` from `ui/src/api.ts` (`worktrees: GitWorktreeSummary[]` with `path`, `branch`, `is_main`); `ContextMenu.show(x, y, items)` via the existing `this.contextMenu` (line 127); `attachTooltip` (already imported).
- Produces: nothing consumed by later tasks (final task).

- [ ] **Step 1: Add `pin` icon**

In `ui/src/icons/index.ts`, next to `check`:

```ts
  /** Pin — view pinned to a worktree. Lucide `pin`. */
  pin: (o?: IconOptions): string =>
    svg(
      `<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>`,
      o,
    ),
```

- [ ] **Step 2: Extend the test mock and write failing tests**

In `ui/src/structure/tree.test.ts`, add `gitRepoSummary` to the `vi.mock("../api", …)` factory (tree.ts will now import it — without this the mocked module lacks the export and every test crashes):

```ts
  // Default: not enough worktrees to grow the selector. Selector tests override.
  gitRepoSummary: vi.fn().mockResolvedValue({ worktrees: [] }),
```

Import it alongside the others and alias like the existing mocks:

```ts
import { structureListDir, structureMoveInto, getDirContext, gitRepoSummary } from "../api";
const repoSummaryMock = gitRepoSummary as unknown as ReturnType<typeof vi.fn>;
```

Add a describe (again before the branch-chip block). A helper builds the two-worktree payload:

```ts
describe("StructureTree worktree selector header", () => {
  let host: HTMLDivElement;
  let tree: StructureTree;

  const twoWorktrees = {
    worktrees: [
      { path: "/repo", branch: "main", is_main: true },
      { path: "/repo/.covenant/worktrees/wt-a", branch: "agent/wt-a", is_main: false },
    ],
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    listDirMock.mockReset();
    listDirMock.mockResolvedValue([entry("/repo/a.md", "a.md", "file")]);
    repoSummaryMock.mockReset();
    repoSummaryMock.mockResolvedValue({ worktrees: [] });
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    tree = new StructureTree(host, () => undefined);
  });

  it("keeps the plain label when the repo has one worktree", async () => {
    repoSummaryMock.mockResolvedValue({ worktrees: [{ path: "/repo", branch: "main", is_main: true }] });
    await tree.setCwd("/repo");
    await flush();
    const label = host.querySelector(".structure-cwd")!;
    expect(label.classList.contains("structure-cwd-selector")).toBe(false);
  });

  it("upgrades the label to a selector when the repo has sibling worktrees", async () => {
    repoSummaryMock.mockResolvedValue(twoWorktrees);
    await tree.setCwd("/repo");
    await flush();
    const label = host.querySelector(".structure-cwd")!;
    expect(label.classList.contains("structure-cwd-selector")).toBe(true);
    expect(label.querySelector(".structure-cwd-chevron")).not.toBeNull();
  });

  it("shows the pin indicator while pinned", async () => {
    repoSummaryMock.mockResolvedValue(twoWorktrees);
    await tree.setCwd("/repo");
    await flush();
    await tree.pinTo("/repo/.covenant/worktrees/wt-a");
    await flush();
    expect(host.querySelector(".structure-cwd-pin")).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npm test -- ui/src/structure/tree.test.ts`
Expected: the two selector/pin tests FAIL (no `structure-cwd-selector` class); everything else PASSES.

- [ ] **Step 4: Implement the selector in `renderHeader`**

In `ui/src/structure/tree.ts`: add `gitRepoSummary, type GitRepoSummary` to the existing `../api` import block. In `renderHeader(cwd)`, right after `this.headerEl.appendChild(label)` (~line 519), add the pin indicator and the async upgrade:

```ts
    if (this.pinnedRoot) {
      const pin = document.createElement("span");
      pin.className = "structure-cwd-pin";
      pin.innerHTML = Icons.pin({ size: 10 });
      label.prepend(pin);
    }
    this.decorateWorktreeSelector(cwd, label);
```

Add the two private methods (near `renderBranch`):

```ts
  /// Upgrade the plain cwd label into a worktree selector when the repo
  /// has sibling worktrees. Async probe; a stale result (re-rooted while
  /// awaiting, or header rebuilt) is dropped via the isConnected check.
  private decorateWorktreeSelector(cwd: string, label: HTMLElement): void {
    void gitRepoSummary(cwd)
      .then((repo) => {
        if (this.cwd !== cwd || !label.isConnected) return;
        if (repo.worktrees.length < 2) return;
        label.classList.add("structure-cwd-selector");
        const chevron = document.createElement("span");
        chevron.className = "structure-cwd-chevron";
        chevron.innerHTML = Icons.chevronsUpDown({ size: 10 });
        label.appendChild(chevron);
        label.setAttribute("role", "button");
        label.setAttribute("tabindex", "0");
        label.removeAttribute("title");
        attachTooltip(
          label,
          this.pinnedRoot
            ? `Pinned to ${cwd} — click to change`
            : "Switch which worktree the tree shows",
        );
        label.addEventListener("click", () => this.openWorktreeMenu(label, repo));
      })
      .catch(() => {
        /* not a repo or probe failed — stay a plain label */
      });
  }

  /// Dropdown listing "Follow terminal" + every worktree (main first).
  private openWorktreeMenu(anchor: HTMLElement, repo: GitRepoSummary): void {
    const viewed = this.cwd;
    const inTree = (root: string): boolean =>
      viewed === root || (viewed?.startsWith(root + "/") ?? false);
    const rows = [...repo.worktrees].sort(
      (a, b) => Number(b.is_main) - Number(a.is_main),
    );
    const items: MenuItem[] = [
      {
        label: "Follow terminal",
        icon: this.pinnedRoot ? undefined : Icons.check({ size: 12 }),
        onClick: () => void this.unpin(),
      },
      { divider: true },
      ...rows.map((wt) => ({
        label: wt.path.split("/").pop() ?? wt.path,
        icon: inTree(wt.path) ? Icons.check({ size: 12 }) : undefined,
        badge: wt.is_main ? "MAIN" : undefined,
        shortcut: wt.branch ?? undefined,
        onClick: () => void this.pinTo(wt.path),
      })),
    ];
    const r = anchor.getBoundingClientRect();
    this.contextMenu.show(r.left, r.bottom + 4, items);
  }
```

- [ ] **Step 5: Add CSS**

In `ui/src/styles.css`, after the `.structure-cwd` rule (~line 8672):

```css
.structure-cwd-selector { cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.structure-cwd-selector:hover { color: var(--text-primary); }
.structure-cwd-chevron svg, .structure-cwd-pin svg { flex-shrink: 0; vertical-align: -1px; }
.structure-cwd-pin { color: var(--text-primary); margin-right: 2px; }
```

(No border-radius anywhere; the dropdown reuses `.ctx-menu` chrome as-is.)

- [ ] **Step 6: Run the full suite and type-check**

Run: `npm test -- ui/src/structure/tree.test.ts`
Expected: PASS (all describes).
Run: `npm run build`
Expected: type-check + bundle succeed.

- [ ] **Step 7: Commit**

```bash
git add ui/src/icons/index.ts ui/src/structure/tree.ts ui/src/structure/tree.test.ts ui/src/styles.css
git commit -m "feat(structure): worktree selector on the tree header path"
```

---

## Manual verification (after both tasks)

1. `npm run tauri:dev`, open a terminal in a repo with worktrees (this one qualifies).
2. Header path shows a chevron → click → dropdown lists Follow terminal / main (MAIN badge) / worktrees with branch names.
3. Pick main → tree re-roots, pin icon appears, branch chip shows main's branch; `cd` in the terminal does NOT move the tree.
4. Follow terminal → tree snaps back to the shell's cwd.
5. Editor opens + Changes button operate on the viewed root.
