pub mod claude_code;
pub mod codex;
pub mod opencode;
pub mod pi;

use std::sync::Arc;
use std::time::Duration;

pub struct PollerHandle {
    _thread: std::thread::JoinHandle<()>,
}

pub fn start(store: Arc<crate::ScoreStore>) -> PollerHandle {
    let thread = std::thread::spawn(move || loop {
        for p in claude_code::candidate_files() {
            let _ = claude_code::poll_one(&store, &p);
        }
        for p in codex::candidate_files() {
            let _ = codex::poll_one(&store, &p);
        }
        for p in opencode::candidate_files() {
            let _ = opencode::poll_one(&store, &p);
        }
        for p in pi::candidate_files() {
            let _ = pi::poll_one(&store, &p);
        }
        std::thread::sleep(Duration::from_secs(30));
    });
    PollerHandle { _thread: thread }
}
