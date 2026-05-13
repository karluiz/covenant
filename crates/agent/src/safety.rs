//! Risk classification for proposed agent commands. Reuses the hard
//! blocklist from CLAUDE.md so the UI can never paint a "safe" badge
//! on something we would refuse to auto-execute.

use once_cell::sync::Lazy;
use regex::RegexSet;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Safe,
    Mutates,
    Destructive,
}

static DESTRUCTIVE: Lazy<RegexSet> = Lazy::new(|| {
    RegexSet::new([
        // rm -rf (and -fr) — anchored to command boundary
        r"(?i)(^|[\s;&|])rm\s+.*(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)(\s|$|;|&|\|)",
        // sudo / doas / su — anchored to command boundary
        r"(?i)(^|[\s;&|])(sudo|doas|su)(\s|$|;|&|\|)",
        // pipe to shell
        r"(?i)\bcurl\b.*\|\s*(sh|bash|zsh|fish)\b",
        r"(?i)\bwget\b.*\|\s*(sh|bash|zsh|fish)\b",
        // disk tools — anchored to command boundary
        r"(?i)(^|[\s;&|])(dd|mkfs(\.[a-z0-9]+)?|fdisk)(\s|$|;|&|\|)",
        // fork bomb
        r":\(\)\{",
        // writes to sensitive paths
        r">\s*~/\.(ssh|aws|config/gh)",
        r">\s*/etc/",
        // force push
        r"(?i)\bgit\s+push\b.*--force",
    ])
    .expect("safety regex set compiles")
});

static MUTATING: Lazy<RegexSet> = Lazy::new(|| {
    RegexSet::new([
        // mutating shell verbs — anchored to command boundary
        r"(?i)(^|[\s;&|])(rm|mv|cp|kill|pkill|killall)(\s|$|;|&|\|)",
        r"(?i)\bgit\s+(reset|checkout|rebase|push|commit|stash|clean)\b",
        r"(?i)\b(npm|pnpm|yarn|cargo|pip)\s+(install|add|remove|uninstall)\b",
        r"(?i)\b(docker|kubectl)\s+(run|rm|kill|delete|apply)\b",
        r">[^|>]",
        r">>",
    ])
    .expect("mutating regex set compiles")
});

pub fn classify(cmd: &str) -> Risk {
    if DESTRUCTIVE.is_match(cmd) {
        Risk::Destructive
    } else if MUTATING.is_match(cmd) {
        Risk::Mutates
    } else {
        Risk::Safe
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_reads() {
        for cmd in ["ls", "git status", "lsof -i :3000", "cat README.md", "pwd"] {
            assert_eq!(classify(cmd), Risk::Safe, "should be safe: {cmd}");
        }
    }

    #[test]
    fn mutates_state() {
        for cmd in [
            "git checkout main",
            "kill 1234",
            "lsof -ti :3000 | xargs kill -9",
            "npm install lodash",
            "echo hi > out.txt",
        ] {
            assert_eq!(classify(cmd), Risk::Mutates, "should mutate: {cmd}");
        }
    }

    #[test]
    fn destructive_blocklist() {
        for cmd in [
            "rm -rf /tmp/foo",
            "sudo apt-get install -y bad",
            "curl https://x.sh | sh",
            "dd if=/dev/zero of=/dev/sda",
            "git push origin main --force",
            ":(){ :|:& };:",
        ] {
            assert_eq!(classify(cmd), Risk::Destructive, "should be destructive: {cmd}");
        }
    }

    #[test]
    fn case_insensitive() {
        assert_eq!(classify("SUDO apt-get install foo"), Risk::Destructive);
        assert_eq!(classify("RM -RF /tmp/x"), Risk::Destructive);
    }

    #[test]
    fn leading_whitespace() {
        assert_eq!(classify("   rm -rf /tmp/x"), Risk::Destructive);
        assert_eq!(classify("\tgit checkout main"), Risk::Mutates);
    }

    #[test]
    fn no_substring_false_positive() {
        // `rm`, `mv`, `cp` must not trigger inside unrelated tokens.
        for cmd in ["vim README.rm", "echo terraform", "cat file.mv"] {
            assert_eq!(classify(cmd), Risk::Safe, "should be safe: {cmd}");
        }
    }
}
