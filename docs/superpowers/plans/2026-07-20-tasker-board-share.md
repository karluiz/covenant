# Tasker Board Share Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish one Tasker project as a read-only, auto-refreshing board at `https://forge.covenant.uno/b/:token`.

**Architecture:** A pure TS redactor turns a `Project` into a `BoardSnapshot` (no descriptions, no cancelled tasks, done capped at 20). A Rust module cloned from `covenant_gist.rs` POSTs/PUTs that snapshot to the forge and keeps a local `projectId → share` map. The Tasker panel gets a share action and a debounced auto-push driven by a new save event on `TaskStorage`. The public page is a minijinja template in the separate `covenant-server` repo that polls a JSON endpoint every 20s.

**Tech Stack:** TypeScript (Vite, Vitest), Rust (Tauri 2, reqwest, serde), axum + minijinja + Postgres on the server side.

**Spec:** `docs/superpowers/specs/2026-07-20-tasker-board-share-design.md`

## Global Constraints

- All UI chrome copy is English.
- New panels/pages use `border-radius: 0` (sharp corners); only dots may be 50%.
- Chrome glyphs are inline SVG via `Icons.*` — never emoji.
- Never use `element.title` for tooltips — use `attachTooltip`.
- No `unwrap()` in Rust outside `#[cfg(test)]` and `main()`.
- TypeScript is `strict: true`; no `as any` without a justifying comment.
- Vitest runs from the repo ROOT (`npm test`), not from `ui/`.
- In this worktree, `node_modules` is a symlink: stage files explicitly, never `git add -A`.
- Tasks 1–5 are this repo. Task 6 is the separate `covenant-server` repo and cannot be done from this checkout.

---

### Task 1: The redactor — `toSnapshot`

Pure function, no I/O. This is the privacy boundary: `description` must have nowhere to land.

**Files:**
- Create: `ui/src/tasker/snapshot.ts`
- Test: `ui/src/tasker/snapshot.test.ts`

**Interfaces:**
- Consumes: `Project`, `Task`, `TaskStatus`, `TaskPriority` from `./types`; `BOARD_COLUMNS` from `./board`.
- Produces: `export type BoardSnapshot`, `export type SharedTask`, `export type SharedSubtask`, `export function toSnapshot(project: Project, now?: number): BoardSnapshot`, `export const DONE_LIMIT = 20`.

- [ ] **Step 1: Write the failing test**

Create `ui/src/tasker/snapshot.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { toSnapshot, DONE_LIMIT } from "./snapshot";
import type { Project, Task } from "./types";

function task(over: Partial<Task> = {}): Task {
  return {
    id: over.id ?? "t1",
    title: "Ship the thing",
    status: "pending",
    priority: "normal",
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

function project(tasks: Task[]): Project {
  return { id: "p1", name: "Covenant", createdAt: 1, updatedAt: 2, tasks };
}

describe("toSnapshot", () => {
  it("never leaks a task description", () => {
    const secret = "sk-ant-do-not-publish-me";
    const snap = toSnapshot(project([task({ description: secret })]), 5000);
    expect(JSON.stringify(snap)).not.toContain(secret);
  });

  it("carries the fields a viewer needs", () => {
    const snap = toSnapshot(
      project([
        task({
          title: "Fix the parser",
          priority: "urgent",
          dueDate: 4000,
          dueTime: "09:30",
          tags: ["rust"],
          estimatedMinutes: 60,
          spentMinutes: 15,
          subtasks: [{ id: "s1", title: "repro", completed: true, createdAt: 1 }],
        }),
      ]),
      5000,
    );
    const t = snap.columns[0].tasks[0];
    expect(snap.title).toBe("Covenant");
    expect(snap.v).toBe(1);
    expect(snap.updatedAt).toBe(5000);
    expect(t.title).toBe("Fix the parser");
    expect(t.priority).toBe("urgent");
    expect(t.dueDate).toBe(4000);
    expect(t.dueTime).toBe("09:30");
    expect(t.tags).toEqual(["rust"]);
    expect(t.estimatedMinutes).toBe(60);
    expect(t.spentMinutes).toBe(15);
    expect(t.subtasks).toEqual([{ title: "repro", completed: true }]);
  });

  it("lays out the three board columns in order", () => {
    const snap = toSnapshot(
      project([
        task({ id: "a", status: "pending" }),
        task({ id: "b", status: "active" }),
        task({ id: "c", status: "done", completedAt: 3000 }),
      ]),
      5000,
    );
    expect(snap.columns.map((c) => c.status)).toEqual(["pending", "active", "done"]);
    expect(snap.columns.map((c) => c.label)).toEqual(["To Do", "In Progress", "Done"]);
    expect(snap.columns.map((c) => c.tasks.length)).toEqual([1, 1, 1]);
  });

  it("drops cancelled tasks entirely", () => {
    const snap = toSnapshot(project([task({ id: "x", status: "cancelled" })]), 5000);
    expect(snap.columns.flatMap((c) => c.tasks)).toHaveLength(0);
  });

  it("caps done at the newest DONE_LIMIT by completedAt", () => {
    const done = Array.from({ length: DONE_LIMIT + 5 }, (_, i) =>
      task({ id: `d${i}`, status: "done", completedAt: i }),
    );
    const snap = toSnapshot(project(done), 5000);
    const col = snap.columns[2];
    expect(col.tasks).toHaveLength(DONE_LIMIT);
    expect(col.tasks[0].id).toBe(`d${DONE_LIMIT + 4}`); // newest first
  });

  it("omits absent optional fields rather than emitting undefined keys", () => {
    const snap = toSnapshot(project([task()]), 5000);
    expect(Object.keys(snap.columns[0].tasks[0]).sort()).toEqual(
      ["createdAt", "id", "priority", "title", "updatedAt"].sort(),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- ui/src/tasker/snapshot.test.ts`
Expected: FAIL — `Failed to resolve import "./snapshot"`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/tasker/snapshot.ts`:

```ts
// The privacy boundary for board sharing: a Project becomes a BoardSnapshot.
// `description` is absent from these types on purpose — free-text notes hold
// paths, tokens and venting, and must have nowhere to land in the payload.

import { BOARD_COLUMNS } from "./board";
import type { Project, Task, TaskPriority, TaskStatus } from "./types";

export const DONE_LIMIT = 20;

export interface SharedSubtask {
  title: string;
  completed: boolean;
}

export interface SharedTask {
  id: string;
  title: string;
  priority: TaskPriority;
  dueDate?: number;
  dueTime?: string;
  tags?: string[];
  subtasks?: SharedSubtask[];
  estimatedMinutes?: number;
  spentMinutes?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface BoardColumn {
  status: TaskStatus;
  label: string;
  tasks: SharedTask[];
}

export interface BoardSnapshot {
  v: 1;
  title: string;
  updatedAt: number;
  columns: BoardColumn[];
}

function shareTask(t: Task): SharedTask {
  const out: SharedTask = {
    id: t.id,
    title: t.title,
    priority: t.priority,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
  if (t.dueDate !== undefined) out.dueDate = t.dueDate;
  if (t.dueTime !== undefined) out.dueTime = t.dueTime;
  if (t.tags?.length) out.tags = [...t.tags];
  if (t.subtasks?.length) {
    out.subtasks = t.subtasks.map((s) => ({ title: s.title, completed: s.completed }));
  }
  if (t.estimatedMinutes !== undefined) out.estimatedMinutes = t.estimatedMinutes;
  if (t.spentMinutes !== undefined) out.spentMinutes = t.spentMinutes;
  if (t.completedAt !== undefined) out.completedAt = t.completedAt;
  return out;
}

export function toSnapshot(project: Project, now = Date.now()): BoardSnapshot {
  const columns = BOARD_COLUMNS.map(({ status, label }) => {
    let tasks = project.tasks.filter((t) => t.status === status);
    if (status === "done") {
      // ponytail: newest 20 only — the server paginates nothing and an
      // unbounded Done column would grow the payload forever.
      tasks = [...tasks]
        .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
        .slice(0, DONE_LIMIT);
    }
    return { status, label, tasks: tasks.map(shareTask) };
  });
  return { v: 1, title: project.name, updatedAt: now, columns };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- ui/src/tasker/snapshot.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/tasker/snapshot.ts ui/src/tasker/snapshot.test.ts
git commit -m "feat(tasker): redact a project into a shareable BoardSnapshot"
```

---

### Task 2: Rust transport — `covenant_board.rs`

Mirrors `crates/app/src/covenant_gist.rs` (read it first), keyed by project id instead of file path, and taking the payload from the frontend instead of reading a file.

**Files:**
- Create: `crates/app/src/covenant_board.rs`
- Modify: `crates/app/src/lib.rs:27-28` (add `mod covenant_board;`) and `crates/app/src/lib.rs:5773-5776` (register four commands next to the `gist_*` ones)

**Interfaces:**
- Consumes: `karl_score::auth::{load_jwt, send_authed, backend_url}`.
- Produces: Tauri commands `board_get_share(app, projectId: String) -> Option<BoardShare>`, `board_list_shares(app) -> Vec<String>`, `board_publish(app, projectId: String, title: String, payload: serde_json::Value) -> BoardShare`, `board_revoke(app, projectId: String)`. `BoardShare` serializes camelCase as `{ boardId: i64, token: String, url: String }`.

- [ ] **Step 1: Write the failing test**

Create `crates/app/src/covenant_board.rs` containing ONLY the test module plus the two types it needs, so the test can fail for the right reason:

```rust
//! Authed HTTP client + local share-state for read-only Tasker board shares.

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn share_store_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cov-board-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("board_shares.json");
        let mut m = load_shares(&p);
        assert!(m.is_empty());
        m.insert(
            "proj-1".into(),
            BoardShare {
                board_id: 7,
                token: "t".into(),
                url: "u".into(),
            },
        );
        save_shares(&p, &m).unwrap();
        assert_eq!(load_shares(&p).get("proj-1").unwrap().board_id, 7);
    }
}
```

Add `mod covenant_board;` on the line after `mod covenant_gist;` in `crates/app/src/lib.rs:27`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p covenant-app covenant_board 2>&1 | tail -20`
Expected: FAIL — `cannot find function 'load_shares' in this scope`.

(If the package name differs, get it with `grep '^name' crates/app/Cargo.toml`.)

- [ ] **Step 3: Write the implementation**

Prepend to `crates/app/src/covenant_board.rs`, above the test module:

```rust
use karl_score::auth;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardShare {
    pub board_id: i64,
    pub token: String,
    pub url: String,
}

pub fn load_shares(path: &Path) -> HashMap<String, BoardShare> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_shares(path: &Path, m: &HashMap<String, BoardShare>) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn shares_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("board_shares.json"))
}

fn jwt() -> Result<String, String> {
    auth::load_jwt()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not signed in to Covenant".to_string())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Send an authed request via [`auth::send_authed`] (401 → refresh JWT +
/// retry once), then surface HTTP errors as strings.
async fn send_authed(
    build: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let j = jwt()?;
    auth::send_authed(&j, build)
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())
}

async fn post_board(title: &str, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
    let url = format!("{}/boards", auth::backend_url());
    let body = serde_json::json!({ "title": title, "payload": payload });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

async fn put_board(id: i64, title: &str, payload: &serde_json::Value) -> Result<(), String> {
    let url = format!("{}/boards/{}", auth::backend_url(), id);
    let body = serde_json::json!({ "title": title, "payload": payload });
    send_authed(|j| client().put(&url).bearer_auth(j).json(&body)).await?;
    Ok(())
}

async fn post_revoke(id: i64) -> Result<(), String> {
    let url = format!("{}/boards/{}/revoke", auth::backend_url(), id);
    send_authed(|j| client().post(&url).bearer_auth(j)).await?;
    Ok(())
}

#[tauri::command]
pub async fn board_get_share(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Option<BoardShare>, String> {
    Ok(load_shares(&shares_path(&app)?).get(&project_id).cloned())
}

/// All locally-known shared project ids — lets the UI badge rows without a
/// per-project round-trip.
#[tauri::command]
pub async fn board_list_shares(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(load_shares(&shares_path(&app)?).into_keys().collect())
}

#[tauri::command]
pub async fn board_publish(
    app: tauri::AppHandle,
    project_id: String,
    title: String,
    payload: serde_json::Value,
) -> Result<BoardShare, String> {
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    // Re-publish in place → the link the boss already has keeps working.
    if let Some(existing) = shares.get(&project_id).cloned() {
        put_board(existing.board_id, &title, &payload).await?;
        return Ok(existing);
    }
    let resp = post_board(&title, &payload).await?;
    let board_id = resp["id"].as_i64().ok_or("missing id in response")?;
    let token = resp["token"]
        .as_str()
        .ok_or("missing token in response")?
        .to_string();
    let share = BoardShare {
        board_id,
        token: token.clone(),
        url: format!("{}/b/{}", auth::backend_url(), token),
    };
    shares.insert(project_id, share.clone());
    save_shares(&file, &shares)?;
    Ok(share)
}

#[tauri::command]
pub async fn board_revoke(app: tauri::AppHandle, project_id: String) -> Result<(), String> {
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    let share = shares.get(&project_id).cloned().ok_or("not shared")?;
    post_revoke(share.board_id).await?;
    shares.remove(&project_id);
    save_shares(&file, &shares)
}
```

Register the commands in `crates/app/src/lib.rs`, immediately after the `covenant_gist::gist_revoke,` line in the `generate_handler!` list:

```rust
            covenant_board::board_get_share,
            covenant_board::board_list_shares,
            covenant_board::board_publish,
            covenant_board::board_revoke,
```

- [ ] **Step 4: Run the test and the linter**

Run: `cargo test -p covenant-app covenant_board 2>&1 | tail -20`
Expected: PASS, 1 test.

Run: `cargo clippy -p covenant-app --all-targets 2>&1 | tail -20`
Expected: no warnings from `covenant_board.rs`.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/covenant_board.rs crates/app/src/lib.rs
git commit -m "feat(board): authed publish/revoke for Tasker board shares"
```

---

### Task 3: The save event on `TaskStorage`

Auto-push needs to know a board changed. `TaskStorage.saveStore()` currently tells nobody.

**Files:**
- Modify: `ui/src/tasker/storage.ts:41-47`
- Test: `ui/src/tasker/storage.test.ts` (create if absent; if it exists, append the describe block)

**Interfaces:**
- Produces: `export const TASKER_SAVED_EVENT = "covenant:tasker-saved"` from `./storage`. The event is a `CustomEvent<{ projectIds: string[] }>` on `window`, carrying the ids of all non-archived projects at save time.

- [ ] **Step 1: Write the failing test**

Append to (or create) `ui/src/tasker/storage.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { TaskStorage, TASKER_SAVED_EVENT } from "./storage";

describe("TASKER_SAVED_EVENT", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("fires on every write, carrying the live project ids", () => {
    const seen: string[][] = [];
    const onSave = (e: Event) => {
      seen.push([...(e as CustomEvent<{ projectIds: string[] }>).detail.projectIds]);
    };
    window.addEventListener(TASKER_SAVED_EVENT, onSave);

    const storage = new TaskStorage();
    const p = storage.createProject("Covenant");
    storage.createTask(p.id, "Ship it");

    window.removeEventListener(TASKER_SAVED_EVENT, onSave);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([p.id]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- ui/src/tasker/storage.test.ts`
Expected: FAIL — `TASKER_SAVED_EVENT` is not exported.

- [ ] **Step 3: Write the implementation**

In `ui/src/tasker/storage.ts`, add the export next to `STORAGE_KEY` (line 5):

```ts
/// Fired after every write so board sharing can auto-push. Not scoped to the
/// mutated project — the whole store is one blob, and listeners filter.
export const TASKER_SAVED_EVENT = "covenant:tasker-saved";
```

and replace `saveStore()` (lines 41-47) with:

```ts
  private saveStore(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.store));
    } catch {
      console.error("Failed to save task store");
      return;
    }
    window.dispatchEvent(
      new CustomEvent(TASKER_SAVED_EVENT, {
        detail: { projectIds: this.getProjects().map((p) => p.id) },
      }),
    );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- ui/src/tasker/storage.test.ts`
Expected: PASS.

Run: `npm test -- ui/src/tasker` — the existing `panel.test.ts` and `board.test.ts` must stay green.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/tasker/storage.ts ui/src/tasker/storage.test.ts
git commit -m "feat(tasker): emit a saved event from TaskStorage"
```

---

### Task 4: Share client — api + auto-push

The debounced push loop and the shared-ids mirror. Modelled on `ui/src/gist/api.ts` + `ui/src/gist/share.ts` (read both first).

**Files:**
- Create: `ui/src/tasker/share.ts`
- Test: `ui/src/tasker/share.test.ts`

**Interfaces:**
- Consumes: `toSnapshot` (Task 1); the `board_*` commands (Task 2); `TASKER_SAVED_EVENT` (Task 3); `copyText` from `../ui/clipboard`; `pushInfoToast` from `../notifications/toast`.
- Produces: `BOARD_SHARES_EVENT`, `PUSH_DEBOUNCE_MS`, `isBoardShared(projectId)`, `getPushState(projectId)`, `ensureBoardSharesLoaded()`, `shareProjectBoard(project)`, `copyBoardLink(projectId)`, `revokeBoardShare(projectId)`, `startBoardAutoPush(storage)`, `boardApi`.
- `PushState = "synced" | "pushing" | "stale"`.

- [ ] **Step 1: Write the failing test**

Create `ui/src/tasker/share.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const publish = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => {
    if (cmd === "board_publish") return publish(args);
    if (cmd === "board_list_shares") return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));
vi.mock("../notifications/toast", () => ({ pushInfoToast: vi.fn() }));
vi.mock("../ui/clipboard", () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

import { TaskStorage, TASKER_SAVED_EVENT } from "./storage";
import {
  startBoardAutoPush,
  shareProjectBoard,
  isBoardShared,
  PUSH_DEBOUNCE_MS,
} from "./share";

describe("board auto-push", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    publish.mockReset();
    publish.mockResolvedValue({ boardId: 1, token: "tok", url: "https://f/b/tok" });
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst of saves into one publish", async () => {
    const storage = new TaskStorage();
    const p = storage.createProject("Covenant");
    await shareProjectBoard(p);
    expect(publish).toHaveBeenCalledTimes(1); // the initial share
    expect(isBoardShared(p.id)).toBe(true);

    const stop = startBoardAutoPush(storage);
    storage.createTask(p.id, "a");
    storage.createTask(p.id, "b");
    storage.createTask(p.id, "c");
    expect(publish).toHaveBeenCalledTimes(1); // still debouncing

    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10);
    expect(publish).toHaveBeenCalledTimes(2); // one push for the burst
    stop();
  });

  it("ignores saves for projects that were never shared", async () => {
    const storage = new TaskStorage();
    const p = storage.createProject("Private");
    const stop = startBoardAutoPush(storage);
    storage.createTask(p.id, "secret");
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10);
    expect(publish).not.toHaveBeenCalled();
    stop();
  });

  it("sends a redacted payload — no descriptions", async () => {
    const storage = new TaskStorage();
    const p = storage.createProject("Covenant");
    await shareProjectBoard(p);
    const stop = startBoardAutoPush(storage);
    storage.createTask(p.id, "task", { description: "sk-ant-secret" });
    await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 10);
    const lastArgs = publish.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(lastArgs)).not.toContain("sk-ant-secret");
    expect(lastArgs.projectId).toBe(p.id);
    expect(lastArgs.title).toBe("Covenant");
    stop();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- ui/src/tasker/share.test.ts`
Expected: FAIL — `Failed to resolve import "./share"`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/tasker/share.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { pushInfoToast } from "../notifications/toast";
import { copyText } from "../ui/clipboard";
import { toSnapshot } from "./snapshot";
import { TASKER_SAVED_EVENT } from "./storage";
import type { TaskStorage } from "./storage";
import type { Project } from "./types";

export interface BoardShare {
  boardId: number;
  token: string;
  url: string;
}

export const boardApi = {
  getShare: (projectId: string) =>
    invoke<BoardShare | null>("board_get_share", { projectId }),
  listShares: () => invoke<string[]>("board_list_shares"),
  publish: (projectId: string, title: string, payload: unknown) =>
    invoke<BoardShare>("board_publish", { projectId, title, payload }),
  revoke: (projectId: string) => invoke<void>("board_revoke", { projectId }),
};

export const PUSH_DEBOUNCE_MS = 2000;
export const BOARD_SHARES_EVENT = "covenant:board-shares-changed";

export type PushState = "synced" | "pushing" | "stale";

const sharedProjects = new Set<string>();
const pushState = new Map<string, PushState>();
let sharesLoaded = false;

function notifySharesChanged(): void {
  window.dispatchEvent(new CustomEvent(BOARD_SHARES_EVENT));
}

export function isBoardShared(projectId: string): boolean {
  return sharedProjects.has(projectId);
}

export function getPushState(projectId: string): PushState {
  return pushState.get(projectId) ?? "synced";
}

/// Idempotent — first caller triggers the fetch, later calls no-op.
export function ensureBoardSharesLoaded(): void {
  if (sharesLoaded) return;
  sharesLoaded = true;
  void boardApi
    .listShares()
    .then((ids) => {
      for (const id of ids) sharedProjects.add(id);
      if (ids.length > 0) notifySharesChanged();
    })
    .catch(() => {
      sharesLoaded = false; // transient failure — retry on next call
    });
}

/// Copy, and if the webview refuses (transient activation is gone after the
/// network round-trip), fall back to a toast the user clicks — that click IS
/// a fresh user gesture, so the retry succeeds.
async function copyOrOffer(url: string): Promise<void> {
  try {
    await copyText(url);
    pushInfoToast({ message: "Board link copied" });
  } catch {
    pushInfoToast({
      message: `Board shared — click to copy: ${url}`,
      onClick: () => {
        void copyText(url);
      },
    });
  }
}

async function push(project: Project): Promise<void> {
  pushState.set(project.id, "pushing");
  notifySharesChanged();
  try {
    await boardApi.publish(project.id, project.name, toSnapshot(project));
    pushState.set(project.id, "synced");
  } catch (err) {
    // ponytail: no retry timer — the next mutation retries. Each PUT carries
    // the whole snapshot, so a viewer only ever sees an older coherent board.
    pushState.set(project.id, "stale");
    console.error("board push failed", err);
  }
  notifySharesChanged();
}

export async function shareProjectBoard(project: Project): Promise<void> {
  const share = await boardApi.publish(project.id, project.name, toSnapshot(project));
  sharedProjects.add(project.id);
  pushState.set(project.id, "synced");
  notifySharesChanged();
  await copyOrOffer(share.url);
}

export async function copyBoardLink(projectId: string): Promise<void> {
  const share = await boardApi.getShare(projectId);
  if (!share) return;
  await copyOrOffer(share.url);
}

export async function revokeBoardShare(projectId: string): Promise<void> {
  await boardApi.revoke(projectId);
  sharedProjects.delete(projectId);
  pushState.delete(projectId);
  notifySharesChanged();
  pushInfoToast({ message: "Board share revoked" });
}

/// Subscribe to store writes and re-publish every shared board, debounced.
/// Returns an unsubscribe function.
export function startBoardAutoPush(storage: TaskStorage): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (projectId: string): void => {
    const existing = timers.get(projectId);
    if (existing) clearTimeout(existing);
    timers.set(
      projectId,
      setTimeout(() => {
        timers.delete(projectId);
        const project = storage.getProject(projectId);
        if (project) void push(project);
      }, PUSH_DEBOUNCE_MS),
    );
  };

  const onSaved = (e: Event): void => {
    const ids = (e as CustomEvent<{ projectIds: string[] }>).detail.projectIds;
    for (const id of ids) {
      if (sharedProjects.has(id)) schedule(id);
    }
  };

  window.addEventListener(TASKER_SAVED_EVENT, onSaved);

  // Reconcile whatever changed while the app was closed.
  void boardApi.listShares().then((ids) => {
    for (const id of ids) {
      sharedProjects.add(id);
      const project = storage.getProject(id);
      if (project) void push(project);
    }
    if (ids.length > 0) notifySharesChanged();
  });

  return () => {
    window.removeEventListener(TASKER_SAVED_EVENT, onSaved);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- ui/src/tasker/share.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/tasker/share.ts ui/src/tasker/share.test.ts
git commit -m "feat(tasker): debounced auto-push of shared boards to the forge"
```

---

### Task 5: The share control in the Tasker panel

The project head row today holds only a delete button (`ui/src/tasker/panel.ts:346`). It gains a share toggle beside it.

**Files:**
- Modify: `ui/src/tasker/panel.ts` — `renderProject` (~line 331-357), `setupEventListeners`, and the constructor/`dispose`
- Modify: `ui/src/tasker/styles.css` (append the block below)
- Test: `ui/src/tasker/panel.test.ts` (append the describe block)

**Interfaces:**
- Consumes: `isBoardShared`, `getPushState`, `shareProjectBoard`, `copyBoardLink`, `revokeBoardShare`, `ensureBoardSharesLoaded`, `startBoardAutoPush`, `BOARD_SHARES_EVENT` (Task 4); `Icons`, `attachTooltip` as already imported by the panel.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/tasker/panel.test.ts` (match the file's existing setup for constructing a `TaskerPanel` — reuse its helper rather than inventing one):

The file already has `mount()` (line 5) returning `{ panel, host }`, `storageOf(panel)` (line 13) and `inbox(panel)` (line 17). Reuse them:

```ts
describe("board share control", () => {
  it("renders a share button per project, unmarked when not shared", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);

    const btn = host.querySelector<HTMLButtonElement>(
      `.tasker-project-share[data-project-id="${pid}"]`,
    );
    expect(btn).not.toBeNull();
    expect(btn!.classList.contains("shared")).toBe(false);
    expect(btn!.getAttribute("aria-label")).toBe("Share board");
  });
});
```

`panel.test.ts` runs in jsdom without a Tauri host, so `ensureBoardSharesLoaded()` and `startBoardAutoPush()` will reject on `invoke`. Both already swallow their failures, but if the suite reports unhandled rejections, mock the module at the top of the file:

```ts
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.reject(new Error("no tauri")) }));
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- ui/src/tasker/panel.test.ts`
Expected: FAIL — `expect(received).not.toBeNull()`, the button does not exist.

- [ ] **Step 3: Write the implementation**

Add the imports at the top of `panel.ts`:

```ts
import {
  BOARD_SHARES_EVENT,
  copyBoardLink,
  ensureBoardSharesLoaded,
  getPushState,
  isBoardShared,
  revokeBoardShare,
  shareProjectBoard,
  startBoardAutoPush,
} from "./share";
```

In `renderProject`, replace the delete-button line (`panel.ts:346`) with a share button followed by the unchanged delete button:

```ts
          ${this.renderShareButton(project)}
          ${project.name === "Inbox" ? "" : `<button class="tasker-project-delete" type="button" data-project-id="${project.id}" aria-label="Delete project">${Icons.trash({ size: 13 })}</button>`}`}
```

Add the renderer as a private method on the class:

```ts
  private renderShareButton(project: Project): string {
    const shared = isBoardShared(project.id);
    const state = shared ? getPushState(project.id) : "synced";
    const label = shared ? "Board shared — click for options" : "Share board";
    return `<button class="tasker-project-share${shared ? " shared" : ""}" type="button"
      data-project-id="${project.id}" data-push-state="${state}" aria-label="${escapeAttr(shared ? "Board shared" : "Share board")}"
      data-tip="${escapeAttr(label)}">${Icons.share({ size: 13 })}${shared ? `<span class="tasker-share-dot" aria-hidden="true"></span>` : ""}</button>`;
  }
```

`Icons.share` exists (`ui/src/icons/index.ts:533`); the panel already imports `Icons` from `../icons` (panel.ts:5). Never an emoji, and never `element.title` — the tooltip is attached imperatively, as at panel.ts:604 and panel.ts:721.

In `setupEventListeners`, add the click handler:

```ts
    this.host.querySelectorAll<HTMLButtonElement>(".tasker-project-share").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const projectId = btn.dataset.projectId;
        if (!projectId) return;
        const project = this.storage.getProject(projectId);
        if (!project) return;
        if (!isBoardShared(projectId)) {
          void shareProjectBoard(project);
          return;
        }
        // Shared already: plain click copies, alt-click stops sharing.
        if (ev.altKey) void revokeBoardShare(projectId);
        else void copyBoardLink(projectId);
      });
    });
```

Also attach the tooltip inside `setupEventListeners`, next to the existing `attachTooltip` calls:

```ts
    this.host.querySelectorAll<HTMLButtonElement>(".tasker-project-share").forEach((btn) => {
      attachTooltip(btn, btn.dataset.tip ?? "Share board");
    });
```

In the constructor, wire the lifecycle:

```ts
    // ponytail: no teardown — TaskerPanel has no dispose and lives for the
    // app's lifetime. Add one here if the panel ever becomes disposable.
    ensureBoardSharesLoaded();
    startBoardAutoPush(this.storage);
    window.addEventListener(BOARD_SHARES_EVENT, () => this.render());
```

Append to `ui/src/tasker/styles.css`:

```css
/* Board share toggle — hover-revealed like the delete action beside it. */
.tasker-project-share {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 4px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--text-dim);
  opacity: 0;
  cursor: pointer;
}
.tasker-project-headrow:hover .tasker-project-share,
.tasker-project-share.shared,
.tasker-project-share:focus-visible {
  opacity: 1;
}
.tasker-project-share.shared {
  color: var(--accent);
}
.tasker-share-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.tasker-project-share[data-push-state="pushing"] .tasker-share-dot {
  animation: tasker-share-pulse 1s ease-in-out infinite;
}
.tasker-project-share[data-push-state="stale"] .tasker-share-dot {
  background: var(--text-dim);
}
@keyframes tasker-share-pulse {
  50% { opacity: 0.3; }
}
```

- [ ] **Step 4: Run the tests and the type-checker**

Run: `npm test -- ui/src/tasker`
Expected: PASS, including the pre-existing panel and board suites.

Run: `npm run build`
Expected: type-check clean, bundle succeeds.

- [ ] **Step 5: Commit**

```bash
git add ui/src/tasker/panel.ts ui/src/tasker/panel.test.ts ui/src/tasker/styles.css
git commit -m "feat(tasker): share-board control on the project row"
```

---

### Task 6: The forge — `/b/:token` (separate repo: `covenant-server`)

**This task cannot be executed from this checkout.** Clone `covenant-server` first. Everything below mirrors how gists are already implemented there — read `src/templates/gist.html` and the `gists` routes before writing anything, and follow whatever migration tool that repo already uses.

**Files (in `covenant-server`):**
- Create: a migration adding the `boards` table
- Create: `src/templates/board.html`
- Modify: the router module that registers `/gists` and `/g/:token`

**Interfaces:**
- Consumes: the `BoardShare` contract from Task 2 — `POST /boards {title, payload}` → `{id, token}`; `PUT /boards/:id {title, payload}` → 204; `POST /boards/:id/revoke` → 204. All three are JWT-authed and scoped to the calling user.
- Produces: public `GET /b/:token` → HTML; public `GET /b/:token.json` → the stored `payload` with an `ETag` header equal to `updated_at`.

- [ ] **Step 1: Migration**

```sql
CREATE TABLE boards (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  payload     JSONB NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX boards_user_id_idx ON boards(user_id);
```

- [ ] **Step 2: Authed routes**

Clone the gist handlers. Token generation is `Uuid::new_v4().simple()`, exactly as gists do it. `PUT` and `revoke` must filter on `user_id = <caller>` so one user cannot touch another's board; a miss returns 404, not 403.

- [ ] **Step 3: Public routes**

```
GET /b/:token       → 404 unless a row matches AND revoked = FALSE.
                      Render board.html with the payload as an escaped JSON island.
GET /b/:token.json  → same lookup; ETag = updated_at as a quoted string.
                      If-None-Match matches → 304 with no body.
```

Revoked and unknown tokens must be indistinguishable — the same generic 404 body, so tokens cannot be enumerated.

- [ ] **Step 4: `board.html`**

Copy `gist.html` and replace its body renderer. Required behaviour, all client-side vanilla JS over the JSON island:

- Header: `title`, then a counts line `N in progress · N to do · N done`, then `updated Xs ago` in mono, recomputed every second from `updatedAt`.
- Three columns in payload order, sharp corners, no shadows. A task is a row: title, then a mono meta line with due date, tags and `done/total` subtasks when present.
- Priority is a 2px left border on the row, rendered only for `high` and `urgent`.
- The `done` column is collapsed by default with its count in the header; click toggles.
- A task with `dueDate` in the past whose column is not `done` renders its date in the alert colour. It is the page's only red.
- Under 720px the columns stack, To Do and In Progress first, headers sticky.
- Poll `/b/:token.json` every 20s carrying `If-None-Match`; on 200, re-render and fade in over 200ms only the rows that are new or changed column. On 404, stop polling and show "This board is no longer shared."
- Escape every interpolated string. No `<form>`, no `fetch` other than the poll.

- [ ] **Step 5: Verify end to end, then deploy**

With the server running locally and `COVENANT_BACKEND_URL` pointed at it, from Covenant: share a board, confirm the link renders; move a task between columns and confirm the viewer updates within ~20s without a manual reload; alt-click to revoke and confirm the link 404s. Then deploy and re-check against `forge.covenant.uno`.

- [ ] **Step 6: Commit (in `covenant-server`)**

```bash
git add migrations/ src/templates/board.html src/routes/
git commit -m "feat(boards): read-only Tasker board shares at /b/:token"
```

---

## Notes on ordering

Tasks 1–4 are independent of the server and fully testable without it: `board_publish` will fail against a forge that has no `/boards` route, which is why the panel surfaces a *stale* dot rather than a modal error. Task 5 is usable the moment Task 6 ships. Do not start Task 6 before Tasks 1–4 are merged — the payload shape is the contract, and it is defined by `toSnapshot`.
