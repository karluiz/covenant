//! Codex adapter — discovers MCP servers, prompts, and AGENTS.md memory
//! configured for the OpenAI Codex CLI.
//!
//! - **User**: `~/.codex/config.toml` ([mcp_servers]), `~/.codex/prompts/*.md`,
//!   `~/.codex/AGENTS.md`
//! - **Project**: `<repo>/AGENTS.md`

use crate::frontmatter;
use crate::model::{CapabilityError, CapabilityResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CodexScope {
    User,
    Project(PathBuf),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub url: Option<String>,
    pub source_file: PathBuf,
    pub scope: CodexScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prompt {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub scope: CodexScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    pub name: String,
    pub path: PathBuf,
    pub scope: CodexScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Capability {
    McpServer(McpServer),
    Prompt(Prompt),
    Memory(Memory),
}

pub fn detect(home: &Path) -> bool {
    home.join(".codex").is_dir()
}

pub fn scan_user(home: &Path) -> CapabilityResult<Vec<Capability>> {
    let root = home.join(".codex");
    let mut out = Vec::new();
    scan_config_toml(&root.join("config.toml"), CodexScope::User, &mut out)?;
    scan_prompts_dir(&root.join("prompts"), CodexScope::User, &mut out)?;
    scan_memory(&root.join("AGENTS.md"), CodexScope::User, &mut out);
    Ok(out)
}

pub fn scan_project(repo: &Path) -> CapabilityResult<Vec<Capability>> {
    let mut out = Vec::new();
    scan_memory(
        &repo.join("AGENTS.md"),
        CodexScope::Project(repo.to_path_buf()),
        &mut out,
    );
    Ok(out)
}

fn scan_memory(path: &Path, scope: CodexScope, out: &mut Vec<Capability>) {
    if path.is_file() {
        out.push(Capability::Memory(Memory {
            name: "AGENTS.md".to_string(),
            path: path.to_path_buf(),
            scope,
        }));
    }
}

fn scan_prompts_dir(
    dir: &Path,
    scope: CodexScope,
    out: &mut Vec<Capability>,
) -> CapabilityResult<()> {
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
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let name = fm.name().map(str::to_string).unwrap_or(stem);
        let description = fm.description().unwrap_or("").to_string();
        out.push(Capability::Prompt(Prompt {
            name,
            description,
            path,
            scope: scope.clone(),
        }));
    }
    Ok(())
}

fn scan_config_toml(
    path: &Path,
    scope: CodexScope,
    out: &mut Vec<Capability>,
) -> CapabilityResult<()> {
    if !path.is_file() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(path)?;
    let value: toml::Value = match raw.parse() {
        Ok(v) => v,
        Err(e) => {
            return Err(CapabilityError::Frontmatter {
                path: path.display().to_string(),
                reason: format!("toml: {e}"),
            });
        }
    };
    let Some(servers) = value.get("mcp_servers").and_then(|v| v.as_table()) else {
        return Ok(());
    };
    for (name, server) in servers {
        let command = server
            .get("command")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let args = server.get("args").and_then(|v| v.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        });
        let url = server
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        out.push(Capability::McpServer(McpServer {
            name: name.clone(),
            command,
            args,
            url,
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
    fn scan_user_missing_codex_dir_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let caps = scan_user(tmp.path()).unwrap();
        assert!(caps.is_empty());
    }

    #[test]
    fn detect_true_when_codex_dir_exists() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".codex")).unwrap();
        assert!(detect(tmp.path()));
    }

    #[test]
    fn scan_user_parses_mcp_servers_from_config_toml() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(
            &home.join(".codex/config.toml"),
            "[mcp_servers.ctx7]\ncommand = \"npx\"\nargs = [\"context7\"]\n",
        );
        let caps = scan_user(home).unwrap();
        let mcps: Vec<_> = caps
            .iter()
            .filter_map(|c| match c {
                Capability::McpServer(m) => Some(m),
                _ => None,
            })
            .collect();
        assert_eq!(mcps.len(), 1);
        assert_eq!(mcps[0].name, "ctx7");
        assert_eq!(mcps[0].command.as_deref(), Some("npx"));
        assert_eq!(
            mcps[0].args.as_ref().unwrap(),
            &vec!["context7".to_string()]
        );
    }

    #[test]
    fn scan_user_parses_prompts() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(
            &home.join(".codex/prompts/review.md"),
            "---\nname: review\ndescription: code review\n---\nbody",
        );
        let caps = scan_user(home).unwrap();
        let prompts: Vec<_> = caps
            .iter()
            .filter_map(|c| match c {
                Capability::Prompt(p) => Some(p),
                _ => None,
            })
            .collect();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].name, "review");
    }

    #[test]
    fn scan_user_surfaces_user_agents_md_as_memory() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(&home.join(".codex/AGENTS.md"), "# memory");
        let caps = scan_user(home).unwrap();
        let mems: Vec<_> = caps
            .iter()
            .filter_map(|c| match c {
                Capability::Memory(m) => Some(m),
                _ => None,
            })
            .collect();
        assert_eq!(mems.len(), 1);
        assert_eq!(mems[0].scope, CodexScope::User);
    }

    #[test]
    fn scan_project_surfaces_repo_agents_md() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path();
        write(&repo.join("AGENTS.md"), "# proj");
        let caps = scan_project(repo).unwrap();
        assert_eq!(caps.len(), 1);
        match &caps[0] {
            Capability::Memory(m) => {
                assert_eq!(m.scope, CodexScope::Project(repo.to_path_buf()))
            }
            _ => panic!(),
        }
    }

    #[test]
    fn malformed_config_toml_returns_error() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(&home.join(".codex/config.toml"), "not = toml = invalid");
        let err = scan_user(home).unwrap_err();
        assert!(matches!(err, CapabilityError::Frontmatter { .. }));
    }
}
