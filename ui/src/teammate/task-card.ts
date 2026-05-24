import type { ProposeTask, TaskArchetype, TeammateMessage } from "../api";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";

export interface TaskCardHandlers {
  onConfirm: (messageId: string) => void;
  onCancel:  (messageId: string) => void;
  onEdit:    (messageId: string) => void;
  /// Optional: jump focus to the tab that this confirmed proposal spawned.
  /// When omitted, the pill renders without a clickable link.
  onOpenTab?: (taskId: string) => void;
  /// Optional label rendered on the confirmed pill ("tab "Integrate GitHub…"").
  /// When omitted, falls back to a generic "tab abierto".
  confirmedTabLabel?: string;
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
  const confirmBtn = button("confirm", "Confirmar", () => handlers.onConfirm(msg.id));
  const editBtn    = iconButton("edit",   Icons.pencil({ size: 14 }), "Editar",   () => handlers.onEdit(msg.id));
  const cancelBtn  = iconButton("cancel", Icons.x({ size: 14 }),      "Cancelar", () => handlers.onCancel(msg.id));
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
  const pill = document.createElement("div");
  pill.className = "task-pill task-pill--confirmed";
  pill.dataset.messageId = msg.id;
  pill.dataset.confirmed = "true";

  pill.append(badge(archetype, "task-pill__badge"));

  const titleEl = document.createElement("span");
  titleEl.className = "task-pill__title";
  titleEl.textContent = title;
  pill.append(titleEl);

  const meta = document.createElement("span");
  meta.className = "task-pill__meta";
  meta.textContent = "→";
  pill.append(meta);

  const link = document.createElement("button");
  link.type = "button";
  link.className = "task-pill__link";
  link.dataset.action = "open-tab";
  link.textContent = handlers.confirmedTabLabel ?? "tab abierto";
  if (handlers.onOpenTab && msg.task_id) {
    link.addEventListener("click", () => handlers.onOpenTab?.(msg.task_id ?? ""));
  } else {
    link.disabled = true;
  }
  pill.append(link);

  const chev = document.createElement("span");
  chev.className = "task-pill__chevron";
  chev.textContent = "›";
  chev.setAttribute("aria-hidden", "true");
  pill.append(chev);

  return pill;
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
  tag.textContent = "cancelada";
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
    case "do":     return "spawnea tab nuevo";
    case "review": return "inspecciona PR/archivo";
    case "watch":  return "suscribe a trigger";
  }
}

function formatScope(scope: { paths?: string[]; tabs?: string[] }): string {
  const parts: string[] = [];
  if (scope.paths?.length) parts.push(scope.paths.join(", "));
  if (scope.tabs?.length)  parts.push(`tabs: ${scope.tabs.length}`);
  return parts.join(" · ");
}
