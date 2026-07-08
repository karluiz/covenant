//! End-to-end: download the JDT.LS (jdtls) tarball, spawn it over stdio on
//! a fixture Maven project, initialize, WAIT for the jdtls-specific
//! `language/status` `ServiceReady` notification (Java/Maven project import
//! is slow and asynchronous — unlike Roslyn/rust-analyzer there is no
//! synchronous "project loaded" signal, so this is the one smoke that must
//! actually watch a readiness notification stream rather than just poll
//! `textDocument/definition` from t=0), then resolve a cross-file
//! definition. Network + real download (~51MB) + a JDK **21+** on the
//! machine (see below): run explicitly with
//! `cargo test -p karl-lsp --test smoke_java -- --ignored --nocapture`.
//!
//! The fixture is deliberately two files (`Lib.java` defines `helper()`,
//! `App.java` calls `Lib.helper()`) rather than one, mirroring
//! `smoke_cs.rs`'s rationale: a single-file fixture could resolve via a
//! degraded/no-project fallback and wouldn't prove the Maven project was
//! actually imported.
//!
//! ## Java runtime note (see `.superpowers/lsp-p5-research.md` §3.0)
//!
//! jdtls 1.60.0 requires a JavaSE **21+** runtime to launch at all (its core
//! OSGi bundle declares `Require-Capability: osgi.ee; filter:="(&(osgi.ee=
//! JavaSE)(version=21))"` — Java 17 fails ~28 bundle-resolution errors and
//! the process exits before ever writing to stdout). This is the *server's*
//! own runtime requirement, independent of what the *fixture project*
//! compiles against. The research environment's login-shell `java` resolves
//! to Homebrew OpenJDK 17.0.18 (< 21), so `runtime::detect` (which asks the
//! login shell) fails the `min_version: "21"` gate in `servers.json`. We try
//! `runtime::detect` first — if a Java 21+ ends up on PATH in some other
//! environment, this smoke uses it — and only fall back to the known-good
//! JDK 26 at `/opt/homebrew/opt/openjdk/bin/java` (verified in the research
//! report to launch jdtls successfully) when detect fails or resolves a
//! runtime that reports a below-21 version.
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use karl_lsp::{install, registry, runtime, server::LspServer};

const LIB_JAVA: &str = "public class Lib {\n    public static int helper() {\n        return 1;\n    }\n}\n";
const APP_JAVA: &str = "public class App {\n    public static void main(String[] args) {\n        int x = Lib.helper();\n        System.out.println(x);\n    }\n}\n";
const POM_XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>fixture</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>21</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
</project>
"#;

/// Known-good JDK 21+ fallback, verified in `.superpowers/lsp-p5-research.md`
/// §3.0/§3.3 (JDK 26.0.1 via Homebrew's unversioned `openjdk` formula) to
/// actually launch jdtls 1.60.0, unlike the environment's default
/// (JAVA_HOME-pointed) OpenJDK 17.0.18 which jdtls hard-refuses to start on.
const FALLBACK_JAVA21: &str = "/opt/homebrew/opt/openjdk/bin/java";

/// Resolve a Java 21+ binary: prefer whatever `runtime::detect` finds on the
/// login-shell PATH (the production code path, `crates/app/src/lsp_commands.rs`),
/// but fall back to the known-good JDK 26 path when detect fails (missing or
/// too old) — this environment's default `java` is 17.0.18, which jdtls
/// cannot run on at all (see module doc).
fn resolve_java21() -> PathBuf {
    let req = registry::spec_for_language("java")
        .expect("java in manifest")
        .runtime
        .as_ref()
        .expect("java entry has runtime spec")
        .as_runtime_req();
    match runtime::detect(&req) {
        Ok(resolved) => {
            eprintln!(
                "[smoke_java] runtime::detect found java {} at {}",
                resolved.version,
                resolved.path.display()
            );
            resolved.path
        }
        Err(e) => {
            eprintln!(
                "[smoke_java] runtime::detect failed ({e}) — falling back to {FALLBACK_JAVA21} \
                 (verified JDK 21+ per lsp-p5-research.md)"
            );
            PathBuf::from(FALLBACK_JAVA21)
        }
    }
}

/// Plain recursive copy — same shape as `copy_dir_all` in
/// `crates/app/src/lsp_commands.rs` (not exported from that crate, so
/// reimplemented here to keep this smoke self-contained rather than reaching
/// into an app-crate private helper).
fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
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

// NB: must be multi_thread — the test blocks on the std::sync::mpsc
// receiver (recv_timeout), and a current_thread runtime would starve the
// spawned reader/writer pump tasks on the same OS thread, hanging forever.
// Same pattern as smoke_cs.rs / smoke_ts.rs.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn definition_end_to_end_java() {
    let data_dir = tempfile::tempdir().unwrap();
    let fixture = tempfile::tempdir().unwrap();

    std::fs::write(fixture.path().join("pom.xml"), POM_XML).unwrap();
    let src_dir = fixture.path().join("src/main/java");
    std::fs::create_dir_all(&src_dir).unwrap();
    std::fs::write(src_dir.join("Lib.java"), LIB_JAVA).unwrap();
    let app_java = src_dir.join("App.java");
    std::fs::write(&app_java, APP_JAVA).unwrap();

    let spec = registry::spec_for_language("java").expect("java in manifest");
    install::download(spec, data_dir.path(), |_, _| {})
        .await
        .expect("download jdt-language-server tarball");
    assert!(install::is_installed(data_dir.path(), spec));

    let java = resolve_java21();
    let entry = install::entry_path(data_dir.path(), spec);
    let config_subpath = spec
        .config_subpath
        .as_deref()
        .expect("java entry has config_subpath");
    let config_src = install::install_root(data_dir.path(), spec).join(config_subpath);

    // jdtls extracts a JNI helper into `-configuration` at every startup —
    // must be a writable copy, never the shared read-only install_root
    // (proven in lsp-p5-research.md §3.1: AccessDeniedException otherwise).
    let server_dir = tempfile::tempdir().unwrap();
    let config_dst = server_dir.path().join("config");
    let workspace_dir = server_dir.path().join("data");
    copy_dir_all(&config_src, &config_dst).expect("copy config_mac_arm to a writable tmp dir");
    std::fs::create_dir_all(&workspace_dir).expect("create -data workspace dir");

    // Verified working JVM flag set — mirrors
    // crates/app/src/lsp_commands.rs's java arm EXACTLY (this smoke is the
    // real validation of that launch construction). initialize returned in
    // ~2.2s with exactly these flags in the research pass, no more, no
    // fewer.
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

    let spawn_started = std::time::Instant::now();
    let (tx, rx) = mpsc::channel::<String>();
    let mut srv = LspServer::spawn(
        &java,
        &args,
        fixture.path(),
        move |m| {
            let _ = tx.send(m);
        },
        |_| {},
    )
    .await
    .expect("spawn jdtls via the equinox launcher jar");

    let root_uri = format!("file://{}", fixture.path().display());
    let file_uri = format!("file://{}", app_java.display());

    srv.send(
        serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "processId": null,
                "rootUri": root_uri,
                "workspaceFolders": [{ "uri": root_uri, "name": "fixture" }],
                "capabilities": {}
            }
        })
        .to_string(),
    )
    .await;
    wait_for(&rx, "waiting for initialize result", |v| v["id"] == 1);
    srv.send(r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#.to_string())
        .await;

    // THE readiness gate: jdtls's custom `language/status` notification with
    // payload `{"type": "ServiceReady", "message": "ServiceReady"}`. Java /
    // Maven project import is asynchronous and slow (verified ~3.5s for a
    // warm ~/.m2 cache in the research pass, but a cold cache or first-run
    // plugin resolution can take much longer) — this is NOT a fixed sleep,
    // it watches the actual notification stream. Budget generously (120s).
    wait_for(
        &rx,
        "waiting for language/status ServiceReady",
        |v| v["method"] == "language/status" && v["params"]["type"] == "ServiceReady",
    );
    let service_ready_elapsed = spawn_started.elapsed();
    eprintln!(
        "[smoke_java] ServiceReady reached at t+{:.2}s",
        service_ready_elapsed.as_secs_f64()
    );

    srv.send(
        serde_json::json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": file_uri, "languageId": "java", "version": 1,
                "text": APP_JAVA } }
        })
        .to_string(),
    )
    .await;

    // Character must be LINE-relative (LSP `Position.character`), not a
    // whole-file byte offset — smoke_cs.rs's single-line fixture masked
    // this distinction (whole-file offset == line offset when there's only
    // one line); APP_JAVA is multi-line, so it must be computed properly.
    let call_offset = APP_JAVA.find("Lib.helper()").unwrap() + "Lib.".len() + 1;
    let call_line_start = APP_JAVA[..call_offset].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let call_character = (call_offset - call_line_start) as i64;
    let call_line = APP_JAVA[..call_offset].matches('\n').count() as i64;
    let mut result = None;
    for attempt in 0..90 {
        let id = 100 + attempt;
        srv.send(
            serde_json::json!({
                "jsonrpc": "2.0", "id": id, "method": "textDocument/definition",
                "params": { "textDocument": { "uri": file_uri },
                    "position": { "line": call_line, "character": call_character } }
            })
            .to_string(),
        )
        .await;
        let resp = wait_for(&rx, "polling textDocument/definition", move |v| v["id"] == id);
        if resp["result"].is_array() && !resp["result"].as_array().unwrap().is_empty() {
            result = Some(resp);
            break;
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    let resp = result.expect(
        "definition on Lib.helper() never resolved after 90 attempts (ServiceReady was \
         reached, but the classpath/project model never resolved the cross-file symbol) — \
         BLOCKED, see the [jdtls] transcript above for what the server logged",
    );
    let loc = &resp["result"][0];
    let uri = loc["uri"].as_str().expect("location has a uri");
    assert!(
        uri.ends_with("Lib.java"),
        "definition should resolve into Lib.java (cross-file — proves the Maven project \
         was actually loaded, not just a single-file fallback), got {uri}"
    );
    let range = loc
        .get("targetSelectionRange")
        .or_else(|| loc.get("range"))
        .expect("location has a range or targetSelectionRange");
    let helper_line = LIB_JAVA[..LIB_JAVA.find("helper").unwrap()]
        .matches('\n')
        .count() as i64;
    assert_eq!(
        range["start"]["line"], helper_line,
        "helper() is defined on line {helper_line} of Lib.java"
    );

    srv.kill().await;
}

/// Blocks (via `mpsc::Receiver::recv_timeout`) until a message matching
/// `pred` arrives, up to a 120s deadline (Java/Maven project import is the
/// slowest of the smokes — budget accordingly). Logs every `language/status`
/// and `window/logMessage`/`window/showMessage` notification it passes over
/// so a BLOCKED report has a full transcript of what jdtls was doing.
fn wait_for(
    rx: &mpsc::Receiver<String>,
    what: &str,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let msg = rx
            .recv_timeout(remaining)
            .unwrap_or_else(|_| panic!("timed out ({what}) after 120s — see transcript above"));
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg) {
            if v["method"] == "language/status" {
                eprintln!(
                    "[jdtls status] {} — {}",
                    v["params"]["type"], v["params"]["message"]
                );
            }
            if v["method"] == "window/logMessage" || v["method"] == "window/showMessage" {
                eprintln!("[jdtls log] {}", v["params"]["message"]);
            }
            if pred(&v) {
                return v;
            }
        }
    }
}
