# Covenant Score CS-2 Implementation Plan — GitHub Sign-In

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship GitHub Device Flow sign-in. After CS-2, the user can connect their GitHub account from the Score modal; the chip shows their login + streak instead of "Sign in"; the modal shows avatar + login + current local stats. No backend yet — sync ships in CS-3.

**Architecture:**
- Device Flow uses only `client_id` (no client_secret), so it ships 100% client-side.
- Token stored in macOS Keychain via `keyring` crate.
- User info (login, avatar_url, github_id, connected_at) stored in `karl-score`'s SQLite as a new `user_session` table (single-row).
- Tauri commands expose start / poll / signout / current_user.
- UI: modal renders signed-in vs signed-out states; "Sign in" button triggers device-flow popover with user-code + "open github.com/login/device" button + polling.

**Tech Stack:** Rust (reqwest, keyring), TypeScript, Tauri 2.

**Prerequisites (manual, user does this):**
1. Go to https://github.com/settings/applications/new
2. Name: `Covenant Score`
3. Homepage URL: `https://covenant.uno`
4. Callback URL: leave blank (device flow doesn't use it)
5. Enable **Device Flow** (checkbox at the bottom of the form).
6. Submit. Copy the **Client ID** (no secret needed for device flow).
7. Paste it in step 1 of Task 1 below — replace `__GITHUB_CLIENT_ID__`.

---

## File Structure

**New files:**
- `crates/score/src/auth.rs` — Device Flow client (start / poll / fetch user), Keychain helpers
- `crates/score/src/session.rs` — `user_session` table CRUD
- `crates/score/tests/auth.rs` — unit tests with mocked HTTP responses
- `crates/app/src/score_auth_commands.rs` — `score_signin_start`, `score_signin_poll`, `score_signout`, `score_current_user`
- `ui/src/score/signin.ts` — device-flow popover UI
- `ui/src/score/user.ts` — current user state + cache

**Modified:**
- `crates/score/Cargo.toml` — `reqwest` (workspace, with `json`), `keyring` (3.x), `mockito` dev-dep for tests
- `crates/score/src/lib.rs` — re-export auth + session types
- `crates/score/src/types.rs` — `User`, `DeviceCodeResponse`, `DeviceTokenResponse`
- `crates/app/src/lib.rs` — register new commands, pass `Arc<ScoreStore>` to auth module
- `crates/app/src/score_commands.rs` — extend `Summary` invocation OR add a separate `score_user` command (we add separate)
- `ui/src/score/api.ts` — typed wrappers for the 4 new commands
- `ui/src/score/chip.ts` — when signed-in: show `{login} · {streak}d` with avatar
- `ui/src/score/modal.ts` — render signed-in header (avatar + login + connected date), hide CTA banner when signed-in, add "Disconnect" link
- `ui/src/score/styles.css` — avatar circle, signin popover

**Hard-coded constant:** GitHub OAuth App `client_id` — value lives in `crates/score/src/auth.rs` as `const GITHUB_CLIENT_ID: &str = "..."`. No secret to leak.

---

## Task 1: Add deps + types + GitHub client_id constant

**Files:**
- Modify: `crates/score/Cargo.toml`
- Create: `crates/score/src/auth.rs` (stub with const only)
- Modify: `crates/score/src/types.rs` — add `User` type
- Modify: `crates/score/src/lib.rs` — declare `pub mod auth;`

- [ ] Step 1: In `crates/score/Cargo.toml`, add to `[dependencies]`:

```toml
reqwest = { workspace = true, features = ["json"] }
keyring = "3"
```

And to `[dev-dependencies]`:

```toml
mockito = "1"
```

Note: `reqwest` is already in workspace deps; just enable `json` feature for karl-score. If workspace `reqwest` already has `json`, the `features = ["json"]` line is redundant but harmless.

- [ ] Step 2: Add to `crates/score/src/types.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub github_id: i64,
    pub login: String,
    pub avatar_url: String,
    pub connected_at_ms: i64,
}
```

- [ ] Step 3: Create `crates/score/src/auth.rs` (stub):

```rust
//! GitHub OAuth Device Flow client. Holds the public client_id (no
//! secret — device flow on OAuth Apps does not require one). Token is
//! persisted in macOS Keychain via the `keyring` crate; user info
//! sits in score.sqlite (session module).

pub const GITHUB_CLIENT_ID: &str = "__GITHUB_CLIENT_ID__";

pub const KEYCHAIN_SERVICE: &str = "covenant.uno";
pub const KEYCHAIN_USERNAME: &str = "github-token";
```

Replace `__GITHUB_CLIENT_ID__` with the real value from the prerequisite step.

- [ ] Step 4: In `crates/score/src/lib.rs`, add `pub mod auth;` next to other module declarations. Re-export `User` from types alongside the others.

- [ ] Step 5: Verify build:

```
cargo check -p karl-score
```

- [ ] Step 6: Commit:

```
git add crates/score
git -c commit.gpgsign=false commit -m "feat(score): scaffold auth module with GitHub client_id constant

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `user_session` table + CRUD

**Files:**
- Create: `crates/score/src/session.rs`
- Modify: `crates/score/src/store.rs` — extend `open()` to create the new table
- Modify: `crates/score/src/lib.rs` — `pub mod session;`
- Create: `crates/score/tests/session.rs`

- [ ] Step 1: In `store.rs` `ScoreStore::open()`, extend the `execute_batch` SQL to also create:

```sql
CREATE TABLE IF NOT EXISTS user_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    github_id INTEGER NOT NULL,
    login TEXT NOT NULL,
    avatar_url TEXT NOT NULL,
    connected_at_ms INTEGER NOT NULL
);
```

(One-row table — `id` is fixed at 1, so an UPSERT on id=1 acts as set-current-user.)

- [ ] Step 2: Write failing test `crates/score/tests/session.rs`:

```rust
use karl_score::{session, ScoreStore, User};
use tempfile::tempdir;

#[test]
fn save_and_load_user() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    assert!(session::current(&store).unwrap().is_none());

    let u = User { github_id: 42, login: "karluiz".into(),
                   avatar_url: "https://avatars/x".into(),
                   connected_at_ms: 1_700_000_000_000 };
    session::set_current(&store, &u).unwrap();

    let loaded = session::current(&store).unwrap().unwrap();
    assert_eq!(loaded.github_id, 42);
    assert_eq!(loaded.login, "karluiz");

    session::clear(&store).unwrap();
    assert!(session::current(&store).unwrap().is_none());
}
```

- [ ] Step 3: Implement `crates/score/src/session.rs`:

```rust
use crate::{store::Result, ScoreStore, User};
use rusqlite::{params, OptionalExtension};

pub fn current(store: &ScoreStore) -> Result<Option<User>> {
    let c = store.connection();
    let c = c.lock().unwrap();
    let row = c
        .query_row(
            "SELECT github_id, login, avatar_url, connected_at_ms
             FROM user_session WHERE id = 1",
            [],
            |r| {
                Ok(User {
                    github_id: r.get(0)?,
                    login: r.get(1)?,
                    avatar_url: r.get(2)?,
                    connected_at_ms: r.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn set_current(store: &ScoreStore, u: &User) -> Result<()> {
    let c = store.connection();
    let c = c.lock().unwrap();
    c.execute(
        "INSERT INTO user_session(id, github_id, login, avatar_url, connected_at_ms)
         VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(id) DO UPDATE SET
            github_id=excluded.github_id,
            login=excluded.login,
            avatar_url=excluded.avatar_url,
            connected_at_ms=excluded.connected_at_ms",
        params![u.github_id, u.login, u.avatar_url, u.connected_at_ms],
    )?;
    Ok(())
}

pub fn clear(store: &ScoreStore) -> Result<()> {
    let c = store.connection();
    let c = c.lock().unwrap();
    c.execute("DELETE FROM user_session WHERE id = 1", [])?;
    Ok(())
}
```

Note: this requires exposing the `conn: Arc<Mutex<Connection>>` via a `pub fn connection(&self) -> Arc<Mutex<Connection>>` on `ScoreStore`. Add this method to `store.rs`:

```rust
impl ScoreStore {
    pub fn connection(&self) -> Arc<Mutex<Connection>> {
        self.conn.clone()
    }
}
```

- [ ] Step 4: `cargo test -p karl-score` — all tests pass.

- [ ] Step 5: Commit:

```
git add crates/score
git -c commit.gpgsign=false commit -m "feat(score): user_session table for current GitHub identity

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Device Flow HTTP client + Keychain

**Files:**
- Modify: `crates/score/src/auth.rs`
- Create: `crates/score/tests/auth.rs`

- [ ] Step 1: Replace `crates/score/src/auth.rs`:

```rust
//! GitHub OAuth Device Flow. https://docs.github.com/en/apps/oauth-apps/
//! building-oauth-apps/authorizing-oauth-apps#device-flow

use crate::{User, ScoreStore, session};
use serde::{Deserialize, Serialize};

pub const GITHUB_CLIENT_ID: &str = "__GITHUB_CLIENT_ID__";
pub const KEYCHAIN_SERVICE: &str = "covenant.uno";
pub const KEYCHAIN_USERNAME: &str = "github-token";

const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const USER_URL: &str = "https://api.github.com/user";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u32,      // seconds between polls
    pub expires_in: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DeviceTokenResponse {
    Success { access_token: String, token_type: String, scope: String },
    Pending { error: String, error_description: Option<String> },
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("github: {0}")]
    Github(String),
    #[error("keyring: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("score: {0}")]
    Score(#[from] crate::store::ScoreError),
}

pub async fn start_device_flow(
    base_url: &str,
) -> Result<DeviceCodeResponse, AuthError> {
    let url = format!("{base_url}/login/device/code");
    let resp = reqwest::Client::new()
        .post(&url)
        .header("Accept", "application/json")
        .form(&[("client_id", GITHUB_CLIENT_ID)])
        .send().await?
        .error_for_status()?;
    let body: DeviceCodeResponse = resp.json().await?;
    Ok(body)
}

pub async fn poll_token(
    base_url: &str,
    device_code: &str,
) -> Result<DeviceTokenResponse, AuthError> {
    let url = format!("{base_url}/login/oauth/access_token");
    let resp = reqwest::Client::new()
        .post(&url)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", GITHUB_CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send().await?
        .error_for_status()?;
    let body: DeviceTokenResponse = resp.json().await?;
    Ok(body)
}

pub async fn fetch_user(
    api_base: &str,
    token: &str,
) -> Result<User, AuthError> {
    let url = format!("{api_base}/user");
    let resp = reqwest::Client::new()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "covenant-score")
        .bearer_auth(token)
        .send().await?
        .error_for_status()?;
    let v: serde_json::Value = resp.json().await?;
    Ok(User {
        github_id: v["id"].as_i64()
            .ok_or_else(|| AuthError::Github("missing id".into()))?,
        login: v["login"].as_str()
            .ok_or_else(|| AuthError::Github("missing login".into()))?
            .to_string(),
        avatar_url: v["avatar_url"].as_str().unwrap_or("").to_string(),
        connected_at_ms: chrono::Utc::now().timestamp_millis(),
    })
}

pub fn store_token_in_keychain(token: &str) -> Result<(), AuthError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)?;
    entry.set_password(token)?;
    Ok(())
}

pub fn load_token_from_keychain() -> Result<Option<String>, AuthError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)?;
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_token_from_keychain() -> Result<(), AuthError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// High-level: once the user has a token, fetch their /user record and
/// persist it (Keychain + SQLite). Returns the User.
pub async fn finalize_signin(
    api_base: &str,
    token: &str,
    store: &ScoreStore,
) -> Result<User, AuthError> {
    let user = fetch_user(api_base, token).await?;
    store_token_in_keychain(token)?;
    session::set_current(store, &user)?;
    Ok(user)
}

pub fn signout(store: &ScoreStore) -> Result<(), AuthError> {
    delete_token_from_keychain()?;
    session::clear(store)?;
    Ok(())
}

pub const GITHUB_OAUTH_BASE: &str = "https://github.com";
pub const GITHUB_API_BASE: &str = "https://api.github.com";
```

Don't forget to replace `__GITHUB_CLIENT_ID__` with the real client_id from Task 1.

- [ ] Step 2: Write tests `crates/score/tests/auth.rs` using `mockito`:

```rust
use karl_score::auth::{
    fetch_user, poll_token, start_device_flow, DeviceTokenResponse,
};

#[tokio::test]
async fn start_device_flow_parses_response() {
    let mut server = mockito::Server::new_async().await;
    let _m = server.mock("POST", "/login/device/code")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{
            "device_code": "abc123",
            "user_code": "WDJB-MJHT",
            "verification_uri": "https://github.com/login/device",
            "interval": 5,
            "expires_in": 900
        }"#)
        .create_async().await;
    let resp = start_device_flow(&server.url()).await.unwrap();
    assert_eq!(resp.user_code, "WDJB-MJHT");
    assert_eq!(resp.interval, 5);
}

#[tokio::test]
async fn poll_token_handles_pending() {
    let mut server = mockito::Server::new_async().await;
    let _m = server.mock("POST", "/login/oauth/access_token")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"error":"authorization_pending"}"#)
        .create_async().await;
    let resp = poll_token(&server.url(), "abc").await.unwrap();
    assert!(matches!(resp, DeviceTokenResponse::Pending { .. }));
}

#[tokio::test]
async fn poll_token_handles_success() {
    let mut server = mockito::Server::new_async().await;
    let _m = server.mock("POST", "/login/oauth/access_token")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"access_token":"ghu_xxx","token_type":"bearer","scope":""}"#)
        .create_async().await;
    let resp = poll_token(&server.url(), "abc").await.unwrap();
    assert!(matches!(resp, DeviceTokenResponse::Success { .. }));
}

#[tokio::test]
async fn fetch_user_parses_github_user() {
    let mut server = mockito::Server::new_async().await;
    let _m = server.mock("GET", "/user")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{"id": 12345, "login": "karluiz", "avatar_url": "https://avatars/x"}"#)
        .create_async().await;
    let u = fetch_user(&server.url(), "tok").await.unwrap();
    assert_eq!(u.github_id, 12345);
    assert_eq!(u.login, "karluiz");
    assert_eq!(u.avatar_url, "https://avatars/x");
}
```

- [ ] Step 3: Run `cargo test -p karl-score` — all pass.

- [ ] Step 4: Commit:

```
git add crates/score
git -c commit.gpgsign=false commit -m "feat(score): GitHub Device Flow client + Keychain token storage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Tauri commands for sign-in lifecycle

**Files:**
- Create: `crates/app/src/score_auth_commands.rs`
- Modify: `crates/app/src/lib.rs` — register module + handler entries

- [ ] Step 1: Create `crates/app/src/score_auth_commands.rs`:

```rust
use karl_score::auth::{
    self, DeviceCodeResponse, DeviceTokenResponse,
    GITHUB_OAUTH_BASE, GITHUB_API_BASE,
};
use karl_score::{session, User};
use crate::score_commands::ScoreState;
use tauri::State;

#[tauri::command]
pub async fn score_signin_start() -> Result<DeviceCodeResponse, String> {
    auth::start_device_flow(GITHUB_OAUTH_BASE).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn score_signin_poll(
    state: State<'_, ScoreState>,
    device_code: String,
) -> Result<Option<User>, String> {
    let store = state.0.clone();
    match auth::poll_token(GITHUB_OAUTH_BASE, &device_code).await
        .map_err(|e| e.to_string())?
    {
        DeviceTokenResponse::Pending { .. } => Ok(None),
        DeviceTokenResponse::Success { access_token, .. } => {
            let user = auth::finalize_signin(GITHUB_API_BASE, &access_token, &store)
                .await.map_err(|e| e.to_string())?;
            Ok(Some(user))
        }
    }
}

#[tauri::command]
pub fn score_current_user(state: State<'_, ScoreState>) -> Result<Option<User>, String> {
    session::current(&state.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_signout(state: State<'_, ScoreState>) -> Result<(), String> {
    auth::signout(&state.0).map_err(|e| e.to_string())
}
```

- [ ] Step 2: In `crates/app/src/lib.rs`, add `mod score_auth_commands;` alongside other mods. Append to `tauri::generate_handler![...]`:

```
score_auth_commands::score_signin_start,
score_auth_commands::score_signin_poll,
score_auth_commands::score_current_user,
score_auth_commands::score_signout,
```

- [ ] Step 3: `cargo check -p covenant`.

- [ ] Step 4: Commit:

```
git add crates/app
git -c commit.gpgsign=false commit -m "feat(score): Tauri commands for GitHub sign-in lifecycle

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: UI — sign-in popover + user state

**Files:**
- Modify: `ui/src/score/api.ts` — add types + 4 invocations
- Create: `ui/src/score/user.ts` — cached current-user accessor
- Create: `ui/src/score/signin.ts` — popover modal

- [ ] Step 1: Extend `ui/src/score/api.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

// (existing Summary, DailyCell, scoreSummary, scoreHeatmap stay)

export interface User {
  github_id: number;
  login: string;
  avatar_url: string;
  connected_at_ms: number;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export async function scoreSigninStart(): Promise<DeviceCodeResponse> {
  return invoke<DeviceCodeResponse>("score_signin_start");
}

export async function scoreSigninPoll(
  device_code: string,
): Promise<User | null> {
  return invoke<User | null>("score_signin_poll", { deviceCode: device_code });
}

export async function scoreCurrentUser(): Promise<User | null> {
  return invoke<User | null>("score_current_user");
}

export async function scoreSignout(): Promise<void> {
  return invoke<void>("score_signout");
}
```

- [ ] Step 2: Create `ui/src/score/user.ts`:

```ts
import { scoreCurrentUser, type User } from "./api";

let cached: User | null | undefined = undefined;
const listeners: Array<(u: User | null) => void> = [];

export async function getCurrentUser(force = false): Promise<User | null> {
  if (cached !== undefined && !force) return cached;
  cached = await scoreCurrentUser();
  return cached;
}

export function setCurrentUser(u: User | null): void {
  cached = u;
  for (const l of listeners) l(u);
}

export function onUserChanged(l: (u: User | null) => void): () => void {
  listeners.push(l);
  return () => {
    const i = listeners.indexOf(l);
    if (i >= 0) listeners.splice(i, 1);
  };
}
```

- [ ] Step 3: Create `ui/src/score/signin.ts`:

```ts
import { scoreSigninPoll, scoreSigninStart, type User } from "./api";
import { setCurrentUser } from "./user";

/// Show the device-flow popover. Resolves with the authenticated User
/// on success, or null if the user closes the popover before completing.
export async function runDeviceFlow(): Promise<User | null> {
  const dc = await scoreSigninStart();

  return new Promise<User | null>((resolve) => {
    const back = document.createElement("div");
    back.className = "score-modal-backdrop";

    const box = document.createElement("div");
    box.className = "score-modal score-signin";
    box.innerHTML = `
      <h3>Connect GitHub</h3>
      <div class="sub">Enter this code on github.com to authorize Covenant.</div>
      <div class="signin-code">${dc.user_code.split("").map(c =>
        `<span>${c === "-" ? "&minus;" : c}</span>`).join("")}</div>
      <div class="signin-actions">
        <button type="button" class="signin-open">Open github.com/login/device</button>
        <button type="button" class="signin-copy">Copy code</button>
      </div>
      <div class="signin-status">Waiting for authorization…</div>
    `;
    back.appendChild(box);
    document.body.appendChild(back);

    const status = box.querySelector(".signin-status") as HTMLElement;
    const openBtn = box.querySelector(".signin-open") as HTMLButtonElement;
    const copyBtn = box.querySelector(".signin-copy") as HTMLButtonElement;

    openBtn.addEventListener("click", () => {
      window.open(dc.verification_uri, "_blank");
    });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(dc.user_code);
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy code"), 1500);
    });

    let cancelled = false;
    back.addEventListener("click", (e) => {
      if (e.target === back) {
        cancelled = true;
        back.remove();
        resolve(null);
      }
    });

    const intervalMs = Math.max(dc.interval, 5) * 1000;
    const deadline = Date.now() + dc.expires_in * 1000;

    async function tick(): Promise<void> {
      if (cancelled) return;
      if (Date.now() > deadline) {
        status.textContent = "Code expired. Close and try again.";
        return;
      }
      try {
        const user = await scoreSigninPoll(dc.device_code);
        if (user) {
          setCurrentUser(user);
          back.remove();
          resolve(user);
          return;
        }
      } catch (e) {
        console.warn("signin poll error", e);
      }
      setTimeout(() => void tick(), intervalMs);
    }
    setTimeout(() => void tick(), intervalMs);
  });
}
```

- [ ] Step 4: `npx tsc --noEmit` from `ui/` — clean.

- [ ] Step 5: Commit:

```
git add ui/src/score
git -c commit.gpgsign=false commit -m "feat(score): UI device-flow popover + user state cache

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Modal + chip — signed-in state

**Files:**
- Modify: `ui/src/score/modal.ts` — render signed-in header, hide CTA when signed-in, add Disconnect
- Modify: `ui/src/score/chip.ts` — when signed-in, show login + streak (with avatar)
- Modify: `ui/src/score/styles.css` — avatar circle, signin popover styles

- [ ] Step 1: Update `chip.ts` to consult user state:

Replace `refresh()` and add user reactivity. Imports:

```ts
import { scoreSummary, type Summary } from "./api";
import { getCurrentUser, onUserChanged } from "./user";
```

Replace the body of `refresh()`:

```ts
  async function refresh(): Promise<void> {
    try {
      const [s, u] = await Promise.all([scoreSummary(), getCurrentUser()]);
      text.innerHTML = renderChipText(s, u);
    } catch (e) {
      console.warn("score chip refresh failed", e);
    }
  }
```

Add helper above `makeScoreChip`:

```ts
function renderChipText(s: Summary, u: { login: string; avatar_url: string } | null): string {
  if (!u && s.total_prompts === 0 && s.total_commits === 0) return "Sign in";
  const streak = s.current_streak > 0 ? ` · ${s.current_streak}d` : "";
  if (!u) return `${s.total_prompts} prompts${streak}`;
  return `<img class="score-chip-avatar" src="${u.avatar_url}" alt=""> ${u.login}${streak}`;
}
```

Inside `makeScoreChip`, after wiring `setOnClick`, subscribe to user changes:

```ts
  onUserChanged(() => { void refresh(); });
```

- [ ] Step 2: Update `modal.ts` to:

- Call `await getCurrentUser()` alongside summary/heatmap.
- If `user` present: render `<img class="score-avatar">` + `<h3>{login}</h3>` + `<div class="sub">Connected {date}</div>` + at footer, "Disconnect" link.
- If `user` absent: keep existing header + CTA banner. CTA button calls `runDeviceFlow()` from `signin.ts`; on success, re-fetches user and re-renders the modal in-place.

Concrete patch — replace the `openScoreModal` body:

```ts
import { runDeviceFlow } from "./signin";
import { getCurrentUser, setCurrentUser } from "./user";
import { scoreSignout, scoreHeatmap, scoreSummary, type DailyCell, type Summary, type User } from "./api";

// ... intensityClass and renderHeatmap unchanged

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function renderHeader(user: User | null): string {
  if (!user) return `
    <h3>Covenant Score</h3>
    <div class="sub">Tracking local · No sincronizado</div>`;
  return `
    <div class="score-header">
      <img class="score-avatar" src="${user.avatar_url}" alt="">
      <div>
        <h3>${user.login}</h3>
        <div class="sub">Connected ${formatDate(user.connected_at_ms)}</div>
      </div>
    </div>`;
}

function renderFooter(user: User | null): string {
  if (!user) return `
    <div class="score-cta">
      <div class="text">
        <h4>Conecta GitHub para sincronizar</h4>
        <p>Backup, multi-dispositivo, y perfil público (próximamente).</p>
      </div>
      <button type="button" class="signin-trigger">Sign in with GitHub</button>
    </div>`;
  return `
    <div class="score-footer">
      <a href="#" class="signout">Disconnect GitHub</a>
    </div>`;
}

export async function openScoreModal(): Promise<void> {
  const existing = document.querySelector(".score-modal-backdrop");
  if (existing) { existing.remove(); return; }

  const [summary, cells, user] = await Promise.all([
    scoreSummary(), scoreHeatmap(), getCurrentUser(),
  ]);

  const back = document.createElement("div");
  back.className = "score-modal-backdrop";
  back.addEventListener("click", (e) => {
    if (e.target === back) back.remove();
  });

  const modal = document.createElement("div");
  modal.className = "score-modal";
  modal.innerHTML = `
    ${renderHeader(user)}
    <div class="score-stat-row">
      <div class="score-stat"><div class="v">${summary.total_prompts}</div>
        <div class="l">Total prompts</div></div>
      <div class="score-stat"><div class="v">${summary.today_prompts}</div>
        <div class="l">Today</div></div>
      <div class="score-stat"><div class="v">${summary.current_streak}d</div>
        <div class="l">Current streak</div></div>
      <div class="score-stat"><div class="v">${summary.total_commits}</div>
        <div class="l">Total commits</div></div>
    </div>
    <div class="score-heatmap-wrap"></div>
    <div class="score-legend">
      <span>Less</span>
      <span class="score-cell"></span>
      <span class="score-cell l1"></span>
      <span class="score-cell l2"></span>
      <span class="score-cell l3"></span>
      <span class="score-cell l4"></span>
      <span>More</span>
    </div>
    ${renderFooter(user)}
  `;
  modal.querySelector(".score-heatmap-wrap")!.appendChild(renderHeatmap(cells));

  modal.querySelector(".signin-trigger")?.addEventListener("click", async () => {
    const u = await runDeviceFlow();
    if (u) { back.remove(); void openScoreModal(); }
  });
  modal.querySelector(".signout")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await scoreSignout();
    setCurrentUser(null);
    back.remove();
    void openScoreModal();
  });

  back.appendChild(modal);
  document.body.appendChild(back);
}
```

- [ ] Step 3: Extend `ui/src/score/styles.css`. Append:

```css
.score-header { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.score-avatar { width: 36px; height: 36px; border-radius: 50%;
  border: 1px solid #2a5a64; }
.score-chip-avatar { width: 12px; height: 12px; border-radius: 50%;
  vertical-align: middle; margin-right: 4px; }
.score-footer { margin-top: 16px; padding-top: 12px;
  border-top: 1px solid #1a2128; text-align: right; }
.score-footer .signout { color: #5a6873; font-size: 11px;
  text-decoration: none; border-bottom: 1px dotted #3a4854; }
.score-footer .signout:hover { color: #c8d4dc; }

.score-signin { width: 480px; text-align: center; }
.score-signin .signin-code { display: inline-flex; gap: 6px;
  margin: 18px 0; font-size: 28px; letter-spacing: 0.05em;
  color: #7dd3e0; font-weight: 500; }
.score-signin .signin-code span { padding: 6px 10px;
  border: 1px solid #2a5a64; border-radius: 6px;
  background: rgba(95,179,196,0.04); }
.score-signin .signin-actions { display: flex; gap: 10px;
  justify-content: center; margin-bottom: 14px; }
.score-signin .signin-actions button {
  background: #1a2128; border: 1px solid #2a3540;
  color: #e8f1f5; border-radius: 6px; padding: 8px 14px;
  font-family: inherit; font-size: 11px; cursor: pointer; }
.score-signin .signin-actions button:hover {
  background: #232b34; border-color: #3a4854; }
.score-signin .signin-status { color: #5a6873; font-size: 11px; }
```

- [ ] Step 4: `npx tsc --noEmit` from `ui/` — clean.

- [ ] Step 5: Manual test:

```
npm run tauri dev
```

- Click chip → modal opens with "Sign in with GitHub" button.
- Click it → popover shows user_code + "Open github.com/login/device".
- Click "Open …" → browser opens. Enter the code, authorize.
- Popover closes within 5–10s (next poll). Modal re-renders with avatar + login + "Disconnect" link.
- Chip now shows avatar + login + streak.
- Click "Disconnect" → reverts to signed-out state.

- [ ] Step 6: Commit:

```
git add ui/src/score
git -c commit.gpgsign=false commit -m "feat(score): modal + chip render signed-in state with avatar

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: device flow ✓, Keychain storage ✓, user_session table ✓, signed-in chip ✓, signed-in modal ✓, disconnect ✓, no scopes requested ✓.
- Out of scope (CS-3): sync to Azure backend, public profile page, JWT, server-side commit verification, leaderboards.
- Token never leaves the local machine in CS-2. Backend cannot impersonate.
- If the user revokes the OAuth App in GitHub settings, the next API call in CS-3 will 401; CS-2 doesn't make any further API calls after sign-in so revocation is silently fine until CS-3.
