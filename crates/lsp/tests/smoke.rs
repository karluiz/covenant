//! End-to-end: download rust-analyzer, spawn it on a fixture crate,
//! initialize, and resolve a definition. Network + ~12MB download:
//! run explicitly with `cargo test -p karl-lsp --test smoke -- --ignored`.
use std::sync::mpsc;
use std::time::Duration;

use karl_lsp::{framing, install, registry, root, server::LspServer};

// NB: must be multi_thread — the test blocks on the std::sync::mpsc
// receiver (recv_timeout), and a current_thread runtime would starve the
// spawned reader/writer pump tasks on the same OS thread, hanging forever.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn definition_end_to_end() {
    let data_dir = tempfile::tempdir().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    std::fs::write(
        fixture.path().join("Cargo.toml"),
        "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    std::fs::create_dir(fixture.path().join("src")).unwrap();
    let main_rs = fixture.path().join("src/main.rs");
    std::fs::write(&main_rs, "fn helper() {}\nfn main() { helper(); }\n").unwrap();

    let spec = registry::spec_for_language("rust").unwrap();
    install::download(spec, data_dir.path(), |_, _| {})
        .await
        .expect("download");
    assert!(install::is_installed(data_dir.path(), spec));

    let detected = root::detect_root(&main_rs, &spec.root_markers);
    assert_eq!(detected, fixture.path());

    let (tx, rx) = mpsc::channel::<String>();
    let mut srv = LspServer::spawn(
        &install::entry_path(data_dir.path(), spec),
        &spec.args,
        &detected,
        move |m| {
            let _ = tx.send(m);
        },
        |_| {},
    )
    .await
    .expect("spawn");

    let root_uri = format!("file://{}", detected.display());
    let file_uri = format!("file://{}", main_rs.display());
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
            "params": { "textDocument": { "uri": file_uri, "languageId": "rust", "version": 1,
                "text": "fn helper() {}\nfn main() { helper(); }\n" } }
        })
        .to_string(),
    )
    .await;

    // rust-analyzer needs a moment to index; retry definition until it lands.
    let mut result = None;
    for attempt in 0..30 {
        let id = 100 + attempt;
        srv.send(
            serde_json::json!({
                "jsonrpc": "2.0", "id": id, "method": "textDocument/definition",
                "params": { "textDocument": { "uri": file_uri },
                    "position": { "line": 1, "character": 13 } } // on `helper` call
            })
            .to_string(),
        )
        .await;
        let resp = wait_for(&rx, move |v| v["id"] == id);
        if resp["result"].is_array() && !resp["result"].as_array().unwrap().is_empty() {
            result = Some(resp);
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let resp = result.expect("definition resolved");
    let loc = &resp["result"][0];
    let range = loc
        .get("targetSelectionRange")
        .or_else(|| loc.get("range"))
        .unwrap();
    assert_eq!(range["start"]["line"], 0, "helper is defined on line 0");
    srv.kill().await;

    // encode_frame referenced so the crate surface stays exercised end-to-end
    let _ = framing::encode_frame("{}");
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
