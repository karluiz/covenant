//! Detection is projection run backwards: read the executor dirs that
//! `project()` writes to and surface items Canon did NOT put there (no source
//! under `.covenant/canon/`). Reuses project.rs's dir constants as the single
//! source of truth for "where executors read".

use crate::kind::{ContextKind, ContextUnit};
use crate::manifest::canon_dir;
use crate::project::{parse_frontmatter_str, read_dir_md, AGENT_DIRS, COMMAND_DIRS};
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

/// Foreign items across executor dirs, deduped by name within each kind.
/// Task 1: Agent + Command. Task 2 extends with Skill + Mcp.
pub fn scan_detected(repo_root: &Path) -> Result<Vec<ContextUnit>, CanonError> {
    let mut out = Vec::new();
    let mut agent_seen = HashSet::new();
    scan_file_per_item(repo_root, AGENT_DIRS, ContextKind::Agent, &mut agent_seen, &mut out)?;
    let mut cmd_seen = HashSet::new();
    scan_file_per_item(repo_root, COMMAND_DIRS, ContextKind::Command, &mut cmd_seen, &mut out)?;
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
        std::fs::write(root.join(".covenant/canon/agents/managed.md"), "# managed\n").unwrap();
        std::fs::create_dir_all(root.join(".claude/agents")).unwrap();
        std::fs::write(root.join(".claude/agents/managed.md"), "# managed\n").unwrap();

        let det = scan_detected(root).unwrap();
        let foo = det.iter().find(|u| u.name == "foo").expect("foreign agent detected");
        assert_eq!(foo.kind, ContextKind::Agent);
        assert_eq!(foo.detected_in.as_deref(), Some(".claude/agents"));
        assert_eq!(foo.summary.as_deref(), Some("A foreign agent"));
        assert!(det.iter().all(|u| u.name != "managed"), "source-backed item is not detected");
    }
}
