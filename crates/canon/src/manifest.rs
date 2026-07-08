use crate::types::CanonManifest;
use crate::CanonError;
use std::path::{Path, PathBuf};

pub fn canon_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".covenant/canon")
}

pub fn read_manifest(repo_root: &Path) -> Result<CanonManifest, CanonError> {
    let path = canon_dir(repo_root).join("canon.toml");
    if !path.exists() {
        return Ok(CanonManifest::default());
    }
    let text = std::fs::read_to_string(&path)?;
    Ok(toml::from_str(&text)?)
}

pub fn write_manifest(repo_root: &Path, m: &CanonManifest) -> Result<(), CanonError> {
    let dir = canon_dir(repo_root);
    std::fs::create_dir_all(&dir)?;
    let text = toml::to_string_pretty(m)?;
    std::fs::write(dir.join("canon.toml"), text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::InstalledRef;

    #[test]
    fn roundtrip_manifest() {
        let tmp = std::env::temp_dir().join(format!("canon-rt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let m = CanonManifest {
            version: 1,
            installed: vec![InstalledRef {
                name: "kyc-peru".into(),
                version: "2.1.0".into(),
                source: "local:/tmp/kyc".into(),
                sha: "abc123".into(),
                signer: Some("github:mibanco".into()),
                installed_at: "2026-06-24T00:00:00Z".into(),
            }],
        };
        write_manifest(&tmp, &m).unwrap();
        let back = read_manifest(&tmp).unwrap();
        assert_eq!(back.installed.len(), 1);
        assert_eq!(back.installed[0].name, "kyc-peru");
        assert_eq!(back.version, 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_manifest_is_default() {
        let tmp = std::env::temp_dir().join("canon-missing-does-not-exist-xyz");
        let m = read_manifest(&tmp).unwrap();
        assert_eq!(m.version, 0);
        assert!(m.installed.is_empty());
    }
}
