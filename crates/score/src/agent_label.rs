//! Map a foreground process to a canonical execution-agent label.
//!
//! Claude Code overwrites its `comm` to a version string starting in v2.1,
//! so we MUST also inspect argv before falling back to None.

pub fn resolve(comm: &str, argv: &[&str]) -> Option<&'static str> {
    let comm_l = comm.to_lowercase();
    let argv_joined = argv.iter().map(|s| s.to_lowercase()).collect::<Vec<_>>().join(" ");

    let has = |needle: &str| comm_l.contains(needle) || argv_joined.contains(needle);

    if has("claude")   { return Some("claude_code"); }
    if has("codex")    { return Some("codex"); }
    if has("copilot")  { return Some("copilot"); }
    if has("opencode") { return Some("opencode"); }
    if argv_joined.split_whitespace().any(|t| t == "pi") || comm_l == "pi" {
        return Some("pi");
    }
    None
}
