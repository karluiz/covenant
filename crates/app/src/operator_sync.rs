//! Org operator roster sync (P1 of the 2026-07-25 org-roster spec).
//!
//! The org is the source of truth for org-tagged operators; local SQLite +
//! SOUL.md is the offline cache. Only the SOUL.md travels — machine-local
//! grants (`github_access`, `acp_enabled`, `perception_enabled`,
//! `is_default`, `xp`) never leave the machine and are preserved on pull.
//!
//! Push: fire-and-forget after any local edit of an org operator.
//! Pull: on org selection; LWW on `updated_at`, both directions.

use serde::{Deserialize, Serialize};

use crate::canon_registry::{client, send_authed, urlencoding};
use crate::operator_registry::{Operator, OperatorId, OperatorRegistry};
use crate::storage::Storage;
use karl_score::auth;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RosterRow {
    pub operator_id: String,
    pub soul_md: String,
    pub updated_at_ms: i64,
    pub updated_by: String,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct PullSummary {
    pub pulled: usize,
    pub pushed: usize,
    pub unchanged: usize,
}

pub async fn fetch_roster(org: &str) -> Result<Vec<RosterRow>, String> {
    let url = format!(
        "{}/orgs/{}/operators",
        auth::backend_url(),
        urlencoding(org)
    );
    send_authed(|j| client().get(&url).bearer_auth(j))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn put_operator(
    org: &str,
    operator_id: &str,
    soul_md: &str,
    updated_at_ms: u64,
) -> Result<RosterRow, String> {
    let url = format!(
        "{}/orgs/{}/operators/{}",
        auth::backend_url(),
        urlencoding(org),
        urlencoding(operator_id)
    );
    let body = serde_json::json!({ "soul_md": soul_md, "updated_at_ms": updated_at_ms });
    send_authed(|j| client().put(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

/// Fire-and-forget push of one operator's soul to its org roster.
/// Failures are logged, never surfaced — the next pull reconciles.
pub fn spawn_push(org: String, operator_id: String, soul_md: String, updated_at_ms: u64) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = put_operator(&org, &operator_id, &soul_md, updated_at_ms).await {
            tracing::warn!(operator_id = %operator_id, error = %e, "org operator push failed");
        }
    });
}

/// Push `op` to its org roster if it belongs to one. Reads the soul from
/// the registry so callers only need the operator.
pub fn push_if_org(registry: &OperatorRegistry, op: &Operator) {
    let Some(org) = op.org_slug.clone() else {
        return;
    };
    let Some(soul_md) = registry.read_soul(op.id) else {
        return;
    };
    spawn_push(org, op.id.to_string(), soul_md, op.updated_at_unix_ms);
}

/// What to do with one roster row given the local timestamp (if any).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SyncAction {
    /// Local is newer — push it up.
    PushLocal,
    /// Remote is newer (or unknown locally) — import it.
    Import,
    /// Timestamps match — nothing to do.
    Skip,
}

pub(crate) fn decide(local_updated_ms: Option<u64>, remote_updated_ms: i64) -> SyncAction {
    let remote = remote_updated_ms.max(0) as u64;
    match local_updated_ms {
        Some(l) if l > remote => SyncAction::PushLocal,
        Some(l) if l == remote => SyncAction::Skip,
        _ => SyncAction::Import,
    }
}

/// Build the operator to import for a roster row: hydrate the soul over the
/// existing local operator (preserving machine-local grants) or over a fresh
/// grants-off operator when the id is unknown locally.
pub(crate) fn build_import_op(
    local: Option<Operator>,
    id: OperatorId,
    org: &str,
    soul: &crate::soul::Soul,
    updated_at_ms: u64,
) -> Operator {
    let mut op = local.unwrap_or(Operator {
        id,
        name: String::new(),
        emoji: String::new(),
        color: String::new(),
        tags: vec![],
        persona: String::new(),
        escalate_threshold: 0.6,
        model: String::new(),
        hard_constraints: String::new(),
        is_default: false,
        created_at_unix_ms: updated_at_ms,
        updated_at_unix_ms: 0,
        xp: 0,
        voice: Default::default(),
        soul_path: None,
        soul_mtime_unix_ms: 0,
        github_access: Default::default(),
        acp_enabled: false,
        perception_enabled: false,
        perception_reflexes: String::new(),
        supervision_enabled: false,
        org_slug: None,
        mcp_servers: vec![],
    });
    crate::soul::hydrate_operator(&mut op, soul);
    op.org_slug = Some(org.to_string());
    // Keep the server timestamp so LWW stays coherent across machines.
    op.updated_at_unix_ms = updated_at_ms;
    op
}

/// Pull an org's roster and reconcile it into the local registry.
/// P1: no deletion reconcile — absent-from-roster local ops are left alone,
/// but local org ops the server doesn't know yet are pushed up.
pub async fn pull_org(
    org: &str,
    registry: &OperatorRegistry,
    storage: &Storage,
) -> Result<PullSummary, String> {
    let roster = fetch_roster(org).await?;
    let mut summary = PullSummary::default();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for row in roster {
        seen.insert(row.operator_id.clone());
        let Ok(id) = row.operator_id.parse::<OperatorId>() else {
            tracing::warn!(operator_id = %row.operator_id, "roster row with non-ULID id skipped");
            continue;
        };
        let local = registry.get(id);
        match decide(
            local.as_ref().map(|l| l.updated_at_unix_ms),
            row.updated_at_ms,
        ) {
            SyncAction::Skip => summary.unchanged += 1,
            SyncAction::PushLocal => {
                if let Some(soul_md) = registry.read_soul(id) {
                    let ts = local.map(|l| l.updated_at_unix_ms).unwrap_or(0);
                    // Tolerate push failures (members are read-only — the
                    // server owner-gates writes): keep pulling the rest.
                    match put_operator(org, &row.operator_id, &soul_md, ts).await {
                        Ok(_) => summary.pushed += 1,
                        Err(e) => tracing::debug!(operator_id = %row.operator_id, error = %e,
                            "roster push skipped"),
                    }
                }
            }
            SyncAction::Import => {
                let soul = match crate::soul::parse(&row.soul_md) {
                    Ok(s) => s,
                    Err(e) => {
                        tracing::warn!(operator_id = %row.operator_id, error = %e,
                            "roster soul_md unparseable; skipped");
                        continue;
                    }
                };
                let op = build_import_op(local, id, org, &soul, row.updated_at_ms.max(0) as u64);
                registry
                    .import(storage, op, &row.soul_md)
                    .await
                    .map_err(|e| e.to_string())?;
                summary.pulled += 1;
            }
        }
    }

    // Local org operators the server has never seen (e.g. promoted while
    // offline): push them up so the roster converges.
    for op in registry.list() {
        if op.org_slug.as_deref() == Some(org) && !seen.contains(&op.id.to_string()) {
            if let Some(soul_md) = registry.read_soul(op.id) {
                match put_operator(org, &op.id.to_string(), &soul_md, op.updated_at_unix_ms).await {
                    Ok(_) => summary.pushed += 1,
                    Err(e) => tracing::debug!(operator_id = %op.id.to_string(), error = %e,
                        "roster convergence push skipped"),
                }
            }
        }
    }

    Ok(summary)
}

pub mod commands {
    use super::*;
    use std::sync::Arc;
    use tauri::State;

    #[tauri::command]
    pub async fn operator_org_pull(
        org: String,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<Storage>>,
    ) -> Result<PullSummary, String> {
        pull_org(org.trim(), &registry, &storage).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operator_registry::GithubAccess;

    #[test]
    fn decide_lww_matrix() {
        assert_eq!(decide(None, 100), SyncAction::Import);
        assert_eq!(decide(Some(50), 100), SyncAction::Import);
        assert_eq!(decide(Some(100), 100), SyncAction::Skip);
        assert_eq!(decide(Some(150), 100), SyncAction::PushLocal);
        // Negative remote timestamps clamp to 0 instead of wrapping.
        assert_eq!(decide(Some(1), -5), SyncAction::PushLocal);
    }

    #[test]
    fn build_import_preserves_local_grants_and_zeroes_fresh() {
        let raw = "---\nname: Atlas\n---\nI keep the night watch.";
        let soul = crate::soul::parse(raw).unwrap();
        let id = OperatorId(ulid::Ulid::new());

        // Fresh: grants off, not default.
        let fresh = build_import_op(None, id, "acme", &soul, 500);
        assert_eq!(fresh.name, "Atlas");
        assert_eq!(fresh.org_slug.as_deref(), Some("acme"));
        assert_eq!(fresh.updated_at_unix_ms, 500);
        assert!(!fresh.is_default);
        assert!(!fresh.acp_enabled);
        assert!(!fresh.perception_enabled);
        assert_eq!(fresh.github_access, GithubAccess::Off);
        assert_eq!(fresh.xp, 0);

        // Existing: machine-local grants survive the import.
        let mut local = fresh.clone();
        local.github_access = GithubAccess::ReadWrite;
        local.acp_enabled = true;
        local.perception_enabled = true;
        local.is_default = true;
        local.xp = 420;
        let merged = build_import_op(Some(local), id, "acme", &soul, 900);
        assert_eq!(merged.github_access, GithubAccess::ReadWrite);
        assert!(merged.acp_enabled);
        assert!(merged.perception_enabled);
        assert!(merged.is_default);
        assert_eq!(merged.xp, 420);
        assert_eq!(merged.updated_at_unix_ms, 900);
    }
}
