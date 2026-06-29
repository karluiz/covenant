//! Claude Code adapter — discovers skills, slash commands, hooks and MCP servers
//! from the three real-world locations confirmed in T1 / T1.b:
//!
//! - **Plugin** (read-only): `~/.claude/plugins/{cache,marketplaces}/<marketplace>/<plugin>/[<version>/]{skills,commands}/...`
//! - **User**: `~/.claude/{skills,commands}/...` and `~/.claude/settings.json`
//! - **Project**: `<repo>/.claude/{skills,commands}/...` and `<repo>/.claude/settings.json`

use crate::frontmatter::{self, Frontmatter};
use crate::model::{CapabilityError, CapabilityResult};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ClaudeScope {
    /// Read-only; lives inside ~/.claude/plugins/...
    Plugin {
        marketplace: String,
        plugin: String,
        version: Option<String>,
    },
    /// Writable; lives under ~/.claude/
    User,
    /// Writable; lives under <repo>/.claude/
    Project(PathBuf),
}

impl ClaudeScope {
    pub fn read_only(&self) -> bool {
        matches!(self, ClaudeScope::Plugin { .. })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub scope: ClaudeScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommand {
    pub name: String,
    pub description: Option<String>,
    pub path: PathBuf,
    pub scope: ClaudeScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hook {
    pub event: String,
    pub matcher: Option<String>,
    pub command: String,
    pub source_file: PathBuf,
    pub scope: ClaudeScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    /// `stdio`, `http`, `sse`, or other tool-defined kinds.
    pub kind: String,
    pub command: Option<String>,
    pub url: Option<String>,
    pub source_file: PathBuf,
    pub scope: ClaudeScope,
}

/// A subagent definition under `~/.claude/agents/*.md` or `<repo>/.claude/agents/*.md`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub scope: ClaudeScope,
}

/// An instruction/memory file (`CLAUDE.md`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    pub name: String,
    pub path: PathBuf,
    pub scope: ClaudeScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Capability {
    Skill(Skill),
    SlashCommand(SlashCommand),
    Hook(Hook),
    McpServer(McpServer),
    Agent(Agent),
    Memory(Memory),
}

/// Scan the user scope (`~/.claude`) for everything we know how to find.
pub fn scan_user(home: &Path) -> CapabilityResult<Vec<Capability>> {
    let root = home.join(".claude");
    let mut out = Vec::new();
    scan_skills_dir(&root.join("skills"), ClaudeScope::User, &mut out)?;
    scan_commands_dir(&root.join("commands"), ClaudeScope::User, &mut out)?;
    scan_agents_dir(&root.join("agents"), ClaudeScope::User, &mut out)?;
    scan_settings_json(&root.join("settings.json"), ClaudeScope::User, &mut out)?;
    scan_memory(&root.join("CLAUDE.md"), ClaudeScope::User, &mut out)?;
    Ok(out)
}

/// Scan a project scope rooted at `<repo>` (looks at `<repo>/.claude`).
pub fn scan_project(repo: &Path) -> CapabilityResult<Vec<Capability>> {
    let root = repo.join(".claude");
    let scope = ClaudeScope::Project(repo.to_path_buf());
    let mut out = Vec::new();
    scan_skills_dir(&root.join("skills"), scope.clone(), &mut out)?;
    scan_commands_dir(&root.join("commands"), scope.clone(), &mut out)?;
    scan_agents_dir(&root.join("agents"), scope.clone(), &mut out)?;
    scan_settings_json(&root.join("settings.json"), scope.clone(), &mut out)?;
    // Project memory lives at the repo root (`<repo>/CLAUDE.md`), not under `.claude`.
    scan_memory(&repo.join("CLAUDE.md"), scope, &mut out)?;
    Ok(out)
}

/// Scan `~/.claude/plugins/{cache,marketplaces}` for plugin-provided skills + commands.
/// Returns only skills/commands; plugin manifests carry hooks/MCPs elsewhere and are
/// out of scope for v0.
pub fn scan_plugins(home: &Path) -> CapabilityResult<Vec<Capability>> {
    let mut out = Vec::new();
    for parent in ["cache", "marketplaces"] {
        let root = home.join(".claude").join("plugins").join(parent);
        if !root.is_dir() {
            continue;
        }
        scan_plugins_recursive(&root, parent, &mut out)?;
    }
    Ok(out)
}

fn scan_plugins_recursive(
    root: &Path,
    _parent: &str,
    out: &mut Vec<Capability>,
) -> CapabilityResult<()> {
    for entry in walk(root) {
        // Detect a `skills/` or `commands/` dir whose parent path encodes plugin info.
        if !entry.is_dir() {
            continue;
        }
        let name = match entry.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };
        if name == "skills" {
            if let Some(scope) = plugin_scope_from_path(&entry) {
                scan_skills_dir(&entry, scope, out)?;
            }
        } else if name == "commands" {
            if let Some(scope) = plugin_scope_from_path(&entry) {
                scan_commands_dir(&entry, scope, out)?;
            }
        }
    }
    Ok(())
}

/// Given `.../plugins/<bucket>/<marketplace>/<plugin>[/<version>]/skills`, build a Plugin scope.
fn plugin_scope_from_path(skills_or_commands: &Path) -> Option<ClaudeScope> {
    let parent = skills_or_commands.parent()?;
    let parent_name = parent.file_name()?.to_str()?.to_string();
    let grandparent = parent.parent()?;
    let grandparent_name = grandparent.file_name()?.to_str()?.to_string();
    let great = grandparent.parent()?;
    let great_name = great.file_name()?.to_str()?.to_string();

    // Two layouts:
    //  cache/<marketplace>/<plugin>/<version>/skills    → great=plugin, grand=version… no, reversed
    // Concretely from real FS: cache/claude-plugins-official/superpowers/5.1.0/skills/
    //  parent=5.1.0, grand=superpowers, great=claude-plugins-official.
    //  marketplaces/<marketplace>/plugins/<plugin>/skills (no version)
    //  parent=<plugin>, grand=plugins, great=<marketplace>.
    if looks_like_version(&parent_name) {
        Some(ClaudeScope::Plugin {
            marketplace: great_name,
            plugin: grandparent_name,
            version: Some(parent_name),
        })
    } else if grandparent_name == "plugins" {
        Some(ClaudeScope::Plugin {
            marketplace: great_name,
            plugin: parent_name,
            version: None,
        })
    } else {
        // Layout we don't recognize — skip silently.
        None
    }
}

fn looks_like_version(s: &str) -> bool {
    // Permissive: starts with digit and contains a dot. Good enough for "5.1.0", "1.0.0".
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_ascii_digit()) && s.contains('.')
}

fn scan_skills_dir(
    dir: &Path,
    scope: ClaudeScope,
    out: &mut Vec<Capability>,
) -> CapabilityResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let raw = std::fs::read_to_string(&skill_md)?;
        let fm = frontmatter::parse(&raw);
        let fallback_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let name = fm.name().unwrap_or(&fallback_name).to_string();
        let description = fm.description().unwrap_or("").to_string();
        out.push(Capability::Skill(Skill {
            name,
            description,
            path: skill_md,
            scope: scope.clone(),
        }));
    }
    Ok(())
}

fn scan_commands_dir(
    dir: &Path,
    scope: ClaudeScope,
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
        let fm: Frontmatter = frontmatter::parse(&raw);
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let name = fm.name().map(str::to_string).unwrap_or(stem);
        let description = fm.description().map(str::to_string);
        out.push(Capability::SlashCommand(SlashCommand {
            name,
            description,
            path,
            scope: scope.clone(),
        }));
    }
    Ok(())
}

fn scan_agents_dir(
    dir: &Path,
    scope: ClaudeScope,
    out: &mut Vec<Capability>,
) -> CapabilityResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("md") {
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
        out.push(Capability::Agent(Agent {
            name,
            description,
            path,
            scope: scope.clone(),
        }));
    }
    Ok(())
}

fn scan_memory(path: &Path, scope: ClaudeScope, out: &mut Vec<Capability>) -> CapabilityResult<()> {
    if !path.is_file() {
        return Ok(());
    }
    out.push(Capability::Memory(Memory {
        name: "CLAUDE.md".to_string(),
        path: path.to_path_buf(),
        scope,
    }));
    Ok(())
}

fn scan_settings_json(
    path: &Path,
    scope: ClaudeScope,
    out: &mut Vec<Capability>,
) -> CapabilityResult<()> {
    if !path.is_file() {
        return Ok(());
    }
    let raw = std::fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| CapabilityError::Json(path.display().to_string(), e))?;
    extract_hooks(&value, path, &scope, out);
    extract_mcp_servers(&value, path, &scope, out);
    Ok(())
}

fn extract_hooks(
    value: &serde_json::Value,
    source: &Path,
    scope: &ClaudeScope,
    out: &mut Vec<Capability>,
) {
    // settings.json shape:
    // { "hooks": { "<EventName>": [ { "matcher": "...", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
    let Some(map) = value.get("hooks").and_then(|v| v.as_object()) else {
        return;
    };
    for (event, entries) in map {
        let Some(arr) = entries.as_array() else {
            continue;
        };
        for entry in arr {
            let matcher = entry
                .get("matcher")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let Some(inner) = entry.get("hooks").and_then(|v| v.as_array()) else {
                continue;
            };
            for h in inner {
                let Some(cmd) = h.get("command").and_then(|v| v.as_str()) else {
                    continue;
                };
                out.push(Capability::Hook(Hook {
                    event: event.clone(),
                    matcher: matcher.clone(),
                    command: cmd.to_string(),
                    source_file: source.to_path_buf(),
                    scope: scope.clone(),
                }));
            }
        }
    }
}

fn extract_mcp_servers(
    value: &serde_json::Value,
    source: &Path,
    scope: &ClaudeScope,
    out: &mut Vec<Capability>,
) {
    // settings.json shape: { "mcpServers": { "<name>": { "command": "...", "url": "...", "type": "stdio|http|sse" } } }
    let Some(map) = value.get("mcpServers").and_then(|v| v.as_object()) else {
        return;
    };
    for (name, server) in map {
        let kind = server
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("stdio")
            .to_string();
        let command = server
            .get("command")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let url = server
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        out.push(Capability::McpServer(McpServer {
            name: name.clone(),
            kind,
            command,
            url,
            source_file: source.to_path_buf(),
            scope: scope.clone(),
        }));
    }
}

fn walk(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // Avoid descending into .git or node_modules — large + never relevant.
                let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
                if matches!(name, ".git" | "node_modules") {
                    continue;
                }
                stack.push(path.clone());
            }
            out.push(path);
        }
    }
    out
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
    fn scan_user_finds_skills_and_commands() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(
            &home.join(".claude/skills/my-skill/SKILL.md"),
            "---\nname: my-skill\ndescription: does X\n---\nbody",
        );
        write(
            &home.join(".claude/commands/foo.md"),
            "---\nname: foo\ndescription: foo cmd\n---\nbody",
        );

        let caps = scan_user(home).unwrap();
        assert_eq!(caps.len(), 2);
        let skill = caps
            .iter()
            .find_map(|c| {
                if let Capability::Skill(s) = c {
                    Some(s)
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(skill.name, "my-skill");
        assert_eq!(skill.description, "does X");
        assert_eq!(skill.scope, ClaudeScope::User);
        assert!(!skill.scope.read_only());
        assert!(caps
            .iter()
            .any(|c| matches!(c, Capability::SlashCommand(_))));
    }

    #[test]
    fn scan_user_falls_back_to_dir_name_when_no_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(
            &home.join(".claude/skills/no-fm/SKILL.md"),
            "no frontmatter here",
        );
        let caps = scan_user(home).unwrap();
        let Capability::Skill(s) = &caps[0] else {
            panic!("expected skill");
        };
        assert_eq!(s.name, "no-fm");
        assert_eq!(s.description, "");
    }

    #[test]
    fn scan_user_skips_skill_dir_without_skill_md() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        // Directory exists but no SKILL.md.
        fs::create_dir_all(home.join(".claude/skills/empty")).unwrap();
        let caps = scan_user(home).unwrap();
        assert!(caps.is_empty());
    }

    #[test]
    fn scan_user_handles_missing_claude_dir() {
        let tmp = TempDir::new().unwrap();
        let caps = scan_user(tmp.path()).unwrap();
        assert!(caps.is_empty());
    }

    #[test]
    fn scan_user_extracts_hooks_and_mcp_servers() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let settings = serde_json::json!({
            "hooks": {
                "SessionStart": [
                    {
                        "matcher": "*",
                        "hooks": [
                            { "type": "command", "command": "echo hi" }
                        ]
                    }
                ]
            },
            "mcpServers": {
                "ctx7": { "command": "npx context7", "type": "stdio" },
                "remote": { "url": "https://example.com/mcp", "type": "http" }
            }
        });
        write(&home.join(".claude/settings.json"), &settings.to_string());

        let caps = scan_user(home).unwrap();
        let hooks: Vec<_> = caps
            .iter()
            .filter_map(|c| match c {
                Capability::Hook(h) => Some(h),
                _ => None,
            })
            .collect();
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].event, "SessionStart");
        assert_eq!(hooks[0].matcher.as_deref(), Some("*"));
        assert_eq!(hooks[0].command, "echo hi");

        let mcps: Vec<_> = caps
            .iter()
            .filter_map(|c| match c {
                Capability::McpServer(m) => Some(m),
                _ => None,
            })
            .collect();
        assert_eq!(mcps.len(), 2);
        let names: Vec<&str> = mcps.iter().map(|m| m.name.as_str()).collect();
        assert!(names.contains(&"ctx7"));
        assert!(names.contains(&"remote"));
    }

    #[test]
    fn scan_user_finds_agents_and_memory() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        std::fs::create_dir_all(home.join(".claude/agents")).unwrap();
        std::fs::write(
            home.join(".claude/agents/reviewer.md"),
            "---\nname: reviewer\ndescription: reviews code\n---\nbody",
        )
        .unwrap();
        std::fs::write(home.join(".claude/CLAUDE.md"), "# memory\n").unwrap();
        let caps = scan_user(home).unwrap();
        let agent = caps.iter().find_map(|c| match c {
            Capability::Agent(a) => Some(a),
            _ => None,
        });
        assert_eq!(agent.unwrap().name, "reviewer");
        assert!(caps
            .iter()
            .any(|c| matches!(c, Capability::Memory(m) if m.name == "CLAUDE.md")));
    }

    #[test]
    fn scan_project_uses_repo_scope() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path();
        write(
            &repo.join(".claude/skills/proj-skill/SKILL.md"),
            "---\nname: proj-skill\ndescription: project-level\n---\n",
        );
        let caps = scan_project(repo).unwrap();
        let Capability::Skill(s) = &caps[0] else {
            panic!()
        };
        assert_eq!(s.scope, ClaudeScope::Project(repo.to_path_buf()));
        assert!(!s.scope.read_only());
    }

    #[test]
    fn scan_plugins_detects_versioned_cache_layout() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        // ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<name>/SKILL.md
        write(
            &home.join(".claude/plugins/cache/mkt-a/superpowers/5.1.0/skills/foo/SKILL.md"),
            "---\nname: foo\ndescription: plugin skill\n---\n",
        );
        let caps = scan_plugins(home).unwrap();
        let skills: Vec<_> = caps
            .iter()
            .filter_map(|c| match c {
                Capability::Skill(s) => Some(s),
                _ => None,
            })
            .collect();
        assert_eq!(skills.len(), 1);
        let s = skills[0];
        assert_eq!(s.name, "foo");
        match &s.scope {
            ClaudeScope::Plugin {
                marketplace,
                plugin,
                version,
            } => {
                assert_eq!(marketplace, "mkt-a");
                assert_eq!(plugin, "superpowers");
                assert_eq!(version.as_deref(), Some("5.1.0"));
            }
            _ => panic!("expected plugin scope"),
        }
        assert!(s.scope.read_only());
    }

    #[test]
    fn scan_plugins_detects_marketplace_unversioned_layout() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        // ~/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/commands/cmd.md
        write(
            &home.join(".claude/plugins/marketplaces/mkt-b/plugins/hookify/commands/list.md"),
            "---\nname: list\n---\nbody",
        );
        let caps = scan_plugins(home).unwrap();
        let cmds: Vec<_> = caps
            .iter()
            .filter_map(|c| match c {
                Capability::SlashCommand(c) => Some(c),
                _ => None,
            })
            .collect();
        assert_eq!(cmds.len(), 1);
        match &cmds[0].scope {
            ClaudeScope::Plugin {
                marketplace,
                plugin,
                version,
            } => {
                assert_eq!(marketplace, "mkt-b");
                assert_eq!(plugin, "hookify");
                assert_eq!(version, &None);
            }
            _ => panic!("expected plugin scope"),
        }
    }

    #[test]
    fn malformed_settings_json_returns_error() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(&home.join(".claude/settings.json"), "{ not json");
        let err = scan_user(home).unwrap_err();
        assert!(matches!(err, CapabilityError::Json(_, _)));
    }

    #[test]
    fn read_only_flag_only_for_plugin_scope() {
        assert!(ClaudeScope::Plugin {
            marketplace: "m".into(),
            plugin: "p".into(),
            version: None
        }
        .read_only());
        assert!(!ClaudeScope::User.read_only());
        assert!(!ClaudeScope::Project("/tmp".into()).read_only());
    }
}
