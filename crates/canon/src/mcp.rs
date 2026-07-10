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

/// Merge `canon-*`-namespaced server values into a JSON config file under
/// `top_key`, owning ONLY `canon-` keys and preserving every other key + all
/// other top-level config. Writes pretty JSON with a trailing newline.
pub(crate) fn merge_json_servers(
    path: &Path,
    top_key: &str,
    canon: &[(String, serde_json::Value)],
) -> Result<(), CanonError> {
    let mut root: serde_json::Value = if path.exists() {
        let raw = std::fs::read_to_string(path)?;
        match serde_json::from_str(&raw) {
            Ok(v) => v,
            // The file exists but isn't valid JSON: never clobber it. Leave
            // it untouched and no-op — projection_status will report this
            // file as not-synced until the user fixes it.
            Err(_) => return Ok(()),
        }
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
    let canon: Vec<(String, serde_json::Value)> = servers
        .iter()
        .map(|(n, s)| (n.clone(), claude_value(s)))
        .collect();
    merge_json_servers(&repo_root.join(".mcp.json"), "mcpServers", &canon)
}

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
    let canon: Vec<(String, serde_json::Value)> = servers
        .iter()
        .map(|(n, s)| (n.clone(), opencode_value(s)))
        .collect();
    merge_json_servers(&repo_root.join("opencode.json"), "mcp", &canon)
}

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
                toml::Value::Array(
                    srv.args
                        .iter()
                        .map(|a| toml::Value::String(a.clone()))
                        .collect(),
                ),
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
        // Never clobber an existing config we can't parse (a stray typo in the
        // user's config.toml must not destroy it) — leave it untouched.
        match toml::from_str(&std::fs::read_to_string(&path)?) {
            Ok(v) => v,
            Err(_) => return Ok(()),
        }
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
    let stale: Vec<String> = map
        .keys()
        .filter(|k| k.starts_with("canon-"))
        .cloned()
        .collect();
    for k in stale {
        map.remove(&k);
    }
    for (name, srv) in servers {
        map.insert(format!("canon-{name}"), codex_value(srv));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out =
        toml::to_string_pretty(&root).map_err(|e| CanonError::InvalidPackage(e.to_string()))?;
    std::fs::write(&path, out)?;
    Ok(())
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
            McpServer {
                command: Some("npx".into()),
                args: vec!["-y".into(), "ctx7".into()],
                ..Default::default()
            },
        )];
        project_mcp_claude(repo, &servers).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(repo.join(".mcp.json")).unwrap())
                .unwrap();
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
            serde_json::from_str(&std::fs::read_to_string(repo.join(".mcp.json")).unwrap())
                .unwrap();
        let m = v["mcpServers"].as_object().unwrap();
        assert!(m.contains_key("mine"));
        assert!(!m.contains_key("canon-old"), "stale canon server removed");
    }

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
            McpServer {
                command: Some("npx".into()),
                args: vec!["-y".into()],
                ..Default::default()
            },
        )];
        project_mcp_opencode(repo, &servers).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(repo.join("opencode.json")).unwrap())
                .unwrap();
        let m = v["mcp"].as_object().unwrap();
        assert!(m.contains_key("mine"), "user server preserved");
        let c = &m["canon-ctx7"];
        assert_eq!(c["type"], "local");
        assert_eq!(c["command"], serde_json::json!(["npx", "-y"]));
        assert_eq!(c["enabled"], true);
    }

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
            McpServer {
                command: Some("npx".into()),
                args: vec!["-y".into()],
                ..Default::default()
            },
        )];
        project_mcp_codex(repo, &servers).unwrap();

        let v: toml::Value =
            toml::from_str(&std::fs::read_to_string(repo.join(".codex/config.toml")).unwrap())
                .unwrap();
        let servers_tbl = v["mcp_servers"].as_table().unwrap();
        assert!(servers_tbl.contains_key("mine"), "user server preserved");
        assert_eq!(servers_tbl["canon-ctx7"]["command"].as_str(), Some("npx"));
        assert_eq!(
            v["model"]["name"].as_str(),
            Some("gpt"),
            "unrelated table preserved"
        );
    }

    #[test]
    fn project_mcp_codex_unparseable_existing_file_is_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        std::fs::create_dir_all(repo.join(".codex")).unwrap();
        let invalid = "[bad toml";
        std::fs::write(repo.join(".codex/config.toml"), invalid).unwrap();
        let servers = vec![(
            "ctx7".to_string(),
            McpServer {
                command: Some("npx".into()),
                ..Default::default()
            },
        )];

        let result = project_mcp_codex(repo, &servers);
        assert!(result.is_ok(), "must not error on unparseable file");

        let contents = std::fs::read_to_string(repo.join(".codex/config.toml")).unwrap();
        assert_eq!(
            contents, invalid,
            "unparseable user file must not be clobbered"
        );
    }

    #[test]
    fn project_mcp_claude_unparseable_existing_file_is_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        let invalid = "{ not valid json,";
        std::fs::write(repo.join(".mcp.json"), invalid).unwrap();
        let servers = vec![(
            "ctx7".to_string(),
            McpServer {
                command: Some("npx".into()),
                ..Default::default()
            },
        )];

        let result = project_mcp_claude(repo, &servers);
        assert!(result.is_ok(), "must not error on unparseable file");

        let contents = std::fs::read_to_string(repo.join(".mcp.json")).unwrap();
        assert_eq!(
            contents, invalid,
            "unparseable user file must not be clobbered"
        );
    }
}
