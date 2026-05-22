import type { ProposeTask, TaskArchetype, TeammateMessage } from "../api";

export interface TaskCardHandlers {
  onConfirm: (messageId: string) => void;
  onCancel:  (messageId: string) => void;
  onEdit:    (messageId: string) => void;
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
  const { archetype, title, deliverable, scope } = propose.draft;

  const card = document.createElement("div");
  card.className = "task-card";
  card.dataset.messageId = msg.id;
  const confirmed = msg.confirmed_at_unix_ms !== null;
  const cancelled = msg.dismissed_at_unix_ms !== null;
  if (confirmed) card.classList.add("task-card--confirmed");
  if (cancelled) card.classList.add("task-card--cancelled");

  const header = document.createElement("div");
  header.className = "task-card__header";
  const badge = document.createElement("span");
  badge.className = "task-card__badge";
  badge.dataset.archetype = archetype;
  badge.textContent = ARCHETYPE_LABEL[archetype];
  const titleEl = document.createElement("span");
  titleEl.className = "task-card__title";
  titleEl.textContent = title;
  header.append(badge, titleEl);

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
  const editBtn    = button("edit",    "Editar",    () => handlers.onEdit(msg.id));
  const cancelBtn  = button("cancel",  "Cancelar",  () => handlers.onCancel(msg.id));
  if (confirmed || cancelled) {
    confirmBtn.disabled = true;
    editBtn.disabled = true;
    cancelBtn.disabled = true;
  }
  actions.append(confirmBtn, editBtn, cancelBtn);

  if (confirmed) {
    const footer = document.createElement("div");
    footer.className = "task-card__footer";
    footer.textContent = "confirmed";
    card.append(header, rows, actions, footer);
  } else if (cancelled) {
    const footer = document.createElement("div");
    footer.className = "task-card__footer";
    footer.textContent = "cancelled";
    card.append(header, rows, actions, footer);
  } else {
    card.append(header, rows, actions);
  }
  return card;
}

function row(label: string, value: string): HTMLElement {
  const dt = document.createElement("dt"); dt.textContent = label;
  const dd = document.createElement("dd"); dd.textContent = value;
  const wrap = document.createElement("div");
  wrap.className = "task-card__row";
  wrap.append(dt, dd);
  return wrap;
}

function button(action: "confirm" | "edit" | "cancel", label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.action = action;
  b.className = `task-card__btn task-card__btn--${action}`;
  b.textContent = label;
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
