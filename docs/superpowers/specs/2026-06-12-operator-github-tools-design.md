# Operator GitHub Tools — Design

**Date:** 2026-06-12
**Status:** Approved
**Branch:** `worktree-operator-github-tools`

## Goal

Operators (the LLM agents behind the teammate panel / Telegram) get read/write
access to the user's GitHub account — list/read issues and PRs, create issues,
comment, open PRs — on the repos the user manages, using the GitHub token
Covenant already stores from sign-in.

## Decisions (made with Karluiz)

1. **Permission model:** re-auth via the existing OAuth Device Flow, adding
   `scope=repo`. Coarse scope accepted; GitHub App / fine-grained PAT deferred.
2. **Tool surface v0:** issues **and** PRs (read + write).
3. **Write gating:** no per-action confirmation. A per-operator setting
   `github_access: Off | ReadOnly | ReadWrite` (default `Off`) controls which
   tools the operator is given.

## Architecture

### 1. Token scope (re-auth)

- `crates/score/src/auth.rs` — `start_device_flow()` adds `("scope", "repo")`
  to the device-code form (currently sends only `client_id`, which yields a
  public-read-only token).
- `DeviceTokenResponse::Success.scope` (currently discarded) is persisted at
  sign-in so the app knows whether the stored token carries `repo`.
  Storage: a second Keychain entry (`github-token-scope`) following the
  existing `covenant-jwt` pattern in `crates/score/src/auth.rs`, written by
  the auth command path in `crates/app/src/score_auth_commands.rs` and
  cleared on sign-out.
- Settings UI: when signed in but stored scope lacks `repo`, show an English
  CTA — "Re-connect GitHub to enable repo access for operators" — that runs
  sign-out + sign-in (one device-flow round trip).

### 2. Per-operator access level

- `crates/app/src/operator_registry.rs` — `Operator` gains:

  ```rust
  #[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
  pub enum GithubAccess {
      #[default]
      Off,
      ReadOnly,
      ReadWrite,
  }

  pub struct Operator {
      // ...
      #[serde(default)]
      pub github_access: GithubAccess,
  }
  ```

  `#[serde(default)]` means existing persisted operators deserialize to `Off`.
- Immersive Operator Creator (UI): a 3-state control (Off / Read-only /
  Read-write) in the controls rail; persisted through the existing operator
  update command. All copy in English.

### 3. GitHub tools — new module `crates/app/src/teammate/github_tools.rs`

Follows the existing `tools.rs` pattern (args struct + handler + tool-def fn),
but handlers are `async` (reqwest HTTP) — the dispatch loop in
`teammate/llm.rs` is already async, so this composes.

**Read tools** (registered for `ReadOnly` and `ReadWrite`):

| Tool | Endpoint | Notes |
|---|---|---|
| `gh_list_repos` | `GET /user/repos?sort=pushed` | capped (default 30) |
| `gh_list_issues` | `GET /repos/{owner}/{repo}/issues` | state filter; PRs filtered out of issue listings |
| `gh_get_issue` | `GET /repos/{owner}/{repo}/issues/{n}` | body truncated; includes recent comments (capped) |
| `gh_list_prs` | `GET /repos/{owner}/{repo}/pulls` | state filter |
| `gh_get_pr` | `GET /repos/{owner}/{repo}/pulls/{n}` (+ `/files`) | summarized file list, capped patch excerpts |

**Write tools** (registered only for `ReadWrite`):

| Tool | Endpoint | Notes |
|---|---|---|
| `gh_create_issue` | `POST /repos/{owner}/{repo}/issues` | title + body |
| `gh_comment` | `POST /repos/{owner}/{repo}/issues/{n}/comments` | works for issues and PRs (same endpoint) |
| `gh_create_pr` | `POST /repos/{owner}/{repo}/pulls` | title/body/head/base |
| `gh_update_issue_state` | `PATCH /repos/{owner}/{repo}/issues/{n}` | `state` only (close/reopen) — no label/assignee mutation in v0 |

**Client details:**

- `reqwest` to `https://api.github.com` with `Accept:
  application/vnd.github+json`, `User-Agent: covenant-client`, bearer token.
- Responses are normalized into compact JSON (selected fields only) and
  capped: list lengths bounded, bodies truncated with an explicit
  `"(truncated)"` marker — keeps LLM token budget bounded.
- Errors mapped to tool errors the LLM can act on: `401` → "GitHub token
  invalid — ask the user to re-connect GitHub", `403` with rate-limit headers
  → "GitHub rate limit hit, retry later", `404` → repo/issue not found.

### 4. Plumbing

- `ToolEnv` (`teammate/tools.rs`) gains
  `pub github: Option<GithubCtx>` where
  `GithubCtx { token: String, access: GithubAccess }`.
- At dispatch time (`teammate/llm.rs` callers in `runtime.rs` /
  `commands.rs`): if the operator's `github_access != Off`, load the token
  from the Keychain (`crates/score` helpers) and attach it; otherwise leave
  `None`.
- **Conditional registration, not runtime refusal:** the tool-definition list
  sent to the LLM includes GitHub tools according to access level. `Off`
  operators never see them; `ReadOnly` operators never see write tools. Both
  dispatch paths get this (Anthropic `llm.rs:~516` and OpenAI-compat
  `llm.rs:~732`).
- System-prompt tool docs (`llm.rs:~194` block) gain a short section
  describing the GitHub tools, included only when they are registered.

### 5. Safety

- No generic `github_api` tool — only the specific endpoints above. No
  DELETE, no repo-settings mutation, no merges, no force operations.
- The token never appears in tool results, logs, or LLM-visible text (it is
  injected only into the Authorization header).
- The existing 12-iteration cap per dispatch bounds GitHub call volume; no
  separate rate limiter in v0.
- Tools never write to the PTY; the existing PTY safety blocklist is
  untouched.

## Error handling

- Missing token / scope mismatch at dispatch time → tools simply not
  registered (operator behaves as `Off`); a `tracing` warn records why.
- Network failures surface as tool errors (`CommandFailed`-style) so the LLM
  can report them instead of hallucinating success.

## Testing

- `github_tools` unit tests with `mockito` (already a dev-dep pattern in
  `crates/score/tests/auth.rs`): happy path + 401/403/404 mapping +
  truncation behavior, per tool.
- Serde test: legacy `Operator` JSON without `github_access` deserializes to
  `Off`.
- Gating tests: tool-definition list for `Off` / `ReadOnly` / `ReadWrite`
  contains exactly the expected names, on both dispatch paths.
- Auth test: device-flow form includes `scope=repo`; token-response `scope`
  is persisted.

## Out of scope (v0)

- PR reviews, merging, labels/assignees, milestones.
- GitHub App installation flow or fine-grained PATs.
- Per-action write confirmation.
- Org-level operations beyond what `repo` scope grants on the user's repos.
