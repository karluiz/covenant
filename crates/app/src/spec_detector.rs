//! Spec auto-detection: watches the repo for new spec files and emits
//! candidate events the UI can turn into "use as mission?" toasts.
//!
//! Classification is path-based:
//! - `docs/specs/*.md` (excluding `_template.md`, `next-features.md`,
//!   and `drafts/**`) → Covenant
//! - `docs/superpowers/specs/*-design.md` → Superpowers
//! - anything else → not a candidate (returns None)

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpecSource {
    Covenant,
    Superpowers,
}

/// Classify a path relative to `repo_root`. Returns None if the path is
/// not a recognized spec location.
pub fn classify_spec(repo_root: &Path, path: &Path) -> Option<SpecSource> {
    let rel = path.strip_prefix(repo_root).ok()?;
    let s = rel.to_string_lossy();
    let s = s.replace('\\', "/");

    if !s.ends_with(".md") {
        return None;
    }

    if let Some(rest) = s.strip_prefix("docs/specs/") {
        if rest.contains('/') {
            return None; // drafts/ or any nested path
        }
        if rest == "_template.md" || rest == "next-features.md" {
            return None;
        }
        return Some(SpecSource::Covenant);
    }

    if let Some(rest) = s.strip_prefix("docs/superpowers/specs/") {
        if rest.contains('/') {
            return None;
        }
        return Some(SpecSource::Superpowers);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        PathBuf::from("/tmp/repo")
    }

    #[test]
    fn covenant_spec_classified() {
        let p = root().join("docs/specs/3.16-foo.md");
        assert_eq!(classify_spec(&root(), &p), Some(SpecSource::Covenant));
    }

    #[test]
    fn superpowers_spec_classified() {
        let p = root().join("docs/superpowers/specs/2026-05-04-foo-design.md");
        assert_eq!(classify_spec(&root(), &p), Some(SpecSource::Superpowers));
    }

    #[test]
    fn template_ignored() {
        let p = root().join("docs/specs/_template.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn next_features_ignored() {
        let p = root().join("docs/specs/next-features.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn drafts_subdir_ignored() {
        let p = root().join("docs/specs/drafts/wip-foo.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn non_md_ignored() {
        let p = root().join("docs/specs/3.1-foo.txt");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn outside_repo_ignored() {
        let p = PathBuf::from("/elsewhere/docs/specs/3.1-foo.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn unrelated_path_ignored() {
        let p = root().join("README.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }
}
