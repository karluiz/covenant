use karl_score::achievements::{
    AchievementAward, AchievementDefinition, AchievementProgress, AchievementSummary, CATALOG,
};
use karl_score::{
    AgentCell, BranchCell, DailyCell, GroupCell, ModelCell, ModelSource, RepoCell, ScoreFilter,
    ScoreStore, SessionRow, SkillUseCell, SpecBreakdown, Summary,
};
use std::sync::Arc;
use tauri::State;

pub struct ScoreState(pub Arc<ScoreStore>);

// Every read below scans score.sqlite (320MB+ in real use). A sync
// #[tauri::command] runs inline in the webview's URL-scheme handler ON THE
// NATIVE MAIN THREAD — after idle the file cache is cold and a summary()
// full scan blocked the UI for 1-2.5s (the "first tab switch after idle"
// beachball, sampled live 2026-08-04). async + spawn_blocking keeps the
// scan off the main thread. Do not add a sync DB-touching command here.
async fn blocking<T: Send + 'static>(
    store: Arc<ScoreStore>,
    f: impl FnOnce(&ScoreStore) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || f(&store))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn score_summary(state: State<'_, ScoreState>) -> Result<Summary, String> {
    blocking(state.0.clone(), |s| s.summary().map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn score_heatmap(state: State<'_, ScoreState>) -> Result<Vec<DailyCell>, String> {
    blocking(state.0.clone(), |s| s.heatmap_all().map_err(|e| e.to_string())).await
}

#[tauri::command]
pub fn score_set_current_session(
    session_id: Option<String>,
    cwd: Option<String>,
    group_name: Option<String>,
    workspace: Option<String>,
    group_color: Option<String>,
) {
    // Refresh the group's live identity color so breakdowns can paint
    // entity-colored bars. Independent of whether a session is active.
    if let (Some(name), Some(color)) = (group_name.as_deref(), group_color.as_deref()) {
        karl_score::note_group_color(name, color);
    }
    match (session_id, cwd) {
        (Some(sid), Some(c)) => {
            karl_score::set_current_session(Some(karl_score::CurrentSession {
                session_id: sid,
                cwd: std::path::PathBuf::from(c),
                group_name,
                workspace,
            }));
        }
        _ => karl_score::set_current_session(None),
    }
}

#[tauri::command]
pub async fn score_summary_filtered(
    state: State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<Summary, String> {
    blocking(state.0.clone(), move |s| {
        s.summary_filtered(&filter).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn score_heatmap_filtered(
    state: State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<Vec<DailyCell>, String> {
    blocking(state.0.clone(), move |s| {
        s.heatmap_filtered(&filter).map_err(|e| e.to_string())
    })
    .await
}

/// Per-skill load counts — the "used" half of Canon's adoption story
/// (installs come from the registry, uses from local score events).
#[tauri::command]
pub async fn score_skill_usage(
    state: State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<Vec<SkillUseCell>, String> {
    blocking(state.0.clone(), move |s| {
        s.skill_usage(&filter).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn score_breakdown_repos(
    state: State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<Vec<RepoCell>, String> {
    blocking(state.0.clone(), move |s| {
        s.breakdown_repos(&filter).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn score_breakdown_branches(
    state: State<'_, ScoreState>,
    repo: String,
    filter: ScoreFilter,
) -> Result<Vec<BranchCell>, String> {
    blocking(state.0.clone(), move |s| {
        s.breakdown_branches(&repo, &filter).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn score_breakdown_groups(
    state: State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<Vec<GroupCell>, String> {
    blocking(state.0.clone(), move |s| {
        s.breakdown_groups(&filter).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn score_recent_sessions(
    state: State<'_, ScoreState>,
    limit: u32,
) -> Result<Vec<SessionRow>, String> {
    blocking(state.0.clone(), move |s| {
        s.recent_sessions(limit).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn score_breakdown_agents(
    state: State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<Vec<AgentCell>, String> {
    blocking(state.0.clone(), move |s| {
        s.breakdown_agents(&filter).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn score_breakdown_specs(
    state: State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<SpecBreakdown, String> {
    blocking(state.0.clone(), move |s| {
        s.breakdown_specs(&filter).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub fn score_achievement_catalog() -> Vec<&'static AchievementDefinition> {
    CATALOG.iter().collect()
}

#[tauri::command]
pub async fn score_achievement_summary(
    state: State<'_, ScoreState>,
) -> Result<AchievementSummary, String> {
    blocking(state.0.clone(), |s| {
        s.achievement_summary().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn score_achievement_progress(
    state: State<'_, ScoreState>,
) -> Result<Vec<AchievementProgress>, String> {
    blocking(state.0.clone(), |s| {
        s.achievement_progress_all().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn score_achievement_awards(
    state: State<'_, ScoreState>,
    limit: Option<u32>,
) -> Result<Vec<AchievementAward>, String> {
    blocking(state.0.clone(), move |s| {
        s.achievement_awards_recent(limit.unwrap_or(50))
            .map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn score_achievement_mark_seen(
    state: State<'_, ScoreState>,
    award_id: i64,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    blocking(state.0.clone(), move |s| {
        s.achievement_mark_seen(award_id, now).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn score_achievement_recompute(state: State<'_, ScoreState>) -> Result<u32, String> {
    blocking(state.0.clone(), |s| {
        s.achievement_recompute().map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn score_breakdown_models(
    state: State<'_, ScoreState>,
    filter: ScoreFilter,
    source: ModelSource,
) -> Result<Vec<ModelCell>, String> {
    blocking(state.0.clone(), move |s| {
        s.breakdown_models(&filter, source).map_err(|e| e.to_string())
    })
    .await
}
