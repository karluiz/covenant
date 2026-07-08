use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::LspError;

#[derive(Debug, Clone, Deserialize)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
    pub kind: ArchiveKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveKind {
    Gzip,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerSpec {
    pub language: String,
    pub name: String,
    pub version: String,
    /// Entry point relative to the install dir.
    pub cmd: String,
    pub args: Vec<String>,
    pub root_markers: Vec<String>,
    pub approx_size_mb: u32,
    pub artifacts: HashMap<String, Artifact>,
}

#[derive(Debug, Deserialize)]
struct Manifest {
    servers: Vec<ServerSpec>,
}

fn manifest() -> &'static Manifest {
    static M: OnceLock<Manifest> = OnceLock::new();
    M.get_or_init(|| {
        serde_json::from_str(include_str!("../servers.json"))
            .expect("servers.json is baked in and must parse")
    })
}

pub fn spec_for_language(lang: &str) -> Result<&'static ServerSpec, LspError> {
    manifest()
        .servers
        .iter()
        .find(|s| s.language == lang)
        .ok_or_else(|| LspError::UnknownLanguage(lang.to_string()))
}

pub fn platform_key() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos-aarch64",
        ("macos", "x86_64") => "macos-x86_64",
        ("windows", _) => "windows-x86_64",
        (_, "aarch64") => "linux-aarch64",
        _ => "linux-x86_64",
    }
}

impl ServerSpec {
    pub fn artifact(&self) -> Result<&Artifact, LspError> {
        let key = platform_key();
        self.artifacts
            .get(key)
            .ok_or_else(|| LspError::NoArtifact(key.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_parses_and_has_rust() {
        let spec = spec_for_language("rust").expect("rust in manifest");
        assert_eq!(spec.name, "rust-analyzer");
        assert!(spec.root_markers.contains(&"Cargo.toml".to_string()));
    }

    #[test]
    fn unknown_language_errors() {
        assert!(spec_for_language("cobol").is_err());
    }

    #[test]
    fn current_platform_has_artifact() {
        let spec = spec_for_language("rust").unwrap();
        let art = spec.artifact().expect("artifact for current platform");
        assert!(art.url.starts_with("https://"));
        assert_eq!(art.sha256.len(), 64);
    }
}
