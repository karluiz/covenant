# Operator Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator emit a `` ```card `` fenced block for structured info (commits, files, tasks) so it renders as a titled card with rows instead of a prose wall.

**Architecture:** A new pure module `ui/src/teammate/card.ts` parses ` ```card ` fences into segments and builds card HTML via a caller-supplied cell renderer. `panel.ts` wires it with the existing inline renderer (refactored to accept the pre-split mention `bundle`) and uses it for operator bubbles. A static `CARD_DIRECTIVE` in `llm.rs` teaches the operator the format. No storage / schema / command changes.

**Tech Stack:** TypeScript + vitest (UI), Rust (system prompt), CSS.

---

## File Structure

- Create: `ui/src/teammate/card.ts` — pure card parser + HTML builder (no DOM, no panel deps).
- Create: `ui/src/teammate/card.test.ts` — vitest unit tests for the parser/builder.
- Modify: `ui/src/teammate/panel.ts` — refactor `renderInlineContent` to expose `renderInline(visible, bundle)`, add `renderMessageBody`, switch the operator bubble call site.
- Modify: `ui/src/styles.css` — `.teammate-card` styling.
- Modify: `crates/app/src/teammate/llm.rs` — add `CARD_DIRECTIVE`, append in `build_system_prompt`, add a test.

Notes for the implementer:
- Run UI tests from the repo root: `npm test` (which is `vitest run`). Target one file with `npx vitest run ui/src/teammate/card.test.ts`.
- Run Rust tests with `cargo test -p app teammate::llm` (or the crate's package name `app`).
- Do NOT touch the user-message bubble (panel.ts:1289) — cards are operator-only.

---

### Task 1: Card parser + HTML builder (pure module)

**Files:**
- Create: `ui/src/teammate/card.ts`
- Test: `ui/src/teammate/card.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/teammate/card.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { splitMessageSegments, renderCardHtml, renderCardSegments } from "./card";

// A trivial cell renderer for structure assertions: HTML-escape only.
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

describe("splitMessageSegments", () => {
  it("returns a single prose segment when there is no card fence", () => {
    const segs = splitMessageSegments("just a normal reply\nsecond line");
    expect(segs).toEqual([{ kind: "prose", text: "just a normal reply\nsecond line" }]);
  });

  it("parses a card fence with a title and label|value rows", () => {
    const text = "```card title=Last 10 commits\nb481d7d | operator threads plan\n76342a5 | spec\n```";
    const segs = splitMessageSegments(text);
    expect(segs).toEqual([
      {
        kind: "card",
        title: "Last 10 commits",
        rows: [
          { label: "b481d7d", value: "operator threads plan" },
          { label: "76342a5", value: "spec" },
        ],
      },
    ]);
  });

  it("accepts a bare title after `card ` (no title= prefix)", () => {
    const segs = splitMessageSegments("```card My Title\nrow\n```");
    expect(segs[0]).toMatchObject({ kind: "card", title: "My Title" });
  });

  it("treats a row with no pipe as a single full-width cell, and trims", () => {
    const segs = splitMessageSegments("```card\n  just one cell  \n```");
    expect(segs[0]).toEqual({ kind: "card", title: null, rows: [{ label: null, value: "just one cell" }] });
  });

  it("splits on the FIRST pipe only", () => {
    const segs = splitMessageSegments("```card\na | b | c\n```");
    expect((segs[0] as any).rows[0]).toEqual({ label: "a", value: "b | c" });
  });

  it("keeps prose before and after a card as separate segments", () => {
    const segs = splitMessageSegments("intro\n```card\nx | y\n```\noutro");
    expect(segs.map((s) => s.kind)).toEqual(["prose", "card", "prose"]);
    expect((segs[0] as any).text).toBe("intro");
    expect((segs[2] as any).text).toBe("outro");
  });

  it("falls back to prose for an unterminated fence", () => {
    const text = "```card title=Broken\nb481d7d | no closing fence";
    const segs = splitMessageSegments(text);
    expect(segs).toEqual([{ kind: "prose", text }]);
  });

  it("renders an empty card body as title only (no rows)", () => {
    const segs = splitMessageSegments("```card title=Empty\n```");
    expect(segs[0]).toEqual({ kind: "card", title: "Empty", rows: [] });
  });
});

describe("renderCardHtml", () => {
  it("emits a title and label/value rows, escaping via the cell renderer", () => {
    const html = renderCardHtml(
      { kind: "card", title: "T<>", rows: [{ label: "a&b", value: "v" }] },
      esc,
    );
    expect(html).toContain('<div class="teammate-card">');
    expect(html).toContain('<div class="teammate-card__title">T&lt;&gt;</div>');
    expect(html).toContain('<span class="teammate-card__label">a&amp;b</span>');
    expect(html).toContain('<span class="teammate-card__value">v</span>');
  });

  it("omits the title div when title is null", () => {
    const html = renderCardHtml({ kind: "card", title: null, rows: [] }, esc);
    expect(html).not.toContain("teammate-card__title");
  });

  it("emits a single full-width cell for a label-less row", () => {
    const html = renderCardHtml(
      { kind: "card", title: null, rows: [{ label: null, value: "solo" }] },
      esc,
    );
    expect(html).toContain('<span class="teammate-card__cell">solo</span>');
    expect(html).not.toContain("teammate-card__label");
  });
});

describe("renderCardSegments", () => {
  it("renders prose via the cell renderer and cards as blocks, in order", () => {
    const out = renderCardSegments("hi\n```card\na | b\n```\nbye", esc);
    expect(out).toBe("hi" + renderCardHtml({ kind: "card", title: null, rows: [{ label: "a", value: "b" }] }, esc) + "bye");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run ui/src/teammate/card.test.ts`
Expected: FAIL — `card.ts` does not exist / exports undefined.

- [ ] **Step 3: Implement `ui/src/teammate/card.ts`**

```ts
// Parses operator `` ```card `` fenced blocks into segments and builds card
// HTML. Pure — no DOM, no panel dependencies. The caller supplies a
// `renderCell` that turns a raw cell string into safe inline HTML (panel.ts
// passes its existing inline renderer so code spans + mention chips work
// inside cells). renderCell MUST escape, since output is assigned via innerHTML.

export interface CardRow {
  label: string | null; // null => full-width cell
  value: string;
}

export type MessageSegment =
  | { kind: "prose"; text: string }
  | { kind: "card"; title: string | null; rows: CardRow[] };

const FENCE_OPEN = /^```card\b(.*)$/;
const FENCE_CLOSE = "```";

function parseTitle(info: string): string | null {
  const t = info.trim();
  if (!t) return null;
  return t.startsWith("title=") ? (t.slice("title=".length).trim() || null) : t;
}

function parseRow(line: string): CardRow {
  const idx = line.indexOf("|");
  if (idx < 0) return { label: null, value: line.trim() };
  return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
}

export function splitMessageSegments(text: string): MessageSegment[] {
  const lines = text.split("\n");
  const segments: MessageSegment[] = [];
  let prose: string[] = [];

  const flushProse = () => {
    if (prose.length) {
      segments.push({ kind: "prose", text: prose.join("\n") });
      prose = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(FENCE_OPEN);
    if (open) {
      // Find the closing fence.
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === FENCE_CLOSE) {
          close = j;
          break;
        }
      }
      if (close >= 0) {
        flushProse();
        const rows = lines
          .slice(i + 1, close)
          .filter((l) => l.trim() !== "")
          .map(parseRow);
        segments.push({ kind: "card", title: parseTitle(open[1]), rows });
        i = close + 1;
        continue;
      }
      // No closing fence: treat the open line as ordinary prose.
    }
    prose.push(lines[i]);
    i++;
  }
  flushProse();
  return segments;
}

export function renderCardHtml(
  card: Extract<MessageSegment, { kind: "card" }>,
  renderCell: (s: string) => string,
): string {
  let h = '<div class="teammate-card">';
  if (card.title) {
    h += `<div class="teammate-card__title">${renderCell(card.title)}</div>`;
  }
  for (const row of card.rows) {
    if (row.label === null) {
      h += `<div class="teammate-card__row"><span class="teammate-card__cell">${renderCell(row.value)}</span></div>`;
    } else {
      h += `<div class="teammate-card__row"><span class="teammate-card__label">${renderCell(row.label)}</span><span class="teammate-card__value">${renderCell(row.value)}</span></div>`;
    }
  }
  h += "</div>";
  return h;
}

export function renderCardSegments(
  text: string,
  renderCell: (s: string) => string,
): string {
  return splitMessageSegments(text)
    .map((seg) => (seg.kind === "card" ? renderCardHtml(seg, renderCell) : renderCell(seg.text)))
    .join("");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run ui/src/teammate/card.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add ui/src/teammate/card.ts ui/src/teammate/card.test.ts
git commit -m "feat(teammate): card markup parser and HTML builder"
```

---

### Task 2: Wire cards into the operator bubble

**Files:**
- Modify: `ui/src/teammate/panel.ts` (refactor `renderInlineContent` near :1730; operator call site at :1304)

- [ ] **Step 1: Refactor `renderInlineContent` to expose the bundle-aware core**

In `ui/src/teammate/panel.ts`, replace the existing `renderInlineContent` function (currently starting at line 1730) with the following. This splits the `--- Mentioned ---` bundle out into a reusable helper and exposes `renderInline(visible, bundle)`, keeping behavior identical for callers of `renderInlineContent`:

```ts
const MENTION_SEP = "\n\n--- Mentioned ---\n";

function splitMentionBundle(text: string): { visible: string; bundle: string } {
  const idx = text.indexOf(MENTION_SEP);
  if (idx < 0) return { visible: text, bundle: "" };
  return { visible: text.slice(0, idx), bundle: text.slice(idx + MENTION_SEP.length) };
}

// Render already-bundle-split visible text to inline HTML. Escapes, then
// applies code spans and @spec/@file mention chips resolved from `bundle`.
function renderInline(visible: string, bundle: string): string {
  const specMeta = extractSpecMeta(bundle);

  let html = escapeHtml(visible).replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/@spec:([\w./-]+)/g, (_m, id: string) => {
    const meta = specMeta.get(id);
    const label = meta?.title ? `${id} · ${meta.title}` : id;
    const pathAttr = meta?.path ? ` data-spec-path="${escapeHtml(meta.path)}"` : "";
    return `<button type="button" class="teammate-mention-chip" data-mention-kind="spec" data-spec-id="${escapeHtml(id)}"${pathAttr}>§ ${escapeHtml(label)}</button>`;
  });
  const fileSet = extractFileMentions(bundle);
  if (fileSet.size > 0) {
    const paths = Array.from(fileSet).sort((a, b) => b.length - a.length);
    const escaped = paths.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(`@(${escaped.join("|")})`, "g");
    html = html.replace(re, (_m, p: string) => {
      return `<button type="button" class="teammate-mention-chip" data-mention-kind="file" data-file-path="${escapeHtml(p)}">⌗ ${escapeHtml(p)}</button>`;
    });
  }
  return html;
}

function renderInlineContent(text: string): string {
  const { visible, bundle } = splitMentionBundle(text);
  return renderInline(visible, bundle);
}

// Render an operator message: same inline handling as renderInlineContent,
// plus ```card``` fences become card blocks. Cells reuse renderInline so code
// spans and mention chips work inside them.
function renderMessageBody(text: string): string {
  const { visible, bundle } = splitMentionBundle(text);
  return renderCardSegments(visible, (cell) => renderInline(cell, bundle));
}
```

- [ ] **Step 2: Add the import at the top of `panel.ts`**

Add near the other `./` imports:

```ts
import { renderCardSegments } from "./card";
```

- [ ] **Step 3: Switch the operator bubble to `renderMessageBody`**

At the operator bubble assignment (currently `b.innerHTML = renderInlineContent(msg.content.data);` at panel.ts:1304 — the one inside the `else` branch, NOT the user branch at :1289), change it to:

```ts
      b.innerHTML = renderMessageBody(msg.content.data);
```

Leave the user-message bubble at :1289 using `renderInlineContent` unchanged.

- [ ] **Step 4: Verify the build / typecheck and existing tests**

Run: `npx tsc --noEmit -p ui` (or the repo's typecheck script if present), then `npx vitest run ui/src/teammate/card.test.ts`
Expected: no type errors; card tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/teammate/panel.ts
git commit -m "feat(teammate): render card blocks in operator messages"
```

---

### Task 3: Card styling

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Add card styles**

Append to `ui/src/styles.css` (square corners, flat surface, hairline row dividers — consistent with the operator drawer aesthetic; uses existing CSS variables where available, with literal fallbacks):

```css
/* Operator cards — structured info blocks inside operator messages. */
.teammate-card {
  margin: 6px 0;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 0; /* square corners, matches operator drawer */
  background: var(--surface-2, rgba(255, 255, 255, 0.03));
  overflow: hidden;
  font-size: 12px;
}
.teammate-card__title {
  padding: 6px 10px;
  font-weight: 600;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  opacity: 0.9;
}
.teammate-card__row {
  display: flex;
  gap: 10px;
  padding: 5px 10px;
}
.teammate-card__row + .teammate-card__row {
  border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.06));
}
.teammate-card__label {
  flex: 0 0 auto;
  font-family: var(--mono, ui-monospace, "SF Mono", Menlo, monospace);
  opacity: 0.7;
  white-space: nowrap;
}
.teammate-card__value,
.teammate-card__cell {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}
```

- [ ] **Step 2: Verify visually**

Use the `respawn` skill (or `npm run tauri:dev`) to launch, open an operator chat, and have it emit a card (e.g. ask "summarize the last 5 commits"). Confirm a titled block with hairline-divided rows, square corners, no row gradients.
Expected: readable card, not a prose wall.

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles.css
git commit -m "style(teammate): operator card styling"
```

---

### Task 4: Teach the operator the card format

**Files:**
- Modify: `crates/app/src/teammate/llm.rs` (`CARD_DIRECTIVE` const + `build_system_prompt` at :157; test near the existing prompt test at ~:957)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)]` module in `crates/app/src/teammate/llm.rs` (alongside the existing test that asserts `p.contains("SENTIMENT:")`):

```rust
    #[test]
    fn system_prompt_includes_card_directive() {
        let op = test_operator(); // reuse the same constructor the SENTIMENT test uses
        let p = build_system_prompt(&op);
        assert!(p.contains("```card"), "prompt must teach the card fence");
        assert!(p.contains("# Cards"), "prompt must have the Cards section header");
    }
```

If the existing test constructs its operator inline rather than via a helper, mirror that construction here instead of `test_operator()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p app system_prompt_includes_card_directive`
Expected: FAIL — directive text not present.

- [ ] **Step 3: Add the directive and append it**

Add the const near `SENTIMENT_DIRECTIVE` (after line ~46) in `crates/app/src/teammate/llm.rs`:

```rust
/// Appended to every operator system prompt: teach the operator to present
/// structured information as a `card` block instead of a numbered paragraph.
/// Static text so the system prompt stays stable and the prompt cache hits.
const CARD_DIRECTIVE: &str = "\n\n# Cards\n\
    \n\
    When you inform the user of a LIST of structured items — commits, changed \
    files, tasks, options, or key/value facts — present them as a card instead \
    of a numbered paragraph. A card is a fenced block:\n\
    \n\
    ```card title=<short title>\n\
    <label> | <value>\n\
    <label> | <value>\n\
    ```\n\
    \n\
    Rules: one row per line; the part before the first `|` is the label, the \
    rest is the value; omit the `|` for a single full-width line; `title=` is \
    optional. Use plain prose for normal conversational replies — only reach \
    for a card when the content is genuinely a list/table of items.";
```

Then update the two return expressions in `build_system_prompt` (currently at the end of the function, ~line 273) to append `CARD_DIRECTIVE` after `SENTIMENT_DIRECTIVE`:

```rust
    if persona.is_empty() {
        format!("{header}{SENTIMENT_DIRECTIVE}{CARD_DIRECTIVE}")
    } else {
        format!("{header}\n\n# Persona\n\n{persona}{SENTIMENT_DIRECTIVE}{CARD_DIRECTIVE}")
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p app system_prompt_includes_card_directive` then `cargo test -p app teammate::llm`
Expected: PASS (new test passes; existing SENTIMENT/prompt tests still pass).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/llm.rs
git commit -m "feat(teammate): teach operator to emit card blocks"
```

---

## Self-Review Notes

- **Spec coverage:** markup format → Task 1; renderer + call-site → Task 2; styling → Task 3; prompt directive → Task 4; robustness (unterminated/empty/first-pipe/multi-card) → Task 1 tests. Sentiment coexistence is automatic (stripped backend-side before the text reaches the UI).
- **Type consistency:** `MessageSegment`/`CardRow`, `splitMessageSegments`, `renderCardHtml`, `renderCardSegments`, `renderInline`, `renderMessageBody`, `splitMentionBundle` are used with identical signatures across Tasks 1–2.
- **YAGNI honored:** no typed cards, no clickable shas, no persistence — exactly the spec's out-of-scope list.
