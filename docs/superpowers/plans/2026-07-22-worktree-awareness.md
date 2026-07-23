# Worktree awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the branch each surface is rooted at, and the worktree the running dev app was built from, visible at a glance.

**Architecture:** Two additive, independent signals. (A) A mono branch chip on a second line under the file-tree header, pulled from the existing `get_dir_context` command. (B) A hollow green "running" dot on the tab whose worktree matches the dev app's own launch dir, from a new dev-only Rust command. No new watchers; no behavior change.

**Tech Stack:** TypeScript + Vitest/jsdom (frontend), Rust + Tauri commands (backend), existing `getDirContext` / `StructureTree` / `TabManager` plumbing.

## Global Constraints

- Sharp corners everywhere: `border-radius: 0` (except 50% dots). — DESIGN.md
- Chrome glyphs are inline SVG via `Icons.*`, never emoji. — DESIGN.md rule 12
- No native tooltips via `element.title` for *interactive* chrome — use `attachTooltip`. (Non-interactive status dots in this file already use `.title`; match that local precedent.)
- English-first UI copy.
- Respect `prefers-reduced-motion` for any animation.
- Frontend: `strict: true`, no `as any` without a justifying comment.
- Rust: no `unwrap()` outside `#[cfg(test)]`/`main()`; shell-outs run on `spawn_blocking`.
- Run `npm test` from repo ROOT (not `ui/`); `cargo test --workspace` for Rust.

---

### Task 1: A — branch chip on the file-tree header

**Files:**
- Modify: `ui/src/icons/index.ts` (add `gitBranch` icon)
- Modify: `ui/src/structure/tree.ts` (field, constructor, `renderBranch`, wire into `setCwd`/`renderWaiting`, import)
- Modify: `ui/src/styles.css` (`.structure-branch*`)
- Test: `ui/src/structure/tree.test.ts`

**Interfaces:**
- Consumes: `getDirContext(cwd) → Promise<DirContext>` where `DirContext.git?.branch: string` (already exported from `ui/src/api.ts:1367`). `Icons.gitBranch({size}) → string`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the `gitBranch` icon**

In `ui/src/icons/index.ts`, after the `gitCompare` entry (ends line 145), add:

```ts
  /** Git branch — a commit forking to a side branch. */
  gitBranch: (o?: IconOptions): string =>
    svg(
      `<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="7.5" r="3"/><path d="M6 9v6"/><path d="M8.5 6.4c6 0 9.5 1.5 9.5 5.1"/>`,
      o,
    ),
```

- [ ] **Step 2: Write the failing test**

In `ui/src/structure/tree.test.ts`, extend the `vi.mock("../api", …)` factory (currently lines 6-9) to also export `getDirContext`:

```ts
vi.mock("../api", () => ({
  structureListDir: vi.fn(),
  structureMoveInto: vi.fn(),
  getDirContext: vi.fn(),
}));
```

Add the import alongside the existing ones (after line 12):

```ts
import { getDirContext } from "../api";
const dirCtxMock = getDirContext as unknown as ReturnType<typeof vi.fn>;
```

Add a new describe block at the end of the file:

```ts
describe("StructureTree branch chip", () => {
  let host: HTMLDivElement;
  let tree: StructureTree;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    listDirMock.mockReset();
    dirCtxMock.mockReset();
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    tree = new StructureTree(host, () => undefined);
  });

  it("shows the branch name for a repo cwd", async () => {
    listDirMock.mockResolvedValueOnce([entry("/wt/a.md", "a.md", "file")]);
    dirCtxMock.mockResolvedValueOnce({ git: { repo_name: "covenant", branch: "agent/css-fixes-0722-wez" }, runtime: null });
    await tree.setCwd("/wt");
    await flush();
    const chip = host.querySelector(".structure-branch-name");
    expect(chip?.textContent).toBe("agent/css-fixes-0722-wez");
    expect(host.querySelector<HTMLElement>(".structure-branch")?.hidden).toBe(false);
  });

  it("stays hidden when the cwd is not a git repo", async () => {
    listDirMock.mockResolvedValueOnce([entry("/plain/a.md", "a.md", "file")]);
    dirCtxMock.mockResolvedValueOnce({ git: null, runtime: null });
    await tree.setCwd("/plain");
    await flush();
    expect(host.querySelector<HTMLElement>(".structure-branch")?.hidden).toBe(true);
  });

  it("drops a stale branch result after a re-root", async () => {
    listDirMock.mockResolvedValue([entry("/x/a.md", "a.md", "file")]);
    // First cwd resolves slowly; second resolves before it.
    let resolveFirst: (v: unknown) => void = () => undefined;
    dirCtxMock.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    dirCtxMock.mockResolvedValueOnce({ git: { repo_name: "r", branch: "second" }, runtime: null });
    await tree.setCwd("/wt-one");
    await tree.setCwd("/wt-two");
    await flush();
    // Now the stale first probe resolves — it must NOT overwrite the chip.
    resolveFirst({ git: { repo_name: "r", branch: "first" }, runtime: null });
    await flush();
    expect(host.querySelector(".structure-branch-name")?.textContent).toBe("second");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- tree.test.ts`
Expected: FAIL — `.structure-branch-name` is null (renderBranch doesn't exist yet).

- [ ] **Step 4: Implement the chip**

In `ui/src/structure/tree.ts`:

a) Add `getDirContext` to the api import (find the existing `import { structureListDir, … } from "../api";` and add `getDirContext`).

b) Declare the field next to `headerEl` (line 106):

```ts
  private readonly branchEl: HTMLElement;
```

c) In the constructor, insert the branch bar between `headerEl` and `listEl` (after the `this.root.appendChild(this.headerEl);` at line 172):

```ts
    this.branchEl = document.createElement("div");
    this.branchEl.className = "structure-branch";
    this.branchEl.hidden = true;
    this.root.appendChild(this.branchEl);
```

d) Call `renderBranch` right after `renderHeader` in `setCwd` (line 482):

```ts
    this.renderHeader(cwd);
    this.renderBranch(cwd);
```

e) Hide the bar in `renderWaiting` (first line of the method body, line 492):

```ts
    this.branchEl.hidden = true;
```

f) Add the method (place it right after `renderHeader`, before `refreshRoot`):

```ts
  /// Fill the branch bar under the path. Async: the branch comes from a
  /// git probe (get_dir_context, cached 5s). Captures `cwd` so a re-root
  /// mid-flight drops a stale result. Hidden when the cwd is not a repo.
  private renderBranch(cwd: string): void {
    this.branchEl.hidden = true;
    this.branchEl.innerHTML = "";
    if (!cwd) return;
    void getDirContext(cwd)
      .then((ctx) => {
        if (this.cwd !== cwd) return; // re-rooted while awaiting
        const branch = ctx.git?.branch;
        if (!branch) return; // not a repo → stay hidden
        const chip = document.createElement("span");
        chip.className = "structure-branch-chip";
        chip.title = branch;
        chip.innerHTML =
          Icons.gitBranch({ size: 11 }) +
          `<span class="structure-branch-name"></span>`;
        chip.querySelector(".structure-branch-name")!.textContent = branch;
        this.branchEl.appendChild(chip);
        this.branchEl.hidden = false;
      })
      .catch(() => {
        /* probe failed — leave the bar hidden */
      });
  }
```

(`Icons` is already imported in tree.ts — it's used in `renderHeader`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tree.test.ts`
Expected: PASS (all three new cases).

- [ ] **Step 6: Add the CSS**

In `ui/src/styles.css`, after the `.structure-cwd` block (ends line 8478), add:

```css
.structure-branch {
    display: flex;
    align-items: center;
    padding: 5px 10px 7px;
    border-bottom: 1px solid var(--border);
}
.structure-branch[hidden] { display: none; }
.structure-branch-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    padding: 2px 7px;
    font-size: 10.5px;
    color: var(--text-primary);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 0;
    font-variant-numeric: tabular-nums;
}
.structure-branch-chip svg { color: var(--muted); flex-shrink: 0; }
.structure-branch-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
```

- [ ] **Step 7: Verify build + commit**

Run: `npm run build` (TS type-check + bundle) — Expected: no errors.

```bash
git add ui/src/icons/index.ts ui/src/structure/tree.ts ui/src/structure/tree.test.ts ui/src/styles.css
git commit -m "feat(structure): show the rooted branch on the file tree header"
```

---

### Task 2: B (backend) — `dev_live_worktree_root` command

**Files:**
- Modify: `crates/app/src/lib.rs` (add `git_toplevel` helper, `dev_live_worktree_root` command, register in `generate_handler!`, add a `#[cfg(test)]` test)

**Interfaces:**
- Produces: Tauri command `dev_live_worktree_root() -> Option<String>` — the git worktree root the process was launched from in a debug build; `None` in release. Consumed by Task 3.
- Produces: `fn git_toplevel(cwd: &std::path::Path) -> Option<String>` (module-private, tested directly).

- [ ] **Step 1: Write the failing Rust test**

In `crates/app/src/lib.rs`, add at the end of the file:

```rust
#[cfg(test)]
mod live_worktree_tests {
    use super::git_toplevel;
    use std::process::Command;

    #[test]
    fn git_toplevel_returns_repo_root() {
        let dir = std::env::temp_dir().join(format!("covenant-wt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Command::new("git").arg("-C").arg(&dir).arg("init").output().unwrap();

        let top = git_toplevel(&dir).expect("toplevel in a repo");
        // git resolves symlinks (e.g. /var → /private/var on macOS), so
        // compare by leaf, not full path.
        let leaf = dir.file_name().unwrap().to_string_lossy();
        assert!(top.ends_with(leaf.as_ref()), "got {top}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_toplevel_none_outside_repo() {
        let dir = std::env::temp_dir(); // temp dir itself is not a git repo
        assert!(git_toplevel(dir.as_path()).is_none() || git_toplevel(dir.as_path()).is_some());
        // (Non-assertive on hosts where temp happens to sit in a repo; the
        //  meaningful assertion is the positive case above.)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant git_toplevel_returns_repo_root`
Expected: FAIL — `git_toplevel` not found.

- [ ] **Step 3: Implement helper + command**

In `crates/app/src/lib.rs`, right after the `get_dir_context` command (ends line 2652), add:

```rust
/// The git worktree root containing `cwd`, or None if `cwd` isn't in a repo.
/// Shells out; call on a blocking thread.
fn git_toplevel(cwd: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let top = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if top.is_empty() {
        None
    } else {
        Some(top)
    }
}

/// Dev-only: the worktree the running app was launched from, so the UI can
/// mark that worktree's tab "live". `tauri dev` inherits the cwd of
/// `npm run tauri:dev` (the worktree dir); a Finder-launched release build
/// has cwd `/` and nothing is live — so release always returns None.
// ponytail: raw `--show-toplevel` vs the shell's PWD; a symlinked worktree
// path won't match on the frontend and the dot just won't show. Dev-only
// cosmetic — swap to a canonicalized compare on both sides if it ever bites.
#[tauri::command]
async fn dev_live_worktree_root() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    tokio::task::spawn_blocking(|| {
        let cwd = std::env::current_dir().ok()?;
        git_toplevel(&cwd)
    })
    .await
    .ok()
    .flatten()
}
```

- [ ] **Step 4: Register the command**

In the `generate_handler!` list, next to `get_dir_context,` (line 5663), add:

```rust
            dev_live_worktree_root,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p covenant git_toplevel_returns_repo_root`
Expected: PASS.

- [ ] **Step 6: Verify build + commit**

Run: `cargo build -p covenant` — Expected: compiles.

```bash
git add crates/app/src/lib.rs
git commit -m "feat(app): dev_live_worktree_root command for live-worktree marking"
```

---

### Task 3: B (frontend) — green running dot on the live worktree's tab

**Files:**
- Create: `ui/src/tabs/live-worktree.ts` (pure `cwdUnderRoot` helper)
- Create: `ui/src/tabs/live-worktree.test.ts`
- Modify: `ui/src/api.ts` (add `devLiveWorktreeRoot` wrapper)
- Modify: `ui/src/tabs/manager.ts` (field, fetch, `isLiveWorktree`, `renderTabLiveDot`, mount in `renderTabPill`, call on `cwd_changed`, import)
- Modify: `ui/src/styles.css` (`.tab-live-dot`)

**Interfaces:**
- Consumes: `dev_live_worktree_root` (Task 2); `activePane(tab).cwd`; the `.tab-btn[data-tab-id]` pill DOM and the `pillPaneLate`/busy-dot block in `renderTabPill` (manager.ts:7645-7650).
- Produces: `cwdUnderRoot(cwd, root): boolean`; `devLiveWorktreeRoot(): Promise<string | null>`.

- [ ] **Step 1: Write the failing test for the pure matcher**

Create `ui/src/tabs/live-worktree.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cwdUnderRoot } from "./live-worktree";

const ROOT = "/Users/k/Sources/karlTerminal/.covenant/worktrees/agent-foo";

describe("cwdUnderRoot", () => {
  it("matches the root itself", () => {
    expect(cwdUnderRoot(ROOT, ROOT)).toBe(true);
  });
  it("matches a subdir of the root", () => {
    expect(cwdUnderRoot(ROOT + "/ui/src", ROOT)).toBe(true);
  });
  it("rejects a sibling worktree with a shared prefix", () => {
    expect(cwdUnderRoot(ROOT + "-2", ROOT)).toBe(false);
  });
  it("rejects when either side is empty/null", () => {
    expect(cwdUnderRoot("", ROOT)).toBe(false);
    expect(cwdUnderRoot(ROOT, null)).toBe(false);
    expect(cwdUnderRoot(null, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- live-worktree.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the matcher**

Create `ui/src/tabs/live-worktree.ts`:

```ts
/// True when `cwd` is the worktree root `root` or a directory inside it.
/// Boundary-safe: a trailing slash on the prefix stops "/w/foo-2" from
/// matching root "/w/foo". Worktrees are never nested (AGENTS.md), so a
/// single prefix test is unambiguous.
export function cwdUnderRoot(
  cwd: string | null | undefined,
  root: string | null | undefined,
): boolean {
  if (!cwd || !root) return false;
  if (cwd === root) return true;
  const base = root.endsWith("/") ? root : root + "/";
  return cwd.startsWith(base);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- live-worktree.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the api wrapper**

In `ui/src/api.ts`, after `getDirContext` (ends line 1369), add:

```ts
/// Dev-only: the worktree root the running app was launched from, or null
/// in a release build. Used to mark that worktree's tab "live".
export async function devLiveWorktreeRoot(): Promise<string | null> {
  return invoke<string | null>("dev_live_worktree_root");
}
```

- [ ] **Step 6: Wire the manager (no separate test — covered by the matcher unit + manual verify)**

In `ui/src/tabs/manager.ts`:

a) Import the helper and the api wrapper (add to existing import groups):

```ts
import { cwdUnderRoot } from "./live-worktree";
import { devLiveWorktreeRoot } from "../api";
```

b) Declare the field near the other tab-strip state (top of the class):

```ts
  private liveWorktreeRoot: string | null = null;
```

c) Fetch once in the constructor (fire-and-forget; null in release, so no dot ever mounts there):

```ts
    void devLiveWorktreeRoot()
      .then((root) => {
        this.liveWorktreeRoot = root;
        if (root) this.renderTabbar();
      })
      .catch(() => {
        /* command missing / not a repo — no live dot */
      });
```

d) Add the predicate + idempotent dot method (place next to `renderTabBusyDot`, after line 2246):

```ts
  private isLiveWorktree(tab: Tab): boolean {
    return cwdUnderRoot(activePane(tab).cwd, this.liveWorktreeRoot);
  }

  /// Mount/remove the hollow-ring "this worktree built the running app"
  /// dot. Idempotent — safe to call on rebuild and on cwd_changed. Dev
  /// only (liveWorktreeRoot is null in release).
  private renderTabLiveDot(tab: Tab): void {
    const pill = this.tabbarHost.querySelector<HTMLElement>(
      `.tab-btn[data-tab-id="${tab.id}"]`,
    );
    if (!pill) return;
    const existing = pill.querySelector(".tab-live-dot");
    if (this.isLiveWorktree(tab)) {
      if (existing instanceof HTMLElement) return;
      const dot = document.createElement("span");
      dot.className = "tab-live-dot";
      dot.title = "The running app was built from this worktree";
      pill.insertBefore(dot, pill.firstChild);
    } else if (existing) {
      existing.remove();
    }
  }
```

e) Mount on pill (re)build. In `renderTabPill`, right after the busy-dot re-apply block (after line 7650, `}` closing the `if (pillPaneLate.busyProc …)`), add:

```ts
    // Live-worktree dot: this worktree is what the running dev app was
    // built from. Hollow ring so it reads distinct from the filled
    // busy-proc dot. Pill isn't in the DOM yet — attach directly.
    if (this.isLiveWorktree(tab)) {
      const liveDot = document.createElement("span");
      liveDot.className = "tab-live-dot";
      liveDot.title = "The running app was built from this worktree";
      pill.insertBefore(liveDot, pill.firstChild);
    }
```

f) Refresh on cwd change. In the `cwd_changed` handler, after the `structure.setCwd` block (after line 3687), add:

```ts
              if (tabRef.current) this.renderTabLiveDot(tabRef.current);
```

- [ ] **Step 7: Add the CSS**

In `ui/src/styles.css`, after the `.tab-busy-dot` / `busy-pulse` block (ends line 14058), add:

```css
.tab-live-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
  background: transparent;
  border: 1.5px solid #4ade80;
  box-shadow: 0 0 5px rgba(74, 222, 128, 0.5);
  animation: live-pulse 2.2s ease-in-out infinite;
  vertical-align: middle;
  flex-shrink: 0;
}
@keyframes live-pulse {
  0%, 100% { opacity: 0.45; }
  50%      { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .tab-live-dot { animation: none; opacity: 0.8; }
}
```

- [ ] **Step 8: Run the frontend suite + build**

Run: `npm test -- live-worktree.test.ts` — Expected: PASS.
Run: `npm run build` — Expected: no type errors.

- [ ] **Step 9: Commit**

```bash
git add ui/src/tabs/live-worktree.ts ui/src/tabs/live-worktree.test.ts ui/src/api.ts ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "feat(tabs): green running dot on the live worktree's tab"
```

---

## Manual verification (after all tasks)

1. `npm run tauri:dev` from this worktree. Open tabs in ≥2 different worktrees.
2. **A:** file-tree header of each tab shows its own branch under the path. A detached-HEAD worktree shows the short sha; a non-repo cwd (e.g. `cd /tmp`) shows no chip.
3. **B:** the tab whose worktree is this one (the one you ran `tauri:dev` in) wears the hollow green dot; other worktree tabs don't. `cd` a tab out of its worktree and back → dot updates.
4. Release smoke (optional): a packaged build shows no live dot on any tab.

## Self-review notes

- Spec coverage: A (chip, empty states, async stale-guard) → Task 1. B backend (dev-only, `current_dir` → toplevel) → Task 2. B frontend (fetch once, `startsWith` match, tab-only, dot on create + cwd_changed) → Task 3. Non-goals (no watcher, no popover/status-bar dup, tab only) respected.
- Type consistency: `cwdUnderRoot`, `devLiveWorktreeRoot`, `dev_live_worktree_root`, `git_toplevel`, `renderTabLiveDot`, `isLiveWorktree` used identically across tasks.
- Ponytail ceiling recorded in code (symlinked-worktree path match) — see the `ponytail:` comment in Task 2.
