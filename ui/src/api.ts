// Typed wrappers around `karl-app` Tauri commands.
//
// Every command exposed by the Rust backend MUST funnel through this
// file (CLAUDE.md ts conventions). Per-session streams come back as
// `Channel<T>` instances handed in at spawn time, so listeners are
// attached before any byte / event can be produced — no race.

import { Channel, invoke } from "@tauri-apps/api/core";

export type SessionId = string;
export type BlockId = string;

export type OutputHandler = (chunk: Uint8Array) => void;
export type SessionUiEventHandler = (event: SessionUiEvent) => void;

// Mirrors `karl_session::SessionUiEvent`. Keep in sync if Rust grows
// new variants. The session id is included on every variant for
// future multi-session UI dispatch (M5+).
export type SessionUiEvent =
  | { kind: "prompt_start"; session: SessionId }
  | {
      kind: "block_started";
      session: SessionId;
      block: BlockId;
      command: string;
      cwd: string;
      started_at_unix_ms: number;
    }
  | {
      kind: "block_finished";
      session: SessionId;
      block: BlockId;
      exit_code: number | null;
      duration_ms: number;
    }
  | { kind: "cwd_changed"; session: SessionId; cwd: string }
  | {
      kind: "fix_suggested";
      session: SessionId;
      block: BlockId;
      command: string;
      rationale: string;
    };

export interface SpawnHandlers {
  onOutput: OutputHandler;
  onSessionEvent: SessionUiEventHandler;
}

export async function spawnSession(handlers: SpawnHandlers): Promise<SessionId> {
  const outputChannel = new Channel<number[]>();
  outputChannel.onmessage = (data) => handlers.onOutput(new Uint8Array(data));

  const sessionEventChannel = new Channel<SessionUiEvent>();
  sessionEventChannel.onmessage = (event) => handlers.onSessionEvent(event);

  return invoke<SessionId>("spawn_session", {
    onOutput: outputChannel,
    onSessionEvent: sessionEventChannel,
  });
}

export async function writeToSession(id: SessionId, data: Uint8Array): Promise<void> {
  return invoke<void>("write_to_session", { id, data: Array.from(data) });
}

export async function resizeSession(
  id: SessionId,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("resize_session", { id, cols, rows });
}

export async function closeSession(id: SessionId): Promise<void> {
  return invoke<void>("close_session", { id });
}

/// Type a command into the PTY without a trailing newline. Used by the
/// fix-suggestion click path — user reviews and presses Enter.
export async function injectCommand(id: SessionId, command: string): Promise<void> {
  return invoke<void>("inject_command", { id, command });
}

/// Fetch a block's persisted output_text (or null if not in DB).
export async function getBlockOutput(blockId: BlockId): Promise<string | null> {
  return invoke<string | null>("get_block_output", { blockId });
}

export async function setOperatorEnabled(
  sessionId: SessionId,
  enabled: boolean,
): Promise<void> {
  return invoke<void>("set_operator_enabled", { sessionId, enabled });
}

export async function isOperatorEnabled(sessionId: SessionId): Promise<boolean> {
  return invoke<boolean>("is_operator_enabled", { sessionId });
}

export interface OperatorDecisionRow {
  id: number;
  session_id_short: string;
  timestamp_unix_ms: number;
  in_flight_command: string | null;
  output_excerpt: string;
  action: "reply" | "escalate" | "wait" | string;
  reply_text: string | null;
  rationale: string | null;
  executed: boolean;
}

export async function listOperatorDecisions(
  limit: number,
): Promise<OperatorDecisionRow[]> {
  return invoke<OperatorDecisionRow[]>("list_operator_decisions", { limit });
}

export interface AgentConfig {
  model_summary: string;
  model_chat: string;
  max_calls_per_minute: number;
}

export interface OperatorConfig {
  enabled_default: boolean;
  persona: string;
  executor_patterns: string[];
  idle_threshold_secs: number;
  max_decisions_per_minute: number;
  deny_extra_patterns: string[];
}

export interface TerminalConfig {
  font_family: string;
  font_size: number;
}

export interface Settings {
  anthropic_api_key: string | null;
  agent: AgentConfig;
  operator: OperatorConfig;
  terminal: TerminalConfig;
}

export async function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export type AgentTokenHandler = (delta: string) => void;

export async function askAgent(
  sessionId: SessionId,
  question: string,
  onToken: AgentTokenHandler,
): Promise<void> {
  const channel = new Channel<string>();
  channel.onmessage = (delta) => onToken(delta);
  return invoke<void>("ask_agent", {
    sessionId,
    question,
    onToken: channel,
  });
}
