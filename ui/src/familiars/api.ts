import { invoke } from "@tauri-apps/api/core";

export type Style = "concise" | "formal" | "conversational" | "sarcastic";

export interface FamiliarSummary {
  id: string;
  session_id: string;
  name: string;
  style: Style;
  daily_cap_usd: number;
}

export interface ChatOutput {
  assistant_text: string;
  directive_id: string | null;
  directive_kind: string | null;
  directive_payload: string | null;
  directive_rationale: string | null;
  safety_block_reason: string | null;
}

export interface MissionOut {
  mission_id: string;
  objective: string;
  digest: string;
  started_ms: number;
  finished_ms: number | null;
}

export interface SnapshotOut {
  rolling_summary: string;
  last_event_ms: number;
  recent_missions: MissionOut[];
  spend_today_usd: number;
  frozen: boolean;
}

export interface DirectiveOut {
  id: string;
  state: "proposed" | "approved" | "rejected" | "executed" | "safety_blocked";
  kind: string;
  payload: string;
  rationale: string;
  proposed_ms: number;
  decided_ms: number | null;
  block_reason: string | null;
}

export const Familiars = {
  list: () => invoke<FamiliarSummary[]>("familiar_list"),
  spawn: (session_id: string, name: string, style: Style, daily_cap_usd: number) =>
    invoke<string>("familiar_spawn", { sessionId: session_id, name, style, dailyCapUsd: daily_cap_usd }),
  updateConfig: (familiar_id: string, name: string, style: Style, daily_cap_usd: number) =>
    invoke<void>("familiar_update_config",
      { familiarId: familiar_id, name, style, dailyCapUsd: daily_cap_usd }),
  chat: (familiar_id: string, user_text: string) =>
    invoke<ChatOutput>("familiar_chat", { input: { familiar_id, user_text } }),
  approve: (familiar_id: string, directive_id: string) =>
    invoke<string>("familiar_approve_directive",
      { familiarId: familiar_id, directiveId: directive_id }),
  reject: (familiar_id: string, directive_id: string) =>
    invoke<void>("familiar_reject_directive",
      { familiarId: familiar_id, directiveId: directive_id }),
  markExecuted: (familiar_id: string, directive_id: string) =>
    invoke<void>("familiar_mark_executed",
      { familiarId: familiar_id, directiveId: directive_id }),
  snapshot: (familiar_id: string) =>
    invoke<SnapshotOut>("familiar_snapshot", { familiarId: familiar_id }),
  audit: (familiar_id: string, since_ms: number) =>
    invoke<DirectiveOut[]>("familiar_audit",
      { familiarId: familiar_id, sinceMs: since_ms }),
};
