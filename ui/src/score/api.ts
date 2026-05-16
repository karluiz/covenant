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
