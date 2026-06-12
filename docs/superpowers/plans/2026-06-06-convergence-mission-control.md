# Convergence → Mission Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dead Convergence inbox|roster two-pane with a live operator card grid (Mission Control), and fix the Phase-C regression that made it render blank.

**Architecture:** Backend snapshot (`get_convergence_snapshot`) is reused as-is except for lock-poison hardening. The frontend bridge is fixed to enumerate live panes for valid session ids (the root cause), then the overlay is rewritten to a single card grid with a header strip; "blocked" becomes an expandable card state rather than a separate inbox.

**Tech Stack:** TypeScript + vanilla DOM + vitest (jsdom); Rust + Tokio; Tauri IPC.

**Spec:** `docs/superpowers/specs/2026-06-06-convergence-mission-control-design.md`

**Conventions:**
- Run all TS tests: `npm test` (root). Single file: `npx vitest run ui/src/<path>.test.ts`.
- Run Rust tests: `cargo test -p covenant <filter>`.
- Commit per task (Conventional Commits). End commit messages with the Co-Authored-By trailer already used in this repo.
- `docs/superpowers/` is gitignored — do NOT try to `git add` plan/spec files.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `ui/src/convergence/hints.ts` | Pure: build per-pane `SessionHint[]` from tabs | **Create** |
| `ui/src/convergence/hints.test.ts` | Tests for hint building (the regression test) | **Create** |
| `ui/src/tabs/manager.ts` | Add public `listSessionHints()` | **Modify** |
| `ui/src/convergence/tabs-bridge.ts` | Use `listSessionHints()`, drop the unchecked cast | **Rewrite** |
| `crates/app/src/convergence.rs` | `lock_recover()` helper + use it; tests | **Modify** |
| `ui/src/convergence/model.ts` | Pure: status priority, sort, escalation join | **Create** |
| `ui/src/convergence/model.test.ts` | Tests for the view model | **Create** |
| `ui/src/convergence/tile.ts` | `renderOperatorCard` (single + multi + blocked) | **Rewrite** |
| `ui/src/convergence/tile.test.ts` | Tests for card rendering | **Create** |
| `ui/src/convergence/overlay.ts` | Grid + header strip + resilient refresh | **Rewrite** |
| `ui/src/convergence/overlay.test.ts` | Tests for refresh resilience | **Create** |
| `ui/src/styles.css` | `.mc-*` styles; retire `.cv-*` v2 block | **Modify** |

**Out of scope (follow-up, per spec §6.5):** the `▤ compact` table mode. The MVP header omits the toggle; do not stub a non-functional control.

---

## Task 1: Fix the data bridge (root cause)

This task alone makes Convergence render again (with the current UI) by sending valid session ids.

**Files:**
- Create: `ui/src/convergence/hints.ts`
- Test: `ui/src/convergence/hints.test.ts`
- Modify: `ui/src/tabs/manager.ts` (add method; add import)
- Rewrite: `ui/src/convergence/tabs-bridge.ts`

- [ ] **Step 1: Write the failing test**

`ui/src/convergence/hints.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { sessionHintsFromTabs, type HintTab } from "./hints";

const tab = (over: Partial<HintTab>): HintTab => ({
  panes: [{ sessionId: "s1" }],
  defaultTitle: "zsh 1",
  customName: null,
  color: null,
  ...over,
});

describe("sessionHintsFromTabs", () => {
  it("emits one hint per shell tab using defaultTitle", () => {
    expect(sessionHintsFromTabs([tab({})])).toEqual([
      { sessionId: "s1", title: "zsh 1", color: null },
    ]);
  });

  it("prefers a trimmed customName over defaultTitle", () => {
    const out = sessionHintsFromTabs([tab({ customName: "  awareness  " })]);
    expect(out[0].title).toBe("awareness");
  });

  it("falls back to defaultTitle when customName is blank", () => {
    const out = sessionHintsFromTabs([tab({ customName: "   " })]);
    expect(out[0].title).toBe("zsh 1");
  });

  it("emits a hint for EACH pane of a split tab", () => {
    const out = sessionHintsFromTabs([
      tab({ panes: [{ sessionId: "a" }, { sessionId: "b" }], color: "#f00" }),
    ]);
    expect(out.map((h) => h.sessionId)).toEqual(["a", "b"]);
    expect(out.every((h) => h.color === "#f00")).toBe(true);
  });

  it("skips panes without a live session (e.g. browser panes)", () => {
    const out = sessionHintsFromTabs([
      tab({ panes: [{ sessionId: null }, { sessionId: "x" }] }),
    ]);
    expect(out.map((h) => h.sessionId)).toEqual(["x"]);
  });

  it("never yields an undefined session_id (the Phase-C regression)", () => {
    const out = sessionHintsFromTabs([tab({ panes: [{ sessionId: null }] })]);
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/convergence/hints.test.ts`
Expected: FAIL — `Cannot find module './hints'`.

- [ ] **Step 3: Create the pure helper**

`ui/src/convergence/hints.ts`:

```ts
/// A per-session hint sent with the Convergence snapshot command.
/// `sessionId` is REQUIRED and must be a real string. Sending `undefined`
/// (the Phase-C regression — Tab.sessionId was removed but the bridge
/// still read it) makes the Rust `TabHint { session_id: String }`
/// deserialize fail, which rejects the whole snapshot and blanks the
/// overlay. See spec 2026-06-06.
export interface SessionHint {
  sessionId: string;
  title: string;
  color: string | null;
}

/// Minimal structural view of a tab — only what hint-building reads.
/// Structural so tests pass plain objects without a full `Tab`.
export interface HintTab {
  panes: ReadonlyArray<{ sessionId: string | null }>;
  defaultTitle: string;
  customName: string | null;
  color: string | null;
}

/// One hint per *pane* that owns a live session. Split tabs contribute
/// both panes; panes with `sessionId === null` (browser panes) are
/// skipped — that skip is exactly what prevents an undefined session id
/// from reaching the backend.
export function sessionHintsFromTabs(
  tabs: ReadonlyArray<HintTab>,
): SessionHint[] {
  const out: SessionHint[] = [];
  for (const t of tabs) {
    const title = t.customName?.trim() || t.defaultTitle || "untitled";
    for (const p of t.panes) {
      if (!p.sessionId) continue;
      out.push({ sessionId: p.sessionId, title, color: t.color });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/convergence/hints.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Add `listSessionHints()` to TabManager**

In `ui/src/tabs/manager.ts`, add the import near the other tab-local imports (top of file, after existing imports):

```ts
import { sessionHintsFromTabs, type SessionHint } from "../convergence/hints";
```

Then add this public method to the `TabManager` class (place it next to `activateBySessionId`, the other method the bridge calls):

```ts
  /// Per-session hints for the Convergence snapshot — one per live pane,
  /// across every tab (split tabs contribute both panes). Public + typed
  /// so the convergence bridge never reaches into private fields through
  /// an unchecked cast; that cast silently broke when Phase C moved
  /// `sessionId` from `Tab` onto `Pane`. See spec 2026-06-06.
  listSessionHints(): SessionHint[] {
    return sessionHintsFromTabs(this.tabs);
  }
```

(`this.tabs` is `Tab[]`; each `Tab` is structurally a `HintTab` — it has `panes`, `defaultTitle`, `customName`, `color`.)

- [ ] **Step 6: Rewrite the bridge to use it**

Replace the entire contents of `ui/src/convergence/tabs-bridge.ts` with:

```ts
import type { TabManager } from "../tabs/manager";
import type { ConvergenceTabBridge } from "./overlay";

/// Bridges the Convergence overlay to the live tab set. Uses the public
/// `TabManager.listSessionHints()` (one hint per live pane) — no casts,
/// no reaching into private fields. The previous version cast the
/// manager to an internal shape and read `tab.sessionId`, which Phase C
/// removed; that produced `session_id: undefined` and rejected the
/// snapshot. See spec 2026-06-06.
export function makeTabsBridge(manager: TabManager): ConvergenceTabBridge {
  return {
    listTabs: () =>
      manager.listSessionHints().map((h) => ({
        sessionId: h.sessionId,
        title: h.title,
        color: h.color,
      })),
    activateBySessionId: (id, _opts) =>
      manager.activateBySessionId(
        id as Parameters<typeof manager.activateBySessionId>[0],
      ),
  };
}
```

- [ ] **Step 7: Typecheck + full test run**

Run: `npm run build` (runs `tsc`) — Expected: no type errors.
Run: `npm test` — Expected: PASS (existing suite + the 6 new hint tests).

- [ ] **Step 8: Commit**

```bash
git add ui/src/convergence/hints.ts ui/src/convergence/hints.test.ts ui/src/tabs/manager.ts ui/src/convergence/tabs-bridge.ts
git commit -m "$(cat <<'EOF'
fix(convergence): send valid per-pane session ids to the snapshot

Phase C moved sessionId from Tab onto Pane; the convergence bridge still
read tab.sessionId through an unchecked cast, sending session_id:
undefined, which failed TabHint deserialization and blanked the overlay.
Add a typed TabManager.listSessionHints() that enumerates live panes
(split tabs included, browser panes skipped) and have the bridge use it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Harden the backend lock (cannot blank again)

A panic elsewhere while holding `op_state` would poison the mutex and make every snapshot panic forever. Recover instead.

**Files:**
- Modify: `crates/app/src/convergence.rs` (add helper, use at the lock site, add test)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `crates/app/src/convergence.rs`:

```rust
    #[test]
    fn lock_recover_survives_poison() {
        let m = std::sync::Mutex::new(7i32);
        // Poison the mutex: panic while holding the guard.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = m.lock().unwrap();
            panic!("poison it");
        }));
        assert!(m.lock().is_err(), "mutex should be poisoned");
        assert_eq!(*lock_recover(&m), 7);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant convergence::tests::lock_recover_survives_poison`
Expected: FAIL — `cannot find function lock_recover in this scope`.

- [ ] **Step 3: Add the helper**

In `crates/app/src/convergence.rs`, add this free function just above `pub async fn build_convergence_snapshot` (it can see `StdMutex`, already imported as `use std::sync::{Arc, Mutex as StdMutex};`):

```rust
/// Lock a `std::sync::Mutex`, recovering from poisoning instead of
/// panicking. A panic elsewhere while holding `op_state` must not
/// permanently brick the snapshot (which blanks the whole overlay). See
/// spec 2026-06-06 §8.
fn lock_recover<T>(m: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}
```

- [ ] **Step 4: Use it at the lock site**

In `build_convergence_snapshot`, replace:

```rust
            let st = s.op_state.lock().expect("op_state poisoned");
```

with:

```rust
            let st = lock_recover(&s.op_state);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p covenant convergence`
Expected: PASS (existing convergence tests + `lock_recover_survives_poison`).

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/convergence.rs
git commit -m "$(cat <<'EOF'
fix(convergence): recover poisoned op_state lock instead of panicking

A panic while holding op_state would poison the mutex and make every
subsequent snapshot panic, permanently blanking the overlay. Lock via a
poison-recovering helper.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Pure view model

Status priority, operator sort, and the escalation join — all pure and unit-tested.

**Files:**
- Create: `ui/src/convergence/model.ts`
- Test: `ui/src/convergence/model.test.ts`

- [ ] **Step 1: Write the failing test**

`ui/src/convergence/model.test.ts`:

```ts
// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  statusPriority,
  operatorStatus,
  escalationIndex,
  sortOperators,
} from "./model";
import type { EscalationCard, OperatorRosterEntry, SessionSummary, TileStatus } from "../api";

const session = (status: TileStatus, id = "s"): SessionSummary => ({
  session_id: id, tab_title: id, tab_color: null, status,
  vendor: "unknown", raw_command_label: null, last_command: null,
  last_output_line: null, last_decision_action: null,
  last_decision_rationale: null, mission_name: null,
  cost_usd: null, budget_usd: null,
});

const op = (
  operator_id: string, operator_name: string,
  sessions: SessionSummary[], has_escalation = false,
): OperatorRosterEntry => ({
  operator_id, operator_name, operator_avatar: null, sessions, has_escalation,
});

const esc = (operator_id: string, session_id: string, at: number): EscalationCard => ({
  session_id, tab_title: session_id, tab_color: null, operator_id,
  operator_name: operator_id, operator_avatar: null, vendor: "unknown",
  raw_command_label: null, question: "q?", executor_excerpt: null,
  mission_name: null, escalated_at_unix_ms: at,
});

describe("statusPriority", () => {
  it("orders blocked < thinking < working < awaiting < idle", () => {
    const order: TileStatus[] = [
      "blocked", "operator-thinking", "working", "awaiting-input", "idle",
    ];
    const ranks = order.map(statusPriority);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe("operatorStatus", () => {
  it("returns the highest-priority status across sessions", () => {
    expect(operatorStatus(op("o", "O", [session("idle"), session("blocked")]))).toBe("blocked");
    expect(operatorStatus(op("o", "O", [session("idle"), session("working")]))).toBe("working");
    expect(operatorStatus(op("o", "O", []))).toBe("idle");
  });
});

describe("escalationIndex", () => {
  it("maps session_id to its escalation card", () => {
    const idx = escalationIndex([esc("o", "s1", 10)]);
    expect(idx.get("s1")?.question).toBe("q?");
    expect(idx.get("nope")).toBeUndefined();
  });
});

describe("sortOperators", () => {
  it("puts escalating operators first, oldest escalation first", () => {
    const roster = [
      op("a", "alpha", [session("working")]),
      op("b", "bravo", [session("blocked", "sb")], true),
      op("c", "charlie", [session("blocked", "sc")], true),
    ];
    const escs = [esc("c", "sc", 100), esc("b", "sb", 500)];
    const out = sortOperators(roster, escs).map((o) => o.operator_id);
    expect(out).toEqual(["c", "b", "a"]); // c older (100) before b (500), both before working
  });

  it("breaks non-escalation ties by status then name", () => {
    const roster = [
      op("z", "zeta", [session("idle")]),
      op("a", "ana", [session("idle")]),
      op("w", "wade", [session("working")]),
    ];
    const out = sortOperators(roster, []).map((o) => o.operator_id);
    expect(out).toEqual(["w", "a", "z"]); // working first, then idle by name
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/convergence/model.test.ts`
Expected: FAIL — `Cannot find module './model'`.

- [ ] **Step 3: Create the model**

`ui/src/convergence/model.ts`:

```ts
import type {
  EscalationCard,
  OperatorRosterEntry,
  TileStatus,
} from "../api";

const PRIORITY: Record<TileStatus, number> = {
  blocked: 0,
  "operator-thinking": 1,
  working: 2,
  "awaiting-input": 3,
  idle: 4,
};

/// Lower = more urgent. Unknown statuses sort last.
export function statusPriority(s: TileStatus): number {
  return PRIORITY[s] ?? 99;
}

/// The status shown on an operator's header pill: the most urgent status
/// across all of its sessions. Empty operator → idle.
export function operatorStatus(entry: OperatorRosterEntry): TileStatus {
  return entry.sessions.reduce<TileStatus>(
    (best, s) => (statusPriority(s.status) < statusPriority(best) ? s.status : best),
    "idle",
  );
}

/// session_id → escalation card, for joining question/tail/reply onto a
/// blocked session (SessionSummary lacks those fields).
export function escalationIndex(esc: EscalationCard[]): Map<string, EscalationCard> {
  return new Map(esc.map((e) => [e.session_id, e]));
}

/// Grid order: escalating operators first (oldest escalation first),
/// then by header-status priority, then by name.
export function sortOperators(
  roster: OperatorRosterEntry[],
  esc: EscalationCard[],
): OperatorRosterEntry[] {
  const oldestEsc = new Map<string, number>();
  for (const e of esc) {
    const cur = oldestEsc.get(e.operator_id);
    if (cur === undefined || e.escalated_at_unix_ms < cur) {
      oldestEsc.set(e.operator_id, e.escalated_at_unix_ms);
    }
  }
  return [...roster].sort((a, b) => {
    if (a.has_escalation !== b.has_escalation) return a.has_escalation ? -1 : 1;
    if (a.has_escalation && b.has_escalation) {
      const at = oldestEsc.get(a.operator_id) ?? 0;
      const bt = oldestEsc.get(b.operator_id) ?? 0;
      if (at !== bt) return at - bt;
    }
    const ap = statusPriority(operatorStatus(a));
    const bp = statusPriority(operatorStatus(b));
    if (ap !== bp) return ap - bp;
    return a.operator_name.localeCompare(b.operator_name);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/convergence/model.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/convergence/model.ts ui/src/convergence/model.test.ts
git commit -m "$(cat <<'EOF'
feat(convergence): pure view model (status priority, sort, esc join)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Operator card renderer

Rewrite `tile.ts` to render one card per operator. `blocked` expands in place (question + executor tail + reply). Multi-session operators get sub-rows.

**Files:**
- Rewrite: `ui/src/convergence/tile.ts`
- Test: `ui/src/convergence/tile.test.ts`

- [ ] **Step 1: Write the failing test**

`ui/src/convergence/tile.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderOperatorCard } from "./tile";
import { escalationIndex } from "./model";
import type { EscalationCard, OperatorRosterEntry, SessionSummary, TileStatus } from "../api";

const session = (over: Partial<SessionSummary>): SessionSummary => ({
  session_id: "s1", tab_title: "awareness", tab_color: null, status: "working",
  vendor: "claude", raw_command_label: null, last_command: "editing storage.rs",
  last_output_line: null, last_decision_action: null, last_decision_rationale: null,
  mission_name: null, cost_usd: null, budget_usd: null, ...over,
});

const op = (sessions: SessionSummary[], has_escalation = false): OperatorRosterEntry => ({
  operator_id: "op-zeta", operator_name: "Zeta", operator_avatar: "🦊",
  sessions, has_escalation,
});

const cb = () => ({ onFocus: vi.fn(), onToggleExpand: vi.fn(), onSubmit: vi.fn() });

describe("renderOperatorCard", () => {
  it("renders a working single-session card with name, status, activity", () => {
    const el = renderOperatorCard(op([session({})]), escalationIndex([]), cb(), new Set());
    expect(el.querySelector(".mc-card__name")?.textContent).toBe("Zeta");
    expect(el.classList.contains("mc-card--working")).toBe(true);
    expect(el.textContent).toContain("editing storage.rs");
  });

  it("shows a cost bar only when AOM-enrolled", () => {
    const noCost = renderOperatorCard(op([session({})]), escalationIndex([]), cb(), new Set());
    expect(noCost.querySelector(".mc-cost")).toBeNull();
    const withCost = renderOperatorCard(
      op([session({ cost_usd: 0.42, budget_usd: 1 })]), escalationIndex([]), cb(), new Set());
    expect(withCost.querySelector(".mc-cost")).not.toBeNull();
  });

  it("blocked card glows, shows the question, tail, and a reply composer", () => {
    const esc: EscalationCard = {
      session_id: "s1", tab_title: "deploy", tab_color: null, operator_id: "op-zeta",
      operator_name: "Zeta", operator_avatar: "🦊", vendor: "claude",
      raw_command_label: null, question: "OK to force-push?",
      executor_excerpt: "! [rejected] main -> main", mission_name: null,
      escalated_at_unix_ms: 0,
    };
    const el = renderOperatorCard(
      op([session({ status: "blocked" as TileStatus })], true),
      escalationIndex([esc]), cb(), new Set());
    expect(el.classList.contains("mc-card--blocked")).toBe(true);
    expect(el.textContent).toContain("OK to force-push?");
    expect(el.querySelector(".mc-card__tail")?.textContent).toContain("! [rejected]");
    expect(el.querySelector(".mc-reply")).not.toBeNull();
  });

  it("clicking the tab link focuses the session", () => {
    const c = cb();
    const el = renderOperatorCard(op([session({})]), escalationIndex([]), c, new Set());
    el.querySelector<HTMLElement>(".mc-card__tab")!.click();
    expect(c.onFocus).toHaveBeenCalledWith("s1", false);
  });

  it("multi-session operator shows an aggregate count and sub-rows when expanded", () => {
    const entry = op([session({ session_id: "s1" }), session({ session_id: "s2", tab_title: "api" })]);
    const collapsed = renderOperatorCard(entry, escalationIndex([]), cb(), new Set());
    expect(collapsed.querySelector(".mc-card__count")?.textContent).toContain("2");
    expect(collapsed.querySelectorAll(".mc-subrow").length).toBe(0);
    const expanded = renderOperatorCard(entry, escalationIndex([]), cb(), new Set(["op-zeta"]));
    expect(expanded.querySelectorAll(".mc-subrow").length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/convergence/tile.test.ts`
Expected: FAIL — `renderOperatorCard` is not exported.

- [ ] **Step 3: Rewrite `tile.ts`**

Replace the entire contents of `ui/src/convergence/tile.ts` with:

```ts
import type {
  EscalationCard,
  OperatorRosterEntry,
  SessionSummary,
  TileStatus,
  Vendor,
} from "../api";
import { renderAvatarHtml } from "../operator/avatars";
import { CustomSelect } from "../ui/select";
import { operatorStatus } from "./model";

export type ReplyScope = "one-shot" | "mission" | "global";

export interface CardCallbacks {
  /// Jump to a session's tab. keepOpen=false closes the overlay.
  onFocus: (sessionId: string, keepOpen: boolean) => void;
  /// Toggle expand/collapse for a multi-session operator.
  onToggleExpand: (operatorId: string) => void;
  /// Send a reply to a blocked session.
  onSubmit: (sessionId: string, text: string, scope: ReplyScope) => Promise<void>;
}

/// One card per operator. Single-session operators render their session
/// inline; multi-session operators show an aggregate header and, when
/// expanded, one sub-row per session. Blocked sessions expand to show the
/// question, the executor's tail, and a reply composer.
export function renderOperatorCard(
  entry: OperatorRosterEntry,
  esc: Map<string, EscalationCard>,
  cb: CardCallbacks,
  expanded: ReadonlySet<string>,
): HTMLElement {
  const status = operatorStatus(entry);
  const root = document.createElement("article");
  root.className = `mc-card mc-card--${status}`;
  root.dataset.operatorId = entry.operator_id;

  const multi = entry.sessions.length > 1;
  const isOpen = entry.has_escalation || expanded.has(entry.operator_id);

  root.append(renderHeader(entry, status, multi, isOpen, cb));

  if (!multi) {
    const only = entry.sessions[0];
    if (only) root.append(renderSessionBody(only, esc.get(only.session_id), cb));
  } else if (isOpen) {
    const sub = document.createElement("div");
    sub.className = "mc-card__sub";
    for (const s of entry.sessions) sub.append(renderSubRow(s, esc.get(s.session_id), cb));
    root.append(sub);
  }
  return root;
}

function renderHeader(
  entry: OperatorRosterEntry,
  status: TileStatus,
  multi: boolean,
  isOpen: boolean,
  cb: CardCallbacks,
): HTMLElement {
  const head = document.createElement("div");
  head.className = "mc-card__head";

  const avatar = document.createElement("span");
  avatar.className = `mc-avatar mc-avatar--${status}`;
  avatar.innerHTML = renderAvatarHtml(entry.operator_avatar ?? "👤", 28);

  const name = document.createElement("strong");
  name.className = "mc-card__name";
  name.textContent = entry.operator_name;

  const pill = document.createElement("span");
  pill.className = `mc-pill mc-pill--${status}`;
  pill.textContent = status === "blocked" ? "NEEDS YOU" : status;

  head.append(avatar, name, pill);

  if (multi) {
    const blocked = entry.sessions.filter((s) => s.status === "blocked").length;
    const count = document.createElement("span");
    count.className = "mc-card__count";
    count.textContent =
      `${entry.sessions.length} sessions` + (blocked ? ` · ${blocked} blocked` : "");
    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "mc-card__caret";
    caret.setAttribute("aria-label", isOpen ? "Collapse" : "Expand");
    caret.textContent = isOpen ? "▾" : "▸";
    caret.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onToggleExpand(entry.operator_id);
    });
    head.append(count, caret);
  } else {
    const only = entry.sessions[0];
    if (only) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "mc-card__tab";
      tab.textContent = `→ ${only.tab_title}`;
      tab.addEventListener("click", (e) => {
        e.stopPropagation();
        cb.onFocus(only.session_id, false);
      });
      head.append(tab);
    }
  }
  return head;
}

/// Body of a single-session card (or the detail inside a sub-row):
/// activity line, context chips, cost bar, and — when blocked — the
/// question, executor tail, and reply composer.
function renderSessionBody(
  s: SessionSummary,
  esc: EscalationCard | undefined,
  cb: CardCallbacks,
): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (s.status === "blocked" && esc) {
    const q = document.createElement("p");
    q.className = "mc-card__question";
    q.textContent = esc.question ?? "(no question text)";
    frag.append(q);
    if (esc.executor_excerpt) {
      const tail = document.createElement("pre");
      tail.className = "mc-card__tail";
      tail.textContent = esc.executor_excerpt;
      frag.append(tail);
    }
    frag.append(renderReply(s.session_id, cb.onSubmit));
    return frag;
  }

  const act = document.createElement("div");
  act.className = "mc-card__activity";
  act.textContent = activityLine(s);
  frag.append(act);

  const chips = contextChips(s);
  if (chips) frag.append(chips);

  const cost = costBar(s);
  if (cost) frag.append(cost);
  return frag;
}

function renderSubRow(
  s: SessionSummary,
  esc: EscalationCard | undefined,
  cb: CardCallbacks,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "mc-subrow";
  row.dataset.sessionId = s.session_id;

  const head = document.createElement("div");
  head.className = "mc-subrow__head";
  const dot = document.createElement("span");
  dot.className = `mc-dot mc-dot--${s.status}`;
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "mc-subrow__tab";
  tab.textContent = s.tab_title;
  tab.addEventListener("click", () => cb.onFocus(s.session_id, false));
  const st = document.createElement("span");
  st.className = "mc-subrow__status";
  st.textContent = s.status === "blocked" ? "needs you" : s.status;
  head.append(dot, tab, st);
  row.append(head, renderSessionBody(s, esc, cb));
  return row;
}

function activityLine(s: SessionSummary): string {
  const what = s.last_command ?? s.last_output_line ?? "…";
  return `${vendorLabel(s)} · ${what}`;
}

function vendorLabel(s: SessionSummary): string {
  if (s.vendor !== "unknown") return s.vendor;
  return s.raw_command_label ?? "shell";
}

function contextChips(s: SessionSummary): HTMLElement | null {
  const labels: string[] = [];
  if (s.mission_name) labels.push(`◈ ${s.mission_name}`);
  if (labels.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "mc-chips";
  for (const l of labels) {
    const chip = document.createElement("span");
    chip.className = "mc-chip";
    chip.textContent = l;
    wrap.append(chip);
  }
  return wrap;
}

function costBar(s: SessionSummary): HTMLElement | null {
  if (s.cost_usd == null || s.budget_usd == null) return null;
  const pct = s.budget_usd > 0 ? Math.min(100, (s.cost_usd / s.budget_usd) * 100) : 0;
  const wrap = document.createElement("div");
  wrap.className = "mc-cost";
  const bar = document.createElement("div");
  bar.className = "mc-cost__bar";
  const fill = document.createElement("i");
  fill.style.width = `${pct}%`;
  if (pct >= 90) fill.classList.add("mc-cost__fill--danger");
  else if (pct >= 70) fill.classList.add("mc-cost__fill--warn");
  bar.append(fill);
  const label = document.createElement("span");
  label.className = "mc-cost__label";
  label.textContent = `$${s.cost_usd.toFixed(2)} / $${s.budget_usd.toFixed(2)}`;
  wrap.append(bar, label);
  return wrap;
}

function renderReply(
  sessionId: string,
  onSubmit: CardCallbacks["onSubmit"],
): HTMLElement {
  const wrap = document.createElement("form");
  wrap.className = "mc-reply";
  wrap.addEventListener("submit", (e) => e.preventDefault());

  const textarea = document.createElement("textarea");
  textarea.className = "mc-reply__textarea";
  textarea.placeholder = "Reply to operator…";
  textarea.rows = 2;

  const controls = document.createElement("div");
  controls.className = "mc-reply__controls";
  const scope = new CustomSelect({
    className: "mc-reply__scope",
    ariaLabel: "Reply scope",
    value: "one-shot",
    options: ["one-shot", "mission", "global"].map((v) => ({ value: v, label: v })),
  });
  const send = document.createElement("button");
  send.type = "button";
  send.className = "mc-reply__send";
  send.textContent = "Send ⌘↵";

  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    await onSubmit(sessionId, text, scope.value as ReplyScope);
    textarea.value = "";
  };
  send.addEventListener("click", () => void submit());
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  });

  controls.append(scope.element, send);
  wrap.append(textarea, controls);
  return wrap;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/convergence/tile.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/convergence/tile.ts ui/src/convergence/tile.test.ts
git commit -m "$(cat <<'EOF'
feat(convergence): operator card renderer (single, multi, blocked)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Overlay rewrite — grid, header strip, resilient refresh

Rewrite `overlay.ts` to render the card grid with a header strip, filters, keyboard nav, and a refresh that never blanks on a transient error.

**Files:**
- Rewrite: `ui/src/convergence/overlay.ts`
- Test: `ui/src/convergence/overlay.test.ts`

- [ ] **Step 1: Write the failing test**

`ui/src/convergence/overlay.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getSnap = vi.fn();
vi.mock("../api", () => ({
  getConvergenceSnapshot: (...a: unknown[]) => getSnap(...a),
  submitConvergenceReply: vi.fn(),
}));

import { ConvergenceOverlay } from "./overlay";

const bridge = {
  listTabs: () => [{ sessionId: "s1", title: "awareness", color: null }],
  activateBySessionId: vi.fn(() => true),
};

const snapWith = (name: string) => ({
  roster: [{
    operator_id: "o", operator_name: name, operator_avatar: "🦊",
    has_escalation: false,
    sessions: [{
      session_id: "s1", tab_title: "awareness", tab_color: null, status: "working",
      vendor: "claude", raw_command_label: null, last_command: "x",
      last_output_line: null, last_decision_action: null, last_decision_rationale: null,
      mission_name: null, cost_usd: null, budget_usd: null,
    }],
  }],
  escalations: [],
});

describe("ConvergenceOverlay.refresh", () => {
  let ov: ConvergenceOverlay;
  beforeEach(() => { getSnap.mockReset(); ov = new ConvergenceOverlay(bridge); });
  afterEach(() => ov.close());

  it("renders a card grid on success", async () => {
    getSnap.mockResolvedValue(snapWith("Zeta"));
    ov.open();
    await ov.refreshForTest();
    expect(document.querySelector(".mc-card__name")?.textContent).toBe("Zeta");
  });

  it("keeps the last-good render when a later snapshot rejects (no blank)", async () => {
    getSnap.mockResolvedValueOnce(snapWith("Zeta"));
    ov.open();
    await ov.refreshForTest();
    getSnap.mockRejectedValueOnce(new Error("deserialize fail"));
    await ov.refreshForTest();
    expect(document.querySelector(".mc-card__name")?.textContent).toBe("Zeta");
    expect(document.querySelector(".mc-reconnecting")).not.toBeNull();
  });

  it("shows the empty state when there are no operators", async () => {
    getSnap.mockResolvedValue({ roster: [], escalations: [] });
    ov.open();
    await ov.refreshForTest();
    expect(document.querySelector(".convergence-overlay__empty")?.hasAttribute("hidden")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/convergence/overlay.test.ts`
Expected: FAIL — `refreshForTest` / new structure not present.

- [ ] **Step 3: Rewrite `overlay.ts`**

Replace the entire contents of `ui/src/convergence/overlay.ts` with:

```ts
import {
  getConvergenceSnapshot,
  submitConvergenceReply,
  type ConvergenceSnapshot,
} from "../api";
import { Icons } from "../icons";
import { escalationIndex, sortOperators } from "./model";
import { renderOperatorCard, type ReplyScope } from "./tile";

export interface TabMeta {
  sessionId: string;
  title: string;
  color: string | null;
}

export interface ConvergenceTabBridge {
  listTabs(): TabMeta[];
  activateBySessionId(sessionId: string, opts?: { keepOverlayOpen?: boolean }): boolean;
}

type Filter = "all" | "needs you" | "working" | "idle";
const POLL_MS = 1000;

export class ConvergenceOverlay {
  private root: HTMLElement | null = null;
  private gridEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private empty: HTMLElement | null = null;
  private reconnectEl: HTMLElement | null = null;
  private pollHandle: number | null = null;
  private visible = false;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private snap: ConvergenceSnapshot | null = null; // last-good
  private filter: Filter = "all";
  private expanded = new Set<string>();
  private activeOperatorId: string | null = null;

  constructor(private bridge: ConvergenceTabBridge) {}

  isVisible(): boolean { return this.visible; }
  toggle(): void { if (this.visible) this.close(); else this.open(); }

  open(): void {
    if (this.visible) return;
    this.mount();
    this.visible = true;
    void this.refresh();
    this.pollHandle = window.setInterval(() => void this.refresh(), POLL_MS);
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    if (this.pollHandle !== null) { window.clearInterval(this.pollHandle); this.pollHandle = null; }
    if (this.escHandler !== null) {
      document.removeEventListener("keydown", this.escHandler, { capture: true });
      this.escHandler = null;
    }
    this.root?.remove();
    this.root = this.gridEl = this.summaryEl = this.empty = this.reconnectEl = null;
    this.snap = null;
    this.filter = "all";
    this.expanded.clear();
    this.activeOperatorId = null;
  }

  private mount(): void {
    const root = document.createElement("div");
    root.className = "convergence-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Convergence Mode");

    const header = document.createElement("div");
    header.className = "convergence-overlay__header";
    const title = document.createElement("h1");
    title.className = "convergence-overlay__title";
    title.textContent = "CONVERGENCE";
    const exit = document.createElement("button");
    exit.type = "button";
    exit.className = "modal-cancel-btn";
    exit.innerHTML = `<span>Exit</span><kbd class="modal-kbd">Esc</kbd>`;
    exit.addEventListener("click", () => this.close());
    header.append(title, exit);

    const strip = document.createElement("div");
    strip.className = "mc-strip";
    const summary = document.createElement("div");
    summary.className = "mc-strip__summary";
    const reconnect = document.createElement("span");
    reconnect.className = "mc-reconnecting";
    reconnect.textContent = "reconnecting…";
    reconnect.hidden = true;
    const filters = document.createElement("div");
    filters.className = "mc-strip__filters";
    for (const f of ["all", "needs you", "working", "idle"] as const) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "mc-fchip" + (this.filter === f ? " mc-fchip--on" : "");
      chip.textContent = f;
      chip.dataset.filter = f;
      chip.addEventListener("click", () => { this.filter = f; this.render(); });
      filters.append(chip);
    }
    strip.append(summary, reconnect, filters);

    const grid = document.createElement("div");
    grid.className = "mc-grid";

    const empty = document.createElement("div");
    empty.className = "convergence-overlay__empty";
    empty.hidden = true;
    empty.innerHTML = `
      <div class="convergence-overlay__empty-icon">${Icons.link2({ size: 56 })}</div>
      <div class="convergence-overlay__empty-title">Nothing to converge</div>
      <div class="convergence-overlay__empty-body">
        Mission Control shows every operator across your tabs.<br/>
        Enable an operator on a tab (⌘O) to populate this view.
      </div>
      <kbd class="convergence-overlay__empty-hint">⌘⇧M to toggle convergence</kbd>`;

    root.append(header, strip, grid, empty);
    document.body.append(root);

    this.root = root;
    this.gridEl = grid;
    this.summaryEl = summary;
    this.empty = empty;
    this.reconnectEl = reconnect;

    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest(".mc-reply")) { e.preventDefault(); e.stopPropagation(); active.blur(); return; }
        e.preventDefault(); e.stopPropagation(); this.close(); return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.tagName === "TEXTAREA" && (active as HTMLTextAreaElement).value.length > 0) return;
        e.preventDefault();
        this.moveActive(e.key === "ArrowDown" ? 1 : -1);
      }
      if (e.key === "Enter" && this.activeOperatorId && !(document.activeElement?.closest(".mc-reply"))) {
        const op = this.visibleOperators().find((o) => o.operator_id === this.activeOperatorId);
        const first = op?.sessions[0];
        if (first) { this.bridge.activateBySessionId(first.session_id); this.close(); }
      }
    };
    document.addEventListener("keydown", this.escHandler, { capture: true });
  }

  /// Test seam — drives one refresh and resolves when render is done.
  refreshForTest(): Promise<void> { return this.refresh(); }

  private async refresh(): Promise<void> {
    if (!this.visible) return;
    const tabs = this.bridge.listTabs().map((t) => ({
      session_id: t.sessionId, title: t.title, color: t.color,
    }));
    try {
      this.snap = await getConvergenceSnapshot(tabs);
      if (this.reconnectEl) this.reconnectEl.hidden = true;
    } catch (err) {
      console.warn("convergence snapshot failed", err);
      // Resilience: keep the last-good render; flag reconnecting. Never blank.
      if (this.reconnectEl) this.reconnectEl.hidden = false;
      if (!this.snap) this.renderEmptyError();
      return;
    }
    this.render();
  }

  private visibleOperators() {
    if (!this.snap) return [];
    const sorted = sortOperators(this.snap.roster, this.snap.escalations);
    return sorted.filter((entry) => {
      switch (this.filter) {
        case "all": return true;
        case "needs you": return entry.has_escalation;
        case "working": return entry.sessions.some((s) => s.status === "working");
        case "idle": return entry.sessions.every((s) => s.status === "idle");
      }
    });
  }

  private render(): void {
    if (!this.gridEl || !this.empty || !this.summaryEl || !this.snap) return;
    const roster = this.snap.roster;
    if (roster.length === 0) {
      this.gridEl.replaceChildren();
      this.gridEl.hidden = true;
      this.empty.hidden = false;
      this.summaryEl.textContent = "";
      return;
    }
    this.empty.hidden = true;
    this.gridEl.hidden = false;

    // Summary counts (over the full roster, not the filtered view).
    const sessions = roster.flatMap((r) => r.sessions);
    const needs = roster.filter((r) => r.has_escalation).length;
    const working = sessions.filter((s) => s.status === "working").length;
    const idle = sessions.filter((s) => s.status === "idle").length;
    const cost = sessions.reduce((a, s) => a + (s.cost_usd ?? 0), 0);
    this.summaryEl.innerHTML =
      `<b>${roster.length}</b> operators · ` +
      (needs ? `<b class="mc-strip__alert">${needs} needs you</b> · ` : "") +
      `${working} working · ${idle} idle` +
      (cost > 0 ? ` · <b>$${cost.toFixed(2)}</b>` : "");

    // Sync filter chip active state.
    this.root?.querySelectorAll<HTMLElement>(".mc-fchip").forEach((c) => {
      c.classList.toggle("mc-fchip--on", c.dataset.filter === this.filter);
    });

    const esc = escalationIndex(this.snap.escalations);
    const list = this.visibleOperators();
    if (!this.activeOperatorId || !list.some((o) => o.operator_id === this.activeOperatorId)) {
      this.activeOperatorId = list[0]?.operator_id ?? null;
    }
    this.gridEl.replaceChildren();
    if (list.length === 0) {
      const none = document.createElement("div");
      none.className = "mc-grid__empty";
      none.innerHTML = `No operators match <code>${this.filter}</code>. <button type="button" class="mc-grid__reset">Show all</button>`;
      none.querySelector(".mc-grid__reset")?.addEventListener("click", () => { this.filter = "all"; this.render(); });
      this.gridEl.append(none);
      return;
    }
    for (const entry of list) {
      const card = renderOperatorCard(entry, esc, {
        onFocus: (sid, keepOpen) => {
          const ok = this.bridge.activateBySessionId(sid, { keepOverlayOpen: keepOpen });
          if (ok && !keepOpen) this.close();
        },
        onToggleExpand: (opId) => {
          if (this.expanded.has(opId)) this.expanded.delete(opId);
          else this.expanded.add(opId);
          this.render();
        },
        onSubmit: this.submitReply.bind(this),
      }, this.expanded);
      if (entry.operator_id === this.activeOperatorId) card.classList.add("mc-card--active");
      this.gridEl.append(card);
    }
  }

  private renderEmptyError(): void {
    if (!this.gridEl || !this.empty || !this.summaryEl) return;
    this.empty.hidden = true;
    this.gridEl.hidden = false;
    this.summaryEl.textContent = "";
    this.gridEl.replaceChildren();
    const err = document.createElement("div");
    err.className = "mc-grid__empty";
    err.innerHTML = `Couldn't load operator status. <button type="button" class="mc-grid__reset">Retry</button>`;
    err.querySelector(".mc-grid__reset")?.addEventListener("click", () => void this.refresh());
    this.gridEl.append(err);
  }

  private moveActive(delta: number): void {
    const list = this.visibleOperators();
    if (list.length === 0) return;
    const idx = list.findIndex((o) => o.operator_id === this.activeOperatorId);
    const next = (idx === -1 ? 0 : idx + delta + list.length) % list.length;
    this.activeOperatorId = list[next].operator_id;
    this.render();
  }

  async submitReply(sessionId: string, text: string, scope: ReplyScope): Promise<void> {
    try {
      await submitConvergenceReply(sessionId, text, scope);
    } catch (err) {
      console.warn("[convergence] submitReply failed", err);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/convergence/overlay.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + full suite**

Run: `npm run build` — Expected: no type errors.
Run: `npm test` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/convergence/overlay.ts ui/src/convergence/overlay.test.ts
git commit -m "$(cat <<'EOF'
feat(convergence): Mission Control grid + header strip + resilient refresh

Single card grid (one per operator), summary + filters in the header, and
a refresh that keeps the last-good render with a reconnecting chip instead
of blanking on a transient snapshot error.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Styles

Add the `.mc-*` styles and retire the dead `.cv-*` v2 block.

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Remove the old v2 block**

Delete the entire `/* ===== Convergence v2 (spec 3.8.1) ===== */` block — from the line `/* ===== Convergence v2 (spec 3.8.1) ===== */` (≈ line 12162) down to and including the closing rule for `.cv-avatar` (the rule block ending just before `/* Spec-pending badge (Task 4) ... */`). Keep the `.spec-badge` block and everything after it. Keep the earlier `.convergence-overlay*`, `.modal-cancel-btn`, `.modal-kbd`, and `.convergence-overlay__empty*` rules (still used).

- [ ] **Step 2: Append the new Mission Control styles**

Append at the end of `ui/src/styles.css`:

```css
/* ===== Convergence — Mission Control (spec 2026-06-06) ===== */
.mc-strip {
  display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
  color: var(--muted); font-size: 12px;
}
.mc-strip__summary b { color: var(--text-primary); }
.mc-strip__alert { color: var(--danger) !important; }
.mc-reconnecting {
  font-size: 11px; color: #ffcf5f;
  background: rgba(255,207,95,.1); border: 1px solid rgba(255,207,95,.25);
  border-radius: 6px; padding: 2px 8px;
}
.mc-reconnecting[hidden] { display: none; }
.mc-strip__filters { margin-left: auto; display: flex; gap: 4px; }
.mc-fchip {
  background: transparent; border: 1px solid transparent; color: var(--muted);
  font-size: 11px; padding: 3px 9px; border-radius: 8px; cursor: pointer;
  letter-spacing: .03em;
}
.mc-fchip--on { background: var(--bg-panel); color: var(--text-primary); border-color: var(--border); }

.mc-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px; align-content: start; overflow-y: auto; padding-top: 4px;
  height: calc(100% - 96px);
}
.mc-grid[hidden] { display: none; }
.mc-grid__empty { color: var(--muted); font-size: 12px; font-style: italic; padding: 16px; display: flex; gap: 10px; align-items: center; }
.mc-grid__reset, .mc-grid__empty code {
  font-style: normal; background: var(--bg-panel); border: 1px solid var(--border);
  border-radius: 4px; padding: 3px 8px; font-size: 11px; color: var(--text-primary); cursor: pointer;
}

.mc-card {
  background: var(--bg-panel); border: 1px solid var(--border);
  border-left: 3px solid transparent; border-radius: 12px; padding: 13px 15px;
  display: flex; flex-direction: column; gap: 8px;
}
.mc-card--working { border-left-color: #5fff8a; }
.mc-card--operator-thinking { border-left-color: var(--accent); }
.mc-card--awaiting-input { border-left-color: #ffcf5f; }
.mc-card--idle { opacity: .62; }
.mc-card--blocked {
  border-left-color: var(--danger);
  box-shadow: 0 0 0 1px rgba(232,90,90,.25), 0 0 24px -6px rgba(232,90,90,.4);
}
.mc-card--active { outline: 1px solid var(--accent); outline-offset: 1px; }

.mc-card__head { display: flex; align-items: center; gap: 9px; }
.mc-card__name { color: var(--text-primary); font-size: 14px; font-weight: 600; }
.mc-card__tab {
  margin-left: auto; background: transparent; border: 0; cursor: pointer;
  color: var(--accent); font: inherit; font-size: 12px; text-decoration: underline dotted;
}
.mc-card__count { margin-left: auto; color: var(--muted); font-size: 11px; }
.mc-card__caret { background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 14px; padding: 2px 4px; }

.mc-avatar {
  width: 30px; height: 30px; border-radius: 50%; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--bg-card-active, var(--bg-panel)); font-size: 16px;
  box-shadow: 0 0 0 2px var(--bg-overlay), 0 0 0 4px #3a434f;
}
.mc-avatar--working { box-shadow: 0 0 0 2px var(--bg-overlay), 0 0 0 4px #5fff8a; }
.mc-avatar--operator-thinking { box-shadow: 0 0 0 2px var(--bg-overlay), 0 0 0 4px var(--accent); }
.mc-avatar--awaiting-input { box-shadow: 0 0 0 2px var(--bg-overlay), 0 0 0 4px #ffcf5f; }
.mc-avatar--blocked { box-shadow: 0 0 0 2px var(--bg-overlay), 0 0 0 4px var(--danger); }

.mc-pill {
  font-size: 10px; padding: 2px 8px; border-radius: 10px; letter-spacing: .05em;
  background: var(--bg-card-active, var(--bg-panel)); color: var(--muted);
}
.mc-pill--working { color: #5fff8a; background: rgba(95,255,138,.12); }
.mc-pill--operator-thinking { color: var(--accent); background: rgba(122,162,247,.14); }
.mc-pill--awaiting-input { color: #ffcf5f; background: rgba(255,207,95,.12); }
.mc-pill--blocked { color: var(--danger); background: rgba(232,90,90,.15); }

.mc-card__activity { color: var(--muted); font-size: 12px; }
.mc-card__question { color: #d6d9de; font-size: 12px; line-height: 1.45; margin: 0; }
.mc-card__tail {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; line-height: 1.4; color: #aeb4be;
  background: var(--bg-overlay); border: 1px solid var(--border);
  border-radius: 7px; padding: 8px 10px; margin: 0;
  max-height: 200px; overflow: auto; white-space: pre-wrap; word-break: break-word;
}

.mc-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.mc-chip { font-size: 10px; padding: 2px 7px; border-radius: 6px; background: var(--bg-overlay); border: 1px solid var(--border); color: var(--muted); }

.mc-cost { display: flex; align-items: center; gap: 8px; }
.mc-cost__bar { flex: 1; height: 5px; background: var(--border); border-radius: 3px; overflow: hidden; }
.mc-cost__bar > i { display: block; height: 100%; background: var(--accent); }
.mc-cost__fill--warn { background: #ffcf5f !important; }
.mc-cost__fill--danger { background: var(--danger) !important; }
.mc-cost__label { font-size: 10px; color: var(--muted); }

.mc-card__sub { display: flex; flex-direction: column; gap: 8px; padding-left: 6px; border-left: 1px solid var(--border); margin-left: 8px; }
.mc-subrow { display: flex; flex-direction: column; gap: 6px; }
.mc-subrow__head { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.mc-subrow__tab { background: transparent; border: 0; color: var(--text-primary); cursor: pointer; font: inherit; font-size: 12px; }
.mc-subrow__status { margin-left: auto; color: var(--muted); font-size: 11px; }
.mc-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); flex: 0 0 auto; }
.mc-dot--working { background: #5fff8a; }
.mc-dot--operator-thinking { background: var(--accent); }
.mc-dot--awaiting-input { background: #ffcf5f; }
.mc-dot--blocked { background: var(--danger); }

.mc-reply { display: flex; gap: 8px; align-items: flex-end; background: var(--bg-overlay); border: 1px solid var(--border); border-radius: 9px; padding: 8px 10px; }
.mc-reply__textarea { flex: 1; background: transparent; border: 0; resize: none; outline: none; color: var(--text-primary); font: inherit; font-size: 13px; min-height: calc(1.4em * 2); }
.mc-reply__controls { display: flex; flex-direction: column; gap: 6px; align-items: flex-end; }
.mc-reply__scope { width: 96px; }
.mc-reply__send { background: var(--accent); color: #fff; border: 0; font-size: 11px; padding: 6px 12px; border-radius: 6px; cursor: pointer; }
```

- [ ] **Step 3: Build + visual sanity**

Run: `npm run build` — Expected: no errors.
(Visual check happens in Task 7.)

- [ ] **Step 4: Commit**

```bash
git add ui/src/styles.css
git commit -m "$(cat <<'EOF'
feat(convergence): Mission Control card-grid styles; retire dead cv-v2 css

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Manual verification

**Files:** none (runtime check).

- [ ] **Step 1: Launch the app**

Use the `respawn` skill (or `npm run tauri:dev`). Ensure at least one tab has an operator enabled (⌘O), ideally: one actively working, one+ idle, and — if reproducible — one blocked (operator escalated).

- [ ] **Step 2: Open Mission Control**

Press ⌘⇧M. Expected:
- A card grid appears (not blank, no center divider).
- One card per operator; idle operators visible but dimmed.
- Header strip shows `N operators · … · $cost` and filter chips.

- [ ] **Step 3: Exercise interactions**

- Click a card's `→ tab` link → jumps to that tab and closes the overlay.
- Filter chips (all / needs you / working / idle) narrow the grid.
- ↑/↓ move the active card; Enter jumps to it.
- If a blocked operator exists: its card glows red, sorts to the front, shows the question + executor tail, and the reply composer sends (operator unblocks on next poll).

- [ ] **Step 4: Confirm resilience**

With the overlay open, nothing should ever flash to a fully blank screen between 1 Hz polls.

- [ ] **Step 5: Final full test run**

Run: `npm test && cargo test -p covenant convergence`
Expected: all PASS.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §1 root cause / §4 bridge fix → Task 1. ✓
- §4 + §8 backend lock hardening → Task 2. ✓
- §5 escalation join + §6.2 status taxonomy + §6.4 sort → Task 3. ✓
- §6.1 card anatomy + §6.3 blocked state + multi-session → Task 4. ✓
- §6.4 grid + header strip + filters + §7 interactions + §8 resilience → Task 5. ✓
- styling → Task 6. ✓
- testing §9 + manual → distributed + Task 7. ✓
- §6.5 compact mode → intentionally deferred (noted under File Structure; spec permits MVP without it).

**Type consistency:** `renderOperatorCard(entry, esc:Map, cb, expanded:Set)`, `CardCallbacks{onFocus,onToggleExpand,onSubmit}`, `ReplyScope`, `escalationIndex`/`sortOperators`/`operatorStatus`, and `ConvergenceTabBridge`/`TabMeta` are used identically across tile.ts, overlay.ts, and their tests. ✓

**Placeholder scan:** no TBD/TODO; every code step has full code and an exact run command. ✓
