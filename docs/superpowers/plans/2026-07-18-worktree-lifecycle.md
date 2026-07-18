# Worktree Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Covenant say which git worktrees are dead and let the user reclaim them in one confirmed action.

**Architecture:** Extend the existing `GitWorktreeSummary` with a derived lifecycle state (never stored — computed from git on every summary), then surface that state in the git popover, which already lists every worktree. Mutations (`reclaim`, `relocate`) re-derive state server-side and refuse anything not provably safe. No new UI surface: the popover becomes the ledger.

**Tech Stack:** Rust (`crates/app/src/git_tools.rs`, `std::process::Command` over git), TypeScript (`ui/src/status/bar.ts`, `ui/src/api.ts`), CSS (`ui/src/styles.css`), tests via `cargo test` + `vitest`.

**Spec:** `docs/superpowers/specs/2026-07-18-worktree-lifecycle-design.md`

## Global Constraints

- No `unwrap()` outside `#[cfg(test)]` and `main()`.
- Errors: `thiserror` in library crates, `anyhow` only at the `app` binary boundary. `git_tools.rs` returns `Result<_, String>` — follow the file's existing convention.
- Public types derive `Debug` + `Clone`; anything crossing IPC derives `Serialize`.
- TypeScript `strict: true`. No `as any` without a justifying comment.
- All new panels/rows: `border-radius: 0` (DESIGN.md hard rule). Exception: 50% dots.
- Chrome glyphs are inline SVG via `Icons.*`, never emoji (DESIGN.md rule 12).
- Never `element.title` for tooltips — always `attachTooltip` (DESIGN.md).
- UI copy is English.
- Canonical worktree root is `.covenant/worktrees/` — harness-neutral. Never `.claude/worktrees/`.
- Stale threshold: **14 days**.
- Run tests from repo ROOT: `npm test`, `cargo test --workspace`.
- `cargo fmt --all` && `cargo clippy --workspace --all-targets` before the final commit.

## Design refinements over the spec

Two corrections found while planning. Both are already reflected below; update the spec to match.

1. **No new Canon section.** The spec called for a Worktrees section in `.rail-*` chrome. The git popover already lists worktrees with sections, counts, search, and per-row buttons. Adding state + actions there delivers the whole feature with zero new surface. Cheaper and it puts the diagnosis where the user already looks.
2. **`Active` is defined without "commits ahead".** The spec's phrasing ("commits ahead of main, or dirty, or a live tab") collides with `Stale`, since every unmerged branch is ahead. The working definition: **current worktree, or dirty, or unmerged-and-recent**. `Stale` is unmerged-clean-and-old. These are disjoint.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `crates/app/src/git_tools.rs` | Worktree parsing, state derivation, reclaim/relocate | Modify |
| `crates/app/src/lib.rs` | Tauri command registration | Modify |
| `ui/src/api.ts` | Typed IPC wrappers + `GitWorktreeSummary` type | Modify |
| `ui/src/status/bar.ts` | Git popover rendering + reclaim/relocate actions | Modify |
| `ui/src/status/worktree-state.ts` | State label/dot mapping, pure, unit-testable | Create |
| `ui/src/status/worktree-state.test.ts` | Tests for the above | Create |
| `ui/src/styles.css` | State dot colors | Modify |

---

### Task 1: Derive the lifecycle state

**Files:**
- Modify: `crates/app/src/git_tools.rs` (add types + derivation; extend `GitWorktreeSummary` at :17-25, extend `parse_worktree_list` construction at :162-172, extend `repo_summary` at :66-70)
- Test: `crates/app/src/git_tools.rs` (`mod tests`)

**Interfaces:**
- Consumes: existing `GitWorktreeSummary`, `git()`, `status_count()`, `canonical_or_self()`, test helpers `git_run()` / `init_repo()`
- Produces: `WorktreeState` enum; `GitWorktreeSummary.state`, `.merged`, `.last_commit_unix`; `pub const STALE_AFTER_DAYS: i64`; `fn derive_state(...) -> WorktreeState`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `crates/app/src/git_tools.rs`:

```rust
    const DAY: i64 = 86_400;

    #[test]
    fn orphan_wins_over_everything() {
        // Path gone from disk: nothing else matters.
        let s = derive_state(
            /* path_exists */ false,
            /* current */ false,
            /* dirty */ 3,
            /* merged */ true,
            /* last_commit */ Some(0),
            /* now */ 100 * DAY,
        );
        assert_eq!(s, WorktreeState::Orphan);
    }

    #[test]
    fn the_current_worktree_is_always_active() {
        // Merged and clean, but it is where the user is standing.
        let s = derive_state(true, true, 0, true, Some(100 * DAY), 100 * DAY);
        assert_eq!(s, WorktreeState::Active);
    }

    #[test]
    fn dirty_beats_merged() {
        // Merged but with uncommitted work: never propose deleting this.
        let s = derive_state(true, false, 1, true, Some(100 * DAY), 100 * DAY);
        assert_eq!(s, WorktreeState::Active);
    }

    #[test]
    fn merged_and_clean_is_spent() {
        let s = derive_state(true, false, 0, true, Some(100 * DAY), 100 * DAY);
        assert_eq!(s, WorktreeState::Spent);
    }

    #[test]
    fn unmerged_clean_and_old_is_stale() {
        let now = 100 * DAY;
        let s = derive_state(true, false, 0, false, Some(now - 15 * DAY), now);
        assert_eq!(s, WorktreeState::Stale);
    }

    #[test]
    fn unmerged_clean_and_recent_is_active() {
        let now = 100 * DAY;
        let s = derive_state(true, false, 0, false, Some(now - 13 * DAY), now);
        assert_eq!(s, WorktreeState::Active);
    }

    #[test]
    fn stale_boundary_is_exclusive_at_fourteen_days() {
        let now = 100 * DAY;
        // Exactly 14 days is not yet stale.
        assert_eq!(
            derive_state(true, false, 0, false, Some(now - 14 * DAY), now),
            WorktreeState::Active
        );
        assert_eq!(
            derive_state(true, false, 0, false, Some(now - 14 * DAY - 1), now),
            WorktreeState::Stale
        );
    }

    #[test]
    fn unknown_commit_date_defaults_to_active() {
        // Unclassifiable must never be deletable.
        let s = derive_state(true, false, 0, false, None, 100 * DAY);
        assert_eq!(s, WorktreeState::Active);
    }

    #[test]
    fn repo_summary_marks_a_merged_worktree_spent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let base = String::from_utf8(
            std::process::Command::new("git")
                .arg("-C").arg(root)
                .args(["branch", "--show-current"])
                .output().unwrap().stdout,
        ).unwrap().trim().to_string();

        let wt = root.join("wt-merged");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "done"]);
        std::fs::write(wt.join("tracked.txt"), "changed\n").unwrap();
        git_run(&wt, &["add", "."]);
        git_run(&wt, &["commit", "-q", "-m", "work"]);
        git_run(root, &["merge", "-q", "--no-ff", "-m", "merge", "done"]);

        let summary = repo_summary(root).unwrap();
        let row = summary.worktrees.iter()
            .find(|w| w.branch.as_deref() == Some("done"))
            .expect("worktree present");
        assert!(row.merged, "branch was merged into {base}");
        assert_eq!(row.state, WorktreeState::Spent);
        assert!(row.last_commit_unix.is_some());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant-app git_tools:: 2>&1 | tail -20`
Expected: FAIL — `cannot find function 'derive_state'`, `cannot find type 'WorktreeState'`.

(If the package name differs, use `cargo test --workspace git_tools::`.)

- [ ] **Step 3: Add the state type and derivation**

In `crates/app/src/git_tools.rs`, above `GitWorktreeSummary`:

```rust
/// A worktree stops being stale-eligible for this long after its last commit.
pub const STALE_AFTER_DAYS: i64 = 14;

/// Where Covenant puts worktrees. Harness-neutral on purpose: adopting any one
/// executor's default (`.claude/worktrees/`) would make that executor's
/// convention everyone's problem.
pub const CANONICAL_WORKTREE_DIR: &str = ".covenant/worktrees";

/// Derived on every summary, never stored. See the design spec for the
/// precedence rationale.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeState {
    /// Where the user is standing, has uncommitted work, or is recent unmerged work.
    Active,
    /// Unmerged and clean, but untouched for `STALE_AFTER_DAYS`. Needs a human decision.
    Stale,
    /// Merged into the default branch and clean. Provably safe to delete.
    Spent,
    /// Registered in git, gone from disk.
    Orphan,
}

/// Precedence: Orphan -> Active -> Spent -> Stale, defaulting to Active.
/// Defaulting to Active is deliberate: anything we cannot classify must never
/// be proposed for deletion.
fn derive_state(
    path_exists: bool,
    current: bool,
    dirty_count: u32,
    merged: bool,
    last_commit_unix: Option<i64>,
    now_unix: i64,
) -> WorktreeState {
    if !path_exists {
        return WorktreeState::Orphan;
    }
    if current || dirty_count > 0 {
        return WorktreeState::Active;
    }
    if merged {
        return WorktreeState::Spent;
    }
    match last_commit_unix {
        Some(ts) if now_unix - ts > STALE_AFTER_DAYS * 86_400 => WorktreeState::Stale,
        _ => WorktreeState::Active,
    }
}
```

Add the three fields to `GitWorktreeSummary` (after `dirty_count`):

```rust
    pub state: WorktreeState,
    pub merged: bool,
    pub last_commit_unix: Option<i64>,
```

In `parse_worktree_list`, the struct literal gains defaults:

```rust
                state: WorktreeState::Active,
                merged: false,
                last_commit_unix: None,
```

- [ ] **Step 4: Populate the fields in `repo_summary`**

Replace the loop at `crates/app/src/git_tools.rs:66-70`:

```rust
    let current_root = canonical_or_self(Path::new(&repo_root));
    let mut worktrees = parse_worktree_list(&git(cwd, &["worktree", "list", "--porcelain"])?);

    let default_branch = default_branch(cwd);
    let merged: std::collections::HashSet<String> = git(
        cwd,
        &["branch", "--merged", &default_branch, "--format=%(refname:short)"],
    )
    .unwrap_or_default()
    .lines()
    .map(|l| l.trim().to_string())
    .filter(|l| !l.is_empty())
    .collect();

    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    for wt in &mut worktrees {
        let wt_path = Path::new(&wt.path);
        let path_exists = wt_path.is_dir();
        wt.current = canonical_or_self(wt_path) == current_root;
        wt.dirty_count = if path_exists {
            status_count(wt_path).unwrap_or(0)
        } else {
            0
        };
        wt.merged = wt
            .branch
            .as_ref()
            .is_some_and(|b| merged.contains(b) && *b != default_branch);
        wt.last_commit_unix = wt.branch.as_ref().and_then(|b| {
            git(cwd, &["log", "-1", "--format=%ct", b])
                .ok()
                .and_then(|s| s.trim().parse::<i64>().ok())
        });
        wt.state = derive_state(
            path_exists,
            wt.current,
            wt.dirty_count,
            wt.merged,
            wt.last_commit_unix,
            now_unix,
        );
    }
```

Add the helper next to `status_count`:

```rust
/// Resolves the repo's default branch: origin's HEAD, else `main`, else `master`.
fn default_branch(cwd: &Path) -> String {
    if let Ok(sym) = git(cwd, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        if let Some(name) = sym.trim().rsplit('/').next() {
            if !name.is_empty() {
                return name.to_string();
            }
        }
    }
    for candidate in ["main", "master"] {
        if git(cwd, &["rev-parse", "--verify", "--quiet", candidate]).is_ok() {
            return candidate.to_string();
        }
    }
    "main".to_string()
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p covenant-app git_tools:: 2>&1 | tail -20`
Expected: PASS, including the pre-existing `parses_worktree_porcelain`.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/git_tools.rs
git commit -m "feat(worktrees): derive a lifecycle state per worktree"
```

---

### Task 2: Flag off-convention worktrees and measure disk

**Files:**
- Modify: `crates/app/src/git_tools.rs`
- Modify: `crates/app/src/lib.rs` (register `worktree_sizes` near `git_repo_summary` at :2567)
- Test: `crates/app/src/git_tools.rs` (`mod tests`)

**Interfaces:**
- Consumes: `CANONICAL_WORKTREE_DIR`, `GitWorktreeSummary`, `canonical_or_self()`
- Produces: `GitWorktreeSummary.off_convention: bool`; `pub fn worktree_slug(branch: &str) -> String`; `pub fn worktree_sizes(paths: Vec<String>) -> Vec<(String, u64)>`; Tauri command `worktree_sizes`

`size_kb` is deliberately NOT on `GitWorktreeSummary`: `du` on 23 worktrees takes seconds and would block every popover open. It is fetched separately and merged in by the frontend.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn worktrees_under_the_canonical_root_are_on_convention() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join(CANONICAL_WORKTREE_DIR).join("feature-x");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "feature-x"]);

        let summary = repo_summary(root).unwrap();
        let row = summary.worktrees.iter()
            .find(|w| w.branch.as_deref() == Some("feature-x")).unwrap();
        assert!(!row.off_convention);
    }

    #[test]
    fn worktrees_outside_the_canonical_root_are_flagged() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join("somewhere-else");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "stray"]);

        let summary = repo_summary(root).unwrap();
        let row = summary.worktrees.iter()
            .find(|w| w.branch.as_deref() == Some("stray")).unwrap();
        assert!(row.off_convention);
    }

    #[test]
    fn the_main_worktree_is_never_off_convention() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let summary = repo_summary(root).unwrap();
        let main_row = summary.worktrees.iter().find(|w| w.current).unwrap();
        assert!(!main_row.off_convention);
    }

    #[test]
    fn slug_strips_branch_prefixes() {
        assert_eq!(worktree_slug("feat/canon-org-rename"), "canon-org-rename");
        assert_eq!(worktree_slug("feature/big-thing"), "big-thing");
        assert_eq!(worktree_slug("fix/notch-focus-gate"), "notch-focus-gate");
        assert_eq!(worktree_slug("chore/deps"), "deps");
        assert_eq!(worktree_slug("worktree-somnus-v2"), "somnus-v2");
        assert_eq!(worktree_slug("plain"), "plain");
        // Nested paths flatten rather than creating directories.
        assert_eq!(worktree_slug("feat/a/b"), "a-b");
    }

    #[test]
    fn sizes_are_reported_for_existing_paths_only() {
        let tmp = tempfile::TempDir::new().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("f"), vec![0u8; 4096]).unwrap();
        let gone = tmp.path().join("gone").to_string_lossy().to_string();

        let out = worktree_sizes(vec![real.to_string_lossy().to_string(), gone]);
        assert_eq!(out.len(), 1, "missing paths are omitted, not zeroed");
        assert!(out[0].1 > 0);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant-app git_tools:: 2>&1 | tail -20`
Expected: FAIL — `no field 'off_convention'`, `cannot find function 'worktree_slug'`, `cannot find function 'worktree_sizes'`.

- [ ] **Step 3: Implement**

Add `pub off_convention: bool,` to `GitWorktreeSummary`, and `off_convention: false,` to the literal in `parse_worktree_list`.

Inside the `for wt in &mut worktrees` loop from Task 1, after `wt.current` is set:

```rust
        let canonical_root = canonical_or_self(&current_root.join(CANONICAL_WORKTREE_DIR));
        wt.off_convention = !wt.current
            && !wt.bare
            && !canonical_or_self(wt_path).starts_with(&canonical_root);
```

Hoist `canonical_root` above the loop so it is computed once.

Add at module level:

```rust
/// Directory name for a worktree of `branch`, under `CANONICAL_WORKTREE_DIR`.
pub fn worktree_slug(branch: &str) -> String {
    let stripped = ["feature/", "feat/", "fix/", "chore/", "worktree-"]
        .iter()
        .find_map(|p| branch.strip_prefix(p))
        .unwrap_or(branch);
    stripped.replace('/', "-")
}

/// Disk usage in KB per path. Missing paths are omitted. Slow — call off the
/// summary path, never inside `repo_summary`.
pub fn worktree_sizes(paths: Vec<String>) -> Vec<(String, u64)> {
    paths
        .into_iter()
        .filter(|p| Path::new(p).is_dir())
        .filter_map(|p| {
            let out = Command::new("du").args(["-sk", &p]).output().ok()?;
            if !out.status.success() {
                return None;
            }
            let text = String::from_utf8_lossy(&out.stdout);
            let kb = text.split_whitespace().next()?.parse::<u64>().ok()?;
            Some((p, kb))
        })
        .collect()
}
```

- [ ] **Step 4: Register the Tauri command**

In `crates/app/src/lib.rs`, next to `git_repo_summary` (:2567):

```rust
#[tauri::command]
async fn worktree_sizes(paths: Vec<String>) -> Result<Vec<(String, u64)>, String> {
    tokio::task::spawn_blocking(move || git_tools::worktree_sizes(paths))
        .await
        .map_err(|e| format!("worktree_sizes join: {e}"))
}
```

Add `worktree_sizes` to the `tauri::generate_handler![...]` list alongside `git_repo_summary`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p covenant-app git_tools:: 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/git_tools.rs crates/app/src/lib.rs
git commit -m "feat(worktrees): flag off-convention paths and report disk usage"
```

---

### Task 3: Stop painting dead worktrees green

**Files:**
- Create: `ui/src/status/worktree-state.ts`
- Create: `ui/src/status/worktree-state.test.ts`
- Modify: `ui/src/api.ts:1360-1368` (`GitWorktreeSummary`)
- Modify: `ui/src/status/bar.ts:974-995` (worktree row rendering)
- Modify: `ui/src/styles.css:6739-6742` (state dot colors)

**Interfaces:**
- Consumes: `GitWorktreeSummary.state`, `.off_convention`, `.merged`
- Produces: `type WorktreeState`; `worktreeStateLabel(state)`; `worktreeStateClass(state)`; `worktreeDefaultAction(wt)`

- [ ] **Step 1: Write the failing test**

Create `ui/src/status/worktree-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { worktreeStateLabel, worktreeStateClass, worktreeDefaultAction } from "./worktree-state";

const wt = (over: Partial<Parameters<typeof worktreeDefaultAction>[0]> = {}) => ({
  path: "/repo/.covenant/worktrees/x",
  branch: "x",
  head: "abc",
  current: false,
  detached: false,
  bare: false,
  dirty_count: 0,
  state: "spent" as const,
  merged: true,
  last_commit_unix: 0,
  off_convention: false,
  ...over,
});

describe("worktree state presentation", () => {
  it("never labels a spent worktree as clean", () => {
    expect(worktreeStateLabel("spent")).toBe("spent");
    expect(worktreeStateLabel("spent")).not.toBe("clean");
  });

  it("gives each state its own dot class", () => {
    const classes = (["active", "stale", "spent", "orphan"] as const).map(worktreeStateClass);
    expect(new Set(classes).size).toBe(4);
    expect(worktreeStateClass("spent")).not.toBe(worktreeStateClass("active"));
  });

  it("reclaims a spent worktree even when it is off-convention", () => {
    // Deleting beats moving: no point relocating something we are about to remove.
    expect(worktreeDefaultAction(wt({ off_convention: true }))).toBe("reclaim");
  });

  it("relocates an off-convention worktree that is still alive", () => {
    expect(worktreeDefaultAction(wt({ state: "active", merged: false, off_convention: true })))
      .toBe("relocate");
  });

  it("offers open for a healthy active worktree", () => {
    expect(worktreeDefaultAction(wt({ state: "active", merged: false }))).toBe("open");
  });

  it("offers prune for an orphan", () => {
    expect(worktreeDefaultAction(wt({ state: "orphan" }))).toBe("prune");
  });

  it("never offers an action for the current worktree", () => {
    expect(worktreeDefaultAction(wt({ current: true, state: "active" }))).toBe("none");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- worktree-state`
Expected: FAIL — `Failed to resolve import "./worktree-state"`.

- [ ] **Step 3: Implement the module**

Create `ui/src/status/worktree-state.ts`:

```ts
import type { GitWorktreeSummary } from "../api";

export type WorktreeState = "active" | "stale" | "spent" | "orphan";
export type WorktreeAction = "open" | "decide" | "reclaim" | "prune" | "relocate" | "none";

const LABELS: Record<WorktreeState, string> = {
  active: "active",
  stale: "stale",
  spent: "spent",
  orphan: "orphan",
};

export function worktreeStateLabel(state: WorktreeState): string {
  return LABELS[state];
}

export function worktreeStateClass(state: WorktreeState): string {
  return `status-git-pop-wt-${state}`;
}

/**
 * One action per worktree — the user accepts a verdict rather than choosing a
 * git command. Lifecycle state wins over the off-convention flag: a spent
 * worktree gets deleted, not moved.
 */
export function worktreeDefaultAction(wt: GitWorktreeSummary): WorktreeAction {
  if (wt.current) return "none";
  if (wt.state === "orphan") return "prune";
  if (wt.state === "spent") return "reclaim";
  if (wt.off_convention) return "relocate";
  if (wt.state === "stale") return "decide";
  return "open";
}
```

- [ ] **Step 4: Extend the API type**

In `ui/src/api.ts`, replace the `GitWorktreeSummary` interface (:1360-1368):

```ts
export interface GitWorktreeSummary {
  path: string;
  branch: string | null;
  head: string | null;
  current: boolean;
  detached: boolean;
  bare: boolean;
  dirty_count: number;
  state: "active" | "stale" | "spent" | "orphan";
  merged: boolean;
  last_commit_unix: number | null;
  off_convention: boolean;
}

export async function worktreeSizes(paths: string[]): Promise<Array<[string, number]>> {
  return invoke<Array<[string, number]>>("worktree_sizes", { paths });
}
```

- [ ] **Step 5: Render the state in the popover**

In `ui/src/status/bar.ts`, add to the imports:

```ts
import { worktreeStateClass, worktreeStateLabel } from "./worktree-state";
```

Replace the `state` const in the worktree map (:977-981):

```ts
        const state = wt.current
          ? `<span class="status-git-pop-badge is-here">here</span>`
          : `<span class="status-git-pop-badge ${worktreeStateClass(wt.state)}">${
            wt.dirty_count > 0
              ? `${wt.dirty_count} changed`
              : escapeHtml(worktreeStateLabel(wt.state))
          }</span>`;
```

Add an off-convention marker inside `status-git-pop-row-meta`, after the path:

```ts
              <span class="status-git-pop-row-meta">${escapeHtml(compactPath(wt.path))}${
                wt.off_convention ? ` <span class="status-git-pop-wt-exile">off-convention</span>` : ""
              }</span>
```

- [ ] **Step 6: Add the state colors**

In `ui/src/styles.css`, after the existing `.status-git-pop-dirty` rules (:6742):

```css
.status-git-pop-wt-active { color: var(--ok); }
.status-git-pop-wt-active::before { background: var(--ok); }
.status-git-pop-wt-stale { color: var(--running); }
.status-git-pop-wt-stale::before { background: var(--running); }
/* Spent reads as inert, not healthy — it is the thing you are meant to delete. */
.status-git-pop-wt-spent { color: var(--muted); }
.status-git-pop-wt-spent::before { background: var(--muted); }
.status-git-pop-wt-orphan { color: var(--danger); }
.status-git-pop-wt-orphan::before { background: var(--danger); }
.status-git-pop-wt-exile {
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 0.85em;
}
```

Add the four `.status-git-pop-wt-*` selectors to the existing dot-shape rule list at `:6707-6708` and `:6728-6729` so they inherit the `::before` dot geometry.

Verify `--danger` and `--muted` exist: `grep -n "\-\-danger\|\-\-muted" ui/src/styles.css | head -3`. If either is absent, use the nearest defined token and note the substitution in the commit message.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- worktree-state && npm run build`
Expected: PASS, and a clean type-check.

- [ ] **Step 8: Commit**

```bash
git add ui/src/status/worktree-state.ts ui/src/status/worktree-state.test.ts ui/src/api.ts ui/src/status/bar.ts ui/src/styles.css
git commit -m "feat(worktrees): show lifecycle state in the git popover"
```

---

### Task 4: Reclaim spent worktrees, safely

**Files:**
- Modify: `crates/app/src/git_tools.rs`
- Modify: `crates/app/src/lib.rs`
- Test: `crates/app/src/git_tools.rs` (`mod tests`)

**Interfaces:**
- Consumes: `repo_summary()`, `WorktreeState`
- Produces: `pub struct ReclaimOutcome { path, removed, reason }`; `pub fn reclaim_worktrees(cwd: &Path, paths: Vec<String>) -> Result<Vec<ReclaimOutcome>, String>`; Tauri command `worktree_reclaim`

The safety property: **the frontend's classification is never trusted.** `reclaim_worktrees` re-runs `repo_summary` and refuses any path it does not itself compute as `Spent`.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn reclaim_removes_a_spent_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join("wt-done");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "done"]);
        std::fs::write(wt.join("tracked.txt"), "x\n").unwrap();
        git_run(&wt, &["add", "."]);
        git_run(&wt, &["commit", "-q", "-m", "w"]);
        git_run(root, &["merge", "-q", "--no-ff", "-m", "m", "done"]);

        let out = reclaim_worktrees(root, vec![wt.to_string_lossy().to_string()]).unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].removed, "reason: {:?}", out[0].reason);
        assert!(!wt.exists(), "directory is gone");

        let branches = git(root, &["branch", "--format=%(refname:short)"]).unwrap();
        assert!(!branches.lines().any(|l| l.trim() == "done"), "branch deleted too");
    }

    #[test]
    fn reclaim_refuses_an_unmerged_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join("wt-live");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "live"]);
        std::fs::write(wt.join("tracked.txt"), "x\n").unwrap();
        git_run(&wt, &["add", "."]);
        git_run(&wt, &["commit", "-q", "-m", "w"]);

        let out = reclaim_worktrees(root, vec![wt.to_string_lossy().to_string()]).unwrap();
        assert_eq!(out.len(), 1);
        assert!(!out[0].removed);
        assert!(out[0].reason.as_deref().unwrap_or("").contains("not spent"));
        assert!(wt.exists(), "untouched");
    }

    #[test]
    fn reclaim_refuses_a_dirty_worktree_even_if_merged() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join("wt-dirty");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "dirty"]);
        std::fs::write(wt.join("tracked.txt"), "x\n").unwrap();
        git_run(&wt, &["add", "."]);
        git_run(&wt, &["commit", "-q", "-m", "w"]);
        git_run(root, &["merge", "-q", "--no-ff", "-m", "m", "dirty"]);
        std::fs::write(wt.join("tracked.txt"), "uncommitted\n").unwrap();

        let out = reclaim_worktrees(root, vec![wt.to_string_lossy().to_string()]).unwrap();
        assert!(!out[0].removed);
        assert!(wt.exists());
    }

    #[test]
    fn reclaim_refuses_the_current_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let out = reclaim_worktrees(root, vec![root.to_string_lossy().to_string()]).unwrap();
        assert!(!out[0].removed);
        assert!(root.exists());
    }

    #[test]
    fn reclaim_refuses_a_path_that_is_not_a_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let out = reclaim_worktrees(root, vec!["/tmp/not-a-worktree".to_string()]).unwrap();
        assert!(!out[0].removed);
        assert!(out[0].reason.as_deref().unwrap_or("").contains("unknown"));
    }

    #[test]
    fn one_refusal_does_not_abort_the_batch() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let good = root.join("wt-good");
        git_run(root, &["worktree", "add", "-q", good.to_str().unwrap(), "-b", "good"]);
        std::fs::write(good.join("tracked.txt"), "x\n").unwrap();
        git_run(&good, &["add", "."]);
        git_run(&good, &["commit", "-q", "-m", "w"]);
        git_run(root, &["merge", "-q", "--no-ff", "-m", "m", "good"]);

        let out = reclaim_worktrees(
            root,
            vec!["/tmp/nope".to_string(), good.to_string_lossy().to_string()],
        )
        .unwrap();
        assert_eq!(out.len(), 2);
        assert!(out.iter().any(|o| o.removed), "the valid one still went through");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant-app git_tools::tests::reclaim 2>&1 | tail -20`
Expected: FAIL — `cannot find function 'reclaim_worktrees'`.

- [ ] **Step 3: Implement**

```rust
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReclaimOutcome {
    pub path: String,
    pub removed: bool,
    /// Present when `removed` is false. Shown to the user verbatim.
    pub reason: Option<String>,
}

/// Removes worktrees that this function itself classifies as `Spent`, and
/// deletes their branches. Refuses everything else.
///
/// The caller's classification is deliberately ignored: state is re-derived
/// here so a stale UI, or a direct IPC call, cannot delete live work.
pub fn reclaim_worktrees(
    cwd: &Path,
    paths: Vec<String>,
) -> Result<Vec<ReclaimOutcome>, String> {
    let summary = repo_summary(cwd)?;
    let mut outcomes = Vec::with_capacity(paths.len());

    for path in paths {
        let target = canonical_or_self(Path::new(&path));
        let Some(wt) = summary
            .worktrees
            .iter()
            .find(|w| canonical_or_self(Path::new(&w.path)) == target)
        else {
            outcomes.push(ReclaimOutcome {
                path,
                removed: false,
                reason: Some("unknown worktree".into()),
            });
            continue;
        };

        if wt.state != WorktreeState::Spent {
            outcomes.push(ReclaimOutcome {
                path,
                removed: false,
                reason: Some(format!("not spent (state: {:?})", wt.state).to_lowercase()),
            });
            continue;
        }

        if let Err(e) = git(cwd, &["worktree", "remove", &wt.path]) {
            outcomes.push(ReclaimOutcome { path, removed: false, reason: Some(e) });
            continue;
        }
        // The branch is merged, so -d is safe and refuses anything unmerged.
        if let Some(branch) = &wt.branch {
            let _ = git(cwd, &["branch", "-d", branch]);
        }
        outcomes.push(ReclaimOutcome { path, removed: true, reason: None });
    }

    let _ = git(cwd, &["worktree", "prune"]);
    Ok(outcomes)
}
```

- [ ] **Step 4: Register the Tauri command**

In `crates/app/src/lib.rs`, near `git_repo_summary`:

```rust
#[tauri::command]
async fn worktree_reclaim(
    cwd: String,
    paths: Vec<String>,
) -> Result<Vec<git_tools::ReclaimOutcome>, String> {
    let path = PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || git_tools::reclaim_worktrees(&path, paths))
        .await
        .map_err(|e| format!("worktree_reclaim join: {e}"))?
}
```

Add `worktree_reclaim` to `tauri::generate_handler![...]`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p covenant-app git_tools:: 2>&1 | tail -20`
Expected: PASS — all six reclaim tests plus the earlier ones.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/git_tools.rs crates/app/src/lib.rs
git commit -m "feat(worktrees): reclaim spent worktrees, refusing anything else"
```

---

### Task 5: Relocate off-convention worktrees when idle

**Files:**
- Modify: `crates/app/src/git_tools.rs`
- Modify: `crates/app/src/lib.rs`
- Test: `crates/app/src/git_tools.rs` (`mod tests`)

**Interfaces:**
- Consumes: `repo_summary()`, `CANONICAL_WORKTREE_DIR`, `worktree_slug()`, `WorktreeState`
- Produces: `pub fn relocate_worktree(cwd: &Path, path: &str) -> Result<String, String>`; Tauri command `worktree_relocate`

Idle is defined here as: not the current worktree, and `dirty_count == 0`. Covenant cannot see another process's cwd from this layer, so the frontend adds the attached-tab check before offering the action; this function enforces the half it can prove.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn relocate_moves_a_stray_worktree_under_the_canonical_root() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let stray = root.join("stray-place");
        git_run(root, &["worktree", "add", "-q", stray.to_str().unwrap(), "-b", "feat/thing"]);

        let moved = relocate_worktree(root, stray.to_str().unwrap()).unwrap();
        assert!(moved.ends_with("/.covenant/worktrees/thing"), "got {moved}");
        assert!(Path::new(&moved).is_dir());
        assert!(!stray.exists());

        let summary = repo_summary(root).unwrap();
        let row = summary.worktrees.iter()
            .find(|w| w.branch.as_deref() == Some("feat/thing")).unwrap();
        assert!(!row.off_convention);
    }

    #[test]
    fn relocate_refuses_a_dirty_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let stray = root.join("stray-dirty");
        git_run(root, &["worktree", "add", "-q", stray.to_str().unwrap(), "-b", "busy"]);
        std::fs::write(stray.join("tracked.txt"), "uncommitted\n").unwrap();

        let err = relocate_worktree(root, stray.to_str().unwrap()).unwrap_err();
        assert!(err.contains("uncommitted"), "got {err}");
        assert!(stray.exists());
    }

    #[test]
    fn relocate_refuses_the_current_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let err = relocate_worktree(root, root.to_str().unwrap()).unwrap_err();
        assert!(err.contains("current"), "got {err}");
    }

    #[test]
    fn relocate_is_a_noop_for_a_worktree_already_in_place() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let good = root.join(CANONICAL_WORKTREE_DIR).join("ok");
        git_run(root, &["worktree", "add", "-q", good.to_str().unwrap(), "-b", "ok"]);

        let out = relocate_worktree(root, good.to_str().unwrap()).unwrap();
        assert_eq!(canonical_or_self(Path::new(&out)), canonical_or_self(&good));
        assert!(good.is_dir());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant-app git_tools::tests::relocate 2>&1 | tail -20`
Expected: FAIL — `cannot find function 'relocate_worktree'`.

- [ ] **Step 3: Implement**

```rust
/// Moves a worktree under `CANONICAL_WORKTREE_DIR`. Returns the new path.
///
/// Refuses anything not provably idle: `git worktree move` under a live session
/// pulls the floor out from under it.
pub fn relocate_worktree(cwd: &Path, path: &str) -> Result<String, String> {
    let summary = repo_summary(cwd)?;
    let target = canonical_or_self(Path::new(path));
    let wt = summary
        .worktrees
        .iter()
        .find(|w| canonical_or_self(Path::new(&w.path)) == target)
        .ok_or_else(|| "unknown worktree".to_string())?;

    if wt.current {
        return Err("cannot relocate the current worktree".into());
    }
    if wt.dirty_count > 0 {
        return Err(format!(
            "worktree has {} uncommitted change(s); commit or discard first",
            wt.dirty_count
        ));
    }
    if !wt.off_convention {
        return Ok(wt.path.clone());
    }

    let branch = wt
        .branch
        .as_deref()
        .ok_or_else(|| "cannot relocate a detached worktree".to_string())?;
    let root = Path::new(&summary.repo_root).join(CANONICAL_WORKTREE_DIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;

    let dest = root.join(worktree_slug(branch));
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    let dest_str = dest.to_string_lossy().to_string();
    git(cwd, &["worktree", "move", &wt.path, &dest_str])?;
    Ok(dest_str)
}
```

- [ ] **Step 4: Register the Tauri command**

```rust
#[tauri::command]
async fn worktree_relocate(cwd: String, path: String) -> Result<String, String> {
    let root = PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || git_tools::relocate_worktree(&root, &path))
        .await
        .map_err(|e| format!("worktree_relocate join: {e}"))?
}
```

Add `worktree_relocate` to `tauri::generate_handler![...]`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p covenant-app git_tools:: 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/git_tools.rs crates/app/src/lib.rs
git commit -m "feat(worktrees): relocate off-convention worktrees when idle"
```

---

### Task 6: Wire reclaim and relocate into the popover

**Files:**
- Modify: `ui/src/api.ts`
- Modify: `ui/src/status/bar.ts` (worktree section head at :1013-1016, row rendering at :974-995, click handling near the existing `.status-git-pop-open-wt` handler)

**Interfaces:**
- Consumes: `worktreeDefaultAction()`, `worktreeSizes()`, `GitWorktreeSummary`
- Produces: `worktreeReclaim(cwd, paths)`, `worktreeRelocate(cwd, path)` in `api.ts`

- [ ] **Step 1: Add the API wrappers**

In `ui/src/api.ts`, after `worktreeSizes`:

```ts
export interface ReclaimOutcome {
  path: string;
  removed: boolean;
  reason: string | null;
}

export async function worktreeReclaim(cwd: string, paths: string[]): Promise<ReclaimOutcome[]> {
  return invoke<ReclaimOutcome[]>("worktree_reclaim", { cwd, paths });
}

export async function worktreeRelocate(cwd: string, path: string): Promise<string> {
  return invoke<string>("worktree_relocate", { cwd, path });
}
```

- [ ] **Step 2: Render the per-row action and the bulk button**

In `ui/src/status/bar.ts`, import:

```ts
import { worktreeDefaultAction } from "./worktree-state";
import { worktreeReclaim, worktreeRelocate, worktreeSizes } from "../api";
```

Replace the `action` const in the worktree map (:982-984):

```ts
        const verb = worktreeDefaultAction(wt);
        const ACTION_LABEL: Record<string, string> = {
          open: "Open tab",
          decide: "Open tab",
          reclaim: "Reclaim",
          prune: "Prune",
          relocate: "Relocate",
        };
        const action = verb === "none"
          ? ""
          : verb === "open" || verb === "decide"
            ? `<button type="button" class="status-git-pop-open-wt" data-path="${escapeHtml(wt.path)}" data-label="${escapeHtml(label)}">Open tab</button>`
            : `<button type="button" class="status-git-pop-wt-act" data-verb="${verb}" data-path="${escapeHtml(wt.path)}">${ACTION_LABEL[verb]}</button>`;
```

In the worktrees section head (:1013-1016), add the bulk button:

```ts
    const spent = summary.worktrees.filter((w) => w.state === "spent");
    const bulk = spent.length > 0
      ? `<button type="button" class="status-git-pop-reclaim-all">Reclaim ${spent.length} spent</button>`
      : "";
```

and place `${bulk}` inside the `<h3>` of the worktrees section, after the count span.

- [ ] **Step 3: Handle the clicks**

Add to the imports in `bar.ts` (the file already imports `pushInfoToast` at :53):

```ts
import { pushConfirmToast, pushInfoToast } from "../notifications/toast";
```

Insert directly after the existing `.status-git-pop-open-wt` handler block (`ui/src/status/bar.ts:1088-1096`), inside the same method — `cwd` is already in scope there:

```ts
    pop.querySelectorAll<HTMLButtonElement>(".status-git-pop-wt-act").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const path = btn.dataset.path ?? "";
        const verb = btn.dataset.verb ?? "";
        if (!path) return;
        btn.disabled = true;
        try {
          if (verb === "relocate") {
            const moved = await worktreeRelocate(cwd, path);
            pushInfoToast({ message: `Moved to ${compactPath(moved)}` });
          } else {
            // prune and reclaim share one command: the backend re-derives state
            // and refuses anything it does not itself classify as spent.
            const [outcome] = await worktreeReclaim(cwd, [path]);
            if (outcome && !outcome.removed) {
              pushInfoToast({ message: `Could not reclaim: ${outcome.reason ?? "refused"}` });
              return;
            }
            pushInfoToast({ message: "Worktree reclaimed" });
          }
          // The popover renders once from openBranchPopover and has no refresh
          // path; closing it is the honest way to drop now-stale rows.
          this.closeBranchPopover();
        } catch (e) {
          pushInfoToast({ message: String(e) });
        } finally {
          btn.disabled = false;
        }
      });
    });

    pop.querySelector<HTMLButtonElement>(".status-git-pop-reclaim-all")
      ?.addEventListener("click", async (ev) => {
        const btn = ev.currentTarget as HTMLButtonElement;
        const paths = summary.worktrees.filter((w) => w.state === "spent").map((w) => w.path);
        if (paths.length === 0) return;
        btn.disabled = true;
        // `du` over every spent worktree is slow, so the size lands in the
        // confirm copy rather than blocking the popover render.
        const sizes = await worktreeSizes(paths).catch(() => [] as Array<[string, number]>);
        const gb = sizes.reduce((sum, [, kb]) => sum + kb, 0) / 1024 / 1024;
        const detail = gb >= 0.1 ? `, freeing ${gb.toFixed(1)} GB` : "";
        btn.disabled = false;
        // Never window.confirm: a native modal blocks the whole webview.
        pushConfirmToast({
          // Toast messages render via textContent — do NOT escapeHtml here or
          // the entities show up literally.
          message: `Delete ${paths.length} merged worktree(s)${detail}? Their branches are already in ${
            summary.current_branch ?? "the default branch"
          }.`,
          confirmLabel: "Reclaim",
          onConfirm: () => {
            void (async () => {
              try {
                const outcomes = await worktreeReclaim(cwd, paths);
                const failed = outcomes.filter((o) => !o.removed);
                pushInfoToast({
                  message: failed.length === 0
                    ? `Reclaimed ${outcomes.length} worktree(s).`
                    : `Reclaimed ${outcomes.length - failed.length}, refused ${failed.length}.`,
                });
              } catch (e) {
                pushInfoToast({ message: String(e) });
              } finally {
                this.closeBranchPopover();
              }
            })();
          },
        });
      });
```

Both handlers must be arrow functions so `this` stays the status bar instance, matching the surrounding code.

- [ ] **Step 4: Style the action buttons**

In `ui/src/styles.css`, next to the `.status-git-pop-open-wt` rules:

```css
.status-git-pop-wt-act,
.status-git-pop-reclaim-all {
  border-radius: 0;
  appearance: none;
}
.status-git-pop-reclaim-all {
  margin-left: auto;
  font-size: 0.8em;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
```

Match the surrounding button chrome — copy the border/background/padding declarations from `.status-git-pop-open-wt` rather than inventing new ones.

- [ ] **Step 5: Verify the build and tests**

Run: `npm run build && npm test && cargo test --workspace 2>&1 | tail -20`
Expected: clean type-check, vitest green, cargo green.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api.ts ui/src/status/bar.ts ui/src/styles.css
git commit -m "feat(worktrees): reclaim and relocate from the git popover"
```

---

### Task 7: Verify against the real repo and tidy

**Files:**
- Modify: `docs/superpowers/specs/2026-07-18-worktree-lifecycle-design.md`

- [ ] **Step 1: Format and lint**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets 2>&1 | tail -30`
Expected: no warnings introduced by this branch.

- [ ] **Step 2: Verify live in the app**

Use the `verify` skill (DOM-dump recipe) to confirm in a running dev build:
- the popover lists worktrees with four distinct state labels,
- no `Spent` row renders with the healthy/`--ok` dot,
- the `Reclaim N spent` button appears with a plausible count for this repo,
- off-convention rows carry the marker.

Do NOT click Reclaim during verification — this repo's real worktrees are the test data for the next step.

- [ ] **Step 3: Reclaim for real, once**

With the app running on this repo, click `Reclaim N spent` and confirm. Then check:

```bash
git worktree list | wc -l
du -sh .claude/worktrees .covenant/worktrees 2>/dev/null
```

Expected: roughly 17 fewer worktrees, tens of GB freed. Record the actual before/after numbers in the commit message.

- [ ] **Step 4: Update the spec to match what was built**

Edit `docs/superpowers/specs/2026-07-18-worktree-lifecycle-design.md`:
- Under **Architecture → Frontend**, replace the "New Worktrees section following the established `.rail-*` chrome" paragraph with the popover-as-ledger decision and the reason (zero new surface; the diagnosis belongs where the user already looks).
- Under **The state model**, replace the `Active` derivation cell with "Current worktree, uncommitted changes, or unmerged with a commit inside `STALE_AFTER_DAYS`" and note that `Stale` is its disjoint complement.
- Under **Phases**, merge phases 1 and 2 into one shipped phase and renumber phase 3 to phase 2.
- Under **Architecture → Backend**, rename `ReclaimReport` to `Vec<ReclaimOutcome>` (per-path outcome, which is what shipped), drop `size_kb` from the `GitWorktreeSummary` listing and document the separate `worktree_sizes` command with its reason, and move `worktree_create` to the deferred prevention phase.
- Under **Testing**, drop the "census counts group correctly" frontend test — there is no census; the surviving frontend test is that a `Spent` row never renders the healthy dot.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-18-worktree-lifecycle-design.md
git commit -m "docs: reconcile the worktree lifecycle spec with the implementation"
```

---

## Deferred to a follow-up plan

**Prevention** — Covenant creating the worktree and launching the executor inside it (`Spawn.cwd`, ACP `cwd`), plus the Canon artifact projecting the convention into `AGENTS.md` / `CLAUDE.md` / copilot instructions. This plan delivers diagnosis and repair; prevention is a separate subsystem touching spawn and Canon, and is only worth building once the ledger proves the state model is right.

**Automatic reclaim** and **cross-repo ledger** stay open per the spec.
