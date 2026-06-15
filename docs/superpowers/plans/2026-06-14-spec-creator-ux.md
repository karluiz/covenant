# Spec Creator UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three Spec Creator UX defects — section chips unmarked on resume, read-only sections, and raw `<!--section:-->` markers leaking into the chat prose.

**Architecture:** Frontend-heavy work in `ui/src/spec-chat/`. A new shared `sections.ts` util becomes the single source of truth for the section list and adds a markdown→sections parser. `stream-state` rebuilds its section map on `hydrate` and gains an `editSection` mutator. `live-spec` renders a persistent `done` state on the nav and makes section bodies `contentEditable`, persisting edits via one new trivial Rust command. A new `prose.ts` util turns section markers into inline chips.

**Tech Stack:** TypeScript + Vite + vitest (jsdom for DOM tests); Rust + Tauri commands. No new dependencies.

---

## File Structure

- **Create** `ui/src/spec-chat/sections.ts` — canonical `SECTIONS` list + `titleForKey`/`keyForTitle` + `parseSectionsFromMarkdown`. One responsibility: section identity & markdown parsing.
- **Create** `ui/src/spec-chat/prose.ts` — `renderProse(text)`: escapes prose and replaces section markers with inline chips.
- **Modify** `ui/src/spec-chat/stream-state.ts` — `hydrate` seeds the section map from markdown; new `editSection`; rebuild markdown helper.
- **Modify** `ui/src/spec-chat/live-spec.ts` — import shared SECTIONS; persistent nav `.done`; `contentEditable` bodies + anti-clobber guard + `onPersist` callback.
- **Modify** `ui/src/spec-chat/entrance.ts` — drop local `SECTION_TITLES`, derive from shared SECTIONS.
- **Modify** `ui/src/spec-chat/activity-stream.ts` — render committed + live prose via `renderProse`.
- **Modify** `ui/src/spec-chat/immersive.ts` — hydrate with `partial_md` always; wire `onPersist`.
- **Modify** `ui/src/spec-chat/immersive.css` — `.node.done` + editable `.content` styles + `.sec-chip`.
- **Modify** `ui/src/api.ts` — `specAuthorSaveMarkdown` wrapper.
- **Modify** `crates/agent/src/spec_author.rs` — `save_markdown` / `save_markdown_default`.
- **Modify** `crates/app/src/lib.rs` — `spec_author_save_markdown` command + register.

---

## Task 1: Shared `sections.ts` util

**Files:**
- Create: `ui/src/spec-chat/sections.ts`
- Test: `ui/src/spec-chat/sections.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/spec-chat/sections.test.ts
import { describe, it, expect } from 'vitest';
import { SECTIONS, titleForKey, keyForTitle, parseSectionsFromMarkdown } from './sections';

describe('sections util', () => {
  it('exposes the six canonical sections in order', () => {
    expect(SECTIONS.map((s) => s.key)).toEqual([
      'goal', 'out_of_scope', 'acceptance', 'file_boundaries', 'complexity', 'open_questions',
    ]);
  });

  it('round-trips key <-> title (case-insensitive on title)', () => {
    expect(titleForKey('goal')).toBe('Goal');
    expect(keyForTitle('Goal')).toBe('goal');
    expect(keyForTitle('out of scope')).toBe('out_of_scope');
    expect(keyForTitle('Nonsense')).toBeNull();
  });

  it('parses a full spec markdown into per-section bodies (status done)', () => {
    const md = [
      '## Goal', '', 'Build the thing.', '',
      '## Out of scope', '', 'Not this.', '',
      '## Acceptance criteria', '', '- works', '',
    ].join('\n');
    const map = parseSectionsFromMarkdown(md);
    expect(map.get('goal')).toEqual({ markdown: 'Build the thing.', status: 'done' });
    expect(map.get('out_of_scope')).toEqual({ markdown: 'Not this.', status: 'done' });
    expect(map.get('acceptance')).toEqual({ markdown: '- works', status: 'done' });
    expect(map.has('complexity')).toBe(false);
  });

  it('returns an empty map for null/empty markdown', () => {
    expect(parseSectionsFromMarkdown(null).size).toBe(0);
    expect(parseSectionsFromMarkdown('').size).toBe(0);
  });

  it('ignores unknown ## headers without crashing', () => {
    const map = parseSectionsFromMarkdown('## Random\nx\n## Goal\ny');
    expect(map.has('goal')).toBe(true);
    expect(map.get('goal')!.markdown).toBe('y');
    expect(map.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/spec-chat/sections.test.ts`
Expected: FAIL — cannot find module `./sections`.

- [ ] **Step 3: Write the implementation**

```ts
// ui/src/spec-chat/sections.ts
import type { SpecSectionKey } from './events';
import type { SectionView } from './stream-state';

/** Single source of truth for the spec section list + display titles. */
export const SECTIONS: { key: SpecSectionKey; title: string }[] = [
  { key: 'goal', title: 'Goal' },
  { key: 'out_of_scope', title: 'Out of scope' },
  { key: 'acceptance', title: 'Acceptance criteria' },
  { key: 'file_boundaries', title: 'File boundaries' },
  { key: 'complexity', title: 'Complexity' },
  { key: 'open_questions', title: 'Open questions' },
];

export function titleForKey(key: SpecSectionKey): string {
  return SECTIONS.find((s) => s.key === key)?.title ?? key;
}

export function keyForTitle(title: string): SpecSectionKey | null {
  const t = title.trim().toLowerCase();
  return SECTIONS.find((s) => s.title.toLowerCase() === t)?.key ?? null;
}

/** Split a spec markdown body on `## <Title>` headers into per-section bodies.
 *  Only known section titles are kept; unknown headers are skipped. Every
 *  parsed section is marked `done` (its header is present on disk). */
export function parseSectionsFromMarkdown(md: string | null): Map<SpecSectionKey, SectionView> {
  const map = new Map<SpecSectionKey, SectionView>();
  if (!md) return map;
  let curKey: SpecSectionKey | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (curKey) map.set(curKey, { markdown: buf.join('\n').trim(), status: 'done' });
  };
  for (const line of md.split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      curKey = keyForTitle(m[1]);
      buf = [];
    } else if (curKey) {
      buf.push(line);
    }
  }
  flush();
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/spec-chat/sections.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/spec-chat/sections.ts ui/src/spec-chat/sections.test.ts
git commit -m "feat(spec): shared sections util with markdown parser"
```

---

## Task 2: `stream-state` — hydrate seeds sections + `editSection`

**Files:**
- Modify: `ui/src/spec-chat/stream-state.ts`
- Test: `ui/src/spec-chat/stream-state.test.ts`

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe`)

```ts
  it('hydrate with markdown rebuilds the section map (status done)', () => {
    const s = createStreamState();
    s.hydrate({ messages: [], markdown: '## Goal\n\nBuild it.\n\n## Complexity\n\nLow.' });
    expect(s.section('goal')).toEqual({ markdown: 'Build it.', status: 'done' });
    expect(s.section('complexity')).toEqual({ markdown: 'Low.', status: 'done' });
    expect(s.section('acceptance')).toBeNull();
  });

  it('editSection updates the map and returns rebuilt canonical markdown', () => {
    const s = createStreamState();
    s.apply({ kind: 'section_update', section: 'goal', markdown: 'old', status: 'done' });
    const rebuilt = s.editSection('goal', 'new goal text');
    expect(s.section('goal')).toEqual({ markdown: 'new goal text', status: 'done' });
    expect(rebuilt).toBe('## Goal\n\nnew goal text');
  });

  it('editSection rebuilds finalMarkdown when a final already exists', () => {
    const s = createStreamState();
    s.apply({ kind: 'final', markdown: '## Goal\n\nold' });
    s.apply({ kind: 'section_update', section: 'goal', markdown: 'old', status: 'done' });
    s.editSection('goal', 'edited');
    expect(s.finalMarkdown()).toBe('## Goal\n\nedited');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/spec-chat/stream-state.test.ts`
Expected: FAIL — `editSection` not a function; hydrate ignores `markdown`.

- [ ] **Step 3: Implement**

In `ui/src/spec-chat/stream-state.ts`, add the import at the top (after the existing imports):

```ts
import { SECTIONS, parseSectionsFromMarkdown } from './sections';
```

Extend the `StreamState` interface — change the `hydrate` signature and add `editSection`:

```ts
  hydrate(data: { messages: readonly ConvMessage[]; markdown?: string | null; finalMarkdown?: string | null }): void;
  /** Overwrite a section's body (user edit). Returns the rebuilt canonical
   *  spec markdown (all known sections, in order) for persistence. */
  editSection(key: SpecSectionKey, markdown: string): string;
```

Inside `createStreamState`, add a rebuild helper just above the `return {`:

```ts
  const rebuildMarkdown = () =>
    SECTIONS.filter((s) => sections.has(s.key))
      .map((s) => `## ${s.title}\n\n${sections.get(s.key)!.markdown}`)
      .join('\n\n');
```

Replace the existing `hydrate(data)` implementation with:

```ts
    hydrate(data) {
      messages.length = 0;
      for (const item of parsePersistedTranscript(data.messages)) messages.push(item);
      if (data.markdown != null) {
        sections.clear();
        for (const [k, v] of parseSectionsFromMarkdown(data.markdown)) sections.set(k, v);
      }
      if (data.finalMarkdown != null) finalMd = data.finalMarkdown;
      fire();
    },
```

Add `editSection` right after `hydrate` (before `messages: () => messages,`):

```ts
    editSection(key, markdown) {
      sections.set(key, { markdown, status: 'done' });
      const rebuilt = rebuildMarkdown();
      if (finalMd != null) finalMd = rebuilt;
      fire();
      return rebuilt;
    },
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ui && npx vitest run src/spec-chat/stream-state.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add ui/src/spec-chat/stream-state.ts ui/src/spec-chat/stream-state.test.ts
git commit -m "feat(spec): hydrate rebuilds section map + editSection mutator"
```

---

## Task 3: `prose.ts` — section markers as inline chips

**Files:**
- Create: `ui/src/spec-chat/prose.ts`
- Test: `ui/src/spec-chat/prose.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/spec-chat/prose.test.ts
import { describe, it, expect } from 'vitest';
import { renderProse } from './prose';

describe('renderProse', () => {
  it('passes plain prose through, HTML-escaped', () => {
    expect(renderProse('a < b & c')).toBe('a &lt; b &amp; c');
  });

  it('replaces a closed section block with a done chip and keeps surrounding text', () => {
    const html = renderProse('Listo. <!--section:goal-->## Goal\nBuild it.<!--/section--> sigo');
    expect(html).toContain('Listo. ');
    expect(html).toContain('sec-chip');
    expect(html).toContain('Goal');
    expect(html).not.toContain('## Goal');
    expect(html).not.toContain('<!--');
    expect(html).toContain(' sigo');
  });

  it('hides the body of an unclosed (mid-stream) marker and shows a pending chip', () => {
    const html = renderProse('Consolidando. <!--section:goal-->## Goal\nhalf written');
    expect(html).toContain('sec-chip pending');
    expect(html).not.toContain('## Goal');
    expect(html).not.toContain('half written');
  });

  it('drops a partial opening marker tail (no key terminator yet)', () => {
    const html = renderProse('texto <!--section:go');
    expect(html).toBe('texto ');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/spec-chat/prose.test.ts`
Expected: FAIL — cannot find module `./prose`.

- [ ] **Step 3: Implement**

```ts
// ui/src/spec-chat/prose.ts
import { titleForKey } from './sections';
import type { SpecSectionKey } from './events';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const chip = (title: string, done: boolean) =>
  `<span class="sec-chip${done ? '' : ' pending'}">${done ? '✓' : '✎'} ${esc(title)}${done ? ' drafted' : '…'}</span>`;

/** Escape prose for safe innerHTML and turn `<!--section:KEY-->…<!--/section-->`
 *  blocks into inline chips. An unclosed marker (mid-stream) hides its body and
 *  shows a pending chip; a partial opening marker tail is dropped. */
export function renderProse(text: string): string {
  const OPEN = '<!--section:';
  const CLOSE = '<!--/section-->';
  let out = '';
  let rest = text;
  for (;;) {
    const open = rest.indexOf(OPEN);
    if (open === -1) { out += esc(rest); break; }
    out += esc(rest.slice(0, open));
    const after = rest.slice(open + OPEN.length);
    const keyEnd = after.indexOf('-->');
    if (keyEnd === -1) break; // partial opening marker still streaming — drop tail
    const key = after.slice(0, keyEnd) as SpecSectionKey;
    const title = titleForKey(key);
    const body = after.slice(keyEnd + 3);
    const close = body.indexOf(CLOSE);
    if (close === -1) { out += chip(title, false); break; } // unclosed → pending, hide body
    out += chip(title, true);
    rest = body.slice(close + CLOSE.length);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ui && npx vitest run src/spec-chat/prose.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/spec-chat/prose.ts ui/src/spec-chat/prose.test.ts
git commit -m "feat(spec): renderProse turns section markers into inline chips"
```

---

## Task 4: Wire `renderProse` into the activity stream

**Files:**
- Modify: `ui/src/spec-chat/activity-stream.ts:55` (committed assistant bubble) and `:121` (live bubble)
- Test: `ui/src/spec-chat/activity-stream.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to ui/src/spec-chat/activity-stream.test.ts (jsdom env)
  it('renders section markers in assistant prose as chips, not raw', () => {
    const state = createStreamState();
    mountActivityStream(host, state);
    state.addUserMessage('go');
    state.apply({ kind: 'text_delta', text: 'Done. <!--section:goal-->## Goal\nx<!--/section-->' });
    state.apply({ kind: 'turn_done', awaiting_user: true });
    const bubble = host.querySelector('.bubble.asst')!;
    expect(bubble.querySelector('.sec-chip')).not.toBeNull();
    expect(bubble.innerHTML).not.toContain('## Goal');
    expect(bubble.textContent).not.toContain('<!--');
  });
```

(If `activity-stream.test.ts` does not exist, create it with the header
`// @vitest-environment jsdom`, imports for `mountActivityStream` from
`./activity-stream` and `createStreamState` from `./stream-state`, a
`describe('mountActivityStream', …)` block, and a `beforeEach` that sets
`host = document.createElement('div'); document.body.appendChild(host);`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/spec-chat/activity-stream.test.ts`
Expected: FAIL — bubble contains raw `## Goal`, no `.sec-chip`.

- [ ] **Step 3: Implement**

In `ui/src/spec-chat/activity-stream.ts` add the import at the top:

```ts
import { renderProse } from './prose';
```

Replace the committed assistant branch (the `else` at line ~54-55) so assistant
prose goes through `renderProse` while user text stays plain-escaped:

```ts
      } else {
        const cls = m.role === 'user' ? 'user' : 'asst';
        const body = m.role === 'user' ? esc(m.content) : renderProse(m.content);
        el = itemFromHtml(`<div class="item"><div class="bubble ${cls}">${body}</div></div>`);
      }
```

Replace the live-text body assignment in `renderLiveText` (line ~121) from
`liveText.textContent = t;` to:

```ts
      liveText.innerHTML = renderProse(t);
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ui && npx vitest run src/spec-chat/activity-stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/spec-chat/activity-stream.ts ui/src/spec-chat/activity-stream.test.ts
git commit -m "feat(spec): render section markers as chips in the activity stream"
```

---

## Task 5: Backend `spec_author_save_markdown` command

**Files:**
- Modify: `crates/agent/src/spec_author.rs` (add `save_markdown` + `save_markdown_default`)
- Modify: `crates/app/src/lib.rs` (command + register in invoke_handler)
- Test: `crates/agent/src/spec_author.rs` (unit test in the existing `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `crates/agent/src/spec_author.rs`:

```rust
    #[test]
    fn save_markdown_overwrites_partial_md() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let draft = SpecDraft {
            id: Ulid::new(),
            messages: vec![],
            partial_md: Some("## Goal\n\nold".into()),
            last_updated: chrono::Utc::now(),
            status: DraftStatus::InProgress { phase: "goal".into() },
            repo_root: None,
        };
        save_draft(base, &draft).unwrap();
        save_markdown(draft.id, "## Goal\n\nedited", base).unwrap();
        let reloaded = load_draft(base, draft.id).unwrap();
        assert_eq!(reloaded.partial_md.as_deref(), Some("## Goal\n\nedited"));
    }
```

(If the test module lacks `tempfile`, follow the pattern already used by the
other persistence tests in this file — reuse whatever temp-dir helper they use;
`grep -n "tempdir\|TempDir\|mod tests" crates/agent/src/spec_author.rs` to find it.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p karl_agent spec_author::tests::save_markdown_overwrites_partial_md`
Expected: FAIL — `save_markdown` not found.

- [ ] **Step 3: Implement the lib function**

Add after `mark_published_default` in `crates/agent/src/spec_author.rs`:

```rust
/// Overwrite a draft's spec body (user edit from the section editor) and persist.
pub fn save_markdown(id: Ulid, markdown: &str, base_dir: &Path) -> Result<()> {
    let mut draft = load_draft(base_dir, id)?;
    draft.partial_md = Some(markdown.to_string());
    draft.last_updated = chrono::Utc::now();
    save_draft(base_dir, &draft)
}

/// Convenience wrapper — resolves `~/.covenant/` via `dirs::home_dir()`.
pub fn save_markdown_default(id: Ulid, markdown: &str) -> Result<()> {
    let base = home_covenant_dir()?;
    save_markdown(id, markdown, &base)
}
```

- [ ] **Step 4: Run to verify the unit test passes**

Run: `cargo test -p karl_agent spec_author::tests::save_markdown_overwrites_partial_md`
Expected: PASS.

- [ ] **Step 5: Add the Tauri command**

In `crates/app/src/lib.rs`, add after `spec_author_delete_draft` (~line 2986):

```rust
#[tauri::command]
async fn spec_author_save_markdown(id: String, markdown: String) -> Result<(), String> {
    let ulid = id.parse::<Ulid>().map_err(|e| e.to_string())?;
    karl_agent::spec_author::save_markdown_default(ulid, &markdown).map_err(|e| e.to_string())
}
```

Register it in the `invoke_handler!` list (after `spec_author_delete_draft,` ~line 4086):

```rust
            spec_author_delete_draft,
            spec_author_save_markdown,
```

- [ ] **Step 6: Verify it compiles**

Run: `cargo check -p karl-app`
Expected: compiles clean (no warnings about an unused command).

- [ ] **Step 7: Commit**

```bash
git add crates/agent/src/spec_author.rs crates/app/src/lib.rs
git commit -m "feat(spec): spec_author_save_markdown command to persist edits"
```

---

## Task 6: `api.ts` wrapper

**Files:**
- Modify: `ui/src/api.ts` (after `specAuthorDeleteDraft`, ~line 1725)

- [ ] **Step 1: Add the wrapper**

```ts
/** Persist a user-edited spec body (overwrites the draft's partial_md). */
export async function specAuthorSaveMarkdown(id: string, markdown: string): Promise<void> {
  return invoke<void>("spec_author_save_markdown", { id, markdown });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(spec): specAuthorSaveMarkdown api wrapper"
```

---

## Task 7: `live-spec` — persistent nav `done`, editable bodies, persist callback

**Files:**
- Modify: `ui/src/spec-chat/live-spec.ts`
- Test: `ui/src/spec-chat/live-spec.test.ts`

- [ ] **Step 1: Write the failing tests** (append to the existing `describe`)

```ts
  it('marks a completed section node on the spine even when not the active phase', () => {
    const state = createStreamState();
    mountLiveSpec(host, state);
    state.hydrate({ messages: [], markdown: '## Goal\n\nDone goal.' });
    const node = host.querySelector('.node[data-key="goal"]')!;
    expect(node.classList.contains('done')).toBe(true);
  });

  it('fires onPersist with rebuilt markdown when a section body is edited', () => {
    const state = createStreamState();
    const saved: string[] = [];
    mountLiveSpec(host, state, (md) => saved.push(md));
    state.apply({ kind: 'section_update', section: 'goal', markdown: 'old', status: 'done' });
    const content = host.querySelector('.sec[data-key="goal"] .content') as HTMLElement;
    content.textContent = 'edited goal';
    content.dispatchEvent(new Event('blur'));
    expect(saved).toEqual(['## Goal\n\nedited goal']);
  });

  it('does not clobber a section body while it is focused', () => {
    const state = createStreamState();
    mountLiveSpec(host, state);
    state.apply({ kind: 'section_update', section: 'goal', markdown: 'first', status: 'done' });
    const content = host.querySelector('.sec[data-key="goal"] .content') as HTMLElement;
    content.focus();
    content.textContent = 'user typing';
    // a later state change must NOT overwrite the focused editor
    state.apply({ kind: 'section_update', section: 'goal', markdown: 'first', status: 'done' });
    expect(content.textContent).toBe('user typing');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/spec-chat/live-spec.test.ts`
Expected: FAIL — no `.node.done`, `mountLiveSpec` takes 2 args, content not editable.

- [ ] **Step 3: Implement**

Replace the whole body of `ui/src/spec-chat/live-spec.ts` with:

```ts
import type { StreamState } from './stream-state';
import { SECTIONS } from './sections';

/** Mount the right-side SPECIFICATION panel + section nav spine.
 *  `onPersist` (optional) is called with rebuilt canonical markdown whenever the
 *  user edits a section body, so the caller can persist it to disk. */
export function mountLiveSpec(
  host: HTMLElement,
  state: StreamState,
  onPersist?: (markdown: string) => void,
): () => void {
  const spine = document.createElement('div');
  spine.className = 'spine';
  const spec = document.createElement('div');
  spec.className = 'spec';
  for (const s of SECTIONS) {
    const node = document.createElement('div');
    node.className = 'node'; node.dataset.key = s.key;
    node.innerHTML = `<span class="dot"></span><span class="label">${s.title}</span>`;
    spine.appendChild(node);

    const sec = document.createElement('div');
    sec.className = 'sec'; sec.dataset.key = s.key;
    sec.innerHTML = `<div class="stitle"><span class="badge"></span>${s.title}</div>`
      + `<div class="content"><div class="ghost"><span></span><span></span><span></span></div></div>`;
    spec.appendChild(sec);

    // Commit an edit on blur: overwrite the section and persist rebuilt markdown.
    const content = sec.querySelector('.content') as HTMLElement;
    content.addEventListener('blur', () => {
      if (content.contentEditable !== 'true') return;
      const md = (content.textContent ?? '').trim();
      const cur = state.section(s.key);
      if (!cur || cur.markdown === md) return;
      const rebuilt = state.editSection(s.key, md);
      onPersist?.(rebuilt);
    });
  }
  host.appendChild(spine);
  host.appendChild(spec);

  const render = () => {
    const active = state.activePhase();
    spine.querySelectorAll<HTMLElement>('.node').forEach((n) => {
      const view = state.section(n.dataset.key as never);
      n.classList.toggle('active', n.dataset.key === active);
      n.classList.toggle('done', view?.status === 'done');
    });
    for (const s of SECTIONS) {
      const view = state.section(s.key);
      if (!view) continue;
      const sec = spec.querySelector<HTMLElement>(`.sec[data-key="${s.key}"]`)!;
      const content = sec.querySelector('.content') as HTMLElement;
      // Anti-clobber: never overwrite the body the user is actively editing.
      if (document.activeElement !== content) content.textContent = view.markdown;
      content.contentEditable = view.status === 'done' ? 'true' : 'false';
      sec.classList.toggle('active', s.key === active);
      sec.classList.toggle('done', view.status === 'done');
      if (view.status === 'done') sec.querySelector('.badge')!.textContent = '✓';
    }
  };
  const off = state.onChange(render);
  render();
  return () => { off(); host.removeChild(spine); host.removeChild(spec); };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ui && npx vitest run src/spec-chat/live-spec.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add ui/src/spec-chat/live-spec.ts ui/src/spec-chat/live-spec.test.ts
git commit -m "feat(spec): persistent nav done state + editable section bodies"
```

---

## Task 8: `entrance.ts` — derive titles from shared SECTIONS

**Files:**
- Modify: `ui/src/spec-chat/entrance.ts:31-46`
- Test: existing `ui/src/spec-chat/entrance.test.ts` must still pass.

- [ ] **Step 1: Replace the local `SECTION_TITLES`**

In `ui/src/spec-chat/entrance.ts`, add to the imports near the top:

```ts
import { SECTIONS } from "./sections";
```

Replace the `SECTION_TITLES` const (lines 31-39) with:

```ts
/** Display titles, single-sourced from the shared sections util. */
const SECTION_TITLES = SECTIONS.map((s) => s.title);
```

Leave `sectionProgress` unchanged (it already maps over `SECTION_TITLES`).

- [ ] **Step 2: Run the entrance tests**

Run: `cd ui && npx vitest run src/spec-chat/entrance.test.ts`
Expected: PASS (no behavior change — same titles, same order).

- [ ] **Step 3: Commit**

```bash
git add ui/src/spec-chat/entrance.ts
git commit -m "refactor(spec): single-source section titles in entrance"
```

---

## Task 9: `immersive.ts` — hydrate with partial_md always + wire persist

**Files:**
- Modify: `ui/src/spec-chat/immersive.ts:81` (mountLiveSpec call) and `:95-103` (hydrate)
- Test: existing `ui/src/spec-chat/immersive.test.ts` must still pass.

- [ ] **Step 1: Add the api import**

In `ui/src/spec-chat/immersive.ts`, add `specAuthorSaveMarkdown` to the existing
`../api` import (alongside `specAuthorLoadDraft`, `specAuthorDeleteDraft`).

- [ ] **Step 2: Pass the persist callback to mountLiveSpec**

Change the `mountLiveSpec(tmp, state);` call (line ~81) to:

```ts
  mountLiveSpec(tmp, state, (md) => {
    if (draftId) void specAuthorSaveMarkdown(draftId, md);
  });
```

- [ ] **Step 3: Hydrate section cards from partial_md regardless of status**

Replace the `state.hydrate({ … })` block (lines ~95-103) with:

```ts
        state.hydrate({
          messages: draft.messages.map((m) => ({
            role: m.role === 'User' ? 'user' : 'assistant',
            content: m.content,
          })),
          // Rebuild the section cards/nav from whatever was authored so far.
          markdown: draft.partial_md,
          // Publish stays gated on a completed (Ready) draft.
          finalMarkdown: draft.status === 'Ready' ? draft.partial_md : null,
        });
```

- [ ] **Step 4: Run immersive tests + full spec-chat suite**

Run: `cd ui && npx vitest run src/spec-chat/`
Expected: PASS (all spec-chat tests green).

- [ ] **Step 5: Commit**

```bash
git add ui/src/spec-chat/immersive.ts
git commit -m "feat(spec): resume rebuilds section cards + persists edits"
```

---

## Task 10: CSS — nav `done`, editable body, section chip

**Files:**
- Modify: `ui/src/spec-chat/immersive.css`

- [ ] **Step 1: Add styles**

Append to `ui/src/spec-chat/immersive.css` (match the existing accent/good vars
already used in the file — `--accent`, `--good`, `--line-soft`):

```css
/* persistent "done" state on the section nav spine */
.spec-creator .spine .node.done .dot { background: var(--good); border-color: var(--good); }
.spec-creator .spine .node.done .label { color: var(--txt); }

/* editable section body */
.spec-creator .sec .content[contenteditable="true"] { cursor: text; outline: none; border-radius: 7px; transition: background .2s, box-shadow .2s; }
.spec-creator .sec .content[contenteditable="true"]:hover { background: rgba(255,255,255,.02); }
.spec-creator .sec .content[contenteditable="true"]:focus { background: rgba(124,140,255,.05); box-shadow: 0 0 0 1px var(--accent-soft); padding: 6px 8px; margin: -6px -8px; }

/* inline section-marker chip in the reasoning prose */
.spec-creator .sec-chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 9px; margin: 0 2px; border-radius: 999px; font-size: 12px; font-weight: 600; color: var(--good); background: rgba(78,201,160,.1); border: 1px solid rgba(78,201,160,.22); vertical-align: baseline; }
.spec-creator .sec-chip.pending { color: var(--accent); background: rgba(124,140,255,.1); border-color: var(--accent-soft); }
```

- [ ] **Step 2: Verify the build**

Run: `cd ui && npx vitest run src/spec-chat/ && npx tsc --noEmit`
Expected: tests PASS, typecheck clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/spec-chat/immersive.css
git commit -m "style(spec): nav done state, editable body affordance, section chip"
```

---

## Task 11: Full verification

- [ ] **Step 1: Run the full UI spec-chat suite + typecheck**

Run: `cd ui && npx vitest run src/spec-chat/ && npx tsc --noEmit`
Expected: all green, no type errors.

- [ ] **Step 2: Rust check + targeted test**

Run: `cargo test -p karl_agent spec_author && cargo check -p karl-app`
Expected: spec_author tests pass, app compiles.

- [ ] **Step 3: Manual smoke (the reporter's exact flow)**

Run the app (`npm run tauri:dev` or the `respawn` skill), then:
1. Open Spec Creator, author a draft until Goal (and others) are written.
2. Close the Spec Creator, reopen the same draft from the entrance.
   - **Expect:** Goal/section cards show their content (not skeletons); nav chips for authored sections show the `done` (green dot) state.
3. Click into the Goal card, edit the text, click away.
   - **Expect:** edit sticks; reopening the draft shows the edited text.
4. Scroll the reasoning column to a turn that authored a section.
   - **Expect:** an inline `✓ Goal drafted` chip, never raw `<!--section:-->`/`## Goal`.

---

## Self-Review notes

- **Spec coverage:** Fix 1 → Tasks 1,2,7,9 (+CSS 10). Fix 2 → Tasks 2,5,6,7,9. Fix 3 → Tasks 3,4 (+CSS 10). Shared util → Task 1, adopted in 7/8.
- **Type consistency:** `editSection(key, md): string`, `hydrate({messages, markdown?, finalMarkdown?})`, `mountLiveSpec(host, state, onPersist?)`, `specAuthorSaveMarkdown(id, markdown)`, Rust `save_markdown(id, &str, &Path)` — names used identically across tasks.
- **No placeholders:** every code step shows full code; commands have expected output.
```
