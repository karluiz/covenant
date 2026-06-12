# Covenant RC-1b · Relay: Web→Desktop Presence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the relay tell a desktop how many web clients are connected for its `github_id`, so the desktop can show a "remote control active" indicator. Symmetric to the existing desktop→web presence.

**Architecture:** Add a `Hub::notify_desktops` (mirror of `notify_webs`) and emit a `{"t":"web_presence","web_count":N}` frame to the desktops of a gid whenever a web client joins or leaves.

**Tech Stack:** Rust, axum WS relay (existing `src/rc.rs`).

**Repo:** `~/Sources/covenant-server`. Work in a git worktree. Deploys to forge.covenant.uno on push to main (CD).

**Depends on:** RC-0 Part 1 relay (live). Unblocks RC-1b desktop (the banner/pill).

---

## Context (current `src/rc.rs`)

- `Hub` has `notify_webs(gid, msg) -> usize` (sends to all web clients of a gid, pruning dead) and `web_count(gid) -> usize`, `desktop_online(gid) -> bool`. The `Presence` struct holds `desktops: HashMap<ClientId, UnboundedSender<String>>` and `webs: ...`.
- `handle(socket, hub, gid, role)`:
  - after `join`: `if role == Role::Desktop { hub.notify_webs(gid, presence_frame(true)); }`
  - read loop routes text frames
  - on disconnect: `hub.leave(...)`; `if role == Role::Desktop { hub.notify_webs(gid, presence_frame(hub.desktop_online(gid))); }`; `write.abort()`
- `fn presence_frame(desktop_online: bool) -> String` returns `{"t":"presence","desktop_online":...}`.

---

## Task 1: `Hub::notify_desktops` + unit test

**Files:** Modify `src/rc.rs`

- [ ] **Step 1: Add the failing test** (in the `tests` module)

```rust
    #[test]
    fn notify_desktops_reaches_only_desktop_clients() {
        let hub = Hub::default();
        let (_d, mut drx) = hub.join(5, Role::Desktop);
        let (_w, mut wrx) = hub.join(5, Role::Web);
        let n = hub.notify_desktops(5, "{\"t\":\"web_presence\",\"web_count\":1}".to_string());
        assert_eq!(n, 1);
        assert!(drx.try_recv().is_ok());
        assert!(wrx.try_recv().is_err()); // webs do not get web_presence frames
    }
```

- [ ] **Step 2: Run → fail**

Run: `cargo test --bin covenant-server rc::tests`
Expected: FAIL (notify_desktops undefined). (The crate is binary-only — use `--bin covenant-server`, not `--lib`.)

- [ ] **Step 3: Implement `notify_desktops`** (mirror of `notify_webs`, in `impl Hub`)

```rust
    /// Send a relay-synthesized text frame to ALL desktop clients of a gid.
    pub fn notify_desktops(&self, gid: i64, msg: String) -> usize {
        let mut g = self.inner.lock().expect("hub lock");
        let Some(p) = g.by_gid.get_mut(&gid) else { return 0 };
        let mut n = 0;
        p.desktops.retain(|_, tx| match tx.send(msg.clone()) {
            Ok(()) => { n += 1; true }
            Err(_) => false,
        });
        n
    }
```

- [ ] **Step 4: Run → pass**

Run: `cargo test --bin covenant-server rc::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rc.rs
git commit -m "feat(rc): Hub::notify_desktops"
```

---

## Task 2: Emit `web_presence` on web join/leave

**Files:** Modify `src/rc.rs`

- [ ] **Step 1: Add the frame builder** (next to `presence_frame`)

```rust
fn web_presence_frame(web_count: usize) -> String {
    format!("{{\"t\":\"web_presence\",\"web_count\":{}}}", web_count)
}
```

- [ ] **Step 2: Notify desktops when a web client joins**

In `handle`, right after the existing desktop-join block, add:
```rust
    if role == Role::Web {
        hub.notify_desktops(gid, web_presence_frame(hub.web_count(gid)));
    }
```

- [ ] **Step 3: Notify desktops when a web client leaves**

In `handle`, after `hub.leave(...)` (and the existing desktop-leave notify), add:
```rust
    if role == Role::Web {
        hub.notify_desktops(gid, web_presence_frame(hub.web_count(gid)));
    }
```
> `web_count` is read AFTER `leave`, so a departing web client is already excluded.

- [ ] **Step 4: Verify build + tests**

Run: `cargo test --bin covenant-server rc::tests && cargo build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rc.rs
git commit -m "feat(rc): emit web_presence to desktops on web client join/leave"
```

---

## Task 3: Manual smoke (after deploy)

**Files:** none.

- [ ] After merge→deploy, connect a desktop WS (`/rc/desktop?token=...`) and, separately, a web WS (`/rc/web?token=...`) with the SAME minted gid. Expect the desktop socket to receive `{"t":"web_presence","web_count":1}` when the web connects, and `web_count":0` when it disconnects. (Reuse the node WebSocket smoke approach from RC-0 Part 1; `JWT_SECRET` in `infra/pulzen-secrets.env`.)

---

## Self-Review

**Spec coverage:** ✅ desktop learns web client count (join + leave) via a typed frame; ✅ symmetric to existing presence; ✅ relay stays opaque otherwise. Deferred: nothing — this is the whole relay slice.

**Placeholder scan:** none. Task 3 is manual with concrete steps.

**Type consistency:** `notify_desktops` mirrors `notify_webs`; `web_presence_frame(usize)`; frame `{"t":"web_presence","web_count":N}` matches what the RC-1b desktop plan parses (`WebPresence { web_count }`).

---

## Follow-on

- **RC-1b desktop**: rc-agent parses `web_presence` → emits a Tauri event → a corner pill ("Remote control active · N") + a kill-switch button wiring `disarmAllRemote`. Separate plan.
