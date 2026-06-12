//! GitHub tools for operators (`gh_*`). Specific endpoints only — by
//! design there is NO generic "call any GitHub API" tool. Read tools
//! are registered for ReadOnly+; write tools for ReadWrite only, and
//! handlers re-check access as defense in depth.

use serde::Deserialize;
use serde_json::Value;

use super::tools::{GithubCtx, ToolEnv, ToolError};
use crate::operator_registry::GithubAccess;

const MAX_LIST_ITEMS: usize = 30;
const MAX_BODY_CHARS: usize = 2000;
const MAX_COMMENTS: usize = 10;
const MAX_PR_FILES: usize = 50;
const MAX_PATCH_CHARS: usize = 400;

// ── helpers ─────────────────────────────────────────────────────────

fn parse_args<T: for<'de> Deserialize<'de>>(args: &Value) -> Result<T, ToolError> {
    serde_json::from_value(args.clone()).map_err(|e| ToolError::InvalidArgs(e.to_string()))
}

fn ctx(env: &ToolEnv) -> Result<&GithubCtx, ToolError> {
    env.github
        .as_ref()
        .ok_or_else(|| ToolError::CommandFailed("GitHub access is not enabled for this operator".into()))
}

fn require_write(c: &GithubCtx) -> Result<(), ToolError> {
    if c.access == GithubAccess::ReadWrite {
        Ok(())
    } else {
        Err(ToolError::CommandFailed(
            "this operator has read-only GitHub access; write operations are disabled".into(),
        ))
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}… (truncated)")
    }
}

fn map_github_error(status: u16, body: &str) -> ToolError {
    match status {
        401 => ToolError::CommandFailed(
            "github: token invalid or expired — ask the user to re-connect GitHub in Settings".into(),
        ),
        403 => ToolError::CommandFailed(
            "github: forbidden or rate-limited — wait and retry, or ask the user to re-connect \
             GitHub so the token carries repo scope"
                .into(),
        ),
        404 => ToolError::CommandFailed(
            "github: not found — check owner/repo/number; private repos need repo scope (re-connect GitHub)".into(),
        ),
        s => ToolError::CommandFailed(format!("github: HTTP {s}: {}", truncate(body, 300))),
    }
}

async fn gh_request(
    c: &GithubCtx,
    method: reqwest::Method,
    path_and_query: &str,
    body: Option<Value>,
) -> Result<Value, ToolError> {
    let url = format!("{}{}", c.api_base.trim_end_matches('/'), path_and_query);
    let client = reqwest::Client::new();
    let mut req = client
        .request(method, &url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "covenant-client")
        .bearer_auth(&c.token);
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| ToolError::CommandFailed(format!("github request failed: {e}")))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(map_github_error(status, &text));
    }
    serde_json::from_str(&text)
        .map_err(|e| ToolError::CommandFailed(format!("github: invalid JSON in response: {e}")))
}

fn render(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| "{}".into())
}

// ── read tools ──────────────────────────────────────────────────────

pub async fn gh_list_repos(env: &ToolEnv, _args: &Value) -> Result<String, ToolError> {
    let c = ctx(env)?;
    let v = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/user/repos?sort=pushed&per_page={MAX_LIST_ITEMS}"),
        None,
    )
    .await?;
    let items: Vec<Value> = v
        .as_array()
        .map(|a| {
            a.iter()
                .take(MAX_LIST_ITEMS)
                .map(|r| {
                    serde_json::json!({
                        "full_name": r["full_name"],
                        "private": r["private"],
                        "default_branch": r["default_branch"],
                        "open_issues": r["open_issues_count"],
                        "pushed_at": r["pushed_at"],
                        "description": truncate(r["description"].as_str().unwrap_or(""), 120),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(render(&Value::Array(items)))
}

#[derive(Debug, Deserialize)]
struct RepoArgs {
    owner: String,
    repo: String,
    #[serde(default)]
    state: Option<String>,
}

fn issue_summary(r: &Value) -> Value {
    serde_json::json!({
        "number": r["number"],
        "title": r["title"],
        "state": r["state"],
        "author": r["user"]["login"],
        "comments": r["comments"],
        "updated_at": r["updated_at"],
        "labels": r["labels"].as_array().map(|ls| ls.iter().map(|l| l["name"].clone()).collect::<Vec<_>>()).unwrap_or_default(),
    })
}

pub async fn gh_list_issues(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: RepoArgs = parse_args(args)?;
    let state = a.state.as_deref().unwrap_or("open");
    let c = ctx(env)?;
    let v = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/repos/{}/{}/issues?state={state}&per_page={MAX_LIST_ITEMS}", a.owner, a.repo),
        None,
    )
    .await?;
    let items: Vec<Value> = v
        .as_array()
        .map(|arr| {
            arr.iter()
                // The issues endpoint returns PRs too; a PR carries `pull_request`.
                .filter(|r| r.get("pull_request").is_none())
                .take(MAX_LIST_ITEMS)
                .map(issue_summary)
                .collect()
        })
        .unwrap_or_default();
    Ok(render(&Value::Array(items)))
}

#[derive(Debug, Deserialize)]
struct NumberArgs {
    owner: String,
    repo: String,
    number: u64,
}

pub async fn gh_get_issue(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: NumberArgs = parse_args(args)?;
    let c = ctx(env)?;
    let issue = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/repos/{}/{}/issues/{}", a.owner, a.repo, a.number),
        None,
    )
    .await?;
    let comments = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/repos/{}/{}/issues/{}/comments?per_page={MAX_COMMENTS}", a.owner, a.repo, a.number),
        None,
    )
    .await
    .unwrap_or(Value::Array(vec![]));
    let mut out = issue_summary(&issue);
    out["body"] = Value::String(truncate(issue["body"].as_str().unwrap_or(""), MAX_BODY_CHARS));
    out["recent_comments"] = Value::Array(
        comments
            .as_array()
            .map(|arr| {
                arr.iter()
                    .take(MAX_COMMENTS)
                    .map(|cm| {
                        serde_json::json!({
                            "author": cm["user"]["login"],
                            "created_at": cm["created_at"],
                            "body": truncate(cm["body"].as_str().unwrap_or(""), 500),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    );
    Ok(render(&out))
}

pub async fn gh_list_prs(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: RepoArgs = parse_args(args)?;
    let state = a.state.as_deref().unwrap_or("open");
    let c = ctx(env)?;
    let v = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/repos/{}/{}/pulls?state={state}&per_page={MAX_LIST_ITEMS}", a.owner, a.repo),
        None,
    )
    .await?;
    let items: Vec<Value> = v
        .as_array()
        .map(|arr| {
            arr.iter()
                .take(MAX_LIST_ITEMS)
                .map(|r| {
                    serde_json::json!({
                        "number": r["number"],
                        "title": r["title"],
                        "state": r["state"],
                        "author": r["user"]["login"],
                        "head": r["head"]["ref"],
                        "base": r["base"]["ref"],
                        "draft": r["draft"],
                        "updated_at": r["updated_at"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(render(&Value::Array(items)))
}

pub async fn gh_get_pr(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: NumberArgs = parse_args(args)?;
    let c = ctx(env)?;
    let pr = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/repos/{}/{}/pulls/{}", a.owner, a.repo, a.number),
        None,
    )
    .await?;
    let files = gh_request(
        c,
        reqwest::Method::GET,
        &format!("/repos/{}/{}/pulls/{}/files?per_page={MAX_PR_FILES}", a.owner, a.repo, a.number),
        None,
    )
    .await
    .unwrap_or(Value::Array(vec![]));
    let out = serde_json::json!({
        "number": pr["number"],
        "title": pr["title"],
        "state": pr["state"],
        "author": pr["user"]["login"],
        "head": pr["head"]["ref"],
        "base": pr["base"]["ref"],
        "draft": pr["draft"],
        "mergeable": pr["mergeable"],
        "additions": pr["additions"],
        "deletions": pr["deletions"],
        "changed_files": pr["changed_files"],
        "body": truncate(pr["body"].as_str().unwrap_or(""), MAX_BODY_CHARS),
        "files": files.as_array().map(|arr| arr.iter().take(MAX_PR_FILES).map(|f| serde_json::json!({
            "filename": f["filename"],
            "status": f["status"],
            "additions": f["additions"],
            "deletions": f["deletions"],
            "patch_excerpt": truncate(f["patch"].as_str().unwrap_or(""), MAX_PATCH_CHARS),
        })).collect::<Vec<_>>()).unwrap_or_default(),
    });
    Ok(render(&out))
}

// ── write tools ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct CreateIssueArgs {
    owner: String,
    repo: String,
    title: String,
    #[serde(default)]
    body: Option<String>,
}

pub async fn gh_create_issue(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: CreateIssueArgs = parse_args(args)?;
    let c = ctx(env)?;
    require_write(c)?;
    let v = gh_request(
        c,
        reqwest::Method::POST,
        &format!("/repos/{}/{}/issues", a.owner, a.repo),
        Some(serde_json::json!({"title": a.title, "body": a.body.unwrap_or_default()})),
    )
    .await?;
    Ok(render(&serde_json::json!({
        "created": true,
        "number": v["number"],
        "url": v["html_url"],
    })))
}

#[derive(Debug, Deserialize)]
struct CommentArgs {
    owner: String,
    repo: String,
    number: u64,
    body: String,
}

pub async fn gh_comment(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: CommentArgs = parse_args(args)?;
    let c = ctx(env)?;
    require_write(c)?;
    let v = gh_request(
        c,
        reqwest::Method::POST,
        &format!("/repos/{}/{}/issues/{}/comments", a.owner, a.repo, a.number),
        Some(serde_json::json!({"body": a.body})),
    )
    .await?;
    Ok(render(&serde_json::json!({"created": true, "url": v["html_url"]})))
}

#[derive(Debug, Deserialize)]
struct CreatePrArgs {
    owner: String,
    repo: String,
    title: String,
    head: String,
    base: String,
    #[serde(default)]
    body: Option<String>,
}

pub async fn gh_create_pr(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: CreatePrArgs = parse_args(args)?;
    let c = ctx(env)?;
    require_write(c)?;
    let v = gh_request(
        c,
        reqwest::Method::POST,
        &format!("/repos/{}/{}/pulls", a.owner, a.repo),
        Some(serde_json::json!({
            "title": a.title, "head": a.head, "base": a.base,
            "body": a.body.unwrap_or_default(),
        })),
    )
    .await?;
    Ok(render(&serde_json::json!({
        "created": true,
        "number": v["number"],
        "url": v["html_url"],
    })))
}

#[derive(Debug, Deserialize)]
struct UpdateIssueStateArgs {
    owner: String,
    repo: String,
    number: u64,
    /// "open" or "closed"
    state: String,
}

pub async fn gh_update_issue_state(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let a: UpdateIssueStateArgs = parse_args(args)?;
    if a.state != "open" && a.state != "closed" {
        return Err(ToolError::InvalidArgs("state must be 'open' or 'closed'".into()));
    }
    let c = ctx(env)?;
    require_write(c)?;
    let v = gh_request(
        c,
        reqwest::Method::PATCH,
        &format!("/repos/{}/{}/issues/{}", a.owner, a.repo, a.number),
        Some(serde_json::json!({"state": a.state})),
    )
    .await?;
    Ok(render(&serde_json::json!({
        "number": v["number"],
        "state": v["state"],
        "url": v["html_url"],
    })))
}

// ── tool definitions ────────────────────────────────────────────────

fn read_defs() -> Vec<Value> {
    vec![
        serde_json::json!({
            "name": "gh_list_repos",
            "description": "List the user's GitHub repositories (most recently pushed first). \
                            Use to discover owner/repo names before other gh_ tools.",
            "input_schema": {
                "type": "object",
                "additionalProperties": false,
                "properties": {}
            }
        }),
        serde_json::json!({
            "name": "gh_list_issues",
            "description": "List issues in a GitHub repository (PRs excluded).",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo"],
                "additionalProperties": false,
                "properties": {
                    "owner": { "type": "string", "description": "Repository owner (user or org)." },
                    "repo": { "type": "string", "description": "Repository name." },
                    "state": {
                        "type": "string",
                        "enum": ["open", "closed", "all"],
                        "description": "Issue state filter. Default: open."
                    }
                }
            }
        }),
        serde_json::json!({
            "name": "gh_get_issue",
            "description": "Read one issue: title, state, body (truncated) and recent comments.",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo", "number"],
                "additionalProperties": false,
                "properties": {
                    "owner": { "type": "string", "description": "Repository owner (user or org)." },
                    "repo": { "type": "string", "description": "Repository name." },
                    "number": { "type": "integer", "description": "Issue number." }
                }
            }
        }),
        serde_json::json!({
            "name": "gh_list_prs",
            "description": "List pull requests in a GitHub repository.",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo"],
                "additionalProperties": false,
                "properties": {
                    "owner": { "type": "string", "description": "Repository owner (user or org)." },
                    "repo": { "type": "string", "description": "Repository name." },
                    "state": {
                        "type": "string",
                        "enum": ["open", "closed", "all"],
                        "description": "PR state filter. Default: open."
                    }
                }
            }
        }),
        serde_json::json!({
            "name": "gh_get_pr",
            "description": "Read one pull request: metadata, body (truncated), changed files with patch excerpts.",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo", "number"],
                "additionalProperties": false,
                "properties": {
                    "owner": { "type": "string", "description": "Repository owner (user or org)." },
                    "repo": { "type": "string", "description": "Repository name." },
                    "number": { "type": "integer", "description": "Pull request number." }
                }
            }
        }),
    ]
}

fn write_defs() -> Vec<Value> {
    vec![
        serde_json::json!({
            "name": "gh_create_issue",
            "description": "Create a GitHub issue. Returns its number and URL.",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo", "title"],
                "additionalProperties": false,
                "properties": {
                    "owner": { "type": "string", "description": "Repository owner (user or org)." },
                    "repo": { "type": "string", "description": "Repository name." },
                    "title": { "type": "string", "description": "Issue title." },
                    "body": { "type": "string", "description": "Issue body (markdown)." }
                }
            }
        }),
        serde_json::json!({
            "name": "gh_comment",
            "description": "Comment on a GitHub issue or pull request (same endpoint for both).",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo", "number", "body"],
                "additionalProperties": false,
                "properties": {
                    "owner": { "type": "string", "description": "Repository owner (user or org)." },
                    "repo": { "type": "string", "description": "Repository name." },
                    "number": { "type": "integer", "description": "Issue or pull request number." },
                    "body": { "type": "string", "description": "Comment body (markdown)." }
                }
            }
        }),
        serde_json::json!({
            "name": "gh_create_pr",
            "description": "Open a pull request from an existing branch. The branch must already be pushed.",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo", "title", "head", "base"],
                "additionalProperties": false,
                "properties": {
                    "owner": { "type": "string", "description": "Repository owner (user or org)." },
                    "repo": { "type": "string", "description": "Repository name." },
                    "title": { "type": "string", "description": "Pull request title." },
                    "head": { "type": "string", "description": "Source branch name." },
                    "base": { "type": "string", "description": "Target branch, usually the default branch." },
                    "body": { "type": "string", "description": "Pull request body (markdown)." }
                }
            }
        }),
        serde_json::json!({
            "name": "gh_update_issue_state",
            "description": "Close or reopen a GitHub issue.",
            "input_schema": {
                "type": "object",
                "required": ["owner", "repo", "number", "state"],
                "additionalProperties": false,
                "properties": {
                    "owner": { "type": "string", "description": "Repository owner (user or org)." },
                    "repo": { "type": "string", "description": "Repository name." },
                    "number": { "type": "integer", "description": "Issue number." },
                    "state": {
                        "type": "string",
                        "enum": ["open", "closed"],
                        "description": "New issue state."
                    }
                }
            }
        }),
    ]
}

/// Tool definitions visible to an operator at this access level.
pub fn github_tool_defs(access: GithubAccess) -> Vec<Value> {
    match access {
        GithubAccess::Off => vec![],
        GithubAccess::ReadOnly => read_defs(),
        GithubAccess::ReadWrite => {
            let mut v = read_defs();
            v.extend(write_defs());
            v
        }
    }
}

/// Dispatch adapter for the LLM tool loop. Returns `None` when `name`
/// is not a github tool (caller falls through to its unknown-tool arm).
pub async fn execute_github_tool(
    env: &ToolEnv,
    name: &str,
    input: &Value,
) -> Option<Result<String, ToolError>> {
    Some(match name {
        "gh_list_repos" => gh_list_repos(env, input).await,
        "gh_list_issues" => gh_list_issues(env, input).await,
        "gh_get_issue" => gh_get_issue(env, input).await,
        "gh_list_prs" => gh_list_prs(env, input).await,
        "gh_get_pr" => gh_get_pr(env, input).await,
        "gh_create_issue" => gh_create_issue(env, input).await,
        "gh_comment" => gh_comment(env, input).await,
        "gh_create_pr" => gh_create_pr(env, input).await,
        "gh_update_issue_state" => gh_update_issue_state(env, input).await,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operator_registry::GithubAccess;
    use crate::teammate::tools::{GithubCtx, ToolEnv};

    fn env_with(api_base: String, access: GithubAccess) -> ToolEnv {
        ToolEnv::new(std::env::temp_dir(), 1024).with_github(Some(GithubCtx {
            token: "tok".into(),
            access,
            api_base,
        }))
    }

    #[test]
    fn tool_defs_gated_by_access() {
        assert!(github_tool_defs(GithubAccess::Off).is_empty());
        let ro: Vec<String> = github_tool_defs(GithubAccess::ReadOnly)
            .iter().map(|d| d["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(ro, vec!["gh_list_repos", "gh_list_issues", "gh_get_issue", "gh_list_prs", "gh_get_pr"]);
        let rw: Vec<String> = github_tool_defs(GithubAccess::ReadWrite)
            .iter().map(|d| d["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(rw, vec![
            "gh_list_repos", "gh_list_issues", "gh_get_issue", "gh_list_prs", "gh_get_pr",
            "gh_create_issue", "gh_comment", "gh_create_pr", "gh_update_issue_state",
        ]);
    }

    #[tokio::test]
    async fn list_issues_filters_prs_and_caps_fields() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/repos/karluiz/covenant/issues")
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("state".into(), "open".into()),
            ]))
            .match_header("authorization", "Bearer tok")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"[
                {"number": 7, "title": "Real issue", "state": "open",
                 "user": {"login": "karluiz"}, "comments": 2,
                 "updated_at": "2026-06-01T00:00:00Z", "labels": []},
                {"number": 8, "title": "Actually a PR", "state": "open",
                 "user": {"login": "karluiz"}, "comments": 0,
                 "updated_at": "2026-06-01T00:00:00Z", "labels": [],
                 "pull_request": {"url": "x"}}
            ]"#)
            .create_async()
            .await;
        let env = env_with(server.url(), GithubAccess::ReadOnly);
        let out = gh_list_issues(&env, &serde_json::json!({"owner": "karluiz", "repo": "covenant"}))
            .await
            .unwrap();
        assert!(out.contains("Real issue"));
        assert!(!out.contains("Actually a PR"));
    }

    #[tokio::test]
    async fn unauthorized_maps_to_reconnect_hint() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/repos/o/r/issues")
            .match_query(mockito::Matcher::Any)
            .with_status(401)
            .with_body(r#"{"message":"Bad credentials"}"#)
            .create_async()
            .await;
        let env = env_with(server.url(), GithubAccess::ReadOnly);
        let err = gh_list_issues(&env, &serde_json::json!({"owner": "o", "repo": "r"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("re-connect"));
    }

    #[tokio::test]
    async fn create_issue_posts_and_returns_url() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("POST", "/repos/o/r/issues")
            .match_body(mockito::Matcher::PartialJson(serde_json::json!({"title": "T"})))
            .with_status(201)
            .with_header("content-type", "application/json")
            .with_body(r#"{"number": 42, "html_url": "https://github.com/o/r/issues/42", "state": "open", "title": "T"}"#)
            .create_async()
            .await;
        let env = env_with(server.url(), GithubAccess::ReadWrite);
        let out = gh_create_issue(&env, &serde_json::json!({"owner": "o", "repo": "r", "title": "T"}))
            .await
            .unwrap();
        assert!(out.contains("issues/42"));
    }

    #[tokio::test]
    async fn write_tool_rejected_for_readonly_ctx() {
        let env = env_with("http://127.0.0.1:9".into(), GithubAccess::ReadOnly);
        let err = gh_create_issue(&env, &serde_json::json!({"owner": "o", "repo": "r", "title": "T"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("read-only"));
    }

    #[tokio::test]
    async fn body_truncation_marks_cut() {
        let long = "x".repeat(5000);
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/repos/o/r/issues/1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::json!({
                "number": 1, "title": "t", "state": "open", "body": long,
                "user": {"login": "u"}, "comments": 0,
                "updated_at": "2026-06-01T00:00:00Z", "labels": []
            }).to_string())
            .create_async()
            .await;
        let _m2 = server
            .mock("GET", "/repos/o/r/issues/1/comments")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("[]")
            .create_async()
            .await;
        let env = env_with(server.url(), GithubAccess::ReadOnly);
        let out = gh_get_issue(&env, &serde_json::json!({"owner": "o", "repo": "r", "number": 1}))
            .await
            .unwrap();
        assert!(out.contains("(truncated)"));
        assert!(out.len() < 4000);
    }
}
