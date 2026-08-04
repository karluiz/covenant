// TaskerPanel: right-rail task list with inline task details.

import type { Task, Project, SubTask, TaskStatus, TaskPriority } from "./types";
import { TaskStorage, generateId } from "./storage";
import { Icons } from "../icons";
import { BoardView, renderSubsFraction, formatMinutes, parseDuration, loggedMinutes } from "./board";
import { MarkdownEditor } from "../ui/markdown-editor";
import { CustomSelect } from "../ui/select";
import { attachTooltip } from "../tooltip/tooltip";
import { pushInfoToast } from "../notifications/toast";
import {
  BOARD_SHARES_EVENT,
  copyBoardLink,
  getPushError,
  getPushState,
  isBoardShared,
  revokeBoardShare,
  shareProjectBoard,
  startBoardAutoPush,
} from "./share";

/// Rust's `covenant_board::jwt()` returns this exact string when there is no
/// stored JWT. Detecting it lets the share flow route the user to sign in
/// instead of showing a generic failure toast (F2 — the repo's convention,
/// see `covenant:open-providers`, is a door to fix the state, never a red
/// error, for a state that isn't really a failure).
const NOT_SIGNED_IN_MARKER = "not signed in to Covenant";

function isSignedOutError(err: unknown): boolean {
  return String(err).includes(NOT_SIGNED_IN_MARKER);
}

const EXPANDED_PROJECTS_KEY = "covenant.tasker.expanded-projects";
const VIEW_KEY = "covenant.tasker.view";
const BOARD_PROJECT_KEY = "covenant.tasker.board-project";
const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];

function formatDueDate(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dateOnly = (d: Date) => d.toISOString().split("T")[0];
  if (dateOnly(date) === dateOnly(today)) return "Today";
  if (dateOnly(date) === dateOnly(tomorrow)) return "Tomorrow";

  const diff = Math.floor((ms - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diff < 7 && diff > 0) {
    return date.toLocaleDateString("en-US", { weekday: "short" });
  }

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isOverdue(ms: number): boolean {
  return ms < Date.now();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function getPriorityClass(priority: TaskPriority): string {
  return `tasker-priority-${priority}`;
}

function titleCase(s: string): string {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Build a Mon-first 6×7 day grid for the given month.
function calendarCells(year: number, month: number): Array<{ date: string; day: number; outside: boolean }> {
  const first = new Date(year, month, 1);
  // JS: 0=Sun … 6=Sat → shift so Monday=0
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - lead);
  const cells: Array<{ date: string; day: number; outside: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ date: ymd(d), day: d.getDate(), outside: d.getMonth() !== month });
  }
  return cells;
}

export class TaskerPanel {
  private storage: TaskStorage;
  private host: HTMLElement;
  private isOpen = false;
  private expandedProjects: Set<string> = new Set();
  private currentFilter: TaskStatus | "all" = "all";
  private composingProjectId: string | null = null;
  private selectedTask: { projectId: string; taskId: string } | null = null;
  private openMenu: { kind: "date"; taskId: string } | null = null;
  private dateView: { year: number; month: number } | null = null;
  private dateMenuEl: HTMLElement | null = null;
  private datePickerRepaint: (() => void) | null = null;
  private dateOutsideListener: ((ev: MouseEvent) => void) | null = null;
  private projectSelect: CustomSelect | null = null;
  private shareMenuEl: HTMLElement | null = null;
  private shareMenuOutside: ((ev: MouseEvent) => void) | null = null;
  private editingTitle: { projectId: string; taskId: string } | null = null;
  private renamingProjectId: string | null = null;
  private composingList = false;
  private viewMode: "list" | "board" = "list";
  private boardProjectId: string | null = null;
  private boardKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  /// Dismiss the whole panel (Esc / the header esc pill). Wired by the host.
  private onClose: (() => void) | null = null;
  private board: BoardView | null = null;
  // Live WYSIWYG markdown editors mounted into open task-detail Notes fields.
  // Flushed + destroyed on every render so Milkdown instances don't leak.
  private noteEditors: Array<{ editor: MarkdownEditor; projectId: string; taskId: string }> = [];
  private noteSaveTimer: number | null = null;
  // Once-a-minute repaint while a work timer runs, so logged time stays live.
  private timerTick: number | null = null;

  constructor(host: HTMLElement, opts?: { onClose?: () => void }) {
    this.host = host;
    this.onClose = opts?.onClose ?? null;
    this.storage = new TaskStorage();
    this.loadExpandedProjects();
    this.loadViewPrefs();

    if (this.storage.getProjects().length === 0) {
      const inbox = this.storage.createProject("Inbox", "Quick tasks and todos");
      this.expandedProjects.add(inbox.id);
      this.saveExpandedProjects();
    } else if (this.expandedProjects.size === 0) {
      const first = this.storage.getProjects()[0];
      if (first) this.expandedProjects.add(first.id);
    }

    // ponytail: no teardown — TaskerPanel has no dispose and lives for the
    // app's lifetime. Add one here if the panel ever becomes disposable.
    startBoardAutoPush(this.storage);
    window.addEventListener(BOARD_SHARES_EVENT, () => {
      // Finding 3: auto-push fires this event twice (pushing → synced)
      // ~2s after any edit to a shared project — a moment that has nothing
      // to do with what the user is doing right now. render() rebuilds the
      // whole panel via innerHTML, which would silently discard an
      // in-progress edit (project rename, new-task/new-list composer, task
      // title, notes editor) if it fired mid-keystroke. Skip the rebuild
      // while the user is actively typing inside the panel — the share
      // button's dot/pulse just catches up on the next render the user's
      // own action triggers. Same guard for an open popover (project
      // switcher / share / date / row menu): render() closes them all, so
      // the push cycle was yanking dropdowns shut ~2s after any edit.
      if (this.isTypingInPanel() || this.hasOpenMenu()) return;
      this.render();
    });
  }

  private hasOpenMenu(): boolean {
    return Boolean(
      this.openMenu || this.dateMenuEl || this.shareMenuEl ||
      this.projectSelect?.button.getAttribute("aria-expanded") === "true",
    );
  }

  private isTypingInPanel(): boolean {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !this.host.contains(active)) return false;
    return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable;
  }

  private loadExpandedProjects(): void {
    try {
      const raw = localStorage.getItem(EXPANDED_PROJECTS_KEY);
      if (raw) this.expandedProjects = new Set(JSON.parse(raw));
    } catch {
      // ignore corrupt prefs
    }
  }

  private saveExpandedProjects(): void {
    try {
      localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(Array.from(this.expandedProjects)));
    } catch {
      // ignore quota/private-mode failures
    }
  }

  private loadViewPrefs(): void {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      if (v === "board" || v === "list") this.viewMode = v;
    } catch { /* ignore */ }
    try {
      this.boardProjectId = localStorage.getItem(BOARD_PROJECT_KEY);
    } catch { /* ignore */ }
    // Ensure boardProjectId points at a real project.
    const projects = this.storage.getProjects();
    if (!this.boardProjectId || !projects.some((p) => p.id === this.boardProjectId)) {
      this.boardProjectId = projects[0]?.id ?? null;
    }
  }

  private saveViewPrefs(): void {
    try {
      localStorage.setItem(VIEW_KEY, this.viewMode);
      if (this.boardProjectId) localStorage.setItem(BOARD_PROJECT_KEY, this.boardProjectId);
    } catch { /* ignore */ }
  }

  private switchView(mode: "list" | "board"): void {
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.selectedTask = null;
    document.body.classList.toggle("tasker-board", mode === "board");
    this.saveViewPrefs();
    this.render();
  }

  isOpenCheck(): boolean {
    return this.isOpen;
  }

  private renderHeader(): string {
    return `
    <div class="rail-header">
      <div class="rail-title">
        <span class="rail-dot is-run"></span>
        <span class="rail-title-label">Tasker</span>
      </div>
      <div class="rail-actions">
        <button class="rail-btn${this.viewMode === "list" ? " is-on" : ""}" type="button" data-view="list" aria-label="List view">${Icons.listView({ size: 15 })}</button>
        <button class="rail-btn${this.viewMode === "board" ? " is-on" : ""}" type="button" data-view="board" aria-label="Board view">${Icons.boardView({ size: 15 })}</button>
        <button class="rail-btn tasker-btn-new-project" type="button" aria-label="New project">${Icons.folder({ size: 15 })}</button>
        ${this.viewMode === "board"
          ? `<button class="tasker-esc-btn" type="button" aria-label="Close (Esc)"><kbd class="settings-esc">esc</kbd></button>`
          : ""}
      </div>
    </div>`;
  }

  private renderListBody(): string {
    const projects = this.storage.getProjects();
    return `
        <div class="rail-controls">
          <div class="rail-pills">
            <button class="rail-pill${this.currentFilter === "all" ? " is-active" : ""}" data-filter="all">All</button>
            <button class="rail-pill${this.currentFilter === "active" ? " is-active" : ""}" data-filter="active">Active</button>
            <button class="rail-pill${this.currentFilter === "pending" ? " is-active" : ""}" data-filter="pending">Pending</button>
            <button class="rail-pill${this.currentFilter === "done" ? " is-active" : ""}" data-filter="done">Done</button>
          </div>
        </div>

        ${this.composingList ? `
          <form class="tasker-newlist">
            <input class="tasker-newlist-input" type="text" autocomplete="off" placeholder="New list name…" />
            <button class="tasker-newlist-cancel" type="button" title="Cancel" aria-label="Cancel">${Icons.x({ size: 12 })}</button>
          </form>
        ` : ""}

        <div class="tasker-projects rail-body">
          ${projects.map((p) => this.renderProject(p)).join("")}
        </div>

        <div class="rail-footer">${this.getStats()}</div>`;
  }

  // DESIGN.md rule 14: the switcher is a CustomSelect, mounted into this
  // host span by setupEventListeners (render() rebuilds via innerHTML, so
  // the instance can't live in the HTML string).
  private renderProjectSwitcher(): string {
    const projects = this.storage.getProjects();
    if (projects.length <= 1) {
      const only = projects[0];
      return `<span class="kb-project-name">${escapeHtml(only?.name ?? "")}</span>`;
    }
    return `<span class="kb-project-switch"></span>`;
  }

  private mountProjectSwitcher(): void {
    const host = this.host.querySelector<HTMLElement>(".kb-project-switch");
    this.projectSelect?.destroy();
    this.projectSelect = null;
    if (!host) return;
    const projects = this.storage.getProjects();
    this.projectSelect = new CustomSelect({
      options: projects.map((p) => ({ value: p.id, label: p.name })),
      value: this.boardProjectId ?? projects[0]?.id ?? "",
      ariaLabel: "Board project",
      onChange: (id) => {
        if (id === this.boardProjectId) return;
        this.boardProjectId = id;
        this.selectedTask = null;
        this.saveViewPrefs();
        this.render();
      },
    });
    host.appendChild(this.projectSelect.element);
    this.projectSelect.button.addEventListener("dblclick", () => this.beginBoardRename());
  }

  /// Same gesture and guard as the list view's project rename: dblclick,
  /// and Inbox stays Inbox.
  private beginBoardRename(): void {
    const project = this.currentBoardProject();
    if (!project || project.name === "Inbox") return;
    this.renamingProjectId = project.id;
    this.render();
  }

  /// Same fallback the project switcher uses: a null `boardProjectId` (first
  /// run, or a stale id self-healed elsewhere) still shows the first project.
  private currentBoardProject(): Project | null {
    const projects = this.storage.getProjects();
    return projects.find((p) => p.id === this.boardProjectId) ?? projects[0] ?? null;
  }

  private renderBoardBody(): string {
    const sel = this.selectedTask;
    let dock = "";
    if (sel) {
      const task = this.storage.getTask(sel.projectId, sel.taskId);
      // withTitle: the dock is the only surface showing this task, so the
      // title must be editable here (the list view renames via its row).
      if (task) dock = this.renderTaskDetails(sel.projectId, task, true);
    }
    // The toolbar's project switcher names the board being looked at, so the
    // share affordance belongs beside it — board view has no project header
    // row, which is the only place the list view exposes it. Renaming (dblclick,
    // same gesture as the list view) and the new-bucket composer reuse the list
    // view's input classes so the shared wiring in setupEventListeners applies.
    const boardProject = this.currentBoardProject();
    const renaming = boardProject && this.renamingProjectId === boardProject.id;
    return `
    <div class="tasker-board-toolbar">
      ${renaming
        ? `<input class="tasker-project-rename-input kb-project-rename" data-project-id="${boardProject.id}" type="text" value="${escapeAttr(boardProject.name)}" autocomplete="off" aria-label="Rename bucket" />`
        : this.renderProjectSwitcher()}
      ${boardProject && !renaming ? this.renderShareButton(boardProject, "toolbar") : ""}
      ${this.composingList ? `
        <form class="tasker-newlist kb-newlist">
          <input class="tasker-newlist-input" type="text" autocomplete="off" placeholder="New bucket name…" />
          <button class="tasker-newlist-cancel" type="button" aria-label="Cancel">${Icons.x({ size: 12 })}</button>
        </form>` : ""}
    </div>
    <div class="tasker-board-layout">
      <div class="kb-columns-host"></div>
      <aside class="tasker-board-dock${dock ? " tasker-board-dock-open" : ""}">${dock}</aside>
    </div>`;
  }

  private mountBoard(): void {
    const columnsHost = this.host.querySelector<HTMLElement>(".kb-columns-host");
    if (!columnsHost) return;
    // Self-heal a stale board project (e.g. the current project was deleted from
    // the list view) so the board falls back instead of showing "No project selected".
    const projects = this.storage.getProjects();
    if (!this.boardProjectId || !projects.some((p) => p.id === this.boardProjectId)) {
      this.boardProjectId = projects[0]?.id ?? null;
    }
    if (!this.board) {
      this.board = new BoardView({
        storage: this.storage,
        getProjectId: () => this.boardProjectId,
        isSelected: (p, t) =>
          this.selectedTask?.projectId === p && this.selectedTask?.taskId === t,
        onSelect: (p, t) => {
          const same = this.selectedTask?.projectId === p && this.selectedTask?.taskId === t;
          this.selectedTask = same ? null : { projectId: p, taskId: t };
          this.render();
        },
        onChange: () => this.render(),
      });
    }
    this.board.render(columnsHost);
  }

  render(): void {
    this.flushNoteEditors();
    if (this.dateMenuEl && !this.openMenu) this.closeDatePicker();
    if (this.shareMenuEl) this.closeShareMenu();
    this.host.classList.remove("hidden");
    this.isOpen = true;
    document.body.classList.toggle("tasker-board", this.viewMode === "board");

    if (this.viewMode === "board") {
      this.host.innerHTML = `
      <div class="tasker-panel tasker-panel-board">
        ${this.renderHeader()}
        ${this.renderBoardBody()}
      </div>`;
    } else {
      this.host.innerHTML = `
      <div class="tasker-panel rail-panel">
        ${this.renderHeader()}
        ${this.renderListBody()}
      </div>`;
    }

    this.setupEventListeners();

    if (this.timerTick !== null) {
      clearInterval(this.timerTick);
      this.timerTick = null;
    }
    if (this.storage.getAllTasks({ showCompleted: true }).some((t) => t.timerStartedAt)) {
      this.timerTick = window.setInterval(() => {
        if (!this.isTypingInPanel()) this.render();
      }, 60_000);
    }

    // Preserve the existing list-mode composer autofocus.
    if (this.viewMode === "list") {
      queueMicrotask(() => {
        this.host.querySelector<HTMLInputElement>(".tasker-composer-input")?.focus();
      });
    }
  }

  private renderProject(project: Project): string {
    const isExpanded = this.expandedProjects.has(project.id);
    const isComposing = this.composingProjectId === project.id;
    const tasks = project.tasks.filter((t) =>
      this.currentFilter === "all" ? true : t.status === this.currentFilter,
    );

    const emptyHtml = tasks.length === 0 && !isComposing
      ? `
        <div class="tasker-empty">
          ${Icons.checklist({ size: 26 })}
          <div class="tasker-empty-title">No tasks yet</div>
          <div class="tasker-empty-hint">Capture a task for ${escapeHtml(project.name)}.</div>
        </div>
      `
      : "";

    return `
      <div class="rail-group">
        <div class="tasker-project-headrow">
          ${this.renamingProjectId === project.id
            ? `
          <div class="rail-group-head${isExpanded ? " open" : ""} tasker-project-header-renaming">
            <span class="rail-chev">${Icons.chevronRight({ size: 14 })}</span>
            <input class="tasker-project-rename-input" data-project-id="${project.id}" type="text" value="${escapeAttr(project.name)}" autocomplete="off" aria-label="Rename project" />
          </div>`
            : `
          <button class="rail-group-head${isExpanded ? " open" : ""}" data-project-id="${project.id}">
            <span class="rail-chev">${Icons.chevronRight({ size: 14 })}</span>
            <span class="rail-gname tasker-project-name">${escapeHtml(project.name)}</span>
            <span class="rail-gcount tasker-project-count">${tasks.length}</span>
          </button>
          ${this.renderShareButton(project)}
          ${project.name === "Inbox" ? "" : `<button class="tasker-project-delete" type="button" data-project-id="${project.id}" aria-label="Delete project">${Icons.trash({ size: 13 })}</button>`}`}
        </div>
        ${isExpanded ? `
          <div class="tasker-tasks">
            ${isComposing ? this.renderComposer(project.id) : ""}
            ${emptyHtml}
            ${tasks.map((t) => this.renderTask(project.id, t)).join("")}
            ${!isComposing ? `<button class="rail-new" data-project-id="${project.id}" type="button">+ Add task</button>` : ""}
          </div>
        ` : ""}
      </div>
    `;
  }

  /// `variant` only changes the chrome, never the behavior: the board toolbar
  /// has no row to hover, so its copy sits in flow with a text label, while the
  /// list row stays icon-only and hover-revealed. Both carry the same class, so
  /// the single `.tasker-project-share` click binding covers them both.
  private renderShareButton(project: Project, variant: "row" | "toolbar" = "row"): string {
    const shared = isBoardShared(project.id);
    const state = shared ? getPushState(project.id) : "synced";
    // F4 — say exactly what a click does now: opens a Copy link / Stop
    // sharing menu when already shared, shares directly otherwise.
    let label = shared ? "Board shared — click to manage sharing" : "Share board";
    // F3 — the dimmed dot is the only signal auto-push is failing; carry the
    // actual error in the tooltip so it isn't just a mystery dim dot.
    if (state === "stale") {
      const err = getPushError(project.id);
      label = err ? `Board shared — last sync failed: ${err}` : "Board shared — last sync failed";
    }
    const text = variant === "toolbar" ? `<span class="tasker-share-label">${shared ? "Shared" : "Share"}</span>` : "";
    return `<button class="tasker-project-share${shared ? " shared" : ""}${variant === "toolbar" ? " tasker-share-toolbar" : ""}" type="button"
      data-project-id="${project.id}" data-push-state="${state}" aria-label="${escapeAttr(label)}"
      data-tip="${escapeAttr(label)}">${Icons.share({ size: 13 })}${text}${shared ? `<span class="tasker-share-dot" aria-hidden="true"></span>` : ""}</button>`;
  }

  private renderComposer(projectId: string): string {
    return `
      <form class="tasker-composer" data-project-id="${projectId}">
        <input class="tasker-composer-input" name="title" type="text" autocomplete="off" placeholder="What needs doing?" />
        <div class="tasker-composer-actions">
          <button class="tasker-composer-submit" type="submit">Add task</button>
          <button class="tasker-composer-cancel" type="button">Cancel</button>
        </div>
      </form>
    `;
  }

  private renderTask(projectId: string, task: Task): string {
    const selected = this.selectedTask?.projectId === projectId && this.selectedTask.taskId === task.id;
    const priorityClass = getPriorityClass(task.priority);
    const statusClass = `tasker-task-status-${task.status}`;
    const checkboxIcon = task.status === "done" ? Icons.check({ size: 12 }) : "";

    const dueDateHtml = task.dueDate
      ? `<span class="rail-due${isOverdue(task.dueDate) && task.status !== "done" ? " over" : ""}">${formatDueDate(task.dueDate)}</span>`
      : "";

    return `
      <div class="tasker-task ${statusClass} ${priorityClass}${selected ? " tasker-task-selected" : ""}" data-project-id="${projectId}" data-task-id="${task.id}">
        <div class="rail-task${task.status === "done" ? " done" : ""}" data-pri="${task.priority}" role="button" tabindex="0" aria-expanded="${selected}">
          <button class="rail-cb" type="button" aria-label="Toggle task">${checkboxIcon}</button>
          ${this.editingTitle?.taskId === task.id && this.editingTitle.projectId === projectId
            ? `<input class="tasker-title-input" type="text" value="${escapeAttr(task.title)}" autocomplete="off" />`
            : `<span class="rail-ttl" role="button" tabindex="0">${escapeHtml(task.title)}</span>`}
          ${task.description?.trim() ? `<span class="rail-doc" aria-label="Has description">${Icons.noteText({ size: 13 })}</span>` : ""}
          ${renderSubsFraction(task, "rail-subs")}
          ${dueDateHtml}
          ${task.status === "pending"
            ? `<button class="tasker-task-start" type="button" data-project-id="${projectId}" data-task-id="${task.id}" aria-label="Start task">${Icons.play({ size: 12 })}<span>start</span></button>`
            : ""}
          <span class="tasker-task-chevron" aria-hidden="true">${selected ? "⌃" : "⌄"}</span>
        </div>
        ${selected ? this.renderTaskDetails(projectId, task) : ""}
      </div>
    `;
  }

  private renderTaskDetails(projectId: string, task: Task, withTitle = false): string {
    const dueLabel = task.dueDate ? formatDueDate(task.dueDate) : "Add date";
    return `
      <div class="tasker-edit tasker-sheet" data-project-id="${projectId}" data-task-id="${task.id}">
        ${withTitle ? `<input class="tasker-detail-title" type="text" value="${escapeAttr(task.title)}" autocomplete="off" spellcheck="false" aria-label="Task title" />` : ""}
        <div class="tasker-kv">
          <span class="tasker-kv-key">Status</span>
          <div class="tasker-seg tasker-seg-status" role="group">
            ${(["pending","active","done"] as TaskStatus[]).map((s) =>
              `<button class="tasker-seg-btn${task.status === s ? " on" : ""}" type="button" data-status="${s}">${titleCase(s)}</button>`).join("")}
          </div>
        </div>
        <div class="tasker-kv">
          <span class="tasker-kv-key">Priority</span>
          <div class="tasker-prio-dots" role="group">
            ${PRIORITIES.map((p) =>
              `<button class="tasker-prio-dot ${getPriorityClass(p)}${task.priority === p ? " on" : ""}" type="button" data-priority="${p}" aria-label="${titleCase(p)}"></button>`).join("")}
          </div>
        </div>
        <div class="tasker-kv">
          <span class="tasker-kv-key">Due</span>
          <button class="tasker-chip tasker-chip-due${task.dueDate ? " tasker-chip-due-set" : ""}" type="button">${escapeHtml(dueLabel)}</button>
        </div>
        <div class="tasker-kv">
          <span class="tasker-kv-key">Estimate</span>
          <input class="tasker-est-input" type="text" value="${task.estimatedMinutes ? formatMinutes(task.estimatedMinutes) : ""}" placeholder="2h 30m" autocomplete="off" aria-label="Time estimate" />
        </div>
        <div class="tasker-kv">
          <span class="tasker-kv-key">Logged</span>
          <input class="tasker-est-input tasker-spent-input" type="text" value="${task.spentMinutes ? formatMinutes(task.spentMinutes) : ""}" placeholder="0m" autocomplete="off" aria-label="Time logged" />
          <button class="tasker-timer-btn${task.timerStartedAt ? " on" : ""}" type="button">${task.timerStartedAt ? `${Icons.square({ size: 9 })} Stop · ${escapeHtml(formatMinutes(loggedMinutes(task)))}` : `${Icons.play({ size: 10 })} Start timer`}</button>
        </div>
        ${this.renderSubtasks(task)}
        <div class="tasker-kv tasker-kv-notes">
          <span class="tasker-kv-key tasker-notes-label">Notes</span>
          <div class="tasker-edit-note" data-note-mount></div>
        </div>
        <button class="tasker-sheet-delete" type="button">Delete task</button>
      </div>
    `;
  }

  private renderSubtasks(task: Task): string {
    const subs = task.subtasks ?? [];
    const done = subs.filter((s) => s.completed).length;
    const prog = subs.length
      ? `<span class="tasker-subs-prog${done === subs.length ? " all" : ""}">${done}/${subs.length}</span>`
      : "";
    const rows = subs
      .map(
        (s) => `
        <div class="tasker-sub${s.completed ? " done" : ""}" data-subtask-id="${s.id}">
          <button class="tasker-sub-cb" type="button" aria-label="Toggle subtask">${s.completed ? Icons.check({ size: 10 }) : ""}</button>
          <span class="tasker-sub-title">${escapeHtml(s.title)}</span>
          <button class="tasker-sub-del" type="button" aria-label="Delete subtask">×</button>
        </div>`,
      )
      .join("");
    return `
      <div class="tasker-kv tasker-kv-subs">
        <span class="tasker-kv-key tasker-subs-label">Subtasks${prog}</span>
        <div class="tasker-subs">
          ${rows}
          <form class="tasker-sub-add">
            <span class="tasker-sub-plus" aria-hidden="true">+</span>
            <input class="tasker-sub-input" type="text" placeholder="Add subtask" autocomplete="off" aria-label="Add subtask" />
          </form>
        </div>
      </div>`;
  }

  // F4 — the shared-board affordance: "Copy link" / "Stop sharing". A small
  // action menu (not a select), so it keeps its bespoke popover — same
  // outside-click dismissal, fixed positioning off the anchor, and the
  // .kb-project-menu/.kb-project-opt chrome.
  private closeShareMenu(): void {
    if (this.shareMenuOutside) {
      document.removeEventListener("mousedown", this.shareMenuOutside, true);
      this.shareMenuOutside = null;
    }
    this.shareMenuEl?.remove();
    this.shareMenuEl = null;
  }

  private openShareMenu(anchor: HTMLElement, projectId: string): void {
    if (this.shareMenuEl) { this.closeShareMenu(); return; }

    const el = document.createElement("div");
    el.className = "kb-project-menu tasker-share-menu";
    el.setAttribute("role", "menu");
    el.innerHTML = `
      <button class="kb-project-opt" type="button" role="menuitem" data-action="copy">
        <span class="kb-project-opt-check">${Icons.link2({ size: 13 })}</span>
        <span class="kb-project-opt-name">Copy link</span>
      </button>
      <button class="kb-project-opt" type="button" role="menuitem" data-action="stop">
        <span class="kb-project-opt-check">${Icons.x({ size: 13 })}</span>
        <span class="kb-project-opt-name">Stop sharing</span>
      </button>
    `;
    document.body.appendChild(el);
    this.shareMenuEl = el;

    const r = anchor.getBoundingClientRect();
    el.style.position = "fixed";
    el.style.top = `${r.bottom + 4}px`;
    el.style.left = `${r.left}px`;
    el.style.minWidth = "160px";

    el.querySelector<HTMLButtonElement>('[data-action="copy"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeShareMenu();
      copyBoardLink(projectId).catch(() => {
        pushInfoToast({ message: "Couldn't copy the board link — try again." });
      });
    });
    el.querySelector<HTMLButtonElement>('[data-action="stop"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeShareMenu();
      revokeBoardShare(projectId).catch(() => {
        pushInfoToast({ message: "Couldn't stop sharing the board — try again." });
      });
    });

    this.shareMenuOutside = (ev: MouseEvent) => {
      if (!el.contains(ev.target as Node) && !anchor.contains(ev.target as Node)) {
        this.closeShareMenu();
      }
    };
    document.addEventListener("mousedown", this.shareMenuOutside, true);
  }

  private closeDatePicker(): void {
    if (this.dateOutsideListener) {
      document.removeEventListener("mousedown", this.dateOutsideListener, true);
      this.dateOutsideListener = null;
    }
    this.datePickerRepaint = null;
    this.dateMenuEl?.remove();
    this.dateMenuEl = null;
    this.dateView = null;
    this.openMenu = null;
  }

  private openDatePicker(projectId: string, taskId: string, anchor: HTMLElement): void {
    if (this.dateMenuEl) { this.closeDatePicker(); return; }
    const task = this.storage.getTask(projectId, taskId);
    if (!task) return;
    const base = task.dueDate ? new Date(task.dueDate) : new Date();
    this.dateView = { year: base.getFullYear(), month: base.getMonth() };
    this.openMenu = { kind: "date", taskId };

    const el = document.createElement("div");
    el.className = "tasker-date-menu";
    document.body.appendChild(el);
    this.dateMenuEl = el;

    const paint = (): void => {
      const t = this.storage.getTask(projectId, taskId);
      if (!t) { this.closeDatePicker(); return; }
      el.innerHTML = this.dateCalendarHtml(t);
      this.bindDateCalendar(el, projectId, taskId);
      this.positionDateMenu(anchor, el);
    };
    this.datePickerRepaint = paint;
    paint();

    const onOutside = (ev: MouseEvent): void => {
      const target = ev.target as HTMLElement;
      if (el.contains(target) || anchor.contains(target)) return;
      this.closeDatePicker();
    };
    this.dateOutsideListener = onOutside;
    queueMicrotask(() => {
      if (this.dateOutsideListener === onOutside) {
        document.addEventListener("mousedown", onOutside, true);
      }
    });
  }

  private dateCalendarHtml(task: Task): string {
    const base = task.dueDate ? new Date(task.dueDate) : new Date();
    const view = this.dateView ?? { year: base.getFullYear(), month: base.getMonth() };
    const selected = task.dueDate ? ymd(new Date(task.dueDate)) : "";
    const today = ymd(new Date());
    const cells = calendarCells(view.year, view.month);
    return `
      <div class="tasker-cal-head">
        <span class="tasker-cal-title">${MONTHS[view.month]} ${view.year}</span>
        <div class="tasker-cal-nav">
          <button class="tasker-cal-prev" type="button" aria-label="Previous month">‹</button>
          <button class="tasker-cal-today" type="button">Today</button>
          <button class="tasker-cal-next" type="button" aria-label="Next month">›</button>
        </div>
      </div>
      <div class="tasker-cal-grid">
        ${WEEKDAYS.map((w) => `<span class="tasker-cal-wd">${w}</span>`).join("")}
        ${cells.map((c) => {
          const cls = ["tasker-cal-day", c.outside ? "tasker-cal-out" : "",
            c.date === today ? "tasker-cal-is-today" : "", c.date === selected ? "tasker-cal-sel" : ""]
            .filter(Boolean).join(" ");
          return `<button class="${cls}" type="button" data-date="${c.date}">${c.day}</button>`;
        }).join("")}
      </div>
      ${task.dueDate ? `<button class="tasker-cal-clear" type="button">Clear date</button>` : ""}
    `;
  }

  private bindDateCalendar(el: HTMLElement, projectId: string, taskId: string): void {
    const shift = (delta: number): void => {
      const v = this.dateView ?? { year: new Date().getFullYear(), month: new Date().getMonth() };
      const d = new Date(v.year, v.month + delta, 1);
      this.dateView = { year: d.getFullYear(), month: d.getMonth() };
      this.datePickerRepaint?.();
    };
    el.querySelector<HTMLButtonElement>(".tasker-cal-prev")?.addEventListener("click", () => shift(-1));
    el.querySelector<HTMLButtonElement>(".tasker-cal-next")?.addEventListener("click", () => shift(1));
    el.querySelector<HTMLButtonElement>(".tasker-cal-today")?.addEventListener("click", () => {
      const n = new Date();
      this.dateView = { year: n.getFullYear(), month: n.getMonth() };
      this.datePickerRepaint?.();
    });
    el.querySelector<HTMLButtonElement>(".tasker-cal-clear")?.addEventListener("click", () => {
      this.storage.updateTask(projectId, taskId, { dueDate: undefined });
      this.closeDatePicker();
      this.render();
    });
    el.querySelectorAll<HTMLButtonElement>(".tasker-cal-day").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.date;
        if (!value) return;
        this.storage.updateTask(projectId, taskId, { dueDate: new Date(`${value}T00:00:00`).getTime() });
        this.closeDatePicker();
        this.render();
      });
    });
  }

  private getStats(): string {
    const all = this.storage.getAllTasks();
    const done = all.filter((t) => t.status === "done").length;
    const active = all.filter((t) => t.status === "active").length;
    return `${done} done · ${active} active · ${all.length - done - active} pending`;
  }

  private setupEventListeners(): void {
    this.host.querySelectorAll<HTMLButtonElement>(".rail-header [data-view]").forEach((btn) => {
      attachTooltip(btn, btn.dataset.view === "board" ? "Board view" : "List view");
      btn.addEventListener("click", () => {
        const mode = btn.dataset.view === "board" ? "board" : "list";
        this.switchView(mode);
      });
    });

    if (this.boardKeyHandler) {
      document.removeEventListener("keydown", this.boardKeyHandler);
      this.boardKeyHandler = null;
    }
    // Esc closes the whole panel — consistent with Settings / Changes /
    // Release log. Guarded so it never hijacks an inline edit (rename / new
    // task / new list inputs own their Escape) or an open menu.
    this.boardKeyHandler = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      if (!document.body.classList.contains("sidebar-view-tasker")) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement || ae?.isContentEditable) return;
      if (this.hasOpenMenu()) return;
      e.preventDefault();
      this.onClose?.();
    };
    document.addEventListener("keydown", this.boardKeyHandler);

    // Unconditional: in list mode (no .kb-project-switch host) this just
    // destroys the stale board-mode instance.
    this.mountProjectSwitcher();
    if (this.viewMode === "board") {
      this.host.querySelector<HTMLElement>(".kb-project-name")
        ?.addEventListener("dblclick", () => this.beginBoardRename());
      this.mountBoard();
    }

    this.host.querySelectorAll<HTMLButtonElement>(".rail-pill[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.currentFilter = (btn.dataset.filter as TaskStatus | "all") || "all";
        this.selectedTask = null;
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLButtonElement>(".rail-group-head").forEach((btn) => {
      btn.addEventListener("click", () => {
        const projectId = btn.dataset.projectId;
        if (!projectId) return;
        if (this.expandedProjects.has(projectId)) this.expandedProjects.delete(projectId);
        else this.expandedProjects.add(projectId);
        this.saveExpandedProjects();
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLElement>(".rail-group-head .tasker-project-name").forEach((nameEl) => {
      nameEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const projectId = nameEl.closest<HTMLElement>(".rail-group-head")?.dataset.projectId;
        if (!projectId) return;
        const project = this.storage.getProject(projectId);
        if (!project || project.name === "Inbox") return;
        this.renamingProjectId = projectId;
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLInputElement>(".tasker-project-rename-input").forEach((input) => {
      let settled = false;
      const commit = (): void => {
        if (settled) return;
        settled = true;
        const projectId = input.dataset.projectId;
        const name = input.value.trim();
        this.renamingProjectId = null;
        if (projectId && name.length > 0) {
          this.storage.updateProject(projectId, { name });
        }
        this.render();
      };
      input.addEventListener("blur", commit);
      input.addEventListener("change", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          settled = true;
          this.renamingProjectId = null;
          this.render();
        }
      });
      queueMicrotask(() => {
        input.focus();
        input.select();
      });
    });

    this.host.querySelectorAll<HTMLButtonElement>(".tasker-project-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const projectId = btn.dataset.projectId;
        if (!projectId) return;
        const project = this.storage.getProject(projectId);
        if (!project) return;
        const count = project.tasks.length;
        const suffix = count > 0 ? ` and its ${count} task${count === 1 ? "" : "s"}` : "";
        if (!confirm(`Delete project "${project.name}"${suffix}? This can't be undone.`)) return;
        this.storage.deleteProject(projectId);
        this.expandedProjects.delete(projectId);
        this.saveExpandedProjects();
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLButtonElement>(".tasker-project-share").forEach((btn) => {
      attachTooltip(btn, btn.dataset.tip ?? "Share board");
      // F4 — a native <button> already fires "click" for Enter/Space when
      // focused, so no separate keydown handling is needed for keyboard
      // access to either the share action or the menu it opens.
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const projectId = btn.dataset.projectId;
        if (!projectId) return;
        const project = this.storage.getProject(projectId);
        if (!project) return;
        if (!isBoardShared(projectId)) {
          shareProjectBoard(project).catch((err) => {
            // F2 — signed-out is a state to fix, not a failure: route to
            // Settings → Covenant instead of a generic error.
            if (isSignedOutError(err)) {
              pushInfoToast({
                message: "Sign in to Covenant to share this board — click to open Settings",
                onClick: () => {
                  document.dispatchEvent(new CustomEvent("covenant:open-covenant-settings"));
                },
              });
            } else {
              pushInfoToast({ message: "Couldn't share the board — try again." });
            }
          });
          return;
        }
        // F4 — already shared: open the Copy link / Stop sharing menu
        // instead of overloading the click gesture (plain vs. Alt-click).
        this.openShareMenu(btn, projectId);
      });
    });

    const newProjectBtn = this.host.querySelector<HTMLButtonElement>(".tasker-btn-new-project");
    if (newProjectBtn) {
      attachTooltip(newProjectBtn, "New project");
      newProjectBtn.addEventListener("click", () => {
        this.showNewProjectDialog();
      });
    }

    this.host.querySelector<HTMLButtonElement>(".tasker-esc-btn")?.addEventListener("click", () => {
      this.onClose?.();
    });

    const newListForm = this.host.querySelector<HTMLFormElement>(".tasker-newlist");
    const newListInput = this.host.querySelector<HTMLInputElement>(".tasker-newlist-input");
    const commitNewList = (): void => {
      const name = newListInput?.value.trim() ?? "";
      this.composingList = false;
      if (name.length > 0) {
        const project = this.storage.createProject(name);
        this.expandedProjects.add(project.id);
        this.saveExpandedProjects();
        // From the board, land on the bucket you just created.
        if (this.viewMode === "board") {
          this.boardProjectId = project.id;
          this.selectedTask = null;
          this.saveViewPrefs();
        }
      }
      this.render();
    };
    newListForm?.addEventListener("submit", (e) => {
      e.preventDefault();
      commitNewList();
    });
    newListInput?.addEventListener("change", commitNewList);
    const cancelNewList = (): void => {
      this.composingList = false;
      this.render();
    };
    newListInput?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelNewList();
      }
    });
    newListInput?.addEventListener("blur", () => {
      // Cancel if dismissed without typing; commit happens via change/submit otherwise.
      if ((newListInput.value.trim().length ?? 0) === 0) {
        queueMicrotask(() => {
          if (this.composingList) cancelNewList();
        });
      }
    });
    this.host.querySelector<HTMLButtonElement>(".tasker-newlist-cancel")?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      cancelNewList();
    });
    if (newListInput) queueMicrotask(() => newListInput.focus());

    this.host.querySelectorAll<HTMLButtonElement>(".rail-cb").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const taskEl = (e.currentTarget as HTMLElement).closest<HTMLElement>(".tasker-task");
        const projectId = taskEl?.dataset.projectId;
        const taskId = taskEl?.dataset.taskId;
        if (!projectId || !taskId) return;
        const task = this.storage.getTask(projectId, taskId);
        if (!task) return;
        const done = task.status === "done";
        this.storage.updateTask(projectId, taskId, {
          status: done ? "pending" : "done",
          completedAt: done ? undefined : Date.now(),
        });
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLButtonElement>(".tasker-task-start").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const projectId = btn.dataset.projectId;
        const taskId = btn.dataset.taskId;
        if (!projectId || !taskId) return;
        this.storage.updateTask(projectId, taskId, { status: "active" });
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLElement>(".rail-task").forEach((row) => {
      const toggle = (): void => {
        const taskEl = row.closest<HTMLElement>(".tasker-task");
        const projectId = taskEl?.dataset.projectId;
        const taskId = taskEl?.dataset.taskId;
        if (!projectId || !taskId) return;
        const isSame = this.selectedTask?.projectId === projectId && this.selectedTask.taskId === taskId;
        this.selectedTask = isSame ? null : { projectId, taskId };
        this.openMenu = null;
        this.render();
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggle();
      });
    });

    this.host.querySelectorAll<HTMLButtonElement>(".rail-new").forEach((btn) => {
      btn.addEventListener("click", () => {
        const projectId = btn.dataset.projectId;
        if (projectId) this.openComposer(projectId);
      });
    });

    this.host.querySelectorAll<HTMLFormElement>(".tasker-composer").forEach((form) => {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const projectId = form.dataset.projectId;
        const input = form.querySelector<HTMLInputElement>(".tasker-composer-input");
        const title = input?.value.trim() ?? "";
        if (!projectId || title.length === 0) return;
        const task = this.storage.createTask(projectId, title, { priority: "normal" });
        this.currentFilter = "all";
        this.composingProjectId = null;
        if (task) this.selectedTask = { projectId, taskId: task.id };
        this.expandedProjects.add(projectId);
        this.saveExpandedProjects();
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLButtonElement>(".tasker-composer-cancel").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.composingProjectId = null;
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLInputElement>(".tasker-composer-input").forEach((input) => {
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        this.composingProjectId = null;
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLElement>(".rail-ttl").forEach((titleEl) => {
      const enter = (e: Event): void => {
        e.stopPropagation();
        const taskEl = (e.currentTarget as HTMLElement).closest<HTMLElement>(".tasker-task");
        const projectId = taskEl?.dataset.projectId;
        const taskId = taskEl?.dataset.taskId;
        if (!projectId || !taskId) return;
        this.editingTitle = { projectId, taskId };
        this.render();
      };
      titleEl.addEventListener("click", enter);
      titleEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") enter(e);
      });
    });

    this.host.querySelectorAll<HTMLInputElement>(".tasker-title-input").forEach((input) => {
      let settled = false;
      const commit = (): void => {
        if (settled) return;
        settled = true;
        const taskEl = input.closest<HTMLElement>(".tasker-task");
        const projectId = taskEl?.dataset.projectId;
        const taskId = taskEl?.dataset.taskId;
        const title = input.value.trim();
        this.editingTitle = null;
        if (projectId && taskId && title.length > 0) {
          this.storage.updateTask(projectId, taskId, { title });
        }
        this.render();
      };
      input.addEventListener("blur", commit);
      input.addEventListener("change", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          settled = true;
          this.editingTitle = null;
          this.render();
        }
      });
      queueMicrotask(() => input.focus());
    });

    this.bindDetailsEvents();

  }

  private bindDetailsEvents(): void {
    this.host.querySelectorAll<HTMLElement>(".tasker-edit").forEach((edit) => {
      const projectId = edit.dataset.projectId;
      const taskId = edit.dataset.taskId;
      if (!projectId || !taskId) return;

      const mount = edit.querySelector<HTMLElement>(".tasker-edit-note[data-note-mount]");
      if (mount && !mount.dataset.mounted) {
        mount.dataset.mounted = "1";
        const task = this.storage.getTask(projectId, taskId);
        const editor = new MarkdownEditor({
          value: task?.description ?? "",
          placeholder: "Add notes…",
          // Persist as the user types without re-rendering (which would tear
          // the Milkdown instance down mid-edit). A pending render flushes the
          // latest value via flushNoteEditors().
          onChange: (md) => {
            if (this.noteSaveTimer !== null) clearTimeout(this.noteSaveTimer);
            this.noteSaveTimer = window.setTimeout(() => {
              this.saveNote(projectId, taskId, md);
              this.noteSaveTimer = null;
            }, 300);
          },
        });
        mount.appendChild(editor.element);
        this.noteEditors.push({ editor, projectId, taskId });
      }

      const titleInput = edit.querySelector<HTMLInputElement>(".tasker-detail-title");
      if (titleInput) {
        const commit = (): void => {
          const title = titleInput.value.trim();
          const task = this.storage.getTask(projectId, taskId);
          if (!task || title.length === 0 || title === task.title) return;
          this.storage.updateTask(projectId, taskId, { title });
          this.render();
        };
        titleInput.addEventListener("blur", commit);
        titleInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            titleInput.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            titleInput.value = this.storage.getTask(projectId, taskId)?.title ?? titleInput.value;
            titleInput.blur();
          }
        });
      }

      // Estimate + Logged share the duration grammar; only the field differs.
      const bindDuration = (
        input: HTMLInputElement | null,
        field: "estimatedMinutes" | "spentMinutes",
      ): void => {
        if (!input) return;
        const stored = (): string => {
          const v = this.storage.getTask(projectId, taskId)?.[field];
          return v ? formatMinutes(v) : "";
        };
        const commit = (): void => {
          const task = this.storage.getTask(projectId, taskId);
          if (!task) return;
          const raw = input.value.trim();
          const minutes = raw ? parseDuration(raw) : null;
          if (raw && minutes === null) {
            // Unparseable: restore the stored value instead of guessing.
            input.value = stored();
            return;
          }
          if ((minutes ?? undefined) === task[field]) return;
          this.storage.updateTask(projectId, taskId, { [field]: minutes ?? undefined } as Partial<Task>);
          this.render();
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            input.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            input.value = stored();
            input.blur();
          }
        });
      };
      bindDuration(edit.querySelector<HTMLInputElement>(".tasker-est-input:not(.tasker-spent-input)"), "estimatedMinutes");
      bindDuration(edit.querySelector<HTMLInputElement>(".tasker-spent-input"), "spentMinutes");

      edit.querySelector<HTMLButtonElement>(".tasker-timer-btn")?.addEventListener("click", () => {
        const task = this.storage.getTask(projectId, taskId);
        if (!task) return;
        if (task.timerStartedAt) this.storage.stopTimer(projectId, taskId);
        else this.storage.startTimer(projectId, taskId);
        this.render();
      });

      edit.querySelectorAll<HTMLButtonElement>(".tasker-seg-status .tasker-seg-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const status = btn.dataset.status as TaskStatus | undefined;
          if (!status) return;
          this.storage.updateTask(projectId, taskId, {
            status,
            completedAt: status === "done" ? Date.now() : undefined,
          });
          this.render();
        });
      });

      edit.querySelectorAll<HTMLButtonElement>(".tasker-prio-dots .tasker-prio-dot").forEach((btn) => {
        btn.addEventListener("click", () => {
          const priority = btn.dataset.priority as TaskPriority | undefined;
          if (!priority) return;
          this.storage.updateTask(projectId, taskId, { priority });
          this.render();
        });
      });

      edit.querySelector<HTMLButtonElement>(".tasker-chip-due")?.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openDatePicker(projectId, taskId, e.currentTarget as HTMLElement);
      });

      edit.querySelector<HTMLButtonElement>(".tasker-sheet-delete")?.addEventListener("click", () => {
        this.storage.deleteTask(projectId, taskId);
        this.selectedTask = null;
        this.openMenu = null;
        this.render();
      });

      edit.querySelectorAll<HTMLButtonElement>(".tasker-sub-cb").forEach((btn) => {
        btn.addEventListener("click", () => {
          const subId = btn.closest<HTMLElement>(".tasker-sub")?.dataset.subtaskId;
          if (!subId) return;
          this.updateSubtasks(projectId, taskId, (subs) =>
            subs.map((s) => (s.id === subId ? { ...s, completed: !s.completed } : s)),
          );
        });
      });

      edit.querySelectorAll<HTMLButtonElement>(".tasker-sub-del").forEach((btn) => {
        btn.addEventListener("click", () => {
          const subId = btn.closest<HTMLElement>(".tasker-sub")?.dataset.subtaskId;
          if (!subId) return;
          this.updateSubtasks(projectId, taskId, (subs) => subs.filter((s) => s.id !== subId));
        });
      });

      edit.querySelector<HTMLFormElement>(".tasker-sub-add")?.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = (e.currentTarget as HTMLFormElement).querySelector<HTMLInputElement>(".tasker-sub-input");
        const title = input?.value.trim() ?? "";
        if (!title) return;
        this.updateSubtasks(projectId, taskId, (subs) => [
          ...subs,
          { id: generateId(), title, completed: false, createdAt: Date.now() },
        ]);
        // The render replaced the input — refocus the fresh one so the user
        // can keep typing the next subtask.
        queueMicrotask(() => {
          this.host
            .querySelector<HTMLInputElement>(
              `.tasker-edit[data-task-id="${taskId}"] .tasker-sub-input`,
            )
            ?.focus();
        });
      });
    });
  }

  private updateSubtasks(
    projectId: string,
    taskId: string,
    mutate: (subs: SubTask[]) => SubTask[],
  ): void {
    const task = this.storage.getTask(projectId, taskId);
    if (!task) return;
    const next = mutate(task.subtasks ?? []);
    this.storage.updateTask(projectId, taskId, {
      subtasks: next.length > 0 ? next : undefined,
    });
    this.render();
  }

  private saveNote(projectId: string, taskId: string, md: string): void {
    const description = md.trim();
    this.storage.updateTask(projectId, taskId, {
      description: description.length > 0 ? description : undefined,
    });
  }

  // Persist each open Notes editor's current value, then tear the Milkdown
  // instances down. Called at the top of render() so detached editors don't
  // leak and the latest unsaved keystrokes survive the re-render.
  private flushNoteEditors(): void {
    if (this.noteSaveTimer !== null) {
      clearTimeout(this.noteSaveTimer);
      this.noteSaveTimer = null;
    }
    for (const { editor, projectId, taskId } of this.noteEditors) {
      try {
        this.saveNote(projectId, taskId, editor.value);
      } catch {
        // Editor may not have finished booting; nothing to flush.
      }
      editor.destroy();
    }
    this.noteEditors = [];
  }

  private positionDateMenu(anchor: HTMLElement, cal: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    const margin = 8;
    const calW = cal.offsetWidth || 232;
    const calH = cal.offsetHeight || 280;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = r.right - calW;
    if (left + calW > vw - margin) left = vw - margin - calW;
    if (left < margin) left = Math.min(r.left, Math.max(margin, vw - margin - calW));
    let top = r.bottom + 4;
    if (top + calH > vh - margin) top = Math.max(margin, r.top - 4 - calH);
    cal.style.left = `${Math.round(left)}px`;
    cal.style.top = `${Math.round(top)}px`;
  }

  private showNewProjectDialog(): void {
    this.composingList = true;
    this.render();
  }

  private openComposer(projectId: string): void {
    this.composingProjectId = projectId;
    this.selectedTask = null;
    this.expandedProjects.add(projectId);
    this.saveExpandedProjects();
    this.render();
  }

  close(): void {
    this.host.classList.add("hidden");
    this.isOpen = false;
    document.body.classList.remove("tasker-board");
    if (this.timerTick !== null) {
      clearInterval(this.timerTick);
      this.timerTick = null;
    }
    if (this.boardKeyHandler) {
      document.removeEventListener("keydown", this.boardKeyHandler);
      this.boardKeyHandler = null;
    }
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.render();
  }
}
