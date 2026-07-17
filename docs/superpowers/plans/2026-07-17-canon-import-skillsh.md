# Canon Import from skills.sh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user paste a skills.sh ref (`owner/repo --skill name`) in Canon's Skills section and have Canon run `npx skills add`, then auto-adopt the newly-landed skill(s) into Canon source.

**Architecture:** Import is orchestration over two existing pieces — the skills.sh CLI and sub-project A's `adopt`. A new app command validates the ref, snapshots detected skills, shells `npx --yes skills add <ref>` (arg-vector, no shell), then adopts whatever newly appeared under `.claude/skills`. The testable core (`adopt_new_skills`) lives in the canon crate; the npx shell-out lives in the app crate.

**Tech Stack:** Rust (`crates/canon`, `crates/app` Tauri command, `tokio::process`), TypeScript (`ui/src/canon/cockpit`, `ui/src/api.ts`). No new dependencies.

## Global Constraints

- Canon crate cargo package is **`karl-canon`**; app crate is **`covenant`**. Canon tests: `cargo test -p karl-canon --lib <filter>`. App tests: `cargo test -p covenant --lib <filter>`. Never `cargo test` (whole workspace hangs on `telegram::tests`).
- No new crates/npm deps. `tokio` is `features=["full"]` at workspace root → `tokio::process` + `tokio::time::timeout` are available.
- Rust: no `unwrap()` outside `#[cfg(test)]`; `CanonError` inside `crates/canon`.
- **Security:** the ref is user input that becomes a spawned process. Parse + whitelist; pass an argument vector to `Command` — NEVER build a shell string.
- Scope: **skills only**, paste-a-ref (no search, no `--list`).
- UI copy: English, sentence case; no emoji; SVG icons via `Icons.*`; no native `title` tooltips (use `pushInfoToast` for feedback).

---

## File Structure

- `crates/canon/src/install.rs` — MODIFY: add `adopt_new_skills`.
- `crates/canon/src/lib.rs` — MODIFY: re-export `adopt_new_skills`.
- `crates/app/src/lib.rs` — MODIFY: add `parse_skills_ref` (+ tests), `canon_import_skill` command, register in `generate_handler!`.
- `ui/src/api.ts` — MODIFY: add `canonImportSkill`.
- `ui/src/canon/cockpit/view.ts` — MODIFY: import bar in the Skills section + empty-state action.

---

## Task 1: `adopt_new_skills` — the testable core

**Files:**
- Modify: `crates/canon/src/install.rs`
- Modify: `crates/canon/src/lib.rs`
- Test: `crates/canon/src/install.rs`

**Interfaces:**
- Consumes: `crate::scan_detected`, `crate::adopt`, `crate::compile::slugify`, `ContextKind::Skill`.
- Produces: `pub fn adopt_new_skills(repo_root: &Path, before: &HashSet<String>) -> Result<Vec<String>, CanonError>`.

- [ ] **Step 1: Write the failing test**

Add to `crates/canon/src/install.rs` `#[cfg(test)] mod tests`:

```rust
    #[test]
    fn adopt_new_skills_adopts_only_the_delta() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Pre-existing foreign skill that is in `before` → must NOT be re-adopted.
        std::fs::create_dir_all(root.join(".claude/skills/old-skill")).unwrap();
        std::fs::write(root.join(".claude/skills/old-skill/SKILL.md"), "---\nname: old-skill\n---\nb\n").unwrap();
        let before: std::collections::HashSet<String> = ["old-skill".to_string()].into_iter().collect();

        // A new foreign skill (as if npx just added it) + one with an uppercase name.
        std::fs::create_dir_all(root.join(".claude/skills/pdf-tools")).unwrap();
        std::fs::write(root.join(".claude/skills/pdf-tools/SKILL.md"), "---\nname: pdf-tools\n---\nb\n").unwrap();
        std::fs::create_dir_all(root.join(".claude/skills/CoolTool")).unwrap();
        std::fs::write(root.join(".claude/skills/CoolTool/SKILL.md"), "---\nname: CoolTool\n---\nb\n").unwrap();

        let mut adopted = crate::adopt_new_skills(root, &before).unwrap();
        adopted.sort();
        assert_eq!(adopted, vec!["cooltool".to_string(), "pdf-tools".to_string()], "delta adopted, uppercase slugified");
        assert!(root.join(".covenant/canon/skills/pdf-tools/SKILL.md").exists(), "new skill in canon source");
        assert!(root.join(".covenant/canon/skills/cooltool/SKILL.md").exists(), "uppercase slugified into source");
        // old-skill was in `before` → left foreign, not adopted.
        assert!(!root.join(".covenant/canon/skills/old-skill").exists(), "before-set skill not re-adopted");
        assert!(root.join(".claude/skills/old-skill").exists(), "before-set skill left in place");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-canon --lib install::tests::adopt_new_skills`
Expected: FAIL — `adopt_new_skills` not defined.

- [ ] **Step 3: Implement `adopt_new_skills`**

Add to `crates/canon/src/install.rs`:

```rust
/// Adopt every DETECTED skill whose name is not already in `before`. Returns the
/// adopted names (post-slugify). Used by import: snapshot before an external
/// install, run the installer, then adopt whatever newly appeared under
/// `.claude/skills`. Best-effort — one skill failing to adopt does not sink the
/// batch.
pub fn adopt_new_skills(
    repo_root: &Path,
    before: &std::collections::HashSet<String>,
) -> Result<Vec<String>, CanonError> {
    let fresh: Vec<String> = crate::scan_detected(repo_root)?
        .into_iter()
        .filter(|u| u.kind == ContextKind::Skill && !before.contains(&u.name))
        .map(|u| u.name)
        .collect();
    let mut adopted = Vec::new();
    for name in fresh {
        if crate::adopt(repo_root, ContextKind::Skill, &name).is_ok() {
            adopted.push(crate::compile::slugify(&name));
        }
    }
    Ok(adopted)
}
```

Re-export in `crates/canon/src/lib.rs` — extend the `pub use install::{…}` line to add `adopt_new_skills`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-canon --lib install::tests::adopt_new_skills`
Expected: PASS.

- [ ] **Step 5: Run the canon suite (no regression)**

Run: `cargo test -p karl-canon --lib`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/canon/src/install.rs crates/canon/src/lib.rs
git commit -m "feat(canon): adopt_new_skills adopts the delta after an external install"
```

---

## Task 2: `parse_skills_ref` — ref validation (security boundary)

**Files:**
- Modify: `crates/app/src/lib.rs`
- Test: `crates/app/src/lib.rs`

**Interfaces:**
- Produces: `fn parse_skills_ref(input: &str) -> Result<Vec<String>, String>` — returns the full `npx` argument vector (`["--yes","skills","add",repo,"--skill",n1,…]`) or a human error. Consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Add to `crates/app/src/lib.rs` (in an existing `#[cfg(test)] mod tests` if present, else add one):

```rust
    #[test]
    fn parse_skills_ref_accepts_valid_and_rejects_injection() {
        // Accepts a bare repo, with --skill, and a pasted full command.
        assert_eq!(
            super::parse_skills_ref("owner/repo").unwrap(),
            vec!["--yes", "skills", "add", "owner/repo"]
        );
        assert_eq!(
            super::parse_skills_ref("owner/repo --skill frontend-design").unwrap(),
            vec!["--yes", "skills", "add", "owner/repo", "--skill", "frontend-design"]
        );
        assert_eq!(
            super::parse_skills_ref("npx skills add vercel-labs/agent-skills --skill a --skill b").unwrap(),
            vec!["--yes", "skills", "add", "vercel-labs/agent-skills", "--skill", "a", "--skill", "b"]
        );
        // Rejects injection / traversal / stray flags.
        for bad in [
            "owner/repo; rm -rf ~",
            "owner/repo`whoami`",
            "owner/repo && curl evil",
            "../escape/repo",
            "owner/repo --other",
            "owner/repo --skill x;y",
            "owner/repo/extra",
            "",
        ] {
            assert!(super::parse_skills_ref(bad).is_err(), "must reject: {bad:?}");
        }
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p covenant --lib parse_skills_ref`
Expected: FAIL — `parse_skills_ref` not defined.

- [ ] **Step 3: Implement `parse_skills_ref`**

Add to `crates/app/src/lib.rs`:

```rust
/// One path segment (owner, repo, or skill name): non-empty, no leading dot
/// (blocks `..`), only `[A-Za-z0-9_.-]`. Anything else — slashes, shell
/// metacharacters, whitespace — is rejected.
fn valid_ref_seg(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('.')
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
}

/// Parse a user-pasted skills.sh ref into a safe `npx` argument vector. Accepts
/// `owner/repo`, `owner/repo --skill x --skill y`, and a pasted
/// `npx skills add owner/repo --skill x`. Rejects everything else — the args are
/// whitelisted so no shell metacharacter ever reaches a spawn.
fn parse_skills_ref(input: &str) -> Result<Vec<String>, String> {
    let s = input.trim();
    let s = s.strip_prefix("npx skills add ").map(str::trim).unwrap_or(s);
    let mut toks = s.split_whitespace();
    let repo = toks.next().ok_or_else(|| "empty ref".to_string())?;
    let repo_ok = match repo.split_once('/') {
        Some((o, r)) => valid_ref_seg(o) && valid_ref_seg(r),
        None => false,
    };
    if !repo_ok {
        return Err(format!("invalid repo (expected owner/repo): {repo:?}"));
    }
    let mut args = vec![
        "--yes".to_string(),
        "skills".to_string(),
        "add".to_string(),
        repo.to_string(),
    ];
    while let Some(t) = toks.next() {
        if t != "--skill" {
            return Err(format!("unexpected token {t:?} (only `--skill <name>` allowed)"));
        }
        let name = toks.next().ok_or_else(|| "`--skill` needs a name".to_string())?;
        if !valid_ref_seg(name) {
            return Err(format!("invalid skill name: {name:?}"));
        }
        args.push("--skill".to_string());
        args.push(name.to_string());
    }
    Ok(args)
}
```

Note: `repo.split_once('/')` yields `("owner","repo/extra")` for `owner/repo/extra`, and `valid_ref_seg("repo/extra")` fails on `/` → correctly rejected.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p covenant --lib parse_skills_ref`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(app): parse_skills_ref validates skills.sh refs (no shell injection)"
```

---

## Task 3: `canon_import_skill` command

**Files:**
- Modify: `crates/app/src/lib.rs`

**Interfaces:**
- Consumes: `parse_skills_ref` (Task 2), `karl_canon::{scan_detected, adopt_new_skills, ContextKind}` (Task 1).
- Produces: Tauri command `canon_import_skill(cwd: String, skill_ref: String) -> Result<Vec<String>, String>` (adopted slugs).

- [ ] **Step 1: Add the command**

Add to `crates/app/src/lib.rs`:

```rust
#[tauri::command]
async fn canon_import_skill(cwd: String, skill_ref: String) -> Result<Vec<String>, String> {
    let repo = std::path::PathBuf::from(&cwd);
    let args = parse_skills_ref(&skill_ref)?;

    // Snapshot skills already detected under .claude/skills before the install.
    let repo_b = repo.clone();
    let before = tokio::task::spawn_blocking(move || {
        karl_canon::scan_detected(&repo_b).map(|units| {
            units
                .into_iter()
                .filter(|u| u.kind == karl_canon::ContextKind::Skill)
                .map(|u| u.name)
                .collect::<std::collections::HashSet<String>>()
        })
    })
    .await
    .map_err(|e| format!("canon_import_skill snapshot join: {e}"))?
    .map_err(|e| e.to_string())?;

    // Run `npx --yes skills add <ref>` in the repo. stdin=null so an interactive
    // picker (bare repo) gets EOF and fails fast rather than hanging.
    let run = tokio::time::timeout(
        std::time::Duration::from_secs(120),
        tokio::process::Command::new("npx")
            .args(&args)
            .current_dir(&repo)
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await;
    let out = match run {
        Err(_) => {
            return Err("import timed out after 120s — a bare repo may be prompting; add `--skill <name>`".into())
        }
        Ok(Err(e)) => return Err(format!("could not run npx (is Node installed?): {e}")),
        Ok(Ok(o)) => o,
    };
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("npx skills add failed: {}", err.trim()));
    }

    // Adopt whatever newly landed under .claude/skills.
    let repo_a = repo.clone();
    tokio::task::spawn_blocking(move || karl_canon::adopt_new_skills(&repo_a, &before))
        .await
        .map_err(|e| format!("canon_import_skill adopt join: {e}"))?
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register it** in `generate_handler!` (near `canon_adopt`):

```rust
            canon_adopt,
            canon_import_skill,
```

- [ ] **Step 3: Build to verify it compiles**

Run: `cargo build -p covenant 2>&1 | tail -20`
Expected: clean build (warnings ok). Confirms `karl_canon::adopt_new_skills` / `scan_detected` / `ContextKind` resolve and `tokio::process` is available.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(app): canon_import_skill shells npx skills add + adopts the delta"
```

---

## Task 4: UI — import bar in the Skills section

**Files:**
- Modify: `ui/src/api.ts`
- Modify: `ui/src/canon/cockpit/view.ts`

**Interfaces:**
- Consumes: `canon_import_skill`.
- Produces: `canonImportSkill(cwd, skillRef): Promise<string[]>`; an import bar in `renderSkillsSection`.

- [ ] **Step 1: Add the api wrapper** in `ui/src/api.ts` (near `canonAdopt`):

```ts
export async function canonImportSkill(cwd: string, skillRef: string): Promise<string[]> {
  return invoke<string[]>("canon_import_skill", { cwd, skillRef });
}
```

- [ ] **Step 2: Add the import bar** in `renderSkillsSection` (`ui/src/canon/cockpit/view.ts`).

Import `canonImportSkill` at the top of the file alongside the other `canon*` imports. Inside `renderSkillsSection`, after the `cwd` guard and before the `load()` definition, build an import bar and prepend it to `el`. It reuses `load` to refresh after a successful import:

```ts
    // Import from skills.sh: paste "owner/repo --skill name", run npx, auto-adopt.
    const importBar = document.createElement("form");
    importBar.className = "canon-import-bar";
    const importInput = document.createElement("input");
    importInput.type = "text";
    importInput.className = "canon-import-input";
    importInput.placeholder = "Import from skills.sh — owner/repo --skill name";
    const importBtn = document.createElement("button");
    importBtn.type = "submit";
    importBtn.className = "canon-import-btn";
    importBtn.textContent = "Import";
    importBar.append(importInput, importBtn);
    importBar.addEventListener("submit", (e) => {
      e.preventDefault();
      const ref = importInput.value.trim();
      if (!ref) return;
      importBtn.disabled = true;
      importInput.disabled = true;
      void canonImportSkill(cwd, ref)
        .then((names) => {
          pushInfoToast({
            message: names.length ? `Imported: ${names.join(", ")}` : "Nothing new to import",
          });
          importInput.value = "";
          load();
        })
        .catch((err) => pushInfoToast({ message: `Import failed: ${this.friendlyError(err)}` }))
        .finally(() => {
          importBtn.disabled = false;
          importInput.disabled = false;
        });
    });
```

Then attach it — `el.append(importBar, list, errorEl);` (replacing the existing `el.append(list, errorEl);` so the bar sits above the list). Keep the existing `load(); return el;`.

- [ ] **Step 3: Add the same action to the empty state.** In the `status.installed.length === 0 && status.detectedSkills.length === 0` empty-state branch, the hint already offers "Browse registry". Leave that; the import bar above the empty state is always visible now, so no change needed inside the empty branch. (The import bar is prepended to `el` unconditionally, so it shows even when the list is empty.)

- [ ] **Step 4: Style the import bar** — add to `ui/src/canon/cockpit/cockpit.css`:

```css
.canon-import-bar { display: flex; gap: 8px; margin-bottom: 12px; }
.canon-import-input {
  flex: 1; min-width: 0;
  background: var(--surface-2, #1a1a1a); color: inherit;
  border: 1px solid var(--border, #333); border-radius: 0;
  padding: 6px 10px; font-family: var(--font-mono, monospace); font-size: 12px;
  appearance: none;
}
.canon-import-btn {
  border: 1px solid var(--border, #333); border-radius: 0;
  background: var(--surface-2, #1a1a1a); color: inherit;
  padding: 6px 14px; cursor: pointer;
}
.canon-import-btn:disabled { opacity: 0.5; cursor: default; }
```

(Confirm the actual token names against `cockpit.css` / the design tokens and adjust; fall back values are given.)

- [ ] **Step 5: Type-check + build the frontend**

Run: `npm run build 2>&1 | tail -20`
Expected: clean TS compile (no errors about `canonImportSkill`). Warnings ok.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api.ts ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/cockpit.css
git commit -m "feat(canon-ui): import skills from skills.sh in the Skills section"
```

---

## Manual verification (after Task 4)

Use the `verify` skill (IPC recipe, as used for sub-project A). Against the
`~/Sources/canon-detect-demo` fixture (reset it first), call
`canonImportSkill(repo, "<owner/repo> --skill <name>")` for a small real skill
(e.g. from `anthropics/skills`), then `canonLocalStatus(repo)` — assert the
imported skill appears in `status.installed` and `.covenant/canon/skills/<slug>/`
exists on disk. Requires Node/npx + network.

## Self-review notes

- Spec coverage: `adopt_new_skills` (canon core + tests) → Task 1; ref validation
  + injection tests → Task 2; the npx shell-out command → Task 3; UI import bar →
  Task 4; manual e2e → verification section.
- `skill_ref` (snake_case Rust param) ↔ `skillRef` (camelCase TS invoke key) is the
  Tauri convention — consistent across Task 3 and Task 4.
- Known unknown flagged for implementation, not left as a plan gap: the CLI's
  default install scope (project `.claude/skills` vs global `~/.claude/skills`).
  Running with `current_dir(repo)` should target project scope; verify against
  `npx skills add --help` during Task 3 and, if needed, pass the project-scope flag.
