//! GitHub Copilot CLI adapter — discovers MCP servers and installed plugins.
//!
//! Per T1.b discovery, Copilot CLI 1.0.45 has NO native skills or slash-command
//! surface in the filesystem. It exposes only:
//!
//! - `~/.copilot/mcp-config.json` — MCP servers (JSON; either `mcpServers` or `servers` shape)
//! - `~/.copilot/installed-plugins/` — directory whose immediate subdirs are installed plugins
//! - `~/.copilot/settings.json` — user settings (out of scope for v0)
//!
//! There is currently only one scope: `User`. Copilot has no project scope yet.

use crate::model::{CapabilityError, CapabilityResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CopilotScope {
    User,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    /// `stdio`, `http`, `sse`, or other tool-defined kinds.
    pub kind: String,
    pub command: Option<String>,
    pub url: Option<String>,
    pub source_file: PathBuf,
    pub scope: CopilotScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledPlugin {
    pub name: String,
    pub path: PathBuf,
    pub scope: CopilotScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Capability {
    McpServer(McpServer),
    InstalledPlugin(InstalledPlugin),
}

/// Returns true if `~/.copilot/` exists. Used by UI to show a CTA when absent.
pub fn detect() -> bool {
    let Some(home) = dirs_home() else { return false };
    home.join(".copilot").is_dir()
}

/// Scan the user scope (`~/.copilot`) for MCP servers and installed plugins.
/// Returns an empty vec if `~/.copilot/` is absent.
pub fn scan_user(home: &Path) -> CapabilityResult<Vec<Capability>> {
    let root = home.join(".copilot");
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    scan_mcp_config(&root.join("mcp-config.json"), &mut out)?;
    scan_installed_plugins(&root.join("installed-plugins"), &mut out)?;
    Ok(out)
}

fn scan_mcp_config(path: &Path, out: &mut Vec<Capability>) -> CapabilityResult<()> {
    if !path.is_file() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| CapabilityError::Json(path.display().to_string(), e))?;
    // Accept either `mcpServers` (Claude-compatible) or `servers` (Copilot's own shape).
    let map = value
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .or_else(|| value.get("servers").and_then(|v| v.as_object()));
    let Some(map) = map else { return Ok(()) };
    for (name, server) in map {
        let kind = server
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("stdio")
            .to_string();
        let command = server.get("command").and_then(|v| v.as_str()).map(str::to_string);
        let url = server.get("url").and_then(|v| v.as_str()).map(str::to_string);
        out.push(Capability::McpServer(McpServer {
            name: name.clone(),
            kind,
            command,
            url,
            source_file: path.to_path_buf(),
            scope: CopilotScope::User,
        }));
    }
    Ok(())
}

fn scan_installed_plugins(dir: &Path, out: &mut Vec<Capability>) -> CapabilityResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    let rd = std::fs::read_dir(dir)?;
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else { continue };
        // Skip hidden dirs (.git, etc.)
        if name.starts_with('.') {
            continue;
        }
        out.push(Capability::InstalledPlugin(InstalledPlugin {
            name: name.to_string(),
            path: path.clone(),
            scope: CopilotScope::User,
        }));
    }
    Ok(())
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn missing_copilot_dir_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let caps = scan_user(tmp.path()).unwrap();
        assert!(caps.is_empty());
    }

    #[test]
    fn detect_false_when_absent() {
        // Point HOME at a fresh tempdir that has no .copilot.
        let tmp = TempDir::new().unwrap();
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());
        let result = detect();
        if let Some(p) = prev {
            std::env::set_var("HOME", p);
        }
        assert!(!result);
    }

    #[test]
    fn detect_true_when_dir_exists() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".copilot")).unwrap();
        let prev = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());
        let result = detect();
        if let Some(p) = prev {
            std::env::set_var("HOME", p);
        }
        assert!(result);
    }

    #[test]
    fn mcp_config_mcp_servers_shape() {
        let tmp = TempDir::new().unwrap();
        let cfg = serde_json::json!({
            "mcpServers": {
                "local": { "command": "node server.js", "type": "stdio" }
            }
        });
        write(&tmp.path().join(".copilot/mcp-config.json"), &cfg.to_string());
        let caps = scan_user(tmp.path()).unwrap();
        let mcps: Vec<_> = caps.iter().filter_map(|c| match c {
            Capability::McpServer(m) => Some(m), _ => None
        }).collect();
        assert_eq!(mcps.len(), 1);
        assert_eq!(mcps[0].name, "local");
        assert_eq!(mcps[0].kind, "stdio");
        assert_eq!(mcps[0].command.as_deref(), Some("node server.js"));
    }

    #[test]
    fn mcp_config_servers_shape_fallback() {
        let tmp = TempDir::new().unwrap();
        let cfg = serde_json::json!({
            "servers": {
                "remote": { "url": "https://example.com/mcp", "type": "http" }
            }
        });
        write(&tmp.path().join(".copilot/mcp-config.json"), &cfg.to_string());
        let caps = scan_user(tmp.path()).unwrap();
        let mcps: Vec<_> = caps.iter().filter_map(|c| match c {
            Capability::McpServer(m) => Some(m), _ => None
        }).collect();
        assert_eq!(mcps.len(), 1);
        assert_eq!(mcps[0].name, "remote");
        assert_eq!(mcps[0].kind, "http");
        assert_eq!(mcps[0].url.as_deref(), Some("https://example.com/mcp"));
    }

    #[test]
    fn multiple_mcp_servers_with_variants() {
        let tmp = TempDir::new().unwrap();
        let cfg = serde_json::json!({
            "mcpServers": {
                "a": { "command": "./a", "type": "stdio" },
                "b": { "url": "https://b.example", "type": "sse" },
                "c": { "command": "./c" }  // defaults to stdio
            }
        });
        write(&tmp.path().join(".copilot/mcp-config.json"), &cfg.to_string());
        let caps = scan_user(tmp.path()).unwrap();
        let mut mcps: Vec<_> = caps.iter().filter_map(|c| match c {
            Capability::McpServer(m) => Some(m), _ => None
        }).collect();
        mcps.sort_by(|x, y| x.name.cmp(&y.name));
        assert_eq!(mcps.len(), 3);
        assert_eq!(mcps[2].kind, "stdio"); // c defaults
    }

    #[test]
    fn installed_plugins_lists_subdirs_ignores_files() {
        let tmp = TempDir::new().unwrap();
        let plugins = tmp.path().join(".copilot/installed-plugins");
        std::fs::create_dir_all(plugins.join("plugin-a")).unwrap();
        std::fs::create_dir_all(plugins.join("plugin-b")).unwrap();
        std::fs::write(plugins.join("README.md"), "not a plugin").unwrap();
        let caps = scan_user(tmp.path()).unwrap();
        let mut plugins: Vec<_> = caps.iter().filter_map(|c| match c {
            Capability::InstalledPlugin(p) => Some(p.name.clone()), _ => None
        }).collect();
        plugins.sort();
        assert_eq!(plugins, vec!["plugin-a", "plugin-b"]);
    }

    #[test]
    fn empty_installed_plugins_returns_no_entries() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".copilot/installed-plugins")).unwrap();
        let caps = scan_user(tmp.path()).unwrap();
        let plugins: Vec<_> = caps.iter().filter(|c| matches!(c, Capability::InstalledPlugin(_))).collect();
        assert!(plugins.is_empty());
    }

    #[test]
    fn malformed_mcp_config_returns_json_error() {
        let tmp = TempDir::new().unwrap();
        write(&tmp.path().join(".copilot/mcp-config.json"), "{not valid json");
        let err = scan_user(tmp.path()).unwrap_err();
        assert!(matches!(err, CapabilityError::Json(_, _)));
    }

    #[test]
    fn copilot_dir_present_but_no_files_returns_empty() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".copilot")).unwrap();
        let caps = scan_user(tmp.path()).unwrap();
        assert!(caps.is_empty());
    }
}
