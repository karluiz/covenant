# Beacon — GitHub Deployments Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A right-rail sidebar that shows the GitHub deployment status (per environment) of the repo for the terminal session currently in view, polling while open.

**Architecture:** One backend Tauri command (`beacon_deployments(cwd)`) resolves the GitHub `owner/repo` from the cwd's git remote, loads the keychain token, and queries the GitHub Deployments API, returning a normalized per-environment list. A bespoke frontend panel (`ui/src/beacon/panel.ts`) renders that state and re-polls every 25s while visible. Wiring follows the existing `RightRailController` / bespoke-panel convention used by Tasker/Notes/Teammate.

**Tech Stack:** Rust (Tokio, `reqwest`, `serde`), `karl-score` keychain auth, Tauri 2 commands, TypeScript + DOM (no framework), Vitest.

## Global Constraints

- Source of truth: GitHub **Deployments API** only (`/repos/{o}/{r}/deployments` + statuses). Not Actions runs, not the Environments endpoint.
- Refresh: poll every **25s while the panel is visible**; stop on close. No background polling, no status-bar dot.
- Latest deployment **per environment** only (cap 10 envs); one status fetch per kept deployment.
- Errors return a typed state, never panic. No `unwrap()` outside tests.
- English-only UI copy.
- No native `title=` tooltips — use `attachTooltip` from `ui/src/tooltip/tooltip.ts`.
- True Dark: elevated/selected surfaces use neutral (text-primary) lifts, not accent tints.
- Reuse theme tokens (`--bg-panel`, `--border`, text tokens, `--right-sidebar-w`).
- Tests for `ui/` run from the **repo root** (not `ui/`): `npm run test` / `npx vitest`.

---

## File Structure

- **Create** `crates/app/src/beacon.rs` — git-remote→owner/repo parser, state→color note, GitHub fetch, `BeaconState`/`EnvDeploy` types. Pure logic + one async fetch fn.
- **Modify** `crates/app/src/lib.rs` — `mod beacon;`, the `#[tauri::command] beacon_deployments`, and register it in `generate_handler!`.
- **Create** `ui/src/beacon/panel.ts` — the panel class (render states, poll loop).
- **Create** `ui/src/beacon/beacon.css` — panel styles.
- **Create** `ui/src/beacon/panel.test.ts` — state→DOM render tests.
- **Modify** `ui/src/api.ts` — `beaconDeployments(cwd)` wrapper + types.
- **Modify** `ui/src/titlebar/right-rail.ts` — add `"beacon"` to `RailTarget`.
- **Modify** `ui/index.html` — rail button `#titlebar-beacon` + panel host `#beacon-panel`.
- **Modify** `ui/src/main.ts` — import css, register button in `railButtons`, `openRail`/`closeRail` cases, mount/open/close helpers, click handler.
- **Modify** `ui/src/styles.css` — `sidebar-view-beacon` layout block mirroring `sidebar-view-tasker`.

---

## Task 1: Backend — git remote → owner/repo parser

**Files:**
- Create: `crates/app/src/beacon.rs`
- Test: inline `#[cfg(test)]` in `crates/app/src/beacon.rs`

**Interfaces:**
- Produces: `pub fn parse_owner_repo(remote_url: &str) -> Option<(String, String)>`

- [ ] **Step 1: Write the failing test**

Add to `crates/app/src/beacon.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_url_variants() {
        let cases = [
            ("git@github.com:karluiz/covenant.git", Some(("karluiz", "covenant"))),
            ("https://github.com/karluiz/covenant.git", Some(("karluiz", "covenant"))),
            ("https://github.com/karluiz/covenant", Some(("karluiz", "covenant"))),
            ("ssh://git@github.com/karluiz/covenant.git", Some(("karluiz", "covenant"))),
            ("git@gitlab.com:karluiz/covenant.git", None),
            ("", None),
        ];
        for (input, want) in cases {
            let got = parse_owner_repo(input);
            let want = want.map(|(o, r)| (o.to_string(), r.to_string()));
            assert_eq!(got, want, "input={input:?}");
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant_lib beacon::tests::parses_remote_url_variants`
Expected: FAIL — `parse_owner_repo` not found.
(If the package name differs, get it from `crates/app/Cargo.toml` `[package] name`; use `cargo test -p <name> beacon::`.)

- [ ] **Step 3: Write minimal implementation**

At the top of `crates/app/src/beacon.rs`:

```rust
//! Beacon: GitHub deployment status for the active session's repo.

/// Parse a GitHub `owner/repo` out of a `git remote` URL. Handles
/// `git@github.com:o/r(.git)`, `https://github.com/o/r(.git)`, and
/// `ssh://git@github.com/o/r(.git)`. Returns None for non-GitHub remotes.
pub fn parse_owner_repo(remote_url: &str) -> Option<(String, String)> {
    let s = remote_url.trim();
    // Strip scheme/userinfo down to "github.com<sep>owner/repo".
    let rest = s
        .strip_prefix("git@")
        .or_else(|| s.strip_prefix("ssh://git@"))
        .or_else(|| s.strip_prefix("https://"))
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(s);
    let rest = rest.strip_prefix("github.com")?;
    // Separator is ':' (scp form) or '/' (url form).
    let path = rest.strip_prefix(':').or_else(|| rest.strip_prefix('/'))?;
    let path = path.trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.splitn(2, '/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty() && !s.contains('/'))?;
    Some((owner.to_string(), repo.to_string()))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p covenant_lib beacon::tests::parses_remote_url_variants`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/beacon.rs
git commit -m "feat(beacon): parse owner/repo from git remote url"
```

---

## Task 2: Backend — BeaconState types + deployment fetch

**Files:**
- Modify: `crates/app/src/beacon.rs`
- Test: inline `#[cfg(test)]` in `crates/app/src/beacon.rs`

**Interfaces:**
- Consumes: `parse_owner_repo` (Task 1).
- Produces:
  - `pub enum BeaconState` (serde-tagged) and `pub struct EnvDeploy`.
  - `pub async fn load_deployments(cwd: String) -> BeaconState`
  - `pub fn latest_per_environment(deployments: Vec<RawDeployment>) -> Vec<RawDeployment>`
  - `pub struct RawDeployment { pub id: u64, pub environment: String, pub sha: String, pub creator: Option<String>, pub created_at: String }`

This task adds: the serde types, a pure `latest_per_environment` reducer (unit-tested), and the async GitHub fetch (not unit-tested — it hits the network; covered by the panel/e2e later). The fetch is a self-contained ~20-line `reqwest` call rather than the operator-layer `gh_request` (which is private and returns the operator `ToolError`); this keeps Beacon decoupled from operator tool plumbing.

- [ ] **Step 1: Write the failing test (pure reducer only)**

Add to the `tests` module in `crates/app/src/beacon.rs`:

```rust
#[test]
fn keeps_only_newest_deployment_per_environment() {
    let raw = vec![
        RawDeployment { id: 1, environment: "production".into(), sha: "aaaaaaa".into(), creator: None, created_at: "2026-06-01T00:00:00Z".into() },
        RawDeployment { id: 2, environment: "production".into(), sha: "bbbbbbb".into(), creator: None, created_at: "2026-06-02T00:00:00Z".into() },
        RawDeployment { id: 3, environment: "preview".into(), sha: "ccccccc".into(), creator: None, created_at: "2026-06-01T00:00:00Z".into() },
    ];
    let kept = latest_per_environment(raw);
    assert_eq!(kept.len(), 2);
    let prod = kept.iter().find(|d| d.environment == "production").unwrap();
    assert_eq!(prod.id, 2, "should keep the newest production deployment");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant_lib beacon::tests::keeps_only_newest_deployment_per_environment`
Expected: FAIL — `RawDeployment` / `latest_per_environment` not found.

- [ ] **Step 3: Write the types, reducer, and fetch**

Add to `crates/app/src/beacon.rs` (above the `tests` module):

```rust
use serde::{Deserialize, Serialize};

/// One environment's current deployment state, as the UI consumes it.
#[derive(Debug, Clone, Serialize)]
pub struct EnvDeploy {
    pub environment: String,
    /// success | failure | in_progress | pending | error | inactive
    pub state: String,
    pub description: Option<String>,
    pub target_url: Option<String>,
    pub sha: String, // short (7)
    pub creator: Option<String>,
    pub updated_at: String,
}

/// Tagged so the frontend can switch on `kind`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BeaconState {
    NotAuthed,
    NoRepo,
    Ok { repo: String, envs: Vec<EnvDeploy> },
    Error { message: String },
}

/// Minimal shape we keep from the deployments list response.
#[derive(Debug, Clone)]
pub struct RawDeployment {
    pub id: u64,
    pub environment: String,
    pub sha: String,
    pub creator: Option<String>,
    pub created_at: String,
}

/// Keep only the newest deployment per environment (by `created_at`,
/// ISO-8601 sorts lexically), capped at 10 environments.
pub fn latest_per_environment(deployments: Vec<RawDeployment>) -> Vec<RawDeployment> {
    use std::collections::HashMap;
    let mut by_env: HashMap<String, RawDeployment> = HashMap::new();
    for d in deployments {
        match by_env.get(&d.environment) {
            Some(existing) if existing.created_at >= d.created_at => {}
            _ => {
                by_env.insert(d.environment.clone(), d);
            }
        }
    }
    let mut kept: Vec<RawDeployment> = by_env.into_values().collect();
    kept.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    kept.truncate(10);
    kept
}

// ── GitHub fetch ────────────────────────────────────────────────────

async fn gh_get(token: &str, url: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let resp = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "covenant-client")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("github request failed: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(match status {
            401 => "github: token invalid or expired — reconnect GitHub in Settings".into(),
            403 => "github: forbidden — rate-limited or missing repo permission".into(),
            404 => "github: repo not found — private repos need repo scope".into(),
            s => format!("github: HTTP {s}"),
        });
    }
    serde_json::from_str(&text).map_err(|e| format!("github: invalid JSON: {e}"))
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Resolve owner/repo from `cwd`'s `origin` remote, load the keychain
/// token, and build the per-environment deployment state.
pub async fn load_deployments(cwd: String) -> BeaconState {
    // 1. owner/repo from git remote.
    let remote = match std::process::Command::new("git")
        .args(["-C", &cwd, "remote", "get-url", "origin"])
        .output()
    {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => return BeaconState::NoRepo,
    };
    let (owner, repo) = match parse_owner_repo(&remote) {
        Some(v) => v,
        None => return BeaconState::NoRepo,
    };

    // 2. token.
    let token = match karl_score::auth::load_token_from_keychain() {
        Ok(Some(t)) => t,
        Ok(None) => return BeaconState::NotAuthed,
        Err(e) => return BeaconState::Error { message: format!("keychain: {e}") },
    };

    let api = "https://api.github.com";

    // 3. list deployments.
    let list_url = format!("{api}/repos/{owner}/{repo}/deployments?per_page=30");
    let list = match gh_get(&token, &list_url).await {
        Ok(v) => v,
        Err(e) => return BeaconState::Error { message: e },
    };
    let raw: Vec<RawDeployment> = list
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|d| {
                    Some(RawDeployment {
                        id: d.get("id")?.as_u64()?,
                        environment: d.get("environment")?.as_str().unwrap_or("").to_string(),
                        sha: short_sha(d.get("sha").and_then(|s| s.as_str()).unwrap_or("")),
                        creator: d
                            .get("creator")
                            .and_then(|c| c.get("login"))
                            .and_then(|l| l.as_str())
                            .map(|s| s.to_string()),
                        created_at: d.get("created_at").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let kept = latest_per_environment(raw);

    // 4. latest status per kept deployment.
    let mut envs = Vec::with_capacity(kept.len());
    for d in kept {
        let status_url = format!("{api}/repos/{owner}/{repo}/deployments/{}/statuses?per_page=1", d.id);
        let (state, description, target_url, updated_at) = match gh_get(&token, &status_url).await {
            Ok(v) => {
                let latest = v.as_array().and_then(|a| a.first()).cloned();
                match latest {
                    Some(s) => (
                        s.get("state").and_then(|x| x.as_str()).unwrap_or("pending").to_string(),
                        s.get("description").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string()),
                        s.get("environment_url")
                            .and_then(|x| x.as_str())
                            .or_else(|| s.get("target_url").and_then(|x| x.as_str()))
                            .filter(|x| !x.is_empty())
                            .map(|x| x.to_string()),
                        s.get("created_at").and_then(|x| x.as_str()).unwrap_or(&d.created_at).to_string(),
                    ),
                    None => ("pending".to_string(), None, None, d.created_at.clone()),
                }
            }
            Err(e) => return BeaconState::Error { message: e },
        };
        envs.push(EnvDeploy {
            environment: d.environment,
            state,
            description,
            target_url,
            sha: d.sha,
            creator: d.creator,
            updated_at,
        });
    }

    BeaconState::Ok { repo: format!("{owner}/{repo}"), envs }
}
```

If `karl_score::auth` is not the correct path, confirm with `grep -rn "pub fn load_token_from_keychain" crates/score/src` and match the crate name in `crates/score/Cargo.toml` (`karl-score` → `karl_score`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p covenant_lib beacon::tests`
Expected: PASS (both reducer + parser tests).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/beacon.rs
git commit -m "feat(beacon): deployment state types, reducer, github fetch"
```

---

## Task 3: Backend — Tauri command + registration

**Files:**
- Modify: `crates/app/src/lib.rs`

**Interfaces:**
- Consumes: `beacon::load_deployments` (Task 2).
- Produces: Tauri command `beacon_deployments(cwd: String) -> Result<beacon::BeaconState, String>`, callable from the frontend as `invoke("beacon_deployments", { cwd })`.

- [ ] **Step 1: Declare the module**

Near the other `mod` declarations at the top of `crates/app/src/lib.rs` (e.g. by `mod git_tools;` ~line 36), add:

```rust
mod beacon;
```

- [ ] **Step 2: Add the command**

Near the other `#[tauri::command]` git functions (e.g. after `git_changes` ~line 2259) in `crates/app/src/lib.rs`:

```rust
#[tauri::command]
async fn beacon_deployments(cwd: String) -> Result<beacon::BeaconState, String> {
    Ok(beacon::load_deployments(cwd).await)
}
```

- [ ] **Step 3: Register in the handler**

In the `tauri::generate_handler![ ... ]` list (~line 4199), add a line alongside the git commands:

```rust
            beacon_deployments,
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cargo build -p covenant_lib`
Expected: builds clean (warnings ok). If the package name differs, use the name from `crates/app/Cargo.toml`.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(beacon): expose beacon_deployments tauri command"
```

---

## Task 4: Frontend — api.ts wrapper + types

**Files:**
- Modify: `ui/src/api.ts`

**Interfaces:**
- Produces:
  - `export type BeaconEnv = { environment: string; state: string; description: string | null; target_url: string | null; sha: string; creator: string | null; updated_at: string }`
  - `export type BeaconState = { kind: "not_authed" } | { kind: "no_repo" } | { kind: "ok"; repo: string; envs: BeaconEnv[] } | { kind: "error"; message: string }`
  - `export async function beaconDeployments(cwd: string): Promise<BeaconState>`

- [ ] **Step 1: Add types + wrapper**

Near the other git wrappers (e.g. after `gitChanges` ~line 1280) in `ui/src/api.ts`:

```ts
export type BeaconEnv = {
  environment: string;
  state: string; // success | failure | in_progress | pending | error | inactive
  description: string | null;
  target_url: string | null;
  sha: string;
  creator: string | null;
  updated_at: string;
};

export type BeaconState =
  | { kind: "not_authed" }
  | { kind: "no_repo" }
  | { kind: "ok"; repo: string; envs: BeaconEnv[] }
  | { kind: "error"; message: string };

export async function beaconDeployments(cwd: string): Promise<BeaconState> {
  return invoke<BeaconState>("beacon_deployments", { cwd });
}
```

(The serde tag is `kind` with snake_case variants — matches the Rust `#[serde(tag = "kind", rename_all = "snake_case")]`.)

- [ ] **Step 2: Typecheck**

Run (from repo root): `npx tsc -p ui --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(beacon): api wrapper + types"
```

---

## Task 5: Frontend — panel render (states) with tests

**Files:**
- Create: `ui/src/beacon/panel.ts`
- Create: `ui/src/beacon/panel.test.ts`

**Interfaces:**
- Consumes: `BeaconState`, `BeaconEnv`, `beaconDeployments` (Task 4).
- Produces:
  - `export function stateDotColor(state: string): string` — returns a CSS class suffix: `ok | busy | bad | idle`.
  - `export function renderBeacon(root: HTMLElement, state: BeaconState): void` — pure render of a given state into `root` (no fetching, no polling). Testable.
  - `export class BeaconPanel` — constructor `(host: HTMLElement, opts: { getCwd: () => string | null; onClose: () => void })`, methods `render()` (fetch + poll start) and `close()` (poll stop + clear).

This task builds the pure render + the dot-color map (both unit-tested) and the panel class (poll loop, not unit-tested — exercised via the in-app verification step).

- [ ] **Step 1: Write the failing tests**

Create `ui/src/beacon/panel.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { renderBeacon, stateDotColor } from "./panel";
import type { BeaconState } from "../api";

describe("stateDotColor", () => {
  it("maps deployment states to color classes", () => {
    expect(stateDotColor("success")).toBe("ok");
    expect(stateDotColor("in_progress")).toBe("busy");
    expect(stateDotColor("pending")).toBe("busy");
    expect(stateDotColor("failure")).toBe("bad");
    expect(stateDotColor("error")).toBe("bad");
    expect(stateDotColor("inactive")).toBe("idle");
    expect(stateDotColor("anything-else")).toBe("idle");
  });
});

describe("renderBeacon", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
  });

  it("renders sign-in prompt when not authed", () => {
    renderBeacon(root, { kind: "not_authed" });
    expect(root.textContent).toContain("Sign in with GitHub");
  });

  it("renders no-repo notice", () => {
    renderBeacon(root, { kind: "no_repo" });
    expect(root.textContent).toContain("No GitHub remote");
  });

  it("renders empty state when no deployments", () => {
    renderBeacon(root, { kind: "ok", repo: "o/r", envs: [] });
    expect(root.textContent).toContain("No deployments");
  });

  it("renders error message", () => {
    renderBeacon(root, { kind: "error", message: "boom" });
    expect(root.textContent).toContain("boom");
  });

  it("renders one card per environment with a state dot", () => {
    renderBeacon(root, {
      kind: "ok",
      repo: "o/r",
      envs: [
        { environment: "production", state: "success", description: null, target_url: "https://x", sha: "abc1234", creator: "karluiz", updated_at: "2026-06-26T00:00:00Z" },
        { environment: "preview", state: "in_progress", description: null, target_url: null, sha: "def5678", creator: null, updated_at: "2026-06-26T00:00:00Z" },
      ],
    });
    const cards = root.querySelectorAll(".beacon-env");
    expect(cards.length).toBe(2);
    expect(root.querySelector(".beacon-dot.ok")).not.toBeNull();
    expect(root.querySelector(".beacon-dot.busy")).not.toBeNull();
    expect(root.textContent).toContain("production");
    expect(root.textContent).toContain("abc1234");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from repo root): `npx vitest run ui/src/beacon/panel.test.ts`
Expected: FAIL — cannot import `./panel`.

- [ ] **Step 3: Write the panel**

Create `ui/src/beacon/panel.ts`:

```ts
import { beaconDeployments, type BeaconState } from "../api";

const POLL_MS = 25_000;

/// Map a GitHub deployment state to a dot color class suffix.
export function stateDotColor(state: string): string {
  switch (state) {
    case "success":
      return "ok";
    case "in_progress":
    case "pending":
      return "busy";
    case "failure":
    case "error":
      return "bad";
    default:
      return "idle"; // inactive + unknown
  }
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function notice(text: string, cls = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = `beacon-notice ${cls}`.trim();
  el.textContent = text;
  return el;
}

/// Pure render of a state into `root`. No fetching, no polling.
export function renderBeacon(root: HTMLElement, state: BeaconState): void {
  root.replaceChildren();
  switch (state.kind) {
    case "not_authed":
      root.appendChild(notice("Sign in with GitHub to see deployments."));
      return;
    case "no_repo":
      root.appendChild(notice("No GitHub remote in this folder."));
      return;
    case "error":
      root.appendChild(notice(state.message, "beacon-error"));
      return;
    case "ok": {
      if (state.envs.length === 0) {
        root.appendChild(notice(`No deployments in ${state.repo}.`));
        return;
      }
      for (const env of state.envs) {
        const card = document.createElement(env.target_url ? "a" : "div");
        card.className = "beacon-env";
        if (env.target_url && card instanceof HTMLAnchorElement) {
          card.href = env.target_url;
          card.target = "_blank";
          card.rel = "noopener noreferrer";
        }

        const head = document.createElement("div");
        head.className = "beacon-env-head";
        const dot = document.createElement("span");
        dot.className = `beacon-dot ${stateDotColor(env.state)}`;
        const name = document.createElement("span");
        name.className = "beacon-env-name";
        name.textContent = env.environment || "(default)";
        const when = document.createElement("span");
        when.className = "beacon-env-when";
        when.textContent = relTime(env.updated_at);
        head.append(dot, name, when);

        const meta = document.createElement("div");
        meta.className = "beacon-env-meta";
        const bits = [env.state, env.sha, env.creator].filter(Boolean) as string[];
        meta.textContent = bits.join(" · ");

        card.append(head, meta);
        if (env.description) {
          const desc = document.createElement("div");
          desc.className = "beacon-env-desc";
          desc.textContent = env.description;
          card.appendChild(desc);
        }
        root.appendChild(card);
      }
      return;
    }
  }
}

export class BeaconPanel {
  private root: HTMLElement;
  private timer: number | null = null;
  private generation = 0;

  constructor(
    host: HTMLElement,
    private opts: { getCwd: () => string | null; onClose: () => void },
  ) {
    this.root = document.createElement("div");
    this.root.className = "beacon-root";

    const header = document.createElement("div");
    header.className = "beacon-header";
    const title = document.createElement("span");
    title.className = "beacon-title";
    title.textContent = "Beacon";
    const refresh = document.createElement("button");
    refresh.className = "beacon-refresh";
    refresh.textContent = "↻";
    refresh.addEventListener("click", () => void this.fetch());
    const close = document.createElement("button");
    close.className = "beacon-close";
    close.textContent = "✕";
    close.addEventListener("click", () => this.opts.onClose());
    header.append(title, refresh, close);

    this.body = document.createElement("div");
    this.body.className = "beacon-body";

    host.replaceChildren(header, this.body);
  }

  private body: HTMLElement;

  /// Fetch once and (re)start the visible-only poll loop.
  render(): void {
    void this.fetch();
    this.stopTimer();
    this.timer = window.setInterval(() => void this.fetch(), POLL_MS);
  }

  private async fetch(): Promise<void> {
    const gen = ++this.generation;
    const cwd = this.opts.getCwd();
    if (!cwd) {
      renderBeacon(this.body, { kind: "no_repo" });
      return;
    }
    try {
      const state = await beaconDeployments(cwd);
      if (gen !== this.generation) return; // superseded
      renderBeacon(this.body, state);
    } catch (e) {
      if (gen !== this.generation) return;
      renderBeacon(this.body, { kind: "error", message: String(e) });
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /// Stop polling. Called when the panel is hidden.
  close(): void {
    this.stopTimer();
    this.generation++; // drop any in-flight fetch
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from repo root): `npx vitest run ui/src/beacon/panel.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add ui/src/beacon/panel.ts ui/src/beacon/panel.test.ts
git commit -m "feat(beacon): panel render + poll loop with tests"
```

---

## Task 6: Frontend — styles

**Files:**
- Create: `ui/src/beacon/beacon.css`

- [ ] **Step 1: Write the stylesheet**

Create `ui/src/beacon/beacon.css`:

```css
.beacon-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-panel);
  color: var(--text-primary);
  font-size: 12px;
}
.beacon-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
}
.beacon-title {
  flex: 1;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.beacon-refresh,
.beacon-close {
  background: transparent;
  border: none;
  color: var(--text-secondary, var(--text-primary));
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
}
.beacon-refresh:hover,
.beacon-close:hover {
  color: var(--text-primary);
}
.beacon-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.beacon-notice {
  color: var(--text-secondary, var(--text-primary));
  padding: 12px 6px;
  text-align: center;
}
.beacon-notice.beacon-error {
  color: var(--danger, #e5534b);
  text-align: left;
}
.beacon-env {
  display: block;
  text-decoration: none;
  color: inherit;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--bg-elevated, var(--bg-panel));
}
a.beacon-env:hover {
  border-color: var(--text-primary);
}
.beacon-env-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.beacon-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.beacon-dot.ok { background: #2ea043; }
.beacon-dot.busy { background: #d29922; }
.beacon-dot.bad { background: #e5534b; }
.beacon-dot.idle { background: var(--text-secondary, #8b949e); }
.beacon-env-name {
  flex: 1;
  font-weight: 600;
}
.beacon-env-when {
  color: var(--text-secondary, #8b949e);
  font-size: 11px;
}
.beacon-env-meta {
  color: var(--text-secondary, #8b949e);
  margin-top: 4px;
  font-size: 11px;
}
.beacon-env-desc {
  margin-top: 4px;
  color: var(--text-primary);
}
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/beacon/beacon.css
git commit -m "feat(beacon): panel styles"
```

---

## Task 7: Frontend — rail wiring (RailTarget, html, main.ts, layout css)

**Files:**
- Modify: `ui/src/titlebar/right-rail.ts`
- Modify: `ui/index.html`
- Modify: `ui/src/main.ts`
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes: `BeaconPanel` (Task 5), `manager.activeCwd()`.
- Produces: a `"beacon"` rail target the user can toggle from a titlebar button.

- [ ] **Step 1: Extend RailTarget**

In `ui/src/titlebar/right-rail.ts`, add `"beacon"` to the union:

```ts
export type RailTarget =
  | "blocks"
  | "structure"
  | "activity"
  | "recall"
  | "notes"
  | "cdlc"
  | "teammate"
  | "tasker"
  | "resources"
  | "beacon";
```

- [ ] **Step 2: Add the button + panel host to index.html**

In `ui/index.html`, add a rail button next to `#titlebar-tasker` (~line 127), mirroring its markup:

```html
        <button
          id="titlebar-beacon"
          class="titlebar-view-btn"
          aria-label="Beacon — deployments"
        ></button>
```

And add the panel host next to `#tasker-panel` (~line 195):

```html
      <aside id="beacon-panel" class="hidden"></aside>
```

(Give the button an icon consistent with the others — copy the `<svg>`/icon approach the sibling buttons use; a satellite/radio-tower or signal glyph fits "Beacon".)

- [ ] **Step 3: Wire main.ts**

In `ui/src/main.ts`:

(a) Import the css and panel near the other panel imports (~line 11, 58):

```ts
import "./beacon/beacon.css";
import { BeaconPanel } from "./beacon/panel";
```

(b) Add the button lookup near `taskerBtn` (~line 525):

```ts
  const beaconBtn = document.getElementById("titlebar-beacon");
```

(c) Add to the `railButtons` record (~line 535):

```ts
    beacon: beaconBtn,
```

(d) Add an `openRail` case (~line 579, alongside `tasker`):

```ts
      case "beacon":
        openBeaconPanel();
        break;
```

(e) Add a `closeRail` case (~line 596):

```ts
      case "beacon":
        closeBeaconPanel();
        break;
```

(f) Add the panel host + open/close helpers near the Tasker block (~line 808):

```ts
  // Beacon sidebar — GitHub deployment status for the active repo.
  const beaconPanelHost = requireEl<HTMLElement>("beacon-panel");
  const beaconPanel = new BeaconPanel(beaconPanelHost, {
    getCwd: () => manager.activeCwd(),
    onClose: () => rail.toggle("beacon"),
  });
  const closeBeaconPanel = (): void => {
    if (!document.body.classList.contains("sidebar-view-beacon")) return;
    document.body.classList.remove("sidebar-view-beacon");
    beaconPanelHost.classList.add("hidden");
    beaconPanel.close();
  };
  const openBeaconPanel = (): void => {
    document.body.classList.add("sidebar-view-beacon");
    beaconPanelHost.classList.remove("hidden");
    beaconPanel.render();
  };
```

(g) Add the click handler near the other button listeners (~line 799–804):

```ts
  beaconBtn?.addEventListener("click", () => rail.toggle("beacon"));
```

- [ ] **Step 4: Add the layout css**

In `ui/src/styles.css`, add a `sidebar-view-beacon` block mirroring the `sidebar-view-tasker` rules (~line 3404). Find every selector group containing `sidebar-view-tasker` and add a parallel `sidebar-view-beacon` selector so the right sidebar reserves `--right-sidebar-w` and insets full-screen pages the same way. Minimum, alongside the tasker layout rules:

```css
body.tabbar-left.sidebar-view-beacon #layout:has(> #settings-page:not([hidden])),
body.tabbar-left.sidebar-view-beacon #layout:has(> #docs-page:not([hidden])),
body.tabbar-left.sidebar-view-beacon #layout:has(> #drafts-page:not([hidden])),
body.tabbar-left.sidebar-view-beacon #layout:has(> #mission-page:not([hidden])),
body.tabbar-left.sidebar-view-beacon #layout:has(> #operator-page:not([hidden])),
body.tabbar-left.sidebar-view-beacon #layout:has(> #capabilities-page:not([hidden])) {
  /* copy the exact declarations from the sibling sidebar-view-tasker rule */
}
```

Also confirm the base grid rule that gives the sidebar its width applies when `#beacon-panel` is visible (the `:not(.hidden)` aside takes the `--right-sidebar-w` column). If the existing grid keys off a body class, add `sidebar-view-beacon` to that selector list too.

- [ ] **Step 5: Typecheck + build the frontend**

Run (from repo root):
- `npx tsc -p ui --noEmit` → no new errors.
- `npm run build` (or `cd ui && npm run build`) → builds clean.

- [ ] **Step 6: Run the full frontend test suite**

Run (from repo root): `npx vitest run`
Expected: Beacon tests pass; no previously-passing tests break.

- [ ] **Step 7: Commit**

```bash
git add ui/src/titlebar/right-rail.ts ui/index.html ui/src/main.ts ui/src/styles.css
git commit -m "feat(beacon): rail button + panel wiring"
```

---

## Task 8: In-app verification

**Files:** none (manual verification).

- [ ] **Step 1: Run the app**

Use the `respawn` skill (or `npm run tauri:dev`) to launch Covenant.

- [ ] **Step 2: Verify each state**

- Open a tab in a GitHub repo you own that has deployments (e.g. a Vercel/Netlify-connected repo) → click the Beacon rail button → env cards render with colored dots, sha, creator, relative time; clicking a card opens the live URL.
- Open a tab in a non-GitHub folder (e.g. `/tmp`) → "No GitHub remote".
- Sign out of GitHub (or test with no keychain token) → "Sign in with GitHub".
- Open a GitHub repo with zero deployments → "No deployments".
- Leave the panel open during an active deploy → state flips within ~25s without manual refresh; close the panel → polling stops (confirm no further `beacon_deployments` calls in logs).

- [ ] **Step 3: Confirm and note results**

Record what was verified vs. still pending in the commit message or PR description. Do not claim states you did not actually exercise.

---

## Self-Review Notes

- **Spec coverage:** data source = Deployments API (Task 2 `load_deployments`); poll-while-open 25s (Task 5 `BeaconPanel`); latest-per-env cap 10 (Task 2 `latest_per_environment`); all five UI states (Task 5 tests + render); rail wiring like siblings (Task 7); backend parser + color tests (Tasks 1, 5). All covered.
- **Type consistency:** `BeaconState`/`EnvDeploy` serde tag `kind`/snake_case (Task 2) ↔ TS union on `kind` (Task 4) ↔ render switch (Task 5). `latest_per_environment`, `parse_owner_repo`, `load_deployments`, `stateDotColor`, `renderBeacon`, `BeaconPanel` names consistent across tasks.
- **Deviation from spec:** spec said "reuse `gh_request`"; that helper is private to the operator tool layer and returns `ToolError`, so Task 2 uses a self-contained `gh_get` (~20 lines, same headers/bearer/error mapping) to avoid coupling Beacon to operator plumbing. Net simpler.
