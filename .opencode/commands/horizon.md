---
description: Cut a release — bump version, write CHANGELOG, commit, tag, push (triggers macOS + Windows release workflows)
argument-hint: "[patch|minor|major]"
---

# /horizon — release ritual

You are running the **horizon** release command for Covenant. Execute the full
ritual end-to-end **without asking for confirmation**. The user wants this
fully autonomous.

## Arguments

- `$ARGUMENTS` — bump kind: `patch` (default), `minor`, or `major`.
  If empty or anything else, treat as `patch`.

## Steps (do them in order, in a single sequence)

### 1. Read current state

Run these in parallel:

- `git status --porcelain` — must be **clean** (only ignored files OK). If
  there are uncommitted/untracked changes, **STOP** and tell the user:
  "Working tree dirty — commit or stash first, then re-run /horizon."
- `git tag --sort=-v:refname | head -1` — last release tag (e.g. `v0.5.6`).
- `grep '^version' Cargo.toml` — workspace version (source of truth).

### 2. Compute next version

Call the workspace version from step 1 `$CURRENT` (e.g. `0.5.6`) — step 6
substitutes against it. From its `MAJOR.MINOR.PATCH`, apply the bump:

- `patch` → `MAJOR.MINOR.(PATCH+1)`
- `minor` → `MAJOR.(MINOR+1).0`
- `major` → `(MAJOR+1).0.0`

Call this `$NEXT` (e.g. `0.5.7`). The git tag will be `v$NEXT`.

### 3. Collect commits since last tag

```
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

Substitute against the **current** version string rather than a line
address. `$CURRENT` appears exactly once in each of these files, so a plain
global `s///` is unambiguous and needs no range:

```
sed -i '' "s/^version = \"$CURRENT\"/version = \"$NEXT\"/" Cargo.toml
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEXT\"/" \
  package.json crates/app/tauri.conf.json
```

Do **not** reach for GNU's `0,/re/s//…/` "first match only" idiom. macOS
ships BSD sed, which rejects line address `0` — and it fails *silently*,
leaving the file untouched while the command reports success. That is how
v0.9.46 nearly tagged a build with `Cargo.toml` at the new version and both
JSON manifests still at the old one; only step 6's five-way verification
caught it. (`sed -i ''` with the empty backup arg is itself BSD syntax —
GNU sed wants a bare `-i`. This repo is macOS-canonical, so BSD form wins.)

Then refresh **both** lockfiles — each manifest has one, and a lockfile
left behind still claims the old version:

```
cargo check -p covenant          # refreshes Cargo.lock
npm install --package-lock-only  # refreshes package-lock.json
```

Both lockfiles changing is expected — they go in the commit (step 7 already
stages them). `--package-lock-only` touches only the lockfile, never
`node_modules`, so it's safe and fast.

Verify all five agree before committing — a mismatch here ships a build
whose version doesn't match its own lockfile:

```
grep '^version' Cargo.toml
grep -m1 '"version"' package.json crates/app/tauri.conf.json
grep -m1 '"version"' package-lock.json
grep -m1 -A1 'name = "covenant"' Cargo.lock
```

### 7. Commit

```
git add CHANGELOG.md Cargo.toml Cargo.lock package.json package-lock.json crates/app/tauri.conf.json
git commit -m "chore(release): v$NEXT — <one-line summary>"
```

(No Claude Code coauthor trailer for release commits — match prior style.)

All **six** paths must be staged. `package-lock.json` is the one that goes
missing — step 6 refreshes it, so leaving it out of the `git add` tags a
release whose npm lockfile still claims the previous version (this happened
in v0.9.45). Confirm nothing was left behind before tagging:

```
git status --porcelain   # must be empty
```

If that prints anything, the commit is incomplete — `git add` the remaining
paths and `git commit --amend --no-edit` **before** step 8 creates the tag.
(Amending here is fine: the tag does not exist yet and nothing is pushed.)

### 8. Tag

```
git tag v$NEXT
```

### 9. Push

```
git push origin main
git push origin v$NEXT
```

The tag push triggers `.github/workflows/release-macos.yml` and
`release-windows.yml` (both gated on `tags: ['v*']`).

### 10. Report back

Output a short summary to the user:

```
Released v$NEXT — <one-line summary>

CHANGELOG: <N> bullets across <Added/Changed/Fixed>
Tag pushed: v$NEXT → macOS + Windows workflows running
Watch: gh run list --workflow=release-macos.yml --limit 1
```

## Hard rules

- **Never** push if the working tree had pre-existing uncommitted changes —
  stop in step 1.
- **Never** skip hooks (no `--no-verify`).
- **Never** force-push. **Never** amend once the tag exists or anything is
  pushed — the single exception is completing an under-staged release commit
  in step 7, before the tag is created.
- **Never** push without the tag, or the tag without main.
- If any step fails, stop and report the failure verbatim with the command
  that failed — do NOT try to "recover" by reverting the bump.
