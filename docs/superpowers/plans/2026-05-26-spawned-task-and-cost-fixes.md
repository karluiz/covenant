# Spawned-task wiring + operator cost & error labels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land four small fixes that together: (1) auto-rename + auto-attach mission on spawned executor tabs, (2) cut idle WAIT cost by short-circuiting triage when the executor screen hasn't materially changed since the last Wait, (3) stop labelling Azure / OpenAI-compat errors as "anthropic api".

**Architecture:** Three focused commits in order. (1) `AgentError::Api` grows a `provider: &'static str` field; each provider passes its name. (2) New backend `prime_spawned_tab` Tauri command bundles mission attach + rename slot atomically; frontend awaits it before the existing 1500ms prompt-inject delay; the old fire-and-forget `setMissionForSpawnedTab` wire is removed. (3) Pre-triage gate in `operator.rs::run_tick` reuses the existing `compute_progress_signature` helper (already strips ANSI/spinner/timer churn) and the existing `progress_sig_at_last_wait` field — short-circuits to a synthesized Wait when the despinnered screen signature matches the previous Wait's.

**Tech Stack:** Rust (axum-less Tauri 2 backend, tokio, thiserror), TypeScript (Vite + xterm.js frontend), `cargo test` for backend, `vitest` for frontend.

**Scope reduction vs spec:** the spec proposed two complementary cost gates (busy-indicator substring scan + tail-hash equality). Investigation revealed `compute_progress_signature` (`operator.rs:3868`) already does ANSI-strip + Braille-spinner-strip + timer-token-strip, and `progress_sig_at_last_wait` (`operator.rs:548`) is already maintained per session by the existing loop guard. So Task 3 collapses to one gate reusing both. The busy-indicator constant becomes unnecessary — YAGNI'd out. If a future executor's spinner isn't covered by `strip_spinner_churn`'s glyph set, we add the glyph there, fixing all uses at once.

**Worktree:** `.claude/worktrees/spawn-task-cost-fixes-a/` on branch `feat/spawn-task-cost-fixes`. All work happens here.

---

## File Structure

**Rust — `crates/agent`:**
- `crates/agent/src/lib.rs` — `AgentError::Api` gains `provider: &'static str`; `Display` format becomes `"{provider} api {status}: {body}"`. Two existing internal construction sites in the same file (triage-parse failures at lines 261, 278) updated to pass `"internal"`.
- `crates/agent/src/provider/anthropic.rs` — pass `"anthropic"` when constructing `Api`.
- `crates/agent/src/provider/azure_foundry.rs` — pass `"azure_foundry"`.
- `crates/agent/src/provider/openai_compat.rs` — pass `"openai_compat"`.
- `crates/agent/tests/error_display.rs` — NEW. One test per provider name + one for the `"internal"` fallback.

**Rust — `crates/app`:**
- `crates/app/src/lib.rs` — new `prime_spawned_tab` Tauri command + entry in `invoke_handler` block (~line 3382, next to `set_session_mission`); two `AgentError::Api { ... }` re-construction sites at 2087 and 2225 of `operator.rs` updated to pass `"internal"` for the fallback-error path.
- `crates/app/src/operator.rs` — pre-triage gate in `run_tick`, immediately before the triage block (~line 2090). Reuses existing helpers; no new fields.

**Frontend:**
- `ui/src/api.ts` — typed wrapper `primeSpawnedTab(sessionId, specPath)`.
- `ui/src/teammate/panel.ts` — replace the fire-and-forget `setMissionForSpawnedTab` block (lines 1353-1359) with an `await primeSpawnedTab(...)` before `injectCommand`; remove the `setMissionForSpawnedTab` field from the `deps` type at line 118.
- `ui/src/main.ts` — remove the `setMissionForSpawnedTab` dep wire-up at lines 588-592 (the underlying `setMissionPathForTab` on the manager stays; it still has other callers).

---

## Task 1: Provider-aware `AgentError::Api`

**Files:**
- Create: `crates/agent/tests/error_display.rs`
- Modify: `crates/agent/src/lib.rs:17-25` (enum), `:261`, `:278`
- Modify: `crates/agent/src/provider/anthropic.rs:107-110`
- Modify: `crates/agent/src/provider/azure_foundry.rs:120-123`
- Modify: `crates/agent/src/provider/openai_compat.rs:83-86`
- Modify: `crates/app/src/operator.rs:2087-2091`, `:2225-2229`

### Step 1: Write failing tests for the new Display format

- [ ] **Step 1: Write `crates/agent/tests/error_display.rs`**

```rust
//! Verifies `AgentError::Api` Display includes the originating provider
//! name. Hardcoded labels were the root cause of "anthropic api 400"
//! showing up on Azure Foundry failures.

use karl_agent::AgentError;

#[test]
fn anthropic_display_carries_provider_name() {
    let e = AgentError::Api {
        provider: "anthropic",
        status: 429,
        body: "rate_limited".into(),
    };
    let s = e.to_string();
    assert!(s.contains("anthropic"), "got: {s}");
    assert!(s.contains("429"), "got: {s}");
    assert!(s.contains("rate_limited"), "got: {s}");
}

#[test]
fn azure_foundry_display_carries_provider_name() {
    let e = AgentError::Api {
        provider: "azure_foundry",
        status: 400,
        body: "{\"error\":{\"message\":\"The response was filtered\"}}".into(),
    };
    let s = e.to_string();
    assert!(s.contains("azure_foundry"), "got: {s}");
    assert!(!s.contains("anthropic"), "must not say anthropic: {s}");
}

#[test]
fn openai_compat_display_carries_provider_name() {
    let e = AgentError::Api {
        provider: "openai_compat",
        status: 401,
        body: "unauthorized".into(),
    };
    let s = e.to_string();
    assert!(s.contains("openai_compat"), "got: {s}");
}

#[test]
fn internal_fallback_is_labelled() {
    // Triage-parse / unavailable-provider paths construct Api with
    // status=0; the label must still be present so logs are honest.
    let e = AgentError::Api {
        provider: "internal",
        status: 0,
        body: "triage reply: unknown action \"foo\"".into(),
    };
    let s = e.to_string();
    assert!(s.contains("internal"), "got: {s}");
}
```

- [ ] **Step 2: Run tests to confirm compile failure**

Run: `cargo test -p karl-agent --test error_display 2>&1 | tail -20`
Expected: compile error — `AgentError::Api` has no `provider` field yet.

### Step 3: Update `AgentError::Api`

- [ ] **Step 3: Edit `crates/agent/src/lib.rs` lines 17-25**

Replace:

```rust
#[derive(Debug, Error)]
pub enum AgentError {
    #[error("anthropic api key is empty")]
    MissingKey,
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("anthropic api {status}: {body}")]
    Api { status: u16, body: String },
}
```

with:

```rust
#[derive(Debug, Error)]
pub enum AgentError {
    #[error("api key is empty")]
    MissingKey,
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("{provider} api {status}: {body}")]
    Api {
        provider: &'static str,
        status: u16,
        body: String,
    },
}
```

### Step 4: Update internal Api constructors in `crates/agent/src/lib.rs`

- [ ] **Step 4: Patch line 261 (`parse_triage_reply` JSON parse failure)**

Replace:

```rust
        serde_json::from_str(&candidate).map_err(|e| AgentError::Api {
            status: 0,
            body: format!(
                "triage reply not JSON: {e} — raw: {}",
                truncate_for_err(text)
            ),
        })?;
```

with:

```rust
        serde_json::from_str(&candidate).map_err(|e| AgentError::Api {
            provider: "internal",
            status: 0,
            body: format!(
                "triage reply not JSON: {e} — raw: {}",
                truncate_for_err(text)
            ),
        })?;
```

- [ ] **Step 5: Patch line 278 (`parse_triage_reply` unknown action)**

Replace:

```rust
        other => {
            return Err(AgentError::Api {
                status: 0,
                body: format!("triage reply: unknown action {other:?}"),
            });
        }
```

with:

```rust
        other => {
            return Err(AgentError::Api {
                provider: "internal",
                status: 0,
                body: format!("triage reply: unknown action {other:?}"),
            });
        }
```

### Step 6-8: Update each provider's Api construction site

- [ ] **Step 6: Patch `crates/agent/src/provider/anthropic.rs:107-110`**

Replace:

```rust
            return Err(AgentError::Api {
                status: status.as_u16(),
                body,
            });
```

with:

```rust
            return Err(AgentError::Api {
                provider: "anthropic",
                status: status.as_u16(),
                body,
            });
```

- [ ] **Step 7: Patch `crates/agent/src/provider/azure_foundry.rs:120-123`**

Replace:

```rust
            return Err(AgentError::Api {
                status: status.as_u16(),
                body,
            });
```

with:

```rust
            return Err(AgentError::Api {
                provider: "azure_foundry",
                status: status.as_u16(),
                body,
            });
```

- [ ] **Step 8: Patch `crates/agent/src/provider/openai_compat.rs:83-86`**

Replace:

```rust
            return Err(AgentError::Api {
                status: status.as_u16(),
                body,
            });
```

with:

```rust
            return Err(AgentError::Api {
                provider: "openai_compat",
                status: status.as_u16(),
                body,
            });
```

### Step 9-10: Update downstream `operator.rs` constructors

- [ ] **Step 9: Patch `crates/app/src/operator.rs:2087-2091`** (triage-provider-unavailable fallback)

Replace:

```rust
                    Err(karl_agent::AgentError::Api {
                        status: 0,
                        body: e.to_string(),
                    })
```

with:

```rust
                    Err(karl_agent::AgentError::Api {
                        provider: "internal",
                        status: 0,
                        body: e.to_string(),
                    })
```

- [ ] **Step 10: Patch `crates/app/src/operator.rs:2225-2229`** (decision-provider-unavailable fallback)

Replace:

```rust
                        Err(karl_agent::AgentError::Api {
                            status: 0,
                            body: e.to_string(),
                        })
```

with:

```rust
                        Err(karl_agent::AgentError::Api {
                            provider: "internal",
                            status: 0,
                            body: e.to_string(),
                        })
```

### Step 11: Verify, run tests, build

- [ ] **Step 11: Run new test file**

Run: `cargo test -p karl-agent --test error_display 2>&1 | tail -20`
Expected: 4 passing tests.

- [ ] **Step 12: Run existing agent + app tests to catch ripple**

Run: `cargo test -p karl-agent 2>&1 | tail -20`
Expected: all existing tests pass. Specifically `crates/agent/tests/provider_azure_foundry.rs` line 129 destructures `AgentError::Api { status, .. }` — the `..` covers the new field, so no change needed there.

Run: `cargo build -p covenant 2>&1 | tail -15`
Expected: clean build (the new field forces every construction site to be updated; the compiler is exhaustive — if a site was missed, this fails loudly).

### Step 13: Commit

- [ ] **Step 13: Commit Task 1**

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a
git add crates/agent/src/lib.rs crates/agent/src/provider/anthropic.rs crates/agent/src/provider/azure_foundry.rs crates/agent/src/provider/openai_compat.rs crates/agent/tests/error_display.rs crates/app/src/operator.rs
git commit -m "$(cat <<'EOF'
fix(agent): tag AgentError::Api with originating provider name

Errors from Azure Foundry or OpenAI-compatible providers were rendered
as "anthropic api {status}: {body}" because the Display format was
hardcoded. The activity feed showed "anthropic api 400" for Azure
content-filter rejections, hiding which provider actually failed.

Adds `provider: &'static str` to the variant; each provider impl passes
its own name. Internal fallback paths (triage parse, provider-resolve
failures) use "internal".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `prime_spawned_tab` command + frontend swap

**Files:**
- Modify: `crates/app/src/lib.rs` — add `prime_spawned_tab` command (~near `set_session_mission` at line 903) + register in `invoke_handler` block (~line 3382)
- Modify: `crates/app/src/operator.rs` — make `slug_from_mission_path` and a setter for `aom_startup.rename_to` reachable from `lib.rs`
- Modify: `ui/src/api.ts` — `primeSpawnedTab` wrapper
- Modify: `ui/src/teammate/panel.ts:118` (deps type) and `:1353-1359` (call site)
- Modify: `ui/src/main.ts:588-592` (remove dep wire)

### Step 1: Expose the rename-slot helper from `operator.rs`

The existing `aom_startup.rename_to = Some(slug)` mutation happens in two
places already (`operator.rs:1283`, `:5465`), both deep inside private
methods. Add a thin pub method on `Operator` so `lib.rs` doesn't reach
into private state.

- [ ] **Step 1: Add to `crates/app/src/operator.rs` near the other `pub async fn` methods on `Operator` (after `clear_mission` at line 956)**

```rust
    /// Queue an `aom_startup.rename_to` slot on a session. The next
    /// time the executor reaches idle and matches a claude/pi pattern,
    /// `/rename <slug>\r` (or `/name <slug>\r` for pi) gets injected.
    /// Used by `prime_spawned_tab` so a spawned executor inherits the
    /// originating chat's spec slug. No-op if the session isn't yet
    /// attached — the caller orders this after `set_mission` so the
    /// session is guaranteed to be present.
    pub async fn queue_aom_rename(&self, session_id: SessionId, slug: String) {
        if slug.is_empty() {
            return;
        }
        let mut inner = self.inner.lock().await;
        if let Some(att) = inner.sessions.get_mut(&session_id) {
            att.aom_startup.rename_to = Some(slug);
        }
    }
```

- [ ] **Step 2: Make `slug_from_mission_path` pub(crate)**

Edit `crates/app/src/operator.rs:4130`. Change:

```rust
fn slug_from_mission_path(path: &std::path::Path) -> String {
```

to:

```rust
pub(crate) fn slug_from_mission_path(path: &std::path::Path) -> String {
```

### Step 3: Add the Tauri command in `crates/app/src/lib.rs`

- [ ] **Step 3: Add immediately after `set_session_mission` (after line 911)**

```rust
/// Atomic priming for a freshly-spawned executor tab. Attaches the
/// originating chat's spec as the session mission AND queues a
/// `/rename <slug>` for the next idle. The frontend awaits this before
/// injecting the executor's first prompt so both effects land before
/// the executor's first reply. See spec
/// `docs/superpowers/specs/2026-05-26-spawned-task-and-cost-fixes-design.md`.
#[tauri::command]
async fn prime_spawned_tab(
    state: State<'_, AppState>,
    session_id: String,
    spec_path: String,
) -> Result<(), String> {
    let id = parse_id(&session_id)?;
    let path = std::path::PathBuf::from(&spec_path);
    let mref = mission_pair::MissionRef::covenant(path.clone());
    // Mission attach first — surfaces real errors (file not found,
    // permission denied) before we silently queue a rename for a
    // tab whose mission failed. The rename queue is best-effort.
    state.operator.set_mission(id, mref).await?;
    let slug = operator::slug_from_mission_path(&path);
    state.operator.queue_aom_rename(id, slug).await;
    Ok(())
}
```

### Step 4: Register the command in the `invoke_handler` block

- [ ] **Step 4: Edit `crates/app/src/lib.rs` line 3382** (the existing `set_session_mission,` line)

Replace:

```rust
            set_session_mission,
```

with:

```rust
            set_session_mission,
            prime_spawned_tab,
```

### Step 5: Verify build

- [ ] **Step 5: Build the binary**

Run: `cargo build -p covenant 2>&1 | tail -10`
Expected: clean build. (Compiles the new command + registration. Frontend not yet wired but backend is callable.)

### Step 6: Add the frontend typed wrapper

- [ ] **Step 6: Add to `ui/src/api.ts` immediately after `setSessionMission` (after line 559)**

```typescript
/// Atomic priming for a freshly-spawned executor tab. Attaches the
/// originating chat's spec as the mission AND queues a /rename slot
/// to be injected on next idle. Backend: `prime_spawned_tab` in
/// `crates/app/src/lib.rs`. The caller MUST await this before
/// injecting the executor's first prompt.
export async function primeSpawnedTab(
  sessionId: SessionId,
  specPath: string,
): Promise<void> {
  return invoke<void>("prime_spawned_tab", {
    sessionId,
    specPath,
  });
}
```

### Step 7: Wire the call site in `ui/src/teammate/panel.ts`

- [ ] **Step 7: Edit `ui/src/teammate/panel.ts:1353-1359`**

Replace:

```typescript
          // Auto-set mission if the originating chat had a @spec chip.
          if (specPath && this.deps.setMissionForSpawnedTab) {
            this.lastSentSpecPath = null;
            this.deps.setMissionForSpawnedTab(spawned.sessionId, specPath).catch((e) =>
              console.error("auto-set mission failed", e),
            );
          }
```

with:

```typescript
          // Auto-attach mission + queue /rename if the originating chat
          // had a @spec chip. We AWAIT this (unlike the old fire-and-
          // forget setMissionForSpawnedTab) so the rename slot is in
          // place before the prompt-inject setTimeout fires below.
          // Even if priming fails (e.g. spec deleted) we still inject
          // the prompt — the spec content already inlined into the
          // prompt via buildTaskInjection covers the executor.
          if (specPath) {
            this.lastSentSpecPath = null;
            try {
              await primeSpawnedTab(spawned.sessionId, specPath);
            } catch (e) {
              console.error("prime_spawned_tab failed", e);
            }
          }
```

- [ ] **Step 8: Add `primeSpawnedTab` to the value-import block at the top of `ui/src/teammate/panel.ts`**

The file's value imports from `../api` are in the `import { ... } from "../api"` block starting at line 3. Edit line 6:

Replace:

```typescript
  injectCommand, onTeammateMessage, onTeammateToolCall, operatorLevelFromXp,
```

with:

```typescript
  injectCommand, onTeammateMessage, onTeammateToolCall, operatorLevelFromXp, primeSpawnedTab,
```

### Step 9: Remove the dead dep type from `panel.ts`

- [ ] **Step 9: Edit `ui/src/teammate/panel.ts:118`**

Delete the line:

```typescript
  setMissionForSpawnedTab?: (sessionId: string, specPath: string) => Promise<void>;
```

(It's no longer referenced anywhere after step 7.)

### Step 10: Remove the dep wire from `main.ts`

- [ ] **Step 10: Edit `ui/src/main.ts:588-592`**

Delete this block:

```typescript
    setMissionForSpawnedTab: async (sessionId, specPath) => {
      const tab = manager.tabForSession(sessionId as SessionId);
      if (!tab) return;
      await manager.setMissionPathForTab(tab.id, specPath);
    },
```

(`manager.setMissionPathForTab` itself stays — still used by the mission picker, watcher reload, etc.)

### Step 11: Verify frontend builds + types check

- [ ] **Step 11: Run vitest type check + tests for the teammate panel**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a/ui && npm run typecheck 2>&1 | tail -20`
Expected: no type errors. If the typecheck script doesn't exist, run `npx tsc --noEmit` instead.

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a/ui && npx vitest run teammate/panel 2>&1 | tail -30`
Expected: existing teammate panel tests pass. The previously stubbed `setMissionForSpawnedTab` in those tests becomes dead code; no harm.

### Step 12: Manual smoke test (no automated UI test for this end-to-end)

- [ ] **Step 12: Run the dev binary, reproduce the spawned-task flow**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a && cargo run -p covenant 2>&1 | tail -5`

Then in the running app:
1. Open a Mibli chat in any tab.
2. Type a message that includes a `@spec` mention (any markdown file under `docs/superpowers/specs/`).
3. Confirm the propose_task card.
4. Observe the new tab: mission badge should appear at the top, and within ~1s the executor should run `/rename <slug>` automatically (visible in the terminal as the tab title changing from `claude` to the spec slug).

Expected: both badge and rename happen before the executor's first prompt finishes streaming.

### Step 13: Commit

- [ ] **Step 13: Commit Task 2**

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a
git add crates/app/src/lib.rs crates/app/src/operator.rs ui/src/api.ts ui/src/teammate/panel.ts ui/src/main.ts
git commit -m "$(cat <<'EOF'
feat(operator): atomically prime spawned tabs with mission + /rename

Spawned executor tabs originating from a Mibli chat with an @spec chip
inherited only the prompt text — the mission badge and tab /rename were
either missed entirely (rename) or fire-and-forget with a race against
prompt injection (mission). Result: tabs stayed named "claude" and the
authoritative spec wasn't in the operator's system prompt.

Adds `prime_spawned_tab(session_id, spec_path)` Tauri command that
attaches the mission and queues the AOM /rename slot in one awaited
call. Frontend now awaits this before the existing 1500ms inject
delay, so both effects land before the executor's first reply.

Removes the old fire-and-forget setMissionForSpawnedTab dep wire — the
underlying tabs-manager helper stays for other callers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Pre-triage cost gate

**Files:**
- Modify: `crates/app/src/operator.rs` — add gate immediately before the triage block in `run_tick` (~line 2090). Reuses `compute_progress_signature` (operator.rs:3868) and the existing `progress_sig_at_last_wait` field on `Attached` (operator.rs:548).

**Why no new fields:** the existing idle-wait loop guard at `operator.rs:2592-2611` already maintains `att.progress_sig_at_last_wait` (the despinnered, detimerd, ANSI-stripped tail signature from the last Wait) and `att.consecutive_idle_waits` (count of consecutive matching Waits). The gate just consults those same values *before* triage rather than only after, short-circuiting to a synthesized Wait when they indicate "screen hasn't materially changed since last Wait."

### Step 1: Write the failing unit test

The existing test scaffolding in `operator.rs` has a `mod tests` near the bottom. We'll add to it.

- [ ] **Step 1: Add a unit test to `crates/app/src/operator.rs` inside the existing `#[cfg(test)] mod tests` block**

First, locate the test module:

```bash
grep -n "^#\[cfg(test)\]\|^mod tests" /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a/crates/app/src/operator.rs | head -5
```

Then add this test inside the module:

```rust
    /// Pre-triage cost gate: when `consecutive_idle_waits > 0` AND the
    /// current tail's progress signature equals `progress_sig_at_last_wait`,
    /// `should_skip_triage_for_idle_repeat` must return true so the
    /// caller can synthesize a Wait without calling the triage model.
    /// The check is symmetric with the existing post-triage idle-WAIT
    /// loop guard (`operator.rs:2592-2611`), just consulted earlier.
    #[test]
    fn pretriage_gate_fires_when_signature_repeats() {
        let tail = b"Composing... 10m 24s\n[Esc to interrupt]\n".to_vec();
        let sig = compute_progress_signature(&tail);
        // First Wait: counter at 1, signature stored. Gate must NOT fire
        // (we have no prior wait to compare against).
        assert!(!should_skip_triage_for_idle_repeat(0, 0, sig));
        // Subsequent tick, same screen: counter > 0, sig matches → skip.
        assert!(should_skip_triage_for_idle_repeat(1, sig, sig));
        // Screen changed → gate must NOT fire even if counter > 0.
        let new_sig = sig.wrapping_add(1);
        assert!(!should_skip_triage_for_idle_repeat(1, sig, new_sig));
        // Counter reset to 0 (e.g. after non-Wait outcome) → gate must
        // NOT fire even if the cached sig happens to match.
        assert!(!should_skip_triage_for_idle_repeat(0, sig, sig));
    }
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a && cargo test -p covenant operator::tests::pretriage_gate 2>&1 | tail -20`
Expected: compile error — `should_skip_triage_for_idle_repeat` doesn't exist yet.

### Step 3: Implement the gate helper

- [ ] **Step 3: Add to `crates/app/src/operator.rs` near the other pure helpers (next to `compute_progress_signature` at line 3868)**

```rust
/// Pre-triage cost gate. Returns true when the operator should skip
/// the (paid) triage model call and synthesize a Wait inline.
///
/// Inputs come straight from the Attached struct + the current tick's
/// tail signature; the function is pure so it's trivially testable.
///
/// The semantics mirror the existing post-triage idle-WAIT detector
/// (`operator.rs:2592-2611`): a Wait is "repeated" when the despinnered
/// screen signature matches the previous Wait's AND we already have at
/// least one consecutive Wait on file. We just consult those signals
/// earlier (before paying for triage) to skip the call entirely.
pub(crate) fn should_skip_triage_for_idle_repeat(
    consecutive_idle_waits: u32,
    progress_sig_at_last_wait: u64,
    current_progress_sig: u64,
) -> bool {
    consecutive_idle_waits > 0 && current_progress_sig == progress_sig_at_last_wait
}
```

- [ ] **Step 4: Run the test to confirm pass**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a && cargo test -p covenant operator::tests::pretriage_gate 2>&1 | tail -10`
Expected: 1 passed.

### Step 5: Wire the gate into `run_tick`

The triage block in `run_tick` starts around `operator.rs:2080` (the `if mind_v2_on { ... }` branch that calls the triage provider). We insert the gate immediately before that block. The gate produces a `triage_short_circuit` Wait identically to the existing low-confidence-Act / Wait / Yield branches, so all downstream code (synth AskResponse at line 2168, persistence, loop-guard updates) handles it for free.

- [ ] **Step 5: Locate the triage variable declarations**

Run: `grep -n "let mut triage_short_circuit\|let mut triage_yielded\|let mut triage_cost_usd" /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a/crates/app/src/operator.rs | head -5`
Expected: three consecutive lines around 2049-2051:

```
2049:        let mut triage_short_circuit: Option<OperatorAction> = None;
2050:        let mut triage_cost_usd = 0.0_f64;
2051:        let mut triage_yielded = false;
```

The triage call itself follows immediately after these declarations (the `if mind_v2_on { ... triage_result = ...; match triage_result { ... } }` block at lines 2052+).

- [ ] **Step 6: Insert the gate immediately AFTER line 2051 (after `let mut triage_yielded = false;`)**

The tail-bytes variable in scope at this point is named `tail` (a `Vec<u8>` declared at line ~1795). `inner`, `session_id` are in scope and used by the existing triage match at line 2113 in the same shape.

Insert this block:

```rust
        // Pre-triage cost gate. If the executor's despinnered screen
        // signature matches the last Wait's AND we have a prior Wait on
        // file, the operator already paid the triage call to confirm
        // "nothing to do here" — repeating it would just spend another
        // ~$0.018 to reach the same verdict. Synthesize a free Wait and
        // skip triage entirely. The downstream loop-guard at
        // `operator.rs:2592-2611` will then re-bump the counter for the
        // synthesized Wait, eventually triggering an `idle-wait` escalate
        // exactly as today — just at the same number of Waits but at
        // zero triage cost.
        let pretriage_sig = compute_progress_signature(&tail);
        let (pretriage_skip, pretriage_prior_count, pretriage_prior_sig) = {
            let i = inner.lock().await;
            match i.sessions.get(&session_id) {
                Some(att) => (
                    should_skip_triage_for_idle_repeat(
                        att.consecutive_idle_waits,
                        att.progress_sig_at_last_wait,
                        pretriage_sig,
                    ),
                    att.consecutive_idle_waits,
                    att.progress_sig_at_last_wait,
                ),
                None => (false, 0, 0),
            }
        };
        if pretriage_skip {
            tracing::debug!(
                session = %session_id,
                prior_waits = pretriage_prior_count,
                "operator: pre-triage gate fired (screen unchanged since last wait)"
            );
            triage_short_circuit = Some(OperatorAction::Wait {
                rationale: format!(
                    "pre-triage: screen unchanged (cached sig {:x}, {} prior waits)",
                    pretriage_prior_sig, pretriage_prior_count,
                ),
            });
        }
```

**Sanity checks the engineer should confirm by looking at the surrounding code:**
- `tail` is the `Vec<u8>` snapshot declared around line 1795 (`let (idle, bytes_total, tail) = { ... st.snapshot_tail(SUMMARY_TAIL_TARGET) ... };`).
- `OperatorAction::Wait { rationale: String }` is the exact struct shape — confirm against the existing assignment at line 2113.
- The existing `inner.lock().await` pattern (also used by the triage block at line 2098+) is async — the gate's lock is short-lived and released before the triage block runs.

### Step 7: Verify the gate doesn't break the existing triage flow

- [ ] **Step 7: Build covenant binary**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a && cargo build -p covenant 2>&1 | tail -15`
Expected: clean build.

- [ ] **Step 8: Run full operator test suite**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a && cargo test -p covenant operator:: 2>&1 | tail -30`
Expected: all tests pass, including the new `pretriage_gate_fires_when_signature_repeats`.

### Step 9: Manual verification — observe a $0 Wait in the Activity feed

The fastest way to confirm the gate fires: run the binary, spawn an executor that stays on a spinner for a few ticks (e.g. claude composing a long response), and watch the Mibli Activity panel for the rationale `"pre-triage: screen unchanged (...)"` with `$0.000` cost (no triage line item).

- [ ] **Step 9: Run binary, observe gated Waits**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a && cargo run -p covenant 2>&1 | tail -5`

In the running app:
1. Enable AOM on a tab.
2. Start a claude task that will think for >5s (e.g. ask a complex question, or use the spawned-task flow from Task 2 with a long spec).
3. Open the Activity panel for the operator on that tab.
4. Within ~10s of the executor showing "Composing…", observe at least one Wait row with rationale starting `"pre-triage: …"` and cost `$0.000`.

If you don't see the cost reduction in the visible Activity ribbon (which sums all cost categories), check the `tracing` debug log for the line `"operator: pre-triage gate fired"` — that confirms the path is taken.

### Step 10: Commit

- [ ] **Step 10: Commit Task 3**

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a
git add crates/app/src/operator.rs
git commit -m "$(cat <<'EOF'
perf(operator): skip triage when screen unchanged since last wait

Idle executor sessions (spinner phase, stable prompt waiting, etc.)
were paying ~$0.018 per tick for the triage Haiku call to repeatedly
conclude "nothing to do." A single Mibli session running an
achievements MVP racked up 45 WAITs (~$0.81) in ~30 minutes, every
one of them a known-no-op call.

Adds a free pre-triage gate that consults the existing
`progress_sig_at_last_wait` + `consecutive_idle_waits` fields (already
maintained by the post-triage idle-WAIT loop guard for the same
"despinnered screen unchanged" semantic). When the gate fires, the
operator synthesizes a Wait inline with zero LLM cost; the downstream
loop guard still re-bumps the counter so `idle-wait` escalation fires
at the same Wait number as today, just at no triage spend.

Reuses `compute_progress_signature` (already strips ANSI + Braille
spinners + elapsed-timer tokens) so no new pattern list to maintain
and animated TUIs (Claude Code's "Composing…") collapse to a stable
signature exactly as the loop guard expects.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Step F1: Full backend test suite**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a && cargo test 2>&1 | tail -30`
Expected: all tests pass.

- [ ] **Step F2: Full frontend test suite + type check**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a/ui && npx tsc --noEmit && npx vitest run 2>&1 | tail -30`
Expected: clean type check, all tests pass.

- [ ] **Step F3: End-to-end smoke**

Run the binary, perform the spawn-task flow from Task 2 Step 12. Observe:
1. Mission badge appears on the spawned tab.
2. Executor `/rename`s automatically within ~1-2s.
3. Activity feed for the operator shows `$0.000` Waits with `"pre-triage: …"` rationale during the executor's busy phases.
4. Any provider error (force one with a bogus Azure key, optional) is labelled with the actual provider name in the Activity card, not "anthropic api".

- [ ] **Step F4: Push branch (optional, only when user is ready to PR)**

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/spawn-task-cost-fixes-a
git push -u origin feat/spawn-task-cost-fixes
```
