//! macOS: sweep the aging-prone WebKit per-app state at boot, before any
//! webview exists.
//!
//! Field evidence (2026-08-04, the end of the idle-freeze saga — full ledger
//! in main_lag.rs): a months-old WKWebsiteDataStore + caches + HTTPStorages
//! cookies (with orphaned `binarycookies_tmp_*` from old crashes) degraded
//! the installed app until macOS's wake gating made every post-idle tab
//! switch freeze 1.5-2.5s. The SAME binary + config + session state under a
//! fresh bundle id ran at 40ms. Purging the accumulated state cured the
//! installed app in place. This module ships that cure as prevention, so no
//! user's store ever ages into that condition.
//!
//! What is swept every boot, and why it is free:
//!   * `~/Library/WebKit/<id>/WebsiteData/*` EXCEPT `LocalStorage` — the UI
//!     loads over the tauri custom scheme, so network cache, IndexedDB,
//!     service workers and ITP/ResourceLoadStatistics are dead weight for
//!     the main webview. LocalStorage is preserved: it holds real UX prefs
//!     (zoom level, tabbar collapsed, blocks view, seen-version).
//!   * `~/Library/Caches/<id>` — WebKit's network cache; useless for
//!     custom-scheme content, rebuilt on demand.
//!   * `~/Library/HTTPStorages/<id>*` — process cookie storage plus the
//!     orphaned tmp files crashes leave behind. The main webview never needs
//!     durable cookies. Caveat, documented on purpose: the experimental
//!     in-app browser (gated off by default) shares this storage — if that
//!     feature graduates, revisit with a separate WKWebsiteDataStore for
//!     browser webviews instead of exempting cookies here.
//!
//! Must run BEFORE tauri::Builder creates any webview — WebKit reopens these
//! files on webview init.

use std::fs;
use std::path::Path;

/// Entries under WebsiteData that survive the sweep.
const KEEP: &[&str] = &["LocalStorage"];

/// Sweep one app-id's WebKit residue rooted at `library` (~/Library in
/// production; a tempdir in tests). Returns how many entries were removed.
pub fn sweep_webkit_state(library: &Path, bundle_id: &str) -> usize {
    let mut removed = 0;

    // WebsiteData: selective — keep LocalStorage, drop the rest.
    let website_data = library
        .join("WebKit")
        .join(bundle_id)
        .join("WebsiteData");
    if let Ok(entries) = fs::read_dir(&website_data) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let keep = KEEP.iter().any(|k| name.to_string_lossy() == *k);
            if keep {
                continue;
            }
            let path = entry.path();
            let ok = if path.is_dir() {
                fs::remove_dir_all(&path).is_ok()
            } else {
                fs::remove_file(&path).is_ok()
            };
            if ok {
                removed += 1;
            }
        }
    }

    // Network cache: wholesale.
    let caches = library.join("Caches").join(bundle_id);
    if caches.is_dir() && fs::remove_dir_all(&caches).is_ok() {
        removed += 1;
    }

    // Cookie storage + crash-orphaned tmp files.
    let http_storages = library.join("HTTPStorages");
    if let Ok(entries) = fs::read_dir(&http_storages) {
        let prefix = format!("{bundle_id}.");
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == bundle_id || name.starts_with(&prefix) {
                let path = entry.path();
                let ok = if path.is_dir() {
                    fs::remove_dir_all(&path).is_ok()
                } else {
                    fs::remove_file(&path).is_ok()
                };
                if ok {
                    removed += 1;
                }
            }
        }
    }

    removed
}

/// Boot entry point. No-op off macOS (WebView2/WebKitGTK don't share this
/// failure mode, and the paths don't exist there anyway).
pub fn run(bundle_id: &str) {
    #[cfg(target_os = "macos")]
    {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let library = Path::new(&home).join("Library");
        let removed = sweep_webkit_state(&library, bundle_id);
        if removed > 0 {
            tracing::info!(removed, "webkit hygiene sweep completed");
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bundle_id;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().expect("parent")).expect("mkdir");
        fs::write(p, b"x").expect("write");
    }

    #[test]
    fn sweep_keeps_local_storage_and_drops_the_rot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lib = dir.path();
        let id = "com.example.app";
        // WebsiteData: LocalStorage must survive; the rest must go.
        touch(&lib.join(format!("WebKit/{id}/WebsiteData/LocalStorage/file.sqlite3")));
        touch(&lib.join(format!("WebKit/{id}/WebsiteData/IndexedDB/db.sqlite3")));
        touch(&lib.join(format!("WebKit/{id}/WebsiteData/ResourceLoadStatistics/observations.db")));
        // Network cache and cookies (including a crash orphan).
        touch(&lib.join(format!("Caches/{id}/WebKitCache/blob")));
        touch(&lib.join(format!("HTTPStorages/{id}.binarycookies")));
        touch(&lib.join(format!("HTTPStorages/{id}.binarycookies_tmp_1234.dat")));
        // A neighbor app's cookies must be untouched.
        touch(&lib.join("HTTPStorages/com.other.app.binarycookies"));

        let removed = sweep_webkit_state(lib, id);
        assert_eq!(removed, 5);
        assert!(lib
            .join(format!("WebKit/{id}/WebsiteData/LocalStorage/file.sqlite3"))
            .exists());
        assert!(!lib.join(format!("WebKit/{id}/WebsiteData/IndexedDB")).exists());
        assert!(!lib
            .join(format!("WebKit/{id}/WebsiteData/ResourceLoadStatistics"))
            .exists());
        assert!(!lib.join(format!("Caches/{id}")).exists());
        assert!(!lib.join(format!("HTTPStorages/{id}.binarycookies")).exists());
        assert!(!lib
            .join(format!("HTTPStorages/{id}.binarycookies_tmp_1234.dat"))
            .exists());
        assert!(lib.join("HTTPStorages/com.other.app.binarycookies").exists());
    }

    #[test]
    fn sweep_on_a_clean_system_is_a_quiet_noop() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(sweep_webkit_state(dir.path(), "com.example.app"), 0);
    }
}
