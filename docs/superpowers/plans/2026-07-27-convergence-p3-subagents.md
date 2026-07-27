# Convergence P3 — Sub-Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ACP agent cards in Convergence show their live sub-agents as rows — label, type, running state, elapsed.

**Architecture:** The ACP forwarder already sees every `tool_call`/`tool_call_update`. A pure classifier recognizes agent-spawn tool calls (Task tool: `rawInput.subagent_type` or a `Task` title) and feeds a bounded ring on `AcpTabSession` (last 8; updates flip `running` by id; cleared on PromptDone). The ring rides `AcpMeta` → `AcpSessionInput` → `AgentCard.subagents`; the grid card renders rows when non-empty.

**Tech Stack:** Rust (crate `covenant`), TypeScript strict + Vitest. No new deps.

## Global Constraints

- Spec §P3. One level of nesting; parent status unaffected by children; ring bounded to last 8; completed rows kept until turn end.
- **Deliberate cut (spec's own escape hatch):** the PTY count-only heuristic ships as 0 — building spinner-count regexes without captured Claude Code fixtures is guesswork; the UI hides the affordance when `subagents` is empty. Revisit with real PTY captures.
- `ToolCallUpdate` frames may omit `rawInput`/`title` — updates only touch rows already in the ring, matched by `tool_call_id`; they never classify.
- Same test commands and UI rules as P1/P2 plans.

---

### Task 1: Backend — classifier + ring + wire-through

**Files:**
- Modify: `crates/app/src/convergence.rs` (`SubAgentRow`, `AgentCard.subagents`, inputs)
- Modify: `crates/app/src/acp_commands.rs` (classifier, ring on `AcpTabSession`, forwarder feed, `AcpMeta.subagents`)
- Modify: `crates/app/src/lib.rs` (thread `subagents` through the ACP input loop)

**Interfaces:**

```rust
// convergence.rs
#[derive(Debug, Clone, Serialize)]
pub struct SubAgentRow {
    pub id: String,               // tool_call_id
    pub label: String,            // rawInput.description ?? title ?? "subagent"
    pub detail: Option<String>,   // rawInput.subagent_type
    pub running: bool,
    pub started_unix_ms: u64,
}
// AgentCard gains: pub subagents: Vec<SubAgentRow>,   (empty for PTY lane)
// AcpSessionInput gains: pub subagents: Vec<SubAgentRow>,

// acp_commands.rs
pub(crate) fn subagent_from_tool_call(f: &ToolCallFields, now_unix_ms: u64)
    -> Option<crate::convergence::SubAgentRow>
// AcpTabSession gains: subagents: std::sync::Mutex<std::collections::VecDeque<SubAgentRow>> (cap 8)
//   fn feed_subagent_call(&self, f: &ToolCallFields)     — classify + insert/replace by id
//   fn feed_subagent_update(&self, f: &ToolCallFields)   — update running for known id only
//   fn clear_subagents(&self)                            — PromptDone
// AcpMeta gains: pub subagents: Vec<SubAgentRow>,
```

- [ ] **Step 1: Failing classifier tests** (acp_commands.rs `mod tests`, reusing `tool_call_fields`):

```rust
#[test]
fn subagent_from_tool_call_classifies_task_calls_only() {
    // Task via rawInput.subagent_type
    let t = tool_call_fields(
        r#"{"toolCallId":"t1","title":"Task","status":"in_progress",
            "rawInput":{"subagent_type":"Explore","description":"find phase detection","prompt":"..."}}"#,
    );
    let row = subagent_from_tool_call(&t, 42).expect("classified");
    assert_eq!(row.id, "t1");
    assert_eq!(row.label, "find phase detection");
    assert_eq!(row.detail.as_deref(), Some("Explore"));
    assert!(row.running);
    assert_eq!(row.started_unix_ms, 42);

    // Task-title without subagent_type still counts
    let bare = tool_call_fields(r#"{"toolCallId":"t2","title":"Task(review)","status":"completed"}"#);
    let row2 = subagent_from_tool_call(&bare, 0).expect("classified");
    assert_eq!(row2.label, "Task(review)");
    assert!(!row2.running); // completed → not running

    // Ordinary tools never classify
    let read = tool_call_fields(r#"{"toolCallId":"t3","kind":"read","title":"Read","rawInput":{"fileName":"a.rs"}}"#);
    assert!(subagent_from_tool_call(&read, 0).is_none());
    let exec = tool_call_fields(r#"{"toolCallId":"t4","kind":"execute","rawInput":{"command":"cargo test"}}"#);
    assert!(subagent_from_tool_call(&exec, 0).is_none());
}
```

- [ ] **Step 2: Verify failure** — `cargo test -p covenant --lib acp_commands::tests::subagent` → compile error.

- [ ] **Step 3: Implement.**

Classifier:

```rust
/// Recognize an agent-spawn tool call (Claude Code's Task tool). Updates
/// can't classify — they may omit rawInput/title; match rows by id there.
pub(crate) fn subagent_from_tool_call(
    f: &ToolCallFields,
    now_unix_ms: u64,
) -> Option<crate::convergence::SubAgentRow> {
    let ri = f.raw_input.as_ref();
    let sub_type = ri
        .and_then(|v| v.get("subagent_type"))
        .and_then(Value::as_str);
    let task_title = f
        .title
        .as_deref()
        .is_some_and(|t| t == "Task" || t.starts_with("Task("));
    if sub_type.is_none() && !task_title {
        return None;
    }
    let label = ri
        .and_then(|v| v.get("description"))
        .and_then(Value::as_str)
        .map(String::from)
        .or_else(|| f.title.clone())
        .unwrap_or_else(|| "subagent".into());
    Some(crate::convergence::SubAgentRow {
        id: f.tool_call_id.clone(),
        label,
        detail: sub_type.map(String::from),
        running: !matches!(f.status.as_deref(), Some("completed") | Some("failed")),
        started_unix_ms: now_unix_ms,
    })
}
```

Ring on `AcpTabSession` (std Mutex, lock-recover pattern): `feed_subagent_call` classifies; replaces an existing row with the same id else pushes (pop_front at 8). `feed_subagent_update` finds by `f.tool_call_id`; when found and `f.status` is Some, sets `running = !matches!(status, "completed"|"failed")`. `clear_subagents` empties.

Forwarder: in the `SessionUpdate::ToolCall(f)` arm add `tab_for_task.feed_subagent_call(f);` (needs a wall-clock `now` — same SystemTime pattern as the pending record). Add a `SessionUpdate::ToolCallUpdate(f)` arm calling `tab_for_task.feed_subagent_update(f);` (leave the world-model feed untouched — it never handled updates). Clear beside `set_pending(None)` in the PromptDone task.

Wire-through: `AcpMeta.subagents` cloned in `list_meta`; `AcpSessionInput.subagents`; `acp_agent_card` sets `subagents: inp.subagents`; `pty_agent_card` and the operator path set `subagents: Vec::new()`. Update the two card-constructing test factories (`card()` in convergence tests) with `subagents: Vec::new()`.

- [ ] **Step 4: Verify** — `cargo test -p covenant --lib acp_commands::tests::subagent && cargo test -p covenant --lib convergence && cargo check -p covenant` → green.

- [ ] **Step 5: Commit** — `feat(convergence): ACP sub-agent rows recorded per tab`

---

### Task 2: Frontend — sub-agent rows on the card

**Files:**
- Modify: `ui/src/api.ts` (`SubAgentRow`, `AgentCard.subagents`)
- Modify: `ui/src/convergence/tile.ts` + `tile.test.ts`
- Modify: `ui/src/convergence/model.test.ts`, `overlay.test.ts` (factory gains `subagents: []`)
- Modify: `ui/src/styles.css`

**Interfaces:**

```ts
export interface SubAgentRow {
  id: string; label: string; detail: string | null;
  running: boolean; started_unix_ms: number;
}
// AgentCard gains: subagents: SubAgentRow[];
```

- [ ] **Step 1: Failing test** (tile.test.ts; factory gains `subagents: []`):

```ts
it("renders sub-agent rows when present, hidden when empty", () => {
  expect(renderAgentCard(agent({}), cbs()).querySelector(".mc-subagents")).toBeNull();
  const el = renderAgentCard(
    agent({
      subagents: [
        { id: "t1", label: "find phase detection", detail: "Explore", running: true, started_unix_ms: Date.now() - 65_000 },
        { id: "t2", label: "review:bugs", detail: null, running: false, started_unix_ms: Date.now() },
      ],
    }),
    cbs(),
  );
  const rows = [...el.querySelectorAll(".mc-subrow")];
  expect(rows.length).toBe(2);
  expect(rows[0].textContent).toContain("find phase detection");
  expect(rows[0].textContent).toContain("Explore");
  expect(rows[0].textContent).toContain("1m");
  expect(rows[0].querySelector(".mc-dot--working")).not.toBeNull();
  expect(rows[1].querySelector(".mc-dot--idle")).not.toBeNull();
  expect(rows[1].textContent).toContain("done");
});
```

- [ ] **Step 2: Verify failure** — `npx vitest run ui/src/convergence/tile.test.ts`.

- [ ] **Step 3: Implement.** api.ts types. tile.ts `renderBody` appends after the activity line:

```ts
if (card.subagents.length > 0) frag.append(renderSubAgents(card.subagents));
```

`renderSubAgents(rows)`: `div.mc-subagents` with one `div.mc-subrow` per row — status dot (`mc-dot--working` running / `mc-dot--idle` done), label, muted detail (when present), and a trailing muted span: running → elapsed (`1m 05s` style: minutes+seconds under an hour, else `1h 4m`), done → `"done"`. Elapsed from `Date.now() - started_unix_ms`; the overlay's 1s poll re-renders, so no timer needed.

styles.css (next to `.mc-oplabel`):

```css
.mc-subagents { display: flex; flex-direction: column; gap: 2px; margin-top: 6px; }
.mc-subrow { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.mc-subrow__detail, .mc-subrow__age { color: var(--muted); font-size: 11px; }
.mc-subrow__age { margin-left: auto; }
```

Fix factories in model.test.ts / overlay.test.ts (`subagents: []`).

- [ ] **Step 4: Verify** — `npx vitest run ui/src/convergence && npm run build` → green.

- [ ] **Step 5: Commit** — `feat(convergence): sub-agent rows on ACP agent cards`

---

### Task 3: Full verification

- [ ] `cargo test -p covenant --lib` (modulo the two pre-existing `context::tests` env failures) + `cargo fmt --all` + `cargo clippy -p covenant --all-targets` clean.
- [ ] `npm test` from repo root — green.
- [ ] Manual smoke (user, dev app): ACP tab where the agent spawns Task subagents → rows appear under the card with live elapsed, flip to "done", vanish at turn end.
- [ ] Commit fixups if any.
