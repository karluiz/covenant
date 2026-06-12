# Forward Tab Rename Into Running Agent Session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user renames a tab whose pi executor session is currently unnamed, forward the new name to the pi RPC so the agent's internal session label matches our tab label.

**Architecture:** Frontend `commitTabRename` detects "was unnamed → now named" + pi executor → fires a new Tauri command `pi_set_session_name` that sends `PiCommand::SetSessionName` over the existing pi RPC. Non-pi executors (claude/codex/copilot/opencode) are a no-op for forwarding; the local rename still applies. Re-renames of already-named tabs do not re-forward.

**Tech Stack:** Rust (tauri commands, `karl_agent::pi_rpc`), TypeScript (`ui/src/api.ts`, `ui/src/tabs/manager.ts`), Vitest for the TS unit tests, `cargo test` for the Rust side.

**Spec:** `docs/superpowers/specs/2026-05-18-agent-session-rename-design.md`

---

## File Structure

**Modify:**
- `crates/app/src/pi_commands.rs` — add `pi_set_session_name` Tauri command
- `crates/app/src/lib.rs` — register the new command in the tauri::generate_handler! list (around the existing `pi_*` registrations near line 3291)
- `ui/src/api.ts` — add `piSetSessionName` wrapper (next to `piSteer`, around line 1446)
- `ui/src/tabs/manager.ts` — extend `commitTabRename` to forward to pi when conditions match

**Create:**
- `ui/src/tabs/__tests__/rename-forward.test.ts` — unit test for the forwarding logic (Vitest)

No new files on the Rust side — the command lives alongside the other `pi_*` commands.

---

## Task 1: Add `pi_set_session_name` Tauri command

**Files:**
- Modify: `crates/app/src/pi_commands.rs` (insert after `pi_new_session`, around line 210)
- Modify: `crates/app/src/lib.rs` (add to `tauri::generate_handler!` list around line 3294, alongside other `pi_commands::*` entries)

- [ ] **Step 1: Add the command implementation**

Append to `crates/app/src/pi_commands.rs` (right after `pi_new_session`, before the `// State / model` section header on line 213):

```rust
#[tauri::command]
pub async fn pi_set_session_name(
    state: State<'_, AppState>,
    session_id: SessionId,
    name: String,
) -> Result<(), String> {
    let sess = require(&state, &session_id).await?;
    sess.send(&PiCommand::SetSessionName { name })
        .await
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register the command**

In `crates/app/src/lib.rs`, find the block listing `pi_commands::pi_send_prompt`, `pi_commands::pi_steer`, etc. (around line 3291–3300). Add one line:

```rust
pi_commands::pi_set_session_name,
```

Place it right after `pi_commands::pi_new_session` so the ordering matches `pi_commands.rs`.

- [ ] **Step 3: Verify it compiles**

Run: `cargo check -p karl-app`
Expected: clean build, no warnings about the new symbol.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/pi_commands.rs crates/app/src/lib.rs
git commit -m "feat(pi): expose set_session_name as Tauri command"
```

---

## Task 2: Add `piSetSessionName` wrapper in `api.ts`

**Files:**
- Modify: `ui/src/api.ts` (insert after `piNewSession`, before the next section)

- [ ] **Step 1: Add the wrapper**

Insert after the `piAbort` wrapper (line 1456) and before `piNewSession`, or anywhere in the pi block — keep it adjacent to the other pi command wrappers:

```ts
export async function piSetSessionName(
  sessionId: SessionId,
  name: string,
): Promise<void> {
  return invoke<void>("pi_set_session_name", { sessionId, name });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd ui && npm run typecheck` (or `npx tsc --noEmit` if no script alias)
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(api): wrap pi_set_session_name"
```

---

## Task 3: Write failing test for rename forwarding

**Files:**
- Create: `ui/src/tabs/__tests__/rename-forward.test.ts`

The forwarding logic in `commitTabRename` is tightly coupled to `TabManager` state, but we don't need to spin up the whole class. We extract the decision into a pure helper `shouldForwardRename` so it can be unit-tested in isolation, and `commitTabRename` calls it.

- [ ] **Step 1: Decide the helper signature**

We're going to add this exported helper in `ui/src/tabs/manager.ts` in Task 4:

```ts
export function shouldForwardRename(args: {
  executor: string | null;
  kind: "shell" | "pi";
  previousCustomName: string | null;
  newCustomName: string | null;
}): boolean {
  const wasUnnamed =
    !args.previousCustomName || args.previousCustomName.trim().length === 0;
  const isNamedNow =
    !!args.newCustomName && args.newCustomName.trim().length > 0;
  const isPi = args.kind === "pi" || args.executor === "pi";
  return wasUnnamed && isNamedNow && isPi;
}
```

- [ ] **Step 2: Write the failing test**

Create `ui/src/tabs/__tests__/rename-forward.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldForwardRename } from "../manager";

describe("shouldForwardRename", () => {
  it("forwards when a previously-unnamed pi tab is named", () => {
    expect(
      shouldForwardRename({
        executor: "pi",
        kind: "pi",
        previousCustomName: null,
        newCustomName: "deploy review",
      }),
    ).toBe(true);
  });

  it("forwards when previous name is whitespace-only", () => {
    expect(
      shouldForwardRename({
        executor: "pi",
        kind: "pi",
        previousCustomName: "   ",
        newCustomName: "deploy review",
      }),
    ).toBe(true);
  });

  it("does not forward when the tab was already named (re-rename)", () => {
    expect(
      shouldForwardRename({
        executor: "pi",
        kind: "pi",
        previousCustomName: "old name",
        newCustomName: "new name",
      }),
    ).toBe(false);
  });

  it("does not forward when the new name is empty (clearing)", () => {
    expect(
      shouldForwardRename({
        executor: "pi",
        kind: "pi",
        previousCustomName: null,
        newCustomName: null,
      }),
    ).toBe(false);
  });

  it("does not forward for non-pi executors", () => {
    for (const executor of ["claude", "codex", "copilot", "opencode"]) {
      expect(
        shouldForwardRename({
          executor,
          kind: "shell",
          previousCustomName: null,
          newCustomName: "session a",
        }),
      ).toBe(false);
    }
  });

  it("does not forward for a plain shell tab with no executor", () => {
    expect(
      shouldForwardRename({
        executor: null,
        kind: "shell",
        previousCustomName: null,
        newCustomName: "session a",
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `cd ui && npx vitest run src/tabs/__tests__/rename-forward.test.ts`
Expected: FAIL — `shouldForwardRename` is not exported from `../manager`.

- [ ] **Step 4: Do not commit yet**

The test stays red until Task 4 makes it green. Continue to Task 4.

---

## Task 4: Implement `shouldForwardRename` + wire into `commitTabRename`

**Files:**
- Modify: `ui/src/tabs/manager.ts` (export the helper near the top of the file alongside other module-level helpers like `tabDisplayName` near line 329; modify `commitTabRename` at line 3403)

- [ ] **Step 1: Add the exported helper**

Insert near `tabDisplayName` (around line 329) — just below it is fine. The helper is module-level, not a method:

```ts
export function shouldForwardRename(args: {
  executor: string | null;
  kind: "shell" | "pi";
  previousCustomName: string | null;
  newCustomName: string | null;
}): boolean {
  const wasUnnamed =
    !args.previousCustomName || args.previousCustomName.trim().length === 0;
  const isNamedNow =
    !!args.newCustomName && args.newCustomName.trim().length > 0;
  const isPi = args.kind === "pi" || args.executor === "pi";
  return wasUnnamed && isNamedNow && isPi;
}
```

- [ ] **Step 2: Import the api wrapper**

At the top of `manager.ts`, find the existing `api` imports and add `piSetSessionName`. Search for the line that imports from `"../api"`. Add `piSetSessionName` to the named imports.

If `manager.ts` does not currently import from `../api` directly (it may go through a re-export), add:

```ts
import { piSetSessionName } from "../api";
```

near the other top-of-file imports.

- [ ] **Step 3: Modify `commitTabRename` to forward**

Current code (manager.ts:3403):

```ts
private commitTabRename(id: string, value: string): void {
  const tab = this.tabs.find((t) => t.id === id);
  if (!tab) return;
  const trimmed = value.trim();
  tab.customName = trimmed.length > 0 ? trimmed : null;
  this.rememberSessionName(tab.sessionId, tabDisplayName(tab));
  this.renaming = null;
  this.renderTabbar();
  if (id === this.activeId) this.emitActiveTab();
  this.scheduleSave();
  this.pushExcludedToStatusBar();
}
```

Replace with:

```ts
private commitTabRename(id: string, value: string): void {
  const tab = this.tabs.find((t) => t.id === id);
  if (!tab) return;
  const previousCustomName = tab.customName;
  const trimmed = value.trim();
  const newCustomName = trimmed.length > 0 ? trimmed : null;
  tab.customName = newCustomName;
  this.rememberSessionName(tab.sessionId, tabDisplayName(tab));
  this.renaming = null;
  this.renderTabbar();
  if (id === this.activeId) this.emitActiveTab();
  this.scheduleSave();
  this.pushExcludedToStatusBar();

  if (
    newCustomName &&
    shouldForwardRename({
      executor: tab.executor,
      kind: tab.kind,
      previousCustomName,
      newCustomName,
    })
  ) {
    // Fire-and-forget: if the agent isn't actually attached or the RPC
    // errors, the local rename has already succeeded and that's the
    // part the user cares about. Log at debug for diagnosis.
    void piSetSessionName(tab.sessionId, newCustomName).catch((err) => {
      console.debug("piSetSessionName failed", { sessionId: tab.sessionId, err });
    });
  }
}
```

- [ ] **Step 4: Run the failing test — it should now pass**

Run: `cd ui && npx vitest run src/tabs/__tests__/rename-forward.test.ts`
Expected: PASS — all 6 cases.

- [ ] **Step 5: Run full TS typecheck**

Run: `cd ui && npm run typecheck`
Expected: 0 errors.

- [ ] **Step 6: Commit (test + implementation together)**

```bash
git add ui/src/tabs/manager.ts ui/src/tabs/__tests__/rename-forward.test.ts
git commit -m "feat(tabs): forward rename into pi session when previously unnamed"
```

---

## Task 5: Manual smoke test

This is a UI feature with PTY round-trip. The unit tests cover the decision but not the wire. Verify end-to-end before claiming done.

- [ ] **Step 1: Build the app**

Run: `cargo tauri dev` (or whatever the project's standard dev command is — check `package.json` scripts in the repo root or `ui/`).

- [ ] **Step 2: Open a pi tab**

Open the app, open a new pi tab (whichever UI affordance currently creates one — usually the executor picker / `+` menu).

- [ ] **Step 3: Confirm tab is unnamed**

The tab should show its `defaultTitle` (e.g. "pi" or a generated label). No `customName`.

- [ ] **Step 4: Rename it**

Double-click the tab → type `smoke-test-rename` → Enter.

- [ ] **Step 5: Confirm the forward fired**

In the dev console: no `piSetSessionName failed` debug log should appear (it should succeed silently).

In pi's session state (use whatever pi UI surfaces the session name — the side panel or pi's own metadata view), confirm the session is now labeled `smoke-test-rename`.

- [ ] **Step 6: Re-rename, confirm no second forward**

Rename the same tab to `smoke-test-rename-2`. Add a temporary `console.log` inside the forwarding branch in `commitTabRename` if needed to confirm it is NOT entered on the second rename (because `previousCustomName` is now non-null). Remove the log before committing.

Expected: forwarding skipped on the second rename.

- [ ] **Step 7: Open a shell tab with claude/codex/opencode/copilot running, rename it**

For at least one non-pi executor: open a shell tab, run `claude` (or whatever's available), rename the tab. Confirm no errors in console — the local rename works, no forward attempted.

- [ ] **Step 8: If a temporary log was added in step 6, ensure it was removed**

Run: `git diff ui/src/tabs/manager.ts`
Expected: only the Task 4 changes — no stray `console.log`.

- [ ] **Step 9: Final commit if any smoke-test fixes were needed**

Otherwise skip.

---

## Verification

Run all of the following and confirm green before reporting complete:

- [ ] `cargo check -p karl-app`
- [ ] `cargo test -p karl-app` (no new test on Rust side, but ensure nothing broke)
- [ ] `cd ui && npx vitest run src/tabs/__tests__/rename-forward.test.ts`
- [ ] `cd ui && npm run typecheck`
- [ ] Manual smoke test (Task 5) completed end-to-end

---

## Notes for future executors

When `claude`, `codex`, `copilot`, or `opencode` gains a documented runtime rename surface (a CLI flag, a control-channel message, etc.), the change is:

1. Add a method on that adapter (`crates/capabilities/src/adapters/<name>.rs`).
2. Add a Tauri command analogous to `pi_set_session_name`.
3. Extend `shouldForwardRename` to return `true` for that executor.
4. Extend the dispatch in `commitTabRename` to call the right wrapper.

Do **not** simulate rename by writing slash-commands into the PTY. That races with the user's input buffer and was explicitly out of scope per the spec.
