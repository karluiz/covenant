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

    // ponytail: re-send the command until observed, not once — a blind first
    // write can land before cold pwsh is ready to read and get dropped on CI.
    let write = |s: &mut PtySession| s.write(b"Write-Output covenant-hello\r\n").expect("write to pty");
    write(&mut session);

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut next_resend = Instant::now() + Duration::from_secs(3);
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
        if Instant::now() >= next_resend {
            write(&mut session);
            next_resend = Instant::now() + Duration::from_secs(3);
        }
    }
    panic!(
        "did not observe 'covenant-hello' within 30s. buffer was: {:?}",
        String::from_utf8_lossy(&buf)
    );
}
