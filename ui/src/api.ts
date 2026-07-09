// Typed wrappers around `karl-app` Tauri commands.
//
// Every command exposed by the Rust backend MUST funnel through this
// file (CLAUDE.md ts conventions). Per-session streams come back as
// `Channel<T>` instances handed in at spawn time, so listeners are
// attached before any byte / event can be produced — no race.

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

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
    }
  | {
      kind: "agent_idle_waiting";
      session: SessionId;
      agent: string;
      prompt_text: string | null;
      quiet_ms: number;
    }
  | { kind: "agent_resumed"; session: SessionId }
  | {
      kind: "foreground_changed";
      session: SessionId;
      name: string | null;
      busy: boolean;
    }
  | { kind: "title_suggested"; session: SessionId; title: string };

export interface SpawnHandlers {
  onOutput: OutputHandler;
  onSessionEvent: SessionUiEventHandler;
}

export async function spawnSession(
  handlers: SpawnHandlers,
  opts?: { initialCwd?: string | null; replayKey?: string | null; paneId?: string | null },
): Promise<SessionId> {
  const outputChannel = new Channel<number[]>();
  outputChannel.onmessage = (data) => handlers.onOutput(new Uint8Array(data));

  const sessionEventChannel = new Channel<SessionUiEvent>();
  sessionEventChannel.onmessage = (event) => handlers.onSessionEvent(event);

  return invoke<SessionId>("spawn_session", {
    onOutput: outputChannel,
    onSessionEvent: sessionEventChannel,
    initialCwd: opts?.initialCwd ?? null,
    replayKey: opts?.replayKey ?? null,
    paneId: opts?.paneId ?? null,
  });
}

/// Fetch the tail of a tab's persisted scrollback. Returns an empty
/// array for unknown / new tabs. Write the bytes into xterm BEFORE
/// `spawnSession` attaches its live channel.
export async function replayScrollback(replayKey: string): Promise<Uint8Array> {
  const data = await invoke<number[]>("replay_scrollback", { replayKey });
  return new Uint8Array(data);
}

export async function deleteScrollback(replayKey: string): Promise<void> {
  await invoke<void>("delete_scrollback", { replayKey });
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

/// Force-kill the foreground process tree of `id` (SIGTERM, escalates
/// to SIGKILL after ~500ms). Use when Ctrl+C is being swallowed by a
/// parent (e.g. npm) that doesn't propagate to its children.
export async function killSessionForeground(id: SessionId): Promise<void> {
  return invoke<void>("kill_session_foreground", { id });
}

export interface MindPreview {
  turn_count: number;
  updated_at_rfc3339: string;
  goal: string;
  belief: string;
}

/// Spec 3.20 phase 6: peek at persisted mind for `id`. Resolves to
/// `null` when mind_v2 is off OR no mind exists OR turn_count is 0.
export async function closeSessionCheck(id: SessionId): Promise<MindPreview | null> {
  return invoke<MindPreview | null>("close_session_check", { id });
}

export interface MindTurnRecord {
  turn: number;
  at: string;
  saw: string;
  thought: string;
  action_kind: "Reply" | "Execute" | "Escalate" | "Ignore";
  action_summary: string;
  executed: boolean;
}

export interface MindUpdatedEvent {
  session_id: string;
  goal: string;
  belief: string;
  open_questions: string[];
  tried_failed: string[];
  next_intent: string;
  turn_count: number;
  recent: MindTurnRecord[];
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

export async function setRemoteArmed(sessionId: SessionId, armed: boolean): Promise<void> {
  return invoke<void>("rc_set_armed", { sessionId, armed });
}

export async function getRemoteArmed(sessionId: SessionId): Promise<boolean> {
  return invoke<boolean>("rc_get_armed", { sessionId });
}

export async function disarmAllRemote(): Promise<void> {
  return invoke<void>("rc_disarm_all");
}

export async function setRemoteAllowOpen(allow: boolean): Promise<void> {
  return invoke<void>("rc_set_allow_open", { allow });
}

export async function getRemoteAllowOpen(): Promise<boolean> {
  return invoke<boolean>("rc_get_allow_open");
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

/// Push the user-visible tab title to the backend so AOM startup can
/// build a `covenant-{tab-slug}-{ulid6}` Claude session name. Empty
/// title clears the entry. Fire-and-forget; errors are logged only.
export async function setTabTitle(
  sessionId: SessionId,
  title: string,
): Promise<void> {
  return invoke<void>("set_tab_title", { sessionId, title });
}

/// Push the *display* label for this session to the notch overlay.
/// Includes the group prefix (e.g. "COVENANT › notch"). Separate from
/// `setTabTitle` so AOM session-name slugs don't get the prefix.
export async function notchSetLabel(
  sessionId: SessionId,
  label: string,
): Promise<void> {
  return invoke<void>("notch_set_label", { sessionId, label });
}

/// "Include all" backend hook — flips every tab's `aom_excluded` to
/// false in one call. Surfaced in the AOM popover when ≥1 tabs are
/// excluded. Use sparingly; the per-tab toggle is the daily affordance.
export async function clearAllAomExcluded(): Promise<void> {
  return invoke<void>("clear_all_aom_excluded");
}

export interface ResourcesSessionMetric { id: string; cpu: number; mem_bytes: number; }
export interface ResourcesSnapshot {
  total_cpu: number;
  total_mem_bytes: number;
  ram_share: number;
  mem_total_bytes: number;
  sessions: ResourcesSessionMetric[];
}

/** Start/stop the live resources sampler (panel mount/unmount). */
export async function resourcesSetActive(active: boolean): Promise<void> {
  return invoke<void>("resources_set_active", { active });
}

/** Force one immediate resources sample (the ↻ button). */
export async function resourcesSampleNow(): Promise<void> {
  return invoke<void>("resources_sample_now", {});
}

/** Subscribe to live resources snapshots. Returns an unlisten fn. */
export async function onResourcesUpdate(
  handler: (s: ResourcesSnapshot) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<ResourcesSnapshot>("resources_update", (e) =>
    handler(e.payload),
  );
  return unlisten;
}

/// Operator voice tone — drives prompt directive for the operator's
/// generated text (banner messages, escalations, replies).
export type VoiceTone = "Terse" | "Warm" | "Formal";

/// Per-operator GitHub access level. Gates which gh_* tools the
/// operator's LLM dispatch registers. Mirrors Rust `GithubAccess`.
export type GithubAccess = "Off" | "ReadOnly" | "ReadWrite";

/// Action surfaced by the operator in the banner / activity feed.
/// Tagged union mirrors the Rust `OperatorAction` enum.
export type OperatorAction =
  | { type: "PushAndPR" }
  | { type: "RunCommand"; cmd: string }
  | { type: "Reply" }
  | { type: "Snooze"; minutes: number }
  | { type: "Custom"; id: string; label: string };

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
  voice: VoiceTone;
  is_default: boolean;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
  /// 3.12 — accumulated XP. Level = floor(xp / 100) + 1.
  xp: number;
  github_access: GithubAccess;
  /// Whether the operator may delegate subtasks to background Copilot
  /// sessions via dispatch_acp. Default off.
  acp_enabled: boolean;
  /// Whether the operator auto-answers trivial, safe executor permission
  /// prompts in ACP sessions it's assigned to. Default off.
  perception_enabled: boolean;
  soul_path?: string | null;
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
  voice: VoiceTone;
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

export async function operatorSetGithubAccess(
  id: string,
  access: GithubAccess,
): Promise<void> {
  return invoke<void>("operator_set_github_access", { id, access });
}

/// One row of the ACP /resume picker (from `session/list`).
export interface AcpSessionListing {
  sessionId: string;
  cwd?: string | null;
  title?: string | null;
  updatedAt?: string | null;
}

export async function acpListSessions(sessionId: SessionId): Promise<AcpSessionListing[]> {
  return invoke<AcpSessionListing[]>("acp_list_sessions", { sessionId });
}

/// Load a past conversation into the live tab; the transcript replays
/// through the normal event stream. Returns the (possibly refreshed)
/// model roster. Caller must clear its rendered transcript first.
export async function acpLoadSession(
  sessionId: SessionId,
  acpSessionId: string,
): Promise<AcpModels> {
  return invoke<AcpModels>("acp_load_session", { sessionId, acpSessionId });
}

export async function operatorSetAcpEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  return invoke<void>("operator_set_acp_enabled", { id, enabled });
}

export async function operatorSetPerceptionEnabled(
  id: string,
  enabled: boolean,
): Promise<void> {
  return invoke<void>("operator_set_perception_enabled", { id, enabled });
}

export interface ArchetypeView {
  key: string;
  raw: string;
  name: string;
  avatar: string | null;
  color: string | null;
  tagline: string;
}

export interface SoulView {
  name: string;
  avatar: string | null;
  color: string | null;
  model: string | null;
  voice: string | null;
  escalate_threshold: number | null;
  tags: string[];
  hard_constraints: string | null;
  body: string;
  validation_error: string | null;
}

export async function operatorListArchetypes(): Promise<ArchetypeView[]> {
  return invoke<ArchetypeView[]>("operator_list_archetypes");
}

export async function operatorSoulRead(id: string): Promise<string> {
  return invoke<string>("operator_soul_read", { id });
}

export async function operatorSoulParse(raw: string): Promise<SoulView> {
  return invoke<SoulView>("operator_soul_parse", { raw });
}

export async function operatorCreateFromSoul(raw: string): Promise<Operator> {
  return invoke<Operator>("operator_create_from_soul", { raw });
}

export async function operatorUpdateFromSoul(id: string, raw: string): Promise<Operator> {
  return invoke<Operator>("operator_update_from_soul", { id, raw });
}

export interface MarketplaceListing {
  id: string;
  name: string;
  emoji: string;
  color: string;
  tags: string[];
  tagline: string;
  author_login: string;
  installs: number;
  soul_md: string;
}

export async function marketplaceSearch(q?: string, tag?: string): Promise<MarketplaceListing[]> {
  return invoke<MarketplaceListing[]>("marketplace_search", { q: q ?? null, tag: tag ?? null });
}

export async function marketplacePublish(id: string): Promise<void> {
  return invoke<void>("marketplace_publish", { id });
}

export async function marketplaceInstallCount(id: string): Promise<void> {
  return invoke<void>("marketplace_install_count", { id });
}

export async function marketplaceAdminUrl(): Promise<string> {
  return invoke<string>("marketplace_admin_url");
}

// ── Teammate (Phase 1) ───────────────────────────────────────────────

export type TeammateRole = "user" | "operator" | "system";

export type TaskArchetype = "do" | "review" | "watch";
export type TaskStatus    = "draft" | "active" | "blocked" | "done" | "cancelled";
export type UpdateKind    = "started" | "progress" | "blocked" | "resumed" | "completed" | "cancelled";

export interface TaskScope {
  paths?: string[];
  tabs?:  string[];
  watch_predicate?: unknown;
}

export interface TaskDraft {
  archetype:   TaskArchetype;
  title:       string;
  deliverable: string;
  scope:       TaskScope;
  /// Which executor agent should drive this task once confirmed.
  /// Required for archetype="do"; ignored for review/watch.
  /// One of: "claude" | "codex" | "copilot" | "pi" | "hermes".
  executor?:   string;
}

export interface ProposeTask {
  draft:     TaskDraft;
  rationale: string;
}

export interface TaskReport {
  summary:      string;
  artifact_ids: string[];
}

export interface Task {
  id: string;
  operator_id: string;
  archetype: TaskArchetype;
  title: string;
  body: string;
  deliverable: string;
  status: TaskStatus;
  scope: TaskScope;
  spawned_session: string | null;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
  completed_at_unix_ms: number | null;
  cost_usd_cents: number;
}

export type TeammateContent =
  | { kind: "text";        data: string }
  | { kind: "task_draft";  data: TaskDraft }
  | { kind: "task_update"; data: { task: string; kind: UpdateKind } }
  | { kind: "propose";     data: ProposeTask }
  | { kind: "report";      data: TaskReport };

/// Operator emotional state attached to a message. Mirrors the Rust
/// `Sentiment` enum and the filename token of `ui/operatorsv2/<char>_<token>.png`.
/// Spanish lowercase form is intentional — it's the storage key, the
/// avatar lookup key, and the LLM directive token all at once.
export type Sentiment =
  | "neutral"
  | "feliz"
  | "triste"
  | "enojo"
  | "sorpresa"
  | "duda"
  | "expectacion"
  | "incomodidad"
  | "ver";

export interface TeammateMessage {
  id: string;
  operator_id: string;
  task_id: string | null;
  thread_id: string | null;
  role: TeammateRole;
  content: TeammateContent;
  created_at_unix_ms: number;
  confirmed_at_unix_ms: number | null;
  dismissed_at_unix_ms: number | null;
  /// Present only on operator-authored text turns where the LLM emitted a
  /// parseable `SENTIMENT:` directive. Null/undefined for user turns,
  /// task-card content, legacy rows, and malformed directives — the UI
  /// falls back to a neutral avatar pose in those cases.
  sentiment?: Sentiment | null;
}

export interface TeammateThread {
  id: string;
  operator_id: string;
  title: string;
  created_at_unix_ms: number;
  last_message_at_unix_ms: number;
  archived: boolean;
}

export async function teammateListMessages(
  threadId: string,
  limit = 200,
): Promise<TeammateMessage[]> {
  return invoke<TeammateMessage[]>("teammate_list_messages_for_operator", {
    threadId,
    limit,
  });
}

export async function teammateSendText(
  operatorId: string,
  threadId: string,
  text: string,
  activeSessionId?: string | null,
): Promise<TeammateMessage> {
  return invoke<TeammateMessage>("teammate_send_text_message", {
    operatorId,
    threadId,
    text,
    activeSessionId: activeSessionId ?? null,
  });
}

export async function teammateListThreads(operatorId: string): Promise<TeammateThread[]> {
  return invoke<TeammateThread[]>("teammate_list_threads", { operatorId });
}
export async function teammateCreateThread(operatorId: string, title: string): Promise<TeammateThread> {
  return invoke<TeammateThread>("teammate_create_thread", { operatorId, title });
}
export async function teammateRenameThread(threadId: string, title: string): Promise<void> {
  return invoke<void>("teammate_rename_thread", { threadId, title });
}
export async function teammateArchiveThread(threadId: string): Promise<void> {
  return invoke<void>("teammate_archive_thread", { threadId });
}

export async function teammateConfirmTask(
  operatorId: string,
  messageId: string,
): Promise<Task> {
  return invoke<Task>("teammate_confirm_task", { operatorId, messageId });
}

export async function teammateCancelTaskProposal(
  messageId: string,
): Promise<void> {
  return invoke<void>("teammate_cancel_task_proposal", { messageId });
}

/// Mark an already-active/blocked task as cancelled. Used by the
/// teammate panel's task-detail "Stop" button.
export async function teammateCancelActiveTask(taskId: string): Promise<void> {
  return invoke<void>("teammate_cancel_active_task", { taskId });
}

/// Mark an active/blocked task as done, releasing the operator so it can
/// pick up the next task. Used by the task-detail "Mark done" button.
export async function teammateCompleteTask(taskId: string): Promise<void> {
  return invoke<void>("teammate_complete_task", { taskId });
}

export async function teammateEditTaskProposal(
  messageId: string,
  draft: TaskDraft,
): Promise<void> {
  return invoke<void>("teammate_edit_task_proposal", { messageId, draft });
}

export async function teammateAttachSessionToTask(
  operatorId: string,
  taskId: string,
  sessionId: string,
): Promise<void> {
  return invoke<void>("teammate_attach_session_to_task", {
    operatorId, taskId, sessionId,
  });
}

export async function teammateListTasks(operatorId: string): Promise<Task[]> {
  return invoke<Task[]>("teammate_list_tasks", { operatorId });
}

export async function teammateClearForOperator(operatorId: string): Promise<void> {
  return invoke<void>("teammate_clear_for_operator", { operatorId });
}

/// Delete finished tasks (done | cancelled) for an operator, leaving active,
/// blocked, and draft tasks intact. Returns the number of tasks removed.
export async function teammateClearFinishedTasks(operatorId: string): Promise<number> {
  return invoke<number>("teammate_clear_finished_tasks", { operatorId });
}

/// Delete a single task by id. Artifacts cascade via the FK on
/// teammate_artifacts.task_id.
export async function teammateDeleteTask(taskId: string): Promise<void> {
  return invoke<void>("teammate_delete_task", { taskId });
}

/// A single operator decision row, as returned by the teammate task-details
/// view's decisions feed. Mirrors `crate::storage::OperatorDecisionRow`.
export interface OperatorDecisionRow {
  id: number;
  session_id_short: string;
  timestamp_unix_ms: number;
  in_flight_command: string | null;
  output_excerpt: string;
  action: string;
  reply_text: string | null;
  rationale: string | null;
  executed: boolean;
  mission_path: string | null;
  executor_name: string | null;
  operator_id: string | null;
  operator_name: string | null;
  cost_usd: number;
  applied_memory_id: number | null;
  /// Escalation notification text (only for action === "escalate").
  escalation: string | null;
  /// Trigger class tag for coalescing/grouping. Optional: the backend
  /// persists the column but does not yet emit it (always absent for now).
  trigger_class?: string | null;
}

export async function teammateListDecisionsForSession(
  sessionId: string,
  limit = 20,
): Promise<OperatorDecisionRow[]> {
  return invoke<OperatorDecisionRow[]>("teammate_list_decisions_for_session", {
    sessionId, limit,
  });
}

export async function onTeammateTask(
  handler: (task: Task) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<Task>("teammate-task", (e) => handler(e.payload));
  return unlisten;
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

/// Atomic priming for a freshly-spawned executor tab. Attaches the
/// originating chat's spec as the mission AND queues a /rename slot
/// to be injected on next idle. Backend: `prime_spawned_tab` in
/// `crates/app/src/lib.rs`. The caller MUST await this before
/// injecting the executor's first prompt.
export async function primeSpawnedTab(
  sessionId: SessionId,
  specPath: string,
): Promise<void> {
  return invoke<void>("prime_spawned_tab", {
    sessionId,
    specPath,
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

/// Arm solo autonomous mode on one session (full AOM posture, no global
/// banner). Ephemeral — cleared on reload. Returns the new solo state.
export async function operatorSoloStart(
  sessionId: SessionId,
): Promise<boolean> {
  return invoke<boolean>("operator_solo_start", { sessionId });
}

export async function operatorSoloStop(
  sessionId: SessionId,
): Promise<boolean> {
  return invoke<boolean>("operator_solo_stop", { sessionId });
}

export async function operatorSoloStatus(
  sessionId: SessionId,
): Promise<boolean> {
  return invoke<boolean>("operator_solo_status", { sessionId });
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
  /// Escalation notification text (only for action === "escalate").
  escalation: string | null;
  /// Trigger class tag for coalescing/grouping. Optional: the backend
  /// persists the column but does not yet emit it (always absent for now).
  trigger_class?: string | null;
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
  mind_v2: boolean;
  mind_thinking_budget: number;
}

export function readFontBytes(familyStack: string): Promise<Uint8Array> {
  return invoke<number[]>("read_font_bytes", { familyStack }).then(
    (arr) => new Uint8Array(arr),
  );
}

export function listMonospaceFonts(): Promise<string[]> {
  return invoke<string[]>("list_monospace_fonts", {});
}

export interface TerminalConfig {
  font_family: string;
  font_size: number;
  letter_spacing: number;
  line_height: number;
  ligatures: boolean;
}

export type WindowBackground = "solid" | "vibrant" | "translucent";

export type ThemeMode = "dark" | "light" | "system" | "true_dark";
export type ResolvedTheme = "dark" | "light";

/// Cosmetic tab/group skin. Mirrors the Rust `TabStyle` enum. Applied by
/// toggling a `body.tab-style-<variant>` class: "classic" (default flat-pill),
/// "forge" (angled mechanical), "glass" (icy translucent), "crt" (phosphor retro).
export type TabStyle = "classic" | "forge" | "glass" | "crt";

export type TabShape = "rectangle" | "rounded" | "lofted" | "pill";
export type TabBgMode = "solid" | "translucent" | "off" | "gradient";
export type TabIndicator = "stripe" | "underline" | "left-bar" | "dot" | "glow" | "border";
export type TabHeight = "normal" | "compact" | "spacious";
export type TabGap = "normal" | "tight" | "loose";
export type GroupShape = "match" | "rectangle" | "rounded" | "lofted" | "pill";
export type GroupBg = "tinted" | "solid" | "off";

export interface TabStylesConfig {
  enabled: boolean;
  shape: TabShape;
  bg_mode: TabBgMode;
  bg_gradient?: [string, string];
  indicator: TabIndicator;
  height: TabHeight;
  gap: TabGap;
  // Optional: absent in configs saved before group customization.
  group_shape?: GroupShape;
  group_bg?: GroupBg;
}

export async function setWindowTheme(mode: ResolvedTheme): Promise<void> {
  await invoke("set_window_theme", { mode });
}

export interface WindowConfig {
  background: WindowBackground;
  theme?: ThemeMode;
  tab_style?: TabStyle;
}

export interface AomConfig {
  default_budget_usd: number;
}

export interface NotificationConfig {
  on_operator_escalate: boolean;
  on_aom_error: boolean;
  on_aom_complete: boolean;
  on_executor_idle: boolean;
  suppress_when_focused: boolean;
  email_enabled: boolean;
  email_from?: string | null;
  email_to?: string | null;
  email_digest_window_minutes: number;
}

export interface ProviderEntry {
  kind: "anthropic" | "openai_compat" | "azure_foundry";
  label: string;
  api_key?: string | null;
  base_url?: string | null;
  // Azure Foundry only:
  azure_mode?: "azure_open_ai" | "ai_inference" | null;
  azure_api_version?: string | null;
  azure_deployment?: string | null;
}

export interface RouteEntry {
  provider_id: string;
  model: string;
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
  hidden_indicators: string[];
  /// 3.7 — render the bottom status bar (git + runtime). Default true.
  status_bar_enabled: boolean;
  /// Floating executor notch overlay (pills showing Claude/Codex/Pi
  /// activity). Default true.
  notch_enabled: boolean;
  notch_corner?:
    | "bottom-right"
    | "bottom-left"
    | "top-right"
    | "top-left"
    | "notch"
    | "notch-mini";
  notch_sound_on_done?: boolean;
  /// Tabbar layout: "top" (default, horizontal across the top) or
  /// "left" (fixed vertical sidebar à la Wave Terminal).
  tabbar_position: TabbarPosition;
  /// Visual style of the folded left sidebar (collapsed rail). The
  /// frontend flips `body.tabbar-rail-<style>`; "legacy" (default) is
  /// the original pill rail.
  folded_rail_style?: FoldedRailStyle;
  /// CSS font stack for UI chrome (panels, settings, modals, group
  /// labels). `null` = built-in system sans default. Terminal and
  /// editor fonts are configured separately.
  ui_font_family: string | null;
  /// Familiars feature flag. Both this AND `is_premium` must be true
  /// for the auto-spawn-on-operator-start flow to fire.
  familiars_enabled: boolean;
  /// Premium gate for Familiars (and any other premium-only features).
  is_premium: boolean;
  /// Local LLM provider registry. Keys are provider ids.
  providers?: Record<string, ProviderEntry>;
  /// Model routing table mapping role names to provider+model.
  model_routes?: Record<string, RouteEntry>;
  /// 4.x — experimental feature flags.
  experimental?: {
    split_panes?: boolean;
    statusbar_two_row?: boolean;
    internal_browser?: boolean;
    tab_styles?: TabStylesConfig;
  };
  /// First-run onboarding wizard. `false` on a clean install so the
  /// wizard auto-opens; the wizard flips it to `true` on Done/Skip.
  /// Bumping `ONBOARDING_VERSION` re-shows the wizard for users who
  /// have an older version stamped.
  onboarding_completed?: boolean;
  onboarding_version?: number;
  /// LSP ("Code intelligence") master toggle + per-language download
  /// consent. `undefined` on settings written before this field existed —
  /// treat as the default (enabled, nothing consented).
  code_intelligence?: CodeIntelligenceConfig;
}

export interface CodeIntelligenceConfig {
  enabled: boolean;
  consented_languages: string[];
}

export async function validateSendGridKey(apiKey: string): Promise<boolean> {
  return invoke<boolean>('validate_sendgrid_key', { apiKey });
}

export async function setSettings(settings: Settings): Promise<void> {
  return invoke<void>("set_settings", { settings });
}

export type TabbarPosition = "top" | "left";

export type FoldedRailStyle = "legacy" | "glyph" | "labels" | "spine";

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

export interface GitBranchSummary {
  name: string;
  current: boolean;
  upstream: string | null;
  last_commit: string | null;
  worktree_path: string | null;
}

export interface GitWorktreeSummary {
  path: string;
  branch: string | null;
  head: string | null;
  current: boolean;
  detached: boolean;
  bare: boolean;
  dirty_count: number;
}

export interface GitRepoSummary {
  repo_name: string;
  repo_root: string;
  current_branch: string | null;
  detached_head: string | null;
  dirty_count: number;
  branches: GitBranchSummary[];
  worktrees: GitWorktreeSummary[];
}

export async function gitRepoSummary(cwd: string): Promise<GitRepoSummary> {
  return invoke<GitRepoSummary>("git_repo_summary", { cwd });
}

export async function gitSwitchBranch(cwd: string, branch: string): Promise<GitRepoSummary> {
  return invoke<GitRepoSummary>("git_switch_branch", { cwd, branch });
}

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";
export type LineKind = "context" | "add" | "del";
export interface DiffLine { kind: LineKind; oldNo: number | null; newNo: number | null; text: string; }
export interface Hunk { oldStart: number; newStart: number; header: string; lines: DiffLine[]; }
export type FileDiffBody =
  | { kind: "hunks"; hunks: Hunk[] }
  | { kind: "binary"; sizeBytes: number }
  | { kind: "tooLarge"; lineCount: number };
export interface FileChange {
  path: string; oldPath: string | null; status: ChangeStatus;
  added: number; removed: number; binary: boolean;
}
export interface Changes { staged: FileChange[]; unstaged: FileChange[]; }
export interface FileDiff { path: string; oldPath: string | null; body: FileDiffBody; }

export async function gitChanges(cwd: string): Promise<Changes> {
  return invoke<Changes>("git_changes", { cwd });
}

// Beacon — GitHub Actions workflow status sidebar ----------------------

export type BeaconRun = {
  id: number;
  name: string; // workflow name, e.g. "Release macOS"
  state: string; // success | failure | in_progress | queued | cancelled | ...
  run_number: number;
  branch: string | null;
  sha: string;
  actor: string | null;
  url: string | null;
  updated_at: string;
};

export type BeaconSubRepo = { path: string; repo: string };

export type BeaconState =
  | { kind: "not_authed" }
  | { kind: "no_repo" }
  | { kind: "repos"; dirs: BeaconSubRepo[] }
  | { kind: "ok"; repo: string; runs: BeaconRun[] }
  | { kind: "error"; message: string };

export async function beaconWorkflowRuns(cwd: string): Promise<BeaconState> {
  return invoke<BeaconState>("beacon_workflow_runs", { cwd });
}

export async function beaconRerunWorkflow(cwd: string, runId: number): Promise<void> {
  return invoke<void>("beacon_rerun_workflow", { cwd, runId });
}

export async function beaconCancelWorkflow(cwd: string, runId: number): Promise<void> {
  return invoke<void>("beacon_cancel_workflow", { cwd, runId });
}

// Somnus — REST client sidebar -----------------------------------------

export type SomnusRequest = {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
};

export type SomnusResponse = {
  status: number;
  status_text: string;
  headers: [string, string][];
  body: string;
  body_truncated: boolean;
  body_binary: boolean;
  duration_ms: number;
  size_bytes: number;
};

export type SomnusHistoryEntry = {
  id: string;
  method: string;
  url: string;
  req_headers: [string, string][];
  req_body: string | null;
  status: number | null;
  resp_headers: [string, string][];
  resp_body: string | null;
  error: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
  created_at_unix_ms: number;
};

export async function somnusSend(req: SomnusRequest): Promise<SomnusResponse> {
  return invoke<SomnusResponse>("somnus_send", { req });
}

export async function somnusHistory(limit?: number): Promise<SomnusHistoryEntry[]> {
  return invoke<SomnusHistoryEntry[]>("somnus_history", { limit: limit ?? null });
}

export async function somnusHistoryDelete(id: string): Promise<void> {
  return invoke<void>("somnus_history_delete", { id });
}

export async function somnusHistoryClear(): Promise<void> {
  return invoke<void>("somnus_history_clear", {});
}

// Canon — local Covenant Dependency Lifecycle Catalog ------------------

export interface InstalledRef {
  name: string;
  version: string;
  source: string;
  sha: string;
  signer: string | null;
  installedAt: string;
}

export interface AgentRef {
  name: string;
}

export interface ContextRef {
  name: string;
  summary: string | null;
}

export interface CommandRef {
  name: string;
  description: string | null;
}

export interface CanonStatus {
  installed: InstalledRef[];
  agents: AgentRef[];
  contexts: ContextRef[];
  commands: CommandRef[];
}

export async function canonLocalStatus(cwd: string): Promise<CanonStatus> {
  return invoke<CanonStatus>("canon_local_status", { cwd });
}

export async function canonInstallLocal(
  cwd: string,
  source: string,
  group: string | null,
  workspace: string | null,
): Promise<InstalledRef> {
  return invoke<InstalledRef>("canon_install_local", { cwd, source, group, workspace });
}

// Canon — registry (Phase 2) -------------------------------------------

export interface Org {
  id: number;
  slug: string;
  name: string;
  role: string;
  personal: boolean;
}
export interface Member {
  login: string;
  role: string;
}
export interface PkgMeta {
  id: number;
  name: string;
  version: string;
  description: string;
  publisher_login: string;
  installs: number;
  sha: string;
}
export async function canonMyOrgs(): Promise<Org[]> {
  return invoke<Org[]>("canon_my_orgs");
}
export async function canonCreateOrg(slug: string, name: string): Promise<unknown> {
  return invoke("canon_create_org", { slug, name });
}
export async function canonOrgMembers(org: string): Promise<Member[]> {
  return invoke<Member[]>("canon_org_members", { org });
}
export async function canonAddMember(org: string, login: string): Promise<void> {
  return invoke("canon_add_member", { org, login });
}
export async function canonRemoveMember(org: string, login: string): Promise<void> {
  return invoke("canon_remove_member", { org, login });
}
export async function canonSearch(org: string, query: string | null): Promise<PkgMeta[]> {
  return invoke<PkgMeta[]>("canon_search", { org, query });
}
export interface CanonPreview {
  description: string;
  skill_md: string;
}
export async function canonPreview(org: string, name: string, version: string): Promise<CanonPreview> {
  return invoke<CanonPreview>("canon_preview", { org, name, version });
}
export async function canonReadLocal(cwd: string, name: string): Promise<string> {
  return invoke<string>("canon_read_local", { cwd, name });
}

export async function canonReadSource(
  cwd: string,
  kind: "agent" | "context" | "command" | "skill",
  name: string,
): Promise<string> {
  return invoke<string>("canon_read_source", { cwd, kind, name });
}
export async function canonExport(cwd: string): Promise<void> {
  return invoke<void>("canon_export", { cwd });
}

export type ProjState = "synced" | "stale" | "not_projected";
export interface ExecutorStatus {
  tool: string;
  state: ProjState;
}
export interface ProjectionStatus {
  executors: ExecutorStatus[];
  source_edited_unix: number | null;
}
export async function canonProjectionStatus(cwd: string): Promise<ProjectionStatus> {
  return invoke<ProjectionStatus>("canon_projection_status", { cwd });
}

export interface ScoreSummary {
  total_prompts: number;
  total_commits: number;
  total_tokens: number;
  total_specs: number;
}
/** Per-group score aggregate (prompts/commits/specs/tokens) for the Canon Loop. */
export async function scoreSummaryFiltered(groupName: string | null): Promise<ScoreSummary> {
  const filter = { repo: null, branch: null, group_name: groupName, day: null, agent: null };
  return invoke<ScoreSummary>("score_summary_filtered", { filter });
}
export async function canonPublish(cwd: string, org: string, name: string): Promise<unknown> {
  return invoke<unknown>("canon_publish", { cwd, org, name });
}
export async function canonInstallRegistry(
  cwd: string,
  org: string,
  name: string,
  version: string,
  group: string | null,
  workspace: string | null,
): Promise<InstalledRef> {
  return invoke<InstalledRef>("canon_install_registry", { cwd, org, name, version, group, workspace });
}

// Canon — eval runner (Task 4) -----------------------------------------

export interface EvalSkillSummary {
  skill: string;
  passed: number;
  total: number;
}

export interface CanonEvalProgress {
  skill: string;
  eval_id: string;
  status: "running" | "pass" | "fail" | "skipped" | "error" | "done";
  reason: string;
}

export async function canonRunEvals(cwd: string, skill: string): Promise<void> {
  return invoke<void>("canon_run_evals", { cwd, skill });
}

export async function canonEvalSummary(cwd: string): Promise<EvalSkillSummary[]> {
  return invoke<EvalSkillSummary[]>("canon_eval_summary", { cwd });
}

export async function onCanonEvalProgress(
  handler: (e: CanonEvalProgress) => void,
): Promise<UnlistenFn> {
  return listen<CanonEvalProgress>("canon-eval-progress", (e) => handler(e.payload));
}

export async function gitFileDiff(cwd: string, path: string, staged: boolean): Promise<FileDiff> {
  return invoke<FileDiff>("git_file_diff", { cwd, path, staged });
}
export async function gitStage(cwd: string, path: string): Promise<Changes> {
  return invoke<Changes>("git_stage", { cwd, path });
}
export async function gitUnstage(cwd: string, path: string): Promise<Changes> {
  return invoke<Changes>("git_unstage", { cwd, path });
}
export async function gitCommit(cwd: string, message: string, push = false): Promise<Changes> {
  return invoke<Changes>("git_commit", { cwd, message, push });
}
export async function generateCommitMessage(cwd: string): Promise<string> {
  return invoke<string>("generate_commit_message", { cwd });
}

export async function getSettings(): Promise<Settings> {
  return invoke<Settings>("get_settings");
}

export interface ExperimentalFlags {
  split_panes: boolean;
  statusbar_two_row: boolean;
  internal_browser: boolean;
  tab_styles: TabStylesConfig;
}

export async function getExperimentalFlags(): Promise<ExperimentalFlags> {
  const settings = await getSettings();
  return {
    split_panes: settings.experimental?.split_panes ?? false,
    statusbar_two_row: settings.experimental?.statusbar_two_row ?? true,
    internal_browser: settings.experimental?.internal_browser ?? false,
    tab_styles: settings.experimental?.tab_styles ?? {
      enabled: false,
      shape: "rectangle",
      bg_mode: "solid",
      indicator: "stripe",
      height: "normal",
      gap: "normal",
    },
  };
}

export interface CommandAction {
  cmd: string;
  rationale: string;
  risk: "safe" | "mutates" | "destructive";
  cwd_hint?: string | null;
}

export interface AgentResponse {
  explanation: string;
  command: CommandAction | null;
  followups: string[];
}

export async function askAgent(
  sessionId: SessionId,
  question: string,
  onExplanation: (delta: string) => void,
  onResponse: (resp: AgentResponse) => void,
): Promise<void> {
  const explChan = new Channel<string>();
  explChan.onmessage = (delta) => onExplanation(delta);
  const respChan = new Channel<AgentResponse>();
  respChan.onmessage = (resp) => onResponse(resp);
  return invoke<void>("ask_agent", {
    sessionId,
    question,
    onExplanation: explChan,
    onResponse: respChan,
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

/// Copy OS files/folders (dragged in from Finder) into `destDir`.
/// Returns the created top-level paths. Collisions auto-rename.
export async function structureCopyInto(
  sources: string[],
  destDir: string,
): Promise<string[]> {
  return invoke<string[]>("structure_copy_into", { sources, destDir });
}

/// Move tree entries into `destDir` (internal drag-to-move between folders).
/// Returns the new top-level paths. Collisions auto-rename; a source already
/// in `destDir` is a no-op.
export async function structureMoveInto(
  sources: string[],
  destDir: string,
): Promise<string[]> {
  return invoke<string[]>("structure_move_into", { sources, destDir });
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

/// One match from a fuzzy filename search. `match_indices` are CHAR
/// offsets within `rel_path` where the needle subsequence landed —
/// the UI bolds those positions.
export interface FileHit {
  path: string;
  rel_path: string;
  match_indices: number[];
}

/// Fuzzy filename search across `cwd`, honoring the same ignores as
/// `structureSearch`. Empty query returns []. Results are pre-sorted
/// by score (basename + contiguous-run boosts) on the server.
export async function structureFindFiles(
  cwd: string,
  query: string,
  limit: number,
): Promise<FileHit[]> {
  return invoke<FileHit[]>("structure_find_files", { cwd, query, limit });
}

/// One per-block hit for the `@` mention picker. `match_indices` are
/// CHAR offsets within `command` where the fuzzy subsequence landed.
export interface CommandHit {
  block_id: string;
  session_id: string;
  command: string;
  exit_code: number | null;
  cwd: string;
  finished_at_unix_ms: number;
  match_indices: number[];
}

/// Per-block fuzzy command search. Empty query returns the most
/// recent finished blocks; otherwise results are ranked by fuzzy
/// score then recency.
export async function findRecentCommands(
  query: string,
  limit: number,
): Promise<CommandHit[]> {
  return invoke<CommandHit[]>("find_recent_commands", { query, limit });
}

/// One spec hit for the `@spec:` mention picker. Sourced from the
/// project's published-specs index (same data the Set Mission picker
/// shows), filtered in-process for fuzzy match.
export interface SpecHit {
  id: string;          // version-like, e.g. "3.23"
  title: string;
  goal: string;        // one-line description
  abs_path: string;
  updated_at: string;
  match_indices: number[]; // CHAR offsets in title
}

export async function findSpecs(repoRoot: string, query: string, limit: number): Promise<SpecHit[]> {
  const { draftsApi } = await import("./drafts/api");
  const all = await draftsApi.listPublishedSpecs(repoRoot);
  const q = query.toLowerCase();
  const scored: Array<{ score: number; indices: number[]; spec: typeof all[number] }> = [];
  for (const s of all) {
    if (q === "") {
      scored.push({ score: 0, indices: [], spec: s });
      continue;
    }
    const haystack = (s.id + " " + s.title + " " + s.goal).toLowerCase();
    const titleLower = s.title.toLowerCase();
    if (!haystack.includes(q)) continue;
    const indices: number[] = [];
    let qi = 0;
    for (let i = 0; i < titleLower.length && qi < q.length; i++) {
      if (titleLower[i] === q[qi]) { indices.push(i); qi++; }
    }
    const score = titleLower.startsWith(q) ? 100 : titleLower.includes(q) ? 50 : 10;
    scored.push({ score, indices, spec: s });
  }
  scored.sort((a, b) => b.score - a.score || b.spec.id.localeCompare(a.spec.id));
  return scored.slice(0, limit).map(({ indices, spec }) => ({
    id: spec.id,
    title: spec.title,
    goal: spec.goal,
    abs_path: spec.path,
    updated_at: spec.updated_at,
    match_indices: indices,
  }));
}

/// Full output + metadata for a single block — used to inline a
/// `@cmd:<block_id>` mention chip into the prompt sent to the operator.
export interface BlockExcerpt {
  command: string;
  exit_code: number | null;
  cwd: string;
  plain_output: string;
}

/// Cwd + the N most-recent finished blocks for a session — used to
/// inline a `@session:<short>` mention chip. `shell`/`tab_index` come
/// back blank from the backend; UI fills them from the live TabManager.
export interface SessionExcerpt {
  cwd: string;
  shell: string;
  tab_index: number;
  recent: Array<{ command: string; exit_code: number | null; tail: string }>;
}

export async function readBlockExcerpt(block_id: string): Promise<BlockExcerpt> {
  return invoke<BlockExcerpt>("read_block_excerpt", { blockId: block_id });
}

export async function readSessionExcerpt(session_id: string, n = 5): Promise<SessionExcerpt> {
  return invoke<SessionExcerpt>("read_session_excerpt", { sessionId: session_id, n });
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
  /// Last ~15 non-empty lines of the executor's screen at escalation
  /// time (ANSI-stripped). Distinct from `question`, which is the
  /// operator's rationale; this is the raw context the user reads to
  /// reply.
  executor_excerpt: string | null;
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
  /** Resolved git root the draft was authored in; null for legacy/global drafts. */
  repo_root: string | null;
}

export async function specAuthorStep(
  draftId: string | null,
  userMsg: string,
  cwd?: string | null,
): Promise<SpecStepResult> {
  return invoke<SpecStepResult>("spec_author_step", { draftId, userMsg, cwd: cwd ?? null });
}

export async function specAuthorLoadDraft(id: string): Promise<SpecDraftSummary> {
  return invoke<SpecDraftSummary>("spec_author_load_draft", { id });
}

export async function specAuthorListDrafts(
  repoRoot?: string | null,
): Promise<SpecDraftSummary[]> {
  return invoke<SpecDraftSummary[]>("spec_author_list_drafts", { repoRoot: repoRoot ?? null });
}

export async function specAuthorMarkPublished(id: string): Promise<void> {
  return invoke<void>("spec_author_mark_published", { id });
}

export async function specAuthorDeleteDraft(id: string): Promise<void> {
  return invoke<void>("spec_author_delete_draft", { id });
}

/** Persist a user-edited spec body (overwrites the draft's partial_md). */
export async function specAuthorSaveMarkdown(id: string, markdown: string): Promise<void> {
  return invoke<void>("spec_author_save_markdown", { id, markdown });
}

/** One composer-attached image, base64-encoded (no data: prefix). */
export interface SpecAttachedImage {
  dataB64: string;
  mediaType: string;
}

export async function specAuthorStreamStep(
  draftId: string | null,
  userMsg: string,
  cwd: string | null,
  images?: SpecAttachedImage[],
): Promise<string> {
  return invoke<string>("spec_author_stream_step", {
    draftId, userMsg, cwd, images: images && images.length ? images : null,
  });
}

/** Copy a draft's attached images into `<repoRoot>/docs/specs/assets/<id>/`.
 *  Returns repo-relative paths; empty when the draft has no images. */
export async function specAuthorMaterializeAssets(
  id: string,
  repoRoot: string,
): Promise<string[]> {
  return invoke<string[]>("spec_author_materialize_assets", { id, repoRoot });
}

export async function telegramTestConnection(): Promise<void> {
  return invoke<void>("telegram_test_connection");
}

export type TelegramStatus = "disabled" | "ok" | "error";

export async function telegramStatus(): Promise<TelegramStatus> {
  return invoke<TelegramStatus>("telegram_status");
}

// ── Capabilities (T7–T9) ────────────────────────────────────────────────────
// Mirrors `capabilities_commands::CapabilityListItem` / `DetectResult` in
// `crates/app/src/capabilities_commands.rs`. Keep in sync.

export interface CapabilityListItem {
  id: string;
  tool: "claude" | "copilot" | "opencode" | "codex" | "pi" | "shared" | "covenant";
  kind:
    | "skill"
    | "command"
    | "hook"
    | "mcp"
    | "plugin"
    | "agent"
    | "memory"
    | "extension"
    | "config";
  name: string;
  description: string | null;
  path: string;
  scope_label: string;
  read_only: boolean;
}

export interface CapabilitiesDetect {
  claude: boolean;
  copilot: boolean;
  opencode: boolean;
  codex: boolean;
  pi: boolean;
  shared: boolean;
  covenant: boolean;
}

export async function capabilitiesList(
  projectRoot: string | null,
): Promise<CapabilityListItem[]> {
  return invoke<CapabilityListItem[]>("capabilities_list", {
    projectRoot,
  });
}

export async function capabilitiesRead(path: string): Promise<string> {
  return invoke<string>("capabilities_read", { path });
}

export interface CapabilityDirEntry {
  name: string;
  is_dir: boolean;
  size: number;
}

export async function capabilitiesListDir(
  path: string,
): Promise<CapabilityDirEntry[]> {
  return invoke<CapabilityDirEntry[]>("capabilities_list_dir", { path });
}

export async function capabilitiesWrite(
  path: string,
  contents: string,
): Promise<void> {
  return invoke<void>("capabilities_write", { path, contents });
}

export async function capabilitiesDelete(path: string): Promise<void> {
  return invoke<void>("capabilities_delete", { path });
}

export async function capabilitiesScaffold(
  tool: string,
  kind: string,
  name: string,
  description: string,
  projectRoot: string | null,
): Promise<string> {
  return invoke<string>("capabilities_scaffold", {
    tool,
    kind,
    name,
    description,
    projectRoot,
  });
}

export async function capabilitiesDetect(): Promise<CapabilitiesDetect> {
  return invoke<CapabilitiesDetect>("capabilities_detect");
}

// ── Local LLM provider model listing ────────────────────────────────────────

export type ModelInfo = { id: string; label: string | null };

export async function listModelsAnthropic(): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("list_models_anthropic");
}

export async function listModelsOpenAiCompat(
  baseUrl: string,
  apiKey?: string | null,
): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("list_models_openai_compat", { baseUrl, apiKey: apiKey ?? null });
}

export async function listModelsAzureFoundry(args: {
  endpoint: string;
  apiKey: string;
  mode: "azure_open_ai" | "ai_inference";
  apiVersion: string;
}): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>("list_models_azure_foundry", {
    endpoint: args.endpoint,
    apiKey: args.apiKey,
    mode: args.mode,
    apiVersion: args.apiVersion,
  });
}

/// One-token live probe against Anthropic's Messages API. Returns token
/// counts from the response's `usage` block. Costs ~$0.000002 per call
/// (Haiku, 1 input + 1 output token at max_tokens=1).
export interface AnthropicProbeResult {
  input_tokens: number;
  output_tokens: number;
  model: string;
}

export async function testAnthropicKey(apiKey: string): Promise<AnthropicProbeResult> {
  return invoke<AnthropicProbeResult>("test_anthropic_key", { apiKey });
}

/// Adopt the hosted Covenant trial as the provider for every role. Reads
/// the Covenant JWT from the keychain in Rust (must be signed in) and
/// wires it into Settings — the JWT never reaches the webview. Rejects
/// with "Sign in to Covenant first" when signed out.
export async function adoptTrialProvider(): Promise<void> {
  return invoke<void>("adopt_trial_provider");
}

// ---------------------------------------------------------------------------
// Pi RPC executor — see crates/agent/src/pi_rpc/* and crates/app/src/pi_commands.rs
//
// Types mirror Pi's wire format verbatim. Discriminants are snake_case;
// field names are camelCase. Do NOT rename without updating the Rust side.
// ---------------------------------------------------------------------------

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type PiQueueMode = "all" | "one-at-a-time";
export type PiStreamingBehavior = "steer" | "followUp";
export type PiCompactionReason = "manual" | "threshold" | "overflow";
export type PiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
export type PiUiMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle"
  | "setEditorText";

export interface PiSpawnOpts {
  cwd?: string;
  provider?: string;
  model?: string;
  sessionDir?: string;
  noSession?: boolean;
  extraArgs?: string[];
  program?: string;
}

export interface PiState {
  model?: unknown;
  thinkingLevel?: PiThinkingLevel;
  isStreaming?: boolean;
  sessionPath?: string;
  messageCount?: number;
}

export interface PiSessionStats {
  inputTokens?: number;
  outputTokens?: number;
  totalCost?: number;
  contextWindowUsed?: number;
}

export interface PiAssistantContentText {
  type: "text";
  text: string;
}
export interface PiAssistantContentThinking {
  type: "thinking";
  thinking: string;
}
export interface PiAssistantContentToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: unknown;
}
export type PiAssistantContent =
  | PiAssistantContentText
  | PiAssistantContentThinking
  | PiAssistantContentToolCall
  | { type: string; [k: string]: unknown };

export interface PiAssistantMessage {
  role: "assistant";
  content: PiAssistantContent[];
  model?: string;
  stopReason?: PiStopReason;
  usage?: unknown;
  timestamp?: number;
}
export interface PiUserMessage {
  role: "user";
  content: string;
  timestamp?: number;
  attachments?: unknown[];
}
export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  timestamp?: number;
}
export interface PiBashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  timestamp?: number;
}
export type PiAgentMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiBashExecutionMessage;

/// Streaming delta variants inside `message_update.assistantMessageEvent`.
export type PiDeltaEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string; partial?: unknown }
  | { type: "text_end"; contentIndex: number }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number }
  | { type: "toolcall_start"; contentIndex: number }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: string; [k: string]: unknown };

/// Discriminated union of every event the backend forwards from a Pi
/// session. Subscribe via [`subscribePiEvents`]. Extra event types added
/// by future Pi releases arrive as `{ type: "unknown" }` (the Rust side
/// downgrades unknowns to a sentinel rather than dropping the line).
export type PiEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: PiAgentMessage[] }
  | { type: "turn_start" }
  | {
      type: "turn_end";
      message: PiAssistantMessage;
      toolResults: PiToolResultMessage[];
    }
  | { type: "message_start"; message: PiAgentMessage }
  | {
      type: "message_update";
      message: PiAgentMessage;
      assistantMessageEvent: PiDeltaEvent;
    }
  | { type: "message_end"; message: PiAgentMessage }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: PiCompactionReason }
  | {
      type: "compaction_end";
      reason: PiCompactionReason;
      result?: { summary?: string; firstKeptEntryId?: string; tokensBefore?: number };
      aborted: boolean;
      willRetry: boolean;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage?: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | {
      type: "extension_error";
      extensionPath: string;
      event: string;
      error: string;
    }
  | ({
      type: "extension_ui_request";
      id: string;
      method: PiUiMethod;
    } & Record<string, unknown>)
  | { type: "process_exited"; code: number | null }
  | { type: "unknown" };

export async function spawnPiSession(
  opts: PiSpawnOpts = {},
): Promise<SessionId> {
  const result = await invoke<{ sessionId: SessionId }>("spawn_pi_session", { opts });
  return result.sessionId;
}

export async function closePiSession(sessionId: SessionId): Promise<void> {
  return invoke<void>("close_pi_session", { sessionId });
}

export async function piSendPrompt(
  sessionId: SessionId,
  text: string,
  streamingBehavior?: PiStreamingBehavior,
): Promise<void> {
  return invoke<void>("pi_send_prompt", { sessionId, text, streamingBehavior });
}

export async function piSteer(sessionId: SessionId, text: string): Promise<void> {
  return invoke<void>("pi_steer", { sessionId, text });
}

export async function piFollowUp(sessionId: SessionId, text: string): Promise<void> {
  return invoke<void>("pi_follow_up", { sessionId, text });
}

export async function piAbort(sessionId: SessionId): Promise<void> {
  return invoke<void>("pi_abort", { sessionId });
}

export async function piNewSession(
  sessionId: SessionId,
  parentSession?: string,
): Promise<void> {
  return invoke<void>("pi_new_session", { sessionId, parentSession });
}

export async function piSetSessionName(
  sessionId: SessionId,
  name: string,
): Promise<void> {
  return invoke<void>("pi_set_session_name", { sessionId, name });
}

export async function piGetState(sessionId: SessionId): Promise<PiState> {
  return invoke<PiState>("pi_get_state", { sessionId });
}

export async function piSetModel(
  sessionId: SessionId,
  provider: string,
  modelId: string,
): Promise<void> {
  return invoke<void>("pi_set_model", { sessionId, provider, modelId });
}

export async function piGetAvailableModels(sessionId: SessionId): Promise<unknown> {
  return invoke<unknown>("pi_get_available_models", { sessionId });
}

export async function piSetThinkingLevel(
  sessionId: SessionId,
  level: PiThinkingLevel,
): Promise<void> {
  return invoke<void>("pi_set_thinking_level", { sessionId, level });
}

export async function piCompact(
  sessionId: SessionId,
  customInstructions?: string,
): Promise<void> {
  return invoke<void>("pi_compact", { sessionId, customInstructions });
}

export async function piGetSessionStats(sessionId: SessionId): Promise<PiSessionStats> {
  return invoke<PiSessionStats>("pi_get_session_stats", { sessionId });
}

export async function piExtensionUiResponse(
  sessionId: SessionId,
  requestId: string,
  payload: { value?: string; confirmed?: boolean; cancelled?: boolean },
): Promise<void> {
  return invoke<void>("pi_extension_ui_response", {
    sessionId,
    requestId,
    value: payload.value,
    confirmed: payload.confirmed,
    cancelled: payload.cancelled,
  });
}

/// Notify the score crate which session/cwd/group is currently active.
/// Fire-and-forget; pass nulls to clear.
export function scoreSetCurrentSession(
  sessionId: string | null,
  cwd: string | null,
  groupName: string | null,
  workspace: string | null,
): void {
  void invoke<void>("score_set_current_session", { sessionId, cwd, groupName, workspace });
}

/// Subscribe to a Pi session's event stream. Returns an unlisten fn that
/// must be called to detach. Topic: `session://{sessionId}/pi`.
export async function subscribePiEvents(
  sessionId: SessionId,
  handler: (event: PiEvent) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const topic = `session://${sessionId}/pi`;
  const unlisten = await listen<PiEvent>(topic, (e) => handler(e.payload));
  return unlisten;
}

// ---------------------------------------------------------------------------
// ACP tab executor — interactive `copilot --acp` sessions. See
// crates/agent/src/acp/* and crates/app/src/acp_commands.rs.
//
// Types mirror the ACP wire format (Agent Client Protocol) as re-emitted by
// the backend. Discriminants are snake_case; field names are camelCase. Do
// NOT rename without updating the Rust side (`AcpTabEvent` in
// crates/app/src/acp_commands.rs; `SessionUpdate` / `ContentBlock` /
// `PermissionRequest` in crates/agent/src/acp/protocol.rs).
// ---------------------------------------------------------------------------

/// A single ACP content block. Untagged on the wire — order matters: a diff
/// has `path` + `newText`, a text block has only `text`, anything else
/// falls through to the open bag.
export type AcpContentBlock =
  | { path: string; oldText?: string | null; newText: string } // diff
  | { text: string } // text
  | Record<string, unknown>; // other

export interface AcpToolCallFields {
  toolCallId: string;
  title?: string | null;
  kind?: string | null; // "edit" | "execute" | "read" | other (open set)
  status?: string | null; // "pending" | "in_progress" | "completed" | "failed" (open set)
  rawInput?: unknown;
  rawOutput?: unknown;
  content: AcpContentBlock[];
}

/// One slash command advertised by the agent (`/compact`, `/autopilot`, …).
/// Invoked by sending the command as plain prompt text.
export interface AcpAvailableCommand {
  name: string;
  description?: string | null;
  /// Free-form argument hint, e.g. `{ hint: "focus instructions" }`.
  input?: { hint?: string | null } | null;
}

/// One streamed `session/update` notification payload.
export type AcpSessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: AcpContentBlock }
  | { sessionUpdate: "user_message_chunk"; content: AcpContentBlock }
  | ({ sessionUpdate: "tool_call" } & AcpToolCallFields)
  | ({ sessionUpdate: "tool_call_update" } & AcpToolCallFields)
  | { sessionUpdate: "available_commands_update"; availableCommands: AcpAvailableCommand[] }
  | { sessionUpdate: string }; // future/unrecognized kinds

export interface AcpPermissionOption {
  optionId: string;
  kind: string; // "allow_once" | "allow_always" | "reject_once" (open set)
  name?: string | null;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string | null; kind?: string | null; rawInput?: unknown };
  options: AcpPermissionOption[];
}

/// Discriminated union of every event the backend forwards from an ACP tab
/// session. Subscribe via [`subscribeAcpEvents`].
export type AcpTabEvent =
  | { type: "update"; update: { sessionId: string; update: AcpSessionUpdate } }
  | { type: "permission_pending"; requestKey: string; request: AcpPermissionRequest }
  | { type: "prompt_done"; stopReason: string }
  | { type: "session_dead" }
  | {
      type: "perception_auto_answer";
      requestKey: string;
      optionId: string;
      reason: string;
    };

export interface SpawnAcpResult {
  sessionId: SessionId;
  /// Current model id from `session/new` (e.g. "claude-sonnet-4.6"), if reported.
  model: string | null;
  /// Wire-level ACP sessionId — persist it so a later restart can resume
  /// this conversation via `resumeAcpSessionId`.
  acpSessionId: string;
  /// True when a requested resume actually loaded (vs fresh fallback).
  resumed: boolean;
}

/// Executors with an ACP launch profile in the backend
/// (`AcpSpawnOpts::for_executor`).
export type AcpExecutor = "copilot" | "pi" | "claude" | "opencode";

export async function spawnAcpSession(
  opts: { cwd?: string | null; resumeAcpSessionId?: string | null; executor?: AcpExecutor } = {},
): Promise<SpawnAcpResult> {
  return invoke<SpawnAcpResult>("spawn_acp_session", { opts });
}

/// Latest slash-command roster for a live ACP session. Called once after
/// subscribing — the roster's initial broadcast races the listener setup.
export async function acpGetCommands(sessionId: SessionId): Promise<AcpAvailableCommand[]> {
  return invoke<AcpAvailableCommand[]>("acp_get_commands", { sessionId });
}

export interface AcpModelInfo {
  modelId: string;
  name?: string | null;
  /// Wire extras, e.g. `{ copilotUsage: "1x" }`.
  meta?: Record<string, unknown> | null;
}

export interface AcpModels {
  available: AcpModelInfo[];
  current?: string | null;
}

export async function acpGetModels(sessionId: SessionId): Promise<AcpModels> {
  return invoke<AcpModels>("acp_get_models", { sessionId });
}

export async function acpSetModel(sessionId: SessionId, modelId: string): Promise<void> {
  return invoke<void>("acp_set_model", { sessionId, modelId });
}

/// Tell the backend this session's event listener is registered — the
/// forwarder holds its first emit (e.g. a resume replay burst) until then.
export async function acpMarkReady(sessionId: SessionId): Promise<void> {
  return invoke<void>("acp_mark_ready", { sessionId });
}

/// One-shot LLM tab title from the chat transcript — same 2-word titler
/// the PTY summarizer uses. Null when no summary route is configured.
export async function acpSuggestTitle(
  sessionId: SessionId,
  transcript: string,
): Promise<string | null> {
  return invoke<string | null>("acp_suggest_title", { sessionId, transcript });
}

export async function closeAcpSession(sessionId: SessionId): Promise<void> {
  return invoke<void>("close_acp_session", { sessionId });
}

/// A pasted image riding an ACP prompt: base64 payload (no `data:` URL
/// prefix) + mime type. Backend turns it into an ACP `image` block.
export interface AcpImageAttachment {
  mimeType: string;
  data: string;
}

/// `attachments` are cwd-relative file paths (from @-mentions); the
/// backend embeds each as an ACP `resource` block alongside the text.
/// `images` are pasted screenshots/images (see AcpImageAttachment).
export async function acpSendPrompt(
  sessionId: SessionId,
  text: string,
  attachments?: string[],
  images?: AcpImageAttachment[],
): Promise<void> {
  return invoke<void>("acp_send_prompt", {
    sessionId,
    text,
    attachments: attachments ?? null,
    images: images ?? null,
  });
}

export async function acpRespondPermission(
  sessionId: SessionId,
  requestKey: string,
  optionId: string,
): Promise<void> {
  return invoke<void>("acp_respond_permission", { sessionId, requestKey, optionId });
}

export async function acpCancel(sessionId: SessionId): Promise<void> {
  return invoke<void>("acp_cancel", { sessionId });
}

/// Subscribe to an ACP tab session's event stream. Returns an unlisten fn
/// that must be called to detach. Topic: `session://{sessionId}/acp`.
export async function subscribeAcpEvents(
  sessionId: SessionId,
  handler: (ev: AcpTabEvent) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const topic = `session://${sessionId}/acp`;
  const unlisten = await listen<AcpTabEvent>(topic, (e) => handler(e.payload));
  return unlisten;
}

// ── Canon Context Miner ───────────────────────────────────────────────

export interface MinerFinding {
  category: string;
  title: string;
  bodyMd: string;
  evidence: string[];
  confidence: string;
}
export type MinerEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_start"; id: string; tool: string; arg: string }
  | { kind: "tool_result"; id: string; summary: string; ok: boolean }
  | { kind: "finding"; id: string; finding: MinerFinding }
  | { kind: "run_done"; findingsTotal: number; stopped: boolean }
  | { kind: "error"; message: string };

export async function canonMineStart(repoRoot: string, skillName: string, focus: string, thorough: boolean): Promise<string> {
  return invoke<string>("canon_mine_start", { repoRoot, skillName, focus, thorough });
}
export async function canonMineStop(runId: string): Promise<void> {
  return invoke<void>("canon_mine_stop", { runId });
}
export async function canonCompileSkill(repoRoot: string, skillName: string, findings: MinerFinding[], overwrite: boolean): Promise<string> {
  return invoke<string>("canon_compile_skill", { repoRoot, skillName, findings, overwrite });
}
export async function subscribeMinerEvents(runId: string, cb: (ev: MinerEvent) => void): Promise<UnlistenFn> {
  return listen<MinerEvent>(`canon://miner/${runId}`, (e) => cb(e.payload));
}

export interface VitalsInFlight {
  model: string;
  started_unix_ms: number;
}

export interface Vitals {
  tok_per_min: number;
  spark: number[]; // length 12, oldest→newest
  cache_hit_pct: number | null;
  last_model: string | null;
  last_latency_ms: number | null;
  in_flight: VitalsInFlight | null;
  idle_secs: number;
  is_idle: boolean;
  context_tokens: number;
  context_pct: number | null;
}

export async function getVitals(): Promise<Vitals> {
  return invoke<Vitals>("get_vitals");
}

/// Subscribe to vitals updates pushed by the backend aggregator.
/// Backend emits ~1Hz when active (in-flight or within idle window) and
/// on every call completion. Returns an unlisten fn.
export async function onVitalsUpdate(
  handler: (v: Vitals) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<Vitals>("vitals_update", (e) =>
    handler(e.payload),
  );
  return unlisten;
}

/// Subscribe to `teammate-message` events pushed by the backend when the
/// operator produces a reply. Returns an unlisten fn.
export async function onTeammateMessage(
  handler: (msg: TeammateMessage) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<TeammateMessage>("teammate-message", (e) =>
    handler(e.payload),
  );
  return unlisten;
}

export interface TeammateThreadRenamed {
  thread_id: string;
  title: string;
}

export async function onTeammateThreadRenamed(
  handler: (e: TeammateThreadRenamed) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<TeammateThreadRenamed>(
    "teammate-thread-renamed",
    (e) => handler(e.payload),
  );
  return unlisten;
}

export interface TeammateToolCall {
  operator_id: string;
  progress: {
    kind: "tool_call";
    tool: string;
    args: Record<string, unknown>;
    ok: boolean;
    error: string | null;
  };
}

export async function onTeammateToolCall(
  handler: (call: TeammateToolCall) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<TeammateToolCall>("teammate-tool-call", (e) =>
    handler(e.payload),
  );
  return unlisten;
}

export interface FileMatch {
  path: string;
  score: number;
}

export async function searchSessionFiles(
  sessionId: SessionId,
  query: string,
  limit = 8,
): Promise<FileMatch[]> {
  return invoke<FileMatch[]>("search_session_files", { sessionId, query, limit });
}

// ── Split-pane commands (D6 backend) ──────────────────────────────────────────

/// Create a second pane in `tabId` by splitting from `sourcePaneIdx`.
/// Returns the new PTY session id for the second pane.
export async function splitPane(
  tabId: string,
  orientation: "horizontal" | "vertical",
  sourcePaneIdx: 0 | 1,
): Promise<string> {
  return invoke<string>("split_pane", { tabId, orientation, sourcePaneIdx });
}

/// Close one pane of a split tab; the surviving pane fills the space.
export async function closePaneCmd(tabId: string, paneIdx: 0 | 1): Promise<void> {
  return invoke<void>("close_pane", { tabId, paneIdx });
}

/// Move keyboard + rendering focus to a pane within a split tab.
export async function focusPaneCmd(tabId: string, paneIdx: 0 | 1): Promise<void> {
  return invoke<void>("focus_pane", { tabId, paneIdx });
}

/// Swap the position of the two panes (left↔right or top↔bottom).
export async function swapPanesCmd(tabId: string): Promise<void> {
  return invoke<void>("swap_panes", { tabId });
}

/// Change the split axis without closing either pane.
export async function setPaneOrientationCmd(
  tabId: string,
  orientation: "horizontal" | "vertical",
): Promise<void> {
  return invoke<void>("set_pane_orientation", { tabId, orientation });
}

/// Resize the split; ratio is the fraction [0..1] given to pane 0.
export async function setPaneRatioCmd(tabId: string, ratio: number): Promise<void> {
  return invoke<void>("set_pane_ratio", { tabId, ratio });
}

// ---------------------------------------------------------------------------
// Internal browser API (experimental.internal_browser flag)
// ---------------------------------------------------------------------------

export interface BrowserBounds { x: number; y: number; width: number; height: number; }
export interface BrowserNav {
  url: string; title: string;
  canGoBack: boolean; canGoForward: boolean; loading: boolean;
}

export const browser = {
  open: (tabId: string, url: string, bounds: BrowserBounds) =>
    invoke<void>("browser_open", { tabId, url, bounds }),
  navigate: (tabId: string, url: string) => invoke<void>("browser_navigate", { tabId, url }),
  back: (tabId: string) => invoke<void>("browser_back", { tabId }),
  forward: (tabId: string) => invoke<void>("browser_forward", { tabId }),
  reload: (tabId: string) => invoke<void>("browser_reload", { tabId }),
  setBounds: (tabId: string, bounds: BrowserBounds) => invoke<void>("browser_set_bounds", { tabId, bounds }),
  show: (tabId: string) => invoke<void>("browser_show", { tabId }),
  hide: (tabId: string) => invoke<void>("browser_hide", { tabId }),
  /// PNG data URL of the webview's current frame (macOS only; rejects elsewhere).
  snapshot: (tabId: string) => invoke<string>("browser_snapshot", { tabId }),
  close: (tabId: string) => invoke<void>("browser_close", { tabId }),
  onNav: (tabId: string, cb: (n: BrowserNav) => void) =>
    listen<{ url: string; title: string; can_go_back: boolean; can_go_forward: boolean; loading: boolean }>(
      `browser://${tabId}/nav`,
      (e) => cb({
        url: e.payload.url, title: e.payload.title,
        canGoBack: e.payload.can_go_back, canGoForward: e.payload.can_go_forward,
        loading: e.payload.loading,
      }),
    ),
};

/** A node in the browser favorites tree. Mirrors `store::FavNode` (Rust). */
export interface FavNode {
  id: string;
  parent_id: string | null;
  kind: "folder" | "link";
  title: string;
  url: string | null;
  position: number;
  collapsed: boolean;
  created_at: number;
  children: FavNode[];
}

export const favorites = {
  tree: () => invoke<FavNode[]>("favorites_tree"),
  add: (parentId: string | null, kind: "folder" | "link", title: string, url: string | null) =>
    invoke<FavNode>("favorites_add", { parentId, kind, title, url }),
  rename: (id: string, title: string) => invoke<void>("favorites_rename", { id, title }),
  move: (
    id: string,
    newParentId: string | null,
    afterId: string | null,
    beforeId: string | null,
  ) => invoke<void>("favorites_move", { id, newParentId, afterId, beforeId }),
  delete: (id: string) => invoke<void>("favorites_delete", { id }),
  setCollapsed: (id: string, collapsed: boolean) =>
    invoke<void>("favorites_set_collapsed", { id, collapsed }),
};

export interface CloudSyncConfig {
  enabled: boolean;
  workspaces: boolean;
  operators: boolean;
  specs: boolean;
  preferences: boolean;
}

export interface CloudSyncStatus extends CloudSyncConfig {
  signed_in: boolean;
  last_synced_ms: number | null;
  device: string | null;
}

export interface CloudApplySummary {
  workspaces: boolean;
  operators: number;
  specs: number;
  preferences: boolean;
  skipped: number;
}

export async function cloudSyncStatus(): Promise<CloudSyncStatus> {
  return invoke<CloudSyncStatus>("cloud_sync_status");
}

export async function cloudSyncSetConfig(cfg: CloudSyncConfig): Promise<void> {
  return invoke<void>("cloud_sync_set_config", { cfg });
}

export async function cloudSyncPush(): Promise<number> {
  return invoke<number>("cloud_sync_push");
}

export async function cloudSyncRestore(): Promise<CloudApplySummary> {
  return invoke<CloudApplySummary>("cloud_sync_restore");
}

export async function cloudSyncWipe(): Promise<void> {
  return invoke<void>("cloud_sync_wipe");
}

// ---- LSP ------------------------------------------------------------

/// Present only for npm-method servers (e.g. TypeScript) whose runtime
/// dependency (node) is missing or too old. `found` is `null` when the
/// runtime binary wasn't found at all, a version string when it was found
/// but failed the minimum-version check.
export type LspRuntimeSuggestion =
  | { kind: "on_disk_not_on_path"; version: string; dir: string }
  | { kind: "install"; hint: string };

export interface LspRuntimeMissing {
  name: string;
  min: string;
  found: string | null;
  suggestion: LspRuntimeSuggestion | null;
}

export interface LspServerStatus {
  language: string;
  name: string;
  version: string;
  installed: boolean;
  approxSizeMb: number;
  runtimeMissing?: LspRuntimeMissing | null;
}

export interface LspStartResult {
  serverId: number;
  root: string;
  /// Absolute path to the workspace's `.sln` (falling back to its first
  /// `.csproj`), populated only for languages whose server needs a
  /// post-initialize project-load handshake (currently csharp/Roslyn).
  /// `null` for every other language.
  solutionPath?: string | null;
  /// Which handshake `solutionPath` needs: `"solution"` for a `.sln`/
  /// `.slnx` (send `solution/open`), `"project"` for a bare `.csproj` with
  /// no solution file (send `project/open` — `solution/open` silently
  /// loads nothing for a csproj-only root, verified empirically). `null`
  /// iff `solutionPath` is `null`.
  solutionKind?: string | null;
}

export async function lspServerStatus(language: string): Promise<LspServerStatus> {
  const raw = await invoke<{
    language: string;
    name: string;
    version: string;
    installed: boolean;
    approx_size_mb: number;
    runtime_missing?: {
      name: string;
      min: string;
      found?: string | null;
      suggestion?: LspRuntimeSuggestion | null;
    } | null;
  }>("lsp_server_status", { language });
  return {
    language: raw.language,
    name: raw.name,
    version: raw.version,
    installed: raw.installed,
    approxSizeMb: raw.approx_size_mb,
    runtimeMissing: raw.runtime_missing
      ? {
          name: raw.runtime_missing.name,
          min: raw.runtime_missing.min,
          found: raw.runtime_missing.found ?? null,
          suggestion: raw.runtime_missing.suggestion ?? null,
        }
      : null,
  };
}

export async function lspDownloadServer(language: string): Promise<void> {
  await invoke<void>("lsp_download_server", { language });
}

export async function lspStart(language: string, filePath: string): Promise<LspStartResult> {
  const raw = await invoke<{
    server_id: number;
    root: string;
    solution_path?: string | null;
    solution_kind?: string | null;
  }>("lsp_start", { language, filePath });
  return {
    serverId: raw.server_id,
    root: raw.root,
    solutionPath: raw.solution_path ?? null,
    solutionKind: raw.solution_kind ?? null,
  };
}

export async function lspSend(serverId: number, message: string): Promise<void> {
  await invoke<void>("lsp_send", { serverId, message });
}

export async function lspStop(serverId: number): Promise<void> {
  await invoke<void>("lsp_stop", { serverId });
}

export interface LspInstalledServer {
  language: string;
  name: string;
  version: string;
  sizeBytes: number;
  installed: boolean;
}

export async function lspListInstalled(): Promise<LspInstalledServer[]> {
  const raw = await invoke<Array<{
    language: string; name: string; version: string; size_bytes: number; installed: boolean;
  }>>("lsp_list_installed");
  return raw.map((s) => ({
    language: s.language,
    name: s.name,
    version: s.version,
    sizeBytes: s.size_bytes,
    installed: s.installed,
  }));
}

export async function lspDeleteServer(language: string): Promise<void> {
  await invoke<void>("lsp_delete_server", { language });
}
