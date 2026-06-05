import type { Operator, Sentiment, Task, TaskArchetype, TeammateMessage, TeammateThread, TeammateThreadRenamed, TeammateToolCall, UpdateKind } from "../api";
import type { OperatorDecisionRow } from "../api";
import {
  findRecentCommands,
  findSpecs,
  injectCommand, onTeammateMessage, onTeammateThreadRenamed, onTeammateToolCall, operatorLevelFromXp, primeSpawnedTab,
  operatorList, readBlockExcerpt, readSessionExcerpt,
  structureFindFiles, structureReadFile,
  teammateAttachSessionToTask, teammateArchiveThread, teammateCancelActiveTask, teammateCancelTaskProposal,
  teammateConfirmTask, teammateCreateThread, teammateEditTaskProposal,
  teammateListDecisionsForSession, teammateListMessages, teammateListTasks, teammateListThreads,
  teammateRenameThread, teammateSendText,
  type BlockExcerpt, type SessionExcerpt,
} from "../api";
import { Icons } from "../icons";
import { EMOTION_LABEL, renderAvatarHtml, type Emotion } from "../operator/avatars";
import { attachTooltip } from "../tooltip/tooltip";
import { ComposerInput } from "./composer-input";
import type { MentionSourcesDeps } from "./mention-sources";
import {
  expandMentions, MentionPopup,
  type MentionRegistry, type ReadFileFn,
} from "./mentions";
import { renderCardSegments } from "./card";
import { renderTaskCard, type TaskLifecycleEvent } from "./task-card";
import { ActivityView } from "./activity-view";
import { AomActivityFeed } from "../aom/activity-feed";
import { OperatorStrip } from "./operator-strip";
import type { OperatorStatus } from "../api";
import { listSpawns } from "../spawns/api";

const CHEVRON_DOWN_SVG =
  '<svg class="teammate-panel-header-chevron" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M4 6.5 L8 10.5 L12 6.5" fill="none" stroke="currentColor" ' +
          'stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

const ARCHETYPE_LABEL: Record<TaskArchetype, string> = {
  do: "Do", review: "Review", watch: "Watch",
};

function renderHeaderAvatarWithRing(
  operator: Operator | null,
  sentiment?: Sentiment | null,
): string {
  const xp = operator?.xp ?? 0;
  const xpProgress = Math.max(0, Math.min(1, (xp % 100) / 100));
  const emotion: Emotion = (sentiment as Emotion | undefined) ?? "neutral";
  const avatar = renderAvatarHtml(operator?.emoji ?? "🤖", 32, "", emotion);
  // Avatar wrap holds only the XP ring + avatar. The sentiment badge
  // moved next to the level pill in .teammate-panel-title-row so it
  // stops occluding the v2 character art.
  return (
    `<span class="teammate-panel-avatar-wrap" data-operator-id="${operator?.id ?? ""}" ` +
          `style="--xp-progress:${xpProgress.toFixed(3)};">` +
      `<svg class="teammate-panel-xp-ring" viewBox="0 0 32 32" aria-hidden="true">` +
        `<circle class="track" cx="16" cy="16" r="15"/>` +
        `<circle class="fill"  cx="16" cy="16" r="15"/>` +
      `</svg>` +
      `<span class="teammate-panel-avatar">${avatar}</span>` +
    `</span>`
  );
}

function renderSentimentBadge(sentiment?: Sentiment | null): string {
  if (!sentiment) return "";
  const label = EMOTION_LABEL[sentiment as Emotion] ?? sentiment;
  return `<span class="teammate-panel-sentiment teammate-panel-sentiment--${sentiment}" title="${sentiment}">${label}</span>`;
}

export interface TeammatePanelDeps {
  listMessages:  (threadId: string, limit?: number) => Promise<TeammateMessage[]>;
  sendText:      (operatorId: string, threadId: string, text: string, activeSessionId?: string | null) => Promise<TeammateMessage>;
  listOperators: () => Promise<Operator[]>;
  /// Conversation threads (ChatGPT-style). Optional so tests without
  /// thread wiring still mount — openFor falls back to a null active
  /// thread and message loads pass an empty threadId.
  listThreads?:   (operatorId: string) => Promise<TeammateThread[]>;
  createThread?:  (operatorId: string, title: string) => Promise<TeammateThread>;
  renameThread?:  (threadId: string, title: string) => Promise<void>;
  archiveThread?: (threadId: string) => Promise<void>;
  onMessage?:    (handler: (msg: TeammateMessage) => void) => Promise<() => void>;
  onToolCall?:   (handler: (call: TeammateToolCall) => void) => Promise<() => void>;
  onThreadRenamed?: (handler: (e: TeammateThreadRenamed) => void) => Promise<() => void>;
  getActiveSessionId?: () => string | null;
  /// Returns the executor (claude/codex/copilot/…) running in the active
  /// tab, or null when the foreground is a plain shell. When null, the
  /// active-tab confirm path wraps the prompt with the operator-picked
  /// executor instead of typing it raw into a shell.
  getActiveExecutor?: () => string | null;
  confirmTask?:        (operatorId: string, messageId: string) => Promise<Task>;
  cancelTaskProposal?: (messageId: string) => Promise<void>;
  editTaskProposal?:   (messageId: string, draft: import("../api").TaskDraft) => Promise<void>;
  attachSessionToTask?: (operatorId: string, taskId: string, sessionId: string) => Promise<void>;
  spawnTabForTask?: (
    task: Task,
    overrides?: { cwd?: string | null; groupId?: string | null; color?: string | null },
  ) => Promise<{ sessionId: string; cwd: string | null; groupId: string | null; color: string | null }>;
  /// Fetch all tasks for the operator (proposed/active/done). Powers the Tasks tab.
  listTasks?:       (operatorId: string) => Promise<Task[]>;
  /// Activate the tab whose backing SessionId matches. Returns true if found.
  focusTabBySessionId?: (sessionId: string) => boolean;
  /// Pin the operator to the target tab, enable it, flip live (single-tab
  /// AOM), and refresh tab state so the operator ring + status bar update
  /// in the UI. Routed through TabsManager.setTabOperator under the hood.
  bindOperatorToTab?:   (sessionId: string, operatorId: string) => Promise<void>;
  /// Cwd of the foreground tab. Used to scope file fuzzy search inside
  /// the mention popup. Null does NOT disable the popup — other sources
  /// (commands, sessions, teammates) still render.
  getActiveSessionCwd?: () => string | null;
  /// Multi-source mention picker deps (files / sessions / commands /
  /// teammates). Required — popup is always rendered.
  mentionSources:     MentionSourcesDeps;
  /// Reads file contents for `@file` chip expansion.
  readFile:           ReadFileFn;
  /// Reads a stored block's command + output for `@cmd:<block>` expansion.
  readBlockExcerpt:   (block_id: string) => Promise<BlockExcerpt>;
  /// Reads a session's cwd + last few blocks for `@session:<short>` expansion.
  readSessionExcerpt: (session_id: string) => Promise<SessionExcerpt>;
  /// True if the given sessionId still has a live tab. Used to flip
  /// the task-detail "Open tab" button into a "Continue (new tab)"
  /// action when the original spawn died (e.g., dev-reload).
  isSessionAlive?: (sessionId: string) => boolean;
  /// Backend cancel for already-active tasks (proposals use
  /// cancelTaskProposal). Wired to the task-detail "Stop" button.
  cancelActiveTask?: (taskId: string) => Promise<void>;
  /// Remove the operator binding from a tab — used by Stop so the
  /// teammate is free to take a new task elsewhere.
  unbindOperatorFromTab?: (sessionId: string) => Promise<void>;
  /// Close the tab whose backing SessionId matches. Used by Stop so
  /// "stop" really stops everything — kills the running executor and
  /// frees the slot, not just flips the task row to cancelled.
  closeTabBySessionId?: (sessionId: string) => void;
  /// Open a spec markdown file in the editor drawer when the user clicks a
  /// spec chip in a chat bubble. Path is the absolute path returned by
  /// `findSpecs`.
  openSpec?: (path: string) => void;
}

const DEFAULT_DEPS: TeammatePanelDeps = {
  listMessages:  teammateListMessages,
  sendText:      teammateSendText,
  listOperators: operatorList,
  listThreads:   teammateListThreads,
  createThread:  teammateCreateThread,
  renameThread:  teammateRenameThread,
  archiveThread: teammateArchiveThread,
  onMessage:     onTeammateMessage,
  onToolCall:    onTeammateToolCall,
  onThreadRenamed: onTeammateThreadRenamed,
  confirmTask:         teammateConfirmTask,
  cancelTaskProposal:  teammateCancelTaskProposal,
  editTaskProposal:    teammateEditTaskProposal,
  attachSessionToTask: teammateAttachSessionToTask,
  listTasks:           teammateListTasks,
  cancelActiveTask:    teammateCancelActiveTask,
  mentionSources: {
    findFiles:          structureFindFiles,
    listOperators:      operatorList,
    listOpenSessions:   () => [],
    findRecentCommands,
    findSpecs,
  },
  readFile:           structureReadFile,
  readBlockExcerpt,
  readSessionExcerpt,
};

interface SystemLineStyle {
  text: string;
  tone: "ok" | "warn" | "err" | "muted";
}

interface TaskSpawnInfo {
  sessionId: string;
  cwd: string | null;
  groupId: string | null;
  color: string | null;
}

const TASK_SPAWN_LS_KEY = "covenant.teammate.task-spawn-meta";

function loadTaskSpawnedSessions(): Map<string, TaskSpawnInfo> {
  try {
    const raw = localStorage.getItem(TASK_SPAWN_LS_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Array<[string, TaskSpawnInfo]>;
    return new Map(parsed);
  } catch {
    return new Map();
  }
}

function persistTaskSpawnedSessions(m: Map<string, TaskSpawnInfo>): void {
  try {
    localStorage.setItem(TASK_SPAWN_LS_KEY, JSON.stringify(Array.from(m.entries())));
  } catch {
    // localStorage quota / private mode — non-fatal.
  }
}

function taskUpdateSummary(kind: UpdateKind): SystemLineStyle {
  switch (kind) {
    case "started":   return { text: "Task started in a new tab.", tone: "ok" };
    case "progress":  return { text: "Update in progress.",        tone: "muted" };
    case "blocked":   return { text: "Task blocked.",              tone: "warn" };
    case "resumed":   return { text: "Task resumed.",              tone: "ok" };
    case "completed": return { text: "Task completed.",            tone: "ok" };
    case "cancelled": return { text: "Task cancelled.",            tone: "muted" };
  }
}

/// Translate known backend error strings to user-facing Spanish copy.
/// Unknown errors fall back to a generic message — the raw error still
/// lands in console.error for devs.
function friendlyError(action: "confirm" | "cancel" | "edit", raw: string): { title: string; body: string } {
  const r = raw.toLowerCase();
  if (r.includes("operator already on task")) {
    return {
      title: "Operator is already working on another task.",
      body:  "Finish or release the current task before starting this one.",
    };
  }
  if (r.includes("proposal already confirmed")) {
    return {
      title: "This proposal was already confirmed.",
      body:  "Check the Tasks tab for its status.",
    };
  }
  if (r.includes("proposal already dismissed") || r.includes("already cancelled")) {
    return {
      title: "This proposal was already cancelled.",
      body:  "Ask the operator to create a new one if you need it.",
    };
  }
  if (r.includes("not found")) {
    return {
      title: "Proposal not found.",
      body:  "It may have been deleted. Reload the conversation.",
    };
  }
  return {
    title: `Couldn't ${action} the task.`,
    body:  raw,
  };
}

export class TeammatePanel {
  private host: HTMLElement;
  private deps: TeammatePanelDeps;
  private operator: Operator | null = null;
  private roster: Operator[] = [];
  // Command of the spawn marked `default` in spawns.json, cached so the
  // synchronous buildTaskInjection() can honor it without an await. Null
  // until loaded (or if no spawn is marked default) → falls back to claude.
  private defaultExecutor: string | null = null;
  /// Latest sentiment seen per operator (keyed by OperatorId). Updated
  /// whenever a tagged operator message arrives so the avatar feels
  /// "alive" — the pose + badge follow the most recent mood across
  /// operator switches. Untagged messages don't overwrite (preserves
  /// the last real mood instead of snapping back to neutral on a
  /// model that occasionally forgets the directive).
  private currentMoodByOperator: Map<string, Sentiment> = new Map();
  /// Conversation-thread state. The chat view is scoped to activeThreadId;
  /// Tasks/Activity stay global per operator.
  private activeThreadId: string | null = null;
  private threads: TeammateThread[] = [];
  private threadDropdownOpen = false;
  private threadBarEl: HTMLElement | null = null;
  private threadEl: HTMLElement | null = null;
  private tasksEl: HTMLElement | null = null;
  private composerEl: HTMLElement | null = null;
  private tabsBarEl: HTMLElement | null = null;
  private composerInput: ComposerInput | null = null;
  private headerEl: HTMLElement | null = null;
  private switcherEl: HTMLElement | null = null;
  private dismissSwitcher: ((e: Event) => void) | null = null;
  private unlisten: (() => void) | null = null;
  private unlistenToolCall: (() => void) | null = null;
  private unlistenThreadRenamed: (() => void) | null = null;
  private viewMode: "chat" | "tasks" | "activity" = "chat";
  /// Absolute path of the most-recently-mentioned spec in this session.
  /// Used to auto-set mission on tabs spawned from a confirmed task.
  /// Cleared after consumed or after the panel is reset.
  private lastSentSpecPath: string | null = null;
  /// `@token` → executor-safe replacement (rel path for files/specs,
  /// human label for the rest). Snapshotted from `mentionRegistry` on
  /// send so we can rewrite tokens the LLM echoes back inside a
  /// propose_task draft — executors have no mention registry.
  private lastSentMentionMap: Map<string, string> = new Map();
  /// Local taskId → spawn metadata for "open tab" / Continue buttons.
  /// Populated when we spawn a tab during confirm — and mirrored to
  /// localStorage so Continue after an app restart can recreate a tab
  /// with the same cwd + group, instead of a dangling root-shell tab.
  private taskSpawnedSessions = loadTaskSpawnedSessions();
  private tasksCache: Task[] = [];
  private tasksFilter: "all" | "active" | "proposed" | "done" = "all";
  private expandedTaskIds = new Set<string>();
  private decisionsByTask = new Map<string, OperatorDecisionRow[]>();
  /// Maps `@<token>` → payload of every chip the user has picked in the
  /// current composer draft. Cleared on send.
  private mentionRegistry: MentionRegistry = new Map();
  private mentionPopup: MentionPopup | null = null;
  private activityView: ActivityView | null = null;
  private activityEl: HTMLElement | null = null;
  private operatorStrip: OperatorStrip | null = null;

  constructor(host: HTMLElement, deps: TeammatePanelDeps = DEFAULT_DEPS) {
    this.host = host;
    this.deps = deps;
  }

  isOpen(): boolean { return this.operator !== null; }

  /// Push one `operator-status` event into the per-pane strip. Called by
  /// main.ts's `operator-status` listener. Safe before the header mounts
  /// (no-op until the strip exists).
  setOperatorStatus(s: OperatorStatus): void {
    this.operatorStrip?.apply(s);
  }

  /// Drop a closed session's row from the strip.
  removeOperatorStatus(sessionId: string): void {
    this.operatorStrip?.remove(sessionId);
  }

  /// Resolve the executor command of the spawn marked `default` in
  /// spawns.json and cache it for buildTaskInjection(). Non-fatal: on any
  /// error (or no default marked) we leave defaultExecutor null and fall
  /// back to "claude".
  private async loadDefaultExecutor(): Promise<void> {
    try {
      const specs = await listSpawns();
      const def = specs.find((s) => s.default);
      this.defaultExecutor = def?.command?.trim() || null;
    } catch (e) {
      console.error("loadDefaultExecutor failed", e);
      this.defaultExecutor = null;
    }
  }

  async openFor(operator: Operator): Promise<void> {
    this.operator = operator;
    this.viewMode = "chat";
    this.host.innerHTML = "";
    this.host.classList.add("teammate-panel");
    if (operator.color) {
      this.host.style.setProperty("--operator-color", operator.color);
    } else {
      this.host.style.removeProperty("--operator-color");
    }
    // Load (or seed) conversation threads before painting so the thread
    // bar renders with a title and the message load is thread-scoped.
    // When thread deps are absent (tests), activeThreadId stays null and
    // the message load passes an empty threadId — the panel still mounts.
    await this.loadThreads(operator.id);
    this.host.append(
      this.renderHeader(),
      this.renderThreadBar(),
      this.renderTabsBar(),
      this.renderThread(),
      this.renderTasksView(),
      this.renderActivityView(),
      this.renderComposer(),
    );
    this.applyViewMode();
    const [messages] = await Promise.all([
      this.deps.listMessages(this.activeThreadId ?? "", 200),
      this.deps.listOperators().then((ops) => { this.roster = ops; }).catch(() => { /* ignore */ }),
      this.refreshTasks(),
      this.loadDefaultExecutor(),
    ]);
    // Backfill the operator's mood from history: scan messages newest-
    // first and adopt the first non-null sentiment we find. Keeps the
    // header avatar pose stable across reloads instead of flickering
    // through neutral on first paint.
    if (this.operator) {
      const opId = this.operator.id;
      for (let i = messages.length - 1; i >= 0; i--) {
        const s = messages[i]?.sentiment;
        if (s) {
          this.currentMoodByOperator.set(opId, s);
          break;
        }
      }
    }
    this.paintMessages(messages);
    if (!this.unlisten && this.deps.onMessage) {
      this.unlisten = await this.deps.onMessage((m) => this.onIncomingMessage(m));
    }
    if (!this.unlistenToolCall && this.deps.onToolCall) {
      this.unlistenToolCall = await this.deps.onToolCall((c) => this.onIncomingToolCall(c));
    }
    if (!this.unlistenThreadRenamed && this.deps.onThreadRenamed) {
      this.unlistenThreadRenamed = await this.deps.onThreadRenamed((e) => this.onThreadRenamed(e));
    }
  }

  private onThreadRenamed(e: TeammateThreadRenamed): void {
    const t = this.threads.find((th) => th.id === e.thread_id);
    if (!t) return;
    t.title = e.title;
    this.paintThreadBar();
  }

  close(): void {
    this.closeSwitcher();
    this.unlisten?.();
    this.unlisten = null;
    this.unlistenToolCall?.();
    this.unlistenToolCall = null;
    this.unlistenThreadRenamed?.();
    this.unlistenThreadRenamed = null;
    this.activityView?.stop();
    this.activityView = null;
    this.activityEl = null;
    AomActivityFeed.suppress = false;
    this.mentionPopup?.destroy();
    this.mentionPopup = null;
    this.mentionRegistry.clear();
    this.taskSpawnedSessions.clear();
    this.lastSentSpecPath = null;
    this.lastSentMentionMap.clear();
    this.composerInput = null;
    this.operator = null;
    this.host.style.removeProperty("--operator-color");
    this.host.innerHTML = "";
    this.host.classList.remove("teammate-panel");
  }

  async send(text: string): Promise<void> {
    if (!this.operator) return;
    if (!text.trim()) return;
    const activeId = this.deps.getActiveSessionId?.() ?? null;
    let payload = text.trim();
    if (this.mentionRegistry.size > 0) {
      // Remember the first spec mention so a task spawned from this
      // message auto-sets its mission. Most-recent wins if multiple
      // sends happen before a confirm.
      this.lastSentMentionMap = new Map();
      for (const [token, p] of this.mentionRegistry) {
        if (p.kind === "specs") {
          // Spec chips win for the "read this first" prefix.
          if (!this.lastSentSpecPath) this.lastSentSpecPath = p.abs;
          this.lastSentMentionMap.set(`@${token}`, p.abs);
        } else if (p.kind === "files") {
          // File chips also become read-first targets when no spec was
          // picked — users often drop a spec file via the files source
          // rather than the specs source (e.g. fuzzy-found .md).
          if (!this.lastSentSpecPath) this.lastSentSpecPath = p.abs;
          this.lastSentMentionMap.set(`@${token}`, p.rel);
        } else if (p.kind === "teammates") {
          this.lastSentMentionMap.set(`@${token}`, p.name);
        } else {
          this.lastSentMentionMap.set(`@${token}`, token);
        }
      }
      const expanded = await expandMentions(payload, this.mentionRegistry, this.deps.readFile, {
        readBlock:   this.deps.readBlockExcerpt,
        readSession: this.deps.readSessionExcerpt,
      });
      payload = expanded.text;
    }
    // Clear the composer immediately so the user can keep typing —
    // even if sendText errors below. Stale chips lock the input.
    this.composerInput?.clear();
    this.composerInput?.focus();
    this.mentionRegistry.clear();
    try {
      const msg = await this.deps.sendText(this.operator.id, this.activeThreadId ?? "", payload, activeId);
      this.appendBubble(msg);
      this.setTyping(true);
    } catch (e) {
      console.error("teammate sendText failed", e);
    }
  }

  /// Load the operator's threads (most-recent first). Seeds a first
  /// "New conversation" thread when the operator has none. Sets
  /// this.threads + this.activeThreadId. No-op (null active) when thread
  /// deps are absent so the panel still renders in tests.
  private async loadThreads(operatorId: string): Promise<void> {
    this.threadDropdownOpen = false;
    if (!this.deps.listThreads) {
      this.threads = [];
      this.activeThreadId = null;
      return;
    }
    let threads: TeammateThread[] = [];
    try {
      threads = await this.deps.listThreads(operatorId);
    } catch (e) {
      console.error("listThreads failed", e);
      threads = [];
    }
    if (threads.length === 0 && this.deps.createThread) {
      try {
        const t = await this.deps.createThread(operatorId, "New conversation");
        threads = [t];
      } catch (e) {
        console.error("createThread (seed) failed", e);
      }
    }
    this.threads = threads;
    this.activeThreadId = threads[0]?.id ?? null;
  }

  /// Reload + repaint messages for the active thread. DRYs the load used
  /// by openFor, thread switching, and the trash button.
  private async reloadActiveThreadMessages(): Promise<void> {
    const messages = await this.deps.listMessages(this.activeThreadId ?? "", 200);
    this.paintMessages(messages);
  }

  private renderThreadBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "teammate-thread-bar";
    this.threadBarEl = bar;
    this.paintThreadBar();
    return bar;
  }

  private activeThread(): TeammateThread | null {
    return this.threads.find((t) => t.id === this.activeThreadId) ?? null;
  }

  private paintThreadBar(): void {
    const bar = this.threadBarEl;
    if (!bar) return;
    bar.innerHTML = "";
    // Hide the bar entirely when thread deps are absent (tests / no
    // backend) — nothing to switch between.
    if (!this.deps.listThreads) {
      bar.classList.add("is-hidden");
      return;
    }
    bar.classList.remove("is-hidden");

    const active = this.activeThread();
    const row = document.createElement("button");
    row.type = "button";
    row.className = "teammate-thread-current";
    if (this.threadDropdownOpen) row.classList.add("is-open");
    const titleSpan = document.createElement("span");
    titleSpan.className = "teammate-thread-current-title";
    titleSpan.textContent = active?.title ?? "New conversation";
    const chev = document.createElement("span");
    chev.className = "teammate-thread-chev";
    chev.innerHTML = CHEVRON_DOWN_SVG;
    row.append(titleSpan, chev);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      // Don't toggle while an inline rename is active.
      if (titleSpan.isContentEditable) return;
      this.threadDropdownOpen = !this.threadDropdownOpen;
      this.paintThreadBar();
    });
    // Double-click the active title → inline rename.
    titleSpan.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (active) this.beginRename(titleSpan, active);
    });
    bar.append(row);

    if (this.threadDropdownOpen) bar.append(this.renderThreadDropdown());
  }

  private renderThreadDropdown(): HTMLElement {
    const dd = document.createElement("div");
    dd.className = "teammate-thread-dropdown";

    const create = document.createElement("button");
    create.type = "button";
    create.className = "teammate-thread-new";
    create.textContent = "+ New thread";
    create.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleNewThread();
    });
    dd.append(create);

    for (const t of this.threads) {
      const item = document.createElement("div");
      item.className = "teammate-thread-item";
      if (t.id === this.activeThreadId) item.classList.add("is-active");

      const main = document.createElement("button");
      main.type = "button";
      main.className = "teammate-thread-item-main";
      main.innerHTML =
        `<span class="teammate-thread-item-check">${t.id === this.activeThreadId ? "✓" : ""}</span>` +
        `<span class="teammate-thread-item-title"></span>` +
        `<span class="teammate-thread-item-time">${threadRelTime(t.last_message_at_unix_ms)}</span>`;
      const titleEl = main.querySelector<HTMLElement>(".teammate-thread-item-title");
      if (titleEl) titleEl.textContent = t.title;
      main.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.switchThread(t.id);
      });
      item.append(main);

      const archive = document.createElement("button");
      archive.type = "button";
      archive.className = "teammate-thread-item-archive";
      archive.innerHTML = Icons.trash({ size: 12 });
      attachTooltip(archive, "Archive thread");
      archive.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.handleArchiveThread(t.id);
      });
      item.append(archive);

      dd.append(item);
    }
    return dd;
  }

  private beginRename(titleSpan: HTMLElement, thread: TeammateThread): void {
    titleSpan.contentEditable = "true";
    titleSpan.classList.add("is-editing");
    titleSpan.focus();
    const range = document.createRange();
    range.selectNodeContents(titleSpan);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    let committed = false;
    const commit = (save: boolean) => {
      if (committed) return;
      committed = true;
      titleSpan.contentEditable = "false";
      titleSpan.classList.remove("is-editing");
      const next = (titleSpan.textContent ?? "").trim();
      if (save && next && next !== thread.title) {
        thread.title = next;
        void this.deps.renameThread?.(thread.id, next).catch((e) =>
          console.error("renameThread failed", e),
        );
      }
      titleSpan.textContent = thread.title;
    };
    titleSpan.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    titleSpan.addEventListener("blur", () => commit(true), { once: true });
  }

  private async handleNewThread(): Promise<void> {
    if (!this.operator || !this.deps.createThread) return;
    try {
      const t = await this.deps.createThread(this.operator.id, "New conversation");
      this.threads.unshift(t);
      this.activeThreadId = t.id;
      this.threadDropdownOpen = false;
      this.paintThreadBar();
      await this.reloadActiveThreadMessages();
    } catch (e) {
      console.error("createThread failed", e);
    }
  }

  private async switchThread(threadId: string): Promise<void> {
    if (threadId === this.activeThreadId) {
      this.threadDropdownOpen = false;
      this.paintThreadBar();
      return;
    }
    this.activeThreadId = threadId;
    this.threadDropdownOpen = false;
    this.paintThreadBar();
    await this.reloadActiveThreadMessages();
  }

  /// Archive a specific thread. If it was active, fall to the most-recent
  /// remaining thread (or seed a fresh one) and reload the chat view.
  private async handleArchiveThread(threadId: string): Promise<void> {
    if (!this.operator) return;
    try {
      await this.deps.archiveThread?.(threadId);
    } catch (e) {
      console.error("archiveThread failed", e);
      return;
    }
    const wasActive = threadId === this.activeThreadId;
    this.threads = this.threads.filter((t) => t.id !== threadId);
    if (wasActive) {
      if (this.threads.length === 0 && this.deps.createThread) {
        try {
          const t = await this.deps.createThread(this.operator.id, "New conversation");
          this.threads = [t];
        } catch (e) {
          console.error("createThread (after archive) failed", e);
        }
      }
      this.activeThreadId = this.threads[0]?.id ?? null;
      await this.reloadActiveThreadMessages();
    }
    this.paintThreadBar();
  }

  private renderHeader(): HTMLElement {
    const h = document.createElement("button");
    h.type = "button";
    h.className = "teammate-panel-header";
    h.setAttribute("aria-label", "Switch teammate");
    const op = this.operator;
    const level = operatorLevelFromXp(op?.xp ?? 0);
    const sentiment = op ? this.currentMoodByOperator.get(op.id) ?? null : null;
    // Scope --operator-color to the header so the level pill (inline
    // next to the name) and the XP ring fill both pick up the operator's
    // chosen color without a separate JS path per element. Falls through
    // to --accent for any element that uses var(--operator-color, ...).
    if (op?.color) h.style.setProperty("--operator-color", op.color);
    // Level pill sits inline next to the operator name (was previously
    // overlaid on the avatar's chin and occluded the v2 character art).
    // Pre-formatted "Lv N" — short enough to read at 11px without
    // crowding the name. Hidden when op is null (no operator selected).
    const levelPill = op
      ? `<span class="teammate-panel-level">Lv ${level}</span>`
      : "";
    h.innerHTML = `
      ${renderHeaderAvatarWithRing(op, sentiment)}
      <span class="teammate-panel-titlebox">
        <span class="teammate-panel-title-row">
          <span class="teammate-panel-title-name">${escapeHtml(op?.name ?? "")}</span>
          ${levelPill}
          ${renderSentimentBadge(sentiment)}
        </span>
        <span class="teammate-panel-subtitle" data-role="subtitle">${escapeHtml(op?.model ?? "")}</span>
      </span>
      ${CHEVRON_DOWN_SVG}
    `;
    h.addEventListener("click", () => this.toggleSwitcher());
    // Per-pane operator status strip (Phase 2). Lives under the header so
    // it's always visible above the thread, fed by `operator-status`. It
    // wraps onto its own full-width row via flex-wrap + order:99, so it
    // renders below the avatar cluster regardless of DOM order. Inserted
    // BEFORE the trailing chevron to keep the chevron the last element
    // child (a header invariant asserted in panel.test.ts).
    const stripHost = document.createElement("div");
    stripHost.className = "teammate-panel-operator-strip-host";
    const chevron = h.querySelector(".teammate-panel-header-chevron");
    if (chevron) h.insertBefore(stripHost, chevron);
    else h.appendChild(stripHost);
    this.operatorStrip = new OperatorStrip(stripHost);
    this.headerEl = h;
    return h;
  }

  /// Swap just the avatar wrap inside the header in-place. Called when a
  /// new sentiment lands so the avatar pose + badge update without
  /// disturbing the rest of the header (model label, chevron, switcher
  /// open state). No-op when the header hasn't been rendered yet.
  ///
  /// The level pill is NOT touched here — it lives next to the name
  /// (.teammate-panel-title-row .teammate-panel-level) and only
  /// changes when XP crosses a level boundary, which happens on a full
  /// render path (operator switch, XP award refresh), not on every
  /// inbound message.
  private refreshHeaderAvatar(): void {
    const header = this.headerEl;
    if (!header) return;
    const wrap = header.querySelector(".teammate-panel-avatar-wrap");
    if (!wrap) return;
    const op = this.operator;
    const sentiment = op ? this.currentMoodByOperator.get(op.id) ?? null : null;
    // Replace the whole wrap rather than mutate children — keeps the
    // XP-progress CSS var and the SVG ring in lockstep with the avatar.
    const tmp = document.createElement("div");
    tmp.innerHTML = renderHeaderAvatarWithRing(op, sentiment);
    const fresh = tmp.firstElementChild;
    if (fresh) wrap.replaceWith(fresh);
    // Sentiment badge lives next to the level pill in the title row; swap
    // it in-place so the mood updates without rebuilding the whole header.
    const titleRow = header.querySelector(".teammate-panel-title-row");
    if (titleRow) {
      const oldBadge = titleRow.querySelector(".teammate-panel-sentiment");
      const tmp2 = document.createElement("div");
      tmp2.innerHTML = renderSentimentBadge(sentiment);
      const newBadge = tmp2.firstElementChild;
      if (oldBadge && newBadge) oldBadge.replaceWith(newBadge);
      else if (oldBadge) oldBadge.remove();
      else if (newBadge) titleRow.appendChild(newBadge);
    }
  }

  private renderTabsBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "teammate-panel-tabs";
    bar.append(
      this.renderTabButton("chat",  "Chat"),
      this.renderTabButton("tasks", "Tasks"),
      this.renderTabButton("activity", "Activity"),
      this.renderResetButton(),
    );
    this.tabsBarEl = bar;
    return bar;
  }

  private renderResetButton(): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "teammate-panel-reset";
    b.setAttribute("aria-label", "Delete this thread");
    b.innerHTML = Icons.trash({ size: 14 });
    attachTooltip(b, "Delete this thread");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleResetClick();
    });
    return b;
  }

  /// Trash button — archives the ACTIVE thread (non-destructive: data is
  /// retained, just hidden) and switches to the most-recent remaining
  /// thread, seeding a fresh one if none remain. Tasks/Activity are
  /// global and untouched.
  private async handleResetClick(): Promise<void> {
    if (!this.operator) return;
    if (!this.activeThreadId || !this.deps.archiveThread) {
      // No thread wiring (tests / no backend) — nothing to archive.
      return;
    }
    await this.handleArchiveThread(this.activeThreadId);
  }

  private renderTabButton(mode: "chat" | "tasks" | "activity", label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "teammate-panel-tab";
    b.dataset.tab = mode;
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    b.append(labelSpan);
    if (mode === "tasks" || mode === "activity") {
      const count = document.createElement("span");
      count.className = "teammate-panel-tab-count is-empty";
      count.dataset.role = mode === "tasks" ? "count" : "activity-count";
      b.append(count);
    }
    b.addEventListener("click", () => {
      if (this.viewMode === mode) return;
      this.viewMode = mode;
      this.applyViewMode();
      if (mode === "tasks") void this.refreshTasks();
    });
    return b;
  }

  private applyViewMode(): void {
    if (!this.tabsBarEl) return;
    for (const tab of this.tabsBarEl.querySelectorAll<HTMLElement>(".teammate-panel-tab")) {
      tab.classList.toggle("is-active", tab.dataset.tab === this.viewMode);
    }
    const chat = this.viewMode === "chat";
    const activity = this.viewMode === "activity";
    // Use a class instead of the `hidden` attribute — the existing
    // `.teammate-panel-thread` rule sets `display: flex`, which beats
    // the attribute's default `display: none`. Class is `!important` in CSS.
    this.threadEl?.classList.toggle("is-hidden", !chat);
    this.composerEl?.classList.toggle("is-hidden", !chat);
    this.tasksEl?.classList.toggle("is-hidden", this.viewMode !== "tasks");
    this.activityEl?.classList.toggle("is-hidden", !activity);
    // Tell the activity view whether it's visible so it can manage the badge.
    this.activityView?.setVisible(activity);
  }

  private renderThread(): HTMLElement {
    const t = document.createElement("div");
    t.className = "teammate-panel-thread";
    t.addEventListener("click", (e) => {
      const chip = (e.target as HTMLElement | null)?.closest<HTMLElement>(
        ".teammate-mention-chip",
      );
      if (!chip) return;
      e.preventDefault();
      const kind = chip.dataset.mentionKind;
      if (kind === "file") {
        const path = chip.dataset.filePath;
        if (path && this.deps.openSpec) this.deps.openSpec(path);
        return;
      }
      const id = chip.dataset.specId;
      const path = chip.dataset.specPath;
      if (path && this.deps.openSpec) {
        this.deps.openSpec(path);
      } else if (id) {
        void this.openSpecById(id);
      }
    });
    this.threadEl = t;
    return t;
  }

  private async openSpecById(id: string): Promise<void> {
    if (!this.deps.openSpec) return;
    const cwd = this.deps.getActiveSessionCwd?.() ?? "";
    try {
      const hits = await this.deps.mentionSources.findSpecs(cwd, id, 20);
      const match = hits.find((h) => h.id === id) ?? hits[0];
      if (match) this.deps.openSpec(match.abs_path);
    } catch (e) {
      console.error("openSpec failed", e);
    }
  }

  private renderTasksView(): HTMLElement {
    const t = document.createElement("div");
    t.className = "teammate-panel-tasks is-hidden";
    this.tasksEl = t;
    return t;
  }

  private renderActivityView(): HTMLElement {
    this.activityView = new ActivityView();
    this.activityEl = this.activityView.getElement();
    this.activityEl.classList.add("is-hidden");
    const opId = this.operator?.id ?? "";
    void this.activityView.start(opId, (count) => {
      this.updateActivityBadge(count);
    });
    // Suppress floating toasts — decisions now flow into the sidebar.
    AomActivityFeed.suppress = true;
    return this.activityEl;
  }

  private updateActivityBadge(count: number): void {
    if (!this.tabsBarEl) return;
    const badge = this.tabsBarEl.querySelector<HTMLElement>('[data-role="activity-count"]');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = String(count);
      badge.classList.remove("is-empty");
    } else {
      badge.textContent = "";
      badge.classList.add("is-empty");
    }
  }

  private renderComposer(): HTMLElement {
    const c = document.createElement("form");
    c.className = "teammate-panel-composer";
    const composer = new ComposerInput(c, {
      placeholder: `Message ${this.operator?.name ?? ""}…  (type @ to mention)`,
    });
    this.composerInput = composer;
    composer.onSubmit(() => { void this.send(composer.getValue()); });
    c.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send(composer.getValue());
    });
    this.composerEl = c;

    // Reset draft-scoped mention map when the user clears the composer.
    composer.onInput(() => {
      if (composer.getValue().length === 0) this.mentionRegistry.clear();
    });

    this.mentionPopup?.destroy();
    this.mentionPopup = new MentionPopup({
      input: composer,
      anchor: c,
      getCwd: () => this.deps.getActiveSessionCwd?.() ?? null,
      sources: this.deps.mentionSources,
      onPick: (chip, hit) => { this.mentionRegistry.set(chip.token, hit.payload); },
    });
    return c;
  }

  private async refreshTasks(): Promise<void> {
    if (!this.operator || !this.deps.listTasks) return;
    try {
      this.tasksCache = await this.deps.listTasks(this.operator.id);
    } catch (e) {
      console.error("listTasks failed", e);
      this.tasksCache = [];
    }
    this.paintTasks();
    this.updateTasksCount();
    this.updateHeaderWorkingState();
  }

  /// Active = the operator currently has something open. Drives the
  /// header's "is-working" state (animated ring + subtitle showing the
  /// task title instead of the model name).
  private firstWorkingTask(): Task | null {
    return this.tasksCache.find((t) => {
      if (t.status !== "active" && t.status !== "blocked") return false;
      // An active task whose tab/session is gone isn't actually running —
      // e.g. after an app restart or the tab was closed. Don't light up the
      // header working ring for it (it reads as "Mibli is busy" / AOM-on when
      // nothing is executing). The task stays active so it can be reopened.
      const sid = this.taskSpawnedSessions.get(t.id)?.sessionId ?? t.spawned_session;
      if (!sid) return false;
      return this.deps.isSessionAlive?.(sid) ?? true;
    }) ?? null;
  }

  private updateHeaderWorkingState(): void {
    if (!this.headerEl) return;
    const task = this.firstWorkingTask();
    const sub = this.headerEl.querySelector<HTMLElement>('[data-role="subtitle"]');
    if (!sub) return;
    if (task) {
      this.headerEl.classList.add("is-working");
      sub.classList.add("teammate-panel-subtitle--working");
      sub.innerHTML = `
        <span class="teammate-panel-subtitle__dot" aria-hidden="true"></span>
        <span class="teammate-panel-subtitle__task">${escapeHtml(task.title)}</span>
      `;
      sub.title = task.title;
    } else {
      this.headerEl.classList.remove("is-working");
      sub.classList.remove("teammate-panel-subtitle--working");
      sub.textContent = this.operator?.model ?? "";
      sub.removeAttribute("title");
    }
  }

  private updateTasksCount(): void {
    const countEl = this.tabsBarEl?.querySelector<HTMLElement>('[data-role="count"]');
    if (!countEl) return;
    const open = this.tasksCache.filter(
      (t) => t.status === "active" || t.status === "blocked",
    ).length;
    countEl.textContent = open > 0 ? String(open) : "";
    countEl.classList.toggle("is-empty", open === 0);
  }

  private paintTasks(): void {
    if (!this.tasksEl) return;
    this.tasksEl.innerHTML = "";
    this.tasksEl.append(this.renderTaskFilters());

    if (this.tasksCache.length === 0) {
      const empty = document.createElement("div");
      empty.className = "teammate-panel-empty";
      empty.textContent = "No tasks yet. Ask your operator for one.";
      this.tasksEl.append(empty);
      return;
    }

    const filtered = this.tasksCache.filter((t) => this.matchesFilter(t));
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "teammate-panel-empty";
      empty.textContent = "No tasks match this filter.";
      this.tasksEl.append(empty);
      return;
    }

    const list = document.createElement("div");
    list.className = "task-list";

    // Order: active first, then blocked, then proposed/draft, then done, then cancelled.
    const order: Record<Task["status"], number> = {
      active: 0, blocked: 1, draft: 2, done: 3, cancelled: 4,
    };
    const sorted = [...filtered].sort((a, b) => {
      const oa = order[a.status] ?? 99;
      const ob = order[b.status] ?? 99;
      if (oa !== ob) return oa - ob;
      return b.updated_at_unix_ms - a.updated_at_unix_ms;
    });

    for (const t of sorted) list.append(this.renderTaskItem(t));
    this.tasksEl.append(list);
  }

  private matchesFilter(t: Task): boolean {
    switch (this.tasksFilter) {
      case "all":      return true;
      case "active":   return t.status === "active" || t.status === "blocked";
      case "proposed": return t.status === "draft";
      case "done":     return t.status === "done" || t.status === "cancelled";
    }
  }

  private renderTaskFilters(): HTMLElement {
    const row = document.createElement("div");
    row.className = "task-filters";
    type Filter = "all" | "active" | "proposed" | "done";
    const chips: { id: Filter; label: string }[] = [
      { id: "all",      label: "All" },
      { id: "active",   label: "Active" },
      { id: "proposed", label: "Proposed" },
      { id: "done",     label: "Done" },
    ];
    for (const c of chips) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "task-filter-chip";
      b.dataset.filter = c.id;
      b.textContent = c.label;
      if (this.tasksFilter === c.id) b.classList.add("is-on");
      b.addEventListener("click", () => {
        if (this.tasksFilter === c.id) return;
        this.tasksFilter = c.id;
        this.paintTasks();
      });
      row.append(b);
    }
    return row;
  }

  private renderTaskItem(task: Task): HTMLElement {
    const item = document.createElement("div");
    item.className = `task-item task-item--${task.status}`;
    item.dataset.taskId = task.id;
    const isOpen = this.expandedTaskIds.has(task.id);
    if (isOpen) item.classList.add("is-open");

    item.append(this.renderTaskHead(task));
    if (isOpen) item.append(this.renderTaskBody(task));

    return item;
  }

  private renderTaskHead(task: Task): HTMLElement {
    const head = document.createElement("div");
    head.className = "task-item__head";

    const dot = document.createElement("span");
    dot.className = "task-item__status";
    head.append(dot);

    const title = document.createElement("div");
    title.className = "task-item__title";
    title.textContent = task.title;
    head.append(title);

    const chev = document.createElement("span");
    chev.className = "task-item__chev";
    chev.textContent = "›";
    chev.setAttribute("aria-hidden", "true");
    head.append(chev);

    const meta = document.createElement("div");
    meta.className = "task-item__meta";
    const badge = document.createElement("span");
    badge.className = "task-card__badge";
    badge.dataset.archetype = task.archetype;
    badge.textContent = ARCHETYPE_LABEL[task.archetype];
    meta.append(badge);
    meta.append(textSpan(`${statusLabel(task.status)} · ${formatAge(task.updated_at_unix_ms)}`));
    if (task.spawned_session) {
      meta.append(dotSep());
      meta.append(textSpan(`tab ${task.spawned_session.slice(0, 6)}`));
    }
    head.append(meta);

    head.addEventListener("click", () => this.toggleTaskExpansion(task));
    return head;
  }

  private toggleTaskExpansion(task: Task): void {
    if (this.expandedTaskIds.has(task.id)) {
      this.expandedTaskIds.delete(task.id);
    } else {
      this.expandedTaskIds.add(task.id);
      // Kick off a decisions fetch (cached after the first hit).
      if (task.spawned_session && !this.decisionsByTask.has(task.id)) {
        void teammateListDecisionsForSession(task.spawned_session, 20)
          .then((rows) => {
            this.decisionsByTask.set(task.id, rows);
            if (this.expandedTaskIds.has(task.id)) this.paintTasks();
          })
          .catch((e) => console.error("listDecisionsForSession failed", e));
      }
    }
    this.paintTasks();
  }

  private renderTaskBody(task: Task): HTMLElement {
    const body = document.createElement("div");
    body.className = "task-item__body";

    // --- Executor strip (looks up the executor from the propose msg) ---
    const exec = this.executorForTask(task);
    if (exec) body.append(this.renderExecStrip(exec));

    // --- 3-up stats: decisions / cost / status-age ---
    body.append(this.renderTaskStats(task));

    // --- Compact lifecycle timeline ---
    body.append(this.renderTaskTimeline(task));

    // --- Decisions feed (last 8) ---
    body.append(this.renderTaskDecisions(task));

    // --- Action row: Open tab + Stop ---
    body.append(this.renderTaskActions(task));

    return body;
  }

  private executorForTask(task: Task): string | null {
    return this.executorByTaskId.get(task.id) ?? null;
  }

  private renderExecStrip(executor: string): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "exec-strip";
    const logo = document.createElement("span");
    logo.className = "exec-strip__logo";
    logo.textContent = executorGlyph(executor);
    const name = document.createElement("span");
    name.className = "exec-strip__name";
    name.textContent = executor;
    strip.append(logo, name);
    return strip;
  }

  private renderTaskStats(task: Task): HTMLElement {
    const stats = document.createElement("div");
    stats.className = "task-stats";
    const decisions = this.decisionsByTask.get(task.id);
    const decisionsCount = decisions?.length ?? null;
    const cost = (task.cost_usd_cents / 100).toFixed(2);
    const age = formatAge(task.updated_at_unix_ms);
    stats.append(
      statTile("Decisions", decisionsCount === null ? "…" : String(decisionsCount),
        decisionsCount === null ? "loading" : decisionsBreakdown(decisions ?? [])),
      statTile("Cost", `$${cost}`, "USD spent"),
      statTile("Age", age, statusLabel(task.status)),
    );
    return stats;
  }

  private renderTaskTimeline(task: Task): HTMLElement {
    const t = document.createElement("div");
    t.className = "task-timeline";
    const steps: Array<"done" | "current" | "future"> = (() => {
      switch (task.status) {
        case "draft":     return ["current", "future", "future", "future"];
        case "active":    return ["done", "done", "current", "future"];
        case "blocked":   return ["done", "done", "current", "future"];
        case "done":      return ["done", "done", "done", "current"];
        case "cancelled": return ["done", "done", "future", "future"];
      }
    })();
    const labels = ["Proposed", "Started", "Active", "Done"];
    const currentIdx = steps.findIndex((s) => s === "current");
    const currentLabel = currentIdx >= 0 ? labels[currentIdx] : "";
    steps.forEach((state, i) => {
      const dot = document.createElement("span");
      dot.className = `task-timeline__dot task-timeline__dot--${state}`;
      t.append(dot);
      if (i < steps.length - 1) {
        const bar = document.createElement("span");
        const done = state === "done";
        bar.className = `task-timeline__bar${done ? " task-timeline__bar--done" : ""}`;
        t.append(bar);
        if (state === "current") {
          const label = document.createElement("span");
          label.className = "task-timeline__label";
          label.textContent = `${currentLabel} · ${formatAge(task.updated_at_unix_ms)} ago`;
          t.append(label);
        }
      }
    });
    return t;
  }

  private renderTaskDecisions(task: Task): HTMLElement {
    const section = document.createElement("div");
    section.className = "task-section";
    const title = document.createElement("div");
    title.className = "task-section__title";
    title.textContent = "Decisions";
    const decisions = this.decisionsByTask.get(task.id) ?? [];
    if (decisions.length) {
      const count = document.createElement("span");
      count.className = "task-section__count";
      count.textContent = String(decisions.length);
      title.append(count);
    }
    section.append(title);

    if (!task.spawned_session) {
      section.append(emptyLine("No attached session yet."));
      return section;
    }
    if (!this.decisionsByTask.has(task.id)) {
      section.append(emptyLine("Loading…"));
      return section;
    }
    if (decisions.length === 0) {
      section.append(emptyLine("No decisions recorded yet."));
      return section;
    }

    const list = document.createElement("div");
    list.className = "decisions";
    for (const d of decisions.slice(0, 8)) list.append(renderDecision(d));
    section.append(list);
    return section;
  }

  private renderTaskActions(task: Task): HTMLElement {
    const actions = document.createElement("div");
    actions.className = "task-actions";

    const recordedSid = task.spawned_session ?? this.taskSpawnedSessions.get(task.id)?.sessionId ?? null;
    const sessionLive = !!recordedSid && (this.deps.isSessionAlive?.(recordedSid) ?? true);
    const closed = task.status === "done" || task.status === "cancelled";

    // Open / Continue button — only when there's something to open.
    if (sessionLive && recordedSid) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "btn btn--primary";
      open.textContent = "Open tab";
      open.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deps.focusTabBySessionId?.(recordedSid);
      });
      actions.append(open);
    } else if (!closed && this.deps.spawnTabForTask) {
      // Spawn died (likely a dev reload) — offer to respawn into a
      // fresh tab so the task is recoverable instead of orphaned.
      const open = document.createElement("button");
      open.type = "button";
      open.className = "btn btn--primary";
      open.textContent = "Continue in new tab";
      open.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await this.respawnAndInject(task);
        } catch (err) {
          console.error("respawn tab failed", err);
        }
      });
      actions.append(open);
    }

    // Stop button — only meaningful while the task is still running.
    // A done/cancelled task has nothing to stop, so we omit the button
    // entirely rather than leaving a dead, disabled control on the card.
    if (closed) {
      // Collapse to a single column (or no row at all) so we don't leave
      // a lopsided/empty actions grid behind.
      if (actions.childElementCount === 0) actions.style.display = "none";
      else actions.style.gridTemplateColumns = "1fr";
      return actions;
    }

    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "btn btn--danger";
    stop.textContent = "Stop";
    stop.disabled = !this.deps.cancelActiveTask;
    stop.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!this.deps.cancelActiveTask) return;
      stop.disabled = true;
      try {
        await this.deps.cancelActiveTask(task.id);
        // Free the operator from the spawned tab so the user (and any
        // other task) can bind it elsewhere immediately.
        if (recordedSid && this.deps.unbindOperatorFromTab) {
          await this.deps.unbindOperatorFromTab(recordedSid).catch((err) =>
            console.error("unbindOperatorFromTab failed", err),
          );
        }
        // Then close the spawned tab itself so Stop actually stops the
        // running executor process, not just marks the task cancelled.
        if (recordedSid) this.deps.closeTabBySessionId?.(recordedSid);
        void this.refreshTasks();
      } catch (err) {
        console.error("cancelActiveTask failed", err);
        stop.disabled = false;
      }
    });
    actions.append(stop);
    return actions;
  }

  /// Cache mapping task_id → executor name (lifted from the propose msg).
  /// Populated in paintMessages and refreshed by refreshTasks.
  private executorByTaskId = new Map<string, string>();

  /// Lifecycle events (started/cancelled/resumed/…) grouped by task id, so a
  /// confirmed task's pill renders them in its drawer instead of as loose
  /// system rows. Rebuilt every paintMessages.
  private lifecycleByTaskId = new Map<string, TaskLifecycleEvent[]>();
  /// Task ids that have a propose card in the current thread — their
  /// task_update messages are owned by the pill drawer, not painted as rows.
  private tasksWithCard = new Set<string>();

  private paintMessages(msgs: TeammateMessage[]): void {
    // Lift task_id → executor from propose messages so renderTaskBody
    // can show the executor strip without joining tables.
    this.lifecycleByTaskId = new Map();
    this.tasksWithCard = new Set();
    for (const m of msgs) {
      if (m.content.kind === "propose" && m.task_id) {
        this.tasksWithCard.add(m.task_id);
        if (m.content.data.draft.executor) {
          this.executorByTaskId.set(m.task_id, m.content.data.draft.executor);
        }
      }
      if (m.content.kind === "task_update") {
        const tid = m.content.data.task;
        const arr = this.lifecycleByTaskId.get(tid) ?? [];
        arr.push({ kind: m.content.data.kind, ts: m.created_at_unix_ms });
        this.lifecycleByTaskId.set(tid, arr);
      }
    }
    if (!this.threadEl) return;
    this.threadEl.innerHTML = "";
    if (msgs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "teammate-panel-empty";
      const name = this.operator?.name ?? "your operator";
      empty.innerHTML = `
        <div class="teammate-empty-icon">${Icons.headphones({ size: 28, strokeWidth: 1.3 })}</div>
        <div class="teammate-empty-title">Chat with ${escapeHtml(name)}</div>
        <div class="teammate-empty-hint">Ask about your project, get code reviewed, or delegate tasks.</div>
        <div class="teammate-empty-chips">
          <button type="button" class="teammate-empty-chip" data-prompt="What's happening in my open tabs?">What's happening in my tabs?</button>
          <button type="button" class="teammate-empty-chip" data-prompt="Audit the workspace I'm in for code-quality issues and surface the top findings.">Audit this workspace</button>
          <button type="button" class="teammate-empty-chip" data-prompt="Summarize the changes in the last 10 commits of this workspace.">Summarize recent changes</button>
          <button type="button" class="teammate-empty-chip" data-prompt="What should I work on next?">What should I do next?</button>
        </div>
      `;
      empty.addEventListener("click", (e) => {
        const chip = (e.target as HTMLElement).closest<HTMLButtonElement>(".teammate-empty-chip");
        if (!chip?.dataset.prompt) return;
        void this.send(chip.dataset.prompt);
      });
      this.threadEl.append(empty);
      return;
    }
    for (const m of msgs) this.paintMessage(m);
  }

  private paintMessage(msg: TeammateMessage): void {
    if (!this.threadEl) return;
    switch (msg.content.kind) {
      case "text":
        this.paintTextBubble(msg);
        return;
      case "propose":
        this.paintProposeCard(msg);
        return;
      case "task_update":
        // Belongs to a task pill → folded into that pill's drawer, not a row.
        if (this.tasksWithCard.has(msg.content.data.task)) return;
        this.paintSystemLine(msg, taskUpdateSummary(msg.content.data.kind));
        return;
      case "task_draft":
      case "report":
        this.paintSystemLine(msg, { text: `(${msg.content.kind})`, tone: "muted" });
        return;
    }
  }

  private appendBubble(msg: TeammateMessage): void {
    if (!this.threadEl) return;
    const empty = this.threadEl.querySelector(".teammate-panel-empty");
    empty?.remove();
    this.paintMessage(msg);
  }

  private paintTextBubble(msg: TeammateMessage): void {
    if (!this.threadEl) return;
    if (msg.content.kind !== "text") return;
    let prev: Element | null = this.threadEl.lastElementChild;
    while (prev && prev.classList.contains("teammate-typing")) {
      prev = prev.previousElementSibling;
    }
    const sameRoleAsPrev = prev?.getAttribute("data-role") === msg.role;

    if (msg.role === "user") {
      const b = document.createElement("div");
      b.className = "teammate-bubble teammate-bubble-user";
      b.setAttribute("data-role", "user");
      b.innerHTML = renderInlineContent(msg.content.data);
      this.threadEl.append(b);
    } else {
      const row = document.createElement("div");
      row.className = `teammate-bubble-row teammate-bubble-row-${msg.role}`;
      row.setAttribute("data-role", msg.role);
      const av = document.createElement("div");
      av.className = "teammate-bubble-avatar";
      if (sameRoleAsPrev) {
        av.classList.add("teammate-bubble-avatar-hidden");
      } else if (msg.role === "operator" && this.operator) {
        av.innerHTML = renderAvatarHtml(this.operator.emoji, 22);
      }
      const b = document.createElement("div");
      b.className = `teammate-bubble teammate-bubble-${msg.role}`;
      b.innerHTML = renderMessageBody(msg.content.data);
      row.append(av, b);
      this.threadEl.append(row);
    }
    this.threadEl.scrollTop = this.threadEl.scrollHeight;
  }

  private paintProposeCard(msg: TeammateMessage): void {
    if (!this.threadEl) return;
    const card = renderTaskCard(msg, {
      onConfirm: (id) => { void this.handleConfirm(id, msg); },
      onCancel:  (id) => { void this.handleCancel(id); },
      onEdit:    (id) => { this.openEditDialog(id, msg); },
      onOpenTab: (taskId) => { this.focusTabForTaskId(taskId); },
      onShowTask: (taskId) => { this.showTaskDetail(taskId); },
      confirmedTabLabel: this.tabLabelForMessage(msg),
      lifecycle: msg.task_id ? this.lifecycleByTaskId.get(msg.task_id) ?? [] : [],
    });
    const wrap = document.createElement("div");
    wrap.className = "teammate-row teammate-row--operator";
    wrap.appendChild(card);
    this.threadEl.appendChild(wrap);
    this.threadEl.scrollTop = this.threadEl.scrollHeight;
  }

  private tabLabelForMessage(msg: TeammateMessage): string {
    const task = msg.task_id ? this.tasksCache.find((t) => t.id === msg.task_id) : null;
    const raw = task?.title;
    if (!raw) return "open tab";
    const trimmed = raw.length > 28 ? `${raw.slice(0, 26)}…` : raw;
    return `tab "${trimmed}"`;
  }

  /// Switch to the Tasks view, expand the matching task, and scroll
  /// it into view. Called from the chat-bubble pill so clicking it
  /// takes you to the task instead of silently doing nothing.
  private showTaskDetail(taskId: string): void {
    this.viewMode = "tasks";
    this.applyViewMode();
    this.expandedTaskIds.add(taskId);
    void this.refreshTasks().then(() => {
      const el = this.tasksEl?.querySelector<HTMLElement>(`[data-task-id="${taskId}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  private focusTabForTaskId(taskId: string): void {
    // Prefer the locally-stashed session (set the moment we spawn the
    // tab in handleConfirm) — the backend task cache may not yet have
    // published `spawned_session`.
    const sid = this.taskSpawnedSessions.get(taskId)?.sessionId
      ?? this.tasksCache.find((t) => t.id === taskId)?.spawned_session;
    const alive = !!sid && (this.deps.isSessionAlive?.(sid) ?? true);
    if (alive && sid) {
      this.deps.focusTabBySessionId?.(sid);
      return;
    }
    const task = this.tasksCache.find((t) => t.id === taskId);
    if (!task) return;
    void this.respawnAndInject(task).catch((e) => console.error("respawn from pill failed", e));
  }

  /// Spawn a fresh tab for a task that had a dead/missing session,
  /// reattach, bind the operator, and inject the original task prompt
  /// so the new tab actually starts the work — same flow as the
  /// initial confirm path. Used by both Continue button and pill click.
  /// Preserves cwd + group from the original spawn (read from
  /// taskSpawnedSessions, which is localStorage-backed) so Continue
  /// after restart lands in the right project and visual group.
  private async respawnAndInject(task: Task): Promise<void> {
    if (!this.operator || !this.deps.spawnTabForTask) return;
    const opId = this.operator.id;
    const saved = this.taskSpawnedSessions.get(task.id);
    const spawned = await this.deps.spawnTabForTask(task, {
      cwd: saved?.cwd ?? null,
      groupId: saved?.groupId ?? null,
      color: saved?.color ?? null,
    });
    this.taskSpawnedSessions.set(task.id, {
      sessionId: spawned.sessionId,
      cwd: spawned.cwd ?? saved?.cwd ?? null,
      groupId: spawned.groupId ?? saved?.groupId ?? null,
      color: spawned.color ?? saved?.color ?? null,
    });
    persistTaskSpawnedSessions(this.taskSpawnedSessions);
    if (this.deps.attachSessionToTask) {
      await this.deps.attachSessionToTask(opId, task.id, spawned.sessionId).catch((e) =>
        console.error("attachSessionToTask on respawn failed", e),
      );
    }
    void this.deps.bindOperatorToTab?.(spawned.sessionId, opId).catch((e) =>
      console.error("bindOperatorToTab on respawn failed", e),
    );
    this.deps.focusTabBySessionId?.(spawned.sessionId);
    // The executor used when the task was originally confirmed isn't
    // currently persisted on the task row; fall back to whatever the
    // operator's default executor is by passing null (buildTaskInjection
    // emits a plain prompt the operator will pick up on its next turn).
    const line = buildTaskInjection(
      task.title, task.deliverable, null, new Map(), null, null, this.defaultExecutor,
    );
    window.setTimeout(() => {
      void injectCommand(spawned.sessionId, line).catch((e) =>
        console.error("injectCommand on respawn failed", e),
      );
    }, 1500);
    void this.refreshTasks();
  }

  private paintSystemLine(msg: TeammateMessage, style: SystemLineStyle): void {
    if (!this.threadEl) return;
    void msg;
    const row = document.createElement("div");
    row.className = `teammate-row teammate-row--system teammate-row--${style.tone}`;
    const dot = document.createElement("span");
    dot.className = "teammate-row__dot";
    const txt = document.createElement("span");
    txt.className = "teammate-row__txt";
    txt.textContent = style.text;
    row.append(dot, txt);
    this.threadEl.appendChild(row);
    this.threadEl.scrollTop = this.threadEl.scrollHeight;
  }

  private appendErrorCard(title: string, body: string): void {
    if (!this.threadEl) return;
    const card = document.createElement("div");
    card.className = "teammate-error-card";
    const t = document.createElement("div");
    t.className = "teammate-error-card__title";
    t.textContent = title;
    const b = document.createElement("div");
    b.className = "teammate-error-card__body";
    b.textContent = body;
    card.append(t, b);
    this.threadEl.appendChild(card);
    this.threadEl.scrollTop = this.threadEl.scrollHeight;
  }

  private async handleConfirm(messageId: string, msg: TeammateMessage): Promise<void> {
    if (!this.operator) return;
    const { confirmTask, spawnTabForTask, attachSessionToTask, getActiveSessionId } = this.deps;
    if (!confirmTask) {
      this.appendErrorCard("Action unavailable", "confirmTask is not wired up.");
      return;
    }
    try {
      const task = await confirmTask(this.operator.id, messageId);
      if (task.archetype === "do" && attachSessionToTask) {
        // Default: attach to whatever tab is currently active and inject
        // the task into its PTY. If a coding agent (Claude Code, Copilot
        // CLI, codex …) is running there, the prompt becomes a new turn in
        // its open conversation. If it's a plain shell, the prompt sits at
        // the cursor as plain text. User opts back into spawning a fresh
        // tab via localStorage["covenant.teammate.confirm-target"]="spawn".
        const target = (localStorage.getItem("covenant.teammate.confirm-target") ?? "active").trim();
        const operatorPickedExecutor =
          msg.content.kind === "propose" ? msg.content.data.draft.executor ?? null : null;
        let targetSessionId: string | null = null;
        let injectDelayMs = 150;
        let line = "";
        if (target === "spawn" && spawnTabForTask) {
          const spawned = await spawnTabForTask(task);
          targetSessionId = spawned.sessionId;
          this.taskSpawnedSessions.set(task.id, {
            sessionId: spawned.sessionId,
            cwd: spawned.cwd,
            groupId: spawned.groupId,
            color: spawned.color,
          });
          persistTaskSpawnedSessions(this.taskSpawnedSessions);
          injectDelayMs = 1500;
          const specPath = this.lastSentSpecPath;
          line = buildTaskInjection(
            task.title, task.deliverable, operatorPickedExecutor,
            this.lastSentMentionMap, specPath, spawned.cwd, this.defaultExecutor,
          );
          // Auto-attach mission + queue /rename if the originating chat
          // had a @spec chip. We AWAIT this (unlike the old fire-and-
          // forget setMissionForSpawnedTab) so the rename slot is in
          // place before the prompt-inject setTimeout fires below.
          // Even if priming fails (e.g. spec deleted) we still inject
          // the prompt — the spec content already inlined into the
          // prompt via buildTaskInjection covers the executor.
          if (specPath) {
            this.lastSentSpecPath = null;
            try {
              await primeSpawnedTab(spawned.sessionId, specPath);
            } catch (e) {
              console.error("prime_spawned_tab failed", e);
            }
          }
        } else {
          targetSessionId = getActiveSessionId?.() ?? null;
          if (!targetSessionId) {
            this.appendErrorCard(
              "No active tab.",
              "Open or focus a tab before confirming the task.",
            );
          } else {
            // If the active tab is already running a known executor (TUI),
            // type raw text + \n — it becomes a new message in the agent's
            // open conversation. If not, treat it like a spawn: shell-quote
            // and prefix with the operator-picked executor so the shell
            // actually launches it instead of barfing on a malformed line.
            const fg = this.deps.getActiveExecutor?.() ?? null;
            const specPath = this.lastSentSpecPath;
            line = fg
              ? buildActiveTabInjection(task.title, task.deliverable, this.lastSentMentionMap, specPath, null)
              : buildTaskInjection(task.title, task.deliverable, operatorPickedExecutor, this.lastSentMentionMap, specPath, null, this.defaultExecutor);
            if (specPath) this.lastSentSpecPath = null;
          }
        }
        if (targetSessionId) {
          await attachSessionToTask(this.operator.id, task.id, targetSessionId);
          const sid = targetSessionId;
          const opId = this.operator.id;
          // Bind operator + flip single-tab AOM through the tabs-manager
          // helper so the UI (operator ring, status bar) actually repaints.
          // Non-fatal if it fails — the task is already dispatched.
          void this.deps.bindOperatorToTab?.(sid, opId).catch((e) => {
            console.error("bindOperatorToTab failed", e);
          });
          window.setTimeout(() => {
            void injectCommand(sid, line).catch((e) => {
              console.error("injectCommand for task failed", e);
            });
          }, injectDelayMs);
        }
      }
      const refreshed = await this.deps.listMessages(this.activeThreadId ?? "", 200);
      this.paintMessages(refreshed);
      void this.refreshTasks();
    } catch (e) {
      console.error("confirmTask failed", e);
      const { title, body } = friendlyError("confirm", String(e));
      this.appendErrorCard(title, body);
    }
    void msg;
  }

  private async handleCancel(messageId: string): Promise<void> {
    const { cancelTaskProposal } = this.deps;
    if (!this.operator) return;
    if (!cancelTaskProposal) {
      this.appendErrorCard("Action unavailable", "cancelTaskProposal is not wired up.");
      return;
    }
    try {
      await cancelTaskProposal(messageId);
      const refreshed = await this.deps.listMessages(this.activeThreadId ?? "", 200);
      this.paintMessages(refreshed);
      void this.refreshTasks();
    } catch (e) {
      console.error("cancelTaskProposal failed", e);
      const { title, body } = friendlyError("cancel", String(e));
      this.appendErrorCard(title, body);
    }
  }

  private openEditDialog(messageId: string, msg: TeammateMessage): void {
    if (msg.content.kind !== "propose") return;
    const current = msg.content.data.draft;
    const nextTitle = window.prompt("Edit task title:", current.title);
    if (nextTitle === null || nextTitle === current.title) return;
    const { editTaskProposal } = this.deps;
    if (!editTaskProposal || !this.operator) return;
    void editTaskProposal(messageId, { ...current, title: nextTitle })
      .then(() => this.deps.listMessages(this.activeThreadId ?? "", 200))
      .then((refreshed) => this.paintMessages(refreshed))
      .catch((e) => {
        console.error("editTaskProposal failed", e);
        const { title, body } = friendlyError("edit", String(e));
        this.appendErrorCard(title, body);
      });
  }

  private setTyping(on: boolean): void {
    if (!this.threadEl) return;
    const existing = this.threadEl.querySelector(".teammate-typing");
    if (on && !existing) {
      const row = document.createElement("div");
      row.className = "teammate-bubble-row teammate-bubble-row-operator teammate-typing";
      row.setAttribute("data-role", "operator");
      const av = document.createElement("div");
      av.className = "teammate-bubble-avatar";
      if (this.operator) av.innerHTML = renderAvatarHtml(this.operator.emoji, 22);
      const b = document.createElement("div");
      b.className = "teammate-bubble teammate-bubble-operator teammate-typing";
      b.innerHTML = `<span class="teammate-typing-dot"></span><span class="teammate-typing-dot"></span><span class="teammate-typing-dot"></span>`;
      row.append(av, b);
      this.threadEl.append(row);
      this.threadEl.scrollTop = this.threadEl.scrollHeight;
    } else if (!on && existing) {
      existing.remove();
    }
  }

  private onIncomingMessage(msg: TeammateMessage): void {
    if (!this.operator || msg.operator_id !== this.operator.id) return;
    // Thread-scoped: a message addressed to a different thread belongs to
    // another conversation and must not paint in the current view. (Null
    // thread_id = legacy/global → always shown.)
    if (msg.thread_id && msg.thread_id !== this.activeThreadId) return;
    // Bump the active thread's recency + float it to the top of the
    // dropdown ordering so switching feels fresh. Low-risk, local-only.
    if (msg.thread_id) {
      const idx = this.threads.findIndex((t) => t.id === msg.thread_id);
      if (idx >= 0) {
        const t = this.threads[idx];
        t.last_message_at_unix_ms = msg.created_at_unix_ms;
        this.threads.splice(idx, 1);
        this.threads.unshift(t);
      }
    }
    this.setTyping(false);
    // Update the per-operator mood map before painting so any DOM that
    // re-reads it (header avatar wrap, future per-bubble badges) picks
    // up the new pose. Only operator-authored text turns carry sentiment
    // — see api.ts `Sentiment` doc-comment for the matrix.
    if (msg.sentiment) {
      this.currentMoodByOperator.set(this.operator.id, msg.sentiment);
      this.refreshHeaderAvatar();
    }
    if (msg.content.kind === "task_update") {
      // Lifecycle events live inside the task pill's drawer, not as loose
      // rows. Reload the thread so the pill rebuilds with the new event +
      // refreshed state chip (mirrors the confirm/cancel repaint path).
      if (this.operator) {
        void this.deps
          .listMessages(this.operator.id, 200)
          .then((refreshed) => this.paintMessages(refreshed))
          .catch((e) => console.error("reload thread on task_update failed", e));
      }
      void this.refreshTasks();
    } else {
      this.appendBubble(msg);
    }
    // YOLO mode (default ON): auto-confirm fresh propose messages with
    // archetype="do" the moment they arrive — no click required. Opt out
    // with localStorage.setItem("covenant.teammate.yolo", "off").
    if (
      msg.content.kind === "propose" &&
      msg.content.data.draft.archetype === "do" &&
      msg.confirmed_at_unix_ms === null &&
      msg.dismissed_at_unix_ms === null
    ) {
      const yolo = (localStorage.getItem("covenant.teammate.yolo") ?? "on").trim();
      if (yolo !== "off" && yolo !== "none") {
        void this.handleConfirm(msg.id, msg);
      }
    }
  }

  private onIncomingToolCall(call: TeammateToolCall): void {
    if (!this.operator || call.operator_id !== this.operator.id) return;
    if (!this.threadEl) return;
    const args = call.progress.args ?? {};
    const path = typeof args["path"] === "string" ? (args["path"] as string) : "";
    const ok = call.progress.ok;
    const tool = call.progress.tool;
    const line = document.createElement("div");
    line.className = `teammate-tool-line${ok ? "" : " teammate-tool-line-error"}`;
    const icon = ok ? "📖" : "⚠";
    const escapedPath = path.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c] as string));
    line.innerHTML = `<span class="teammate-tool-line-icon" aria-hidden="true">${icon}</span>` +
                     `<span class="teammate-tool-line-text">${escapeHtml(tool)}` +
                     (path ? ` · <code>${escapedPath}</code>` : "") + `</span>`;
    const typing = this.threadEl.querySelector(".teammate-typing");
    if (typing) this.threadEl.insertBefore(line, typing);
    else this.threadEl.append(line);
    this.threadEl.scrollTop = this.threadEl.scrollHeight;
  }

  private toggleSwitcher(): void {
    if (this.switcherEl) {
      this.closeSwitcher();
      return;
    }
    if (!this.headerEl || this.roster.length === 0) return;
    const list = document.createElement("div");
    list.className = "teammate-panel-switcher";
    for (const op of this.roster) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "teammate-panel-switcher-row";
      if (this.operator && op.id === this.operator.id) {
        row.classList.add("teammate-panel-switcher-row-active");
      }
      row.innerHTML = `
        ${renderAvatarHtml(op.emoji, 24)}
        <span class="teammate-panel-switcher-name">${escapeHtml(op.name)}</span>
        ${op.is_default ? `<span class="teammate-panel-switcher-tag">default</span>` : ""}
      `;
      row.addEventListener("click", () => {
        this.closeSwitcher();
        if (this.operator && op.id === this.operator.id) return;
        void this.openFor(op);
      });
      list.append(row);
    }
    this.host.append(list);
    this.switcherEl = list;
    this.host.classList.add("switcher-open");

    const dismiss = (e: Event) => {
      if (!this.switcherEl) return;
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "click" && this.switcherEl.contains(e.target as Node)) return;
      if (e.type === "click" && this.headerEl?.contains(e.target as Node)) return;
      this.closeSwitcher();
    };
    this.dismissSwitcher = dismiss;
    setTimeout(() => {
      document.addEventListener("click", dismiss);
      document.addEventListener("keydown", dismiss);
    }, 0);
  }

  private closeSwitcher(): void {
    if (this.dismissSwitcher) {
      document.removeEventListener("click", this.dismissSwitcher);
      document.removeEventListener("keydown", this.dismissSwitcher);
      this.dismissSwitcher = null;
    }
    this.switcherEl?.remove();
    this.switcherEl = null;
    this.host.classList.remove("switcher-open");
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const MENTION_SEP = "\n\n--- Mentioned ---\n";

function splitMentionBundle(text: string): { visible: string; bundle: string } {
  const idx = text.indexOf(MENTION_SEP);
  if (idx < 0) return { visible: text, bundle: "" };
  return { visible: text.slice(0, idx), bundle: text.slice(idx + MENTION_SEP.length) };
}

// Render already-bundle-split visible text to inline HTML. Escapes, then
// applies code spans and @spec/@file mention chips resolved from `bundle`.
function renderInline(visible: string, bundle: string): string {
  const specMeta = extractSpecMeta(bundle);

  let html = escapeHtml(visible).replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/@spec:([\w./-]+)/g, (_m, id: string) => {
    const meta = specMeta.get(id);
    const label = meta?.title ? `${id} · ${meta.title}` : id;
    const pathAttr = meta?.path ? ` data-spec-path="${escapeHtml(meta.path)}"` : "";
    return `<button type="button" class="teammate-mention-chip" data-mention-kind="spec" data-spec-id="${escapeHtml(id)}"${pathAttr}>§ ${escapeHtml(label)}</button>`;
  });
  const fileSet = extractFileMentions(bundle);
  if (fileSet.size > 0) {
    // Longest-first so a nested path doesn't get shadowed by an ancestor.
    const paths = Array.from(fileSet).sort((a, b) => b.length - a.length);
    const escaped = paths.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`@(${escaped.join('|')})`, 'g');
    html = html.replace(re, (_m, p: string) => {
      return `<button type="button" class="teammate-mention-chip" data-mention-kind="file" data-file-path="${escapeHtml(p)}">⌗ ${escapeHtml(p)}</button>`;
    });
  }
  return html;
}

function renderInlineContent(text: string): string {
  const { visible, bundle } = splitMentionBundle(text);
  return renderInline(visible, bundle);
}

// Render an operator message: same inline handling as renderInlineContent,
// plus ```card``` fences become card blocks. Cells reuse renderInline so code
// spans and mention chips work inside them.
function renderMessageBody(text: string): string {
  const { visible, bundle } = splitMentionBundle(text);
  return renderCardSegments(visible, (cell) => renderInline(cell, bundle));
}

/// Pull file-mention paths out of the bundle. File sections are headed
/// `### <rel-path>` with no leading keyword (specs use `spec `, commands
/// use `command:`, sessions use `session:` — skip those).
function extractFileMentions(bundle: string): Set<string> {
  const out = new Set<string>();
  const re = /^### (?!spec |command:|session:)(\S.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bundle)) !== null) {
    out.add(m[1].trim());
  }
  return out;
}

function extractSpecMeta(bundle: string): Map<string, { title: string; path?: string }> {
  const out = new Map<string, { title: string; path?: string }>();
  // Heading "### spec <id>: <title>" optionally followed by
  // "<!-- spec-path: <abs> -->" on the next line (so the chip can
  // open the file even after a restart, when no active session cwd
  // is available for findSpecs to scope by).
  const re = /^### spec (\S+): (.+?)(?:\n<!-- spec-path: (.+?) -->)?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bundle)) !== null) {
    out.set(m[1], { title: m[2].trim(), path: m[3] });
  }
  return out;
}

function textSpan(text: string): HTMLElement {
  const s = document.createElement("span");
  s.textContent = text;
  return s;
}

function dotSep(): HTMLElement {
  const s = document.createElement("span");
  s.className = "task-item__dot-sep";
  return s;
}

function statusLabel(s: Task["status"]): string {
  switch (s) {
    case "active":    return "active";
    case "blocked":   return "blocked";
    case "draft":     return "proposed";
    case "done":      return "done";
    case "cancelled": return "cancelled";
  }
}

/// Build the line we type into the spawned tab when a task is confirmed
/// with the "spawn new tab" target (the non-default path — the default is
/// to attach to the active tab where an executor is already running).
///
/// Behavior is driven by `localStorage["covenant.teammate.executor"]`:
///   - empty / unset → defaults to "claude"
///   - "none" / "off" → no autorun; pastes the task as a shell comment for
///     the user to review and Enter manually
///   - any other value → runs `<value> '<prompt>'\n`
///
/// Valid executor names match Covenant's own executor registry — the
/// agent CLIs the app tracks via fg_proc:
///   claude, codex, copilot, pi, hermes
/// (note: it's `copilot`, NOT `gh copilot` — the GitHub Copilot CLI is
/// installed as the `copilot` binary). To change without rebuilding:
///   localStorage.setItem("covenant.teammate.executor", "codex")
/// Rewrite any `@token` in `text` using `map` (token-with-`@` → resolved
/// display). Unknown tokens are stripped of their leading `@` so the
/// executor at least sees a plain word instead of a chat-only chip
/// reference it can't resolve.
export function sanitizeMentionTokens(text: string, map: Map<string, string>): string {
  return text.replace(/@[\w.:/\\-]+/g, (m) => {
    const hit = map.get(m);
    if (hit) return hit;
    console.warn("teammate: unresolved @token in task draft", m);
    return m.slice(1);
  });
}

export function buildTaskInjection(
  title: string,
  deliverable: string,
  operatorPicked: string | null,
  mentionMap: Map<string, string> = new Map(),
  specPath: string | null = null,
  cwd: string | null = null,
  defaultExecutor: string | null = null,
): string {
  const cleanTitle = sanitizeMentionTokens(title, mentionMap);
  const cleanDeliverable = sanitizeMentionTokens(deliverable, mentionMap);
  const base = [cleanTitle.trim(), cleanDeliverable.trim()].filter(Boolean).join(" — ");
  const prompt = withSpecPrefix(base, specPath, cwd);
  // Precedence: operator's choice (from the propose draft) → localStorage
  // override → the spawn marked `default` in spawns.json → "claude".
  // "none"/"off" disables autorun.
  const fallback = (
    localStorage.getItem("covenant.teammate.executor") ?? defaultExecutor ?? "claude"
  ).trim();
  const exec = (operatorPicked ?? fallback).trim();
  if (!exec || exec === "none" || exec === "off") {
    return `# ${prompt} `;
  }
  return `${exec} ${shellQuote(prompt)}\n`;
}

/// If the originating chat mentioned a @spec chip, tell the executor to
/// read that spec first. Without this, executors like Claude Code waste
/// turns rediscovering the spec by grep — they have no view of the tab
/// mission Covenant sets out-of-band.
function withSpecPrefix(prompt: string, specPath: string | null, cwd: string | null): string {
  if (!specPath) return prompt;
  const display = relativeIfUnder(specPath, cwd);
  return `Read ${display} first, then: ${prompt}`;
}

function relativeIfUnder(abs: string, cwd: string | null): string {
  if (!cwd) return abs;
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return abs.startsWith(root) ? abs.slice(root.length) : abs;
}

/// Inject text for "attach to active tab" confirms. We assume the user is
/// already inside an agent CLI (Claude Code, Copilot CLI, codex, …) — so
/// no executor prefix, no shell quoting. Trailing `\n` submits the message.
function buildActiveTabInjection(
  title: string,
  deliverable: string,
  mentionMap: Map<string, string> = new Map(),
  specPath: string | null = null,
  cwd: string | null = null,
): string {
  const cleanTitle = sanitizeMentionTokens(title, mentionMap);
  const cleanDeliverable = sanitizeMentionTokens(deliverable, mentionMap);
  const base = [cleanTitle.trim(), cleanDeliverable.trim()].filter(Boolean).join(" — ");
  const prompt = withSpecPrefix(base, specPath, cwd);
  return `${prompt}\n`;
}

function shellQuote(s: string): string {
  // POSIX single-quoting: wrap in '…', and replace embedded ' with '\''.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function statTile(label: string, value: string, sub: string): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "task-stat";
  const l = document.createElement("div");
  l.className = "task-stat__label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "task-stat__value";
  v.textContent = value;
  const s = document.createElement("div");
  s.className = "task-stat__sub";
  s.textContent = sub;
  tile.append(l, v, s);
  return tile;
}

function emptyLine(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "task-section__empty";
  el.textContent = text;
  return el;
}

function decisionsBreakdown(rows: OperatorDecisionRow[]): string {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const k = r.action.toLowerCase();
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const order = ["reply", "inject", "read", "block", "escalate", "wait"];
  const parts: string[] = [];
  for (const k of order) {
    if (counts[k]) parts.push(`${counts[k]}${k.charAt(0)}`);
  }
  return parts.join(" · ") || "—";
}

function executorGlyph(name: string): string {
  switch (name.toLowerCase()) {
    case "claude":  return "🟧";
    case "codex":   return "🟩";
    case "copilot": return "🟦";
    case "pi":      return "🟠";
    case "hermes":  return "🟢";
    default:        return "▣";
  }
}

function renderDecision(d: OperatorDecisionRow): HTMLElement {
  const row = document.createElement("div");
  row.className = "decision";

  const r1 = document.createElement("div");
  r1.className = "decision__row1";
  const time = document.createElement("span");
  time.className = "decision__time";
  time.textContent = formatAge(d.timestamp_unix_ms);
  const kind = document.createElement("span");
  const k = d.action.toLowerCase();
  kind.className = `decision__kind decision__kind--${k}`;
  kind.textContent = shortAction(d.action);
  const cost = document.createElement("span");
  cost.className = "decision__cost";
  cost.textContent = `$${d.cost_usd.toFixed(3)}`;
  r1.append(time, kind, cost);
  row.append(r1);

  const detail = document.createElement("div");
  detail.className = "decision__detail";
  const text = decisionDetailText(d);
  detail.textContent = text;
  detail.title = text;
  row.append(detail);

  return row;
}

function shortAction(action: string): string {
  const a = action.toUpperCase();
  if (a === "ESCALATE") return "ESCAL";
  return a;
}

function decisionDetailText(d: OperatorDecisionRow): string {
  if (d.reply_text && d.reply_text.trim()) return d.reply_text.trim();
  if (d.in_flight_command && d.in_flight_command.trim()) return d.in_flight_command.trim();
  if (d.rationale && d.rationale.trim()) return d.rationale.trim();
  return d.output_excerpt.slice(0, 80);
}

/// Compact relative time for the thread dropdown: <60s "now", <60m "Xm",
/// <24h "Xh", else "Xd".
function threadRelTime(unixMs: number): string {
  const diffSec = Math.max(0, (Date.now() - unixMs) / 1000);
  if (diffSec < 60)    return "now";
  if (diffSec < 3600)  return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

function formatAge(unixMs: number): string {
  const diffSec = Math.max(0, (Date.now() - unixMs) / 1000);
  if (diffSec < 60)    return `${Math.floor(diffSec)}s`;
  if (diffSec < 3600)  return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}
