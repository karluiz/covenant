# AI-Generated Tab Titles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tabs name themselves with a ≤2-word AI-generated label of the session's activity, with a cwd-basename cold start replacing `zsh ${seq}`.

**Architecture:** The existing per-session summarizer (debounced LLM call after each `BlockFinished`) is extended to also emit a short title via a `TITLE:` sentinel line in its response. The title is stored on the world model, persisted to SQLite, and published as a new `SessionEvent::TitleSuggested` that the frontend consumes to update `tab.defaultTitle` (unless a manual `customName` is set).

**Tech Stack:** Rust (tokio, rusqlite, thiserror), tokio broadcast bus, Tauri IPC, TypeScript (xterm.js frontend).

---

## File Structure

- `crates/app/src/world.rs` — add `title: Option<String>` field to `SessionWorldModel`.
- `crates/app/src/storage.rs` — `title` column + migration; extend `save_summary`; add title to the summary load path.
- `crates/session/src/lib.rs` — `SessionEvent::TitleSuggested` + `SessionUiEvent::TitleSuggested` + `to_ui` mapping.
- `crates/app/src/summarizer.rs` — title rules in system prompt, parse sentinel line, persist + publish on change; `spawn_loop` gains a bus `Sender`.
- `crates/app/src/lib.rs` — pass `session.event_sender()` to `summarizer::spawn_loop`.
- `ui/src/api.ts` — `title_suggested` event type.
- `ui/src/tabs/manager.ts` — cwd-basename cold start; `title_suggested` handler.

---

## Task 1: World model holds a title

**Files:**
- Modify: `crates/app/src/world.rs:28-36`

- [ ] **Step 1: Add the field**

In `crates/app/src/world.rs`, inside `pub struct SessionWorldModel`, next to `pub summary: Option<String>,` add:

```rust
    /// Short (≤2 word) AI-generated activity label for the session's tab.
    /// `None` until the summarizer produces one.
    pub title: Option<String>,
```

If `SessionWorldModel` has a manual constructor or `Default` impl that lists fields explicitly, initialize `title: None` there. (If it derives `Default`, no change needed.)

- [ ] **Step 2: Build**

Run: `cargo build -p karl-app`
Expected: PASS (compiles; if a struct literal for `SessionWorldModel` now errors with "missing field `title`", add `title: None` at that site and rebuild).

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/world.rs
git commit -m "feat(world): add title field to SessionWorldModel"
```

---

## Task 2: Persist the title in SQLite

**Files:**
- Modify: `crates/app/src/storage.rs` (schema ~line 71, migrations ~line 568, `save_summary` ~line 739, test ~line 3116)

- [ ] **Step 1: Write the failing test**

In `crates/app/src/storage.rs`, near the existing `summary_upsert_replaces_prior` test (~line 3116), add:

```rust
    #[tokio::test]
    async fn summary_roundtrips_title() {
        let storage = Storage::open_in_memory().await.unwrap();
        let sid = SessionId::new();
        storage
            .save_summary(sid, "did stuff".to_string(), "release prep".to_string(), 100)
            .await
            .unwrap();
        let (summary, title) = storage.load_summary(sid).await.unwrap().unwrap();
        assert_eq!(summary, "did stuff");
        assert_eq!(title, "release prep");
    }
```

Notes for the implementer:
- Match the existing test's setup style for `Storage` construction and `SessionId` — copy from `summary_upsert_replaces_prior` if `Storage::open_in_memory`/`SessionId::new` differ in name.
- If no `load_summary` exists yet, this test also drives creating one (Step 4).

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl-app summary_roundtrips_title`
Expected: FAIL — `save_summary` takes 3 args not 4, and/or `load_summary` missing.

- [ ] **Step 3: Add the column + migration**

In the `summaries` table `CREATE TABLE` (~line 71) the column is added for fresh DBs:

```sql
    title               TEXT NOT NULL DEFAULT '',
```

For existing DBs, in the migrations block (mirror the teammate migration at ~line 571), add an idempotent migration:

```rust
    // Tab titles: short activity label per session, generated alongside
    // the rolling summary. Older DBs created the summaries table without
    // it. ALTER is a no-op error if the column already exists; ignore.
    let _ = conn.execute(
        "ALTER TABLE summaries ADD COLUMN title TEXT NOT NULL DEFAULT ''",
        [],
    );
```

(Use whatever ignore-on-duplicate pattern the surrounding migrations already use — match the existing style at line 571 exactly.)

- [ ] **Step 4: Extend `save_summary` and add `load_summary`**

Change `save_summary` (~line 739) to accept and upsert the title:

```rust
    /// Upsert the rolling summary and tab title for a session.
    pub async fn save_summary(
        &self,
        session_id: SessionId,
        summary: String,
        title: String,
        updated_at_unix_ms: u64,
    ) -> Result<(), StorageError> {
        let session_str = session_id.to_string();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO summaries (session_id, summary, title, updated_at_unix_ms)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(session_id) DO UPDATE SET
                     summary = excluded.summary,
                     title = excluded.title,
                     updated_at_unix_ms = excluded.updated_at_unix_ms",
                params![session_str, summary, title, updated_at_unix_ms as i64],
            )?;
            Ok(())
        })
        .await
    }
```

Adapt the body to the crate's actual connection-access helper (`with_conn` / direct pool call) — copy the exact wrapper the original `save_summary` used; only the SQL, params, and signature change. Then add a loader returning `(summary, title)`:

```rust
    /// Load the persisted (summary, title) for a session, if any.
    pub async fn load_summary(
        &self,
        session_id: SessionId,
    ) -> Result<Option<(String, String)>, StorageError> {
        let session_str = session_id.to_string();
        self.with_conn(move |conn| {
            let row = conn
                .query_row(
                    "SELECT summary, title FROM summaries WHERE session_id = ?1",
                    params![session_str],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
                )
                .optional()?;
            Ok(row)
        })
        .await
    }
```

(If a summary loader already exists under another name, extend it to also select `title` and update its callers/tests instead of adding a duplicate.)

- [ ] **Step 5: Update existing `save_summary` callers**

The only production caller is `crates/app/src/summarizer.rs` — it's updated in Task 4, so for now make it compile by passing an empty title at that call site if you build before Task 4:
`storage.save_summary(session_id, trimmed.clone(), String::new(), updated_at)`. Also fix `summary_upsert_replaces_prior` (~line 3116) to pass the new title arg (use `String::new()` or `"x".into()`).

- [ ] **Step 6: Run tests**

Run: `cargo test -p karl-app summary_roundtrips_title summary_upsert_replaces_prior`
Expected: PASS both.

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/storage.rs
git commit -m "feat(storage): persist tab title alongside session summary"
```

---

## Task 3: New bus event TitleSuggested

**Files:**
- Modify: `crates/session/src/lib.rs` (enum ~line 85, UI enum ~line 236, `to_ui` ~line 285)

- [ ] **Step 1: Write the failing test**

In `crates/session/src/lib.rs` test module (add one if absent), add:

```rust
    #[test]
    fn title_suggested_maps_to_ui() {
        let sid = SessionId::new();
        let ev = SessionEvent::TitleSuggested {
            session: sid,
            title: "release prep".to_string(),
        };
        match ev.to_ui() {
            Some(SessionUiEvent::TitleSuggested { session, title }) => {
                assert_eq!(session, sid);
                assert_eq!(title, "release prep");
            }
            other => panic!("expected TitleSuggested ui event, got {other:?}"),
        }
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl-session title_suggested_maps_to_ui`
Expected: FAIL — variant `TitleSuggested` does not exist.

- [ ] **Step 3: Add the bus variant**

In `pub enum SessionEvent` (~line 85), after `ForegroundChanged { .. }`, add:

```rust
    /// A fresh AI-generated tab title for the session, produced by the
    /// summarizer. Emitted only when the title changed from the last one.
    TitleSuggested {
        session: SessionId,
        title: String,
    },
```

- [ ] **Step 4: Add the UI variant**

In `pub enum SessionUiEvent` (~line 236), after the `ForegroundChanged` UI variant, add:

```rust
    TitleSuggested {
        session: SessionId,
        title: String,
    },
```

- [ ] **Step 5: Map it in `to_ui`**

In `to_ui` (~line 285), add an arm (after the `ForegroundChanged` arm):

```rust
            SessionEvent::TitleSuggested { session, title } => {
                Some(SessionUiEvent::TitleSuggested {
                    session: *session,
                    title: title.clone(),
                })
            }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cargo test -p karl-session title_suggested_maps_to_ui`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/session/src/lib.rs
git commit -m "feat(session): add TitleSuggested bus + UI event"
```

---

## Task 4: Summarizer emits the title

**Files:**
- Modify: `crates/app/src/summarizer.rs` (system prompt ~line 32, `spawn_loop` ~line 47, `run_loop` ~line 59, `regenerate` ~line 115)
- Modify: `crates/app/src/lib.rs:577-585` (caller passes the bus sender)

- [ ] **Step 1: Write the failing test**

Add a pure parse helper + test in `crates/app/src/summarizer.rs`:

```rust
/// Split a summarizer response into (title, summary). The model is asked
/// to make its first line `TITLE: <label>`. If absent, title is empty and
/// the whole text is the summary (back-compat).
fn split_title(raw: &str) -> (String, String) {
    let raw = raw.trim_start();
    if let Some(rest) = raw.strip_prefix("TITLE:") {
        let mut lines = rest.splitn(2, '\n');
        let title = lines.next().unwrap_or("").trim().to_string();
        let summary = lines.next().unwrap_or("").trim().to_string();
        (title, summary)
    } else {
        (String::new(), raw.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::split_title;

    #[test]
    fn parses_title_sentinel() {
        let (t, s) = split_title("TITLE: release prep\n\nUser cut a release.");
        assert_eq!(t, "release prep");
        assert_eq!(s, "User cut a release.");
    }

    #[test]
    fn missing_sentinel_yields_empty_title() {
        let (t, s) = split_title("Just a summary, no title line.");
        assert_eq!(t, "");
        assert_eq!(s, "Just a summary, no title line.");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl-app split_title`
Expected: FAIL — `split_title` not defined (or test module absent).

- [ ] **Step 3: Add title rules to the system prompt**

In `SUMMARY_SYSTEM_PROMPT` (~line 32), prepend a rule as the first instruction:

```
- Your FIRST line must be exactly `TITLE: <label>` where <label> is at \
  most 2 lowercase words naming the current activity (e.g. `release prep`, \
  `debugging auth`, `tab titles`). If nothing meaningful has happened, \
  leave it empty: `TITLE:`. Then a blank line, then the summary body \
  following the rules below.
```

(Append into the existing string literal; keep the rest verbatim so the cached prefix only grows by this static block.)

- [ ] **Step 4: Wire the bus sender into `spawn_loop`/`run_loop`**

Change `spawn_loop` (~line 47) and `run_loop` (~line 59) to take a `broadcast::Sender<SessionEvent>`:

```rust
pub fn spawn_loop(
    session_id: SessionId,
    world: Arc<Mutex<SessionWorldModel>>,
    settings: Arc<Mutex<Settings>>,
    storage: Storage,
    bus: broadcast::Receiver<SessionEvent>,
    bus_tx: broadcast::Sender<SessionEvent>,
    vitals: crate::vitals::VitalsHandle,
) {
    tauri::async_runtime::spawn(run_loop(
        session_id, world, settings, storage, bus, bus_tx, vitals,
    ));
}
```

Add `bus_tx: broadcast::Sender<SessionEvent>` to `run_loop`'s signature and thread it into the `regenerate(...)` call (add the arg there too). Also keep a `last_title: Option<String>` local in `run_loop` (alongside `last_block_at`) and pass `&mut last_title` to `regenerate` so it can dedupe emissions.

- [ ] **Step 5: Parse + persist + publish in `regenerate`**

In `regenerate` (~line 115) add params `bus_tx: &broadcast::Sender<SessionEvent>` and `last_title: &mut Option<String>`. After the response comes back, replace the summary-only handling:

```rust
    let (title, summary) = split_title(&resp.text);
    let trimmed = summary; // already trimmed by split_title
    let tokens_estimate = trimmed.len() / 4;

    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Err(e) = storage
        .save_summary(session_id, trimmed.clone(), title.clone(), updated_at)
        .await
    {
        tracing::warn!(error = %e, "failed to persist summary");
    }

    {
        let mut w = world.lock().await;
        w.summary = Some(trimmed);
        if !title.is_empty() {
            w.title = Some(title.clone());
        }
    }

    // Publish the title only when it actually changed, so the tab strip
    // doesn't re-render on every block.
    if !title.is_empty() && last_title.as_deref() != Some(title.as_str()) {
        let _ = bus_tx.send(SessionEvent::TitleSuggested {
            session: session_id,
            title: title.clone(),
        });
        *last_title = Some(title);
    }
```

Add `use tokio::sync::broadcast;` import if not already present (it is — used for the receiver). Ensure `SessionEvent` is imported (it is, via `karl_session`).

- [ ] **Step 6: Update the caller in lib.rs**

At `crates/app/src/lib.rs:577`, pass the sender:

```rust
    summarizer::spawn_loop(
        id,
        world.clone(),
        state.settings.clone(),
        state.storage.clone(),
        session.subscribe(),
        session.event_sender(),
        state.vitals.clone(),
    );
```

(`event_sender()` exists at `crates/session/src/lib.rs:471`.)

- [ ] **Step 7: Run tests + build**

Run: `cargo test -p karl-app split_title && cargo build -p karl-app`
Expected: PASS + clean build.

- [ ] **Step 8: Commit**

```bash
git add crates/app/src/summarizer.rs crates/app/src/lib.rs
git commit -m "feat(summarizer): generate and publish AI tab titles"
```

---

## Task 5: Frontend event type

**Files:**
- Modify: `ui/src/api.ts:20-60` (the `SessionUiEvent` union)

- [ ] **Step 1: Add the union member**

In `ui/src/api.ts`, in the `SessionUiEvent` union (after the `foreground_changed` member ~line 54-60), add:

```ts
  | { kind: "title_suggested"; session: SessionId; title: string }
```

- [ ] **Step 2: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS (no new errors from this line).

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui): add title_suggested session event type"
```

---

## Task 6: Cold-start title = cwd basename

**Files:**
- Modify: `ui/src/tabs/manager.ts:3645`

- [ ] **Step 1: Add a basename helper (if none exists)**

Near the top-level helpers in `ui/src/tabs/manager.ts` (e.g. next to `tabDisplayName` ~line 491), add:

```ts
/// Last path segment of a cwd, for the cold-start tab title. Empty/unknown
/// cwd falls back to "shell".
function cwdBasename(cwd: string | null | undefined): string {
  const seg = (cwd ?? "").split("/").filter(Boolean).pop();
  return seg && seg.length > 0 ? seg : "shell";
}
```

(First check the file/imports for an existing basename util; reuse it if present instead of adding this.)

- [ ] **Step 2: Replace the hardcoded default title**

At `manager.ts:3645`, change:

```ts
      defaultTitle: `zsh ${seq}`,
```

to:

```ts
      defaultTitle: cwdBasename(initialCwd),
```

(`initialCwd` is in scope here — used at `manager.ts:3675` as `cwd: initialCwd ?? ""`.)

- [ ] **Step 3: Type-check + build**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(tabs): cold-start tab title from cwd basename, not zsh N"
```

---

## Task 7: Frontend handles title_suggested

**Files:**
- Modify: `ui/src/tabs/manager.ts` (session-event switch ~line 2981, alongside `foreground_changed`)

- [ ] **Step 1: Add the handler arm**

In the per-session event switch, after the `foreground_changed` arm (`} else if (event.kind === "foreground_changed") { ... }`, ends ~line 2994), add:

```ts
            } else if (event.kind === "title_suggested") {
              // AI-generated activity label. Only update the auto title;
              // a user-set customName always wins (see tabDisplayName).
              if (tabRef.current && event.title.trim().length > 0) {
                tabRef.current.defaultTitle = event.title.trim();
                this.renderTabbar();
              }
```

Notes:
- `renderTabbar()` is the strip re-render used by `setTabLabel` (manager.ts:4089). If it's private, calling it via `this.` from inside this method is fine (same class).
- Do NOT touch `customName` — `tabDisplayName` (manager.ts:491) already returns `customName?.trim() || defaultTitle`, so manual renames stay sticky automatically.

- [ ] **Step 2: Type-check + build**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(tabs): apply AI title_suggested to auto-named tabs"
```

---

## Task 8: Restore precedence on manifest reload

**Files:**
- Modify: `ui/src/tabs/manager.ts` (`restoreFromManifest` ~line 4702 and the post-spawn setup ~line 1065)

- [ ] **Step 1: Confirm current restore behavior**

Read `restoreFromManifest` (~line 4702-4760) and the manifest type (`custom_name` at line 389/4733). The manifest persists `customName` but not the auto title. After this change a restored tab without a customName should show the **cwd basename** (already correct, because `createTab` now defaults to `cwdBasename(initialCwd)` from Task 6), then upgrade once the summarizer emits a fresh `title_suggested`.

- [ ] **Step 2: Verify no extra code needed**

Because the persisted title lives in SQLite (backend) and the summarizer re-emits `title_suggested` shortly after a session is re-attached on boot, the frontend needs no manifest field for the title. Confirm the restore path passes `initialCwd` into `createTab` so the basename cold start applies. If it does, this task is documentation-only — no code change.

- [ ] **Step 3: (Only if restore does NOT pass initialCwd)** thread the persisted cwd into the `createTab`/spawn call in `restoreFromManifest` so `cwdBasename` has input. Mirror the existing `initialCwd` plumbing from the live-spawn path (`manager.ts:887` / `1103`).

- [ ] **Step 4: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit (only if code changed)**

```bash
git add ui/src/tabs/manager.ts
git commit -m "fix(tabs): cwd basename cold start on manifest restore"
```

---

## Task 9: Full verification

- [ ] **Step 1: Backend tests**

Run: `cargo test -p karl-app -p karl-session`
Expected: PASS (includes `summary_roundtrips_title`, `summary_upsert_replaces_prior`, `split_title*`, `title_suggested_maps_to_ui`).

- [ ] **Step 2: Frontend tests + types**

Run: `cd ui && npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 3: Manual smoke (respawn)**

Use the `respawn` skill to restart `tauri dev`. Then:
1. Open a tab in a project dir → label is the **dir basename** (not `zsh N`).
2. Run a handful of meaningful commands (e.g. an edit + a failing test) → after the ~500ms debounce + LLM call, the label upgrades to a ≤2-word activity label.
3. Double-click the tab → rename to `mine` → run more commands → label stays `mine` (manual sticky).
4. Open a tab with no API key configured for the Summary role → label stays the dir basename, no errors in the log.

Expected: all four behave as described.

- [ ] **Step 4: Final commit (if any fixups)**

```bash
git add -A
git commit -m "chore: AI tab titles verification fixups"
```
```
