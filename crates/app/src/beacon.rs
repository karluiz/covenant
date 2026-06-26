//! Beacon: GitHub deployment status for the active session's repo.

/// Parse a GitHub `owner/repo` out of a `git remote` URL. Handles
/// `git@github.com:o/r(.git)`, `https://github.com/o/r(.git)`, and
/// `ssh://git@github.com/o/r(.git)`. Returns None for non-GitHub remotes.
pub fn parse_owner_repo(remote_url: &str) -> Option<(String, String)> {
    let s = remote_url.trim();
    // Strip scheme/userinfo down to "github.com<sep>owner/repo".
    let rest = s
        .strip_prefix("git@")
        .or_else(|| s.strip_prefix("ssh://git@"))
        .or_else(|| s.strip_prefix("https://"))
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(s);
    let rest = rest.strip_prefix("github.com")?;
    // Separator is ':' (scp form) or '/' (url form).
    let path = rest.strip_prefix(':').or_else(|| rest.strip_prefix('/'))?;
    let path = path.trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.splitn(2, '/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty() && !s.contains('/'))?;
    Some((owner.to_string(), repo.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_url_variants() {
        let cases = [
            ("git@github.com:karluiz/covenant.git", Some(("karluiz", "covenant"))),
            ("https://github.com/karluiz/covenant.git", Some(("karluiz", "covenant"))),
            ("https://github.com/karluiz/covenant", Some(("karluiz", "covenant"))),
            ("ssh://git@github.com/karluiz/covenant.git", Some(("karluiz", "covenant"))),
            ("git@gitlab.com:karluiz/covenant.git", None),
            ("", None),
        ];
        for (input, want) in cases {
            let got = parse_owner_repo(input);
            let want = want.map(|(o, r)| (o.to_string(), r.to_string()));
            assert_eq!(got, want, "input={input:?}");
        }
    }
}
