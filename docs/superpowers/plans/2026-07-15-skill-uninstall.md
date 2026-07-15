# Local Skill Uninstall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A trash button on Canon Skills rows that removes a locally installed skill — source dir, manifest entry, and every executor projection — with a native confirm.

**Architecture:** Skill projection becomes reconciling (prunes stale `canon-*` dirs) so removing the source cleans the projection on the next `project()`. A `karl_canon::uninstall_skill` mirrors `install_from_dir` in reverse; a Tauri command + api.ts wrapper expose it; the Skills section gains the button.

**Tech Stack:** Rust (karl-canon lib + covenant Tauri app), TypeScript + vitest UI.

**Spec:** `docs/superpowers/specs/2026-07-15-skill-uninstall-design.md`

## Global Constraints

- Skills only. Do not touch agent/command/context/mcp projection or add delete for those kinds.
- Projection pruning acts ONLY on `canon-`-prefixed dirs under `SKILL_DIRS` (`.claude/skills`, `.pi/skills`) — never user files, never non-`canon-` dirs.
- App crate package name is `covenant` (`cargo test -p covenant`, `cargo check -p covenant`) — NOT `app`.
- Rust tests: `cargo test -p karl-canon` / `-p covenant`. NEVER `cargo test --workspace` (hangs on telegram tests).
- `npm test` runs from the repo ROOT, never from `ui/`.
- No `unwrap()` outside `#[cfg(test)]`; `thiserror` (`CanonError`) in the lib crate.
- UI: no emoji, inline SVG `Icons.*` only, `attachTooltip` (via `iconButton`) never `element.title`, border-radius 0, English copy.
- Work stays in the worktree `.claude/worktrees/skill-uninstall` (branch `worktree-skill-uninstall`). Verify with `git rev-parse --abbrev-ref HEAD` before each commit.

---

### Task 1: Reconciling skill projection

**Files:**
- Modify: `crates/canon/src/project.rs` (add `prune_stale_skill_dirs`, call it in `project_with_active` ~line 520 before the `write_skill_dirs` loop; `SKILL_DIRS` is at line 101)
- Test: `crates/canon/src/project.rs` `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `SKILL_DIRS` (project.rs:101), `canon_dir` (already imported).
- Produces: `project(repo_root)` now removes `.claude/skills/canon-<name>` / `.pi/skills/canon-<name>` dirs whose `<name>` is not a currently-installed skill.

- [ ] **Step 1: Write the failing test**

Add to `crates/canon/src/project.rs` tests (use `tempfile`, already a dev-dep used by sibling crates — if the test module lacks `use` for it, follow the pattern in `crates/canon/src/kind.rs` tests which use `tempfile::tempdir()`):

```rust
#[test]
fn project_prunes_stale_canon_skill_dirs_keeps_installed_and_user_dirs() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();

    // A real installed skill (manifest + source), so projection re-creates its dir.
    let src = root.join(".covenant/canon/skills/kept");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("skill.toml"), "name = \"kept\"\nversion = \"1.0.0\"\n").unwrap();
    std::fs::write(src.join("SKILL.md"), "---\nname: kept\n---\nbody\n").unwrap();
    let manifest = crate::CanonManifest {
        version: 1,
        installed: vec![crate::types::InstalledRef {
            name: "kept".into(), version: "1.0.0".into(), source: "local:x".into(),
            sha: "0".into(), signer: None, installed_at: "t".into(),
        }],
    };
    crate::write_manifest(root, &manifest).unwrap();

    // A stale canon- projection with no source, and a user-owned dir.
    std::fs::create_dir_all(root.join(".claude/skills/canon-ghost")).unwrap();
    std::fs::write(root.join(".claude/skills/canon-ghost/SKILL.md"), "old").unwrap();
    std::fs::create_dir_all(root.join(".claude/skills/my-own")).unwrap();
    std::fs::write(root.join(".claude/skills/my-own/SKILL.md"), "mine").unwrap();

    project(root).unwrap();

    assert!(!root.join(".claude/skills/canon-ghost").exists(), "stale canon dir pruned");
    assert!(root.join(".claude/skills/canon-kept/SKILL.md").exists(), "installed skill projected");
    assert!(root.join(".claude/skills/my-own/SKILL.md").exists(), "user dir untouched");
}
```

Verify `CanonManifest`/`InstalledRef` field names against `crates/canon/src/types.rs` before running — match them exactly (the InstalledRef fields shown mirror `install_from_dir`'s constructor).

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl-canon project_prunes_stale_canon_skill_dirs -- --nocapture`
Expected: FAIL — `canon-ghost` still exists (projection is additive, nothing prunes it).

- [ ] **Step 3: Implement the prune helper + call it**

In `crates/canon/src/project.rs`, add near `write_skill_dirs` (~line 138):

```rust
/// Remove `canon-*` skill dirs under SKILL_DIRS whose name isn't in `keep`.
/// Makes skill projection reconciling: a source that's gone (uninstalled or
/// hand-deleted) stops shadowing executors on the next `project()`. Touches
/// ONLY `canon-`-prefixed dirs — user-authored skill dirs are never removed.
fn prune_stale_skill_dirs(
    repo_root: &Path,
    keep: &std::collections::HashSet<String>,
) -> Result<(), CanonError> {
    for base in SKILL_DIRS {
        let dir = repo_root.join(base);
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // dir doesn't exist yet → nothing to prune
        };
        for entry in entries {
            let path = entry?.path();
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if let Some(skill) = name.strip_prefix("canon-") {
                if !keep.contains(skill) && path.is_dir() {
                    std::fs::remove_dir_all(&path)?;
                }
            }
        }
    }
    Ok(())
}
```

In `project_with_active`, immediately before the `for (name, _v, body) in &skills` write loop (~line 520):

```rust
    let keep: std::collections::HashSet<String> =
        skills.iter().map(|(n, _, _)| n.clone()).collect();
    prune_stale_skill_dirs(repo_root, &keep)?;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p karl-canon project_prunes_stale_canon_skill_dirs`
Expected: PASS.

- [ ] **Step 5: Run the full canon suite (no regressions)**

Run: `cargo test -p karl-canon`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must be worktree-skill-uninstall
git add crates/canon/src/project.rs
git commit -m "feat(canon): reconciling skill projection — prune stale canon- dirs"
```

---

### Task 2: `uninstall_skill`

**Files:**
- Modify: `crates/canon/src/install.rs` (add `uninstall_skill`; `write_lock` is the private helper in this file, `canon_dir`/`read_manifest`/`write_manifest` are imported, `valid_pkg_name` is in-crate, `project` is imported)
- Modify: `crates/canon/src/lib.rs` (re-export `uninstall_skill`)
- Test: `crates/canon/src/install.rs` tests

**Interfaces:**
- Consumes: `install_from_dir` (to set up test state), `read_manifest`, `write_manifest`, `write_lock`, `valid_pkg_name`, `project`, `canon_dir`.
- Produces: `karl_canon::uninstall_skill(repo_root: &Path, name: &str) -> Result<(), CanonError>`.

- [ ] **Step 1: Write the failing tests**

Add to `crates/canon/src/install.rs` tests:

```rust
#[test]
fn uninstall_skill_removes_source_manifest_and_projection() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let pkg = root.join("pkg");
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::write(pkg.join("skill.toml"), "name = \"kyc\"\nversion = \"1.0.0\"\n").unwrap();
    std::fs::write(pkg.join("SKILL.md"), "---\nname: kyc\n---\nx\n").unwrap();
    install_from_dir(root, &pkg, "local:pkg").unwrap();
    assert!(root.join(".covenant/canon/skills/kyc").exists());
    assert!(root.join(".claude/skills/canon-kyc/SKILL.md").exists());

    uninstall_skill(root, "kyc").unwrap();

    assert!(!root.join(".covenant/canon/skills/kyc").exists(), "source removed");
    assert!(!root.join(".claude/skills/canon-kyc").exists(), "projection removed");
    assert!(read_manifest(root).unwrap().installed.iter().all(|i| i.name != "kyc"), "manifest entry removed");
}

#[test]
fn uninstall_skill_absent_errors() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(uninstall_skill(tmp.path(), "nope").is_err());
}

#[test]
fn uninstall_skill_rejects_bad_name() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(uninstall_skill(tmp.path(), "../escape").is_err());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p karl-canon uninstall_skill`
Expected: FAIL — `uninstall_skill` not found.

- [ ] **Step 3: Implement `uninstall_skill`**

In `crates/canon/src/install.rs` (near `install_from_dir`):

```rust
/// Remove a locally installed skill: its source dir, its manifest/lock entry,
/// and (via the reconciling `project`) its executor projections. Errors if the
/// name is invalid or the skill isn't installed.
pub fn uninstall_skill(repo_root: &Path, name: &str) -> Result<(), CanonError> {
    if !valid_pkg_name(name) {
        return Err(CanonError::InvalidPackage(format!("invalid skill name: {name:?}")));
    }
    let skills_root = canon_dir(repo_root).join("skills");
    let dest = skills_root.join(name);
    if !dest.starts_with(&skills_root) {
        return Err(CanonError::InvalidPackage(format!("skill path escapes skills dir: {name:?}")));
    }
    let mut manifest = read_manifest(repo_root)?;
    let had_entry = manifest.installed.iter().any(|i| i.name == name);
    if !dest.exists() && !had_entry {
        return Err(CanonError::InvalidPackage(format!("skill not installed: {name}")));
    }
    if dest.exists() {
        std::fs::remove_dir_all(&dest)?;
    }
    manifest.installed.retain(|i| i.name != name);
    write_manifest(repo_root, &manifest)?;
    write_lock(repo_root, &manifest)?;
    project(repo_root)
}
```

In `crates/canon/src/lib.rs`, add to the existing `pub use install::…` line (or as a new one matching the file's style):

```rust
pub use install::uninstall_skill;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl-canon uninstall_skill`
Expected: all three PASS.

- [ ] **Step 5: Full canon suite**

Run: `cargo test -p karl-canon`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add crates/canon/src/install.rs crates/canon/src/lib.rs
git commit -m "feat(canon): uninstall_skill removes source, manifest entry, projection"
```

---

### Task 3: Tauri command + api.ts wrapper

**Files:**
- Modify: `crates/app/src/lib.rs` (add `canon_uninstall_skill` near `canon_install_registry` ~line 2693; register in `generate_handler!` at ~line 5075)
- Modify: `ui/src/api.ts` (add `canonUninstallSkill` near the other `canon…` registry wrappers)

**Interfaces:**
- Consumes: `karl_canon::uninstall_skill` (Task 2).
- Produces: Tauri command `canon_uninstall_skill(cwd, name) -> Result<(), String>`; `canonUninstallSkill(cwd: string, name: string): Promise<void>`.

- [ ] **Step 1: Add the Tauri command**

In `crates/app/src/lib.rs`, after `canon_install_registry` (ends ~line 2725):

```rust
/// Remove a locally installed skill (source + manifest + projection).
#[tauri::command]
async fn canon_uninstall_skill(cwd: String, name: String) -> Result<(), String> {
    let repo = std::path::PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || karl_canon::uninstall_skill(&repo, &name))
        .await
        .map_err(|e| format!("canon_uninstall_skill join: {e}"))?
        .map_err(|e| e.to_string())
}
```

Register it in the `generate_handler!` list next to `canon_install_registry_unit` (~line 5076):

```rust
            canon_uninstall_skill,
```

- [ ] **Step 2: Add the api.ts wrapper**

In `ui/src/api.ts`, next to `canonInstallRegistry`/`canonInstallRegistryUnit`:

```ts
export async function canonUninstallSkill(cwd: string, name: string): Promise<void> {
  return invoke<void>("canon_uninstall_skill", { cwd, name });
}
```

- [ ] **Step 3: Build both sides**

Run: `cargo check -p covenant && npm run build`
Expected: both clean (no new TS errors; `canonUninstallSkill` is exported but not yet used — that's fine, `export`ed functions don't trip no-unused).

- [ ] **Step 4: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add crates/app/src/lib.rs ui/src/api.ts
git commit -m "feat(app): canon_uninstall_skill command + api wrapper"
```

---

### Task 4: Trash button on Skills rows

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts` (`renderSkillsSection`, the `status.installed` loop at ~line 963–987; `canonUninstallSkill` import at the top ~line 20)
- Test: `ui/src/canon/cockpit/view.test.ts`

**Interfaces:**
- Consumes: `canonUninstallSkill` (Task 3), `iconButton`, `Icons.trash`, `this.friendlyError`, the section's `load` closure and `errorEl` (both in scope in `renderSkillsSection`).

- [ ] **Step 1: Write the failing test**

In `ui/src/canon/cockpit/view.test.ts`: add `canonUninstallSkill: vi.fn(async () => undefined),` to the `vi.mock("../../api", …)` object, and add `canonUninstallSkill` to the `import { … } from "../../api"` list. Then add, inside a Skills describe block (create one if absent, mirroring the existing section tests' use of `new CanonCockpitView(opts)` + `vi.waitFor`):

```ts
it("uninstalls a skill via the trash button after confirm", async () => {
  vi.mocked(canonLocalStatus).mockResolvedValue({
    installed: [{ name: "kyc", version: "1.0.0", source: "local:x", sha: "a", signer: null, installedAt: "t" }],
    agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [],
  });
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
  const v = new CanonCockpitView(opts);
  v.open(); v.showSection("skills");
  await vi.waitFor(() => {
    expect(v.element.querySelector(".canon-skill-row [aria-label='Uninstall skill']")).toBeTruthy();
  });
  v.element.querySelector<HTMLButtonElement>(".canon-skill-row [aria-label='Uninstall skill']")!.click();
  await vi.waitFor(() => {
    expect(api.canonUninstallSkill).toHaveBeenCalledWith(expect.any(String), "kyc");
  });
  confirmSpy.mockRestore();
});

it("does not uninstall when confirm is declined", async () => {
  vi.mocked(canonLocalStatus).mockResolvedValue({
    installed: [{ name: "kyc", version: "1.0.0", source: "local:x", sha: "a", signer: null, installedAt: "t" }],
    agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [],
  });
  vi.mocked(api.canonUninstallSkill).mockClear();
  const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
  const v = new CanonCockpitView(opts);
  v.open(); v.showSection("skills");
  await vi.waitFor(() => {
    expect(v.element.querySelector(".canon-skill-row [aria-label='Uninstall skill']")).toBeTruthy();
  });
  v.element.querySelector<HTMLButtonElement>(".canon-skill-row [aria-label='Uninstall skill']")!.click();
  await Promise.resolve();
  expect(api.canonUninstallSkill).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});
```

Match the fixture's `installed` shape to the real `InstalledRef` TS type in `api.ts` (fields: name, version, source, sha, signer, installed_at) — adjust if the type differs. Reference `api` via the file's existing import style (the registry tests already `import { … } from "../../api"` and call `vi.mocked(...)`; use `canonUninstallSkill` the same way — `api.canonUninstallSkill` in the snippet assumes a namespace import, so rewrite as bare `canonUninstallSkill` if the file imports names individually).

- [ ] **Step 2: Run tests to verify they fail**

Run (from repo ROOT): `npm test -- --run ui/src/canon/cockpit/view.test.ts`
Expected: FAIL — no `[aria-label='Uninstall skill']` button rendered.

- [ ] **Step 3: Add the trash button**

In `ui/src/canon/cockpit/view.ts`, add the import at the top (~line 20, alongside `canonPublish`):

```ts
  canonUninstallSkill,
```

In `renderSkillsSection`'s `status.installed` loop, after the Publish `if (active && …) { … }` block and before `list.appendChild(skillCard({…}))` (~line 978):

```ts
            const del = iconButton(Icons.trash({ size: 15 }), "Uninstall skill", () => {
              if (!confirm(`Uninstall skill "${i.name}"? Removes it from this repo and every executor projection.`)) return;
              errorEl.hidden = true;
              del.disabled = true;
              void canonUninstallSkill(cwd, i.name)
                .then(load)
                .catch((e) => {
                  errorEl.hidden = false;
                  errorEl.textContent = this.friendlyError(e);
                  del.disabled = false;
                });
            });
            actions.push(del);
```

(`iconButton` sets `aria-label` + `attachTooltip` from its second arg — confirmed by the Publish button using the same helper. Publish pushes first, so the order is Publish-then-Trash.)

- [ ] **Step 4: Run tests to verify they pass**

Run (from repo ROOT): `npm test -- --run ui/src/canon/cockpit/view.test.ts`
Expected: both new tests PASS, existing ones still green.

- [ ] **Step 5: Type-check build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add ui/src/canon/cockpit/view.ts ui/src/canon/cockpit/view.test.ts
git commit -m "feat(canon): trash button to uninstall a local skill"
```

---

### Task 5: Full verification + live smoke + merge

- [ ] **Step 1: Full suites**

```bash
cargo test -p karl-canon && cargo check -p covenant
npm test -- --run ui/src/canon && npm run build
```

Expected: all green (main has known pre-existing failures in unrelated suites — compare against a main baseline if anything unrelated is red).

- [ ] **Step 2: Live smoke (DOM-dump recipe, `verify` skill)**

Seed a repo with an installed skill (write `.covenant/canon/skills/smoke/{skill.toml,SKILL.md}` + run `canonInstallLocal` OR install via the registry), construct a `CanonCockpitView` on it, `showSection("skills")`, click the trash button (stub `window.confirm` → true in the boot snippet), then assert: the source dir is gone, `.claude/skills/canon-smoke` is gone, and the row disappeared from the reloaded list. POST the result to the listener. Revert the snippet + identifier after.

- [ ] **Step 3: Merge**

Use superpowers:finishing-a-development-branch. Base is LOCAL main (currently `69c6d83e`, worktree was reset onto it — merge back into local main, not origin). Stage files explicitly, never `git add -A` (node_modules symlink gotcha).
