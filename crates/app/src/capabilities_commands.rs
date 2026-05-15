//! Tauri commands for the Capabilities panel (T7–T9).
//!
//! Bridges the `karl-capabilities` crate to the UI: flat list across tools,
//! raw file read for editing, atomic writes, deletion (with `.bak` snapshot),
//! and template scaffolding. Plugin scope (under `~/.claude/plugins`) is
//! treated as read-only — writes/deletes there are rejected.

use std::path::{Path, PathBuf};

use karl_capabilities::adapters::{claude, codex, copilot, opencode, shared};
use karl_capabilities::model::{Kind, Tool};
use karl_capabilities::scaffold::{render, ScaffoldRequest};
use karl_capabilities::writer::{delete_with_backup, write_atomic};
use serde::Serialize;

/// Flat record handed to the UI. The UI never inspects discriminants —
/// it just renders `tool` / `kind` / `scope_label` / `read_only`.
#[derive(Debug, Clone, Serialize)]
pub struct CapabilityListItem {
    pub id: String,
    pub tool: String,
    pub kind: String,
    pub name: String,
    pub description: Option<String>,
    pub path: String,
    pub scope_label: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectResult {
    pub claude: bool,
    pub copilot: bool,
    pub opencode: bool,
    pub codex: bool,
    pub shared: bool,
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME not set".to_string())
}

fn scope_label_claude(scope: &claude::ClaudeScope) -> (String, bool) {
    match scope {
        claude::ClaudeScope::User => ("user".to_string(), false),
        claude::ClaudeScope::Project(p) => {
            let name = p
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("project")
                .to_string();
            (format!("project:{name}"), false)
        }
        claude::ClaudeScope::Plugin { marketplace, plugin, version } => {
            let v = version.as_deref().map(|v| format!("@{v}")).unwrap_or_default();
            (format!("plugin:{marketplace}/{plugin}{v}"), true)
        }
    }
}

fn item_from_claude(c: claude::Capability) -> CapabilityListItem {
    match c {
        claude::Capability::Skill(s) => {
            let (scope_label, read_only) = scope_label_claude(&s.scope);
            let path = s.path.to_string_lossy().into_owned();
            CapabilityListItem {
                id: format!("claude:{path}"),
                tool: "claude".into(),
                kind: "skill".into(),
                name: s.name,
                description: Some(s.description),
                path,
                scope_label,
                read_only,
            }
        }
        claude::Capability::SlashCommand(c) => {
            let (scope_label, read_only) = scope_label_claude(&c.scope);
            let path = c.path.to_string_lossy().into_owned();
            CapabilityListItem {
                id: format!("claude:{path}"),
                tool: "claude".into(),
                kind: "command".into(),
                name: c.name,
                description: c.description,
                path,
                scope_label,
                read_only,
            }
        }
        claude::Capability::Hook(h) => {
            let (scope_label, read_only) = scope_label_claude(&h.scope);
            let path = h.source_file.to_string_lossy().into_owned();
            CapabilityListItem {
                // hooks are inside settings.json — disambiguate the id with event+command
                id: format!("claude:hook:{path}:{}:{}", h.event, h.command),
                tool: "claude".into(),
                kind: "hook".into(),
                name: format!("{} [{}]", h.event, h.matcher.as_deref().unwrap_or("*")),
                description: Some(h.command),
                path,
                scope_label,
                read_only,
            }
        }
        claude::Capability::McpServer(m) => {
            let (scope_label, read_only) = scope_label_claude(&m.scope);
            let path = m.source_file.to_string_lossy().into_owned();
            CapabilityListItem {
                id: format!("claude:mcp:{path}:{}", m.name),
                tool: "claude".into(),
                kind: "mcp".into(),
                name: m.name,
                description: Some(format!(
                    "{} {}",
                    m.kind,
                    m.command.or(m.url).unwrap_or_default()
                )),
                path,
                scope_label,
                read_only,
            }
        }
    }
}

fn item_from_copilot(c: copilot::Capability) -> CapabilityListItem {
    match c {
        copilot::Capability::McpServer(m) => {
            let path = m.source_file.to_string_lossy().into_owned();
            CapabilityListItem {
                id: format!("copilot:mcp:{path}:{}", m.name),
                tool: "copilot".into(),
                kind: "mcp".into(),
                name: m.name,
                description: Some(format!(
                    "{} {}",
                    m.kind,
                    m.command.or(m.url).unwrap_or_default()
                )),
                path,
                scope_label: "user".into(),
                read_only: false,
            }
        }
        copilot::Capability::InstalledPlugin(p) => {
            let path = p.path.to_string_lossy().into_owned();
            let mut desc_parts = Vec::new();
            if let Some(m) = &p.marketplace {
                desc_parts.push(m.clone());
            }
            if let Some(v) = &p.version {
                desc_parts.push(format!("v{v}"));
            }
            if !p.enabled {
                desc_parts.push("disabled".to_string());
            }
            let description = if desc_parts.is_empty() {
                None
            } else {
                Some(desc_parts.join(" · "))
            };
            CapabilityListItem {
                id: format!("copilot:plugin:{path}"),
                tool: "copilot".into(),
                kind: "plugin".into(),
                name: p.name,
                description,
                path,
                scope_label: "user".into(),
                read_only: true,
            }
        }
    }
}

fn item_from_opencode(c: opencode::Capability) -> CapabilityListItem {
    let scope_label = |s: &opencode::OpencodeScope| match s {
        opencode::OpencodeScope::User => "user".to_string(),
        opencode::OpencodeScope::Project(p) => {
            let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("project");
            format!("project:{name}")
        }
    };
    match c {
        opencode::Capability::Agent(a) => {
            let lbl = scope_label(&a.scope);
            let path = a.path.to_string_lossy().into_owned();
            CapabilityListItem {
                id: format!("opencode:{path}"),
                tool: "opencode".into(),
                kind: "agent".into(),
                name: a.name,
                description: Some(a.description),
                path,
                scope_label: lbl,
                read_only: false,
            }
        }
        opencode::Capability::McpServer(m) => {
            let lbl = scope_label(&m.scope);
            let path = m.source_file.to_string_lossy().into_owned();
            CapabilityListItem {
                id: format!("opencode:mcp:{path}:{}", m.name),
                tool: "opencode".into(),
                kind: "mcp".into(),
                name: m.name,
                description: Some(format!(
                    "{} {}",
                    m.kind,
                    m.command
                        .map(|v| v.join(" "))
                        .or(m.url)
                        .unwrap_or_default()
                )),
                path,
                scope_label: lbl,
                read_only: false,
            }
        }
    }
}

fn item_from_codex(c: codex::Capability) -> CapabilityListItem {
    let scope_label = |s: &codex::CodexScope| match s {
        codex::CodexScope::User => "user".to_string(),
        codex::CodexScope::Project(p) => format!(
            "project:{}",
            p.file_name().and_then(|s| s.to_str()).unwrap_or("project")
        ),
    };
    match c {
        codex::Capability::McpServer(m) => {
            let path = m.source_file.to_string_lossy().into_owned();
            let lbl = scope_label(&m.scope);
            let desc = m
                .command
                .map(|c| {
                    format!(
                        "{c} {}",
                        m.args.as_ref().map(|a| a.join(" ")).unwrap_or_default()
                    )
                })
                .or(m.url)
                .unwrap_or_default();
            CapabilityListItem {
                id: format!("codex:mcp:{path}:{}", m.name),
                tool: "codex".into(),
                kind: "mcp".into(),
                name: m.name,
                description: Some(desc),
                path,
                scope_label: lbl,
                read_only: false,
            }
        }
        codex::Capability::Prompt(p) => {
            let path = p.path.to_string_lossy().into_owned();
            let lbl = scope_label(&p.scope);
            CapabilityListItem {
                id: format!("codex:prompt:{path}"),
                tool: "codex".into(),
                kind: "command".into(),
                name: p.name,
                description: Some(p.description),
                path,
                scope_label: lbl,
                read_only: false,
            }
        }
        codex::Capability::Memory(m) => {
            let path = m.path.to_string_lossy().into_owned();
            let lbl = scope_label(&m.scope);
            CapabilityListItem {
                id: format!("codex:memory:{path}"),
                tool: "codex".into(),
                kind: "memory".into(),
                name: m.name,
                description: Some("AGENTS.md memory".to_string()),
                path,
                scope_label: lbl,
                read_only: false,
            }
        }
    }
}

fn item_from_shared(s: shared::SharedSkill) -> CapabilityListItem {
    let path = s.path.to_string_lossy().into_owned();
    let scope_label = match (s.source.as_deref(), s.version.as_deref()) {
        (Some(src), Some(v)) => format!("shared:{src}@{v}"),
        (Some(src), None) => format!("shared:{src}"),
        _ => "shared".to_string(),
    };
    CapabilityListItem {
        id: format!("shared:{path}"),
        tool: "shared".into(),
        kind: "skill".into(),
        name: s.name,
        description: Some(s.description),
        path,
        scope_label,
        read_only: false,
    }
}

fn aggregate(project_root: Option<String>) -> Result<Vec<CapabilityListItem>, String> {
    let home = home()?;
    let mut out = Vec::new();

    // Claude: user + plugins + (optional) project.
    out.extend(
        claude::scan_user(&home)
            .map_err(|e| format!("claude scan_user: {e}"))?
            .into_iter()
            .map(item_from_claude),
    );
    out.extend(
        claude::scan_plugins(&home)
            .map_err(|e| format!("claude scan_plugins: {e}"))?
            .into_iter()
            .map(item_from_claude),
    );

    // Copilot: user only.
    out.extend(
        copilot::scan_user(&home)
            .map_err(|e| format!("copilot scan_user: {e}"))?
            .into_iter()
            .map(item_from_copilot),
    );

    // Opencode: user + (optional) project.
    out.extend(
        opencode::scan_user(&home)
            .map_err(|e| format!("opencode scan_user: {e}"))?
            .into_iter()
            .map(item_from_opencode),
    );

    // Codex: user scope (config.toml, prompts, AGENTS.md).
    out.extend(
        codex::scan_user(&home)
            .map_err(|e| format!("codex scan_user: {e}"))?
            .into_iter()
            .map(item_from_codex),
    );

    // Shared ~/.agents/skills.
    out.extend(
        shared::scan(&home)
            .map_err(|e| format!("shared scan: {e}"))?
            .into_iter()
            .map(item_from_shared),
    );

    if let Some(root) = project_root {
        let p = PathBuf::from(&root);
        if p.is_dir() {
            out.extend(
                claude::scan_project(&p)
                    .map_err(|e| format!("claude scan_project: {e}"))?
                    .into_iter()
                    .map(item_from_claude),
            );
            out.extend(
                opencode::scan_project(&p)
                    .map_err(|e| format!("opencode scan_project: {e}"))?
                    .into_iter()
                    .map(item_from_opencode),
            );
            out.extend(
                codex::scan_project(&p)
                    .map_err(|e| format!("codex scan_project: {e}"))?
                    .into_iter()
                    .map(item_from_codex),
            );
        }
    }

    Ok(out)
}

fn is_plugin_path(path: &Path, home: &Path) -> bool {
    path.starts_with(home.join(".claude").join("plugins"))
}

#[tauri::command]
pub async fn capabilities_list(
    project_root: Option<String>,
) -> Result<Vec<CapabilityListItem>, String> {
    tokio::task::spawn_blocking(move || aggregate(project_root))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
pub async fn capabilities_list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let p = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || -> Result<Vec<DirEntry>, String> {
        let rd = std::fs::read_dir(&p).map_err(|e| format!("{}: {e}", p.display()))?;
        let mut out = Vec::new();
        for entry in rd.flatten() {
            let name = match entry.file_name().to_str() {
                Some(s) => s.to_string(),
                None => continue,
            };
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            out.push(DirEntry {
                name,
                is_dir: meta.is_dir(),
                size: if meta.is_file() { meta.len() } else { 0 },
            });
        }
        out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn capabilities_read(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || std::fs::read_to_string(&p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub async fn capabilities_write(path: String, contents: String) -> Result<(), String> {
    let h = home()?;
    let p = PathBuf::from(&path);
    if is_plugin_path(&p, &h) {
        return Err("plugin-scoped capabilities are read-only".to_string());
    }
    tokio::task::spawn_blocking(move || write_atomic(&p, &contents))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn capabilities_delete(path: String) -> Result<(), String> {
    let h = home()?;
    let p = PathBuf::from(&path);
    if is_plugin_path(&p, &h) {
        return Err("plugin-scoped capabilities are read-only".to_string());
    }
    tokio::task::spawn_blocking(move || delete_with_backup(&p))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

fn parse_tool(s: &str) -> Result<Tool, String> {
    match s {
        "claude" => Ok(Tool::Claude),
        "copilot" => Ok(Tool::Copilot),
        "opencode" => Ok(Tool::Opencode),
        "codex" => Ok(Tool::Codex),
        "shared" => Ok(Tool::Shared),
        other => Err(format!("unknown tool: {other}")),
    }
}

fn parse_kind(s: &str) -> Result<Kind, String> {
    match s {
        "skill" => Ok(Kind::Skill),
        "command" => Ok(Kind::SlashCommand),
        "hook" => Ok(Kind::Hook),
        "mcp" => Ok(Kind::McpServer),
        other => Err(format!("unknown kind: {other}")),
    }
}

fn scaffold_target(
    tool: Tool,
    kind: Kind,
    name: &str,
    project_root: Option<&Path>,
    home: &Path,
) -> Result<PathBuf, String> {
    if name.trim().is_empty() {
        return Err("name must not be empty".into());
    }
    let p = match (tool, kind) {
        (Tool::Claude, Kind::Skill) => match project_root {
            Some(root) => root.join(".claude/skills").join(name).join("SKILL.md"),
            None => home.join(".claude/skills").join(name).join("SKILL.md"),
        },
        (Tool::Claude, Kind::SlashCommand) => match project_root {
            Some(root) => root.join(".claude/commands").join(format!("{name}.md")),
            None => home.join(".claude/commands").join(format!("{name}.md")),
        },
        (Tool::Opencode, Kind::Skill) => match project_root {
            Some(root) => root.join(".opencode/agent").join(format!("{name}.md")),
            None => home.join(".config/opencode/agent").join(format!("{name}.md")),
        },
        (Tool::Shared, Kind::Skill) => home.join(".agents/skills").join(name).join("SKILL.md"),
        (Tool::Codex, Kind::SlashCommand) => {
            home.join(".codex/prompts").join(format!("{name}.md"))
        }
        (Tool::Codex, Kind::McpServer) => {
            home.join(format!(".codex/scaffolded-{name}.json"))
        }
        // Hooks / MCPs: write a snippet file for the user to paste into their settings.json.
        // We intentionally do NOT auto-merge in v0 (avoids clobbering hand-edited JSON).
        (Tool::Claude, Kind::Hook) | (Tool::Claude, Kind::McpServer) | (Tool::Copilot, Kind::McpServer) => {
            let ext = "json";
            home.join(format!(".claude/scaffolded-{name}.{ext}"))
        }
        _ => return Err("unsupported tool/kind combo".into()),
    };
    Ok(p)
}

#[tauri::command]
pub async fn capabilities_scaffold(
    tool: String,
    kind: String,
    name: String,
    description: String,
    project_root: Option<String>,
) -> Result<String, String> {
    let t = parse_tool(&tool)?;
    let k = parse_kind(&kind)?;
    let h = home()?;
    let root = project_root.as_deref().map(PathBuf::from);
    let body = render(&ScaffoldRequest {
        tool: t,
        kind: k,
        name: &name,
        description: &description,
    })
    .ok_or_else(|| "unsupported tool/kind combo".to_string())?;
    let target = scaffold_target(t, k, &name, root.as_deref(), &h)?;
    let target_for_blocking = target.clone();
    tokio::task::spawn_blocking(move || write_atomic(&target_for_blocking, &body))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn capabilities_detect() -> Result<DetectResult, String> {
    let h = home()?;
    let h_clone = h.clone();
    tokio::task::spawn_blocking(move || DetectResult {
        claude: h_clone.join(".claude").is_dir(),
        copilot: h_clone.join(".copilot").is_dir(),
        opencode: h_clone.join(".config/opencode").is_dir()
            || h_clone.join(".opencode/bin/opencode").is_file(),
        codex: codex::detect(&h_clone),
        shared: shared::detect(&h_clone),
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn aggregate_runs_against_home_without_panic() {
        // Smoke test: just verify the aggregation against the real $HOME
        // does not panic and returns a Vec (length may be zero on CI).
        let result = aggregate(None);
        assert!(result.is_ok(), "aggregate failed: {:?}", result.err());
    }

    #[tokio::test]
    async fn detect_returns_struct() {
        let r = capabilities_detect().await.unwrap();
        // Fields are bool; just confirm we can read them.
        let _ = (r.claude, r.copilot, r.opencode, r.codex, r.shared);
    }

    #[test]
    fn scaffold_target_claude_skill_user() {
        let home = PathBuf::from("/h");
        let p = scaffold_target(Tool::Claude, Kind::Skill, "foo", None, &home).unwrap();
        assert_eq!(p, PathBuf::from("/h/.claude/skills/foo/SKILL.md"));
    }

    #[test]
    fn scaffold_target_claude_skill_project() {
        let home = PathBuf::from("/h");
        let root = PathBuf::from("/repo");
        let p = scaffold_target(Tool::Claude, Kind::Skill, "foo", Some(&root), &home).unwrap();
        assert_eq!(p, PathBuf::from("/repo/.claude/skills/foo/SKILL.md"));
    }

    #[test]
    fn scaffold_target_rejects_empty_name() {
        let home = PathBuf::from("/h");
        assert!(scaffold_target(Tool::Claude, Kind::Skill, "  ", None, &home).is_err());
    }

    #[test]
    fn scaffold_target_copilot_skill_unsupported() {
        let home = PathBuf::from("/h");
        assert!(scaffold_target(Tool::Copilot, Kind::Skill, "x", None, &home).is_err());
    }
}
