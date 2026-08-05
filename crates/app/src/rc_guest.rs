//! Guest-driver state for collaborative terminal shares. The desktop is
//! the sole write authority: a session has at most one driver, granted
//! only by an explicit owner click and revoked on owner typing, owner
//! click, guest disconnect, or share revoke.
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

pub struct GuestDriver {
    /// Read by Task 7's rc_agent frame wiring to route inbound `send_input`
    /// frames to the right websocket connection.
    #[allow(dead_code)]
    pub conn_id: u64,
    pub login: String,
    /// Best-effort line assembly for the blocklist scan. TUIs/editors and
    /// escape sequences evade it by design — the real trust boundary is
    /// the explicit grant to a known identity. Threaded through
    /// `gate_guest_bytes` by Task 7's rc_agent wiring.
    #[allow(dead_code)]
    pub line: String,
}

#[derive(Default)]
pub struct RcGuestState {
    pub drivers: HashMap<karl_session::SessionId, GuestDriver>,
    /// rc_agent's live out-channel; None while disconnected.
    pub out: Option<tokio::sync::mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>>,
}

pub fn send_frame(st: &RcGuestState, json: String) {
    if let Some(tx) = &st.out {
        let _ = tx.send(tokio_tungstenite::tungstenite::Message::Text(json));
    }
}

/// Forward guest bytes, suppressing any line terminator whose assembled
/// line matches the blocklist. Returns (bytes to write, blocked message).
/// Wired into the inbound `send_input` path by Task 7's rc_agent frame
/// handling; exercised directly by the unit tests below until then.
#[allow(dead_code)]
pub fn gate_guest_bytes(line: &mut String, bytes: &[u8]) -> (Vec<u8>, Option<String>) {
    let mut fwd = Vec::with_capacity(bytes.len());
    for &b in bytes {
        match b {
            b'\r' | b'\n' => {
                if let Some(d) = crate::safety::is_dangerous(line, &[]) {
                    line.clear();
                    return (fwd, Some(d.message));
                }
                line.clear();
                fwd.push(b);
            }
            0x7f | 0x08 => {
                line.pop();
                fwd.push(b);
            }
            // ^C aborts the line; ESC starts a sequence we can't track —
            // reset the buffer either way (documented best-effort gap).
            0x03 | 0x1b => {
                line.clear();
                fwd.push(b);
            }
            _ => {
                if b >= 0x20 {
                    line.push(b as char);
                } // ASCII-only scan; blocklist patterns are ASCII
                fwd.push(b);
            }
        }
    }
    (fwd, None)
}

/// Remove the driver (if any), announce control_revoked to guests, and
/// tell the UI. Callable from sync contexts (std Mutex, no awaits).
pub fn revoke_driver(app: &AppHandle, id: karl_session::SessionId) -> Option<GuestDriver> {
    let state = app.try_state::<crate::AppState>()?;
    let mut st = state.rc_guest.lock().ok()?;
    let gone = st.drivers.remove(&id)?;
    send_frame(
        &st,
        format!("{{\"t\":\"control_revoked\",\"session_id\":\"{id}\"}}"),
    );
    drop(st);
    let _ = app.emit(
        "rc://guest/driver",
        serde_json::json!({ "sessionId": id.to_string(), "login": null }),
    );
    tracing::info!(target: "rc_guest", session = %id, login = %gone.login, "guest driver revoked");
    Some(gone)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_typing_forwards_and_accumulates() {
        let mut line = String::new();
        let (fwd, blocked) = gate_guest_bytes(&mut line, b"ls -la");
        assert_eq!(fwd, b"ls -la");
        assert_eq!(blocked, None);
        assert_eq!(line, "ls -la");
    }

    #[test]
    fn clean_enter_forwards_terminator_and_clears_line() {
        let mut line = "git status".to_string();
        let (fwd, blocked) = gate_guest_bytes(&mut line, b"\r");
        assert_eq!(fwd, b"\r");
        assert_eq!(blocked, None);
        assert!(line.is_empty());
    }

    #[test]
    fn dangerous_enter_is_suppressed() {
        let mut line = String::new();
        let (_f, _b) = gate_guest_bytes(&mut line, b"rm -rf /");
        let (fwd, blocked) = gate_guest_bytes(&mut line, b"\r");
        assert!(fwd.is_empty(), "the terminator must not reach the PTY");
        assert!(blocked.is_some());
        assert!(line.is_empty(), "buffer resets so the guest can correct");
    }

    #[test]
    fn newline_is_gated_like_cr() {
        let mut line = "sudo reboot".to_string();
        let (fwd, blocked) = gate_guest_bytes(&mut line, b"\n");
        assert!(fwd.is_empty());
        assert!(blocked.is_some());
    }

    #[test]
    fn backspace_edits_the_buffer() {
        let mut line = String::new();
        gate_guest_bytes(&mut line, b"lsx");
        gate_guest_bytes(&mut line, &[0x7f]);
        assert_eq!(line, "ls");
    }

    #[test]
    fn ctrl_c_and_esc_reset_the_buffer_but_forward() {
        let mut line = "half-typed".to_string();
        let (fwd, _) = gate_guest_bytes(&mut line, &[0x03]);
        assert_eq!(fwd, &[0x03]);
        assert!(line.is_empty());
        line.push_str("x");
        let (fwd2, _) = gate_guest_bytes(&mut line, &[0x1b]);
        assert_eq!(fwd2, &[0x1b]);
        assert!(line.is_empty());
    }

    #[test]
    fn dangerous_mid_chunk_forwards_prefix_only() {
        // paste "rm -rf /\rls\r": nothing from the terminator on may pass
        let mut line = String::new();
        let (fwd, blocked) = gate_guest_bytes(&mut line, b"rm -rf /\rls\r");
        assert_eq!(fwd, b"rm -rf /", "typed chars echo, the submit never lands");
        assert!(blocked.is_some());
    }
}
