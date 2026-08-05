//! Authed HTTP client for the covenant-server Canon package registry.
// ponytail: wire path stays `/cdlc/packages` — the deployed forge.covenant.uno
// backend still serves that route. Rename to `/canon/` only alongside a server
// deploy that adds the new route (keep the old one until old clients age out).
use karl_score::auth;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Org {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub personal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    pub login: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PkgMeta {
    pub id: i64,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub publisher_login: String,
    pub installs: i32,
    pub sha: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    /// Cross-org eval aggregate. Absent on a pre-Plan-B server → 0/0 → hidden.
    #[serde(default)]
    pub eval_passed: i64,
    #[serde(default)]
    pub eval_total: i64,
    /// Criteria-eval score aggregate (Task 13's server fields). Absent on a
    /// pre-upgrade server → None → hidden, same pattern as eval_passed above.
    #[serde(default)]
    pub eval_score: Option<i64>,
    #[serde(default)]
    pub eval_max_score: Option<i64>,
    #[serde(default)]
    pub eval_baseline_score: Option<i64>,
    #[serde(default)]
    pub eval_fresh: Option<bool>,
}

#[allow(dead_code)] // description/sha/publisher_login/kind are part of the server JSON contract
#[derive(Debug, Clone, Deserialize)]
pub struct PkgFull {
    pub id: i64,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub skill_toml: String,
    pub skill_md: String,
    pub sha: String,
    pub publisher_login: String,
    #[serde(default = "default_kind")]
    pub kind: String,
}

fn default_kind() -> String {
    "skill".to_string()
}

fn jwt() -> Result<String, String> {
    auth::load_jwt()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not signed in to Covenant".to_string())
}

pub(crate) fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Send an authed request via [`auth::send_authed`] (401 → refresh JWT +
/// retry once), then surface HTTP errors as strings.
pub(crate) async fn send_authed(
    build: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let j = jwt()?;
    auth::send_authed(&j, build)
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())
}

pub async fn list_orgs() -> Result<Vec<Org>, String> {
    let url = format!("{}/orgs", auth::backend_url());
    send_authed(|j| client().get(&url).bearer_auth(j))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn create_org(slug: &str, name: &str) -> Result<Value, String> {
    let url = format!("{}/orgs", auth::backend_url());
    let body = serde_json::json!({ "slug": slug, "name": name });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

/// Owner-only display-name edit; the slug never changes.
pub async fn rename_org(org: &str, name: &str) -> Result<(), String> {
    let url = format!("{}/orgs/{}", auth::backend_url(), urlencoding(org));
    let body = serde_json::json!({ "name": name });
    send_authed(|j| client().patch(&url).bearer_auth(j).json(&body)).await?;
    Ok(())
}

/// Owner-only org deletion, keyed by slug (mirrors `rename_org`).
pub async fn delete_org(org: &str) -> Result<(), String> {
    let url = format!("{}/orgs/{}", auth::backend_url(), urlencoding(org));
    send_authed(|j| client().delete(&url).bearer_auth(j)).await?;
    Ok(())
}

pub async fn list_members(org: &str) -> Result<Vec<Member>, String> {
    let url = format!("{}/orgs/{}/members", auth::backend_url(), urlencoding(org));
    send_authed(|j| client().get(&url).bearer_auth(j))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn add_member(org: &str, login: &str) -> Result<(), String> {
    let url = format!("{}/orgs/{}/members", auth::backend_url(), urlencoding(org));
    let body = serde_json::json!({ "login": login });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body)).await?;
    Ok(())
}

pub async fn remove_member(org: &str, login: &str) -> Result<(), String> {
    let url = format!(
        "{}/orgs/{}/members/{}",
        auth::backend_url(),
        urlencoding(org),
        urlencoding(login)
    );
    send_authed(|j| client().delete(&url).bearer_auth(j)).await?;
    Ok(())
}

pub async fn search(org: &str, q: Option<&str>, kind: &str) -> Result<Vec<PkgMeta>, String> {
    let mut url = format!(
        "{}/cdlc/packages?org={}&kind={}",
        auth::backend_url(),
        urlencoding(org),
        urlencoding(kind)
    );
    if let Some(q) = q.filter(|s| !s.is_empty()) {
        url.push_str(&format!("&q={}", urlencoding(q)));
    }
    send_authed(|j| client().get(&url).bearer_auth(j))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn resolve(org: &str, name: &str, version: &str, kind: &str) -> Result<PkgFull, String> {
    let url = format!(
        "{}/cdlc/packages/{}/{}/{}?kind={}",
        auth::backend_url(),
        urlencoding(org),
        urlencoding(name),
        urlencoding(version),
        urlencoding(kind)
    );
    send_authed(|j| client().get(&url).bearer_auth(j))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
pub async fn publish(
    org: &str,
    name: &str,
    version: &str,
    description: &str,
    skill_toml: &str,
    skill_md: &str,
    kind: &str,
    evals: Option<Value>,
) -> Result<Value, String> {
    let url = format!("{}/cdlc/packages", auth::backend_url());
    let mut body = serde_json::json!({
        "org": org, "name": name, "version": version,
        "description": description, "skill_toml": skill_toml, "skill_md": skill_md,
        "kind": kind,
    });
    // Server ignores unknown keys today — safe to ship ahead of the Task 13
    // server-side field addition. Omitted entirely (not `null`) when the unit
    // has no non-stale results, so an old server sees the same body as before.
    if let Some(evals) = evals {
        body["evals"] = evals;
    }
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrgDefault {
    pub kind: String,
    pub name: String,
}

/// Owner-curated set of packages every repo of the org should have.
pub async fn list_defaults(org: &str) -> Result<Vec<OrgDefault>, String> {
    let url = format!("{}/orgs/{}/defaults", auth::backend_url(), urlencoding(org));
    send_authed(|j| client().get(&url).bearer_auth(j))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn set_default(org: &str, kind: &str, name: &str) -> Result<(), String> {
    let url = format!(
        "{}/orgs/{}/defaults/{}/{}",
        auth::backend_url(),
        urlencoding(org),
        urlencoding(kind),
        urlencoding(name)
    );
    send_authed(|j| client().put(&url).bearer_auth(j)).await?;
    Ok(())
}

pub async fn unset_default(org: &str, kind: &str, name: &str) -> Result<(), String> {
    let url = format!(
        "{}/orgs/{}/defaults/{}/{}",
        auth::backend_url(),
        urlencoding(org),
        urlencoding(kind),
        urlencoding(name)
    );
    send_authed(|j| client().delete(&url).bearer_auth(j)).await?;
    Ok(())
}

pub async fn record_install(id: i64) -> Result<(), String> {
    let url = format!("{}/cdlc/packages/{}/install", auth::backend_url(), id);
    send_authed(|j| client().post(&url).bearer_auth(j)).await?;
    Ok(())
}

/// The wire shape for one pushed eval row: exactly four keys, none of them
/// `reason` or `duration_ms`. Kept as a standalone pure function — rather than
/// inlined into `push_evals` — so the privacy boundary (the judge's free-text
/// `reason` about the user's repo never leaves the machine) has a mechanical
/// guard: `EvalResult` is `Serialize`, so a future `json!({"results": results})`
/// would compile and silently upload it without this explicit allowlist and
/// its covering test.
fn eval_wire_row(r: &karl_canon::EvalResult) -> Value {
    serde_json::json!({
        "eval_id": r.eval_id,
        "pass": r.pass,
        "baseline_pass": r.baseline_pass,
        "ran_at_ms": r.ran_at_ms,
    })
}

/// Push a skill's eval outcomes to the registry (Plan B). Pass/fail only —
/// `EvalResult.reason` is free text an LLM wrote about the user's repo and
/// never leaves the machine.
pub async fn push_evals(pkg_id: i64, results: &[karl_canon::EvalResult]) -> Result<(), String> {
    let url = format!("{}/cdlc/packages/{}/evals", auth::backend_url(), pkg_id);
    let rows: Vec<Value> = results.iter().map(eval_wire_row).collect();
    let body = serde_json::json!({ "results": rows });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body)).await?;
    Ok(())
}

/// Minimal percent-encoding for path/query segments (slug/name/version are
/// already restricted to url-safe chars server-side, but encode defensively).
pub(crate) fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{eval_wire_row, urlencoding};

    #[test]
    fn urlencoding_escapes_unsafe() {
        assert_eq!(urlencoding("kyc-peru"), "kyc-peru");
        assert_eq!(urlencoding("a b/c"), "a%20b%2Fc");
        assert_eq!(urlencoding("1.0.0"), "1.0.0");
    }

    /// Privacy guard: `EvalResult.reason` is free text an LLM wrote about the
    /// user's repo and must never appear in the pushed wire row. Also asserts
    /// `duration_ms` is dropped and that the row has EXACTLY four keys, so
    /// this test cannot rot into vacuousness (e.g. by only checking presence
    /// of the four expected keys while tolerating extras added later).
    #[test]
    fn eval_wire_row_excludes_reason_and_duration_ms() {
        let r = karl_canon::EvalResult {
            eval_id: "kyc-refuses-without-id".to_string(),
            pass: true,
            reason: "The transcript reveals the repo uses a Postgres instance at \
                     internal-db.corp.example with table `customer_pii`."
                .to_string(),
            ran_at_ms: 1_700_000_000_000,
            duration_ms: 4_321,
            baseline_pass: Some(false),
            ..Default::default()
        };
        let row = eval_wire_row(&r);

        let obj = row.as_object().expect("row is a JSON object");
        assert_eq!(obj.len(), 4, "row must have exactly four keys");

        assert_eq!(row.get("eval_id").unwrap(), "kyc-refuses-without-id");
        assert_eq!(row.get("pass").unwrap(), true);
        assert_eq!(row.get("baseline_pass").unwrap(), false);
        assert_eq!(row.get("ran_at_ms").unwrap(), 1_700_000_000_000i64);

        assert!(
            row.get("reason").is_none(),
            "judge's free-text reason must never be pushed"
        );
        assert!(
            row.get("duration_ms").is_none(),
            "duration_ms is not part of the wire contract"
        );
    }
}
