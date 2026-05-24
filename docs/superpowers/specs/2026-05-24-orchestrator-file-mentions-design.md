# Orchestrator File Mentions — Design

## Goal

Let users mention one or more files inside the orchestrator chat composer
(shared between the Teammate panel and the Operator chat) by typing `@`,
selecting from a fuzzy file picker scoped to the current session's `cwd`.
Selected mentions are inserted as plain-text `@<relative/path>` tokens
into the existing message string. No file contents are inlined.

## Non-goals (v1)

- No inlining of file contents into the LLM prompt
- No directory, glob, or remote-file mentions
- No image / binary file mentions
- No persistence of recently-mentioned files
- No backend message-schema changes — mentions travel as plain text

## UX

- Typing `@` inside the composer opens a popup anchored below the caret
  showing the top 8 fuzzy matches from the session's cwd
- Continued typing filters; `↑/↓` navigates; `Tab` or `Enter` inserts;
  `Esc` closes
- Typing whitespace with no current match closes the popup and leaves
  the literal `@text` in the input (no false hijack)
- Insertion replaces the active `@query` span with `@<relative/path>`.
  Tokens are styled as inline chips via a CSS class, but the underlying
  input value stores them as plain `@path` text so the existing send
  path is unchanged
- Multiple `@` mentions per message are supported

## Architecture

### Frontend — `ui/src/mentions/`

- `mention-controller.ts`
  - `attachMentions(inputEl, deps)` wraps an existing `<input>` or
    `<textarea>` element
  - Owns the open/closed state machine, listens for `input`/`keydown`,
    tracks the active `@`-span in the value, drives the popup
  - Inserts the chosen path back into the input and dispatches `input`
    so consumers see the new value
- `mention-popup.ts`
  - Floating panel anchored to the caret; renders a list of matches
    with the matched substring highlighted
  - Reuses existing tooltip/menu positioning helpers where available;
    otherwise computes a viewport-clamped position
- `fuzzy.ts`
  - Small subsequence scorer with bonuses for: consecutive matches,
    matches after path separators, prefix matches on the basename
  - No new dependency

### Backend — `crates/app/src/`

- New Tauri command `search_session_files(session_id, query, limit)`
  returning `Vec<FileMatch> { path: String, score: i32 }`
- Walks the session's `cwd` using the `ignore` crate so `.gitignore`
  is respected
- Filters to text files via a hardcoded extension allowlist:
  `rs ts tsx js jsx mjs cjs py md mdx json toml yaml yml txt css scss
  html sh bash zsh fish go java kt rb php c h hpp cpp swift sql lua
  rust-toolchain`
  (tight on purpose; expand on demand)
- Caps walk depth and total entries to keep large repos responsive
- Caches the per-session file list with a short TTL (~5s) so successive
  keystrokes do not re-walk the tree
- Fuzzy-matches on the relative path; returns up to `limit` results

### Wire-through

- `ui/src/api.ts` adds a typed `searchSessionFiles(sessionId, query)`
  wrapper around the new Tauri command
- `ui/src/teammate/panel.ts`
  (current composer at line ~367) calls `attachMentions(inputEl, {
  searchFiles, sessionId })` after constructing the input
- The operator-side chat composer (shared component) calls the same
  attach function with the same dependencies

## Token format

`@<relative-path>` as a literal substring inside the message text.
The backend LLM layer does not need to change for v1: paths flow
through the prompt as part of the user message. A future iteration may
upgrade this into a structured payload if the agent needs to fetch
contents.

## Tests

### Rust

- `search_session_files` returns only text-allowlist files
- `.gitignore`d files are excluded
- Walk depth and entry caps are enforced
- Fuzzy ranking prefers prefix and basename matches over deep mid-path
  matches

### TypeScript

- Fuzzy scorer correctness for representative path queries
- `mention-controller` open/close/insert state machine: trigger on
  `@`, cancel on whitespace-without-match, replace span on selection,
  cursor lands after inserted token

## Risks / open questions

- Very large repos: extension allowlist plus walk caps should keep
  this snappy, but we may want a background warm-up of the cache on
  session open if latency on first `@` is noticeable
- Caret positioning for the popup inside a single-line `<input>` is
  approximate; if it looks bad we can switch the composer to a styled
  `<textarea>` (minor visual change, no behavioral one)
