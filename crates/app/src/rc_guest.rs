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
///
/// The scan buffer clears only on a clean (non-blocked) submit, or on
/// ^C / ^U — the two keystrokes that genuinely invalidate the shell's
/// current line. ESC and CSI tails (arrow keys, etc.) leave the buffer
/// as-is or let it accumulate garbage, which only biases toward
/// over-blocking (false positive) — the safe direction per the doctrine
/// note in `safety.rs`.
///
/// That said, this is best-effort line assembly, not a line-editor
/// emulation, and it has a known, accepted gap: cursor-repositioning
/// sequences (^A / Home / arrow-left, etc.) move the shell's cursor
/// without moving ours, so a guest who repositions and then backspaces
/// can shrink our buffer past what the real line actually lost (the
/// real shell no-ops a backspace at column 0; ours still pops). That
/// under-tracks the real line — the false negative this module doesn't
/// close. We are not fixing it: the trust boundary is the explicit
/// driver grant to a known identity, and this gate is a tripwire for a
/// naive dangerous one-liner, not a wall against a determined bypass.
#[allow(dead_code)]
pub fn gate_guest_bytes(line: &mut String, bytes: &[u8]) -> (Vec<u8>, Option<String>) {
    let mut fwd = Vec::with_capacity(bytes.len());
    for &b in bytes {
        match b {
            // \r / \n are the usual submits; 0x0f (^O) is bound by both
            // zsh (accept-line-and-down-history) and bash
            // (operate-and-get-next) to accept-and-run the current line.
            b'\r' | b'\n' | 0x0f => {
                if let Some(d) = crate::safety::is_dangerous(line, &[]) {
                    // Do NOT clear `line` here. Every printable byte was
                    // already forwarded, so the shell's own line editor
                    // still holds this exact (dangerous) text — clearing
                    // our copy would desync us from it, and a bare Enter
                    // right after (which re-scans an empty buffer) would
                    // let the still-buffered command execute. Keep the
                    // buffer so every subsequent terminator re-scans and
                    // re-blocks until the guest edits the line (backspace)
                    // or genuinely invalidates it (^C / ^U, which do clear
                    // — see below).
                    return (fwd, Some(d.message));
                }
                line.clear();
                fwd.push(b);
            }
            0x7f | 0x08 => {
                line.pop();
                fwd.push(b);
            }
            // ^C aborts the line; ^U (kill-whole-line, bash/zsh emacs mode)
            // erases it. Both genuinely empty the shell's current line, so
            // clearing our buffer to match is correct here.
            //
            // ESC is deliberately NOT in this arm. A bare ESC is just a
            // meta-prefix in bash/zsh emacs mode — it does NOT touch the
            // shell's line editor by itself. If we cleared our buffer on
            // ESC, a guest could bypass a block with `rm -rf /`, Enter
            // (blocked, buffer persists), ESC (buffer wrongly cleared),
            // Enter (buffer now empty → passes → the still-buffered
            // dangerous command in the real shell executes). ESC instead
            // falls through to the default arm below: forwarded, but any
            // printable bytes that follow it (e.g. an arrow key's `[A`
            // CSI tail) still accumulate into the scan buffer as garbage.
            // That only biases toward false positives (over-blocking),
            // which is the safe direction per safety.rs doctrine: "false
            // positives are fine, false negatives are not."
            0x03 | 0x15 => {
                line.clear();
                fwd.push(b);
            }
            _ => {
                // ASCII-only scan (blocklist patterns are ASCII). Bytes
                // 0x20..=0x7e accumulate literally. UTF-8 lead bytes
                // (0xc2..=0xf4) push exactly one placeholder char so
                // backspace pops one "character" per real keystroke,
                // staying aligned with the shell's own line editor;
                // their continuation bytes (0x80..=0xbf) are skipped —
                // already accounted for by the lead byte's placeholder.
                // Every byte is forwarded to the PTY unchanged regardless.
                match b {
                    0x20..=0x7e => line.push(b as char),
                    0xc2..=0xf4 => line.push('\u{fffd}'),
                    0x80..=0xbf => {}
                    _ => {}
                }
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
    // Recover a poisoned guard rather than fail open: `.ok()?` here would
    // turn a panic elsewhere while holding this lock into a silent no-op
    // that leaves the driver grant in place — the one thing revocation
    // must never do.
    let mut st = state.rc_guest.lock().unwrap_or_else(|e| e.into_inner());
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
        assert_eq!(
            line, "rm -rf /",
            "the buffer must persist unchanged: the shell's own line editor \
             still holds this exact text, so a bare Enter right after must \
             re-scan and re-block the same command rather than see a blank line"
        );
    }

    #[test]
    fn blocked_line_stays_blocked_until_edited() {
        let mut line = String::new();
        gate_guest_bytes(&mut line, b"rm -rf /");
        let (fwd1, blocked1) = gate_guest_bytes(&mut line, b"\r");
        assert!(fwd1.is_empty());
        assert!(blocked1.is_some());
        assert_eq!(line, "rm -rf /");

        // A second bare Enter, with nothing edited in between: the
        // buffered command must still be blocked, not silently run.
        let (fwd2, blocked2) = gate_guest_bytes(&mut line, b"\r");
        assert!(
            fwd2.is_empty(),
            "the terminator must not reach the PTY on retry either"
        );
        assert!(blocked2.is_some(), "must re-block, not execute, on retry");
        assert_eq!(line, "rm -rf /");
    }

    #[test]
    fn editing_after_a_block_lets_a_clean_enter_through() {
        let mut line = String::new();
        gate_guest_bytes(&mut line, b"rm -rf /");
        gate_guest_bytes(&mut line, b"\r"); // blocked; line persists
        assert_eq!(line, "rm -rf /");

        // Backspace every character — the guest correcting the command.
        for _ in 0..line.chars().count() {
            gate_guest_bytes(&mut line, &[0x7f]);
        }
        assert!(line.is_empty());

        let (fwd, blocked) = gate_guest_bytes(&mut line, b"\r");
        assert_eq!(fwd, b"\r", "a clean line's Enter must now pass");
        assert_eq!(blocked, None);
    }

    #[test]
    fn ctrl_o_is_gated_like_cr() {
        // zsh binds ^O to accept-line-and-down-history, bash to
        // operate-and-get-next — both execute the current line.
        let mut line = "rm -rf /".to_string();
        let (fwd, blocked) = gate_guest_bytes(&mut line, &[0x0f]);
        assert!(fwd.is_empty(), "^O must not reach the PTY when blocked");
        assert!(blocked.is_some());
    }

    #[test]
    fn esc_then_enter_does_not_unblock() {
        // The bypass this test guards against: block a dangerous line,
        // press bare ESC (which must NOT clear the buffer — see
        // `esc_forwards_but_does_not_clear_the_buffer`), then Enter again.
        // The real shell never lost "rm -rf /" (ESC alone doesn't touch
        // its line editor either), so the second Enter must still block.
        let mut line = String::new();
        gate_guest_bytes(&mut line, b"rm -rf /");
        let (_fwd1, blocked1) = gate_guest_bytes(&mut line, b"\r");
        assert!(blocked1.is_some());

        gate_guest_bytes(&mut line, &[0x1b]); // bare ESC

        let (fwd2, blocked2) = gate_guest_bytes(&mut line, b"\r");
        assert!(
            fwd2.is_empty(),
            "ESC must not have unblocked the buffered command"
        );
        assert!(blocked2.is_some(), "must still block after a bare ESC");
    }

    #[test]
    fn arrow_key_after_block_keeps_blocking() {
        // An arrow key is ESC + CSI tail (e.g. `\x1b[A`). The ESC byte
        // doesn't touch the buffer; the tail bytes `[`/`A` are printable
        // ASCII and accumulate as garbage — over-blocking, never
        // under-blocking.
        let mut line = String::new();
        gate_guest_bytes(&mut line, b"rm -rf /");
        let (_fwd1, blocked1) = gate_guest_bytes(&mut line, b"\r");
        assert!(blocked1.is_some());

        gate_guest_bytes(&mut line, b"\x1b[A"); // up-arrow

        let (fwd2, blocked2) = gate_guest_bytes(&mut line, b"\r");
        assert!(fwd2.is_empty());
        assert!(
            blocked2.is_some(),
            "an arrow key must not unblock the buffered command"
        );
    }

    #[test]
    fn ctrl_u_clears_and_allows_clean_line() {
        let mut line = String::new();
        gate_guest_bytes(&mut line, b"rm -rf /");
        let (_fwd1, blocked1) = gate_guest_bytes(&mut line, b"\r");
        assert!(blocked1.is_some());

        gate_guest_bytes(&mut line, &[0x15]); // ^U kills the whole line
        assert!(line.is_empty());

        let (fwd2, blocked2) = gate_guest_bytes(&mut line, b"ls");
        assert_eq!(fwd2, b"ls");
        assert_eq!(blocked2, None);

        let (fwd3, blocked3) = gate_guest_bytes(&mut line, b"\r");
        assert_eq!(fwd3, b"\r", "the clean line's Enter must pass");
        assert_eq!(blocked3, None);
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
    fn ctrl_c_and_ctrl_u_reset_the_buffer_and_forward() {
        // ^C aborts the line; ^U (kill-whole-line) erases it. Both
        // genuinely invalidate the shell's current line, so clearing our
        // copy to match is correct.
        let mut line = "half-typed".to_string();
        let (fwd, _) = gate_guest_bytes(&mut line, &[0x03]);
        assert_eq!(fwd, &[0x03]);
        assert!(line.is_empty(), "^C must clear the buffer");

        line.push_str("more-half-typed");
        let (fwd2, _) = gate_guest_bytes(&mut line, &[0x15]);
        assert_eq!(fwd2, &[0x15]);
        assert!(line.is_empty(), "^U must clear the buffer");
    }

    #[test]
    fn esc_forwards_but_does_not_clear_the_buffer() {
        // A bare ESC is just a meta-prefix in bash/zsh emacs mode — it does
        // NOT touch the shell's real line editor, so clearing our copy on
        // ESC would desync us from what the shell still holds.
        let mut line = "half-typed".to_string();
        let (fwd, _) = gate_guest_bytes(&mut line, &[0x1b]);
        assert_eq!(fwd, &[0x1b], "ESC must still reach the PTY");
        assert_eq!(
            line, "half-typed",
            "ESC alone must not clear the scan buffer"
        );
    }

    #[test]
    fn dangerous_mid_chunk_forwards_prefix_only() {
        // paste "rm -rf /\rls\r": nothing from the terminator on may pass
        let mut line = String::new();
        let (fwd, blocked) = gate_guest_bytes(&mut line, b"rm -rf /\rls\r");
        assert_eq!(fwd, b"rm -rf /", "typed chars echo, the submit never lands");
        assert!(blocked.is_some());
    }

    #[test]
    fn multibyte_utf8_forwards_and_gets_one_placeholder_per_character() {
        // "é" is 0xC3 0xA9 in UTF-8 — both bytes are > 0x7f. The lead byte
        // (0xc3) gets exactly one placeholder char in the scan buffer; the
        // continuation byte (0xa9) is skipped, so backspace later pops
        // one "character" per real keystroke instead of desyncing.
        let mut line = String::new();
        let (fwd, blocked) = gate_guest_bytes(&mut line, "café".as_bytes());
        assert_eq!(
            fwd,
            "café".as_bytes(),
            "every byte must reach the PTY unchanged"
        );
        assert_eq!(blocked, None);
        assert_eq!(
            line, "caf\u{fffd}",
            "the lead byte gets one placeholder, the continuation byte is skipped"
        );
    }

    #[test]
    fn multibyte_backspace_stays_aligned_with_the_real_shell_line() {
        // Real shell line ends up as "sudo reboot": "sudo" + "é" (one
        // keystroke) + backspace (removes the "é") + " reboot". If the
        // scan buffer didn't give "é" exactly one pop-able placeholder,
        // the backspace would remove an ASCII char instead, leaving the
        // buffer as "sud reboot" — one char short of what the shell
        // actually holds, and the dangerous line would slip through.
        let mut line = String::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"sudo");
        bytes.extend_from_slice("é".as_bytes());
        bytes.push(0x7f); // backspace: must remove the whole "é"
        bytes.extend_from_slice(b" reboot");

        let (fwd, _blocked) = gate_guest_bytes(&mut line, &bytes);
        assert_eq!(fwd, bytes, "every byte still reaches the PTY");
        assert_eq!(
            line, "sudo reboot",
            "buffer must match the real shell line after the backspace"
        );

        let (fwd2, blocked2) = gate_guest_bytes(&mut line, b"\r");
        assert!(fwd2.is_empty());
        assert!(
            blocked2.is_some(),
            "the real line 'sudo reboot' must be blocked"
        );
    }
}
