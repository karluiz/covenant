//! Super-agent loop, world model, and Anthropic client for karl-terminal.
//!
//! M3 lands the read-only agent. This file only exists so the workspace
//! compiles cleanly.

pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}
