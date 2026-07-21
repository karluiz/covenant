//! Detection is projection run backwards: read the executor dirs that
//! `project()` writes to and surface items Canon did NOT put there (no source
//! under `.covenant/canon/`). Reuses project.rs's dir constants as the single
//! source of truth for "where executors read".

use crate::kind::{ContextKind, ContextUnit};
use crate::manifest::canon_dir;
use crate::project::{parse_frontmatter_str, read_dir_md, AGENT_DIRS, COMMAND_DIRS, SKILL_DIRS};
use crate::CanonError;
use std::collections::HashSet;
use std::path::Path;

/// A file-per-item `.md` executor dir (agents, commands): a `<stem>.md` is
/// foreign when no `<stem>.md` exists under the matching Canon source dir.
fn scan_file_per_item(
    repo_root: &Path,
    dirs: &[&str],
    kind: ContextKind,
    seen: &mut HashSet<String>,
    out: &mut Vec<ContextUnit>,
) -> Result<(), CanonError> {
    let source: HashSet<String> = read_dir_md(&canon_dir(repo_root).join(kind.dir()))?
        .into_iter()
        .map(|(stem, _)| stem)
        .collect();
    for base in dirs {
        for (stem, raw) in read_dir_md(&repo_root.join(base))? {
            if source.contains(&stem) || !seen.insert(stem.clone()) {
                continue;
            }
            out.push(ContextUnit {
                kind,
                summary: parse_frontmatter_str(&raw, "description"),
                name: stem,
                projectable: true,
                packageable: kind == ContextKind::Agent || kind == ContextKind::Command,
                detected_in: Some(base.to_string()),
            });
        }
    }
    Ok(())
}

/// A `canon-`-prefixed dir is a Canon projection; any other skill dir is foreign.
fn scan_skills(repo_root: &Path, out: &mut Vec<ContextUnit>) -> Result<(), CanonError> {
    let mut seen = HashSet::new();
    for base in SKILL_DIRS {
        let dir = repo_root.join(base);
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries {
            let path = entry?.path();
            if !path.is_dir() {
                continue;
            }
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if name.starts_with("canon-") || !seen.insert(name.clone()) {
                continue;
            }
            let summary = std::fs::read_to_string(path.join("SKILL.md"))
                .ok()
                .and_then(|md| parse_frontmatter_str(&md, "description"));
            out.push(ContextUnit {
                kind: ContextKind::Skill,
                name,
                summary,
                projectable: true,
                packageable: true,
                detected_in: Some(base.to_string()),
            });
        }
    }
    Ok(())
}

/// An MCP server in the EXECUTOR config `.mcp.json` whose key is not
/// `canon-`-prefixed was added outside Canon. (Canon's own source lives in
/// `.covenant/canon/mcp/*.json` and is read by `read_mcp_servers` — that is the
/// managed side; detection reads the projected `.mcp.json` instead.)
fn scan_mcp(repo_root: &Path, out: &mut Vec<ContextUnit>) -> Result<(), CanonError> {
    let path = repo_root.join(".mcp.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(()), // no executor config → nothing foreign
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(()), // malformed: never guess, just skip
    };
    let Some(servers) = v.get("mcpServers").and_then(|m| m.as_object()) else {
        return Ok(());
    };
    for (name, srv) in servers {
        if name.starts_with("canon-") {
            continue;
        }
        out.push(ContextUnit {
            kind: ContextKind::Mcp,
            summary: srv
                .get("description")
                .and_then(|d| d.as_str())
                .map(String::from),
            name: name.clone(),
            projectable: true,
            packageable: true,
            detected_in: Some(".mcp.json".to_string()),
        });
    }
    Ok(())
}

/// Foreign items across executor dirs, deduped by name within each kind.
/// Task 1: Agent + Command. Task 2 extends with Skill + Mcp.
pub fn scan_detected(repo_root: &Path) -> Result<Vec<ContextUnit>, CanonError> {
    let mut out = Vec::new();
    let mut agent_seen = HashSet::new();
    scan_file_per_item(
        repo_root,
        AGENT_DIRS,
        ContextKind::Agent,
        &mut agent_seen,
        &mut out,
    )?;
    let mut cmd_seen = HashSet::new();
    scan_file_per_item(
        repo_root,
        COMMAND_DIRS,
        ContextKind::Command,
        &mut cmd_seen,
        &mut out,
    )?;
    scan_skills(repo_root, &mut out)?;
    scan_mcp(repo_root, &mut out)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_foreign_agent_not_source_backed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Foreign agent installed straight into .claude/agents (no Canon source).
        std::fs::create_dir_all(root.join(".claude/agents")).unwrap();
        std::fs::write(
            root.join(".claude/agents/foo.md"),
            "---\nname: foo\ndescription: A foreign agent\n---\nbody\n",
        )
        .unwrap();
        // A source-backed agent must NOT be reported as detected.
        std::fs::create_dir_all(root.join(".covenant/canon/agents")).unwrap();
        std::fs::write(
            root.join(".covenant/canon/agents/managed.md"),
            "# managed\n",
        )
        .unwrap();
        std::fs::create_dir_all(root.join(".claude/agents")).unwrap();
        std::fs::write(root.join(".claude/agents/managed.md"), "# managed\n").unwrap();

        let det = scan_detected(root).unwrap();
        let foo = det
            .iter()
            .find(|u| u.name == "foo")
            .expect("foreign agent detected");
        assert_eq!(foo.kind, ContextKind::Agent);
        assert_eq!(foo.detected_in.as_deref(), Some(".claude/agents"));
        assert_eq!(foo.summary.as_deref(), Some("A foreign agent"));
        assert!(
            det.iter().all(|u| u.name != "managed"),
            "source-backed item is not detected"
        );
    }

    #[test]
    fn detects_foreign_skill_and_mcp_but_not_canon_prefixed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Foreign skill hand-installed (no canon- prefix).
        std::fs::create_dir_all(root.join(".claude/skills/kyc")).unwrap();
        std::fs::write(
            root.join(".claude/skills/kyc/SKILL.md"),
            "---\nname: kyc\ndescription: KYC helper\n---\nbody\n",
        )
        .unwrap();
        // A Canon-projected skill (canon- prefix) must NOT be detected.
        std::fs::create_dir_all(root.join(".claude/skills/canon-managed")).unwrap();
        std::fs::write(root.join(".claude/skills/canon-managed/SKILL.md"), "x\n").unwrap();
        // Foreign MCP server (key without canon- prefix); a canon- one is ignored.
        std::fs::write(
            root.join(".mcp.json"),
            r#"{"mcpServers":{"ctx7":{"command":"npx","description":"C7"},"canon-x":{"command":"npx"}}}"#,
        )
        .unwrap();

        let det = scan_detected(root).unwrap();
        let skill = det
            .iter()
            .find(|u| u.name == "kyc")
            .expect("foreign skill detected");
        assert_eq!(skill.kind, ContextKind::Skill);
        assert_eq!(skill.detected_in.as_deref(), Some(".claude/skills"));
        assert!(
            det.iter().all(|u| u.name != "canon-managed"),
            "canon- skill not detected"
        );
        let mcp = det
            .iter()
            .find(|u| u.name == "ctx7")
            .expect("foreign mcp detected");
        assert_eq!(mcp.kind, ContextKind::Mcp);
        assert_eq!(mcp.detected_in.as_deref(), Some(".mcp.json"));
        assert!(
            det.iter().all(|u| u.name != "canon-x"),
            "canon- mcp server not detected"
        );
    }
}
