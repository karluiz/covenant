use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use karl_lsp::registry::InstallKind;
use karl_lsp::{install, registry, root, runtime, server::LspServer, LspError};

/// One server per workspace root. Both maps live behind a single mutex so
/// `lsp_start` and `lsp_stop` can never acquire them in opposite orders
/// (that used to be a two-mutex AB/BA deadlock).
#[derive(Default)]
struct LspRegistry {
    servers: HashMap<u64, LspServer>,
    /// (language, root) → server_id
    by_key: HashMap<(String, String), u64>,
}

pub struct LspState {
    data_dir: PathBuf,
    next_id: AtomicU64,
    registry: Mutex<LspRegistry>,
}

impl LspState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            next_id: AtomicU64::new(1),
            registry: Mutex::new(LspRegistry::default()),
        }
    }
}

/// Populated on `LspServerStatus` when a server that declares a `runtime`
/// requirement (e.g. node for npm-method servers, or dotnet for a
/// binary-with-runtime server like Roslyn/csharp) needs it and it isn't
/// present. `found` is `None` when the runtime binary wasn't found at all,
/// `Some(version)` when it was found but failed the minimum-version check.
#[derive(Debug, Clone, Serialize)]
pub struct RuntimeMissingInfo {
    pub name: String,
    pub min: String,
    pub found: Option<String>,
    pub suggestion: Option<RuntimeSuggestionDto>,
}

/// Actionable fix suggestion for a missing/mismatched runtime, mirrors
/// `karl_lsp::runtime::RuntimeSuggestion` across the Tauri IPC boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuntimeSuggestionDto {
    OnDiskNotOnPath { version: String, dir: String },
    Install { hint: String },
}

impl From<karl_lsp::runtime::RuntimeSuggestion> for RuntimeSuggestionDto {
    fn from(s: karl_lsp::runtime::RuntimeSuggestion) -> Self {
        match s {
            karl_lsp::runtime::RuntimeSuggestion::OnDiskNotOnPath { version, dir } => {
                RuntimeSuggestionDto::OnDiskNotOnPath { version, dir }
            }
            karl_lsp::runtime::RuntimeSuggestion::Install { hint } => {
                RuntimeSuggestionDto::Install { hint }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LspServerStatus {
    pub language: String,
    pub name: String,
    pub version: String,
    pub installed: bool,
    pub approx_size_mb: u32,
    /// `Some` only for servers that declare a `runtime` requirement in the
    /// manifest (npm-method servers like typescript, or a binary-with-runtime
    /// server like Roslyn/csharp) whose runtime dependency is missing or too
    /// old. Plain binary servers with no runtime (rust-analyzer) always
    /// report `None` here.
    pub runtime_missing: Option<RuntimeMissingInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspStartResult {
    pub server_id: u64,
    pub root: String,
    /// Absolute path to the `.sln`/`.slnx` (falling back to the first
    /// `.csproj`) found under `root` (see `find_solution_path`), for
    /// servers that need a post-initialize project-load handshake
    /// (currently csharp/Roslyn only — cross-file definitions never resolve
    /// without it). `None` for every other language.
    pub solution_path: Option<String>,
    /// Which handshake `solution_path` needs: `"solution"` (empirically
    /// verified `solution/open {"solution": "<uri>"}` — see task-3-report)
    /// for a `.sln`/`.slnx`, `"project"` (empirically verified
    /// `project/open {"projects": ["<uri>"]}` — see task-4-report) for a
    /// bare `.csproj` with no solution file. `None` iff `solution_path` is
    /// `None`.
    pub solution_kind: Option<String>,
}

/// Directory names never worth descending into while searching for a
/// solution/project file: build output, dependency caches, and VCS/hidden
/// dirs. Checked by exact name; hidden dirs (leading `.`) are skipped
/// separately in `find_first_bounded`.
const SKIP_DIRS: &[&str] = &["bin", "obj", "node_modules", ".git"];

/// Depth bound for the recursive descent below. `root` itself is depth 0;
/// `root/src/App.csproj` is found at depth 1. Kept small since this walks
/// on every `lsp_start` call — a repo with a `.sln`/`.csproj` more than a
/// few directories below `root` is not a layout we need to support.
const MAX_DESCENT_DEPTH: u32 = 3;

/// First `root` entry (direct children only, sorted by name for a
/// deterministic result) whose filename ends with `suffix`.
fn find_direct_child(root: &Path, suffix: &str) -> Option<PathBuf> {
    let mut entries: Vec<_> = std::fs::read_dir(root).ok()?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    entries.into_iter().find_map(|entry| {
        let name = entry.file_name();
        let name = name.to_str()?;
        name.ends_with(suffix).then(|| root.join(name))
    })
}

/// Bounded, depth-first search under (but not including) `dir` for the
/// first file whose name ends with `suffix`. Directory entries are sorted
/// so the result is stable across filesystems/platforms rather than
/// dependent on readdir order. Skips `SKIP_DIRS` and hidden directories;
/// stops descending past `MAX_DESCENT_DEPTH`.
fn find_first_bounded(dir: &Path, suffix: &str, depth: u32) -> Option<PathBuf> {
    if depth > MAX_DESCENT_DEPTH {
        return None;
    }
    let mut entries: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().collect();
    entries.sort_by_key(|e| e.file_name());

    // Files at this level first, so a shallower match always wins over one
    // found by descending into an earlier sibling directory.
    for entry in &entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if entry.path().is_file() && name.ends_with(suffix) {
            return Some(entry.path());
        }
    }
    for entry in &entries {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !entry.path().is_dir() {
            continue;
        }
        if name.starts_with('.') || SKIP_DIRS.contains(&name) {
            continue;
        }
        if let Some(found) = find_first_bounded(&entry.path(), suffix, depth + 1) {
            return Some(found);
        }
    }
    None
}

/// A `.sln`/`.slnx` (else a `.csproj`), for languages whose server needs a
/// post-initialize project-load handshake (currently csharp/Roslyn only).
/// `root` is the outermost ancestor `detect_root` found containing one of
/// `spec.root_markers` — for csharp that includes `global.json`, which is
/// commonly the *only* thing at the repo root, with the actual
/// `.sln`/`.csproj` nested under `src/` or similar. So this does not stop
/// at `root`'s direct children: it prefers a `.sln` directly in `root`,
/// then falls back to a bounded recursive descent (depth `MAX_DESCENT_DEPTH`,
/// skipping `SKIP_DIRS`/hidden dirs) for the first `.sln`, then repeats the
/// same direct/descent search for `.csproj`. The returned kind string
/// (`"solution"` / `"project"`) tells the caller which handshake to send —
/// `solution/open` and `project/open` are NOT interchangeable: Roslyn's
/// `solution/open` expects an actual `.sln`/`.slnx` and silently loads
/// nothing for a bare `.csproj` (verified empirically — see
/// task-4-report.md). Logs a warning (not silent) when nothing is found at
/// all, since that means no handshake ever fires and cross-file resolution
/// silently degrades.
fn find_solution_path(root: &Path, language: &str) -> Option<(String, &'static str)> {
    if language != "csharp" {
        return None;
    }
    let sln = find_direct_child(root, ".sln")
        .or_else(|| find_direct_child(root, ".slnx"))
        .or_else(|| find_first_bounded(root, ".sln", 1))
        .or_else(|| find_first_bounded(root, ".slnx", 1));
    if let Some(p) = sln {
        return Some((p.to_string_lossy().to_string(), "solution"));
    }

    let proj =
        find_direct_child(root, ".csproj").or_else(|| find_first_bounded(root, ".csproj", 1));
    if let Some(p) = proj {
        return Some((p.to_string_lossy().to_string(), "project"));
    }

    tracing::warn!(
        root = %root.to_string_lossy(),
        "csharp: no .sln/.csproj found under root; no project-load handshake will fire, cross-file resolution degraded"
    );
    None
}

#[cfg(test)]
mod find_solution_path_tests {
    use super::*;
    use std::fs;

    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "").unwrap();
    }

    #[test]
    fn global_json_at_root_finds_nested_csproj() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("global.json"));
        touch(&t.path().join("src/App.csproj"));
        let found = find_solution_path(t.path(), "csharp");
        assert_eq!(
            found,
            Some((
                t.path()
                    .join("src/App.csproj")
                    .to_string_lossy()
                    .to_string(),
                "project"
            ))
        );
    }

    #[test]
    fn prefers_sln_directly_in_root() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("Foo.sln"));
        touch(&t.path().join("src/App.csproj"));
        let found = find_solution_path(t.path(), "csharp");
        assert_eq!(
            found,
            Some((
                t.path().join("Foo.sln").to_string_lossy().to_string(),
                "solution"
            ))
        );
    }

    #[test]
    fn empty_dir_returns_none() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(find_solution_path(t.path(), "csharp"), None);
    }

    #[test]
    fn non_csharp_short_circuits_without_touching_disk() {
        // A nonexistent path would fail any read_dir call; confirms the
        // language check returns None before ever inspecting `root`.
        let bogus = Path::new("/does/not/exist/at/all");
        assert_eq!(find_solution_path(bogus, "rust"), None);
    }

    #[test]
    fn skips_bin_obj_and_hidden_dirs() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("global.json"));
        touch(&t.path().join("bin/Decoy.csproj"));
        touch(&t.path().join("obj/Decoy2.csproj"));
        touch(&t.path().join(".hidden/Decoy3.csproj"));
        touch(&t.path().join("src/App.csproj"));
        let found = find_solution_path(t.path(), "csharp");
        assert_eq!(
            found,
            Some((
                t.path()
                    .join("src/App.csproj")
                    .to_string_lossy()
                    .to_string(),
                "project"
            ))
        );
    }

    #[test]
    fn descent_beyond_max_depth_is_not_found() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("global.json"));
        // depth: a/b/c/d/Too.csproj is 4 levels below root — beyond
        // MAX_DESCENT_DEPTH (3) — so it must not be found.
        touch(&t.path().join("a/b/c/d/Too.csproj"));
        assert_eq!(find_solution_path(t.path(), "csharp"), None);
    }
}

#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

/// Progress payload for the npm-install path (no byte-stream progress —
/// `npm_install` fires this periodically with a human-readable status
/// instead). Emitted on the same `lsp://download/{language}` topic as
/// `DownloadProgress`; consumers distinguish by install kind.
#[derive(Debug, Clone, Serialize)]
struct NpmInstallProgress {
    message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspInstalledServer {
    pub language: String,
    pub name: String,
    pub version: String,
    pub size_bytes: u64,
    pub installed: bool,
}

#[tauri::command]
pub fn lsp_server_status(
    state: State<'_, LspState>,
    language: String,
) -> Result<LspServerStatus, String> {
    let spec = registry::spec_for_language(&language).map_err(|e| e.to_string())?;

    let mut installed = install::is_installed(&state.data_dir, spec);
    let mut runtime_missing = None;

    // Runtime gate is orthogonal to install_kind: an npm-method server
    // (typescript) and a binary-with-runtime server (csharp/Roslyn, whose
    // zip download is unrelated to `dotnet`) both declare `spec.runtime`
    // and must be gated the same way.
    if let Some(rt) = &spec.runtime {
        if let Err(e) = runtime::detect(&rt.as_runtime_req()) {
            match e {
                LspError::RuntimeMissing { name, min, found } => {
                    let suggestion = Some(runtime::suggest_fix(&rt.as_runtime_req()).into());
                    runtime_missing = Some(RuntimeMissingInfo {
                        name,
                        min,
                        found,
                        suggestion,
                    });
                    installed = false;
                }
                other => return Err(other.to_string()),
            }
        }
    }

    Ok(LspServerStatus {
        language,
        name: spec.name.clone(),
        version: spec.version.clone(),
        installed,
        approx_size_mb: spec.approx_size_mb,
        runtime_missing,
    })
}

#[tauri::command]
pub async fn lsp_download_server(
    app: AppHandle,
    state: State<'_, LspState>,
    language: String,
) -> Result<(), String> {
    let spec = registry::spec_for_language(&language).map_err(|e| e.to_string())?;
    let topic = format!("lsp://download/{language}");

    // Runtime gate is orthogonal to install_kind: csharp (Binary — a zip
    // download of the Roslyn nupkg, not `npm install`) still declares
    // `spec.runtime` (dotnet) and must be gated the same as an npm-method
    // server. Resolve up front so both branches can fail fast on a missing
    // runtime instead of downloading first.
    let node_dir = if let Some(rt) = &spec.runtime {
        let resolved = runtime::detect(&rt.as_runtime_req()).map_err(|e| e.to_string())?;
        // Node's PARENT DIR (not the binary itself) so npm_install's
        // resolve_npm_path fast path finds `npm` next to it instead of
        // falling back to a login-shell lookup. Unused for the Binary
        // branch below (csharp/dotnet) — only npm_install needs it.
        let dir = resolved
            .path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| {
                format!(
                    "cannot resolve parent directory of {}",
                    resolved.path.display()
                )
            })?;
        Some(dir)
    } else {
        None
    };

    match spec.install_kind() {
        InstallKind::Binary => {
            install::download(spec, &state.data_dir, |received, total| {
                let _ = app.emit(&topic, DownloadProgress { received, total });
            })
            .await
            .map_err(|e| e.to_string())?;
        }
        InstallKind::Npm => {
            let node_dir = node_dir
                .ok_or_else(|| format!("{} is an npm server but has no runtime spec", spec.name))?;
            install::npm_install(spec, &state.data_dir, &node_dir, |message| {
                let _ = app.emit(
                    &topic,
                    NpmInstallProgress {
                        message: message.to_string(),
                    },
                );
            })
            .await
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn lsp_list_installed(state: State<'_, LspState>) -> Result<Vec<LspInstalledServer>, String> {
    let servers = registry::all_specs()
        .iter()
        .map(|spec| LspInstalledServer {
            language: spec.language.clone(),
            name: spec.name.clone(),
            version: spec.version.clone(),
            size_bytes: install::installed_size(&state.data_dir, spec),
            installed: install::is_installed(&state.data_dir, spec),
        })
        .collect();
    Ok(servers)
}

#[tauri::command]
pub fn lsp_delete_server(state: State<'_, LspState>, language: String) -> Result<(), String> {
    let spec = registry::spec_for_language(&language).map_err(|e| e.to_string())?;
    install::remove(&state.data_dir, spec).map_err(|e| e.to_string())?;
    tracing::info!(language = %language, "lsp server deleted");
    Ok(())
}

/// Recursively copy every file and subdirectory under `src` into `dst`,
/// creating `dst` (and any intermediate directories) as needed. `dst` need
/// not exist yet.
///
/// Used to materialize a WRITABLE copy of jdtls's `-configuration` dir: the
/// equinox launcher extracts a JNI helper library into
/// `<configuration>/org.eclipse.equinox.launcher/` on every startup, and the
/// shared install dir (`install_root`) must stay read-only/shared across
/// server instances — pointing `-configuration` directly at it crashes with
/// `AccessDeniedException` (verified empirically, see
/// `.superpowers/lsp-p5-research.md` §3.1). Symlinks are skipped; none are
/// expected inside the jdtls tar.gz config dirs.
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let dst_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod copy_dir_all_tests {
    use super::*;
    use std::fs;

    #[test]
    fn copies_nested_files_and_preserves_content() {
        let src = tempfile::tempdir().unwrap();
        fs::write(src.path().join("top.txt"), b"top-level").unwrap();
        fs::create_dir_all(src.path().join("nested/deeper")).unwrap();
        fs::write(src.path().join("nested/mid.txt"), b"mid-level").unwrap();
        fs::write(src.path().join("nested/deeper/leaf.txt"), b"leaf-level").unwrap();

        let dst_parent = tempfile::tempdir().unwrap();
        // Deliberately a path that does not exist yet, to confirm
        // copy_dir_all creates it (and intermediate dirs) itself.
        let dst = dst_parent.path().join("copy-dest");

        copy_dir_all(src.path(), &dst).unwrap();

        assert_eq!(fs::read(dst.join("top.txt")).unwrap(), b"top-level");
        assert_eq!(fs::read(dst.join("nested/mid.txt")).unwrap(), b"mid-level");
        assert_eq!(
            fs::read(dst.join("nested/deeper/leaf.txt")).unwrap(),
            b"leaf-level"
        );
    }

    #[test]
    fn is_a_real_copy_not_a_reference() {
        let src = tempfile::tempdir().unwrap();
        fs::write(src.path().join("f.txt"), b"original").unwrap();
        let dst_parent = tempfile::tempdir().unwrap();
        let dst = dst_parent.path().join("copy-dest");

        copy_dir_all(src.path(), &dst).unwrap();
        fs::write(src.path().join("f.txt"), b"mutated-after-copy").unwrap();

        assert_eq!(
            fs::read(dst.join("f.txt")).unwrap(),
            b"original",
            "destination must be an independent copy, not linked to src"
        );
    }
}

#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    state: State<'_, LspState>,
    language: String,
    file_path: String,
) -> Result<LspStartResult, String> {
    let spec = registry::spec_for_language(&language).map_err(|e| e.to_string())?;
    if !install::is_installed(&state.data_dir, spec) {
        return Err(format!("{} is not installed", spec.name));
    }

    // Runtime gate: any spec with a runtime requirement (npm-method AND
    // binary-with-runtime like Roslyn/csharp) must have it present before
    // spawn, even though the entry itself is already installed and — for
    // csharp — is spawned directly rather than via `dotnet <entry>`.
    if let Some(rt) = &spec.runtime {
        runtime::detect(&rt.as_runtime_req()).map_err(|e| e.to_string())?;
    }

    let root = root::detect_root(Path::new(&file_path), &spec.root_markers);
    let root_str = root.to_string_lossy().to_string();
    let (solution_path, solution_kind) = match find_solution_path(&root, &language) {
        Some((path, kind)) => (Some(path), Some(kind.to_string())),
        None => (None, None),
    };
    let key = (language.clone(), root_str.clone());

    // Step 1: fast path — an already-live server for this key.
    {
        let reg = state.registry.lock().await;
        if let Some(&id) = reg.by_key.get(&key) {
            if reg.servers.contains_key(&id) {
                return Ok(LspStartResult {
                    server_id: id,
                    root: root_str,
                    solution_path,
                    solution_kind,
                });
            }
        }
        // guard dropped here: stale/absent entries are resolved after we
        // (re)spawn below, never held across the spawn await.
    }

    // `id` is allocated before spawn args are built because the Roslyn
    // (binary-with-runtime) branch needs it for the per-server log dir
    // name. A simple atomic increment — reordering it earlier has no
    // bearing on the race-loser cleanup below (a lost race just leaves an
    // orphaned, harmless log dir under that id).
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);

    // Step 2: spawn with no lock held — this can be slow (process launch,
    // handshake) and must never block lsp_send/lsp_stop for other servers.
    // Four cases:
    //   - Npm servers spawn the resolved `node` binary with the JS entry
    //     point as its first argument, since the "binary" here is a
    //     `.mjs`/`.js` file that can't execute itself.
    //   - Binary+config_subpath (java/jdtls) spawns the resolved `java`
    //     runtime binary with the equinox launcher jar via `-jar`, plus a
    //     WRITABLE per-server copy of the manifest's `config_subpath` dir
    //     (jdtls extracts a JNI helper into it at every startup; a
    //     read-only path crashes — see lsp-p5-research.md §3.1) and a
    //     per-server `-data` workspace dir (required — omitting it crashes
    //     too, §3.2). Checked BEFORE the runtime-only branch below since
    //     java also declares `spec.runtime`.
    //   - Binary-with-runtime (csharp/Roslyn) spawns `entry_path` DIRECTLY
    //     — the apphost self-resolves the dotnet runtime, we never launch
    //     via `dotnet <entry>` — but requires Roslyn's mandatory CLI args
    //     plus a writable per-server log dir.
    //   - Plain Binary with no runtime (rust-analyzer) spawns `entry_path`
    //     directly with `spec.args` — unchanged from before this task.
    let (bin, spawn_args): (PathBuf, Vec<String>) =
        match spec.install_kind() {
            InstallKind::Npm => {
                let rt = spec.runtime.as_ref().ok_or_else(|| {
                    format!("{} is an npm server but has no runtime spec", spec.name)
                })?;
                let node = runtime::detect(&rt.as_runtime_req()).map_err(|e| e.to_string())?;
                let entry = install::entry_path(&state.data_dir, spec);
                let mut args = vec![entry.to_string_lossy().to_string()];
                args.extend(spec.args.iter().cloned());
                (node.path, args)
            }
            InstallKind::Binary if spec.config_subpath.is_some() => {
                let rt = spec.runtime.as_ref().ok_or_else(|| {
                    format!("{} is a java server but has no runtime spec", spec.name)
                })?;
                let java = runtime::detect(&rt.as_runtime_req()).map_err(|e| e.to_string())?;
                let entry = install::entry_path(&state.data_dir, spec);
                let config_subpath = spec.config_subpath.as_deref().ok_or_else(|| {
                    format!("{} is a java server but has no config_subpath", spec.name)
                })?;
                let config_src = install::install_root(&state.data_dir, spec).join(config_subpath);

                // Per-server writable dirs. These MUST live outside
                // `lsp/jdtls/` (the install-name dir): `install_from_bytes`'s
                // version-GC sweep deletes every sibling of `install_root`
                // under `lsp/jdtls/`, which would nuke a running server's
                // config/workspace on the next re-download. Use a separate
                // parent, mirroring how the C# arm uses `lsp/logs/<id>`.
                let server_dir = state
                    .data_dir
                    .join("lsp")
                    .join("jdtls-servers")
                    .join(id.to_string());
                let config_dst = server_dir.join("config");
                let workspace_dir = server_dir.join("data");
                copy_dir_all(&config_src, &config_dst).map_err(|e| {
                    format!(
                        "copying jdtls config {} -> {}: {e}",
                        config_src.display(),
                        config_dst.display()
                    )
                })?;
                std::fs::create_dir_all(&workspace_dir).map_err(|e| {
                    format!(
                        "creating jdtls -data workspace dir {}: {e}",
                        workspace_dir.display()
                    )
                })?;

                // Verified working JVM flag set (lsp-p5-research.md §3.3):
                // initialize returned in ~2.2s with exactly these flags, no
                // more, no fewer.
                let mut args: Vec<String> = [
                    "-Declipse.application=org.eclipse.jdt.ls.core.id1",
                    "-Dosgi.bundles.defaultStartLevel=4",
                    "-Declipse.product=org.eclipse.jdt.ls.core.product",
                    "-Dfile.encoding=UTF-8",
                    "-Xmx1G",
                    "--add-modules=ALL-SYSTEM",
                    "--add-opens",
                    "java.base/java.util=ALL-UNNAMED",
                    "--add-opens",
                    "java.base/java.lang=ALL-UNNAMED",
                ]
                .iter()
                .map(|s| s.to_string())
                .collect();
                args.push("-jar".to_string());
                args.push(entry.to_string_lossy().to_string());
                args.push("-configuration".to_string());
                args.push(config_dst.to_string_lossy().to_string());
                args.push("-data".to_string());
                args.push(workspace_dir.to_string_lossy().to_string());
                args.extend(spec.args.iter().cloned());
                (java.path, args)
            }
            InstallKind::Binary if spec.runtime.is_some() => {
                let entry = install::entry_path(&state.data_dir, spec);
                let log_dir = state.data_dir.join("lsp").join("logs").join(id.to_string());
                std::fs::create_dir_all(&log_dir)
                    .map_err(|e| format!("creating lsp log dir {}: {e}", log_dir.display()))?;
                // Required by the Roslyn CLI: it errors out without
                // --logLevel/--extensionLogDirectory/--stdio.
                let mut args = vec![
                    "--logLevel".to_string(),
                    "Information".to_string(),
                    "--extensionLogDirectory".to_string(),
                    log_dir.to_string_lossy().to_string(),
                    "--stdio".to_string(),
                ];
                args.extend(spec.args.iter().cloned());
                (entry, args)
            }
            InstallKind::Binary => (
                install::entry_path(&state.data_dir, spec),
                spec.args.clone(),
            ),
        };

    let msg_topic = format!("lsp://{id}/message");
    let exit_topic = format!("lsp://{id}/exit");
    let app_msg = app.clone();
    let app_exit = app.clone();
    let mut srv = LspServer::spawn(
        &bin,
        &spawn_args,
        &root,
        move |msg| {
            let _ = app_msg.emit(&msg_topic, msg);
        },
        move |_code| {
            // Fires once when the server's stdout closes. Spawn a task so
            // the (non-async) exit callback can emit + self-heal the
            // registry: without this a crashed server leaves a dead id
            // forever, and lsp_start for the same (language, root) never
            // succeeds again.
            let app_exit = app_exit.clone();
            tokio::spawn(async move {
                let _ = app_exit.emit(&exit_topic, ());
                let state = app_exit.state::<LspState>();
                let mut reg = state.registry.lock().await;
                reg.servers.remove(&id);
                reg.by_key.retain(|_, v| *v != id);
                tracing::warn!(
                    server_id = id,
                    "lsp server exited; registry entry cleaned up"
                );
            });
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // Step 3: re-lock and re-check — another task may have raced us and
    // already installed a live server for this key while we were spawning.
    let mut reg = state.registry.lock().await;
    if let Some(&winner_id) = reg.by_key.get(&key) {
        if reg.servers.contains_key(&winner_id) {
            drop(reg);
            srv.kill().await;
            tracing::info!(
                server_id = winner_id,
                loser_id = id,
                language = %language,
                root = %root_str,
                "lsp_start race lost; killed duplicate spawn"
            );
            return Ok(LspStartResult {
                server_id: winner_id,
                root: root_str,
                solution_path,
                solution_kind,
            });
        }
    }

    tracing::info!(server_id = id, language = %language, root = %root_str, "lsp server started");
    reg.servers.insert(id, srv);
    reg.by_key.insert(key, id);
    Ok(LspStartResult {
        server_id: id,
        root: root_str,
        solution_path,
        solution_kind,
    })
}

#[tauri::command]
pub async fn lsp_send(
    state: State<'_, LspState>,
    server_id: u64,
    message: String,
) -> Result<(), String> {
    // Grab a cloned sender under the lock, then drop the guard before the
    // (potentially slow) send — a stalled child stdin must never wedge the
    // single global registry mutex for every other lsp_start/lsp_stop/lsp_send.
    let sender = {
        let reg = state.registry.lock().await;
        reg.servers
            .get(&server_id)
            .ok_or("unknown lsp server")?
            .sender()
    }; // guard dropped here
    if sender.send(message).await.is_err() {
        tracing::warn!(server_id, "lsp send dropped: server channel closed");
    }
    Ok(())
}

#[tauri::command]
pub async fn lsp_stop(state: State<'_, LspState>, server_id: u64) -> Result<(), String> {
    // Remove from the map(s) first (under the lock), then kill outside the
    // lock so a slow process teardown never blocks other lsp_* commands.
    let srv = {
        let mut reg = state.registry.lock().await;
        reg.by_key.retain(|_, v| *v != server_id);
        reg.servers.remove(&server_id)
    };
    if let Some(mut srv) = srv {
        tracing::info!(server_id, "stopping lsp server");
        srv.kill().await;
    } else {
        tracing::warn!(server_id, "lsp_stop called for unknown/already-gone server");
    }
    Ok(())
}
