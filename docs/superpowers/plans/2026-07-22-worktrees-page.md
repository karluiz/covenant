# Worktrees Management Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-screen Worktrees page (like Changes/Pulse) that shows every worktree's disk usage and what it was working on, with disk-reclaim and per-worktree actions.

**Architecture:** New `WorktreesSurface` overlay mirroring `PulseSurface`/`ChangesSurface` — a body-level fixed overlay toggled by an `open_` flag + body class, Escape captured on the capture phase. Data reuses `gitRepoSummary` (list/states), `worktreeSizes` (disk, with a `/target` trick), and `gitChanges` (selected worktree's files). Two small new Rust commands add per-worktree diffstat/commit-subject and a `target/`-cleaner.

**Tech Stack:** Rust (Tauri commands, `spawn_blocking`), TypeScript + vanilla DOM (no framework), Vitest, `cargo test`.

## Global Constraints

- No `unwrap()` outside `#[cfg(test)]` / `main()`.
- Rust commands run their blocking work in `tokio::task::spawn_blocking`.
- TS: `strict: true`, no `as any` without a justifying comment.
- UI chrome copy is English; group/section names uppercased via CSS, not string mutation.
- Sharp corners (`border-radius: 0`) on new panels except 50% dots; native inputs need `appearance: none`. (docs/DESIGN.md)
- No native tooltips — use `attachTooltip`, never `element.title`. (There is one existing exception in tab live-dots; do not copy it.)
- Icons are inline SVG (`Icons.*`), never emoji.
- `npm test` runs from repo ROOT; `cargo test` from workspace root.
- `node_modules` inside a worktree is a symlink to main's deps — never delete or `git add -A` it.

---

### Task 1: `worktree_detail` Rust command

**Files:**
- Modify: `crates/app/src/git_tools.rs` (add `WorktreeDetail`, `worktree_detail`, `parse_shortstat`; tests at bottom)
- Modify: `crates/app/src/lib.rs` (add `#[tauri::command] worktree_detail` wrapper near line 2811; register in invoke handler near line 5758)
- Modify: `ui/src/api.ts` (add `WorktreeDetail` interface + `worktreeDetail` wrapper near line 1491)

**Interfaces:**
- Produces (Rust): `pub fn worktree_detail(path: &Path) -> WorktreeDetail` where `WorktreeDetail { last_subject: Option<String>, insertions: u64, deletions: u64 }`.
- Produces (command): `worktree_detail(path: String) -> Result<WorktreeDetail, String>`.
- Produces (TS): `worktreeDetail(path: string): Promise<WorktreeDetail>` where `WorktreeDetail { last_subject: string | null; insertions: number; deletions: number }`.
- Consumes: existing `git(cwd, args)` helper (`git_tools.rs:1118`).

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `crates/app/src/git_tools.rs`. If the file has no test module, add one at the end: `#[cfg(test)] mod tests { use super::*; ... }`.

```rust
#[test]
fn worktree_detail_reports_subject_and_diffstat() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    let run = |args: &[&str]| {
        std::process::Command::new("git").arg("-C").arg(p).args(args).output().unwrap();
    };
    run(&["init", "-q"]);
    run(&["config", "user.email", "t@t"]);
    run(&["config", "user.name", "t"]);
    std::fs::write(p.join("a.txt"), "one\n").unwrap();
    run(&["add", "a.txt"]);
    run(&["commit", "-q", "-m", "seed commit"]);
    std::fs::write(p.join("a.txt"), "one\ntwo\nthree\n").unwrap();

    let d = worktree_detail(p);
    assert_eq!(d.last_subject.as_deref(), Some("seed commit"));
    assert!(d.insertions >= 2, "insertions was {}", d.insertions);
}

#[test]
fn worktree_detail_empty_repo_has_no_subject() {
    let dir = tempfile::tempdir().unwrap();
    std::process::Command::new("git").arg("-C").arg(dir.path()).args(["init", "-q"]).output().unwrap();
    let d = worktree_detail(dir.path());
    assert_eq!(d.last_subject, None);
    assert_eq!((d.insertions, d.deletions), (0, 0));
}
```

Verify `tempfile` is a dev-dependency: `grep -n 'tempfile' crates/app/Cargo.toml`. If absent, add under `[dev-dependencies]`: `tempfile = "3"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant-app worktree_detail 2>&1 | tail -20`
Expected: FAIL — `cannot find function \`worktree_detail\``.
(If the crate name differs, find it: `grep -m1 '^name' crates/app/Cargo.toml`.)

- [ ] **Step 3: Write minimal implementation**

Add to `crates/app/src/git_tools.rs` (near `worktree_sizes`, ~line 1171). `Serialize` is already imported in this file (used by the other summary structs).

```rust
/// What a worktree was working on: last commit subject + uncommitted diffstat
/// (staged + unstaged vs HEAD). Cheap enough to call per selected worktree.
#[derive(Debug, Clone, Serialize)]
pub struct WorktreeDetail {
    pub last_subject: Option<String>,
    pub insertions: u64,
    pub deletions: u64,
}

pub fn worktree_detail(path: &Path) -> WorktreeDetail {
    let last_subject = git(path, &["log", "-1", "--format=%s"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let (insertions, deletions) = git(path, &["diff", "HEAD", "--shortstat"])
        .ok()
        .map(|s| parse_shortstat(&s))
        .unwrap_or((0, 0));
    WorktreeDetail { last_subject, insertions, deletions }
}

/// Parse `git --shortstat`: " 3 files changed, 240 insertions(+), 12 deletions(-)".
/// The count precedes the "insertion"/"deletion" token; either may be absent.
fn parse_shortstat(s: &str) -> (u64, u64) {
    let toks: Vec<&str> = s.split_whitespace().collect();
    let num_before = |kw: &str| -> u64 {
        toks.iter()
            .position(|t| t.starts_with(kw))
            .and_then(|i| i.checked_sub(1))
            .and_then(|i| toks.get(i))
            .and_then(|n| n.parse::<u64>().ok())
            .unwrap_or(0)
    };
    (num_before("insertion"), num_before("deletion"))
}
```

Then the command wrapper in `crates/app/src/lib.rs` (after `git_changes`, ~line 2811):

```rust
#[tauri::command]
async fn worktree_detail(path: String) -> Result<git_tools::WorktreeDetail, String> {
    let p = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git_tools::worktree_detail(&p))
        .await
        .map_err(|e| format!("worktree_detail join: {e}"))
}
```

Register it in the `invoke_handler![...]` list (after `git_changes,` at line 5758):

```rust
            worktree_detail,
```

And the TS wrapper in `ui/src/api.ts` (after `gitChanges`, ~line 1491):

```ts
export interface WorktreeDetail {
  last_subject: string | null;
  insertions: number;
  deletions: number;
}

export async function worktreeDetail(path: string): Promise<WorktreeDetail> {
  return invoke<WorktreeDetail>("worktree_detail", { path });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p covenant-app worktree_detail 2>&1 | tail -20`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/git_tools.rs crates/app/src/lib.rs ui/src/api.ts crates/app/Cargo.toml
git commit -m "feat(git): worktree_detail command — last commit subject + diffstat"
```

---

### Task 2: `worktree_clean_target` Rust command

**Files:**
- Modify: `crates/app/src/git_tools.rs` (add `clean_target`; tests)
- Modify: `crates/app/src/lib.rs` (command wrapper + registration)
- Modify: `ui/src/api.ts` (`worktreeCleanTarget` wrapper)

**Interfaces:**
- Produces (Rust): `pub fn clean_target(path: &Path) -> Result<u64, String>` — freed KB.
- Produces (command): `worktree_clean_target(path: String) -> Result<u64, String>`.
- Produces (TS): `worktreeCleanTarget(path: string): Promise<number>`.
- Consumes: existing `worktree_sizes(Vec<String>) -> Vec<(String,u64)>` (`git_tools.rs:1154`).

- [ ] **Step 1: Write the failing test**

Add to the tests module in `crates/app/src/git_tools.rs`:

```rust
#[test]
fn clean_target_removes_target_keeps_symlink_and_source() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    std::fs::write(p.join(".git"), "gitdir: /somewhere\n").unwrap(); // linked-worktree marker
    std::fs::create_dir(p.join("target")).unwrap();
    std::fs::write(p.join("target").join("build.o"), vec![0u8; 4096]).unwrap();
    std::fs::write(p.join("keep.rs"), "fn main() {}\n").unwrap();
    // node_modules as a symlink to some other dir — must survive.
    let other = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(other.path(), p.join("node_modules")).unwrap();

    let freed = clean_target(p).unwrap();
    assert!(!p.join("target").exists(), "target should be gone");
    assert!(p.join("keep.rs").exists(), "source must survive");
    assert!(std::fs::symlink_metadata(p.join("node_modules")).unwrap().file_type().is_symlink(),
        "node_modules symlink must survive");
    let _ = freed; // KB may round to 0 on tiny dirs; deletion is what matters.
}

#[test]
fn clean_target_refuses_symlinked_target() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path();
    std::fs::write(p.join(".git"), "gitdir: /somewhere\n").unwrap();
    let real = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(real.path(), p.join("target")).unwrap();

    let err = clean_target(p).unwrap_err();
    assert!(err.contains("symlink"), "got: {err}");
    assert!(p.join("target").exists(), "symlinked target must be untouched");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant-app clean_target 2>&1 | tail -20`
Expected: FAIL — `cannot find function \`clean_target\``.

- [ ] **Step 3: Write minimal implementation**

Add to `crates/app/src/git_tools.rs`:

```rust
/// Delete a worktree's `target/` build cache and return freed KB. Refuses
/// anything that isn't a real directory named `target` directly under a git
/// worktree root. Never touches `node_modules` (a symlink to main's deps).
/// ponytail: `.git`-existence is the worktree check; skips a full
/// `git worktree list` cross-verify — upgrade if callers ever pass non-worktree
/// paths that happen to hold a `.git`.
pub fn clean_target(path: &Path) -> Result<u64, String> {
    if !path.join(".git").exists() {
        return Err(format!("{} is not a git worktree", path.display()));
    }
    let target = path.join("target");
    let meta = std::fs::symlink_metadata(&target)
        .map_err(|_| "no target/ directory".to_string())?;
    if meta.file_type().is_symlink() {
        return Err("target/ is a symlink; refusing to delete".into());
    }
    if !meta.is_dir() {
        return Err("target/ is not a directory".into());
    }
    let freed = worktree_sizes(vec![target.to_string_lossy().into_owned()])
        .into_iter()
        .next()
        .map(|(_, kb)| kb)
        .unwrap_or(0);
    std::fs::remove_dir_all(&target).map_err(|e| format!("remove target/: {e}"))?;
    Ok(freed)
}
```

Command wrapper in `crates/app/src/lib.rs` (after the `worktree_detail` wrapper from Task 1):

```rust
#[tauri::command]
async fn worktree_clean_target(path: String) -> Result<u64, String> {
    let p = PathBuf::from(path);
    tokio::task::spawn_blocking(move || git_tools::clean_target(&p))
        .await
        .map_err(|e| format!("worktree_clean_target join: {e}"))?
}
```

Register in the invoke handler (after `worktree_detail,`):

```rust
            worktree_clean_target,
```

TS wrapper in `ui/src/api.ts` (after `worktreeDetail`):

```ts
/** Delete a worktree's target/ build cache; resolves freed KB. */
export async function worktreeCleanTarget(path: string): Promise<number> {
  return invoke<number>("worktree_clean_target", { path });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p covenant-app clean_target 2>&1 | tail -20`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/git_tools.rs crates/app/src/lib.rs ui/src/api.ts
git commit -m "feat(git): worktree_clean_target command — rm target/, symlink-guarded"
```

---

### Task 3: Disk size-split helper

**Files:**
- Create: `ui/src/worktrees/sizes.ts`
- Create: `ui/src/worktrees/sizes.test.ts`

**Interfaces:**
- Produces: `splitSizes(paths: string[], sizes: ReadonlyArray<readonly [string, number]>): Map<string, { total: number; target: number }>`.
- Produces: `sizeRequestPaths(paths: string[]): string[]` — `[...paths, ...paths.map(p => \`${p}/target\`)]`.
- Consumes: shape of `worktreeSizes` return (`Array<[string, number]>`).

- [ ] **Step 1: Write the failing test**

`ui/src/worktrees/sizes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { splitSizes, sizeRequestPaths } from "./sizes";

describe("splitSizes", () => {
  it("splits totals from target/ entries and defaults missing to 0", () => {
    const paths = ["/a", "/b"];
    const sizes: Array<[string, number]> = [["/a", 100], ["/a/target", 80], ["/b", 50]];
    const out = splitSizes(paths, sizes);
    expect(out.get("/a")).toEqual({ total: 100, target: 80 });
    expect(out.get("/b")).toEqual({ total: 50, target: 0 });
  });

  it("requests both worktree and target paths", () => {
    expect(sizeRequestPaths(["/a", "/b"])).toEqual(["/a", "/b", "/a/target", "/b/target"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- sizes 2>&1 | tail -20` (from repo root)
Expected: FAIL — cannot resolve `./sizes`.

- [ ] **Step 3: Write minimal implementation**

`ui/src/worktrees/sizes.ts`:

```ts
/** Paths to ask `worktreeSizes` for: each worktree plus its `target/`, so one
 * du call yields both the total and the reclaimable build-cache size. */
export function sizeRequestPaths(paths: string[]): string[] {
  return [...paths, ...paths.map((p) => `${p}/target`)];
}

/** Fold a flat `[path, kb]` list (from `sizeRequestPaths`) back into per-worktree
 * totals. Missing entries (e.g. a worktree with no target/ yet) default to 0. */
export function splitSizes(
  paths: string[],
  sizes: ReadonlyArray<readonly [string, number]>,
): Map<string, { total: number; target: number }> {
  const byPath = new Map(sizes.map(([p, kb]) => [p, kb] as const));
  const out = new Map<string, { total: number; target: number }>();
  for (const p of paths) {
    out.set(p, { total: byPath.get(p) ?? 0, target: byPath.get(`${p}/target`) ?? 0 });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- sizes 2>&1 | tail -20`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/worktrees/sizes.ts ui/src/worktrees/sizes.test.ts
git commit -m "feat(worktrees): disk size-split helper"
```

---

### Task 4: `WorktreesSurface` skeleton + wiring (opens empty)

Goal: page opens/closes via ⌘⌥W and the popover, shows an empty framed shell. Verified live before any content lands.

**Files:**
- Create: `ui/src/worktrees/index.ts`
- Create: `ui/src/worktrees/worktrees.css`
- Create: `ui/src/worktrees/format.ts`
- Modify: `ui/src/main.ts` (host + toggle + event; import the css)
- Modify: `ui/src/status/bar.ts` (popover "Manage worktrees" button)

**Interfaces:**
- Produces: `class WorktreesSurface { constructor(host: HTMLElement); open(repoRoot: string): Promise<void>; close(): void; get isOpen(): boolean }`.
- Produces (`format.ts`): `worktreeLabel(wt: GitWorktreeSummary): string`, `compactPath(path: string): string`, `humanSize(kb: number): string`.
- Consumes: `gitRepoSummary` (api.ts:1466), `worktreeStateClass`/`worktreeStateLabel`/`worktreeDefaultAction` (status/worktree-state.ts).

- [ ] **Step 1: Format helpers**

`ui/src/worktrees/format.ts` — ponytail: worktreeLabel/compactPath duplicate the 6-line bar.ts privates rather than exporting from that 3000-line file.

```ts
import type { GitWorktreeSummary } from "../api";

export function worktreeLabel(wt: GitWorktreeSummary): string {
  if (wt.branch) return wt.branch;
  const base = wt.path.split("/").filter(Boolean).pop() ?? wt.path;
  if (wt.detached && wt.head) return `DETACHED@${wt.head.slice(0, 7)}`;
  if (wt.bare) return `${base} (bare)`;
  return base;
}

export function compactPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, "~");
}

/** KB → "6.2 GB" / "52 MB" / "800 KB". */
export function humanSize(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`;
  return `${kb} KB`;
}
```

- [ ] **Step 2: Surface skeleton**

`ui/src/worktrees/index.ts` — mirrors `PulseSurface`. Detail/list/actions land in Tasks 5-7; this task ships open/close/shell only.

```ts
import { gitRepoSummary, type GitRepoSummary } from "../api";

/// Full-screen Worktrees management page. Mirrors PulseSurface
/// (ui/src/pulse/index.ts): a fixed overlay the terminal keeps focus behind,
/// so Escape is captured on the capture phase.
export class WorktreesSurface {
  private host: HTMLElement;
  private open_ = false;
  private repoRoot = "";
  private summary: GitRepoSummary | null = null;

  private onKey = (e: KeyboardEvent): void => {
    if (this.open_ && e.key === "Escape") { e.preventDefault(); this.close(); }
  };

  constructor(host: HTMLElement) { this.host = host; }

  get isOpen(): boolean { return this.open_; }

  async open(repoRoot: string): Promise<void> {
    if (this.open_) return;
    this.open_ = true;
    this.repoRoot = repoRoot;
    document.body.classList.add("worktrees-fullscreen");
    document.addEventListener("keydown", this.onKey, true);
    this.mountShell();
    await this.refresh();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    document.removeEventListener("keydown", this.onKey, true);
    document.body.classList.remove("worktrees-fullscreen");
    this.host.innerHTML = "";
  }

  private async refresh(): Promise<void> {
    try {
      this.summary = await gitRepoSummary(this.repoRoot);
    } catch {
      this.summary = null;
    }
    this.render();
  }

  private mountShell(): void {
    this.host.innerHTML = "";
    const frame = document.createElement("div");
    frame.className = "wt-frame";

    const header = document.createElement("div");
    header.className = "wt-header";
    const title = document.createElement("span");
    title.className = "wt-title";
    title.textContent = "Worktrees";
    const spacer = document.createElement("span");
    spacer.className = "wt-header-spacer";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "wt-close";
    close.setAttribute("aria-label", "Close (Esc)");
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.close());
    header.append(title, spacer, close);

    const body = document.createElement("div");
    body.className = "wt-body";

    frame.append(header, body);
    this.host.appendChild(frame);
  }

  // Replaced in Task 5.
  private render(): void {
    const body = this.host.querySelector(".wt-body");
    if (body) body.textContent = this.summary ? `${this.summary.worktrees.length} worktrees` : "Not a git repo";
  }
}
```

- [ ] **Step 3: CSS**

`ui/src/worktrees/worktrees.css` — copy the Pulse overlay geometry. Confirm the exact top offset with `grep -n 'pulse-frame' ui/src/pulse/*.css ui/src/**/*.css` and match it.

```css
body.worktrees-fullscreen { overflow: hidden; }

.wt-frame {
  position: fixed;
  inset: var(--titlebar-height, 38px) 0 0 0;
  z-index: 40;
  display: flex;
  flex-direction: column;
  background: var(--bg, #0b0b0d);
  color: var(--fg, #e6e6e6);
}
.wt-header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 20px; border-bottom: 1px solid var(--border, #222);
}
.wt-title { font-weight: 600; letter-spacing: 0.02em; }
.wt-header-spacer { flex: 1; }
.wt-close { background: none; border: 0; cursor: pointer; color: inherit; }
.wt-body { flex: 1; display: flex; min-height: 0; }
.wt-left { width: 44%; min-width: 320px; overflow-y: auto; border-right: 1px solid var(--border, #222); }
.wt-right { flex: 1; overflow-y: auto; padding: 20px; min-width: 0; }
```

- [ ] **Step 4: Wire into `main.ts`**

Import at top (near the `ChangesSurface` import, line 120):

```ts
import { WorktreesSurface } from "./worktrees/index";
import "./worktrees/worktrees.css";
```

After the Pulse block (~line 2027), add host + open helper + event:

```ts
  // Worktrees management page — ⌘⌥W toggle. Own fixed-overlay host on body.
  const worktreesHost = document.createElement("div");
  document.body.appendChild(worktreesHost);
  const worktreesSurface = new WorktreesSurface(worktreesHost);
  const openWorktrees = async (): Promise<void> => {
    const cwd = manager.activeCwd();
    if (!cwd) return;
    try {
      const summary = await gitRepoSummary(cwd);
      await worktreesSurface.open(summary.repo_root);
    } catch { /* not a git repo — no-op */ }
  };
  window.addEventListener("covenant:open-worktrees", () => { void openWorktrees(); });
```

In the global keydown handler, next to the ⌘⌥M Pulse block (~line 2731):

```ts
    // ⌘⌥W → Worktrees management page. "∑" is what ⌥W emits on macOS
    // (same pattern as the ⌘⌥R "®" / ⌘⌥M "µ" handlers).
    if (e.metaKey && e.altKey && !e.shiftKey && (e.key === "w" || e.key === "W" || e.key === "∑")) {
      e.preventDefault();
      if (worktreesSurface.isOpen) { worktreesSurface.close(); } else { void openWorktrees(); }
      return;
    }
```

- [ ] **Step 5: Popover "Manage worktrees" button**

In `ui/src/status/bar.ts`, in `renderBranchPopoverSummary`, find where the `.status-git-pop-actions` footer is built (~line 1059, the "View changes" button). Add a sibling button before it:

```ts
    const manageBtn = document.createElement("button");
    manageBtn.type = "button";
    manageBtn.className = "status-git-pop-manage";
    manageBtn.textContent = "Manage worktrees";
    manageBtn.addEventListener("click", () => {
      this.closeBranchPopover?.();
      window.dispatchEvent(new CustomEvent("covenant:open-worktrees"));
    });
```

Append `manageBtn` into the same actions container as the View-changes button (match the existing `.append(...)` call). If `closeBranchPopover` isn't a method, close the popover the same way the "View changes" handler does (inspect `onViewChanges` wiring at ~line 1059).

- [ ] **Step 6: Verify build + live**

Run: `npm run build 2>&1 | tail -15`
Expected: type-check + bundle succeed.

Then verify live (use the `verify-live` skill or `npm run tauri:dev`): press ⌘⌥W → empty "Worktrees" page opens showing "N worktrees"; Esc closes it; the popover's "Manage worktrees" button opens it too.

- [ ] **Step 7: Commit**

```bash
git add ui/src/worktrees/index.ts ui/src/worktrees/worktrees.css ui/src/worktrees/format.ts ui/src/main.ts ui/src/status/bar.ts
git commit -m "feat(worktrees): WorktreesSurface skeleton + ⌘⌥W + popover entry"
```

---

### Task 5: Left list — rows, disk bars, lazy sizes, sort, select

**Files:**
- Modify: `ui/src/worktrees/index.ts`
- Modify: `ui/src/worktrees/worktrees.css`

**Interfaces:**
- Consumes: `splitSizes`, `sizeRequestPaths` (Task 3); `worktreeSizes` (api.ts:1408); `worktreeStateClass`/`worktreeStateLabel` (status/worktree-state.ts); `worktreeLabel`/`compactPath`/`humanSize` (Task 4).
- Produces: `this.selected: string | null` (worktree path); `renderList()`; `loadSizes()`; sizes stored in `this.sizes: Map<string, { total: number; target: number }>`.

- [ ] **Step 1: Add state + imports**

At the top of `index.ts`, extend imports:

```ts
import { gitRepoSummary, worktreeSizes, type GitRepoSummary, type GitWorktreeSummary } from "../api";
import { worktreeStateClass, worktreeStateLabel } from "../status/worktree-state";
import { worktreeLabel, compactPath, humanSize } from "./format";
import { splitSizes, sizeRequestPaths } from "./sizes";
```

Add fields to the class:

```ts
  private sizes = new Map<string, { total: number; target: number }>();
  private selected: string | null = null;
```

- [ ] **Step 2: Replace `render()` with real split + list + detail host**

```ts
  private render(): void {
    const body = this.host.querySelector(".wt-body");
    if (!body) return;
    body.innerHTML = "";
    if (!this.summary) { body.textContent = "Not a git repo."; return; }

    const left = document.createElement("div");
    left.className = "wt-left";
    const right = document.createElement("div");
    right.className = "wt-right";
    body.append(left, right);

    // Default selection: current worktree, else the first row.
    const wts = this.summary.worktrees;
    if (!this.selected || !wts.some((w) => w.path === this.selected)) {
      this.selected = (wts.find((w) => w.current) ?? wts[0])?.path ?? null;
    }
    this.renderList(left);
    this.renderDetail(right); // Task 6
  }

  private sortedWorktrees(): GitWorktreeSummary[] {
    const size = (p: string) => this.sizes.get(p)?.total ?? -1;
    return [...(this.summary?.worktrees ?? [])].sort((a, b) => size(b.path) - size(a.path));
  }

  private renderList(host: HTMLElement): void {
    host.innerHTML = "";
    const maxKb = Math.max(1, ...[...this.sizes.values()].map((s) => s.total));
    for (const wt of this.sortedWorktrees()) {
      const size = this.sizes.get(wt.path);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "wt-row" + (wt.path === this.selected ? " is-selected" : "");
      row.addEventListener("click", () => { this.selected = wt.path; this.render(); });

      const dot = document.createElement("span");
      dot.className = `wt-dot ${worktreeStateClass(wt.state)}`;
      const label = document.createElement("span");
      label.className = "wt-row-label";
      label.textContent = worktreeLabel(wt);
      const path = document.createElement("span");
      path.className = "wt-row-path";
      path.textContent = compactPath(wt.path);

      const bar = document.createElement("span");
      bar.className = "wt-bar";
      const fill = document.createElement("span");
      fill.className = "wt-bar-fill";
      fill.style.width = size ? `${Math.round((size.total / maxKb) * 100)}%` : "0%";
      bar.appendChild(fill);

      const sizeEl = document.createElement("span");
      sizeEl.className = "wt-row-size";
      sizeEl.textContent = size ? humanSize(size.total) : "…";

      const badge = document.createElement("span");
      badge.className = "wt-row-badge";
      badge.textContent = wt.current ? "HERE"
        : wt.dirty_count > 0 ? `${wt.dirty_count} changed`
        : worktreeStateLabel(wt.state);

      row.append(dot, label, path, bar, sizeEl, badge);
      host.appendChild(row);
    }
  }

  private async loadSizes(): Promise<void> {
    if (!this.summary) return;
    const paths = this.summary.worktrees.map((w) => w.path);
    try {
      const raw = await worktreeSizes(sizeRequestPaths(paths));
      this.sizes = splitSizes(paths, raw);
    } catch { /* leave sizes empty — rows show "…" */ }
    if (this.open_) this.render();
  }
```

- [ ] **Step 3: Kick off lazy sizes after first paint**

In `refresh()`, after `this.render();`, add:

```ts
    void this.loadSizes();
```

- [ ] **Step 4: CSS for rows/bars**

Append to `worktrees.css`:

```css
.wt-row {
  display: grid;
  grid-template-columns: 10px 1fr auto 64px auto;
  grid-template-areas: "dot label bar size badge" "dot path bar size badge";
  align-items: center; gap: 2px 10px;
  width: 100%; text-align: left;
  padding: 10px 16px; background: none; border: 0; border-bottom: 1px solid var(--border, #1c1c1e);
  color: inherit; cursor: pointer;
}
.wt-row.is-selected { background: var(--bg-elev, #16161a); }
.wt-dot { grid-area: dot; width: 8px; height: 8px; border-radius: 50%; background: var(--fg-dim, #666); }
.wt-row-label { grid-area: label; font-weight: 600; }
.wt-row-path { grid-area: path; font-size: 11px; color: var(--fg-dim, #888); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wt-bar { grid-area: bar; width: 60px; height: 4px; background: var(--border, #222); }
.wt-bar-fill { display: block; height: 100%; background: var(--accent, #6b9fff); }
.wt-row-size { grid-area: size; text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; }
.wt-row-badge { grid-area: badge; font-size: 11px; color: var(--fg-dim, #888); }
```

(`worktreeStateClass` yields `status-git-pop-wt-active|stale|spent|orphan`; those already carry dot colors in the existing status CSS. If the color doesn't apply, add per-state `.wt-dot.status-git-pop-wt-active { background: ... }` overrides matching the popover.)

- [ ] **Step 5: Verify**

Run: `npm run build 2>&1 | tail -15` → passes.
Live: ⌘⌥W → list of worktrees sorted biggest-first, sizes fill in after ~1s, clicking a row selects it (highlight moves).

- [ ] **Step 6: Commit**

```bash
git add ui/src/worktrees/index.ts ui/src/worktrees/worktrees.css
git commit -m "feat(worktrees): left list with disk bars, lazy sizes, sort + select"
```

---

### Task 6: Right detail panel — structured summary + changed files

**Files:**
- Modify: `ui/src/worktrees/index.ts`
- Modify: `ui/src/worktrees/worktrees.css`

**Interfaces:**
- Consumes: `worktreeDetail` (Task 1), `gitChanges` (api.ts:1489), `humanSize` (Task 4).
- Produces: `renderDetail(host)`, `loadDetail(path)`, `this.detail: Map<string, { subject: string | null; ins: number; del: number; files: string[] }>` cache.

- [ ] **Step 1: Add detail cache + loader**

Extend imports:

```ts
import { gitRepoSummary, worktreeSizes, worktreeDetail, gitChanges, type GitRepoSummary, type GitWorktreeSummary } from "../api";
```

Add field:

```ts
  private detail = new Map<string, { subject: string | null; ins: number; del: number; files: string[] }>();
```

Loader (loads only the selected worktree; cached):

```ts
  private async loadDetail(path: string): Promise<void> {
    if (this.detail.has(path)) return;
    try {
      const [d, changes] = await Promise.all([worktreeDetail(path), gitChanges(path)]);
      const files = [...changes.unstaged, ...changes.staged].map((f) => `${f.status[0].toUpperCase()} ${f.path}`);
      this.detail.set(path, { subject: d.last_subject, ins: d.insertions, del: d.deletions, files });
    } catch {
      this.detail.set(path, { subject: null, ins: 0, del: 0, files: [] });
    }
    if (this.open_ && this.selected === path) this.render();
  }
```

- [ ] **Step 2: Implement `renderDetail`**

```ts
  private renderDetail(host: HTMLElement): void {
    host.innerHTML = "";
    const wt = this.summary?.worktrees.find((w) => w.path === this.selected);
    if (!wt) { host.textContent = "Select a worktree."; return; }

    const d = this.detail.get(wt.path);
    if (!d) void this.loadDetail(wt.path);
    const size = this.sizes.get(wt.path);

    const title = document.createElement("div");
    title.className = "wt-d-title";
    title.textContent = worktreeLabel(wt);
    const path = document.createElement("div");
    path.className = "wt-d-path";
    path.textContent = compactPath(wt.path);

    const summary = document.createElement("div");
    summary.className = "wt-d-summary";
    const when = wt.last_commit_unix ? relativeTime(wt.last_commit_unix) : "no commits";
    const subj = d ? (d.subject ?? "(no commit yet)") : "…";
    const stat = d ? `${wt.dirty_count} changed · +${d.ins} / -${d.del}` : "…";
    summary.innerHTML = `<div class="wt-d-subject">${escapeHtml(subj)}</div>` +
      `<div class="wt-d-meta">${escapeHtml(when)} · ${escapeHtml(stat)}</div>`;

    const files = document.createElement("div");
    files.className = "wt-d-files";
    if (d && d.files.length) {
      for (const f of d.files.slice(0, 40)) {
        const row = document.createElement("div");
        row.className = "wt-d-file";
        row.textContent = f;
        files.appendChild(row);
      }
      if (d.files.length > 40) {
        const more = document.createElement("div");
        more.className = "wt-d-file wt-d-more";
        more.textContent = `+${d.files.length - 40} more`;
        files.appendChild(more);
      }
    }

    const disk = document.createElement("div");
    disk.className = "wt-d-disk";
    if (size) {
      disk.textContent = size.target > 0
        ? `disk ${humanSize(size.total)} · target/ ${humanSize(size.target)} reclaimable`
        : `disk ${humanSize(size.total)}`;
    }

    const actions = document.createElement("div");
    actions.className = "wt-d-actions"; // filled in Task 7

    host.append(title, path, summary, files, disk, actions);
  }
```

Add module-scope helpers at the bottom of `index.ts` (below the class):

```ts
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

function relativeTime(unixSecs: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs);
  if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
```

(If the codebase already exports a relative-time / `escapeHtml` util, import that instead — check `grep -rn "export function escapeHtml\|relativeTime\|timeAgo" ui/src`.)

- [ ] **Step 3: CSS**

Append to `worktrees.css`:

```css
.wt-d-title { font-size: 15px; font-weight: 600; }
.wt-d-path { font-size: 11px; color: var(--fg-dim, #888); margin-bottom: 14px; }
.wt-d-summary { margin-bottom: 14px; }
.wt-d-subject { font-style: italic; }
.wt-d-meta { font-size: 12px; color: var(--fg-dim, #888); margin-top: 2px; }
.wt-d-files { font-family: var(--mono, monospace); font-size: 12px; margin-bottom: 14px; }
.wt-d-file { padding: 1px 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wt-d-more { color: var(--fg-dim, #888); }
.wt-d-disk { font-size: 12px; color: var(--fg-dim, #aaa); margin-bottom: 14px; font-variant-numeric: tabular-nums; }
.wt-d-actions { display: flex; flex-wrap: wrap; gap: 8px; }
```

- [ ] **Step 4: Verify**

Run: `npm run build 2>&1 | tail -15` → passes.
Live: selecting a worktree shows its last commit subject, relative time, `N changed +X/-Y`, changed-files list, and the disk line with `target/ reclaimable`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/worktrees/index.ts ui/src/worktrees/worktrees.css
git commit -m "feat(worktrees): detail panel — commit subject, diffstat, changed files, disk"
```

---

### Task 7: Actions — Open tab, View diff, Clean target, state action

**Files:**
- Modify: `ui/src/worktrees/index.ts`
- Modify: `ui/src/main.ts` (pass callbacks into the surface constructor)

**Interfaces:**
- Consumes: `worktreeDefaultAction` (status/worktree-state.ts); `worktreeCleanTarget` (Task 2); `worktreeReclaim`/`worktreeRelocate`/`worktreeRetire` (api.ts); `ChangesSurface.open` via a `covenant:open-changes` event; tab-open via a callback.
- Produces: constructor gains `opts: { onOpenTab: (path: string) => void; getOccupiedCwds: () => ReadonlySet<string>; liveRoot: () => string | null }`.

- [ ] **Step 1: Widen the constructor**

```ts
import { worktreeDefaultAction } from "../status/worktree-state";
import { worktreeCleanTarget, worktreeReclaim, worktreeRelocate, worktreeRetire } from "../api";

interface WorktreesOpts {
  onOpenTab: (path: string) => void;
  getOccupiedCwds: () => ReadonlySet<string>;
  liveRoot: () => string | null;
}

// in the class:
  private opts: WorktreesOpts;
  constructor(host: HTMLElement, opts: WorktreesOpts) { this.host = host; this.opts = opts; }
```

- [ ] **Step 2: Build the actions row (replace the empty `actions` block in `renderDetail`)**

Replace `const actions = ...; host.append(...)` tail of `renderDetail` with a call:

```ts
    const actions = this.renderActions(wt, size);
    host.append(title, path, summary, files, disk, actions);
```

Add the method:

```ts
  private renderActions(wt: GitWorktreeSummary, size?: { total: number; target: number }): HTMLElement {
    const row = document.createElement("div");
    row.className = "wt-d-actions";
    const btn = (text: string, cls: string, fn: () => void, disabled = false): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `wt-act ${cls}`;
      b.textContent = text;
      b.disabled = disabled;
      b.addEventListener("click", fn);
      row.appendChild(b);
      return b;
    };

    if (!wt.current && !wt.is_main) {
      btn("Open tab", "wt-act-open", () => { this.opts.onOpenTab(wt.path); this.close(); });
    }
    btn("View diff", "wt-act-diff", () => {
      window.dispatchEvent(new CustomEvent("covenant:open-changes", { detail: { cwd: wt.path } }));
      this.close();
    });

    // Clean build artifacts — guarded on the live/current worktree.
    const isLive = this.opts.liveRoot() === wt.path || wt.current;
    const hasTarget = !size || size.target > 0;
    if (hasTarget) {
      const freed = size ? ` (${humanSize(size.target)})` : "";
      btn("Clean build artifacts" + freed, "wt-act-clean", () => {
        const warn = isLive ? "\n\nThis worktree built the running app — cleaning target/ mid-run can crash the dev build." : "";
        if (!window.confirm(`Delete ${compactPath(wt.path)}/target/?${warn}`)) return;
        void worktreeCleanTarget(wt.path).then(() => {
          this.sizes.delete(wt.path);
          void this.loadSizes();
        }).catch((e) => window.alert(`Clean failed: ${String(e)}`));
      });
    }

    // State action (prune/reclaim/relocate/retire) — reuse the popover verdict.
    const act = worktreeDefaultAction(wt, this.opts.getOccupiedCwds());
    if (act === "prune" || act === "reclaim") {
      btn(act === "prune" ? "Prune" : "Reclaim", "wt-act-danger", () => {
        if (!window.confirm(`Remove worktree ${worktreeLabel(wt)}? This deletes the checkout.`)) return;
        void worktreeReclaim(this.repoRoot, [wt.path]).then(() => { this.selected = null; void this.refresh(); })
          .catch((e) => window.alert(`Reclaim failed: ${String(e)}`));
      });
    } else if (act === "relocate") {
      btn("Relocate", "wt-act", () => {
        void worktreeRelocate(this.repoRoot, wt.path).then(() => void this.refresh())
          .catch((e) => window.alert(`Relocate failed: ${String(e)}`));
      });
    }
    return row;
  }
```

Note: `window.confirm`/`window.alert` are used to match the existing popover's confirm flow — verify the popover uses them too (`grep -n "confirm(" ui/src/status/bar.ts`). If the app has a custom confirm/toast, swap to it; do NOT introduce a JS `alert` if the codebase forbids modal dialogs (browser-automation note) — but this is the desktop webview, where the popover already confirms this way.

- [ ] **Step 3: Update `main.ts` construction**

Replace `new WorktreesSurface(worktreesHost)` with:

```ts
  const worktreesSurface = new WorktreesSurface(worktreesHost, {
    onOpenTab: (path) => { statusBar.onOpenGitWorktree?.(path); },
    getOccupiedCwds: () => statusBar.getOccupiedCwds?.() ?? new Set(),
    liveRoot: () => manager.liveWorktreeRoot ?? null,
  });
```

Verify the exact names: `grep -n "onOpenGitWorktree\|getOccupiedCwds\|liveWorktreeRoot" ui/src/main.ts ui/src/status/bar.ts ui/src/tabs/manager.ts`. Adjust the three callbacks to the real accessors (the summary map named `onOpenGitWorktree`, `getOccupiedCwds`, and `liveWorktreeRoot`). If `onOpenGitWorktree` isn't directly reachable, dispatch the same event the popover's "Open tab" button dispatches.

- [ ] **Step 4: CSS for buttons**

Append to `worktrees.css`:

```css
.wt-act {
  padding: 6px 12px; font-size: 12px; cursor: pointer;
  background: var(--bg-elev, #1a1a1e); color: inherit;
  border: 1px solid var(--border, #333); border-radius: 0;
}
.wt-act:hover:not(:disabled) { background: var(--bg-elev-2, #24242a); }
.wt-act:disabled { opacity: 0.4; cursor: default; }
.wt-act-danger { border-color: var(--danger, #a33); }
```

- [ ] **Step 5: Verify**

Run: `npm run build 2>&1 | tail -15` → passes.
Live: on a non-current worktree — "Open tab" opens it and closes the page; "View diff" opens Changes for that worktree; "Clean build artifacts (X GB)" confirms then frees space (size updates); a spent/orphan worktree shows Prune/Reclaim. On the current/live worktree, the clean confirm carries the extra warning.

- [ ] **Step 6: Commit**

```bash
git add ui/src/worktrees/index.ts ui/src/main.ts ui/src/worktrees/worktrees.css
git commit -m "feat(worktrees): row actions — open tab, view diff, clean target, prune/reclaim/relocate"
```

---

### Task 8: Full green + design audit

**Files:** none (verification task).

- [ ] **Step 1: Full test suite**

Run: `npm test 2>&1 | tail -20` → all pass.
Run: `cargo test -p covenant-app 2>&1 | tail -20` → all pass (note: some telegram tests hang under broad `cargo test --workspace`; scope to `-p covenant-app`).

- [ ] **Step 2: Format + lint**

Run: `cargo fmt --all && cargo clippy -p covenant-app --all-targets 2>&1 | tail -20` → no warnings on new code.
Run: `npm run build 2>&1 | tail -15` → clean.

- [ ] **Step 3: Design audit**

Dispatch the `design-rules-auditor` agent on the diff (`git diff main...HEAD`) to check docs/DESIGN.md hard rules (sharp corners, no native tooltips, no emoji, SVG icons, light/dark). Fix any blockers it reports.

- [ ] **Step 4: Live smoke**

Use the `verify-live` skill: open the page, confirm sizes/sort/select/detail/actions, clean a `target/` on a throwaway worktree and confirm the freed space, close with Esc. Record what was observed.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "chore(worktrees): design-audit + lint fixes"
```

---

## Self-Review

**Spec coverage:**
- Full-screen surface (Changes/Pulse pattern) → Task 4. ✓
- Master/detail layout → Tasks 5 (left) + 6 (right). ✓
- Disk total + bar, biggest-first → Task 5. ✓
- `target/` reclaimable figure via `worktreeSizes` `/target` trick → Task 3 + 5/6. ✓
- Structured "what was this working on" (branch, last commit, diffstat, files) → Task 1 + 6. ✓
- Actions: Open tab, View diff, Clean target (live-guarded), state action → Task 7. ✓
- `worktree_detail` + `worktree_clean_target` Rust commands with tests → Tasks 1, 2. ✓
- `node_modules` symlink never touched; symlinked `target` refused → Task 2 test. ✓
- Popover "Manage worktrees" link, popover otherwise unchanged → Task 4. ✓
- ⌘⌥W shortcut (⌘⇧W was taken by close-tab) + `covenant:open-worktrees` event → Task 4. ✓
- Frontend size-split vitest → Task 3. ✓

**Placeholder scan:** No TBD/TODO. Two spots defer to a `grep` to confirm real accessor names (`escapeHtml`/relative-time util in Task 6; `onOpenGitWorktree`/`getOccupiedCwds`/`liveWorktreeRoot` in Task 7) — these are verification steps with a concrete fallback, not placeholders.

**Type consistency:** `WorktreeDetail` fields (`last_subject`/`insertions`/`deletions`) identical Rust↔TS. `splitSizes` returns `{ total, target }` used verbatim in Tasks 5–7. `worktreeCleanTarget` returns `number` (KB), consumed in Task 7. `worktreeDefaultAction` action strings (`prune`/`reclaim`/`relocate`) match `worktree-state.ts:4`.

**Deviations from spec, noted:** Clean-target guard uses `.git`-existence instead of a full `git worktree list` cross-check (ponytail comment names the ceiling). Everything else matches the spec.
