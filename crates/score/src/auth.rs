//! GitHub OAuth Device Flow client. Holds the public client_id (no
//! secret — device flow on OAuth Apps does not require one). Token is
//! persisted in macOS Keychain via the `keyring` crate; user info
//! sits in score.sqlite (session module).

pub const GITHUB_CLIENT_ID: &str = "Ov23liWVUtut6NkCyDAE";

pub const KEYCHAIN_SERVICE: &str = "covenant.uno";
pub const KEYCHAIN_USERNAME: &str = "github-token";
