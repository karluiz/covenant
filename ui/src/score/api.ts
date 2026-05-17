import { invoke } from "@tauri-apps/api/core";

export interface Summary {
  total_prompts: number;
  total_commits: number;
  today_prompts: number;
  today_commits: number;
  current_streak: number;
  longest_streak: number;
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
}

export interface RepoCell { repo: string; prompts: number; commits: number }
export interface BranchCell { branch: string; prompts: number; commits: number }
export interface GroupCell { group_name: string; prompts: number }
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
