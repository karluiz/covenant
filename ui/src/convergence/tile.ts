import type { AgentCard, SubAgentRow, TileStatus } from "../api";
import { renderAvatarHtml } from "../operator/avatars";
import { formatChord } from "../platform";
import { CustomSelect } from "../ui/select";

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
  /// Send a reply to a blocked (escalated) operator session.
  onSubmit: (sessionId: string, text: string, scope: ReplyScope) => Promise<void>;
  /// Operator cards only: disable the operator on this session.
  /// Single-click, no confirm — fully reversible (⌘O on the tab re-arms).
  onStop: (sessionId: string) => void;
}

/// One grid card per agent session. Blocked sessions surface their full
/// interaction (question, tail, composer) in the attention queue above
/// the grid — the grid card stays informational.
export function renderAgentCard(card: AgentCard, cb: CardCallbacks): HTMLElement {
  const root = document.createElement("article");
  root.className = `mc-card mc-card--${card.status}`;
  root.dataset.sessionId = card.session_id;
  root.append(renderHeader(card, cb));
  root.append(renderBody(card));
  return root;
}

function renderHeader(card: AgentCard, cb: CardCallbacks): HTMLElement {
  const head = document.createElement("div");
  head.className = "mc-card__head";

  const dot = document.createElement("span");
  dot.className = `mc-dot mc-dot--${card.status}`;

  const exec = document.createElement("strong");
  exec.className = "mc-card__exec";
  exec.textContent = card.executor ?? vendorLabel(card);

  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "mc-card__tab";
  tab.textContent = `→ ${card.tab_title}`;
  tab.addEventListener("click", (e) => {
    e.stopPropagation();
    cb.onFocus(card.session_id, false);
  });

  const pill = document.createElement("span");
  pill.className = `mc-pill mc-pill--${card.status}`;
  pill.textContent = card.status === "blocked" ? "NEEDS YOU" : STATUS_LABEL[card.status];

  head.append(dot, exec, tab, pill);

  if (card.operator_id) {
    const op = document.createElement("span");
    op.className = "mc-oplabel";
    op.innerHTML = `${renderAvatarHtml(card.operator_avatar ?? "👤", 18)}<span>${card.operator_name ?? ""}</span>`;
    head.append(op);

    // Stop: disable the operator on this session. The disabled session
    // goes inert; the card itself stays (it's still an agent session).
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "mc-card__stop";
    stop.textContent = "Stop";
    stop.setAttribute("aria-label", "Stop operator");
    stop.addEventListener("click", (e) => {
      e.stopPropagation();
      cb.onStop(card.session_id);
    });
    head.append(stop);
  }

  return head;
}

/// Card body: activity line, context chips, cost bar.
function renderBody(card: AgentCard): DocumentFragment {
  const frag = document.createDocumentFragment();

  const act = document.createElement("div");
  act.className = "mc-card__activity";
  act.textContent = card.phase_label ?? activityLine(card);
  frag.append(act);

  if (card.subagents.length > 0) frag.append(renderSubAgents(card.subagents));

  const chips = contextChips(card);
  if (chips) frag.append(chips);

  const cost = costBar(card);
  if (cost) frag.append(cost);
  return frag;
}

/// Live sub-agent rows (ACP Task tool calls). Elapsed is computed per
/// render — the overlay's 1s poll keeps it fresh, no timer needed.
function renderSubAgents(rows: SubAgentRow[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mc-subagents";
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "mc-subrow";
    const dot = document.createElement("span");
    dot.className = `mc-dot mc-dot--${r.running ? "working" : "idle"}`;
    const label = document.createElement("span");
    label.className = "mc-subrow__label";
    label.textContent = r.label;
    row.append(dot, label);
    if (r.detail) {
      const detail = document.createElement("span");
      detail.className = "mc-subrow__detail";
      detail.textContent = r.detail;
      row.append(detail);
    }
    const age = document.createElement("span");
    age.className = "mc-subrow__age";
    age.textContent = r.running ? elapsedLabel(r.started_unix_ms) : "done";
    row.append(age);
    wrap.append(row);
  }
  return wrap;
}

function elapsedLabel(sinceMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function activityLine(card: AgentCard): string {
  return card.last_command ?? card.last_output_line ?? "…";
}

function vendorLabel(card: AgentCard): string {
  if (card.vendor !== "unknown") return card.vendor;
  return card.raw_command_label ?? "shell";
}

function contextChips(card: AgentCard): HTMLElement | null {
  const labels: string[] = [];
  if (card.mission_name) labels.push(`◈ ${card.mission_name}`);
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

function costBar(card: AgentCard): HTMLElement | null {
  if (card.cost_usd == null || card.budget_usd == null) return null;
  const pct = card.budget_usd > 0 ? Math.min(100, (card.cost_usd / card.budget_usd) * 100) : 0;
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
  label.textContent = `$${card.cost_usd.toFixed(2)} / $${card.budget_usd.toFixed(2)}`;
  wrap.append(bar, label);
  return wrap;
}

/// Scoped operator-reply composer — shared with the attention queue's
/// operator-escalation cards.
export function renderReply(
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
