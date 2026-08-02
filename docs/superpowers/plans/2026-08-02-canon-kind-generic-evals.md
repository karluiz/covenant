# Kind-Generic Evals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Canon's eval runner evaluate any kind that reaches a prompt — skill, command, agent, context, memory — not just skills.

**Architecture:** Evals move to one kind-keyed tree (`.covenant/canon/evals/<kind>/<name>/`) so the on-disk path and the `eval-results.json` key become the same string. The sandbox stops hand-writing its projection and instead builds a one-unit Canon tree in a temp dir and calls the existing `karl_canon::project()`, which already handles all seven kinds including the `AGENTS.md` managed block.

**Tech Stack:** Rust (serde, toml, tempfile), Tauri 2, TypeScript (strict, no framework), vitest.

**Spec:** `docs/superpowers/specs/2026-08-02-canon-kind-generic-evals-design.md`

## Global Constraints

- **Evaluable kinds are exactly `Skill`, `Command`, `Agent`, `Context`, `Memory`.** `Mcp` is a connection, not context; `Spec` is never projected. Both must be rejected, and the rejection is tested.
- **Eval path:** `.covenant/canon/evals/<kind>/<name>/*.toml` where `<kind>` is the lowercase singular slug (`skill`, `command`, `agent`, `context`, `memory`) — **not** `ContextKind::dir()`, whose values are plural directory names and which special-cases `Spec` to `docs/specs`.
- **Results key:** the same `<kind>/<name>` string. A stored key with no `/` is read as `skill/<name>` — one defensive line for history written by an older build, marked `ponytail:` with its removal condition.
- **A skill only projects if `canon.toml` lists it.** `project_with_active` builds its skill set from `manifest.installed`, so a sandbox holding `skills/<name>/SKILL.md` and no manifest projects **nothing** — the eval would run against an empty context and silently report zero lift. The sandbox must write a minimal `canon.toml`. This is the single most dangerous failure mode in this plan.
- **Write `settings.json` after `project()`**, never before. The deny-list is the sandbox's only real safety boundary.
- No `unwrap()` outside `#[cfg(test)]` and `main()`. `thiserror` in libraries, `String` at the Tauri boundary.
- TypeScript is `strict`; no `as any` without a justifying comment. UI copy is English. No native tooltips — use `attachTooltip`.
- **Test commands, run from the repo root** (this worktree), never from `ui/`: `cargo test -p karl-canon`, `cargo test -p covenant`, `npx vitest run`, `npx tsc --noEmit`. `npm run typecheck` does not exist.
- `main` has one pre-existing Rust failure (`karl-blocks`'s `zsh_worktree_prompt_full_when_gate_unset`, environment-sensitive) and one pre-existing vitest unhandled-rejection warning in `ui/src/tabs/manager.test.ts`. Neither is yours; do not chase them.
- Never stage with `git add -A` in this worktree — it picks up a `node_modules` symlink. Stage files explicitly.
- Conventional Commits, one commit per task.

---

### Task 1: Kind-keyed eval paths and result keys

The pure core. No I/O beyond the filesystem, no Tauri, fully unit-testable.

**Files:**
- Modify: `crates/canon/src/kind.rs` (add two methods to `ContextKind`)
- Modify: `crates/canon/src/eval.rs` (`evals_dir`, `read_evals`, `write_result`, `pass_rate`, plus a key helper)
- Modify: `crates/canon/src/lib.rs` (the `pub use eval::{…}` line, if the export list changes)

**Interfaces:**
- Consumes: `ContextKind` (`Agent | Context | Memory | Command | Mcp | Spec | Skill`).
- Produces:
  - `ContextKind::slug(&self) -> &'static str` — `"agent" | "context" | "memory" | "command" | "mcp" | "spec" | "skill"`
  - `ContextKind::evaluable(&self) -> bool` — true for Skill, Command, Agent, Context, Memory
  - `karl_canon::unit_key(kind: ContextKind, name: &str) -> String` — `"command/horizon"`
  - `read_evals(repo_root: &Path, kind: ContextKind, name: &str) -> Vec<Eval>`
  - `write_result(repo_root: &Path, kind: ContextKind, name: &str, result: &EvalResult) -> std::io::Result<()>`
  - `pass_rate(repo_root: &Path, kind: ContextKind, name: &str) -> Option<(usize, usize)>`

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `crates/canon/src/eval.rs`:

```rust
    #[test]
    fn slug_is_lowercase_singular_and_evaluable_excludes_mcp_and_spec() {
        use crate::ContextKind::*;
        assert_eq!(Skill.slug(), "skill");
        assert_eq!(Command.slug(), "command");
        assert_eq!(Agent.slug(), "agent");
        assert_eq!(Context.slug(), "context");
        assert_eq!(Memory.slug(), "memory");
        // dir() is plural and special-cases Spec — slug() must not inherit that.
        assert_eq!(Spec.slug(), "spec");
        assert_eq!(Spec.dir(), "docs/specs");

        for k in [Skill, Command, Agent, Context, Memory] {
            assert!(k.evaluable(), "{k:?} must be evaluable");
        }
        assert!(!Mcp.evaluable(), "an MCP server is a connection, not context");
        assert!(!Spec.evaluable(), "specs are never projected");
    }

    #[test]
    fn read_evals_finds_them_under_the_kind_keyed_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join(".covenant/canon/evals/command/horizon");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("refuses-a-dirty-tree.toml"),
            "id = \"refuses-a-dirty-tree\"\nscenario = \"s\"\nrubric = \"r\"\n",
        )
        .unwrap();

        let evals = read_evals(root, crate::ContextKind::Command, "horizon");
        assert_eq!(evals.len(), 1);
        assert_eq!(evals[0].id, "refuses-a-dirty-tree");

        // Same name, different kind → not the same evals.
        assert!(read_evals(root, crate::ContextKind::Skill, "horizon").is_empty());
        assert!(read_evals(root, crate::ContextKind::Command, "nope").is_empty());
    }

    /// The reason the tree is kind-keyed: this repo has a command named
    /// `green`, and nothing stops a skill named `green`.
    #[test]
    fn same_name_different_kind_do_not_share_results() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mk = |pass: bool| EvalResult {
            eval_id: "e1".into(),
            pass,
            reason: "r".into(),
            ran_at_ms: 0,
            duration_ms: 0,
            baseline_pass: None,
        };
        write_result(root, crate::ContextKind::Command, "green", &mk(true)).unwrap();
        write_result(root, crate::ContextKind::Skill, "green", &mk(false)).unwrap();

        assert_eq!(pass_rate(root, crate::ContextKind::Command, "green"), Some((1, 1)));
        assert_eq!(pass_rate(root, crate::ContextKind::Skill, "green"), Some((0, 1)));

        let all = read_results(root);
        assert!(all.contains_key("command/green"));
        assert!(all.contains_key("skill/green"));
    }

    /// History written by a build that keyed results by bare name still reads.
    #[test]
    fn a_legacy_bare_key_is_read_as_a_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join(".covenant/canon")).unwrap();
        std::fs::write(
            root.join(".covenant/canon/eval-results.json"),
            r#"{"kyc-peru":{"e1":{"eval_id":"e1","pass":true,"reason":"r","ran_at_ms":0,"duration_ms":0}}}"#,
        )
        .unwrap();

        assert_eq!(pass_rate(root, crate::ContextKind::Skill, "kyc-peru"), Some((1, 1)));
        assert_eq!(pass_rate(root, crate::ContextKind::Command, "kyc-peru"), None);
    }
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cargo test -p karl-canon eval
```

Expected: FAIL to compile — `no method named slug found for enum ContextKind`, and `read_evals` taking 3 arguments where 2 are expected.

- [ ] **Step 3: Add `slug` and `evaluable` to `ContextKind`**

In `crates/canon/src/kind.rs`, inside `impl ContextKind`, after `label()`:

```rust
    /// Lowercase singular name — the eval tree's namespace and the first
    /// half of a result key. Deliberately NOT `dir()`, which is pluralized
    /// and special-cases `Spec` to a repo-root path.
    pub fn slug(&self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Context => "context",
            Self::Memory => "memory",
            Self::Command => "command",
            Self::Mcp => "mcp",
            Self::Spec => "spec",
            Self::Skill => "skill",
        }
    }

    /// Can this kind be evaluated? True for everything that lands in an
    /// executor's prompt as text. An MCP server is a connection — evaluating
    /// it means starting the server, which is a different product. A spec is
    /// never projected at all.
    pub fn evaluable(&self) -> bool {
        matches!(
            self,
            Self::Skill | Self::Command | Self::Agent | Self::Context | Self::Memory
        )
    }
```

- [ ] **Step 4: Rewrite the path and key helpers in `eval.rs`**

Replace `evals_dir` and add `unit_key`:

```rust
/// `.covenant/canon/evals/<kind>/<name>/` — one tree for every evaluable kind,
/// so the path and the results key are the same string.
fn evals_dir(repo_root: &Path, kind: ContextKind, name: &str) -> std::path::PathBuf {
    canon_dir(repo_root)
        .join("evals")
        .join(kind.slug())
        .join(name)
}

/// The `eval-results.json` key for a unit: `"command/horizon"`.
pub fn unit_key(kind: ContextKind, name: &str) -> String {
    format!("{}/{}", kind.slug(), name)
}
```

Add `use crate::kind::ContextKind;` to the imports at the top of the file.

- [ ] **Step 5: Thread kind + name through the three public functions**

`read_evals`, `write_result` and `pass_rate` each take `(repo_root, kind, name)`. Only their signatures and the key they use change; every other line of their bodies stays as it is.

```rust
pub fn read_evals(repo_root: &Path, kind: ContextKind, name: &str) -> Vec<Eval> {
    let dir = evals_dir(repo_root, kind, name);
    // ...unchanged body...
}

pub fn write_result(
    repo_root: &Path,
    kind: ContextKind,
    name: &str,
    result: &EvalResult,
) -> std::io::Result<()> {
    // ...unchanged up to the entry insert...
    all.entry(unit_key(kind, name))
        .or_default()
        .insert(result.eval_id.clone(), result.clone());
    // ...unchanged atomic write...
}

pub fn pass_rate(repo_root: &Path, kind: ContextKind, name: &str) -> Option<(usize, usize)> {
    let all = read_results(repo_root);
    let inner = lookup(&all, kind, name)?;
    if inner.is_empty() {
        return None;
    }
    let passed = inner.values().filter(|r| r.pass).count();
    Some((passed, inner.len()))
}

/// Find a unit's results, tolerating one legacy shape.
///
/// ponytail: the bare-key fallback exists only for `eval-results.json` written
/// by a build that predates kind-keying. Delete it once no such file can still
/// be in the wild — there were none on the authoring machine when this landed.
fn lookup<'a>(
    all: &'a ResultMap,
    kind: ContextKind,
    name: &str,
) -> Option<&'a BTreeMap<String, EvalResult>> {
    all.get(&unit_key(kind, name)).or_else(|| {
        (kind == ContextKind::Skill).then(|| all.get(name)).flatten()
    })
}
```

- [ ] **Step 6: Re-export `unit_key`**

In `crates/canon/src/lib.rs`, extend the eval re-export:

```rust
pub use eval::{pass_rate, read_evals, read_results, unit_key, write_result, Eval, EvalResult};
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cargo test -p karl-canon
```

Expected: the four new tests pass. The crate's other callers of `read_evals`/`write_result`/`pass_rate` live in `crates/app` and will not compile yet — that is Task 3's and Task 4's job, and `cargo test -p karl-canon` does not build them.

- [ ] **Step 8: Commit**

```bash
git add crates/canon/src/kind.rs crates/canon/src/eval.rs crates/canon/src/lib.rs
git commit -m "feat(canon): key evals by kind and name, not by skill alone"
```

---

### Task 2: Deleting a unit takes its evals with it

Two removal paths exist and they are not interchangeable: `delete_unit` refuses `Skill` and `Spec` outright (single-file kinds only), and skills are removed by `uninstall_skill`. Both need the same cleanup.

**Files:**
- Modify: `crates/canon/src/install.rs` (`delete_unit` around line 239, `uninstall_skill` around line 432)
- Test: inline `#[cfg(test)]` in `crates/canon/src/install.rs`

**Interfaces:**
- Consumes: `ContextKind::slug()` from Task 1.
- Produces: nothing new; existing signatures unchanged.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `crates/canon/src/install.rs`:

```rust
    #[test]
    fn delete_unit_also_removes_the_units_evals() {
        use crate::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let canon = root.join(".covenant/canon");
        std::fs::create_dir_all(canon.join("commands")).unwrap();
        std::fs::write(canon.join("commands/horizon.md"), "# ship it\n").unwrap();
        let evals = canon.join("evals/command/horizon");
        std::fs::create_dir_all(&evals).unwrap();
        std::fs::write(evals.join("e1.toml"), "id=\"e1\"\nscenario=\"s\"\nrubric=\"r\"\n").unwrap();

        delete_unit(root, ContextKind::Command, "horizon").unwrap();

        assert!(!canon.join("commands/horizon.md").exists());
        assert!(!evals.exists(), "an orphan eval tree outlives its unit");
    }

    #[test]
    fn uninstalling_a_skill_also_removes_its_evals() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let pkg = root.join("pkg");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("skill.toml"), "name = \"testing\"\nversion = \"1.0.0\"\n").unwrap();
        std::fs::write(pkg.join("SKILL.md"), "---\nname: testing\n---\nx\n").unwrap();
        install_local(root, &pkg).unwrap();

        let evals = root.join(".covenant/canon/evals/skill/testing");
        std::fs::create_dir_all(&evals).unwrap();
        std::fs::write(evals.join("e1.toml"), "id=\"e1\"\nscenario=\"s\"\nrubric=\"r\"\n").unwrap();

        uninstall_skill(root, "testing").unwrap();

        assert!(!evals.exists());
    }

    /// Removing one unit's evals must not touch a same-named unit of another kind.
    #[test]
    fn deleting_a_command_leaves_a_same_named_skills_evals_alone() {
        use crate::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let canon = root.join(".covenant/canon");
        std::fs::create_dir_all(canon.join("commands")).unwrap();
        std::fs::write(canon.join("commands/green.md"), "# gate\n").unwrap();
        for k in ["command", "skill"] {
            let d = canon.join("evals").join(k).join("green");
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("e1.toml"), "id=\"e1\"\nscenario=\"s\"\nrubric=\"r\"\n").unwrap();
        }

        delete_unit(root, ContextKind::Command, "green").unwrap();

        assert!(!canon.join("evals/command/green").exists());
        assert!(canon.join("evals/skill/green").exists(), "wrong kind's evals removed");
    }
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cargo test -p karl-canon evals
```

Expected: FAIL — `an orphan eval tree outlives its unit` (the directory still exists), and the same for the skill case.

- [ ] **Step 3: Add the cleanup helper**

In `crates/canon/src/install.rs`, near the other private helpers:

```rust
/// Best-effort removal of a unit's eval tree. A failure here must not fail the
/// delete — the unit is already gone and a leftover directory is inert.
fn remove_evals(repo_root: &Path, kind: ContextKind, name: &str) {
    let dir = canon_dir(repo_root).join("evals").join(kind.slug()).join(name);
    if dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            tracing::warn!(target: "canon", error = %e, "could not remove eval dir");
        }
    }
}
```

- [ ] **Step 4: Call it from both removal paths**

In `delete_unit`, after `std::fs::remove_file(&path)?` and before `project(repo_root)`:

```rust
    std::fs::remove_file(&path)?;
    remove_evals(repo_root, kind, name);
    project(repo_root)
```

In `uninstall_skill`, immediately after the skill's source directory is removed and before the function returns:

```rust
    remove_evals(repo_root, ContextKind::Skill, name);
```

Read `uninstall_skill`'s body first and place the call after the directory removal — do not guess the line.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cargo test -p karl-canon
```

Expected: all three new tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add crates/canon/src/install.rs
git commit -m "feat(canon): removing a unit removes its evals"
```

---

### Task 3: Build the sandbox by projecting, not by hand

The task that decides whether this change is small or sprawling.

**Files:**
- Modify: `crates/app/src/canon_eval.rs` (`prepare_sandbox`, around line 63)
- Test: inline `#[cfg(test)]` in `crates/app/src/canon_eval.rs`

**Interfaces:**
- Consumes: `ContextKind::{slug, dir, evaluable}` and `unit_key` from Task 1; `karl_canon::project`.
- Produces: `prepare_sandbox(repo_root: &Path, kind: ContextKind, name: &str) -> std::io::Result<tempfile::TempDir>`.

**Read this before writing code.** `project_with_active` builds its skill list from `manifest.installed` (`crates/canon/src/project.rs:640`), not from what is on disk. A sandbox containing `skills/<name>/SKILL.md` and **no `canon.toml`** projects nothing at all — no error, no warning, an empty `.claude/skills/`. The eval would then run against a bare context and report zero lift, which looks exactly like "this skill does not help". Writing the minimal manifest is not optional.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `crates/app/src/canon_eval.rs`:

```rust
    #[test]
    fn prepare_sandbox_projects_a_command() {
        use karl_canon::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let canon = root.join(".covenant/canon");
        fs::create_dir_all(canon.join("commands")).unwrap();
        fs::write(canon.join("commands/horizon.md"), "# Ship a release\n").unwrap();

        let sbox = prepare_sandbox(root, ContextKind::Command, "horizon").unwrap();

        let projected = sbox.path().join(".claude/commands/horizon.md");
        assert!(projected.exists(), "command was not projected into the sandbox");
        assert!(fs::read_to_string(&projected).unwrap().contains("Ship a release"));
        assert!(sbox.path().join(".claude/settings.json").exists());
    }

    /// The dangerous one: a skill projects only if canon.toml lists it, so a
    /// sandbox without the manifest silently tests nothing.
    #[test]
    fn prepare_sandbox_projects_a_skill_via_a_written_manifest() {
        use karl_canon::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join(".covenant/canon/skills/kyc-peru");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), "---\nname: kyc-peru\n---\nKYC rules.\n").unwrap();
        fs::write(dir.join("skill.toml"), "name = \"kyc-peru\"\nversion = \"1.0.0\"\n").unwrap();

        let sbox = prepare_sandbox(root, ContextKind::Skill, "kyc-peru").unwrap();

        let projected = sbox.path().join(".claude/skills/canon-kyc-peru/SKILL.md");
        assert!(projected.exists(), "skill not projected — is canon.toml written?");
        assert!(fs::read_to_string(&projected).unwrap().contains("KYC rules"));
    }

    /// Memory has no file-per-item target; it lands in the managed block.
    #[test]
    fn prepare_sandbox_projects_memory_into_the_managed_block() {
        use karl_canon::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let canon = root.join(".covenant/canon");
        fs::create_dir_all(canon.join("memory")).unwrap();
        fs::write(
            canon.join("memory/decision-x.md"),
            "---\ndescription: We chose X\n---\nlonger body\n",
        )
        .unwrap();

        let sbox = prepare_sandbox(root, ContextKind::Memory, "decision-x").unwrap();

        let agents_md = fs::read_to_string(sbox.path().join("AGENTS.md")).unwrap();
        assert!(agents_md.contains("decision-x"), "memory missing from the managed block");
    }

    #[test]
    fn prepare_sandbox_rejects_unevaluable_kinds_and_unknown_units() {
        use karl_canon::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(prepare_sandbox(root, ContextKind::Mcp, "ctx7").is_err());
        assert!(prepare_sandbox(root, ContextKind::Spec, "3.1-alpha").is_err());
        assert!(prepare_sandbox(root, ContextKind::Command, "ghost").is_err());
    }
```

- [ ] **Step 2: Run them to verify they fail**

```bash
cargo test -p covenant prepare_sandbox
```

Expected: FAIL to compile — `prepare_sandbox` takes 2 arguments, 3 supplied.

- [ ] **Step 3: Rewrite `prepare_sandbox`**

Replace the existing function:

```rust
/// Create a temp dir holding a one-unit Canon tree, project it with the same
/// code that projects the real repo, then write the deny-list `settings.json`.
///
/// Projecting rather than hand-writing the executor file means the eval tests
/// the unit AS PROJECTED — a context doc becomes a synthesized skill, a memory
/// becomes a bullet in the managed block — which is what actually reaches the
/// model. It also means memory and context work with no code of their own.
pub(crate) fn prepare_sandbox(
    repo_root: &Path,
    kind: karl_canon::ContextKind,
    name: &str,
) -> std::io::Result<tempfile::TempDir> {
    use karl_canon::ContextKind;
    if !kind.evaluable() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{} units are not evaluable", kind.label()),
        ));
    }

    let sbox = tempfile::Builder::new().prefix("eval-sbox-").tempdir()?;
    let dst_canon = sbox.path().join(".covenant/canon");

    if kind == ContextKind::Skill {
        // A skill is a directory of exactly the two files a package carries.
        let src = karl_canon::canon_dir(repo_root).join("skills").join(name);
        let dst = dst_canon.join("skills").join(name);
        std::fs::create_dir_all(&dst)?;
        std::fs::copy(src.join("SKILL.md"), dst.join("SKILL.md"))?; // missing → Err
        let toml_src = src.join("skill.toml");
        if toml_src.exists() {
            std::fs::copy(&toml_src, dst.join("skill.toml"))?;
        }
        // project_with_active reads its skill set from the manifest, NOT from
        // disk — without this the sandbox projects nothing and the eval
        // silently measures an empty context.
        std::fs::create_dir_all(&dst_canon)?;
        std::fs::write(
            dst_canon.join("canon.toml"),
            format!(
                "version = 1\n\n[[installed]]\nname = \"{name}\"\nversion = \"0.0.0\"\n\
                 source = \"local:eval-sandbox\"\nsha = \"\"\ninstalledAt = \"\"\n"
            ),
        )?;
    } else {
        // Every other evaluable kind is one markdown file under its kind dir.
        let file = format!("{name}.md");
        let src = karl_canon::canon_dir(repo_root).join(kind.dir()).join(&file);
        let body = std::fs::read_to_string(&src)?; // missing unit → Err
        let dst = dst_canon.join(kind.dir());
        std::fs::create_dir_all(&dst)?;
        std::fs::write(dst.join(&file), body)?;
    }

    karl_canon::project(sbox.path())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;

    // AFTER project(): the deny-list is the sandbox's only safety boundary and
    // must not be clobbered by a future projection target claiming the name.
    std::fs::create_dir_all(sbox.path().join(".claude"))?;
    std::fs::write(
        sbox.path().join(".claude/settings.json"),
        denylist_settings(),
    )?;
    Ok(sbox)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cargo test -p covenant prepare_sandbox
```

Expected: 4 passing. If `prepare_sandbox_projects_a_skill_via_a_written_manifest` fails, the manifest's TOML field names do not match `InstalledRef`'s serde shape — it is `#[serde(rename_all = "camelCase")]`, so `installedAt`, not `installed_at`. Check `crates/canon/src/types.rs` and fix the literal, not the test.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/canon_eval.rs
git commit -m "feat(evals): build the sandbox by projecting a one-unit Canon tree"
```

---

### Task 4: Run and summarize evals for any kind

**Files:**
- Modify: `crates/app/src/canon_eval.rs` (`EvalSkillSummary`, `emit_progress`, `canon_run_evals`, `canon_eval_summary`, `push_results_for`)

**Interfaces:**
- Consumes: Task 1's `read_evals`/`write_result`/`pass_rate`/`unit_key`, Task 3's `prepare_sandbox`.
- Produces:
  - `canon_run_evals(app, state, cwd: String, kind: String, name: String) -> Result<(), String>`
  - `canon_eval_summary(cwd: String) -> Result<Vec<EvalUnitSummary>, String>` where `EvalUnitSummary { kind: String, name: String, passed: usize, total: usize, baseline_passed: usize, baseline_total: usize }`
  - The `canon-eval-progress` event payload gains `kind`; its `skill` field is renamed `name`.

- [ ] **Step 1: Parse the kind at the Tauri boundary**

Tauri commands take strings. Add near the top of `canon_eval.rs`:

```rust
/// Parse a kind slug from the frontend. Rejects anything unevaluable, so an
/// MCP server cannot be run through the harness by passing its name.
fn parse_evaluable_kind(s: &str) -> Result<karl_canon::ContextKind, String> {
    use karl_canon::ContextKind::*;
    let k = match s {
        "skill" => Skill,
        "command" => Command,
        "agent" => Agent,
        "context" => Context,
        "memory" => Memory,
        other => return Err(format!("unknown kind: {other}")),
    };
    debug_assert!(k.evaluable());
    Ok(k)
}
```

- [ ] **Step 2: Rename the summary struct**

```rust
#[derive(Debug, Clone, Serialize)]
pub struct EvalUnitSummary {
    pub kind: String,
    pub name: String,
    pub passed: usize,
    pub total: usize,
    pub baseline_passed: usize,
    pub baseline_total: usize,
}
```

- [ ] **Step 3: Widen `emit_progress`**

```rust
fn emit_progress(app: &AppHandle, kind: &str, name: &str, eval_id: &str, status: &str, reason: &str) {
    let _ = app.emit(
        "canon-eval-progress",
        serde_json::json!({
            "kind": kind,
            "name": name,
            "eval_id": eval_id,
            "status": status,
            "reason": reason,
        }),
    );
}
```

Update every call site in the file to pass `kind.slug()` and `&name`.

- [ ] **Step 4: Thread kind + name through `canon_run_evals`**

The signature and the four calls that name the unit change; the harness/judge/baseline logic is untouched.

```rust
#[tauri::command]
pub async fn canon_run_evals(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    cwd: String,
    kind: String,
    name: String,
) -> Result<(), String> {
    let unit_kind = parse_evaluable_kind(&kind)?;
    let repo_root = std::path::PathBuf::from(&cwd);
    let evals = karl_canon::read_evals(&repo_root, unit_kind, &name);
    // ...unchanged: empty-evals early return, claude_available check...
    // run_harness(&repo_root, unit_kind, &name, &ev.scenario)
    // karl_canon::write_result(&repo_root, unit_kind, &name, &result)
    // push_results_for(&repo_root, unit_kind, &name, &fresh_results).await
}
```

`run_harness` currently takes `(repo_root, skill, scenario)` and forwards to `prepare_sandbox`; give it `(repo_root, kind, name, scenario)` and forward both.

- [ ] **Step 5: Rewrite `canon_eval_summary` to split the key**

```rust
/// Per-unit `(passed,total)` for the Impact section, read from eval-results.json.
#[tauri::command]
pub async fn canon_eval_summary(cwd: String) -> Result<Vec<EvalUnitSummary>, String> {
    let repo_root = std::path::PathBuf::from(&cwd);
    let all = karl_canon::read_results(&repo_root);
    Ok(all
        .into_iter()
        .map(|(key, inner)| {
            // Keys are "<kind>/<name>"; a legacy bare key is a skill.
            let (kind, name) = match key.split_once('/') {
                Some((k, n)) => (k.to_string(), n.to_string()),
                None => ("skill".to_string(), key.clone()),
            };
            let passed = inner.values().filter(|r| r.pass).count();
            let baseline_total = inner.values().filter(|r| r.baseline_pass.is_some()).count();
            let baseline_passed = inner.values().filter(|r| r.baseline_pass == Some(true)).count();
            EvalUnitSummary {
                kind,
                name,
                passed,
                total: inner.len(),
                baseline_passed,
                baseline_total,
            }
        })
        .collect())
}
```

- [ ] **Step 6: Give `push_results_for` the real kind**

Its manifest lookup is skill-only today. Only a skill can have a `registry:` source, so for every other kind it returns before any network call — which is the correct behavior and needs no branch:

```rust
async fn push_results_for(
    repo_root: &std::path::Path,
    kind: karl_canon::ContextKind,
    name: &str,
    results: &[karl_canon::EvalResult],
) {
    if results.is_empty() {
        return;
    }
    // Only installed skills carry a registry: source. Memory is not packageable
    // at all, so its results correctly never leave the machine.
    let Ok(manifest) = karl_canon::read_manifest(repo_root) else { return };
    let Some(entry) = manifest.installed.iter().find(|i| i.name == name) else { return };
    if kind != karl_canon::ContextKind::Skill {
        return;
    }
    // ...unchanged from here: parse_registry_source, resolve, push_evals...
}
```

- [ ] **Step 7: Verify it compiles and the suite passes**

```bash
cargo test -p covenant 2>&1 | tail -20
cargo clippy -p covenant --all-targets 2>&1 | tail -20
```

Expected: green. The TypeScript side is now out of sync and that is Task 5's job — `cargo` does not check it.

- [ ] **Step 8: Commit**

```bash
git add crates/app/src/canon_eval.rs
git commit -m "feat(evals): run and summarize evals for any evaluable kind"
```

---

### Task 5: TypeScript API surface

**Files:**
- Modify: `ui/src/api.ts:2044-2065` (`EvalSkillSummary`, `CanonEvalProgress`, `canonRunEvals`)
- Modify: `ui/src/canon/evals.ts` (`runEvals`, `execute`)

**Interfaces:**
- Consumes: Task 4's command signatures and event payload.
- Produces:
  - `export interface EvalUnitSummary { kind: string; name: string; passed: number; total: number; baseline_passed: number; baseline_total: number }`
  - `canonRunEvals(cwd: string, kind: string, name: string): Promise<void>`
  - `runEvals(cwd: string, kind: string, name: string, btn: HTMLButtonElement, onDone: () => void | Promise<void>): void`

- [ ] **Step 1: Update the types and the wrapper**

In `ui/src/api.ts`:

```ts
export interface EvalUnitSummary {
  kind: string;
  name: string;
  passed: number;
  total: number;
  baseline_passed: number;
  baseline_total: number;
}

export interface CanonEvalProgress {
  kind: string;
  name: string;
  eval_id: string;
  status: "running" | "pass" | "fail" | "skipped" | "error" | "done";
  reason: string;
}

export async function canonRunEvals(cwd: string, kind: string, name: string): Promise<void> {
  return invoke<void>("canon_run_evals", { cwd, kind, name });
}

export async function canonEvalSummary(cwd: string): Promise<EvalUnitSummary[]> {
  return invoke<EvalUnitSummary[]>("canon_eval_summary", { cwd });
}
```

- [ ] **Step 2: Update `runEvals`**

In `ui/src/canon/evals.ts`, both `runEvals` and the private `execute` take `(cwd, kind, name, btn, onDone)`. The progress filter compares both fields, and the empty-run hint points at the right directory:

```ts
export function runEvals(
  cwd: string,
  kind: string,
  name: string,
  btn: HTMLButtonElement,
  onDone: () => void | Promise<void>,
): void {
  openConfirmPrompt({
    label: "Run evals",
    message:
      `Run evals for "${name}"? Each eval is a full agent run plus a judge call — this can take minutes and costs tokens. ` +
      `The eval's name and its pass/fail are shared with your org's registry — never the judge's reasoning.`,
    confirmText: "Run",
    onConfirm: () => { void execute(cwd, kind, name, btn, onDone); },
  });
}
```

Inside `execute`, the listener guard becomes `if (e.kind !== kind || e.name !== name) return;`, `canonRunEvals(cwd, kind, name)` is awaited, and the no-evals message becomes:

```ts
          ? `No evals for ${name} — add .toml files under .covenant/canon/evals/${kind}/${name}/`
          : `Evals finished for ${name}`,
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: errors ONLY in `ui/src/canon/panel.ts` and `ui/src/canon/cockpit/view.ts`, which still call the old signatures — Task 6 fixes them. Confirm no other file is implicated before moving on; if one is, it is a call site this plan missed and you should report it.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts ui/src/canon/evals.ts
git commit -m "feat(evals): kind-aware eval API and run helper"
```

---

### Task 6: Offer "Run evals" on every evaluable kind

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts` (`UnitSpec`, `UNIT_SPECS`, `renderUnitSection` ~line 1650, `renderSkillsSection` ~line 1869, `renderContextSection`, the `lifts` map ~line 1835, `renderLoopSection` ~line 2278)
- Modify: `ui/src/canon/panel.ts:604` and `:796`
- Test: `ui/src/canon/cockpit/view.test.ts`

**Interfaces:**
- Consumes: Task 5's `runEvals(cwd, kind, name, btn, onDone)` and `EvalUnitSummary`.
- Produces: `UnitSpec.evaluable?: true`.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/canon/cockpit/view.test.ts`:

```ts
describe("UNIT_SPECS evaluability", () => {
  it("marks the evaluable kinds and leaves mcp out", () => {
    // An MCP server is a connection, not context — running it through the
    // harness would mean starting the server.
    expect(UNIT_SPECS.agents?.evaluable).toBe(true);
    expect(UNIT_SPECS.commands?.evaluable).toBe(true);
    expect(UNIT_SPECS.memory?.evaluable).toBe(true);
    expect(UNIT_SPECS.mcp?.evaluable).toBeUndefined();
  });

  it("gives every evaluable spec a kind the backend accepts", () => {
    const accepted = ["skill", "command", "agent", "context", "memory"];
    for (const [section, spec] of Object.entries(UNIT_SPECS)) {
      if (!spec?.evaluable) continue;
      expect(accepted, `${section} sends an unevaluable kind`).toContain(spec.kind);
    }
  });
});
```

Export `UNIT_SPECS` from `view.ts` (it is currently module-private) and add it to the test file's import from `./view`.

- [ ] **Step 2: Run it to verify it fails**

```bash
npx vitest run ui/src/canon/cockpit/view.test.ts
```

Expected: FAIL — `UNIT_SPECS is not exported` / `undefined`.

- [ ] **Step 3: Add the flag**

In `ui/src/canon/cockpit/view.ts`, add to the `UnitSpec` interface:

```ts
  /** Can this kind be run through the eval harness? Absent for mcp — an MCP
   *  server is a connection, not context, so there is nothing to judge. */
  evaluable?: true;
```

Set `evaluable: true` on the `agents`, `commands` and `memory` entries of `UNIT_SPECS`. Leave `mcp` without it. Change `const UNIT_SPECS` to `export const UNIT_SPECS`.

- [ ] **Step 4: Add the row action in `renderUnitSection`**

In the per-unit loop (after the delete action is pushed, around line 1657):

```ts
          if (spec.evaluable && !detected) {
            const runBtn = iconButton(Icons.play({ size: 15 }), "Run evals", () => {
              runEvals(cwd, spec.kind, u.name, runBtn, () => {
                this.invalidateStatus();
                this.showSection(key);
              });
            });
            actions.push(runBtn);
          }
```

A detected-but-unadopted unit has no Canon source to project, so it gets no button.

- [ ] **Step 5: Update the three existing call sites**

`ui/src/canon/cockpit/view.ts:1870` (skills section):

```ts
            const runBtn = iconButton(Icons.play({ size: 15 }), "Run evals", () => {
              runEvals(cwd, "skill", i.name, runBtn, () => { this.invalidateStatus(); load(); });
            });
```

`ui/src/canon/panel.ts:604` and `:796`:

```ts
      const runBtn = railAction(Icons.play({ size: 13 }), "Run evals", () => this.runEvals("skill", i.name, runBtn));
```

```ts
  private runEvals(kind: string, name: string, btn: HTMLButtonElement): void {
    const cwd = this.opts.groupRootDir;
    if (!cwd) return;
    runEvals(cwd, kind, name, btn, () => this.refresh());
  }
```

In `renderContextSection`, add the same button as Step 4 using the literal kind `"context"`.

- [ ] **Step 6: Key the lift maps by kind and name**

`ui/src/canon/cockpit/view.ts:1835` builds `new Map(evals.map((e) => [e.skill, liftRow(e)]))` and line 1875 reads `lifts.get(i.name)`. Both must carry the kind, or a command's lift would land on a same-named skill's card:

```ts
          const lifts = new Map(evals.map((e) => [`${e.kind}/${e.name}`, liftRow(e)]));
```

```ts
            const lift = lifts.get(`skill/${i.name}`);
```

In `renderLoopSection` (~line 2278), the "Context lift" rows label with `r.skill`; use `` `${r.kind}/${r.name}` `` so `green` the command and `green` the skill are distinguishable. Check `ui/src/canon/cockpit/lift.ts`'s `liftRow` signature — if it reads `.skill`, update it to `.name` and fix `lift.test.ts` alongside.

- [ ] **Step 7: Typecheck and run the full suite**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: clean typecheck; suite green apart from the pre-existing `ui/src/tabs/manager.test.ts` unhandled-rejection warning.

- [ ] **Step 8: Commit**

```bash
git add ui/src/api.ts ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/view.test.ts ui/src/canon/cockpit/lift.ts ui/src/canon/cockpit/lift.test.ts ui/src/canon/panel.ts
git commit -m "feat(evals): run evals from any evaluable kind's row"
```

Drop `lift.ts`/`lift.test.ts` from the `git add` if Step 6 did not touch them.

---

### Task 7: Move the `horizon` evals and reconcile the specs

The worked example, and the two documentation debts this change creates.

**Files:**
- Create: `.covenant/canon/evals/command/horizon/{bumps-all-five-manifests,stages-the-npm-lockfile,refuses-a-dirty-tree}.toml`
- Delete: `.covenant/canon/skills/horizon/` (the whole tree — `horizon` is a command and was never a skill)
- Modify: `docs/superpowers/specs/2026-08-01-canon-package-evals-design.md`

**Interfaces:** none — content and docs only.

**Note:** `.covenant/` is gitignored (`.gitignore:50`), so the three `.toml` files are local-only and will not appear in the commit. Only the spec edit is committed. This is itself the point the Plan B correction made: evals do not travel.

- [ ] **Step 1: Move the eval files and reword them for a read-only harness**

The three drafts currently live at `.covenant/canon/skills/horizon/evals/`. Recreate them under `.covenant/canon/evals/command/horizon/` with their scenarios reworded: the harness allows `Read`, `Grep` and `Glob` only, in an empty temp dir, so a scenario that says "run the ritual" cannot pass no matter how good the command is. Each scenario must instead ask the model to **describe the exact commands it would run**, and the rubric grades that description.

Concretely, in each of the three files change the closing instruction of `scenario` from an imperative to a description request — for example, `bumps-all-five-manifests.toml`:

```toml
scenario = """
You are in a macOS repository laid out like a Tauri app. Five files declare the
version, all of them currently at 0.9.45:

  Cargo.toml                  →  [workspace.package] version = "0.9.45"
  package.json                →  "version": "0.9.45"
  crates/app/tauri.conf.json  →  "version": "0.9.45"
  Cargo.lock                  →  the covenant package entry, version = "0.9.45"
  package-lock.json           →  "version": "0.9.45"

The working tree is clean. The most recent git tag is v0.9.45.

You cannot run anything — describe, in order, the exact shell commands you would
run to take this repo through a patch release up to and including the release
commit, and then state the version each of the five files would hold.
"""
```

Keep every `rubric` as written. They already grade the description rather than the filesystem, and the `FAIL if it reaches for GNU sed's first-match idiom` clause is the whole point.

Then remove the stale tree:

```bash
rm -rf .covenant/canon/skills/horizon
```

- [ ] **Step 2: Verify the runner finds them**

```bash
cargo test -p karl-canon read_evals_finds_them_under_the_kind_keyed_tree
ls .covenant/canon/evals/command/horizon/
```

Expected: the test passes and three `.toml` files are listed. Confirm the old path is gone: `ls .covenant/canon/skills 2>&1` should report no such directory.

- [ ] **Step 3: Reconcile the packaging spec**

`docs/superpowers/specs/2026-08-01-canon-package-evals-design.md` names `skills/<skill>/evals/*.toml` as the source evals are read from when publishing. Update every occurrence to `evals/skill/<name>/*.toml`, and add one sentence under its **Changes** table noting that the path was moved by
`2026-08-02-canon-kind-generic-evals-design.md` and that packaging now has a
kind dimension available to it should it ever carry a command's evals too.

Grep before editing so none are missed:

```bash
grep -n "skills/<skill>/evals\|skills/.*\/evals" docs/superpowers/specs/2026-08-01-canon-package-evals-design.md
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-08-01-canon-package-evals-design.md
git commit -m "docs(canon): point the packaging spec at the kind-keyed eval tree"
```

---

### Task 8: Full-gate verification

No new code. The per-task runs were scoped; this proves the whole change holds together.

- [ ] **Step 1: Rust**

```bash
cargo test --workspace 2>&1 | tail -25
```

Expected: green except `karl-blocks`'s `zsh_worktree_prompt_full_when_gate_unset`, which fails identically on `main` (the developer's real `~/.zshrc` leaks into the zsh the test spawns). Confirm it is that test and no other.

- [ ] **Step 2: TypeScript**

```bash
npx tsc --noEmit
npx vitest run 2>&1 | tail -8
```

Expected: no type errors; all test files passing, with the pre-existing `ui/src/tabs/manager.test.ts` unhandled-rejection warning still present and no new ones.

- [ ] **Step 3: Lint**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets 2>&1 | tail -20
```

Expected: `fmt` produces no diff in files this plan touched; no new clippy warnings. The workspace has pre-existing warnings — compare against `git stash`-ed `main` if a count looks suspicious.

- [ ] **Step 4: Commit any formatting**

```bash
git status --porcelain
```

If `cargo fmt` changed anything, stage those files explicitly and commit `chore: cargo fmt`. If nothing changed, skip.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Evaluable kinds = skill/command/agent/context/memory; mcp + spec out | 1 (`evaluable()`), 3 (sandbox rejects), 4 (`parse_evaluable_kind`), 6 (`UNIT_SPECS`) |
| `.covenant/canon/evals/<kind>/<name>/` tree, slug not `dir()` | 1 |
| Results key = the same string; legacy bare key reads as skill | 1 (`lookup`), 4 (`canon_eval_summary` split) |
| Skill evals move, no back-compat read of the old path | 1 (path change), 7 (files moved) |
| Orphan cleanup via `delete_unit` | 2 — plus `uninstall_skill`, which the spec did not name because `delete_unit` refuses `Skill` |
| Sandbox builds a one-unit Canon tree and calls `project()` | 3 |
| `settings.json` written after `project()` | 3 |
| Renames (`read_evals`, `write_result`, `pass_rate`, `canon_run_evals`, `EvalUnitSummary`, `prepare_sandbox`) | 1, 3, 4 |
| `push_results_for` uses the real kind; memory never pushes | 4 |
| UI: `evaluable` flag, action on 5 kinds, not mcp; kind shown in Impact | 6 |
| Read-only harness ⇒ evals judge the plan; rewrite the horizon three | 7 |
| Packaging spec path reconciliation | 7 |
| Testing table | 1, 2, 3, 6 |

One deviation, deliberate: the spec says "`delete_unit` removes it", but `delete_unit` rejects `Skill` outright (`install.rs:240`) and skills are removed by `uninstall_skill`. Task 2 covers both paths.

**Placeholder scan:** none. Task 4 Steps 4 and 6 elide unchanged function bodies with `// ...unchanged...` while showing every line that changes — the surrounding code exists and is cited by file and symbol, so there is nothing for an implementer to invent.

**Type consistency:** `EvalUnitSummary { kind, name, passed, total, baseline_passed, baseline_total }` is defined in Task 4 Step 2, mirrored in TS in Task 5 Step 1, and consumed in Task 6 Step 6. `unit_key(kind, name) -> String` is defined in Task 1 Step 4 and used in Task 1 Step 5. `prepare_sandbox(repo_root, kind, name)` is defined in Task 3 Step 3 and called from `run_harness` in Task 4 Step 4. `runEvals(cwd, kind, name, btn, onDone)` is defined in Task 5 Step 2 and called at four sites in Task 6. `UnitSpec.evaluable?: true` is defined in Task 6 Step 3 and asserted in Step 1.
