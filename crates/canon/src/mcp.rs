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
