//! opencode adapter — discovers agents and MCP servers configured for opencode
//! (https://opencode.ai). Per T1.b:
//!
//! - **User**: `~/.config/opencode/agent/*.md` and `~/.config/opencode/opencode.json`
//! - **Project**: `<repo>/.opencode/agent/*.md` and `<repo>/opencode.json`
//!
//! The shared `~/.agents/skills/` standard is handled by a separate adapter.

use crate::frontmatter;
use crate::model::{CapabilityError, CapabilityResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum OpencodeScope {
    User,
    Project(PathBuf),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub scope: OpencodeScope,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    /// `local` or `remote` per opencode's schema.
    pub kind: String,
    pub command: Option<Vec<String>>,
    pub url: Option<String>,
    pub enabled: bool,
    pub source_file: PathBuf,
    pub scope: OpencodeScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Capability {
    Agent(Agent),
    McpServer(McpServer),
}

/// Scan the user scope (`~/.config/opencode`).
pub fn scan_user(home: &Path) -> CapabilityResult<Vec<Capability>> {
    let root = home.join(".config").join("opencode");
    let mut out = Vec::new();
    scan_agents_dir(&root.join("agent"), OpencodeScope::User, &mut out)?;
    scan_opencode_json(&root.join("opencode.json"), OpencodeScope::User, &mut out)?;
    Ok(out)
}

/// Scan a project scope rooted at `<repo>` (looks at `<repo>/.opencode` + `<repo>/opencode.json`).
pub fn scan_project(repo: &Path) -> CapabilityResult<Vec<Capability>> {
    let scope = OpencodeScope::Project(repo.to_path_buf());
    let mut out = Vec::new();
    scan_agents_dir(&repo.join(".opencode").join("agent"), scope.clone(), &mut out)?;
    scan_opencode_json(&repo.join("opencode.json"), scope, &mut out)?;
    Ok(out)
}

/// True if opencode appears to be installed/configured on this host.
pub fn detect() -> bool {
    let Some(home) = home_dir() else { return false };
    home.join(".config").join("opencode").is_dir()
        || home.join(".opencode").join("bin").join("opencode").is_file()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn scan_agents_dir(dir: &Path, scope: OpencodeScope, out: &mut Vec<Capability>) -> CapabilityResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let raw = std::fs::read_to_string(&path)?;
        let fm = frontmatter::parse(&raw);
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let name = fm.name().map(str::to_string).unwrap_or(stem);
        let description = fm.description().unwrap_or("").to_string();
        let model = fm.get("model").map(str::to_string);
        out.push(Capability::Agent(Agent {
            name,
            description,
            path,
            scope: scope.clone(),
            model,
        }));
    }
    Ok(())
}

fn scan_opencode_json(path: &Path, scope: OpencodeScope, out: &mut Vec<Capability>) -> CapabilityResult<()> {
    if !path.is_file() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| CapabilityError::Json(path.display().to_string(), e))?;
    let Some(map) = value.get("mcp").and_then(|v| v.as_object()) else {
        return Ok(());
    };
    for (name, server) in map {
        let kind = server.get("type").and_then(|v| v.as_str()).unwrap_or("local").to_string();
        let command = server
            .get("command")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(str::to_string)).collect::<Vec<_>>());
        let url = server.get("url").and_then(|v| v.as_str()).map(str::to_string);
        let enabled = server.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        out.push(Capability::McpServer(McpServer {
            name: name.clone(),
            kind,
            command,
            url,
            enabled,
            source_file: path.to_path_buf(),
            scope: scope.clone(),
        }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(path: &Path, body: &str) {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    #[test]
    fn scan_user_missing_config_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let caps = scan_user(tmp.path()).unwrap();
        assert!(caps.is_empty());
    }

    #[test]
    fn scan_user_parses_agent_with_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(
            &home.join(".config/opencode/agent/reviewer.md"),
            "---\nname: reviewer\ndescription: reviews PRs\nmodel: anthropic/claude-sonnet-4-6\n---\nbody",
        );
        let caps = scan_user(home).unwrap();
        assert_eq!(caps.len(), 1);
        let Capability::Agent(a) = &caps[0] else { panic!("expected agent") };
        assert_eq!(a.name, "reviewer");
        assert_eq!(a.description, "reviews PRs");
        assert_eq!(a.model.as_deref(), Some("anthropic/claude-sonnet-4-6"));
        assert_eq!(a.scope, OpencodeScope::User);
    }

    #[test]
    fn agent_without_frontmatter_falls_back_to_stem() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(&home.join(".config/opencode/agent/plain.md"), "just body text");
        let caps = scan_user(home).unwrap();
        let Capability::Agent(a) = &caps[0] else { panic!() };
        assert_eq!(a.name, "plain");
        assert_eq!(a.description, "");
        assert!(a.model.is_none());
    }

    #[test]
    fn agent_extracts_model_field() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(
            &home.join(".config/opencode/agent/a.md"),
            "---\nname: a\nmodel: anthropic/claude-sonnet-4-6\n---\n",
        );
        let caps = scan_user(home).unwrap();
        let Capability::Agent(a) = &caps[0] else { panic!() };
        assert_eq!(a.model.as_deref(), Some("anthropic/claude-sonnet-4-6"));
    }

    #[test]
    fn opencode_json_multiple_mcps_local_and_remote() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let cfg = serde_json::json!({
            "mcp": {
                "ctx7": { "type": "local", "command": ["npx", "context7"], "enabled": true },
                "remote": { "type": "remote", "url": "https://example.com/mcp" }
            }
        });
        write(&home.join(".config/opencode/opencode.json"), &cfg.to_string());
        let caps = scan_user(home).unwrap();
        let mcps: Vec<_> = caps.iter().filter_map(|c| match c { Capability::McpServer(m) => Some(m), _ => None }).collect();
        assert_eq!(mcps.len(), 2);
        let local = mcps.iter().find(|m| m.name == "ctx7").unwrap();
        assert_eq!(local.kind, "local");
        assert_eq!(local.command.as_ref().unwrap(), &vec!["npx".to_string(), "context7".to_string()]);
        assert!(local.enabled);
        let remote = mcps.iter().find(|m| m.name == "remote").unwrap();
        assert_eq!(remote.kind, "remote");
        assert_eq!(remote.url.as_deref(), Some("https://example.com/mcp"));
    }

    #[test]
    fn mcp_enabled_defaults_to_true_when_absent() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let cfg = serde_json::json!({
            "mcp": { "x": { "type": "local", "command": ["x"] } }
        });
        write(&home.join(".config/opencode/opencode.json"), &cfg.to_string());
        let caps = scan_user(home).unwrap();
        let Capability::McpServer(m) = &caps[0] else { panic!() };
        assert!(m.enabled);
    }

    #[test]
    fn mcp_enabled_false_respected() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let cfg = serde_json::json!({
            "mcp": { "x": { "type": "local", "command": ["x"], "enabled": false } }
        });
        write(&home.join(".config/opencode/opencode.json"), &cfg.to_string());
        let caps = scan_user(home).unwrap();
        let Capability::McpServer(m) = &caps[0] else { panic!() };
        assert!(!m.enabled);
    }

    #[test]
    fn project_scope_agents_carry_repo_path() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path();
        write(
            &repo.join(".opencode/agent/proj.md"),
            "---\nname: proj\ndescription: project-scoped\n---\n",
        );
        let caps = scan_project(repo).unwrap();
        let Capability::Agent(a) = &caps[0] else { panic!() };
        assert_eq!(a.scope, OpencodeScope::Project(repo.to_path_buf()));
    }

    #[test]
    fn project_opencode_json_mcps_picked_up() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path();
        let cfg = serde_json::json!({
            "mcp": { "p": { "type": "local", "command": ["p"] } }
        });
        write(&repo.join("opencode.json"), &cfg.to_string());
        let caps = scan_project(repo).unwrap();
        let Capability::McpServer(m) = &caps[0] else { panic!() };
        assert_eq!(m.name, "p");
        assert_eq!(m.scope, OpencodeScope::Project(repo.to_path_buf()));
    }

    #[test]
    fn malformed_opencode_json_returns_json_error() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(&home.join(".config/opencode/opencode.json"), "{ not json");
        let err = scan_user(home).unwrap_err();
        assert!(matches!(err, CapabilityError::Json(_, _)));
    }

    #[test]
    fn detect_true_when_config_dir_exists() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".config/opencode")).unwrap();
        std::env::set_var("HOME", tmp.path());
        assert!(detect());
    }

    #[test]
    fn detect_false_when_nothing_exists() {
        let tmp = TempDir::new().unwrap();
        std::env::set_var("HOME", tmp.path());
        assert!(!detect());
    }

    #[test]
    fn non_md_files_ignored_in_agent_dir() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(&home.join(".config/opencode/agent/notes.txt"), "ignore me");
        write(&home.join(".config/opencode/agent/keep.md"), "---\nname: keep\n---\n");
        let caps = scan_user(home).unwrap();
        assert_eq!(caps.len(), 1);
        let Capability::Agent(a) = &caps[0] else { panic!() };
        assert_eq!(a.name, "keep");
    }
}
