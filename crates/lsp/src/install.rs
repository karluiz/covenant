use std::io::Read;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::registry::{ArchiveKind, ServerSpec};
use crate::LspError;

pub fn install_root(data_dir: &Path, spec: &ServerSpec) -> PathBuf {
    data_dir.join("lsp").join(&spec.name).join(&spec.version)
}

pub fn entry_path(data_dir: &Path, spec: &ServerSpec) -> PathBuf {
    install_root(data_dir, spec).join(&spec.cmd)
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
}
