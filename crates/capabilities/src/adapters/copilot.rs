//! GitHub Copilot CLI adapter — discovers MCP servers and installed plugins.
//!
//! Per T1.b discovery, Copilot CLI 1.0.45 has NO native skills or slash-command
//! surface in the filesystem. It exposes only:
//!
//! - `~/.copilot/mcp-config.json` — MCP servers (JSON; either `mcpServers` or `servers` shape)
//! - `~/.copilot/config.json` — authoritative `installedPlugins[]` list (name, marketplace,
//!   version, enabled, cache_path). Read first.
//! - `~/.copilot/installed-plugins/<marketplace>/<plugin>/` — physical plugin dirs;
//!   used as a fallback when `config.json` is absent or has no `installedPlugins`.
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
    pub marketplace: Option<String>,
    pub version: Option<String>,
    pub enabled: bool,
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
    let plugins_dir = root.join("installed-plugins");
    let added = scan_plugins_from_config(&root.join("config.json"), &mut out)?;
    if !added {
        scan_installed_plugins_fs(&plugins_dir, &mut out)?;
    }
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

/// Read `~/.copilot/config.json` and emit one `InstalledPlugin` per entry in
/// `installedPlugins[]`. Returns `Ok(true)` if the array existed (even if empty),
/// so the caller knows not to fall back to a filesystem scan.
fn scan_plugins_from_config(path: &Path, out: &mut Vec<Capability>) -> CapabilityResult<bool> {
    if !path.is_file() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(path)?;
    // config.json may contain a leading `//` comment line; strip lines that start with `//`.
    let cleaned: String = raw
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    let value: serde_json::Value = serde_json::from_str(&cleaned)
        .map_err(|e| CapabilityError::Json(path.display().to_string(), e))?;
    let Some(arr) = value.get("installedPlugins").and_then(|v| v.as_array()) else {
        return Ok(false);
    };
    for p in arr {
        let Some(name) = p.get("name").and_then(|v| v.as_str()) else { continue };
        let cache_path = p
            .get("cache_path")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_default();
        let marketplace = p
            .get("marketplace")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let version = p.get("version").and_then(|v| v.as_str()).map(str::to_string);
        let enabled = p.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
        out.push(Capability::InstalledPlugin(InstalledPlugin {
            name: name.to_string(),
            path: cache_path,
            scope: CopilotScope::User,
            marketplace,
            version,
            enabled,
        }));
    }
    Ok(true)
}

/// Filesystem fallback: walk `installed-plugins/<marketplace>/<plugin>/`.
/// Used only when `config.json` is missing or has no `installedPlugins`.
fn scan_installed_plugins_fs(dir: &Path, out: &mut Vec<Capability>) -> CapabilityResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)?.flatten() {
        let market_path = entry.path();
        if !market_path.is_dir() {
            continue;
        }
        let Some(marketplace) = market_path.file_name().and_then(|s| s.to_str()) else { continue };
        if marketplace.starts_with('.') {
            continue;
        }
        for sub in std::fs::read_dir(&market_path)?.flatten() {
            let plugin_path = sub.path();
            if !plugin_path.is_dir() {
                continue;
            }
            let Some(name) = plugin_path.file_name().and_then(|s| s.to_str()) else { continue };
            if name.starts_with('.') {
                continue;
            }
            out.push(Capability::InstalledPlugin(InstalledPlugin {
                name: name.to_string(),
                path: plugin_path.clone(),
                scope: CopilotScope::User,
                marketplace: Some(marketplace.to_string()),
                version: None,
                enabled: true,
            }));
        }
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
    fn installed_plugins_from_config_json() {
        let tmp = TempDir::new().unwrap();
        let cfg = serde_json::json!({
            "installedPlugins": [
                {
                    "name": "frontend-design",
                    "marketplace": "claude-code-plugins",
                    "version": "1.0.0",
                    "enabled": true,
                    "cache_path": "/abs/claude-code-plugins/frontend-design"
                },
                {
                    "name": "anvil",
                    "marketplace": "",
                    "version": "1.0.0",
                    "enabled": false,
                    "cache_path": "/abs/_direct/burkeholland--anvil"
                }
            ]
        });
        write(&tmp.path().join(".copilot/config.json"), &cfg.to_string());
        let caps = scan_user(tmp.path()).unwrap();
        let mut plugins: Vec<_> = caps.iter().filter_map(|c| match c {
            Capability::InstalledPlugin(p) => Some(p.clone()), _ => None
        }).collect();
        plugins.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].name, "anvil");
        assert_eq!(plugins[0].marketplace, None);
        assert!(!plugins[0].enabled);
        assert_eq!(plugins[1].name, "frontend-design");
        assert_eq!(plugins[1].marketplace.as_deref(), Some("claude-code-plugins"));
        assert_eq!(plugins[1].version.as_deref(), Some("1.0.0"));
    }

    #[test]
    fn config_json_with_leading_comment_is_parsed() {
        let tmp = TempDir::new().unwrap();
        let body = "// managed automatically\n{\"installedPlugins\":[{\"name\":\"p\",\"marketplace\":\"m\",\"cache_path\":\"/x\"}]}";
        write(&tmp.path().join(".copilot/config.json"), body);
        let caps = scan_user(tmp.path()).unwrap();
        let plugins: Vec<_> = caps.iter().filter_map(|c| match c {
            Capability::InstalledPlugin(p) => Some(p.name.clone()), _ => None
        }).collect();
        assert_eq!(plugins, vec!["p"]);
    }

    #[test]
    fn fs_fallback_walks_marketplace_subdirs() {
        let tmp = TempDir::new().unwrap();
        let plugins = tmp.path().join(".copilot/installed-plugins");
        std::fs::create_dir_all(plugins.join("claude-code-plugins/frontend-design")).unwrap();
        std::fs::create_dir_all(plugins.join("_direct/burkeholland--anvil")).unwrap();
        std::fs::write(plugins.join("README.md"), "stray").unwrap();
        let caps = scan_user(tmp.path()).unwrap();
        let mut names: Vec<_> = caps.iter().filter_map(|c| match c {
            Capability::InstalledPlugin(p) => Some(p.name.clone()), _ => None
        }).collect();
        names.sort();
        assert_eq!(names, vec!["burkeholland--anvil", "frontend-design"]);
    }

    #[test]
    fn config_json_takes_precedence_over_fs() {
        let tmp = TempDir::new().unwrap();
        let plugins = tmp.path().join(".copilot/installed-plugins");
        std::fs::create_dir_all(plugins.join("market/from-fs")).unwrap();
        let cfg = serde_json::json!({
            "installedPlugins": [
                {"name": "from-config", "marketplace": "m", "cache_path": "/x"}
            ]
        });
        write(&tmp.path().join(".copilot/config.json"), &cfg.to_string());
        let caps = scan_user(tmp.path()).unwrap();
        let names: Vec<_> = caps.iter().filter_map(|c| match c {
            Capability::InstalledPlugin(p) => Some(p.name.clone()), _ => None
        }).collect();
        assert_eq!(names, vec!["from-config"]);
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
