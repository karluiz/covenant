# Worktree Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Covenant creates the worktree and launches the executor inside it, so no coding agent ever reaches the question of where a worktree goes.

**Architecture:** One new Rust function (`create_worktree`) that places worktrees at the canonical root using the same structural main-worktree identification the lifecycle feature already relies on, plus a `worktree: bool` flag on `SpawnSpec` defaulting to true for every spawn but the base shell. The three launch paths resolve a worktree before launching; tab close removes it again when it provably holds nothing. No new persistence — every decision is derived from git plus the existing tab snapshots.

**Tech Stack:** Rust (`crates/app/src/git_tools.rs`, `crates/app/src/spawns_store.rs`, `crates/app/src/lib.rs`), TypeScript (`ui/src/spawns/`, `ui/src/main.ts`, `ui/src/tabs/manager.ts`, `ui/src/api.ts`), tests via `cargo test` + `vitest`.

**Spec:** `docs/superpowers/specs/2026-07-19-worktree-prevention-design.md`

## Global Constraints

- No `unwrap()` outside `#[cfg(test)]` and `main()`.
- `git_tools.rs` returns `Result<_, String>` — follow the file's existing convention. No thiserror/anyhow there.
- Public types derive `Debug` + `Clone`; anything crossing IPC derives `Serialize`.
- TypeScript `strict: true`. No `as any` without a justifying comment.
- New/changed UI chrome: `border-radius: 0` (DESIGN.md hard rule). Exception: 50% dots.
- Chrome glyphs are inline SVG via `Icons.*`, never emoji.
- Never `element.title` for tooltips — always `attachTooltip`.
- Never `window.confirm` / `alert` / `prompt` — a native modal freezes the whole webview.
- Toast messages render via `textContent` — do NOT `escapeHtml` toast copy. Row/markup strings DO need escaping.
- UI copy is English.
- Canonical worktree root is `CANONICAL_WORKTREE_DIR` = `.covenant/worktrees`, resolved against the **main** worktree.
- Run tests from the repo ROOT of the worktree: `cargo test -p covenant`, `npm test`, `npm run build`.
- Do NOT run `cargo fmt --all` — this repo has ~43 files of pre-existing drift; reformatting them is out of scope.
- Conventional Commits.

## The trap this feature keeps falling into

`GitWorktreeSummary.current` means **"matches the cwd this call was made with"**, NOT "is the repository's main worktree". Covenant's own workflow does feature work inside `.covenant/worktrees/<slug>`, so a linked cwd is the NORMAL case. Conflating the two produced three separate defects in the predecessor, two of them Critical.

The main worktree is always the **first entry** of `git worktree list --porcelain`. `repo_summary` and `relocate_worktree` both already rely on exactly that (`summary.worktrees.first()`). Reuse it. Do not introduce a second mechanism.

## Known pre-existing failures — do not attribute to this branch, do not fix

- 9 vitest files / 7 tests: landing-astro tsconfig, notch/store, spec-chat, tasker/board, teammate/task-card, workspaces/manager (jsdom timing).
- A compile error in `crates/capabilities/examples/scan_real.rs` blocks `cargo test --workspace`. Use `cargo test -p covenant`.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `crates/app/src/git_tools.rs` | `create_worktree`, `agent_slug`, retirement predicate | Modify |
| `crates/app/src/spawns_store.rs` | `SpawnSpec.worktree` + its default | Modify |
| `crates/app/src/lib.rs` | Tauri command registration | Modify |
| `ui/src/api.ts` | Typed IPC wrappers | Modify |
| `ui/src/spawns/types.ts` | `SpawnSpec.worktree` | Modify |
| `ui/src/spawns/worktree-launch.ts` | Pure decision: does this spawn get a worktree, and what slug | Create |
| `ui/src/spawns/worktree-launch.test.ts` | Tests for the above | Create |
| `ui/src/main.ts` | Wire the three launch paths | Modify |
| `ui/src/tabs/manager.ts` | Retire the worktree on tab close | Modify |

---

### Task 1: Create a worktree at the canonical root

**Files:**
- Modify: `crates/app/src/git_tools.rs`
- Test: `crates/app/src/git_tools.rs` (`mod tests`)

**Interfaces:**
- Consumes: `CANONICAL_WORKTREE_DIR`, `repo_summary()`, `default_branch()`, `canonical_or_self()`, `git()`, test helpers `git_run()` / `init_repo()`
- Produces: `pub fn create_worktree(cwd: &Path, slug: &str, base: Option<&str>) -> Result<String, String>`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `crates/app/src/git_tools.rs`:

```rust
    #[test]
    fn create_worktree_lands_under_the_canonical_root() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);

        let path = create_worktree(root, "agent/claude-0719-a3f", None).unwrap();
        let expected = canonical_or_self(
            &root.join(CANONICAL_WORKTREE_DIR).join("agent-claude-0719-a3f"),
        );
        assert_eq!(canonical_or_self(Path::new(&path)), expected, "got {path}");
        assert!(Path::new(&path).is_dir());
    }

    #[test]
    fn create_worktree_lands_under_the_MAIN_root_when_called_from_a_linked_worktree() {
        // The bug shape that shipped twice in the predecessor: deriving the
        // canonical root from the CALLING cwd instead of the main worktree.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let caller = root.join(CANONICAL_WORKTREE_DIR).join("caller");
        git_run(root, &["worktree", "add", "-q", caller.to_str().unwrap(), "-b", "caller"]);

        let path = create_worktree(&caller, "agent/codex-0719-b7c", None).unwrap();
        let expected = canonical_or_self(
            &root.join(CANONICAL_WORKTREE_DIR).join("agent-codex-0719-b7c"),
        );
        assert_eq!(canonical_or_self(Path::new(&path)), expected, "got {path}");
        assert!(!path.contains("caller"), "must not nest inside the caller: {path}");
        // The caller must not be dirtied as a side effect.
        assert_eq!(status_count(&caller).unwrap(), 0);
    }

    #[test]
    fn create_worktree_refuses_a_slug_that_already_exists() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        create_worktree(root, "agent/dup-0719-aaa", None).unwrap();
        let err = create_worktree(root, "agent/dup-0719-aaa", None).unwrap_err();
        assert!(err.contains("already exists"), "got {err}");
    }

    #[test]
    fn create_worktree_branches_from_the_default_branch_when_base_is_none() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        // Move the caller off main so "branches from HEAD" would be visibly wrong.
        git_run(root, &["switch", "-q", "-c", "side"]);
        std::fs::write(root.join("side-only.txt"), "x\n").unwrap();
        git_run(root, &["add", "."]);
        git_run(root, &["commit", "-q", "-m", "side commit"]);

        let path = create_worktree(root, "agent/base-0719-ccc", None).unwrap();
        assert!(
            !Path::new(&path).join("side-only.txt").exists(),
            "must branch from the default branch, not the caller's HEAD",
        );
    }

    #[test]
    fn create_worktree_honors_an_explicit_base() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        git_run(root, &["switch", "-q", "-c", "side"]);
        std::fs::write(root.join("side-only.txt"), "x\n").unwrap();
        git_run(root, &["add", "."]);
        git_run(root, &["commit", "-q", "-m", "side commit"]);
        git_run(root, &["switch", "-q", "main"]);

        let path = create_worktree(root, "agent/explicit-0719-ddd", Some("side")).unwrap();
        assert!(Path::new(&path).join("side-only.txt").exists());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant git_tools::tests::create_worktree 2>&1 | tail -20`
Expected: FAIL — `cannot find function 'create_worktree'`.

- [ ] **Step 3: Implement**

Add to `crates/app/src/git_tools.rs`, near `relocate_worktree`:

```rust
/// Creates a worktree for `slug` under the canonical root and returns its path.
///
/// `base` defaults to the repo's default branch — an agent should start from
/// shared main, not from the half-finished state of whatever branch the caller
/// happens to be standing on.
///
/// The canonical root is anchored to the MAIN worktree, never to `cwd`:
/// `repo_summary` is normally called with a linked worktree's cwd (Covenant
/// does feature work inside `.covenant/worktrees/<slug>`), and anchoring to the
/// caller nests new worktrees inside sibling ones.
pub fn create_worktree(cwd: &Path, slug: &str, base: Option<&str>) -> Result<String, String> {
    if slug.trim().is_empty() {
        return Err("empty worktree slug".into());
    }
    let summary = repo_summary(cwd)?;
    // `git worktree list --porcelain` always lists the main worktree first;
    // `summary.worktrees` preserves that ordering. Same single mechanism
    // `relocate_worktree` and `off_convention` already use.
    let main_root = summary
        .worktrees
        .first()
        .map(|w| PathBuf::from(&w.path))
        .ok_or_else(|| "no worktrees reported by git".to_string())?;

    let dir_name = slug.replace('/', "-");
    let root = main_root.join(CANONICAL_WORKTREE_DIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let dest = root.join(&dir_name);
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }

    let base_ref = base
        .map(str::to_string)
        .unwrap_or_else(|| default_branch(cwd));
    let dest_str = dest.to_string_lossy().to_string();
    git(cwd, &["worktree", "add", "-q", &dest_str, "-b", slug, &base_ref])?;
    Ok(dest_str)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p covenant git_tools:: 2>&1 | tail -20`
Expected: PASS — the five new tests plus every pre-existing one.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/git_tools.rs
git commit -m "feat(worktrees): create a worktree at the canonical root"
```

---

### Task 2: Decide when a worktree is retired

**Files:**
- Modify: `crates/app/src/git_tools.rs`
- Test: `crates/app/src/git_tools.rs` (`mod tests`)

**Interfaces:**
- Consumes: `repo_summary()`, `default_branch()`, `canonical_or_self()`, `git()`, `CANONICAL_WORKTREE_DIR`
- Produces: `pub fn retire_worktree(cwd: &Path, path: &str) -> Result<bool, String>` — `Ok(true)` when removed, `Ok(false)` when deliberately kept, `Err` only on a git failure

A worktree with no commits of its own and a clean tree contains nothing, so removing it is lossless — the same class of proof that makes `Spent` safe to reclaim, reached by a different route. Anything else stays and the lifecycle ledger classifies it later.

The "no other tab is standing in it" condition is NOT checked here: this layer cannot see sessions. The frontend enforces that half (Task 6), exactly as it does for relocate.

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn retire_removes_an_untouched_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let path = create_worktree(root, "agent/untouched-0719-aaa", None).unwrap();

        assert!(retire_worktree(root, &path).unwrap());
        assert!(!Path::new(&path).exists());
        let branches = git(root, &["branch", "--format=%(refname:short)"]).unwrap();
        assert!(
            !branches.lines().any(|l| l.trim() == "agent/untouched-0719-aaa"),
            "an empty worktree's branch has nothing in it either",
        );
    }

    #[test]
    fn retire_keeps_a_worktree_with_commits() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let path = create_worktree(root, "agent/worked-0719-bbb", None).unwrap();
        let wt = Path::new(&path);
        std::fs::write(wt.join("new.txt"), "real work\n").unwrap();
        git_run(wt, &["add", "."]);
        git_run(wt, &["commit", "-q", "-m", "real work"]);

        assert!(!retire_worktree(root, &path).unwrap());
        assert!(wt.exists());
    }

    #[test]
    fn retire_keeps_a_dirty_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let path = create_worktree(root, "agent/dirty-0719-ccc", None).unwrap();
        std::fs::write(Path::new(&path).join("tracked.txt"), "uncommitted\n").unwrap();

        assert!(!retire_worktree(root, &path).unwrap());
        assert!(Path::new(&path).exists());
    }

    #[test]
    fn retire_keeps_an_untracked_only_worktree() {
        // No commits and `git status` sees an untracked file: still someone's
        // work (a scratch file, a .env). Not ours to delete.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let path = create_worktree(root, "agent/scratch-0719-ddd", None).unwrap();
        std::fs::write(Path::new(&path).join("scratch.txt"), "notes\n").unwrap();

        assert!(!retire_worktree(root, &path).unwrap());
        assert!(Path::new(&path).exists());
    }

    #[test]
    fn retire_refuses_a_worktree_outside_the_canonical_root() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let stray = root.join("stray");
        git_run(root, &["worktree", "add", "-q", stray.to_str().unwrap(), "-b", "stray"]);

        assert!(!retire_worktree(root, stray.to_str().unwrap()).unwrap());
        assert!(stray.exists());
    }

    #[test]
    fn retire_refuses_the_main_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        assert!(!retire_worktree(root, root.to_str().unwrap()).unwrap());
        assert!(root.exists());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant git_tools::tests::retire 2>&1 | tail -20`
Expected: FAIL — `cannot find function 'retire_worktree'`.

- [ ] **Step 3: Implement**

```rust
/// Removes a worktree Covenant handed out, when it provably holds nothing.
///
/// Returns `Ok(true)` if it was removed, `Ok(false)` if it was deliberately
/// kept. Keeping is never an error — the lifecycle ledger classifies survivors
/// later as Active / Stale / Spent.
///
/// Conditions, all required: under the canonical root, not the main worktree,
/// no commits beyond its base, and a clean tree (untracked files count as
/// dirty — a scratch file is still someone's work).
///
/// The "no other tab is standing in it" condition lives in the caller: this
/// module has no visibility into sessions.
pub fn retire_worktree(cwd: &Path, path: &str) -> Result<bool, String> {
    let summary = repo_summary(cwd)?;
    let target = canonical_or_self(Path::new(path));

    let main_root = summary
        .worktrees
        .first()
        .map(|w| canonical_or_self(Path::new(&w.path)))
        .ok_or_else(|| "no worktrees reported by git".to_string())?;
    if target == main_root {
        return Ok(false);
    }
    if !target.starts_with(main_root.join(CANONICAL_WORKTREE_DIR)) {
        return Ok(false);
    }

    let Some(wt) = summary
        .worktrees
        .iter()
        .find(|w| canonical_or_self(Path::new(&w.path)) == target)
    else {
        return Ok(false);
    };
    if wt.dirty_count > 0 {
        return Ok(false);
    }
    let Some(branch) = wt.branch.as_deref() else {
        return Ok(false);
    };

    // `--porcelain` in status already counts untracked files, so dirty_count
    // covers scratch files. What is left to prove is "no commits of its own".
    let base = default_branch(cwd);
    let ahead = git(cwd, &["rev-list", "--count", &format!("{base}..{branch}")])
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(1); // unknown → assume it has work, keep it
    if ahead > 0 {
        return Ok(false);
    }

    git(cwd, &["worktree", "remove", &wt.path])?;
    // The branch has no commits beyond base, so -d cannot refuse it and there
    // is nothing to lose. Failure here is not fatal: the directory is already
    // gone and the ledger will surface a stray branch.
    let _ = git(cwd, &["branch", "-d", branch]);
    let _ = git(cwd, &["worktree", "prune"]);
    Ok(true)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p covenant git_tools:: 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/git_tools.rs
git commit -m "feat(worktrees): retire a handed-out worktree that holds nothing"
```

---

### Task 3: Expose both operations over IPC

**Files:**
- Modify: `crates/app/src/lib.rs` (add next to the existing `worktree_reclaim` / `worktree_relocate` commands, and to `tauri::generate_handler![...]`)
- Modify: `ui/src/api.ts`

**Interfaces:**
- Consumes: `git_tools::create_worktree`, `git_tools::retire_worktree`
- Produces: Tauri commands `worktree_create`, `worktree_retire`; TS wrappers `worktreeCreate(cwd, slug, base)`, `worktreeRetire(cwd, path)`

- [ ] **Step 1: Add the Rust commands**

In `crates/app/src/lib.rs`, beside the existing worktree commands:

```rust
#[tauri::command]
async fn worktree_create(
    cwd: String,
    slug: String,
    base: Option<String>,
) -> Result<String, String> {
    let root = PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || {
        git_tools::create_worktree(&root, &slug, base.as_deref())
    })
    .await
    .map_err(|e| format!("worktree_create join: {e}"))?
}

#[tauri::command]
async fn worktree_retire(cwd: String, path: String) -> Result<bool, String> {
    let root = PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || git_tools::retire_worktree(&root, &path))
        .await
        .map_err(|e| format!("worktree_retire join: {e}"))?
}
```

Add `worktree_create` and `worktree_retire` to the `tauri::generate_handler![...]` list.

- [ ] **Step 2: Add the TS wrappers**

In `ui/src/api.ts`, after the existing `worktreeRelocate`:

```ts
export async function worktreeCreate(
  cwd: string,
  slug: string,
  base?: string,
): Promise<string> {
  return invoke<string>("worktree_create", { cwd, slug, base: base ?? null });
}

/// Resolves true when the worktree was removed, false when it was kept
/// because it held something. Never throws for "kept".
export async function worktreeRetire(cwd: string, path: string): Promise<boolean> {
  return invoke<boolean>("worktree_retire", { cwd, path });
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo check -p covenant 2>&1 | tail -3 && npm run build 2>&1 | tail -3`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs ui/src/api.ts
git commit -m "feat(worktrees): expose create and retire over IPC"
```

---

### Task 4: Flag spawns for isolation

**Files:**
- Modify: `crates/app/src/spawns_store.rs` (`SpawnSpec` at :5-21)
- Modify: `ui/src/spawns/types.ts`
- Test: `crates/app/src/spawns_store.rs` (`mod tests`)

**Interfaces:**
- Produces: `SpawnSpec.worktree: bool` (Rust) and `SpawnSpec.worktree?: boolean` (TS)

The default is the design decision: **every spawn except the base shell**. A list of known executor ids would work today and leave tomorrow's executor unprotected — which is the original failure mode wearing a new hat.

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `crates/app/src/spawns_store.rs`:

```rust
    #[test]
    fn spawns_default_to_isolated() {
        let spec: SpawnSpec = serde_json::from_str(
            r#"{"id":"codex","label":"Codex","icon":null,"command":"codex","cwd":null}"#,
        )
        .unwrap();
        assert!(spec.worktree, "a spawn with no explicit flag is isolated");
    }

    #[test]
    fn an_explicit_false_is_honored() {
        let spec: SpawnSpec = serde_json::from_str(
            r#"{"id":"sh","label":"Shell","icon":null,"command":"zsh","cwd":null,"worktree":false}"#,
        )
        .unwrap();
        assert!(!spec.worktree);
    }

    #[test]
    fn a_pre_existing_spawns_json_still_parses() {
        // Installs upgrading from before this field must not break; they
        // inherit isolation rather than silently opting out.
        let legacy = r#"[{"id":"claude","label":"Claude","icon":null,"command":"claude","cwd":null}]"#;
        let specs: Vec<SpawnSpec> = serde_json::from_str(legacy).unwrap();
        assert_eq!(specs.len(), 1);
        assert!(specs[0].worktree);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant spawns_store:: 2>&1 | tail -20`
Expected: FAIL — `no field 'worktree' on type 'SpawnSpec'`.

- [ ] **Step 3: Implement**

Add to `SpawnSpec` in `crates/app/src/spawns_store.rs`, after `acp`:

```rust
    /// Launch this spawn inside a fresh worktree at the canonical root.
    ///
    /// Defaults to true for every spawn — the base shell is the one thing
    /// that opts out, and it does so explicitly. Keying the default off a
    /// list of known executor ids would leave tomorrow's executor
    /// unprotected, which is the original problem wearing a new hat.
    #[serde(default = "default_worktree")]
    pub worktree: bool,
```

and at module level:

```rust
fn default_worktree() -> bool {
    true
}
```

Every `SpawnSpec { .. }` literal in the file needs `worktree: true` (or `false` for a plain-shell preset, if one exists). Compile errors will point at each site.

- [ ] **Step 4: Mirror the field in TypeScript**

In `ui/src/spawns/types.ts`, after `acp`:

```ts
  /// Launch inside a fresh worktree at the canonical root. Optional:
  /// absent in pre-existing spawns.json, where it defaults to true.
  worktree?: boolean;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p covenant spawns_store:: 2>&1 | tail -10 && npm run build 2>&1 | tail -3`
Expected: PASS and a clean type-check.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/spawns_store.rs ui/src/spawns/types.ts
git commit -m "feat(spawns): isolate every spawn but the base shell by default"
```

---

### Task 5: The launch decision, as a pure module

**Files:**
- Create: `ui/src/spawns/worktree-launch.ts`
- Create: `ui/src/spawns/worktree-launch.test.ts`

**Interfaces:**
- Consumes: `SpawnSpec` from `./types`
- Produces: `wantsWorktree(spec: SpawnSpec): boolean`; `agentSlug(spec: SpawnSpec, now: Date, rand: () => number): string`

Kept pure and separate from `main.ts` so the slug rules and the opt-out are testable without mounting the app.

- [ ] **Step 1: Write the failing test**

Create `ui/src/spawns/worktree-launch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { wantsWorktree, agentSlug } from "./worktree-launch";
import type { SpawnSpec } from "./types";

const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({
  id: "codex",
  label: "Codex",
  icon: null,
  command: "codex",
  args: [],
  env: {},
  cwd: null,
  default: false,
  ...over,
});

describe("worktree launch decision", () => {
  it("isolates a spawn whose flag is absent — an older spawns.json opts in", () => {
    expect(wantsWorktree(spec())).toBe(true);
  });

  it("honors an explicit opt-out", () => {
    expect(wantsWorktree(spec({ worktree: false }))).toBe(false);
  });

  it("honors an explicit opt-in", () => {
    expect(wantsWorktree(spec({ worktree: true }))).toBe(true);
  });

  it("builds a slug that names the executor and the day", () => {
    const s = agentSlug(spec({ id: "copilot" }), new Date("2026-07-19T10:00:00Z"), () => 0.5);
    expect(s).toMatch(/^agent\/copilot-0719-[a-z0-9]{3}$/);
  });

  it("varies the suffix so two same-day launches do not collide", () => {
    const day = new Date("2026-07-19T10:00:00Z");
    const a = agentSlug(spec(), day, () => 0.1);
    const b = agentSlug(spec(), day, () => 0.9);
    expect(a).not.toBe(b);
  });

  it("produces a slug git accepts as a ref", () => {
    // No spaces, no double dots, no trailing slash, no leading dash.
    const s = agentSlug(spec({ id: "pi agent" }), new Date("2026-07-19T10:00:00Z"), () => 0.5);
    expect(s).not.toMatch(/\s|\.\.|^-|\/$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- worktree-launch`
Expected: FAIL — `Failed to resolve import "./worktree-launch"`.

- [ ] **Step 3: Implement**

Create `ui/src/spawns/worktree-launch.ts`:

```ts
import type { SpawnSpec } from "./types";

/// Absent means isolated. A spawns.json written before this field existed
/// opts IN, so upgrading installs get isolation without a migration.
export function wantsWorktree(spec: SpawnSpec): boolean {
  return spec.worktree !== false;
}

/// `agent/<executor>-<MMDD>-<suffix>`. Readable enough to answer "where did
/// this branch come from" months later — the `worktree-a3dd4e8417b0e2ebe`
/// branches this repo accumulated are the counter-example.
///
/// `now` and `rand` are injected so the slug is testable.
export function agentSlug(spec: SpawnSpec, now: Date, rand: () => number): string {
  const executor = spec.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    || "agent";
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const suffix = Math.floor(rand() * 46656).toString(36).padStart(3, "0").slice(-3);
  return `agent/${executor}-${mm}${dd}-${suffix}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- worktree-launch`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/spawns/worktree-launch.ts ui/src/spawns/worktree-launch.test.ts
git commit -m "feat(spawns): pure launch decision and agent slug"
```

---

### Task 6: Launch every agent inside its worktree

**Files:**
- Modify: `ui/src/main.ts` — `runSpawn` (around :1253-1280), `manager.defaultAgentCmdline` (around :1307-1315)

**Interfaces:**
- Consumes: `wantsWorktree`, `agentSlug`, `worktreeCreate`, `manager.createTab({cwd, initialCommand})`, `manager.createAcpTab({cwd, executor})`, `pushInfoToast`
- Produces: nothing new — this task wires existing pieces

**Behaviour change, accepted deliberately:** today a PTY spawn writes into the terminal you are standing in. In worktree mode it opens a new tab instead, so agents are born isolated on every path. A spawn with `worktree: false` keeps today's in-place behaviour untouched.

**Isolation must never be why an agent fails to start.** If `worktreeCreate` throws, launch in the current cwd and surface the reason — degraded, never blocked.

- [ ] **Step 1: Add the imports**

In `ui/src/main.ts`:

```ts
import { wantsWorktree, agentSlug } from "./spawns/worktree-launch";
import { worktreeCreate } from "./api";
```

(`pushInfoToast` is already imported in this file.)

- [ ] **Step 2: Resolve the worktree before launching**

Inside the `runSpawn` closure in `ui/src/main.ts`, after `const spec = specs.find((s) => s.id === id);` and its guard, insert:

```ts
        // Covenant hands out the worktree so no executor ever reaches the
        // question of where one goes. Failure here degrades to the current
        // cwd — isolation must never be why an agent fails to start.
        const baseCwd = manager.activeCwd();
        let launchCwd = baseCwd;
        let isolated = false;
        if (wantsWorktree(spec) && baseCwd) {
          try {
            launchCwd = await worktreeCreate(
              baseCwd,
              agentSlug(spec, new Date(), Math.random),
            );
            isolated = true;
          } catch (e) {
            pushInfoToast({ message: `Launching in place — worktree failed: ${String(e)}` });
          }
        }
```

- [ ] **Step 3: Use it on the ACP path**

Replace the `createAcpTab` call in `runSpawn`:

```ts
        if (acpExec) {
          await manager.createAcpTab({
            cwd: launchCwd,
            executor: acpExec,
          });
          return;
        }
```

- [ ] **Step 4: Use it on the PTY path**

Replace the body after `const cmdline = ...` in `runSpawn`:

```ts
        const cmdline = buildSpawnCmdline(spec, claudeTheme()) + "\n";
        if (isolated && launchCwd) {
          // A PTY spawn normally writes into the session you are already in.
          // There is no cwd to set on that path, so isolation means a new tab.
          await manager.createTab({ cwd: launchCwd, initialCommand: cmdline });
          manager.setActiveSpawnId(spec.id);
          await chip.refresh();
          requestAnimationFrame(() => manager.focusActive());
          return;
        }
        const bytes = new TextEncoder().encode(cmdline);
        await writeToSession(sid, bytes);
        manager.setActiveSpawnId(spec.id);
        await chip.refresh();
        // Focus last, after the chip DOM is rebuilt and a frame has passed —
        // otherwise the run <button> click + chip refresh race the terminal
        // focus and it intermittently doesn't stick. ponytail: rAF is enough.
        requestAnimationFrame(() => manager.focusActive());
```

- [ ] **Step 5: Leave the third launch path alone, deliberately**

`manager.defaultAgentCmdline` (around `ui/src/main.ts:1307`) returns a cmdline string for the group context menu's "Start new agent", which preloads it into a fresh tab created by the caller. It hands back a string, not a tab, so it has nowhere to put a cwd.

Do NOT change its signature in this task. Add this comment above it so the omission is a recorded decision rather than an oversight:

```ts
    // ponytail: not worktree-aware. This returns a cmdline string; the CALLER
    // creates the tab, so there is no cwd to set from here. Making it isolated
    // means changing its contract to return {cmdline, cwd} and updating every
    // caller — worth doing only if this path turns out to be a real source of
    // stray worktrees. runSpawn (the Ctrl+N / picker / "Start agent" path) is
    // the one that filled .claude/worktrees.
```

- [ ] **Step 6: Verify the build**

Run: `npm run build 2>&1 | tail -3 && npm test -- worktree-launch 2>&1 | tail -4`
Expected: clean type-check, 6 tests passing.

- [ ] **Step 7: Commit**

```bash
git add ui/src/main.ts
git commit -m "feat(spawns): launch agents inside a Covenant-created worktree"
```

---

### Task 7: Retire the worktree when its tab closes

**Files:**
- Modify: `ui/src/tabs/manager.ts` — `finalizeCloseTab` (around :6066)
- Test: `ui/src/tabs/manager.test.ts` (create the describe block if the file has none for close behaviour)

**Interfaces:**
- Consumes: `worktreeRetire` from `../api`, `this.listTabSnapshots()`
- Produces: nothing new

The backend proves "holds nothing"; this layer proves "nobody is standing in it", because only the frontend can see tabs. Same split as the relocate guard.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/tabs/manager.test.ts`:

```ts
describe("worktree retirement on tab close", () => {
  it("does not retire a worktree another tab is still standing in", async () => {
    const occupied = ["/repo/.covenant/worktrees/agent-codex-0719-aaa"];
    expect(shouldRetire("/repo/.covenant/worktrees/agent-codex-0719-aaa", occupied)).toBe(false);
  });

  it("retires a worktree no remaining tab occupies", () => {
    expect(shouldRetire("/repo/.covenant/worktrees/agent-codex-0719-aaa", ["/repo"])).toBe(true);
  });

  it("treats a nested cwd as occupying the worktree", () => {
    // The agent cd'd into a subdirectory; the worktree is still in use.
    const occupied = ["/repo/.covenant/worktrees/agent-codex-0719-aaa/crates/app"];
    expect(shouldRetire("/repo/.covenant/worktrees/agent-codex-0719-aaa", occupied)).toBe(false);
  });

  it("never retires when the closing tab has no cwd", () => {
    expect(shouldRetire(null, [])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- manager`
Expected: FAIL — `shouldRetire is not defined`.

- [ ] **Step 3: Implement the predicate**

Export it from `ui/src/tabs/manager.ts` (module level, above the class) so the test can reach it without constructing a manager:

```ts
/// Whether the closing tab's worktree may be handed to the backend for
/// retirement. Proves only the half this layer can see — "no remaining tab is
/// standing in it". The backend independently proves it holds no work.
export function shouldRetire(closingCwd: string | null, remainingCwds: string[]): boolean {
  if (!closingCwd) return false;
  const prefix = closingCwd.endsWith("/") ? closingCwd : `${closingCwd}/`;
  return !remainingCwds.some((c) => c === closingCwd || c.startsWith(prefix));
}
```

- [ ] **Step 4: Call it from `finalizeCloseTab`**

In `ui/src/tabs/manager.ts`, inside `finalizeCloseTab`, after the tab has been removed from `this.tabs` (so `listTabSnapshots()` no longer includes it):

```ts
    // Covenant handed this worktree out; take it back when it holds nothing.
    // Fire-and-forget: a failed retirement leaves a worktree the lifecycle
    // ledger will classify later, which is strictly better than blocking a
    // tab close on git.
    const closingCwd = tab.cwd ?? null;
    if (closingCwd) {
      const remaining = this.listTabSnapshots().map((t) => t.cwd).filter((c): c is string => !!c);
      if (shouldRetire(closingCwd, remaining)) {
        void worktreeRetire(closingCwd, closingCwd).catch(() => {
          /* keep quiet: the ledger surfaces anything left behind */
        });
      }
    }
```

Add the import at the top of the file:

```ts
import { worktreeRetire } from "../api";
```

If `tab.cwd` is not the field name on the Tab type, use whatever `listTabSnapshots()` reports as `cwd` for the closing tab — read the type before writing this.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- manager 2>&1 | tail -5 && npm run build 2>&1 | tail -3`
Expected: PASS and a clean type-check.

- [ ] **Step 6: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/tabs/manager.test.ts
git commit -m "feat(worktrees): retire a handed-out worktree when its tab closes"
```

---

### Task 8: Surface the toggle in Harnesses

**Files:**
- Modify: `ui/src/settings/spawns.ts` — the ACP checkbox row is at :259-278, `collect()` at :292-303

**Interfaces:**
- Consumes: `SpawnSpec.worktree`, `attachTooltip`
- Produces: nothing new

The ACP toggle immediately above is the pattern: a `<label class="spawns-md-acp">` wrapping a checkbox and a `<span>`, persisted through `collect()` → `persist()`. Mirror it exactly rather than inventing a control.

- [ ] **Step 1: Add the row**

In `ui/src/settings/spawns.ts`, directly after the `detailHost.appendChild(acpRow);` line (:269):

```ts
    // Isolation toggle. Unlike ACP this is not gated on the command — every
    // spawn can be isolated, and every spawn but the base shell is by default.
    const wtRow = document.createElement("label");
    wtRow.className = "spawns-md-acp";
    wtRow.dataset["role"] = "worktree";
    const wtCheck = document.createElement("input");
    wtCheck.type = "checkbox";
    // Absent means isolated — a spawns.json written before this field existed
    // opts IN, so upgrading installs inherit isolation without a migration.
    wtCheck.checked = spec.worktree !== false;
    const wtText = document.createElement("span");
    wtText.textContent = "Isolate in a worktree";
    wtRow.append(wtCheck, wtText);
    attachTooltip(wtRow, {
      text: "Covenant creates a worktree for this spawn and launches it there, so the agent never picks its own location.",
    });
    detailHost.appendChild(wtRow);
    wtCheck.addEventListener("change", () => { void persist(); });
```

Add `attachTooltip` to the file's imports if it is not already there (`import { attachTooltip } from "../tooltip/tooltip";`). If its options object takes a different shape in this codebase, match the shape used by other call sites in `ui/src/settings/` — read one before writing.

- [ ] **Step 2: Persist it**

In `collect()` (:292-303), extend the returned object:

```ts
      return {
        ...draft,
        acp: acpCheck.checked && acpExecutorFor(draft) !== null,
        worktree: wtCheck.checked,
      };
```

- [ ] **Step 3: Verify the round-trip**

Run: `npm run build 2>&1 | tail -3 && npm test -- spawns 2>&1 | tail -4`
Expected: clean type-check; any existing spawns settings tests still pass.

Then confirm by hand that toggling the checkbox writes `"worktree": false` into `spawns.json` and that reopening the panel shows it unchecked — the flag has to survive a round trip, not just render.

- [ ] **Step 4: Commit**

```bash
git add ui/src/settings/spawns.ts
git commit -m "feat(settings): toggle worktree isolation per spawn"
```

---

### Task 9: Verify live and reconcile the spec

**Files:**
- Modify: `docs/superpowers/specs/2026-07-19-worktree-prevention-design.md`

- [ ] **Step 1: Lint**

Run: `cargo clippy -p covenant --lib --all-targets 2>&1 | grep -B2 "git_tools.rs\|spawns_store.rs" | head -20`
Expected: no findings in the files this branch touched. Do NOT run `cargo fmt --all`.

- [ ] **Step 2: Full test sweep**

Run: `cargo test -p covenant 2>&1 | grep "^test result:" | head -3 && npm test 2>&1 | tail -4`
Expected: Rust green; vitest shows the documented pre-existing failure set (9 files / 7 tests) and nothing more.

- [ ] **Step 3: Verify live**

Use the `verify` skill (DOM-dump recipe). Confirm in a running dev build:
- launching an executor spawn opens a tab whose cwd is under `.covenant/worktrees/`,
- the branch name matches `agent/<executor>-<MMDD>-<suffix>`,
- closing that tab without doing any work removes the worktree AND its branch,
- launching a spawn with `worktree: false` still runs in place, in the current terminal,
- `git worktree list` is back to its starting length afterwards.

Poll for every element — do not use fixed `setTimeout` waits. Launch the dev app with the cd inlined in the command (`npm --prefix <worktree> run tauri:dev`); a backgrounded `cd` does not persist and will silently run `main` instead of this branch.

- [ ] **Step 4: Reconcile the spec**

Update `docs/superpowers/specs/2026-07-19-worktree-prevention-design.md` to match what shipped: correct any behaviour that changed during implementation, and record the live-verification result.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-19-worktree-prevention-design.md
git commit -m "docs: reconcile the worktree prevention spec with the implementation"
```

---

## Deferred

- **The Canon artifact** projecting the convention into `AGENTS.md` / `CLAUDE.md` / copilot instructions. Separate subsystem; drops in priority now that Covenant hands out the worktree, since a written rule becomes the backstop for work Covenant did not launch rather than the mechanism.
- **Renaming the branch from the LLM tab title** once `acp_suggest_title` lands one. Two words beat any slug, and `git branch -m` moves the worktree with it.
- **Cross-repo scope.** `covenant-server` has the same mess and the ledger does not reach it.
