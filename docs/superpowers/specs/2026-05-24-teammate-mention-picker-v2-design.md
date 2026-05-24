# Teammate composer — multi-source @mention picker v2

**Status:** spec, awaiting plan
**Owner:** karluiz
**Date:** 2026-05-24
**Touches:** `ui/src/teammate/mentions.ts`, `ui/src/teammate/panel.ts`, `ui/src/styles.css`, `crates/agent` (mention expansion if any), backend `find_files`/new `find_mentions` command.

---

## Problem

Today the teammate composer claims `(type @ to mention a file)`, but when the user types `@sad` nothing appears — no popup, no hints, no empty state. Two separate failures:

1. **Reliability gap** — the popup is wired only if `deps.findFiles` is injected and `getActiveSessionCwd()` returns non-null. When either condition fails silently, the user sees nothing. Placeholder lies.
2. **Capability gap** — even when it works, the picker only suggests files. The Recall/agent universe has richer entities worth mentioning (sessions, recent commands, teammates), and the current popup has no tabs, no grouping, no key hints, no chips — just a single flat list of paths.

Both are addressed together because the bug fix and the redesign touch the same render path; splitting them means rewriting twice.

---

## Goals

- Typing `@` in the composer **always** opens the picker with a visible state (results, empty, or "no session" hint). Never silently does nothing.
- Picker supports four sources, grouped: **Files**, **Sessions**, **Recent commands**, **Teammates**. Tabs at the top let the user scope; default tab is **All**.
- Selected mention renders as an **atomic chip** in the input — color-coded by source, can't be half-deleted with backspace (one delete removes the whole chip).
- Footer shows key hints (`↑↓ nav · ⇥/↵ insert · esc close`).
- On submit, each chip expands into a structured fenced block the LLM gets as context (files keep current behavior; sessions/commands get summaries; teammates get reference + recent activity).

## Non-goals

- Reusing the picker in the Recall search input. Different semantics (search filter vs. composer); deferred.
- Mention-completion inside arbitrary text fields elsewhere. Composer-only.
- Persisting drafts with chips across composer remount. Drafts already reset on operator switch; keep that.

---

## Architecture

### Composer input: `<input>` → `contenteditable` div

`ui/src/teammate/panel.ts` switches `.teammate-panel-input` from `<input type="text">` to `<div contenteditable="plaintext-only" role="textbox">` so chip nodes can live inline.

Contract for the new `ComposerInput` (new file `ui/src/teammate/composer-input.ts`):

- `getValue(): string` — serialize content to plain text, where each chip becomes its canonical token (`@path`, `@session:01HXXX`, `@cmd:01HXXX`, `@teammate:claude`).
- `setValue(text: string): void` — for restoring drafts; no chips, plain text only.
- `insertChip(chip: ChipSpec): void` — replaces the `@query` segment at the caret with an atomic chip element + trailing space.
- `getCaretContext(): { textBeforeCaret: string; range: Range } | null` — used by the picker to detect the active `@token`.
- Events: `oninput` (debounced), `onkeydown`, `onsubmit` (Enter without Shift, when picker closed).

Chip DOM:

```html
<span class="tmt-chip tmt-chip--file"
      contenteditable="false"
      data-kind="file"
      data-token="@ui/src/teammate/mentions.ts">
  <span class="tmt-chip__ico">⌗</span>mentions.ts
</span>
```

`contenteditable="false"` on the chip + a single zero-width space after each chip handles backspace-deletes-whole-chip semantics in WebKit/Chromium without custom keydown logic. (Verified pattern; see references.)

### Picker: extend `MentionPopup`

`ui/src/teammate/mentions.ts` `MentionPopup` keeps its position/lifecycle role but its state and render expand:

```ts
type Source = "files" | "sessions" | "commands" | "teammates";

interface MentionHit {
  kind: Source;
  token: string;              // canonical insertion form
  primary: string;            // display name ("mentions.ts", "tab 2 · zsh")
  secondary: string;          // dim line ("ui/src/teammate/…", "4 blocks · last: cargo test")
  matchIndices: number[];     // for bolding the matched chars
  payload: unknown;           // source-specific (file abs path, session id, block id, …)
}

interface PopupState {
  start: number;                  // index in composer text
  query: string;
  activeTab: "all" | Source;
  hits: MentionHit[];             // already-grouped/sorted for activeTab
  selected: number;
  loading: boolean;
  cwd: string | null;
}
```

`PopupDeps` gains a single `findMentions(args)` injection that fans out to per-source providers. New file `ui/src/teammate/mention-sources.ts` exports the providers:

- `findFiles(cwd, query, limit)` — wraps existing backend `find_files` command.
- `findSessions(query, limit)` — pulls from `SessionStore` (frontend already tracks open tabs).
- `findCommands(query, limit)` — calls a **new** backend command `find_recent_commands(query, limit)` that searches Block titles across all sessions, newest-first.
- `findTeammates(query, limit)` — pulls from the operator registry already in memory.

`mention-sources.ts::findMentions(args)` runs providers in parallel (`Promise.allSettled`), then interleaves results: top-3 from each source for the "All" tab, all results from one source for a scoped tab. Source failure → that source contributes zero hits; never throws.

### Rendering

Picker DOM matches mockup A (`docs/superpowers/specs/2026-05-24-teammate-mention-picker-v2-design.md` references the HTML in `.superpowers/brainstorm/24852-1779652130/content/mention-popup.html`). New classes (added to `ui/src/styles.css`, near existing `.teammate-mention-*` block):

- `.tmt-mp-header` — tab bar
- `.tmt-mp-tab[.is-active]` — individual tab
- `.tmt-mp-group` — group label between source rows in "All" tab
- `.tmt-mp-row[.is-selected]` with `.tmt-mp-row__ico`, `.__main`, `.__name`, `.__meta`
- `.tmt-mp-row--session/--cmd/--team` — source color variants
- `.tmt-mp-foot` + `.tmt-mp-foot kbd` — key hints footer
- `.tmt-chip[--file/--session/--cmd/--team]` — input chips

Existing `.teammate-mention-*` classes are renamed to `.tmt-mp-*` in the same change since no external code references them.

### Triggers — fix the silent-failure bug

Reliability fix in `panel.ts`:

1. `findFiles` (and the new `findMentions`) dependency is **required**, not optional. Remove the `if (findFiles)` guard at line 418. If a host forgets to inject it, fail loudly in dev (`console.error` + visible "mentions unavailable" hint inside the popup on first `@`).
2. Even when `getCwd()` returns null, the file-source provider reports zero hits but the **picker still opens** showing Sessions/Commands/Teammates (which don't depend on cwd) plus a `Files (no active session)` group label. The user is never met with silence.

### Submit / expansion

`expandMentions` in `mentions.ts` is generalized:

- File chip → unchanged: inline fenced block with file contents (capped at `MAX_FILE_BYTES`, total at `MAX_TOTAL_BYTES`).
- Session chip → fenced block titled `session: <cwd> (<tab>)` containing last 5 blocks' `cmd + exit_code + last 20 lines of plain_output`.
- Command chip → fenced block titled `command: <cmd>` containing `cwd`, `exit_code`, full `plain_output` (capped at `MAX_FILE_BYTES`).
- Teammate chip → short reference: `teammate @<name> (id=<operator_id>) — last activity: <summary>` (one paragraph, no fence).

Total payload still capped at `MAX_TOTAL_BYTES = 512KB`. Per-chip skipped reasons (oversized, unreadable) are surfaced in the same `skipped[]` array `expandMentions` already returns.

### Backend additions

`crates/agent` (or wherever `find_files` lives — verify in plan phase) adds:

- `find_recent_commands(query: String, limit: usize) -> Vec<CommandHit>` — searches Block titles across all open sessions, fuzzy match, ranked by recency × match quality. `CommandHit { block_id, session_id, command, exit_code, cwd, finished_at }`.
- `find_session_summary(session_id: SessionId) -> SessionSummary` — used by the expansion path, returns last 5 blocks. Cheap to compute from existing in-memory state.

No new tables, no SQLite work; all in-memory off the session/block stores.

---

## Data flow

```
keydown / input in composer
   │
   ▼
ComposerInput.getCaretContext() → activeMentionAt(text, caret)
   │ (returns {start, query} or null)
   ▼
MentionPopup.onInputChange()
   │ open + spinner
   ▼
mention-sources.findMentions({query, cwd, activeTab, limit})
   │ Promise.allSettled([findFiles, findSessions, findCommands, findTeammates])
   ▼
PopupState.hits = grouped/interleaved
   │
   ▼
render() — tabs · groups · rows · footer

user presses ↵ or ⇥
   ▼
MentionPopup.pick(hit) → ComposerInput.insertChip({kind, token, label, payload})
   │ chip replaces `@query` segment, adds trailing space
   ▼
composer text updated, popup closes

user presses ⌘↵ to send
   ▼
ComposerInput.getValue() → text with `@token`s
   ▼
expandMentions(text, chipPayloads) → ExpandedMessage{ text, skipped }
   ▼
operator dispatch (unchanged below this point)
```

---

## Error handling

| Failure | UX |
|---|---|
| `findFiles` throws | Files group shows "couldn't search files" row; other sources still listed |
| `getCwd()` returns null | Files group shows "no active session"; other sources still listed |
| `find_recent_commands` not yet implemented | Commands tab disabled, "All" tab hides the group; logged, no error to user |
| `findMentions` returns zero across all sources | Empty state: "no matches for `<query>`" |
| Chip insertion races with input mutation | Picker re-reads `getCaretContext()`; if the `@token` moved/disappeared, picker closes silently |
| Chip references a deleted entity at expand time (e.g., closed session) | `skipped[]` entry: `"session no longer open"`; chip rendered as plain `@token` text in the sent payload |
| Total mention bundle > 512KB | Same as today: per-file skipped with reason, message still sends |

---

## Testing

Reuse `mentions.test.ts` pattern. New cases:

- `activeMentionAt` — already covered, keep.
- `findMentions` grouping/interleaving with multiple sources (mocked providers).
- `ComposerInput.insertChip` — chip is `contenteditable=false`, `getValue` round-trips token correctly, backspace deletes whole chip.
- `MentionPopup` — opens with no cwd, opens with empty hits, tab switching reorders hits, Esc closes, ↵ inserts top hit.
- `expandMentions` — file (existing), session (new), command (new), teammate (new), mixed message, oversized cases.

No backend Rust tests beyond a unit test for `find_recent_commands` fuzzy ranking.

---

## Open questions

None blocking. Tab-bar visibility on narrow sidebar widths may need a fallback (icons-only tabs ≤ 320px) — defer to implementation if it looks cramped.

---

## References

- Mockup A/B/C: `.superpowers/brainstorm/24852-1779652130/content/mention-popup.html`
- Existing implementation: `ui/src/teammate/mentions.ts:1`, `ui/src/teammate/panel.ts:415`
- Existing styles: `ui/src/styles.css:15474`
- `activeMentionAt` parser, `expandMentions` shape, `MentionPopup` lifecycle — unchanged contracts
