use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Prompt,
    Commit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreEvent {
    pub timestamp_ms: i64,
    pub kind: EventKind,
    /// "anthropic" / "openai_compat" / "<repo>:<sha7>" for commits
    pub executor: String,
    #[serde(default)]
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyCell {
    /// ISO date (YYYY-MM-DD), local tz of recording device.
    pub day: String,
    pub prompts: u32,
    pub commits: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub total_prompts: u64,
    pub total_commits: u64,
    pub today_prompts: u32,
    pub today_commits: u32,
    pub current_streak: u32,
    pub longest_streak: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub github_id: i64,
    pub login: String,
    pub avatar_url: String,
    pub connected_at_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Context {
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub group_name: Option<String>,
}

pub fn day_from_ms_local(ms: i64) -> String {
    let dt: DateTime<Utc> = DateTime::from_timestamp_millis(ms).unwrap_or_default();
    let local = dt.with_timezone(&chrono::Local);
    local.format("%Y-%m-%d").to_string()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeRange {
    All,
    Last7d,
    Last30d,
}
impl Default for TimeRange {
    fn default() -> Self {
        Self::All
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScoreFilter {
    #[serde(default)]
    pub range: TimeRange,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub group_name: Option<String>,
    pub day: Option<String>, // "YYYY-MM-DD"
    #[serde(default)]
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoCell {
    pub repo: String,
    pub prompts: u32,
    pub commits: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchCell {
    pub branch: String,
    pub prompts: u32,
    pub commits: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupCell {
    pub group_name: String,
    pub prompts: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRow {
    pub start_ts: i64,
    pub end_ts: i64,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub group_name: Option<String>,
    pub prompts: u32,
    pub commits: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecRow {
    pub ts_ms: i64,
    pub path: String,
    pub repo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecBreakdown {
    pub total: u32,
    pub recent: Vec<SpecRow>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelSource { Internal, External }

#[derive(Debug, Clone, Copy, Default)]
pub struct LlmUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCell {
    pub source: ModelSource,
    pub agent: Option<String>,
    pub provider: String,
    pub model: String,
    pub calls: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCell {
    pub agent: String,
    pub prompts: u32,
    pub share: f32,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn day_format_matches_iso() {
        let d = day_from_ms_local(0);
        // 1970-01-01 in any tz produces YYYY-MM-DD shape
        assert_eq!(d.len(), 10);
        assert_eq!(&d[4..5], "-");
    }
}
