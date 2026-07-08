# Actionable LSP Runtime Banner — Design

**Date:** 2026-07-08
**Status:** Approved pending user review
**Context:** Builds on shipped LSP P1–P5 (v0.8.141). The "needs-runtime" banner (P3/P4/P5) currently states the requirement but doesn't guide the fix.

## Problem

When a language server needs a runtime the user's login shell can't satisfy, the editor shows a bare banner:

> Code intelligence needs Java ≥ 21 (found 17.0.18) [Recheck]

This states the requirement but doesn't orient. The most common real case — the user HAS a new-enough runtime installed, but their login-shell PATH resolves an older one (e.g. openjdk 26 at `/opt/homebrew/opt/openjdk` while `/usr/bin/java` shims to 17) — is exactly where a bare requirement is least helpful. The banner should diagnose and tell the user the exact fix, the way a knowledgeable person would.

## Goal

Make the needs-runtime banner **actionable**: when the runtime is missing or too old, scan common install locations for a satisfying version; if one exists off-PATH, show the exact PATH fix (copyable, never auto-applied); otherwise show a per-runtime install hint. Covers node / dotnet / java (every runtime that uses the needs-runtime path).

## Non-goals

- The app never writes the user's dotfiles. It shows a copyable command; the user runs it. (Approved scope decision — diagnose + command, not one-click fix.)
- No exhaustive filesystem walk — a curated per-runtime location list.
- No version-manager activation logic (nvm `use`, sdkman `use`) in v1 — if the satisfying binary is found under a version-manager dir, we still show the PATH-prepend of that binary's dir; the idiomatic `nvm use` hint is a follow-up (`ponytail:`).
- macOS is canonical. Linux/Windows get generic install hints (no curated scan) — `ponytail:`.

## Architecture

```
runtime::detect(req) fails (RuntimeMissing)
        │
        ▼
runtime::suggest_fix(req) -> RuntimeSuggestion        (NEW, crates/lsp/src/runtime.rs)
  scan curated dirs → run <bin> --version → extract_version → keep newest that is >= min
        │
        ├─ a satisfying binary found, its dir NOT on the login-shell PATH
        │     → OnDiskNotOnPath { version, dir }
        ├─ none found
        │     → Install { hint }
        └─ (satisfying binary found AND already on PATH — shouldn't happen since detect just failed on it; treat as Install for safety)
        │
        ▼
lsp_server_status attaches it to RuntimeMissingInfo.suggestion
        │
        ▼ (Tauri → api.ts → manager needs-runtime status)
editor.ts renders the enriched banner
```

### Backend — `crates/lsp/src/runtime.rs`

New pure-ish surface (the disk scan is impure; the selection logic is pure and unit-tested):

```rust
pub enum RuntimeSuggestion {
    /// A satisfying version exists on disk but its dir isn't on the
    /// login-shell PATH. `dir` is the bin dir to prepend.
    OnDiskNotOnPath { version: String, dir: String },
    /// No satisfying version found anywhere we looked.
    Install { hint: String },
}

/// Called only after `detect` returns RuntimeMissing. Scans a curated,
/// per-runtime list of common locations for a version >= req.min_version.
pub fn suggest_fix(req: &RuntimeReq) -> RuntimeSuggestion;

/// PURE + unit-tested: given candidate (dir, version) pairs and a min,
/// pick the dir of the NEWEST candidate that satisfies min. None if empty.
fn pick_newest_satisfying(candidates: &[(String, String)], min: &str) -> Option<(String, String)>;
```

- **Curated locations (macOS)** — globbed dirs, each yielding a candidate `<dir>/<bin>` we run `--version` on:
  - java: `/usr/libexec/java_home -V` output paths (append `/bin`), `/opt/homebrew/opt/openjdk*/bin`, `/opt/homebrew/opt/openjdk@*/bin`, `~/.sdkman/candidates/java/*/bin`
  - node: `/opt/homebrew/opt/node*/bin`, `~/.nvm/versions/node/*/bin`, `/usr/local/bin`
  - dotnet: `/usr/local/share/dotnet`, `/opt/homebrew/opt/dotnet*/bin`, `/opt/homebrew/opt/dotnet@*/bin`
  - Version parsing reuses `extract_version` (already generalized in P5 — handles `openjdk 17.0.18`, `v18.19.0`, `10.0.101`).
- **"not on PATH" test:** the candidate `dir` is not a prefix of any entry in the login-shell PATH (query it once via `$SHELL -lc 'echo $PATH'`). If the newest-satisfying dir IS already on PATH, `detect` wouldn't have failed on an older one unless order matters — treat "found but on PATH" as `Install` (safe fallback) to avoid a confusing "add a dir you already have" message.
- **Install hints (static, per runtime):** java → `brew install openjdk` (or Temurin); node → `brew install node` (or nodejs.org); dotnet → `brew install dotnet` (or the .NET SDK page). English, one line.
- **Blocking scan in an async command:** `suggest_fix` runs sync `Command`s; called from `lsp_server_status` which is a **sync** Tauri command already — so no async-blocking concern (consistent with the existing sync status command).

### Contract — `crates/app/src/lsp_commands.rs` + `ui/src/api.ts`

`RuntimeMissingInfo` gains `suggestion: Option<RuntimeSuggestionDto>` where the DTO is a tagged shape:
```rust
// serde tag = "kind": "on_disk_not_on_path" | "install"
enum RuntimeSuggestionDto {
    OnDiskNotOnPath { version: String, dir: String },
    Install { hint: String },
}
```
`lsp_server_status`, on RuntimeMissing, calls `suggest_fix` and populates `suggestion`. api.ts `LspServerStatus.runtimeMissing` gains `suggestion?: { kind: "on_disk_not_on_path"; version; dir } | { kind: "install"; hint }`. The frontend `needs-runtime` status (manager.ts `LspDocStatus`) carries it through.

### Frontend — `ui/src/structure/editor.ts` (needs-runtime case)

The banner keeps its first line ("Code intelligence needs {Runtime} ≥ {min} (found {found})") and gains a second, actionable line from the suggestion:
- **OnDiskNotOnPath:** "You have {Runtime} {version} at `{dir}` — it's just not on your shell's PATH." + a monospace, copyable command `export PATH="{dir}:$PATH"` with a **Copy** button + trailing hint "Add it to `~/.zprofile`, then Recheck." (`~/.zprofile` because that's what the login-shell detector sources.)
- **Install:** "{hint}" + a **Copy** button on the command portion.
- **No suggestion / null:** current behavior (just the requirement line).
- **Recheck** button stays. Copy uses the app's existing clipboard helper (reuse whatever `attachTooltip`-adjacent copy util exists; else `navigator.clipboard.writeText`). Sharp corners, English, no `element.title`.

## Error handling

- `suggest_fix` never fails the status: any scan/spawn error → treat that candidate as absent; if all fail → `Install` hint. The banner always renders something useful.
- A candidate whose `--version` is unparseable is skipped (extract_version → None).
- If querying the login-shell PATH fails, skip the "on PATH" filter (still offer the on-disk dir — worst case the user adds a dir already on PATH, harmless).

## Testing

- **Rust unit (pure):** `pick_newest_satisfying` — picks newest satisfying, ignores below-min, empty → None, ties/ordering. `extract_version` already covered (P5). A table-driven test for the "dir not on PATH" prefix check with a fake PATH string.
- **Rust (scan, light):** a test that `suggest_fix` for a runtime returns *something* (Install or OnDisk) without panicking, given the real machine — tolerant assertion (don't hard-code the dev machine's JDKs).
- **Frontend vitest:** the banner-line builder is a pure function `runtimeSuggestionLine(suggestion) -> { text, command? }` — unit-test the three cases (on-disk, install, null). The DOM wiring is verified by build + manual.
- **Manual:** with java 17 on PATH + openjdk 26 installed (the exact repro), open a `.java` → banner shows "You have Java 26 at /opt/homebrew/opt/openjdk — not on your PATH" + copyable export + Recheck.

## Scope / effort

Single focused change: one new backend function + its pure selector, a DTO field threaded through the existing status contract, and an enriched banner branch. No new dependencies. One implementation plan.
