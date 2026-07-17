# Canon — Import from skills.sh (Sub-project C-import)

**Date:** 2026-07-17
**Branch:** `feat/canon-import-skillsh`
**Status:** Approved design, pending implementation plan

## Problem

Canon can now DETECT and ADOPT context already present in a repo (sub-project A),
and it has an org-scoped registry (`canon_install_registry` → forge.covenant.uno).
What it can't do is pull from the **public external ecosystem** of agent skills.

[skills.sh](https://www.skills.sh) is the de-facto "npm for agent skills":
`npx skills add <owner/repo> --skill <name>` installs a skill, and it handles the
messy parts — 20+ registries, varying repo layouts, updates. Crucially, skills
are `SKILL.md` files (YAML frontmatter: name + description — the same format Canon
projects) and `npx skills add` writes them into **`.claude/skills/`** — exactly
where sub-project A's detection already looks.

That last fact is the whole design: **import composes with A for free.** If Canon
runs `npx skills add`, the skill lands where detection sees it, and A's `adopt`
brings it into Canon source. Import is orchestration over two things we already
have — the skills.sh CLI and A's adopt — not a new fetcher.

## Approach

```
paste "owner/repo --skill x"
   │
   ▼  canon_import_skill(cwd, ref)          [new app-layer command]
   1. snapshot detected skill names BEFORE   (karl_canon::scan_detected)
   2. npx --yes skills add <ref>             (shell-out, cwd = repo root, stdin null)
   3. karl_canon::adopt_new_skills(repo, before)
        → scan detected AFTER, adopt each name not in `before`   (karl_canon::adopt)
   4. return the adopted (slugified) skill names
```

- No GitHub fetch / repo-layout / registry logic — `npx skills` owns that.
- No new landing logic — A's `adopt` (already live-verified) owns that. Adopt
  slugifies, moves the skill into `.covenant/canon/skills/<slug>/`, adds a
  manifest ref, projects `canon-<slug>`, and removes the foreign dup.
- Complements the org registry; this is the public external source.

## Architecture

### Canon crate — testable core (`crates/canon/src/install.rs`)

`adopt_new_skills` isolates the part that has no external dependency, so it's
unit-testable without npx:

```rust
/// Adopt every DETECTED skill whose name is not already in `before`. Returns the
/// adopted names (post-slugify). Used by import: snapshot before an external
/// install, run the installer, then adopt whatever newly appeared under
/// `.claude/skills`. Skips skills that error individually (best-effort import).
pub fn adopt_new_skills(
    repo_root: &Path,
    before: &std::collections::HashSet<String>,
) -> Result<Vec<String>, CanonError> {
    let detected: Vec<String> = crate::scan_detected(repo_root)?
        .into_iter()
        .filter(|u| u.kind == ContextKind::Skill && !before.contains(&u.name))
        .map(|u| u.name)
        .collect();
    let mut adopted = Vec::new();
    for name in detected {
        // Best-effort: one skill failing to adopt must not sink the whole import.
        // slugify happens inside adopt; record the slug we land under.
        if crate::adopt(repo_root, ContextKind::Skill, &name).is_ok() {
            adopted.push(crate::compile::slugify(&name));
        }
    }
    Ok(adopted)
}
```

Re-exported from `crates/canon/src/lib.rs`. Also need a way to snapshot the
"before" set — a small helper or inline in the app command using `scan_detected`.

### App crate — the shell-out (`crates/app/src/lib.rs`, new command)

`canon_import_skill(cwd, ref)`:

1. **Validate `ref`** (security — see below). Reject → error before spawning.
2. Snapshot: `before = scan_detected(repo).filter(Skill).map(name)` as a HashSet.
3. Spawn `npx` with an **argument vector** (never a shell string):
   `["--yes", "skills", "add", <repo>, "--skill", <n1>, "--skill", <n2>, ...]`,
   `current_dir(repo_root)`, `stdin(Stdio::null())` (so any interactive prompt
   gets EOF and fails fast instead of hanging), capture stdout+stderr.
   Wrap in a ~120s timeout (`tokio::time::timeout` with `tokio::process`, or
   `std::process` inside `spawn_blocking` + a watchdog). Non-zero exit or timeout
   → return the stderr as the error.
4. `karl_canon::adopt_new_skills(repo, &before)`.
5. Return `Vec<String>` (adopted slugs). Empty vec = the command ran but nothing
   new landed (surface that as an informational message, not an error).

Registered in `generate_handler!`. Mirrors the structure of the existing
`canon_install_registry` command.

### Ref validation (security boundary)

The ref is user input that becomes a spawned process. Parse and whitelist; never
interpolate into a shell.

- Strip an optional leading `npx skills add ` (users copy the whole command from
  skills.sh).
- Tokenize on whitespace. Token 0 = **repo**, must match
  `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$` (`owner/repo`). Reject otherwise.
- Remaining tokens must be `--skill <name>` pairs, `<name>` matching
  `^[A-Za-z0-9_.-]+$`. Any other token/flag → reject with a clear message.
- `--skill` is optional (a bare repo installs all its skills; delta-adopt handles
  however many land). But a ref without `--skill` may hang the CLI on an
  interactive picker → the `stdin(null)` + timeout guard turns that into a fast
  failure, and the error message suggests adding `--skill`.

### UI (`ui/src/canon/cockpit/view.ts`, Skills section)

- An **import bar** above the skills list: a text input
  (placeholder `owner/repo --skill name`) + an "Import" button. Same action in the
  empty-state actions row, beside "Browse registry".
- On submit: disable the button, `canonImportSkill(cwd, ref)`:
  - success with names → `pushInfoToast({ message: "Imported: <names>" })` +
    reload the section (they now render as managed skills).
  - success with empty → `pushInfoToast({ message: "Nothing new to import" })`.
  - error → `pushInfoToast({ message: "Import failed: <friendlyError>" })`.
- `canonImportSkill(cwd, ref): Promise<string[]>` added to `ui/src/api.ts`.
- Copy: English, sentence case. No emoji. SVG icons via `Icons.*`. No native
  `title` tooltips.

## Scope (v1 — ponytail)

- **Skills only** (skills.sh is skills). No agents/commands from skills.sh.
- **Paste-a-ref** discovery only — no in-app search (`npx skills find`) and no
  `--list` picker. Both are follow-ups.
- Auto-adopt the delta (all newly-detected skills after the install).
- Node/npx must be on PATH — if absent, the spawn fails; surface a clear
  "npx not found — install Node" message.
- Project scope: run in the repo root so the CLI targets `.claude/skills/`
  (project), not `~/.claude/skills/` (global). Verify the CLI's default/flag
  during implementation against `npx skills add --help`.

## Testing

- **Unit (`crates/canon`):** `adopt_new_skills` — plant a foreign
  `.claude/skills/new-skill`, `before = {}`, assert it returns `["new-skill"]`
  and the skill is now in Canon source; plant a second foreign skill already in
  `before`, assert it is NOT re-adopted. Uppercase name (`.claude/skills/CoolTool`)
  → returned slug is `cooltool` and it's adopted. Scope with `-p karl-canon`.
- **Unit (`crates/app`):** ref validator — accepts `owner/repo`,
  `owner/repo --skill x`, and a pasted `npx skills add owner/repo --skill x`;
  rejects injection attempts (`owner/repo; rm -rf ~`, backticks, `--other`,
  `../escape`), returning an error (no spawn).
- **Manual e2e verify** (the `verify`-skill DOM/IPC recipe, as used for A):
  import a real ref (e.g. a small skill from `anthropics/skills`) against a
  fixture repo, confirm the skill lands, auto-adopts, and shows as a managed
  Canon skill; confirm `.covenant/canon/skills/<slug>/` on disk. Reuse the
  `~/Sources/canon-detect-kit` fixture repo.

## Out of scope (follow-ups)

- **In-app search** (`npx skills find <query>` → results → pick). Needs parsing
  the CLI's output; deferred.
- **`--list` picker** (paste a repo → list its skills → choose).
- **Non-skill kinds** from external sources (agents/commands).
- **Update/upgrade** an imported skill (re-import currently re-adopts/overwrites).
- **Provenance**: recording that a skill came from skills.sh vs local (the
  manifest `source` is `"detected"` after adopt; a dedicated `skills.sh:<repo>`
  source label is a nice-to-have, not v1).
