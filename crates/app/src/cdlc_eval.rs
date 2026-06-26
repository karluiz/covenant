//! Agentic eval harness: run `claude -p <scenario>` in a throwaway sandbox
//! with the skill-under-test projected, capture the transcript, judge it.
//!
//! Safety (#1 risk): the run is confined to a temp `cwd` + a deny-list
//! `settings.json` + a hard timeout. Not a true sandbox — a hardened
//! container is a follow-up. Authored scenarios are semi-trusted.

use std::path::Path;
use std::time::{Duration, Instant};

const HARNESS_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Clone, PartialEq)]
pub enum HarnessStatus {
    Ran,
    TimedOut,
    Skipped(String),
}

#[derive(Debug, Clone)]
pub struct HarnessOutcome {
    pub transcript: String,
    pub status: HarnessStatus,
    pub duration_ms: u64,
}

/// True if the `claude` CLI is on PATH and runnable.
pub fn claude_available() -> bool {
    std::process::Command::new("claude")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Deny-list mirroring `crates/agent/src/safety.rs` — keeps a prompt-injected
/// scenario from doing damage even inside the sandbox cwd.
fn denylist_settings() -> String {
    serde_json::json!({
        "permissions": {
            "deny": [
                "Bash(rm:*)",
                "Bash(sudo:*)",
                "Bash(su:*)",
                "Bash(dd:*)",
                "Bash(mkfs:*)",
                "Bash(curl:*)",
                "Bash(wget:*)",
                "Bash(git push:*)",
                "WebFetch",
                "WebSearch"
            ]
        }
    })
    .to_string()
}

/// Create a temp dir, project the skill into `.claude/skills/cdlc-<skill>/`,
/// and write the deny-list `settings.json`. Errors if SKILL.md is missing.
pub(crate) fn prepare_sandbox(repo_root: &Path, skill: &str) -> std::io::Result<tempfile::TempDir> {
    let src = karl_cdlc::cdlc_dir(repo_root)
        .join("skills")
        .join(skill)
        .join("SKILL.md");
    let body = std::fs::read_to_string(&src)?; // missing skill → Err
    let sbox = tempfile::Builder::new().prefix("eval-sbox-").tempdir()?;
    let skill_dir = sbox.path().join(".claude/skills").join(format!("cdlc-{skill}"));
    std::fs::create_dir_all(&skill_dir)?;
    std::fs::write(skill_dir.join("SKILL.md"), body)?;
    std::fs::write(sbox.path().join(".claude/settings.json"), denylist_settings())?;
    Ok(sbox)
}

/// Run one scenario through `claude -p` in the sandbox. Confined by cwd-jail +
/// deny-list + timeout. ponytail: bypassPermissions is safe only because the
/// cwd is empty and the deny-list blocks the dangerous tools; harden with a
/// container before running untrusted third-party evals.
pub async fn run_harness(repo_root: &Path, skill: &str, scenario: &str) -> HarnessOutcome {
    let started = Instant::now();
    if !claude_available() {
        return HarnessOutcome {
            transcript: String::new(),
            status: HarnessStatus::Skipped("claude CLI not found on PATH".into()),
            duration_ms: 0,
        };
    }
    let sbox = match prepare_sandbox(repo_root, skill) {
        Ok(s) => s,
        Err(e) => {
            return HarnessOutcome {
                transcript: String::new(),
                status: HarnessStatus::Skipped(format!("sandbox prep failed: {e}")),
                duration_ms: started.elapsed().as_millis() as u64,
            }
        }
    };

    let mut cmd = tokio::process::Command::new("claude");
    cmd.arg("-p")
        .arg(scenario)
        .arg("--permission-mode")
        .arg("bypassPermissions")
        .current_dir(sbox.path())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);

    let (transcript, status) =
        match tokio::time::timeout(Duration::from_secs(HARNESS_TIMEOUT_SECS), cmd.output()).await {
            Err(_) => (String::new(), HarnessStatus::TimedOut),
            Ok(Err(e)) => (String::new(), HarnessStatus::Skipped(format!("claude spawn failed: {e}"))),
            Ok(Ok(out)) => (
                String::from_utf8_lossy(&out.stdout).to_string(),
                HarnessStatus::Ran,
            ),
        };
    HarnessOutcome {
        transcript,
        status,
        duration_ms: started.elapsed().as_millis() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn prepare_sandbox_projects_skill_and_denylist() {
        let repo = tempfile::tempdir().unwrap();
        let skill_dir = repo.path().join(".covenant/cdlc/skills/kyc-peru");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# KYC Peru\nrefuse without KYC").unwrap();

        let sbox = prepare_sandbox(repo.path(), "kyc-peru").unwrap();
        let projected = sbox.path().join(".claude/skills/cdlc-kyc-peru/SKILL.md");
        assert!(projected.exists(), "skill projected into sandbox");
        assert!(
            fs::read_to_string(&projected).unwrap().contains("refuse without KYC"),
            "skill body copied"
        );
        let settings = sbox.path().join(".claude/settings.json");
        assert!(settings.exists(), "deny-list settings written");
        assert!(
            fs::read_to_string(&settings).unwrap().contains("Bash(rm:*)"),
            "deny-list mirrors the safety blocklist"
        );
    }

    #[test]
    fn missing_skill_md_is_an_error() {
        let repo = tempfile::tempdir().unwrap();
        assert!(prepare_sandbox(repo.path(), "nope").is_err());
    }
}
