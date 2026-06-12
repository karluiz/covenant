import { invoke } from "@tauri-apps/api/core";

export interface Summary {
  total_prompts: number;
  total_commits: number;
  today_prompts: number;
  today_commits: number;
  current_streak: number;
  longest_streak: number;
  total_tokens: number;
  total_specs: number;
}

export interface DailyCell {
  day: string;
  prompts: number;
  commits: number;
}

export async function scoreSummary(): Promise<Summary> {
  return invoke<Summary>("score_summary");
}

export async function scoreHeatmap(): Promise<DailyCell[]> {
  return invoke<DailyCell[]>("score_heatmap");
}

export interface User {
  github_id: number;
  login: string;
  avatar_url: string;
  connected_at_ms: number;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export async function scoreSigninStart(): Promise<DeviceCodeResponse> {
  return invoke<DeviceCodeResponse>("score_signin_start");
}

export async function scoreSigninPoll(
  device_code: string,
): Promise<User | null> {
  return invoke<User | null>("score_signin_poll", { deviceCode: device_code });
}

export async function scoreCurrentUser(): Promise<User | null> {
  return invoke<User | null>("score_current_user");
}

export async function scoreSignout(): Promise<void> {
  return invoke<void>("score_signout");
}

export interface SyncStatus {
  signed_in: boolean;
  last_synced_at_ms: number;
  last_server_cursor_ms: number;
  pending_events: number;
}

export async function scoreSyncNow(): Promise<number> {
  return invoke<number>("score_sync_now");
}

export async function scoreSyncStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>("score_sync_status");
}

export type TimeRange = "all" | "last7d" | "last30d";

export interface ScoreFilter {
  range?: TimeRange;
  repo?: string | null;
  branch?: string | null;
  group_name?: string | null;
  day?: string | null;
  agent?: string | null;
}

export interface RepoCell { repo: string; prompts: number; commits: number }
export interface BranchCell { branch: string; prompts: number; commits: number }
export interface GroupCell { group_name: string; workspace: string | null; prompts: number }
export interface SessionRow {
  start_ts: number;
  end_ts: number;
  repo: string | null;
  branch: string | null;
  group_name: string | null;
  prompts: number;
  commits: number;
}

export async function scoreSummaryFiltered(filter: ScoreFilter): Promise<Summary> {
  return invoke<Summary>("score_summary_filtered", { filter });
}

export async function scoreHeatmapFiltered(filter: ScoreFilter): Promise<DailyCell[]> {
  return invoke<DailyCell[]>("score_heatmap_filtered", { filter });
}

export async function scoreBreakdownRepos(filter: ScoreFilter): Promise<RepoCell[]> {
  return invoke<RepoCell[]>("score_breakdown_repos", { filter });
}

export async function scoreBreakdownBranches(repo: string, filter: ScoreFilter): Promise<BranchCell[]> {
  return invoke<BranchCell[]>("score_breakdown_branches", { repo, filter });
}

export async function scoreBreakdownGroups(filter: ScoreFilter): Promise<GroupCell[]> {
  return invoke<GroupCell[]>("score_breakdown_groups", { filter });
}

export async function scoreRecentSessions(limit = 10): Promise<SessionRow[]> {
  return invoke<SessionRow[]>("score_recent_sessions", { limit });
}

export interface AgentCell {
  agent: string;
  prompts: number;
  share: number;
}

export interface SpecRow {
  ts_ms: number;
  path: string;
  repo: string | null;
}

export interface SpecBreakdown {
  total: number;
  recent: SpecRow[];
}

export type ModelSource = "internal" | "external";

export interface ModelCell {
  source: ModelSource;
  agent: string | null;
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
}

export async function scoreBreakdownAgents(filter: ScoreFilter): Promise<AgentCell[]> {
  return invoke<AgentCell[]>("score_breakdown_agents", { filter });
}

export async function scoreBreakdownSpecs(filter: ScoreFilter): Promise<SpecBreakdown> {
  return invoke<SpecBreakdown>("score_breakdown_specs", { filter });
}

export async function scoreBreakdownModels(filter: ScoreFilter, source: ModelSource): Promise<ModelCell[]> {
  return invoke<ModelCell[]>("score_breakdown_models", { filter, source });
}

// ─── Achievements ───────────────────────────────────────────────────────────

export type AchievementCategory =
  | "craft" | "safety" | "reliability" | "orchestration" | "memory" | "focus";

export type AchievementRarity =
  | "common" | "uncommon" | "rare" | "epic" | "legendary";

export type AchievementSubjectKind =
  | "operator" | "orchestrator" | "project" | "user" | "system";

export type AchievementScopeKind =
  | "global" | "repo" | "operator" | "orchestrator";

export interface AchievementTier {
  tier: number;
  label: string;
  target: number;
}

export interface ReputationWeight {
  dimension: AchievementCategory;
  weight: number;
}

export interface AchievementDefinition {
  id: string;
  title: string;
  summary: string;
  category: AchievementCategory;
  rarity: AchievementRarity;
  subject: AchievementSubjectKind;
  scope: AchievementScopeKind;
  hidden: boolean;
  tiers: AchievementTier[];
  reputation: ReputationWeight[];
  trigger_kinds: string[];
}

export interface AchievementProgress {
  achievement_id: string;
  subject_type: string;
  subject_id: string | null;
  scope_type: string;
  scope_id: string | null;
  tier: number;
  progress: number;
  target: number;
  next_tier: number | null;
  earned_at_ms?: number;
}

export interface AchievementAward {
  id: number;
  achievement_id: string;
  tier: number;
  title: string;
  subject_type: string;
  subject_id: string | null;
  scope_type: string;
  scope_id: string | null;
  repo: string | null;
  branch: string | null;
  earned_at_ms: number;
  seen_at_ms: number | null;
}

export interface CategoryRollup {
  category: AchievementCategory;
  points: number;
}

export interface AchievementSummary {
  total_awards: number;
  by_category: CategoryRollup[];
  recent_awards: AchievementAward[];
  in_progress: AchievementProgress[];
}

export async function scoreAchievementCatalog(): Promise<AchievementDefinition[]> {
  return invoke<AchievementDefinition[]>("score_achievement_catalog");
}

export async function scoreAchievementSummary(): Promise<AchievementSummary> {
  return invoke<AchievementSummary>("score_achievement_summary");
}

export async function scoreAchievementProgress(): Promise<AchievementProgress[]> {
  return invoke<AchievementProgress[]>("score_achievement_progress");
}

export async function scoreAchievementAwards(limit = 50): Promise<AchievementAward[]> {
  return invoke<AchievementAward[]>("score_achievement_awards", { limit });
}

export async function scoreAchievementMarkSeen(awardId: number): Promise<void> {
  return invoke<void>("score_achievement_mark_seen", { awardId });
}

export async function scoreAchievementRecompute(): Promise<number> {
  return invoke<number>("score_achievement_recompute");
}

/// Comma-separated OAuth scopes granted to the stored GitHub token,
/// or null when signed out / signed in before scopes were recorded.
export async function scoreTokenScope(): Promise<string | null> {
  return invoke<string | null>("score_token_scope");
}
