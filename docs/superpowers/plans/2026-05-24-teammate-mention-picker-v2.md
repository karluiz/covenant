# Teammate composer @mention picker v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the silent, file-only @mention popup in the teammate composer with a reliable multi-source picker (Files / Sessions / Commands / Teammates) that renders atomic chips in a contenteditable input.

**Architecture:** Backend gets one new query (`find_recent_commands`). Frontend gets (a) a `mention-sources` module that fans out to the four providers and returns a unified `MentionHit[]`, (b) a refactored `MentionPopup` with tabs+groups+footer, (c) a new `ComposerInput` wrapping a `contenteditable` div with atomic chips, and (d) a generalized `expandMentions` that builds source-specific fenced blocks at send time.

**Tech Stack:** Rust (axum command via Tauri IPC, tokio), TypeScript (vanilla — no framework), Vitest for unit tests, xterm.js untouched.

**Spec:** `docs/superpowers/specs/2026-05-24-teammate-mention-picker-v2-design.md`

**Commit policy:** One commit per task (not per TDD step) — see user preference [feedback_commit_granularity].

---

## File Structure

**New files:**
- `ui/src/teammate/composer-input.ts` — `ComposerInput` class wrapping a `contenteditable` div
- `ui/src/teammate/composer-input.test.ts`
- `ui/src/teammate/mention-sources.ts` — providers + `findMentions` orchestrator
- `ui/src/teammate/mention-sources.test.ts`

**Modified files:**
- `crates/app/src/lib.rs` — register `find_recent_commands` command
- `crates/blocks/src/lib.rs` (or wherever the live Block store lives — verify before editing) — add `recent_commands(query, limit)` query
- `ui/src/api.ts` — bind `findRecentCommands`, add `CommandHit`/`SessionHit`/`TeammateHit`/`MentionHit` types
- `ui/src/teammate/mentions.ts` — generalize `MentionPopup` and `expandMentions` to multi-source
- `ui/src/teammate/mentions.test.ts` — extend with new cases
- `ui/src/teammate/panel.ts` — swap `<input>` → `ComposerInput`, require deps, remove silent guard
- `ui/src/styles.css` — rename `.teammate-mention-*` → `.tmt-mp-*`, add tabs/groups/footer styles, add `.tmt-chip-*`

---

## Task 1: Backend `find_recent_commands` command

**Files:**
- Modify: `crates/app/src/lib.rs` (register command, ~line 3303 invoke_handler list and ~line 2421 command function)
- Modify: `crates/blocks/src/lib.rs` *(verify location — search for the in-memory block store)*
- Test: `crates/blocks/src/lib.rs` (inline `#[cfg(test)]` module)

- [ ] **Step 1.1: Locate the block store**

Run: `rg -n "pub struct.*Block" crates/blocks/src/`
Expected: find the type that holds finished blocks across sessions (likely a `Vec<Block>` or `HashMap<BlockId, Block>` behind an `Arc<RwLock<…>>`). If the in-memory aggregator lives in `crates/session` instead, edit that crate.

- [ ] **Step 1.2: Write failing test for `recent_commands`**

In the store crate's test module:

```rust
#[test]
fn recent_commands_ranks_by_recency_and_fuzzy() {
    let store = BlockStore::new();
    store.push(test_block("cargo build",   ts(100)));
    store.push(test_block("cargo test",    ts(200)));
    store.push(test_block("git status",    ts(150)));
    store.push(test_block("cargo bench",   ts(50)));
    let hits = store.recent_commands("cargo", 10);
    assert_eq!(hits.iter().map(|h| h.command.as_str()).collect::<Vec<_>>(),
               vec!["cargo test", "cargo build", "cargo bench"]);
}

#[test]
fn recent_commands_empty_query_returns_newest() {
    let store = BlockStore::new();
    store.push(test_block("a", ts(1)));
    store.push(test_block("b", ts(2)));
    assert_eq!(store.recent_commands("", 10)[0].command, "b");
}
```

Run: `cargo test -p blocks recent_commands` (substitute correct crate)
Expected: FAIL — method doesn't exist.

- [ ] **Step 1.3: Implement `recent_commands`**

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct CommandHit {
    pub block_id: String,        // ulid as string for IPC
    pub session_id: String,
    pub command: String,
    pub exit_code: Option<i32>,
    pub cwd: String,
    pub finished_at_unix_ms: u64,
    pub match_indices: Vec<u32>, // CHAR offsets in `command`
}

impl BlockStore {
    pub fn recent_commands(&self, query: &str, limit: usize) -> Vec<CommandHit> {
        let blocks = self.read();  // adapt to actual lock API
        let mut scored: Vec<(i32, &Block)> = blocks
            .iter()
            .filter(|b| b.finished_at.is_some())
            .filter_map(|b| {
                if query.is_empty() {
                    Some((0, b))
                } else {
                    fuzzy_match(&b.command, query).map(|s| (s, b))
                }
            })
            .collect();
        // Sort: score desc, then finished_at desc.
        scored.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then(b.1.finished_at_unix_ms().cmp(&a.1.finished_at_unix_ms()))
        });
        scored.into_iter()
            .take(limit)
            .map(|(_, b)| CommandHit {
                block_id: b.id.to_string(),
                session_id: b.session_id.to_string(),
                command: b.command.clone(),
                exit_code: b.exit_code,
                cwd: b.cwd.display().to_string(),
                finished_at_unix_ms: b.finished_at_unix_ms(),
                match_indices: fuzzy_indices(&b.command, query),
            })
            .collect()
    }
}
```

If `fuzzy_match`/`fuzzy_indices` don't exist in this crate, copy the same scoring approach used by `structure::find_files` (see `crates/app/src/structure.rs:418`). If that lives in a third crate, factor it; otherwise duplicate — fuzzy scoring is small.

Run: `cargo test -p blocks recent_commands`
Expected: PASS.

- [ ] **Step 1.4: Expose as Tauri command**

In `crates/app/src/lib.rs`, near `structure_find_files` (~line 2421):

```rust
#[tauri::command]
async fn find_recent_commands(
    state: tauri::State<'_, AppState>,
    query: String,
    limit: usize,
) -> Result<Vec<blocks::CommandHit>, String> {
    let store = state.block_store.clone();
    tokio::task::spawn_blocking(move || store.recent_commands(&query, limit))
        .await
        .map_err(|e| format!("find_recent_commands join: {e}"))
}
```

Add `find_recent_commands,` to the `invoke_handler` list at ~line 3303.

Verify field name matches actual `AppState` (search for `block_store` or equivalent — if the field has a different name, use it).

Run: `cargo check`
Expected: clean.

- [ ] **Step 1.5: Bind in `ui/src/api.ts`**

Add after `structureFindFiles`:

```ts
export interface CommandHit {
  block_id: string;
  session_id: string;
  command: string;
  exit_code: number | null;
  cwd: string;
  finished_at_unix_ms: number;
  match_indices: number[];
}

export async function findRecentCommands(
  query: string,
  limit: number,
): Promise<CommandHit[]> {
  return invoke<CommandHit[]>("find_recent_commands", { query, limit });
}
```

- [ ] **Step 1.6: Commit**

```bash
git add crates/ ui/src/api.ts
git commit -m "feat(blocks): find_recent_commands query + IPC binding"
```

---

## Task 2: `mention-sources.ts` — unified `findMentions`

**Files:**
- Create: `ui/src/teammate/mention-sources.ts`
- Create: `ui/src/teammate/mention-sources.test.ts`

- [ ] **Step 2.1: Write failing tests**

```ts
// ui/src/teammate/mention-sources.test.ts
import { describe, it, expect, vi } from "vitest";
import { findMentions, type MentionSourcesDeps } from "./mention-sources";

const deps = (over: Partial<MentionSourcesDeps> = {}): MentionSourcesDeps => ({
  findFiles:       vi.fn().mockResolvedValue([]),
  listOperators:   vi.fn().mockResolvedValue([]),
  listOpenSessions:vi.fn().mockReturnValue([]),
  findRecentCommands: vi.fn().mockResolvedValue([]),
  ...over,
});

describe("findMentions", () => {
  it("returns interleaved top-N per source on 'all' tab", async () => {
    const d = deps({
      findFiles: vi.fn().mockResolvedValue([
        { path: "/a/x.ts", rel_path: "x.ts", match_indices: [] },
        { path: "/a/y.ts", rel_path: "y.ts", match_indices: [] },
        { path: "/a/z.ts", rel_path: "z.ts", match_indices: [] },
        { path: "/a/w.ts", rel_path: "w.ts", match_indices: [] }, // 4th, should drop
      ]),
      listOperators: vi.fn().mockResolvedValue([{ id: "op1", name: "claude" }]),
    });
    const hits = await findMentions({ query: "", cwd: "/a", activeTab: "all", limit: 12, deps: d });
    const kinds = hits.map(h => h.kind);
    expect(kinds.filter(k => k === "files").length).toBe(3); // top-3 only on all
    expect(kinds).toContain("teammates");
  });

  it("scoped tab returns only that source, full limit", async () => {
    const d = deps({
      findFiles: vi.fn().mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({ path: `/a/${i}.ts`, rel_path: `${i}.ts`, match_indices: [] })),
      ),
    });
    const hits = await findMentions({ query: "", cwd: "/a", activeTab: "files", limit: 12, deps: d });
    expect(hits.length).toBe(10);
    expect(hits.every(h => h.kind === "files")).toBe(true);
  });

  it("source failure does not break the whole picker", async () => {
    const d = deps({
      findFiles: vi.fn().mockRejectedValue(new Error("boom")),
      listOperators: vi.fn().mockResolvedValue([{ id: "op1", name: "claude" }]),
    });
    const hits = await findMentions({ query: "", cwd: "/a", activeTab: "all", limit: 12, deps: d });
    expect(hits.some(h => h.kind === "teammates")).toBe(true);
  });

  it("null cwd → files source contributes zero, others still run", async () => {
    const d = deps({
      findFiles: vi.fn(),
      listOperators: vi.fn().mockResolvedValue([{ id: "op1", name: "claude" }]),
    });
    const hits = await findMentions({ query: "", cwd: null, activeTab: "all", limit: 12, deps: d });
    expect(d.findFiles).not.toHaveBeenCalled();
    expect(hits.some(h => h.kind === "teammates")).toBe(true);
  });
});
```

Run: `pnpm -C ui vitest run mention-sources` (or `npm test`; verify the runner from `ui/package.json`)
Expected: FAIL — module doesn't exist.

- [ ] **Step 2.2: Implement `mention-sources.ts`**

```ts
/// Unified mention source orchestrator. Each provider can fail; the
/// orchestrator interleaves results so partial failures still produce
/// a useful popup.

import type { FileHit, CommandHit, Operator } from "../api";

export type Source = "files" | "sessions" | "commands" | "teammates";
export type Tab = "all" | Source;

export interface OpenSessionInfo {
  session_id: string;
  short_id: string;     // "01HXXX…" first 6
  cwd: string;
  tab_index: number;    // 1-based
  shell: string;
  last_command: string | null;
  block_count: number;
}

export interface MentionHit {
  kind: Source;
  /// Canonical insertion token (without the leading "@").
  /// Files: rel_path. Sessions: "session:<short_id>". Commands:
  /// "cmd:<block_id>". Teammates: "teammate:<name>".
  token: string;
  primary: string;
  secondary: string;
  matchIndices: number[];
  /// Source-specific original payload, used by `expandMentions` later.
  payload:
    | { kind: "files";     abs: string; rel: string }
    | { kind: "sessions";  session_id: string }
    | { kind: "commands";  block_id: string; session_id: string }
    | { kind: "teammates"; operator_id: string; name: string };
}

export interface MentionSourcesDeps {
  findFiles:           (cwd: string, query: string, limit: number) => Promise<FileHit[]>;
  listOperators:       () => Promise<Operator[]>;
  listOpenSessions:    () => OpenSessionInfo[]; // sync; pulled from in-memory TabsManager
  findRecentCommands:  (query: string, limit: number) => Promise<CommandHit[]>;
}

export interface FindMentionsArgs {
  query: string;
  cwd: string | null;
  activeTab: Tab;
  limit: number;
  deps: MentionSourcesDeps;
}

const PER_SOURCE_ON_ALL = 3;

export async function findMentions(args: FindMentionsArgs): Promise<MentionHit[]> {
  const { query, cwd, activeTab, limit, deps } = args;
  const want = (s: Source) => activeTab === "all" || activeTab === s;

  const filesP = want("files") && cwd
    ? deps.findFiles(cwd, query, limit).then(asFileHits).catch(logZero("findFiles"))
    : Promise.resolve<MentionHit[]>([]);

  const sessionsP = want("sessions")
    ? Promise.resolve(filterSessions(deps.listOpenSessions(), query)).catch(logZero("listOpenSessions"))
    : Promise.resolve<MentionHit[]>([]);

  const commandsP = want("commands")
    ? deps.findRecentCommands(query, limit).then(asCommandHits).catch(logZero("findRecentCommands"))
    : Promise.resolve<MentionHit[]>([]);

  const teammatesP = want("teammates")
    ? deps.listOperators().then(ops => filterTeammates(ops, query)).catch(logZero("listOperators"))
    : Promise.resolve<MentionHit[]>([]);

  const [files, sessions, commands, teammates] =
    await Promise.all([filesP, sessionsP, commandsP, teammatesP]);

  if (activeTab !== "all") {
    return ({ files, sessions, commands, teammates } as Record<Source, MentionHit[]>)[activeTab].slice(0, limit);
  }
  // All tab — top N per source, preserving the order [files, sessions, commands, teammates].
  return [
    ...files.slice(0, PER_SOURCE_ON_ALL),
    ...sessions.slice(0, PER_SOURCE_ON_ALL),
    ...commands.slice(0, PER_SOURCE_ON_ALL),
    ...teammates.slice(0, PER_SOURCE_ON_ALL),
  ].slice(0, limit);
}

function logZero(name: string): (e: unknown) => MentionHit[] {
  return (e) => { console.error(`mention source ${name} failed`, e); return []; };
}

function asFileHits(hits: FileHit[]): MentionHit[] {
  return hits.map(h => ({
    kind: "files" as const,
    token: h.rel_path,
    primary: basename(h.rel_path),
    secondary: h.rel_path,
    matchIndices: h.match_indices,
    payload: { kind: "files", abs: h.path, rel: h.rel_path },
  }));
}

function asCommandHits(hits: CommandHit[]): MentionHit[] {
  return hits.map(h => ({
    kind: "commands" as const,
    token: `cmd:${h.block_id}`,
    primary: h.command,
    secondary: `exit ${h.exit_code ?? "?"} · ${relativeTime(h.finished_at_unix_ms)} · ${shortCwd(h.cwd)}`,
    matchIndices: h.match_indices,
    payload: { kind: "commands", block_id: h.block_id, session_id: h.session_id },
  }));
}

function filterSessions(sessions: OpenSessionInfo[], query: string): MentionHit[] {
  const q = query.toLowerCase();
  const candidates = sessions.filter(s =>
    q === "" ||
    s.cwd.toLowerCase().includes(q) ||
    s.shell.toLowerCase().includes(q) ||
    String(s.tab_index) === q
  );
  return candidates.map(s => ({
    kind: "sessions" as const,
    token: `session:${s.short_id}`,
    primary: `tab ${s.tab_index} · ${s.shell}`,
    secondary: `${shortCwd(s.cwd)} · ${s.block_count} blocks${s.last_command ? ` · last: ${s.last_command}` : ""}`,
    matchIndices: [],
    payload: { kind: "sessions", session_id: s.session_id },
  }));
}

function filterTeammates(ops: Operator[], query: string): MentionHit[] {
  const q = query.toLowerCase();
  return ops
    .filter(o => q === "" || o.name.toLowerCase().includes(q))
    .map(o => ({
      kind: "teammates" as const,
      token: `teammate:${o.name}`,
      primary: o.name,
      secondary: `teammate${o.model ? ` · ${o.model}` : ""}`,
      matchIndices: [],
      payload: { kind: "teammates", operator_id: o.id, name: o.name },
    }));
}

function basename(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
function shortCwd(cwd: string): string { return cwd.replace(/^.*\/([^/]+\/[^/]+)$/, "…/$1"); }
function relativeTime(ms: number): string {
  const d = Date.now() - ms; const s = Math.floor(d / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
```

Run: tests from 2.1.
Expected: PASS.

- [ ] **Step 2.3: Commit**

```bash
git add ui/src/teammate/mention-sources.ts ui/src/teammate/mention-sources.test.ts
git commit -m "feat(teammate): mention-sources orchestrator (files/sessions/commands/teammates)"
```

---

## Task 3: `ComposerInput` — contenteditable + atomic chips

**Files:**
- Create: `ui/src/teammate/composer-input.ts`
- Create: `ui/src/teammate/composer-input.test.ts`

- [ ] **Step 3.1: Write failing tests**

```ts
// ui/src/teammate/composer-input.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { ComposerInput } from "./composer-input";

let host: HTMLElement;
let ci: ComposerInput;

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  ci = new ComposerInput(host, { placeholder: "x" });
});

describe("ComposerInput", () => {
  it("emits input event on text change", () => {
    let count = 0;
    ci.onInput(() => count++);
    ci.element().textContent = "hi";
    ci.element().dispatchEvent(new InputEvent("input"));
    expect(count).toBe(1);
  });

  it("getValue serializes text + chip tokens", () => {
    ci.element().textContent = "see ";
    const range = document.createRange();
    range.selectNodeContents(ci.element());
    range.collapse(false);
    ci.replaceQueryWithChip(range, { kind: "files", token: "a/b.ts", label: "b.ts" }, "");
    ci.element().append(document.createTextNode(" please"));
    expect(ci.getValue()).toBe("see @a/b.ts  please");
  });

  it("setValue clears chips and writes plain text", () => {
    ci.setValue("hello");
    expect(ci.getValue()).toBe("hello");
    expect(ci.element().querySelectorAll(".tmt-chip").length).toBe(0);
  });

  it("chip nodes are contenteditable=false", () => {
    const r = document.createRange();
    ci.element().textContent = "";
    r.selectNodeContents(ci.element()); r.collapse(false);
    ci.replaceQueryWithChip(r, { kind: "sessions", token: "session:abc", label: "tab 2" }, "");
    const chip = ci.element().querySelector(".tmt-chip")!;
    expect(chip.getAttribute("contenteditable")).toBe("false");
    expect(chip.getAttribute("data-token")).toBe("session:abc");
  });
});
```

Run: vitest.
Expected: FAIL — module missing.

- [ ] **Step 3.2: Implement `composer-input.ts`**

```ts
/// Wraps a contenteditable div as a single-line composer that supports
/// atomic, color-coded mention chips. Chips are non-editable spans
/// with `contenteditable="false"`; backspace removes them whole.
///
/// `getValue()` serializes chips back to `@token` text so the rest of
/// the send pipeline keeps working with plain strings.

import type { Source } from "./mention-sources";

export interface ChipSpec {
  kind: Source;
  token: string;       // without leading @
  label: string;       // human-visible inside the chip
}

export interface ComposerInputOpts {
  placeholder?: string;
}

const ICONS: Record<Source, string> = {
  files: "⌗",
  sessions: "▮",
  commands: "$",
  teammates: "@",
};

export class ComposerInput {
  private el: HTMLDivElement;
  private inputCbs: Array<() => void> = [];
  private keydownCbs: Array<(e: KeyboardEvent) => void> = [];
  private submitCbs: Array<() => void> = [];

  constructor(host: HTMLElement, opts: ComposerInputOpts = {}) {
    this.el = document.createElement("div");
    this.el.className = "teammate-panel-input";
    this.el.setAttribute("contenteditable", "plaintext-only");
    this.el.setAttribute("role", "textbox");
    this.el.setAttribute("aria-multiline", "false");
    if (opts.placeholder) this.el.dataset.placeholder = opts.placeholder;
    this.el.addEventListener("input", () => { this.inputCbs.forEach(cb => cb()); });
    this.el.addEventListener("keydown", (e) => {
      this.keydownCbs.forEach(cb => cb(e));
      if (e.key === "Enter" && !e.shiftKey && !e.defaultPrevented) {
        e.preventDefault();
        this.submitCbs.forEach(cb => cb());
      }
    });
    host.appendChild(this.el);
  }

  element(): HTMLDivElement { return this.el; }

  setPlaceholder(p: string): void { this.el.dataset.placeholder = p; }

  setValue(text: string): void {
    this.el.textContent = text;
  }

  /// Walk the DOM, concatenating text and chip data-tokens (prefixed @).
  getValue(): string {
    let out = "";
    this.el.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.textContent ?? "";
      } else if (n instanceof HTMLElement && n.classList.contains("tmt-chip")) {
        out += "@" + (n.dataset.token ?? "");
      } else {
        out += n.textContent ?? "";
      }
    });
    return out;
  }

  clear(): void {
    this.el.innerHTML = "";
  }

  focus(): void { this.el.focus(); }

  /// Get the active `@token` segment to the left of the caret. Returns
  /// null if the caret isn't inside one. Walks the *current* text-node
  /// only, so chips terminate scanning automatically.
  getActiveMention(): { node: Text; start: number; end: number; query: string } | null {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.textContent ?? "";
    const caret = range.startOffset;
    let i = caret - 1;
    while (i >= 0) {
      const ch = text[i];
      if (ch === "@") {
        const prev = i === 0 ? " " : text[i - 1];
        const startOfNode = i === 0;
        // Mention must be at start of node or after whitespace. Chip
        // boundaries also count as "start" because they sit between
        // text nodes.
        if (startOfNode || /\s/.test(prev)) {
          return { node: node as Text, start: i, end: caret, query: text.slice(i + 1, caret) };
        }
        return null;
      }
      if (/\s/.test(ch)) return null;
      i--;
    }
    return null;
  }

  /// Replace `@query` segment with an atomic chip + trailing space.
  /// Caller passes the active range from `getActiveMention`.
  replaceQueryWithChip(
    range: { node: Text; start: number; end: number } | Range,
    spec: ChipSpec,
    _query: string,
  ): void {
    if ("node" in range) {
      const r = document.createRange();
      r.setStart(range.node, range.start);
      r.setEnd(range.node, range.end);
      r.deleteContents();
      const chip = this.buildChip(spec);
      r.insertNode(document.createTextNode(" "));
      r.insertNode(chip);
      // Move caret after the space.
      const sel = window.getSelection();
      if (sel) {
        const after = document.createRange();
        after.setStartAfter(chip.nextSibling!); after.collapse(true);
        sel.removeAllRanges(); sel.addRange(after);
      }
    } else {
      // Range path used by tests when we don't have a Text node start.
      range.deleteContents();
      const chip = this.buildChip(spec);
      range.insertNode(chip);
      range.collapse(false);
      this.el.appendChild(document.createTextNode(" "));
    }
    this.inputCbs.forEach(cb => cb());
  }

  /// Drop all chips and emit input — used when the caller wants to
  /// reset draft state.
  removeAllChips(): void {
    this.el.querySelectorAll(".tmt-chip").forEach(c => c.remove());
    this.inputCbs.forEach(cb => cb());
  }

  /// Iterate chip tokens currently in the input.
  chips(): Array<{ kind: Source; token: string }> {
    return Array.from(this.el.querySelectorAll<HTMLElement>(".tmt-chip")).map(c => ({
      kind: c.dataset.kind as Source,
      token: c.dataset.token ?? "",
    }));
  }

  onInput(cb: () => void): void { this.inputCbs.push(cb); }
  onKeydown(cb: (e: KeyboardEvent) => void): void { this.keydownCbs.push(cb); }
  onSubmit(cb: () => void): void { this.submitCbs.push(cb); }

  private buildChip(spec: ChipSpec): HTMLSpanElement {
    const c = document.createElement("span");
    c.className = `tmt-chip tmt-chip--${spec.kind}`;
    c.setAttribute("contenteditable", "false");
    c.dataset.kind = spec.kind;
    c.dataset.token = spec.token;
    c.innerHTML =
      `<span class="tmt-chip__ico">${ICONS[spec.kind]}</span>` +
      escapeHtml(spec.label);
    return c;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]!));
}
```

Run: vitest from 3.1.
Expected: PASS.

- [ ] **Step 3.3: Commit**

```bash
git add ui/src/teammate/composer-input.ts ui/src/teammate/composer-input.test.ts
git commit -m "feat(teammate): ComposerInput with atomic mention chips"
```

---

## Task 4: Refactor `MentionPopup` to multi-source

**Files:**
- Modify: `ui/src/teammate/mentions.ts` (replace `MentionPopup` body + state types)
- Modify: `ui/src/teammate/mentions.test.ts` (extend cases)

- [ ] **Step 4.1: Update test file with new cases**

Add to `mentions.test.ts` (keep existing `activeMentionAt` / `expandMentions` cases):

```ts
import { MentionPopup } from "./mentions";
import type { MentionHit, MentionSourcesDeps } from "./mention-sources";

function harness(overrides: Partial<MentionSourcesDeps> = {}) {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const input = new (require("./composer-input").ComposerInput)(host);
  const deps: MentionSourcesDeps = {
    findFiles: async () => [],
    listOperators: async () => [],
    listOpenSessions: () => [],
    findRecentCommands: async () => [],
    ...overrides,
  };
  const onPick = vi.fn();
  const popup = new MentionPopup({
    input,
    anchor: host,
    getCwd: () => "/tmp",
    sources: deps,
    onPick,
  });
  return { popup, input, host, onPick };
}

describe("MentionPopup v2", () => {
  it("opens on @ even with empty results", async () => {
    const { popup, input } = harness();
    input.element().textContent = "@";
    placeCaretAtEnd(input.element());
    input.element().dispatchEvent(new InputEvent("input"));
    await flush();
    expect(popup.isOpen()).toBe(true);
    expect(popup.currentEl()?.querySelector(".tmt-mp-foot")).toBeTruthy();
  });

  it("renders tabs and switches active source on click", async () => {
    const { popup, input } = harness({
      findFiles: async () => [{ path: "/a/x.ts", rel_path: "x.ts", match_indices: [] }],
      listOperators: async () => [{ id: "1", name: "claude" } as any],
    });
    input.element().textContent = "@";
    placeCaretAtEnd(input.element());
    input.element().dispatchEvent(new InputEvent("input"));
    await flush();
    const tabs = popup.currentEl()!.querySelectorAll(".tmt-mp-tab");
    expect(tabs.length).toBe(5); // All + 4 sources
    (tabs[1] as HTMLElement).click(); // Files tab
    await flush();
    expect(popup.currentEl()!.querySelector(".tmt-mp-tab.is-active")!.textContent).toMatch(/files/i);
  });

  it("never silently no-ops when cwd is null — shows other sources", async () => {
    const { popup, input } = harness({ listOperators: async () => [{ id: "1", name: "claude" } as any] });
    (popup as any).deps.getCwd = () => null;
    input.element().textContent = "@";
    placeCaretAtEnd(input.element());
    input.element().dispatchEvent(new InputEvent("input"));
    await flush();
    expect(popup.currentEl()!.textContent).toMatch(/teammates|claude|no active session/i);
  });
});

function placeCaretAtEnd(el: HTMLElement) {
  const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
  const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
}
async function flush() { await new Promise(r => setTimeout(r, 200)); } // > FIND_DEBOUNCE_MS
```

Run: vitest mentions.
Expected: FAIL — `sources` dep / new structure not implemented.

- [ ] **Step 4.2: Refactor `MentionPopup`**

Replace the existing `MentionPopup` class in `ui/src/teammate/mentions.ts`. Keep `activeMentionAt`, `expandMentions`, helpers — only `MentionPopup` + types change.

```ts
import type {
  MentionHit, MentionSourcesDeps, Tab, Source,
} from "./mention-sources";
import { findMentions } from "./mention-sources";
import type { ComposerInput, ChipSpec } from "./composer-input";

const FIND_DEBOUNCE_MS = 120;
const POPUP_LIMIT = 20;
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "all",       label: "All" },
  { id: "files",     label: "Files" },
  { id: "sessions",  label: "Sessions" },
  { id: "commands",  label: "Commands" },
  { id: "teammates", label: "Teammates" },
];

interface PopupState {
  start: number;
  query: string;
  activeTab: Tab;
  hits: MentionHit[];
  selected: number;
  loading: boolean;
  cwd: string | null;
}

export interface MentionPopupDeps {
  input: ComposerInput;
  anchor: HTMLElement;
  getCwd: () => string | null;
  sources: MentionSourcesDeps;
  onPick: (chip: ChipSpec, hit: MentionHit) => void;
}

export class MentionPopup {
  private el: HTMLDivElement | null = null;
  private state: PopupState | null = null;
  private debounce: number | null = null;
  private reqId = 0;

  constructor(private deps: MentionPopupDeps) {
    deps.input.onInput(() => this.onInputChange());
    deps.input.onKeydown((e) => this.onKeyDown(e));
  }

  isOpen(): boolean { return this.state !== null; }
  currentEl(): HTMLDivElement | null { return this.el; }

  destroy(): void { this.close(); }

  private onInputChange(): void {
    const m = this.deps.input.getActiveMention();
    if (!m) { this.close(); return; }
    const cwd = this.deps.getCwd();
    this.openOrUpdate({
      start: m.start, query: m.query,
      activeTab: this.state?.activeTab ?? "all",
      hits: this.state?.hits ?? [], selected: 0, loading: true, cwd,
    });
    this.scheduleFetch();
  }

  private scheduleFetch(): void {
    if (this.debounce !== null) window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => { void this.runFetch(); }, FIND_DEBOUNCE_MS);
  }

  private async runFetch(): Promise<void> {
    if (!this.state) return;
    const my = ++this.reqId;
    const { query, cwd, activeTab } = this.state;
    const hits = await findMentions({
      query, cwd, activeTab, limit: POPUP_LIMIT, deps: this.deps.sources,
    });
    if (my !== this.reqId || !this.state) return;
    this.state.hits = hits;
    this.state.loading = false;
    this.state.selected = 0;
    this.render();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.state) return;
    const { hits } = this.state;
    if (e.key === "Escape") { e.preventDefault(); this.close(); return; }
    if (e.key === "ArrowDown" && hits.length) {
      e.preventDefault();
      this.state.selected = (this.state.selected + 1) % hits.length;
      this.render(); return;
    }
    if (e.key === "ArrowUp" && hits.length) {
      e.preventDefault();
      this.state.selected = (this.state.selected - 1 + hits.length) % hits.length;
      this.render(); return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && hits.length) {
      e.preventDefault();
      this.pick(hits[this.state.selected]); return;
    }
    if (e.key === "Tab" && e.shiftKey === false) {
      // cycle tabs
      e.preventDefault();
      this.setTab(nextTab(this.state.activeTab)); return;
    }
  }

  private setTab(t: Tab): void {
    if (!this.state) return;
    this.state.activeTab = t;
    this.state.loading = true; this.state.hits = []; this.state.selected = 0;
    this.render(); this.scheduleFetch();
  }

  private pick(hit: MentionHit): void {
    if (!this.state) return;
    const m = this.deps.input.getActiveMention();
    if (m) {
      const chip: ChipSpec = { kind: hit.kind, token: hit.token, label: hit.primary };
      this.deps.input.replaceQueryWithChip(m, chip, m.query);
      this.deps.onPick(chip, hit);
    }
    this.close();
  }

  private close(): void {
    this.state = null;
    if (this.el) { this.el.remove(); this.el = null; }
  }

  private openOrUpdate(next: PopupState): void {
    this.state = next;
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "tmt-mp"; // popup root
      this.el.setAttribute("role", "listbox");
      this.deps.anchor.appendChild(this.el);
    }
    this.render();
  }

  private render(): void {
    if (!this.el || !this.state) return;
    const { hits, selected, loading, cwd, activeTab } = this.state;

    const header = TABS.map(t =>
      `<div class="tmt-mp-tab${t.id === activeTab ? " is-active" : ""}" data-tab="${t.id}">${t.label}</div>`
    ).join("");

    let body = "";
    if (loading && hits.length === 0) {
      body = `<div class="tmt-mp-empty">Searching…</div>`;
    } else if (hits.length === 0) {
      const msg = !cwd && activeTab === "files"
        ? "No active session — file mentions unavailable."
        : `No matches${this.state.query ? ` for “${this.state.query}”` : ""}.`;
      body = `<div class="tmt-mp-empty">${escapeHtml(msg)}</div>`;
    } else {
      body = renderRows(hits, selected, activeTab);
    }

    this.el.innerHTML = `
      <div class="tmt-mp-header">${header}</div>
      <div class="tmt-mp-list">${body}</div>
      <div class="tmt-mp-foot">
        <span><kbd>↑↓</kbd> nav</span>
        <span><kbd>⇥</kbd>/<kbd>↵</kbd> insert</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    `;
    this.el.querySelectorAll<HTMLElement>(".tmt-mp-tab").forEach(t => {
      t.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.setTab(t.dataset.tab as Tab);
      });
    });
    this.el.querySelectorAll<HTMLElement>(".tmt-mp-row").forEach((row, idx) => {
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (this.state) { this.state.selected = idx; this.pick(this.state.hits[idx]); }
      });
    });
  }
}

function nextTab(t: Tab): Tab {
  const idx = TABS.findIndex(x => x.id === t);
  return TABS[(idx + 1) % TABS.length].id;
}

function renderRows(hits: MentionHit[], selected: number, tab: Tab): string {
  const parts: string[] = [];
  let lastGroup: Source | null = null;
  hits.forEach((h, i) => {
    if (tab === "all" && h.kind !== lastGroup) {
      parts.push(`<div class="tmt-mp-group">${labelFor(h.kind)}</div>`);
      lastGroup = h.kind;
    }
    parts.push(
      `<div class="tmt-mp-row tmt-mp-row--${h.kind}${i === selected ? " is-selected" : ""}" data-idx="${i}">
        <div class="tmt-mp-row__ico">${iconFor(h.kind)}</div>
        <div class="tmt-mp-row__main">
          <div class="tmt-mp-row__name">${highlight(h.primary, h.matchIndices)}</div>
          <div class="tmt-mp-row__meta">${escapeHtml(h.secondary)}</div>
        </div>
      </div>`
    );
  });
  return parts.join("");
}

function labelFor(k: Source): string {
  return ({ files: "Files", sessions: "Sessions", commands: "Recent commands", teammates: "Teammates" } as const)[k];
}
function iconFor(k: Source): string {
  return ({ files: "⌗", sessions: "▮", commands: "$", teammates: "@" } as const)[k];
}
```

The existing `highlight` and `escapeHtml` helpers stay; if `escapeHtml` doesn't exist in this file already, add a small local copy.

Run: vitest mentions.
Expected: PASS for new tests; existing `activeMentionAt` / `expandMentions` tests still PASS.

- [ ] **Step 4.3: Commit**

```bash
git add ui/src/teammate/mentions.ts ui/src/teammate/mentions.test.ts
git commit -m "feat(teammate): multi-source MentionPopup with tabs and footer"
```

---

## Task 5: Generalize `expandMentions` for non-file chips

**Files:**
- Modify: `ui/src/teammate/mentions.ts` (existing `expandMentions` function)
- Modify: `ui/src/teammate/mentions.test.ts` (add cases)

- [ ] **Step 5.1: Decide payload registry shape**

The send path needs to look up each chip's payload by token. Change the `mentionedFiles: Map<string, string>` in `panel.ts` to a richer registry; for now, define the type in `mentions.ts`:

```ts
import type { MentionHit } from "./mention-sources";

export type MentionPayload = MentionHit["payload"];
export type MentionRegistry = Map<string, MentionPayload>; // key = token without "@"
```

- [ ] **Step 5.2: Write failing tests**

```ts
it("expandMentions handles a command chip by inlining cmd + output", async () => {
  const reg: MentionRegistry = new Map([
    ["cmd:01H", { kind: "commands", block_id: "01H", session_id: "S1" }],
  ]);
  const result = await expandMentions(
    "look at @cmd:01H",
    reg,
    /*readFile*/ undefined,
    {
      readBlock: async () => ({ command: "cargo test", exit_code: 1, cwd: "/r", plain_output: "FAIL ...\n" }),
      readSession: async () => { throw new Error("unused"); },
    },
  );
  expect(result.text).toMatch(/```command: cargo test/);
  expect(result.text).toMatch(/exit_code: 1/);
  expect(result.text).toMatch(/FAIL/);
});

it("expandMentions inlines session summary for a session chip", async () => {
  const reg: MentionRegistry = new Map([
    ["session:01H", { kind: "sessions", session_id: "S1" }],
  ]);
  const result = await expandMentions(
    "diff @session:01H",
    reg,
    undefined,
    {
      readBlock: async () => { throw new Error("unused"); },
      readSession: async () => ({
        cwd: "/r", shell: "zsh", tab_index: 2,
        recent: [
          { command: "ls", exit_code: 0, tail: "a\nb\n" },
          { command: "cargo test", exit_code: 1, tail: "FAIL\n" },
        ],
      }),
    },
  );
  expect(result.text).toMatch(/session: \/r/);
  expect(result.text).toMatch(/cargo test/);
});

it("teammate chip produces a one-line reference, not a fence", async () => {
  const reg: MentionRegistry = new Map([
    ["teammate:claude", { kind: "teammates", operator_id: "op1", name: "claude" }],
  ]);
  const result = await expandMentions("hey @teammate:claude", reg);
  expect(result.text).toMatch(/teammate @claude \(id=op1\)/);
});
```

Run: vitest.
Expected: FAIL.

- [ ] **Step 5.3: Implement generalization**

Replace `expandMentions` signature. Keep the file branch using existing `readFile` for back-compat.

```ts
export interface ExpansionDeps {
  readFile?:    ReadFileFn;
  readBlock?:   (block_id: string) => Promise<BlockExcerpt>;
  readSession?: (session_id: string) => Promise<SessionExcerpt>;
}

export interface BlockExcerpt {
  command: string;
  exit_code: number | null;
  cwd: string;
  plain_output: string;
}

export interface SessionExcerpt {
  cwd: string;
  shell: string;
  tab_index: number;
  recent: Array<{ command: string; exit_code: number | null; tail: string }>;
}

export async function expandMentions(
  rawText: string,
  registry: MentionRegistry,
  readFile?: ReadFileFn,
  extras: ExpansionDeps = {},
): Promise<ExpandedMessage> {
  const skipped: SkippedMention[] = [];
  let total = 0;
  const fences: string[] = [];
  const re = /(^|\s)@(\S+)/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawText)) !== null) {
    const token = m[2];
    if (seen.has(token)) continue;
    seen.add(token);
    const payload = registry.get(token);
    if (!payload) continue;

    if (payload.kind === "files" && readFile) {
      // existing behavior — read file, fence, append
      // (keep your current implementation here, unchanged)
    } else if (payload.kind === "commands" && extras.readBlock) {
      try {
        const b = await extras.readBlock(payload.block_id);
        const body = `command: ${b.command}\nexit_code: ${b.exit_code ?? "?"}\ncwd: ${b.cwd}\n\n${b.plain_output}`;
        if (total + body.length > MAX_TOTAL_BYTES) {
          skipped.push({ path: token, reason: "skipped (mention bundle over 512KB)" });
        } else {
          fences.push("```command: " + b.command + "\n" + body + "\n```");
          total += body.length;
        }
      } catch (e) {
        skipped.push({ path: token, reason: `unavailable (${String(e)})` });
      }
    } else if (payload.kind === "sessions" && extras.readSession) {
      try {
        const s = await extras.readSession(payload.session_id);
        const lines = [`cwd: ${s.cwd}`, `shell: ${s.shell}`, `tab: ${s.tab_index}`, ""];
        for (const r of s.recent) {
          lines.push(`$ ${r.command}    (exit ${r.exit_code ?? "?"})`);
          lines.push(r.tail.split("\n").slice(-20).join("\n"));
          lines.push("");
        }
        const body = lines.join("\n");
        if (total + body.length > MAX_TOTAL_BYTES) {
          skipped.push({ path: token, reason: "skipped (mention bundle over 512KB)" });
        } else {
          fences.push("```session: " + s.cwd + "\n" + body + "\n```");
          total += body.length;
        }
      } catch (e) {
        skipped.push({ path: token, reason: `unavailable (${String(e)})` });
      }
    } else if (payload.kind === "teammates") {
      fences.push(`teammate @${payload.name} (id=${payload.operator_id})`);
    }
  }
  const text = fences.length ? `${rawText}\n\n${fences.join("\n\n")}` : rawText;
  return { text, skipped };
}
```

Use whatever fenced-block conventions the existing file branch already uses; the snippet above is illustrative — match the live code's style.

Run: vitest.
Expected: PASS for new + existing cases.

- [ ] **Step 5.4: Add `readBlock` / `readSession` backend bindings**

Two more Tauri commands (small):

In Rust:
```rust
#[derive(serde::Serialize)]
pub struct BlockExcerptDto { pub command: String, pub exit_code: Option<i32>, pub cwd: String, pub plain_output: String }
#[derive(serde::Serialize)]
pub struct SessionExcerptDto { pub cwd: String, pub shell: String, pub tab_index: u32, pub recent: Vec<RecentBlockDto> }
#[derive(serde::Serialize)]
pub struct RecentBlockDto { pub command: String, pub exit_code: Option<i32>, pub tail: String }

#[tauri::command]
async fn read_block_excerpt(state: tauri::State<'_, AppState>, block_id: String) -> Result<BlockExcerptDto, String> { … }

#[tauri::command]
async fn read_session_excerpt(state: tauri::State<'_, AppState>, session_id: String, n: usize) -> Result<SessionExcerptDto, String> { … }
```

Both delegate to small helpers on the block/session store. `tail` truncates to last 4KB of `plain_output`.

Register in `invoke_handler`. Add corresponding `readBlockExcerpt`/`readSessionExcerpt` in `ui/src/api.ts`.

Run: `cargo check && pnpm -C ui tsc --noEmit`
Expected: clean.

- [ ] **Step 5.5: Commit**

```bash
git add crates/ ui/src/api.ts ui/src/teammate/mentions.ts ui/src/teammate/mentions.test.ts
git commit -m "feat(teammate): generalize expandMentions for session/command/teammate chips"
```

---

## Task 6: Wire everything into `panel.ts`

**Files:**
- Modify: `ui/src/teammate/panel.ts`

- [ ] **Step 6.1: Update `TeammatePanelDeps`**

Replace the `findFiles`/`readFile` optional props with a single required `mentionSources: MentionSourcesDeps` (still keep `readFile` for the file branch). Also accept `readBlock`/`readSession`:

```ts
import type { MentionSourcesDeps } from "./mention-sources";
// in TeammatePanelDeps:
mentionSources:  MentionSourcesDeps;        // REQUIRED — was findFiles?
readFile:        ReadFileFn;                // REQUIRED
readBlockExcerpt:   (id: string) => Promise<BlockExcerpt>;
readSessionExcerpt: (id: string) => Promise<SessionExcerpt>;
getActiveSessionCwd?: () => string | null;
```

In `DEFAULT_DEPS`, wire defaults from `../api.ts` (use the new bindings from Task 5.4). For `listOpenSessions`, expose a function on the existing TabsManager — search for it:

Run: `rg -n "class TabsManager\b" ui/src/`
Add a method `listOpenSessions(): OpenSessionInfo[]` if absent, populating from the current tab list and the per-tab block counts.

- [ ] **Step 6.2: Swap `<input>` → `ComposerInput`**

In `renderComposer()`:

```ts
private renderComposer(): HTMLElement {
  const c = document.createElement("form");
  c.className = "teammate-panel-composer";

  const composer = new ComposerInput(c, {
    placeholder: `Message ${this.operator?.name ?? ""}…  (type @ to mention a file, session, command, or teammate)`,
  });
  this.composerInput = composer;
  this.composerEl = c;

  composer.onSubmit(() => { void this.send(composer.getValue()); });
  composer.onInput(() => {
    if (composer.getValue().length === 0) this.mentionRegistry.clear();
  });

  this.mentionPopup?.destroy();
  this.mentionPopup = new MentionPopup({
    input: composer,
    anchor: c,
    getCwd: () => this.deps.getActiveSessionCwd?.() ?? null,
    sources: this.deps.mentionSources,
    onPick: (chip, hit) => { this.mentionRegistry.set(chip.token, hit.payload); },
  });
  return c;
}
```

Remove the old `this.inputEl` references; replace with `this.composerInput`. Update `send()`:

```ts
async send(text: string): Promise<void> {
  if (!this.operator) return;
  if (!text.trim()) return;
  const activeId = this.deps.getActiveSessionId?.() ?? null;
  let payload = text.trim();
  if (this.mentionRegistry.size > 0) {
    const expanded = await expandMentions(payload, this.mentionRegistry, this.deps.readFile, {
      readBlock:   this.deps.readBlockExcerpt,
      readSession: this.deps.readSessionExcerpt,
    });
    payload = expanded.text;
  }
  const msg = await this.deps.sendText(this.operator.id, payload, activeId);
  this.appendBubble(msg);
  this.composerInput?.clear();
  this.mentionRegistry.clear();
  this.setTyping(true);
}
```

Rename `mentionedFiles` → `mentionRegistry: MentionRegistry`. Touch all the spots flagged by tsc.

- [ ] **Step 6.3: Type-check and run existing panel tests**

Run: `pnpm -C ui tsc --noEmit && pnpm -C ui vitest run panel`
Expected: clean compile; panel tests pass (some may need a deps stub update — extend them to provide the new required fields).

- [ ] **Step 6.4: Commit**

```bash
git add ui/src/teammate/panel.ts ui/src/teammate/panel.test.ts ui/src/api.ts
git commit -m "feat(teammate): swap composer to ComposerInput + multi-source mentions"
```

---

## Task 7: CSS — popup chrome + chips

**Files:**
- Modify: `ui/src/styles.css` (around the existing `.teammate-mention-*` block at line 15474)

- [ ] **Step 7.1: Replace + extend the mention-popup styles**

Delete the existing `.teammate-mention-popup`, `.teammate-mention-row`, `.teammate-mention-row b`, `.teammate-mention-row.is-selected`, `.teammate-mention-empty` blocks. Insert in the same location:

```css
/* === Mention picker (teammate composer) =============================== */
.tmt-mp {
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: calc(100% - 6px);
  z-index: 12;
  max-height: 280px;
  display: flex;
  flex-direction: column;
  background: var(--bg-overlay, var(--bg-panel));
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  padding: 4px;
  font-size: 12px;
}
.tmt-mp-header {
  display: flex; gap: 2px;
  padding: 4px 4px 6px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.tmt-mp-tab {
  flex: 1; text-align: center;
  padding: 5px 6px; border-radius: 6px;
  color: var(--fg-muted, #7c8597);
  font-size: 10.5px; letter-spacing: .04em;
  text-transform: uppercase; font-weight: 600;
  cursor: pointer; user-select: none;
}
.tmt-mp-tab.is-active {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}
.tmt-mp-list { overflow-y: auto; max-height: 200px; }
.tmt-mp-group {
  padding: 6px 8px 3px;
  color: var(--fg-muted, #5d6577);
  font-size: 9.5px; text-transform: uppercase;
  letter-spacing: .08em; font-weight: 700;
}
.tmt-mp-row {
  display: flex; align-items: center; gap: 10px;
  padding: 6px 8px; border-radius: 6px;
  cursor: pointer; white-space: nowrap;
}
.tmt-mp-row.is-selected,
.tmt-mp-row:hover {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
}
.tmt-mp-row__ico {
  width: 22px; height: 22px; border-radius: 5px;
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  color: var(--fg-muted, #9aa3b6);
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; flex-shrink: 0;
}
.tmt-mp-row--sessions  .tmt-mp-row__ico { background: rgba(120,180,255,.15); color: #9ec6ff; }
.tmt-mp-row--commands  .tmt-mp-row__ico { background: rgba(180,140,255,.15); color: #c8b1ff; }
.tmt-mp-row--teammates .tmt-mp-row__ico { background: rgba(120,220,170,.15); color: #9ee7c2; }
.tmt-mp-row__main { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.tmt-mp-row__name { color: var(--fg); font-weight: 500; }
.tmt-mp-row__name b { color: var(--accent); font-weight: 700; }
.tmt-mp-row__meta {
  color: var(--fg-muted, #6b7385);
  font-size: 10.5px; margin-top: 1px;
  overflow: hidden; text-overflow: ellipsis;
}
.tmt-mp-empty {
  padding: 12px; text-align: center;
  color: var(--fg-muted, #6b7385); font-style: italic;
}
.tmt-mp-foot {
  border-top: 1px solid var(--border);
  padding: 5px 8px; display: flex; gap: 14px;
  color: var(--fg-muted, #6b7385); font-size: 10.5px;
}
.tmt-mp-foot kbd {
  background: color-mix(in srgb, var(--fg) 8%, transparent);
  border: 1px solid var(--border); border-radius: 3px;
  padding: 0 4px; font-family: ui-monospace, monospace;
  font-size: 10px; color: var(--fg);
}

/* === Inline mention chips (composer input) ============================ */
.tmt-chip {
  display: inline-flex; align-items: center; gap: 4px;
  background: rgba(255,140,80,.14);
  border: 1px solid rgba(255,140,80,.4);
  color: #ffb38a;
  border-radius: 6px; padding: 1px 6px;
  font-size: 11px; font-weight: 600;
  user-select: none;
  vertical-align: baseline;
}
.tmt-chip__ico { opacity: .75; }
.tmt-chip--sessions  { background: rgba(120,180,255,.14); border-color: rgba(120,180,255,.4); color: #9ec6ff; }
.tmt-chip--commands  { background: rgba(180,140,255,.14); border-color: rgba(180,140,255,.4); color: #c8b1ff; }
.tmt-chip--teammates { background: rgba(120,220,170,.14); border-color: rgba(120,220,170,.4); color: #9ee7c2; }

/* Placeholder for contenteditable composer */
.teammate-panel-input[contenteditable][data-placeholder]:empty::before {
  content: attr(data-placeholder);
  color: var(--fg-muted, #7c8597);
  pointer-events: none;
}
```

- [ ] **Step 7.2: Smoke check**

Run: `pnpm -C ui vite build` (or `tauri dev` startup) — confirm no parse errors.
Expected: clean build.

- [ ] **Step 7.3: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(teammate): styles for multi-source mention picker + inline chips"
```

---

## Task 8: Manual verification in the app

- [ ] **Step 8.1: Launch dev build**

Run: `cargo tauri dev`
Expected: app boots, no console errors.

- [ ] **Step 8.2: Verify each acceptance criterion**

In the teammate panel composer:

- [ ] Type `@` with no query → popup opens with All tab, 4 grouped sections visible (or partial if some sources have zero hits), footer shows key hints.
- [ ] Type `@men` → fuzzy-matched file rows with bolded chars; commands matching "men" also visible.
- [ ] Click "Sessions" tab → only session rows; switching tabs cycles via Tab key.
- [ ] Arrow keys move selection; ↵ inserts the highlighted item as a chip.
- [ ] Chip renders in the input with correct color; pressing Backspace once removes the whole chip, not one character.
- [ ] Send a message containing a file chip → backend receives the original `@path` token AND the fenced file contents.
- [ ] Send a message containing a command chip → backend receives a fenced block titled `command: <cmd>` with output.
- [ ] Close the active tab, then try to mention a file → "No active session" hint shows under Files; other sources still listed and pickable.
- [ ] Disable the dev `findFiles` provider temporarily (e.g. throw in `mention-sources`) → other sources still produce results; console logs the failure; user sees no silent dead-input.

- [ ] **Step 8.3: Final commit if any verify-driven fixes were needed**

```bash
git add -p
git commit -m "fix(teammate): polish from manual verification"
```

---

## Self-Review

- **Spec coverage:**
  - Bug fix (silent failure) → Task 6.2 removes the `if (findFiles)` guard, makes deps required.
  - Multi-source picker (Files/Sessions/Commands/Teammates) → Tasks 2, 4.
  - Atomic chips → Task 3.
  - Tab UI + footer key hints → Task 4.2 render, Task 7.
  - Expansion semantics (files inline, sessions/commands summary, teammates ref) → Task 5.
  - Backend `find_recent_commands` → Task 1.
  - Total payload cap reused → Task 5.3 preserves `MAX_TOTAL_BYTES`.

- **Placeholder scan:** Step 5.3 has an `// existing implementation here, unchanged` placeholder for the file branch — that's intentional (don't rewrite what works) but the implementer must actually keep the live code. Flag is acceptable.

- **Type consistency:** `MentionHit.kind` uses `Source` literals (`"files"`, etc.) consistently across mention-sources.ts, composer-input.ts, mentions.ts CSS class suffixes, and panel.ts. `MentionRegistry` key is the bare token (no leading `@`); `getValue()` and `expandMentions` regex both produce/consume that shape.
