//! Structure sidebar (3.3) — filesystem backend for the file tree.
//!
//! Three Tauri commands: `structure_list_dir`, `structure_read_file`,
//! `structure_write_file`. All fs ops run via `spawn_blocking` from the
//! command handlers in `lib.rs`. This module is pure functions over
//! `Path` arguments.

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
}

/// Names we always skip regardless of `.gitignore`. Matches by exact
/// basename — these are universal noise sources.
const HARDCODED_IGNORES: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    ".next",
    "__pycache__",
];

pub fn list_dir(cwd: &Path) -> Result<Vec<DirEntry>, String> {
    if !cwd.is_dir() {
        return Err(format!("not a directory: {}", cwd.display()));
    }
    // Build a one-shot gitignore matcher rooted at this dir. The
    // `ignore` crate's WalkBuilder is overkill for one-level reads —
    // we just want the matcher. Errors loading .gitignore are
    // soft-fail: we still list the directory, just without those rules.
    let gi_path = cwd.join(".gitignore");
    let (matcher, _gi_err) = ignore::gitignore::Gitignore::new(&gi_path);
    let mut out = Vec::new();
    let read = std::fs::read_dir(cwd).map_err(|e| format!("read_dir: {e}"))?;
    for entry in read {
        let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if HARDCODED_IGNORES.iter().any(|n| *n == name) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_symlink = metadata.file_type().is_symlink();
        let kind = if metadata.is_dir() {
            EntryKind::Dir
        } else if metadata.is_file() {
            EntryKind::File
        } else {
            continue;
        };
        let abs = entry.path();
        if matcher.matched(&abs, matches!(kind, EntryKind::Dir)).is_ignore() {
            continue;
        }
        out.push(DirEntry {
            name,
            path: abs.display().to_string(),
            kind,
            is_symlink,
        });
    }
    out.sort_by(|a, b| match (a.kind, b.kind) {
        (EntryKind::Dir, EntryKind::File) => std::cmp::Ordering::Less,
        (EntryKind::File, EntryKind::Dir) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadKind {
    Text,
    Binary,
    TooLarge,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReadResult {
    pub kind: ReadKind,
    pub content: Option<String>,
    pub size_bytes: u64,
}

pub fn read_file_text(path: &Path, max_bytes: u64) -> Result<ReadResult, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("not a file: {}", path.display()));
    }
    let size = metadata.len();
    if size > max_bytes {
        return Ok(ReadResult { kind: ReadKind::TooLarge, content: None, size_bytes: size });
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read: {e}"))?;
    if bytes.contains(&0u8) {
        return Ok(ReadResult { kind: ReadKind::Binary, content: None, size_bytes: size });
    }
    match std::str::from_utf8(&bytes) {
        Ok(s) => Ok(ReadResult {
            kind: ReadKind::Text,
            content: Some(s.to_string()),
            size_bytes: size,
        }),
        Err(_) => Ok(ReadResult { kind: ReadKind::Binary, content: None, size_bytes: size }),
    }
}

pub fn write_file_text(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!(
                "parent dir does not exist: {}",
                parent.display()
            ));
        }
    }
    std::fs::write(path, content.as_bytes())
        .map_err(|e| format!("write: {e}"))
}

/// Write `bytes` to `path` verbatim. Mirrors `write_file_text` but
/// for binary payloads (PNG export, future image dumps, …). Same
/// parent-dir guard so a typo path fails loudly instead of silently
/// dropping bytes into the cwd.
pub fn write_file_binary(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!(
                "parent dir does not exist: {}",
                parent.display()
            ));
        }
    }
    std::fs::write(path, bytes).map_err(|e| format!("write: {e}"))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BinaryReadResult {
    Found { bytes: Vec<u8>, size_bytes: u64 },
    TooLarge { size_bytes: u64 },
}

/// Read `path` as raw bytes (for image previews, etc.). Returns
/// `TooLarge` instead of bytes when the file exceeds `max_bytes` —
/// callers render a friendly placeholder rather than blow IPC.
pub fn read_file_binary(path: &Path, max_bytes: u64) -> Result<BinaryReadResult, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("not a file: {}", path.display()));
    }
    let size = metadata.len();
    if size > max_bytes {
        return Ok(BinaryReadResult::TooLarge { size_bytes: size });
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read: {e}"))?;
    Ok(BinaryReadResult::Found { bytes, size_bytes: size })
}

/// Rename `from` to `to`. Refuses if `from` doesn't exist, if `to`
/// already exists (no overwrite), or if the parent dirs differ —
/// renames are intentionally same-directory only. Cross-directory
/// moves are out of scope for now (would need a separate "move" UX).
pub fn rename_path(from: &Path, to: &Path) -> Result<(), String> {
    if !from.exists() {
        return Err(format!("source does not exist: {}", from.display()));
    }
    if to.exists() {
        return Err(format!("destination already exists: {}", to.display()));
    }
    if from.parent() != to.parent() {
        return Err("rename across directories is not supported".to_string());
    }
    std::fs::rename(from, to).map_err(|e| format!("rename: {e}"))
}

/// Move `path` to the system Trash (Recycle Bin on Windows, Trash on
/// macOS, freedesktop trash on Linux). Soft-delete: the user can
/// restore from the OS Trash UI. We never `remove_file`/`remove_dir`
/// directly — too easy to lose work.
pub fn trash_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("path does not exist: {}", path.display()));
    }
    trash::delete(path).map_err(|e| format!("trash: {e}"))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchHit {
    pub path: String,
    /// 1-based line number where the match was found.
    pub line_number: u32,
    /// The full line text (trimmed of trailing newline).
    pub line_text: String,
    /// Char offset (NOT byte) within `line_text` where the match starts.
    pub match_start: u32,
    /// Char offset (NOT byte) within `line_text` where the match ends.
    pub match_end: u32,
}

/// Per-file caps so a runaway query against a giant repo doesn't melt
/// the UI. Both are deliberately conservative — the user can refine
/// the query if their first hit doesn't show up.
const SEARCH_MAX_FILE_BYTES: u64 = 1024 * 1024; // 1 MiB
const SEARCH_MAX_LINE_CHARS: usize = 400; // truncate display, full match still found
const SEARCH_HITS_PER_FILE: usize = 20; // avoid one huge file dominating

/// Walk `root` honoring .gitignore + hardcoded ignore set, searching
/// every text file for `query` (case-insensitive substring). Returns
/// up to `limit` hits, ordered by file walk order (deterministic).
///
/// Skips: directories in HARDCODED_IGNORES, gitignored paths, files
/// > 1 MiB, files containing NUL in the first chunk (binary).
///
/// Empty query returns Ok(vec![]) immediately — the UI calls us on
/// every keystroke and we don't want to spin on nothing.
pub fn search(root: &Path, query: &str, limit: u32) -> Result<Vec<SearchHit>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let needle_lower = query.to_lowercase();
    let mut hits: Vec<SearchHit> = Vec::new();
    let limit = limit as usize;

    let walker = ignore::WalkBuilder::new(root)
        .hidden(false) // let the user search dotfiles like .env.example
        .git_ignore(true)
        .git_exclude(true)
        .git_global(false) // don't depend on user's global gitignore
        // Apply .gitignore even when there's no .git/ next to it. Our
        // tests run in tempdirs (no .git), and projects vendored as
        // submodules / extracted tarballs lack .git too — but we still
        // want their .gitignore respected so search results don't get
        // polluted by build artifacts.
        .require_git(false)
        .filter_entry(|entry| {
            // Skip hardcoded ignores at any depth.
            entry
                .file_name()
                .to_str()
                .map(|n| !HARDCODED_IGNORES.iter().any(|h| *h == n))
                .unwrap_or(true)
        })
        .build();

    for entry in walker {
        if hits.len() >= limit {
            break;
        }
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let ft = match entry.file_type() {
            Some(ft) => ft,
            None => continue,
        };
        if !ft.is_file() {
            continue;
        }
        let path = entry.path();
        let metadata = match path.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > SEARCH_MAX_FILE_BYTES {
            continue;
        }
        let bytes = match std::fs::read(path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Binary heuristic — sniff first 4 KiB for NUL.
        let sniff_len = bytes.len().min(4096);
        if bytes[..sniff_len].contains(&0u8) {
            continue;
        }
        let text = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let mut file_hits = 0usize;
        for (idx, line) in text.lines().enumerate() {
            if hits.len() >= limit {
                break;
            }
            if file_hits >= SEARCH_HITS_PER_FILE {
                break;
            }
            // Case-insensitive substring search. We lowercase the line
            // for matching but report char offsets in the ORIGINAL line
            // so highlighting in the UI reads naturally.
            let line_lower = line.to_lowercase();
            let byte_pos = match line_lower.find(&needle_lower) {
                Some(p) => p,
                None => continue,
            };
            // Convert byte offset → char offset for the UI.
            let match_start_chars = line_lower[..byte_pos].chars().count();
            let match_end_chars = match_start_chars + query.chars().count();

            // Truncate display text if absurdly long; keep the match
            // visible by centering on it.
            let (display, adj_start, adj_end) =
                truncate_around(line, match_start_chars, match_end_chars, SEARCH_MAX_LINE_CHARS);

            hits.push(SearchHit {
                path: path.display().to_string(),
                line_number: (idx + 1) as u32,
                line_text: display,
                match_start: adj_start as u32,
                match_end: adj_end as u32,
            });
            file_hits += 1;
        }
    }

    Ok(hits)
}

/// If the line is short enough, return as-is. Otherwise crop a window
/// around the match (with a leading ellipsis if we cut from the left,
/// trailing ellipsis if from the right) and adjust the match offsets
/// to the new string. Keeps long lines from blowing up the UI cells.
fn truncate_around(
    line: &str,
    match_start: usize,
    match_end: usize,
    max_chars: usize,
) -> (String, usize, usize) {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= max_chars {
        return (line.to_string(), match_start, match_end);
    }
    let half = max_chars / 2;
    let center = (match_start + match_end) / 2;
    let mut start = center.saturating_sub(half);
    let mut end = (start + max_chars).min(chars.len());
    if end == chars.len() {
        start = chars.len() - max_chars;
    }
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < chars.len() { "…" } else { "" };
    let cropped: String = chars[start..end].iter().collect();
    let display = format!("{prefix}{cropped}{suffix}");
    let adj_start = prefix.chars().count() + match_start.saturating_sub(start);
    let adj_end = prefix.chars().count() + match_end.saturating_sub(start);
    (display, adj_start, adj_end)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_tree(tmp: &TempDir, names: &[&str]) {
        for n in names {
            let p = tmp.path().join(n);
            if n.ends_with('/') {
                fs::create_dir_all(&p).unwrap();
            } else {
                if let Some(parent) = p.parent() {
                    fs::create_dir_all(parent).unwrap();
                }
                fs::write(&p, b"").unwrap();
            }
        }
    }

    #[test]
    fn skips_hardcoded_ignores() {
        let tmp = TempDir::new().unwrap();
        make_tree(&tmp, &["src/", "node_modules/", ".git/", "target/", "README.md"]);
        let entries = list_dir(tmp.path()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "README.md"]);
    }

    #[test]
    fn folders_first_then_alpha() {
        let tmp = TempDir::new().unwrap();
        make_tree(&tmp, &["b.txt", "a.txt", "z_dir/", "a_dir/"]);
        let entries = list_dir(tmp.path()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a_dir", "z_dir", "a.txt", "b.txt"]);
    }

    #[test]
    fn err_on_non_dir() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("file.txt");
        fs::write(&f, b"").unwrap();
        assert!(list_dir(&f).is_err());
    }

    #[test]
    fn honors_gitignore() {
        let tmp = TempDir::new().unwrap();
        make_tree(&tmp, &[
            "src/main.rs",
            "build/output.bin",
            "secret.env",
            "README.md",
            ".gitignore",
        ]);
        fs::write(tmp.path().join(".gitignore"), "build/\n*.env\n").unwrap();
        let entries = list_dir(tmp.path()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        // .gitignore itself is shown (gitignore patterns don't hide it),
        // but build/ and secret.env are filtered.
        assert!(names.contains(&"src"));
        assert!(names.contains(&"README.md"));
        assert!(names.contains(&".gitignore"));
        assert!(!names.contains(&"build"));
        assert!(!names.contains(&"secret.env"));
    }

    #[test]
    fn gitignore_only_applies_inside_repo_or_with_root() {
        // No .gitignore = nothing extra is filtered (only hardcoded set).
        let tmp = TempDir::new().unwrap();
        make_tree(&tmp, &["foo.log", "bar.txt"]);
        let entries = list_dir(tmp.path()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"foo.log"));
        assert!(names.contains(&"bar.txt"));
    }

    #[test]
    fn read_small_text_file() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("hello.txt");
        fs::write(&f, "hello world\n").unwrap();
        let result = read_file_text(&f, 1024 * 1024).unwrap();
        assert_eq!(result.kind, ReadKind::Text);
        assert_eq!(result.content.as_deref(), Some("hello world\n"));
    }

    #[test]
    fn read_too_large_returns_size_marker() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("big.bin");
        fs::write(&f, vec![0u8; 2048]).unwrap();
        let result = read_file_text(&f, 1024).unwrap();
        assert_eq!(result.kind, ReadKind::TooLarge);
        assert!(result.content.is_none());
        assert_eq!(result.size_bytes, 2048);
    }

    #[test]
    fn read_binary_returns_binary_marker() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("a.bin");
        // Bytes including a NUL — our heuristic treats this as binary.
        fs::write(&f, b"abc\x00def").unwrap();
        let result = read_file_text(&f, 1024 * 1024).unwrap();
        assert_eq!(result.kind, ReadKind::Binary);
        assert!(result.content.is_none());
    }

    #[test]
    fn read_missing_file_errors() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("nope.txt");
        assert!(read_file_text(&f, 1024).is_err());
    }

    #[test]
    fn write_overwrites_existing_file() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("a.txt");
        fs::write(&f, "old").unwrap();
        write_file_text(&f, "new content").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "new content");
    }

    #[test]
    fn write_creates_new_file() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("new.txt");
        write_file_text(&f, "fresh").unwrap();
        assert_eq!(fs::read_to_string(&f).unwrap(), "fresh");
    }

    #[test]
    fn write_to_missing_parent_errors() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("nope/missing.txt");
        assert!(write_file_text(&f, "x").is_err());
    }

    #[test]
    fn search_empty_query_returns_empty() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.txt"), "hello world").unwrap();
        let hits = search(tmp.path(), "", 100).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn search_finds_substring_case_insensitive() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.txt"), "Hello WORLD\nfoo bar").unwrap();
        let hits = search(tmp.path(), "world", 100).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line_number, 1);
        assert_eq!(hits[0].line_text, "Hello WORLD");
        assert_eq!(hits[0].match_start, 6);
        assert_eq!(hits[0].match_end, 11);
    }

    #[test]
    fn search_skips_gitignored_files() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join(".gitignore"), "secret.env\n").unwrap();
        fs::write(tmp.path().join("ok.txt"), "hello").unwrap();
        fs::write(tmp.path().join("secret.env"), "hello").unwrap();
        let hits = search(tmp.path(), "hello", 100).unwrap();
        // Only ok.txt should match. .gitignore content does not contain
        // "hello" so it doesn't appear either way.
        assert_eq!(hits.len(), 1);
        assert!(hits[0].path.ends_with("ok.txt"));
    }

    #[test]
    fn search_skips_hardcoded_ignores() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("node_modules")).unwrap();
        fs::write(tmp.path().join("node_modules/dep.txt"), "needle").unwrap();
        fs::write(tmp.path().join("src.txt"), "needle").unwrap();
        let hits = search(tmp.path(), "needle", 100).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].path.ends_with("src.txt"));
    }

    #[test]
    fn search_skips_binary_files() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.bin"), b"hello\x00world hello").unwrap();
        fs::write(tmp.path().join("a.txt"), "hello world").unwrap();
        let hits = search(tmp.path(), "hello", 100).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].path.ends_with("a.txt"));
    }

    #[test]
    fn search_caps_per_file_hits() {
        let tmp = TempDir::new().unwrap();
        let lines: Vec<String> = (0..50).map(|i| format!("hit number {i}")).collect();
        fs::write(tmp.path().join("noisy.txt"), lines.join("\n")).unwrap();
        let hits = search(tmp.path(), "hit", 1000).unwrap();
        assert_eq!(hits.len(), SEARCH_HITS_PER_FILE);
    }

    #[test]
    fn search_overall_limit_respected() {
        let tmp = TempDir::new().unwrap();
        for i in 0..5 {
            fs::write(tmp.path().join(format!("f{i}.txt")), "needle").unwrap();
        }
        let hits = search(tmp.path(), "needle", 3).unwrap();
        assert_eq!(hits.len(), 3);
    }

    #[test]
    fn truncate_around_keeps_short_lines() {
        let (s, a, b) = truncate_around("hello world", 6, 11, 80);
        assert_eq!(s, "hello world");
        assert_eq!((a, b), (6, 11));
    }

    #[test]
    fn truncate_around_crops_long_lines_centered_on_match() {
        let line: String = std::iter::repeat('x').take(500).collect::<String>()
            + "needle"
            + &std::iter::repeat('y').take(500).collect::<String>();
        let match_start = 500;
        let match_end = 506;
        let (s, a, b) = truncate_around(&line, match_start, match_end, 80);
        // Should be ~80 chars + ellipses; the slice should still
        // contain "needle" at the reported offsets.
        let chars: Vec<char> = s.chars().collect();
        let slice: String = chars[a..b].iter().collect();
        assert_eq!(slice, "needle");
    }

    #[test]
    fn write_file_binary_round_trips_bytes() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("out.png");
        let payload: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF];

        write_file_binary(&path, payload).expect("write ok");

        let read_back = std::fs::read(&path).expect("read ok");
        assert_eq!(read_back, payload);
    }

    #[test]
    fn write_file_binary_rejects_missing_parent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("missing/sub/out.png");
        let err = write_file_binary(&path, b"x").expect_err("should fail");
        assert!(err.contains("parent dir"));
    }
}
