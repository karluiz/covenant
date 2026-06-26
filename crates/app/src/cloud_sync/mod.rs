pub mod commands;
pub mod secrets;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::operator_registry::OperatorRegistry;
use crate::settings::{CloudSyncConfig, Settings};
use crate::storage::Storage;
use karl_score::auth;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncEnvelope {
    pub schema_version: u32,
    pub updated_at_ms: i64,
    pub device: String,
    pub sections: SyncSections,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SyncSections {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspaces: Option<Value>, // raw TabManifestV2 JSON
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operators: Option<Vec<OperatorExport>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specs: Option<Vec<Value>>, // raw SpecDraft JSON
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferences: Option<Value>, // Settings minus secrets
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OperatorExport {
    pub meta: Value, // serialized Operator, soul_path removed
    pub soul_md: String,
}

#[derive(Serialize, Default, Clone, Debug)]
pub struct ApplySummary {
    pub workspaces: bool,
    pub operators: usize,
    pub specs: usize,
    pub preferences: bool,
    pub skipped: usize,
}

pub fn device_name() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| std::env::consts::OS.to_string())
}

/// Everything the gather step reads from. Borrowed so commands can pass live
/// app state.
pub struct GatherCtx<'a> {
    pub cfg: &'a CloudSyncConfig,
    pub settings: &'a Settings,
    pub registry: &'a OperatorRegistry,
    pub tab_manifest_path: &'a std::path::Path,
    pub specs_base_dir: std::path::PathBuf,
}

pub fn build_envelope(ctx: &GatherCtx<'_>) -> SyncEnvelope {
    let mut sections = SyncSections::default();

    if ctx.cfg.workspaces {
        if let Ok(Some(body)) = crate::tab_manifest::load(ctx.tab_manifest_path) {
            sections.workspaces = serde_json::from_str::<Value>(&body).ok();
        }
    }
    if ctx.cfg.operators {
        let mut ops = Vec::new();
        for op in ctx.registry.list() {
            let mut meta = serde_json::to_value(&op).unwrap_or(Value::Null);
            if let Some(o) = meta.as_object_mut() {
                o.remove("soul_path"); // machine-specific; regenerated on import
            }
            let soul_md = ctx.registry.read_soul(op.id).unwrap_or_default();
            ops.push(OperatorExport { meta, soul_md });
        }
        sections.operators = Some(ops);
    }
    if ctx.cfg.specs {
        let drafts = karl_agent::spec_author::list_drafts(&ctx.specs_base_dir);
        sections.specs = Some(
            drafts
                .iter()
                .filter_map(|d| serde_json::to_value(d).ok())
                .collect(),
        );
    }
    if ctx.cfg.preferences {
        let mut prefs = serde_json::to_value(ctx.settings).unwrap_or(Value::Null);
        secrets::strip_secrets(&mut prefs);
        sections.preferences = Some(prefs);
    }

    SyncEnvelope {
        schema_version: SCHEMA_VERSION,
        updated_at_ms: chrono::Utc::now().timestamp_millis(),
        device: device_name(),
        sections,
    }
}

/// Everything apply writes to.
pub struct ApplyCtx<'a> {
    pub settings: &'a Settings,
    pub registry: &'a OperatorRegistry,
    pub storage: &'a Storage,
    pub tab_manifest_path: &'a std::path::Path,
    pub specs_base_dir: std::path::PathBuf,
    /// Sink for the merged settings (the command persists + broadcasts it).
    pub merged_settings_out: &'a mut Option<Settings>,
}

pub async fn apply_envelope(env: &SyncEnvelope, ctx: &mut ApplyCtx<'_>) -> ApplySummary {
    let mut summary = ApplySummary::default();

    if let Some(ws) = &env.sections.workspaces {
        if let Ok(body) = serde_json::to_string(ws) {
            if crate::tab_manifest::save(ctx.tab_manifest_path, &body).is_ok() {
                summary.workspaces = true;
            }
        }
    }
    if let Some(ops) = &env.sections.operators {
        for ex in ops {
            // meta has no soul_path; deserialize then let import assign it.
            match serde_json::from_value::<crate::operator_registry::Operator>(ex.meta.clone()) {
                Ok(op) => {
                    if ctx
                        .registry
                        .import(ctx.storage, op, &ex.soul_md)
                        .await
                        .is_ok()
                    {
                        summary.operators += 1;
                    } else {
                        summary.skipped += 1;
                    }
                }
                Err(_) => {
                    summary.skipped += 1;
                }
            }
        }
    }
    if let Some(specs) = &env.sections.specs {
        for s in specs {
            match serde_json::from_value::<karl_agent::spec_author::SpecDraft>(s.clone()) {
                Ok(draft) => {
                    if karl_agent::spec_author::save_draft(&ctx.specs_base_dir, &draft).is_ok() {
                        summary.specs += 1;
                    } else {
                        summary.skipped += 1;
                    }
                }
                Err(_) => {
                    summary.skipped += 1;
                }
            }
        }
    }
    if let Some(cloud_prefs) = &env.sections.preferences {
        *ctx.merged_settings_out = Some(secrets::merge_preferences(ctx.settings, cloud_prefs));
        summary.preferences = true;
    }

    summary
}

// ---- HTTP ----

fn endpoint() -> String {
    format!("{}/sync/state", auth::backend_url())
}

fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

pub async fn push(env: &SyncEnvelope) -> Result<i64, String> {
    let jwt = auth::load_jwt()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not signed in".to_string())?;
    let resp = http_client()
        .put(endpoint())
        .header("User-Agent", "covenant-cloud-sync")
        .bearer_auth(&jwt)
        .json(env)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v["updated_at_ms"].as_i64().unwrap_or(0))
}

pub async fn pull() -> Result<Option<SyncEnvelope>, String> {
    let jwt = auth::load_jwt()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not signed in".to_string())?;
    let resp = http_client()
        .get(endpoint())
        .header("User-Agent", "covenant-cloud-sync")
        .bearer_auth(&jwt)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    let resp = resp.error_for_status().map_err(|e| e.to_string())?;
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let env =
        serde_json::from_value::<SyncEnvelope>(v["state"].clone()).map_err(|e| e.to_string())?;
    Ok(Some(env))
}

pub async fn wipe() -> Result<(), String> {
    let jwt = auth::load_jwt()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not signed in".to_string())?;
    http_client()
        .delete(endpoint())
        .header("User-Agent", "covenant-cloud-sync")
        .bearer_auth(&jwt)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips_through_json() {
        let env = SyncEnvelope {
            schema_version: SCHEMA_VERSION,
            updated_at_ms: 123,
            device: "dev".into(),
            sections: SyncSections {
                workspaces: Some(serde_json::json!({"version":2})),
                operators: None,
                specs: Some(vec![serde_json::json!({"id":"x"})]),
                preferences: None,
            },
        };
        let s = serde_json::to_string(&env).unwrap();
        let back: SyncEnvelope = serde_json::from_str(&s).unwrap();
        assert_eq!(back.schema_version, SCHEMA_VERSION);
        assert!(back.sections.workspaces.is_some());
        assert!(back.sections.operators.is_none());
        assert_eq!(back.sections.specs.unwrap().len(), 1);
    }
}
