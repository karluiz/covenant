// AcpChatView — Copilot ACP tab body (A2).
//
// Replaces xterm.js in the tab slot for ACP sessions. Subscribes to the
// session's `session://{id}/acp` event stream, renders the streamed agent
// output as a structured chat log — prose bubbles, tool-call cards (diffs,
// shell output + exit chips), and interactive permission cards — instead
// of raw shell bytes.
//
// Architecture: all stream-shaping logic lives in the exported, DOM-free
// `reduceAcpEvent` reducer (+ `markPermAnswered` helper) so it's unit
// testable without a document. `AcpChatView` is a thin incremental
// renderer on top: it owns one `AcpStreamState`, feeds every inbound
// event through the reducer, then patches only the DOM node(s) the event
// actually touched (tool cards update in place via `tools`/`toolDoms`
// maps; a run of same-role prose chunks updates one growing `<div>`
// rather than appending a new one per delta).

import type {
  AcpAvailableCommand,
  AcpContentBlock,
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpSessionUpdate,
  AcpTabEvent,
  AcpToolCallFields,
  AcpTrust,
  SessionId,
} from "../../api";
import {
  acpCancel,
  acpGetCommands,
  acpGetModels,
  acpListSessions,
  acpLoadSession,
  acpMarkReady,
  acpRespondPermission,
  acpSendPrompt,
  acpSetModel,
  acpSetTrust,
  acpSuggestTitle,
  closeAcpSession,
  spawnAcpSession,
  structureListDir,
  subscribeAcpEvents,
} from "../../api";
import type {
  AcpExecutor,
  AcpImageAttachment,
  AcpModelInfo,
  AcpSessionListing,
  DirEntry,
} from "../../api";
import { openUrl } from "@tauri-apps/plugin-opener";
import { brandIconSvg } from "../../icons/brands";
import { Icons } from "../../icons";
import { attachTooltip } from "../../tooltip/tooltip";
import { renderMarkdown } from "../../ui/markdown";

/// Coarse relative time for the /resume picker ("3h ago", "2d ago").
/// Exported for tests.
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/// A resume title is junk when it's empty or just a bare slash-command
/// (`/model`, `/respawn`) — the agent titles a session off its first user
/// message, so sessions opened only to switch a setting surface as noise.
/// Exported for tests.
export function isJunkResumeTitle(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  return t.length === 0 || /^\/[\w-]+$/.test(t);
}

/// Quick-view lightbox for a pasted image. One at a time — opening
/// replaces any existing overlay. Dismiss: click anywhere or Escape.
function openImagePreview(dataUrl: string): void {
  document.querySelector(".acp-image-preview-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "acp-image-preview-overlay";
  const img = document.createElement("img");
  img.src = dataUrl;
  img.alt = "Pasted image preview";
  overlay.appendChild(img);
  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

/// YOU-bubble content: prompt text plus a thumbnail per attached image
/// (click → the same lightbox as the composer chips).
function buildUserContent(text: string, images: AcpImageAttachment[]): HTMLElement {
  const content = document.createElement("div");
  content.className = "acp-msg-content";
  if (text) {
    const t = document.createElement("div");
    t.textContent = text;
    content.appendChild(t);
  }
  if (images.length > 0) {
    const grid = document.createElement("div");
    grid.className = "acp-msg-images";
    for (const img of images) {
      const dataUrl = `data:${img.mimeType};base64,${img.data}`;
      const thumb = document.createElement("img");
      thumb.className = "acp-msg-image-thumb";
      thumb.src = dataUrl;
      thumb.alt = "Attached image";
      thumb.addEventListener("click", () => openImagePreview(dataUrl));
      grid.appendChild(thumb);
    }
    content.appendChild(grid);
  }
  return content;
}

/// Per-executor branding for the chat chrome. `cmdline` is what the
/// empty-state shows as "your prompt goes to …".
const EXECUTOR_BRAND: Record<AcpExecutor, { title: string; longName: string; cmdline: string; roleLabel: string }> = {
  copilot: {
    title: "Copilot",
    longName: "GitHub Copilot's coding agent",
    cmdline: "copilot --acp",
    roleLabel: "copilot",
  },
  pi: {
    title: "pi",
    longName: "the pi coding agent (via the pi-acp adapter)",
    cmdline: "pi-acp",
    roleLabel: "pi",
  },
  claude: {
    title: "Claude",
    longName: "Claude Code's agent (via the official claude-agent-acp adapter)",
    cmdline: "claude-agent-acp",
    roleLabel: "claude",
  },
  opencode: {
    title: "OpenCode",
    longName: "OpenCode's coding agent (first-party ACP server)",
    cmdline: "opencode acp",
    roleLabel: "opencode",
  },
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// -----------------------------------------------------------------------
// Pure stream model — reducer + item types. No DOM. See view.test.ts.
// -----------------------------------------------------------------------

export interface AcpUserItem {
  kind: "user";
  text: string;
  /// Images attached when the prompt was sent this session. Absent on
  /// replayed transcripts (the wire replay doesn't carry image data).
  images?: AcpImageAttachment[];
}

export interface AcpProseItem {
  kind: "prose";
  role: "assistant" | "thought";
  text: string;
}

export interface AcpToolItem {
  kind: "tool";
  toolCallId: string;
  /// Merged fields across `tool_call` + any `tool_call_update`s — same
  /// merge semantics as `merge_tool` in `crates/agent/src/acp/run.rs`
  /// (later non-empty value wins, per field).
  fields: AcpToolCallFields;
}

export interface AcpPermItem {
  kind: "perm";
  requestKey: string;
  request: AcpPermissionRequest;
  /// Set once the user answers (by `markPermAnswered`). A one-line
  /// human-readable record, e.g. "Allowed once · `git push`".
  answered?: string;
}

export interface AcpNoticeItem {
  kind: "notice";
  text: string;
  /// "divider": thin turn-end marker (from `prompt_done`).
  /// "dead": the ACP process died — the view renders a restart affordance.
  /// "info" / "error": free-form system notes (subscribe/send failures).
  /// "perception": an auto-answered permission prompt audit note (from
  /// `perception_auto_answer`) — muted/secondary, distinct from a human
  /// answer on a `perm` card.
  variant: "divider" | "dead" | "info" | "error" | "perception";
}

export type AcpStreamItem = AcpUserItem | AcpProseItem | AcpToolItem | AcpPermItem | AcpNoticeItem;

export interface AcpStreamState {
  items: AcpStreamItem[];
  tools: Map<string, AcpToolItem>;
  pendingPerms: Map<string, AcpPermItem>;
  inFlight: boolean;
  /// Latest slash-command roster from `available_commands_update` —
  /// replaced wholesale on every update (the wire sends the full list).
  commands: AcpAvailableCommand[];
  /// Whether any agent output (message/thought chunk or tool call)
  /// arrived since the last user send. A `prompt_done` with this still
  /// false is a silently-failed turn (e.g. a broken provider behind
  /// pi-acp reports a clean empty end_turn) — surfaced as a notice
  /// instead of pure silence. Reset by the view on each send.
  turnHadOutput: boolean;
  /// Set once any tool update in the session carries a typed
  /// `shell_exit`. Only after that does a completed execute WITHOUT one
  /// mean "the adapter left the console running" — for adapters that
  /// never emit `shell_exit`, absence carries no signal and no execute
  /// is ever flagged as a background console.
  sawShellExit: boolean;
}

export function createAcpStreamState(): AcpStreamState {
  return {
    items: [],
    tools: new Map(),
    pendingPerms: new Map(),
    inFlight: false,
    commands: [],
    turnHadOutput: false,
    sawShellExit: false,
  };
}

/// The trailing `@fragment` immediately before the caret, if any —
/// `start` is the index of the `@` itself. Fragments may contain `/`
/// (nested paths) but never whitespace or a second `@`.
export interface MentionFragment {
  start: number;
  fragment: string;
}

export function mentionFragmentAt(value: string, caret: number): MentionFragment | null {
  const upTo = value.slice(0, caret);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(upTo);
  if (!m) return null;
  return { start: caret - m[1].length - 1, fragment: m[1] };
}

/// Prefix-filter the slash roster against the composer's current `/token`.
/// `input` is the full composer value; returns [] unless the value is a
/// single leading slash-token (commands are only recognized there).
export function filterSlashCommands(
  commands: AcpAvailableCommand[],
  input: string,
): AcpAvailableCommand[] {
  const m = /^\/(\S*)$/.exec(input);
  if (!m) return [];
  const prefix = m[1].toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(prefix));
}

/// Best-effort plain text out of a content block: direct `text`, or the
/// nested `{content:{text}}` shape some ACP agents emit. Diff blocks
/// (`{path, newText}`) return `null` — those render in the tool card's
/// diff view, not as prose. Mirrors `ContentBlock::as_text` in
/// `crates/agent/src/acp/protocol.rs`.
function contentText(block: AcpContentBlock): string | null {
  const b = block as { text?: unknown; path?: unknown; content?: { text?: unknown } };
  if (typeof b.text === "string") return b.text;
  if (typeof b.path === "string") return null;
  if (b.content && typeof b.content.text === "string") return b.content.text;
  return null;
}

/// Appends `text` to the state's trailing prose item if it's the same
/// role, else starts a new one. Because this only ever looks at
/// `items[items.length - 1]`, any other item type appended in between
/// (a tool card, a user bubble, a permission card) naturally forces the
/// next chunk to start a fresh item at the correct chronological
/// position — no separate "current turn" cursor needed.
function appendProse(state: AcpStreamState, role: "assistant" | "thought", text: string | null): void {
  if (text === null || text.length === 0) return;
  const last = state.items[state.items.length - 1];
  if (last && last.kind === "prose" && last.role === role) {
    last.text += text;
    return;
  }
  state.items.push({ kind: "prose", role, text });
}

function isToolUpdate(u: AcpSessionUpdate): u is Extract<AcpSessionUpdate, { toolCallId: string }> {
  return "toolCallId" in u;
}

/// Replayed user chunks that are really executor-harness bookkeeping
/// (slash-command records, background-task notifications, context
/// reminders), not typed prompts. Exported for tests.
export function isCommandNoise(text: string): boolean {
  return /^<(command-name|command-message|command-args|local-command-stdout|task-notification|system-reminder)\b/.test(
    text.trimStart(),
  );
}

/// Tool results arrive from the claude adapter as markdown with ``` fences,
/// but tool-card bodies render into a monospace <pre> — the fence lines are
/// pure noise there. Drop lines that are only a fence (with optional lang
/// tag); everything else stays verbatim. Exported for tests.
export function stripFences(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*```[\w-]*\s*$/.test(line))
    .join("\n");
}

/// Persisted per-executor model preference — agents reset to their own
/// default on every spawn, so the last explicit pick is re-applied
/// post-handshake (see `applyPreferredModel`).
function modelPrefKey(executor: AcpExecutor): string {
  return `covenant.acp-model.${executor}`;
}

function preferredModel(executor: AcpExecutor): string | null {
  try {
    return localStorage.getItem(modelPrefKey(executor));
  } catch {
    return null;
  }
}

function persistPreferredModel(executor: AcpExecutor, modelId: string): void {
  try {
    localStorage.setItem(modelPrefKey(executor), modelId);
  } catch {
    /* preference simply won't persist */
  }
}

/// Derive a tab title from the first real user prompt: first non-empty
/// line, hard-capped. Returns null for slash commands and harness noise.
/// Exported for tests.
export function titleFromPrompt(text: string): string | null {
  const t = text.trim();
  if (t.length === 0 || t.startsWith("/") || isCommandNoise(t)) return null;
  const line = t.split("\n", 1)[0].trim();
  if (line.length === 0) return null;
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

/// Later non-empty field wins. Identical semantics to `merge_tool` in
/// `crates/agent/src/acp/run.rs`: `null`/`undefined` on the incoming frame
/// means "unchanged", not "clear the field" (tool_call_update frames omit
/// fields that haven't changed since the initial tool_call).
function mergeToolFields(existing: AcpToolCallFields, incoming: AcpToolCallFields): void {
  if (incoming.title != null) existing.title = incoming.title;
  if (incoming.kind != null) existing.kind = incoming.kind;
  if (incoming.status != null) existing.status = incoming.status;
  if (incoming.rawInput != null) existing.rawInput = incoming.rawInput;
  if (incoming.rawOutput != null) existing.rawOutput = incoming.rawOutput;
  if (incoming.content.length > 0) existing.content = incoming.content;
}

function upsertTool(state: AcpStreamState, f: AcpToolCallFields): void {
  const existing = state.tools.get(f.toolCallId);
  if (!existing) {
    const item: AcpToolItem = { kind: "tool", toolCallId: f.toolCallId, fields: f };
    state.items.push(item);
    state.tools.set(f.toolCallId, item);
    return;
  }
  mergeToolFields(existing.fields, f);
}

/// Mutates `state` in place to reflect one event from the ACP tab
/// session's event stream. Pure aside from that mutation — no DOM, no
/// I/O — so the stream-shaping contract (chunk accumulation, tool merge
/// semantics, permission bookkeeping, turn/session lifecycle) is testable
/// on its own.
export function reduceAcpEvent(state: AcpStreamState, ev: AcpTabEvent): void {
  switch (ev.type) {
    case "update": {
      const u = ev.update.update;
      // `AcpSessionUpdate`'s catch-all member (`{ sessionUpdate: string }`,
      // for future/unrecognized wire kinds) has a plain `string` in the
      // discriminant, so `===` narrowing alone doesn't exclude it — pair
      // it with an `in` check on the field only the real variant has.
      if (u.sessionUpdate === "agent_message_chunk" && "content" in u) {
        state.turnHadOutput = true;
        appendProse(state, "assistant", contentText(u.content));
      } else if (u.sessionUpdate === "agent_thought_chunk" && "content" in u) {
        state.turnHadOutput = true;
        appendProse(state, "thought", contentText(u.content));
      } else if (u.sessionUpdate === "user_message_chunk" && "content" in u) {
        // Only emitted during a session/load replay — live prompts never
        // echo the user's message back (verified against copilot 1.0.68),
        // so this can't double-render the locally-appended user bubble.
        // Merge consecutive chunks into the trailing user item, mirroring
        // appendProse (copilot replays one coalesced chunk per message).
        const text = contentText(u.content);
        // Claude Code transcripts store slash-command bookkeeping as user
        // text (`<command-name>/model</command-name>`, `<local-command-
        // stdout>…`); claude-agent-acp replays them verbatim (seen live).
        // They're harness records, not something the user typed — drop.
        if (text && isCommandNoise(text)) break;
        if (text) {
          const last = state.items[state.items.length - 1];
          if (last && last.kind === "user") last.text += text;
          else state.items.push({ kind: "user", text });
        }
      } else if (isToolUpdate(u)) {
        state.turnHadOutput = true;
        if (exitCodeOf(u.rawOutput) !== null || textExitCodeOf(u.content) !== null) {
          state.sawShellExit = true;
        }
        upsertTool(state, {
          toolCallId: u.toolCallId,
          title: u.title,
          kind: u.kind,
          status: u.status,
          rawInput: u.rawInput,
          rawOutput: u.rawOutput,
          content: u.content,
        });
      } else if (u.sessionUpdate === "available_commands_update" && "availableCommands" in u) {
        state.commands = u.availableCommands;
      }
      // Unrecognized/future `sessionUpdate` kinds are ignored — the
      // protocol is public preview (see protocol.rs's `Unknown` catch-all).
      break;
    }
    case "permission_pending": {
      // A replayed/duplicate frame for a request that's already pending
      // must not spawn a second card — first one wins.
      if (state.pendingPerms.has(ev.requestKey)) return;
      const item: AcpPermItem = { kind: "perm", requestKey: ev.requestKey, request: ev.request };
      state.items.push(item);
      state.pendingPerms.set(ev.requestKey, item);
      break;
    }
    case "prompt_done": {
      state.inFlight = false;
      // end_turn is the boring, expected outcome — a loud divider per
      // turn is noise. Only surface stop reasons that carry information
      // (timeout, cancelled, refusal, max_tokens, errors).
      if (ev.stopReason !== "end_turn") {
        state.items.push({ kind: "notice", text: `Turn finished — ${ev.stopReason}`, variant: "divider" });
      } else if (!state.turnHadOutput) {
        // Clean end_turn with zero output = a provider failing silently
        // behind the adapter (seen live: pi + a broken cf-gateway model).
        state.items.push({
          kind: "notice",
          text: "The agent returned no output for this turn — the selected model/provider may be failing. Try switching models (/model).",
          variant: "error",
        });
      }
      break;
    }
    case "session_dead": {
      state.inFlight = false;
      // Executor-neutral: this view now fronts copilot AND pi (pi-acp).
      state.items.push({
        kind: "notice",
        text: "Agent process exited. Restart to continue.",
        variant: "dead",
      });
      break;
    }
    case "perception_auto_answer": {
      // No `permission_pending` was ever forwarded for this request (see
      // `crates/app/src/acp_commands.rs`) — this is the only trace of the
      // prompt in the UI, so it always appends a fresh audit note rather
      // than updating an existing `perm` card.
      state.items.push({
        kind: "notice",
        text: perceptionAuditText(ev.optionId, ev.reason),
        variant: "perception",
      });
      break;
    }
  }
}

/// Formats the inline audit note for an auto-answered permission prompt.
/// Exported for unit testing.
export function perceptionAuditText(optionId: string, reason: string): string {
  return `Perception ✓ auto-answered: ${optionId} — ${reason}`;
}

/// Records the user's answer on a pending permission item and drops it
/// from `pendingPerms` (it stays in `items` as an answered record). Not
/// wire-driven — the view calls this optimistically right after the user
/// clicks an option, before `acpRespondPermission` resolves.
export function markPermAnswered(state: AcpStreamState, requestKey: string, label: string): void {
  const item = state.pendingPerms.get(requestKey);
  if (!item) return;
  item.answered = label;
  state.pendingPerms.delete(requestKey);
}

// -----------------------------------------------------------------------
// View
// -----------------------------------------------------------------------

export interface AcpChatViewOptions {
  /// The Covenant SessionId returned by `spawnAcpSession`. All event
  /// subscription + commands key off this id (reassigned on restart).
  sessionId: SessionId;
  /// Element the view will fill. Caller owns sizing/positioning; the view
  /// applies its own internal flex layout.
  host: HTMLElement;
  /// Fired when the user clicks the close affordance. Callers typically
  /// remove the tab here.
  onClose?: () => void;
  /// Current model id reported by the ACP handshake (e.g.
  /// "claude-sonnet-4.6"). Shown in the header meta; null hides it.
  model?: string | null;
  /// Working directory of the ACP session. Threaded through to
  /// `spawnAcpSession` on restart.
  cwd?: string | null;
  /// Which agent drives this tab ("copilot" default). Controls branding
  /// (header, empty state, composer) and — critically — which agent
  /// `restart()` respawns.
  executor?: AcpExecutor;
  /// Wire-level ACP sessionId from the spawn. `restart()` passes it as
  /// `resumeAcpSessionId` so a crashed agent comes back with its
  /// transcript, and reports the (possibly new) id via `onSessionChange`.
  acpSessionId?: string | null;
  /// Trust level the session launched with (from `SpawnAcpResult.trust`).
  /// Defaults to "balanced" — the chip only ever changes the LIVE session
  /// via `acpSetTrust`; it never touches the executor's stored config.
  trust?: AcpTrust;
  /// Fired when `restart()` adopts a fresh session, so the owner (tab
  /// manager) can re-point pane.sessionId / pane.acpSessionId and persist.
  onSessionChange?: (sessionId: SessionId, acpSessionId: string) => void;
  /// Fired once per view with a tab title derived from the first real
  /// user prompt (typed or replayed) — ACP tabs have no PTY, so the
  /// screen-based summarizer titler never sees them.
  onTitle?: (title: string) => void;
  /// Fired by the `/rename <name>` composer command. Owner sets the tab's
  /// authoritative customName (unlike onTitle, which is the auto-derived
  /// defaultTitle the titler can still overwrite).
  onRename?: (name: string) => void;
}

interface ToolCardDom {
  root: HTMLElement;
  chipEl: HTMLElement;
  dotEl: HTMLElement;
  titleEl: HTMLElement;
  exitEl: HTMLElement;
  toggleEl: HTMLElement;
  bodyEl: HTMLElement;
}

interface PermCardDom {
  root: HTMLElement;
  waitingEl: HTMLElement;
  optionsEl: HTMLElement;
  recordEl: HTMLElement;
}

/// Public surface kept narrow: mount on construction, [`destroy`] to
/// unmount + unsubscribe. No imperative re-render entry — the view drives
/// itself off events (mirrors `PiChatView`).
export class AcpChatView {
  private readonly host: HTMLElement;
  private sessionId: SessionId;
  private readonly onCloseCb?: () => void;
  private readonly cwd: string | null;
  private model: string | null;
  private metaEl!: HTMLElement;
  private modelChipEl!: HTMLButtonElement;
  private modelMenuEl!: HTMLElement;
  private models: AcpModelInfo[] = [];
  private trustChipEl!: HTMLButtonElement;
  private trustMenuEl!: HTMLElement;
  private resumeMenuEl!: HTMLElement;
  /// Live trust for THIS session only — switching calls `acpSetTrust`, it
  /// never writes back to the executor's stored config. New tabs still
  /// inherit the executor's configured default via `SpawnAcpResult.trust`.
  private trust: AcpTrust;
  private static readonly TRUST_LABELS: Record<AcpTrust, string> = {
    ask: "ASK",
    balanced: "BALANCED",
    yolo: "YOLO",
  };
  private readonly closeModelMenuOnOutsideClick = (e: MouseEvent): void => {
    if (e.target instanceof Node && this.modelMenuEl.contains(e.target)) return;
    if (e.target instanceof Node && this.modelChipEl.contains(e.target)) return;
    if (e.target instanceof Node && this.trustMenuEl.contains(e.target)) return;
    if (e.target instanceof Node && this.trustChipEl.contains(e.target)) return;
    this.closeModelMenu();
    this.closeTrustMenu();
  };
  private readonly closeResumeMenuOnOutsideClick = (e: MouseEvent): void => {
    if (e.target instanceof Node && this.resumeMenuEl.contains(e.target)) return;
    this.closeResumeMenu();
  };

  private readonly state: AcpStreamState = createAcpStreamState();
  private unlisten: (() => void) | null = null;
  private destroyed = false;
  private readonly executor: AcpExecutor;
  private acpSessionId: string | null;
  private readonly onSessionChange?: (sessionId: SessionId, acpSessionId: string) => void;
  private readonly onTitle?: (title: string) => void;
  private readonly onRename?: (name: string) => void;
  /// One title per view — first real user prompt wins.
  private titleSent = false;
  /// Set once an LLM-generated title actually lands. Until then the tab
  /// shows the truncated-prompt fallback, and `prompt_done` retries the
  /// titler with the full transcript (mirrors the PTY screen titler, which
  /// names the tab from the agent's output rather than the bare prompt).
  private llmTitled = false;
  /// Images pasted into the composer, sent as ACP `image` blocks with
  /// the next prompt and cleared. Rendered as removable chips.
  private pendingImages: AcpImageAttachment[] = [];
  private imageStripEl!: HTMLElement;

  private statusEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private jumpBtn!: HTMLButtonElement;

  private readonly toolDoms: Map<string, ToolCardDom> = new Map();
  private liveStripEl: HTMLElement | null = null;
  /// toolCallId → when the console was first seen running in background
  /// (for the strip's age readout). Membership itself derives from
  /// `state.tools` on every strip render.
  private readonly bgSince: Map<string, number> = new Map();
  private liveStripTimer: number | null = null;
  private readonly permDoms: Map<string, PermCardDom> = new Map();

  private slashEl!: HTMLElement;
  private slashItems: AcpAvailableCommand[] = [];
  private slashSel = 0;

  private mentionEl!: HTMLElement;
  private mentionItems: DirEntry[] = [];
  private mentionSel = 0;
  private mentionFrag: MentionFragment | null = null;
  /// cwd-relative paths picked via @-mention; filtered against the final
  /// text on send (deleting the token drops the attachment).
  private readonly mentions: Set<string> = new Set();
  /// Monotonic token so a slow structureListDir can't clobber a newer one.
  private mentionListToken = 0;
  /// The DOM node backing the trailing prose item, if any — kept in sync
  /// with `state.items[items.length - 1]` by identity so a run of
  /// same-role chunks updates one node instead of appending N.
  private lastProseItem: AcpProseItem | null = null;
  private lastProseEl: HTMLElement | null = null;
  /// Same pattern for replayed user bubbles (`user_message_chunk`).
  private lastUserItem: AcpUserItem | null = null;
  private lastUserEl: HTMLElement | null = null;

  private stickToBottom = true;
  /// Last observed scrollTop — lets the scroll handler tell an upward
  /// (user) scroll from a downward/programmatic one. See
  /// [`resolveStickToBottom`].
  private lastScrollTop = 0;
  /// Timestamp of the last programmatic "jump to bottom" — wheel/scroll
  /// events within a short window after this are residual momentum from
  /// the jump and must not break `stickToBottom`.
  private jumpedAt = 0;

  constructor(opts: AcpChatViewOptions) {
    this.host = opts.host;
    this.sessionId = opts.sessionId;
    this.onCloseCb = opts.onClose;
    this.cwd = opts.cwd ?? null;
    this.model = opts.model ?? null;
    this.executor = opts.executor ?? "copilot";
    this.acpSessionId = opts.acpSessionId ?? null;
    this.trust = opts.trust ?? "balanced";
    this.onSessionChange = opts.onSessionChange;
    this.onTitle = opts.onTitle;
    this.onRename = opts.onRename;
    this.mount();
    void this.subscribe();
  }

  /// Tear down DOM + event subscription. Idempotent.
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.liveStripTimer !== null) {
      window.clearInterval(this.liveStripTimer);
      this.liveStripTimer = null;
    }
    document.removeEventListener("mousedown", this.closeModelMenuOnOutsideClick);
    document.removeEventListener("mousedown", this.closeResumeMenuOnOutsideClick);
    if (this.unlisten) {
      try {
        this.unlisten();
      } catch {
        /* listener already gone */
      }
      this.unlisten = null;
    }
    this.host.innerHTML = "";
    this.host.classList.remove("acp-chat-view");
  }

  /// Convenience for callers that own tab lifecycle: tears down the view
  /// AND tells the backend to close the underlying session. Use this
  /// when the tab is being permanently removed; use [`destroy`] when the
  /// session is being kept alive but the view is just being unmounted.
  async closeSession(): Promise<void> {
    this.destroy();
    try {
      await closeAcpSession(this.sessionId);
    } catch {
      /* already gone */
    }
    this.onCloseCb?.();
  }

  focusComposer(): void {
    this.inputEl?.focus();
  }

  /// Put text in the composer for review (pane-menu Commands semantics —
  /// the user reads it, then hits ↩).
  insertText(text: string): void {
    this.inputEl.value = text;
    this.syncComposer();
    this.inputEl.focus();
  }

  /// Put text in the composer and submit it (pane-menu Prompts/Skills
  /// semantics). If a turn is already in flight, handleSend no-ops and
  /// the text stays staged in the composer.
  submitText(text: string): void {
    this.inputEl.value = text;
    this.syncComposer();
    this.inputEl.focus();
    void this.handleSend();
  }

  // -------------------------------------------------------------------------
  // Mount
  // -------------------------------------------------------------------------

  private mount(): void {
    const brand = EXECUTOR_BRAND[this.executor];
    const logo = brandIconSvg(this.executor, 16) ?? "◈";
    this.host.classList.add("acp-chat-view");
    this.host.innerHTML = `
      <div class="acp-chat-header">
        <span class="acp-chat-logo" aria-hidden="true">${logo}</span>
        <span class="acp-chat-title">${brand.title}</span>
        <button type="button" class="acp-model-chip" hidden></button>
        <button type="button" class="acp-trust-chip"></button>
        <span class="acp-chat-meta"></span>
        <span class="acp-chat-status" data-state="idle" aria-live="polite">idle</span>
        <div class="acp-model-menu" role="listbox" hidden></div>
        <div class="acp-trust-menu" role="listbox" hidden></div>
      </div>
      <div class="acp-chat-messages" role="log" aria-live="polite">
        <div class="acp-chat-empty" role="note">
          <p class="acp-empty-kicker">${brand.title} · ACP session</p>
          <h3>${brand.title} panel, not a terminal</h3>
          <p>This is a structured chat session with ${brand.longName}. Your prompt goes to <code>${brand.cmdline}</code>; Covenant renders replies, tool runs, and permission requests as chat UI instead of raw shell output.</p>
          <ul>
            <li><span class="acp-empty-ic" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="2.5" y="2.5" width="11" height="11" stroke="currentColor" stroke-width="1.3"/><path d="M5 6h6M5 8.5h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span>Tool calls that edit files or run shell commands show up as cards you can inspect.</li>
            <li><span class="acp-empty-ic" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M8 2 3 4.2v3.4c0 3 2.1 5.2 5 6.4 2.9-1.2 5-3.4 5-6.4V4.2L8 2Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></span>When ${brand.title} needs permission to act, you'll see a card with the wire's own options.</li>
            <li><span class="acp-empty-ic" aria-hidden="true"><svg width="15" height="15" viewBox="0 0 16 16" fill="none"><path d="M2 5.5 8 9l6-3.5M2 5.5 8 2l6 3.5M2 5.5v5L8 14l6-3.5v-5" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></span>Press <kbd>↩</kbd> to send; <kbd>⇧↩</kbd> for a new line.</li>
          </ul>
        </div>
      </div>
      <div class="acp-live-strip" hidden></div>
      <form class="acp-chat-input" autocomplete="off">
        <div class="acp-slash-menu" role="listbox" hidden></div>
        <div class="acp-slash-menu acp-mention-menu" role="listbox" hidden></div>
        <div class="acp-resume-menu" role="listbox" hidden></div>
        <div class="acp-image-strip" hidden></div>
        <button type="button" class="acp-jump-present" hidden>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M8 13l4.5-4.5M8 13 3.5 8.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Jump to present
        </button>
        <div class="acp-composer">
          <textarea
            class="acp-chat-textarea"
            rows="1"
            placeholder="Message ${brand.title}…"
            aria-label="Message ${brand.title}"
          ></textarea>
          <div class="acp-chat-actions">
            <span class="acp-composer-hint"><kbd>↩</kbd> send · <kbd>⇧↩</kbd> newline</span>
            <button type="button" class="acp-chat-cancel" hidden aria-label="Stop" title="Stop">
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect width="10" height="10" rx="2" fill="currentColor"/></svg>
            </button>
            <button type="submit" class="acp-chat-send" disabled aria-label="Send" title="Send">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 13V3M8 3 3.5 7.5M8 3l4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>
      </form>
    `;
    this.statusEl = requireChild(this.host, ".acp-chat-status");
    this.metaEl = requireChild(this.host, ".acp-chat-meta");
    this.modelChipEl = requireChild(this.host, ".acp-model-chip") as HTMLButtonElement;
    this.modelMenuEl = requireChild(this.host, ".acp-model-menu");
    this.modelChipEl.addEventListener("click", () => {
      if (this.modelMenuEl.hidden) this.openModelMenu();
      else this.closeModelMenu();
    });
    this.resumeMenuEl = requireChild(this.host, ".acp-resume-menu");
    this.trustChipEl = requireChild(this.host, ".acp-trust-chip") as HTMLButtonElement;
    this.trustMenuEl = requireChild(this.host, ".acp-trust-menu");
    this.trustChipEl.addEventListener("click", () => {
      if (this.trustMenuEl.hidden) this.openTrustMenu();
      else this.closeTrustMenu();
    });
    attachTooltip(this.trustChipEl, "Trust level — YOLO skips all permission prompts");
    this.renderMeta();
    this.renderTrustChip();
    this.liveStripEl = requireChild(this.host, ".acp-live-strip");
    this.messagesEl = requireChild(this.host, ".acp-chat-messages");
    this.messagesEl.addEventListener(
      "scroll",
      () => {
        const el = this.messagesEl;
        const prevTop = this.lastScrollTop;
        this.lastScrollTop = el.scrollTop;
        // After a programmatic jump, ignore scroll events for a short
        // window — the jump itself fires scroll, and on trackpads
        // residual momentum can briefly put us > 48px from the bottom.
        if (Date.now() - this.jumpedAt < 300) return;
        this.stickToBottom = resolveStickToBottom(
          prevTop,
          el.scrollTop,
          el.scrollHeight,
          el.clientHeight,
          this.stickToBottom,
        );
        this.syncJumpChip();
      },
      { passive: true },
    );
    // Scrolling up must release bottom-stick IMMEDIATELY. The scroll
    // handler above only releases once you're >48px from the bottom, but
    // while a turn is streaming, every chunk yanks scrollTop back to the
    // bottom — a trackpad can't escape the 48px window between chunks, so
    // the transcript reads as unscrollable. Wheel intent (deltaY < 0)
    // beats position.
    this.messagesEl.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY < 0 && Date.now() - this.jumpedAt >= 300) this.stickToBottom = false;
      },
      { passive: true },
    );
    // Intercept clicks on <a> tags rendered by the markdown renderer —
    // Tauri's webview blocks default navigation, so route through openUrl.
    this.messagesEl.addEventListener("click", (e) => {
      const anchor = (e.target as HTMLElement).closest?.("a[href]");
      if (!anchor) return;
      e.preventDefault();
      const href = anchor.getAttribute("href");
      if (href) void openUrl(href).catch((err) => console.error("openUrl failed", err));
    });
    this.emptyEl = requireChild(this.host, ".acp-chat-empty");
    this.imageStripEl = requireChild(this.host, ".acp-image-strip");
    this.inputEl = requireChild(this.host, ".acp-chat-textarea") as HTMLTextAreaElement;
    this.sendBtn = requireChild(this.host, ".acp-chat-send") as HTMLButtonElement;
    this.cancelBtn = requireChild(this.host, ".acp-chat-cancel") as HTMLButtonElement;
    this.jumpBtn = requireChild(this.host, ".acp-jump-present") as HTMLButtonElement;
    this.jumpBtn.addEventListener("click", () => {
      this.stickToBottom = true;
      this.jumpedAt = Date.now();
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this.syncJumpChip();
    });

    const form = requireChild(this.host, "form.acp-chat-input") as HTMLFormElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.handleSend();
    });
    this.cancelBtn.addEventListener("click", () => void this.handleCancel());
    this.slashEl = requireChild(this.host, ".acp-slash-menu");
    this.mentionEl = requireChild(this.host, ".acp-mention-menu");
    this.inputEl.addEventListener("input", () => {
      this.syncComposer();
      this.updateSlashMenu();
      void this.updateMentionMenu();
    });
    // Paste-to-attach: image/* clipboard items become ACP `image` blocks
    // on the next send (both copilot and pi-acp advertise
    // promptCapabilities.image). Text pastes flow through untouched.
    this.inputEl.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [...items]
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null);
      if (files.length === 0) return;
      e.preventDefault();
      for (const f of files) {
        const reader = new FileReader();
        reader.onload = () => {
          const url = String(reader.result ?? "");
          const comma = url.indexOf(",");
          if (comma < 0) return;
          this.pendingImages.push({ mimeType: f.type, data: url.slice(comma + 1) });
          this.renderImageStrip();
        };
        reader.readAsDataURL(f);
      }
    });
    this.inputEl.addEventListener("keydown", (e) => {
      // Popup navigation wins over send while a menu is open. The two
      // menus are mutually exclusive (slash needs a leading /token,
      // mention needs a trailing @fragment).
      if (!this.mentionEl.hidden) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? 1 : -1;
          const n = this.mentionItems.length;
          this.mentionSel = (this.mentionSel + delta + n) % n;
          this.renderMentionMenu();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          this.pickMention(this.mentionItems[this.mentionSel]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.hideMentionMenu();
          return;
        }
      }
      if (!this.slashEl.hidden) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? 1 : -1;
          const n = this.slashItems.length;
          this.slashSel = (this.slashSel + delta + n) % n;
          this.renderSlashMenu();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          this.pickSlashCommand(this.slashItems[this.slashSel]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.hideSlashMenu();
          return;
        }
      }
      if (e.key !== "Enter") return;
      // Chat convention: Enter sends, ⇧↩ inserts a newline. ⌘↩ keeps
      // sending too (muscle memory from the original binding).
      if (e.shiftKey) return; // let the textarea insert the newline
      e.preventDefault();
      void this.handleSend();
    });
  }

  // -------------------------------------------------------------------------
  // Slash-command autocomplete — roster comes from the agent's
  // `available_commands_update`; picking one just inserts `/name ` because
  // commands are invoked as plain prompt text (verified vs copilot 1.0.68).
  // -------------------------------------------------------------------------

  private updateSlashMenu(): void {
    // Synthesize /model when the agent has a model roster but doesn't
    // advertise a "model" command (pi-acp) — it routes to our native
    // picker in pickSlashCommand, never to the wire as prompt text.
    // Same for /resume: all three agents implement session/list (verified
    // live), but none advertises a slash command for it.
    let roster = this.state.commands;
    if (this.models.length > 0 && !roster.some((c) => c.name === "model")) {
      roster = [...roster, { name: "model", description: "Switch model (native picker)" }];
    }
    if (!roster.some((c) => c.name === "resume")) {
      roster = [...roster, { name: "resume", description: "Load a past conversation" }];
    }
    // /rename is a Covenant-native tab command, not a wire command — handleSend
    // intercepts it so it never reaches the agent as prompt text.
    if (!roster.some((c) => c.name === "rename")) {
      roster = [...roster, { name: "rename", description: "Rename this tab", input: { hint: "<name>" } }];
    }
    this.slashItems = filterSlashCommands(roster, this.inputEl.value);
    if (this.slashItems.length === 0) {
      this.hideSlashMenu();
      return;
    }
    this.slashSel = Math.min(this.slashSel, this.slashItems.length - 1);
    this.slashEl.hidden = false;
    this.renderSlashMenu();
  }

  private renderSlashMenu(): void {
    this.slashEl.textContent = "";
    this.slashItems.forEach((cmd, i) => {
      const row = document.createElement("div");
      row.className = "acp-slash-row";
      row.setAttribute("role", "option");
      if (i === this.slashSel) row.classList.add("acp-slash-selected");
      const name = document.createElement("span");
      name.className = "acp-slash-name";
      name.textContent = `/${cmd.name}`;
      row.appendChild(name);
      const hint = cmd.input?.hint;
      if (hint) {
        const hintEl = document.createElement("span");
        hintEl.className = "acp-slash-hint";
        hintEl.textContent = hint;
        row.appendChild(hintEl);
      }
      if (cmd.description) {
        const desc = document.createElement("span");
        desc.className = "acp-slash-desc";
        desc.textContent = cmd.description;
        row.appendChild(desc);
      }
      // mousedown (not click) so the textarea never loses focus.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.pickSlashCommand(cmd);
      });
      this.slashEl.appendChild(row);
    });
  }

  private pickSlashCommand(cmd: AcpAvailableCommand | undefined): void {
    if (!cmd) return;
    this.hideSlashMenu();
    // Commands with interactive sub-selection in the copilot TUI can't
    // ride a text prompt — route them to our native pickers instead.
    if (cmd.name === "model") {
      this.inputEl.value = "";
      this.syncComposer();
      this.openModelMenu();
      return;
    }
    if (cmd.name === "resume") {
      this.inputEl.value = "";
      this.syncComposer();
      void this.openResumeMenu();
      return;
    }
    this.inputEl.value = `/${cmd.name} `;
    this.syncComposer();
    this.inputEl.focus();
  }

  private hideSlashMenu(): void {
    this.slashEl.hidden = true;
    this.slashEl.textContent = "";
    this.slashItems = [];
    this.slashSel = 0;
  }

  // -------------------------------------------------------------------------
  // @-mention file picker — lists the session cwd via structureListDir;
  // picking a file inserts `@rel/path ` and records it as an attachment
  // (embedded as an ACP `resource` block on send). Dirs descend in place.
  // -------------------------------------------------------------------------

  private async updateMentionMenu(): Promise<void> {
    if (!this.cwd) return; // no jail root — mentions disabled
    const frag = mentionFragmentAt(this.inputEl.value, this.inputEl.selectionStart ?? 0);
    if (!frag) {
      this.hideMentionMenu();
      return;
    }
    this.mentionFrag = frag;
    const slash = frag.fragment.lastIndexOf("/");
    const dirPart = slash >= 0 ? frag.fragment.slice(0, slash + 1) : "";
    const base = (slash >= 0 ? frag.fragment.slice(slash + 1) : frag.fragment).toLowerCase();
    const token = ++this.mentionListToken;
    let entries: DirEntry[];
    try {
      entries = await structureListDir(`${this.cwd}/${dirPart}`);
    } catch {
      this.hideMentionMenu();
      return;
    }
    // A newer keystroke superseded this listing, or the fragment vanished.
    if (token !== this.mentionListToken || this.destroyed) return;
    this.mentionItems = entries
      .filter((e) => e.name.toLowerCase().startsWith(base))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
      .slice(0, 20);
    if (this.mentionItems.length === 0) {
      this.hideMentionMenu();
      return;
    }
    this.mentionSel = Math.min(this.mentionSel, this.mentionItems.length - 1);
    this.mentionEl.hidden = false;
    this.renderMentionMenu();
  }

  private renderMentionMenu(): void {
    this.mentionEl.textContent = "";
    this.mentionItems.forEach((entry, i) => {
      const row = document.createElement("div");
      row.className = "acp-slash-row";
      row.setAttribute("role", "option");
      if (i === this.mentionSel) row.classList.add("acp-slash-selected");
      const name = document.createElement("span");
      name.className = "acp-slash-name";
      name.textContent = entry.kind === "dir" ? `${entry.name}/` : entry.name;
      row.appendChild(name);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.pickMention(entry);
      });
      this.mentionEl.appendChild(row);
    });
  }

  private pickMention(entry: DirEntry | undefined): void {
    const frag = this.mentionFrag;
    if (!entry || !frag) return;
    const slash = frag.fragment.lastIndexOf("/");
    const dirPart = slash >= 0 ? frag.fragment.slice(0, slash + 1) : "";
    const caret = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const before = this.inputEl.value.slice(0, frag.start);
    const after = this.inputEl.value.slice(caret);
    if (entry.kind === "dir") {
      const repl = `@${dirPart}${entry.name}/`;
      this.inputEl.value = `${before}${repl}${after}`;
      this.syncComposer();
      const pos = before.length + repl.length;
      this.inputEl.setSelectionRange(pos, pos);
      this.inputEl.focus();
      void this.updateMentionMenu(); // descend: relist the picked dir
      return;
    }
    const rel = `${dirPart}${entry.name}`;
    const repl = `@${rel} `;
    this.inputEl.value = `${before}${repl}${after}`;
    this.syncComposer();
    const pos = before.length + repl.length;
    this.inputEl.setSelectionRange(pos, pos);
    this.mentions.add(rel);
    this.inputEl.focus();
    this.hideMentionMenu();
  }

  private hideMentionMenu(): void {
    this.mentionEl.hidden = true;
    this.mentionEl.textContent = "";
    this.mentionItems = [];
    this.mentionSel = 0;
    this.mentionFrag = null;
  }

  /// Header meta — plain textContent, wire/user strings never hit
  /// innerHTML. The model lives in its own clickable chip; meta is cwd.
  private renderMeta(): void {
    const home = /^\/Users\/[^/]+/;
    this.metaEl.textContent = this.cwd ? this.cwd.replace(home, "~") : "";
    this.modelChipEl.textContent = this.model ?? "model";
    this.modelChipEl.hidden = this.model === null && this.models.length === 0;
  }

  /// Trust chip — always visible (unlike the model chip, which hides
  /// without a roster). YOLO gets permanent warning styling, not just a
  /// hover state, since it's a standing risk posture for the session.
  private renderTrustChip(): void {
    this.trustChipEl.textContent = AcpChatView.TRUST_LABELS[this.trust];
    this.trustChipEl.classList.toggle("acp-trust-chip--yolo", this.trust === "yolo");
  }

  // -------------------------------------------------------------------------
  // Trust picker — live-session only (`session/set_trust` via `acpSetTrust`).
  // Never mutates the executor's stored config; a fresh tab always launches
  // at the executor's configured default (`SpawnAcpResult.trust`).
  // -------------------------------------------------------------------------

  private openTrustMenu(): void {
    this.closeModelMenu();
    this.trustMenuEl.style.left = `${this.trustChipEl.offsetLeft}px`;
    this.trustMenuEl.hidden = false;
    this.renderTrustMenu();
    document.addEventListener("mousedown", this.closeModelMenuOnOutsideClick);
  }

  private closeTrustMenu(): void {
    this.trustMenuEl.hidden = true;
    this.trustMenuEl.textContent = "";
    document.removeEventListener("mousedown", this.closeModelMenuOnOutsideClick);
  }

  private renderTrustMenu(): void {
    this.trustMenuEl.textContent = "";
    for (const t of ["ask", "balanced", "yolo"] as AcpTrust[]) {
      // <div role="option">, same as the model-menu rows — a bare <button>
      // gets native rounded Aqua chrome in WKWebView (no button reset in
      // this stylesheet), violating the border-radius-0 rule.
      const item = document.createElement("div");
      item.className = "acp-slash-row";
      item.dataset.trust = t;
      item.setAttribute("role", "option");
      if (t === this.trust) item.classList.add("acp-slash-selected");
      const name = document.createElement("span");
      name.className = "acp-slash-name";
      name.textContent = AcpChatView.TRUST_LABELS[t];
      item.appendChild(name);
      if (t === "yolo") item.classList.add("acp-trust-menu-yolo");
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.trust = t;
        this.renderTrustChip();
        this.closeTrustMenu();
        void acpSetTrust(this.sessionId, t);
      });
      this.trustMenuEl.appendChild(item);
    }
  }

  // -------------------------------------------------------------------------
  // Model picker — roster from session/new (cached backend-side); switching
  // goes through ACP `session/set_model`. Also opened by the /model slash
  // command, whose TUI behavior (an interactive picker) can't ride a text
  // prompt.
  // -------------------------------------------------------------------------

  private openModelMenu(): void {
    if (this.models.length === 0) return;
    this.closeTrustMenu();
    // Anchor under the chip (offsetParent is the header, which is
    // position:relative). Done here, not in CSS — the chip's x depends
    // on the title/meta widths at open time.
    this.modelMenuEl.style.left = `${this.modelChipEl.offsetLeft}px`;
    this.modelMenuEl.hidden = false;
    this.renderModelMenu();
    document.addEventListener("mousedown", this.closeModelMenuOnOutsideClick);
  }

  private closeModelMenu(): void {
    this.modelMenuEl.hidden = true;
    this.modelMenuEl.textContent = "";
    document.removeEventListener("mousedown", this.closeModelMenuOnOutsideClick);
  }

  private renderModelMenu(): void {
    this.modelMenuEl.textContent = "";
    for (const m of this.models) {
      const row = document.createElement("div");
      row.className = "acp-slash-row";
      row.setAttribute("role", "option");
      if (m.modelId === this.model) row.classList.add("acp-slash-selected");
      const name = document.createElement("span");
      name.className = "acp-slash-name";
      name.textContent = m.name ?? m.modelId;
      row.appendChild(name);
      const usage = m.meta?.copilotUsage;
      if (typeof usage === "string") {
        const hint = document.createElement("span");
        hint.className = "acp-slash-hint";
        hint.textContent = usage;
        row.appendChild(hint);
      }
      if (m.modelId === this.model) {
        const mark = document.createElement("span");
        mark.className = "acp-slash-desc";
        mark.textContent = "current";
        row.appendChild(mark);
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        void this.pickModel(m.modelId);
      });
      this.modelMenuEl.appendChild(row);
    }
  }

  // -------------------------------------------------------------------------
  // /resume picker — session/list roster in the same dropdown chrome as the
  // model menu; picking calls session/load on the LIVE process and lets the
  // replay repopulate the cleared transcript.
  // -------------------------------------------------------------------------

  private async openResumeMenu(): Promise<void> {
    let listings: AcpSessionListing[];
    try {
      listings = await acpListSessions(this.sessionId);
    } catch (err) {
      this.appendNotice(`resume: ${String(err)}`, "error");
      return;
    }
    // Drop the live session and throwaway sessions whose only title is a bare
    // slash-command (`/model`, `/respawn`) — those were opened, tweaked, and
    // abandoned; they're the noise the resume list used to drown in.
    const others = listings
      .filter((l) => l.sessionId !== this.acpSessionId && !isJunkResumeTitle(l.title))
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    if (others.length === 0) {
      this.appendNotice("No past conversations to resume.", "info");
      return;
    }
    this.closeModelMenu();
    this.resumeMenuEl.hidden = false;
    this.resumeMenuEl.textContent = "";
    const header = document.createElement("div");
    header.className = "acp-resume-header";
    header.textContent = "Resume a conversation";
    this.resumeMenuEl.appendChild(header);
    for (const l of others.slice(0, 20)) {
      const row = document.createElement("div");
      row.className = "acp-slash-row";
      row.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "acp-slash-desc";
      name.textContent = (l.title ?? l.sessionId).slice(0, 80);
      row.appendChild(name);
      if (l.updatedAt) {
        const hint = document.createElement("span");
        hint.className = "acp-slash-hint";
        hint.textContent = relativeTime(l.updatedAt);
        row.appendChild(hint);
      }
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        void this.pickResume(l.sessionId);
      });
      this.resumeMenuEl.appendChild(row);
    }
    document.addEventListener("mousedown", this.closeResumeMenuOnOutsideClick);
  }

  private closeResumeMenu(): void {
    this.resumeMenuEl.hidden = true;
    this.resumeMenuEl.textContent = "";
    document.removeEventListener("mousedown", this.closeResumeMenuOnOutsideClick);
  }

  private async pickResume(acpSessionId: string): Promise<void> {
    this.closeResumeMenu();
    this.resetTranscript();
    this.appendNotice("Loading conversation…", "info");
    try {
      const models = await acpLoadSession(this.sessionId, acpSessionId);
      this.acpSessionId = acpSessionId;
      this.onSessionChange?.(this.sessionId, acpSessionId);
      if (models.available.length > 0) this.models = models.available;
      if (models.current) this.model = models.current;
      this.renderMeta();
    } catch (err) {
      this.appendNotice(`resume failed: ${String(err)}`, "error");
    }
  }

  /// Clear the rendered conversation so a session/load replay can
  /// repopulate from scratch. State and DOM caches reset together —
  /// stale tool/perm DOM registries would otherwise re-bind replayed
  /// toolCallIds to detached nodes.
  private resetTranscript(): void {
    this.state.items.length = 0;
    this.state.tools.clear();
    this.state.pendingPerms.clear();
    this.state.turnHadOutput = false;
    this.state.inFlight = false;
    this.toolDoms.clear();
    this.permDoms.clear();
    // Detach the growing-node cursors — they point into removed DOM.
    this.lastProseItem = null;
    this.lastProseEl = null;
    this.lastUserItem = null;
    this.lastUserEl = null;
    // Keep the empty-state node (hidden) — clearing textContent would
    // detach the element this.emptyEl points at.
    for (const child of [...this.messagesEl.children]) {
      if (child !== this.emptyEl) child.remove();
    }
    this.emptyEl.hidden = true;
    this.setInFlight(false);
  }

  private async pickModel(modelId: string): Promise<void> {
    this.closeModelMenu();
    try {
      await acpSetModel(this.sessionId, modelId);
      this.model = modelId;
      persistPreferredModel(this.executor, modelId);
      this.renderMeta();
      this.appendNotice(`Model switched to ${modelId}.`, "info");
    } catch (err) {
      this.appendNotice(`model switch failed: ${String(err)}`, "error");
    }
  }

  /// Re-apply the user's persisted model pick for this executor. Agents
  /// start every ACP session on their own default (copilot 1.0.68 ignores
  /// even its settings.json `"model": "auto"` under --acp), so a one-time
  /// pick would silently revert on every new tab/restart without this.
  /// Silent on success — no notice spam on every spawn.
  private async applyPreferredModel(): Promise<void> {
    const want = preferredModel(this.executor);
    if (!want || want === this.model) return;
    if (!this.models.some((m) => m.modelId === want)) return;
    try {
      await acpSetModel(this.sessionId, want);
      this.model = want;
      this.renderMeta();
    } catch {
      /* stale preference or unsupported agent — the default stands */
    }
  }

  // -------------------------------------------------------------------------
  // Event subscription + dispatch
  // -------------------------------------------------------------------------

  private async subscribe(): Promise<void> {
    try {
      const unlisten = await subscribeAcpEvents(this.sessionId, (ev) => {
        if (this.destroyed) return;
        this.handleEvent(ev);
      });
      // destroy() may have run while the await was in flight — its
      // unsubscribe pass saw `this.unlisten === null` and skipped, so
      // detach here instead of leaking a live Tauri listener.
      if (this.destroyed) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      // Listener is live — unblock the forwarder's first emit. Without
      // this, a resume replay burst is emitted before the listener lands
      // and the transcript arrives with holes. (5s backend escape hatch
      // keeps a failed call from wedging the stream.)
      try {
        await acpMarkReady(this.sessionId);
      } catch {
        /* forwarder falls back to its timeout */
      }
      // Seed the slash + model rosters: their initial broadcasts raced this
      // listener's registration, so pull the backend's cached copies. Live
      // updates keep flowing through the event stream and replace them.
      try {
        const commands = await acpGetCommands(this.sessionId);
        if (!this.destroyed && this.state.commands.length === 0) {
          this.state.commands = commands;
        }
      } catch {
        /* roster is a nicety — the composer still works without it */
      }
      try {
        const models = await acpGetModels(this.sessionId);
        if (!this.destroyed) {
          this.models = models.available;
          if (models.current) this.model = models.current;
          this.renderMeta();
          await this.applyPreferredModel();
        }
      } catch {
        /* model picker is a nicety */
      }
    } catch (err) {
      if (!this.destroyed) this.appendNotice(`subscribe failed: ${String(err)}`, "error");
    }
  }

  private handleEvent(ev: AcpTabEvent): void {
    reduceAcpEvent(this.state, ev);
    switch (ev.type) {
      case "update": {
        const u = ev.update.update;
        if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") {
          this.renderProseTail();
        } else if (u.sessionUpdate === "user_message_chunk") {
          // Replay-only (live prompts never echo back) — without this the
          // replayed transcript renders agent prose and tool cards but
          // silently drops every YOU bubble.
          this.renderUserTail();
        } else if ("toolCallId" in u) {
          this.renderTool(u.toolCallId);
        }
        break;
      }
      case "permission_pending":
        this.renderPerm(ev.requestKey);
        break;
      case "prompt_done":
        this.setInFlight(false);
        this.renderNoticeTail();
        // Retry the titler now that the agent has responded — the bare
        // first prompt often isn't enough to name the tab.
        if (this.titleSent && !this.llmTitled && this.onTitle)
          this.runTitler(this.transcriptForTitle());
        break;
      case "session_dead":
        this.setInFlight(false);
        this.renderNoticeTail();
        break;
      case "perception_auto_answer":
        this.renderNoticeTail();
        break;
    }
    this.scrollToBottom();
  }

  // -------------------------------------------------------------------------
  // Prose rendering — agent prose goes through `renderMarkdown` (the same
  // escape-first mini-renderer the changelog uses: headings, lists, fences,
  // bold/italic — Claude streams real markdown and the backticks-only
  // formatProse rendered it raw). Raw agent text never hits innerHTML
  // unescaped in either path.
  // -------------------------------------------------------------------------

  /// Replayed user bubble — same one-growing-node pattern as
  /// `renderProseTail`. Also feeds the tab-title inference: the first
  /// real user prompt of a resumed conversation titles the tab.
  private renderUserTail(): void {
    const item = this.state.items[this.state.items.length - 1];
    if (!item || item.kind !== "user") return;
    if (this.lastUserItem === item && this.lastUserEl) {
      this.lastUserEl.textContent = item.text;
      return;
    }
    this.hideEmptyState();
    const el = document.createElement("div");
    el.className = "acp-msg acp-msg-user";
    el.innerHTML = `<div class="acp-msg-role">you</div><div class="acp-msg-content"></div>`;
    const contentEl = requireChild(el, ".acp-msg-content");
    contentEl.textContent = item.text;
    this.messagesEl.appendChild(el);
    this.lastUserItem = item;
    this.lastUserEl = contentEl;
    this.maybeEmitTitle(item.text);
  }

  private maybeEmitTitle(text: string): void {
    if (this.titleSent || !this.onTitle) return;
    const title = titleFromPrompt(text);
    if (title === null) return;
    this.titleSent = true;
    // Instant fallback (first prompt line) while the real titler runs —
    // same 2-word LLM label PTY tabs get from the screen summarizer.
    this.onTitle(title);
    this.runTitler(text);
  }

  /// Ask the LLM for a 2-word title from `transcript`. Applies the result
  /// only on success; leaves `llmTitled` false on null/empty so the next
  /// `prompt_done` retries with a richer transcript.
  private runTitler(transcript: string): void {
    void acpSuggestTitle(this.sessionId, transcript)
      .then((t) => {
        if (t && t.trim().length > 0) {
          this.llmTitled = true;
          this.onTitle?.(t.trim());
        }
      })
      .catch(() => {
        /* fallback title already set */
      });
  }

  /// Build a compact "you: … / assistant: …" transcript from the first
  /// user prompt and agent prose — enough for the titler to name the topic
  /// when the bare prompt was too vague. Capped so we never ship a wall of
  /// text to the LLM.
  private transcriptForTitle(): string {
    const lines: string[] = [];
    for (const it of this.state.items) {
      if (it.kind === "user") lines.push(`you: ${it.text.trim()}`);
      else if (it.kind === "prose" && it.role !== "thought")
        lines.push(`assistant: ${it.text.trim()}`);
      if (lines.length >= 4) break;
    }
    return lines.join("\n\n").slice(0, 2000);
  }

  private renderProseTail(): void {
    const item = this.state.items[this.state.items.length - 1];
    if (!item || item.kind !== "prose") return;
    if (this.lastProseItem === item && this.lastProseEl) {
      this.lastProseEl.innerHTML = renderMarkdown(item.text);
      return;
    }
    this.hideEmptyState();
    const el = document.createElement("div");
    el.className = item.role === "thought" ? "acp-msg acp-msg-thought" : "acp-msg acp-msg-assistant";
    el.innerHTML = `<div class="acp-msg-role">${item.role === "thought" ? "thinking" : EXECUTOR_BRAND[this.executor].roleLabel}</div><div class="acp-msg-content"></div>`;
    const contentEl = requireChild(el, ".acp-msg-content");
    contentEl.innerHTML = renderMarkdown(item.text);
    this.messagesEl.appendChild(el);
    this.lastProseItem = item;
    this.lastProseEl = contentEl;
  }

  // -------------------------------------------------------------------------
  // Tool call cards
  // -------------------------------------------------------------------------

  private renderTool(toolCallId: string): void {
    const item = this.state.tools.get(toolCallId);
    if (!item) return;
    let dom = this.toolDoms.get(toolCallId);
    if (!dom) {
      dom = this.buildToolCard();
      this.toolDoms.set(toolCallId, dom);
      this.hideEmptyState();
      this.messagesEl.appendChild(dom.root);
    }
    this.updateToolCard(dom, item.fields);
  }

  private buildToolCard(): ToolCardDom {
    const root = document.createElement("div");
    root.className = "acp-tool";
    root.innerHTML = `
      <div class="acp-tool-head">
        <span class="acp-status-dot" data-state="pending"></span>
        <span class="acp-chip" data-kind="tool">tool</span>
        <span class="acp-tool-title"></span>
        <span class="acp-exit-chip" hidden></span>
        <span class="acp-tool-toggle" aria-expanded="true">▾</span>
      </div>
      <div class="acp-tool-body"></div>
    `;
    const chipEl = requireChild(root, ".acp-chip");
    const dotEl = requireChild(root, ".acp-status-dot");
    const titleEl = requireChild(root, ".acp-tool-title");
    const exitEl = requireChild(root, ".acp-exit-chip");
    const toggleEl = requireChild(root, ".acp-tool-toggle");
    const bodyEl = requireChild(root, ".acp-tool-body");
    toggleEl.addEventListener("click", () => {
      const expanded = toggleEl.getAttribute("aria-expanded") !== "false";
      toggleEl.setAttribute("aria-expanded", String(!expanded));
      toggleEl.textContent = expanded ? "▸" : "▾";
      bodyEl.hidden = expanded;
    });
    return { root, chipEl, dotEl, titleEl, exitEl, toggleEl, bodyEl };
  }

  private updateToolCard(dom: ToolCardDom, f: AcpToolCallFields): void {
    const kind = f.kind ?? "tool";
    dom.chipEl.dataset.kind = kind;
    dom.chipEl.textContent = kind;

    const background = isBackgroundConsole(f, this.state.sawShellExit);
    // A background console reads as still-running even though the tool
    // call itself completed — the process it spawned is alive.
    const state = background ? "running" : statusToState(f.status);
    dom.dotEl.dataset.state = state;
    dom.root.dataset.status = state;

    const command = commandOf(f.rawInput);
    dom.titleEl.textContent = f.title ?? command ?? f.toolCallId;

    const code = exitCodeOf(f.rawOutput) ?? textExitCodeOf(f.content);
    if (code !== null) {
      dom.exitEl.hidden = false;
      dom.exitEl.textContent = `exit ${code}`;
      dom.exitEl.dataset.ok = String(code === 0);
      delete dom.exitEl.dataset.bg;
    } else if (background) {
      dom.exitEl.hidden = false;
      dom.exitEl.textContent = "background";
      dom.exitEl.dataset.bg = "true";
      delete dom.exitEl.dataset.ok;
    } else {
      dom.exitEl.hidden = true;
    }

    if (background && !this.bgSince.has(f.toolCallId)) {
      this.bgSince.set(f.toolCallId, Date.now());
    } else if (!background) {
      this.bgSince.delete(f.toolCallId);
    }
    this.renderLiveStrip();

    dom.bodyEl.innerHTML = "";
    const diffs = diffBlocksOf(f.content);
    if (diffs.length > 0) {
      for (const d of diffs) dom.bodyEl.appendChild(buildDiffBlock(d));
    } else if (command !== null) {
      const cmdEl = document.createElement("div");
      cmdEl.className = "acp-shell-cmd";
      cmdEl.innerHTML = `<code>${escapeHtml(command)}</code>`;
      dom.bodyEl.appendChild(cmdEl);
      const out = stripFences(joinContentText(f.content));
      if (out.length > 0) {
        const outEl = document.createElement("pre");
        outEl.className = "acp-shell-out";
        outEl.textContent = out;
        dom.bodyEl.appendChild(outEl);
      }
      if (background) {
        const shellId = shellIdOf(f.rawOutput);
        const note = document.createElement("div");
        note.className = "acp-bg-note";
        note.innerHTML =
          `<span>This console is still running — the agent moved on without waiting for it to exit.</span>` +
          (shellId !== null ? `<span class="acp-bg-shellid">shellId ${escapeHtml(shellId)}</span>` : "");
        dom.bodyEl.appendChild(note);
      }
    } else {
      const out = stripFences(joinContentText(f.content));
      if (out.length > 0) {
        const outEl = document.createElement("pre");
        outEl.className = "acp-shell-out";
        outEl.textContent = out;
        dom.bodyEl.appendChild(outEl);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Live-console strip — census of background consoles above the composer.
  // Mounts only while any are alive; unmounts itself at zero.
  // -------------------------------------------------------------------------

  private renderLiveStrip(): void {
    const el = this.liveStripEl;
    if (!el) return;
    const live: Array<{ command: string | null; shellId: string | null; since: number | undefined }> = [];
    for (const item of this.state.tools.values()) {
      if (!isBackgroundConsole(item.fields, this.state.sawShellExit)) continue;
      live.push({
        command: commandOf(item.fields.rawInput),
        shellId: shellIdOf(item.fields.rawOutput),
        since: this.bgSince.get(item.toolCallId),
      });
    }
    if (live.length === 0) {
      el.hidden = true;
      if (this.liveStripTimer !== null) {
        window.clearInterval(this.liveStripTimer);
        this.liveStripTimer = null;
      }
      return;
    }
    const parts = live.map((c) => {
      const bits = [c.command ?? "console"];
      if (c.shellId !== null) bits.push(`shellId ${c.shellId}`);
      if (c.since !== undefined) bits.push(consoleAge(c.since));
      return bits.join(" · ");
    });
    el.innerHTML =
      `<span class="acp-live-dot"></span>` +
      `<span class="acp-live-count">${live.length} console${live.length === 1 ? "" : "s"} running</span>` +
      `<span class="acp-live-cmds">${escapeHtml(parts.join("  ·  "))}</span>`;
    el.hidden = false;
    if (this.liveStripTimer === null) {
      // Age readout only — membership updates arrive with tool events.
      this.liveStripTimer = window.setInterval(() => this.renderLiveStrip(), 30_000);
    }
  }

  // -------------------------------------------------------------------------
  // Permission cards
  // -------------------------------------------------------------------------

  private renderPerm(requestKey: string): void {
    const item = this.state.pendingPerms.get(requestKey);
    if (!item) return;
    this.hideEmptyState();
    const dom = this.buildPermCard(item);
    this.permDoms.set(requestKey, dom);
    this.messagesEl.appendChild(dom.root);
  }

  private buildPermCard(item: AcpPermItem): PermCardDom {
    const { request } = item;
    const kind = request.toolCall.kind ?? "tool";
    const command = commandOf(request.toolCall.rawInput);
    // Edit/read-kind tool calls carry no `command` — surface the file
    // target instead so the card isn't blank about what's being touched.
    const target = command ?? fileNameOf(request.toolCall.rawInput);
    const title = request.toolCall.title ?? target ?? request.toolCall.toolCallId;

    const root = document.createElement("div");
    root.className = "acp-perm";
    root.innerHTML = `
      <div class="acp-perm-head">
        <span class="acp-chip" data-kind="${escapeHtml(kind)}">${escapeHtml(kind)}</span>
        <span class="acp-perm-title">${escapeHtml(title)}</span>
      </div>
      ${target !== null ? `<div class="acp-perm-cmd"><code>${escapeHtml(target)}</code></div>` : ""}
      <div class="acp-perm-waiting">Waiting for your decision…</div>
      <div class="acp-perm-record" hidden></div>
      <div class="acp-perm-options"></div>
    `;
    const waitingEl = requireChild(root, ".acp-perm-waiting");
    const recordEl = requireChild(root, ".acp-perm-record");
    const optionsEl = requireChild(root, ".acp-perm-options");
    for (const option of request.options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "acp-perm-option";
      btn.dataset.optionKind = option.kind;
      btn.textContent = option.name ?? option.kind;
      btn.addEventListener("click", () => {
        this.answerPerm(item, option, { root, waitingEl, optionsEl, recordEl });
      });
      optionsEl.appendChild(btn);
    }
    return { root, waitingEl, optionsEl, recordEl };
  }

  private answerPerm(item: AcpPermItem, option: AcpPermissionOption, dom: PermCardDom): void {
    if (item.answered) return; // already answered — buttons should be disabled, but guard anyway
    const command = commandOf(item.request.toolCall.rawInput);
    const label = permAnswerLabel(option, command);

    dom.optionsEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.disabled = true;
    });
    markPermAnswered(this.state, item.requestKey, label);
    dom.waitingEl.hidden = true;
    dom.recordEl.hidden = false;
    dom.recordEl.innerHTML = formatProse(label);

    void acpRespondPermission(this.sessionId, item.requestKey, option.optionId).catch((err) => {
      dom.recordEl.innerHTML = `${formatProse(label)} <span class="acp-perm-error">(send failed: ${escapeHtml(String(err))})</span>`;
    });
  }

  // -------------------------------------------------------------------------
  // Notices (turn dividers, dead-session restart, system notes)
  // -------------------------------------------------------------------------

  private renderNoticeTail(): void {
    const item = this.state.items[this.state.items.length - 1];
    if (!item || item.kind !== "notice") return;
    this.hideEmptyState();
    this.messagesEl.appendChild(this.buildNoticeNode(item));
  }

  private buildNoticeNode(item: AcpNoticeItem): HTMLElement {
    if (item.variant === "divider") {
      const el = document.createElement("div");
      el.className = "acp-turn-divider";
      el.textContent = item.text;
      return el;
    }
    const el = document.createElement("div");
    el.className = `acp-msg-system acp-msg-system-${item.variant}`;
    el.textContent = item.text;
    if (item.variant === "dead") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "acp-restart-btn";
      btn.textContent = "Restart session";
      btn.addEventListener("click", () => void this.restart());
      el.appendChild(btn);
    }
    return el;
  }

  /// Pushed directly (not via `reduceAcpEvent`, since it's not a wire
  /// event) — used for local subscribe/send/cancel/restart failures.
  private appendNotice(text: string, variant: "info" | "error"): void {
    this.state.items.push({ kind: "notice", text, variant });
    this.hideEmptyState();
    this.messagesEl.appendChild(this.buildNoticeNode({ kind: "notice", text, variant }));
    this.scrollToBottom();
  }

  // -------------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------------

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    const images = this.pendingImages;
    if ((text.length === 0 && images.length === 0) || this.state.inFlight) return;
    // /rename is a Covenant tab command — rename the tab, never send it to the
    // agent (which just replies "no output" to unknown slash text).
    const rename = /^\/rename(?:\s+(.*))?$/.exec(text);
    if (rename) {
      const name = (rename[1] ?? "").trim();
      this.hideSlashMenu();
      this.inputEl.value = "";
      this.syncComposer();
      if (name.length === 0) {
        this.appendNotice("Usage: /rename <name>", "info");
      } else {
        this.onRename?.(name);
        this.appendNotice(`Renamed tab to "${name}".`, "info");
      }
      return;
    }
    this.hideSlashMenu();
    this.hideMentionMenu();
    // Only mentions whose @token survived editing become attachments.
    const attachments = [...this.mentions].filter((p) => text.includes(`@${p}`));
    this.mentions.clear();
    this.inputEl.value = "";
    this.syncComposer();
    this.pendingImages = [];
    this.renderImageStrip();
    this.state.items.push({
      kind: "user",
      text,
      images: images.length > 0 ? images : undefined,
    });
    this.state.turnHadOutput = false; // armed: silent end_turn → notice
    this.hideEmptyState();
    const el = document.createElement("div");
    el.className = "acp-msg acp-msg-user";
    el.innerHTML = `<div class="acp-msg-role">you</div>`;
    el.appendChild(buildUserContent(text, images));
    this.messagesEl.appendChild(el);
    this.maybeEmitTitle(text);
    this.stickToBottom = true;
    this.setInFlight(true);
    this.scrollToBottom();
    try {
      await acpSendPrompt(
        this.sessionId,
        text,
        attachments.length > 0 ? attachments : undefined,
        images.length > 0 ? images : undefined,
      );
    } catch (err) {
      this.setInFlight(false);
      this.appendNotice(`send failed: ${String(err)}`, "error");
    }
  }

  /// Removable chips for pasted images, above the textarea. Chip body
  /// (thumbnail + label) opens a quick-view overlay; only the ✕ removes.
  private renderImageStrip(): void {
    this.imageStripEl.hidden = this.pendingImages.length === 0;
    this.imageStripEl.textContent = "";
    this.syncComposer();
    this.pendingImages.forEach((img, i) => {
      const dataUrl = `data:${img.mimeType};base64,${img.data}`;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "acp-image-chip";
      chip.title = "Click to preview";
      chip.innerHTML =
        `<img class="acp-image-chip-thumb" src="${dataUrl}" alt="" />` +
        `<span>image ${i + 1} · ${escapeHtml(img.mimeType.replace("image/", ""))}</span>` +
        `<span class="acp-image-chip-x" title="Remove image">${Icons.x({ size: 12 })}</span>`;
      chip.addEventListener("click", (e) => {
        const x = chip.querySelector(".acp-image-chip-x");
        if (x && e.target instanceof Node && x.contains(e.target)) {
          this.pendingImages.splice(i, 1);
          this.renderImageStrip();
          return;
        }
        openImagePreview(dataUrl);
      });
      this.imageStripEl.appendChild(chip);
    });
  }

  private async handleCancel(): Promise<void> {
    try {
      await acpCancel(this.sessionId);
      this.statusEl.dataset.state = "aborting";
      this.statusEl.textContent = "cancelling…";
    } catch (err) {
      this.appendNotice(`cancel failed: ${String(err)}`, "error");
    }
  }

  private async restart(): Promise<void> {
    if (this.unlisten) {
      try {
        this.unlisten();
      } catch {
        /* already gone */
      }
      this.unlisten = null;
    }
    try {
      // Same executor as the original spawn, and resume the wire session
      // so a crashed agent comes back with its transcript (falls back to
      // fresh server-side if the session can't be loaded).
      const spawned = await spawnAcpSession({
        cwd: this.cwd,
        executor: this.executor,
        resumeAcpSessionId: this.acpSessionId ?? undefined,
      });
      // destroy() may have run during the spawn await — don't adopt the
      // fresh session or resubscribe on a torn-down view. (subscribe()
      // has its own post-await guard for a destroy racing ITS await.)
      if (this.destroyed) {
        void closeAcpSession(spawned.sessionId).catch(() => {
          /* best-effort — nothing to surface on a destroyed view */
        });
        return;
      }
      this.sessionId = spawned.sessionId;
      this.acpSessionId = spawned.acpSessionId;
      this.onSessionChange?.(spawned.sessionId, spawned.acpSessionId);
      this.model = spawned.model ?? this.model;
      this.trust = spawned.trust;
      this.renderMeta();
      this.renderTrustChip();
      this.setInFlight(false);
      // A resumed spawn replays the WHOLE transcript as session/update
      // frames. Into a non-empty view that duplicates every prose bubble
      // while the replayed tool_calls merge invisibly into the existing
      // cards (same toolCallIds) — the "instructions lost in the middle"
      // bug. Clear first and let the replay repopulate; a non-resumed
      // restart keeps the old transcript as visual history.
      if (spawned.resumed) this.resetTranscript();
      await this.subscribe();
      this.appendNotice(spawned.resumed ? "Session restarted — conversation resumed." : "Session restarted.", "info");
    } catch (err) {
      if (!this.destroyed) this.appendNotice(`restart failed: ${String(err)}`, "error");
    }
  }

  private setInFlight(busy: boolean): void {
    this.state.inFlight = busy;
    // Send and Stop swap in place — never side by side.
    this.sendBtn.hidden = busy;
    this.cancelBtn.hidden = !busy;
    if (!busy) this.syncComposer();
    this.statusEl.dataset.state = busy ? "running" : "idle";
    this.statusEl.textContent = busy ? "running…" : "idle";
  }

  /// Keep the composer card honest after any value change (typed or
  /// programmatic): auto-grow the textarea to its content and disable
  /// Send when there is nothing to send.
  private syncComposer(): void {
    const el = this.inputEl;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    this.sendBtn.disabled =
      el.value.trim().length === 0 && this.pendingImages.length === 0;
  }

  private hideEmptyState(): void {
    this.emptyEl.hidden = true;
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      if (!this.stickToBottom) {
        // Content grew while the user was scrolled up — no scroll event
        // fires for that, so re-check the chip here.
        this.syncJumpChip();
        return;
      }
      const el = this.messagesEl;
      el.scrollTop = el.scrollHeight;
    });
  }

  /// "Jump to present" chip: visible only while the transcript is
  /// scrolled meaningfully away from the live edge.
  private syncJumpChip(): void {
    const el = this.messagesEl;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight >= 48;
    this.jumpBtn.hidden = !away || this.stickToBottom;
  }
}

/// Directional bottom-stick: only an upward scroll (user intent — wheel,
/// trackpad, scrollbar drag, PgUp) releases the stick. Downward or
/// programmatic scrolls and content growth never do — while a turn is
/// streaming, `scrollToBottom()`'s own scroll event can observe a tall
/// chunk appended after `scrollTop` was set (distance ≥ 48px at event
/// time), and a purely positional check would misread that as the user
/// scrolling away, killing follow on every big chunk.
export function resolveStickToBottom(
  prevScrollTop: number,
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  current: boolean,
): boolean {
  const distance = scrollHeight - scrollTop - clientHeight;
  if (distance < 48) return true;
  // 1px slack: fractional scrollTop jitter under zoom is not intent.
  if (scrollTop < prevScrollTop - 1) return false;
  return current;
}

function requireChild(root: HTMLElement, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`acp-chat-view: missing ${selector}`);
  return el;
}

// -----------------------------------------------------------------------
// Rendering helpers (pure — exported where useful for future reuse/tests)
// -----------------------------------------------------------------------

/// Escape-then-format: plain text with `\n` -> `<br>` and backtick spans
/// -> `<code>`. No markdown library, and the raw agent string is escaped
/// FIRST — only the escaped string ever gets the two whitelisted tags
/// spliced in, so this is safe against untrusted agent output.
export function formatProse(text: string): string {
  const escaped = escapeHtml(text);
  const withCode = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
  return withCode.replace(/\n/g, "<br>");
}

function statusToState(status: string | null | undefined): "ok" | "running" | "fail" | "pending" {
  switch (status) {
    case "completed":
      return "ok";
    case "failed":
      return "fail";
    case "pending":
    case "in_progress":
      return "running";
    default:
      return "pending";
  }
}

/// `rawInput.command` — mirrors `ToolCallFields::command()` /
/// `PermissionToolCall::command()` in `crates/agent/src/acp/protocol.rs`.
function commandOf(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const cmd = (rawInput as { command?: unknown }).command;
  return typeof cmd === "string" ? cmd : null;
}

/// `rawInput.fileName` — edit/read-kind tool calls carry this instead of
/// `command`; mirrors `tool_call_target`'s `rawInput.fileName` fallback in
/// `crates/app/src/acp_commands.rs`.
function fileNameOf(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const name = (rawInput as { fileName?: unknown }).fileName;
  return typeof name === "string" ? name : null;
}

/// Coarse age readout for the live-console strip: "<1m", "12m", "3h".
function consoleAge(since: number): string {
  const m = Math.floor((Date.now() - since) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

/// `rawOutput.contents[].shellId` from any typed entry, if present.
/// Free-text `<shellId: N …>` mentions are NOT parsed — wording varies
/// per adapter; only the typed field is trusted.
export function shellIdOf(rawOutput: unknown): string | null {
  if (!rawOutput || typeof rawOutput !== "object") return null;
  const contents = (rawOutput as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) return null;
  for (const entry of contents) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { shellId?: unknown }).shellId;
    if (typeof id === "string") return id;
    if (typeof id === "number") return String(id);
  }
  return null;
}

/// An execute tool call that completed WITHOUT a `shell_exit` left its
/// console running (dev server, watcher). Only meaningful once the
/// adapter has proven it emits `shell_exit` at all (`sawShellExit`).
export function isBackgroundConsole(f: AcpToolCallFields, sawShellExit: boolean): boolean {
  return (
    sawShellExit &&
    f.kind === "execute" &&
    f.status === "completed" &&
    commandOf(f.rawInput) !== null &&
    exitCodeOf(f.rawOutput) === null &&
    textExitCodeOf(f.content) === null
  );
}

/// Copilot ends a foreground execute's streamed output with a free-text
/// `<shellId: N completed with exit code X>` marker; resumed sessions
/// replay only that text, without the typed `shell_exit` entry. Parse it
/// as an exit signal so finished commands aren't censused as live
/// background consoles ("26 consoles running" of dead one-shot lints).
const TEXT_EXIT_RE = /<shellId:\s*\S+ completed with exit code (-?\d+)>/;
export function textExitCodeOf(content: AcpContentBlock[]): number | null {
  const m = TEXT_EXIT_RE.exec(joinContentText(content));
  return m ? Number(m[1]) : null;
}

/// `rawOutput.contents[].exitCode` where `type === "shell_exit"` — mirrors
/// `ToolCallFields::exit_code()`.
function exitCodeOf(rawOutput: unknown): number | null {
  if (!rawOutput || typeof rawOutput !== "object") return null;
  const contents = (rawOutput as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) return null;
  for (const entry of contents) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as { type?: unknown }).type === "shell_exit" &&
      typeof (entry as { exitCode?: unknown }).exitCode === "number"
    ) {
      return (entry as { exitCode: number }).exitCode;
    }
  }
  return null;
}

function joinContentText(content: AcpContentBlock[]): string {
  const parts: string[] = [];
  for (const c of content) {
    const t = contentText(c);
    if (t !== null) parts.push(t);
  }
  return parts.join("\n");
}

interface DiffBlockLike {
  path: string;
  oldText?: string | null;
  newText: string;
}

function diffBlocksOf(content: AcpContentBlock[]): DiffBlockLike[] {
  const out: DiffBlockLike[] = [];
  for (const c of content) {
    const b = c as { path?: unknown; newText?: unknown; oldText?: unknown };
    if (typeof b.path === "string" && typeof b.newText === "string") {
      out.push({
        path: b.path,
        newText: b.newText,
        oldText: typeof b.oldText === "string" ? b.oldText : null,
      });
    }
  }
  return out;
}

/// Renders a collapsible diff block. This is a spike-level line diff, not
/// a real LCS/Myers diff: lines from `newText` that don't match the line
/// at the same index in `oldText` render as additions (green); everything
/// else renders as context. Good enough to show "this tool call edited
/// this file" at a glance; a proper diff algorithm is out of scope here.
function buildDiffBlock(d: DiffBlockLike): HTMLElement {
  const details = document.createElement("details");
  details.className = "acp-diff";
  details.open = true;
  const newLines = d.newText.split("\n");
  const oldLines = (d.oldText ?? "").split("\n");
  const rows = newLines
    .map((line, i) => {
      const isContext = d.oldText != null && oldLines[i] === line;
      const cls = isContext ? "acp-diff-ctx" : "acp-diff-add";
      const marker = isContext ? " " : "+";
      return `<div class="acp-diff-line ${cls}">${marker} ${escapeHtml(line)}</div>`;
    })
    .join("");
  details.innerHTML = `
    <summary class="acp-diff-summary">${escapeHtml(d.path)}</summary>
    <div class="acp-diff-body">${rows}</div>
  `;
  return details;
}

function optionVerb(option: AcpPermissionOption): string {
  switch (option.kind) {
    case "allow_once":
      return "Allowed once";
    case "allow_always":
      return "Allowed always";
    case "reject_once":
      return "Denied";
    default:
      return option.name ?? option.kind;
  }
}

function permAnswerLabel(option: AcpPermissionOption, command: string | null): string {
  const verb = optionVerb(option);
  return command ? `${verb} · \`${command}\`` : verb;
}
