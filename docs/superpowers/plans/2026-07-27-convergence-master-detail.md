# Convergence Master-Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Convergence overlay's card grid with a master-detail layout: dense status rows on the left, a live detail pane (tail, subagents, blocked interaction) on the right.

**Architecture:** The backend `AgentCard` gains an always-populated `excerpt` (last ~15 PTY screen lines) so the detail pane has live content for every status, not just blocked. The frontend removes the separate attention queue — blocked sessions are rows sorted first; their interaction (question, permission buttons, composer) renders inside the detail pane by reusing `attention.ts`. Spec: `docs/superpowers/specs/2026-07-27-convergence-master-detail-design.md`.

**Tech Stack:** Rust (Tauri command, pure snapshot builders), TypeScript strict (no framework, DOM building), Vitest + jsdom, cargo test.

## Global Constraints

- Sharp corners: `border-radius: 0` on every new/edited `mc-*` rule except the 7px `.mc-dot` (50%) and avatar circles.
- Color states only via spine/dot/pill: working `#5fff8a`, awaiting-input `#ffcf5f`, blocked `var(--danger)`, operator-thinking `var(--accent)`, idle no color + `opacity: .6`.
- Uppercase via CSS `text-transform`, never string mutation.
- No native `title` attributes; no emoji in chrome (inline SVG `Icons.*` only).
- Selected-row lift is neutral (`rgb(var(--ink-rgb) / 0.05)`), never accent-tinted.
- TS: `strict`, no `as any`. Rust: no `unwrap()` outside tests.
- Run `npm test` from repo ROOT, not `ui/`. Cargo: `cargo test -p covenant-app convergence`.
- Commits: one per feature-level task (user preference), Conventional Commits.

---

### Task 1: Backend — `AgentCard.excerpt` for all statuses

**Files:**
- Modify: `crates/app/src/convergence.rs` (struct at :145, `pty_agent_card` at :366, `acp_agent_card` at :400, `BuiltRow` at :428, `AgentCardInput` at :442, `assemble_snapshot` at :469, `build_convergence_snapshot` at :532, tests at :884+)

**Interfaces:**
- Produces: `AgentCard.excerpt: Option<String>` — serialized to the frontend as `excerpt: string | null`. Deletes `BuiltRow.executor_excerpt` and `AgentCardInput.waiting_excerpt` (the card itself is now the single source of the tail).

- [ ] **Step 1: Write the failing tests**

In the `#[cfg(test)]` module of `convergence.rs`, the existing `card()` helper (:884) gets `excerpt: None` added to its literal. Add two tests:

```rust
#[test]
fn assemble_snapshot_attention_excerpt_comes_from_the_card() {
    // Blocked operator row: attention item carries the card's tail.
    let mut c = card("s1", TileStatus::Blocked, Some("Zeta"));
    c.excerpt = Some("cargo test\nrunning 34/210".into());
    let snap = assemble_snapshot(
        vec![BuiltRow {
            card: c,
            escalated_at_unix_ms: 100,
            question: Some("release?".into()),
        }],
        vec![],
    );
    assert_eq!(
        snap.attention[0].excerpt.as_deref(),
        Some("cargo test\nrunning 34/210")
    );
}

#[test]
fn working_card_keeps_its_excerpt_on_the_wire() {
    let mut c = card("s1", TileStatus::Working, None);
    c.excerpt = Some("$ npm test".into());
    let snap = assemble_snapshot(vec![], vec![AgentCardInput { card: c, permission_for_attention: None }]);
    assert_eq!(snap.agents[0].excerpt.as_deref(), Some("$ npm test"));
    assert!(snap.attention.is_empty());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant-app convergence`
Expected: FAIL — `excerpt` is not a field of `AgentCard`, `BuiltRow` still requires `executor_excerpt`.

- [ ] **Step 3: Implement**

1. `AgentCard` (:145): add after `last_output_line`:
```rust
    /// Last ~15 screen lines, ANSI-stripped, secret-masked upstream.
    /// PTY lanes only; None for ACP (chat lane has no screen).
    pub excerpt: Option<String>,
```
2. `pty_agent_card` (:375 literal) and `acp_agent_card` (:402 literal): add `excerpt: None,`.
3. `BuiltRow` (:428): delete `executor_excerpt` field and its doc comment. `AgentCardInput` (:442): delete `waiting_excerpt`.
4. `assemble_snapshot`: at :482 use `item.excerpt = b.card.excerpt.clone();` and at :502 use `item.excerpt = a.card.excerpt.clone();`.
5. `build_convergence_snapshot`, operator-less PTY branch (:566-578): replace the blocked-gated `waiting_excerpt` computation with an unconditional set on the card:
```rust
                let mut c = c;
                c.excerpt = {
                    let tail = lock_recover(&s.op_state).snapshot_tail(8 * 1024);
                    last_non_empty_lines(&tail, 15, 200)
                };
                agent_inputs.push(AgentCardInput {
                    card: c,
                    permission_for_attention: None,
                });
```
6. Operator lane card literal (:627): add `excerpt: last_non_empty_lines(&tail_bytes, 15, 200),` and delete the `executor_excerpt` computation (:649-651); `BuiltRow` literal (:653) loses that field.
7. Fix remaining test literals the compiler flags (`:912`, `:943`, `:953`, `:967`, `:975`): move any `executor_excerpt: Some(x)` / `waiting_excerpt: Some(x)` value onto `card.excerpt` instead; delete the `None` ones.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p covenant-app convergence`
Expected: PASS, including the two new tests and the pre-existing excerpt-flow tests now reading from the card.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/convergence.rs
git commit -m "feat(convergence): carry the PTY tail excerpt on every agent card"
```

---

### Task 2: Frontend model — `excerpt` on `AgentCard`, attention body extraction

**Files:**
- Modify: `ui/src/api.ts` (AgentCard interface, :2356)
- Modify: `ui/src/convergence/attention.ts`
- Test: `ui/src/convergence/attention.test.ts` (rewrite)

**Interfaces:**
- Consumes: Task 1's wire shape.
- Produces:
  - `api.ts`: `excerpt: string | null` on `AgentCard`.
  - `attention.ts`: `renderAttentionBody(item: AttentionItem, cb: AttentionCallbacks): DocumentFragment` — question + kind-specific affordance (permission buttons / PTY composer / operator reply). **No excerpt/tail inside** — the detail pane already shows `card.excerpt`, rendering it twice is a bug.
  - `attention.ts`: `agoLabel(sinceMs: number): string` becomes exported (rows need it).
  - Deleted: `renderAttentionCard`, its private `renderHeader`, `kindLabel`. `AttentionCallbacks` stays as-is (minus `onFocus`, which only the deleted header used — remove it).

- [ ] **Step 1: Add the API field**

In `ui/src/api.ts`, inside `export interface AgentCard`, after `last_output_line`:
```ts
  /// Last ~15 screen lines (PTY lanes); null for ACP.
  excerpt: string | null;
```

- [ ] **Step 2: Rewrite the failing test file**

Replace `ui/src/convergence/attention.test.ts` with:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderAttentionBody, agoLabel, type AttentionCallbacks } from "./attention";
import type { AttentionItem } from "../api";

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  session_id: "s1", tab_title: "deploy", tab_color: null, lane: "pty",
  executor: "claude", kind: "operator-escalation", question: "Ship it?",
  excerpt: null, permission: null, operator_name: "Zeta",
  operator_avatar: null, mission_name: null, since_unix_ms: 100, ...over,
});

const cbs = (): AttentionCallbacks => ({
  onOperatorReply: vi.fn(async () => {}),
  onPermission: vi.fn(),
  onPtyReply: vi.fn(),
});

const mounted = (frag: DocumentFragment): HTMLElement => {
  const host = document.createElement("div");
  host.append(frag);
  return host;
};

describe("renderAttentionBody", () => {
  it("operator escalation: question + scoped reply composer", () => {
    const el = mounted(renderAttentionBody(item({}), cbs()));
    expect(el.querySelector(".mc-detail__question")?.textContent).toBe("Ship it?");
    expect(el.querySelector(".mc-reply")).not.toBeNull();
    expect(el.querySelector(".mc-reply__scope")).not.toBeNull();
  });

  it("acp permission: title fallback + option buttons answer inline", () => {
    const onPermission = vi.fn();
    const el = mounted(renderAttentionBody(
      item({
        kind: "acp-permission", question: null,
        permission: {
          request_key: "rk", title: "Run cargo test?", since_unix_ms: 1,
          options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
        },
      }),
      { ...cbs(), onPermission },
    ));
    expect(el.querySelector(".mc-detail__question")?.textContent).toBe("Run cargo test?");
    el.querySelector<HTMLButtonElement>(".mc-perm-opts button")!.click();
    expect(onPermission).toHaveBeenCalledWith("s1", "rk", "allow");
  });

  it("pty waiting: composer writes to the terminal, no scope select", () => {
    const onPtyReply = vi.fn();
    const el = mounted(renderAttentionBody(item({ kind: "pty-waiting", question: null }), { ...cbs(), onPtyReply }));
    expect(el.querySelector(".mc-detail__question")?.textContent).toBe("(waiting on you)");
    expect(el.querySelector(".mc-reply__scope")).toBeNull();
    const ta = el.querySelector<HTMLTextAreaElement>(".mc-reply__textarea")!;
    ta.value = "y";
    el.querySelector<HTMLButtonElement>(".mc-reply__send")!.click();
    expect(onPtyReply).toHaveBeenCalledWith("s1", "y");
  });

  it("never renders the excerpt — the detail pane owns the tail", () => {
    const el = mounted(renderAttentionBody(item({ excerpt: "$ ls\nfoo" }), cbs()));
    expect(el.textContent).not.toContain("$ ls");
  });
});

describe("agoLabel", () => {
  it("formats seconds/minutes", () => {
    expect(agoLabel(Date.now() - 5_000)).toBe("5s ago");
    expect(agoLabel(Date.now() - 120_000)).toBe("2m ago");
  });
});
```

Check the exact `PendingAcpPermission` field names in `ui/src/api.ts` and match them in the test literal (the shape above follows `attention.ts`'s existing usage: `request_key`, `options[].option_id/name/kind`, `title`, `since_unix_ms`).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- attention` (from repo root)
Expected: FAIL — `renderAttentionBody` / `agoLabel` not exported.

- [ ] **Step 4: Implement in `attention.ts`**

Delete `renderAttentionCard`, `renderHeader`, `kindLabel`, and `onFocus` from `AttentionCallbacks`. Export `agoLabel`. Add:

```ts
/// Kind-specific interaction for a blocked session, rendered inside the
/// detail pane: the question line plus the answer affordance. The tail
/// is NOT rendered here — the pane already shows card.excerpt.
export function renderAttentionBody(
  item: AttentionItem,
  cb: AttentionCallbacks,
): DocumentFragment {
  const frag = document.createDocumentFragment();

  const q = document.createElement("p");
  q.className = "mc-detail__question";
  q.textContent = item.question ?? item.permission?.title ?? "(waiting on you)";
  frag.append(q);

  switch (item.kind) {
    case "acp-permission": {
      const opts = document.createElement("div");
      opts.className = "mc-perm-opts";
      for (const o of item.permission?.options ?? []) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = o.name ?? o.kind.replace(/_/g, " ");
        btn.addEventListener("click", () => {
          if (item.permission) cb.onPermission(item.session_id, item.permission.request_key, o.option_id);
        });
        opts.append(btn);
      }
      frag.append(opts);
      break;
    }
    case "pty-waiting":
      frag.append(renderPtyComposer(item.session_id, cb.onPtyReply));
      break;
    case "operator-escalation":
      frag.append(renderReply(item.session_id, cb.onOperatorReply));
      break;
  }
  return frag;
}
```

`renderPtyComposer` stays as-is. (`overlay.ts` and `tile.ts` won't compile against the deletions yet — that's Tasks 3–4; run only the attention tests here.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- attention`
Expected: PASS (4+2 tests). Other convergence test files may fail to compile — expected until Tasks 3–4.

---

### Task 3: `tile.ts` — row renderer + detail pane renderer

**Files:**
- Modify: `ui/src/convergence/tile.ts`
- Test: `ui/src/convergence/tile.test.ts` (rewrite)

**Interfaces:**
- Consumes: `renderAttentionBody`, `AttentionCallbacks` from `./attention` (Task 2); `AgentCard.excerpt` (Task 2).
- Produces (all from `./tile`):
  - `renderAgentRow(card: AgentCard, opts: { selected: boolean; age: string | null }, cb: RowCallbacks): HTMLElement` with `RowCallbacks = { onSelect(sessionId: string): void; onFocus(sessionId: string): void }`. Root is a `<button class="mc-row mc-row--<status>">` with `data-session-id`.
  - `renderDetailPane(card: AgentCard, attention: AttentionItem | null, cb: DetailCallbacks): HTMLElement` with `DetailCallbacks = { onFocus(sessionId: string, keepOpen: boolean): void; onStop(sessionId: string): void } & AttentionCallbacks`. Root is `<section class="mc-detail">` with `data-session-id`.
  - `renderReply(sessionId, onSubmit)` and `type ReplyScope` unchanged (attention.ts imports them).
  - Deleted: `renderAgentCard`, `CardCallbacks`, `contextChips` (mission moves into the detail meta line).

- [ ] **Step 1: Rewrite the failing test file**

Replace `ui/src/convergence/tile.test.ts` with:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderAgentRow, renderDetailPane, type RowCallbacks, type DetailCallbacks } from "./tile";
import type { AgentCard, AttentionItem, TileStatus } from "../api";

const agent = (over: Partial<AgentCard>): AgentCard => ({
  session_id: "s1", tab_title: "agent tests", tab_color: null, lane: "pty",
  executor: "claude", status: "working" as TileStatus, phase_label: null,
  cwd: null, vendor: "claude", raw_command_label: null,
  last_command: "cargo test --workspace", last_output_line: null, excerpt: null,
  mission_name: null, operator_id: null, operator_name: null,
  operator_avatar: null, cost_usd: null, budget_usd: null, subagents: [], ...over,
});

const rowCbs = (): RowCallbacks => ({ onSelect: vi.fn(), onFocus: vi.fn() });
const detailCbs = (): DetailCallbacks => ({
  onFocus: vi.fn(), onStop: vi.fn(),
  onOperatorReply: vi.fn(async () => {}), onPermission: vi.fn(), onPtyReply: vi.fn(),
});

describe("renderAgentRow", () => {
  it("headline is the tab title; sub-line is executor · operator; activity is mono line", () => {
    const el = renderAgentRow(
      agent({ executor: "codex", operator_name: "Zeta", phase_label: "editing a.rs" }),
      { selected: false, age: null }, rowCbs(),
    );
    expect(el.classList.contains("mc-row--working")).toBe(true);
    expect(el.querySelector(".mc-row__title")?.textContent).toBe("agent tests");
    expect(el.querySelector(".mc-row__sub")?.textContent).toBe("codex · Zeta");
    expect(el.querySelector(".mc-row__activity")?.textContent).toBe("editing a.rs");
  });

  it("selected + age render; click selects; double-click focuses the tab", () => {
    const cb = rowCbs();
    const el = renderAgentRow(agent({ status: "blocked" }), { selected: true, age: "2m ago" }, cb);
    expect(el.classList.contains("mc-row--selected")).toBe(true);
    expect(el.querySelector(".mc-row__age")?.textContent).toBe("2m ago");
    el.click();
    expect(cb.onSelect).toHaveBeenCalledWith("s1");
    el.dispatchEvent(new MouseEvent("dblclick"));
    expect(cb.onFocus).toHaveBeenCalledWith("s1");
  });
});

describe("renderDetailPane", () => {
  it("head has title + status pill + Open tab; no Stop without an operator", () => {
    const cb = detailCbs();
    const el = renderDetailPane(agent({}), null, cb);
    expect(el.querySelector(".mc-detail__title")?.textContent).toBe("agent tests");
    expect(el.querySelector(".mc-pill--working")?.textContent).toBe("working");
    expect(el.querySelector(".mc-stop")).toBeNull();
    el.querySelector<HTMLButtonElement>(".mc-detail__open")!.click();
    expect(cb.onFocus).toHaveBeenCalledWith("s1", false);
  });

  it("operator: meta shows the badge, Stop stops", () => {
    const cb = detailCbs();
    const el = renderDetailPane(
      agent({ operator_id: "o1", operator_name: "Zeta", mission_name: "release", cwd: "/x", cost_usd: 0.4, budget_usd: 1 }),
      null, cb,
    );
    expect(el.querySelector(".mc-oplabel")?.textContent).toContain("Zeta");
    expect(el.querySelector(".mc-chip")?.textContent).toContain("release");
    expect(el.querySelector(".mc-detail__cwd")?.textContent).toBe("/x");
    expect(el.querySelector(".mc-cost")).not.toBeNull();
    el.querySelector<HTMLButtonElement>(".mc-stop")!.click();
    expect(cb.onStop).toHaveBeenCalledWith("s1");
  });

  it("live tail renders from card.excerpt; subagent rows render", () => {
    const el = renderDetailPane(
      agent({
        excerpt: "$ cargo test\nrunning 34/210",
        subagents: [{ id: "t1", label: "fix-flaky", detail: null, running: true, started_unix_ms: Date.now() - 61_000 }],
      }),
      null, detailCbs(),
    );
    expect(el.querySelector(".mc-tail")?.textContent).toContain("running 34/210");
    expect(el.querySelector(".mc-subrow")?.textContent).toContain("fix-flaky");
  });

  it("blocked + attention item: the interaction renders inside the pane", () => {
    const at: AttentionItem = {
      session_id: "s1", tab_title: "agent tests", tab_color: null, lane: "pty",
      executor: "claude", kind: "operator-escalation", question: "Ship?",
      excerpt: null, permission: null, operator_name: "Zeta",
      operator_avatar: null, mission_name: null, since_unix_ms: 1,
    };
    const el = renderDetailPane(agent({ status: "blocked" }), at, detailCbs());
    expect(el.querySelector(".mc-detail__question")?.textContent).toBe("Ship?");
    expect(el.querySelector(".mc-reply")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- convergence/tile`
Expected: FAIL — `renderAgentRow` / `renderDetailPane` not exported.

- [ ] **Step 3: Implement in `tile.ts`**

Keep `STATUS_LABEL`, `renderSubAgents`, `elapsedLabel`, `activityLine`, `vendorLabel`, `costBar`, `renderReply`, `ReplyScope`. Delete `renderAgentCard`, `CardCallbacks`, `renderHeader`, `renderBody`, `contextChips`. Add:

```ts
import { renderAttentionBody, type AttentionCallbacks } from "./attention";
import type { AttentionItem } from "../api";

export interface RowCallbacks {
  onSelect: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
}

/// One rail row. The spine (CSS border-left) is the only status color.
export function renderAgentRow(
  card: AgentCard,
  opts: { selected: boolean; age: string | null },
  cb: RowCallbacks,
): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `mc-row mc-row--${card.status}${opts.selected ? " mc-row--selected" : ""}`;
  row.dataset.sessionId = card.session_id;

  const top = document.createElement("div");
  top.className = "mc-row__top";
  const dot = document.createElement("span");
  dot.className = `mc-dot mc-dot--${card.status}`;
  const title = document.createElement("span");
  title.className = "mc-row__title";
  title.textContent = card.tab_title;
  top.append(dot, title);
  if (opts.age) {
    const age = document.createElement("span");
    age.className = "mc-row__age";
    age.textContent = opts.age;
    top.append(age);
  }

  const sub = document.createElement("div");
  sub.className = "mc-row__sub";
  sub.textContent = [card.executor ?? vendorLabel(card), card.operator_name]
    .filter(Boolean)
    .join(" · ");

  const act = document.createElement("div");
  act.className = "mc-row__activity";
  act.textContent = card.phase_label ?? activityLine(card);

  row.append(top, sub, act);
  row.addEventListener("click", () => cb.onSelect(card.session_id));
  row.addEventListener("dblclick", () => cb.onFocus(card.session_id));
  return row;
}

export type DetailCallbacks = {
  onFocus: (sessionId: string, keepOpen: boolean) => void;
  onStop: (sessionId: string) => void;
} & AttentionCallbacks;

/// The right pane: everything known about the selected agent, live.
/// `attention` is the session's queue item when blocked — its question
/// and answer affordance render at the bottom of the pane.
export function renderDetailPane(
  card: AgentCard,
  attention: AttentionItem | null,
  cb: DetailCallbacks,
): HTMLElement {
  const pane = document.createElement("section");
  pane.className = "mc-detail";
  pane.dataset.sessionId = card.session_id;

  const head = document.createElement("div");
  head.className = "mc-detail__head";
  const title = document.createElement("h2");
  title.className = "mc-detail__title";
  title.textContent = card.tab_title;
  const pill = document.createElement("span");
  pill.className = `mc-pill mc-pill--${card.status}`;
  pill.textContent = STATUS_LABEL[card.status];
  const actions = document.createElement("div");
  actions.className = "mc-detail__actions";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "mc-detail__open";
  open.textContent = `Open tab ${formatChord(["enter"])}`;
  open.addEventListener("click", () => cb.onFocus(card.session_id, false));
  actions.append(open);
  if (card.operator_id) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "mc-stop";
    stop.textContent = "Stop";
    stop.setAttribute("aria-label", "Stop operator");
    stop.addEventListener("click", () => cb.onStop(card.session_id));
    actions.append(stop);
  }
  head.append(title, pill, actions);
  pane.append(head);

  const meta = document.createElement("div");
  meta.className = "mc-detail__meta";
  const exec = document.createElement("strong");
  exec.textContent = card.executor ?? vendorLabel(card);
  meta.append(exec);
  if (card.operator_id) {
    const op = document.createElement("span");
    op.className = "mc-oplabel";
    op.innerHTML = `${renderAvatarHtml(card.operator_avatar ?? "👤", 18)}<span>${card.operator_name ?? ""}</span>`;
    meta.append(op);
  }
  if (card.mission_name) {
    const chip = document.createElement("span");
    chip.className = "mc-chip";
    chip.textContent = `◈ ${card.mission_name}`;
    meta.append(chip);
  }
  if (card.cwd) {
    const cwd = document.createElement("span");
    cwd.className = "mc-detail__cwd";
    cwd.textContent = card.cwd;
    meta.append(cwd);
  }
  pane.append(meta);

  const cost = costBar(card);
  if (cost) pane.append(cost);

  if (card.excerpt) {
    const tail = document.createElement("pre");
    tail.className = "mc-tail";
    tail.textContent = card.excerpt;
    pane.append(tail);
  }
  if (card.subagents.length > 0) pane.append(renderSubAgents(card.subagents));
  if (attention) pane.append(renderAttentionBody(attention, cb));
  return pane;
}
```

Note the existing `"👤"` avatar-fallback argument to `renderAvatarHtml` is data (an avatar glyph), not chrome — keep it, matching current code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- convergence/tile`
Expected: PASS. (`overlay.ts` still imports `renderAgentCard`/`renderAttentionCard` — its tests stay red until Task 4.)

---

### Task 4: `overlay.ts` — split layout, selection drives the pane

**Files:**
- Modify: `ui/src/convergence/overlay.ts`
- Modify: `ui/src/convergence/model.ts` (doc comment only — `attentionIndex` now joins instead of excluding)
- Test: `ui/src/convergence/overlay.test.ts`

**Interfaces:**
- Consumes: `renderAgentRow`, `renderDetailPane` (Task 3), `renderAttentionBody` indirectly, `agoLabel` (Task 2), `attentionIndex`/`sortAgents` (unchanged).
- Produces: same public class surface (`open/close/toggle/isVisible/refreshForTest`, `submitReply`). DOM: `.mc-body` > `.mc-rail` + `.mc-detail-host`; the old `.mc-attention` and `.mc-grid` nodes are gone.

- [ ] **Step 1: Update the failing tests**

In `overlay.test.ts`: add `excerpt: null,` to the `agent()` factory. Replace the first test and add two:

```ts
  it("renders every session as a rail row, blocked first, and details the blocked one", async () => {
    getSnap.mockResolvedValue({
      agents: [
        agent({ session_id: "s1", tab_title: "alpha" }),
        agent({ session_id: "s2", tab_title: "beta", status: "blocked" }),
      ],
      attention: [attItem({ session_id: "s2", question: "Ship?" })],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    const rows = [...document.querySelectorAll<HTMLElement>(".mc-rail .mc-row")];
    expect(rows.map((r) => r.dataset.sessionId)).toEqual(["s2", "s1"]);
    // blocked auto-selected → detail shows its interaction
    const detail = document.querySelector<HTMLElement>(".mc-detail")!;
    expect(detail.dataset.sessionId).toBe("s2");
    expect(detail.querySelector(".mc-detail__question")?.textContent).toBe("Ship?");
    expect(detail.querySelector(".mc-reply")).not.toBeNull();
    const summary = document.querySelector(".mc-strip__summary")?.textContent ?? "";
    expect(summary).toContain("1 needs you");
  });

  it("clicking a row moves the detail pane to it", async () => {
    getSnap.mockResolvedValue({
      agents: [agent({ session_id: "s1", tab_title: "alpha" }), agent({ session_id: "s2", tab_title: "beta" })],
      attention: [],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    document.querySelector<HTMLElement>('.mc-row[data-session-id="s2"]')!.click();
    expect(document.querySelector<HTMLElement>(".mc-detail")?.dataset.sessionId).toBe("s2");
  });

  it("a poll refresh never clobbers a composer draft", async () => {
    getSnap.mockResolvedValue({
      agents: [agent({ session_id: "s2", status: "blocked" })],
      attention: [attItem({ session_id: "s2" })],
    });
    ov.open();
    await ov.refreshForTest();
    await ov.refreshForTest();
    const ta = document.querySelector<HTMLTextAreaElement>(".mc-detail .mc-reply__textarea")!;
    ta.focus();
    ta.value = "draft in progress";
    await ov.refreshForTest();
    const after = document.querySelector<HTMLTextAreaElement>(".mc-detail .mc-reply__textarea")!;
    expect(after).toBe(ta);
    expect(after.value).toBe("draft in progress");
  });
```

In the surviving "last-good" test, change the assertion selector from `.mc-card__exec` to `.mc-row__sub` (executor now lives in the sub-line): `expect(document.querySelector(".mc-row__sub")?.textContent).toBe("codex");`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- convergence/overlay`
Expected: FAIL (old DOM structure, and `overlay.ts` still imports deleted symbols — a compile error is a valid failure here).

- [ ] **Step 3: Implement in `overlay.ts`**

Imports: drop `renderAttentionCard`; import `renderAgentRow`, `renderDetailPane` from `./tile`, `agoLabel` from `./attention`.

Fields: replace `attentionEl`/`gridEl` with `railEl: HTMLElement | null` and `detailHostEl: HTMLElement | null` (update `close()` nulling accordingly).

`mount()`: replace the `attention` + `grid` creation with:
```ts
    const body = document.createElement("div");
    body.className = "mc-body";
    const rail = document.createElement("div");
    rail.className = "mc-rail";
    const detailHost = document.createElement("div");
    detailHost.className = "mc-detail-host";
    body.append(rail, detailHost);
    // …
    root.append(header, strip, body, empty);
```

`visibleAgents()` — the queue no longer exists; blocked rows stay in the list:
```ts
  private visibleAgents() {
    if (!this.snap) return [];
    return sortAgents(this.snap.agents, this.snap.attention).filter((card) => {
      switch (this.filter) {
        case "all": return true;
        case "needs you": return card.status === "blocked";
        case "working": return card.status === "working";
        case "idle": return card.status === "idle";
      }
    });
  }
```

`render()` — same summary math; then:
```ts
    const at = attentionIndex(this.snap.attention);
    const list = this.visibleAgents();
    if (!this.activeSessionId || !list.some((a) => a.session_id === this.activeSessionId)) {
      this.activeSessionId = list[0]?.session_id ?? null;
    }
    this.railEl.replaceChildren();
    if (list.length === 0) {
      const none = document.createElement("div");
      none.className = "mc-rail__empty";
      none.innerHTML = `No agents match <code>${this.filter}</code>. <button type="button" class="mc-rail__reset">Show all</button>`;
      none.querySelector(".mc-rail__reset")?.addEventListener("click", () => { this.filter = "all"; this.render(); });
      this.railEl.append(none);
    }
    for (const card of list) {
      const item = at.get(card.session_id);
      this.railEl.append(
        renderAgentRow(card, {
          selected: card.session_id === this.activeSessionId,
          age: item?.since_unix_ms != null && item.since_unix_ms > 0 ? agoLabel(item.since_unix_ms) : null,
        }, {
          onSelect: (sid) => { this.activeSessionId = sid; this.render(); },
          onFocus: (sid) => { if (this.bridge.activateBySessionId(sid)) this.close(); },
        }),
      );
    }
    this.renderDetail(at);
```

New `renderDetail` — skip while a draft is being typed, keep scroll:
```ts
  private renderDetail(at: Map<string, AttentionItem>): void {
    const host = this.detailHostEl;
    if (!host || !this.snap) return;
    const card = this.snap.agents.find((a) => a.session_id === this.activeSessionId);
    if (!card) { host.replaceChildren(); return; }
    // A focused composer means the human is mid-draft — a 1s poll must
    // not replace the textarea under their fingers.
    const active = document.activeElement;
    if (active?.tagName === "TEXTAREA" && host.contains(active)) return;
    const scroll = host.scrollTop;
    host.replaceChildren(
      renderDetailPane(card, at.get(card.session_id) ?? null, {
        onFocus: (sid, keepOpen) => {
          const ok = this.bridge.activateBySessionId(sid, { keepOverlayOpen: keepOpen });
          if (ok && !keepOpen) this.close();
        },
        onStop: this.stopOperator.bind(this),
        onOperatorReply: this.submitReply.bind(this),
        onPermission: (sid, key, opt) => {
          void acpRespondPermission(sid as SessionId, key, opt).catch((err) =>
            console.warn("[convergence] respond permission failed", sid, err),
          );
          void this.refresh();
        },
        onPtyReply: (sid, text) => {
          void writeToSession(sid as SessionId, new TextEncoder().encode(text + "\r")).catch(
            (err) => console.warn("[convergence] pty reply failed", sid, err),
          );
          void this.refresh();
        },
      }),
    );
    host.scrollTop = scroll;
  }
```

Empty state (`agents.length === 0 && attention.length === 0`): hide `.mc-body` (`body.hidden = true` — keep a `bodyEl` ref or query it), show `this.empty`; inverse otherwise. Add `.mc-body[hidden] { display: none; }` in Task 5.

`renderEmptyError()`: swap `gridEl` for `railEl` and `mc-grid__empty`/`mc-grid__reset` for `mc-rail__empty`/`mc-rail__reset`; clear `detailHostEl` too.

Keyboard handler: unchanged (`moveActive` already re-renders; the new render feeds the pane). One addition — the submit-guard branch in Escape stays as-is since composers still use `.mc-reply`.

In `model.ts`, update `attentionIndex`'s doc comment: `/// session_id → attention item, for joining the queue onto rows and the detail pane.`

- [ ] **Step 4: Run tests + typecheck**

Run: `npm test -- convergence` then `npm run build`
Expected: all convergence suites PASS; `tsc` clean (proves no dangling imports of deleted symbols anywhere).

---

### Task 5: CSS — rewrite the `mc-*` block

**Files:**
- Modify: `ui/src/styles.css` (block starting at `.mc-strip`, ~:19947, through `.mc-reply__send`)

**Interfaces:**
- Consumes: class names produced in Tasks 3–4: `mc-body`, `mc-rail`, `mc-rail__empty`, `mc-rail__reset`, `mc-row` (+ `--<status>`, `--selected`, `__top`, `__title`, `__age`, `__sub`, `__activity`), `mc-detail-host`, `mc-detail` (+ `__head`, `__title`, `__actions`, `__open`, `__meta`, `__cwd`, `__question`), `mc-stop`, `mc-tail`. Kept classes: `mc-strip*`, `mc-fchip`, `mc-dot*`, `mc-pill*`, `mc-oplabel`, `mc-chip`, `mc-cost*`, `mc-perm-opts`, `mc-subagents`, `mc-subrow*`, `mc-reply*`, `mc-reconnecting`.

- [ ] **Step 1: Replace the rules**

Delete: `.mc-grid`, `.mc-grid__empty`, `.mc-grid__reset`, `.mc-card` and every `.mc-card__*` / `.mc-card--*` rule, `.mc-attention`, `.mc-attention__head`, `.mc-attention-card__age`, `.mc-avatar*` (unused by the new renderers), `.mc-chips`, `.mc-card__sub`, the second duplicate `.mc-subrow` block (`flex-direction: column` variant at the bottom, plus `.mc-subrow__head/__tab/__status` — dead since the sub-session experiment).

Sharpen kept rules: `border-radius: 0` on `.mc-reconnecting`, `.mc-fchip`, `.mc-pill`, `.mc-chip`, `.mc-cost__bar`, `.mc-reply`, `.mc-reply__send` (dots stay 50%).

Add:

```css
.mc-body { flex: 1; min-height: 0; display: flex; border: 1px solid var(--border); }
.mc-body[hidden] { display: none; }

.mc-rail {
  flex: 0 0 340px; min-width: 0; overflow-y: auto;
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column; align-content: start;
}
.mc-rail__empty { color: var(--muted); font-size: 12px; font-style: italic; padding: 16px; display: flex; gap: 10px; align-items: center; }
.mc-rail__reset, .mc-rail__empty code {
  font-style: normal; background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 0; padding: 3px 8px; font-size: 11px; color: var(--text-primary); cursor: pointer;
}

.mc-row {
  appearance: none; background: transparent; text-align: left; font: inherit;
  border: 0; border-left: 2px solid transparent; border-bottom: 1px solid var(--border);
  padding: 10px 12px; cursor: pointer;
  display: flex; flex-direction: column; gap: 3px; min-width: 0;
}
.mc-row:hover { background: rgb(var(--ink-rgb) / 0.03); }
.mc-row--selected { background: rgb(var(--ink-rgb) / 0.05); }
.mc-row--working { border-left-color: #5fff8a; }
.mc-row--operator-thinking { border-left-color: var(--accent); }
.mc-row--awaiting-input { border-left-color: #ffcf5f; }
.mc-row--blocked { border-left-color: var(--danger); }
.mc-row--idle { opacity: .6; }

.mc-row__top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.mc-row__title {
  flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: var(--text-primary); font-size: 12px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .04em;
}
.mc-row__age { color: var(--muted); font-size: 11px; flex: 0 0 auto; }
.mc-row__sub { color: var(--muted); font-size: 11px; padding-left: 15px; }
.mc-row__activity {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; color: var(--muted); padding-left: 15px;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}

.mc-detail-host { flex: 1; min-width: 0; overflow-y: auto; }
.mc-detail { padding: 18px 22px; display: flex; flex-direction: column; gap: 14px; }

.mc-detail__head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.mc-detail__title {
  margin: 0; font-size: 14px; font-weight: 600; color: var(--text-primary);
  text-transform: uppercase; letter-spacing: .05em;
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.mc-detail__actions { margin-left: auto; display: flex; gap: 8px; flex: 0 0 auto; }
.mc-detail__open, .mc-stop {
  appearance: none; background: transparent; border: 1px solid var(--border); border-radius: 0;
  color: var(--muted); cursor: pointer; font: inherit; font-size: 11px; padding: 3px 10px;
  transition: color .12s ease, border-color .12s ease, background .12s ease;
}
.mc-detail__open:hover { color: var(--text-primary); border-color: var(--text-primary); }
.mc-stop:hover {
  color: var(--danger); border-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
}

.mc-detail__meta { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
.mc-detail__meta strong { color: var(--text-primary); font-weight: 600; }
.mc-detail__cwd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.mc-detail__question { color: var(--text-primary); font-size: 13px; line-height: 1.45; margin: 0; }

.mc-tail {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; line-height: 1.4; color: var(--muted);
  background: var(--bg-overlay); border: 1px solid var(--border);
  border-radius: 0; padding: 10px 12px; margin: 0;
  max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
```

Also change `.convergence-overlay`'s `overflow: auto` to `overflow: hidden` (the rail and pane scroll internally now).

- [ ] **Step 2: Verify in the app**

Run: `npm test && npm run build`, then use the `respawn` skill to restart `tauri:dev` and open ⌘⇧M with a couple of agent tabs (`claude` in one PTY, an ACP chat in another). Check: rows fill the rail blocked-first, uppercase titles, spine-only color; selecting a row fills the pane; the tail updates ~1s; a blocked session's composer works and survives polls while focused; light theme legible (watch the `body.theme-light input` trap on `.mc-reply__textarea` — if the textarea goes white-on-white, add `body.theme-light .mc-reply__textarea { background: transparent; }` after it in the file).

- [ ] **Step 3: Commit the frontend redesign (Tasks 2–5)**

```bash
git add ui/src/api.ts ui/src/convergence ui/src/styles.css
git commit -m "feat(convergence): master-detail overlay — rail rows + live detail pane"
```

---

### Task 6: Verification gate

**Files:** none (checks only)

- [ ] **Step 1: Full test pass**

Run: `cargo test -p covenant-app && npm test && npm run build`
Expected: all green. (Do not run the full `cargo test --workspace` blindly — telegram tests hang under broad runs; `-p covenant-app` is the relevant crate.)

- [ ] **Step 2: Design audit**

Dispatch the `design-rules-auditor` agent on the branch diff (`git diff main...HEAD -- ui/`). Fix any blockers it reports, amend the frontend commit.

- [ ] **Step 3: Screenshot for the PR**

Capture the redesigned overlay (dark + light) for the PR description per repo PR conventions.
