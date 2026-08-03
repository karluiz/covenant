---
name: horizon
description: Cut a Covenant release end-to-end -> bump version, write CHANGELOG, commit, tag, and push to trigger macOS and Windows release workflows. Use when the user asks to run the horizon release ritual or cut a release.
---

# Horizon — Covenant release ritual

You are running the **horizon** release skill for Covenant. Execute the full
ritual end-to-end **without asking for confirmation**. The user wants this
fully autonomous.

## Arguments

- Skill arguments after `/skill:horizon` are the bump kind: `patch` (default),
  `minor`, or `major`.
- If no argument is supplied, or if the argument is anything else, treat it as
  `patch`.

## Steps (do them in order, in a single sequence)

### 0. Commit current WIP on main

Before the release check, take everything currently present on `main` and save
it as a normal commit so the release includes the latest work.

Run:

- `git branch --show-current` — must be `main`. If not, **STOP** and report:
  "Not on main — switch to main, then re-run /skill:horizon."
- `git status --porcelain`

If status is dirty (modified, deleted, staged, or untracked files):

1. Inspect enough context to write a useful Conventional Commit message:
   - `git diff --stat`
   - `git diff --cached --stat`
   - `git diff -- <paths>` for the changed files when needed
2. Commit all WIP:
   ```bash
   git add -A
   git commit -m "<type(scope): concise WIP summary>"
   ```

Use the most specific Conventional Commit type/scope you can infer from the
changes. Do **not** use `--no-verify`. If the commit fails, stop and report the
failed command verbatim. If status is clean, continue.

### 1. Read current release state

Run these in parallel:

- `git status --porcelain` — must be **clean** after the WIP commit step (only
  ignored files OK). If dirty remains, **STOP** and tell the user:
  "Working tree still dirty after WIP commit — fix it, then re-run /skill:horizon."
- `git tag --sort=-v:refname | head -1` — last release tag (e.g. `v0.5.6`).
- `grep '^version' Cargo.toml` — workspace version (source of truth).

### 2. Compute next version

From the workspace version `MAJOR.MINOR.PATCH`, apply the bump:

- `patch` → `MAJOR.MINOR.(PATCH+1)`
- `minor` → `MAJOR.(MINOR+1).0`
- `major` → `(MAJOR+1).0.0`

Call this `$NEXT` (e.g. `0.5.7`). The git tag will be `v$NEXT`.

### 3. Collect commits since last tag

```bash
git log <last-tag>..HEAD --pretty=format:'%h %s'
```

Skip merge commits and any commit whose subject starts with `chore(release):`.

### 4. Generate the one-line summary

From those commits, infer **what shipped** in this release. The summary
is for the CHANGELOG header and the commit message — keep it to ~6–10
words, no trailing period. Examples from prior releases:

- "Windows launch fix (pwsh help banner)"
- "Horizontal tab bar overflow scroll"
- "Capabilities auto-context + tab/group drag polish"

Focus on the most user-visible change. If there are multiple unrelated
changes, pick the highest-impact one and append "+ polish" or similar.

### 5. Generate the CHANGELOG entry

Prepend a new section to `CHANGELOG.md` directly after the line
`Removed**.` (i.e. above the current top-most version section). Format:

```markdown
## v$NEXT — <one-line summary>

### <Fixed | Added | Changed>

- **<short title>**: <1–3 sentences explaining the change and the
  affected files in backticks>.

- **<next item>**: ...
```

Group bullets by Conventional Commit type:

- `fix:` / `bug:` → **Fixed**
- `feat:` / `add:` → **Added**
- `refactor:` / `chore:` / `perf:` / `docs:` / `style:` → **Changed**

Use the section headers in the order **Added → Changed → Fixed**, omitting
any empty group.

Each bullet should be **substantive** — read the diff for the relevant
commits with `git show <hash> --stat` (or `git log -p <hash>` for small
ones) to write a meaningful description, not just echo the commit subject.
Reference file paths in backticks like prior entries do.

### 6. Bump version in all manifests

Update these files to `$NEXT`:

- `Cargo.toml` — the `[workspace.package] version = "..."` line
- `package.json` — root `"version"` field
- `crates/app/tauri.conf.json` — `"version"` field

After editing, run `cargo check -p covenant` to make sure Cargo.lock
gets refreshed. If lock changes, that's expected — it'll go in the commit.

### 7. Commit

```bash
git add CHANGELOG.md Cargo.toml Cargo.lock package.json crates/app/tauri.conf.json
git commit -m "chore(release): v$NEXT — <one-line summary>"
```

No Claude Code coauthor trailer for release commits — match prior style.

### 8. Tag

```bash
git tag v$NEXT
```

### 9. Push

```bash
git push origin main
git push origin v$NEXT
```

The tag push triggers `.github/workflows/release-macos.yml` and
`release-windows.yml` (both gated on `tags: ['v*']`).

### 10. Report back

Output a short summary to the user:

```text
Released v$NEXT — <one-line summary>

CHANGELOG: <N> bullets across <Added/Changed/Fixed>
Tag pushed: v$NEXT → macOS + Windows workflows running
Watch: gh run list --workflow=release-macos.yml --limit 1
```

## Hard rules

- **Never** push if the WIP commit step failed or if the working tree remains
  dirty after step 0.
- **Never** skip hooks (no `--no-verify`).
- **Never** force-push or amend.
- **Never** push without the tag, or the tag without main.
- If any step fails, stop and report the failure verbatim with the command
  that failed — do **not** try to "recover" by reverting the bump.
