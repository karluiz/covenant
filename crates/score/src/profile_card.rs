//! Pure, side-effect-free composite "Covenant Score" + the aggregates-only
//! public profile snapshot. No DB, no network. See the design doc for the
//! formula and the privacy contract.

use serde::{Deserialize, Serialize};

use crate::achievements::{
    find_definition, AchievementAward, AchievementCategory, AchievementRarity, CategoryRollup,
};
use crate::types::{Summary, User};

const REP_SCALE: f64 = 600.0;
const STREAK_SCALE: f64 = 21.0;
const W_REP: f64 = 0.70;
const W_ACT: f64 = 0.30;

const ALL_CATEGORIES: [AchievementCategory; 6] = [
    AchievementCategory::Craft,
    AchievementCategory::Safety,
    AchievementCategory::Reliability,
    AchievementCategory::Orchestration,
    AchievementCategory::Memory,
    AchievementCategory::Focus,
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScoreBreakdown {
    pub headline: f64,     // 0.0..=10.0, one decimal
    pub reputation01: f64, // 0..1
    pub activity01: f64,   // 0..1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotDimension {
    pub category: AchievementCategory,
    pub points: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotAward {
    pub achievement_id: String,
    pub tier: u32,
    pub rarity: AchievementRarity,
    pub title: String,
    pub earned_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotTotals {
    pub awards_count: u32,
    pub current_streak: u32,
    pub total_prompts: u64,
    pub total_commits: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicProfileSnapshot {
    pub schema_version: u32,
    pub github_id: i64,
    pub login: String,
    pub avatar_url: String,
    pub generated_at_ms: i64,
    pub score: ScoreBreakdown,
    pub dimensions: Vec<SnapshotDimension>,
    pub awards: Vec<SnapshotAward>,
    pub totals: SnapshotTotals,
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

/// The documented composite score. 70% saturating reputation, 30% saturating streak.
pub fn compute_score(dimensions: &[CategoryRollup], current_streak: u32) -> ScoreBreakdown {
    let rep_total: u32 = dimensions.iter().map(|d| d.points).sum();
    let rep01 = 1.0 - (-(rep_total as f64) / REP_SCALE).exp();
    let act01 = 1.0 - (-(current_streak as f64) / STREAK_SCALE).exp();
    let headline = round1((W_REP * rep01 + W_ACT * act01) * 10.0);
    ScoreBreakdown {
        headline,
        reputation01: rep01,
        activity01: act01,
    }
}

/// Build the aggregates-only public snapshot. Explicitly constructs each field;
/// never copies `AchievementAward.repo`/`branch`/scope ids.
pub fn build_snapshot(
    user: &User,
    summary: &Summary,
    by_category: &[CategoryRollup],
    awards: &[AchievementAward],
    generated_at_ms: i64,
) -> PublicProfileSnapshot {
    let score = compute_score(by_category, summary.current_streak);

    let dimensions = ALL_CATEGORIES
        .iter()
        .map(|c| SnapshotDimension {
            category: *c,
            points: by_category
                .iter()
                .find(|r| r.category == *c)
                .map(|r| r.points)
                .unwrap_or(0),
        })
        .collect();

    let snapshot_awards = awards
        .iter()
        .map(|a| SnapshotAward {
            achievement_id: a.achievement_id.clone(),
            tier: a.tier,
            rarity: find_definition(&a.achievement_id)
                .map(|d| d.rarity)
                .unwrap_or(AchievementRarity::Common),
            title: a.title.clone(),
            earned_at_ms: a.earned_at_ms,
        })
        .collect::<Vec<_>>();

    PublicProfileSnapshot {
        schema_version: 1,
        github_id: user.github_id,
        login: user.login.clone(),
        avatar_url: user.avatar_url.clone(),
        generated_at_ms,
        score,
        dimensions,
        awards: snapshot_awards,
        totals: SnapshotTotals {
            awards_count: awards.len() as u32,
            current_streak: summary.current_streak,
            total_prompts: summary.total_prompts,
            total_commits: summary.total_commits,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::achievements::AchievementAward;
    use crate::achievements::{AchievementCategory, CategoryRollup};
    use crate::types::{Summary, User};

    fn rollup(cat: AchievementCategory, points: u32) -> CategoryRollup {
        CategoryRollup {
            category: cat,
            points,
        }
    }

    #[test]
    fn fresh_user_scores_near_zero() {
        let s = compute_score(&[], 0);
        assert!(s.headline < 0.1, "got {}", s.headline);
        assert_eq!(s.reputation01, 0.0);
        assert_eq!(s.activity01, 0.0);
    }

    #[test]
    fn solid_user_lands_in_mid_high_band() {
        // ~900 reputation points + a 14-day streak
        let dims = [
            rollup(AchievementCategory::Craft, 600),
            rollup(AchievementCategory::Reliability, 300),
        ];
        let s = compute_score(&dims, 14);
        assert!(s.headline >= 6.0 && s.headline <= 9.0, "got {}", s.headline);
    }

    #[test]
    fn score_is_monotonic_in_reputation() {
        let a = compute_score(&[rollup(AchievementCategory::Craft, 200)], 5).headline;
        let b = compute_score(&[rollup(AchievementCategory::Craft, 800)], 5).headline;
        assert!(b > a);
    }

    #[test]
    fn headline_rounded_to_one_decimal_and_capped() {
        let dims = [rollup(AchievementCategory::Craft, 100_000)];
        let s = compute_score(&dims, 100_000);
        assert!(s.headline <= 10.0);
        assert_eq!((s.headline * 10.0).fract(), 0.0, "one decimal place");
    }

    #[test]
    fn snapshot_has_all_six_dimensions_even_when_missing() {
        let user = User {
            github_id: 1,
            login: "x".into(),
            avatar_url: "a".into(),
            connected_at_ms: 0,
        };
        let summary = Summary {
            total_prompts: 10,
            total_commits: 2,
            today_prompts: 0,
            today_commits: 0,
            current_streak: 3,
            longest_streak: 3,
            total_tokens: 0,
            total_specs: 0,
        };
        let snap = build_snapshot(
            &user,
            &summary,
            &[rollup(AchievementCategory::Craft, 50)],
            &[],
            123,
        );
        assert_eq!(snap.dimensions.len(), 6);
        assert_eq!(snap.schema_version, 1);
        assert_eq!(snap.totals.current_streak, 3);
    }

    #[test]
    fn snapshot_never_leaks_repo_or_branch() {
        // An award carries repo/branch internally; the snapshot must drop them.
        let award = AchievementAward {
            id: 1,
            achievement_id: "finisher".into(),
            tier: 2,
            title: "The Finisher".into(),
            subject_type: "operator".into(),
            subject_id: Some("op".into()),
            scope_type: "operator".into(),
            scope_id: Some("op".into()),
            repo: Some("SECRET-REPO".into()),
            branch: Some("SECRET-BRANCH".into()),
            earned_at_ms: 99,
            seen_at_ms: None,
        };
        let user = User {
            github_id: 1,
            login: "x".into(),
            avatar_url: "a".into(),
            connected_at_ms: 0,
        };
        let summary = Summary {
            total_prompts: 0,
            total_commits: 0,
            today_prompts: 0,
            today_commits: 0,
            current_streak: 0,
            longest_streak: 0,
            total_tokens: 0,
            total_specs: 0,
        };
        let snap = build_snapshot(&user, &summary, &[], &[award], 1);
        let json = serde_json::to_string(&snap).unwrap();
        assert!(!json.contains("SECRET-REPO"), "repo leaked into snapshot");
        assert!(
            !json.contains("SECRET-BRANCH"),
            "branch leaked into snapshot"
        );
        assert_eq!(snap.awards.len(), 1);
        assert_eq!(snap.awards[0].achievement_id, "finisher");
    }
}
