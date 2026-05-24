//! Fuzzy file search over a session's cwd, scoped to text files.

use ignore::WalkBuilder;
use karl_session::SessionId;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 12;
const CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Serialize, Clone)]
pub struct FileMatch {
    pub path: String,
    pub score: i32,
}

struct CacheEntry {
    cwd: PathBuf,
    files: Vec<String>,
    at: Instant,
}

#[derive(Default)]
pub struct FileSearchCache {
    inner: Mutex<HashMap<SessionId, CacheEntry>>,
}

impl FileSearchCache {
    pub fn new() -> Self { Self::default() }

    fn get_or_walk(&self, sid: SessionId, cwd: &Path) -> Vec<String> {
        let mut guard = self.inner.lock().expect("cache poisoned");
        if let Some(entry) = guard.get(&sid) {
            if entry.cwd == cwd && entry.at.elapsed() < CACHE_TTL {
                return entry.files.clone();
            }
        }
        let files = walk(cwd);
        guard.insert(sid, CacheEntry {
            cwd: cwd.to_path_buf(),
            files: files.clone(),
            at: Instant::now(),
        });
        files
    }
}

fn walk(cwd: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let walker = WalkBuilder::new(cwd)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .max_depth(Some(MAX_DEPTH))
        .build();
    for dent in walker.flatten() {
        if !dent.file_type().map(|t| t.is_file()).unwrap_or(false) { continue; }
        let p = dent.path();
        if !is_text_path(p) { continue; }
        if let Ok(rel) = p.strip_prefix(cwd) {
            let s = rel.to_string_lossy().replace('\\', "/");
            out.push(s);
            if out.len() >= MAX_FILES { break; }
        }
    }
    out
}

pub fn search(cache: &FileSearchCache, sid: SessionId, cwd: &Path, query: &str, limit: usize) -> Vec<FileMatch> {
    let files = cache.get_or_walk(sid, cwd);
    let mut scored: Vec<FileMatch> = files.into_iter()
        .filter_map(|p| fuzzy_score(&p, query).map(|s| FileMatch { path: p, score: s }))
        .collect();
    scored.sort_by(|a, b| b.score.cmp(&a.score).then(a.path.cmp(&b.path)));
    scored.truncate(limit);
    scored
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

    #[test]
    fn walker_returns_text_files_and_skips_gitignored() {
        use std::fs;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        // Initialize a git repo so the ignore crate honours .gitignore
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(root)
            .status()
            .unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/lib.rs"), "fn main(){}").unwrap();
        fs::write(root.join("src/logo.png"), b"\x89PNG").unwrap();
        fs::write(root.join("README.md"), "# hi").unwrap();
        fs::write(root.join(".gitignore"), "target\n").unwrap();
        fs::create_dir_all(root.join("target")).unwrap();
        fs::write(root.join("target/skip.rs"), "x").unwrap();

        let files = walk(root);
        assert!(files.iter().any(|p| p == "src/lib.rs"));
        assert!(files.iter().any(|p| p == "README.md"));
        assert!(!files.iter().any(|p| p.ends_with(".png")));
        assert!(!files.iter().any(|p| p.starts_with("target/")));
    }

    #[test]
    fn search_ranks_basename_prefix_first() {
        use std::fs;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("a/api-helpers")).unwrap();
        fs::create_dir_all(root.join("b")).unwrap();
        fs::write(root.join("a/api-helpers/zzz.ts"), "").unwrap();
        fs::write(root.join("b/api.ts"), "").unwrap();

        let cache = FileSearchCache::new();
        let sid = SessionId::default();
        let results = search(&cache, sid, root, "api", 8);
        assert_eq!(results[0].path, "b/api.ts");
    }
}
