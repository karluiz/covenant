import type { ProposeTask, TaskArchetype, TeammateMessage, UpdateKind } from "../api";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";

/// One entry in a confirmed task's lifecycle history (started / cancelled /
/// resumed / …). Rendered as a node on the pill's collapsible drawer spine.
export interface TaskLifecycleEvent {
  kind: UpdateKind;
  ts: number;
}

export interface TaskCardHandlers {
  onConfirm: (messageId: string) => void;
  onCancel:  (messageId: string) => void;
  onEdit:    (messageId: string) => void;
  /// Optional: jump focus to the tab that this confirmed proposal spawned.
  /// When omitted, the pill renders without a clickable link.
  onOpenTab?: (taskId: string) => void;
  /// Optional: open the task detail view (Tasks tab, expanded). Fired
  /// when the user clicks the pill body or chevron — distinct from the
  /// "open tab" affordance which focuses the spawned PTY tab.
  onShowTask?: (taskId: string) => void;
  /// Optional label rendered on the confirmed pill ("tab "Integrate GitHub…"").
  /// When omitted, falls back to a generic "tab abierto".
  confirmedTabLabel?: string;
  /// Lifecycle history for a confirmed task, oldest-first. Drives the
  /// collapsed state chip + expandable drawer spine.
  lifecycle?: TaskLifecycleEvent[];
}

const ARCHETYPE_LABEL: Record<TaskArchetype, string> = {
  do: "Do", review: "Review", watch: "Watch",
};

export function renderTaskCard(
  msg: TeammateMessage,
  handlers: TaskCardHandlers,
): HTMLElement {
  if (msg.content.kind !== "propose") {
    throw new Error(`renderTaskCard called with non-propose content: ${msg.content.kind}`);
  }
  const propose: ProposeTask = msg.content.data;
  const { archetype, title } = propose.draft;
  const confirmed = msg.confirmed_at_unix_ms !== null;
  const cancelled = msg.dismissed_at_unix_ms !== null;

  // Confirmed proposals collapse into a single-line pill — once the user
  // accepted, the full deliverable/scope block is noise. Tab link uses
  // task_id only as a marker; the actual session lookup is the operator's.
  if (confirmed) {
    return renderConfirmedPill(msg, archetype, title, handlers);
  }
  if (cancelled) {
    return renderCancelledPill(msg, archetype, title);
  }

  return renderActionableCard(msg, propose, handlers);
}

function renderActionableCard(
  msg: TeammateMessage,
  propose: ProposeTask,
  handlers: TaskCardHandlers,
): HTMLElement {
  const { archetype, title, deliverable, scope } = propose.draft;
  const card = document.createElement("div");
  card.className = "task-card";
  card.dataset.messageId = msg.id;

  const header = document.createElement("div");
  header.className = "task-card__header";
  header.append(badge(archetype), titleSpan(title));

  const rows = document.createElement("dl");
  rows.className = "task-card__rows";
  rows.append(
    row("Archetype", `${ARCHETYPE_LABEL[archetype]} · ${archetypeHint(archetype)}`),
    row("Deliverable", deliverable),
  );
  const scopeStr = formatScope(scope);
  if (scopeStr) rows.append(row("Scope", scopeStr));

  const actions = document.createElement("div");
  actions.className = "task-card__actions";
  const confirmBtn = button("confirm", "Confirm", () => handlers.onConfirm(msg.id));
  const editBtn    = iconButton("edit",   Icons.pencil({ size: 14 }), "Edit",   () => handlers.onEdit(msg.id));
  const cancelBtn  = iconButton("cancel", Icons.x({ size: 14 }),      "Cancel", () => handlers.onCancel(msg.id));
  actions.append(confirmBtn, editBtn, cancelBtn);

  card.append(header, rows, actions);
  return card;
}

function renderConfirmedPill(
  msg: TeammateMessage,
  archetype: TaskArchetype,
  title: string,
  handlers: TaskCardHandlers,
): HTMLElement {
  const events = handlers.lifecycle ?? [];

  // The unit wraps the collapsed pill + its (hidden) lifecycle drawer so
  // expanding pushes history down without disturbing the chat layout.
  const unit = document.createElement("div");
  unit.className = "task-pill-unit";
  if (msg.task_id) unit.dataset.taskId = msg.task_id;

  const pill = document.createElement("div");
  pill.className = "task-pill task-pill--confirmed";
  pill.dataset.messageId = msg.id;
  pill.dataset.confirmed = "true";
  if (handlers.onShowTask && msg.task_id) {
    pill.classList.add("task-pill--clickable");
    pill.setAttribute("role", "button");
    pill.tabIndex = 0;
    const openDetail = () => handlers.onShowTask?.(msg.task_id ?? "");
    pill.addEventListener("click", (e) => {
      // The toggle + open-tab controls have their own handlers — clicking
      // them must not also open the detail view.
      if ((e.target as HTMLElement).closest("[data-action]")) return;
      openDetail();
    });
    pill.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); }
    });
  }

  pill.append(badge(archetype, "task-pill__badge"));

  const titleEl = document.createElement("span");
  titleEl.className = "task-pill__title";
  titleEl.textContent = title;
  pill.append(titleEl);

  // Current-state chip — derived from the latest lifecycle event.
  const { label: stateLabel, tone } = currentState(events);
  const state = document.createElement("span");
  state.className = `task-pill__state task-pill__state--${tone}`;
  const led = document.createElement("span");
  led.className = "task-pill__led";
  state.append(led, document.createTextNode(stateLabel));
  pill.append(state);

  unit.append(pill);

  // No history yet (e.g. a just-confirmed task before its "started" event
  // lands) → leave the pill bare; the reload on the first task_update will
  // repaint it with the toggle + drawer.
  if (events.length > 0) {
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "task-pill__toggle";
    toggle.dataset.action = "toggle-drawer";
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = `${events.length} <span class="chev" aria-hidden="true">⌄</span>`;
    attachTooltip(toggle, "Show task history");
    pill.append(toggle);

    const drawer = renderLifecycleDrawer(msg, events, handlers);
    unit.append(drawer);

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = unit.classList.toggle("is-open");
      drawer.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    });
  }

  return unit;
}

function renderLifecycleDrawer(
  msg: TeammateMessage,
  events: TaskLifecycleEvent[],
  handlers: TaskCardHandlers,
): HTMLElement {
  const drawer = document.createElement("div");
  drawer.className = "task-pill-drawer";
  drawer.hidden = true;

  events.forEach((ev, i) => {
    const isLast = i === events.length - 1;
    const item = document.createElement("div");
    item.className = `tpl-item tpl--${nodeTone(ev.kind)}`;
    if (isLast && nodeTone(ev.kind) === "ok") item.classList.add("tpl-item--current");

    const node = document.createElement("span");
    node.className = "tpl-node";
    const label = document.createElement("span");
    label.className = "tpl-label";
    label.textContent = EVENT_LABEL[ev.kind];
    const time = document.createElement("span");
    time.className = "tpl-time";
    time.textContent = relTime(ev.ts);
    item.append(node, label, time);
    drawer.append(item);
  });

  if (handlers.onOpenTab && msg.task_id) {
    const footer = document.createElement("div");
    footer.className = "tpl-footer";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "tpl-open";
    open.dataset.action = "open-tab";
    open.textContent = `${handlers.confirmedTabLabel ?? "Open tab"} →`;
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      handlers.onOpenTab?.(msg.task_id ?? "");
    });
    footer.append(open);
    drawer.append(footer);
  }

  return drawer;
}

const EVENT_LABEL: Record<UpdateKind, string> = {
  started:   "Started in a new tab",
  progress:  "Update in progress",
  blocked:   "Blocked",
  resumed:   "Resumed",
  completed: "Completed",
  cancelled: "Cancelled",
};

type StateTone = "ok" | "warn" | "muted";

/// Collapsed-pill status, derived from the most recent lifecycle event.
function currentState(events: TaskLifecycleEvent[]): { label: string; tone: StateTone } {
  const last = events[events.length - 1];
  if (!last) return { label: "Active", tone: "ok" };
  switch (last.kind) {
    case "started":
    case "resumed":
    case "progress":  return { label: "Active",    tone: "ok" };
    case "blocked":   return { label: "Blocked",   tone: "warn" };
    case "completed": return { label: "Done",      tone: "ok" };
    case "cancelled": return { label: "Cancelled", tone: "muted" };
  }
}

function nodeTone(kind: UpdateKind): StateTone {
  switch (kind) {
    case "blocked":   return "warn";
    case "cancelled": return "muted";
    default:          return "ok";
  }
}

/// Compact relative time ("now" / "4m" / "3h" / "2d") for the drawer spine.
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 45_000) return "now";
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function renderCancelledPill(
  msg: TeammateMessage,
  archetype: TaskArchetype,
  title: string,
): HTMLElement {
  const pill = document.createElement("div");
  pill.className = "task-pill task-pill--cancelled";
  pill.dataset.messageId = msg.id;
  pill.dataset.cancelled = "true";

  pill.append(badge(archetype, "task-pill__badge"));

  const titleEl = document.createElement("span");
  titleEl.className = "task-pill__title";
  titleEl.textContent = title;
  pill.append(titleEl);

  const tag = document.createElement("span");
  tag.className = "task-pill__tag";
  tag.textContent = "cancelled";
  pill.append(tag);

  return pill;
}

function row(label: string, value: string): HTMLElement {
  const dt = document.createElement("dt"); dt.textContent = label;
  const dd = document.createElement("dd"); dd.textContent = value;
  const wrap = document.createElement("div");
  wrap.className = "task-card__row";
  wrap.append(dt, dd);
  return wrap;
}

function badge(archetype: TaskArchetype, extraClass = ""): HTMLElement {
  const b = document.createElement("span");
  b.className = `task-card__badge ${extraClass}`.trim();
  b.dataset.archetype = archetype;
  b.textContent = ARCHETYPE_LABEL[archetype];
  return b;
}

function titleSpan(title: string): HTMLElement {
  const t = document.createElement("span");
  t.className = "task-card__title";
  t.textContent = title;
  return t;
}

function button(action: "confirm", label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.action = action;
  b.className = `task-card__btn task-card__btn--${action}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function iconButton(
  action: "edit" | "cancel",
  svg: string,
  tooltip: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.action = action;
  b.className = `task-card__btn task-card__btn--${action} task-card__btn--icon`;
  b.setAttribute("aria-label", tooltip);
  b.innerHTML = svg;
  attachTooltip(b, tooltip);
  b.addEventListener("click", onClick);
  return b;
}

function archetypeHint(a: TaskArchetype): string {
  switch (a) {
    case "do":     return "spawns a new tab";
    case "review": return "inspects a PR / file";
    case "watch":  return "subscribes to a trigger";
  }
}

function formatScope(scope: { paths?: string[]; tabs?: string[] }): string {
  const parts: string[] = [];
  if (scope.paths?.length) parts.push(scope.paths.join(", "));
  if (scope.tabs?.length)  parts.push(`tabs: ${scope.tabs.length}`);
  return parts.join(" · ");
}
