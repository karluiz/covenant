pub mod claude_code;

use std::sync::Arc;
use std::time::Duration;

pub struct PollerHandle { _thread: std::thread::JoinHandle<()> }

pub fn start(store: Arc<crate::ScoreStore>) -> PollerHandle {
    let thread = std::thread::spawn(move || loop {
        for p in claude_code::candidate_files() { let _ = claude_code::poll_one(&store, &p); }
        std::thread::sleep(Duration::from_secs(30));
    });
    PollerHandle { _thread: thread }
}
