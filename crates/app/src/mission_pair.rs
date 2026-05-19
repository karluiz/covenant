//! Pairing layer for missions: a mission may attach a single Covenant
//! spec OR a Superpowers (spec, plan?) pair. This module owns the type
//! definitions, plan resolution, and the narrow mutation API used by
//! the operator at runtime.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MissionKind {
    Covenant,
    Superpowers,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MissionRef {
    pub kind: MissionKind,
    pub spec_path: PathBuf,
    pub plan_path: Option<PathBuf>,
}

/// In-memory representation of an attached plan file. Mirrors `MissionDoc`
/// in `operator.rs` but is only present when `MissionRef.plan_path` is
/// `Some`. The operator's prompt builder reads `content`; mtime drives
/// conflict detection on mutation ops.
#[derive(Debug, Clone)]
pub struct PlanDoc {
    pub path: PathBuf,
    pub content: String,
    pub mtime_unix_ms: u64,
}

impl MissionRef {
    pub fn covenant(spec_path: PathBuf) -> Self {
        Self {
            kind: MissionKind::Covenant,
            spec_path,
            plan_path: None,
        }
    }
    pub fn superpowers(spec_path: PathBuf, plan_path: Option<PathBuf>) -> Self {
        Self {
            kind: MissionKind::Superpowers,
            spec_path,
            plan_path,
        }
    }
}

/// Extract the `spec:` field from a leading YAML frontmatter block, if
/// present. We don't pull in serde_yaml for this — the surface area is
/// one optional string, and a tiny manual parser keeps build deps flat.
pub fn parse_plan_frontmatter_spec(body: &str) -> Option<String> {
    let rest = body.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    let block = &rest[..end];
    for line in block.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("spec:") else {
            continue;
        };
        let val = rest.trim();
        // Only strip quotes when they appear as a matched pair so an
        // asymmetric leading-or-trailing quote doesn't get silently
        // chewed off (e.g. `spec: "foo` should stay literal, not `foo`).
        let unquoted = strip_matched_quotes(val).trim();
        if unquoted.is_empty() {
            return None;
        }
        return Some(unquoted.to_string());
    }
    None
}

fn strip_matched_quotes(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return &s[1..s.len() - 1];
        }
    }
    s
}

/// Resolve the plan path for a given Superpowers spec.
///
/// 1. Scan `*.md` under `plans_dir`. For any file with a frontmatter
///    `spec:` value that resolves (via `plans_dir.join(value).canonicalize`)
///    to `spec_path.canonicalize()`, return it.
/// 2. Otherwise look for `<plans_dir>/<basename-stripped-of-`-design`>.md`.
/// 3. Otherwise `Ok(None)`.
pub fn resolve_plan_for_spec(
    spec_path: &Path,
    plans_dir: &Path,
) -> std::io::Result<Option<PathBuf>> {
    if !plans_dir.exists() {
        return Ok(None);
    }
    let target = std::fs::canonicalize(spec_path)?;
    for entry in std::fs::read_dir(plans_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let body = match std::fs::read_to_string(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let Some(rel) = parse_plan_frontmatter_spec(&body) else {
            continue;
        };
        let resolved = plans_dir.join(&rel);
        if let Ok(can) = std::fs::canonicalize(&resolved) {
            if can == target {
                return Ok(Some(path));
            }
        }
    }
    let stem = spec_path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let stripped = stem.strip_suffix("-design").unwrap_or(stem);
    let candidate = plans_dir.join(format!("{stripped}.md"));
    if candidate.exists() {
        return Ok(Some(candidate));
    }
    Ok(None)
}

/// Pure-string version of `mark_plan_task` for unit testing.
pub fn mark_plan_task_in_body(body: &str, task_index: usize, done: bool) -> Result<String, String> {
    let mut count = 0usize;
    let mut out = String::with_capacity(body.len());
    let mut hit = false;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_end_matches('\n');
        let is_top = trimmed.starts_with("- [ ] ") || trimmed.starts_with("- [x] ");
        if is_top {
            if count == task_index {
                let replacement = if done { "- [x] " } else { "- [ ] " };
                let rest = &trimmed[6..];
                out.push_str(replacement);
                out.push_str(rest);
                if line.ends_with('\n') {
                    out.push('\n');
                }
                hit = true;
                count += 1;
                continue;
            }
            count += 1;
        }
        out.push_str(line);
    }
    if !hit {
        return Err(format!(
            "task index {task_index} out of range (found {count} top-level tasks)",
        ));
    }
    Ok(out)
}

/// Pure-string version of `append_plan_note`. Inserts the note line at
/// the position immediately before the next top-level task (or EOF).
/// Rejects multi-line notes — the operator must escalate instead.
pub fn append_plan_note_in_body(
    body: &str,
    task_index: usize,
    note: &str,
) -> Result<String, String> {
    if note.contains('\n') {
        return Err("note must be a single line".into());
    }
    let lines: Vec<&str> = body.split_inclusive('\n').collect();
    let mut top_indices: Vec<usize> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_end_matches('\n');
        if t.starts_with("- [ ] ") || t.starts_with("- [x] ") {
            top_indices.push(i);
        }
    }
    let Some(&start_idx) = top_indices.get(task_index) else {
        return Err(format!(
            "task index {task_index} out of range (found {} top-level tasks)",
            top_indices.len(),
        ));
    };
    let next_top = top_indices
        .get(task_index + 1)
        .copied()
        .unwrap_or(lines.len());
    let mut insert_at = start_idx + 1;
    while insert_at < next_top {
        let t = lines[insert_at].trim_end_matches('\n');
        if t.starts_with("> note:") {
            insert_at += 1;
        } else {
            break;
        }
    }
    let mut out = String::with_capacity(body.len() + note.len() + 16);
    for (i, line) in lines.iter().enumerate() {
        if i == insert_at {
            out.push_str(&format!("> note: {note}\n"));
        }
        out.push_str(line);
    }
    if insert_at == lines.len() {
        out.push_str(&format!("> note: {note}\n"));
    }
    Ok(out)
}

pub fn count_top_level_tasks(body: &str) -> (usize, usize) {
    let mut total = 0;
    let mut done = 0;
    for line in body.lines() {
        if line.starts_with("- [ ] ") {
            total += 1;
        } else if line.starts_with("- [x] ") {
            total += 1;
            done += 1;
        }
    }
    (total, done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_top_level_tasks_counts_only_top_level() {
        let body = "- [ ] A\n  - [ ] sub\n- [x] B\n- [ ] C\n";
        assert_eq!(count_top_level_tasks(body), (3, 1));
    }

    #[test]
    fn frontmatter_extracts_spec_relative_path() {
        let body = "---\nspec: ../specs/2026-05-04-foo-design.md\n---\n\n# Plan\n";
        let got = parse_plan_frontmatter_spec(body);
        assert_eq!(got, Some("../specs/2026-05-04-foo-design.md".to_string()));
    }

    #[test]
    fn frontmatter_missing_returns_none() {
        let body = "# Plan without frontmatter\n\nstuff\n";
        assert_eq!(parse_plan_frontmatter_spec(body), None);
    }

    #[test]
    fn frontmatter_without_spec_field_returns_none() {
        let body = "---\nauthor: x\n---\n\n# Plan\n";
        assert_eq!(parse_plan_frontmatter_spec(body), None);
    }

    #[test]
    fn frontmatter_with_quoted_value_extracts_unquoted() {
        let body = "---\nspec: \"../specs/foo-design.md\"\n---\n";
        assert_eq!(
            parse_plan_frontmatter_spec(body),
            Some("../specs/foo-design.md".to_string()),
        );
    }

    #[test]
    fn frontmatter_asymmetric_quote_stays_literal() {
        // A stray leading or trailing quote must NOT be silently stripped.
        let body = "---\nspec: \"../specs/foo-design.md\n---\n";
        assert_eq!(
            parse_plan_frontmatter_spec(body),
            Some("\"../specs/foo-design.md".to_string()),
        );
    }

    use std::fs;
    use tempfile::tempdir;

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn resolve_plan_prefers_frontmatter_match() {
        let dir = tempdir().unwrap();
        let specs = dir.path().join("docs/superpowers/specs");
        let plans = dir.path().join("docs/superpowers/plans");
        let spec = specs.join("2026-05-04-foo-design.md");
        let frontmatter_plan = plans.join("unrelated-name.md");
        let convention_plan = plans.join("2026-05-04-foo.md");
        write(&spec, "# spec\n");
        write(
            &frontmatter_plan,
            "---\nspec: ../specs/2026-05-04-foo-design.md\n---\n# plan\n",
        );
        write(&convention_plan, "# also a plan\n");
        let got = resolve_plan_for_spec(&spec, &plans).unwrap();
        // Compare via canonicalize so /private/tmp vs /tmp on macOS doesn't trip us.
        assert_eq!(
            got.map(|p| fs::canonicalize(p).unwrap()),
            Some(fs::canonicalize(&frontmatter_plan).unwrap()),
        );
    }

    #[test]
    fn resolve_plan_falls_back_to_filename_convention() {
        let dir = tempdir().unwrap();
        let specs = dir.path().join("docs/superpowers/specs");
        let plans = dir.path().join("docs/superpowers/plans");
        let spec = specs.join("2026-05-04-foo-design.md");
        let plan = plans.join("2026-05-04-foo.md");
        write(&spec, "# spec\n");
        write(&plan, "# plan no frontmatter\n");
        let got = resolve_plan_for_spec(&spec, &plans).unwrap();
        assert_eq!(
            got.map(|p| fs::canonicalize(p).unwrap()),
            Some(fs::canonicalize(&plan).unwrap()),
        );
    }

    #[test]
    fn resolve_plan_returns_none_when_no_match() {
        let dir = tempdir().unwrap();
        let specs = dir.path().join("docs/superpowers/specs");
        let plans = dir.path().join("docs/superpowers/plans");
        let spec = specs.join("2026-05-04-foo-design.md");
        write(&spec, "# spec\n");
        fs::create_dir_all(&plans).unwrap();
        assert_eq!(resolve_plan_for_spec(&spec, &plans).unwrap(), None);
    }

    #[test]
    fn mark_plan_task_flips_unchecked_to_checked() {
        let body = "# Plan\n\n- [ ] Task A\n- [ ] Task B\n- [ ] Task C\n";
        let out = mark_plan_task_in_body(body, 1, true).unwrap();
        assert_eq!(out, "# Plan\n\n- [ ] Task A\n- [x] Task B\n- [ ] Task C\n",);
    }

    #[test]
    fn mark_plan_task_flips_checked_to_unchecked() {
        let body = "- [x] A\n- [x] B\n";
        let out = mark_plan_task_in_body(body, 0, false).unwrap();
        assert_eq!(out, "- [ ] A\n- [x] B\n");
    }

    #[test]
    fn mark_plan_task_skips_indented_subtasks() {
        let body = "- [ ] A\n  - [ ] sub\n- [ ] B\n";
        let out = mark_plan_task_in_body(body, 1, true).unwrap();
        assert_eq!(out, "- [ ] A\n  - [ ] sub\n- [x] B\n");
    }

    #[test]
    fn mark_plan_task_index_out_of_range_errors() {
        let body = "- [ ] A\n";
        assert!(mark_plan_task_in_body(body, 5, true).is_err());
    }

    #[test]
    fn append_plan_note_inserts_under_task() {
        let body = "- [ ] A\n- [ ] B\n";
        let out = append_plan_note_in_body(body, 0, "tried approach X").unwrap();
        assert_eq!(out, "- [ ] A\n> note: tried approach X\n- [ ] B\n");
    }

    #[test]
    fn append_plan_note_appends_after_existing_notes() {
        let body = "- [ ] A\n> note: first\n- [ ] B\n";
        let out = append_plan_note_in_body(body, 0, "second").unwrap();
        assert_eq!(out, "- [ ] A\n> note: first\n> note: second\n- [ ] B\n",);
    }

    #[test]
    fn append_plan_note_at_eof_when_last_task() {
        let body = "- [ ] A\n";
        let out = append_plan_note_in_body(body, 0, "done").unwrap();
        assert_eq!(out, "- [ ] A\n> note: done\n");
    }

    #[test]
    fn append_plan_note_rejects_newlines_in_text() {
        let body = "- [ ] A\n";
        assert!(append_plan_note_in_body(body, 0, "line1\nline2").is_err());
    }
}
