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

const DEFAULT_SPAWNS: &[(&str, &str, &str, &[&str])] = &[
    ("claude", "Claude", "claude", &[]),
    ("codex", "Codex", "codex", &[]),
    ("copilot", "Copilot", "gh", &["copilot"]),
    ("hermes", "Hermes", "hermes", &[]),
];

/// Presets we want to backfill into a previously-persisted spawns.json
/// when a new release introduces them. Narrow on purpose: only ids in
/// this list are restored if missing — anything the user has deleted
/// stays deleted. Adding an entry here is a one-shot migration; once it
/// has shipped in a release, every existing install will have the row.
const BACKFILL_IDS: &[&str] = &["hermes"];

impl SpawnStore {
    pub fn open(data_dir: &Path) -> std::io::Result<Self> {
        let path = data_dir.join("spawns.json");
        let specs = if path.exists() {
            let raw = std::fs::read_to_string(&path)?;
            // Only backfill into a well-formed file. A malformed
            // spawns.json keeps the existing "empty list" fallback so
            // the user notices the corruption instead of silently
            // ending up with a one-row file.
            match serde_json::from_str::<Vec<SpawnSpec>>(&raw) {
                Ok(mut loaded) => {
                    let mut changed = false;
                    for id in BACKFILL_IDS {
                        if loaded.iter().any(|s| s.id == *id) {
                            continue;
                        }
                        if let Some((sid, label, cmd, args)) =
                            DEFAULT_SPAWNS.iter().find(|(d_id, ..)| d_id == id)
                        {
                            loaded.push(SpawnSpec {
                                id: (*sid).into(),
                                label: (*label).into(),
                                icon: None,
                                command: (*cmd).into(),
                                args: args.iter().map(|s| (*s).into()).collect(),
                                env: Default::default(),
                                cwd: None,
                                default: false,
                            });
                            changed = true;
                        }
                    }
                    if changed {
                        std::fs::write(
                            &path,
                            serde_json::to_string_pretty(&loaded)
                                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?,
                        )?;
                    }
                    loaded
                }
                Err(_) => Vec::new(),
            }
        } else {
            let seeded = DEFAULT_SPAWNS
                .iter()
                .map(|(id, label, cmd, args)| SpawnSpec {
                    id: (*id).into(),
                    label: (*label).into(),
                    icon: None,
                    command: (*cmd).into(),
                    args: args.iter().map(|s| (*s).into()).collect(),
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

    pub fn list(&self) -> std::io::Result<Vec<SpawnSpec>> {
        Ok(self
            .inner
            .lock()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?
            .clone())
    }

    pub fn upsert(&self, spec: SpawnSpec) -> std::io::Result<()> {
        let mut g = self
            .inner
            .lock()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
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
        let mut g = self
            .inner
            .lock()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
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
        let list = store.list().unwrap();
        assert!(list.iter().any(|s| s.id == "claude" && s.default));
        assert!(list.iter().any(|s| s.id == "codex"));
        assert!(list.iter().any(|s| s.id == "copilot"));
        let hermes = list.iter().find(|s| s.id == "hermes").expect("hermes preset");
        assert_eq!(hermes.command, "hermes");
        assert!(!hermes.default, "hermes must not steal default from claude");
        assert!(dir.path().join("spawns.json").exists());
    }

    #[test]
    fn backfills_hermes_into_legacy_spawns_json() {
        let dir = tempdir().unwrap();
        // Simulate a pre-Hermes install: spawns.json with just Claude.
        let legacy = vec![SpawnSpec {
            id: "claude".into(),
            label: "Claude".into(),
            icon: None,
            command: "claude".into(),
            args: vec![],
            env: Default::default(),
            cwd: None,
            default: true,
        }];
        std::fs::write(
            dir.path().join("spawns.json"),
            serde_json::to_string_pretty(&legacy).unwrap(),
        )
        .unwrap();

        let store = SpawnStore::open(dir.path()).unwrap();
        let list = store.list().unwrap();
        assert!(list.iter().any(|s| s.id == "hermes"), "hermes must be backfilled");
        // Backfill must NOT restore presets the user has deleted.
        assert!(!list.iter().any(|s| s.id == "codex"));
        assert!(!list.iter().any(|s| s.id == "copilot"));
    }

    #[test]
    fn backfill_is_idempotent() {
        let dir = tempdir().unwrap();
        // First open seeds everything (incl. hermes).
        let _ = SpawnStore::open(dir.path()).unwrap();
        let after_first = std::fs::read_to_string(dir.path().join("spawns.json")).unwrap();
        // Second open must not duplicate hermes nor rewrite the file
        // contents (no spurious mtime churn for the user).
        let _ = SpawnStore::open(dir.path()).unwrap();
        let after_second = std::fs::read_to_string(dir.path().join("spawns.json")).unwrap();
        assert_eq!(after_first, after_second);
        let parsed: Vec<SpawnSpec> = serde_json::from_str(&after_second).unwrap();
        assert_eq!(parsed.iter().filter(|s| s.id == "hermes").count(), 1);
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
                env: Default::default(),
                cwd: None,
                default: false,
            })
            .unwrap();
        assert!(store.list().unwrap().iter().any(|s| s.id == "ollama"));

        // reopen — must persist
        let reopened = SpawnStore::open(dir.path()).unwrap();
        assert!(reopened.list().unwrap().iter().any(|s| s.id == "ollama"));

        reopened.delete("ollama").unwrap();
        let reopened2 = SpawnStore::open(dir.path()).unwrap();
        assert!(!reopened2.list().unwrap().iter().any(|s| s.id == "ollama"));
    }

    #[test]
    fn malformed_json_falls_back_to_empty() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("spawns.json"), "{not json").unwrap();
        let store = SpawnStore::open(dir.path()).unwrap();
        assert!(store.list().unwrap().is_empty());
    }
}
