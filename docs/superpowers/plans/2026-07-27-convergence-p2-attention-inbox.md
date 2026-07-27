# Convergence P2 — Attention Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ⌘⇧M leads with a unified answerable "needs you" queue — ACP permission prompts, PTY Waiting states, operator escalations — each with inline actions; the agent grid demotes below it.

**Architecture:** `AcpTabSession` records its currently-pending permission (set at the forwarder's `PermissionPending` emit, cleared on answer/turn-end). The snapshot builder unions three blocked signals into `AttentionItem` (replacing `EscalationCard`); the overlay renders the queue above the grid and excludes queued sessions from the grid. All three reply paths already exist (`acp_respond_permission`, `write_to_session`, `submit_convergence_reply`) — this wires them into one surface.

**Tech Stack:** Rust (crate `covenant`), TypeScript strict + Vitest. No new deps.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-convergence-rework-design.md` §P2. Builds on P1 (already merged into this branch).
- Poll stays 1s while open; no push (spec decision Q3).
- PTY question extraction stays heuristic — the queue card must always show the screen excerpt; never parse PTY prompts into structured options.
- Deliberate simplification vs spec: the ACP permission card gets **option buttons only**, no free-text reply — a pending permission is resolved by an option, not prose (`ponytail:` comment at the render site).
- `get_blocked_session_ids` (tab-strip dots) now returns ALL attention session ids — a tab needing you shows a dot regardless of kind.
- `AttentionItem.since_unix_ms: Option<u64>` — `None` for PtyWaiting (NotchHub keeps no wall-clock; items without a timestamp sort after timestamped ones, UI shows no age).
- Rust tests: `cargo test -p covenant --lib convergence` / `--lib acp_commands`; FE tests from repo ROOT via `npx vitest run ui/src/convergence`.
- UI: sharp corners, no emoji glyphs in chrome, English copy, `attachTooltip` (never `element.title`).

## File Structure

- `crates/app/src/convergence.rs` — `AttentionKind`, `AttentionItem`, `PendingAcpPermission` + `PermissionChoice`, reshaped assembly (EscalationCard deleted).
- `crates/app/src/acp_commands.rs` — pending-permission record/clear on `AcpTabSession`; `list_meta` → `Vec<AcpMeta>`.
- `crates/app/src/lib.rs` — builder passes pending through; `get_blocked_session_ids` maps attention.
- `ui/src/api.ts` — type reshape (EscalationCard → AttentionItem).
- `ui/src/convergence/model.ts` — `attentionIndex`, `sortAttention`, `sortAgents` reads attention timestamps.
- `ui/src/convergence/attention.ts` (new) + `attention.test.ts` — `renderAttentionCard` for the three kinds.
- `ui/src/convergence/tile.ts` — exports `renderReply`; blocked-with-escalation body moves to attention.ts (grid cards lose the composer).
- `ui/src/convergence/overlay.ts` — queue section above grid; grid excludes queued sessions; summary/filters.
- `ui/src/styles.css` — `.mc-attention*`, `.mc-perm-opts` rules.

---

### Task 1: Backend — `PendingAcpPermission` recorded on the ACP tab

**Files:**
- Modify: `crates/app/src/convergence.rs` (structs + pure builder fn + tests)
- Modify: `crates/app/src/acp_commands.rs` (field, record/clear, `AcpMeta`)

**Interfaces:**
- Produces (convergence.rs):

```rust
#[derive(Debug, Clone, Serialize)]
pub struct PermissionChoice {
    pub option_id: String,
    /// "allow_once" | "allow_always" | "reject_once" (open set).
    pub kind: String,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PendingAcpPermission {
    pub request_key: String,
    /// Human line: tool title, else rawInput.command, else kind, else "permission".
    pub title: String,
    pub options: Vec<PermissionChoice>,
    pub since_unix_ms: u64,
}
```

- Produces (acp_commands.rs):

```rust
/// Pure: build the convergence-facing pending record from a wire request.
pub(crate) fn pending_from_request(
    request_key: &str,
    request: &PermissionRequest,
    now_unix_ms: u64,
) -> crate::convergence::PendingAcpPermission

pub struct AcpMeta {
    pub session_id: SessionId,
    pub executor: String,
    pub cwd: Option<String>,
    pub pending: Option<crate::convergence::PendingAcpPermission>,
}
impl AcpRegistry { pub async fn list_meta(&self) -> Vec<AcpMeta> }  // replaces the tuple version
```

- `AcpTabSession` gains `pending_permission: std::sync::Mutex<Option<PendingAcpPermission>>`.

- [ ] **Step 1: Write the failing test** (in `acp_commands.rs` `mod tests`, which already has `PermissionRequest` fixtures):

```rust
#[test]
fn pending_from_request_derives_title_and_choices() {
    let req: PermissionRequest = serde_json::from_value(json!({
        "sessionId": "s1",
        "toolCall": { "toolCallId": "t1", "kind": "execute", "rawInput": { "command": "npm test" } },
        "options": [
            { "optionId": "allow_once", "kind": "allow_once", "name": "Allow once" },
            { "optionId": "reject", "kind": "reject_once" }
        ]
    }))
    .expect("fixture parses");
    let p = pending_from_request("perm-7", &req, 1234);
    assert_eq!(p.request_key, "perm-7");
    assert_eq!(p.title, "npm test"); // no title → falls back to rawInput.command
    assert_eq!(p.since_unix_ms, 1234);
    assert_eq!(p.options.len(), 2);
    assert_eq!(p.options[0].option_id, "allow_once");
    assert_eq!(p.options[0].name.as_deref(), Some("Allow once"));
    assert_eq!(p.options[1].name, None);
}

#[test]
fn pending_from_request_prefers_explicit_title() {
    let req: PermissionRequest = serde_json::from_value(json!({
        "sessionId": "s1",
        "toolCall": { "toolCallId": "t1", "title": "Write src/main.rs", "kind": "edit" },
        "options": [{ "optionId": "a", "kind": "allow_once" }]
    }))
    .expect("fixture parses");
    assert_eq!(pending_from_request("k", &req, 0).title, "Write src/main.rs");
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p covenant --lib acp_commands::tests::pending_from_request`
Expected: compile error — `pending_from_request` not found.

- [ ] **Step 3: Implement.**

convergence.rs: add the two structs (near `AgentCard`).

acp_commands.rs:

```rust
pub(crate) fn pending_from_request(
    request_key: &str,
    request: &PermissionRequest,
    now_unix_ms: u64,
) -> crate::convergence::PendingAcpPermission {
    let tc = &request.tool_call;
    let title = tc
        .title
        .clone()
        .or_else(|| tc.command().map(String::from))
        .or_else(|| tc.kind.clone())
        .unwrap_or_else(|| "permission".into());
    crate::convergence::PendingAcpPermission {
        request_key: request_key.into(),
        title,
        options: request
            .options
            .iter()
            .map(|o| crate::convergence::PermissionChoice {
                option_id: o.option_id.clone(),
                kind: o.kind.clone(),
                name: o.name.clone(),
            })
            .collect(),
        since_unix_ms: now_unix_ms,
    }
}
```

Wire the lifecycle (no test — thin glue over the tested pure fn):
1. Field on `AcpTabSession`: `pending_permission: std::sync::Mutex<Option<crate::convergence::PendingAcpPermission>>` — init `std::sync::Mutex::new(None)` at both construction sites (search `world: std::sync::Mutex::new`).
2. **Record**: in the forwarder, right before `app_for_task.emit(&topic_for_task, &payload)`, add:

```rust
if let AcpTabEvent::PermissionPending { request_key, request } = &payload {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let rec = pending_from_request(request_key, request, now);
    match tab_for_task.pending_permission.lock() {
        Ok(mut g) => *g = Some(rec),
        Err(poisoned) => *poisoned.into_inner() = Some(rec),
    }
}
```

3. **Clear** (set `None` with the same lock-recover pattern) in:
   - `acp_respond_permission` (human answered),
   - the `AcpTabEvent::PromptDone` emit path in `acp_send_prompt` (turn ended — covers cancelled/stale prompts).
4. `list_meta` reshape to `Vec<AcpMeta>`, cloning the pending record under the std lock. Update the P1 call site in `lib.rs` (`for (id, executor, cwd) in ...` → `for m in ...`; pending threaded in Task 2).

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p covenant --lib acp_commands::tests::pending && cargo check -p covenant`
Expected: 2 pass; crate compiles (lib.rs updated for `AcpMeta`).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/convergence.rs crates/app/src/acp_commands.rs crates/app/src/lib.rs
git commit -m "feat(acp): record pending permission per tab for convergence"
```

---

### Task 2: Backend — `AttentionItem` replaces `EscalationCard`

**Files:**
- Modify: `crates/app/src/convergence.rs`
- Modify: `crates/app/src/lib.rs` (`get_blocked_session_ids`)

**Interfaces:**
- Produces:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttentionKind { AcpPermission, PtyWaiting, OperatorEscalation }

#[derive(Debug, Clone, Serialize)]
pub struct AttentionItem {
    pub session_id: String,
    pub tab_title: String,
    pub tab_color: Option<String>,
    pub lane: Lane,
    pub executor: Option<String>,
    pub kind: AttentionKind,
    /// What's being asked: operator question / permission title / waiting reason.
    pub question: Option<String>,
    /// Raw context: last ~15 screen lines (PTY lanes); None for ACP.
    pub excerpt: Option<String>,
    /// ACP only: the pending permission (options answer inline).
    pub permission: Option<PendingAcpPermission>,
    pub operator_name: Option<String>,
    pub operator_avatar: Option<String>,
    pub mission_name: Option<String>,
    pub since_unix_ms: Option<u64>,
}

pub struct ConvergenceSnapshot { pub agents: Vec<AgentCard>, pub attention: Vec<AttentionItem> }
pub fn assemble_snapshot(op_rows: Vec<BuiltRow>, agent_cards: Vec<AgentCard>) -> ConvergenceSnapshot
```

- `EscalationCard` struct is DELETED. `BuiltRow` unchanged. Sort: timestamped items oldest-first, `None` timestamps after them (stable by session_id).
- `SessionInput` unchanged; `pty_agent_card` signature unchanged. The operator-less PTY branch in `build_convergence_snapshot` now also snapshots the tail when the phase is Waiting; `AcpSessionInput` gains `pub pending: Option<PendingAcpPermission>`.

- [ ] **Step 1: Rewrite the assembly tests.** Replace the two P1 `assemble_*` tests with:

```rust
fn waiting_card(sid: &str) -> AgentCard {
    let mut c = card(sid, TileStatus::Blocked, None);
    c.phase_label = Some("waiting: permission".into());
    c
}

#[test]
fn assemble_attention_unifies_three_kinds_timestamped_first() {
    // operator escalation @200
    let op = BuiltRow {
        card: card("op1", TileStatus::Blocked, Some("o1")),
        escalated_at_unix_ms: 200,
        executor_excerpt: Some("tail".into()),
        question: Some("q?".into()),
    };
    // acp permission @100 (older → leads)
    let mut acp = card("acp1", TileStatus::Blocked, None);
    acp.lane = Lane::Acp;
    acp.permission_for_attention = Some(PendingAcpPermission {
        request_key: "k1".into(),
        title: "npm test".into(),
        options: vec![],
        since_unix_ms: 100,
    });
    // pty waiting, no timestamp → last
    let pty = waiting_card("pty1");

    let snap = assemble_snapshot(vec![op], vec![acp, pty]);
    let kinds: Vec<_> = snap.attention.iter().map(|a| (a.session_id.as_str(), a.kind)).collect();
    assert_eq!(kinds, vec![
        ("acp1", AttentionKind::AcpPermission),
        ("op1", AttentionKind::OperatorEscalation),
        ("pty1", AttentionKind::PtyWaiting),
    ]);
    assert_eq!(snap.attention[0].question.as_deref(), Some("npm test"));
    assert_eq!(snap.attention[1].excerpt.as_deref(), Some("tail"));
    assert_eq!(snap.attention[2].since_unix_ms, None);
    assert_eq!(snap.agents.len(), 3); // every attention session still has its card
}

#[test]
fn assemble_non_blocked_produce_no_attention() {
    let snap = assemble_snapshot(
        vec![op_row("a", TileStatus::Working, "o1", 0)],
        vec![card("b", TileStatus::Idle, None)],
    );
    assert!(snap.attention.is_empty());
}
```

Notes for the implementer: to carry the pending record and excerpt from card-building into assembly, extend `AgentCard`-producing paths with two **non-serialized carrier fields** is NOT allowed (AgentCard is the wire type). Instead change `assemble_snapshot`'s second parameter to `Vec<AgentCardInput>`:

```rust
/// Agent-lane card + attention carriers that don't belong on the wire card.
pub struct AgentCardInput {
    pub card: AgentCard,
    pub permission_for_attention: Option<PendingAcpPermission>,
    pub waiting_excerpt: Option<String>,
}
```

`pty_agent_card`/`acp_agent_card` keep returning `AgentCard`; the builder wraps them. The test above then uses `AgentCardInput { card: acp, permission_for_attention: Some(...), waiting_excerpt: None }` etc. — adjust the fixture accordingly (the sketch shows intent; the compiling shape is the `AgentCardInput` wrapper).

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p covenant --lib convergence`
Expected: compile errors (EscalationCard gone / new types missing).

- [ ] **Step 3: Implement.**

- Delete `EscalationCard`; add `AttentionKind`, `AttentionItem`, `AgentCardInput`.
- `assemble_snapshot(op_rows: Vec<BuiltRow>, agent_inputs: Vec<AgentCardInput>)`:
  - op rows with `Blocked` → `AttentionItem { kind: OperatorEscalation, question: b.question, excerpt: b.executor_excerpt, permission: None, since_unix_ms: Some(b.escalated_at_unix_ms), executor/lane/operator fields from card }`.
  - agent inputs with `card.status == Blocked`:
    - `permission_for_attention` Some → `AcpPermission`, `question: Some(p.title)`, `since_unix_ms: Some(p.since_unix_ms)`, `permission: Some(p)`.
    - else → `PtyWaiting`, `question: card.phase_label.clone()`, `excerpt: waiting_excerpt`, `since_unix_ms: None`.
  - Sort: `(since_unix_ms.is_none(), since_unix_ms.unwrap_or(u64::MAX), session_id)` ascending.
  - `agents` = op cards + agent cards (unchanged flattening).
- Builder changes:
  - Operator-less PTY branch: when the produced card's status is Blocked, snapshot the tail (`lock_recover(&s.op_state).snapshot_tail(8 * 1024)` → `last_non_empty_lines(&tail, 15, 200)`) into `waiting_excerpt`.
  - ACP loop: `AcpSessionInput` gains `pending: Option<PendingAcpPermission>`; wrap `acp_agent_card` output with `permission_for_attention: inp.pending` (move `pending` out before the card build). **Card status override**: when `pending` is Some but the notch phase isn't Waiting (race), force status Blocked so card and queue agree.
- lib.rs: ACP input loop copies `pending: m.pending` from `AcpMeta`; `get_blocked_session_ids` maps `snap.attention` (rename nothing — same command name, now returns every attention session id; update its doc comment).

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p covenant --lib convergence && cargo check -p covenant`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/convergence.rs crates/app/src/lib.rs
git commit -m "feat(convergence): unified AttentionItem replaces EscalationCard"
```

---

### Task 3: Frontend types + model

**Files:**
- Modify: `ui/src/api.ts` (replace `EscalationCard` types)
- Modify: `ui/src/convergence/model.ts`, `ui/src/convergence/model.test.ts`

**Interfaces:**
- Produces (api.ts):

```ts
export type AttentionKind = "acp-permission" | "pty-waiting" | "operator-escalation";

export interface PermissionChoice { option_id: string; kind: string; name: string | null; }
export interface PendingAcpPermission {
  request_key: string; title: string; options: PermissionChoice[]; since_unix_ms: number;
}

export interface AttentionItem {
  session_id: string; tab_title: string; tab_color: string | null;
  lane: Lane; executor: string | null; kind: AttentionKind;
  question: string | null; excerpt: string | null;
  permission: PendingAcpPermission | null;
  operator_name: string | null; operator_avatar: string | null;
  mission_name: string | null; since_unix_ms: number | null;
}

export interface ConvergenceSnapshot { agents: AgentCard[]; attention: AttentionItem[]; }
```

`EscalationCard` interface deleted (grep for remaining importers: only convergence files).

- Produces (model.ts): `attentionIndex(items: AttentionItem[]): Map<string, AttentionItem>` (replaces `escalationIndex`), `sortAgents(agents: AgentCard[], attention: AttentionItem[]): AgentCard[]` (blocked ordering now keys off `attentionIndex` timestamps; `null`/missing → `Infinity`). Backend pre-sorts `attention`, so no FE `sortAttention`.

- [ ] **Step 1: Update model.test.ts** — replace the `esc()` factory + assertions:

```ts
const att = (sid: string, at: number | null): AttentionItem => ({
  session_id: sid, tab_title: sid, tab_color: null, lane: "pty",
  executor: "claude", kind: "operator-escalation", question: "q?",
  excerpt: null, permission: null, operator_name: "o",
  operator_avatar: null, mission_name: null, since_unix_ms: at,
});
```

`escalationIndex` describe block → `attentionIndex` (same shape). `sortAgents` test: same expectation as P1 but escalations replaced by `[att("blockNew", 200), att("blockOld", 100)]` (blocked without an attention timestamp still sorts after).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/convergence/model.test.ts`
Expected: FAIL (type/import errors).

- [ ] **Step 3: Implement** api.ts + model.ts per the interfaces (in `sortAgents`, build `at` map from `since_unix_ms ?? Infinity`).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run ui/src/convergence/model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/convergence/model.ts ui/src/convergence/model.test.ts
git commit -m "feat(convergence): AttentionItem FE types + model"
```

---

### Task 4: Frontend — `renderAttentionCard`

**Files:**
- Create: `ui/src/convergence/attention.ts`
- Create: `ui/src/convergence/attention.test.ts`
- Modify: `ui/src/convergence/tile.ts` (export `renderReply`; drop the blocked/escalation body branch — grid cards always render the activity body now)
- Modify: `ui/src/convergence/tile.test.ts` (the "blocked operator card shows question..." test moves to attention.test.ts; blocked grid test asserts activity body)
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes: `acpRespondPermission`, `acpSendPrompt` NOT used (simplification), `writeToSession` from `../api`; `renderReply`, `ReplyScope` from `./tile`.
- Produces:

```ts
export interface AttentionCallbacks {
  onFocus: (sessionId: string, keepOpen: boolean) => void;
  /// operator-escalation reply (existing pipe)
  onOperatorReply: (sessionId: string, text: string, scope: ReplyScope) => Promise<void>;
  /// acp-permission answer
  onPermission: (sessionId: string, requestKey: string, optionId: string) => void;
  /// pty-waiting reply — writes text + Enter to the PTY
  onPtyReply: (sessionId: string, text: string) => void;
}
export function renderAttentionCard(item: AttentionItem, cb: AttentionCallbacks): HTMLElement
```

- [ ] **Step 1: Write attention.test.ts**

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderAttentionCard, type AttentionCallbacks } from "./attention";
import type { AttentionItem } from "../api";

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  session_id: "s1", tab_title: "deploy", tab_color: null, lane: "pty",
  executor: "claude", kind: "operator-escalation", question: "OK to push?",
  excerpt: null, permission: null, operator_name: "Zeta",
  operator_avatar: null, mission_name: null, since_unix_ms: 100, ...over,
});

const cbs = (): AttentionCallbacks => ({
  onFocus: vi.fn(), onOperatorReply: vi.fn(async () => {}),
  onPermission: vi.fn(), onPtyReply: vi.fn(),
});

describe("renderAttentionCard", () => {
  it("acp-permission renders option buttons and answers with option_id", () => {
    const c = cbs();
    const el = renderAttentionCard(item({
      kind: "acp-permission", lane: "acp", question: "npm test",
      permission: {
        request_key: "k1", title: "npm test", since_unix_ms: 1,
        options: [
          { option_id: "allow_once", kind: "allow_once", name: "Allow once" },
          { option_id: "rej", kind: "reject_once", name: null },
        ],
      },
    }), c);
    const btns = [...el.querySelectorAll<HTMLButtonElement>(".mc-perm-opts button")];
    expect(btns.map((b) => b.textContent)).toEqual(["Allow once", "reject once"]);
    btns[0].click();
    expect(c.onPermission).toHaveBeenCalledWith("s1", "k1", "allow_once");
    expect(el.querySelector(".mc-reply")).toBeNull(); // options answer it, no prose
  });

  it("pty-waiting renders excerpt and submits a PTY reply", () => {
    const c = cbs();
    const el = renderAttentionCard(item({
      kind: "pty-waiting", question: "waiting: input",
      excerpt: "Overwrite migrations/v2.sql? [y/N]",
    }), c);
    expect(el.querySelector(".mc-card__tail")?.textContent).toContain("Overwrite");
    const ta = el.querySelector<HTMLTextAreaElement>(".mc-reply__textarea")!;
    ta.value = " y ";
    el.querySelector<HTMLButtonElement>(".mc-reply__send")!.click();
    expect(c.onPtyReply).toHaveBeenCalledWith("s1", "y");
  });

  it("operator-escalation renders question, excerpt and scoped composer", async () => {
    const c = cbs();
    const el = renderAttentionCard(item({ excerpt: "the tail" }), c);
    expect(el.querySelector(".mc-card__question")?.textContent).toBe("OK to push?");
    expect(el.querySelector(".mc-card__tail")?.textContent).toBe("the tail");
    const ta = el.querySelector<HTMLTextAreaElement>(".mc-reply__textarea")!;
    ta.value = "go";
    el.querySelector<HTMLButtonElement>(".mc-reply__send")!.click();
    await Promise.resolve();
    expect(c.onOperatorReply).toHaveBeenCalledWith("s1", "go", "one-shot");
  });

  it("every kind gets a jump-to-tab affordance", () => {
    const c = cbs();
    const el = renderAttentionCard(item({}), c);
    el.querySelector<HTMLButtonElement>(".mc-card__tab")!.click();
    expect(c.onFocus).toHaveBeenCalledWith("s1", false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/convergence/attention.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement attention.ts.**

Structure: `article.mc-card.mc-card--blocked.mc-attention-card` with `dataset.sessionId`. Header like the grid card (dot + executor + `→ tab_title` button + "NEEDS YOU" pill + operator label when `operator_name`). Body per kind:
- `acp-permission`: `.mc-card__question` = `question ?? permission.title`; `.mc-perm-opts` row — one button per option, label `name ?? kind.replace(/_/g, " ")`, click → `cb.onPermission(item.session_id, permission.request_key, option_id)`. `// ponytail: options answer the prompt; free-text reply deferred — a permission resolves by option, not prose.`
- `pty-waiting`: `.mc-card__question` = question; excerpt `pre.mc-card__tail`; PTY composer — reuse the textarea/send markup of `renderReply` but WITHOUT the scope select: build a small local composer that calls `cb.onPtyReply(sid, text.trim())` (⌘↩ and click; clear after send).
- `operator-escalation`: question + tail + `renderReply(item.session_id, cb.onOperatorReply)` imported from tile.ts.

tile.ts: `export function renderReply(...)` (make public, unchanged body); delete the `if (card.status === "blocked" && esc)` branch in `renderBody` and the now-unused `esc` parameter of `renderAgentCard`/`renderBody` (`renderAgentCard(card, cb)`); grid blocked cards just show phase label + activity (queue owns the interaction). Update tile.test.ts: drop the escalation-body and send-button tests (they moved here), fix `renderAgentCard` arity, keep the blocked-agent-card test (no composer).

styles.css (next to `.mc-card` rules):

```css
.mc-attention { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.mc-attention__head { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); }
.mc-perm-opts { display: flex; gap: 6px; margin-top: 8px; }
.mc-perm-opts button { appearance: none; border: 1px solid var(--border-color, #333); background: transparent; color: var(--text-primary); padding: 4px 10px; font-size: 12px; cursor: pointer; border-radius: 0; }
.mc-perm-opts button:hover { border-color: var(--text-primary); }
```

(match existing token names used by `.mc-*` rules — adjust `--border-color` to whatever `.mc-reply__send` uses).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run ui/src/convergence/attention.test.ts ui/src/convergence/tile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/convergence/attention.ts ui/src/convergence/attention.test.ts ui/src/convergence/tile.ts ui/src/convergence/tile.test.ts ui/src/styles.css
git commit -m "feat(convergence): attention cards — inline permission/PTY/operator replies"
```

---

### Task 5: Overlay — queue above grid

**Files:**
- Modify: `ui/src/convergence/overlay.ts`, `ui/src/convergence/overlay.test.ts`

**Interfaces:**
- Consumes: `renderAttentionCard` (attention.ts), `attentionIndex`/`sortAgents` (model.ts), `acpRespondPermission`, `writeToSession` (api.ts). Public class surface unchanged.

- [ ] **Step 1: Update overlay.test.ts.** Fixtures switch `escalations` → `attention`; the api mock adds `acpRespondPermission: vi.fn()` and `writeToSession: vi.fn()`. New/updated assertions:

```ts
it("renders the attention queue above the grid and excludes queued sessions from it", async () => {
  getSnap.mockResolvedValue({
    agents: [
      agent({ session_id: "s1", tab_title: "alpha" }),
      agent({ session_id: "s2", tab_title: "beta", status: "blocked" }),
    ],
    attention: [attItem({ session_id: "s2" })],
  });
  ov.open();
  await ov.refreshForTest();
  await ov.refreshForTest();
  expect(document.querySelectorAll(".mc-attention .mc-attention-card").length).toBe(1);
  const gridCards = [...document.querySelectorAll(".mc-grid .mc-card")];
  expect(gridCards.map((c) => (c as HTMLElement).dataset.sessionId)).toEqual(["s1"]);
  expect(document.querySelector(".mc-strip__summary")?.textContent).toContain("1 needs you");
});
```

(`attItem` = the Task 4 `item()` factory inlined; existing last-good and empty-state tests keep their intent with `attention: []`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/convergence/overlay.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**

- Mount: insert `const attention = document.createElement("div"); attention.className = "mc-attention";` between strip and grid; keep a ref.
- `render()`:
  - Queue: for each `this.snap.attention` (backend pre-sorted) → `renderAttentionCard(item, { onFocus, onOperatorReply: this.submitReply.bind(this), onPermission: (sid, key, opt) => { void acpRespondPermission(sid as SessionId, key, opt).catch(...); void this.refresh(); }, onPtyReply: (sid, text) => { void writeToSession(sid as SessionId, new TextEncoder().encode(text + "\r")).catch(...); void this.refresh(); } })`. Hide the section (`attention.hidden`) when empty.
  - Grid: `visibleAgents()` additionally filters out sessions present in `attentionIndex(this.snap.attention)` (except under the `"needs you"` filter, where the grid renders nothing and only the queue shows).
  - Summary: needs-you count = `attention.length`; working/idle counts unchanged.
  - Empty state: only when `agents.length === 0 && attention.length === 0`.
- Keyboard nav: unchanged (moves through grid cards only — queue cards are pointer/tab targets).

- [ ] **Step 4: Run full FE + typecheck**

Run: `npx vitest run ui/src/convergence && npm run build`
Expected: green; tsc clean (any straggler `EscalationCard` import dies here).

- [ ] **Step 5: Commit**

```bash
git add ui/src/convergence/overlay.ts ui/src/convergence/overlay.test.ts
git commit -m "feat(convergence): attention inbox leads the overlay"
```

---

### Task 6: Full verification

- [ ] **Step 1:** `cargo test -p covenant --lib && cargo fmt --all && cargo clippy -p covenant --all-targets 2>&1 | tail -5` — green modulo the two pre-existing `context::tests::runtime_*` env failures; commit any fmt diff.
- [ ] **Step 2:** `npm test 2>&1 | tail -8` from repo root — all green.
- [ ] **Step 3:** Manual smoke (user, dev app): ACP permission prompt → queue card with option buttons that answer it; `claude` PTY waiting on y/N → queue card, reply "y" lands in the terminal; operator escalation → scoped composer as before; tab-strip dot appears for an ACP permission.
- [ ] **Step 4:** `git add -u && git commit -m "fix(convergence): P2 verification fixups"` (skip if clean).
