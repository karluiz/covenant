use crate::{canon_dir, read_manifest, CanonError};
use std::path::Path;

const START: &str = "<!-- canon:start -->";
const END: &str = "<!-- canon:end -->";

/// Sync state of one executor's projected files versus the current Canon sources.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjState {
    Synced,
    Stale,
    NotProjected,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExecutorStatus {
    pub tool: String,
    pub state: ProjState,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProjectionStatus {
    pub executors: Vec<ExecutorStatus>,
    /// Newest mtime (unix secs) under `.covenant/canon/`, or `None` if no sources.
    pub source_edited_unix: Option<u64>,
}

/// Remove the top-level `covenant:` mapping from a doc's leading `---`…`---`
/// frontmatter. The key line and every following indented (or blank) line up to
/// the next top-level key (or the closing fence) is dropped. Body is untouched.
/// ponytail: line-based, not a real YAML parse — handles single-level nesting,
/// which is all the `covenant:` block uses. Swap to serde_yaml if it grows.
fn strip_covenant_block(md: &str) -> String {
    let lines: Vec<&str> = md.lines().collect();
    let open = match lines.iter().position(|l| l.trim() == "---") {
        Some(i) => i,
        None => return md.to_string(),
    };
    let close = match lines.iter().skip(open + 1).position(|l| l.trim() == "---") {
        Some(i) => open + 1 + i,
        None => return md.to_string(),
    };
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let in_fm = i > open && i < close;
        // top-level key (no indent) named exactly `covenant:`
        if in_fm && line == line.trim_start() && line.trim_start().starts_with("covenant:") {
            i += 1;
            while i < close {
                let child = lines[i];
                if child.trim().is_empty() || child.starts_with(' ') || child.starts_with('\t') {
                    i += 1;
                } else {
                    break;
                }
            }
            continue;
        }
        out.push(line);
        i += 1;
    }
    let mut s = out.join("\n");
    if md.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// `(file_stem, contents)` for every `*.md` directly under `dir`, sorted by stem.
/// Returns an empty Vec when `dir` does not exist.
pub(crate) fn read_dir_md(dir: &Path) -> Result<Vec<(String, String)>, CanonError> {
    let mut out: Vec<(String, String)> = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        out.push((stem, std::fs::read_to_string(&path)?));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Project operator personas into Claude's native multi-agent dir.
/// Executors that read a multi-file AGENT dir (file-per-item). One persona per
/// `.md`. Add an executor by adding its dir here.
pub(crate) const AGENT_DIRS: &[&str] = &[".claude/agents", ".opencode/agent"];

/// Executors that read multi-file SKILL dirs (the Superpowers `SKILL.md`
/// convention). Skills and full context bodies land here as `canon-<name>/SKILL.md`.
pub(crate) const SKILL_DIRS: &[&str] = &[".claude/skills", ".pi/skills"];

/// Executors that read a multi-file COMMAND dir as file-per-item `<name>.md`
/// slash commands. Codex has no project-level commands; Copilot uses a
/// different extension/frontmatter — both deferred. Add an executor here.
pub(crate) const COMMAND_DIRS: &[&str] = &[".claude/commands", ".opencode/commands", ".pi/prompts"];

/// Write each `<stem>.md` (covenant block stripped) into every dir in `dirs`.
/// Shared by agents and commands — the two file-per-item projection kinds.
fn project_file_per_item(
    repo_root: &Path,
    dirs: &[&str],
    items: &[(String, String)],
) -> Result<(), CanonError> {
    if items.is_empty() {
        return Ok(());
    }
    for base in dirs {
        let dir = repo_root.join(base);
        std::fs::create_dir_all(&dir)?;
        for (stem, raw) in items {
            std::fs::write(dir.join(format!("{stem}.md")), strip_covenant_block(raw))?;
        }
    }
    Ok(())
}

fn project_agents(repo_root: &Path, agents: &[(String, String)]) -> Result<(), CanonError> {
    project_file_per_item(repo_root, AGENT_DIRS, agents)
}

fn project_commands(repo_root: &Path, commands: &[(String, String)]) -> Result<(), CanonError> {
    project_file_per_item(repo_root, COMMAND_DIRS, commands)
}

/// Write `canon-<name>/SKILL.md` (with content already prepared) into every
/// executor SKILL dir.
fn write_skill_dirs(repo_root: &Path, name: &str, content: &str) -> Result<(), CanonError> {
    for base in SKILL_DIRS {
        let dir = repo_root.join(base).join(format!("canon-{name}"));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("SKILL.md"), content)?;
    }
    Ok(())
}

/// Remove `canon-*` skill dirs under SKILL_DIRS whose name isn't in `keep`.
/// Makes skill projection reconciling: a source that's gone (uninstalled or
/// hand-deleted) stops shadowing executors on the next `project()`. Touches
/// ONLY `canon-`-prefixed dirs — user-authored skill dirs are never removed.
fn prune_stale_skill_dirs(
    repo_root: &Path,
    keep: &std::collections::HashSet<String>,
) -> Result<(), CanonError> {
    for base in SKILL_DIRS {
        let dir = repo_root.join(base);
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue, // dir doesn't exist yet → nothing to prune
        };
        for entry in entries {
            let path = entry?.path();
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n,
                None => continue,
            };
            if let Some(skill) = name.strip_prefix("canon-") {
                if !keep.contains(skill) && path.is_dir() {
                    std::fs::remove_dir_all(&path)?;
                }
            }
        }
    }
    Ok(())
}

/// Project the FULL body of each regulatory context doc into an on-demand Claude
/// skill dir. The `summary:` frontmatter is dropped here (it rides the managed
/// block instead — see project_managed_block) and Claude frontmatter is re-added.
fn project_context_skills(
    repo_root: &Path,
    contexts: &[(String, String)],
) -> Result<(), CanonError> {
    for (stem, raw) in contexts {
        let body = body_after_frontmatter(raw);
        write_skill_dirs(repo_root, stem, &ensure_frontmatter(stem, body))?;
    }
    Ok(())
}

/// First top-level `<key>:` value inside the leading frontmatter, trimmed and
/// dequoted. `None` if there is no frontmatter or no non-empty value.
/// ponytail: single-line values only; add block-scalar support if needed.
pub(crate) fn parse_frontmatter_str(md: &str, key: &str) -> Option<String> {
    let lines: Vec<&str> = md.lines().collect();
    let open = lines.iter().position(|l| l.trim() == "---")?;
    let close = open
        + 1
        + lines
            .iter()
            .skip(open + 1)
            .position(|l| l.trim() == "---")?;
    let prefix = format!("{key}:");
    for l in &lines[open + 1..close] {
        if let Some(rest) = l.strip_prefix(&prefix) {
            let v = rest.trim().trim_matches('"').trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

pub(crate) fn parse_summary(md: &str) -> Option<String> {
    parse_frontmatter_str(md, "summary")
}

/// Markdown body after the closing `---` of a leading frontmatter block.
/// Returns the input unchanged when there is no frontmatter.
fn body_after_frontmatter(md: &str) -> &str {
    let s = md.trim_start_matches('\n');
    if let Some(rest) = s.strip_prefix("---") {
        if let Some(idx) = rest.find("\n---") {
            // skip past the closing fence line
            let after = &rest[idx + 1..]; // at the "---" line
            if let Some(nl) = after.find('\n') {
                return after[nl + 1..].trim_start_matches('\n');
            }
        }
    }
    md
}

/// Ensure a SKILL.md body has YAML frontmatter required by Claude Code.
/// If the body already starts with `---`, it is returned unchanged (idempotent).
/// Otherwise, a minimal frontmatter block is prepended, deriving the description
/// from the first Markdown heading or falling back to a default.
fn ensure_frontmatter(pkg: &str, body: &str) -> String {
    if body.trim_start().starts_with("---") {
        return body.to_string();
    }
    let desc = body
        .lines()
        .find(|l| l.trim_start().starts_with('#'))
        .map(|l| l.trim_start_matches('#').trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("Canon context: {pkg}"));
    format!("---\nname: canon-{pkg}\ndescription: {desc}\n---\n\n{body}")
}

/// Remove the `<!-- canon:start -->...<!-- canon:end -->` managed block (and trim
/// surrounding blank lines). Returns the input unchanged if no block is present.
fn strip_block(existing: &str) -> String {
    if let (Some(s), Some(e)) = (existing.find(START), existing.find(END)) {
        if s < e {
            let end = e + END.len();
            // Drop the span and clean up any surrounding whitespace/blank lines.
            let before = existing[..s].trim_end();
            let after = existing[end..].trim_start_matches('\n');
            if before.is_empty() {
                // block was at the very top
                after.to_string()
            } else if after.is_empty() {
                format!("{before}\n")
            } else {
                format!("{before}\n\n{after}")
            }
        } else {
            existing.to_string()
        }
    } else {
        existing.to_string()
    }
}

/// Build the concatenated managed-block body shared by codex/copilot/hermes.
/// Returns `None` when there is nothing to project (block should be absent).
/// Extracted from `project_with_active` so `projection_status` reuses the exact
/// same generator (ponytail: one source of truth for the block string).
fn managed_body(
    active_agent: Option<&str>,
    agents: &[(String, String)],
    skills: &[(String, String, String)],
    contexts: &[(String, String)],
    memories: &[(String, String)],
) -> Option<String> {
    let mut sections: Vec<String> = Vec::new();
    if let Some(name) = active_agent {
        if let Some((stem, raw)) = agents.iter().find(|(s, _)| s == name) {
            sections.push(format!(
                "## {stem} (operator)\n\n{}",
                body_after_frontmatter(raw).trim()
            ));
        }
    }
    for (name, v, body) in skills {
        sections.push(format!("## {name} v{v}\n\n{}", body.trim()));
    }
    for (stem, raw) in contexts {
        if let Some(sum) = parse_summary(raw) {
            sections.push(format!("## {stem} (context)\n\n{sum}"));
        }
    }
    let mem_bullets: Vec<String> = memories
        .iter()
        .filter_map(|(_, raw)| {
            parse_frontmatter_str(raw, "description")
                .or_else(|| {
                    body_after_frontmatter(raw)
                        .lines()
                        .map(|l| l.trim())
                        .find(|l| !l.is_empty())
                        .map(|s| s.to_string())
                })
                .filter(|s| !s.is_empty())
                .map(|fact| format!("- {fact}"))
        })
        .collect();
    if !mem_bullets.is_empty() {
        sections.push(format!("## Memory\n\n{}", mem_bullets.join("\n")));
    }
    if sections.is_empty() {
        return None;
    }
    Some(format!(
        "# Canon context (auto-generated — do not edit inside this block)\n\n{}",
        sections.join("\n\n")
    ))
}

#[derive(Clone, Copy, PartialEq)]
enum Check {
    Missing,
    Match,
    Differ,
}

fn check_file(path: &Path, expected: &str) -> Check {
    match std::fs::read_to_string(path) {
        Ok(actual) if actual == expected => Check::Match,
        Ok(_) => Check::Differ,
        Err(_) => Check::Missing,
    }
}

/// A managed-block file is synced iff re-upserting the current body is a no-op.
/// `body == None` means the block should be absent.
fn check_managed(path: &Path, body: Option<&str>) -> Check {
    let existing = std::fs::read_to_string(path);
    match (body, existing) {
        (Some(b), Ok(cur)) => {
            if !cur.contains(START) {
                Check::Missing
            } else if upsert_block(&cur, b) == cur {
                Check::Match
            } else {
                Check::Differ
            }
        }
        (Some(_), Err(_)) => Check::Missing,
        (None, Ok(cur)) => {
            if cur.contains(START) {
                Check::Differ
            } else {
                Check::Match
            }
        }
        (None, Err(_)) => Check::Match,
    }
}

fn aggregate(checks: &[Check]) -> ProjState {
    if checks.is_empty() || checks.iter().all(|c| *c == Check::Missing) {
        return ProjState::NotProjected;
    }
    if checks.iter().all(|c| *c == Check::Match) {
        return ProjState::Synced;
    }
    ProjState::Stale
}

/// Newest mtime (unix secs) of any file under `.covenant/canon/`.
fn newest_source_mtime(repo_root: &Path) -> Option<u64> {
    fn walk(dir: &Path, newest: &mut u64) {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, newest);
                } else if let Ok(m) = e.metadata() {
                    if let Ok(mt) = m.modified() {
                        if let Ok(d) = mt.duration_since(std::time::UNIX_EPOCH) {
                            *newest = (*newest).max(d.as_secs());
                        }
                    }
                }
            }
        }
    }
    let dir = canon_dir(repo_root);
    if !dir.exists() {
        return None;
    }
    let mut newest = 0u64;
    walk(&dir, &mut newest);
    (newest > 0).then_some(newest)
}

/// Read-only: compare each executor's projected files against what `project()`
/// would currently write, without touching disk. Reuses the same content
/// helpers as projection, so "synced" means byte-identical to a fresh project.
pub fn projection_status(repo_root: &Path) -> Result<ProjectionStatus, CanonError> {
    const TOOLS: [&str; 5] = ["claude", "opencode", "pi", "codex", "copilot"];

    let manifest = read_manifest(repo_root)?;
    let skills_dir = canon_dir(repo_root).join("skills");
    let agents = read_dir_md(&canon_dir(repo_root).join("agents"))?;
    let contexts = read_dir_md(&canon_dir(repo_root).join("context"))?;
    let commands = read_dir_md(&canon_dir(repo_root).join("commands"))?;
    let memories = read_dir_md(&canon_dir(repo_root).join("memory"))?;
    let mcp_servers = crate::mcp::read_mcp_servers(repo_root)?;
    let mut skills: Vec<(String, String, String)> = Vec::new();
    for i in &manifest.installed {
        let md = skills_dir.join(&i.name).join("SKILL.md");
        skills.push((
            i.name.clone(),
            i.version.clone(),
            std::fs::read_to_string(&md)?,
        ));
    }

    // No sources at all → nothing is projected anywhere.
    if agents.is_empty()
        && skills.is_empty()
        && contexts.is_empty()
        && commands.is_empty()
        && mcp_servers.is_empty()
        && memories.is_empty()
    {
        return Ok(ProjectionStatus {
            executors: TOOLS
                .iter()
                .map(|t| ExecutorStatus {
                    tool: t.to_string(),
                    state: ProjState::NotProjected,
                })
                .collect(),
            source_edited_unix: None,
        });
    }

    // Expected file-per-item content: (tool, absolute path, expected bytes).
    let mut files: Vec<(&str, std::path::PathBuf, String)> = Vec::new();
    for (stem, raw) in &agents {
        let content = strip_covenant_block(raw);
        files.push((
            "claude",
            repo_root.join(".claude/agents").join(format!("{stem}.md")),
            content.clone(),
        ));
        files.push((
            "opencode",
            repo_root.join(".opencode/agent").join(format!("{stem}.md")),
            content,
        ));
    }
    for (name, _v, body) in &skills {
        let content = ensure_frontmatter(name, body);
        files.push((
            "claude",
            repo_root
                .join(".claude/skills")
                .join(format!("canon-{name}"))
                .join("SKILL.md"),
            content.clone(),
        ));
        files.push((
            "pi",
            repo_root
                .join(".pi/skills")
                .join(format!("canon-{name}"))
                .join("SKILL.md"),
            content,
        ));
    }
    for (stem, raw) in &contexts {
        let content = ensure_frontmatter(stem, body_after_frontmatter(raw));
        files.push((
            "claude",
            repo_root
                .join(".claude/skills")
                .join(format!("canon-{stem}"))
                .join("SKILL.md"),
            content.clone(),
        ));
        files.push((
            "pi",
            repo_root
                .join(".pi/skills")
                .join(format!("canon-{stem}"))
                .join("SKILL.md"),
            content,
        ));
    }
    for (stem, raw) in &commands {
        let content = strip_covenant_block(raw);
        files.push((
            "claude",
            repo_root
                .join(".claude/commands")
                .join(format!("{stem}.md")),
            content.clone(),
        ));
        files.push((
            "opencode",
            repo_root
                .join(".opencode/commands")
                .join(format!("{stem}.md")),
            content.clone(),
        ));
        files.push((
            "pi",
            repo_root.join(".pi/prompts").join(format!("{stem}.md")),
            content,
        ));
    }

    let body = managed_body(None, &agents, &skills, &contexts, &memories);

    let mut checks: std::collections::BTreeMap<&str, Vec<Check>> =
        std::collections::BTreeMap::new();
    for (tool, path, expected) in &files {
        checks
            .entry(tool)
            .or_default()
            .push(check_file(path, expected));
    }
    // Managed-block executors. codex + opencode both read AGENTS.md.
    let agents_md = repo_root.join("AGENTS.md");
    checks
        .entry("codex")
        .or_default()
        .push(check_managed(&agents_md, body.as_deref()));
    checks
        .entry("opencode")
        .or_default()
        .push(check_managed(&agents_md, body.as_deref()));
    checks.entry("copilot").or_default().push(check_managed(
        &repo_root.join(".github/copilot-instructions.md"),
        body.as_deref(),
    ));

    let mut executors: Vec<ExecutorStatus> = TOOLS
        .iter()
        .map(|t| ExecutorStatus {
            tool: t.to_string(),
            state: aggregate(checks.get(t).map(|v| v.as_slice()).unwrap_or(&[])),
        })
        .collect();

    // MCP is projected only to claude/opencode/codex, as a structured config
    // merge. Downgrade a tool to Stale when its canon-* MCP servers don't match;
    // upgrade a not-projected tool to Synced when MCP is its only (matching)
    // source. Never falsely downgrade for an absent managed block.
    if !mcp_servers.is_empty() {
        for e in executors.iter_mut() {
            if !matches!(e.tool.as_str(), "claude" | "opencode" | "codex") {
                continue;
            }
            if !crate::mcp::mcp_synced(repo_root, &e.tool, &mcp_servers) {
                e.state = ProjState::Stale;
            } else if e.state == ProjState::NotProjected
                && checks.get(e.tool.as_str()).map_or(true, |v| v.is_empty())
            {
                // Only upgrade when NO non-MCP content applies to this tool —
                // an all-Missing checks set (content exists but un-projected)
                // must stay NotProjected, not be masked as Synced by a matching MCP.
                e.state = ProjState::Synced;
            }
        }
    }

    Ok(ProjectionStatus {
        executors,
        source_edited_unix: newest_source_mtime(repo_root),
    })
}

/// Generate every executor's native files from the repo's Canon sources.
pub fn project(repo_root: &Path) -> Result<(), CanonError> {
    project_with_active(repo_root, None)
}

/// Like `project`, but also folds the currently-attached operator's persona into
/// the managed-block executors (codex/copilot run one persona at a time).
pub fn project_with_active(repo_root: &Path, active_agent: Option<&str>) -> Result<(), CanonError> {
    let manifest = read_manifest(repo_root)?;
    let skills_dir = canon_dir(repo_root).join("skills");

    // Sources.
    let agents = read_dir_md(&canon_dir(repo_root).join("agents"))?;
    let contexts = read_dir_md(&canon_dir(repo_root).join("context"))?;
    let commands = read_dir_md(&canon_dir(repo_root).join("commands"))?;
    let memories = read_dir_md(&canon_dir(repo_root).join("memory"))?;
    let mcp_servers = crate::mcp::read_mcp_servers(repo_root)?;
    let mut skills: Vec<(String, String, String)> = Vec::new(); // (name, version, body)
    for i in &manifest.installed {
        let md = skills_dir.join(&i.name).join("SKILL.md");
        skills.push((
            i.name.clone(),
            i.version.clone(),
            std::fs::read_to_string(&md)?,
        ));
    }

    // File-per-item executors (Claude, opencode, pi): one file per artifact.
    project_agents(repo_root, &agents)?;
    project_context_skills(repo_root, &contexts)?;
    project_commands(repo_root, &commands)?;
    crate::mcp::project_mcp(repo_root, &mcp_servers)?;
    // Build keep set: installed skills + context names (both are projected as canon-* dirs).
    let mut keep: std::collections::HashSet<String> =
        skills.iter().map(|(n, _, _)| n.clone()).collect();
    for (name, _) in &contexts {
        keep.insert(name.clone());
    }
    prune_stale_skill_dirs(repo_root, &keep)?;
    for (name, _v, body) in &skills {
        write_skill_dirs(repo_root, name, &ensure_frontmatter(name, body))?;
    }

    // Managed-block executors (codex, copilot): one concatenated block.
    match managed_body(active_agent, &agents, &skills, &contexts, &memories) {
        None => {
            // `.hermes.md` is stripped only if present (the loop guards on exists).
            for rel in ["AGENTS.md", ".github/copilot-instructions.md", ".hermes.md"] {
                let path = repo_root.join(rel);
                if path.exists() {
                    let existing = std::fs::read_to_string(&path)?;
                    std::fs::write(&path, strip_block(&existing))?;
                }
            }
        }
        Some(body) => {
            // codex + opencode read AGENTS.md; copilot reads its own file.
            for rel in ["AGENTS.md", ".github/copilot-instructions.md"] {
                upsert_file(repo_root, rel, &body)?;
            }
            // Hermes reads AGENTS.md, but a project-local `.hermes.md` shadows it.
            // Mirror the block into `.hermes.md` only when it already exists.
            if repo_root.join(".hermes.md").exists() {
                upsert_file(repo_root, ".hermes.md", &body)?;
            }
        }
    }
    Ok(())
}

fn upsert_file(repo_root: &Path, rel: &str, body: &str) -> Result<(), CanonError> {
    let path = repo_root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    std::fs::write(&path, upsert_block(&existing, body))?;
    Ok(())
}

fn upsert_block(existing: &str, body: &str) -> String {
    let block = format!("{START}\n{body}\n{END}");
    if let (Some(s), Some(e)) = (existing.find(START), existing.find(END)) {
        if s < e {
            let end = e + END.len();
            return format!("{}{}{}", &existing[..s], block, &existing[end..]);
        }
        // malformed (END before START): fall through to append a fresh block
    }
    if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", existing.trim_end())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{write_manifest, CanonManifest, InstalledRef};

    #[test]
    fn strip_covenant_removes_block_keeps_standard_keys() {
        let md = "---\nname: kyc-reviewer\nmodel: claude-sonnet-4-6\ncovenant:\n  escalate_threshold: 0.7\n  voice: formal\ntools: [Read]\n---\nbody text\n";
        let out = strip_covenant_block(md);
        assert!(out.contains("name: kyc-reviewer"));
        assert!(out.contains("model: claude-sonnet-4-6"));
        assert!(
            out.contains("tools: [Read]"),
            "key after covenant block must survive"
        );
        assert!(!out.contains("covenant:"), "covenant key removed");
        assert!(
            !out.contains("escalate_threshold"),
            "covenant children removed"
        );
        assert!(out.contains("body text"), "body untouched");
    }

    #[test]
    fn strip_covenant_noop_without_block() {
        let md = "---\nname: x\n---\nbody\n";
        assert_eq!(strip_covenant_block(md), md);
    }

    #[test]
    fn body_after_frontmatter_returns_body() {
        let md = "---\nsummary: short\n---\nfull body here\n";
        assert_eq!(body_after_frontmatter(md), "full body here\n");
    }

    #[test]
    fn body_after_frontmatter_noop_when_no_frontmatter() {
        let md = "no frontmatter here\n";
        assert_eq!(body_after_frontmatter(md), md);
    }

    #[test]
    fn parse_summary_reads_frontmatter_line() {
        let md = "---\nsummary: \"Mask all PII; cite SBS article.\"\n---\nfull text\n";
        assert_eq!(
            parse_summary(md).as_deref(),
            Some("Mask all PII; cite SBS article.")
        );
    }

    #[test]
    fn parse_summary_none_when_absent() {
        let md = "---\nname: x\n---\nbody\n";
        assert_eq!(parse_summary(md), None);
    }

    #[test]
    fn project_agents_writes_stripped_claude_files() {
        let base = std::env::temp_dir().join(format!("canon-agents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();
        let src = crate::canon_dir(&repo).join("agents");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("kyc-reviewer.md"),
            "---\nname: kyc-reviewer\nmodel: claude-sonnet-4-6\ncovenant:\n  voice: formal\n---\nReview KYC.\n",
        )
        .unwrap();

        let agents = read_dir_md(&src).unwrap();
        assert_eq!(agents.len(), 1);
        project_agents(&repo, &agents).unwrap();

        let out = repo.join(".claude/agents/kyc-reviewer.md");
        assert!(out.exists());
        let content = std::fs::read_to_string(&out).unwrap();
        assert!(content.contains("name: kyc-reviewer"));
        assert!(
            !content.contains("covenant:"),
            "covenant block must be stripped"
        );
        assert!(content.contains("Review KYC."));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn project_writes_opencode_and_pi_targets() {
        let base = std::env::temp_dir().join(format!("canon-multi-exec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();

        let adir = crate::canon_dir(&repo).join("agents");
        std::fs::create_dir_all(&adir).unwrap();
        std::fs::write(
            adir.join("kyc-reviewer.md"),
            "---\nname: kyc-reviewer\ncovenant:\n  voice: formal\n---\nReview KYC.\n",
        )
        .unwrap();
        let cdir = crate::canon_dir(&repo).join("context");
        std::fs::create_dir_all(&cdir).unwrap();
        std::fs::write(
            cdir.join("sbs-kyc.md"),
            "---\nsummary: Mask PII.\n---\n# SBS\nfull text\n",
        )
        .unwrap();
        crate::write_manifest(
            &repo,
            &CanonManifest {
                version: 1,
                installed: vec![],
            },
        )
        .unwrap();

        project(&repo).unwrap();

        // opencode gets the agent (covenant block stripped, same as Claude)
        let oc = repo.join(".opencode/agent/kyc-reviewer.md");
        assert!(oc.exists(), "opencode agent file written");
        assert!(
            !std::fs::read_to_string(&oc).unwrap().contains("covenant:"),
            "stripped for opencode too"
        );
        // pi gets the context body as a skill
        let pi = repo.join(".pi/skills/canon-sbs-kyc/SKILL.md");
        assert!(pi.exists(), "pi skill file written from context");
        assert!(std::fs::read_to_string(&pi).unwrap().contains("full text"));
        // Claude targets unchanged (regression)
        assert!(repo.join(".claude/agents/kyc-reviewer.md").exists());
        assert!(repo.join(".claude/skills/canon-sbs-kyc/SKILL.md").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn project_mirrors_block_into_existing_hermes_md_only() {
        let base = std::env::temp_dir().join(format!("canon-hermes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();
        let cdir = crate::canon_dir(&repo).join("context");
        std::fs::create_dir_all(&cdir).unwrap();
        std::fs::write(cdir.join("sbs.md"), "---\nsummary: Cite SBS.\n---\nbody\n").unwrap();
        crate::write_manifest(
            &repo,
            &CanonManifest {
                version: 1,
                installed: vec![],
            },
        )
        .unwrap();

        // No .hermes.md → must NOT be created (Hermes falls back to AGENTS.md).
        project(&repo).unwrap();
        assert!(
            !repo.join(".hermes.md").exists(),
            "must not create .hermes.md"
        );
        assert!(
            repo.join("AGENTS.md").exists(),
            "AGENTS.md written (Hermes reads it)"
        );

        // Existing .hermes.md → block mirrored in, user content preserved.
        std::fs::write(repo.join(".hermes.md"), "# My Hermes rules\n").unwrap();
        project(&repo).unwrap();
        let h = std::fs::read_to_string(repo.join(".hermes.md")).unwrap();
        assert!(h.contains("# My Hermes rules"), "user content preserved");
        assert!(
            h.contains("<!-- canon:start -->"),
            "canon block mirrored into .hermes.md"
        );
        assert!(h.contains("Cite SBS."), "context summary present");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn project_context_writes_claude_skill_from_body() {
        let base = std::env::temp_dir().join(format!("canon-ctx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();
        let src = crate::canon_dir(&repo).join("context");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("sbs-kyc.md"),
            "---\nsummary: Mask PII; cite SBS article.\n---\n# SBS KYC\nFull regulatory text.\n",
        )
        .unwrap();

        let contexts = read_dir_md(&src).unwrap();
        project_context_skills(&repo, &contexts).unwrap();

        let out = repo.join(".claude/skills/canon-sbs-kyc/SKILL.md");
        assert!(out.exists());
        let content = std::fs::read_to_string(&out).unwrap();
        assert!(
            content.starts_with("---\nname: canon-"),
            "must have Claude frontmatter"
        );
        assert!(
            content.contains("Full regulatory text."),
            "full body present"
        );
        assert!(
            !content.contains("summary: Mask PII"),
            "context frontmatter dropped"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn upsert_is_idempotent_and_single_block() {
        let once = upsert_block("", "BODY-A");
        let twice = upsert_block(&once, "BODY-A");
        assert_eq!(once, twice);
        assert_eq!(twice.matches("<!-- canon:start -->").count(), 1);
        // Replaces body, preserves surrounding text.
        let with_prefix = upsert_block("hand-written top\n", "BODY-B");
        assert!(with_prefix.starts_with("hand-written top"));
        let replaced = upsert_block(&with_prefix, "BODY-C");
        assert!(replaced.contains("BODY-C"));
        assert!(!replaced.contains("BODY-B"));
    }

    // I3: ensure_frontmatter adds YAML frontmatter for Claude Code.
    #[test]
    fn ensure_frontmatter_adds_header_from_heading() {
        let body = "# KYC Peru\nrules";
        let out = ensure_frontmatter("kyc-peru", body);
        assert!(
            out.starts_with("---\nname: canon-"),
            "must start with frontmatter"
        );
        assert!(
            out.contains("description: KYC Peru"),
            "must derive description from heading"
        );
        // Idempotent: a body already starting with --- is returned unchanged.
        let out2 = ensure_frontmatter("kyc-peru", &out);
        assert_eq!(out, out2, "must not add double frontmatter");
    }

    #[test]
    fn ensure_frontmatter_falls_back_to_default_when_no_heading() {
        let body = "Just some prose without a heading.";
        let out = ensure_frontmatter("my-pkg", body);
        assert!(out.contains("description: Canon context: my-pkg"));
    }

    // I3: project() writes SKILL.md with frontmatter for the claude executor.
    #[test]
    fn project_writes_claude_skill_with_frontmatter() {
        let base = std::env::temp_dir().join(format!("canon-proj-fm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();

        // Set up a minimal installed skill in .covenant/canon/skills/kyc-peru/SKILL.md
        let skills_dir = crate::canon_dir(&repo).join("skills/kyc-peru");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(skills_dir.join("SKILL.md"), "# KYC Peru\nrules\n").unwrap();

        // Write a manifest referencing that skill.
        let manifest = CanonManifest {
            version: 1,
            installed: vec![InstalledRef {
                name: "kyc-peru".into(),
                version: "1.0.0".into(),
                source: "local:test".into(),
                sha: "abc".into(),
                signer: Some("github:mibanco".into()),
                installed_at: "2024-01-01T00:00:00Z".into(),
            }],
        };
        write_manifest(&repo, &manifest).unwrap();

        project(&repo).unwrap();

        let skill_md = repo.join(".claude/skills/canon-kyc-peru/SKILL.md");
        assert!(skill_md.exists());
        let content = std::fs::read_to_string(&skill_md).unwrap();
        assert!(
            content.starts_with("---\nname: canon-"),
            "must have frontmatter"
        );
        assert!(
            content.contains("description: KYC Peru"),
            "must have description"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    // I2: project() strips the managed block from AGENTS.md when manifest is empty.
    #[test]
    fn project_strips_managed_block_when_empty_manifest() {
        let base = std::env::temp_dir().join(format!("canon-proj-strip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();
        std::fs::create_dir_all(&repo).unwrap();

        // Write AGENTS.md with a managed block already present.
        let agents_path = repo.join("AGENTS.md");
        std::fs::write(
            &agents_path,
            "hand-written\n\n<!-- canon:start -->\n# Canon context\n<!-- canon:end -->\n",
        )
        .unwrap();

        // Write an empty manifest.
        let manifest = CanonManifest {
            version: 1,
            installed: vec![],
        };
        write_manifest(&repo, &manifest).unwrap();

        project(&repo).unwrap();

        let content = std::fs::read_to_string(&agents_path).unwrap();
        assert!(
            !content.contains("<!-- canon:start -->"),
            "managed block must be stripped when manifest is empty"
        );
        assert!(
            content.contains("hand-written"),
            "surrounding content must be preserved"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    // strip_block unit tests.
    #[test]
    fn strip_block_removes_managed_span() {
        let input = "top\n\n<!-- canon:start -->\ninner\n<!-- canon:end -->\nbottom\n";
        let out = strip_block(input);
        assert!(!out.contains("<!-- canon:start -->"));
        assert!(out.contains("top"));
        assert!(out.contains("bottom"));
    }

    #[test]
    fn strip_block_noop_when_no_block() {
        let input = "just some text\n";
        assert_eq!(strip_block(input), input);
    }

    #[test]
    fn managed_block_includes_active_agent_and_context_summary() {
        let base = std::env::temp_dir().join(format!("canon-full-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();

        // an agent
        let adir = crate::canon_dir(&repo).join("agents");
        std::fs::create_dir_all(&adir).unwrap();
        std::fs::write(
            adir.join("kyc-reviewer.md"),
            "---\nname: kyc-reviewer\ncovenant:\n  voice: formal\n---\nReview KYC carefully.\n",
        )
        .unwrap();

        // a context doc with a summary
        let cdir = crate::canon_dir(&repo).join("context");
        std::fs::create_dir_all(&cdir).unwrap();
        std::fs::write(
            cdir.join("sbs-kyc.md"),
            "---\nsummary: Mask PII; cite SBS article.\n---\n# SBS KYC\nfull text\n",
        )
        .unwrap();

        // empty skills manifest
        crate::write_manifest(
            &repo,
            &CanonManifest {
                version: 1,
                installed: vec![],
            },
        )
        .unwrap();

        project_with_active(&repo, Some("kyc-reviewer")).unwrap();

        let agents_md = std::fs::read_to_string(repo.join("AGENTS.md")).unwrap();
        assert!(
            agents_md.contains("kyc-reviewer (operator)"),
            "active operator in block"
        );
        assert!(
            agents_md.contains("Review KYC carefully."),
            "operator body in block"
        );
        assert!(
            agents_md.contains("Mask PII; cite SBS article."),
            "context summary in block"
        );
        assert!(
            !agents_md.contains("full text"),
            "context FULL body must NOT be in managed block"
        );
        assert_eq!(agents_md.matches("<!-- canon:start -->").count(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn project_strips_block_when_everything_empty() {
        let base = std::env::temp_dir().join(format!("canon-empty-all-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(
            repo.join("AGENTS.md"),
            "hand-written\n\n<!-- canon:start -->\nold\n<!-- canon:end -->\n",
        )
        .unwrap();
        crate::write_manifest(
            &repo,
            &CanonManifest {
                version: 1,
                installed: vec![],
            },
        )
        .unwrap();

        project(&repo).unwrap();

        let content = std::fs::read_to_string(repo.join("AGENTS.md")).unwrap();
        assert!(
            !content.contains("<!-- canon:start -->"),
            "block stripped when all sources empty"
        );
        assert!(
            content.contains("hand-written"),
            "surrounding content preserved"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn projection_status_reports_synced_stale_and_not_projected() {
        let base = std::env::temp_dir().join(format!("canon-status-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();

        // One agent source + one context source, empty skills manifest.
        let adir = crate::canon_dir(&repo).join("agents");
        std::fs::create_dir_all(&adir).unwrap();
        std::fs::write(
            adir.join("kyc-reviewer.md"),
            "---\nname: kyc-reviewer\ncovenant:\n  voice: formal\n---\nReview KYC.\n",
        )
        .unwrap();
        let cdir = crate::canon_dir(&repo).join("context");
        std::fs::create_dir_all(&cdir).unwrap();
        std::fs::write(
            cdir.join("sbs.md"),
            "---\nsummary: Cite SBS.\n---\n# SBS\nfull\n",
        )
        .unwrap();
        write_manifest(
            &repo,
            &CanonManifest {
                version: 1,
                installed: vec![],
            },
        )
        .unwrap();

        // Before projecting: everything is not_projected.
        let st = projection_status(&repo).unwrap();
        let state = |tool: &str| {
            st.executors
                .iter()
                .find(|e| e.tool == tool)
                .unwrap()
                .state
                .clone()
        };
        assert_eq!(state("claude"), ProjState::NotProjected);
        assert_eq!(state("codex"), ProjState::NotProjected);
        assert!(
            st.source_edited_unix.is_some(),
            "sources exist → mtime present"
        );

        // After projecting: everything the sources touch is synced.
        project(&repo).unwrap();
        let st = projection_status(&repo).unwrap();
        let state = |tool: &str| {
            st.executors
                .iter()
                .find(|e| e.tool == tool)
                .unwrap()
                .state
                .clone()
        };
        assert_eq!(state("claude"), ProjState::Synced);
        assert_eq!(state("opencode"), ProjState::Synced);
        assert_eq!(state("codex"), ProjState::Synced);
        assert_eq!(state("copilot"), ProjState::Synced);
        // pi has no marketplace skills (empty manifest), but the context source is
        // also projected into `.pi/skills` (project_context_skills writes both
        // SKILL_DIRS), so pi is synced too.
        assert_eq!(state("pi"), ProjState::Synced);

        // Hand-edit Claude's projected agent file → claude goes stale, others stay synced.
        std::fs::write(repo.join(".claude/agents/kyc-reviewer.md"), "tampered\n").unwrap();
        let st = projection_status(&repo).unwrap();
        let state = |tool: &str| {
            st.executors
                .iter()
                .find(|e| e.tool == tool)
                .unwrap()
                .state
                .clone()
        };
        assert_eq!(state("claude"), ProjState::Stale);
        assert_eq!(state("codex"), ProjState::Synced);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn projection_status_empty_repo_all_not_projected() {
        let base = std::env::temp_dir().join(format!("canon-status-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();
        write_manifest(
            &repo,
            &CanonManifest {
                version: 1,
                installed: vec![],
            },
        )
        .unwrap();

        let st = projection_status(&repo).unwrap();
        assert!(st
            .executors
            .iter()
            .all(|e| e.state == ProjState::NotProjected));
        assert_eq!(st.source_edited_unix, None);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn project_commands_writes_all_three_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        let cmds = vec![(
            "deploy".to_string(),
            "---\ndescription: x\n---\nRun deploy\n".to_string(),
        )];
        project_commands(repo, &cmds).unwrap();
        assert!(repo.join(".claude/commands/deploy.md").exists());
        assert!(repo.join(".opencode/commands/deploy.md").exists());
        assert!(repo.join(".pi/prompts/deploy.md").exists());
        let written = std::fs::read_to_string(repo.join(".claude/commands/deploy.md")).unwrap();
        assert!(written.contains("Run deploy"));
    }

    #[test]
    fn projection_status_flags_stale_command() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        std::fs::create_dir_all(repo.join(".covenant/canon/commands")).unwrap();
        std::fs::write(
            repo.join(".covenant/canon/commands/deploy.md"),
            "Run deploy\n",
        )
        .unwrap();
        project(repo).unwrap();
        // Tamper the projected claude command → claude must read stale.
        std::fs::write(repo.join(".claude/commands/deploy.md"), "tampered\n").unwrap();
        let st = projection_status(repo).unwrap();
        let claude = st.executors.iter().find(|e| e.tool == "claude").unwrap();
        assert_eq!(claude.state, ProjState::Stale);
    }

    #[test]
    fn projection_status_flags_stale_mcp() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        std::fs::create_dir_all(repo.join(".covenant/canon/mcp")).unwrap();
        std::fs::write(
            repo.join(".covenant/canon/mcp/ctx7.json"),
            r#"{"command":"npx"}"#,
        )
        .unwrap();
        project(repo).unwrap();
        // Tamper the projected Claude MCP config.
        std::fs::write(
            repo.join(".mcp.json"),
            r#"{"mcpServers":{"canon-ctx7":{"command":"TAMPERED"}}}"#,
        )
        .unwrap();
        let st = projection_status(repo).unwrap();
        let claude = st.executors.iter().find(|e| e.tool == "claude").unwrap();
        assert_eq!(claude.state, ProjState::Stale);
    }

    /// Regression: `NotProjected` from `aggregate()` is overloaded — it means
    /// both "no checks apply" AND "non-MCP content exists but is un-projected".
    /// The MCP fold's upgrade branch must only fire in the former case, never
    /// masking pending managed-block content as Synced just because the tool's
    /// MCP config happens to already match.
    #[test]
    fn projection_status_mcp_fold_does_not_mask_unprojected_context() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        // MCP source only — project() projects the MCP config but there is no
        // managed-block content yet, so AGENTS.md is never written.
        std::fs::create_dir_all(repo.join(".covenant/canon/mcp")).unwrap();
        std::fs::write(
            repo.join(".covenant/canon/mcp/ctx7.json"),
            r#"{"command":"npx"}"#,
        )
        .unwrap();
        project(repo).unwrap();
        assert!(!repo.join("AGENTS.md").exists(), "no managed content yet");

        // Now add un-projected context content (a `summary:` folds into the
        // managed block) WITHOUT re-running project(). codex's MCP config still
        // matches, but the context doc was never folded into AGENTS.md.
        std::fs::create_dir_all(repo.join(".covenant/canon/context")).unwrap();
        std::fs::write(
            repo.join(".covenant/canon/context/kyc.md"),
            "---\nsummary: Mask PII.\n---\nbody\n",
        )
        .unwrap();

        let st = projection_status(repo).unwrap();
        let codex = st.executors.iter().find(|e| e.tool == "codex").unwrap();
        assert_ne!(
            codex.state,
            ProjState::Synced,
            "un-projected managed content must not be masked as Synced by a matching MCP fold"
        );
        assert_eq!(codex.state, ProjState::NotProjected);
    }

    #[test]
    fn project_writes_memory_section_into_agents_md() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        let dir = repo.join(".covenant/canon/memory");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("decision-x.md"),
            "---\ndescription: We chose X\n---\nbody\n",
        )
        .unwrap();
        project(repo).unwrap();
        let agents_md = std::fs::read_to_string(repo.join("AGENTS.md")).unwrap();
        assert!(agents_md.contains("## Memory"), "memory heading present");
        assert!(agents_md.contains("- We chose X"), "memory bullet present");
    }

    #[test]
    fn projection_status_flags_stale_memory() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        let dir = repo.join(".covenant/canon/memory");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("decision-x.md"),
            "---\ndescription: We chose X\n---\nbody\n",
        )
        .unwrap();
        project(repo).unwrap();
        // Edit the memory source WITHOUT re-projecting. The managed block in AGENTS.md
        // still says "We chose X" but the expected block now says "We chose Y" → the
        // block's START marker is present but its content differs → check_managed → Differ
        // → codex Stale. (Rewriting AGENTS.md to drop the marker entirely would instead
        // read as Missing → NotProjected, which is not what we want to assert here.)
        std::fs::write(
            dir.join("decision-x.md"),
            "---\ndescription: We chose Y\n---\nbody\n",
        )
        .unwrap();
        let st = projection_status(repo).unwrap();
        let codex = st.executors.iter().find(|e| e.tool == "codex").unwrap();
        assert_eq!(codex.state, ProjState::Stale);
    }

    #[test]
    fn project_prunes_stale_canon_skill_dirs_keeps_installed_and_user_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        // A real installed skill (manifest + source), so projection re-creates its dir.
        let src = root.join(".covenant/canon/skills/kept");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("skill.toml"),
            "name = \"kept\"\nversion = \"1.0.0\"\n",
        )
        .unwrap();
        std::fs::write(src.join("SKILL.md"), "---\nname: kept\n---\nbody\n").unwrap();
        let manifest = crate::CanonManifest {
            version: 1,
            installed: vec![crate::types::InstalledRef {
                name: "kept".into(),
                version: "1.0.0".into(),
                source: "local:x".into(),
                sha: "0".into(),
                signer: None,
                installed_at: "t".into(),
            }],
        };
        crate::write_manifest(root, &manifest).unwrap();

        // A stale canon- projection with no source, and a user-owned dir.
        std::fs::create_dir_all(root.join(".claude/skills/canon-ghost")).unwrap();
        std::fs::write(root.join(".claude/skills/canon-ghost/SKILL.md"), "old").unwrap();
        std::fs::create_dir_all(root.join(".claude/skills/my-own")).unwrap();
        std::fs::write(root.join(".claude/skills/my-own/SKILL.md"), "mine").unwrap();

        project(root).unwrap();

        assert!(
            !root.join(".claude/skills/canon-ghost").exists(),
            "stale canon dir pruned"
        );
        assert!(
            root.join(".claude/skills/canon-kept/SKILL.md").exists(),
            "installed skill projected"
        );
        assert!(
            root.join(".claude/skills/my-own/SKILL.md").exists(),
            "user dir untouched"
        );
    }
}
