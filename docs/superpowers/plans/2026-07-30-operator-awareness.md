# Operator Awareness (terrain collision brake) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A group supervisor loses decision authority whenever two or more of the sessions it supervises share one git working tree, and says so through the escalation lane.

**Architecture:** A pure detector in `crates/app/src/group_supervision.rs` groups the supervised sessions by their resolved git toplevel. When a collision is present, the watcher emits a `group-supervision-braked` Tauri event and publishes an `EscalationRequested` on the existing escalation bus; the frontend's existing `TabManager.setGroupIntervene(groupId, false)` does the actual disarming. Terrain going clean again re-arms through the same event with `braked: false`.

**Tech Stack:** Rust (tokio, tauri 2, `karl_session` events), TypeScript (no framework), Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-07-30-operator-awareness-design.md`

## Global Constraints

- No `unwrap()` outside `#[cfg(test)]` and `main()`.
- `tracing` with structured fields (`group = %group_id`), never string-interpolated.
- No sync I/O on an async task — the `git` shell-outs go through `tokio::task::spawn_blocking`.
- All user-visible copy is English.
- TypeScript is `strict: true`; no `as any` without a justifying comment.
- Deliberate shortcuts get a `// ponytail:` comment naming the ceiling.
- Conventional Commits. One commit per task.
- Rust tests: `cargo test -p karl-app group_supervision`. Frontend: `npm test` from the repo ROOT.

---

### Task 1: Terrain collision detector

Pure functions only — no git, no tauri, no locks. Everything that decides
*whether* to brake lives here so it can be tested without an app.

**Files:**
- Modify: `crates/app/src/group_supervision.rs` (add below `decides()`, around line 248)
- Test: same file, in the existing `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: `karl_session::SessionId`
- Produces:
  - `struct Collision { root: PathBuf, sessions: Vec<SessionId> }`
  - `fn terrain_collision(roots: &[(SessionId, PathBuf)]) -> Option<Collision>`
  - `fn brake_transition(colliding: bool, already_braked: bool) -> Option<bool>`

- [ ] **Step 1: Write the failing tests**

Append to the existing `mod tests` block at the bottom of `crates/app/src/group_supervision.rs`:

```rust
    #[test]
    fn distinct_worktrees_do_not_collide() {
        let a = SessionId::new();
        let b = SessionId::new();
        let roots = vec![
            (a, PathBuf::from("/repo/.covenant/worktrees/one")),
            (b, PathBuf::from("/repo/.covenant/worktrees/two")),
        ];
        assert!(terrain_collision(&roots).is_none());
    }

    #[test]
    fn shared_worktree_collides_and_names_its_sessions() {
        let a = SessionId::new();
        let b = SessionId::new();
        let c = SessionId::new();
        let roots = vec![
            (a, PathBuf::from("/repo")),
            (b, PathBuf::from("/repo/.covenant/worktrees/one")),
            (c, PathBuf::from("/repo")),
        ];
        let hit = terrain_collision(&roots).expect("two sessions share /repo");
        assert_eq!(hit.root, PathBuf::from("/repo"));
        assert_eq!(hit.sessions.len(), 2);
        assert!(hit.sessions.contains(&a));
        assert!(hit.sessions.contains(&c));
    }

    #[test]
    fn a_lone_session_never_collides() {
        let roots = vec![(SessionId::new(), PathBuf::from("/repo"))];
        assert!(terrain_collision(&roots).is_none());
    }

    #[test]
    fn brake_transition_fires_once_and_rearms_once() {
        // Colliding, not yet braked → brake.
        assert_eq!(brake_transition(true, false), Some(true));
        // Still colliding, already braked → say nothing.
        assert_eq!(brake_transition(true, true), None);
        // Clean again, was braked → re-arm.
        assert_eq!(brake_transition(false, true), Some(false));
        // Clean, never braked → say nothing (never re-arms a group the
        // user downgraded by hand).
        assert_eq!(brake_transition(false, false), None);
    }
```

Add `use std::path::PathBuf;` to the test module's `use super::*;` neighbourhood if it is not already in scope from the parent module.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p karl-app group_supervision 2>&1 | tail -30`
Expected: FAIL — `cannot find function terrain_collision in this scope` (and `brake_transition`).

- [ ] **Step 3: Write the implementation**

Add `use std::path::PathBuf;` to the module's imports at the top of
`crates/app/src/group_supervision.rs` (next to `use std::collections::HashMap;`).

Insert after `decides()` (currently ends around line 247):

```rust
/// Two or more supervised sessions standing on one git working tree.
#[derive(Debug, Clone)]
pub(crate) struct Collision {
    pub root: PathBuf,
    pub sessions: Vec<SessionId>,
}

/// Awareness, the whole rule: two executors editing one working tree
/// clobber each other regardless of branch, so no supervisor may hold
/// decision authority over them. Pure — takes already-resolved toplevels
/// so this is testable without git. Sessions whose cwd is not inside a
/// repo are simply absent from `roots` and cannot collide.
///
/// Returns the FIRST colliding root by iteration order; one collision is
/// enough to brake the whole group, so finding all of them buys nothing.
// ponytail: one rule (shared root). Protected branch and dirty-tree
// signals were considered and dropped as noise — see the design doc.
pub(crate) fn terrain_collision(roots: &[(SessionId, PathBuf)]) -> Option<Collision> {
    let mut by_root: HashMap<&PathBuf, Vec<SessionId>> = HashMap::new();
    for (sid, root) in roots {
        by_root.entry(root).or_default().push(*sid);
    }
    // Sort for a stable answer: HashMap iteration order is not.
    let mut hits: Vec<(&PathBuf, Vec<SessionId>)> = by_root
        .into_iter()
        .filter(|(_, sessions)| sessions.len() >= 2)
        .collect();
    hits.sort_by(|a, b| a.0.cmp(b.0));
    let (root, mut sessions) = hits.into_iter().next()?;
    sessions.sort_by_key(|s| s.0);
    Some(Collision {
        root: root.clone(),
        sessions,
    })
}

/// What to announce this tick, given the terrain and what we already
/// announced. `Some(true)` = brake now, `Some(false)` = re-arm now,
/// `None` = nothing changed, stay quiet.
///
/// A group the user downgraded by hand is never in the braked set, so it
/// is never re-armed by this path — we only restore autonomy we ourselves
/// suspended.
pub(crate) fn brake_transition(colliding: bool, already_braked: bool) -> Option<bool> {
    match (colliding, already_braked) {
        (true, false) => Some(true),
        (false, true) => Some(false),
        _ => None,
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p karl-app group_supervision 2>&1 | tail -20`
Expected: PASS — all four new tests green, existing `group_supervision` tests still green.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/group_supervision.rs
git commit -m "feat(awareness): detect two supervised sessions on one working tree

Pure detector: group the supervised sessions by git toplevel, a root with
two or more of them is a collision. brake_transition keeps the announcement
edge-triggered so the brake fires once and only re-arms what it suspended."
```

---

### Task 2: Brake the supervisor and escalate

Wires Task 1 into the live watcher: resolve each member's toplevel, and on
a state change emit the frontend event plus an `EscalationRequested`.

**Files:**
- Modify: `crates/app/src/group_supervision.rs`
  - `Inner` struct (line ~134)
  - `GroupSupervisionWatcher::spawn` initializer (line ~157)
  - `check_for_pattern` (insert after the `supervised_group_for` guard, line ~348, BEFORE the `watcher_owns` gate at line ~356)
  - new helpers at the bottom near `screen_tail` (line ~506)

**Interfaces:**
- Consumes: `terrain_collision`, `brake_transition`, `Collision` (Task 1); `crate::AppState` (for `escalation_bus_tx`, reached exactly like `screen_tail` reaches `state.sessions`); `crate::project_ref::project_ref_from_cwd`.
- Produces: Tauri event `group-supervision-braked` with payload `TerrainBrake` — the frontend contract Task 3 consumes:
  ```jsonc
  {
    "group_id": "...",
    "operator_id": "...",
    "operator_name": "Zeta",
    "braked": true,          // false = terrain clean, re-arm
    "root": "/Users/.../karlTerminal",
    "session_count": 4,
    "message": "Zeta stepped back — 4 sessions share the karlTerminal working tree (main). Supervision is now observe-only."
  }
  ```

- [ ] **Step 1: Add the braked set and the event constant**

At the top of `crates/app/src/group_supervision.rs`, next to `FINDING_EVENT_NAME` (line ~49):

```rust
const BRAKE_EVENT_NAME: &str = "group-supervision-braked";
```

Add to the imports:

```rust
use std::collections::HashSet;
use std::path::Path;
use karl_session::{EscalationKind, OperatorAction as SessionOperatorAction};
```

(merge the `karl_session` names into the existing `use karl_session::{SessionEvent, SessionId};` line rather than adding a second `use`).

Add the field to `Inner` (line ~147, after `recent_findings`):

```rust
    /// Groups whose supervisor we suspended for terrain collision. Keeps
    /// the brake edge-triggered (it would otherwise re-fire on every
    /// wake) and marks exactly which groups this path may re-arm.
    braked: HashSet<String>,
```

And to the initializer inside `spawn` (line ~157):

```rust
            braked: HashSet::new(),
```

- [ ] **Step 2: Add the terrain resolver**

Append near `screen_tail` at the bottom of the file:

```rust
/// Resolve each supervised session's git toplevel. Shells out once per
/// session, so it runs on a blocking task — the watcher's own task must
/// never block. Sessions outside a repo are dropped: nothing to collide
/// with, nothing to protect.
async fn resolve_roots(
    inner: &Arc<Mutex<Inner>>,
    registry: &Arc<OperatorRegistry>,
    group_id: &str,
) -> Vec<(SessionId, PathBuf)> {
    let cwds: Vec<(SessionId, PathBuf)> = {
        let i = inner.lock().await;
        let mut out = Vec::new();
        for sid in registry.group_sessions(group_id) {
            if let Some(world) = i.worlds.get(&sid) {
                out.push((sid, world.lock().await.cwd.clone()));
            }
        }
        out
    };
    tokio::task::spawn_blocking(move || {
        cwds.into_iter()
            .filter_map(|(sid, cwd)| toplevel_of(&cwd).map(|root| (sid, root)))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// `git rev-parse --show-toplevel`, or None when `cwd` is not in a repo.
// ponytail: one process per session per wake, capped by the watcher's
// 6 checks/minute. Cache by cwd string if that ever shows up in a profile.
fn toplevel_of(cwd: &Path) -> Option<PathBuf> {
    let out = std::process::Command::new("git")
        .current_dir(cwd)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}
```

- [ ] **Step 3: Add the announce helper**

Append below `resolve_roots`:

```rust
/// Payload the frontend consumes to downgrade (or restore) the group and
/// to toast the reason. `braked: false` means the terrain came back clean.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerrainBrake {
    pub group_id: String,
    pub operator_id: String,
    pub operator_name: String,
    pub braked: bool,
    pub root: String,
    pub session_count: usize,
    pub message: String,
}

/// Announce a brake / re-arm on both lanes: the Tauri event the frontend
/// acts on, and the escalation bus so it reaches the user the way any
/// "needs you" does (Telegram today, any future subscriber for free).
/// The re-arm only takes the Tauri lane — restoring what the user already
/// asked for is not a "needs you".
async fn announce_brake(
    app: &AppHandle,
    op: &Operator,
    group_id: &str,
    trigger_id: SessionId,
    trigger_cwd: PathBuf,
    hit: Option<&Collision>,
) {
    let payload = match hit {
        Some(c) => TerrainBrake {
            group_id: group_id.to_string(),
            operator_id: op.id.to_string(),
            operator_name: op.name.clone(),
            braked: true,
            root: c.root.display().to_string(),
            session_count: c.sessions.len(),
            message: format!(
                "{} stepped back — {} sessions share the {} working tree. Supervision is now observe-only.",
                op.name,
                c.sessions.len(),
                c.root
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| c.root.display().to_string()),
            ),
        },
        None => TerrainBrake {
            group_id: group_id.to_string(),
            operator_id: op.id.to_string(),
            operator_name: op.name.clone(),
            braked: false,
            root: String::new(),
            session_count: 0,
            message: format!("{} is deciding again — the sessions no longer share a working tree.", op.name),
        },
    };

    if let Err(e) = app.emit(BRAKE_EVENT_NAME, &payload) {
        tracing::warn!(error = ?e, group = %group_id, "failed to emit terrain brake");
    } else {
        tracing::info!(
            group = %group_id,
            braked = payload.braked,
            sessions = payload.session_count,
            "group-supervision terrain brake"
        );
    }

    if !payload.braked {
        return;
    }

    use tauri::Manager;
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    let project = tokio::task::spawn_blocking(move || {
        crate::project_ref::project_ref_from_cwd(&trigger_cwd)
    })
    .await
    .ok();
    let Some(project) = project else { return };

    let _ = state
        .escalation_bus_tx
        .send(SessionEvent::EscalationRequested {
            session: trigger_id,
            escalation_id: ulid::Ulid::new().to_string(),
            kind: EscalationKind::Blocked,
            summary: payload.message.clone(),
            actions: vec![
                SessionOperatorAction::Reply,
                SessionOperatorAction::Snooze { minutes: 10 },
            ],
            operator: op.to_session_ref(),
            project,
        });
}
```

`escalation_bus_tx` is currently `#[allow(dead_code)]` on `AppState` — remove
that attribute if the compiler now says it is unused-attribute; leave it if it
still warns for other reasons.

- [ ] **Step 4: Wire it into `check_for_pattern`**

In `check_for_pattern`, insert this block **between** the `supervised_group_for`
guard (which ends around line 348 with `let group_id = group_id.as_str();`) and
the `watcher_owns` gate at line ~356:

```rust
    // Awareness: a supervisor may not decide for executors that share one
    // working tree — four agents editing one checkout clobber each other
    // regardless of branch. Runs before the ownership gate because the
    // brake changes who owns this turn.
    {
        let roots = resolve_roots(inner, registry, group_id).await;
        let hit = terrain_collision(&roots);
        let already = inner.lock().await.braked.contains(group_id);
        if let Some(brake) = brake_transition(hit.is_some(), already) {
            // Only brake a supervisor that actually holds authority; a
            // group already in observe-only has nothing to take away.
            if !brake || decides(registry, group_id) {
                let trigger_cwd = {
                    let i = inner.lock().await;
                    match i.worlds.get(&trigger_id) {
                        Some(w) => w.lock().await.cwd.clone(),
                        None => PathBuf::from("."),
                    }
                };
                announce_brake(app, &op, group_id, trigger_id, trigger_cwd, hit.as_ref()).await;
                let mut i = inner.lock().await;
                if brake {
                    i.braked.insert(group_id.to_string());
                } else {
                    i.braked.remove(group_id);
                }
                // The brake IS this tick's report. Running the normal
                // check on top would burn a model call to say something
                // less important than what we just said.
                if brake {
                    return Ok(());
                }
            }
        }
    }
```

Note the ordering consequence, worth a comment at the site:
`decides()` will not read `false` until the frontend round-trips
`setGroupIntervene` back through `groupSetSupervisor`. That is why we
`return Ok(())` on the braking tick instead of falling through — one tick of
stale authority, no model call, no toast.

- [ ] **Step 5: Build and run the suite**

Run: `cargo test -p karl-app group_supervision 2>&1 | tail -20`
Expected: PASS, no new warnings. Then:

Run: `cargo clippy -p karl-app --all-targets 2>&1 | grep -E "^(warning|error)" | head -20`
Expected: no new warnings attributable to `group_supervision.rs`.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/group_supervision.rs
git commit -m "feat(awareness): brake a supervisor standing on shared terrain

On collision the watcher emits group-supervision-braked and publishes an
EscalationRequested on the existing bus, then returns — the brake is that
tick's report. Terrain going clean again re-arms through the same event."
```

---

### Task 3: Frontend — downgrade the group and show it

The backend never disarms anything directly; it asks. `setGroupIntervene`
already reverts supervisor-claimed AOM panes, persists
`supervisor_intervene: false` through `groupSetSupervisor`, and repaints.

**Files:**
- Modify: `ui/src/notifications/toast.ts` (the `ToastHost` — where the other `group-supervision-*` Tauri listeners live, ~line 106-150)
- Modify: `ui/src/tabs/manager.ts` (next to the `operator:supervision-disabled` listener, ~line 2517)
- Test: `ui/src/tabs/manager.brake.test.ts` (create)

**Interfaces:**
- Consumes: the `TerrainBrake` payload from Task 2.
- Produces: DOM CustomEvent `"group-supervision:braked"` with
  `detail: { groupId: string; braked: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `ui/src/tabs/manager.brake.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { applyTerrainBrake } from "./manager";

describe("applyTerrainBrake", () => {
  it("downgrades the group to observe-only when braked", () => {
    const setGroupIntervene = vi.fn();
    applyTerrainBrake({ groupId: "g1", braked: true }, setGroupIntervene);
    expect(setGroupIntervene).toHaveBeenCalledWith("g1", false);
  });

  it("re-arms the group when terrain is clean again", () => {
    const setGroupIntervene = vi.fn();
    applyTerrainBrake({ groupId: "g1", braked: false }, setGroupIntervene);
    expect(setGroupIntervene).toHaveBeenCalledWith("g1", true);
  });

  it("ignores a payload with no group", () => {
    const setGroupIntervene = vi.fn();
    applyTerrainBrake({ groupId: "", braked: true }, setGroupIntervene);
    expect(setGroupIntervene).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from the repo ROOT, not `ui/`): `npm test -- manager.brake 2>&1 | tail -20`
Expected: FAIL — `applyTerrainBrake` is not exported from `./manager`.

- [ ] **Step 3: Implement the pure helper and the listener**

In `ui/src/tabs/manager.ts`, add near the other exported free functions
(`panesForIntervene` is at ~line 887 — put it beside that):

```ts
/// Terrain brake → intervene gate. Exported free of TabManager so the
/// mapping is testable without a live tab tree.
export function applyTerrainBrake(
  detail: { groupId: string; braked: boolean },
  setGroupIntervene: (groupId: string, intervene: boolean) => void,
): void {
  if (!detail.groupId) return;
  setGroupIntervene(detail.groupId, !detail.braked);
}
```

Then, inside the constructor's listener block next to the existing
`operator:supervision-disabled` handler (~line 2517):

```ts
    // Awareness: the supervisor is standing on terrain it may not decide
    // on (or that just came clean). Same intervene gate the UI uses.
    window.addEventListener("group-supervision:braked", (ev: Event) => {
      const detail = (ev as CustomEvent<{ groupId: string; braked: boolean }>)
        .detail;
      if (!detail) return;
      applyTerrainBrake(detail, (g, i) => this.setGroupIntervene(g, i));
    });
```

- [ ] **Step 4: Bridge the Tauri event in the toast host**

In `ui/src/notifications/toast.ts`, add a field beside
`unlistenGroupSupervision`:

```ts
  private unlistenTerrainBrake?: UnlistenFn;
```

Add to `start()`:

```ts
    this.unlistenTerrainBrake = await listen<TerrainBrake>(
      "group-supervision-braked",
      (event) => {
        // The manager owns the intervene gate; the toast host only has
        // the Tauri listener, so it forwards and shows the reason.
        window.dispatchEvent(
          new CustomEvent("group-supervision:braked", {
            detail: {
              groupId: event.payload.group_id,
              braked: event.payload.braked,
            },
          }),
        );
        this.showGroupSupervision({
          group_id: event.payload.group_id,
          operator_id: event.payload.operator_id,
          operator_name: event.payload.operator_name,
          message: event.payload.message,
          timestamp_unix_ms: Date.now(),
        });
      },
    );
```

Add to `stop()`:

```ts
    if (this.unlistenTerrainBrake) {
      this.unlistenTerrainBrake();
      this.unlistenTerrainBrake = undefined;
    }
```

And declare the payload type beside the existing `GroupSupervisionFinding`
type import/definition in the same file:

```ts
interface TerrainBrake {
  group_id: string;
  operator_id: string;
  operator_name: string;
  braked: boolean;
  root: string;
  session_count: number;
  message: string;
}
```

Note: the brake is deliberately NOT written into `recordGroupFinding` — it
is not a correlation finding, it is a change of authority, and the escalation
lane already retains it.

- [ ] **Step 5: Run the tests and the type-check**

Run: `npm test -- manager.brake 2>&1 | tail -20`
Expected: PASS, three tests.

Run: `npm run build 2>&1 | tail -20`
Expected: type-check clean, Vite bundle succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/notifications/toast.ts ui/src/tabs/manager.brake.test.ts
git commit -m "feat(awareness): downgrade a braked group to observe-only

The toast host forwards group-supervision-braked to the manager, which runs
the same setGroupIntervene gate the UI uses — supervisor-claimed AOM panes
revert, the user's own AOM is untouched, the supervisor stays attached."
```

---

### Task 4: Verify in-app

Not a code task. The brake only proves itself against a real collision.

- [ ] **Step 1: Build and launch**

Run: `npm run tauri:dev`
Note: the dev build is a separate app (`com.karluiz.covenant.dev`) and starts
unconfigured. Seed it once if needed:
`cp ~/Library/Application\ Support/com.karluiz.covenant/config.json ~/Library/Application\ Support/com.karluiz.covenant.dev/`

- [ ] **Step 2: Reproduce the incident**

1. Open two tabs, both `cd` to the SAME repo checkout (the main worktree).
2. Group them, attach a supervision-enabled operator via the group context menu — it attaches as "Decides for you".
3. Start an executor in one tab and let it finish a turn (`AgentIdleWaiting`).

Expected: within ~1.5s of the turn ending, a toast signed by the operator
saying it stepped back; the group chip flips to "Observes only"; any AOM the
supervisor armed is off, any AOM you armed yourself is untouched; a Telegram
escalation arrives if Telegram is configured.

- [ ] **Step 3: Verify the re-arm**

`cd` one of the two tabs into a different worktree
(`.covenant/worktrees/<slug>`), let an executor finish another turn.

Expected: a toast saying the operator is deciding again; the group chip
returns to "Decides for you".

- [ ] **Step 4: Verify it stays quiet**

With the two tabs in separate worktrees, let several turns pass.

Expected: no brake toasts at all. `brake_transition` returning `None` is the
common case and must be silent.

- [ ] **Step 5: Record the outcome**

If all four pass, note it in the design doc's Status line
(`design approved, implemented, in-app verified <date>`) and commit that
one-line change. If something fails, do NOT paper over it — report what
happened before touching more code.

---

## Self-review notes

- Spec coverage: detection §1 → Task 1 + Task 2 Step 2; brake §2 → Task 2 Step 4 + Task 3; notification §3 → Task 2 Step 3; dedup/re-arm §4 → Task 1 `brake_transition` + Task 2 Step 1/4; testing → Task 1 Step 1, Task 3 Step 1; known ceiling → `ponytail:` comments in Task 2 Step 2 and the ordering note in Task 2 Step 4.
- The spec's "known ceiling" (a braked group returns to observe-only, where the watcher resumes a model call per idle turn) is inherent to the downgrade and is documented, not coded around.
- Names are consistent across tasks: `terrain_collision`, `brake_transition`, `Collision`, `TerrainBrake`, `BRAKE_EVENT_NAME` / `"group-supervision-braked"`, `applyTerrainBrake`, DOM event `"group-supervision:braked"`.
