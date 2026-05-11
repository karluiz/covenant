//! Exercises the block parser against a PowerShell-shaped OSC 133 stream.
//!
//! Verifies that `BlockParser` is shell-agnostic: the same byte-level
//! sequences that zsh emits should parse identically when emitted by a
//! PowerShell prompt function. Windows paths in OSC 7 use forward-slash
//! URI encoding (`file://host/C:/Users/karl`).

use std::path::PathBuf;

use karl_blocks::{BlockEvent, BlockParser};

/// Helper: feed all bytes in one shot and return events.
fn parse(input: &[u8]) -> Vec<BlockEvent> {
    let mut p = BlockParser::new();
    p.feed(input)
}

/// A realistic PowerShell terminal session:
///
/// 1. OSC 133 A — prompt start
/// 2. OSC 7 — cwd is a Windows path
/// 3. PS1-style prompt text rendered between B/C markers
/// 4. OSC 133 C with explicit cmdline payload (PS preexec equivalent)
/// 5. CRLF-terminated output lines (PowerShell table formatter uses CRLF)
/// 6. OSC 133 D;0 — command finished, exit 0
#[test]
fn pwsh_full_block_sequence() {
    // Build the stream in parts for readability.
    let stream: &[u8] = b"\
        \x1b]133;A\x1b\\\
        \x1b]7;file://DESKTOP-KARL/C:/Users/karl\x1b\\\
        \x1b]133;B\x07\
        PS C:\\Users\\karl> \
        \x1b]133;C;Get-Process pwsh\x1b\\\
        \r\n\
        Handles  NPM(K)    PM(K)      WS(K)     CPU(s)     Id  SI ProcessName\r\n\
        -------  ------    -----      -----     ------     --  -- -----------\r\n\
            350      32    52100      63204       1.234   1234   1 pwsh\r\n\
        \x1b]133;D;0\x07\
    ";

    let evs = parse(stream);

    // Must see at least a CommandSubmitted and a CommandFinished.
    let submitted = evs.iter().find(|e| {
        matches!(e, BlockEvent::CommandSubmitted { command } if command == "Get-Process pwsh")
    });
    assert!(
        submitted.is_some(),
        "expected CommandSubmitted {{ command: \"Get-Process pwsh\" }}, got: {evs:?}"
    );

    let finished = evs.iter().find(|e| {
        matches!(e, BlockEvent::CommandFinished { exit_code: Some(0) })
    });
    assert!(
        finished.is_some(),
        "expected CommandFinished {{ exit_code: Some(0) }}, got: {evs:?}"
    );
}

/// OSC 7 with a Windows-style URI path should produce a PathBuf that
/// preserves the full path (forward-slash form under the URI host).
#[test]
fn pwsh_osc7_windows_path() {
    let evs = parse(b"\x1b]7;file://DESKTOP-KARL/C:/Users/karl\x1b\\");
    assert_eq!(
        evs,
        vec![BlockEvent::CwdChanged {
            path: PathBuf::from("/C:/Users/karl"),
        }]
    );
}

/// Chunked delivery: OSC sequence split across two feed() calls —
/// mirrors how Tokio drains the ConPTY pipe in small buffers.
#[test]
fn pwsh_chunked_command_finished() {
    let mut p = BlockParser::new();
    let part1 = p.feed(b"\x1b]133;");
    let part2 = p.feed(b"D;0\x07");
    assert!(part1.is_empty(), "no event expected from partial OSC");
    assert_eq!(
        part2,
        vec![BlockEvent::CommandFinished { exit_code: Some(0) }],
        "CommandFinished must fire once ST arrives"
    );
}

/// Verify the explicit C-payload form works for pwsh, mirroring the zsh
/// preexec snippet behaviour. The bytes typed between B and C are noisy
/// (PS renders autosuggestions inline); the payload must win.
#[test]
fn pwsh_c_payload_overrides_byte_capture() {
    let evs = parse(
        b"\x1b]133;B\x07Get-Process\x1b[2m pwsh\x1b[0m\x1b]133;C;Get-Process pwsh\x1b\\",
    );
    assert_eq!(
        evs,
        vec![BlockEvent::CommandSubmitted {
            command: "Get-Process pwsh".to_string(),
        }]
    );
}

/// Non-zero exit code is faithfully propagated (e.g. a failing cmdlet).
#[test]
fn pwsh_nonzero_exit_code() {
    let evs = parse(b"\x1b]133;D;1\x07");
    assert_eq!(
        evs,
        vec![BlockEvent::CommandFinished {
            exit_code: Some(1)
        }]
    );
}
