//! Achievements: definitions, catalog, and pure rule helpers.
//!
//! Storage lives in [`crate::store`]. Public recording API lives in [`crate::lib`].
//! This module is intentionally side-effect-free except for serialization.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum AchievementCategory {
    Craft,
    Safety,
    Reliability,
    Orchestration,
    Memory,
    Focus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AchievementRarity {
    Common,
    Uncommon,
    Rare,
    Epic,
    Legendary,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SubjectKind {
    Operator,
    Orchestrator,
    Project,
    User,
    System,
}

impl SubjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SubjectKind::Operator => "operator",
            SubjectKind::Orchestrator => "orchestrator",
            SubjectKind::Project => "project",
            SubjectKind::User => "user",
            SubjectKind::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    Global,
    Repo,
    Operator,
    Orchestrator,
}

impl ScopeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScopeKind::Global => "global",
            ScopeKind::Repo => "repo",
            ScopeKind::Operator => "operator",
            ScopeKind::Orchestrator => "orchestrator",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationLevel {
    None,
    SelfReport,
    CommandPassed,
    UserAccepted,
    CommitObserved,
    ReleaseEvent,
}

impl VerificationLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            VerificationLevel::None => "none",
            VerificationLevel::SelfReport => "self_report",
            VerificationLevel::CommandPassed => "command_passed",
            VerificationLevel::UserAccepted => "user_accepted",
            VerificationLevel::CommitObserved => "commit_observed",
            VerificationLevel::ReleaseEvent => "release_event",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AchievementTier {
    pub tier: u8,
    pub label: &'static str,
    pub target: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReputationWeight {
    pub dimension: AchievementCategory,
    pub weight: u8, // out of 100; multiple weights split tier points
}

#[derive(Debug, Clone, Serialize)]
pub struct AchievementDefinition {
    pub id: &'static str,
    pub title: &'static str,
    pub summary: &'static str,
    pub category: AchievementCategory,
    pub rarity: AchievementRarity,
    pub subject: SubjectKind,
    pub scope: ScopeKind,
    pub hidden: bool,
    pub tiers: &'static [AchievementTier],
    pub reputation: &'static [ReputationWeight],
    /// Fact kinds that increment progress for this achievement.
    pub trigger_kinds: &'static [&'static str],
}

/// A fact recorded by some emitter. The achievement engine consumes these.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AchievementFact {
    pub kind: String,
    pub subject_type: SubjectKind,
    pub subject_id: Option<String>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub group_name: Option<String>,
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub verification: Option<VerificationLevel>,
    pub dedupe_key: Option<String>,
}

impl AchievementFact {
    pub fn new(kind: impl Into<String>, subject_type: SubjectKind) -> Self {
        Self {
            kind: kind.into(),
            subject_type,
            subject_id: None,
            repo: None,
            branch: None,
            group_name: None,
            session_id: None,
            task_id: None,
            verification: None,
            dedupe_key: None,
        }
    }

    pub fn with_subject(mut self, id: impl Into<String>) -> Self {
        self.subject_id = Some(id.into());
        self
    }

    pub fn with_repo(mut self, repo: impl Into<String>) -> Self {
        self.repo = Some(repo.into());
        self
    }

    pub fn with_task(mut self, task_id: impl Into<String>) -> Self {
        self.task_id = Some(task_id.into());
        self
    }

    pub fn with_verification(mut self, v: VerificationLevel) -> Self {
        self.verification = Some(v);
        self
    }

    pub fn with_dedupe(mut self, key: impl Into<String>) -> Self {
        self.dedupe_key = Some(key.into());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AchievementProgress {
    pub achievement_id: String,
    pub subject_type: String,
    pub subject_id: Option<String>,
    pub scope_type: String,
    pub scope_id: Option<String>,
    pub tier: u32,
    pub progress: u32,
    pub target: u32,
    pub next_tier: Option<u32>,
    pub earned_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AchievementAward {
    pub id: i64,
    pub achievement_id: String,
    pub tier: u32,
    pub title: String,
    pub subject_type: String,
    pub subject_id: Option<String>,
    pub scope_type: String,
    pub scope_id: Option<String>,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub earned_at_ms: i64,
    pub seen_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AchievementSummary {
    pub total_awards: u32,
    pub by_category: Vec<CategoryRollup>,
    pub recent_awards: Vec<AchievementAward>,
    pub in_progress: Vec<AchievementProgress>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CategoryRollup {
    pub category: AchievementCategory,
    pub points: u32,
}

// ─── Tier point table (per spec §6.3) ─────────────────────────────────────────

pub fn tier_points(tier: u8) -> u32 {
    match tier {
        1 => 10,
        2 => 25,
        3 => 60,
        4 => 150,
        5 => 400,
        _ => 0,
    }
}

// ─── Tier helpers ─────────────────────────────────────────────────────────────

/// Returns the tier number (1..=5) crossed at exactly `progress`, if any.
pub fn tier_at(progress: u32, tiers: &[AchievementTier]) -> u32 {
    let mut highest = 0u32;
    for t in tiers {
        if progress >= t.target {
            highest = t.tier as u32;
        }
    }
    highest
}

pub fn next_tier(progress: u32, tiers: &[AchievementTier]) -> Option<(u32, u32)> {
    for t in tiers {
        if progress < t.target {
            return Some((t.tier as u32, t.target));
        }
    }
    None
}

// ─── Catalog ──────────────────────────────────────────────────────────────────
// Common/hard/rare habit count targets per spec §6.1.

const COMMON_TIERS: &[AchievementTier] = &[
    AchievementTier { tier: 1, label: "Bronze",   target: 1   },
    AchievementTier { tier: 2, label: "Silver",   target: 5   },
    AchievementTier { tier: 3, label: "Gold",     target: 25  },
    AchievementTier { tier: 4, label: "Platinum", target: 100 },
    AchievementTier { tier: 5, label: "Diamond",  target: 500 },
];

const HARD_TIERS: &[AchievementTier] = &[
    AchievementTier { tier: 1, label: "Bronze",   target: 1   },
    AchievementTier { tier: 2, label: "Silver",   target: 3   },
    AchievementTier { tier: 3, label: "Gold",     target: 10  },
    AchievementTier { tier: 4, label: "Platinum", target: 25  },
    AchievementTier { tier: 5, label: "Diamond",  target: 100 },
];

const FINISHER_TIERS: &[AchievementTier] = &[
    AchievementTier { tier: 1, label: "Bronze",   target: 1    },
    AchievementTier { tier: 2, label: "Silver",   target: 10   },
    AchievementTier { tier: 3, label: "Gold",     target: 50   },
    AchievementTier { tier: 4, label: "Platinum", target: 250  },
    AchievementTier { tier: 5, label: "Diamond",  target: 1000 },
];

const PROJECT_TIERS: &[AchievementTier] = &[
    AchievementTier { tier: 1, label: "Bronze",   target: 1   },
    AchievementTier { tier: 2, label: "Silver",   target: 3   },
    AchievementTier { tier: 3, label: "Gold",     target: 10  },
    AchievementTier { tier: 4, label: "Platinum", target: 30  },
    AchievementTier { tier: 5, label: "Diamond",  target: 100 },
];

pub const CATALOG: &[AchievementDefinition] = &[
    AchievementDefinition {
        id: "clean_run",
        title: "Clean Run",
        summary: "Verified task completed with no failed command blocks.",
        category: AchievementCategory::Craft,
        rarity: AchievementRarity::Common,
        subject: SubjectKind::Operator,
        scope: ScopeKind::Operator,
        hidden: false,
        tiers: COMMON_TIERS,
        reputation: &[
            ReputationWeight { dimension: AchievementCategory::Craft, weight: 50 },
            ReputationWeight { dimension: AchievementCategory::Reliability, weight: 50 },
        ],
        trigger_kinds: &["clean_run"],
    },
    AchievementDefinition {
        id: "finisher",
        title: "The Finisher",
        summary: "Task completed with verification or user acceptance.",
        category: AchievementCategory::Reliability,
        rarity: AchievementRarity::Common,
        subject: SubjectKind::Operator,
        scope: ScopeKind::Operator,
        hidden: false,
        tiers: FINISHER_TIERS,
        reputation: &[ReputationWeight { dimension: AchievementCategory::Reliability, weight: 100 }],
        trigger_kinds: &["task_verified"],
    },
    AchievementDefinition {
        id: "guardian",
        title: "Guardian",
        summary: "Risky action handled safely through the safety pipeline.",
        category: AchievementCategory::Safety,
        rarity: AchievementRarity::Uncommon,
        subject: SubjectKind::System,
        scope: ScopeKind::Global,
        hidden: false,
        tiers: COMMON_TIERS,
        reputation: &[ReputationWeight { dimension: AchievementCategory::Safety, weight: 100 }],
        trigger_kinds: &["risky_action_blocked", "risky_action_confirmed", "risky_action_rewritten"],
    },
    AchievementDefinition {
        id: "secret_keeper",
        title: "Secret Keeper",
        summary: "Secret-like material redacted before storage or dispatch.",
        category: AchievementCategory::Safety,
        rarity: AchievementRarity::Common,
        subject: SubjectKind::System,
        scope: ScopeKind::Global,
        hidden: false,
        tiers: COMMON_TIERS,
        reputation: &[ReputationWeight { dimension: AchievementCategory::Safety, weight: 100 }],
        trigger_kinds: &["secret_redacted"],
    },
    AchievementDefinition {
        id: "spec_keeper",
        title: "Spec Keeper",
        summary: "Reads or creates a spec before first code edit in a task.",
        category: AchievementCategory::Craft,
        rarity: AchievementRarity::Common,
        subject: SubjectKind::Operator,
        scope: ScopeKind::Repo,
        hidden: false,
        tiers: COMMON_TIERS,
        reputation: &[
            ReputationWeight { dimension: AchievementCategory::Craft, weight: 50 },
            ReputationWeight { dimension: AchievementCategory::Memory, weight: 50 },
        ],
        trigger_kinds: &["spec_kept"],
    },
    AchievementDefinition {
        id: "build_steward",
        title: "Build Steward",
        summary: "Build, lint, or test passes after task changes.",
        category: AchievementCategory::Craft,
        rarity: AchievementRarity::Common,
        subject: SubjectKind::Operator,
        scope: ScopeKind::Repo,
        hidden: false,
        tiers: COMMON_TIERS,
        reputation: &[ReputationWeight { dimension: AchievementCategory::Craft, weight: 100 }],
        trigger_kinds: &[
            "build_command_passed",
            "test_command_passed",
            "lint_command_passed",
        ],
    },
    AchievementDefinition {
        id: "cartographer",
        title: "Cartographer",
        summary: "Useful project note, spec, or summary created or updated.",
        category: AchievementCategory::Memory,
        rarity: AchievementRarity::Common,
        subject: SubjectKind::Project,
        scope: ScopeKind::Repo,
        hidden: false,
        tiers: PROJECT_TIERS,
        reputation: &[ReputationWeight { dimension: AchievementCategory::Memory, weight: 100 }],
        trigger_kinds: &["project_note_created"],
    },
    AchievementDefinition {
        id: "command_librarian",
        title: "Command Librarian",
        summary: "Test, build, lint, or dev command learned for this repo.",
        category: AchievementCategory::Memory,
        rarity: AchievementRarity::Uncommon,
        subject: SubjectKind::Project,
        scope: ScopeKind::Repo,
        hidden: false,
        tiers: PROJECT_TIERS,
        reputation: &[
            ReputationWeight { dimension: AchievementCategory::Memory, weight: 50 },
            ReputationWeight { dimension: AchievementCategory::Craft, weight: 50 },
        ],
        trigger_kinds: &["project_command_learned"],
    },
    AchievementDefinition {
        id: "recovery_artist",
        title: "Recovery Artist",
        summary: "Blocked or failed task recovered and later completed.",
        category: AchievementCategory::Orchestration,
        rarity: AchievementRarity::Rare,
        subject: SubjectKind::Orchestrator,
        scope: ScopeKind::Global,
        hidden: false,
        tiers: HARD_TIERS,
        reputation: &[
            ReputationWeight { dimension: AchievementCategory::Orchestration, weight: 50 },
            ReputationWeight { dimension: AchievementCategory::Reliability, weight: 50 },
        ],
        trigger_kinds: &["task_recovered"],
    },
    AchievementDefinition {
        id: "good_delegate",
        title: "Good Delegate",
        summary: "Orchestrator split a task and delegated at least one subtask successfully.",
        category: AchievementCategory::Orchestration,
        rarity: AchievementRarity::Uncommon,
        subject: SubjectKind::Orchestrator,
        scope: ScopeKind::Global,
        hidden: false,
        tiers: HARD_TIERS,
        reputation: &[ReputationWeight { dimension: AchievementCategory::Orchestration, weight: 100 }],
        trigger_kinds: &["orchestrator_task_delegated"],
    },
];

pub fn find_definition(id: &str) -> Option<&'static AchievementDefinition> {
    CATALOG.iter().find(|d| d.id == id)
}

pub fn definitions_for_kind(kind: &str) -> Vec<&'static AchievementDefinition> {
    CATALOG
        .iter()
        .filter(|d| d.trigger_kinds.contains(&kind))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_at_returns_highest_crossed() {
        assert_eq!(tier_at(0, COMMON_TIERS), 0);
        assert_eq!(tier_at(1, COMMON_TIERS), 1);
        assert_eq!(tier_at(4, COMMON_TIERS), 1);
        assert_eq!(tier_at(5, COMMON_TIERS), 2);
        assert_eq!(tier_at(100, COMMON_TIERS), 4);
        assert_eq!(tier_at(10_000, COMMON_TIERS), 5);
    }

    #[test]
    fn next_tier_walks_targets() {
        assert_eq!(next_tier(0, COMMON_TIERS), Some((1, 1)));
        assert_eq!(next_tier(1, COMMON_TIERS), Some((2, 5)));
        assert_eq!(next_tier(500, COMMON_TIERS), None);
    }

    #[test]
    fn catalog_lookup() {
        assert!(find_definition("clean_run").is_some());
        assert!(find_definition("nope").is_none());
        let hits: Vec<_> = definitions_for_kind("secret_redacted")
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(hits, vec!["secret_keeper"]);
    }
}
