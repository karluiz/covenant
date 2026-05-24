import type { Operator, Task, TaskArchetype, TeammateMessage, TeammateToolCall, UpdateKind } from "../api";
import {
  injectCommand, onTeammateMessage, onTeammateToolCall, operatorLevelFromXp,
  operatorList, teammateAttachSessionToTask, teammateCancelTaskProposal,
  teammateClearForOperator, teammateConfirmTask, teammateEditTaskProposal,
  teammateListMessages, teammateListTasks, teammateSendText,
} from "../api";
import { Icons } from "../icons";
import { renderAvatarHtml } from "../operator/avatars";
import { attachTooltip } from "../tooltip/tooltip";
import { renderTaskCard } from "./task-card";

const CHEVRON_DOWN_SVG =
  '<svg class="teammate-panel-header-chevron" viewBox="0 0 16 16" aria-hidden="true">' +
    '<path d="M4 6.5 L8 10.5 L12 6.5" fill="none" stroke="currentColor" ' +
          'stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

const ARCHETYPE_LABEL: Record<TaskArchetype, string> = {
  do: "Do", review: "Review", watch: "Watch",
};

function renderHeaderAvatarWithRing(operator: Operator | null): string {
  const xp = operator?.xp ?? 0;
  const xpProgress = Math.max(0, Math.min(1, (xp % 100) / 100));
  const avatar = renderAvatarHtml(operator?.emoji ?? "🤖", 32);
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

export interface TeammatePanelDeps {
  listMessages:  (operatorId: string, limit?: number) => Promise<TeammateMessage[]>;
  sendText:      (operatorId: string, text: string, activeSessionId?: string | null) => Promise<TeammateMessage>;
  listOperators: () => Promise<Operator[]>;
  onMessage?:    (handler: (msg: TeammateMessage) => void) => Promise<() => void>;
  onToolCall?:   (handler: (call: TeammateToolCall) => void) => Promise<() => void>;
  getActiveSessionId?: () => string | null;
  confirmTask?:        (operatorId: string, messageId: string) => Promise<Task>;
  cancelTaskProposal?: (messageId: string) => Promise<void>;
  editTaskProposal?:   (messageId: string, draft: import("../api").TaskDraft) => Promise<void>;
  attachSessionToTask?: (operatorId: string, taskId: string, sessionId: string) => Promise<void>;
  spawnTabForTask?: (task: Task) => Promise<{ sessionId: string }>;
  /// Fetch all tasks for the operator (proposed/active/done). Powers the Tasks tab.
  listTasks?:       (operatorId: string) => Promise<Task[]>;
  /// Activate the tab whose backing SessionId matches. Returns true if found.
  focusTabBySessionId?: (sessionId: string) => boolean;
  /// Wipe all messages + tasks for this operator (test/reset affordance).
  clearForOperator?:    (operatorId: string) => Promise<void>;
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
};

interface SystemLineStyle {
  text: string;
  tone: "ok" | "warn" | "err" | "muted";
}

function taskUpdateSummary(kind: UpdateKind): SystemLineStyle {
  switch (kind) {
    case "started":   return { text: "Tarea iniciada en un tab nuevo.", tone: "ok" };
    case "progress":  return { text: "Actualización en curso.",         tone: "muted" };
    case "blocked":   return { text: "Tarea bloqueada.",                tone: "warn" };
    case "resumed":   return { text: "Tarea retomada.",                 tone: "ok" };
    case "completed": return { text: "Tarea completada.",               tone: "ok" };
    case "cancelled": return { text: "Tarea cancelada.",                tone: "muted" };
  }
}

/// Translate known backend error strings to user-facing Spanish copy.
/// Unknown errors fall back to a generic message — the raw error still
/// lands in console.error for devs.
function friendlyError(action: "confirm" | "cancel" | "edit", raw: string): { title: string; body: string } {
  const r = raw.toLowerCase();
  if (r.includes("operator already on task")) {
    return {
      title: "Mibli ya está trabajando en otra tarea.",
      body:  "Terminá o liberá la tarea actual antes de iniciar esta.",
    };
  }
  if (r.includes("proposal already confirmed")) {
    return {
      title: "Esta propuesta ya fue confirmada.",
      body:  "Mirá la pestaña Tasks para ver el estado.",
    };
  }
  if (r.includes("proposal already dismissed") || r.includes("already cancelled")) {
    return {
      title: "Esta propuesta ya estaba cancelada.",
      body:  "Pedile a Mibli que cree una nueva si la necesitás.",
    };
  }
  if (r.includes("not found")) {
    return {
      title: "No encontré esa propuesta.",
      body:  "Puede haber sido borrada. Recargá la conversación.",
    };
  }
  const verb = action === "confirm" ? "confirmar" : action === "cancel" ? "cancelar" : "editar";
  return {
    title: `No pude ${verb} la tarea.`,
    body:  raw,
  };
}

export class TeammatePanel {
  private host: HTMLElement;
  private deps: TeammatePanelDeps;
  private operator: Operator | null = null;
  private roster: Operator[] = [];
  private threadEl: HTMLElement | null = null;
  private tasksEl: HTMLElement | null = null;
  private composerEl: HTMLElement | null = null;
  private tabsBarEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private headerEl: HTMLElement | null = null;
  private switcherEl: HTMLElement | null = null;
  private dismissSwitcher: ((e: Event) => void) | null = null;
  private unlisten: (() => void) | null = null;
  private unlistenToolCall: (() => void) | null = null;
  private viewMode: "chat" | "tasks" = "chat";
  private tasksCache: Task[] = [];
  private tasksFilter: "all" | "active" | "proposed" | "done" = "all";
  private resetBtnEl: HTMLButtonElement | null = null;
  private resetArmed = false;
  private resetArmTimer: number | null = null;

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
      this.renderComposer(),
    );
    this.applyViewMode();
    const [messages] = await Promise.all([
      this.deps.listMessages(operator.id, 200),
      this.deps.listOperators().then((ops) => { this.roster = ops; }).catch(() => { /* ignore */ }),
      this.refreshTasks(),
    ]);
    this.paintMessages(messages);
    if (!this.unlisten && this.deps.onMessage) {
      this.unlisten = await this.deps.onMessage((m) => this.onIncomingMessage(m));
    }
    if (!this.unlistenToolCall && this.deps.onToolCall) {
      this.unlistenToolCall = await this.deps.onToolCall((c) => this.onIncomingToolCall(c));
    }
  }

  close(): void {
    this.closeSwitcher();
    this.unlisten?.();
    this.unlisten = null;
    this.unlistenToolCall?.();
    this.unlistenToolCall = null;
    this.operator = null;
    this.host.style.removeProperty("--operator-color");
    this.host.innerHTML = "";
    this.host.classList.remove("teammate-panel");
  }

  async send(text: string): Promise<void> {
    if (!this.operator) return;
    if (!text.trim()) return;
    const activeId = this.deps.getActiveSessionId?.() ?? null;
    const msg = await this.deps.sendText(this.operator.id, text.trim(), activeId);
    this.appendBubble(msg);
    if (this.inputEl) this.inputEl.value = "";
    this.setTyping(true);
  }

  private renderHeader(): HTMLElement {
    const h = document.createElement("button");
    h.type = "button";
    h.className = "teammate-panel-header";
    h.setAttribute("aria-label", "Switch teammate");
    const op = this.operator;
    const level = operatorLevelFromXp(op?.xp ?? 0);
    h.innerHTML = `
      ${renderHeaderAvatarWithRing(op)}
      <span class="teammate-panel-titlebox">
        <span class="teammate-panel-title-row">
          <span class="teammate-panel-title-name">${escapeHtml(op?.name ?? "")}</span>
          <span class="teammate-panel-level">Lv ${level}</span>
        </span>
        <span class="teammate-panel-subtitle">${escapeHtml(op?.model ?? "")}</span>
      </span>
      ${CHEVRON_DOWN_SVG}
    `;
    h.addEventListener("click", () => this.toggleSwitcher());
    this.headerEl = h;
    return h;
  }

  private renderTabsBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "teammate-panel-tabs";
    bar.append(
      this.renderTabButton("chat",  "Chat"),
      this.renderTabButton("tasks", "Tasks"),
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
    attachTooltip(b, "Borrar chats y tareas de este operador");
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.handleResetClick();
    });
    this.resetBtnEl = b;
    return b;
  }

  private setResetArmed(armed: boolean): void {
    this.resetArmed = armed;
    const b = this.resetBtnEl;
    if (!b) return;
    if (armed) {
      b.classList.add("is-armed");
      b.innerHTML = "";
      const label = document.createElement("span");
      label.className = "teammate-panel-reset__label";
      label.textContent = "Confirmar";
      b.append(label);
      if (this.resetArmTimer) window.clearTimeout(this.resetArmTimer);
      this.resetArmTimer = window.setTimeout(() => this.setResetArmed(false), 4000);
    } else {
      b.classList.remove("is-armed");
      b.innerHTML = Icons.trash({ size: 14 });
      if (this.resetArmTimer) {
        window.clearTimeout(this.resetArmTimer);
        this.resetArmTimer = null;
      }
    }
  }

  private async handleResetClick(): Promise<void> {
    if (!this.operator) return;
    const { clearForOperator } = this.deps;
    if (!clearForOperator) {
      this.appendErrorCard("Acción no disponible", "clearForOperator no está conectado.");
      return;
    }
    if (!this.resetArmed) {
      this.setResetArmed(true);
      return;
    }
    this.setResetArmed(false);
    try {
      await clearForOperator(this.operator.id);
      this.tasksCache = [];
      this.paintMessages([]);
      this.paintTasks();
      this.updateTasksCount();
    } catch (e) {
      console.error("clearForOperator failed", e);
      this.appendErrorCard("No pude resetear el operador.", String(e));
    }
  }

  private renderTabButton(mode: "chat" | "tasks", label: string): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "teammate-panel-tab";
    b.dataset.tab = mode;
    const labelSpan = document.createElement("span");
    labelSpan.textContent = label;
    b.append(labelSpan);
    if (mode === "tasks") {
      const count = document.createElement("span");
      count.className = "teammate-panel-tab-count";
      count.dataset.role = "count";
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
    // Use a class instead of the `hidden` attribute — the existing
    // `.teammate-panel-thread` rule sets `display: flex`, which beats
    // the attribute's default `display: none`. Class is `!important` in CSS.
    this.threadEl?.classList.toggle("is-hidden", !chat);
    this.composerEl?.classList.toggle("is-hidden", !chat);
    this.tasksEl?.classList.toggle("is-hidden", chat);
  }

  private renderThread(): HTMLElement {
    const t = document.createElement("div");
    t.className = "teammate-panel-thread";
    this.threadEl = t;
    return t;
  }

  private renderTasksView(): HTMLElement {
    const t = document.createElement("div");
    t.className = "teammate-panel-tasks is-hidden";
    this.tasksEl = t;
    return t;
  }

  private renderComposer(): HTMLElement {
    const c = document.createElement("form");
    c.className = "teammate-panel-composer";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `hablar con ${this.operator?.name ?? ""}…`;
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.setAttribute("autocorrect", "off");
    input.spellcheck = false;
    input.className = "teammate-panel-input";
    this.inputEl = input;
    c.append(input);
    c.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send(input.value);
    });
    this.composerEl = c;
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
      empty.textContent = "Sin tareas todavía. Pedile una a tu operador.";
      this.tasksEl.append(empty);
      return;
    }

    const filtered = this.tasksCache.filter((t) => this.matchesFilter(t));
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "teammate-panel-empty";
      empty.textContent = "Sin tareas en este filtro.";
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

    const dot = document.createElement("span");
    dot.className = "task-item__status";
    item.append(dot);

    const title = document.createElement("div");
    title.className = "task-item__title";
    title.textContent = task.title;
    item.append(title);

    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "task-item__cta";
    if (task.status === "active" || task.status === "blocked") {
      cta.textContent = "Open tab";
      cta.disabled = !task.spawned_session || !this.deps.focusTabBySessionId;
      cta.addEventListener("click", () => {
        if (task.spawned_session) this.deps.focusTabBySessionId?.(task.spawned_session);
      });
    } else if (task.status === "draft") {
      cta.textContent = "Review";
      cta.disabled = true;
    } else {
      cta.textContent = "View";
      cta.disabled = true;
    }
    item.append(cta);

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
    item.append(meta);

    return item;
  }

  private paintMessages(msgs: TeammateMessage[]): void {
    if (!this.threadEl) return;
    this.threadEl.innerHTML = "";
    if (msgs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "teammate-panel-empty";
      const name = this.operator?.name ?? "tu operador";
      empty.textContent = `Sin conversación aún. Empezá hablándole a ${name}.`;
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
      confirmedTabLabel: this.tabLabelForMessage(msg),
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
    if (!raw) return "tab abierto";
    const trimmed = raw.length > 24 ? `${raw.slice(0, 22)}…` : raw;
    return `tab "${trimmed}"`;
  }

  private focusTabForTaskId(taskId: string): void {
    const task = this.tasksCache.find((t) => t.id === taskId);
    const sid = task?.spawned_session;
    if (sid) this.deps.focusTabBySessionId?.(sid);
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
    const { confirmTask, spawnTabForTask, attachSessionToTask } = this.deps;
    if (!confirmTask) {
      this.appendErrorCard("Acción no disponible", "confirmTask no está conectado.");
      return;
    }
    try {
      const task = await confirmTask(this.operator.id, messageId);
      if (task.archetype === "do" && spawnTabForTask && attachSessionToTask) {
        const { sessionId } = await spawnTabForTask(task);
        await attachSessionToTask(this.operator.id, task.id, sessionId);
        // Inject the task as a shell comment at the prompt — no newline,
        // so the user reviews/edits and presses Enter when ready. Leading
        // `#` makes it harmless even if Enter is hit accidentally.
        const prompt = buildTaskPrompt(task.title, task.deliverable);
        // Small delay so the shell has produced its prompt before we type.
        window.setTimeout(() => {
          void injectCommand(sessionId, prompt).catch((e) => {
            console.error("injectCommand for task failed", e);
          });
        }, 250);
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
      this.appendErrorCard("Acción no disponible", "cancelTaskProposal no está conectado.");
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
    const nextTitle = window.prompt("Editar título de la tarea:", current.title);
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
    this.appendBubble(msg);
    if (msg.content.kind === "task_update") void this.refreshTasks();
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
  const escaped = escapeHtml(text);
  return escaped.replace(/`([^`\n]+)`/g, '<code>$1</code>');
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
    case "active":    return "activa";
    case "blocked":   return "bloqueada";
    case "draft":     return "propuesta";
    case "done":      return "completada";
    case "cancelled": return "cancelada";
  }
}

function buildTaskPrompt(title: string, deliverable: string): string {
  const parts = [title.trim(), deliverable.trim()].filter(Boolean);
  return `# ${parts.join(" — ")} `;
}

function formatAge(unixMs: number): string {
  const diffSec = Math.max(0, (Date.now() - unixMs) / 1000);
  if (diffSec < 60)    return `${Math.floor(diffSec)}s`;
  if (diffSec < 3600)  return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}
