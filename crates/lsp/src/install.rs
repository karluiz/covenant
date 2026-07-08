use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::registry::{ArchiveKind, ServerSpec};
use crate::LspError;

pub fn install_root(data_dir: &Path, spec: &ServerSpec) -> PathBuf {
    data_dir.join("lsp").join(&spec.name).join(&spec.version)
}

/// Path to the runnable entry inside the install dir. For a `Binary`
/// server this is the downloaded executable (`spec.cmd`); for an `Npm`
/// server this is the JS entry point (`npm.bin_entry`) that gets launched
/// with the user's node (resolved separately, see `runtime`).
pub fn entry_path(data_dir: &Path, spec: &ServerSpec) -> PathBuf {
    let root = install_root(data_dir, spec);
    match &spec.npm {
        Some(npm) => root.join(&npm.bin_entry),
        None => root.join(&spec.cmd),
    }
}

pub fn is_installed(data_dir: &Path, spec: &ServerSpec) -> bool {
    entry_path(data_dir, spec).is_file()
}

/// Size in bytes of the installed entry file, or 0 if not installed.
pub fn installed_size(data_dir: &Path, spec: &ServerSpec) -> u64 {
    std::fs::metadata(entry_path(data_dir, spec))
        .map(|m| m.len())
        .unwrap_or(0)
}

/// Delete the installed version directory for `spec`. Idempotent: removing
/// an already-absent install is not an error (matches `is_installed`'s
/// "false means gone" semantics either way).
pub fn remove(data_dir: &Path, spec: &ServerSpec) -> Result<(), LspError> {
    let root = install_root(data_dir, spec);
    match std::fs::remove_dir_all(&root) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Verify sha256 of the raw artifact bytes, unpack, and atomically move
/// into place. Verification happens BEFORE any bytes are unpacked.
pub fn install_from_bytes(
    bytes: &[u8],
    spec: &ServerSpec,
    data_dir: &Path,
) -> Result<PathBuf, LspError> {
    let artifact = spec.artifact()?;
    let actual = format!("{:x}", Sha256::digest(bytes));
    if !actual.eq_ignore_ascii_case(&artifact.sha256) {
        return Err(LspError::ShaMismatch {
            expected: artifact.sha256.clone(),
            actual,
        });
    }

    let root = install_root(data_dir, spec);
    // `root`'s last component is the full version string (layout is
    // `<data_dir>/lsp/<name>/<version>/`), which may itself contain dots
    // (e.g. "4.3.0"). Derive staging from the full file name rather than
    // `with_extension`, which only replaces the last dot-delimited segment
    // and would collide across versions like "4.3.0" and "4.3.1".
    let staging = root.with_file_name(format!("{}.staging", spec.version));
    if let Err(e) = std::fs::remove_dir_all(&staging) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("failed to clean up pre-existing staging directory before install");
        }
    }
    std::fs::create_dir_all(&staging)?;

    match artifact.kind {
        ArchiveKind::Gzip => {
            let mut decoder = flate2::read::GzDecoder::new(bytes);
            let mut out = Vec::new();
            decoder.read_to_end(&mut out)?;
            std::fs::write(staging.join(&spec.cmd), out)?;
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            staging.join(&spec.cmd),
            std::fs::Permissions::from_mode(0o755),
        )?;
    }

    let _ = std::fs::remove_dir_all(&root);
    std::fs::rename(&staging, &root)?;

    // Old versions are superseded — delete them (spec: keep only current).
    if let Some(name_dir) = root.parent() {
        if let Ok(entries) = std::fs::read_dir(name_dir) {
            for e in entries.flatten() {
                if e.path() != root {
                    if let Err(_err) = std::fs::remove_dir_all(e.path()) {
                        tracing::warn!(
                            "failed to clean up superseded LSP server version directory"
                        );
                    }
                }
            }
        }
    }

    Ok(entry_path(data_dir, spec))
}

/// Download the artifact for the current platform and install it.
/// `progress(received, total)` fires per chunk.
pub async fn download(
    spec: &ServerSpec,
    data_dir: &Path,
    progress: impl Fn(u64, Option<u64>),
) -> Result<PathBuf, LspError> {
    use futures_util::StreamExt;
    let artifact = spec.artifact()?;
    let resp = reqwest::get(&artifact.url)
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| LspError::Download(e.to_string()))?;
    let total = resp.content_length();
    let mut received: u64 = 0;
    let mut bytes = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| LspError::Download(e.to_string()))?;
        received += chunk.len() as u64;
        bytes.extend_from_slice(&chunk);
        progress(received, total);
    }
    install_from_bytes(&bytes, spec, data_dir)
}

/// Locate the `npm` executable to invoke directly (never shelled through
/// `sh -lc` with interpolated arguments — package names/versions come from
/// the baked-in registry, but avoiding string interpolation into a shell
/// entirely is simply cleaner and cheaper to reason about).
///
/// npm ships alongside `node` in the same bin dir for every mainstream
/// Node distribution (nvm, volta, fnm, Homebrew, the official installer),
/// so try that first. Fall back to asking the login shell only to resolve
/// the *path* — no untrusted data is interpolated into that command.
fn resolve_npm_path(node_dir: &Path) -> Result<PathBuf, LspError> {
    let candidate = node_dir.join(if cfg!(windows) { "npm.cmd" } else { "npm" });
    if candidate.is_file() {
        return Ok(candidate);
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = std::process::Command::new(&shell)
        .args(["-lc", "command -v npm"])
        .output()
        .map_err(|e| LspError::Spawn(format!("login shell: {e}")))?;
    let path_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || path_str.is_empty() {
        return Err(LspError::Spawn("npm not found on PATH".into()));
    }
    Ok(PathBuf::from(path_str))
}

/// Install an npm-method server (e.g. typescript-language-server) into
/// `<data_dir>/lsp/<name>/<version>/` via `npm install --prefix`.
///
/// `node_dir` is the directory containing the user's resolved `node`
/// binary (see `runtime::detect`); it's used both to locate `npm` and to
/// put on the child's `PATH` so npm's own `node` shebang resolves.
///
/// Package names/versions are passed as separate `Command` args, never
/// interpolated into a shell string, so nothing here is shell-injectable.
/// `progress` fires immediately and then periodically while npm runs —
/// npm install has no meaningful byte-stream progress, unlike the binary
/// download path.
///
/// ponytail: npm handles integrity via package-lock; we trust the user's registry
pub async fn npm_install(
    spec: &ServerSpec,
    data_dir: &Path,
    node_dir: &Path,
    progress: impl Fn(&str),
) -> Result<PathBuf, LspError> {
    let npm_spec = spec
        .npm
        .as_ref()
        .ok_or_else(|| LspError::Spawn(format!("{} has no npm install method", spec.name)))?;

    let root = install_root(data_dir, spec);
    std::fs::create_dir_all(&root)?;

    let npm_path = resolve_npm_path(node_dir)?;

    let mut cmd = tokio::process::Command::new(&npm_path);
    cmd.arg("install").arg("--prefix").arg(&root);
    cmd.args(&npm_spec.packages);

    let mut paths = vec![node_dir.to_path_buf()];
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    let joined_path =
        std::env::join_paths(paths).map_err(|e| LspError::Spawn(format!("PATH: {e}")))?;
    cmd.env("PATH", joined_path);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let child = cmd
        .spawn()
        .map_err(|e| LspError::Spawn(format!("npm install: {e}")))?;

    progress("installing…");
    let fut = child.wait_with_output();
    tokio::pin!(fut);
    let mut ticker = tokio::time::interval(std::time::Duration::from_millis(500));
    ticker.tick().await; // first tick fires immediately; already reported once above
    let output = loop {
        tokio::select! {
            _ = ticker.tick() => progress("installing…"),
            res = &mut fut => break res.map_err(|e| LspError::Spawn(format!("npm install: {e}")))?,
        }
    };

    if !output.status.success() {
        return Err(LspError::Spawn(format!(
            "npm install failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    Ok(entry_path(data_dir, spec))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{ArchiveKind, Artifact, ServerSpec};
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::io::Write;

    fn gzip(data: &[u8]) -> Vec<u8> {
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(data).unwrap();
        enc.finish().unwrap()
    }

    fn spec_with_sha(sha256: &str) -> ServerSpec {
        spec_with_sha_and_version(sha256, "1.0")
    }

    fn spec_with_sha_and_version(sha256: &str, version: &str) -> ServerSpec {
        let mut artifacts = HashMap::new();
        artifacts.insert(
            crate::registry::platform_key().to_string(),
            Artifact {
                url: "https://example.invalid/x.gz".into(),
                sha256: sha256.into(),
                kind: ArchiveKind::Gzip,
            },
        );
        ServerSpec {
            language: "rust".into(),
            name: "fake-ra".into(),
            version: version.into(),
            cmd: "fake-ra".into(),
            args: vec![],
            root_markers: vec!["Cargo.toml".into()],
            approx_size_mb: 1,
            artifacts,
            runtime: None,
            npm: None,
        }
    }

    fn npm_spec_with_version(version: &str) -> ServerSpec {
        ServerSpec {
            language: "typescript".into(),
            name: "fake-ts-ls".into(),
            version: version.into(),
            cmd: "fake-ts-ls".into(),
            args: vec![],
            root_markers: vec!["package.json".into()],
            approx_size_mb: 1,
            artifacts: HashMap::new(),
            runtime: Some(crate::registry::RuntimeSpec {
                name: "node".into(),
                min_version: "18".into(),
                version_arg: "--version".into(),
            }),
            npm: Some(crate::registry::NpmSpec {
                packages: vec!["fake-ts-ls@1.2.3".into()],
                bin_entry: "node_modules/fake-ts-ls/lib/cli.mjs".into(),
            }),
        }
    }

    #[test]
    fn installs_verified_gzip_and_marks_executable() {
        let dir = tempfile::tempdir().unwrap();
        let payload = b"#!/bin/sh\necho fake\n";
        let gz = gzip(payload);
        let sha = format!("{:x}", Sha256::digest(&gz));
        let spec = spec_with_sha(&sha);

        let entry = install_from_bytes(&gz, &spec, dir.path()).unwrap();
        assert_eq!(entry, dir.path().join("lsp/fake-ra/1.0/fake-ra"));
        assert_eq!(std::fs::read(&entry).unwrap(), payload);
        assert!(is_installed(dir.path(), &spec));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&entry).unwrap().permissions().mode();
            assert_ne!(mode & 0o111, 0, "entry must be executable");
        }
    }

    #[test]
    fn rejects_sha_mismatch_and_installs_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let gz = gzip(b"payload");
        let spec = spec_with_sha(&"0".repeat(64));
        let err = install_from_bytes(&gz, &spec, dir.path()).unwrap_err();
        assert!(matches!(err, crate::LspError::ShaMismatch { .. }));
        assert!(!is_installed(dir.path(), &spec));
    }

    #[test]
    fn not_installed_when_entry_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!is_installed(dir.path(), &spec_with_sha(&"0".repeat(64))));
    }

    #[test]
    fn dotted_version_upgrade_stages_uniquely_and_gcs_old_version() {
        // Regression test: `root.with_extension("staging")` only replaces
        // the last dot-delimited segment of the path, so for a dotted
        // version like "4.3.0" it produced a staging dir "4.3.staging" that
        // would collide with a later "4.3.1" install. Installing two dotted
        // versions of the same server back-to-back exercises both the
        // staging-path derivation and the old-version GC sweep.
        let dir = tempfile::tempdir().unwrap();

        let payload_old = b"#!/bin/sh\necho old\n";
        let gz_old = gzip(payload_old);
        let sha_old = format!("{:x}", Sha256::digest(&gz_old));
        let spec_old = spec_with_sha_and_version(&sha_old, "4.3.0");

        let payload_new = b"#!/bin/sh\necho new\n";
        let gz_new = gzip(payload_new);
        let sha_new = format!("{:x}", Sha256::digest(&gz_new));
        let spec_new = spec_with_sha_and_version(&sha_new, "4.3.1");

        let entry_old = install_from_bytes(&gz_old, &spec_old, dir.path()).unwrap();
        assert_eq!(std::fs::read(&entry_old).unwrap(), payload_old);
        assert!(is_installed(dir.path(), &spec_old));

        let entry_new = install_from_bytes(&gz_new, &spec_new, dir.path()).unwrap();
        assert_eq!(std::fs::read(&entry_new).unwrap(), payload_new);

        // Old dotted-version directory must be gone (old-version GC), and
        // the new dotted version must report installed.
        assert!(
            !install_root(dir.path(), &spec_old).exists(),
            "old version directory should have been GC'd"
        );
        assert!(is_installed(dir.path(), &spec_new));
    }

    #[test]
    fn installed_size_is_zero_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let spec = spec_with_sha(&"0".repeat(64));
        assert_eq!(installed_size(dir.path(), &spec), 0);
    }

    #[test]
    fn installed_size_matches_entry_file_len_after_install() {
        let dir = tempfile::tempdir().unwrap();
        let payload = b"#!/bin/sh\necho fake, somewhat longer payload\n";
        let gz = gzip(payload);
        let sha = format!("{:x}", Sha256::digest(&gz));
        let spec = spec_with_sha(&sha);

        install_from_bytes(&gz, &spec, dir.path()).unwrap();
        assert_eq!(installed_size(dir.path(), &spec), payload.len() as u64);
    }

    #[test]
    fn remove_deletes_version_dir_and_is_installed_false_after() {
        let dir = tempfile::tempdir().unwrap();
        let payload = b"#!/bin/sh\necho fake\n";
        let gz = gzip(payload);
        let sha = format!("{:x}", Sha256::digest(&gz));
        let spec = spec_with_sha(&sha);

        install_from_bytes(&gz, &spec, dir.path()).unwrap();
        assert!(is_installed(dir.path(), &spec));

        remove(dir.path(), &spec).unwrap();
        assert!(!is_installed(dir.path(), &spec));
        assert!(!install_root(dir.path(), &spec).exists());
    }

    #[test]
    fn remove_on_absent_install_is_a_noop_ok() {
        let dir = tempfile::tempdir().unwrap();
        let spec = spec_with_sha(&"0".repeat(64));
        assert!(remove(dir.path(), &spec).is_ok());
    }

    #[test]
    fn npm_spec_entry_path_resolves_to_bin_entry_under_install_root() {
        let dir = tempfile::tempdir().unwrap();
        let spec = npm_spec_with_version("1.2.3");

        let expected = dir
            .path()
            .join("lsp/fake-ts-ls/1.2.3/node_modules/fake-ts-ls/lib/cli.mjs");
        assert_eq!(entry_path(dir.path(), &spec), expected);
        assert_eq!(
            install_root(dir.path(), &spec),
            dir.path().join("lsp/fake-ts-ls/1.2.3")
        );
    }

    #[test]
    fn npm_spec_is_installed_false_until_bin_entry_exists() {
        let dir = tempfile::tempdir().unwrap();
        let spec = npm_spec_with_version("1.2.3");

        assert!(!is_installed(dir.path(), &spec));

        let entry = entry_path(dir.path(), &spec);
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, b"#!/usr/bin/env node\n").unwrap();

        assert!(is_installed(dir.path(), &spec));
        assert_eq!(
            installed_size(dir.path(), &spec),
            entry.metadata().unwrap().len()
        );
    }

    #[test]
    fn npm_spec_remove_deletes_version_dir() {
        let dir = tempfile::tempdir().unwrap();
        let spec = npm_spec_with_version("1.2.3");
        let entry = entry_path(dir.path(), &spec);
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, b"noop").unwrap();
        assert!(is_installed(dir.path(), &spec));

        remove(dir.path(), &spec).unwrap();
        assert!(!is_installed(dir.path(), &spec));
        assert!(!install_root(dir.path(), &spec).exists());
    }
}
