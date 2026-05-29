import type { Operator, Sentiment, Task, TaskArchetype, TeammateMessage, TeammateToolCall, UpdateKind } from "../api";
import type { OperatorDecisionRow } from "../api";
import {
  findRecentCommands,
  findSpecs,
  injectCommand, onTeammateMessage, onTeammateToolCall, operatorLevelFromXp, primeSpawnedTab,
  operatorList, readBlockExcerpt, readSessionExcerpt,
  structureFindFiles, structureReadFile,
  teammateAttachSessionToTask, teammateCancelActiveTask, teammateCancelTaskProposal,
  teammateClearForOperator, teammateConfirmTask, teammateEditTaskProposal,
  teammateListDecisionsForSession, teammateListMessages, teammateListTasks,
  teammateSendText,
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
import { renderTaskCard, type TaskLifecycleEvent } from "./task-card";
import { ActivityView } from "./activity-view";
import { AomActivityFeed } from "../aom/activity-feed";

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
  listMessages:  (operatorId: string, limit?: number) => Promise<TeammateMessage[]>;
  sendText:      (operatorId: string, text: string, activeSessionId?: string | null) => Promise<TeammateMessage>;
  listOperators: () => Promise<Operator[]>;
  onMessage?:    (handler: (msg: TeammateMessage) => void) => Promise<() => void>;
  onToolCall?:   (handler: (call: TeammateToolCall) => void) => Promise<() => void>;
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
  /// Wipe all messages + tasks for this operator (test/reset affordance).
  clearForOperator?:    (operatorId: string) => Promise<void>;
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
  onMessage:     onTeammateMessage,
  onToolCall:    onTeammateToolCall,
  confirmTask:         teammateConfirmTask,
  cancelTaskProposal:  teammateCancelTaskProposal,
  editTaskProposal:    teammateEditTaskProposal,
  attachSessionToTask: teammateAttachSessionToTask,
  listTasks:           teammateListTasks,
  clearForOperator:    teammateClearForOperator,
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
  /// Latest sentiment seen per operator (keyed by OperatorId). Updated
  /// whenever a tagged operator message arrives so the avatar feels
  /// "alive" — the pose + badge follow the most recent mood across
  /// operator switches. Untagged messages don't overwrite (preserves
  /// the last real mood instead of snapping back to neutral on a
  /// model that occasionally forgets the directive).
  private currentMoodByOperator: Map<string, Sentiment> = new Map();
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
  /// Last-painted messages, snapshotted so the trash → undo-toast flow
  /// can restore the chat if the user clicks Undo before the deferred
  /// backend clear fires.
  private messagesCache: TeammateMessage[] = [];
  /// Pending soft-delete kicked off by the trash button. While set, the
  /// UI is empty but the backend still holds the data — the timer fires
  /// the actual `clearForOperator` call after the undo window, and any
  /// outgoing send / panel switch / operator change commits it early.
  private pendingClear: {
    operatorId: string;
    messages: TeammateMessage[];
    tasks: Task[];
    timer: number;
  } | null = null;
  private tasksFilter: "all" | "active" | "proposed" | "done" = "all";
  private expandedTaskIds = new Set<string>();
  private decisionsByTask = new Map<string, OperatorDecisionRow[]>();
  /// Maps `@<token>` → payload of every chip the user has picked in the
  /// current composer draft. Cleared on send.
  private mentionRegistry: MentionRegistry = new Map();
  private mentionPopup: MentionPopup | null = null;
  private activityView: ActivityView | null = null;
  private activityEl: HTMLElement | null = null;

  constructor(host: HTMLElement, deps: TeammatePanelDeps = DEFAULT_DEPS) {
    this.host = host;
    this.deps = deps;
  }

  isOpen(): boolean { return this.operator !== null; }

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
    this.host.append(
      this.renderHeader(),
      this.renderTabsBar(),
      this.renderThread(),
      this.renderTasksView(),
      this.renderActivityView(),
      this.renderComposer(),
    );
    this.applyViewMode();
    const [messages] = await Promise.all([
      this.deps.listMessages(operator.id, 200),
      this.deps.listOperators().then((ops) => { this.roster = ops; }).catch(() => { /* ignore */ }),
      this.refreshTasks(),
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
  }

  close(): void {
    // Commit any in-flight soft-delete before tearing down — the toast
    // host outlives the panel and the user can't undo a panel they
    // can't see.
    if (this.pendingClear) { void this.commitPendingClear(); }
    this.closeSwitcher();
    this.unlisten?.();
    this.unlisten = null;
    this.unlistenToolCall?.();
    this.unlistenToolCall = null;
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
    // Commit any in-flight soft-delete before sending — otherwise the
    // pending timer will wipe the message the user just typed.
    if (this.pendingClear) { await this.commitPendingClear(); }
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
      const msg = await this.deps.sendText(this.operator.id, payload, activeId);
      this.appendBubble(msg);
      this.setTyping(true);
    } catch (e) {
      console.error("teammate sendText failed", e);
    }
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
    b.setAttribute("aria-label", "Reset chats & tasks");
    b.innerHTML = Icons.trash({ size: 14 });
    attachTooltip(b, "Reset chats & tasks for this operator");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleResetClick();
    });
    return b;
  }

  /// Soft-delete the operator's chat + tasks: clear locally, defer the
  /// backend wipe, and surface an undo toast. Restores from snapshot if
  /// the user clicks the toast within the undo window; otherwise the
  /// timer commits the clear. Any send/panel-switch commits early so a
  /// new message can't get wiped by the pending timer.
  private async handleResetClick(): Promise<void> {
    if (!this.operator) return;
    if (!this.deps.clearForOperator) {
      this.appendErrorCard("Action unavailable", "clearForOperator is not wired up.");
      return;
    }
    // Already pending → second click commits immediately (escape hatch).
    if (this.pendingClear) {
      await this.commitPendingClear();
      return;
    }
    const opId = this.operator.id;
    const msgCount = this.messagesCache.length;
    const taskCount = this.tasksCache.length;
    const snapshot = {
      operatorId: opId,
      messages: this.messagesCache.slice(),
      tasks:    this.tasksCache.slice(),
      timer:    window.setTimeout(() => { void this.commitPendingClear(); }, 6000),
    };
    this.pendingClear = snapshot;
    this.tasksCache = [];
    this.paintMessages([]);
    this.paintTasks();
    this.updateTasksCount();
    this.updateHeaderWorkingState();
    this.renderUndoBar(msgCount, taskCount);
  }

  /// Inline undo card shown inside the now-empty thread. Replaces the
  /// empty-state CTAs while a pending clear is in flight. Two explicit
  /// buttons (Undo / Delete now) + a 6s progress bar so the user knows
  /// how much time is left before the clear commits.
  private renderUndoBar(msgCount: number, taskCount: number): void {
    if (!this.threadEl) return;
    this.threadEl.innerHTML = "";
    const parts: string[] = [];
    if (msgCount > 0) parts.push(`${msgCount} message${msgCount === 1 ? "" : "s"}`);
    if (taskCount > 0) parts.push(`${taskCount} task${taskCount === 1 ? "" : "s"}`);
    const summary = parts.length > 0 ? parts.join(" and ") : "this chat";
    const card = document.createElement("div");
    card.className = "teammate-undo-card";
    card.innerHTML = `
      <div class="teammate-undo-title">Cleared ${escapeHtml(summary)}</div>
      <div class="teammate-undo-hint">Commits in <span data-role="countdown">6</span>s if no action.</div>
      <div class="teammate-undo-progress"><span class="teammate-undo-progress-fill"></span></div>
      <div class="teammate-undo-actions">
        <button type="button" class="teammate-undo-btn teammate-undo-btn--primary" data-action="undo">Undo</button>
        <button type="button" class="teammate-undo-btn" data-action="commit">Delete now</button>
      </div>
    `;
    const countdownEl = card.querySelector<HTMLElement>('[data-role="countdown"]');
    let remaining = 6;
    const countdownTimer = window.setInterval(() => {
      remaining -= 1;
      if (countdownEl) countdownEl.textContent = String(Math.max(0, remaining));
      if (remaining <= 0) window.clearInterval(countdownTimer);
    }, 1000);
    card.dataset["countdownTimer"] = String(countdownTimer);
    card.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
      if (!btn) return;
      window.clearInterval(countdownTimer);
      if (btn.dataset["action"] === "undo") this.undoPendingClear();
      else if (btn.dataset["action"] === "commit") void this.commitPendingClear();
    });
    this.threadEl.append(card);
  }

  private undoPendingClear(): void {
    const p = this.pendingClear;
    if (!p) return;
    window.clearTimeout(p.timer);
    this.pendingClear = null;
    // Only restore if the user is still viewing the same operator —
    // otherwise the panel context has moved on and a restore would
    // splice messages into the wrong thread.
    if (this.operator?.id !== p.operatorId) return;
    this.tasksCache = p.tasks;
    this.paintMessages(p.messages);
    this.paintTasks();
    this.updateTasksCount();
    this.updateHeaderWorkingState();
  }

  private async commitPendingClear(): Promise<void> {
    const p = this.pendingClear;
    if (!p) return;
    window.clearTimeout(p.timer);
    this.pendingClear = null;
    // Replace the undo card with the empty-state CTAs (only if the user
    // is still viewing the same operator).
    if (this.operator?.id === p.operatorId) {
      this.paintMessages([]);
    }
    try {
      await this.deps.clearForOperator?.(p.operatorId);
    } catch (e) {
      console.error("clearForOperator failed", e);
      this.appendErrorCard("Couldn't reset the operator.", String(e));
    }
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
    this.messagesCache = msgs;
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
      b.innerHTML = renderInlineContent(msg.content.data);
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
    const line = buildTaskInjection(task.title, task.deliverable, null);
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
            this.lastSentMentionMap, specPath, spawned.cwd,
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
              : buildTaskInjection(task.title, task.deliverable, operatorPickedExecutor, this.lastSentMentionMap, specPath, null);
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
      const refreshed = await this.deps.listMessages(this.operator.id, 200);
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
      const refreshed = await this.deps.listMessages(this.operator.id, 200);
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
    const operatorId = this.operator.id;
    void editTaskProposal(messageId, { ...current, title: nextTitle })
      .then(() => this.deps.listMessages(operatorId, 200))
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

function renderInlineContent(text: string): string {
  // The send pipeline appends a "--- Mentioned ---" block with the full
  // resolved content of every @mention so the LLM gets it as context.
  // For chat display we strip that bundle and render the visible portion
  // only — mention tokens like `@spec:3.23` become clickable chips.
  const SEP = "\n\n--- Mentioned ---\n";
  const idx = text.indexOf(SEP);
  const visible = idx >= 0 ? text.slice(0, idx) : text;
  const bundle  = idx >= 0 ? text.slice(idx + SEP.length) : "";
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
): string {
  const cleanTitle = sanitizeMentionTokens(title, mentionMap);
  const cleanDeliverable = sanitizeMentionTokens(deliverable, mentionMap);
  const base = [cleanTitle.trim(), cleanDeliverable.trim()].filter(Boolean).join(" — ");
  const prompt = withSpecPrefix(base, specPath, cwd);
  // Precedence: operator's choice (from the propose draft) → localStorage
  // override → default "claude". "none"/"off" disables autorun.
  const fallback = (localStorage.getItem("covenant.teammate.executor") ?? "claude").trim();
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

function formatAge(unixMs: number): string {
  const diffSec = Math.max(0, (Date.now() - unixMs) / 1000);
  if (diffSec < 60)    return `${Math.floor(diffSec)}s`;
  if (diffSec < 3600)  return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}
