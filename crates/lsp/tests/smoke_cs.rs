//! End-to-end: download the Roslyn language server nupkg, spawn its native
//! apphost on a fixture C# project, initialize, send the (empirically
//! discovered) `solution/open` notification, and resolve a cross-file
//! definition. Network + real download (~57MB) + `dotnet`/.NET 10 SDK on
//! PATH: run explicitly with
//! `cargo test -p karl-lsp --test smoke_cs -- --ignored --nocapture`.
//!
//! The fixture is deliberately two files (`Lib.cs` defines `Helper`,
//! `Program.cs` calls `Lib.Helper()`) rather than one. A single-file fixture
//! resolves via Roslyn's "miscellaneous files" fallback workspace even
//! *without* `solution/open`, which would make this test pass without
//! actually proving the project-load handshake works. The two-file fixture
//! only resolves once the server has genuinely loaded the `.sln`/`.csproj`
//! via MSBuild — verified by hand: without `solution/open`, definition on
//! `Lib.Helper()` returns an empty result (the misc-files workspace only
//! knows about the single open document); with it, definition resolves to
//! `Lib.cs`.
use std::sync::mpsc;
use std::time::Duration;

use karl_lsp::{install, registry, runtime, server::LspServer};

const PROGRAM_CS: &str =
    "class C { static void Main() { var x = Lib.Helper(); System.Console.WriteLine(x); } }\n";
const LIB_CS: &str = "class Lib { public static int Helper() => 1; }\n";

// A hand-written, minimal classic `.sln` (not `dotnet new sln`'s default
// `.slnx` format on .NET 10 SDKs) referencing the fixture's single csproj.
// Verified by hand to load identically to a `dotnet new sln -f sln` /
// `dotnet sln add` generated one.
const FIXTURE_SLN: &str = r#"Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 17
VisualStudioVersion = 17.0.31903.59
MinimumVisualStudioVersion = 10.0.40219.1
Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Program", "Program.csproj", "{91C35E9E-E1DB-47C0-A45A-80D3C8184694}"
EndProject
Global
	GlobalSection(SolutionConfigurationPlatforms) = preSolution
		Debug|Any CPU = Debug|Any CPU
		Release|Any CPU = Release|Any CPU
	EndGlobalSection
	GlobalSection(ProjectConfigurationPlatforms) = postSolution
		{91C35E9E-E1DB-47C0-A45A-80D3C8184694}.Debug|Any CPU.ActiveCfg = Debug|Any CPU
		{91C35E9E-E1DB-47C0-A45A-80D3C8184694}.Debug|Any CPU.Build.0 = Debug|Any CPU
		{91C35E9E-E1DB-47C0-A45A-80D3C8184694}.Release|Any CPU.ActiveCfg = Release|Any CPU
		{91C35E9E-E1DB-47C0-A45A-80D3C8184694}.Release|Any CPU.Build.0 = Release|Any CPU
	EndGlobalSection
	GlobalSection(SolutionProperties) = preSolution
		HideSolutionNode = FALSE
	EndGlobalSection
EndGlobal
"#;

// NB: must be multi_thread — the test blocks on the std::sync::mpsc
// receiver (recv_timeout), and a current_thread runtime would starve the
// spawned reader/writer pump tasks on the same OS thread, hanging forever.
#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn definition_end_to_end_csharp() {
    let data_dir = tempfile::tempdir().unwrap();
    let fixture = tempfile::tempdir().unwrap();
    let log_dir = tempfile::tempdir().unwrap();

    std::fs::write(
        fixture.path().join("Program.csproj"),
        "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable></PropertyGroup></Project>\n",
    )
    .unwrap();
    std::fs::write(fixture.path().join("Lib.cs"), LIB_CS).unwrap();
    let program_cs = fixture.path().join("Program.cs");
    std::fs::write(&program_cs, PROGRAM_CS).unwrap();
    let sln_path = fixture.path().join("Fixture.sln");
    std::fs::write(&sln_path, FIXTURE_SLN).unwrap();

    let spec = registry::spec_for_language("csharp").expect("csharp in manifest");
    install::download(spec, data_dir.path(), |_, _| {})
        .await
        .expect("download roslyn-language-server nupkg");
    assert!(install::is_installed(data_dir.path(), spec));

    let rt = spec
        .runtime
        .as_ref()
        .expect("csharp entry has runtime spec");
    runtime::detect(&rt.as_runtime_req()).expect(
        "dotnet >=10 must be on the login-shell PATH for this smoke test \
         (RuntimeMissing means the test environment lacks dotnet, not a code bug)",
    );

    let entry = install::entry_path(data_dir.path(), spec);
    let args = vec![
        "--logLevel".to_string(),
        "Information".to_string(),
        "--extensionLogDirectory".to_string(),
        log_dir.path().to_string_lossy().to_string(),
        "--stdio".to_string(),
    ];

    let (tx, rx) = mpsc::channel::<String>();
    let mut srv = LspServer::spawn(
        &entry,
        &args,
        fixture.path(),
        move |m| {
            let _ = tx.send(m);
        },
        |_| {},
    )
    .await
    .expect(
        "spawn Microsoft.CodeAnalysis.LanguageServer apphost directly (no `dotnet` indirection)",
    );

    let root_uri = format!("file://{}", fixture.path().display());
    let sln_uri = format!("file://{}", sln_path.display());
    let file_uri = format!("file://{}", program_cs.display());

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
    wait_for(&rx, |v| v["id"] == 1);
    srv.send(r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#.to_string())
        .await;

    // THE handshake: empirically verified (see module doc + task-3-report.md)
    // to be the ONLY variant among solution/open, project/open, and bare
    // initialize that unlocks cross-file definition resolution. Param shape:
    // a flat `{ "solution": "file://<abs .sln>" }` — not a nested object.
    srv.send(
        serde_json::json!({
            "jsonrpc": "2.0", "method": "solution/open",
            "params": { "solution": sln_uri }
        })
        .to_string(),
    )
    .await;

    srv.send(
        serde_json::json!({
            "jsonrpc": "2.0", "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": file_uri, "languageId": "csharp", "version": 1,
                "text": PROGRAM_CS } }
        })
        .to_string(),
    )
    .await;

    // Roslyn project load (MSBuild design-time build) is slow; poll
    // definition on the `Lib.Helper()` call site until it resolves. Also
    // surface window/logMessage notifications so a failure has a transcript
    // of what the server was doing.
    let call_character = (PROGRAM_CS.find("Lib.Helper()").unwrap() + "Lib.".len() + 1) as i64;
    let mut result = None;
    for attempt in 0..90 {
        let id = 100 + attempt;
        srv.send(
            serde_json::json!({
                "jsonrpc": "2.0", "id": id, "method": "textDocument/definition",
                "params": { "textDocument": { "uri": file_uri },
                    "position": { "line": 0, "character": call_character } }
            })
            .to_string(),
        )
        .await;
        let resp = wait_for_logging(&rx, move |v| v["id"] == id);
        if resp["result"].is_array() && !resp["result"].as_array().unwrap().is_empty() {
            result = Some(resp);
            break;
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    }
    let resp = result.expect(
        "definition on Lib.Helper() never resolved after 90 attempts — \
         solution/open handshake did not load the project in time (or at all)",
    );
    let loc = &resp["result"][0];
    let uri = loc["uri"].as_str().expect("location has a uri");
    assert!(
        uri.ends_with("Lib.cs"),
        "definition should resolve into Lib.cs (cross-file — proves the \
         project was actually loaded, not just the misc-files fallback), got {uri}"
    );
    let range = loc
        .get("targetSelectionRange")
        .or_else(|| loc.get("range"))
        .expect("location has a range or targetSelectionRange");
    assert_eq!(
        range["start"]["line"], 0,
        "Helper is defined on line 0 of Lib.cs"
    );

    srv.kill().await;
}

fn wait_for(
    rx: &mpsc::Receiver<String>,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    wait_for_logging(rx, pred)
}

/// Like `wait_for` but also prints every `window/logMessage` /
/// `window/showMessage` notification it passes over — Roslyn logs project
/// load progress ("Loading…", "Successfully completed load of…", restore
/// steps) on those channels, which is exactly what a BLOCKED report needs.
fn wait_for_logging(
    rx: &mpsc::Receiver<String>,
    pred: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(90);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let msg = rx.recv_timeout(remaining).expect("message before deadline");
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg) {
            if v["method"] == "window/logMessage" || v["method"] == "window/showMessage" {
                eprintln!("[roslyn log] {}", v["params"]["message"]);
            }
            if pred(&v) {
                return v;
            }
        }
    }
}
