# Mission Picker Full Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the "Set mission spec" modal (`ui/src/tabs/mission-picker.ts`, 428 LOC) into a full-screen page (`#mission-page`) with search + preview pane, mirroring the established Docs Hub / Drafts pattern.

**Architecture:** New module `ui/src/mission/page.ts` exporting a `MissionPage` class that mirrors `DocsPanel` (workspace cell swap, `Esc` to close). Sidebar (search + sections Published/Superpowers/Drafts/path-input) + preview pane (right). Selection loads the `.md` body via a new `read_spec_body` Tauri command and renders it through a small markdown→HTML helper. The old modal is deleted in the same change. Backend reuses `list_published_specs`, `list_drafts`, `list_superpowers_missions` from spec 3.11 — only **one** new backend command (`read_spec_body`) is added.

**Tech Stack:** Rust + Tokio (`crates/app`), TypeScript + xterm.js (`ui/src`), Vitest (frontend tests), Lucide-sourced inline SVG icons. No new runtime deps; markdown rendered by a ~40-LOC inline helper.

**Spec:** `docs/specs/3.15-mission-picker-page.md`

**Commit policy:** Per the user's stated preference (memory: `feedback_commit_granularity`), do NOT commit after each task. Implement the entire plan, then create **one** `feat: …` commit at the end (Task 12). Per-task verification still happens — only the commits are consolidated.

---

## File-by-file impact

| File | Change |
|---|---|
| `crates/app/src/drafts.rs` | Add `read_spec_body(path, max_bytes) -> SpecBody` + 2 unit tests. |
| `crates/app/src/lib.rs` | Register `drafts::read_spec_body` Tauri command. |
| `ui/src/drafts/api.ts` | Add `draftsApi.readSpecBody(path)` + `SpecBody` type. |
| `ui/src/mission/page.ts` | **CREATE** — `MissionPage` class (open/close/render/keyboard nav/fetch). |
| `ui/src/mission/page.test.ts` | **CREATE** — pure-state helpers (filter, canSubmit, navigate). |
| `ui/src/mission/preview.ts` | **CREATE** — minimal markdown→HTML renderer. |
| `ui/src/mission/preview.test.ts` | **CREATE** — renderer unit tests. |
| `ui/index.html` | Add `<section id="mission-page" hidden></section>` next to `#drafts-page`. |
| `ui/src/main.ts` | Mount `MissionPage`, listen for `mission:open`, ⌘M binding, mutual-exclusion vs settings/docs/drafts. |
| `ui/src/tabs/manager.ts` | Replace `openMissionPicker(...)` call in `promptAndSetMission` with `missionPage.open(opts)` returning the same `PickerResult` shape. Remove import of `openMissionPicker`/`openNewSuperpowersTopicModal`; the topic modal moves to `mission/page.ts` so it stays co-located. |
| `ui/src/styles.css` | Add `#mission-page` styles (grid 2-col, sidebar, sections, preview, skeleton, footer). |
| `ui/src/tabs/mission-picker.ts` | **DELETE.** |
| `ui/src/tabs/mission-picker.test.ts` | **DELETE.** |

Out of bounds (DO NOT touch): `crates/agent/`, `crates/blocks/`, `crates/session/`, `crates/pty/`, `crates/app/src/{operator,aom,safety,mission_persistence,storage,settings}.rs`, `ui/src/{aom,operator,recall,structure,settings,blocks}/`, `docs/specs/_template.md`, existing published specs.

---

## Task 1: Backend — `read_spec_body` Tauri command

**Files:**
- Modify: `crates/app/src/drafts.rs` (append at end of file, before any `#[cfg(test)] mod tests`)
- Modify: `crates/app/src/lib.rs` (register handler in the `tauri::generate_handler!` macro list)

The preview pane needs the full body of the selected `.md`. Add a small command that reads the file with a size cap (so a pathological 50 MB file can't lock the UI). Return `{body, truncated}` so the frontend can show a "truncated" notice when applicable.

- [ ] **Step 1: Add the function + types to `crates/app/src/drafts.rs`**

Append at end of file (above `#[cfg(test)] mod tests` if present, otherwise just at end):

```rust
#[derive(Debug, serde::Serialize)]
pub struct SpecBody {
    pub body: String,
    pub truncated: bool,
}

/// Read a spec/plan markdown file with a hard byte cap so the preview
/// pane can't lock the UI on a pathological file. `max_bytes = 0` means
/// "use default" (200 KB).
pub fn read_spec_body_sync(path: &std::path::Path, max_bytes: usize) -> std::io::Result<SpecBody> {
    let cap = if max_bytes == 0 { 200 * 1024 } else { max_bytes };
    let bytes = std::fs::read(path)?;
    let truncated = bytes.len() > cap;
    let slice = if truncated { &bytes[..cap] } else { &bytes[..] };
    let body = String::from_utf8_lossy(slice).into_owned();
    Ok(SpecBody { body, truncated })
}

#[tauri::command]
pub async fn read_spec_body(path: String, max_bytes: Option<usize>) -> Result<SpecBody, String> {
    let p = std::path::PathBuf::from(&path);
    read_spec_body_sync(&p, max_bytes.unwrap_or(0)).map_err(|e| format!("{path}: {e}"))
}
```

- [ ] **Step 2: Add unit tests at the bottom of the existing `#[cfg(test)] mod tests` block in `drafts.rs`**

```rust
#[test]
fn read_spec_body_returns_full_content_under_cap() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("x.md");
    std::fs::write(&p, b"# Hello\n\nbody").unwrap();
    let r = super::read_spec_body_sync(&p, 0).unwrap();
    assert_eq!(r.body, "# Hello\n\nbody");
    assert!(!r.truncated);
}

#[test]
fn read_spec_body_truncates_over_cap() {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("big.md");
    std::fs::write(&p, vec![b'a'; 1024]).unwrap();
    let r = super::read_spec_body_sync(&p, 100).unwrap();
    assert_eq!(r.body.len(), 100);
    assert!(r.truncated);
}
```

If `tempfile` is not yet a dev-dep, check `crates/app/Cargo.toml` `[dev-dependencies]` — it should already be there for existing drafts tests. If not, add `tempfile = "3"` under `[dev-dependencies]`.

- [ ] **Step 3: Register the command in `crates/app/src/lib.rs`**

Find the `tauri::generate_handler![...]` invocation. Locate the line containing `drafts::list_published_specs` (added in spec 3.11). Add `drafts::read_spec_body` immediately after it (preserving comma).

- [ ] **Step 4: Run tests**

```bash
cargo test -p app drafts::tests::read_spec_body
```

Expected: 2 tests pass.

---

## Task 2: Frontend API wrapper for `read_spec_body`

**Files:**
- Modify: `ui/src/drafts/api.ts`

- [ ] **Step 1: Add the type + wrapper**

Locate the `draftsApi` object definition. Add:

```ts
export interface SpecBody {
  body: string;
  truncated: boolean;
}
```

Inside `draftsApi`, add a method:

```ts
  async readSpecBody(path: string, maxBytes?: number): Promise<SpecBody> {
    return invoke<SpecBody>("read_spec_body", { path, maxBytes: maxBytes ?? null });
  },
```

(Match the existing object's style for `invoke` import and method placement.)

- [ ] **Step 2: Verify type-check**

```bash
cd ui && pnpm tsc --noEmit
```

Expected: 0 errors. If tsc complains about the type of `invoke`, copy the pattern from the adjacent `listPublishedSpecs` method.

---

## Task 3: Markdown preview renderer (TDD)

**Files:**
- Create: `ui/src/mission/preview.ts`
- Create: `ui/src/mission/preview.test.ts`

The renderer is intentionally minimal — specs are well-formed markdown authored by us, not arbitrary input. Cover: ATX headings (#/##/###), paragraphs, unordered lists (`- ` and `* `), fenced code blocks (```), inline `code`, **bold**, *italic*. Everything else passes through as text. All output is HTML-escaped first, then markup is layered on top.

- [ ] **Step 1: Write the failing tests first**

Create `ui/src/mission/preview.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./preview";

describe("renderMarkdown", () => {
  it("renders headings", () => {
    expect(renderMarkdown("# Title\n## Sub")).toContain("<h1>Title</h1>");
    expect(renderMarkdown("# Title\n## Sub")).toContain("<h2>Sub</h2>");
  });

  it("escapes html in plain text", () => {
    const out = renderMarkdown("Hello <script>x</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders unordered lists", () => {
    const out = renderMarkdown("- one\n- two");
    expect(out).toContain("<ul>");
    expect(out).toContain("<li>one</li>");
    expect(out).toContain("<li>two</li>");
  });

  it("renders fenced code blocks without escaping inside the block tag", () => {
    const out = renderMarkdown("```\nfn main() {}\n```");
    expect(out).toContain("<pre><code>");
    expect(out).toContain("fn main() {}");
  });

  it("renders inline code, bold, italic", () => {
    expect(renderMarkdown("a `b` c")).toContain("<code>b</code>");
    expect(renderMarkdown("**bold**")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("*it*")).toContain("<em>it</em>");
  });

  it("groups blank-line-separated lines into paragraphs", () => {
    const out = renderMarkdown("first line\n\nsecond line");
    expect(out).toContain("<p>first line</p>");
    expect(out).toContain("<p>second line</p>");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ui && pnpm vitest run src/mission/preview.test.ts
```

Expected: FAIL ("Cannot find module './preview'").

- [ ] **Step 3: Implement `ui/src/mission/preview.ts`**

```ts
/// Minimal markdown → HTML for the mission preview pane. Specs are
/// authored by us, not user input — but we still HTML-escape every
/// segment before applying markup, defense-in-depth. Supports: ATX
/// headings (#/##/###), paragraphs, unordered lists (- or *), fenced
/// code (```), inline `code`, **bold**, *italic*. Anything else passes
/// through escaped.
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // skip closing fence (or eof)
      out.push(`<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // Headings.
    const h = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      out.push(`<h${level}>${inline(escapeHtml(h[2]!))}</h${level}>`);
      i++;
      continue;
    }

    // Unordered list — consume contiguous `- ` / `* ` lines.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) {
        const m = /^[-*]\s+(.*)$/.exec(lines[i]!)!;
        items.push(`<li>${inline(escapeHtml(m[1]!))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Blank line — paragraph separator.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — consume contiguous non-blank, non-special lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^```/.test(lines[i]!) &&
      !/^#{1,3}\s+/.test(lines[i]!) &&
      !/^[-*]\s+/.test(lines[i]!)
    ) {
      para.push(lines[i]!);
      i++;
    }
    out.push(`<p>${inline(escapeHtml(para.join(" ")))}</p>`);
  }

  return out.join("\n");
}

function inline(s: string): string {
  // Order matters: code first (so its contents are protected from bold/italic).
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ui && pnpm vitest run src/mission/preview.test.ts
```

Expected: 6 tests pass.

---

## Task 4: Pure-state helpers + tests for `MissionPage`

**Files:**
- Create: `ui/src/mission/page.test.ts` (tests first)
- Create: `ui/src/mission/page.ts` (initial scaffold + exported helpers — no DOM yet)

Extract the pure logic so it's unit-testable without JSDOM. Mirrors the pattern in `mission-picker.ts` (`effectivePath`, `canSubmit`, `selectCard`, `typeInput`).

- [ ] **Step 1: Write the failing tests**

Create `ui/src/mission/page.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  initialState,
  filterSpecs,
  selectCard,
  typeInput,
  effectivePath,
  canSubmit,
  navigate,
  type PageState,
} from "./page";

const specs = [
  { id: "3.10", title: "Mission Drafts", goal: "write specs", path: "/p/3.10.md" },
  { id: "3.11", title: "Mission Picker Integration", goal: "picker", path: "/p/3.11.md" },
  { id: "3.14", title: "Escalation Visibility", goal: "see escalations", path: "/p/3.14.md" },
];

function withSpecs(): PageState {
  return { ...initialState(null), specs, drafts: [], superpowers: [], loading: false };
}

describe("MissionPage state", () => {
  it("filterSpecs matches by id, title, and goal (case-insensitive)", () => {
    const s = withSpecs();
    expect(filterSpecs(s.specs, "3.11").map(x => x.id)).toEqual(["3.11"]);
    expect(filterSpecs(s.specs, "ESCAL").map(x => x.id)).toEqual(["3.14"]);
    expect(filterSpecs(s.specs, "specs").map(x => x.id)).toEqual(["3.10"]);
    expect(filterSpecs(s.specs, "").length).toBe(3);
  });

  it("selectCard sets selected and clears input", () => {
    const s = typeInput(withSpecs(), "/free/path.md");
    const next = selectCard(s, "/p/3.11.md");
    expect(next.selected).toEqual({ source: "card", path: "/p/3.11.md" });
    expect(next.inputValue).toBe("");
  });

  it("typeInput deselects any card and tracks input", () => {
    const s = selectCard(withSpecs(), "/p/3.10.md");
    const next = typeInput(s, "/free/path.md");
    expect(next.selected).toEqual({ source: "input", path: "/free/path.md" });
    expect(next.inputValue).toBe("/free/path.md");
  });

  it("canSubmit is false while loading and true with selection or input", () => {
    const loading = { ...withSpecs(), loading: true };
    expect(canSubmit(loading)).toBe(false);
    expect(canSubmit(withSpecs())).toBe(false);
    expect(canSubmit(selectCard(withSpecs(), "/p/3.10.md"))).toBe(true);
    expect(canSubmit(typeInput(withSpecs(), "/x.md"))).toBe(true);
  });

  it("effectivePath: card wins over input", () => {
    let s = typeInput(withSpecs(), "/free/path.md");
    s = selectCard(s, "/p/3.11.md");
    expect(effectivePath(s)).toBe("/p/3.11.md");
  });

  it("navigate cycles through filtered specs", () => {
    const s = withSpecs();
    const a = navigate(s, 1, s.specs);
    expect(a.selected?.path).toBe("/p/3.10.md");
    const b = navigate(a, 1, s.specs);
    expect(b.selected?.path).toBe("/p/3.11.md");
    const c = navigate(b, -1, s.specs);
    expect(c.selected?.path).toBe("/p/3.10.md");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ui && pnpm vitest run src/mission/page.test.ts
```

Expected: FAIL ("Cannot find module './page'").

- [ ] **Step 3: Create `ui/src/mission/page.ts` with the pure helpers (DOM impl arrives in later tasks)**

```ts
import type { DraftSummary, PublishedSpec } from "../drafts/api";
import type { SuperpowersMissionEntry } from "../api";

export type SelectedRef =
  | { source: "card"; path: string }
  | { source: "input"; path: string }
  | null;

export interface PageState {
  specs: PublishedSpec[];
  drafts: DraftSummary[];
  superpowers: SuperpowersMissionEntry[];
  selected: SelectedRef;
  inputValue: string;
  query: string;
  loading: boolean;
  error: string | null;
}

export function initialState(currentMissionPath: string | null): PageState {
  return {
    specs: [],
    drafts: [],
    superpowers: [],
    selected: currentMissionPath ? { source: "card", path: currentMissionPath } : null,
    inputValue: "",
    query: "",
    loading: true,
    error: null,
  };
}

export function filterSpecs(specs: PublishedSpec[], query: string): PublishedSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) return specs;
  return specs.filter(
    (s) =>
      s.id.toLowerCase().includes(q) ||
      s.title.toLowerCase().includes(q) ||
      s.goal.toLowerCase().includes(q),
  );
}

export function selectCard(s: PageState, path: string): PageState {
  return { ...s, selected: { source: "card", path }, inputValue: "" };
}

export function typeInput(s: PageState, value: string): PageState {
  const trimmed = value.trim();
  return {
    ...s,
    selected: trimmed.length > 0 ? { source: "input", path: trimmed } : null,
    inputValue: value,
  };
}

export function effectivePath(s: PageState): string | null {
  if (s.selected?.source === "card") return s.selected.path;
  const t = s.inputValue.trim();
  return t.length > 0 ? t : null;
}

export function canSubmit(s: PageState): boolean {
  if (s.loading) return false;
  return effectivePath(s) !== null;
}

export function navigate(
  s: PageState,
  delta: number,
  visibleSpecs: PublishedSpec[],
): PageState {
  if (visibleSpecs.length === 0) return s;
  const cur =
    s.selected?.source === "card"
      ? visibleSpecs.findIndex((x) => x.path === s.selected!.path)
      : -1;
  const next = ((cur + delta) + visibleSpecs.length) % visibleSpecs.length;
  return selectCard(s, visibleSpecs[next]!.path);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ui && pnpm vitest run src/mission/page.test.ts
```

Expected: 6 tests pass.

---

## Task 5: `MissionPage` class scaffold (open/close, mounted in HTML)

**Files:**
- Modify: `ui/index.html`
- Modify: `ui/src/mission/page.ts` (append the class)

Mirrors `DocsPanel`: takes a `pageHost` and the `workspace`, swaps visibility on open/close, fires `onClosed` so `main.ts` can refit the active terminal.

- [ ] **Step 1: Add the host element to `ui/index.html`**

Find the line `<section id="drafts-page" hidden></section>` and add directly below it:

```html
      <section id="mission-page" hidden></section>
```

- [ ] **Step 2: Append the `MissionPage` class to `ui/src/mission/page.ts`**

Add at the bottom of the file:

```ts
import { draftsApi } from "../drafts/api";
import { listSuperpowersMissions, type MissionRef } from "../api";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { renderMarkdown } from "./preview";
import { Icons } from "../icons";

export type PageResult =
  | { kind: "set"; path: string }
  | { kind: "setRef"; mref: MissionRef }
  | { kind: "publishDraft"; slug: string }
  | { kind: "spawnTab"; initialCommand: string }
  | { kind: "newSuperpowersMission" }
  | null;

export interface MissionPageOpts {
  repoRoot: string;
  currentMissionPath: string | null;
  onBrowse: () => Promise<string | null>;
}

export class MissionPage {
  private isOpenState = false;
  private state: PageState = initialState(null);
  private opts: MissionPageOpts | null = null;
  private resolve: ((r: PageResult) => void) | null = null;
  private unlistenSp: UnlistenFn | null = null;
  public onClosed: (() => void) | null = null;

  constructor(
    private readonly pageHost: HTMLElement,
    private readonly workspace: HTMLElement,
  ) {}

  isOpen(): boolean { return this.isOpenState; }

  open(opts: MissionPageOpts): Promise<PageResult> {
    if (this.isOpenState) {
      // Already open: cancel previous waiter, restart with new opts.
      this.finish(null);
    }
    this.opts = opts;
    this.state = initialState(opts.currentMissionPath);
    this.workspace.hidden = true;
    this.pageHost.hidden = false;
    this.isOpenState = true;

    const promise = new Promise<PageResult>((res) => { this.resolve = res; });
    this.render();
    void this.fetchAll();
    void this.subscribeSuperpowers();
    return promise;
  }

  close(): void { this.finish(null); }

  private finish(result: PageResult): void {
    if (!this.isOpenState) return;
    this.pageHost.innerHTML = "";
    this.pageHost.hidden = true;
    this.workspace.hidden = false;
    this.isOpenState = false;
    if (this.unlistenSp) { this.unlistenSp(); this.unlistenSp = null; }
    const r = this.resolve;
    this.resolve = null;
    if (r) r(result);
    if (this.onClosed) this.onClosed();
  }

  private setState(patch: Partial<PageState>): void {
    this.state = { ...this.state, ...patch };
    this.render();
  }

  private async fetchAll(): Promise<void> {
    if (!this.opts) return;
    const root = this.opts.repoRoot;
    try {
      const [specs, drafts, superpowers] = await Promise.all([
        draftsApi.listPublishedSpecs(root),
        draftsApi.list(root),
        listSuperpowersMissions(root).catch(() => []),
      ]);
      this.setState({ specs, drafts, superpowers, loading: false, error: null });
      // If a card matches currentMissionPath, preview it.
      const sel = this.state.selected;
      if (sel?.source === "card") void this.loadPreview(sel.path);
    } catch (err) {
      this.setState({ loading: false, error: String(err) });
    }
  }

  private async subscribeSuperpowers(): Promise<void> {
    if (!this.opts) return;
    const root = this.opts.repoRoot;
    try {
      this.unlistenSp = await listen("superpowers-missions-changed", () => {
        listSuperpowersMissions(root)
          .then((superpowers) => this.setState({ superpowers }))
          .catch(() => {});
      });
    } catch { /* ignore */ }
  }

  private previewBody = "";
  private previewPath = "";
  private previewLoading = false;
  private previewTruncated = false;
  private previewError: string | null = null;

  private async loadPreview(path: string): Promise<void> {
    this.previewPath = path;
    this.previewLoading = true;
    this.previewError = null;
    this.render();
    try {
      const r = await draftsApi.readSpecBody(path);
      // Race-guard: skip if user moved on to another card.
      if (this.previewPath !== path) return;
      this.previewBody = r.body;
      this.previewTruncated = r.truncated;
      this.previewLoading = false;
      this.render();
    } catch (err) {
      if (this.previewPath !== path) return;
      this.previewBody = "";
      this.previewError = String(err);
      this.previewLoading = false;
      this.render();
    }
  }

  // render() comes in Task 6.
  private render(): void {
    // Stub for now — Task 6 fills this in.
    this.pageHost.innerHTML = `<div class="mission-page-stub">loading…</div>`;
  }
}
```

- [ ] **Step 3: Verify type-check**

```bash
cd ui && pnpm tsc --noEmit
```

Expected: 0 errors.

---

## Task 6: Render sidebar + preview pane + footer

**Files:**
- Modify: `ui/src/mission/page.ts` (replace the `render()` stub)

- [ ] **Step 1: Replace the `render()` method body**

Locate the `private render()` method added in Task 5. Replace its entire body with:

```ts
  private render(): void {
    const s = this.state;
    const visible = filterSpecs(s.specs, s.query);
    this.pageHost.innerHTML = "";

    const header = document.createElement("header");
    header.className = "mission-page-header";
    header.innerHTML = `
      <h2 class="mission-page-title">Set mission</h2>
      <button type="button" class="mission-page-close" aria-label="Close" title="Close (Esc)">${Icons.x({ size: 14 })}</button>
    `;
    this.pageHost.appendChild(header);

    const body = document.createElement("div");
    body.className = "mission-page-body";
    this.pageHost.appendChild(body);

    body.appendChild(this.renderSidebar(visible));
    body.appendChild(this.renderPreview());

    const footer = document.createElement("footer");
    footer.className = "mission-page-footer";
    footer.innerHTML = `
      <button type="button" class="mission-page-cancel">Cancel</button>
      <button type="button" class="mission-page-submit" ${canSubmit(s) ? "" : "disabled"}>Set mission</button>
    `;
    this.pageHost.appendChild(footer);

    this.bindEvents(visible);
  }

  private renderSidebar(visible: PublishedSpec[]): HTMLElement {
    const s = this.state;
    const aside = document.createElement("aside");
    aside.className = "mission-page-sidebar";
    aside.innerHTML = `
      <div class="mission-page-search-row">
        <input type="search" class="mission-page-search" placeholder="Search specs…"
               autocomplete="off" spellcheck="false" value="${escapeAttr(s.query)}" />
      </div>
      ${this.renderError()}
      ${this.renderPublishedSection(visible)}
      ${this.renderSuperpowersSection()}
      ${this.renderDraftsSection()}
      ${this.renderPathRow()}
    `;
    return aside;
  }

  private renderError(): string {
    if (!this.state.error) return "";
    return `<div class="mission-page-error">
      Failed to load: ${escapeHtml(this.state.error)}
      <button type="button" class="mission-page-retry">Retry</button>
    </div>`;
  }

  private renderPublishedSection(visible: PublishedSpec[]): string {
    const s = this.state;
    if (s.loading) {
      return `<section class="mission-page-section">
        <h4>Published</h4>
        <div class="mission-page-skeleton">${"<div class=\"skel-row\"></div>".repeat(3)}</div>
      </section>`;
    }
    if (s.specs.length === 0) {
      return `<section class="mission-page-section">
        <h4>Published (0)</h4>
        <div class="mission-page-empty">
          No published specs yet. Write one in
          <button type="button" class="mission-page-link" data-action="open-drafts">Drafts (⌘⇧D)</button>.
        </div>
      </section>`;
    }
    if (visible.length === 0) {
      return `<section class="mission-page-section">
        <h4>Published (${s.specs.length})</h4>
        <div class="mission-page-empty">No matches for "${escapeHtml(s.query)}".</div>
      </section>`;
    }
    const cards = visible.map((spec) => {
      const isSelected = s.selected?.source === "card" && s.selected.path === spec.path;
      const isCurrent = spec.path === (this.opts?.currentMissionPath ?? null);
      return `
        <button type="button" class="mission-page-spec ${isSelected ? "selected" : ""}"
                data-path="${escapeAttr(spec.path)}">
          <span class="mission-page-id">${escapeHtml(spec.id)}</span>
          <span class="mission-page-spec-body">
            <span class="mission-page-spec-title">${escapeHtml(spec.title)}</span>
            <span class="mission-page-spec-goal">${escapeHtml(spec.goal)}</span>
          </span>
          ${isCurrent ? `<span class="mission-page-badge">current</span>` : ""}
        </button>
      `;
    }).join("");
    return `<section class="mission-page-section">
      <h4>Published (${visible.length}${visible.length !== s.specs.length ? `/${s.specs.length}` : ""})</h4>
      <div class="mission-page-list">${cards}</div>
    </section>`;
  }

  private renderSuperpowersSection(): string {
    const s = this.state;
    if (s.loading || s.superpowers.length === 0) return "";
    const items = s.superpowers.map((e) => {
      const planBadge = e.plan_path
        ? `<span class="mission-page-badge mission-page-badge--ok">plan ✓</span>`
        : `<button type="button" class="mission-page-badge mission-page-badge--missing mission-page-plan-missing"
                   data-spec="${escapeAttr(e.spec_path)}"
                   title="Generate plan with writing-plans skill">plan ✗</button>`;
      return `
        <button type="button" class="mission-page-sp-row"
                data-spec="${escapeAttr(e.spec_path)}"
                data-plan="${escapeAttr(e.plan_path ?? "")}">
          <span class="mission-page-spec-title">${escapeHtml(e.spec_filename)}</span>
          <span class="mission-page-spec-goal">${escapeHtml(e.goal_preview)}</span>
          <span class="mission-page-badge mission-page-badge--ok">spec ✓</span>
          ${planBadge}
        </button>
      `;
    }).join("");
    return `<section class="mission-page-section">
      <div class="mission-page-section-head">
        <h4>Superpowers (${s.superpowers.length})</h4>
        <button type="button" class="mission-page-sp-new" data-action="sp-new">+ New Superpowers mission</button>
      </div>
      <div class="mission-page-list">${items}</div>
    </section>`;
  }

  private renderDraftsSection(): string {
    const s = this.state;
    if (s.drafts.length === 0) return "";
    const items = s.drafts.map((d) => `
      <div class="mission-page-draft" data-slug="${escapeAttr(d.slug)}">
        <span class="mission-page-spec-title">${escapeHtml(d.title)}</span>
        <button type="button" class="mission-page-publish" data-slug="${escapeAttr(d.slug)}">Publish to use</button>
      </div>
    `).join("");
    return `<details class="mission-page-section mission-page-drafts">
      <summary>Drafts (${s.drafts.length})</summary>
      <div class="mission-page-list">${items}</div>
    </details>`;
  }

  private renderPathRow(): string {
    const s = this.state;
    return `
      <section class="mission-page-section mission-page-pathrow">
        <h4>Or pick another file…</h4>
        <div class="mission-page-path-controls">
          <input type="text" class="mission-page-input"
                 autocomplete="off" spellcheck="false"
                 placeholder="/absolute/path/to/spec.md"
                 value="${escapeAttr(s.inputValue)}" />
          <button type="button" class="mission-page-browse">Browse…</button>
        </div>
      </section>
    `;
  }

  private renderPreview(): HTMLElement {
    const main = document.createElement("main");
    main.className = "mission-page-preview";
    if (!this.previewPath) {
      main.innerHTML = `<div class="mission-page-preview-empty">Select a spec on the left to preview.</div>`;
      return main;
    }
    if (this.previewLoading) {
      main.innerHTML = `<div class="mission-page-preview-empty">Loading…</div>`;
      return main;
    }
    if (this.previewError) {
      main.innerHTML = `<div class="mission-page-preview-empty">File not found — will be set as path-only mission.</div>`;
      return main;
    }
    const truncatedNote = this.previewTruncated
      ? `<div class="mission-page-preview-truncated">⚠ Truncated (file > 200 KB)</div>`
      : "";
    main.innerHTML = `${truncatedNote}<article class="mission-page-preview-body">${renderMarkdown(this.previewBody)}</article>`;
    return main;
  }
```

Also add helpers at the bottom of the file (outside the class):

```ts
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}
function escapeAttr(s: string): string { return escapeHtml(s); }
```

- [ ] **Step 2: Verify type-check**

```bash
cd ui && pnpm tsc --noEmit
```

Expected: 0 errors. (Note: `bindEvents` is referenced but not yet defined — it lands in Task 7. If tsc errors here, add a temporary `private bindEvents(_v: PublishedSpec[]) {}` stub.)

---

## Task 7: Bind events (selection, search, keyboard, footer)

**Files:**
- Modify: `ui/src/mission/page.ts`

- [ ] **Step 1: Add `bindEvents` and the keyboard handler to the class**

Inside the class (after the render helpers, before the closing brace), add:

```ts
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  private bindEvents(visible: PublishedSpec[]): void {
    const host = this.pageHost;

    host.querySelector(".mission-page-close")?.addEventListener("click", () => this.finish(null));
    host.querySelector(".mission-page-cancel")?.addEventListener("click", () => this.finish(null));
    host.querySelector(".mission-page-submit")?.addEventListener("click", () => this.submit());
    host.querySelector(".mission-page-retry")?.addEventListener("click", () => {
      this.setState({ loading: true, error: null });
      void this.fetchAll();
    });

    const search = host.querySelector<HTMLInputElement>(".mission-page-search");
    if (search) {
      search.addEventListener("input", () => {
        this.state = { ...this.state, query: search.value };
        this.render();
      });
    }

    host.querySelectorAll<HTMLButtonElement>(".mission-page-spec").forEach((btn) => {
      const path = btn.dataset.path!;
      btn.addEventListener("click", () => {
        this.state = selectCard(this.state, path);
        void this.loadPreview(path);
        this.render();
      });
      btn.addEventListener("dblclick", () => {
        this.state = selectCard(this.state, path);
        this.submit();
      });
    });

    host.querySelectorAll<HTMLButtonElement>(".mission-page-sp-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        const specPath = btn.dataset.spec ?? "";
        const planPath = btn.dataset.plan ?? "";
        if (!specPath) return;
        this.finish({
          kind: "setRef",
          mref: {
            kind: "superpowers",
            spec_path: specPath,
            plan_path: planPath.length > 0 ? planPath : null,
          },
        });
      });
    });

    host.querySelectorAll<HTMLButtonElement>(".mission-page-plan-missing").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const specPath = btn.dataset.spec ?? "";
        if (!specPath) return;
        this.finish({
          kind: "spawnTab",
          initialCommand: `Use the writing-plans skill to create the plan for ${specPath}`,
        });
      });
    });

    host.querySelector<HTMLButtonElement>('[data-action="sp-new"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.finish({ kind: "newSuperpowersMission" });
    });

    host.querySelectorAll<HTMLButtonElement>(".mission-page-publish").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const slug = btn.dataset.slug!;
        this.finish({ kind: "publishDraft", slug });
      });
    });

    const input = host.querySelector<HTMLInputElement>(".mission-page-input");
    if (input) {
      input.addEventListener("input", () => {
        this.state = typeInput(this.state, input.value);
        this.render();
      });
    }

    host.querySelector(".mission-page-browse")?.addEventListener("click", async () => {
      if (!this.opts) return;
      const picked = await this.opts.onBrowse();
      if (picked) {
        this.state = typeInput(this.state, picked);
        this.render();
      }
    });

    host.querySelector('[data-action="open-drafts"]')?.addEventListener("click", () => {
      this.finish(null);
      window.dispatchEvent(new CustomEvent("drafts:toggle"));
    });

    // (Re)install the global key handler so `visible` is captured fresh.
    if (this.keyHandler) window.removeEventListener("keydown", this.keyHandler);
    this.keyHandler = (e: KeyboardEvent) => {
      if (!this.isOpenState) return;
      if (e.key === "Escape") { e.preventDefault(); this.finish(null); return; }
      if (e.key === "Enter" && canSubmit(this.state)) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        // Don't hijack Enter inside the path text input — let user paste/edit freely.
        if (tag === "INPUT") return;
        e.preventDefault();
        this.submit();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = navigate(this.state, e.key === "ArrowDown" ? 1 : -1, visible);
        this.state = next;
        if (next.selected?.source === "card") void this.loadPreview(next.selected.path);
        this.render();
        return;
      }
      if (e.metaKey && !e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        host.querySelector<HTMLInputElement>(".mission-page-search")?.focus();
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        const active = document.activeElement;
        if (!active || !active.classList.contains("mission-page-input")) {
          e.preventDefault();
          host.querySelector<HTMLInputElement>(".mission-page-input")?.focus();
        }
      }
    };
    window.addEventListener("keydown", this.keyHandler);
  }

  private submit(): void {
    const p = effectivePath(this.state);
    if (!p) return;
    this.finish({ kind: "set", path: p });
  }
```

Also extend `finish()` to clean up the key handler. Locate the existing `finish(result: PageResult)` body and add at the top (right after the `if (!this.isOpenState) return;` guard):

```ts
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler);
      this.keyHandler = null;
    }
```

- [ ] **Step 2: Verify type-check + tests**

```bash
cd ui && pnpm tsc --noEmit && pnpm vitest run src/mission/
```

Expected: 0 tsc errors. All 12 tests (6 preview + 6 page) pass.

---

## Task 8: Move `openNewSuperpowersTopicModal` into `mission/page.ts`

**Files:**
- Modify: `ui/src/mission/page.ts` (append)

The old `mission-picker.ts` exported this helper alongside the picker. Since the file is being deleted, move the helper here unchanged so `tabs/manager.ts` can re-import it from `../mission/page`.

- [ ] **Step 1: Append at the bottom of `ui/src/mission/page.ts`**

```ts
export function openNewSuperpowersTopicModal(): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "mission-page-newmodal";
    modal.innerHTML = `
      <h4>New Superpowers mission</h4>
      <label>Topic <input type="text" id="sp-topic" placeholder="what do you want to brainstorm?" /></label>
      <div class="mission-page-newmodal-actions">
        <button type="button" id="sp-cancel">Cancel</button>
        <button type="button" id="sp-create">Create tab</button>
      </div>
    `;
    document.body.appendChild(modal);
    const input = modal.querySelector<HTMLInputElement>("#sp-topic")!;
    input.focus();
    const close = (val: string | null): void => { modal.remove(); resolve(val); };
    modal.querySelector<HTMLButtonElement>("#sp-cancel")!.addEventListener("click", () => close(null));
    modal.querySelector<HTMLButtonElement>("#sp-create")!.addEventListener("click", () => {
      const v = input.value.trim();
      close(v || null);
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); close(input.value.trim() || null); }
      else if (ev.key === "Escape") { ev.preventDefault(); close(null); }
    });
  });
}
```

(CSS class `mission-page-newmodal` is added in Task 10.)

---

## Task 9: Wire `MissionPage` from `main.ts` and `manager.ts`

**Files:**
- Modify: `ui/src/main.ts`
- Modify: `ui/src/tabs/manager.ts`

- [ ] **Step 1: Mount `MissionPage` in `main.ts`**

Near the existing `DocsPanel` / `DraftsPanel` instantiation (around line 386-404), add:

```ts
  const missionPage = requireEl<HTMLElement>("mission-page");
  const missionPanel = new MissionPage(missionPage, workspace);
  missionPanel.onClosed = () => { manager.refitActive(); };
  manager.setMissionPicker((opts) => missionPanel.open(opts));
```

Add the import at the top of the file:

```ts
import { MissionPage } from "./mission/page";
```

- [ ] **Step 2: Add ⌘M binding in the keydown handler**

Locate the existing `⌘⇧M → Convergence Mode` block in `main.ts` (around line 574). Add **immediately above it** (the no-shift variant must be tested first because shift+M would otherwise also pass `key === "m"`):

```ts
    // ⌘M → mission picker page (toggle).
    if (e.metaKey && !e.shiftKey && (e.key === "M" || e.key === "m")) {
      e.preventDefault();
      if (missionPanel.isOpen()) {
        missionPanel.close();
      } else {
        if (settings.isOpen()) await settings.close();
        if (docsPanel.isOpen()) docsPanel.close();
        if (draftsPanel.isOpen()) draftsPanel.close();
        void manager.openMissionForActive();
      }
      return;
    }
```

(Note: if the surrounding handler is not `async`, change `await settings.close()` to `void settings.close();` — match the existing close-others style in the ⌘, handler.)

- [ ] **Step 3: Update `tabs/manager.ts` to use the injected picker**

Find at the top of the file:

```ts
import { openMissionPicker, openNewSuperpowersTopicModal } from "./mission-picker";
```

Replace with:

```ts
import { openNewSuperpowersTopicModal, type MissionPageOpts, type PageResult } from "../mission/page";
```

Add a private field + setter to `TabManager` (locate other private fields near the top of the class):

```ts
  private missionPicker: ((opts: MissionPageOpts) => Promise<PageResult>) | null = null;

  setMissionPicker(fn: (opts: MissionPageOpts) => Promise<PageResult>): void {
    this.missionPicker = fn;
  }
```

In `promptAndSetMission` (around line 1606-1626), replace the `const result = await openMissionPicker({...})` block with:

```ts
    if (!this.missionPicker) return;
    const result = await this.missionPicker({
      repoRoot,
      currentMissionPath: tab.mission?.path ?? null,
      onBrowse: async () => {
        const start =
          tab.mission?.path ??
          (tab.cwd ? `${tab.cwd}/docs/specs` : undefined);
        const picked = await openDialog({
          title: "Pick mission spec",
          multiple: false,
          directory: false,
          defaultPath: start,
          filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
        });
        return typeof picked === "string" ? picked : null;
      },
    });
```

Add a public `openMissionForActive` method on `TabManager` that the ⌘M handler calls (locate near the existing `setMissionPathForActiveTab`):

```ts
  /// Public entry point for ⌘M. Opens the mission page for the active tab.
  async openMissionForActive(): Promise<void> {
    if (!this.activeId) return;
    await this.promptAndSetMission(this.activeId);
  }
```

If `promptAndSetMission` is currently `private`, leave it private — `openMissionForActive` is the public wrapper.

- [ ] **Step 4: Type-check + frontend tests**

```bash
cd ui && pnpm tsc --noEmit && pnpm vitest run
```

Expected: 0 tsc errors, all tests pass.

---

## Task 10: CSS for `#mission-page`

**Files:**
- Modify: `ui/src/styles.css`

Append a new section at the end of the file. Reuse tokens (`--fg`, etc.) and copy patterns from `#drafts-page` and `.docs-page-header` for visual consistency.

- [ ] **Step 1: Append to `ui/src/styles.css`**

```css
/* ---- Mission picker page (3.15) ---- */
#mission-page {
  display: grid;
  grid-template-rows: 56px 1fr 56px;
  background: rgb(11 13 16 / 0.92);
  color: var(--fg);
  overflow: hidden;
  animation: settings-fade 0.12s ease-out;
}
#mission-page[hidden] { display: none; }

.mission-page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  border-bottom: 1px solid rgb(255 255 255 / 0.06);
}
.mission-page-title { margin: 0; font-size: 14px; font-weight: 600; }
.mission-page-close {
  background: none; border: 0; color: var(--fg-dim);
  cursor: pointer; padding: 6px; border-radius: 4px;
}
.mission-page-close:hover { background: rgb(255 255 255 / 0.05); color: var(--fg); }

.mission-page-body {
  display: grid;
  grid-template-columns: 360px 1fr;
  overflow: hidden;
  min-height: 0;
}

.mission-page-sidebar {
  border-right: 1px solid rgb(255 255 255 / 0.06);
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.mission-page-search-row { position: sticky; top: 0; background: rgb(11 13 16 / 0.96); padding-bottom: 8px; z-index: 1; }
.mission-page-search {
  width: 100%;
  background: rgb(255 255 255 / 0.04);
  border: 1px solid rgb(255 255 255 / 0.08);
  color: var(--fg);
  padding: 6px 10px;
  border-radius: 6px;
  font: inherit;
}
.mission-page-search:focus { outline: 2px solid rgb(120 140 255 / 0.4); outline-offset: 0; }

.mission-page-section h4 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-dim);
  margin: 0 0 6px 0;
}
.mission-page-section-head { display: flex; align-items: center; justify-content: space-between; }
.mission-page-list { display: flex; flex-direction: column; gap: 4px; }

.mission-page-spec, .mission-page-sp-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: center;
  background: rgb(255 255 255 / 0.02);
  border: 1px solid transparent;
  color: var(--fg);
  padding: 8px 10px;
  border-radius: 6px;
  text-align: left;
  cursor: pointer;
  font: inherit;
}
.mission-page-spec:hover, .mission-page-sp-row:hover { background: rgb(255 255 255 / 0.05); }
.mission-page-spec.selected { border-color: rgb(120 140 255 / 0.6); background: rgb(120 140 255 / 0.08); }
.mission-page-id { font-family: var(--mono); font-size: 11px; color: var(--fg-dim); min-width: 36px; }
.mission-page-spec-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.mission-page-spec-title { font-weight: 600; font-size: 13px; }
.mission-page-spec-goal { font-size: 11px; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.mission-page-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 999px;
  border: 1px solid rgb(255 255 255 / 0.1);
  color: var(--fg-dim);
}
.mission-page-badge--ok { color: rgb(140 220 160); border-color: rgb(140 220 160 / 0.3); }
.mission-page-badge--missing { color: rgb(220 140 140); border-color: rgb(220 140 140 / 0.3); cursor: pointer; background: none; }

.mission-page-sp-new {
  background: none; border: 0; color: rgb(120 160 255);
  cursor: pointer; padding: 0; font: inherit; font-size: 11px;
}
.mission-page-sp-new:hover { text-decoration: underline; }

.mission-page-empty { font-size: 12px; color: var(--fg-dim); padding: 8px 4px; }
.mission-page-link { background: none; border: 0; color: rgb(120 160 255); cursor: pointer; font: inherit; padding: 0; }
.mission-page-link:hover { text-decoration: underline; }

.mission-page-error {
  background: rgb(220 140 140 / 0.08);
  border: 1px solid rgb(220 140 140 / 0.3);
  color: rgb(240 180 180);
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.mission-page-retry { background: none; border: 1px solid currentColor; color: inherit; padding: 2px 8px; border-radius: 4px; cursor: pointer; }

.mission-page-skeleton .skel-row {
  height: 36px; margin-bottom: 4px;
  background: linear-gradient(90deg, rgb(255 255 255 / 0.04), rgb(255 255 255 / 0.08), rgb(255 255 255 / 0.04));
  background-size: 200% 100%;
  animation: settings-shimmer 1.2s ease-in-out infinite;
  border-radius: 6px;
}
@keyframes settings-shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }

.mission-page-drafts summary { cursor: pointer; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg-dim); }
.mission-page-draft { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; }
.mission-page-publish { background: none; border: 1px solid rgb(255 255 255 / 0.15); color: var(--fg); padding: 2px 8px; border-radius: 4px; cursor: pointer; font: inherit; font-size: 11px; }

.mission-page-pathrow .mission-page-path-controls { display: flex; gap: 6px; }
.mission-page-input {
  flex: 1; background: rgb(255 255 255 / 0.04); border: 1px solid rgb(255 255 255 / 0.08);
  color: var(--fg); padding: 6px 8px; border-radius: 6px; font: inherit; font-family: var(--mono); font-size: 12px;
}
.mission-page-browse { background: rgb(255 255 255 / 0.06); border: 1px solid rgb(255 255 255 / 0.1); color: var(--fg); padding: 6px 10px; border-radius: 6px; cursor: pointer; font: inherit; font-size: 12px; }

.mission-page-preview {
  overflow-y: auto;
  padding: 24px 32px;
}
.mission-page-preview-empty { color: var(--fg-dim); font-style: italic; padding: 40px 0; text-align: center; }
.mission-page-preview-truncated { color: rgb(220 200 140); font-size: 11px; margin-bottom: 12px; }
.mission-page-preview-body h1 { font-size: 18px; margin: 0 0 12px 0; }
.mission-page-preview-body h2 { font-size: 15px; margin: 18px 0 8px 0; color: var(--fg-dim); }
.mission-page-preview-body h3 { font-size: 13px; margin: 14px 0 6px 0; color: var(--fg-dim); }
.mission-page-preview-body p { margin: 0 0 10px 0; line-height: 1.5; }
.mission-page-preview-body ul { padding-left: 20px; margin: 0 0 10px 0; }
.mission-page-preview-body li { margin: 2px 0; }
.mission-page-preview-body code { font-family: var(--mono); font-size: 12px; background: rgb(255 255 255 / 0.06); padding: 1px 4px; border-radius: 3px; }
.mission-page-preview-body pre { background: rgb(0 0 0 / 0.3); border: 1px solid rgb(255 255 255 / 0.06); padding: 10px 12px; border-radius: 6px; overflow-x: auto; }
.mission-page-preview-body pre code { background: none; padding: 0; }

.mission-page-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  align-items: center;
  padding: 0 20px;
  border-top: 1px solid rgb(255 255 255 / 0.06);
}
.mission-page-cancel { background: none; border: 1px solid rgb(255 255 255 / 0.15); color: var(--fg); padding: 6px 14px; border-radius: 6px; cursor: pointer; font: inherit; }
.mission-page-submit { background: rgb(120 140 255); border: 0; color: white; padding: 6px 14px; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 600; }
.mission-page-submit:disabled { opacity: 0.4; cursor: not-allowed; }

/* "+ New Superpowers mission" topic prompt — body-level modal that
   pops after the page closes (kept for parity with the old picker). */
.mission-page-newmodal {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  background: rgb(20 22 26); border: 1px solid rgb(255 255 255 / 0.1);
  border-radius: 8px; padding: 20px; z-index: 1000;
  display: flex; flex-direction: column; gap: 12px; min-width: 380px;
  box-shadow: 0 12px 40px rgb(0 0 0 / 0.5);
}
.mission-page-newmodal h4 { margin: 0; }
.mission-page-newmodal label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--fg-dim); }
.mission-page-newmodal input { background: rgb(255 255 255 / 0.05); border: 1px solid rgb(255 255 255 / 0.1); color: var(--fg); padding: 6px 8px; border-radius: 4px; font: inherit; }
.mission-page-newmodal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.mission-page-newmodal-actions button { background: rgb(255 255 255 / 0.06); border: 1px solid rgb(255 255 255 / 0.1); color: var(--fg); padding: 6px 12px; border-radius: 4px; cursor: pointer; font: inherit; }
.mission-page-newmodal-actions #sp-create { background: rgb(120 140 255); border-color: transparent; color: white; }
```

---

## Task 11: Delete the old modal

**Files:**
- Delete: `ui/src/tabs/mission-picker.ts`
- Delete: `ui/src/tabs/mission-picker.test.ts`

- [ ] **Step 1: Verify nothing else imports `mission-picker`**

```bash
grep -rn "tabs/mission-picker\|from \"\./mission-picker\"" ui/src
```

Expected: zero matches (Task 9 removed the only callsite). If anything turns up, fix it before deleting.

- [ ] **Step 2: Delete the files**

```bash
rm ui/src/tabs/mission-picker.ts ui/src/tabs/mission-picker.test.ts
```

- [ ] **Step 3: Also delete the now-unused CSS classes from styles.css**

```bash
grep -n "mission-picker" ui/src/styles.css | head
```

For each class prefixed `.mission-picker-*` (and any selectors using them), delete the entire rule block. They are exclusive to the old modal — `mission-page-*` classes added in Task 10 cover the page version.

- [ ] **Step 4: Re-run all checks**

```bash
cd ui && pnpm tsc --noEmit && pnpm vitest run
cargo test -p app
```

Expected: 0 tsc errors, all frontend tests pass, all backend tests pass.

---

## Task 12: Manual verification + single consolidated commit

Per CLAUDE.md (no test runner for UI features) and the user's commit-granularity preference, finish with one manual smoke test and one commit.

- [ ] **Step 1: Build + run the app**

```bash
cd ui && pnpm tauri dev
```

- [ ] **Step 2: Smoke test (golden path + edge cases)**

In the running app, verify each:

1. Click the statusbar "Set mission" — `#mission-page` opens (workspace hidden, tabbar still visible).
2. Press `⌘M` while on workspace — page opens. Press `⌘M` again — page closes (toggle).
3. Type in search box — Published list filters by ID/title/goal; "0 matches" empty state shows when nothing matches.
4. Click a Published spec — preview pane on the right renders the markdown (headings, lists, code blocks).
5. Press `↓` / `↑` — navigates Published cards; preview updates with selection.
6. Double-click a card — page closes, mission is set on active tab (verify in statusbar).
7. Open a draft → click "Publish to use" — page closes, drafts panel opens with the wizard auto-publishing.
8. Click "+ New Superpowers mission" — page closes, topic prompt appears, creates a new tab.
9. Click `plan ✗` on a Superpowers row — page closes, new tab spawns running the writing-plans skill prompt.
10. Type a path in "or pick another file" — Set mission button enables; click it — mission is set with that path.
11. Click Browse — native file dialog opens; pick a `.md`, page submits.
12. Press `Esc` — page closes without setting mission. Press `⌘F` — search box gets focus.
13. With settings (`⌘,`) or docs (`⌘?`) open, press `⌘M` — those close, mission page opens (mutual exclusion).
14. Open the page on a tab that has a current mission — that card shows the `current` badge and is pre-selected; preview shows its body.

If any check fails, fix and re-verify before committing. State explicitly which checks passed and which couldn't be verified (e.g. "Browse dialog: not tested — no native dialog in dev environment").

- [ ] **Step 3: Stage + commit (single feat)**

```bash
git add crates/app/src/drafts.rs crates/app/src/lib.rs \
        ui/src/drafts/api.ts \
        ui/src/mission/ \
        ui/index.html \
        ui/src/main.ts \
        ui/src/tabs/manager.ts \
        ui/src/styles.css \
        docs/specs/3.15-mission-picker-page.md \
        docs/superpowers/plans/2026-05-04-mission-picker-page.md

git rm ui/src/tabs/mission-picker.ts ui/src/tabs/mission-picker.test.ts

git commit -m "$(cat <<'EOF'
feat(mission): promote Set Mission modal to full page (3.15)

Replaces the cramped picker modal with #mission-page (sidebar + preview
pane), search across published specs, ⌘M binding, and a small
markdown renderer. Adds read_spec_body Tauri command for the preview.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Verify commit**

```bash
git status
git log -1 --stat
```

Expected: clean working tree; commit shows the new files + deletions.

---

## Self-review checklist (already applied by author)

- **Spec coverage:** Each acceptance criterion in `docs/specs/3.15-mission-picker-page.md` maps to a task — search (T6/T7), preview pane (T3/T6), keyboard nav (T7), `current` badge (T6), empty/error states (T6), parallel fetch + skeleton (T5), modal deleted (T11), `⌘M` toggle (T9), settings/docs/drafts mutual exclusion (T9). Tests (T3, T4) cover renderer + state helpers per spec.
- **Placeholders:** none — every code step shows the code.
- **Type consistency:** `PageState`, `PageResult`, `MissionPageOpts` are introduced in T4/T5 and referenced consistently in T7/T8/T9. `read_spec_body` signature (`path: String, max_bytes: Option<usize>`) is the same on backend (T1) and frontend (T2). The picker callback contract preserves the modal's old `PickerResult` variant names (`set` / `setRef` / `publishDraft` / `spawnTab` / `newSuperpowersMission`) so `manager.ts` doesn't have to change its branch logic.
- **Open question deferred:** "Spec | Plan" toggle when both exist — left as a future iteration; v1 always previews `spec_path` (the `read_spec_body` command works for either, so adding the toggle is purely UI).
