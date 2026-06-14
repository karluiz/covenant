//! Pure classification of a shell command into a build/test/lint kind, for
//! the `build_steward` achievement. Pattern-based; there is no authoritative
//! command registry.

use karl_score::BuildKind;

/// Returns the build kind a command represents, or None if it is not a
/// recognised build/test/lint invocation.
pub fn classify_command(cmd: &str) -> Option<BuildKind> {
    let c = cmd.trim().to_ascii_lowercase();
    // Lint first: `cargo clippy` must not be caught by the `cargo` build arm.
    if c.contains("clippy") || c.contains("eslint") || c.contains("ruff")
        || c.contains("npm run lint") || c.contains("yarn lint")
    {
        return Some(BuildKind::Lint);
    }
    if c.contains("cargo test") || c.contains("npm test") || c.contains("npm run test")
        || c.contains("pytest") || c.contains("go test") || c.contains("make test")
        || c.contains("yarn test")
    {
        return Some(BuildKind::Test);
    }
    if c.contains("cargo build") || c.contains("npm run build") || c.contains("make build")
        || c.contains("go build") || c.contains("cargo check") || c.contains("yarn build")
    {
        return Some(BuildKind::Build);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_each_kind() {
        assert_eq!(classify_command("cargo build --release"), Some(BuildKind::Build));
        assert_eq!(classify_command("cargo test -p foo"), Some(BuildKind::Test));
        assert_eq!(classify_command("cargo clippy --all"), Some(BuildKind::Lint));
        assert_eq!(classify_command("npm run lint"), Some(BuildKind::Lint));
        assert_eq!(classify_command("pytest -q"), Some(BuildKind::Test));
    }

    #[test]
    fn ignores_unrelated_commands() {
        assert_eq!(classify_command("ls -la"), None);
        assert_eq!(classify_command("git status"), None);
        assert_eq!(classify_command("echo cargo build is great"), Some(BuildKind::Build)); // documented over-match
    }
}
