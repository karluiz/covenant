# Orchestrator File Mentions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `@`-trigger fuzzy file picker to the shared orchestrator chat composer (Teammate panel + Operator chat). Selected paths are inserted as plain-text `@<relative/path>` tokens. No content inlining.

**Architecture:** Backend Tauri command walks the session's `cwd` with the `ignore` crate, filters by a text extension allowlist, fuzzy-matches the query, returns ranked relative paths. Frontend ships a reusable `attachMentions(inputEl, deps)` controller that drives a floating popup anchored to the caret and rewrites the input value on selection.

**Tech Stack:** Rust (Tauri 2, `ignore`, `tokio`), TypeScript (vanilla, vitest), existing repo patterns (`ui/src/api.ts` wrappers, `crates/app/src/lib.rs` for `#[tauri::command]`).

**User preference:** one commit per feature, not per TDD step. Each task ends with a single commit.

---

## File Structure

**Created (backend):**
- `crates/app/src/file_search.rs` — `search_session_files` command + helpers (walker, allowlist, fuzzy)
- `crates/app/src/file_search_tests.rs` — integration-style tests over real tempdir trees

**Created (frontend):**
- `ui/src/mentions/fuzzy.ts` — subsequence scorer
- `ui/src/mentions/fuzzy.test.ts`
- `ui/src/mentions/mention-popup.ts` — DOM popup
- `ui/src/mentions/mention-controller.ts` — `attachMentions(inputEl, deps)`
- `ui/src/mentions/mention-controller.test.ts`

**Modified:**
- `crates/app/Cargo.toml` — confirm `ignore` already present (line 44, yes); add `tempfile` to dev-deps if missing
- `crates/app/src/lib.rs` — register `file_search` module + command in `invoke_handler!`
- `ui/src/api.ts` — typed `searchSessionFiles` wrapper
- `ui/src/teammate/panel.ts:367` — call `attachMentions` on the composer input
- Operator chat composer (same shared composer; see Task 6 for resolution)
- `ui/src/styles.css` — popup styling + `@`-token chip class

---

## Task 1: Backend — fuzzy scorer + extension allowlist (pure functions)

**Files:**
- Create: `crates/app/src/file_search.rs`

Pure helpers first, no Tauri surface yet. This lets us unit-test deterministically before bringing the walker in.

- [ ] **Step 1: Create the module file with allowlist + scorer**

```rust
// crates/app/src/file_search.rs
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
    let mut qi = 0usize;
    let mut score: i32 = 0;
    let mut prev_match = false;
    let mut last_sep: isize = -1;
    let basename_start = haystack.rfind('/').map(|i| i + 1).unwrap_or(0);

    for (i, &hb) in h.iter().enumerate() {
        if hb == b'/' { last_sep = i as isize; }
        if qi < q.len() && hb.eq_ignore_ascii_case(&q[qi]) {
            score += 1;
            if prev_match { score += 3; }
            if (i as isize) == last_sep + 1 { score += 4; }
            if i == basename_start && qi == 0 { score += 6; }
            qi += 1;
            prev_match = true;
        } else {
            prev_match = false;
        }
    }
    if qi == q.len() { Some(score) } else { None }
}
```

- [ ] **Step 2: Add unit tests at the bottom of `file_search.rs`**

```rust
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
```

- [ ] **Step 3: Wire the module into the crate**

In `crates/app/src/lib.rs`, add near the other `mod` lines:
```rust
mod file_search;
```

- [ ] **Step 4: Run tests**

```bash
cargo test -p covenant-app file_search:: --no-fail-fast
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/file_search.rs crates/app/src/lib.rs
git commit -m "feat(file-search): fuzzy scorer + text extension allowlist"
```

---

## Task 2: Backend — walker + cache + Tauri command

**Files:**
- Modify: `crates/app/src/file_search.rs`
- Modify: `crates/app/src/lib.rs` (register the command in `invoke_handler!`)

- [ ] **Step 1: Add the walker, cache, command shape**

Append to `crates/app/src/file_search.rs`:

```rust
use ignore::WalkBuilder;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use karl_session::SessionId;

const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 12;
const CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Serialize, Clone)]
pub struct FileMatch {
    pub path: String,   // forward-slash relative to cwd
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
        .hidden(true)            // skip dotfiles
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
```

- [ ] **Step 2: Add the Tauri command in `lib.rs`**

Locate the operator-state and other commands in `crates/app/src/lib.rs`. Add near the other `#[tauri::command]` blocks:

```rust
#[tauri::command]
async fn search_session_files(
    state: tauri::State<'_, AppState>,
    session_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<crate::file_search::FileMatch>, String> {
    let sid: karl_session::SessionId = session_id.parse().map_err(|e: String| e)?;
    let cwd = state.operator().session_cwd(sid).await
        .ok_or_else(|| format!("unknown session {session_id}"))?;
    let limit = limit.unwrap_or(8).min(50);
    Ok(crate::file_search::search(&state.file_search_cache, sid, &cwd, &query, limit))
}
```

Register in the `invoke_handler!` macro list alongside other commands:
```rust
search_session_files,
```

Add `pub file_search_cache: crate::file_search::FileSearchCache,` to `AppState` and initialize it where `AppState` is built (search for the existing constructor; mirror the pattern of other caches).

If `OperatorRegistry::session_cwd` doesn't exist, add it as a small method that reads `inner.sessions[sid].world.lock().await.cwd.clone()` and returns `Option<PathBuf>` (mirror the read in `set_mission` at `operator.rs:937-948`).

- [ ] **Step 3: Add a walker integration test**

Append to `file_search.rs`'s tests module:

```rust
#[test]
fn walker_returns_text_files_and_skips_gitignored() {
    use std::fs;
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
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
    let sid: SessionId = "01ARZ3NDEKTSV4RRFFQ69G5FAV".parse().unwrap();
    let results = search(&cache, sid, root, "api", 8);
    assert_eq!(results[0].path, "b/api.ts");
}
```

Add `tempfile` to `crates/app/Cargo.toml` `[dev-dependencies]` if not already there.

- [ ] **Step 4: Run**

```bash
cargo test -p covenant-app file_search::
cargo check -p covenant-app
```
Expected: tests pass; crate builds.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/file_search.rs crates/app/src/lib.rs crates/app/src/operator.rs crates/app/Cargo.toml
git commit -m "feat(file-search): walker, per-session cache, search_session_files command"
```

---

## Task 3: Frontend — fuzzy scorer mirror + tests

The TypeScript scorer exists for client-side reranking when typing fast (we still call the backend; the backend is canonical). Keep it tiny — same algorithm as Rust.

**Files:**
- Create: `ui/src/mentions/fuzzy.ts`
- Create: `ui/src/mentions/fuzzy.test.ts`

- [ ] **Step 1: Write the scorer**

```ts
// ui/src/mentions/fuzzy.ts
export function fuzzyScore(haystack: string, query: string): number | null {
  if (!query) return 0;
  const h = haystack.toLowerCase();
  const q = query.toLowerCase();
  const basenameStart = (h.lastIndexOf("/") + 1) || 0;
  let qi = 0, score = 0, prevMatch = false, lastSep = -1;
  for (let i = 0; i < h.length; i++) {
    if (h[i] === "/") lastSep = i;
    if (qi < q.length && h[i] === q[qi]) {
      score += 1;
      if (prevMatch) score += 3;
      if (i === lastSep + 1) score += 4;
      if (i === basenameStart && qi === 0) score += 6;
      qi++;
      prevMatch = true;
    } else {
      prevMatch = false;
    }
  }
  return qi === q.length ? score : null;
}
```

- [ ] **Step 2: Tests**

```ts
// ui/src/mentions/fuzzy.test.ts
import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("returns 0 for empty query", () => {
    expect(fuzzyScore("foo/bar.rs", "")).toBe(0);
  });
  it("returns null when query is not a subsequence", () => {
    expect(fuzzyScore("foo.rs", "zzz")).toBeNull();
  });
  it("prefers basename prefix over deep midpath", () => {
    const a = fuzzyScore("b/api.ts", "api")!;
    const b = fuzzyScore("a/api-helpers/zzz.ts", "api")!;
    expect(a).toBeGreaterThan(b);
  });
  it("is case-insensitive", () => {
    expect(fuzzyScore("README.md", "rEAd")).not.toBeNull();
  });
});
```

- [ ] **Step 3: Run**

```bash
npx vitest run ui/src/mentions/fuzzy.test.ts
```
Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add ui/src/mentions/fuzzy.ts ui/src/mentions/fuzzy.test.ts
git commit -m "feat(mentions): client-side fuzzy scorer"
```

---

## Task 4: Frontend — mention popup (presentational)

**Files:**
- Create: `ui/src/mentions/mention-popup.ts`

A dumb component: `new MentionPopup()` with `show(anchor, items, activeIndex)`, `setActive(idx)`, `hide()`. No business logic.

- [ ] **Step 1: Implement**

```ts
// ui/src/mentions/mention-popup.ts
export interface MentionItem {
  path: string;
}

export class MentionPopup {
  private el: HTMLDivElement;
  private listEl: HTMLDivElement;
  private items: MentionItem[] = [];
  private activeIndex = 0;
  private onPick: (item: MentionItem) => void = () => {};

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "mention-popup is-hidden";
    this.listEl = document.createElement("div");
    this.listEl.className = "mention-popup-list";
    this.el.append(this.listEl);
    document.body.append(this.el);
  }

  setOnPick(cb: (item: MentionItem) => void): void { this.onPick = cb; }

  show(anchor: { x: number; y: number }, items: MentionItem[], activeIndex = 0): void {
    this.items = items;
    this.activeIndex = Math.min(activeIndex, Math.max(0, items.length - 1));
    this.listEl.innerHTML = "";
    items.forEach((it, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mention-popup-row" + (i === this.activeIndex ? " is-active" : "");
      row.textContent = it.path;
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.onPick(it);
      });
      this.listEl.append(row);
    });
    this.el.style.left = `${anchor.x}px`;
    this.el.style.top = `${anchor.y}px`;
    this.el.classList.toggle("is-hidden", items.length === 0);
  }

  setActive(idx: number): void {
    if (this.items.length === 0) return;
    this.activeIndex = ((idx % this.items.length) + this.items.length) % this.items.length;
    Array.from(this.listEl.children).forEach((c, i) => {
      c.classList.toggle("is-active", i === this.activeIndex);
    });
  }

  getActive(): MentionItem | null {
    return this.items[this.activeIndex] ?? null;
  }

  moveActive(delta: number): void {
    this.setActive(this.activeIndex + delta);
  }

  hide(): void {
    this.el.classList.add("is-hidden");
    this.items = [];
  }

  isOpen(): boolean { return !this.el.classList.contains("is-hidden"); }
  destroy(): void { this.el.remove(); }
}
```

- [ ] **Step 2: Add CSS** in `ui/src/styles.css` (append at end):

```css
/* Mention popup (file-mention picker) */
.mention-popup {
  position: fixed;
  z-index: 9999;
  min-width: 280px;
  max-width: 480px;
  max-height: 240px;
  overflow-y: auto;
  background: var(--surface, #1a1a1a);
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--text, #ddd);
}
.mention-popup.is-hidden { display: none; }
.mention-popup-row {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 10px;
  background: transparent;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.mention-popup-row:hover,
.mention-popup-row.is-active { background: var(--surface-hover, #2a2a2a); }
```

- [ ] **Step 3: Commit** (no test for the popup — it's exercised via the controller test in Task 5)

```bash
git add ui/src/mentions/mention-popup.ts ui/src/styles.css
git commit -m "feat(mentions): popup component + styles"
```

---

## Task 5: Frontend — mention controller (the brains)

**Files:**
- Create: `ui/src/mentions/mention-controller.ts`
- Create: `ui/src/mentions/mention-controller.test.ts`

- [ ] **Step 1: Implement the controller**

```ts
// ui/src/mentions/mention-controller.ts
import { MentionPopup, type MentionItem } from "./mention-popup";

export interface MentionDeps {
  /** Returns up to `limit` ranked matches for the given query. */
  searchFiles: (query: string, limit: number) => Promise<{ path: string }[]>;
}

export interface MentionHandle {
  detach: () => void;
}

const MAX_RESULTS = 8;
const SEARCH_DEBOUNCE_MS = 60;

/**
 * Attach `@`-trigger file mention behavior to an existing input or
 * textarea. The input's `.value` continues to be the source of truth;
 * selecting a mention rewrites the value to replace the active
 * `@query` span with `@<path>`.
 */
export function attachMentions(
  inputEl: HTMLInputElement | HTMLTextAreaElement,
  deps: MentionDeps,
): MentionHandle {
  const popup = new MentionPopup();
  let activeSpan: { start: number; end: number } | null = null;
  let lastQuery = "";
  let searchSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  popup.setOnPick((item) => insert(item));

  function detectActiveSpan(): { start: number; end: number; query: string } | null {
    const v = inputEl.value;
    const caret = inputEl.selectionStart ?? v.length;
    // Walk left from caret looking for an unescaped '@' with no
    // whitespace between it and the caret.
    for (let i = caret - 1; i >= 0; i--) {
      const c = v[i];
      if (c === "@") {
        // Must be at start or preceded by whitespace to count.
        if (i === 0 || /\s/.test(v[i - 1])) {
          return { start: i, end: caret, query: v.slice(i + 1, caret) };
        }
        return null;
      }
      if (/\s/.test(c)) return null;
    }
    return null;
  }

  function caretAnchor(): { x: number; y: number } {
    const rect = inputEl.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom + 2 };
  }

  function scheduleSearch(query: string): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
  }

  async function runSearch(query: string): Promise<void> {
    const seq = ++searchSeq;
    const results = await deps.searchFiles(query, MAX_RESULTS);
    if (seq !== searchSeq) return; // a newer search superseded us
    if (!activeSpan) { popup.hide(); return; }
    popup.show(caretAnchor(), results as MentionItem[], 0);
  }

  function insert(item: MentionItem): void {
    if (!activeSpan) return;
    const v = inputEl.value;
    const before = v.slice(0, activeSpan.start);
    const after = v.slice(activeSpan.end);
    const token = `@${item.path}`;
    const next = `${before}${token} ${after}`;
    inputEl.value = next;
    const caret = before.length + token.length + 1;
    inputEl.setSelectionRange(caret, caret);
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    closePopup();
    inputEl.focus();
  }

  function closePopup(): void {
    activeSpan = null;
    lastQuery = "";
    popup.hide();
  }

  function onInput(): void {
    const span = detectActiveSpan();
    if (!span) { closePopup(); return; }
    activeSpan = { start: span.start, end: span.end };
    if (span.query !== lastQuery) {
      lastQuery = span.query;
      scheduleSearch(span.query);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!popup.isOpen()) return;
    if (e.key === "ArrowDown")     { popup.moveActive(+1); e.preventDefault(); }
    else if (e.key === "ArrowUp")  { popup.moveActive(-1); e.preventDefault(); }
    else if (e.key === "Enter" || e.key === "Tab") {
      const item = popup.getActive();
      if (item) { insert(item); e.preventDefault(); }
    } else if (e.key === "Escape") { closePopup(); e.preventDefault(); }
  }

  function onBlur(): void {
    // Defer so mousedown on a popup row can fire first.
    setTimeout(() => closePopup(), 100);
  }

  inputEl.addEventListener("input", onInput);
  inputEl.addEventListener("keydown", onKeyDown);
  inputEl.addEventListener("blur", onBlur);

  return {
    detach: () => {
      inputEl.removeEventListener("input", onInput);
      inputEl.removeEventListener("keydown", onKeyDown);
      inputEl.removeEventListener("blur", onBlur);
      popup.destroy();
    },
  };
}
```

- [ ] **Step 2: Tests**

```ts
// ui/src/mentions/mention-controller.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachMentions } from "./mention-controller";

function typeInto(el: HTMLInputElement, text: string): void {
  el.value = text;
  el.setSelectionRange(text.length, text.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("attachMentions", () => {
  let input: HTMLInputElement;
  let search: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    input = document.createElement("input");
    document.body.append(input);
    search = vi.fn(async (_q: string, _n: number) => [
      { path: "src/api.ts" },
      { path: "src/main.ts" },
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("opens popup on '@' and inserts selected path on Enter", async () => {
    const handle = attachMentions(input, { searchFiles: search });
    typeInto(input, "hey @ap");
    await vi.advanceTimersByTimeAsync(100);
    expect(search).toHaveBeenCalledWith("ap", 8);
    const popup = document.querySelector(".mention-popup")!;
    expect(popup.classList.contains("is-hidden")).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(input.value).toBe("hey @src/api.ts ");
    handle.detach();
  });

  it("ignores '@' that follows a non-whitespace char (e.g. email)", async () => {
    attachMentions(input, { searchFiles: search });
    typeInto(input, "foo@bar");
    await vi.advanceTimersByTimeAsync(100);
    expect(search).not.toHaveBeenCalled();
  });

  it("closes the popup on Escape", async () => {
    attachMentions(input, { searchFiles: search });
    typeInto(input, "hi @a");
    await vi.advanceTimersByTimeAsync(100);
    const popup = document.querySelector(".mention-popup")!;
    expect(popup.classList.contains("is-hidden")).toBe(false);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(popup.classList.contains("is-hidden")).toBe(true);
  });

  it("closes the popup when user types whitespace after @query", async () => {
    attachMentions(input, { searchFiles: search });
    typeInto(input, "hi @a");
    await vi.advanceTimersByTimeAsync(100);
    typeInto(input, "hi @a ");
    const popup = document.querySelector(".mention-popup")!;
    expect(popup.classList.contains("is-hidden")).toBe(true);
  });
});
```

- [ ] **Step 3: Run**

```bash
npx vitest run ui/src/mentions/
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add ui/src/mentions/mention-controller.ts ui/src/mentions/mention-controller.test.ts
git commit -m "feat(mentions): @-trigger controller with keyboard nav and insertion"
```

---

## Task 6: Wire into the shared composer

**Files:**
- Modify: `ui/src/api.ts`
- Modify: `ui/src/teammate/panel.ts`

The Teammate panel is the shared composer for both the Teammate and Operator chat (confirmed during brainstorming). One wiring point covers both surfaces.

- [ ] **Step 1: Add the typed API wrapper**

In `ui/src/api.ts`, add alongside other `invoke`-based wrappers (mirror the style of the existing `teammate*` helpers):

```ts
export interface FileMatch { path: string; score: number }

export async function searchSessionFiles(
  sessionId: string,
  query: string,
  limit = 8,
): Promise<FileMatch[]> {
  return invoke<FileMatch[]>("search_session_files", { sessionId, query, limit });
}
```

(Use whatever `invoke` import already exists in that file.)

- [ ] **Step 2: Attach to the composer input**

In `ui/src/teammate/panel.ts` modify `renderComposer` (around line 364–383):

```ts
import { attachMentions } from "../mentions/mention-controller";
import { searchSessionFiles } from "../api";
```

After the `c.append(input);` line and before `c.addEventListener("submit", ...)`:

```ts
const mentionHandle = attachMentions(input, {
  searchFiles: async (query, limit) => {
    const sid = this.deps.getActiveSessionId?.() ?? null;
    if (!sid) return [];
    try {
      const matches = await searchSessionFiles(sid, query, limit);
      return matches.map((m) => ({ path: m.path }));
    } catch (e) {
      console.error("searchSessionFiles failed", e);
      return [];
    }
  },
});
this.mentionHandle = mentionHandle;
```

Add a field at the top of the class with the other private fields:

```ts
private mentionHandle: { detach: () => void } | null = null;
```

In the panel's existing cleanup/dispose path (search for where other event listeners are removed — there should be one; if there's no `dispose`/`destroy` method, add one that calls `this.mentionHandle?.detach()` and is called from the same lifecycle as the existing teardown).

- [ ] **Step 3: Manual smoke test**

```bash
pnpm tauri:dev
```

In the running app: open the Teammate/Operator chat composer, type `@`, confirm the popup appears with files from the current session's cwd. Pick one with Enter — the input should now read `… @<picked/path> `. Send the message and confirm it goes through unchanged (the path is a literal substring).

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts ui/src/teammate/panel.ts
git commit -m "feat(teammate): wire @-mentions into the orchestrator composer"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full test sweep**

```bash
cargo test -p covenant-app
pnpm test
```
Expected: all tests pass.

- [ ] **Step 2: Type check + build**

```bash
pnpm build
```
Expected: clean tsc + vite build.

- [ ] **Step 3: Smoke test in real app** (already covered in Task 6 Step 3 — repeat once more end-to-end).

No commit; this is verification only.

---

## Out of scope (recap)

- File content inlining
- Directory / glob mentions
- Image or binary file mentions
- Persisted recently-mentioned list
- Backend schema change for mention metadata (paths flow as plain text)
