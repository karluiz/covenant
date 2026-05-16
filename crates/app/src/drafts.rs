use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

const SUGGEST_SYSTEM_PROMPT: &str = "You are a spec assistant for Covenant, an \
    AI-native terminal. The user is writing a feature spec following a fixed \
    template. Given the draft so far and the section name, return EXACTLY 3 \
    concrete bullet suggestions for that section. Output JSON: \
    {\"suggestions\":[\"...\",\"...\",\"...\"]}. No prose, no markdown fences.";

pub const SUGGEST_MAX_TOKENS: u32 = 600;
pub const LLM_CALL_CAP: u32 = 20;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SuggestSection {
    OutOfScope,
    AcceptanceCriteria,
    OpenQuestions,
}

pub fn build_suggest_user_message(section: SuggestSection, draft_text: &str) -> String {
    let label = match section {
        SuggestSection::OutOfScope => "Out of scope",
        SuggestSection::AcceptanceCriteria => "Acceptance criteria",
        SuggestSection::OpenQuestions => "Open questions",
    };
    format!("Section: {label}\n\nDraft so far:\n\n{draft_text}\n\nReturn JSON now.")
}

pub fn parse_suggestions(text: &str) -> Result<Vec<String>, DraftError> {
    #[derive(Deserialize)]
    struct Wrap { suggestions: Vec<String> }
    let trimmed = text.trim()
        .trim_start_matches("```json").trim_start_matches("```")
        .trim_end_matches("```").trim();
    let wrap: Wrap = serde_json::from_str(trimmed)
        .map_err(|e| DraftError::Validation(format!("bad llm json: {e}")))?;
    if wrap.suggestions.is_empty() {
        return Err(DraftError::Validation("no suggestions".into()));
    }
    Ok(wrap.suggestions.into_iter().take(3).collect())
}

#[derive(Debug, Error)]
pub enum DraftError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("invalid frontmatter: {0}")]
    InvalidFrontmatter(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("collision: {0}")]
    Collision(String),
    #[error("validation: {0}")]
    Validation(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DraftFrontmatter {
    pub status: String,        // always "draft"
    pub title: String,
    pub slug: String,
    pub created_at: String,    // RFC3339
    pub updated_at: String,    // RFC3339
    #[serde(default)]
    pub llm_calls: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftDocument {
    pub frontmatter: DraftFrontmatter,
    pub body: String,
}

pub fn parse_draft(text: &str) -> Result<DraftDocument, DraftError> {
    let rest = text.strip_prefix("---\n")
        .ok_or_else(|| DraftError::InvalidFrontmatter("missing opening ---".into()))?;
    let end = rest.find("\n---\n")
        .ok_or_else(|| DraftError::InvalidFrontmatter("missing closing ---".into()))?;
    let yaml = &rest[..end];
    let body = rest[end + 5..].to_string();
    let frontmatter: DraftFrontmatter = serde_yaml::from_str(yaml)?;
    Ok(DraftDocument { frontmatter, body })
}

pub fn serialize_draft(doc: &DraftDocument) -> Result<String, DraftError> {
    let yaml = serde_yaml::to_string(&doc.frontmatter)?;
    Ok(format!("---\n{yaml}---\n{}", doc.body))
}

/// kebab-case slug from a free-text title. ASCII-only fallback for
/// non-ASCII chars (drop them). Empty input returns "untitled".
pub fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut prev_dash = true;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() { "untitled".into() } else { trimmed.to_string() }
}

/// Find max `<major>.<minor>` ID among `docs/specs/*.md` (excluding
/// `_template.md` and `drafts/`) and return next minor (`major.(minor+1)`).
/// If no spec exists, returns "1.0".
pub fn next_spec_id(repo_root: &Path) -> Result<String, DraftError> {
    let dir = repo_root.join("docs/specs");
    if !dir.exists() {
        return Ok("1.0".into());
    }
    let mut best: Option<(u32, u32)> = None;
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(".md") || name.starts_with('_') {
            continue;
        }
        let stem = name.trim_end_matches(".md");
        let prefix = stem.split('-').next().unwrap_or("");
        let mut parts = prefix.split('.');
        let (Some(maj), Some(min)) = (parts.next(), parts.next()) else { continue };
        if let (Ok(maj), Ok(min)) = (maj.parse::<u32>(), min.parse::<u32>()) {
            best = Some(best.map_or((maj, min), |(m, n)| {
                if (maj, min) > (m, n) { (maj, min) } else { (m, n) }
            }));
        }
    }
    Ok(match best {
        Some((maj, min)) => format!("{maj}.{}", min + 1),
        None => "1.0".into(),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct DraftSummary {
    pub slug: String,
    pub title: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PublishedSpec {
    pub id: String,         // "3.10"
    pub title: String,      // "Mission Drafts"
    pub goal: String,       // first non-empty paragraph after `## Goal`, ≤ 200 chars
    pub path: String,       // absolute path
    pub updated_at: String, // file mtime RFC3339
}

/// Parse "# 3.10 — Mission Drafts" or "# 3.10 - Mission Drafts" into (id, title).
/// Returns None for headings that don't match the expected published-spec pattern.
pub fn parse_published_spec_heading(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    let rest = line.strip_prefix("# ")?;
    // Split on em-dash or hyphen surrounded by spaces.
    let (id_part, title_part) = if let Some(idx) = rest.find(" — ") {
        (&rest[..idx], &rest[idx + " — ".len()..])
    } else if let Some(idx) = rest.find(" - ") {
        (&rest[..idx], &rest[idx + " - ".len()..])
    } else {
        return None;
    };
    // Validate ID = "<u32>.<u32>"
    let mut parts = id_part.split('.');
    let (Some(maj), Some(min), None) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    maj.parse::<u32>().ok()?;
    min.parse::<u32>().ok()?;
    let title = title_part.trim();
    if title.is_empty() {
        return None;
    }
    Some((id_part.to_string(), title.to_string()))
}

/// Extract the first non-empty paragraph under "## Goal" in the spec body.
/// Returns at most `max_chars` characters; appends "…" if truncated. Empty if
/// "## Goal" is missing or the section has no body.
pub fn extract_goal_paragraph(body: &str, max_chars: usize) -> String {
    let mut in_goal = false;
    let mut buf: Vec<&str> = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("## ") {
            if in_goal {
                break; // hit next section
            }
            if trimmed == "## Goal" {
                in_goal = true;
            }
            continue;
        }
        if !in_goal {
            continue;
        }
        // Skip blank lines until we find content; stop at blank line after content.
        if line.trim().is_empty() {
            if !buf.is_empty() {
                break;
            }
            continue;
        }
        buf.push(line.trim());
    }
    let joined = buf.join(" ");
    if joined.chars().count() <= max_chars {
        return joined;
    }
    let mut out: String = joined.chars().take(max_chars).collect();
    out.push('…');
    out
}

pub fn list_published_specs_sync(repo_root: &Path) -> Result<Vec<PublishedSpec>, DraftError> {
    let dir = repo_root.join("docs/specs");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let ftype = entry.file_type()?;
        if !ftype.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.ends_with(".md") || name_str.starts_with('_') {
            continue;
        }
        let path = entry.path();
        let text = std::fs::read_to_string(&path)?;
        // First non-empty line should be the H1 heading.
        let heading_line = text
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");
        let Some((id, title)) = parse_published_spec_heading(heading_line) else {
            continue; // not a published spec we can interpret
        };
        let goal = extract_goal_paragraph(&text, 200);
        let updated_at = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH).ok()
                    .map(|d| chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0))
            })
            .flatten()
            .map(|dt| dt.to_rfc3339())
            .unwrap_or_default();
        out.push(PublishedSpec {
            id,
            title,
            goal,
            path: path.to_string_lossy().into_owned(),
            updated_at,
        });
    }
    // Sort by semantic ID descending (major, minor).
    out.sort_by(|a, b| {
        let parse = |s: &str| -> (u32, u32) {
            let mut p = s.split('.');
            let maj = p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            let min = p.next().and_then(|x| x.parse().ok()).unwrap_or(0);
            (maj, min)
        };
        parse(&b.id).cmp(&parse(&a.id))
    });
    Ok(out)
}

fn drafts_dir(repo_root: &Path) -> PathBuf {
    repo_root.join("docs/specs/drafts")
}

fn draft_path(repo_root: &Path, slug: &str) -> PathBuf {
    drafts_dir(repo_root).join(format!("{slug}.md"))
}

pub fn list_drafts_sync(repo_root: &Path) -> Result<Vec<DraftSummary>, DraftError> {
    let dir = drafts_dir(repo_root);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(".md") || name.starts_with('.') {
            continue;
        }
        let text = std::fs::read_to_string(entry.path())?;
        let doc = parse_draft(&text)?;
        out.push(DraftSummary {
            slug: doc.frontmatter.slug,
            title: doc.frontmatter.title,
            updated_at: doc.frontmatter.updated_at,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

pub fn read_draft_sync(repo_root: &Path, slug: &str) -> Result<DraftDocument, DraftError> {
    let path = draft_path(repo_root, slug);
    if !path.exists() {
        return Err(DraftError::NotFound(slug.into()));
    }
    let text = std::fs::read_to_string(path)?;
    parse_draft(&text)
}

/// Atomic write: write to `<slug>.md.tmp` then rename. Updates
/// `updated_at` to now (RFC3339 UTC). Creates the drafts directory
/// if missing.
pub fn save_draft_sync(
    repo_root: &Path,
    slug: &str,
    title: &str,
    body: &str,
) -> Result<DraftDocument, DraftError> {
    let dir = drafts_dir(repo_root);
    std::fs::create_dir_all(&dir)?;
    let path = draft_path(repo_root, slug);
    let now = chrono::Utc::now().to_rfc3339();
    let frontmatter = if path.exists() {
        let existing = parse_draft(&std::fs::read_to_string(&path)?)?.frontmatter;
        DraftFrontmatter {
            updated_at: now,
            title: title.into(),
            ..existing
        }
    } else {
        DraftFrontmatter {
            status: "draft".into(),
            title: title.into(),
            slug: slug.into(),
            created_at: now.clone(),
            updated_at: now,
            llm_calls: 0,
        }
    };
    let doc = DraftDocument { frontmatter, body: body.into() };
    let text = serialize_draft(&doc)?;
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
    Ok(doc)
}

pub fn delete_draft_sync(repo_root: &Path, slug: &str) -> Result<(), DraftError> {
    let path = draft_path(repo_root, slug);
    if !path.exists() {
        return Err(DraftError::NotFound(slug.into()));
    }
    std::fs::remove_file(path)?;
    Ok(())
}

/// Move `drafts/<slug>.md` → `<id>-<final_slug>.md`, strip
/// frontmatter, rewrite the `# Draft — X` heading to `# <id> — X`.
/// Returns the published file path. Validates ID uniqueness against
/// existing `docs/specs/*.md` and slug uniqueness.
pub fn publish_draft_sync(
    repo_root: &Path,
    slug: &str,
    id: &str,
    final_slug: &str,
) -> Result<PathBuf, DraftError> {
    // Validate ID format: `<u32>.<u32>`.
    let mut parts = id.split('.');
    let (Some(maj), Some(min), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(DraftError::Validation(format!("invalid id format: {id}")));
    };
    if maj.parse::<u32>().is_err() || min.parse::<u32>().is_err() {
        return Err(DraftError::Validation(format!("invalid id numbers: {id}")));
    }

    // Validate slug.
    let cleaned = slugify(final_slug);
    if cleaned != final_slug {
        return Err(DraftError::Validation(format!(
            "slug must be kebab-case ascii: got {final_slug}, expected {cleaned}"
        )));
    }

    let dest = repo_root.join("docs/specs").join(format!("{id}-{final_slug}.md"));
    if dest.exists() {
        return Err(DraftError::Collision(format!("{}", dest.display())));
    }
    // Also reject if any existing spec uses the same id prefix.
    let specs_dir = repo_root.join("docs/specs");
    if specs_dir.exists() {
        for entry in std::fs::read_dir(&specs_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy().to_string();
            if name.starts_with(&format!("{id}-")) {
                return Err(DraftError::Collision(format!("id {id} already used: {name}")));
            }
        }
    }

    let doc = read_draft_sync(repo_root, slug)?;
    let title = &doc.frontmatter.title;
    // Body may start with `# Draft — <title>`; rewrite or prepend.
    let new_heading = format!("# {id} — {title}");
    let rewritten = if doc.body.starts_with("# Draft —") || doc.body.starts_with("# Draft -") {
        let nl = doc.body.find('\n').unwrap_or(doc.body.len());
        format!("{new_heading}{}", &doc.body[nl..])
    } else {
        format!("{new_heading}\n\n{}", doc.body)
    };

    std::fs::create_dir_all(&specs_dir)?;
    let tmp = dest.with_extension("md.tmp");
    std::fs::write(&tmp, rewritten)?;
    std::fs::rename(&tmp, &dest)?;
    std::fs::remove_file(draft_path(repo_root, slug))?;
    Ok(dest)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SpecBody {
    pub body: String,
    pub truncated: bool,
}

/// Read a spec/plan markdown file with a hard byte cap so the preview
/// pane can't lock the UI on a pathological file. `max_bytes = 0` means
/// "use default" (200 KB).
pub fn read_spec_body_sync(path: &std::path::Path, max_bytes: usize) -> std::io::Result<SpecBody> {
    let cap = if max_bytes == 0 { 200 * 1024 } else { max_bytes };
    let bytes = std::fs::read(path)?;
    let truncated = bytes.len() > cap;
    let slice = if truncated { &bytes[..cap] } else { &bytes[..] };
    let body = String::from_utf8_lossy(slice).into_owned();
    Ok(SpecBody { body, truncated })
}

#[tauri::command]
pub async fn read_spec_body(path: String, max_bytes: Option<usize>) -> Result<SpecBody, String> {
    let p = std::path::PathBuf::from(&path);
    let path_for_err = path.clone();
    tokio::task::spawn_blocking(move || read_spec_body_sync(&p, max_bytes.unwrap_or(0)))
        .await
        .map_err(|e| format!("{path_for_err}: join error: {e}"))?
        .map_err(|e| format!("{path_for_err}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fm() -> DraftFrontmatter {
        DraftFrontmatter {
            status: "draft".into(),
            title: "Mission Drafts".into(),
            slug: "mission-drafts".into(),
            created_at: "2026-05-03T14:55:00Z".into(),
            updated_at: "2026-05-03T15:12:00Z".into(),
            llm_calls: 0,
        }
    }

    #[test]
    fn parse_roundtrip() {
        let doc = DraftDocument {
            frontmatter: fm(),
            body: "# Draft — Mission Drafts\n\n## Goal\nx\n".into(),
        };
        let text = serialize_draft(&doc).unwrap();
        let parsed = parse_draft(&text).unwrap();
        assert_eq!(parsed, doc);
    }

    #[test]
    fn parse_missing_open() {
        let err = parse_draft("title: x\n").unwrap_err();
        assert!(matches!(err, DraftError::InvalidFrontmatter(_)));
    }

    #[test]
    fn parse_missing_close() {
        let err = parse_draft("---\ntitle: x\n").unwrap_err();
        assert!(matches!(err, DraftError::InvalidFrontmatter(_)));
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Mission Drafts"), "mission-drafts");
        assert_eq!(slugify("  Hello, World!  "), "hello-world");
        assert_eq!(slugify("---"), "untitled");
        assert_eq!(slugify("Café 99"), "caf-99");
    }

    #[test]
    fn next_spec_id_increments_max() {
        let tmp = tempfile::tempdir().unwrap();
        let specs = tmp.path().join("docs/specs");
        std::fs::create_dir_all(&specs).unwrap();
        for name in ["1.0-a.md", "3.9-foo.md", "3.2-bar.md", "_template.md"] {
            std::fs::write(specs.join(name), "x").unwrap();
        }
        assert_eq!(next_spec_id(tmp.path()).unwrap(), "3.10");
    }

    #[test]
    fn next_spec_id_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(next_spec_id(tmp.path()).unwrap(), "1.0");
    }

    #[test]
    fn save_then_read_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let doc = save_draft_sync(tmp.path(), "foo", "Foo Title", "## Goal\nbar\n").unwrap();
        assert_eq!(doc.frontmatter.slug, "foo");
        assert_eq!(doc.frontmatter.title, "Foo Title");
        let read = read_draft_sync(tmp.path(), "foo").unwrap();
        assert_eq!(read.body, "## Goal\nbar\n");
        assert_eq!(read.frontmatter.created_at, doc.frontmatter.created_at);
    }

    #[test]
    fn save_preserves_created_at_and_llm_calls() {
        let tmp = tempfile::tempdir().unwrap();
        let first = save_draft_sync(tmp.path(), "a", "A", "x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let mut doc = read_draft_sync(tmp.path(), "a").unwrap();
        doc.frontmatter.llm_calls = 5;
        let text = serialize_draft(&doc).unwrap();
        std::fs::write(tmp.path().join("docs/specs/drafts/a.md"), text).unwrap();
        let second = save_draft_sync(tmp.path(), "a", "A", "y").unwrap();
        assert_eq!(first.frontmatter.created_at, second.frontmatter.created_at);
        assert_eq!(second.frontmatter.llm_calls, 5);
        assert_ne!(first.frontmatter.updated_at, second.frontmatter.updated_at);
    }

    #[test]
    fn list_drafts_sorted_desc() {
        let tmp = tempfile::tempdir().unwrap();
        save_draft_sync(tmp.path(), "a", "A", "x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        save_draft_sync(tmp.path(), "b", "B", "x").unwrap();
        let list = list_drafts_sync(tmp.path()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].slug, "b");
        assert_eq!(list[1].slug, "a");
    }

    #[test]
    fn delete_then_missing() {
        let tmp = tempfile::tempdir().unwrap();
        save_draft_sync(tmp.path(), "a", "A", "x").unwrap();
        delete_draft_sync(tmp.path(), "a").unwrap();
        assert!(matches!(read_draft_sync(tmp.path(), "a"), Err(DraftError::NotFound(_))));
    }

    #[test]
    fn delete_missing_errors() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(matches!(delete_draft_sync(tmp.path(), "x"), Err(DraftError::NotFound(_))));
    }

    #[test]
    fn publish_moves_file_and_rewrites_heading() {
        let tmp = tempfile::tempdir().unwrap();
        save_draft_sync(
            tmp.path(),
            "mission-drafts",
            "Mission Drafts",
            "# Draft — Mission Drafts\n\n## Goal\nx\n",
        ).unwrap();
        let dest = publish_draft_sync(tmp.path(), "mission-drafts", "3.10", "mission-drafts").unwrap();
        assert!(dest.ends_with("docs/specs/3.10-mission-drafts.md"));
        let text = std::fs::read_to_string(&dest).unwrap();
        assert!(text.starts_with("# 3.10 — Mission Drafts\n"));
        assert!(!text.contains("---\nstatus:"));
        assert!(!tmp.path().join("docs/specs/drafts/mission-drafts.md").exists());
    }

    #[test]
    fn publish_rejects_duplicate_id() {
        let tmp = tempfile::tempdir().unwrap();
        let specs = tmp.path().join("docs/specs");
        std::fs::create_dir_all(&specs).unwrap();
        std::fs::write(specs.join("3.10-other.md"), "x").unwrap();
        save_draft_sync(tmp.path(), "a", "A", "## Goal\nx").unwrap();
        let err = publish_draft_sync(tmp.path(), "a", "3.10", "a").unwrap_err();
        assert!(matches!(err, DraftError::Collision(_)));
    }

    #[test]
    fn publish_rejects_invalid_slug() {
        let tmp = tempfile::tempdir().unwrap();
        save_draft_sync(tmp.path(), "a", "A", "x").unwrap();
        let err = publish_draft_sync(tmp.path(), "a", "1.0", "Bad Slug!").unwrap_err();
        assert!(matches!(err, DraftError::Validation(_)));
    }

    #[test]
    fn publish_rejects_invalid_id() {
        let tmp = tempfile::tempdir().unwrap();
        save_draft_sync(tmp.path(), "a", "A", "x").unwrap();
        assert!(matches!(
            publish_draft_sync(tmp.path(), "a", "abc", "a").unwrap_err(),
            DraftError::Validation(_)
        ));
        assert!(matches!(
            publish_draft_sync(tmp.path(), "a", "1.0.0", "a").unwrap_err(),
            DraftError::Validation(_)
        ));
    }

    #[test]
    fn parse_suggestions_plain_json() {
        let r = parse_suggestions(r#"{"suggestions":["a","b","c"]}"#).unwrap();
        assert_eq!(r, vec!["a", "b", "c"]);
    }

    #[test]
    fn parse_suggestions_with_fences() {
        let r = parse_suggestions("```json\n{\"suggestions\":[\"x\",\"y\",\"z\"]}\n```").unwrap();
        assert_eq!(r, vec!["x", "y", "z"]);
    }

    #[test]
    fn parse_suggestions_trims_to_three() {
        let r = parse_suggestions(r#"{"suggestions":["a","b","c","d"]}"#).unwrap();
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn parse_suggestions_rejects_empty() {
        assert!(parse_suggestions(r#"{"suggestions":[]}"#).is_err());
        assert!(parse_suggestions("not json").is_err());
    }

    #[test]
    fn build_user_message_includes_section() {
        let m = build_suggest_user_message(SuggestSection::OutOfScope, "draft body");
        assert!(m.contains("Out of scope"));
        assert!(m.contains("draft body"));
    }

    #[test]
    fn extract_goal_basic() {
        let body = "# 3.10 — X\n\n## Goal\nThe one-sentence goal.\n\n## Out of scope\n- y\n";
        assert_eq!(extract_goal_paragraph(body, 200), "The one-sentence goal.");
    }

    #[test]
    fn extract_goal_multiline_paragraph() {
        let body = "## Goal\nLine one\nLine two.\n\n## Next\n";
        assert_eq!(extract_goal_paragraph(body, 200), "Line one Line two.");
    }

    #[test]
    fn extract_goal_skips_leading_blanks() {
        let body = "## Goal\n\n\nReal goal here.\n";
        assert_eq!(extract_goal_paragraph(body, 200), "Real goal here.");
    }

    #[test]
    fn extract_goal_truncates() {
        let body = format!("## Goal\n{}\n", "a".repeat(300));
        let r = extract_goal_paragraph(&body, 200);
        assert_eq!(r.chars().count(), 201); // 200 + "…"
        assert!(r.ends_with('…'));
    }

    #[test]
    fn extract_goal_missing() {
        assert_eq!(extract_goal_paragraph("## Out of scope\n- x\n", 200), "");
        assert_eq!(extract_goal_paragraph("# Title only\n", 200), "");
    }

    #[test]
    fn parse_heading_em_dash() {
        let r = parse_published_spec_heading("# 3.10 — Mission Drafts");
        assert_eq!(r, Some(("3.10".into(), "Mission Drafts".into())));
    }

    #[test]
    fn parse_heading_hyphen() {
        let r = parse_published_spec_heading("# 1.0 - Foo Bar");
        assert_eq!(r, Some(("1.0".into(), "Foo Bar".into())));
    }

    #[test]
    fn parse_heading_rejects_no_id() {
        assert!(parse_published_spec_heading("# Mission Drafts").is_none());
        assert!(parse_published_spec_heading("# abc — Title").is_none());
        assert!(parse_published_spec_heading("# 1.0.0 — Title").is_none());
        assert!(parse_published_spec_heading("# 3.10 —").is_none());
    }

    #[test]
    fn parse_heading_rejects_non_h1() {
        assert!(parse_published_spec_heading("## 3.10 — X").is_none());
        assert!(parse_published_spec_heading("3.10 — X").is_none());
    }

    #[test]
    fn list_published_excludes_template_and_drafts() {
        let tmp = tempfile::tempdir().unwrap();
        let specs = tmp.path().join("docs/specs");
        std::fs::create_dir_all(specs.join("drafts")).unwrap();
        std::fs::write(specs.join("_template.md"), "# Template\n## Goal\nx\n").unwrap();
        std::fs::write(specs.join("3.1-foo.md"), "# 3.1 — Foo\n\n## Goal\nFoo goal.\n").unwrap();
        std::fs::write(specs.join("3.10-bar.md"), "# 3.10 — Bar\n\n## Goal\nBar goal.\n").unwrap();
        std::fs::write(specs.join("drafts/draft-x.md"), "---\nstatus: draft\ntitle: x\nslug: draft-x\ncreated_at: 2026-01-01T00:00:00Z\nupdated_at: 2026-01-01T00:00:00Z\n---\n# Draft — x\n## Goal\nignored.\n").unwrap();

        let r = list_published_specs_sync(tmp.path()).unwrap();
        assert_eq!(r.len(), 2);
        // Sorted descending: 3.10 then 3.1.
        assert_eq!(r[0].id, "3.10");
        assert_eq!(r[0].title, "Bar");
        assert_eq!(r[0].goal, "Bar goal.");
        assert_eq!(r[1].id, "3.1");
    }

    #[test]
    fn list_published_skips_unparseable_heading() {
        let tmp = tempfile::tempdir().unwrap();
        let specs = tmp.path().join("docs/specs");
        std::fs::create_dir_all(&specs).unwrap();
        std::fs::write(specs.join("not-a-spec.md"), "Just some markdown\n").unwrap();
        std::fs::write(specs.join("3.0-ok.md"), "# 3.0 — OK\n## Goal\ng\n").unwrap();
        let r = list_published_specs_sync(tmp.path()).unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "3.0");
    }

    #[test]
    fn list_published_empty_when_no_specs_dir() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(list_published_specs_sync(tmp.path()).unwrap().len(), 0);
    }

    #[test]
    fn read_spec_body_returns_full_content_under_cap() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.md");
        std::fs::write(&p, b"# Hello\n\nbody").unwrap();
        let r = super::read_spec_body_sync(&p, 0).unwrap();
        assert_eq!(r.body, "# Hello\n\nbody");
        assert!(!r.truncated);
    }

    #[test]
    fn read_spec_body_truncates_over_cap() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.md");
        std::fs::write(&p, vec![b'a'; 1024]).unwrap();
        let r = super::read_spec_body_sync(&p, 100).unwrap();
        assert_eq!(r.body.len(), 100);
        assert!(r.truncated);
    }
}

// ── Tauri command wrappers ──────────────────────────────────────────────────

#[tauri::command]
pub async fn list_published_specs(repo_root: String) -> Result<Vec<PublishedSpec>, String> {
    let path = PathBuf::from(repo_root);
    tokio::task::spawn_blocking(move || list_published_specs_sync(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_drafts(repo_root: String) -> Result<Vec<DraftSummary>, String> {
    let path = PathBuf::from(repo_root);
    tokio::task::spawn_blocking(move || list_drafts_sync(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn read_draft(repo_root: String, slug: String) -> Result<DraftDocumentDto, String> {
    let path = PathBuf::from(repo_root);
    let doc = tokio::task::spawn_blocking(move || read_draft_sync(&path, &slug))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(DraftDocumentDto::from(doc))
}

#[tauri::command]
pub async fn save_draft(
    repo_root: String,
    slug: String,
    title: String,
    body: String,
) -> Result<DraftDocumentDto, String> {
    let path = PathBuf::from(repo_root);
    let doc = tokio::task::spawn_blocking(move || save_draft_sync(&path, &slug, &title, &body))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(DraftDocumentDto::from(doc))
}

#[tauri::command]
pub async fn delete_draft(repo_root: String, slug: String) -> Result<(), String> {
    let path = PathBuf::from(repo_root);
    tokio::task::spawn_blocking(move || delete_draft_sync(&path, &slug))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn publish_draft(
    repo_root: String,
    slug: String,
    id: String,
    final_slug: String,
) -> Result<String, String> {
    let path = PathBuf::from(repo_root);
    let dest = tokio::task::spawn_blocking(move || {
        publish_draft_sync(&path, &slug, &id, &final_slug)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn next_draft_id(repo_root: String) -> Result<String, String> {
    let path = PathBuf::from(repo_root);
    tokio::task::spawn_blocking(move || next_spec_id(&path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn suggest_draft_section(
    state: tauri::State<'_, crate::AppState>,
    repo_root: String,
    slug: String,
    section: SuggestSection,
) -> Result<Vec<String>, String> {
    let resolved = {
        let s = state.settings.lock().await;
        match crate::provider_resolve::resolve_route(&s, crate::settings::Role::Chat) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(?e, "suggest_draft_section: provider unavailable");
                return Err("provider unavailable".to_string());
            }
        }
    };

    // Read draft + check cap.
    let path = PathBuf::from(&repo_root);
    let slug_clone = slug.clone();
    let doc = tokio::task::spawn_blocking(move || read_draft_sync(&path, &slug_clone))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    if doc.frontmatter.llm_calls >= LLM_CALL_CAP {
        return Err(format!("cap reached ({LLM_CALL_CAP})"));
    }

    let user_msg = build_suggest_user_message(section, &doc.body);
    let req = karl_agent::AskRequest {
        api_key: String::new(),
        model: resolved.model.clone(),
        system_prompt: SUGGEST_SYSTEM_PROMPT.to_string(),
        user_message: user_msg,
        max_tokens: SUGGEST_MAX_TOKENS,
        thinking_budget: None,
        force_tool: None,
    };
    let response = karl_agent::provider::collect_oneshot(&*resolved.provider, req)
        .await
        .map_err(|e| e.to_string())?
        .text;

    // Increment llm_calls in frontmatter (best-effort, non-fatal).
    let path = PathBuf::from(&repo_root);
    let slug_clone = slug.clone();
    let _ = tokio::task::spawn_blocking(move || -> Result<(), DraftError> {
        let mut existing = read_draft_sync(&path, &slug_clone)?;
        existing.frontmatter.llm_calls += 1;
        existing.frontmatter.updated_at = chrono::Utc::now().to_rfc3339();
        let text = serialize_draft(&existing)?;
        std::fs::write(draft_path(&path, &slug_clone), text)?;
        Ok(())
    })
    .await;

    parse_suggestions(&response).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct DraftDocumentDto {
    pub frontmatter: DraftFrontmatter,
    pub body: String,
}
impl From<DraftDocument> for DraftDocumentDto {
    fn from(d: DraftDocument) -> Self {
        Self {
            frontmatter: d.frontmatter,
            body: d.body,
        }
    }
}
