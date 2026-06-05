//! Canonical secret masker.
//!
//! Single source of truth for redacting credential-shaped runs from any text
//! before it reaches an LLM (operator/teammate context, terminal excerpts,
//! screen captures). `safety::mask_secrets` delegates here so the two never
//! diverge. Output token is `[REDACTED:<kind>]`; the function is idempotent —
//! already-redacted strings won't match again.

use regex::Regex;
use std::sync::OnceLock;

/// Replace anything that looks like a credential with `[REDACTED:<kind>]`.
///
/// Patterns are applied in order, specific before generic, so a key classifies
/// under its most precise kind (e.g. `sk-ant-…` → `anthropic`, not the generic
/// `sk-` fallback). Idempotent: the `[REDACTED:…]` token contains characters
/// outside the credential character classes, so it never re-matches.
pub fn mask_secrets(input: &str) -> String {
    static REGEXES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let regexes = REGEXES.get_or_init(|| {
        vec![
            // Specific shapes first.
            (Regex::new(r"sk-ant-[A-Za-z0-9_\-]{16,}").unwrap(), "anthropic"),
            (Regex::new(r"sk-(proj-)?[A-Za-z0-9_\-]{20,}").unwrap(), "openai"),
            (Regex::new(r"gh[pousr]_[A-Za-z0-9]{20,}").unwrap(), "github"),
            (Regex::new(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b").unwrap(), "aws"),
            (
                Regex::new(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b")
                    .unwrap(),
                "jwt",
            ),
            (
                Regex::new(r"-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----").unwrap(),
                "pem",
            ),
            // Generic fallbacks last (spec §6). The generic `sk-` class excludes
            // `-`/`_` so it cannot span the dashed anthropic/openai shapes above.
            (Regex::new(r"sk-[A-Za-z0-9]{16,}").unwrap(), "apikey"),
            (Regex::new(r"Bearer\s+[A-Za-z0-9._\-]{16,}").unwrap(), "bearer"),
        ]
    });
    let mut out = input.to_string();
    for (re, kind) in regexes.iter() {
        out = re
            .replace_all(&out, format!("[REDACTED:{kind}]"))
            .into_owned();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::mask_secrets;

    #[test]
    fn redacts_anthropic_key() {
        let masked = mask_secrets("token=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA suffix");
        assert!(!masked.contains("sk-ant-api03"), "got: {masked}");
        assert!(masked.contains("[REDACTED:anthropic]"), "got: {masked}");
    }

    #[test]
    fn redacts_openai_project_key() {
        let masked = mask_secrets("key sk-proj-abcdefghijklmnopqrstuvwxyz1234 end");
        assert!(!masked.contains("sk-proj-abcdefghij"), "got: {masked}");
        assert!(masked.contains("[REDACTED:openai]"), "got: {masked}");
    }

    #[test]
    fn redacts_github_token_inside_bearer() {
        let masked = mask_secrets("Bearer ghp_abcdefghijklmnopqrst1234");
        assert!(!masked.contains("ghp_abcdefghi"), "got: {masked}");
        assert!(masked.contains("[REDACTED:github]"), "got: {masked}");
    }

    #[test]
    fn redacts_aws_access_key() {
        let masked = mask_secrets("id=AKIAIOSFODNN7EXAMPLE done");
        assert!(!masked.contains("AKIAIOSFODNN7EXAMPLE"), "got: {masked}");
        assert!(masked.contains("[REDACTED:aws]"), "got: {masked}");
    }

    #[test]
    fn redacts_jwt() {
        let masked =
            mask_secrets("auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eHh4In0.aaaaaaaaaaaa here");
        assert!(!masked.contains("eyJhbGci"), "got: {masked}");
        assert!(masked.contains("[REDACTED:jwt]"), "got: {masked}");
    }

    #[test]
    fn redacts_pem_header() {
        let masked = mask_secrets("-----BEGIN RSA PRIVATE KEY-----\nMIIE");
        assert!(masked.contains("[REDACTED:pem]"), "got: {masked}");
    }

    // NEW patterns the legacy safety masker lacked (spec §6):

    #[test]
    fn redacts_generic_sk_key_too_short_for_openai_pattern() {
        // 16 alnum chars after `sk-` — below the openai 20-char threshold, so
        // only the generic `sk-` pattern catches it.
        let masked = mask_secrets("use sk-abcd1234efgh5678 now");
        assert!(!masked.contains("sk-abcd1234efgh5678"), "got: {masked}");
        assert!(masked.contains("[REDACTED:"), "got: {masked}");
    }

    #[test]
    fn redacts_bearer_token() {
        let masked = mask_secrets("Authorization: Bearer mF9aQ2pLk8vR3nT0wZ");
        assert!(!masked.contains("mF9aQ2pLk8vR3nT0wZ"), "got: {masked}");
        assert!(masked.contains("[REDACTED:"), "got: {masked}");
    }

    #[test]
    fn leaves_clean_text_untouched() {
        let clean = "no secrets here, just words and a task-list";
        assert_eq!(mask_secrets(clean), clean);
    }

    #[test]
    fn idempotent_on_already_redacted() {
        let already = "before [REDACTED:anthropic] after";
        assert_eq!(mask_secrets(already), already);
    }
}
