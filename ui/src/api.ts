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

export async function spawnSession(
  handlers: SpawnHandlers,
  opts?: { initialCwd?: string | null },
): Promise<SessionId> {
  const outputChannel = new Channel<number[]>();
  outputChannel.onmessage = (data) => handlers.onOutput(new Uint8Array(data));

  const sessionEventChannel = new Channel<SessionUiEvent>();
  sessionEventChannel.onmessage = (event) => handlers.onSessionEvent(event);

  return invoke<SessionId>("spawn_session", {
    onOutput: outputChannel,
    onSessionEvent: sessionEventChannel,
    initialCwd: opts?.initialCwd ?? null,
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

/// M-OP3 live mode toggle. Requires the Operator to also be enabled
/// for actual injection — both are per-session opt-in.
export async function setOperatorLive(
  sessionId: SessionId,
  live: boolean,
): Promise<void> {
  return invoke<void>("set_operator_live", { sessionId, live });
}

export async function isOperatorLive(sessionId: SessionId): Promise<boolean> {
  return invoke<boolean>("is_operator_live", { sessionId });
}

/// Per-tab AOM opt-out toggle. When AOM is on globally, an excluded
/// tab keeps its individual live setting + normal persona instead of
/// inheriting the AOM act-by-default posture. Persistent across AOM
/// cycles AND app restarts (UI manifest restores the value at boot).
export async function setAomExcluded(
  sessionId: SessionId,
  excluded: boolean,
): Promise<void> {
  return invoke<void>("set_aom_excluded", { sessionId, excluded });
}

export async function isAomExcluded(sessionId: SessionId): Promise<boolean> {
  return invoke<boolean>("is_aom_excluded", { sessionId });
}

/// "Include all" backend hook — flips every tab's `aom_excluded` to
/// false in one call. Surfaced in the AOM popover when ≥1 tabs are
/// excluded. Use sparingly; the per-tab toggle is the daily affordance.
export async function clearAllAomExcluded(): Promise<void> {
  return invoke<void>("clear_all_aom_excluded");
}

export interface Operator {
  id: string;
  name: string;
  emoji: string;
  color: string;
  tags: string[];
  persona: string;
  escalate_threshold: number;
  model: string;
  hard_constraints: string;
  is_default: boolean;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
  /// 3.12 — accumulated XP. Level = floor(xp / 100) + 1.
  xp: number;
}

/// Payload of the `operator-xp-updated` event emitted after a decision
/// awards XP. UI surfaces (tab chip, ⌘O panel) listen for this and
/// patch their cached operator in place.
export interface OperatorXpUpdate {
  operator_id: string;
  xp: number;
  awarded: number;
}

export function operatorLevelFromXp(xp: number): number {
  return Math.floor(Math.max(0, xp) / 100) + 1;
}

export interface OperatorDraft {
  name: string;
  emoji: string;
  color: string;
  tags: string[];
  persona: string;
  escalate_threshold: number;
  model: string;
  hard_constraints: string;
}

export async function operatorList(): Promise<Operator[]> {
  return invoke<Operator[]>("operator_list");
}

export async function operatorGet(id: string): Promise<Operator | null> {
  return invoke<Operator | null>("operator_get", { id });
}

export async function operatorCreate(draft: OperatorDraft): Promise<Operator> {
  return invoke<Operator>("operator_create", { draft });
}

export async function operatorUpdate(id: string, draft: OperatorDraft): Promise<Operator> {
  return invoke<Operator>("operator_update", { id, draft });
}

export async function operatorDelete(id: string): Promise<void> {
  return invoke<void>("operator_delete", { id });
}

export async function operatorSetDefault(id: string): Promise<void> {
  return invoke<void>("operator_set_default", { id });
}

/// M-OP6 mission spec attached to a session. The Operator reads it
/// as authoritative scope (Out of scope → escalate, File boundaries
/// → constraints, Open questions → auto-escalate). Pass an absolute
/// path or one resolvable from the backend's CWD.
export type MissionKind = "covenant" | "superpowers";

export interface MissionRef {
  kind: MissionKind;
  spec_path: string;
  plan_path: string | null;
}

export interface MissionPlanInfo {
  path: string;
  mtime_unix_ms: number;
  tasks_total: number;
  tasks_done: number;
}

export interface MissionInfo {
  kind: MissionKind;
  path: string;
  /// Single-line preview of the spec content (≤ 240 chars).
  content_preview: string;
  loaded_at_unix_ms: number;
  /// On-disk mtime when the content was loaded. Carried back on save
  /// so the backend can detect "file changed in another editor"
  /// conflicts.
  mtime_unix_ms: number;
  plan: MissionPlanInfo | null;
}

export interface SuperpowersMissionEntry {
  spec_path: string;
  spec_filename: string;
  plan_path: string | null;
  goal_preview: string;
}

/// Result of `set_session_mission_content`. Discriminated union: the
/// caller branches on `kind` to either close the modal (`saved`),
/// surface a Reload/Overwrite banner (`conflict`), or no-op (`no_mission`).
export type MissionSaveResult =
  | { kind: "saved"; info: MissionInfo }
  | {
      kind: "conflict";
      actual_mtime_unix_ms: number;
      current_content: string;
    }
  | { kind: "no_mission" };

export async function setSessionMission(
  sessionId: SessionId,
  mref: MissionRef,
): Promise<MissionInfo> {
  return invoke<MissionInfo>("set_session_mission", {
    sessionId,
    mref,
  });
}

export async function markPlanTask(
  sessionId: SessionId,
  taskIndex: number,
  done: boolean,
  expectedMtimeUnixMs: number,
): Promise<MissionPlanInfo> {
  return invoke<MissionPlanInfo>("operator_mark_plan_task", {
    sessionId,
    taskIndex,
    done,
    expectedMtimeUnixMs,
  });
}

export async function appendPlanNote(
  sessionId: SessionId,
  taskIndex: number,
  note: string,
  expectedMtimeUnixMs: number,
): Promise<MissionPlanInfo> {
  return invoke<MissionPlanInfo>("operator_append_plan_note", {
    sessionId,
    taskIndex,
    note,
    expectedMtimeUnixMs,
  });
}

export async function listSuperpowersMissions(cwd?: string | null): Promise<SuperpowersMissionEntry[]> {
  return invoke<SuperpowersMissionEntry[]>("list_superpowers_missions", { cwd: cwd ?? null });
}

export async function clearSessionMission(sessionId: SessionId): Promise<void> {
  return invoke<void>("clear_session_mission", { sessionId });
}

export async function getSessionMission(
  sessionId: SessionId,
): Promise<MissionInfo | null> {
  return invoke<MissionInfo | null>("get_session_mission", { sessionId });
}

/// Full mission spec text — used by the status-bar mission viewer
/// modal. Returns null if no mission is set.
export async function getSessionMissionContent(
  sessionId: SessionId,
): Promise<string | null> {
  return invoke<string | null>("get_session_mission_content", { sessionId });
}

/// Full plan-file body for the mission overlay's read-only plan-progress
/// strip. Returns null when the session has no mission, or the mission
/// is a Covenant spec with no paired plan.
export async function getSessionPlanContent(
  sessionId: SessionId,
): Promise<string | null> {
  return invoke<string | null>("get_session_plan_content", { sessionId });
}

/// Persist a new mission spec body. Backend rejects with the string
/// error `"aom_active"` when AOM is running (the modal disables Edit
/// up-front, but this is a defensive double-check). Pass
/// `expectedMtimeUnixMs = 0` to bypass the conflict check (Overwrite).
export async function setSessionMissionContent(
  sessionId: SessionId,
  content: string,
  expectedMtimeUnixMs: number,
): Promise<MissionSaveResult> {
  return invoke<MissionSaveResult>("set_session_mission_content", {
    sessionId,
    content,
    expectedMtimeUnixMs,
  });
}

/// AOM (Autonomous Operator Mode) — global toggle. When on, every
/// Operator-enabled tab adopts act-by-default posture and auto-submits
/// replies (the user is not in the loop).
export interface AomStatus {
  enabled: boolean;
  /// Unix-ms when AOM was last started. 0 if never started since boot.
  /// Even after stop, this stays stamped so the UI can show "ran for X".
  started_at_unix_ms: number;
  /// Decisions made since the last aom_start (reset to 0 each start).
  decisions_count: number;
  /// USD cap configured at start time. AOM auto-stops when accumulated
  /// cost reaches this.
  budget_usd: number;
  /// Running USD total since aom_start.
  accumulated_cost_usd: number;
  /// Set when AOM was auto-stopped because the cap was hit (vs the
  /// user pressing ⌘⇧A). Drives the explanatory toast.
  cost_cap_hit_at_unix_ms: number | null;
}

export async function aomStatus(): Promise<AomStatus> {
  return invoke<AomStatus>("aom_status");
}

export async function aomStart(): Promise<AomStatus> {
  return invoke<AomStatus>("aom_start");
}

export async function aomStop(): Promise<AomStatus> {
  return invoke<AomStatus>("aom_stop");
}

/// Liveness phase exposed by the operator (Task 3). The banner polls
/// this every ~1s while AOM is on so the badge never sits frozen for
/// >2s. The aggregate is "the most-active phase any attached session
/// is currently in"; `since_unix_ms` is when that phase began so the
/// UI can render "deciding 2s" without a separate timestamp call.
export type OperatorPhase =
  | "idle"
  | "observing"
  | "triaging"
  | "deciding"
  | "yielded"
  | "offline";

export interface OperatorPhaseSnapshot {
  phase: OperatorPhase;
  since_unix_ms: number;
}

export async function operatorPhaseOverview(): Promise<OperatorPhaseSnapshot> {
  return invoke<OperatorPhaseSnapshot>("operator_phase_overview");
}

export interface ActionBreakdown {
  reply_count: number;
  executed_count: number;
  escalate_count: number;
  wait_count: number;
}

export interface EscalationDigest {
  timestamp_unix_ms: number;
  session_id_short: string;
  in_flight_command: string | null;
  rationale: string | null;
  reply_text: string | null;
}

export interface PerTabDigest {
  session_id_short: string;
  decisions_count: number;
  last_activity_unix_ms: number;
  cost_usd: number;
  recent_commands: string[];
}

export interface AomReport {
  session_row_id: number;
  started_at_unix_ms: number;
  ended_at_unix_ms: number | null;
  budget_usd: number;
  accumulated_cost_usd: number;
  decisions_count: number;
  cost_cap_hit_at_unix_ms: number | null;
  action_breakdown: ActionBreakdown;
  escalations: EscalationDigest[];
  per_tab: PerTabDigest[];
}

/// Fetch the morning report for the most recent AOM session, or null
/// if AOM has never been started on this DB.
export async function aomReport(): Promise<AomReport | null> {
  return invoke<AomReport | null>("aom_report");
}

/// Tab persistence — backend stores the raw JSON manifest produced
/// by `TabManager.serializeManifest()`. Schema lives in the frontend.
export async function tabManifestLoad(): Promise<string | null> {
  return invoke<string | null>("tab_manifest_load");
}

export async function tabManifestSave(body: string): Promise<void> {
  return invoke<void>("tab_manifest_save", { body });
}

/// Recent blocks that ran in `cwd` across sessions. Used by the
/// BlockManager sidebar when a tab lands in a known dir — surfaces
/// "what was I doing here" before any new command runs.
export interface HistoricalBlockRow {
  session_id_short: string;
  command: string;
  exit_code: number | null;
  duration_ms: number;
  finished_at_unix_ms: number;
}

export async function recentBlocksByCwd(
  cwd: string,
  limit: number,
): Promise<HistoricalBlockRow[]> {
  return invoke<HistoricalBlockRow[]>("recent_blocks_by_cwd", { cwd, limit });
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
  /// Mission spec path attached to the session at the moment the
  /// decision fired. Null for pre-Phase-B rows + sessions without a
  /// mission. Prefer this over a live tab lookup so historical rows
  /// reflect the mission that was actually loaded then.
  mission_path: string | null;
  /// Executor agent (claude / copilot / aider / …) detected at
  /// decision time. Null when no known executor matched.
  executor_name: string | null;
  /// Operator that fired this decision. Null for pre-multi-operator rows.
  operator_id: string | null;
  /// Snapshot of the operator's display name at decision time.
  operator_name: string | null;
}

export async function listOperatorDecisions(
  limit: number,
): Promise<OperatorDecisionRow[]> {
  return invoke<OperatorDecisionRow[]>("list_operator_decisions", { limit });
}

export interface AutosuggestStatus {
  found: boolean;
  path: string | null;
}

/// Probe whether zsh-autosuggestions is installed at one of the
/// well-known paths our shell snippet sources from. UI uses this to
/// surface a one-time hint when missing.
export async function zshAutosuggestionsStatus(): Promise<AutosuggestStatus> {
  return invoke<AutosuggestStatus>("zsh_autosuggestions_status");
}

export interface RecallMatch {
  command: string;
  count: number;
  success_count: number;
  cwd_match_count: number;
  last_used_unix_ms: number;
  score: number;
}

/// Recall: search persisted block history for commands matching `query`.
/// Empty query → most recent distinct commands. `cwd` boosts matches
/// previously run there.
export async function recallSearch(
  query: string,
  cwd: string | null,
  limit: number,
): Promise<RecallMatch[]> {
  return invoke<RecallMatch[]>("recall_search", { query, cwd, limit });
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
  letter_spacing: number;
  line_height: number;
}

export type WindowBackground = "solid" | "vibrant" | "translucent";

export interface WindowConfig {
  background: WindowBackground;
}

export interface AomConfig {
  default_budget_usd: number;
}

export interface NotificationConfig {
  on_operator_escalate: boolean;
  on_aom_error: boolean;
  on_aom_complete: boolean;
  suppress_when_focused: boolean;
  email_enabled: boolean;
  email_from?: string | null;
  email_to?: string | null;
  email_digest_window_minutes: number;
}

export interface Settings {
  anthropic_api_key: string | null;
  sendgrid_api_key?: string | null;
  agent: AgentConfig;
  operator: OperatorConfig;
  terminal: TerminalConfig;
  window: WindowConfig;
  aom: AomConfig;
  notifications?: NotificationConfig;
  /// 3.7 — render the bottom status bar (git + runtime). Default true.
  status_bar_enabled: boolean;
  /// Tabbar layout: "top" (default, horizontal across the top) or
  /// "left" (fixed vertical sidebar à la Wave Terminal).
  tabbar_position: TabbarPosition;
  /// CSS font stack for UI chrome (panels, settings, modals, group
  /// labels). `null` = built-in system sans default. Terminal and
  /// editor fonts are configured separately.
  ui_font_family: string | null;
  /// Familiars feature flag. Both this AND `is_premium` must be true
  /// for the auto-spawn-on-operator-start flow to fire.
  familiars_enabled: boolean;
  /// Premium gate for Familiars (and any other premium-only features).
  is_premium: boolean;
}

export async function validateSendGridKey(apiKey: string): Promise<boolean> {
  return invoke<boolean>('validate_sendgrid_key', { apiKey });
}

export type TabbarPosition = "top" | "left";

/// 3.7 — directory-context probe for the status bar. Both segments are
/// optional; null means "not applicable / not detected" and the bar
/// renders no chip for that segment.
export interface GitInfo {
  repo_name: string;
  branch: string;
}

export interface RuntimeInfo {
  language: string;
  version: string | null;
}

export interface DirContext {
  git: GitInfo | null;
  runtime: RuntimeInfo | null;
}

export async function getDirContext(cwd: string): Promise<DirContext> {
  return invoke<DirContext>("get_dir_context", { cwd });
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

// 3.3 Structure (file tree) ---------------------------------------------

export type EntryKind = "dir" | "file";

export interface DirEntry {
  name: string;
  path: string;
  kind: EntryKind;
  is_symlink: boolean;
}

export type ReadKind = "text" | "binary" | "too_large";

export interface ReadResult {
  kind: ReadKind;
  content: string | null;
  size_bytes: number;
}

export async function structureListDir(
  cwd: string,
  showIgnored = false,
): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("structure_list_dir", { cwd, showIgnored });
}

/// Create an empty file or empty folder at `path`. Backend refuses
/// to clobber existing entries, and the parent directory must exist —
/// the tree always passes an absolute path inside the current cwd.
export async function structureCreatePath(
  path: string,
  kind: "file" | "dir",
): Promise<string> {
  return invoke<string>("structure_create_path", { path, kind });
}

/// Resolve a path-like token (relative or absolute) against `cwd` and
/// return the canonical absolute path iff it points to an existing
/// regular file. Used by the xterm Cmd+Click link provider.
export async function resolveExistingPath(
  path: string,
  cwd: string | null,
): Promise<string | null> {
  return invoke<string | null>("resolve_existing_path", { path, cwd });
}

export async function structureReadFile(
  path: string,
  maxBytes?: number,
): Promise<ReadResult> {
  return invoke<ReadResult>("structure_read_file", {
    path,
    maxBytes: maxBytes ?? null,
  });
}

export async function structureWriteFile(path: string, content: string): Promise<void> {
  return invoke<void>("structure_write_file", { path, content });
}

export async function structureWriteBinaryFile(
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  // Tauri serializes Uint8Array → number[] for the IPC bridge,
  // which the Rust side picks up as `Vec<u8>`. We pass `bytes`
  // directly; do NOT wrap in Array.from, the plugin handles it.
  return invoke<void>("structure_write_binary_file", { path, bytes });
}

export type BinaryReadResult =
  | { kind: "found"; bytes: number[]; size_bytes: number }
  | { kind: "too_large"; size_bytes: number };

export async function structureReadBinaryFile(
  path: string,
  maxBytes?: number,
): Promise<BinaryReadResult> {
  return invoke<BinaryReadResult>("structure_read_binary_file", {
    path,
    maxBytes: maxBytes ?? null,
  });
}

export async function structureRenamePath(
  from: string,
  to: string,
): Promise<void> {
  return invoke<void>("structure_rename_path", { from, to });
}

export async function structureTrashPath(path: string): Promise<void> {
  return invoke<void>("structure_trash_path", { path });
}

/// One match from a global search. `match_start`/`match_end` are CHAR
/// offsets within `line_text` (already truncated server-side if the
/// source line was very long), suitable for highlighting in the UI.
export interface SearchHit {
  path: string;
  line_number: number;
  line_text: string;
  match_start: number;
  match_end: number;
}

/// Substring search across `cwd`, honoring .gitignore + hardcoded
/// ignore set. Empty query returns []. Server caps results to `limit`.
export async function structureSearch(
  cwd: string,
  query: string,
  limit: number,
): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("structure_search", { cwd, query, limit });
}

// 3.8 Convergence Mode -----------------------------------------------------

export type TileStatus =
  | "idle"
  | "working"
  | "awaiting-input"
  | "blocked"
  | "operator-thinking";

export type Vendor = "claude" | "copilot" | "opencode" | "aider" | "codex" | "unknown";

export interface SessionSummary {
  session_id: string;
  tab_title: string;
  tab_color: string | null;
  status: TileStatus;
  vendor: Vendor;
  raw_command_label: string | null;
  last_command: string | null;
  last_output_line: string | null;
  last_decision_action: string | null;
  last_decision_rationale: string | null;
  mission_name: string | null;
  cost_usd: number | null;
  budget_usd: number | null;
}

export interface OperatorRosterEntry {
  operator_id: string;
  operator_name: string;
  operator_avatar: string | null;
  sessions: SessionSummary[];
  has_escalation: boolean;
}

export interface EscalationCard {
  session_id: string;
  tab_title: string;
  tab_color: string | null;
  operator_id: string;
  operator_name: string;
  operator_avatar: string | null;
  vendor: Vendor;
  raw_command_label: string | null;
  question: string | null;
  mission_name: string | null;
  escalated_at_unix_ms: number;
}

export interface ConvergenceSnapshot {
  roster: OperatorRosterEntry[];
  escalations: EscalationCard[];
}

export interface ConvergenceTabHint {
  session_id: string;
  title: string;
  color: string | null;
}

export async function getConvergenceSnapshot(
  tabs: ConvergenceTabHint[],
): Promise<ConvergenceSnapshot> {
  return invoke<ConvergenceSnapshot>("get_convergence_snapshot", { tabs });
}

/// 3.14 — light 1 Hz poll surface for the tab strip. Returns the ids
/// of sessions currently in the convergence `blocked` state.
export async function getBlockedSessionIds(
  tabs: ConvergenceTabHint[],
): Promise<string[]> {
  return invoke<string[]>("get_blocked_session_ids", { tabs });
}

// === 3.16 spec auto-detect ===

export type SpecSource = "covenant" | "superpowers";

export interface SpecCandidate {
  repo_root: string;
  path: string;
  source: SpecSource;
  title: string | null;
  goal_snippet: string;
}

export const specDetectorApi = {
  start: (repoRoot: string): Promise<void> =>
    invoke("start_spec_detector", { repoRoot }),

  markSeen: (repoRoot: string, path: string): Promise<void> =>
    invoke("mark_spec_seen", { repoRoot, path }),
};

/**
 * Subscribe to spec candidates emitted by the detector. The handler is
 * called once per new spec. Returns an unsubscribe function.
 */
export async function subscribeSpecCandidates(
  handler: (cand: SpecCandidate) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<SpecCandidate>("spec:candidate", (e) => {
    handler(e.payload);
  });
  return unlisten;
}

export { draftsApi } from "./drafts/api";
export type {
  DraftFrontmatter,
  DraftSummary,
  DraftDocument,
  SuggestSection,
} from "./drafts/api";
export type { PublishedSpec } from "./drafts/api";

// 3.9 Multi-operator surfaces -----------------------------------------------

export async function sessionSetOperator(
  sessionId: SessionId,
  operatorId: string | null,
): Promise<void> {
  return invoke<void>("session_set_operator", { sessionId, operatorId });
}

export async function sessionGetOperator(sessionId: SessionId): Promise<Operator> {
  return invoke<Operator>("session_get_operator", { sessionId });
}

/**
 * 3.8 Convergence Mode reply pipe. Sends `text` to the operator's
 * internal resolution channel; the backend injects it into the
 * matching session's PTY. `scope` is forwarded for spec 3.13 memory
 * persistence — opaque to the operator decision loop.
 */
export async function submitConvergenceReply(
  sessionId: string,
  text: string,
  scope: "one-shot" | "mission" | "global",
): Promise<void> {
  await invoke<void>("submit_convergence_reply", { sessionId, text, scope });
}

export { Familiars } from "./familiars/api";
export type {
  FamiliarSummary, ChatOutput, MissionOut, SnapshotOut, DirectiveOut, Style,
} from "./familiars/api";

// 3.18 Agentic spec creation -----------------------------------------

export type SpecPhase =
  | "goal"
  | "outofscope"
  | "acceptance"
  | "fileboundaries"
  | "complexity"
  | "openquestions"
  | "emit";

export type SpecStepOutput =
  | { kind: "question"; phase: SpecPhase; text: string }
  | { kind: "final"; markdown: string };

export interface SpecStepResult {
  draftId: string; // ulid
  output: SpecStepOutput;
}

export interface SpecDraftMessage {
  role: "User" | "Assistant";
  content: string;
}

export type SpecDraftStatus =
  | { InProgress: { phase: string } }
  | "Ready"
  | "Published";

export interface SpecDraftSummary {
  id: string;
  messages: SpecDraftMessage[];
  partial_md: string | null;
  last_updated: string; // ISO from chrono DateTime<Utc>
  status: SpecDraftStatus;
}

export async function specAuthorStep(
  draftId: string | null,
  userMsg: string,
): Promise<SpecStepResult> {
  return invoke<SpecStepResult>("spec_author_step", { draftId, userMsg });
}

export async function specAuthorLoadDraft(id: string): Promise<SpecDraftSummary> {
  return invoke<SpecDraftSummary>("spec_author_load_draft", { id });
}

export async function specAuthorListDrafts(): Promise<SpecDraftSummary[]> {
  return invoke<SpecDraftSummary[]>("spec_author_list_drafts");
}

export async function specAuthorMarkPublished(id: string): Promise<void> {
  return invoke<void>("spec_author_mark_published", { id });
}
