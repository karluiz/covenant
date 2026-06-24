use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CdlcManifest {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub installed: Vec<InstalledRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRef {
    pub name: String,
    pub version: String,
    /// "local:<abs-path>" in Phase 1; "registry.covenant.uno" in Plan 2.
    pub source: String,
    pub sha: String,
    #[serde(default)]
    pub signer: Option<String>,
    pub installed_at: String,
}

/// `skill.toml` inside a package dir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillManifest {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub deps: Vec<String>,
}
