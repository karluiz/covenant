//! M0-equivalent for Windows: spawn pwsh.exe via ConPTY, write a command,
//! assert the output appears.

#![cfg(windows)]

use karl_pty::{PtySession, SpawnOptions};
use std::time::{Duration, Instant};

#[test]
fn pwsh_echo_round_trip() {
    let opts = SpawnOptions::from_default_shell().expect("pwsh.exe must be on PATH for this test");
    let (mut session, mut rx) = PtySession::spawn(opts).expect("spawn pwsh");

    std::thread::sleep(Duration::from_millis(400));
    session
        .write(b"Write-Output covenant-hello\r\n")
        .expect("write to pty");

    let deadline = Instant::now() + Duration::from_secs(6);
    let mut buf: Vec<u8> = Vec::new();
    while Instant::now() < deadline {
        match rx.try_recv() {
            Ok(chunk) => {
                buf.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&buf).contains("covenant-hello") {
                    return;
                }
            }
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    panic!(
        "did not observe 'covenant-hello' within 6s. buffer was: {:?}",
        String::from_utf8_lossy(&buf)
    );
}
