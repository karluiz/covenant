use karl_score::agent_label::resolve;

#[test]
fn maps_known_processes() {
    assert_eq!(resolve("claude", &["claude"]),       Some("claude_code"));
    assert_eq!(resolve("node",   &["node", "/usr/local/bin/claude"]), Some("claude_code"));
    assert_eq!(resolve("codex",  &["codex"]),        Some("codex"));
    assert_eq!(resolve("gh",     &["gh", "copilot"]),Some("copilot"));
    assert_eq!(resolve("opencode", &["opencode"]),   Some("opencode"));
    assert_eq!(resolve("pi",     &["pi"]),           Some("pi"));
    assert_eq!(resolve("zsh",    &["zsh"]),          None);
}
