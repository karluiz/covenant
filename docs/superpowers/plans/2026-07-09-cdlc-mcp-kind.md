# CDLC Mcp Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `Mcp` as a first-class context kind — authored as `.covenant/canon/mcp/<name>.json`, enumerated, carried in `CanonStatus`, projected by non-destructive merge into the repo-committed MCP config of Claude, opencode, and Codex, and surfaced in the rail and cockpit.

**Architecture:** MCP is config, not markdown. A new `crates/canon/src/mcp.rs` module owns the parsed `McpServer` model, the `.json` enumerator, the three per-executor mergers, and the projection-status compare. Canon owns only servers prefixed `canon-`; each merge preserves the user's own servers. Codex is TOML via the `toml` crate (data preserved; comments/formatting are NOT — a known limitation). Copilot is excluded (no repo-committed MCP file).

**Tech Stack:** Rust (`crates/canon`, `crates/app`, `serde_json`, `toml`), TypeScript (`ui/src/canon/*`, Vitest).

## Global Constraints

- Rust: no `unwrap()` outside `#[cfg(test)]`. Public serialized structs derive `Serialize`; `Debug + Clone`.
- Canon owns ONLY MCP servers named `canon-<name>` in each executor config. Merges MUST preserve non-`canon-` (user) servers and all other config keys.
- MCP projection targets ONLY claude (`.mcp.json`), opencode (`opencode.json`), codex (`.codex/config.toml`). NOT copilot, NOT pi.
- Deterministic output: use `BTreeMap` for env/headers so serialized config is stable across runs.
- TypeScript strict; no `as any` without a comment. Tauri commands wrapped in `api.ts`.
- Tests from repo ROOT: `npm test`, `cargo test -p karl-canon`. Never vitest from `ui/`.
- No native `element.title`; UI copy English. Conventional Commits; stage explicit paths.
- Worktree `.claude/worktrees/cdlc-mcp` (branch `feat/cdlc-mcp-kind`).
- Known pre-existing unrelated failure: `ui/src/tasker/panel.test.ts` "calendar sets and clears dueDate" — ignore.

---

### Task 1: Backend — `mcp.rs` model + enumerator, `Mcp` kind, `read_source` arm

**Files:**
- Create: `crates/canon/src/mcp.rs`
- Modify: `crates/canon/src/lib.rs` (`pub mod mcp;` + re-export `McpServer`)
- Modify: `crates/canon/src/kind.rs` (`Mcp` variant, `dir()`/`label()`, `list_context` mcp loop)
- Modify: `crates/canon/src/install.rs` (`read_source` `Mcp` arm)
- Test: inline in `crates/canon/src/mcp.rs`

**Interfaces:**
- Produces: `McpServer` (serde), `McpServer::transport_kind()`, `McpServer::is_remote()`, `pub(crate) read_mcp_servers(repo_root) -> Result<Vec<(String, McpServer)>>`; `ContextKind::Mcp`; `list_context` yields `Mcp` units (summary = `description`); `read_source(Mcp)` reads `mcp/<name>.json`.

- [ ] **Step 1: Write the failing test (new `mcp.rs` with tests only)**

Create `crates/canon/src/mcp.rs` with the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_mcp_servers_parses_stdio_and_remote() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join(".covenant/canon/mcp");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("ctx7.json"),
            r#"{"command":"npx","args":["-y","ctx7"],"env":{"K":"v"},"description":"Context7"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("remote.json"),
            r#"{"type":"http","url":"https://example.com/mcp","description":"Remote"}"#,
        )
        .unwrap();

        let servers = read_mcp_servers(root).unwrap();
        assert_eq!(servers.len(), 2);
        let (n0, s0) = &servers[0]; // sorted: ctx7 first
        assert_eq!(n0, "ctx7");
        assert_eq!(s0.transport_kind(), "stdio");
        assert!(!s0.is_remote());
        assert_eq!(s0.description.as_deref(), Some("Context7"));
        let (_n1, s1) = &servers[1];
        assert_eq!(s1.transport_kind(), "http");
        assert!(s1.is_remote());
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-canon read_mcp_servers_parses_stdio_and_remote`
Expected: FAIL — module/function not found.

- [ ] **Step 3: Implement `mcp.rs` (prepend above the test module)**

```rust
//! MCP (Model Context Protocol) servers as a Canon context kind. Source files
//! are `.covenant/canon/mcp/<name>.json` in Claude's per-server shape plus an
//! optional `description`. Projection merges them (namespaced `canon-<name>`)
//! into each executor's native MCP config, preserving the user's own servers.

use crate::manifest::canon_dir;
use crate::CanonError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// Canonical per-server shape (Claude's `.mcp.json` entry + `description`).
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct McpServer {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

impl McpServer {
    /// "stdio" | "http" | "sse". Defaults to stdio when a command is present.
    pub fn transport_kind(&self) -> String {
        self.transport.clone().unwrap_or_else(|| {
            if self.command.is_some() {
                "stdio".to_string()
            } else {
                "http".to_string()
            }
        })
    }

    pub fn is_remote(&self) -> bool {
        matches!(
            self.transport_kind().as_str(),
            "http" | "sse" | "streamable-http"
        )
    }
}

/// Parse every `.covenant/canon/mcp/<name>.json` into (name, McpServer), sorted.
pub(crate) fn read_mcp_servers(repo_root: &Path) -> Result<Vec<(String, McpServer)>, CanonError> {
    let dir = canon_dir(repo_root).join("mcp");
    let mut out: Vec<(String, McpServer)> = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let raw = std::fs::read_to_string(&path)?;
        let srv: McpServer = serde_json::from_str(&raw)
            .map_err(|e| CanonError::InvalidPackage(format!("mcp/{stem}.json: {e}")))?;
        out.push((stem, srv));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}
```

- [ ] **Step 4: Wire the module + re-export in `lib.rs`**

Add `pub mod mcp;` near the other `pub mod` lines, and extend re-exports:

```rust
pub use mcp::McpServer;
```

- [ ] **Step 5: Add the `Mcp` variant + enumerate it (`kind.rs`)**

Add `Mcp` to the enum (between `Command` and `Skill`):

```rust
pub enum ContextKind {
    Agent,
    Context,
    Command,
    Mcp,
    Skill,
}
```

Add `dir()` arm `Self::Mcp => "mcp"` and `label()` arm `Self::Mcp => "Mcp"`.

In `list_context`, after the `commands` loop and before the `skills` loop, add:

```rust
    for (name, srv) in crate::mcp::read_mcp_servers(repo_root)? {
        out.push(ContextUnit {
            kind: ContextKind::Mcp,
            summary: srv.description.clone(),
            name,
            projectable: true,
            packageable: false,
        });
    }
```

- [ ] **Step 6: Add the `Mcp` arm to `read_source` (`install.rs`)**

Change the `read_source` path match to give Mcp a `.json` path:

```rust
    let path = match kind {
        ContextKind::Skill => base.join(name).join("SKILL.md"),
        ContextKind::Mcp => base.join(format!("{name}.json")),
        _ => base.join(format!("{name}.md")),
    };
```

- [ ] **Step 7: Add a `list_context` mcp test + `read_source` mcp test**

Add to `kind.rs` tests:

```rust
#[test]
fn list_context_includes_mcp_with_description() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let dir = root.join(".covenant/canon/mcp");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("ctx7.json"), r#"{"command":"npx","description":"C7"}"#).unwrap();
    let units = list_context(root).unwrap();
    let mcp = units.iter().find(|u| u.kind == ContextKind::Mcp).unwrap();
    assert_eq!(mcp.name, "ctx7");
    assert_eq!(mcp.summary.as_deref(), Some("C7"));
    assert!(!mcp.packageable);
}
```

Add to `install.rs` tests (near `read_source_returns_agent_and_context_bodies`):

```rust
#[test]
fn read_source_reads_mcp_json() {
    use crate::ContextKind;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let dir = root.join(".covenant/canon/mcp");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("ctx7.json"), r#"{"command":"npx"}"#).unwrap();
    let body = read_source(root, ContextKind::Mcp, "ctx7").unwrap();
    assert!(body.contains("npx"));
}
```

- [ ] **Step 8: Run tests + full suite**

Run: `cargo test -p karl-canon read_mcp_servers_parses_stdio_and_remote list_context_includes_mcp_with_description read_source_reads_mcp_json`
Expected: PASS. Then `cargo test -p karl-canon` — all green.

- [ ] **Step 9: Commit**

```bash
git add crates/canon/src/mcp.rs crates/canon/src/lib.rs crates/canon/src/kind.rs crates/canon/src/install.rs
git commit -m "feat(canon): Mcp kind — McpServer model, enumerator, read_source json arm"
```

---

### Task 2: Backend — `CanonStatus.mcp`

**Files:**
- Modify: `crates/canon/src/install.rs` (`McpRef`, `CanonStatus.mcp`, `status()`)
- Test: inline in `crates/canon/src/install.rs`

**Interfaces:**
- Consumes: `read_mcp_servers`, `McpServer::transport_kind`.
- Produces: `CanonStatus.mcp: Vec<McpRef>` where `McpRef { name: String, description: Option<String>, transport: String }`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn status_lists_mcp_with_transport() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let dir = root.join(".covenant/canon/mcp");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("ctx7.json"), r#"{"command":"npx","description":"C7"}"#).unwrap();
    let s = status(root).unwrap();
    assert_eq!(s.mcp.len(), 1);
    assert_eq!(s.mcp[0].name, "ctx7");
    assert_eq!(s.mcp[0].transport, "stdio");
    assert_eq!(s.mcp[0].description.as_deref(), Some("C7"));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p karl-canon status_lists_mcp_with_transport`
Expected: FAIL — no field `mcp`.

- [ ] **Step 3: Add `McpRef` + field + populate**

Add near the other Ref structs:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRef {
    pub name: String,
    pub description: Option<String>,
    pub transport: String,
}
```

Add `pub mcp: Vec<McpRef>` to `CanonStatus`. In `status()`, derive it directly from the parser (MCP carries structured `transport` that `ContextUnit` doesn't model):

```rust
    let mcp = crate::mcp::read_mcp_servers(repo_root)?
        .into_iter()
        .map(|(name, s)| McpRef {
            description: s.description.clone(),
            transport: s.transport_kind(),
            name,
        })
        .collect();
```

Add `mcp` to the returned `CanonStatus { ... }`.

- [ ] **Step 4: Run to verify it passes + full suite**

Run: `cargo test -p karl-canon status_lists_mcp_with_transport && cargo test -p karl-canon`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/canon/src/install.rs
git commit -m "feat(canon): CanonStatus lists mcp servers with transport"
```

---

### Task 3: Backend — Claude MCP projection + shared JSON merge

**Files:**
- Modify: `crates/canon/src/mcp.rs` (`merge_json_servers`, `claude_value`, `project_mcp_claude`)
- Test: inline in `crates/canon/src/mcp.rs`

**Interfaces:**
- Produces: `pub(crate) fn merge_json_servers(path, top_key, canon: &[(String, serde_json::Value)]) -> Result<(), CanonError>` (owns `canon-*` keys, preserves the rest); `pub(crate) fn project_mcp_claude(repo_root, servers) -> Result<(), CanonError>`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn project_mcp_claude_merges_preserving_user_servers() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    // Pre-existing user server must survive.
    std::fs::write(
        repo.join(".mcp.json"),
        r#"{"mcpServers":{"mine":{"command":"my-server"}}}"#,
    )
    .unwrap();
    let servers = vec![(
        "ctx7".to_string(),
        McpServer { command: Some("npx".into()), args: vec!["-y".into(), "ctx7".into()], ..Default::default() },
    )];
    project_mcp_claude(repo, &servers).unwrap();

    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(repo.join(".mcp.json")).unwrap()).unwrap();
    let m = v["mcpServers"].as_object().unwrap();
    assert!(m.contains_key("mine"), "user server preserved");
    assert!(m.contains_key("canon-ctx7"), "canon server added");
    assert_eq!(m["canon-ctx7"]["command"], "npx");
}

#[test]
fn project_mcp_claude_empty_source_strips_canon_only() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    std::fs::write(
        repo.join(".mcp.json"),
        r#"{"mcpServers":{"mine":{"command":"x"},"canon-old":{"command":"y"}}}"#,
    )
    .unwrap();
    project_mcp_claude(repo, &[]).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(repo.join(".mcp.json")).unwrap()).unwrap();
    let m = v["mcpServers"].as_object().unwrap();
    assert!(m.contains_key("mine"));
    assert!(!m.contains_key("canon-old"), "stale canon server removed");
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p karl-canon project_mcp_claude`
Expected: FAIL — functions not found.

- [ ] **Step 3: Implement the shared merge + claude transform (add to `mcp.rs`)**

```rust
/// Merge `canon-*`-namespaced server values into a JSON config file under
/// `top_key`, owning ONLY `canon-` keys and preserving every other key + all
/// other top-level config. Writes pretty JSON with a trailing newline.
pub(crate) fn merge_json_servers(
    path: &Path,
    top_key: &str,
    canon: &[(String, serde_json::Value)],
) -> Result<(), CanonError> {
    let mut root: serde_json::Value = if path.exists() {
        serde_json::from_str(&std::fs::read_to_string(path)?)
            .unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if !root.is_object() {
        root = serde_json::json!({});
    }
    let obj = root.as_object_mut().expect("object");
    let servers = obj
        .entry(top_key.to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    let map = servers.as_object_mut().expect("object");
    map.retain(|k, _| !k.starts_with("canon-"));
    for (name, val) in canon {
        map.insert(format!("canon-{name}"), val.clone());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out = serde_json::to_string_pretty(&root)
        .map_err(|e| CanonError::InvalidPackage(e.to_string()))?;
    std::fs::write(path, out + "\n")?;
    Ok(())
}

fn claude_value(srv: &McpServer) -> serde_json::Value {
    if srv.is_remote() {
        serde_json::json!({ "type": srv.transport_kind(), "url": srv.url, "headers": srv.headers })
    } else {
        serde_json::json!({ "command": srv.command, "args": srv.args, "env": srv.env })
    }
}

pub(crate) fn project_mcp_claude(
    repo_root: &Path,
    servers: &[(String, McpServer)],
) -> Result<(), CanonError> {
    let canon: Vec<(String, serde_json::Value)> =
        servers.iter().map(|(n, s)| (n.clone(), claude_value(s))).collect();
    merge_json_servers(&repo_root.join(".mcp.json"), "mcpServers", &canon)
}
```

Note: the `.expect("object")` calls are guarded by the `is_object()` checks immediately above them, so they cannot fire — acceptable in non-test code as they are provably unreachable, but if the reviewer prefers, replace with `ok_or_else(|| CanonError::InvalidPackage(...))?`.

- [ ] **Step 4: Run to verify they pass**

Run: `cargo test -p karl-canon project_mcp_claude`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/canon/src/mcp.rs
git commit -m "feat(canon): Claude .mcp.json projection with non-destructive merge"
```

---

### Task 4: Backend — opencode MCP projection

**Files:**
- Modify: `crates/canon/src/mcp.rs` (`opencode_value`, `project_mcp_opencode`)
- Test: inline in `crates/canon/src/mcp.rs`

**Interfaces:**
- Consumes: `merge_json_servers` (Task 3).
- Produces: `pub(crate) fn project_mcp_opencode(repo_root, servers) -> Result<(), CanonError>` — merges into `opencode.json` `mcp` with opencode's `local`/`remote` shape.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn project_mcp_opencode_transforms_and_preserves() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    std::fs::write(
        repo.join("opencode.json"),
        r#"{"mcp":{"mine":{"type":"local","command":["x"]}}}"#,
    )
    .unwrap();
    let servers = vec![(
        "ctx7".to_string(),
        McpServer { command: Some("npx".into()), args: vec!["-y".into()], ..Default::default() },
    )];
    project_mcp_opencode(repo, &servers).unwrap();
    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(repo.join("opencode.json")).unwrap()).unwrap();
    let m = v["mcp"].as_object().unwrap();
    assert!(m.contains_key("mine"), "user server preserved");
    let c = &m["canon-ctx7"];
    assert_eq!(c["type"], "local");
    assert_eq!(c["command"], serde_json::json!(["npx", "-y"]));
    assert_eq!(c["enabled"], true);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p karl-canon project_mcp_opencode_transforms_and_preserves`
Expected: FAIL.

- [ ] **Step 3: Implement (add to `mcp.rs`)**

```rust
fn opencode_value(srv: &McpServer) -> serde_json::Value {
    if srv.is_remote() {
        serde_json::json!({
            "type": "remote",
            "url": srv.url,
            "headers": srv.headers,
            "enabled": true,
        })
    } else {
        let mut command = vec![srv.command.clone().unwrap_or_default()];
        command.extend(srv.args.clone());
        serde_json::json!({
            "type": "local",
            "command": command,
            "environment": srv.env,
            "enabled": true,
        })
    }
}

pub(crate) fn project_mcp_opencode(
    repo_root: &Path,
    servers: &[(String, McpServer)],
) -> Result<(), CanonError> {
    let canon: Vec<(String, serde_json::Value)> =
        servers.iter().map(|(n, s)| (n.clone(), opencode_value(s))).collect();
    merge_json_servers(&repo_root.join("opencode.json"), "mcp", &canon)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p karl-canon project_mcp_opencode_transforms_and_preserves`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/canon/src/mcp.rs
git commit -m "feat(canon): opencode.json MCP projection (local/remote transform)"
```

---

### Task 5: Backend — Codex MCP projection (TOML)

**Files:**
- Modify: `crates/canon/src/mcp.rs` (`codex_value`, `project_mcp_codex`)
- Test: inline in `crates/canon/src/mcp.rs`

**KNOWN GOTCHAS (read before starting):**
- The `toml` crate (0.8) round-trips through `toml::Value`, which **loses comments and original formatting** and **may reorder** keys. This is an accepted limitation for v0 (user DATA — other tables — is preserved; comments are not). Add a `// ponytail:` comment noting `toml_edit` as the upgrade path.
- `toml::to_string(&Value)` can error with "values must be emitted before tables" (`ValueAfterTable`) when a top-level scalar follows a table. If you hit this, serialize via `toml::to_string_pretty` and, if it still errors on a hand-crafted mixed fixture, structure the test's pre-existing user content as a table (e.g. `[model]` section) rather than a bare top-level scalar. If serialization proves intractable for realistic Codex configs, STOP and report BLOCKED — we will defer Codex and ship claude+opencode.

**Interfaces:**
- Produces: `pub(crate) fn project_mcp_codex(repo_root, servers) -> Result<(), CanonError>` — merges `[mcp_servers.canon-<name>]` tables into `.codex/config.toml`, owning only `canon-*` tables.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn project_mcp_codex_merges_preserving_user_table() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    std::fs::create_dir_all(repo.join(".codex")).unwrap();
    // Pre-existing user config: a user mcp server + an unrelated table.
    std::fs::write(
        repo.join(".codex/config.toml"),
        "[mcp_servers.mine]\ncommand = \"my-server\"\n\n[model]\nname = \"gpt\"\n",
    )
    .unwrap();
    let servers = vec![(
        "ctx7".to_string(),
        McpServer { command: Some("npx".into()), args: vec!["-y".into()], ..Default::default() },
    )];
    project_mcp_codex(repo, &servers).unwrap();

    let v: toml::Value =
        toml::from_str(&std::fs::read_to_string(repo.join(".codex/config.toml")).unwrap()).unwrap();
    let servers_tbl = v["mcp_servers"].as_table().unwrap();
    assert!(servers_tbl.contains_key("mine"), "user server preserved");
    assert_eq!(servers_tbl["canon-ctx7"]["command"].as_str(), Some("npx"));
    assert_eq!(v["model"]["name"].as_str(), Some("gpt"), "unrelated table preserved");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p karl-canon project_mcp_codex_merges_preserving_user_table`
Expected: FAIL.

- [ ] **Step 3: Implement (add to `mcp.rs`)**

```rust
fn codex_value(srv: &McpServer) -> toml::Value {
    let mut t = toml::map::Map::new();
    if srv.is_remote() {
        if let Some(u) = &srv.url {
            t.insert("url".into(), toml::Value::String(u.clone()));
        }
    } else {
        if let Some(c) = &srv.command {
            t.insert("command".into(), toml::Value::String(c.clone()));
        }
        if !srv.args.is_empty() {
            t.insert(
                "args".into(),
                toml::Value::Array(srv.args.iter().map(|a| toml::Value::String(a.clone())).collect()),
            );
        }
        if !srv.env.is_empty() {
            let e: toml::map::Map<String, toml::Value> = srv
                .env
                .iter()
                .map(|(k, v)| (k.clone(), toml::Value::String(v.clone())))
                .collect();
            t.insert("env".into(), toml::Value::Table(e));
        }
    }
    toml::Value::Table(t)
}

// ponytail: toml::Value round-trip loses comments/formatting in the user's
// config.toml (data preserved). Upgrade to `toml_edit` if comment retention matters.
pub(crate) fn project_mcp_codex(
    repo_root: &Path,
    servers: &[(String, McpServer)],
) -> Result<(), CanonError> {
    let path = repo_root.join(".codex/config.toml");
    let mut root: toml::Value = if path.exists() {
        toml::from_str(&std::fs::read_to_string(&path)?)
            .unwrap_or_else(|_| toml::Value::Table(Default::default()))
    } else {
        toml::Value::Table(Default::default())
    };
    let table = root
        .as_table_mut()
        .ok_or_else(|| CanonError::InvalidPackage("config.toml root is not a table".into()))?;
    let servers_tbl = table
        .entry("mcp_servers".to_string())
        .or_insert_with(|| toml::Value::Table(Default::default()));
    let map = servers_tbl
        .as_table_mut()
        .ok_or_else(|| CanonError::InvalidPackage("mcp_servers is not a table".into()))?;
    let stale: Vec<String> = map.keys().filter(|k| k.starts_with("canon-")).cloned().collect();
    for k in stale {
        map.remove(&k);
    }
    for (name, srv) in servers {
        map.insert(format!("canon-{name}"), codex_value(srv));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out = toml::to_string_pretty(&root)
        .map_err(|e| CanonError::InvalidPackage(e.to_string()))?;
    std::fs::write(&path, out)?;
    Ok(())
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test -p karl-canon project_mcp_codex_merges_preserving_user_table`
Expected: PASS. (If it fails with `ValueAfterTable`, see the GOTCHAS block above.)

- [ ] **Step 5: Commit**

```bash
git add crates/canon/src/mcp.rs
git commit -m "feat(canon): Codex .codex/config.toml MCP projection (TOML merge)"
```

---

### Task 6: Backend — wire projection + status + app command

**Files:**
- Modify: `crates/canon/src/mcp.rs` (`project_mcp`, `mcp_synced`)
- Modify: `crates/canon/src/project.rs` (call `project_mcp` in `project_with_active`; MCP checks in `projection_status`)
- Modify: `crates/app/src/lib.rs` (`canon_read_source` `"mcp"` arm)
- Test: inline in `crates/canon/src/project.rs`

**Interfaces:**
- Consumes: `project_mcp_claude/opencode/codex`, `read_mcp_servers`.
- Produces: `pub(crate) fn project_mcp(repo_root, servers) -> Result<(), CanonError>` (calls all three); `pub(crate) fn mcp_synced(repo_root, tool, servers) -> bool` (true iff `tool`'s config's `canon-*` servers match what projection would write); `canon_read_source` accepts `"mcp"`.

- [ ] **Step 1: Write the failing test (in `project.rs`)**

```rust
#[test]
fn projection_status_flags_stale_mcp() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    std::fs::create_dir_all(repo.join(".covenant/canon/mcp")).unwrap();
    std::fs::write(repo.join(".covenant/canon/mcp/ctx7.json"), r#"{"command":"npx"}"#).unwrap();
    project(repo).unwrap();
    // Tamper the projected Claude MCP config.
    std::fs::write(repo.join(".mcp.json"), r#"{"mcpServers":{"canon-ctx7":{"command":"TAMPERED"}}}"#).unwrap();
    let st = projection_status(repo).unwrap();
    let claude = st.executors.iter().find(|e| e.tool == "claude").unwrap();
    assert_eq!(claude.state, ProjState::Stale);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p karl-canon projection_status_flags_stale_mcp`
Expected: FAIL — MCP not projected / not checked yet.

- [ ] **Step 3: Add `project_mcp` + `mcp_synced` to `mcp.rs`**

```rust
/// Project all Canon MCP servers into claude/opencode/codex configs.
pub(crate) fn project_mcp(
    repo_root: &Path,
    servers: &[(String, McpServer)],
) -> Result<(), CanonError> {
    project_mcp_claude(repo_root, servers)?;
    project_mcp_opencode(repo_root, servers)?;
    project_mcp_codex(repo_root, servers)?;
    Ok(())
}

/// True iff `tool`'s on-disk config carries exactly the `canon-*` MCP servers
/// that projection would currently write. Compares the parsed `canon-*` subset,
/// ignoring the user's own servers and other config.
pub(crate) fn mcp_synced(repo_root: &Path, tool: &str, servers: &[(String, McpServer)]) -> bool {
    fn canon_json(path: &Path, top_key: &str) -> BTreeMap<String, serde_json::Value> {
        let mut out = BTreeMap::new();
        if let Ok(txt) = std::fs::read_to_string(path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                if let Some(m) = v.get(top_key).and_then(|s| s.as_object()) {
                    for (k, val) in m {
                        if k.starts_with("canon-") {
                            out.insert(k.clone(), val.clone());
                        }
                    }
                }
            }
        }
        out
    }
    match tool {
        "claude" => {
            let expected: BTreeMap<String, serde_json::Value> = servers
                .iter()
                .map(|(n, s)| (format!("canon-{n}"), claude_value(s)))
                .collect();
            canon_json(&repo_root.join(".mcp.json"), "mcpServers") == expected
        }
        "opencode" => {
            let expected: BTreeMap<String, serde_json::Value> = servers
                .iter()
                .map(|(n, s)| (format!("canon-{n}"), opencode_value(s)))
                .collect();
            canon_json(&repo_root.join("opencode.json"), "mcp") == expected
        }
        "codex" => {
            let expected: BTreeMap<String, toml::Value> = servers
                .iter()
                .map(|(n, s)| (format!("canon-{n}"), codex_value(s)))
                .collect();
            let mut actual = BTreeMap::new();
            if let Ok(txt) = std::fs::read_to_string(repo_root.join(".codex/config.toml")) {
                if let Ok(v) = toml::from_str::<toml::Value>(&txt) {
                    if let Some(m) = v.get("mcp_servers").and_then(|s| s.as_table()) {
                        for (k, val) in m {
                            if k.starts_with("canon-") {
                                actual.insert(k.clone(), val.clone());
                            }
                        }
                    }
                }
            }
            actual == expected
        }
        _ => true,
    }
}
```

- [ ] **Step 4: Call `project_mcp` in `project_with_active` (`project.rs`)**

After the `let commands = read_dir_md(...)?;` source read, add:

```rust
    let mcp_servers = crate::mcp::read_mcp_servers(repo_root)?;
```

After the `project_commands(repo_root, &commands)?;` call in the file-per-item block, add:

```rust
    crate::mcp::project_mcp(repo_root, &mcp_servers)?;
```

- [ ] **Step 5: Fold MCP sync into `projection_status` executor states (`project.rs`)**

MCP is a structured config compare, not a byte-level `check_file`, and it must
NOT be pushed into the `checks` map — a lone `Check::Missing` for a legitimately
absent managed block (codex with no agents) would aggregate a synced-MCP codex to
`Stale`. Instead, post-process the computed `executors` states.

After `let commands = read_dir_md(...)?;` in `projection_status`, add the MCP
source read:

```rust
    let mcp_servers = crate::mcp::read_mcp_servers(repo_root)?;
```

Extend the "no sources at all" empty guard to include mcp:

```rust
    if agents.is_empty() && skills.is_empty() && contexts.is_empty() && commands.is_empty() && mcp_servers.is_empty() {
```

Change the `let executors = TOOLS.iter()...collect();` binding to `let mut executors: Vec<ExecutorStatus> = TOOLS.iter()...collect();`, then, immediately before `Ok(ProjectionStatus { executors, ... })`, add:

```rust
    // MCP is projected only to claude/opencode/codex, as a structured config
    // merge. Downgrade a tool to Stale when its canon-* MCP servers don't match;
    // upgrade a not-projected tool to Synced when MCP is its only (matching)
    // source. Never falsely downgrade for an absent managed block.
    if !mcp_servers.is_empty() {
        for e in executors.iter_mut() {
            if !matches!(e.tool.as_str(), "claude" | "opencode" | "codex") {
                continue;
            }
            if !crate::mcp::mcp_synced(repo_root, &e.tool, &mcp_servers) {
                e.state = ProjState::Stale;
            } else if e.state == ProjState::NotProjected {
                e.state = ProjState::Synced;
            }
        }
    }
```

(This relies only on `ProjState: PartialEq`, already derived — the test asserts `state == ProjState::Stale`.)

- [ ] **Step 6: Add the `"mcp"` arm to `canon_read_source` (`app/src/lib.rs`)**

In the `match kind.as_str()` add before `other =>`:

```rust
        "mcp" => karl_canon::ContextKind::Mcp,
```

- [ ] **Step 7: Run the test + full suite + app build**

Run: `cargo test -p karl-canon projection_status_flags_stale_mcp && cargo test -p karl-canon && cargo build -p covenant`
Expected: PASS + clean build.

- [ ] **Step 8: Commit**

```bash
git add crates/canon/src/mcp.rs crates/canon/src/project.rs crates/app/src/lib.rs
git commit -m "feat(canon): wire MCP projection + status + read_source command arm"
```

---

### Task 7: Frontend — `CanonStatus.mcp` TS type + `canonReadSource` union

**Files:**
- Modify: `ui/src/api.ts` (`McpRef`, `CanonStatus.mcp`, `canonReadSource` union)
- Modify: `ui/src/canon/panel.test.ts` + `ui/src/canon/cockpit/view.test.ts` (add `mcp: []` to status mocks)

**Interfaces:**
- Produces: `export interface McpRef { name: string; description: string | null; transport: string }`; `CanonStatus.mcp: McpRef[]`; `canonReadSource(cwd, kind: "agent"|"context"|"command"|"mcp"|"skill", name)`.

- [ ] **Step 1: Update `ui/src/api.ts`**

Add near `CommandRef`:

```typescript
export interface McpRef {
  name: string;
  description: string | null;
  transport: string;
}
```

Add `mcp: McpRef[];` to `CanonStatus`. Extend the `canonReadSource` kind union to `"agent" | "context" | "command" | "mcp" | "skill"`.

- [ ] **Step 2: Add `mcp: []` to every `CanonStatus` literal in the two test files**

Grep `ui/src/canon/panel.test.ts` and `ui/src/canon/cockpit/view.test.ts` for each `CanonStatus` object (they currently have `installed/agents/contexts/commands`) and add `mcp: []`. Also grep the whole `ui/src` for any other `CanonStatus` literal (e.g. a `.catch(() => (...) as CanonStatus)` fallback in `cockpit/view.ts`) and add `mcp: []` there too — the build fails otherwise.

- [ ] **Step 3: Build + tests green**

Run (repo ROOT): `npm run build && npm test -- ui/src/canon`
Expected: TS compiles; canon tests PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts ui/src/canon/panel.test.ts ui/src/canon/cockpit/view.test.ts ui/src/canon/cockpit/view.ts
git commit -m "feat(canon): CanonStatus.mcp TS type + canonReadSource mcp union"
```

---

### Task 8: Frontend — rail Mcp section

**Files:**
- Modify: `ui/src/canon/panel.ts` (`renderStatus`)
- Test: `ui/src/canon/panel.test.ts`

**Interfaces:**
- Consumes: `CanonStatus.mcp`, `canonReadSource(cwd, "mcp", name)`, existing `kindSection`/`skillCard`.

- [ ] **Step 1: Write the failing test**

Add to `ui/src/canon/panel.test.ts` (mirror the existing section tests' construction):

```typescript
it("renders an Mcp section", () => {
  const { panel, host } = mountPanel(); // reuse the suite's actual mount pattern
  panel.renderStatus({
    installed: [], agents: [], contexts: [], commands: [],
    mcp: [{ name: "ctx7", description: "Context7", transport: "stdio" }],
  });
  expect(host.textContent).toContain("MCP");
  expect(host.textContent).toContain("ctx7");
});

it("shows the mcp empty hint when none", () => {
  const { panel, host } = mountPanel();
  panel.renderStatus({ installed: [], agents: [], contexts: [], commands: [], mcp: [] });
  expect(host.textContent).toContain("No MCP servers authored.");
});
```

- [ ] **Step 2: Run to verify they fail**

Run (repo ROOT): `npm test -- ui/src/canon/panel.test`
Expected: FAIL.

- [ ] **Step 3: Add the Mcp section to `renderStatus`**

After the `commands` `kindSection` and before the Skills block, add:

```typescript
    // ── Mcp ──
    const mcp = this.kindSection(
      "MCP",
      s.mcp.length,
      "No MCP servers authored.",
      s.mcp.map((m) =>
        skillCard({
          name: m.name,
          meta: m.description ?? m.transport,
          className: "canon-skill-row",
          fetchPreview: () =>
            cwd ? canonReadSource(cwd, "mcp", m.name) : Promise.resolve("(no project folder)"),
          actions: [],
        }),
      ),
    );
```

Update the final `replaceChildren` to order Agents → Context → Commands → Mcp → Skills:

```typescript
    this.body.replaceChildren(agents, contexts, commands, mcp, skills);
```

- [ ] **Step 4: Run to verify they pass + build**

Run (repo ROOT): `npm test -- ui/src/canon/panel.test && npm run build`
Expected: PASS + clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/canon/panel.ts ui/src/canon/panel.test.ts
git commit -m "feat(canon): rail shows an MCP section"
```

---

### Task 9: Frontend — cockpit Mcp nav section

**Files:**
- Modify: `ui/src/canon/cockpit/view.ts`

**Interfaces:**
- Consumes: `CanonStatus.mcp`, `canonReadSource(cwd, "mcp", name)`, existing `renderCommandsSection` pattern.

- [ ] **Step 1: Add `"mcp"` to `SectionKey`, `SECTIONS`, `SECTION_HEAD`, render switch**

`SectionKey` union — add `"mcp"`. In `SECTIONS`, insert after the `commands` entry:

```typescript
  { key: "mcp", label: "MCP" },
```

In `SECTION_HEAD`, add:

```typescript
  mcp: ["MCP", "Model Context Protocol servers projected to your executors."],
```

In the render switch, after the `commands` branch:

```typescript
      : key === "mcp" ? this.renderMcpSection()
```

- [ ] **Step 2: Implement `renderMcpSection`**

Mirror `renderCommandsSection` exactly, reading `status.mcp`:

```typescript
  private renderMcpSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-mcp";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.note("No project folder linked for this group — point it at a repo from the rail to manage MCP servers."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-mcp-list";
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    void canonLocalStatus(cwd)
      .then((status) => {
        list.replaceChildren();
        if (status.mcp.length === 0) {
          list.appendChild(this.note("No MCP servers authored yet."));
          return;
        }
        for (const m of status.mcp) {
          list.appendChild(skillCard({
            name: m.name,
            meta: m.description ?? m.transport,
            className: "canon-skill-row",
            fetchPreview: () => canonReadSource(cwd, "mcp", m.name),
            actions: [],
          }));
        }
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load MCP servers: ${this.friendlyError(e)}`));
      });

    return el;
  }
```

- [ ] **Step 3: Build + canon tests green**

Run (repo ROOT): `npm run build && npm test -- ui/src/canon`
Expected: compiles; canon suite PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/canon/cockpit/view.ts
git commit -m "feat(canon): cockpit MCP nav section"
```

---

## Final verification

- [ ] `cargo test -p karl-canon` — all green.
- [ ] `cargo build -p covenant` — clean.
- [ ] `npm run build` (repo ROOT) — clean.
- [ ] `npm test -- ui/src/canon` (repo ROOT) — green.
- [ ] Manual smoke (optional): author `.covenant/canon/mcp/ctx7.json` (`{"command":"npx","args":["-y","x"]}`), run projection, confirm `canon-ctx7` appears in `.mcp.json` mcpServers, `opencode.json` mcp (as `type:local`), and `.codex/config.toml` `[mcp_servers.canon-ctx7]`, while a hand-added user server survives in each. Rail → MCP section shows it; cockpit → MCP nav present.
