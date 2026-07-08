//! End-to-end: `npm install typescript-language-server typescript`, spawn it
//! on a fixture TS project via the user's `node`, initialize, and resolve a
//! definition. Network + real npm install (~30-60s): run explicitly with
//! `cargo test -p karl-lsp --test smoke_ts -- --ignored --nocapture`.
use std::sync::mpsc;
use std::time::Duration;

use karl_lsp::{install, registry, runtime, server::LspServer};

// NB: must be multi_thread — the test blocks on the std::sync::mpsc
// receiver (recv_timeout), and a current_thread runtime would starve the
// spawned reader/writer pump tasks on the same OS thread, hanging forever.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn definition_end_to_end_typescript() {
    let data_dir = tempfile::tempdir().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    std::fs::write(
        fixture.path().join("tsconfig.json"),
        r#"{"compilerOptions":{"strict":true}}"#,
    )
    .unwrap();
    std::fs::create_dir(fixture.path().join("src")).unwrap();
    let a_ts = fixture.path().join("src/a.ts");
    let source = "function helper() { return 1; }\nconst x = helper();\n";
    std::fs::write(&a_ts, source).unwrap();

    let spec = registry::spec_for_language("typescript").expect("typescript in manifest");
    let rt = spec
        .runtime
        .as_ref()
        .expect("typescript entry has runtime spec");
    let node = runtime::detect(&rt.as_runtime_req()).expect(
        "node >=18 must be on the login-shell PATH for this smoke test \
         (RuntimeMissing means the test environment lacks node, not a code bug)",
    );
    let node_dir = node.path.parent().expect("node path has a parent dir");

    install::npm_install(spec, data_dir.path(), node_dir, |msg| {
        eprintln!("[npm_install] {msg}");
    })
    .await
    .expect("npm install typescript-language-server + typescript");
    assert!(install::is_installed(data_dir.path(), spec));

    let entry = install::entry_path(data_dir.path(), spec);
    let mut args = vec![entry.to_string_lossy().to_string()];
    args.extend(spec.args.iter().cloned());

    let (tx, rx) = mpsc::channel::<String>();
    let mut srv = LspServer::spawn(
        &node.path,
        &args,
        fixture.path(),
        move |m| {
            let _ = tx.send(m);
        },
        |_| {},
    )
    .await
    .expect("spawn typescript-language-server via node");

    let root_uri = format!("file://{}", fixture.path().display());
    let file_uri = format!("file://{}", a_ts.display());
    srv.send(
        serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "processId": null, "rootUri": root_uri, "capabilities": {} }
        })
        .to_string(),
    )
    .await;

    // Wait for the id:1 response.
    wait_for(&rx, |v| v["id"] == 1);
    srv.send(r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#.to_string())
        .await;
    srv.send(
        serde_json::json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": file_uri, "languageId": "typescript", "version": 1,
                "text": source } }
        })
        .to_string(),
    )
    .await;

    // typescript-language-server needs a moment to load the project and
    // index; retry definition until it lands.
    let mut result = None;
    for attempt in 0..30 {
        let id = 100 + attempt;
        srv.send(
            serde_json::json!({
                "jsonrpc": "2.0", "id": id, "method": "textDocument/definition",
                "params": { "textDocument": { "uri": file_uri },
                    "position": { "line": 1, "character": 10 } } // on `helper` call
            })
            .to_string(),
        )
        .await;
        let resp = wait_for(&rx, move |v| v["id"] == id);
        if resp["result"].is_array() && !resp["result"].as_array().unwrap().is_empty() {
            result = Some(resp);
            break;
        }
        if resp["result"].is_object() && !resp["result"].is_null() {
            result = Some(resp);
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let resp = result.expect("definition resolved");
    // Result can be either `Location[]`, `LocationLink[]`, or a single
    // `Location` object depending on server/capability negotiation.
    let loc = if resp["result"].is_array() {
        &resp["result"][0]
    } else {
        &resp["result"]
    };
    let range = loc
        .get("targetSelectionRange")
        .or_else(|| loc.get("range"))
        .expect("location has a range or targetSelectionRange");
    assert_eq!(range["start"]["line"], 0, "helper is defined on line 0");
    srv.kill().await;
}

fn wait_for(
    rx: &mpsc::Receiver<String>,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let msg = rx.recv_timeout(remaining).expect("message before deadline");
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg) {
            if pred(&v) {
                return v;
            }
        }
    }
}
