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

// ─── BuildKind + RiskyOutcome enums ───────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildKind {
    Build,
    Test,
    Lint,
}

impl BuildKind {
    fn passed_kind(self) -> &'static str {
        match self {
            BuildKind::Build => "build_command_passed",
            BuildKind::Test => "test_command_passed",
            BuildKind::Lint => "lint_command_passed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskyOutcome {
    Blocked,
    Confirmed,
    Rewritten,
}

impl RiskyOutcome {
    fn kind(self) -> &'static str {
        match self {
            RiskyOutcome::Blocked => "risky_action_blocked",
            RiskyOutcome::Confirmed => "risky_action_confirmed",
            RiskyOutcome::Rewritten => "risky_action_rewritten",
        }
    }
}

/// Stable, deterministic short hash for dedupe keys (FNV-1a 64-bit).
/// Must NOT use DefaultHasher — dedupe keys are persisted, so the hash
/// has to be stable across Rust versions and processes.
fn short_hash(s: &str) -> u64 {
    const FNV_OFFSET: u64 = 14695981039346656037;
    const FNV_PRIME: u64 = 1099511628211;
    s.bytes()
        .fold(FNV_OFFSET, |h, b| (h ^ b as u64).wrapping_mul(FNV_PRIME))
}

// ─── Pure fact builders ─────────────────────────────────────────────────────

pub fn task_verified_fact(operator: &str, repo: Option<&str>, task_id: &str) -> AchievementFact {
    let mut f = AchievementFact::new("task_verified", SubjectKind::Operator)
        .with_subject(operator)
        .with_task(task_id)
        .with_verification(VerificationLevel::UserAccepted)
        .with_dedupe(format!("task_verified:{task_id}"));
    if let Some(r) = repo {
        f = f.with_repo(r);
    }
    f
}

pub fn clean_run_fact(operator: &str, repo: Option<&str>, task_id: &str) -> AchievementFact {
    let mut f = AchievementFact::new("clean_run", SubjectKind::Operator)
        .with_subject(operator)
        .with_task(task_id)
        .with_verification(VerificationLevel::UserAccepted)
        .with_dedupe(format!("clean_run:{task_id}"));
    if let Some(r) = repo {
        f = f.with_repo(r);
    }
    f
}

pub fn task_recovered_fact(orchestrator: &str, task_id: &str) -> AchievementFact {
    AchievementFact::new("task_recovered", SubjectKind::Orchestrator)
        .with_subject(orchestrator)
        .with_task(task_id)
        .with_verification(VerificationLevel::CommandPassed)
        .with_dedupe(format!("task_recovered:{task_id}"))
}

pub fn build_pass_fact(
    kind: BuildKind,
    operator: &str,
    repo: &str,
    command: &str,
) -> AchievementFact {
    let k = kind.passed_kind();
    AchievementFact::new(k, SubjectKind::Operator)
        .with_subject(operator)
        .with_repo(repo)
        .with_verification(VerificationLevel::CommandPassed)
        .with_dedupe(format!("{k}:{repo}:{}", short_hash(command)))
}

pub fn risky_action_fact(outcome: RiskyOutcome, ts_ms: i64) -> AchievementFact {
    AchievementFact::new(outcome.kind(), SubjectKind::System)
        .with_verification(VerificationLevel::SelfReport)
        .with_dedupe(format!("{}:{}", outcome.kind(), ts_ms))
}

pub fn secret_redacted_fact(site: &str, ts_ms: i64) -> AchievementFact {
    AchievementFact::new("secret_redacted", SubjectKind::System)
        .with_verification(VerificationLevel::SelfReport)
        .with_dedupe(format!("secret_redacted:{site}:{ts_ms}"))
}

pub fn spec_kept_fact(operator: &str, repo: &str, task_id: &str) -> AchievementFact {
    AchievementFact::new("spec_kept", SubjectKind::Operator)
        .with_subject(operator)
        .with_repo(repo)
        .with_task(task_id)
        .with_verification(VerificationLevel::SelfReport)
        .with_dedupe(format!("spec_kept:{repo}:{task_id}"))
}

pub fn task_delegated_fact(orchestrator: &str, task_id: &str) -> AchievementFact {
    AchievementFact::new("orchestrator_task_delegated", SubjectKind::Orchestrator)
        .with_subject(orchestrator)
        .with_task(task_id)
        .with_verification(VerificationLevel::SelfReport)
        .with_dedupe(format!("orchestrator_task_delegated:{task_id}"))
}

/// `_kind` is retained for future metadata but does not affect the dedupe key.
pub fn project_command_learned_fact(
    repo: &str,
    command: &str,
    _kind: BuildKind,
) -> AchievementFact {
    AchievementFact::new("project_command_learned", SubjectKind::Project)
        .with_subject(repo)
        .with_repo(repo)
        .with_verification(VerificationLevel::SelfReport)
        .with_dedupe(format!(
            "project_command_learned:{repo}:{}",
            short_hash(command)
        ))
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
    AchievementTier {
        tier: 1,
        label: "Bronze",
        target: 1,
    },
    AchievementTier {
        tier: 2,
        label: "Silver",
        target: 5,
    },
    AchievementTier {
        tier: 3,
        label: "Gold",
        target: 25,
    },
    AchievementTier {
        tier: 4,
        label: "Platinum",
        target: 100,
    },
    AchievementTier {
        tier: 5,
        label: "Diamond",
        target: 500,
    },
];

const HARD_TIERS: &[AchievementTier] = &[
    AchievementTier {
        tier: 1,
        label: "Bronze",
        target: 1,
    },
    AchievementTier {
        tier: 2,
        label: "Silver",
        target: 3,
    },
    AchievementTier {
        tier: 3,
        label: "Gold",
        target: 10,
    },
    AchievementTier {
        tier: 4,
        label: "Platinum",
        target: 25,
    },
    AchievementTier {
        tier: 5,
        label: "Diamond",
        target: 100,
    },
];

const FINISHER_TIERS: &[AchievementTier] = &[
    AchievementTier {
        tier: 1,
        label: "Bronze",
        target: 1,
    },
    AchievementTier {
        tier: 2,
        label: "Silver",
        target: 10,
    },
    AchievementTier {
        tier: 3,
        label: "Gold",
        target: 50,
    },
    AchievementTier {
        tier: 4,
        label: "Platinum",
        target: 250,
    },
    AchievementTier {
        tier: 5,
        label: "Diamond",
        target: 1000,
    },
];

const PROJECT_TIERS: &[AchievementTier] = &[
    AchievementTier {
        tier: 1,
        label: "Bronze",
        target: 1,
    },
    AchievementTier {
        tier: 2,
        label: "Silver",
        target: 3,
    },
    AchievementTier {
        tier: 3,
        label: "Gold",
        target: 10,
    },
    AchievementTier {
        tier: 4,
        label: "Platinum",
        target: 30,
    },
    AchievementTier {
        tier: 5,
        label: "Diamond",
        target: 100,
    },
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
            ReputationWeight {
                dimension: AchievementCategory::Craft,
                weight: 50,
            },
            ReputationWeight {
                dimension: AchievementCategory::Reliability,
                weight: 50,
            },
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
        reputation: &[ReputationWeight {
            dimension: AchievementCategory::Reliability,
            weight: 100,
        }],
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
        reputation: &[ReputationWeight {
            dimension: AchievementCategory::Safety,
            weight: 100,
        }],
        trigger_kinds: &[
            "risky_action_blocked",
            "risky_action_confirmed",
            "risky_action_rewritten",
        ],
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
        reputation: &[ReputationWeight {
            dimension: AchievementCategory::Safety,
            weight: 100,
        }],
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
            ReputationWeight {
                dimension: AchievementCategory::Craft,
                weight: 50,
            },
            ReputationWeight {
                dimension: AchievementCategory::Memory,
                weight: 50,
            },
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
        reputation: &[ReputationWeight {
            dimension: AchievementCategory::Craft,
            weight: 100,
        }],
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
        reputation: &[ReputationWeight {
            dimension: AchievementCategory::Memory,
            weight: 100,
        }],
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
            ReputationWeight {
                dimension: AchievementCategory::Memory,
                weight: 50,
            },
            ReputationWeight {
                dimension: AchievementCategory::Craft,
                weight: 50,
            },
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
            ReputationWeight {
                dimension: AchievementCategory::Orchestration,
                weight: 50,
            },
            ReputationWeight {
                dimension: AchievementCategory::Reliability,
                weight: 50,
            },
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
        reputation: &[ReputationWeight {
            dimension: AchievementCategory::Orchestration,
            weight: 100,
        }],
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
    fn task_verified_fact_targets_finisher() {
        let f = task_verified_fact("op-123", Some("myrepo"), "task-9");
        assert_eq!(f.kind, "task_verified");
        assert_eq!(f.subject_type, SubjectKind::Operator);
        assert_eq!(f.subject_id.as_deref(), Some("op-123"));
        assert_eq!(f.repo.as_deref(), Some("myrepo"));
        assert_eq!(f.verification, Some(VerificationLevel::UserAccepted));
        assert_eq!(f.dedupe_key.as_deref(), Some("task_verified:task-9"));
        assert!(definitions_for_kind(&f.kind)
            .iter()
            .any(|d| d.id == "finisher"));
    }

    #[test]
    fn clean_run_fact_targets_clean_run() {
        let f = clean_run_fact("op-1", None, "t-1");
        assert_eq!(f.kind, "clean_run");
        assert_eq!(f.subject_type, SubjectKind::Operator);
        assert_eq!(f.dedupe_key.as_deref(), Some("clean_run:t-1"));
        assert!(definitions_for_kind(&f.kind)
            .iter()
            .any(|d| d.id == "clean_run"));
    }

    #[test]
    fn task_recovered_fact_is_orchestrator_global() {
        let f = task_recovered_fact("op-1", "t-1");
        assert_eq!(f.kind, "task_recovered");
        assert_eq!(f.subject_type, SubjectKind::Orchestrator);
        assert_eq!(f.subject_id.as_deref(), Some("op-1"));
        assert_eq!(f.dedupe_key.as_deref(), Some("task_recovered:t-1"));
        assert!(definitions_for_kind(&f.kind)
            .iter()
            .any(|d| d.id == "recovery_artist"));
    }

    #[test]
    fn build_pass_facts_map_to_build_steward() {
        for (k, expect) in [
            (BuildKind::Build, "build_command_passed"),
            (BuildKind::Test, "test_command_passed"),
            (BuildKind::Lint, "lint_command_passed"),
        ] {
            let f = build_pass_fact(k, "op-1", "repo", "cargo test");
            assert_eq!(f.kind, expect);
            assert_eq!(f.subject_type, SubjectKind::Operator);
            assert_eq!(f.repo.as_deref(), Some("repo"));
            assert_eq!(f.verification, Some(VerificationLevel::CommandPassed));
            assert!(definitions_for_kind(&f.kind)
                .iter()
                .any(|d| d.id == "build_steward"));
        }
    }

    #[test]
    fn risky_action_facts_map_to_guardian() {
        for (o, expect) in [
            (RiskyOutcome::Blocked, "risky_action_blocked"),
            (RiskyOutcome::Confirmed, "risky_action_confirmed"),
            (RiskyOutcome::Rewritten, "risky_action_rewritten"),
        ] {
            let f = risky_action_fact(o, 1234);
            assert_eq!(f.kind, expect);
            assert_eq!(f.subject_type, SubjectKind::System);
            assert_eq!(
                f.dedupe_key.as_deref(),
                Some(format!("{expect}:1234").as_str())
            );
            assert!(definitions_for_kind(&f.kind)
                .iter()
                .any(|d| d.id == "guardian"));
        }
    }

    #[test]
    fn secret_redacted_fact_targets_secret_keeper() {
        let f = secret_redacted_fact("operator_mind", 99);
        assert_eq!(f.kind, "secret_redacted");
        assert_eq!(f.subject_type, SubjectKind::System);
        assert_eq!(
            f.dedupe_key.as_deref(),
            Some("secret_redacted:operator_mind:99")
        );
        assert!(definitions_for_kind(&f.kind)
            .iter()
            .any(|d| d.id == "secret_keeper"));
    }

    #[test]
    fn spec_kept_fact_targets_spec_keeper() {
        let f = spec_kept_fact("op-1", "repo", "t-1");
        assert_eq!(f.kind, "spec_kept");
        assert_eq!(f.subject_type, SubjectKind::Operator);
        assert_eq!(f.repo.as_deref(), Some("repo"));
        assert_eq!(f.dedupe_key.as_deref(), Some("spec_kept:repo:t-1"));
        assert!(definitions_for_kind(&f.kind)
            .iter()
            .any(|d| d.id == "spec_keeper"));
    }

    #[test]
    fn task_delegated_fact_targets_good_delegate() {
        let d = task_delegated_fact("op-1", "t-1");
        assert_eq!(d.kind, "orchestrator_task_delegated");
        assert_eq!(d.subject_type, SubjectKind::Orchestrator);
        assert!(definitions_for_kind(&d.kind)
            .iter()
            .any(|x| x.id == "good_delegate"));
    }

    #[test]
    fn project_command_learned_fact_targets_command_librarian() {
        let c = project_command_learned_fact("repo", "cargo test", BuildKind::Test);
        assert_eq!(c.kind, "project_command_learned");
        assert_eq!(c.subject_type, SubjectKind::Project);
        assert!(definitions_for_kind(&c.kind)
            .iter()
            .any(|x| x.id == "command_librarian"));
    }

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
