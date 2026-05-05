import type { EscalationCard, OperatorRosterEntry, SessionSummary } from "../api";

type SubmitFn = (
  sessionId: string,
  text: string,
  scope: "one-shot" | "mission" | "global",
) => Promise<void>;

// =============== Inbox ===============

export interface InboxCardCallbacks {
  onActivate: (sessionId: string) => void;
  onSubmit: SubmitFn;
}

export function renderInboxCard(
  card: EscalationCard,
  isActive: boolean,
  cb: InboxCardCallbacks,
): HTMLElement {
  const root = document.createElement("article");
  root.className = "cv-inbox-card";
  root.dataset.sessionId = card.session_id;
  if (isActive) root.classList.add("cv-inbox-card--active");
  root.tabIndex = 0;

  const header = document.createElement("header");
  header.className = "cv-inbox-card__header";
  const avatar = document.createElement("span");
  avatar.className = "cv-avatar";
  avatar.textContent = card.operator_avatar ?? "👤";
  const title = document.createElement("strong");
  title.className = "cv-inbox-card__title";
  title.textContent = `${card.operator_name} · ${card.tab_title}`;
  const pill = document.createElement("span");
  pill.className = "cv-pill cv-pill--escalated";
  pill.textContent = "ESCALATED";
  const meta = document.createElement("span");
  meta.className = "cv-inbox-card__meta";
  meta.textContent = formatAgo(card.escalated_at_unix_ms);
  header.append(avatar, title, pill, meta);

  const question = document.createElement("p");
  question.className = "cv-inbox-card__question";
  question.textContent = card.question ?? "(no question text)";

  root.append(header, question);

  if (isActive) {
    root.append(renderReplyComposer(card.session_id, cb.onSubmit));
  }

  root.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".cv-reply")) return;
    cb.onActivate(card.session_id);
  });

  return root;
}

function renderReplyComposer(sessionId: string, onSubmit: SubmitFn): HTMLElement {
  const wrap = document.createElement("form");
  wrap.className = "cv-reply";
  wrap.addEventListener("submit", (e) => e.preventDefault());

  const textarea = document.createElement("textarea");
  textarea.className = "cv-reply__textarea";
  textarea.placeholder = "Reply to operator…";
  textarea.rows = 2;
  textarea.addEventListener("input", () => autoGrow(textarea));

  const controls = document.createElement("div");
  controls.className = "cv-reply__controls";
  const scope = document.createElement("select");
  scope.className = "cv-reply__scope";
  for (const v of ["one-shot", "mission", "global"]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    scope.append(o);
  }
  const send = document.createElement("button");
  send.type = "button";
  send.className = "cv-reply__send";
  send.textContent = "Send ⌘↵";

  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    await onSubmit(
      sessionId,
      text,
      scope.value as "one-shot" | "mission" | "global",
    );
    textarea.value = "";
    autoGrow(textarea);
  };

  send.addEventListener("click", () => void submit());
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  });

  controls.append(scope, send);
  wrap.append(textarea, controls);
  // Auto-focus the textarea so the active card is immediately ready
  // for typing — required by the spec's keyboard-first reply UX.
  queueMicrotask(() => textarea.focus());
  return wrap;
}

function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  const max = lh * 8;
  ta.style.height = Math.min(ta.scrollHeight, max) + "px";
  ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
}

function formatAgo(unixMs: number): string {
  if (!unixMs) return "just now";
  const seconds = Math.max(0, Math.floor((Date.now() - unixMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// =============== Roster (stubs filled in Task 5) ===============

export interface RosterRowCallbacks {
  onFocus: (sessionId: string, keepOpen: boolean) => void;
  onToggleExpand: (operatorId: string) => void;
}

export function renderRosterRow(
  _entry: OperatorRosterEntry,
  _expanded: boolean,
  _cb: RosterRowCallbacks,
): HTMLElement {
  const placeholder = document.createElement("div");
  placeholder.className = "cv-roster-row";
  placeholder.textContent = "(roster row — Task 5)";
  return placeholder;
}

export function renderRosterSubRow(
  _summary: SessionSummary,
  _cb: RosterRowCallbacks,
): HTMLElement {
  return document.createElement("div");
}
