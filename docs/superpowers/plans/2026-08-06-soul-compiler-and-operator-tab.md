# Soul Compiler + Operator Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a soul compile to harness configuration, and make an ACP tab an operator that works in a PTY you can see.

**Architecture:** A new `crates/app/src/soul_compile.rs` turns a parsed `Soul` into `{settings.json, CLAUDE.md}` (pure function, golden-file tested). `prepare_claude_acp_config` gains an optional compiled soul: with one, it materializes a **per-operator** config dir (`souls/<operator-id>/`) instead of the shared `claude-acp/` dir, and the ACP child gets it via the `CLAUDE_CONFIG_DIR` env var that is already wired. A new `run_in_pty` MCP tool lets the operator execute in the tab's own PTY, gated on ownership. The ACP tab gains a second **terminal face** backed by an ordinary PTY pane.

**Tech Stack:** Rust (`serde`, `serde_yaml`, `serde_json`, `thiserror`), Tauri 2 commands, TypeScript + Vitest, `@zed-industries/claude-agent-acp` (the ACP adapter for `claude`).

## Global Constraints

- **Nothing is written into the user's repository.** All compiled artifacts live under `app_config_dir()/souls/<operator-id>/`. Verbatim requirement from the spec.
- **The `claude` ACP adapter accepts no CLI flags** — `AcpSpawnOpts::for_executor("claude", …)` sets `agent_args: Some(Vec::new())` (`crates/agent/src/acp/session.rs:110-130`). Configuration reaches it **only** through `CLAUDE_CONFIG_DIR`. Do not add argv flags.
- **No `unwrap()` outside `#[cfg(test)]` and `main()`** (AGENTS.md § Coding Conventions).
- **Errors:** `thiserror` inside library crates, `anyhow` only at the `app` binary boundary.
- **Every new MCP tool must be classified** in `READ_TOOLS` or `WRITE_TOOLS` (`crates/app/src/mcp_server.rs:711-721`) — the `every_tool_is_classified` test fails otherwise.
- **Atomic writes:** every generated file is written to `<name>.tmp` then `std::fs::rename`d, matching `prepare_claude_acp_config` (`crates/app/src/acp_commands.rs:959-963`).
- **Config dirs are `0o700` on unix**, same as `crates/app/src/acp_commands.rs:919-923`.
- Rust tests: `cargo test -p covenant <name>`. TS tests: `npm test -- <file>` **from the repo root**, never from `ui/`.
- Conventional Commits, one task per commit.

---

## File Structure

| File | Responsibility |
|---|---|
| **Create** `crates/app/src/soul_compile.rs` | Pure compile: `Soul` → `CompiledSoul { settings, claude_md, warnings }`. Plus `deny_rule_from_constraint`. No I/O. |
| **Modify** `crates/app/src/soul.rs` | Add `SoulReflexes` + the `reflexes` and `pty` frontmatter fields. |
| **Modify** `crates/app/src/acp_commands.rs` | `prepare_claude_acp_config` takes `Option<&CompiledSoul>`; `SpawnAcpOpts` gains `operator_id`. |
| **Modify** `crates/app/src/mcp_server.rs` | New `run_in_pty` tool + `WRITE_TOOLS` entry. |
| **Modify** `crates/app/src/lib.rs` | `mod soul_compile;` |
| **Modify** `ui/src/api.ts` | `spawnAcpSession` carries `operatorId`. |
| **Modify** `ui/src/tabs/manager.ts` | `createAcpTab` accepts `operatorId`; terminal face; "Invoke operator" menu. |
| **Create** `ui/src/tabs/operator-face.ts` | Pure face-state helper (which face is visible, what the toggle does). Unit-testable without the DOM. |
| **Create** `ui/src/tabs/operator-face.test.ts` | Tests for the above. |

---

## Task 1: Structured reflexes in the soul frontmatter

Prose reflexes cannot compile to permissions deterministically. Reflexes that are *meant* to compile get written in the harness's own rule language, in their own frontmatter block. The Origin-Letter body keeps the prose — it becomes `CLAUDE.md`.

**Files:**
- Modify: `crates/app/src/soul.rs:10-32` (add fields), `crates/app/src/soul.rs:156-254` (tests)

**Interfaces:**
- Consumes: nothing
- Produces: `soul::SoulReflexes { allow: Vec<String>, ask: Vec<String> }`; `SoulFrontmatter::reflexes: Option<SoulReflexes>`; `SoulFrontmatter::pty: Option<String>`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `crates/app/src/soul.rs`:

```rust
    const SAMPLE_REFLEXES: &str = "---\nname: The Guardian\nreflexes:\n  allow:\n  - Bash(cargo test:*)\n  - Read\n  ask:\n  - Bash(git push:*)\npty: visible\nhard_constraints: |\n  ^git push --force\n  ^rm -rf\n---\n\n# The Guardian\n\nI do not move fast.\n";

    #[test]
    fn parses_structured_reflexes_and_pty_mode() {
        let s = parse(SAMPLE_REFLEXES).expect("parse");
        let r = s.frontmatter.reflexes.expect("reflexes present");
        assert_eq!(r.allow, vec!["Bash(cargo test:*)".to_string(), "Read".to_string()]);
        assert_eq!(r.ask, vec!["Bash(git push:*)".to_string()]);
        assert_eq!(s.frontmatter.pty.as_deref(), Some("visible"));
    }

    #[test]
    fn reflexes_absent_is_none_not_error() {
        let s = parse(SAMPLE).expect("parse");
        assert!(s.frontmatter.reflexes.is_none());
        assert!(s.frontmatter.pty.is_none());
    }

    #[test]
    fn reflexes_round_trip() {
        let s = parse(SAMPLE_REFLEXES).expect("parse");
        let s2 = parse(&serialize(&s)).expect("reparse");
        assert_eq!(s, s2);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cargo test -p covenant soul::tests -- --nocapture
```

Expected: FAIL — `no field `reflexes` on type `SoulFrontmatter`` (compile error).

- [ ] **Step 3: Add the fields**

In `crates/app/src/soul.rs`, above `SoulFrontmatter`:

```rust
/// Reflexes that compile. Written in the harness's own permission-rule
/// language (`Bash(cargo test:*)`, `Read`, `mcp__covenant__run_in_pty`)
/// because that is exactly what they compile to — translating from a
/// second notation would only add a lossy layer. Prose reflexes stay in
/// the Origin-Letter body, which compiles to CLAUDE.md.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SoulReflexes {
    /// ALWAYS-YES — decisions the principal already made. → `permissions.allow`
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<String>,
    /// ESCALATE — comes back to the principal. → `permissions.ask`, which
    /// makes the adapter emit `session/request_permission`; Covenant already
    /// parks those and surfaces them (see `PermissionDecision::Defer`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ask: Vec<String>,
}
```

Then inside `SoulFrontmatter`, after `hard_constraints`:

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reflexes: Option<SoulReflexes>,
    /// `"visible"` (default) — the harness works through the tab's PTY:
    /// `deny: ["Bash"]` + `allow: ["mcp__covenant__run_in_pty"]`, so every
    /// command it runs is on screen. `"private"` — the harness keeps its own
    /// bash and the terminal face is just a terminal of yours.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty: Option<String>,
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cargo test -p covenant soul::tests
```

Expected: PASS, including the pre-existing `round_trips`, `parses_frontmatter_and_body`, and `soul_from_operator_round_trips_identity`.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/soul.rs
git commit -m "feat(soul): structured reflexes and pty mode in the frontmatter"
```

---

## Task 2: The compiler — `Soul` → `{settings.json, CLAUDE.md}`

Pure, no I/O, golden-file tested. This is the task whose output you review by eye before anything touches a live session.

**Files:**
- Create: `crates/app/src/soul_compile.rs`
- Modify: `crates/app/src/lib.rs` (add `mod soul_compile;` beside the other `mod` declarations)

**Interfaces:**
- Consumes: `soul::{Soul, SoulFrontmatter, SoulReflexes}` from Task 1
- Produces:
  - `pub struct CompiledSoul { pub settings: serde_json::Value, pub claude_md: String, pub warnings: Vec<String> }`
  - `pub fn compile(soul: &Soul) -> CompiledSoul`
  - `pub fn deny_rule_from_constraint(line: &str) -> Result<String, String>`

- [ ] **Step 1: Write the failing test**

Create `crates/app/src/soul_compile.rs` containing **only** the test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const GUARDIAN: &str = "---\nname: The Guardian\nvoice: terse\nreflexes:\n  allow:\n  - Bash(cargo test:*)\n  ask:\n  - Bash(git push:*)\nhard_constraints: |\n  ^git push --force\n  ^rm -rf\n---\n\n# The Guardian\n\nI do not move fast. I move so that nothing you'd regret gets through.\n";

    fn guardian() -> crate::soul::Soul {
        crate::soul::parse(GUARDIAN).expect("parse")
    }

    #[test]
    fn literal_prefix_constraint_compiles_to_a_bash_deny_rule() {
        assert_eq!(
            deny_rule_from_constraint("^git push --force").unwrap(),
            "Bash(git push --force:*)"
        );
        assert_eq!(deny_rule_from_constraint("^rm -rf").unwrap(), "Bash(rm -rf:*)");
    }

    #[test]
    fn unanchored_or_metacharacter_constraint_is_refused_not_approximated() {
        assert!(deny_rule_from_constraint("rm -rf").is_err());
        assert!(deny_rule_from_constraint("^git (push|reset)").is_err());
        assert!(deny_rule_from_constraint("^curl .* | sh").is_err());
        assert!(deny_rule_from_constraint("").is_err());
    }

    #[test]
    fn visible_pty_is_the_default_and_denies_bash() {
        let c = compile(&guardian());
        let perms = &c.settings["permissions"];
        let deny: Vec<&str> = perms["deny"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        let allow: Vec<&str> = perms["allow"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(deny.contains(&"Bash"), "visible pty must deny the harness's own bash");
        assert!(allow.contains(&"mcp__covenant__run_in_pty"));
    }

    #[test]
    fn private_pty_keeps_the_harness_bash() {
        let mut s = guardian();
        s.frontmatter.pty = Some("private".into());
        let c = compile(&s);
        let deny: Vec<&str> = c.settings["permissions"]["deny"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        let allow: Vec<&str> = c.settings["permissions"]["allow"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(!deny.contains(&"Bash"));
        assert!(!allow.contains(&"mcp__covenant__run_in_pty"));
    }

    #[test]
    fn reflexes_land_in_allow_and_ask() {
        let c = compile(&guardian());
        let allow: Vec<&str> = c.settings["permissions"]["allow"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        let ask: Vec<&str> = c.settings["permissions"]["ask"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(allow.contains(&"Bash(cargo test:*)"));
        assert_eq!(ask, vec!["Bash(git push:*)"]);
    }

    #[test]
    fn hard_constraints_land_in_deny() {
        let c = compile(&guardian());
        let deny: Vec<&str> = c.settings["permissions"]["deny"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(deny.contains(&"Bash(git push --force:*)"));
        assert!(deny.contains(&"Bash(rm -rf:*)"));
        assert!(c.warnings.is_empty());
    }

    #[test]
    fn uncompilable_constraint_warns_and_denies_bash_wholesale() {
        let mut s = guardian();
        s.frontmatter.hard_constraints = Some("^git (push|reset)\n".into());
        let c = compile(&s);
        assert_eq!(c.warnings.len(), 1);
        assert!(c.warnings[0].contains("^git (push|reset)"));
        let deny: Vec<&str> = c.settings["permissions"]["deny"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(deny.contains(&"Bash"), "a constraint we cannot express must fail safe");
    }

    #[test]
    fn default_mode_is_never_bypass() {
        let c = compile(&guardian());
        assert_eq!(c.settings["permissions"]["defaultMode"], "default");
    }

    #[test]
    fn claude_md_carries_the_name_the_body_and_the_pty_discipline() {
        let c = compile(&guardian());
        assert!(c.claude_md.contains("The Guardian"));
        assert!(c.claude_md.contains("I do not move fast."));
        assert!(c.claude_md.contains("run_in_pty"));
        assert!(c.claude_md.contains("terse"));
    }

    #[test]
    fn compiling_every_shipped_soul_produces_no_warnings() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../operator-souls");
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).expect("operator-souls dir") {
            let p = entry.expect("entry").path();
            if p.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let raw = std::fs::read_to_string(&p).expect("read soul");
            let soul = crate::soul::parse(&raw).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
            let c = compile(&soul);
            assert!(c.warnings.is_empty(), "{}: {:?}", p.display(), c.warnings);
            assert!(!c.claude_md.trim().is_empty(), "{}: empty CLAUDE.md", p.display());
            checked += 1;
        }
        assert!(checked >= 5, "expected the five shipped souls, saw {checked}");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cargo test -p covenant soul_compile
```

Expected: FAIL — `cannot find function `compile` in this scope` (the module has no implementation yet). If it instead reports `unresolved module`, add `mod soul_compile;` to `crates/app/src/lib.rs` first.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/app/src/soul_compile.rs`, above the test module:

```rust
//! Compile a SOUL.md into harness configuration. The soul stops being
//! interpreted by a mind of ours and becomes the harness's own settings:
//! ALWAYS-YES → `permissions.allow`, ESCALATE → `permissions.ask` (which
//! the adapter turns into `session/request_permission`, a path Covenant
//! already parks and surfaces to the principal), NEVER →
//! `permissions.deny`. A decision then lives in a file instead of in a
//! token: cheaper, instant, and auditable.
//!
//! Pure — no I/O. `soul_config` does the writing.

use serde_json::{json, Value};

use crate::soul::Soul;

/// Characters a `hard_constraints` line may contain after the `^` anchor to
/// still be a literal command prefix. Anything else is a regex feature with
/// no equivalent in the harness's rule language.
fn is_literal_prefix_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || " _-./=:".contains(c)
}

/// A `hard_constraints` line compiles to a deny rule only when it is a
/// `^`-anchored literal command prefix — the shape every shipped soul uses
/// (`^git push --force`, `^rm -rf`). We refuse rather than approximate: a
/// regex silently mistranslated into a permission rule is a safety rule that
/// does not fire.
pub fn deny_rule_from_constraint(line: &str) -> Result<String, String> {
    let t = line.trim();
    let body = t
        .strip_prefix('^')
        .ok_or_else(|| format!("not `^`-anchored: {t}"))?
        .trim();
    if body.is_empty() {
        return Err(format!("empty constraint: {t}"));
    }
    if !body.chars().all(is_literal_prefix_char) {
        return Err(format!("not a literal command prefix: {t}"));
    }
    Ok(format!("Bash({body}:*)"))
}

pub struct CompiledSoul {
    /// `settings.json` for the operator's `CLAUDE_CONFIG_DIR`.
    pub settings: Value,
    /// `CLAUDE.md` for the same dir — user-level memory for this operator.
    pub claude_md: String,
    /// `hard_constraints` lines that could not be expressed as rules. The
    /// operator still boots; `deny: ["Bash"]` covers the gap.
    pub warnings: Vec<String>,
}

/// `true` unless the soul explicitly opted out with `pty: private`.
fn pty_visible(soul: &Soul) -> bool {
    !matches!(
        soul.frontmatter
            .pty
            .as_deref()
            .map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("private")
    )
}

pub fn compile(soul: &Soul) -> CompiledSoul {
    let fm = &soul.frontmatter;
    let visible = pty_visible(soul);

    let mut allow: Vec<String> = Vec::new();
    let mut ask: Vec<String> = Vec::new();
    let mut deny: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    if let Some(r) = &fm.reflexes {
        allow.extend(r.allow.iter().cloned());
        ask.extend(r.ask.iter().cloned());
    }

    for line in fm
        .hard_constraints
        .as_deref()
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.trim().is_empty())
    {
        match deny_rule_from_constraint(line) {
            Ok(rule) => deny.push(rule),
            Err(why) => warnings.push(why),
        }
    }

    // Visible PTY: the harness loses its own bash and works through ours, so
    // every command it runs is on screen. A constraint we could not compile
    // gets the same treatment — failing safe means denying the tool the
    // constraint was about.
    if visible || !warnings.is_empty() {
        deny.push("Bash".to_string());
    }
    if visible {
        allow.push("mcp__covenant__run_in_pty".to_string());
    }

    allow.sort();
    allow.dedup();
    ask.sort();
    ask.dedup();
    deny.sort();
    deny.dedup();

    let settings = json!({
        "permissions": {
            // Never bypassPermissions: the reflexes ARE the permission
            // model, and bypass would make them dead text.
            "defaultMode": "default",
            "allow": allow,
            "ask": ask,
            "deny": deny,
        }
    });

    let mut md = String::new();
    md.push_str(&format!("# {}\n\n", fm.name.trim()));
    md.push_str(
        "You are a version of the principal, put in charge of a domain he cannot \
         personally attend to. You are not a bot with a permission table — when you \
         decide, you decide with a piece of his criterion. The reflexes below are \
         decisions he already made; they are enforced by your settings, not by your \
         goodwill.\n\n",
    );
    md.push_str(&format!(
        "Voice: {}.\n\n",
        fm.voice.as_deref().unwrap_or("terse")
    ));
    if visible {
        md.push_str(
            "## Your terminal\n\nYou have no Bash tool. Run commands through \
             `mcp__covenant__run_in_pty`, which executes in the PTY of your own tab — \
             the principal watches it and can take the keyboard at any time. This is \
             not a restriction to work around; being visible is the job.\n\n",
        );
    }
    md.push_str("## Origin letter\n\n");
    md.push_str(soul.body.trim());
    md.push('\n');

    CompiledSoul {
        settings,
        claude_md: md,
        warnings,
    }
}
```

Then add to `crates/app/src/lib.rs`, in alphabetical position among the `mod` declarations:

```rust
mod soul_compile;
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cargo test -p covenant soul_compile
```

Expected: PASS, 10 tests. `compiling_every_shipped_soul_produces_no_warnings` is the golden check — it proves the five real souls in `operator-souls/` compile clean.

- [ ] **Step 5: Eyeball the compiled output**

```bash
cargo test -p covenant soul_compile -- --nocapture
cargo clippy -p covenant --all-targets 2>&1 | tail -20
```

Expected: clippy clean for the new file.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/soul_compile.rs crates/app/src/lib.rs
git commit -m "feat(soul): compile a soul into harness settings and CLAUDE.md"
```

---

## Task 3: Materialize a per-operator config dir

`prepare_claude_acp_config` already builds an isolated `CLAUDE_CONFIG_DIR`, writes `settings.json` atomically, sets `0o700`, and symlinks the user's `skills`/`commands`/`agents` back in. Give it a soul instead of writing a second copy of all that.

**Files:**
- Modify: `crates/app/src/acp_commands.rs:903-978` (signature + dir choice + settings merge + `CLAUDE.md`)
- Test: `crates/app/tests/soul_config.rs` (create)

**Interfaces:**
- Consumes: `soul_compile::{compile, CompiledSoul}` from Task 2
- Produces: `prepare_claude_acp_config(base: &Path, cfg: &AcpExecutorConfig, soul: Option<(&str, &CompiledSoul)>) -> Result<(PathBuf, Option<String>), String>` — the `&str` is the operator id, used as the dir name. `None` keeps today's shared `claude-acp/` behaviour byte for byte.

- [ ] **Step 1: Write the failing test**

Create `crates/app/tests/soul_config.rs`:

```rust
//! The compiled soul must land in a per-operator dir and never in the
//! shared one, and must not clobber keys the user hand-added.

use std::path::Path;

fn read_json(p: &Path) -> serde_json::Value {
    let s = std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    serde_json::from_str(&s).expect("valid json")
}

#[test]
fn a_soul_gets_its_own_dir_with_settings_and_claude_md() {
    let tmp = tempfile::tempdir().expect("tmpdir");
    let raw = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../operator-souls/guardian.md"),
    )
    .expect("guardian.md");
    let soul = covenant::soul::parse(&raw).expect("parse");
    let compiled = covenant::soul_compile::compile(&soul);
    let cfg = covenant::settings::AcpExecutorConfig::default();

    let (dir, _tok) =
        covenant::acp_commands::prepare_claude_acp_config(tmp.path(), &cfg, Some(("op-123", &compiled)))
            .expect("prepare");

    assert!(dir.ends_with("souls/op-123"), "got {}", dir.display());
    assert!(!tmp.path().join("claude-acp").exists(), "must not touch the shared dir");

    let settings = read_json(&dir.join("settings.json"));
    let deny: Vec<&str> = settings["permissions"]["deny"]
        .as_array()
        .expect("deny array")
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(deny.contains(&"Bash"));
    assert!(deny.contains(&"Bash(rm -rf:*)"));

    let md = std::fs::read_to_string(dir.join("CLAUDE.md")).expect("CLAUDE.md");
    assert!(md.contains("The Guardian"));
    assert!(md.contains("run_in_pty"));
}

#[test]
fn user_added_settings_keys_survive_recompilation() {
    let tmp = tempfile::tempdir().expect("tmpdir");
    let dir = tmp.path().join("souls/op-9");
    std::fs::create_dir_all(&dir).expect("mkdir");
    std::fs::write(
        dir.join("settings.json"),
        r#"{"env":{"MY_VAR":"1"},"permissions":{"allow":["Read"]}}"#,
    )
    .expect("seed");

    let soul = covenant::soul::parse("---\nname: X\n---\n\nbody\n").expect("parse");
    let compiled = covenant::soul_compile::compile(&soul);
    let cfg = covenant::settings::AcpExecutorConfig::default();
    covenant::acp_commands::prepare_claude_acp_config(tmp.path(), &cfg, Some(("op-9", &compiled)))
        .expect("prepare");

    let settings = read_json(&dir.join("settings.json"));
    assert_eq!(settings["env"]["MY_VAR"], "1", "hand-added keys must survive");
    // permissions are DERIVED — the compiled set replaces the previous one
    // wholesale rather than accumulating stale rules.
    let allow: Vec<&str> = settings["permissions"]["allow"]
        .as_array()
        .expect("allow")
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(!allow.contains(&"Read"), "stale compiled rules must not accumulate");
}

#[test]
fn no_soul_keeps_the_shared_dir() {
    let tmp = tempfile::tempdir().expect("tmpdir");
    let cfg = covenant::settings::AcpExecutorConfig::default();
    let (dir, _tok) =
        covenant::acp_commands::prepare_claude_acp_config(tmp.path(), &cfg, None).expect("prepare");
    assert!(dir.ends_with("claude-acp"), "got {}", dir.display());
    assert!(!dir.join("CLAUDE.md").exists(), "the soulless path writes no CLAUDE.md");
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cargo test -p covenant --test soul_config
```

Expected: FAIL — `this function takes 2 arguments but 3 arguments were supplied`. If it fails on `tempfile` instead, add it: `cargo add --dev tempfile -p covenant`. If `covenant::soul_compile` or `covenant::acp_commands` is private, change those `mod` lines in `crates/app/src/lib.rs` to `pub mod`, and make `prepare_claude_acp_config` `pub`.

- [ ] **Step 3: Change the signature and the dir choice**

In `crates/app/src/acp_commands.rs`, replace the signature and the dir/settings section (lines 903-963) with:

```rust
pub fn prepare_claude_acp_config(
    base: &std::path::Path,
    cfg: &crate::settings::AcpExecutorConfig,
    soul: Option<(&str, &crate::soul_compile::CompiledSoul)>,
) -> Result<(PathBuf, Option<String>), String> {
    // The soulless dir is SHARED by every claude tab (one path, no session
    // id) and settings.json below is a read-modify-write — two tabs spawning
    // close together could interleave and boot the adapter against the wrong
    // defaultMode (worst case: an unintended bypassPermissions). Serialize
    // the whole prepare. This only guards writers in THIS process — which is
    // sufficient, Covenant is the only writer. std Mutex is fine: sync fn
    // inside spawn_blocking, no awaits to hold it across.
    //
    // A soul gets its own dir, so the interleave is gone there, but the lock
    // still covers it: one lock is cheaper than reasoning about two.
    static PREP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = PREP_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    let dir = match soul {
        Some((operator_id, _)) => base.join("souls").join(operator_id),
        None => base.join("claude-acp"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("claude-acp config dir: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }

    // settings.json: `permissions` and `model` are DERIVED on every spawn —
    // with a soul, `permissions` is replaced wholesale by the compiled set so
    // a reflex the principal deleted cannot survive in the file. Every other
    // key the user hand-adds is preserved verbatim.
    let settings = dir.join("settings.json");
    let mut root: Value = std::fs::read_to_string(&settings)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| json!({}));
    if !root.is_object() {
        root = json!({});
    }
    if let Some(obj) = root.as_object_mut() {
        match soul {
            Some((_, compiled)) => {
                obj.insert("permissions".into(), compiled.settings["permissions"].clone());
            }
            None => {
                let mode = match cfg.trust {
                    AcpTrust::Yolo => "bypassPermissions",
                    _ => "default",
                };
                let perms = obj.entry("permissions").or_insert_with(|| json!({}));
                if !perms.is_object() {
                    *perms = json!({});
                }
                if let Some(p) = perms.as_object_mut() {
                    p.insert("defaultMode".into(), json!(mode));
                }
            }
        }
        match &cfg.model {
            Some(m) => {
                obj.insert("model".into(), json!(m));
            }
            None => {
                obj.remove("model");
            }
        }
    }
    let rendered =
        serde_json::to_string_pretty(&root).map_err(|e| format!("settings.json: {e}"))?;
    // Atomic replace (tmp + rename, same pattern as settings::save) so a
    // reader — the adapter booting — never sees a half-written file.
    let tmp = dir.join("settings.json.tmp");
    std::fs::write(&tmp, rendered).map_err(|e| format!("settings.json: {e}"))?;
    std::fs::rename(&tmp, &settings).map_err(|e| format!("settings.json: {e}"))?;

    // CLAUDE.md is user-level memory for this operator: with CLAUDE_CONFIG_DIR
    // pointed here, this is the file the harness reads as its own identity.
    // Soul-owned and fully derived, so it is replaced, not merged.
    if let Some((_, compiled)) = soul {
        let md = dir.join("CLAUDE.md");
        let md_tmp = dir.join("CLAUDE.md.tmp");
        std::fs::write(&md_tmp, &compiled.claude_md).map_err(|e| format!("CLAUDE.md: {e}"))?;
        std::fs::rename(&md_tmp, &md).map_err(|e| format!("CLAUDE.md: {e}"))?;
    }
```

Leave everything from the `// The isolated config dir hides the user's real ~/.claude` symlink block onward exactly as it is — the symlinks and the OAuth-token tail apply to both paths unchanged.

- [ ] **Step 4: Fix the one existing call site**

At `crates/app/src/acp_commands.rs:1134`, change:

```rust
            tokio::task::spawn_blocking(move || prepare_claude_acp_config(&base, &cfg_for_prep))
```

to:

```rust
            tokio::task::spawn_blocking(move || prepare_claude_acp_config(&base, &cfg_for_prep, None))
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cargo test -p covenant --test soul_config && cargo test -p covenant
```

Expected: the three new tests PASS and the existing suite stays green — `no_soul_keeps_the_shared_dir` is what proves the soulless path did not change.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/acp_commands.rs crates/app/tests/soul_config.rs crates/app/Cargo.toml
git commit -m "feat(soul): materialize a compiled soul into a per-operator CLAUDE_CONFIG_DIR"
```

---

## Task 4: Spawn an ACP session as an operator

**Files:**
- Modify: `crates/app/src/acp_commands.rs:712-726` (`SpawnAcpOpts`), `:1126-1151` (the `executor == "claude"` block)
- Modify: `ui/src/api.ts:3581-3591`
- Test: `crates/app/tests/soul_config.rs` (append)

**Interfaces:**
- Consumes: `prepare_claude_acp_config(base, cfg, Some((operator_id, &compiled)))` from Task 3
- Produces: `SpawnAcpOpts::operator_id: Option<String>`; `spawnAcpSession({ …, operatorId })` in `ui/src/api.ts`

- [ ] **Step 1: Write the failing test**

Append to `crates/app/tests/soul_config.rs`:

```rust
#[test]
fn spawn_opts_carry_an_operator_id_over_the_wire() {
    // The field must deserialize from the camelCase the frontend sends.
    let opts: covenant::acp_commands::SpawnAcpOpts =
        serde_json::from_str(r#"{"executor":"claude","operatorId":"op-123"}"#).expect("deserialize");
    assert_eq!(opts.operator_id.as_deref(), Some("op-123"));
    assert_eq!(opts.executor.as_deref(), Some("claude"));

    let bare: covenant::acp_commands::SpawnAcpOpts =
        serde_json::from_str(r#"{"executor":"copilot"}"#).expect("deserialize");
    assert!(bare.operator_id.is_none(), "a soulless spawn stays soulless");
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cargo test -p covenant --test soul_config spawn_opts_carry
```

Expected: FAIL — `no field `operator_id` on type `SpawnAcpOpts``.

- [ ] **Step 3: Add the field**

In `crates/app/src/acp_commands.rs`, inside `SpawnAcpOpts` after `group_id`:

```rust
    /// The operator this tab IS. When set, the tab is not a bare harness:
    /// the operator's compiled soul becomes the session's CLAUDE_CONFIG_DIR,
    /// so the harness boots already wearing its mandate and its reflexes.
    /// `None` = a soulless ACP chat, the pre-operator behaviour.
    pub operator_id: Option<String>,
```

Confirm the struct carries `#[serde(rename_all = "camelCase")]`; if it does not, add it — the test above asserts the wire name.

- [ ] **Step 4: Compile the soul at spawn time**

In `crates/app/src/acp_commands.rs`, inside the `if executor == "claude" {` block, replace the `spawn_blocking` call and its binding with:

```rust
        // The operator's soul, compiled fresh on every spawn: the file on
        // disk is the source of truth, so editing SOUL.md and reopening the
        // tab is the whole update loop.
        let compiled = match opts.operator_id.as_deref() {
            Some(id) => {
                let op = operator_registry
                    .get(id)
                    .await
                    .ok_or_else(|| format!("unknown operator: {id}"))?;
                let path = op
                    .soul_path
                    .clone()
                    .ok_or_else(|| format!("operator {id} has no soul file"))?;
                let raw = tokio::fs::read_to_string(&path)
                    .await
                    .map_err(|e| format!("read soul {path}: {e}"))?;
                let soul = crate::soul::parse(&raw).map_err(|e| format!("parse soul: {e}"))?;
                let c = crate::soul_compile::compile(&soul);
                for w in &c.warnings {
                    tracing::warn!(operator = id, warning = %w, "soul constraint did not compile");
                }
                Some((id.to_string(), c))
            }
            None => None,
        };
        let cfg_for_prep = cfg.clone();
        let (cfg_dir, oauth_token) = tokio::task::spawn_blocking(move || {
            let soul_ref = compiled.as_ref().map(|(id, c)| (id.as_str(), c));
            prepare_claude_acp_config(&base, &cfg_for_prep, soul_ref)
        })
        .await
        .map_err(|e| format!("claude config prep: {e}"))??;
```

Keep the `refresh_claude_token_if_stale().await;` line and everything after `(cfg_dir, oauth_token)` unchanged. If `OperatorRegistry` exposes the lookup under a different name than `get`, use whatever `crates/app/src/operator_registry.rs` provides — the surrounding `set_acp_enabled` at `operator_registry.rs:659` shows the accessor pattern in use.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cargo test -p covenant --test soul_config && cargo check -p covenant
```

Expected: PASS, and `cargo check` clean.

- [ ] **Step 6: Thread it through the frontend API**

In `ui/src/api.ts`, add `operatorId?: string | null;` to the options type of `spawnAcpSession` (around line 3581) so it reaches the `invoke<SpawnAcpResult>("spawn_acp_session", { opts })` call at line 3591. The field name must be exactly `operatorId` to match the `camelCase` rename asserted in Step 1.

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit -p tsconfig.json
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add crates/app/src/acp_commands.rs crates/app/tests/soul_config.rs ui/src/api.ts
git commit -m "feat(acp): spawn a session as an operator, wearing its compiled soul"
```

---

## Task 5: `run_in_pty` — the MCP tool that crosses the ceiling

`crates/app/src/mcp_server.rs:707-711` documents a standing ceiling: the server never executes commands. This tool breaks it deliberately, so it carries its own gate. Read that comment block and the `session_output` tool next to it before writing — `session_output` is the closest existing shape and already does the masking and truncation.

**Files:**
- Modify: `crates/app/src/mcp_server.rs` (tool registration, `WRITE_TOOLS` at line 711)
- Test: `crates/app/tests/run_in_pty_gate.rs` (create)

**Interfaces:**
- Consumes: `$COVENANT_SESSION_ID`, already exported into every ACP spawn (`AGENTS.md` § Covenant MCP Server → Spawn injection)
- Produces: MCP tool `run_in_pty { command: String }` → the command's output, ANSI-free and secret-masked. It takes **no** session id: the session is the caller's own, resolved from the env var recorded at spawn.

- [ ] **Step 1: Write the failing test**

Create `crates/app/tests/run_in_pty_gate.rs`:

```rust
//! The gate, not the plumbing. `run_in_pty` writes to exactly one PTY —
//! the caller's own — and the blocklist still applies.

#[test]
fn run_in_pty_is_classified_as_a_write_tool() {
    // every_tool_is_classified in mcp_server.rs enforces membership; this
    // asserts the SIDE, because a write tool listed as a read renders
    // without its warning pill.
    assert!(
        covenant::mcp_server::write_tools().contains(&"run_in_pty"),
        "run_in_pty executes commands — it is a write"
    );
    assert!(!covenant::mcp_server::read_tools().contains(&"run_in_pty"));
}

#[test]
fn the_target_session_is_the_callers_own_never_an_argument() {
    // Resolution takes the caller's spawn-time session id and ignores any
    // session id in the payload: an operator must not be able to reach
    // another tab's shell by naming it.
    let resolved = covenant::mcp_server::resolve_own_session(Some("sess-A"));
    assert_eq!(resolved.as_deref(), Some("sess-A"));
    assert!(
        covenant::mcp_server::resolve_own_session(None).is_none(),
        "no spawn-time session id means no PTY to write to"
    );
}

#[test]
fn the_blocklist_still_applies_to_commands_from_an_operator() {
    // safety::is_blocked is the same gate the autonomous-execution policy
    // framework uses; run_in_pty must not be a way around it.
    assert!(covenant_agent::safety::is_blocked("rm -rf /"));
    assert!(covenant_agent::safety::is_blocked("sudo reboot"));
    assert!(!covenant_agent::safety::is_blocked("cargo test"));
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cargo test -p covenant --test run_in_pty_gate
```

Expected: FAIL — `run_in_pty` is not in `WRITE_TOOLS`, and `write_tools()` / `read_tools()` / `resolve_own_session` do not exist. If `covenant_agent::safety::is_blocked` has a different name, read `crates/agent/src/safety.rs` and use the real one — the blocklist lives there per AGENTS.md § Security.

- [ ] **Step 3: Expose the classification lists and add the tool**

In `crates/app/src/mcp_server.rs`, add `"run_in_pty"` to `WRITE_TOOLS` (line 711) and add these accessors beside it:

```rust
/// Test-visible views of the classification lists. The lists themselves
/// stay private so `every_tool_is_classified` remains the single gate.
pub fn write_tools() -> &'static [&'static str] {
    WRITE_TOOLS
}
pub fn read_tools() -> &'static [&'static str] {
    READ_TOOLS
}

/// The session a `run_in_pty` call may write to: the one recorded when this
/// executor was spawned, never one the caller names. `None` when the caller
/// was not spawned by Covenant, which is a refusal, not a fallback.
pub fn resolve_own_session(spawn_session_id: Option<&str>) -> Option<String> {
    spawn_session_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}
```

Register the tool alongside `session_output`, following that tool's masking and truncation. The handler must, in order:

1. Resolve the session with `resolve_own_session`; `None` → error `"run_in_pty: this executor was not spawned by Covenant"`.
2. Reject the command if the blocklist matches (`crates/agent/src/safety.rs`) — error, not a prompt. The blocklist is never auto-executed regardless of policy (AGENTS.md § Security).
3. Write the command to that session's PTY.
4. Return the resulting block's output through the same `safety::mask_secrets` + truncation path `session_output` uses.
5. Record the call in the ledger, same call site the reflex ledger already writes from.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cargo test -p covenant --test run_in_pty_gate && cargo test -p covenant mcp_server
```

Expected: PASS, and `every_tool_is_classified` stays green with the new entry.

- [ ] **Step 5: Update the AGENTS.md ceiling note**

`AGENTS.md` § Covenant MCP Server currently reads *"strictly read-only, there is no write-to-session tool and adding one requires the full policy framework, not a new tool"* and *"it does **not** execute commands. Keep it that way"*. Both sentences are now false. Replace them with the real posture: `run_in_pty` executes, scoped to the caller's own session, blocklist-gated, ledger-recorded — and widening that scope still needs a safety review.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/mcp_server.rs crates/app/tests/run_in_pty_gate.rs AGENTS.md
git commit -m "feat(mcp): run_in_pty — an operator executes in its own tab's PTY"
```

---

## Task 6: The operator tab — terminal face + "Invoke operator"

**Files:**
- Create: `ui/src/tabs/operator-face.ts`, `ui/src/tabs/operator-face.test.ts`
- Modify: `ui/src/tabs/manager.ts:5981-6002` (`createAcpTab` options), `:2685` and `:9794` ("Start new agent" menu items)

**Interfaces:**
- Consumes: `spawnAcpSession({ operatorId })` from Task 4; `this.spawnPtyForPane(cwd)` (`ui/src/tabs/manager.ts:1496`, returns the new session id)
- Produces: `nextFace(current: Face): Face` and `type Face = "conversation" | "terminal"`; `createAcpTab({ operatorId })`

- [ ] **Step 1: Write the failing test**

Create `ui/src/tabs/operator-face.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { nextFace, faceLabel, type Face } from "./operator-face";

describe("operator face", () => {
  it("toggles between the two faces and nothing else", () => {
    expect(nextFace("conversation")).toBe("terminal");
    expect(nextFace("terminal")).toBe("conversation");
  });

  it("round-trips", () => {
    const start: Face = "conversation";
    expect(nextFace(nextFace(start))).toBe(start);
  });

  it("labels the face you would switch TO, which is what a toggle reads as", () => {
    expect(faceLabel("conversation")).toBe("Terminal");
    expect(faceLabel("terminal")).toBe("Conversation");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm test -- ui/src/tabs/operator-face.test.ts
```

Expected: FAIL — `Failed to resolve import "./operator-face"`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/tabs/operator-face.ts`:

```ts
/// An operator tab is one being with two faces: the conversation (its ACP
/// session — its mind) and the terminal (the PTY it owns — its hands). Not
/// two kinds of tab, and not a split: you look at one at a time, and the
/// other keeps running.

export type Face = "conversation" | "terminal";

export function nextFace(current: Face): Face {
  return current === "conversation" ? "terminal" : "conversation";
}

/// A toggle is labelled with where it takes you, not where you are.
export function faceLabel(current: Face): string {
  return current === "conversation" ? "Terminal" : "Conversation";
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm test -- ui/src/tabs/operator-face.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Give `createAcpTab` an operator and a terminal face**

In `ui/src/tabs/manager.ts`, add to the `createAcpTab` options object (after `initialPrompt`, line 6001):

```ts
    /// The operator this tab IS. Its compiled soul becomes the session's
    /// config dir, so the harness boots already wearing the mandate. When
    /// set, the tab also gets a terminal face: a PTY the operator owns and
    /// the principal can watch or take over.
    operatorId?: string | null;
```

Pass it through to the `spawnAcpSession({ … })` call at line 6224. Then, when `operatorId` is set, create the terminal face's PTY with the existing helper and keep its host hidden until the face is toggled:

```ts
    let face: Face = "conversation";
    let terminalSessionId: string | null = null;
    if (opts?.operatorId) {
      // Same PTY every other tab gets — the operator does not get a special
      // kind of terminal, it gets one of yours.
      terminalSessionId = await this.spawnPtyForPane(launchCwd ?? "");
    }
```

Wire the toggle to `nextFace(face)`, showing `acpPaneHost0` for `"conversation"` and the terminal host for `"terminal"`. Bind it on the tab's context menu using `faceLabel(face)` as the item label. Import both from `./operator-face`.

- [ ] **Step 6: Collapse the menu into "Invoke operator"**

`ui/src/tabs/manager.ts` has two `label: "Start new agent"` items — the group context menu (line 2685) and the empty-tabbar one (line 9794). Replace each with an **"Invoke operator"** submenu listing the operators from the registry, each calling `createAcpTab({ operatorId, executor: "claude", groupId, cwd, isolate: true })`, plus a final **"Raw terminal"** item that keeps today's default-spawn behaviour verbatim. Remove the separate "Start ACP" item: picking the harness is now the soul's business, not the user's.

- [ ] **Step 7: Type-check and run the suite**

```bash
npx tsc --noEmit -p tsconfig.json && npm test
```

Expected: no type errors; the full Vitest suite green, including the pre-existing `ui/src/tabs/manager.test.ts`.

- [ ] **Step 8: Verify it live**

Use the `verify` skill's DOM-dump recipe (`AGENTS.md` § Canon context → verify). Probe, in one POST: that invoking `guardian` yields a tab with `kind: "acp"`, that its pane has a non-null terminal session id, that `souls/<operator-id>/settings.json` exists with `"Bash"` in `permissions.deny`, and that toggling the face swaps which host is `hidden`. Clean up the worktree, its `agent/*` branch, the listener, and the dev app afterwards.

- [ ] **Step 9: Commit**

```bash
git add ui/src/tabs/operator-face.ts ui/src/tabs/operator-face.test.ts ui/src/tabs/manager.ts
git commit -m "feat(tabs): an ACP tab becomes an operator with a terminal face"
```

---

## Not in this plan

From the spec, deliberately deferred — each needs the above in real use first:

| Spec phase | Why it waits |
|---|---|
| Phase 3 tail — `SpawnSpec` deriving from the soul | The menu collapse (Task 6) covers the user-visible half. Reshaping `spawns.json` touches restore and the Spawns UI; own plan. |
| Phase 4 — detector + resident guardian | Needs the operator tab working before "poke a resident operator" means anything. Own plan. |
| Phase 5 — deleting `teammate/llm.rs`, `tools.rs`, providers | The spec is explicit: only after phases 2–4 are in real use. |
| `intervene_in_session` (write to a *foreign* PTY) | Only the guardian needs it, and the guardian arrives in Phase 4. `run_in_pty` stays own-session-only until then. |
