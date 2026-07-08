# Actionable Runtime Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a language server's runtime is missing/too old, the needs-runtime banner diagnoses the fix — if a satisfying version exists off-PATH it shows the exact copyable `export PATH=...`, else a per-runtime install hint. The app never writes dotfiles.

**Architecture:** Extends shipped LSP P1–P5 (v0.8.141). Backend `crates/lsp/src/runtime.rs` gains a pure `pick_newest_satisfying` selector + an impure `suggest_fix` scan of curated locations. The result rides through the existing status contract (`RuntimeMissingInfo.suggestion` → `LspServerStatus` → api.ts → manager `needs-runtime`). The editor's needs-runtime banner branch renders a second actionable line with a Copy button.

**Tech Stack:** Rust (std only — no new deps), TypeScript (existing `copyToClipboard` helper, CM6-free plain DOM).

**Spec:** `docs/superpowers/specs/2026-07-08-runtime-banner-guidance-design.md`

## Global Constraints

- Rust: thiserror; no unwrap outside cfg(test); tracing structured; String errors at the Tauri boundary.
- TS strict, no `as any` without a justifying comment. English copy, sharp corners, no `element.title`.
- The app NEVER writes the user's dotfiles — it only shows a copyable command.
- Curated per-runtime location list, NOT a filesystem walk. macOS canonical; Linux/Windows get the install hint only (no scan) — `ponytail:`.
- Reuse `extract_version`/`version_ge` (already in runtime.rs). Reuse the existing `copyToClipboard` util (grep `export function copyToClipboard` / its import site in `ui/src/blocks/manager.ts`).
- vitest from repo ROOT; `cargo test -p karl-lsp`; app crate `covenant`. Conventional Commits.

## Current shapes (do not re-derive)

- `runtime.rs`: `RuntimeReq { name: String, min_version: String, version_arg: String }`, `pub fn extract_version(&str) -> Option<String>`, `pub fn version_ge(found: &str, min: &str) -> bool`, `fn is_version_like(&str) -> bool`, `detect(req) -> Result<Resolved, LspError>`.
- `crates/app/src/lsp_commands.rs`: `RuntimeMissingInfo { name, min, found: Option<String> }` (derives `Serialize`); `LspServerStatus.runtime_missing: Option<RuntimeMissingInfo>`; `lsp_server_status` builds it at ~L307-317 (`runtime_missing = Some(RuntimeMissingInfo { name, min, found })` inside the `if let Err(e) = runtime::detect(...)` branch).
- `ui/src/api.ts`: `interface LspRuntimeMissing` (~L3062); `LspServerStatus.runtimeMissing?: LspRuntimeMissing | null`; raw shape `{ name, min, found? }` normalized at ~L3108.
- `ui/src/lsp/manager.ts`: `LspDocStatus` union has `{ kind: "needs-runtime"; name; min; found: string|null }` (~L30); built from `st.runtimeMissing` at ~L294.
- `ui/src/structure/editor.ts`: `case "needs-runtime":` (~L1125) renders `label` + `Recheck`.

---

### Task 1: Backend — `pick_newest_satisfying` (pure) + `RuntimeSuggestion`

**Files:**
- Modify: `crates/lsp/src/runtime.rs`

**Interfaces:**
- Produces: `pub enum RuntimeSuggestion { OnDiskNotOnPath { version: String, dir: String }, Install { hint: String } }` (derives `Debug, Clone, PartialEq`), and `fn pick_newest_satisfying(candidates: &[(String, String)], min: &str) -> Option<(String, String)>` where each candidate is `(dir, version)`; returns the `(dir, version)` of the newest that satisfies `min`.

- [ ] **Step 1: Write the failing test**

Add to `runtime.rs`'s `#[cfg(test)] mod tests`:
```rust
#[test]
fn pick_newest_satisfying_picks_highest_above_min() {
    let c = vec![
        ("/a".to_string(), "17.0.18".to_string()),
        ("/b".to_string(), "26.0.1".to_string()),
        ("/c".to_string(), "21.0.2".to_string()),
    ];
    assert_eq!(
        pick_newest_satisfying(&c, "21"),
        Some(("/b".to_string(), "26.0.1".to_string()))
    );
}

#[test]
fn pick_newest_satisfying_ignores_below_min() {
    let c = vec![
        ("/a".to_string(), "17.0.18".to_string()),
        ("/b".to_string(), "20.9.9".to_string()),
    ];
    assert_eq!(pick_newest_satisfying(&c, "21"), None);
}

#[test]
fn pick_newest_satisfying_empty_is_none() {
    assert_eq!(pick_newest_satisfying(&[], "21"), None);
}

#[test]
fn pick_newest_satisfying_orders_by_full_version_not_just_major() {
    let c = vec![
        ("/a".to_string(), "21.0.9".to_string()),
        ("/b".to_string(), "21.2.0".to_string()),
    ];
    assert_eq!(
        pick_newest_satisfying(&c, "21"),
        Some(("/b".to_string(), "21.2.0".to_string()))
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl-lsp pick_newest`
Expected: compile error — `pick_newest_satisfying` / `RuntimeSuggestion` not defined.

- [ ] **Step 3: Implement**

Add to `runtime.rs` (near `version_ge`):
```rust
/// A remedy the UI can show when `detect` reports a runtime missing/too old.
#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeSuggestion {
    /// A satisfying version exists on disk but its bin dir isn't on the
    /// login-shell PATH. `dir` is the bin dir to prepend.
    OnDiskNotOnPath { version: String, dir: String },
    /// No satisfying version found in the curated locations.
    Install { hint: String },
}

/// Parse a version string to a sortable (major, minor, patch) key. Missing
/// segments default to 0; a leading `v` is tolerated. Non-numeric → 0.
fn version_key(v: &str) -> (u32, u32, u32) {
    let mut it = v.trim().trim_start_matches('v').split('.');
    let p = |x: Option<&str>| x.and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    (p(it.next()), p(it.next()), p(it.next()))
}

/// From `(dir, version)` candidates, return the newest that is `>= min`.
fn pick_newest_satisfying(candidates: &[(String, String)], min: &str) -> Option<(String, String)> {
    candidates
        .iter()
        .filter(|(_, v)| version_ge(v, min))
        .max_by_key(|(_, v)| version_key(v))
        .cloned()
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cargo test -p karl-lsp pick_newest`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/lsp/src/runtime.rs
git commit -m "feat(lsp): RuntimeSuggestion + pick_newest_satisfying selector"
```

---

### Task 2: Backend — `suggest_fix` scan (curated locations + not-on-PATH check)

**Files:**
- Modify: `crates/lsp/src/runtime.rs`

**Interfaces:**
- Consumes: `RuntimeReq`, `RuntimeSuggestion`, `pick_newest_satisfying`, `extract_version`.
- Produces: `pub fn suggest_fix(req: &RuntimeReq) -> RuntimeSuggestion` — scans curated per-runtime locations, runs `<candidate> <version_arg>`, and returns `OnDiskNotOnPath` when the newest satisfying candidate's dir is NOT on the login-shell PATH, else `Install { hint }`.

- [ ] **Step 1: Write the failing test**

Add to the tests module (behavioral, tolerant — no hard-coded machine state):
```rust
#[test]
fn suggest_fix_returns_install_hint_for_unknown_runtime() {
    // A runtime we scan no locations for → always Install (never panics).
    let req = RuntimeReq {
        name: "totally-not-a-real-runtime".into(),
        min_version: "1".into(),
        version_arg: "--version".into(),
    };
    match suggest_fix(&req) {
        RuntimeSuggestion::Install { hint } => assert!(!hint.is_empty()),
        other => panic!("expected Install, got {other:?}"),
    }
}

#[test]
fn suggest_fix_never_panics_for_known_runtimes() {
    for name in ["java", "node", "dotnet"] {
        let req = RuntimeReq {
            name: name.into(),
            min_version: "999".into(), // nothing satisfies → forces Install or a real on-disk<999
            version_arg: "--version".into(),
        };
        let _ = suggest_fix(&req); // must not panic
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p karl-lsp suggest_fix`
Expected: compile error — `suggest_fix` not defined.

- [ ] **Step 3: Implement**

Add to `runtime.rs`:
```rust
use std::path::PathBuf;

/// Bin dirs to probe for a given runtime, macOS-curated. Each returned dir
/// is expected to contain an executable named `req.name`. ponytail: a
/// curated list, not a filesystem walk; extend per-OS as needed.
fn candidate_bin_dirs(name: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    match name {
        "java" => {
            // Homebrew openjdk / openjdk@NN → <keg>/bin
            dirs.extend(homebrew_opt_bins("openjdk"));
            // macOS java_home lists every registered JVM's Home dir.
            if let Ok(out) = std::process::Command::new("/usr/libexec/java_home")
                .arg("-V")
                .output()
            {
                let text = String::from_utf8_lossy(&out.stderr); // java_home -V prints to stderr
                for line in text.lines() {
                    if let Some(idx) = line.find('/') {
                        let p = PathBuf::from(line[idx..].trim());
                        if p.is_dir() {
                            dirs.push(p.join("bin"));
                        }
                    }
                }
            }
            if let Some(h) = &home {
                push_glob_children(&mut dirs, &h.join(".sdkman/candidates/java"), "bin");
            }
        }
        "node" => {
            dirs.extend(homebrew_opt_bins("node"));
            dirs.push(PathBuf::from("/usr/local/bin"));
            if let Some(h) = &home {
                push_glob_children(&mut dirs, &h.join(".nvm/versions/node"), "bin");
            }
        }
        "dotnet" => {
            // dotnet's dir holds the `dotnet` binary directly (no /bin).
            dirs.push(PathBuf::from("/usr/local/share/dotnet"));
            for d in homebrew_opt_bins("dotnet") {
                // homebrew_opt_bins appends /bin; dotnet keg exposes bin too.
                dirs.push(d);
            }
        }
        _ => {}
    }
    dirs
}

/// `/opt/homebrew/opt/<prefix>*/bin` for every keg whose name starts with prefix.
fn homebrew_opt_bins(prefix: &str) -> Vec<PathBuf> {
    let base = PathBuf::from("/opt/homebrew/opt");
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with(prefix) {
                out.push(e.path().join("bin"));
            }
        }
    }
    out
}

/// For each immediate child dir of `parent`, push `child/<sub>`.
fn push_glob_children(dirs: &mut Vec<PathBuf>, parent: &std::path::Path, sub: &str) {
    if let Ok(entries) = std::fs::read_dir(parent) {
        for e in entries.flatten() {
            if e.path().is_dir() {
                dirs.push(e.path().join(sub));
            }
        }
    }
}

fn install_hint(name: &str) -> String {
    match name {
        "java" => "brew install openjdk".into(),
        "node" => "brew install node".into(),
        "dotnet" => "brew install dotnet".into(),
        other => format!("install {other}"),
    }
}

/// The bin dirs currently on the login-shell PATH (what `detect` uses).
fn login_shell_path_dirs() -> Vec<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = std::process::Command::new(&shell)
        .args(["-lc", "echo $PATH"])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .trim()
            .split(':')
            .map(|s| s.to_string())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Called after `detect` reports RuntimeMissing. Scans curated locations
/// for a satisfying version; suggests a PATH fix if one exists off-PATH,
/// else an install hint. Never fails — always returns a usable suggestion.
pub fn suggest_fix(req: &RuntimeReq) -> RuntimeSuggestion {
    let mut candidates: Vec<(String, String)> = Vec::new();
    for dir in candidate_bin_dirs(&req.name) {
        let exe = dir.join(&req.name);
        if !exe.is_file() {
            continue;
        }
        if let Ok(out) = std::process::Command::new(&exe).arg(&req.version_arg).output() {
            let raw = String::from_utf8_lossy(&out.stdout);
            // node/dotnet print to stdout; java --version also stdout.
            let raw = if raw.trim().is_empty() {
                String::from_utf8_lossy(&out.stderr).into_owned()
            } else {
                raw.into_owned()
            };
            if let Some(v) = extract_version(&raw) {
                candidates.push((dir.to_string_lossy().into_owned(), v));
            }
        }
    }
    match pick_newest_satisfying(&candidates, &req.min_version) {
        Some((dir, version)) => {
            let on_path = login_shell_path_dirs().iter().any(|p| p == &dir);
            if on_path {
                // Already on PATH yet detect failed → the on-PATH one is the
                // old one and this dir is too; don't tell the user to add a
                // dir they have. Fall back to install hint.
                RuntimeSuggestion::Install { hint: install_hint(&req.name) }
            } else {
                RuntimeSuggestion::OnDiskNotOnPath { version, dir }
            }
        }
        None => RuntimeSuggestion::Install { hint: install_hint(&req.name) },
    }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cargo test -p karl-lsp suggest_fix`
Expected: 2 passed. Also `cargo test -p karl-lsp` — all green.

- [ ] **Step 5: Commit**

```bash
git add crates/lsp/src/runtime.rs
git commit -m "feat(lsp): suggest_fix scans curated runtime locations for an off-PATH fix"
```

---

### Task 3: Wire the suggestion through the status contract (Rust + api.ts)

**Files:**
- Modify: `crates/app/src/lsp_commands.rs`, `ui/src/api.ts`

**Interfaces:**
- Consumes: `runtime::{suggest_fix, RuntimeSuggestion}`.
- Produces: `RuntimeMissingInfo.suggestion: Option<RuntimeSuggestionDto>`; DTO serializes with `#[serde(tag = "kind", rename_all = "snake_case")]` to `{kind:"on_disk_not_on_path", version, dir}` | `{kind:"install", hint}`. api.ts `LspRuntimeMissing.suggestion?: RuntimeSuggestionDto`.

- [ ] **Step 1: Rust — add the DTO + populate it**

In `crates/app/src/lsp_commands.rs`, add near `RuntimeMissingInfo`:
```rust
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuntimeSuggestionDto {
    OnDiskNotOnPath { version: String, dir: String },
    Install { hint: String },
}

impl From<karl_lsp::runtime::RuntimeSuggestion> for RuntimeSuggestionDto {
    fn from(s: karl_lsp::runtime::RuntimeSuggestion) -> Self {
        match s {
            karl_lsp::runtime::RuntimeSuggestion::OnDiskNotOnPath { version, dir } => {
                RuntimeSuggestionDto::OnDiskNotOnPath { version, dir }
            }
            karl_lsp::runtime::RuntimeSuggestion::Install { hint } => {
                RuntimeSuggestionDto::Install { hint }
            }
        }
    }
}
```
Add the field to `RuntimeMissingInfo`:
```rust
pub struct RuntimeMissingInfo {
    pub name: String,
    pub min: String,
    pub found: Option<String>,
    pub suggestion: Option<RuntimeSuggestionDto>,
}
```
Where `RuntimeMissingInfo { name, min, found }` is built (in `lsp_server_status`, the `if let Err(e) = runtime::detect(...)` branch ~L307-317), compute the suggestion from the SAME `RuntimeReq` the detect used and attach it:
```rust
let suggestion = Some(runtime::suggest_fix(&rt.as_runtime_req()).into());
runtime_missing = Some(RuntimeMissingInfo { name, min, found, suggestion });
```
(Use the same `rt` / RuntimeReq already in scope in that branch — READ the exact variable names around L307 and match them; if `name`/`min`/`found` are extracted from the `LspError::RuntimeMissing`, build the req from the spec's `rt` that was passed to `detect`.)

- [ ] **Step 2: `cargo check -p covenant`**

Run: `cargo check -p covenant`
Expected: clean.

- [ ] **Step 3: api.ts — thread the DTO**

In `ui/src/api.ts`, extend `LspRuntimeMissing` (~L3062):
```ts
export type LspRuntimeSuggestion =
  | { kind: "on_disk_not_on_path"; version: string; dir: string }
  | { kind: "install"; hint: string };

export interface LspRuntimeMissing {
  name: string;
  min: string;
  found: string | null;
  suggestion: LspRuntimeSuggestion | null;
}
```
Update the raw shape + normalization (~L3100-3109):
```ts
    runtime_missing?: {
      name: string;
      min: string;
      found?: string | null;
      suggestion?: LspRuntimeSuggestion | null;
    } | null;
```
```ts
    runtimeMissing: raw.runtime_missing
      ? {
          name: raw.runtime_missing.name,
          min: raw.runtime_missing.min,
          found: raw.runtime_missing.found ?? null,
          suggestion: raw.runtime_missing.suggestion ?? null,
        }
      : null,
```
(The DTO's snake_case tag values match the Rust `rename_all = "snake_case"` output; the union tag lives in `kind`.)

- [ ] **Step 4: `npm run build`**

Run: `npm run build`
Expected: clean type-check.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/lsp_commands.rs ui/src/api.ts
git commit -m "feat(lsp): thread RuntimeSuggestion through lsp_server_status + api.ts"
```

---

### Task 4: Frontend — manager threads suggestion + pure banner-line builder

**Files:**
- Modify: `ui/src/lsp/manager.ts`
- Create: `ui/src/lsp/runtime-hint.ts`, `ui/src/lsp/runtime-hint.test.ts`

**Interfaces:**
- Consumes: `LspRuntimeSuggestion` (api.ts).
- Produces: `ui/src/lsp/runtime-hint.ts` `export function runtimeSuggestionLine(s: LspRuntimeSuggestion | null): { text: string; command: string | null }` (pure); `manager.ts` `LspDocStatus` needs-runtime gains `suggestion: LspRuntimeSuggestion | null`.

- [ ] **Step 1: Write the failing test**

`ui/src/lsp/runtime-hint.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { runtimeSuggestionLine } from "./runtime-hint";

describe("runtimeSuggestionLine", () => {
  it("on-disk-not-on-path yields a diagnosis + export command", () => {
    const r = runtimeSuggestionLine({
      kind: "on_disk_not_on_path",
      version: "26.0.1",
      dir: "/opt/homebrew/opt/openjdk/bin",
    });
    expect(r.text).toContain("26.0.1");
    expect(r.text).toContain("/opt/homebrew/opt/openjdk/bin");
    expect(r.command).toBe('export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"');
  });

  it("install yields the hint as the command", () => {
    const r = runtimeSuggestionLine({ kind: "install", hint: "brew install openjdk" });
    expect(r.text.toLowerCase()).toContain("install");
    expect(r.command).toBe("brew install openjdk");
  });

  it("null yields no command", () => {
    expect(runtimeSuggestionLine(null)).toEqual({ text: "", command: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- lsp/runtime-hint`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

`ui/src/lsp/runtime-hint.ts`:
```ts
import type { LspRuntimeSuggestion } from "../api";

/// Turns a backend runtime suggestion into a human line + an optional
/// copyable command for the needs-runtime banner. Pure; the DOM/Copy
/// wiring lives in the editor.
export function runtimeSuggestionLine(
  s: LspRuntimeSuggestion | null,
): { text: string; command: string | null } {
  if (!s) return { text: "", command: null };
  if (s.kind === "on_disk_not_on_path") {
    return {
      text: `You have version ${s.version} at ${s.dir}, but it isn't on your shell's PATH. Add it to ~/.zprofile, then Recheck:`,
      command: `export PATH="${s.dir}:$PATH"`,
    };
  }
  // install
  return { text: "Install a supported version, then Recheck:", command: s.hint };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npm test -- lsp/runtime-hint`
Expected: 3 passed.

- [ ] **Step 5: manager threads the suggestion**

In `ui/src/lsp/manager.ts`, extend the `needs-runtime` variant of `LspDocStatus` (~L30):
```ts
  | { kind: "needs-runtime"; name: string; min: string; found: string | null; suggestion: import("../api").LspRuntimeSuggestion | null }
```
And where it's built from `st.runtimeMissing` (~L294):
```ts
        return {
          kind: "needs-runtime",
          name: st.runtimeMissing.name,
          min: st.runtimeMissing.min,
          found: st.runtimeMissing.found ?? null,
          suggestion: st.runtimeMissing.suggestion ?? null,
        };
```

- [ ] **Step 6: `npm run build` + commit**

Run: `npm run build`
Expected: clean.
```bash
git add ui/src/lsp/runtime-hint.ts ui/src/lsp/runtime-hint.test.ts ui/src/lsp/manager.ts
git commit -m "feat(lsp): pure runtimeSuggestionLine + thread suggestion into needs-runtime status"
```

---

### Task 5: Editor — enriched banner with the actionable line + Copy button

**Files:**
- Modify: `ui/src/structure/editor.ts` (needs-runtime banner ~L1125), `ui/src/styles.css`

**Interfaces:**
- Consumes: `runtimeSuggestionLine`, `LspDocStatus` needs-runtime `.suggestion`, the existing `copyToClipboard` util (grep its definition — used in `ui/src/blocks/manager.ts`; import from the same module).

- [ ] **Step 1: Wire the second line into the banner**

In `editor.ts`, add the import (match the real path found by grepping `export function copyToClipboard` or the import in `ui/src/blocks/manager.ts`):
```ts
import { runtimeSuggestionLine } from "../lsp/runtime-hint";
import { copyToClipboard } from "../<path-to-clipboard-util>";
```
Replace the `needs-runtime` case body's tail (after building `label`, before/around `banner.append(label, recheck)`) so it becomes:
```ts
      case "needs-runtime": {
        chip.hidden = true;
        banner.hidden = false;
        banner.replaceChildren();
        const runtimeName = status.name.charAt(0).toUpperCase() + status.name.slice(1);
        const label = document.createElement("span");
        label.textContent =
          `Code intelligence needs ${runtimeName} ≥ ${status.min}` +
          (status.found ? ` (found ${status.found})` : " — not found in your shell PATH") +
          ".";
        banner.append(label);

        const hint = runtimeSuggestionLine(status.suggestion);
        if (hint.command) {
          const guide = document.createElement("span");
          guide.className = "structure-editor-lsp-banner-guide";
          guide.textContent = hint.text;
          const code = document.createElement("code");
          code.className = "structure-editor-lsp-banner-cmd";
          code.textContent = hint.command;
          const copy = document.createElement("button");
          copy.type = "button";
          copy.textContent = "Copy";
          copy.addEventListener("click", () => {
            void copyToClipboard(hint.command as string);
            copy.textContent = "Copied";
            setTimeout(() => (copy.textContent = "Copy"), 1500);
          });
          banner.append(guide, code, copy);
        }

        const recheck = document.createElement("button");
        recheck.type = "button";
        recheck.textContent = "Recheck";
        recheck.addEventListener("click", () => {
          const path = this.currentPath;
          if (path) void this.setupLsp(path);
        });
        banner.append(recheck);
        break;
      }
```
(If `copyToClipboard` returns void rather than a Promise, drop the `void`. Verify its signature.)

- [ ] **Step 2: Styles**

Append to `ui/src/styles.css` next to the other `.structure-editor-lsp-banner*` rules (reuse the neighboring `var(--...)` tokens; sharp corners):
```css
.structure-editor-lsp-banner-guide {
  opacity: 0.85;
}
.structure-editor-lsp-banner-cmd {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  padding: 1px 6px;
  border: 1px solid var(--border, #333);
  border-radius: 0;
  user-select: all;
  white-space: nowrap;
  overflow-x: auto;
  max-width: 60ch;
}
```

- [ ] **Step 3: Build + full check**

Run: `npm run build && npm test 2>&1 | tail -5`
Expected: clean build; no NEW test failures vs baseline (main has ~6 pre-existing failing files — compare, don't count).

- [ ] **Step 4: Commit**

```bash
git add ui/src/structure/editor.ts ui/src/styles.css
git commit -m "feat(lsp): actionable needs-runtime banner with copyable fix command"
```

- [ ] **Step 5: Manual verify (the exact repro)**

With `java` 17 on the login PATH and openjdk ≥21 installed (e.g. `/opt/homebrew/opt/openjdk`), open a `.java` file → the banner shows "Code intelligence needs Java ≥ 21 (found 17.0.18)." + "You have version 26.0.1 at /opt/homebrew/opt/openjdk/bin, but it isn't on your shell's PATH… " + a copyable `export PATH="…:$PATH"` + Copy + Recheck. Run the command in a shell, add to `~/.zprofile`, click Recheck → banner advances to the consent/download flow. Also confirm a `.rs`/`.ts` file (runtime present) is unaffected.

---

## Self-review notes
- **Spec coverage:** suggest_fix scan + pick_newest (T1-T2) ✓; OnDiskNotOnPath/Install shapes ✓; DTO threaded through status + api.ts (T3) ✓; pure banner-line builder + manager thread (T4) ✓; enriched banner + Copy, no dotfile writes (T5) ✓; per-runtime install hints ✓; curated locations w/ ponytail ✓; ~/.zprofile target ✓.
- **Type consistency:** `RuntimeSuggestion` (lsp) → `RuntimeSuggestionDto` (app, serde snake_case tag) → `LspRuntimeSuggestion` (api.ts union on `kind`) → `runtimeSuggestionLine` — tags `on_disk_not_on_path`/`install` consistent end to end.
- **Known implementer notes:** exact insertion points in lsp_commands.rs (~L307) + api.ts (~L3062/3100) drift — anchor on `RuntimeMissingInfo`/`runtime_missing`, not line numbers. Confirm the `RuntimeReq`/`rt` variable in scope at the detect-failure branch before building the suggestion. Verify `copyToClipboard`'s import path + signature.
