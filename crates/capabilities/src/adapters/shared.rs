//! Shared `~/.agents/skills/<name>/SKILL.md` adapter (skills.sh ecosystem).
//!
//! Cross-tool skill standard managed by `npx skills`. Layout:
//!
//! ```text
//! ~/.agents/
//! ├── .skill-lock.json
//! └── skills/<name>/SKILL.md
//! ```
//!
//! The lockfile, when present, augments each skill with `source` + `version`.
//! Lockfile parse failures degrade gracefully (skill still listed, fields = None).

use crate::frontmatter;
use crate::model::CapabilityResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SharedSkill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub source: Option<String>,
    pub version: Option<String>,
}

/// True iff `~/.agents/skills/` exists as a directory.
pub fn detect(home: &Path) -> bool {
    home.join(".agents").join("skills").is_dir()
}

/// Walk `~/.agents/skills/*/SKILL.md`, parse frontmatter, cross-reference
/// `~/.agents/.skill-lock.json` (best-effort). Returns empty vec if the skills
/// dir is missing — never errors on absence.
pub fn scan(home: &Path) -> CapabilityResult<Vec<SharedSkill>> {
    let root = home.join(".agents");
    let skills_dir = root.join("skills");
    if !skills_dir.is_dir() {
        return Ok(Vec::new());
    }

    let lock = read_lockfile(&root.join(".skill-lock.json"));

    let mut out = Vec::new();
    for entry in std::fs::read_dir(&skills_dir)? {
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
        let (source, version) = lock
            .get(&name)
            .map(|e| (e.source.clone(), e.version.clone()))
            .unwrap_or((None, None));
        out.push(SharedSkill {
            name,
            description,
            path: skill_md,
            source,
            version,
        });
    }
    Ok(out)
}

#[derive(Debug, Clone, Default)]
struct LockEntry {
    source: Option<String>,
    version: Option<String>,
}

/// Read `.skill-lock.json` permissively. Never propagates errors: a missing or
/// malformed file yields an empty map. Tries both `{ "skills": { ... } }` and
/// flat `{ "<name>": { ... } }` shapes.
fn read_lockfile(path: &Path) -> HashMap<String, LockEntry> {
    let mut map = HashMap::new();
    let Ok(raw) = std::fs::read_to_string(path) else {
        return map;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return map;
    };
    let obj = match value.get("skills").and_then(|v| v.as_object()) {
        Some(o) => o,
        None => match value.as_object() {
            Some(o) => o,
            None => return map,
        },
    };
    for (k, v) in obj {
        let Some(entry) = v.as_object() else { continue };
        let source = entry
            .get("source")
            .and_then(|x| x.as_str())
            .map(str::to_string);
        let version = entry
            .get("version")
            .and_then(|x| x.as_str())
            .map(str::to_string);
        if source.is_some() || version.is_some() {
            map.insert(k.clone(), LockEntry { source, version });
        }
    }
    map
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
    fn missing_agents_dir_returns_empty_and_detect_false() {
        let tmp = TempDir::new().unwrap();
        assert!(!detect(tmp.path()));
        assert!(scan(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn empty_skills_dir_returns_empty() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".agents/skills")).unwrap();
        assert!(detect(tmp.path()));
        assert!(scan(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn parses_skill_with_frontmatter() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp.path().join(".agents/skills/react/SKILL.md"),
            "---\nname: react\ndescription: React patterns\n---\nbody",
        );
        let skills = scan(tmp.path()).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "react");
        assert_eq!(skills[0].description, "React patterns");
        assert!(skills[0].source.is_none());
        assert!(skills[0].version.is_none());
    }

    #[test]
    fn skill_without_frontmatter_falls_back_to_dir_name() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp.path().join(".agents/skills/no-fm/SKILL.md"),
            "no frontmatter",
        );
        let skills = scan(tmp.path()).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "no-fm");
        assert_eq!(skills[0].description, "");
    }

    #[test]
    fn skill_dir_without_skill_md_is_skipped() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".agents/skills/empty")).unwrap();
        write(
            &tmp.path().join(".agents/skills/real/SKILL.md"),
            "---\nname: real\n---\n",
        );
        let skills = scan(tmp.path()).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "real");
    }

    #[test]
    fn lockfile_skills_shape_populates_source_and_version() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp.path().join(".agents/skills/react/SKILL.md"),
            "---\nname: react\ndescription: r\n---\n",
        );
        let lock = serde_json::json!({
            "skills": {
                "react": { "source": "vercel-labs/agent-skills@react", "version": "1.2.3" }
            }
        });
        write(
            &tmp.path().join(".agents/.skill-lock.json"),
            &lock.to_string(),
        );
        let skills = scan(tmp.path()).unwrap();
        assert_eq!(
            skills[0].source.as_deref(),
            Some("vercel-labs/agent-skills@react")
        );
        assert_eq!(skills[0].version.as_deref(), Some("1.2.3"));
    }

    #[test]
    fn lockfile_flat_shape_also_supported() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp.path().join(".agents/skills/vue/SKILL.md"),
            "---\nname: vue\n---\n",
        );
        let lock = serde_json::json!({
            "vue": { "source": "foo/bar@vue", "version": "0.1.0" }
        });
        write(
            &tmp.path().join(".agents/.skill-lock.json"),
            &lock.to_string(),
        );
        let skills = scan(tmp.path()).unwrap();
        assert_eq!(skills[0].source.as_deref(), Some("foo/bar@vue"));
        assert_eq!(skills[0].version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn lockfile_without_matching_skill_leaves_fields_none() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp.path().join(".agents/skills/react/SKILL.md"),
            "---\nname: react\n---\n",
        );
        let lock = serde_json::json!({
            "skills": {
                "other": { "source": "x/y", "version": "9.9.9" }
            }
        });
        write(
            &tmp.path().join(".agents/.skill-lock.json"),
            &lock.to_string(),
        );
        let skills = scan(tmp.path()).unwrap();
        assert_eq!(skills.len(), 1);
        assert!(skills[0].source.is_none());
        assert!(skills[0].version.is_none());
    }

    #[test]
    fn malformed_lockfile_does_not_fail_scan() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp.path().join(".agents/skills/react/SKILL.md"),
            "---\nname: react\n---\n",
        );
        write(
            &tmp.path().join(".agents/.skill-lock.json"),
            "{ not json at all",
        );
        let skills = scan(tmp.path()).unwrap();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "react");
        assert!(skills[0].source.is_none());
        assert!(skills[0].version.is_none());
    }
}
