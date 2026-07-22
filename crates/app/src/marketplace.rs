use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use crate::operator_registry::{OperatorId, OperatorRegistry};
use karl_score::auth;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MarketplaceListing {
    pub id: String,
    pub name: String,
    pub emoji: String,
    pub color: String,
    pub tags: Vec<String>,
    pub tagline: String,
    pub author_login: String,
    pub installs: i64,
    pub soul_md: String,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default()
}

/// First non-empty, non-heading line of the SOUL.md body (after frontmatter),
/// capped at 120 chars.
pub fn derive_tagline(soul_md: &str) -> String {
    // Strip leading YAML frontmatter if present: ---\n ... \n---\n
    let body = match soul_md.strip_prefix("---") {
        Some(rest) => rest.splitn(2, "\n---").nth(1).unwrap_or(rest),
        None => soul_md,
    };
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        return t.chars().take(120).collect();
    }
    String::new()
}

async fn jwt() -> Result<String, String> {
    auth::load_jwt()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not signed in to Covenant Cloud".to_string())
}

/// Send an authed request via [`auth::send_authed`] (401 → refresh JWT +
/// retry once).
async fn send_authed(
    build: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let token = jwt().await?;
    auth::send_authed(&token, build)
        .await
        .map_err(|e| e.to_string())
}

pub async fn publish_soul(soul_md: &str) -> Result<(), String> {
    let soul = crate::soul::parse(soul_md).map_err(|e| e.to_string())?;
    let body = json!({
        "name": soul.frontmatter.name,
        "emoji": soul.frontmatter.avatar.unwrap_or_default(),
        "color": soul.frontmatter.color.unwrap_or_default(),
        "tags": soul.frontmatter.tags,
        "tagline": derive_tagline(soul_md),
        "soul_md": soul_md,
    });
    send_authed(|j| {
        client()
            .post(format!("{}/marketplace/operators", auth::backend_url()))
            .bearer_auth(j)
            .json(&body)
    })
    .await?
    .error_for_status()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn marketplace_search(
    q: Option<String>,
    tag: Option<String>,
) -> Result<Vec<MarketplaceListing>, String> {
    let q = q.filter(|s| !s.is_empty());
    let tag = tag.filter(|s| !s.is_empty());
    let rows = send_authed(|j| {
        let mut req = client()
            .get(format!("{}/marketplace/operators", auth::backend_url()))
            .bearer_auth(j);
        if let Some(q) = &q {
            req = req.query(&[("q", q)]);
        }
        if let Some(tag) = &tag {
            req = req.query(&[("tag", tag)]);
        }
        req
    })
    .await?
    .error_for_status()
    .map_err(|e| e.to_string())?
    .json::<Vec<MarketplaceListing>>()
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub async fn marketplace_publish(
    id: String,
    registry: State<'_, Arc<OperatorRegistry>>,
) -> Result<(), String> {
    let oid: OperatorId = id.parse().map_err(|_| "bad operator id".to_string())?;
    let soul = registry
        .read_soul(oid)
        .ok_or_else(|| "operator not found".to_string())?;
    publish_soul(&soul).await
}

#[tauri::command]
pub async fn marketplace_install_count(id: String) -> Result<(), String> {
    send_authed(|j| {
        client()
            .post(format!(
                "{}/marketplace/operators/{}/install",
                auth::backend_url(),
                id
            ))
            .bearer_auth(j)
    })
    .await?;
    Ok(())
}

/// The curator's review queue (submissions with status = pending).
/// Non-curators get a 403 from the server.
#[tauri::command]
pub async fn marketplace_pending() -> Result<Vec<MarketplaceListing>, String> {
    send_authed(|j| {
        client()
            .get(format!(
                "{}/marketplace/operators/pending",
                auth::backend_url()
            ))
            .bearer_auth(j)
    })
    .await?
    .error_for_status()
    .map_err(|e| e.to_string())?
    .json::<Vec<MarketplaceListing>>()
    .await
    .map_err(|e| e.to_string())
}

/// Approve or reject a pending submission. Curator only.
#[tauri::command]
pub async fn marketplace_review(id: String, approve: bool) -> Result<(), String> {
    let verb = if approve { "approve" } else { "reject" };
    send_authed(|j| {
        client()
            .post(format!(
                "{}/marketplace/operators/{}/{}",
                auth::backend_url(),
                id,
                verb
            ))
            .bearer_auth(j)
    })
    .await?
    .error_for_status()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn marketplace_admin_url() -> Result<String, String> {
    let token = jwt().await?;
    Ok(format!(
        "{}/marketplace/admin?token={}",
        auth::backend_url(),
        token
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tagline_skips_frontmatter_and_headings() {
        let soul = "---\nname: X\ntags: [a]\n---\n\n# The Guardian\n\nI move so nothing you'd regret gets through.\n";
        assert_eq!(
            derive_tagline(soul),
            "I move so nothing you'd regret gets through."
        );
    }
    #[test]
    fn tagline_empty_when_no_body() {
        assert_eq!(derive_tagline("---\nname: X\n---\n"), "");
    }
}
