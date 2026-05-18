use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpawnSpec {
    pub id: String,
    pub label: String,
    pub icon: Option<String>,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub model: Option<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    pub cwd: Option<String>,
    #[serde(default)]
    pub default: bool,
}

pub struct SpawnStore {
    path: PathBuf,
    inner: Mutex<Vec<SpawnSpec>>,
}

const DEFAULT_SPAWNS: &[(&str, &str, &str, &[&str], Option<&str>)] = &[
    ("claude", "Claude", "claude", &[], Some("claude-sonnet-4-6")),
    ("codex", "Codex", "codex", &[], Some("gpt-5")),
    ("copilot", "Copilot", "gh", &["copilot"], None),
];

impl SpawnStore {
    pub fn open(data_dir: &Path) -> std::io::Result<Self> {
        let path = data_dir.join("spawns.json");
        let specs = if path.exists() {
            let raw = std::fs::read_to_string(&path)?;
            serde_json::from_str::<Vec<SpawnSpec>>(&raw).unwrap_or_default()
        } else {
            let seeded = DEFAULT_SPAWNS
                .iter()
                .map(|(id, label, cmd, args, model)| SpawnSpec {
                    id: (*id).into(),
                    label: (*label).into(),
                    icon: None,
                    command: (*cmd).into(),
                    args: args.iter().map(|s| (*s).into()).collect(),
                    model: model.map(|s| s.into()),
                    env: Default::default(),
                    cwd: None,
                    default: *id == "claude",
                })
                .collect::<Vec<_>>();
            std::fs::create_dir_all(data_dir).ok();
            std::fs::write(
                &path,
                serde_json::to_string_pretty(&seeded)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?,
            )?;
            seeded
        };
        Ok(Self {
            path,
            inner: Mutex::new(specs),
        })
    }

    pub fn list(&self) -> Vec<SpawnSpec> {
        self.inner.lock().unwrap().clone()
    }

    pub fn upsert(&self, spec: SpawnSpec) -> std::io::Result<()> {
        let mut g = self.inner.lock().unwrap();
        if let Some(existing) = g.iter_mut().find(|s| s.id == spec.id) {
            *existing = spec;
        } else {
            g.push(spec);
        }
        std::fs::write(
            &self.path,
            serde_json::to_string_pretty(&*g)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?,
        )
    }

    pub fn delete(&self, id: &str) -> std::io::Result<()> {
        let mut g = self.inner.lock().unwrap();
        g.retain(|s| s.id != id);
        std::fs::write(
            &self.path,
            serde_json::to_string_pretty(&*g)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn spawn_spec_roundtrip() {
        let spec = SpawnSpec {
            id: "claude".into(),
            label: "Claude".into(),
            icon: None,
            command: "claude".into(),
            args: vec!["--print".into()],
            model: Some("claude-sonnet-4-6".into()),
            env: Default::default(),
            cwd: None,
            default: true,
        };
        let json = serde_json::to_string(&spec).unwrap();
        let back: SpawnSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(spec, back);
    }

    #[test]
    fn seeds_defaults_on_first_open() {
        let dir = tempdir().unwrap();
        let store = SpawnStore::open(dir.path()).unwrap();
        let list = store.list();
        assert!(list.iter().any(|s| s.id == "claude" && s.default));
        assert!(list.iter().any(|s| s.id == "codex"));
        assert!(list.iter().any(|s| s.id == "copilot"));
        assert!(dir.path().join("spawns.json").exists());
    }

    #[test]
    fn upsert_and_delete_roundtrip() {
        let dir = tempdir().unwrap();
        let store = SpawnStore::open(dir.path()).unwrap();
        store
            .upsert(SpawnSpec {
                id: "ollama".into(),
                label: "Ollama".into(),
                icon: None,
                command: "ollama".into(),
                args: vec!["run".into(), "qwen3".into()],
                model: Some("qwen3-30b".into()),
                env: Default::default(),
                cwd: None,
                default: false,
            })
            .unwrap();
        assert!(store.list().iter().any(|s| s.id == "ollama"));

        // reopen — must persist
        let reopened = SpawnStore::open(dir.path()).unwrap();
        assert!(reopened.list().iter().any(|s| s.id == "ollama"));

        reopened.delete("ollama").unwrap();
        let reopened2 = SpawnStore::open(dir.path()).unwrap();
        assert!(!reopened2.list().iter().any(|s| s.id == "ollama"));
    }

    #[test]
    fn malformed_json_falls_back_to_empty() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("spawns.json"), "{not json").unwrap();
        let store = SpawnStore::open(dir.path()).unwrap();
        assert!(store.list().is_empty());
    }
}
