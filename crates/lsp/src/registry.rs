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
    Zip,
    TarGz,
}

/// A runtime (e.g. Node.js) a server needs on the user's machine. Mirrors
/// `runtime::RuntimeReq`'s fields so the manifest can describe the
/// requirement without this crate's registry module depending on how the
/// runtime is actually resolved.
#[derive(Debug, Clone, Deserialize)]
pub struct RuntimeSpec {
    pub name: String,
    pub min_version: String,
    pub version_arg: String,
}

impl RuntimeSpec {
    pub fn as_runtime_req(&self) -> crate::runtime::RuntimeReq {
        crate::runtime::RuntimeReq {
            name: self.name.clone(),
            min_version: self.min_version.clone(),
            version_arg: self.version_arg.clone(),
        }
    }
}

/// How to fetch a server that installs via `npm install` rather than a
/// downloaded binary artifact.
#[derive(Debug, Clone, Deserialize)]
pub struct NpmSpec {
    pub packages: Vec<String>,
    /// JS entry point relative to the install dir, e.g.
    /// "node_modules/typescript-language-server/lib/cli.mjs".
    pub bin_entry: String,
}

/// How a server's files are obtained.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallKind {
    /// A single sha256-verified gzipped binary (rust-analyzer today).
    Binary,
    /// `npm install` into the version dir; launched via the user's node.
    Npm,
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
    #[serde(default)]
    pub artifacts: HashMap<String, Artifact>,
    #[serde(default)]
    pub runtime: Option<RuntimeSpec>,
    #[serde(default)]
    pub npm: Option<NpmSpec>,
    /// Entry point relative to `install_root`, for a binary artifact whose
    /// runnable file is nested inside the unpacked archive (e.g. the Roslyn
    /// nupkg's payload lives under `content/LanguageServer/<rid>/...`).
    /// `None` means the entry is `install_root.join(&cmd)` directly (the
    /// rust-analyzer case: a flat gzipped binary with no wrapping archive
    /// structure).
    #[serde(default)]
    pub entry_subpath: Option<String>,
    /// Config dir to copy alongside the entry for a JVM launcher (e.g.
    /// jdtls's `config_mac_arm`, which the equinox launcher reads via
    /// `-configuration`). `None` for every non-jdtls server. Declared here
    /// for the manifest to carry it through parsing; consumed by the
    /// server-spawn path (P5 task 2), not by `install`/`registry` directly.
    #[serde(default)]
    pub config_subpath: Option<String>,
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

/// All server specs baked into the manifest, for management UIs that need
/// to enumerate every language rather than look one up.
pub fn all_specs() -> &'static [ServerSpec] {
    &manifest().servers
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

    /// Npm iff the manifest entry declares an `npm` install method;
    /// otherwise the server ships as a downloaded binary artifact.
    pub fn install_kind(&self) -> InstallKind {
        if self.npm.is_some() {
            InstallKind::Npm
        } else {
            InstallKind::Binary
        }
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
    #[cfg_attr(not(target_os = "macos"), ignore)]
    fn current_platform_has_artifact() {
        let spec = spec_for_language("rust").unwrap();
        let art = spec.artifact().expect("artifact for current platform");
        assert!(art.url.starts_with("https://"));
        assert_eq!(art.sha256.len(), 64);
    }

    #[test]
    fn rust_entry_is_binary_install_kind() {
        let spec = spec_for_language("rust").unwrap();
        assert_eq!(spec.install_kind(), InstallKind::Binary);
        assert!(spec.npm.is_none());
        assert!(spec.runtime.is_none());
    }

    #[test]
    fn csharp_entry_is_zip_with_entry_subpath_and_runtime() {
        let spec = spec_for_language("csharp").expect("csharp in manifest");
        assert_eq!(spec.name, "roslyn-language-server");
        assert_eq!(spec.install_kind(), InstallKind::Binary);
        assert!(spec.npm.is_none());

        let entry_subpath = spec
            .entry_subpath
            .as_ref()
            .expect("csharp entry has entry_subpath");
        assert_eq!(
            entry_subpath,
            "content/LanguageServer/osx-arm64/Microsoft.CodeAnalysis.LanguageServer"
        );

        let runtime = spec
            .runtime
            .as_ref()
            .expect("csharp entry has runtime spec");
        assert_eq!(runtime.name, "dotnet");

        assert!(spec.root_markers.contains(&"*.sln".to_string()));
    }

    #[test]
    #[cfg_attr(not(all(target_os = "macos", target_arch = "aarch64")), ignore)]
    fn csharp_artifact_is_zip_kind() {
        let spec = spec_for_language("csharp").unwrap();
        let art = spec.artifact().expect("artifact for current platform");
        assert_eq!(art.kind, ArchiveKind::Zip);
        assert_eq!(art.sha256.len(), 64);
    }

    #[test]
    fn typescript_entry_has_npm_and_runtime() {
        let spec = spec_for_language("typescript").expect("typescript in manifest");
        assert_eq!(spec.name, "typescript-language-server");
        assert_eq!(spec.install_kind(), InstallKind::Npm);

        let npm = spec.npm.as_ref().expect("typescript entry has npm spec");
        assert!(!npm.packages.is_empty());
        assert!(npm
            .packages
            .iter()
            .any(|p| p.starts_with("typescript-language-server@")));
        assert_eq!(
            npm.bin_entry,
            "node_modules/typescript-language-server/lib/cli.mjs"
        );

        let runtime = spec
            .runtime
            .as_ref()
            .expect("typescript entry has runtime spec");
        assert_eq!(runtime.name, "node");
    }

    #[test]
    fn java_entry_is_targz_with_entry_and_config_subpath_and_runtime() {
        let spec = spec_for_language("java").expect("java in manifest");
        assert_eq!(spec.name, "jdtls");
        assert_eq!(spec.install_kind(), InstallKind::Binary);
        assert!(spec.npm.is_none());

        let entry_subpath = spec
            .entry_subpath
            .as_ref()
            .expect("java entry has entry_subpath");
        assert_eq!(
            entry_subpath,
            "plugins/org.eclipse.equinox.launcher_1.7.200.v20260619-2039.jar"
        );

        let config_subpath = spec
            .config_subpath
            .as_ref()
            .expect("java entry has config_subpath");
        assert_eq!(config_subpath, "config_mac_arm");

        let runtime = spec.runtime.as_ref().expect("java entry has runtime spec");
        assert_eq!(runtime.name, "java");
        assert_eq!(runtime.min_version, "21");

        assert!(spec.root_markers.contains(&"pom.xml".to_string()));
    }

    #[test]
    #[cfg_attr(not(all(target_os = "macos", target_arch = "aarch64")), ignore)]
    fn java_artifact_is_targz_kind() {
        let spec = spec_for_language("java").unwrap();
        let art = spec.artifact().expect("artifact for current platform");
        assert_eq!(art.kind, ArchiveKind::TarGz);
        assert_eq!(art.sha256.len(), 64);
    }

    /// Additive constraint: rust/TS/C# entries must still parse and keep
    /// their existing shape after adding TarGz + config_subpath.
    #[test]
    fn preexisting_entries_unaffected_by_targz_addition() {
        let rust = spec_for_language("rust").unwrap();
        assert!(rust.config_subpath.is_none());
        let csharp = spec_for_language("csharp").unwrap();
        assert!(csharp.config_subpath.is_none());
        let ts = spec_for_language("typescript").unwrap();
        assert!(ts.config_subpath.is_none());
    }
}
