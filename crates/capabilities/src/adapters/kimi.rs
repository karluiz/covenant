//! Kimi Code adapter — discovers skills, agent profiles, MCP servers and
//! memory for Moonshot AI's `kimi` CLI.
//!
//! Layout (verified against the CLI's own discovery constants — its scanner
//! declares `PROJECT_BRAND_DIRS = [".kimi-code/skills"]` / `[".kimi-code/agents"]`):
//!
//! - `~/.kimi-code/skills/<name>/SKILL.md` (or flat `<name>.md`) — user skills
//! - `~/.kimi-code/agents/*.md` — user agent profiles (`kimi --agent <name>`)
//! - `~/.kimi-code/mcp.json` — user MCP servers (Claude-shaped `mcpServers`)
//! - `~/.kimi-code/AGENTS.md` — user memory
//! - the same four under `<repo>/.kimi-code/` — project scope
//!
//! Not scanned here: the shared `.agents/{skills,agents}` standard (its own
//! adapter), and the project-root `AGENTS.md` / `.mcp.json` that Kimi also
//! reads — those already surface under codex/claude, and listing them twice
//! would double-count one file.

use crate::frontmatter;
use crate::model::{CapabilityError, CapabilityResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum KimiScope {
    User,
    Project(PathBuf),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub scope: KimiScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub scope: KimiScope,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    /// `stdio` when a `command` is present, else the declared remote transport.
    pub kind: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub enabled: bool,
    pub source_file: PathBuf,
    pub scope: KimiScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    pub name: String,
    pub path: PathBuf,
    pub scope: KimiScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Capability {
    Skill(Skill),
    Agent(Agent),
    McpServer(McpServer),
    Memory(Memory),
}

// ponytail: user scope is hardcoded to `~/.kimi-code`. The CLI lets
// `$KIMI_CODE_HOME` relocate it; read the env var here if anyone actually
// sets it (no other adapter in this crate reads env for a scope root, so
// doing it now would be the odd one out).
pub fn detect(home: &Path) -> bool {
    home.join(".kimi-code").is_dir()
}

pub fn scan_user(home: &Path) -> CapabilityResult<Vec<Capability>> {
    scan_root(&home.join(".kimi-code"), KimiScope::User)
}

pub fn scan_project(repo: &Path) -> CapabilityResult<Vec<Capability>> {
    scan_root(
        &repo.join(".kimi-code"),
        KimiScope::Project(repo.to_path_buf()),
    )
}

/// User and project scope share one directory shape, so they share one scan.
fn scan_root(root: &Path, scope: KimiScope) -> CapabilityResult<Vec<Capability>> {
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }
    scan_skills(&root.join("skills"), &scope, &mut out)?;
    scan_agents(&root.join("agents"), &scope, &mut out)?;
    scan_mcp_json(&root.join("mcp.json"), &scope, &mut out)?;
    let agents_md = root.join("AGENTS.md");
    if agents_md.is_file() {
        out.push(Capability::Memory(Memory {
            name: "AGENTS.md".to_string(),
            path: agents_md,
            scope,
        }));
    }
    Ok(out)
}

/// Kimi accepts both skill shapes: a `<name>/SKILL.md` bundle and a flat
/// `<name>.md`. Frontmatter `name`/`description` win; the filename is the
/// fallback (the CLI only *requires* frontmatter for bundles).
fn scan_skills(dir: &Path, scope: &KimiScope, out: &mut Vec<Capability>) -> CapabilityResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        let (md, fallback) = if path.is_dir() {
            let md = path.join("SKILL.md");
            if !md.is_file() {
                continue;
            }
            (md, path.file_name().and_then(|s| s.to_str()))
        } else if path.extension().and_then(|s| s.to_str()) == Some("md") {
            (path.clone(), path.file_stem().and_then(|s| s.to_str()))
        } else {
            continue;
        };
        let fallback = fallback.unwrap_or("").to_string();
        let raw = std::fs::read_to_string(&md)?;
        let fm = frontmatter::parse(&raw);
        out.push(Capability::Skill(Skill {
            name: fm.name().map(str::to_string).unwrap_or(fallback),
            description: fm.description().unwrap_or("").to_string(),
            path: md,
            scope: scope.clone(),
        }));
    }
    Ok(())
}

fn scan_agents(dir: &Path, scope: &KimiScope, out: &mut Vec<Capability>) -> CapabilityResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let raw = std::fs::read_to_string(&path)?;
        let fm = frontmatter::parse(&raw);
        out.push(Capability::Agent(Agent {
            name: fm.name().map(str::to_string).unwrap_or(stem),
            description: fm.description().unwrap_or("").to_string(),
            model: fm.get("model").map(str::to_string),
            path,
            scope: scope.clone(),
        }));
    }
    Ok(())
}

/// `mcp.json` is Claude-shaped: `{"mcpServers": {name: {command|url, ...}}}`.
fn scan_mcp_json(
    path: &Path,
    scope: &KimiScope,
    out: &mut Vec<Capability>,
) -> CapabilityResult<()> {
    if !path.is_file() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| CapabilityError::Json(path.display().to_string(), e))?;
    let Some(map) = value.get("mcpServers").and_then(|v| v.as_object()) else {
        return Ok(());
    };
    for (name, srv) in map {
        let command = srv
            .get("command")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let url = srv.get("url").and_then(|v| v.as_str()).map(str::to_string);
        let kind = if command.is_some() {
            "stdio".to_string()
        } else {
            srv.get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("http")
                .to_string()
        };
        let args = srv
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        out.push(Capability::McpServer(McpServer {
            name: name.clone(),
            kind,
            command,
            args,
            url,
            enabled: srv.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
            source_file: path.to_path_buf(),
            scope: scope.clone(),
        }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn missing_kimi_dir_returns_empty() {
        let tmp = TempDir::new().unwrap();
        assert!(scan_user(tmp.path()).unwrap().is_empty());
        assert!(scan_project(tmp.path()).unwrap().is_empty());
        assert!(!detect(tmp.path()));
    }

    #[test]
    fn user_scan_finds_every_surface() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(
            &home.join(".kimi-code/skills/deploy/SKILL.md"),
            "---\nname: deploy\ndescription: Ship it\n---\nbody\n",
        );
        write(
            &home.join(".kimi-code/agents/reviewer.md"),
            "---\nname: reviewer\ndescription: reviews PRs\nmodel: kimi-k2\n---\n",
        );
        write(
            &home.join(".kimi-code/mcp.json"),
            r#"{"mcpServers":{"ctx7":{"command":"npx","args":["context7"]}}}"#,
        );
        write(&home.join(".kimi-code/AGENTS.md"), "# memory\n");

        let caps = scan_user(home).unwrap();
        assert_eq!(caps.len(), 4, "skill + agent + mcp + memory");
        assert!(detect(home));

        let skill = caps
            .iter()
            .find_map(|c| match c {
                Capability::Skill(s) => Some(s),
                _ => None,
            })
            .unwrap();
        assert_eq!(skill.name, "deploy");
        assert_eq!(skill.description, "Ship it");
        assert_eq!(skill.scope, KimiScope::User);

        let agent = caps
            .iter()
            .find_map(|c| match c {
                Capability::Agent(a) => Some(a),
                _ => None,
            })
            .unwrap();
        assert_eq!(agent.name, "reviewer");
        assert_eq!(agent.model.as_deref(), Some("kimi-k2"));

        let mcp = caps
            .iter()
            .find_map(|c| match c {
                Capability::McpServer(m) => Some(m),
                _ => None,
            })
            .unwrap();
        assert_eq!(mcp.name, "ctx7");
        assert_eq!(mcp.kind, "stdio");
        assert_eq!(mcp.command.as_deref(), Some("npx"));
        assert_eq!(mcp.args, vec!["context7".to_string()]);
        assert!(mcp.enabled, "absent `enabled` defaults to true");

        assert!(caps
            .iter()
            .any(|c| matches!(c, Capability::Memory(m) if m.name == "AGENTS.md")));
    }

    #[test]
    fn flat_markdown_skill_is_discovered() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join(".kimi-code/skills/quick.md"), "no fm\n");
        let caps = scan_user(tmp.path()).unwrap();
        let Capability::Skill(s) = &caps[0] else {
            panic!("expected skill")
        };
        assert_eq!(s.name, "quick", "filename is the fallback name");
        assert_eq!(s.description, "");
    }

    #[test]
    fn skill_dir_without_skill_md_is_skipped() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".kimi-code/skills/empty")).unwrap();
        assert!(scan_user(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn project_scope_carries_repo_path_and_remote_mcp() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path();
        write(
            &repo.join(".kimi-code/mcp.json"),
            r#"{"mcpServers":{"r":{"url":"https://x/mcp","enabled":false}}}"#,
        );
        let caps = scan_project(repo).unwrap();
        let Capability::McpServer(m) = &caps[0] else {
            panic!("expected mcp")
        };
        assert_eq!(m.kind, "http", "no command → remote transport");
        assert_eq!(m.url.as_deref(), Some("https://x/mcp"));
        assert!(!m.enabled);
        assert_eq!(m.scope, KimiScope::Project(repo.to_path_buf()));
    }

    #[test]
    fn malformed_mcp_json_returns_json_error() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join(".kimi-code/mcp.json"), "{ not json");
        assert!(matches!(
            scan_user(tmp.path()).unwrap_err(),
            CapabilityError::Json(_, _)
        ));
    }
}
