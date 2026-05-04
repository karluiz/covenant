use crate::directive::{Directive, DirectiveKind};
use crate::error::{FamiliarError, Result};
use crate::identity::{Familiar, FamiliarConfig, FamiliarId};
use crate::memory::Memory;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct FamiliarHandle {
    pub familiar: Familiar,
    pub memory: Arc<Mutex<Memory>>,
}

pub struct FamiliarManager {
    root: PathBuf,
    map: Arc<Mutex<HashMap<FamiliarId, FamiliarHandle>>>,
    by_session: Arc<Mutex<HashMap<String, FamiliarId>>>,
}

impl FamiliarManager {
    pub fn new(root: PathBuf) -> Self {
        Self { root, map: Default::default(), by_session: Default::default() }
    }

    pub async fn spawn(&self, session_id: String, config: FamiliarConfig)
        -> Result<FamiliarId>
    {
        let id = FamiliarId::new();
        let path = self.root.join(format!("{}.sqlite", id));
        let mem = Arc::new(Mutex::new(Memory::open(&path)?));
        let f = Familiar {
            id, session_id: session_id.clone(), config,
            created_at: now_ms(),
        };
        self.map.lock().await.insert(id, FamiliarHandle {
            familiar: f, memory: mem,
        });
        self.by_session.lock().await.insert(session_id, id);
        Ok(id)
    }

    pub async fn list(&self) -> Vec<Familiar> {
        self.map.lock().await.values().map(|h| h.familiar.clone()).collect()
    }

    pub async fn for_session(&self, session_id: &str) -> Option<FamiliarId> {
        self.by_session.lock().await.get(session_id).copied()
    }

    pub async fn memory_of(&self, id: FamiliarId) -> Result<Arc<Mutex<Memory>>> {
        self.map.lock().await.get(&id)
            .map(|h| h.memory.clone())
            .ok_or_else(|| FamiliarError::NotFound(id.to_string()))
    }

    pub async fn config_of(&self, id: FamiliarId) -> Result<FamiliarConfig> {
        self.map.lock().await.get(&id)
            .map(|h| h.familiar.config.clone())
            .ok_or_else(|| FamiliarError::NotFound(id.to_string()))
    }

    pub async fn update_config(&self, id: FamiliarId, cfg: FamiliarConfig) -> Result<()> {
        let mut m = self.map.lock().await;
        let h = m.get_mut(&id).ok_or_else(|| FamiliarError::NotFound(id.to_string()))?;
        h.familiar.config = cfg;
        Ok(())
    }

    pub async fn approve_directive(&self, id: FamiliarId, directive_id: &str,
                                    now_ms: i64) -> Result<String> {
        let mem = self.memory_of(id).await?;
        let mem = mem.lock().await;
        let row = mem.directive(directive_id)?
            .ok_or_else(|| FamiliarError::NotFound(directive_id.into()))?;
        let kind = match row.kind.as_str() {
            "Stop" => DirectiveKind::Stop,
            "Focus" => DirectiveKind::Focus,
            "Avoid" => DirectiveKind::Avoid,
            "Resume" => DirectiveKind::Resume,
            _ => DirectiveKind::Custom,
        };
        let d = Directive {
            id: row.id.clone(), kind,
            payload: row.payload.clone(), rationale: row.rationale.clone(),
        };
        let rendered = d.rendered_for_operator();
        mem.update_directive_state(directive_id, now_ms, "approved", None)?;
        Ok(rendered)
    }

    pub async fn reject_directive(&self, id: FamiliarId, directive_id: &str,
                                   now_ms: i64) -> Result<()> {
        let mem = self.memory_of(id).await?;
        let mem = mem.lock().await;
        mem.update_directive_state(directive_id, now_ms, "rejected", None)?;
        Ok(())
    }

    pub async fn mark_executed(&self, id: FamiliarId, directive_id: &str,
                                now_ms: i64) -> Result<()> {
        let mem = self.memory_of(id).await?;
        let mem = mem.lock().await;
        mem.update_directive_state(directive_id, now_ms, "executed", None)?;
        Ok(())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawn_and_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = FamiliarManager::new(dir.path().to_path_buf());
        let id = mgr.spawn("S1".into(), FamiliarConfig {
            name: "Marcus".into(), ..Default::default()
        }).await.unwrap();
        assert_eq!(mgr.list().await.len(), 1);
        assert_eq!(mgr.for_session("S1").await, Some(id));
        assert_eq!(mgr.config_of(id).await.unwrap().name, "Marcus");
    }

    #[tokio::test]
    async fn update_config_persists_in_handle() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = FamiliarManager::new(dir.path().to_path_buf());
        let id = mgr.spawn("S2".into(), FamiliarConfig::default()).await.unwrap();
        mgr.update_config(id, FamiliarConfig {
            name: "Iris".into(), daily_cap_usd: 10.0, ..Default::default()
        }).await.unwrap();
        assert_eq!(mgr.config_of(id).await.unwrap().name, "Iris");
    }

    #[tokio::test]
    async fn approve_records_state() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = FamiliarManager::new(dir.path().to_path_buf());
        let id = mgr.spawn("S".into(), FamiliarConfig::default()).await.unwrap();
        // Pre-log a directive (as agent would have done)
        {
            let mem = mgr.memory_of(id).await.unwrap();
            let mem = mem.lock().await;
            mem.log_directive("D1", 100, "proposed", "Stop", "halt", "rationale", None).unwrap();
        }
        let injected = mgr.approve_directive(id, "D1", 200).await.unwrap();
        assert!(injected.contains("[FAMILIAR_DIRECTIVE STOP]"));
        let mem = mgr.memory_of(id).await.unwrap();
        let mem = mem.lock().await;
        assert_eq!(mem.directive("D1").unwrap().unwrap().state, "approved");
    }

    #[tokio::test]
    async fn reject_records_state() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = FamiliarManager::new(dir.path().to_path_buf());
        let id = mgr.spawn("S".into(), FamiliarConfig::default()).await.unwrap();
        {
            let mem = mgr.memory_of(id).await.unwrap();
            let mem = mem.lock().await;
            mem.log_directive("D2", 100, "proposed", "Focus", "x", "y", None).unwrap();
        }
        mgr.reject_directive(id, "D2", 200).await.unwrap();
        let mem = mgr.memory_of(id).await.unwrap();
        let mem = mem.lock().await;
        assert_eq!(mem.directive("D2").unwrap().unwrap().state, "rejected");
    }
}
