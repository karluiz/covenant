//! Fuzzy file search over a session's cwd, scoped to text files.

use std::path::Path;

/// Hardcoded text-file extensions. Tight by design; expand on demand.
const TEXT_EXTS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs",
    "py", "md", "mdx", "json", "toml", "yaml", "yml", "txt",
    "css", "scss", "html", "sh", "bash", "zsh", "fish",
    "go", "java", "kt", "rb", "php",
    "c", "h", "hpp", "cpp", "swift", "sql", "lua",
];

pub(crate) fn is_text_path(path: &Path) -> bool {
    match path.extension().and_then(|e| e.to_str()) {
        Some(ext) => {
            let ext_lower = ext.to_ascii_lowercase();
            TEXT_EXTS.contains(&ext_lower.as_str())
        }
        None => false,
    }
}

/// Subsequence fuzzy score. Returns `None` if `query` is not a
/// subsequence of `haystack`. Higher is better.
///
/// Bonuses:
/// * consecutive matches
/// * match immediately after a path separator
/// * prefix match on the basename
pub(crate) fn fuzzy_score(haystack: &str, query: &str) -> Option<i32> {
    if query.is_empty() {
        return Some(0);
    }
    let h = haystack.as_bytes();
    let q = query.as_bytes();
    let basename_start = haystack.rfind('/').map(|i| i + 1).unwrap_or(0);

    // Score a greedy forward match starting at `start`.
    let score_from = |start: usize| -> Option<i32> {
        let mut qi = 0usize;
        let mut score: i32 = 0;
        let mut prev_match = false;
        let mut last_sep: isize = -1;
        for i in 0..start {
            if h[i] == b'/' { last_sep = i as isize; }
        }
        for i in start..h.len() {
            let hb = h[i];
            if hb == b'/' { last_sep = i as isize; }
            if qi < q.len() && hb.eq_ignore_ascii_case(&q[qi]) {
                score += 1;
                if prev_match { score += 3; }
                if (i as isize) == last_sep + 1 { score += 4; }
                if i == basename_start && qi == 0 { score += 10; }
                qi += 1;
                prev_match = true;
            } else {
                prev_match = false;
            }
        }
        if qi == q.len() { Some(score) } else { None }
    };

    // Try greedy from start and greedy from basename; take the higher score.
    let s1 = score_from(0);
    let s2 = score_from(basename_start);
    match (s1, s2) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn allowlist_admits_rust_and_ts() {
        assert!(is_text_path(&PathBuf::from("a/b/c.rs")));
        assert!(is_text_path(&PathBuf::from("ui/src/api.ts")));
        assert!(is_text_path(&PathBuf::from("README.md")));
    }

    #[test]
    fn allowlist_rejects_binary_and_extensionless() {
        assert!(!is_text_path(&PathBuf::from("logo.png")));
        assert!(!is_text_path(&PathBuf::from("a.exe")));
        assert!(!is_text_path(&PathBuf::from("Makefile")));
    }

    #[test]
    fn fuzzy_empty_query_matches_anything() {
        assert_eq!(fuzzy_score("foo/bar.rs", ""), Some(0));
    }

    #[test]
    fn fuzzy_missing_char_returns_none() {
        assert!(fuzzy_score("foo.rs", "zzz").is_none());
    }

    #[test]
    fn fuzzy_prefers_basename_prefix_over_deep_midpath() {
        let basename_hit = fuzzy_score("crates/app/src/api.ts", "api").unwrap();
        let midpath_hit  = fuzzy_score("a/api-helpers/zzz.ts",   "api").unwrap();
        assert!(basename_hit > midpath_hit,
                "basename={basename_hit} midpath={midpath_hit}");
    }

    #[test]
    fn fuzzy_case_insensitive() {
        assert!(fuzzy_score("README.md", "rEAd").is_some());
    }
}
