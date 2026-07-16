import type {
  EscalationCard,
  OperatorRosterEntry,
  SessionSummary,
  TileStatus,
} from "../api";
import { renderAvatarHtml } from "../operator/avatars";
import { formatChord } from "../platform";
import { CustomSelect } from "../ui/select";
import { operatorStatus } from "./model";

export type ReplyScope = "one-shot" | "mission" | "global";

const REPLY_SCOPES: readonly ReplyScope[] = ["one-shot", "mission", "global"];

const STATUS_LABEL: Record<TileStatus, string> = {
  blocked: "needs you",
  "operator-thinking": "thinking",
  "awaiting-input": "waiting",
  working: "working",
  idle: "idle",
};

export interface CardCallbacks {
  /// Jump to a session's tab. keepOpen=false closes the overlay.
  onFocus: (sessionId: string, keepOpen: boolean) => void;
  /// Toggle expand/collapse for a multi-session operator.
  onToggleExpand: (operatorId: string) => void;
  /// Send a reply to a blocked session.
  onSubmit: (sessionId: string, text: string, scope: ReplyScope) => Promise<void>;
  /// Disable the operator on the given session(s). Single-click, no confirm —
  /// fully reversible (⌘O on the tab re-arms). Disabled sessions go inert and
  /// drop out of the next roster poll, so the card leaves on its own.
  onStop: (operatorId: string, sessionIds: string[]) => void;
}

/// One card per operator. Single-session operators render their session
/// inline; multi-session operators show an aggregate header and, when
/// expanded, one sub-row per session. Blocked sessions expand to show the
/// question, the executor's tail, and a reply composer.
export function renderOperatorCard(
  entry: OperatorRosterEntry,
  esc: Map<string, EscalationCard>,
  cb: CardCallbacks,
  expanded: ReadonlySet<string>,
): HTMLElement {
  const status = operatorStatus(entry);
  const root = document.createElement("article");
  root.className = `mc-card mc-card--${status}`;
  root.dataset.operatorId = entry.operator_id;

  const multi = entry.sessions.length > 1;
  const isOpen = entry.has_escalation || expanded.has(entry.operator_id);

  root.append(renderHeader(entry, status, multi, isOpen, cb));

  if (!multi) {
    const only = entry.sessions[0];
    if (only) root.append(renderSessionBody(only, esc.get(only.session_id), cb));
  } else if (isOpen) {
    const sub = document.createElement("div");
    sub.className = "mc-card__sub";
    for (const s of entry.sessions) sub.append(renderSubRow(s, esc.get(s.session_id), cb));
    root.append(sub);
  }
  return root;
}

function renderHeader(
  entry: OperatorRosterEntry,
  status: TileStatus,
  multi: boolean,
  isOpen: boolean,
  cb: CardCallbacks,
): HTMLElement {
  const head = document.createElement("div");
  head.className = "mc-card__head";

  const avatar = document.createElement("span");
  avatar.className = `mc-avatar mc-avatar--${status}`;
  avatar.innerHTML = renderAvatarHtml(entry.operator_avatar ?? "👤", 28);

  const name = document.createElement("strong");
  name.className = "mc-card__name";
  name.textContent = entry.operator_name;

  const pill = document.createElement("span");
  pill.className = `mc-pill mc-pill--${status}`;
  pill.textContent = status === "blocked" ? "NEEDS YOU" : STATUS_LABEL[status];

  head.append(avatar, name, pill);

  if (multi) {
    const blocked = entry.sessions.filter((s) => s.status === "blocked").length;
    const count = document.createElement("span");
    count.className = "mc-card__count";
    count.textContent =
      `${entry.sessions.length} sessions` + (blocked ? ` · ${blocked} blocked` : "");
    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "mc-card__caret";
    caret.setAttribute("aria-label", isOpen ? "Collapse" : "Expand");
    caret.textContent = isOpen ? "▾" : "▸";
    caret.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onToggleExpand(entry.operator_id);
    });
    head.append(count, caret);
  } else {
    const only = entry.sessions[0];
    if (only) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "mc-card__tab";
      tab.textContent = `→ ${only.tab_title}`;
      tab.addEventListener("click", (e) => {
        e.stopPropagation();
        cb.onFocus(only.session_id, false);
      });
      head.append(tab);
    }
  }

  // Stop: disable the operator on all its sessions. Single-click, no confirm
  // (reversible via ⌘O). For a multi-session operator this stops every session
  // at once. The disabled sessions go inert and drop from the next roster poll.
  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "mc-card__stop";
  stop.textContent = "Stop";
  stop.setAttribute("aria-label", "Stop operator");
  stop.addEventListener("click", (e) => {
    e.stopPropagation();
    cb.onStop(entry.operator_id, entry.sessions.map((s) => s.session_id));
  });
  head.append(stop);

  return head;
}

/// Body of a single-session card (or the detail inside a sub-row):
/// activity line, context chips, cost bar, and — when blocked — the
/// question, executor tail, and reply composer.
function renderSessionBody(
  s: SessionSummary,
  esc: EscalationCard | undefined,
  cb: CardCallbacks,
): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (s.status === "blocked" && esc) {
    const q = document.createElement("p");
    q.className = "mc-card__question";
    q.textContent = esc.question ?? "(no question text)";
    frag.append(q);
    if (esc.executor_excerpt) {
      const tail = document.createElement("pre");
      tail.className = "mc-card__tail";
      tail.textContent = esc.executor_excerpt;
      frag.append(tail);
    }
    frag.append(renderReply(s.session_id, cb.onSubmit));
    return frag;
  }

  const act = document.createElement("div");
  act.className = "mc-card__activity";
  act.textContent = activityLine(s);
  frag.append(act);

  const chips = contextChips(s);
  if (chips) frag.append(chips);

  const cost = costBar(s);
  if (cost) frag.append(cost);
  return frag;
}

function renderSubRow(
  s: SessionSummary,
  esc: EscalationCard | undefined,
  cb: CardCallbacks,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "mc-subrow";
  row.dataset.sessionId = s.session_id;

  const head = document.createElement("div");
  head.className = "mc-subrow__head";
  const dot = document.createElement("span");
  dot.className = `mc-dot mc-dot--${s.status}`;
  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "mc-subrow__tab";
  tab.textContent = s.tab_title;
  tab.addEventListener("click", () => cb.onFocus(s.session_id, false));
  const st = document.createElement("span");
  st.className = "mc-subrow__status";
  st.textContent = STATUS_LABEL[s.status];
  head.append(dot, tab, st);
  row.append(head, renderSessionBody(s, esc, cb));
  return row;
}

function activityLine(s: SessionSummary): string {
  const what = s.last_command ?? s.last_output_line ?? "…";
  return `${vendorLabel(s)} · ${what}`;
}

function vendorLabel(s: SessionSummary): string {
  if (s.vendor !== "unknown") return s.vendor;
  return s.raw_command_label ?? "shell";
}

function contextChips(s: SessionSummary): HTMLElement | null {
  const labels: string[] = [];
  if (s.mission_name) labels.push(`◈ ${s.mission_name}`);
  if (labels.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "mc-chips";
  for (const l of labels) {
    const chip = document.createElement("span");
    chip.className = "mc-chip";
    chip.textContent = l;
    wrap.append(chip);
  }
  return wrap;
}

function costBar(s: SessionSummary): HTMLElement | null {
  if (s.cost_usd == null || s.budget_usd == null) return null;
  const pct = s.budget_usd > 0 ? Math.min(100, (s.cost_usd / s.budget_usd) * 100) : 0;
  const wrap = document.createElement("div");
  wrap.className = "mc-cost";
  const bar = document.createElement("div");
  bar.className = "mc-cost__bar";
  const fill = document.createElement("i");
  fill.style.width = `${pct}%`;
  if (pct >= 90) fill.classList.add("mc-cost__fill--danger");
  else if (pct >= 70) fill.classList.add("mc-cost__fill--warn");
  bar.append(fill);
  const label = document.createElement("span");
  label.className = "mc-cost__label";
  label.textContent = `$${s.cost_usd.toFixed(2)} / $${s.budget_usd.toFixed(2)}`;
  wrap.append(bar, label);
  return wrap;
}

function renderReply(
  sessionId: string,
  onSubmit: CardCallbacks["onSubmit"],
): HTMLElement {
  const wrap = document.createElement("form");
  wrap.className = "mc-reply";
  wrap.addEventListener("submit", (e) => e.preventDefault());

  const textarea = document.createElement("textarea");
  textarea.className = "mc-reply__textarea";
  textarea.placeholder = "Reply to operator…";
  textarea.rows = 2;

  const controls = document.createElement("div");
  controls.className = "mc-reply__controls";
  const scope = new CustomSelect({
    className: "mc-reply__scope",
    ariaLabel: "Reply scope",
    value: "one-shot",
    options: ["one-shot", "mission", "global"].map((v) => ({ value: v, label: v })),
  });
  const send = document.createElement("button");
  send.type = "button";
  send.className = "mc-reply__send";
  send.textContent = `Send ${formatChord(["mod", "enter"])}`;

  const submit = async () => {
    const text = textarea.value.trim();
    if (!text) return;
    const raw = scope.value;
    const scopeVal: ReplyScope = REPLY_SCOPES.includes(raw as ReplyScope)
      ? (raw as ReplyScope)
      : "one-shot";
    await onSubmit(sessionId, text, scopeVal);
    textarea.value = "";
  };
  send.addEventListener("click", () => void submit());
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  });

  controls.append(scope.element, send);
  wrap.append(textarea, controls);
  return wrap;
}
