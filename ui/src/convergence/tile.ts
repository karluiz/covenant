import type { AgentCard, AttentionItem, SubAgentRow, TileStatus } from "../api";
import { renderAvatarHtml } from "../operator/avatars";
import { attachTooltip } from "../tooltip/tooltip";
import { brandIconSvg } from "../icons/brands";
import { BRAND_COLORS } from "../spawns/chip";
import { formatChord } from "../platform";
import { CustomSelect } from "../ui/select";
import { renderAttentionBody, type AttentionCallbacks } from "./attention";

export type ReplyScope = "one-shot" | "mission" | "global";

const REPLY_SCOPES: readonly ReplyScope[] = ["one-shot", "mission", "global"];

const STATUS_LABEL: Record<TileStatus, string> = {
  blocked: "needs you",
  "operator-thinking": "thinking",
  "awaiting-input": "waiting",
  working: "working",
  idle: "idle",
};

export interface RowCallbacks {
  onSelect: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
}

/// One rail row. The spine (CSS border-left) is the only status color.
export function renderAgentRow(
  card: AgentCard,
  opts: { selected: boolean; age: string | null },
  cb: RowCallbacks,
): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `mc-row mc-row--${card.status}${opts.selected ? " mc-row--selected" : ""}`;
  row.dataset.sessionId = card.session_id;

  const top = document.createElement("div");
  top.className = "mc-row__top";
  const dot = document.createElement("span");
  dot.className = `mc-dot mc-dot--${card.status}`;
  const title = document.createElement("span");
  title.className = "mc-row__title";
  title.textContent = displayTitle(card);
  top.append(dot, title);
  if (opts.age) {
    const age = document.createElement("span");
    age.className = "mc-row__age";
    age.textContent = opts.age;
    top.append(age);
  }

  const sub = document.createElement("div");
  sub.className = "mc-row__sub";
  const brand = brandMark(card, 11);
  if (brand) sub.append(brand);
  const subText = document.createElement("span");
  subText.textContent = [card.executor ?? vendorLabel(card), card.operator_name]
    .filter(Boolean)
    .join(" · ");
  sub.append(subText);

  const act = document.createElement("div");
  act.className = "mc-row__activity";
  act.textContent = card.phase_label ?? activityLine(card);

  row.append(top, sub, act);
  row.addEventListener("click", () => cb.onSelect(card.session_id));
  row.addEventListener("dblclick", () => cb.onFocus(card.session_id));
  return row;
}

export type DetailCallbacks = {
  onFocus: (sessionId: string, keepOpen: boolean) => void;
  onStop: (sessionId: string) => void;
} & AttentionCallbacks;

/// The right pane: everything known about the selected agent, live.
/// `attention` is the session's queue item when blocked — its question
/// and answer affordance render at the bottom of the pane.
export function renderDetailPane(
  card: AgentCard,
  attention: AttentionItem | null,
  cb: DetailCallbacks,
): HTMLElement {
  const pane = document.createElement("section");
  pane.className = "mc-detail";
  pane.dataset.sessionId = card.session_id;

  const head = document.createElement("div");
  head.className = "mc-detail__head";
  const title = document.createElement("h2");
  title.className = "mc-detail__title";
  title.textContent = displayTitle(card);
  const pill = document.createElement("span");
  pill.className = `mc-pill mc-pill--${card.status}`;
  pill.textContent = STATUS_LABEL[card.status];
  const actions = document.createElement("div");
  actions.className = "mc-detail__actions";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "mc-detail__open";
  open.textContent = `Open tab ${formatChord(["enter"])}`;
  attachTooltip(open, "Jump to this session's tab and close Convergence.");
  open.addEventListener("click", () => cb.onFocus(card.session_id, false));
  actions.append(open);
  if (card.excerpt) {
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "mc-detail__copy";
    copy.textContent = "Copy tail";
    copy.setAttribute("aria-label", "Copy the tail to the clipboard");
    attachTooltip(copy, "Copy the tail below to the clipboard.");
    copy.addEventListener("click", () => {
      const text = card.excerpt;
      if (text) void navigator.clipboard.writeText(text).catch(() => {});
    });
    actions.append(copy);
  }
  if (card.operator_id) {
    const stop = document.createElement("button");
    stop.type = "button";
    stop.className = "mc-stop";
    stop.textContent = "Stop";
    stop.setAttribute("aria-label", "Stop operator");
    attachTooltip(stop, "Disable the operator on this session. Reversible — ⌘O on the tab re-arms it.");
    stop.addEventListener("click", () => cb.onStop(card.session_id));
    actions.append(stop);
  }
  head.append(title, pill, actions);
  pane.append(head);

  const meta = document.createElement("div");
  meta.className = "mc-detail__meta";
  const metaBrand = brandMark(card, 14);
  if (metaBrand) meta.append(metaBrand);
  const exec = document.createElement("strong");
  exec.textContent = card.executor ?? vendorLabel(card);
  meta.append(exec);
  if (card.operator_id) {
    const op = document.createElement("span");
    op.className = "mc-oplabel";
    op.innerHTML = renderAvatarHtml(card.operator_avatar ?? "👤", 18);
    const opName = document.createElement("span");
    opName.textContent = card.operator_name ?? "";
    op.append(opName);
    meta.append(op);
  }
  if (card.mission_name) {
    const chip = document.createElement("span");
    chip.className = "mc-chip";
    chip.textContent = `◈ ${card.mission_name}`;
    meta.append(chip);
  }
  if (card.cwd) {
    const cwd = document.createElement("span");
    cwd.className = "mc-detail__cwd";
    cwd.textContent = card.cwd;
    meta.append(cwd);
  }
  pane.append(meta);

  const cost = costBar(card);
  if (cost) pane.append(cost);

  if (card.excerpt) {
    const tail = document.createElement("pre");
    tail.className = "mc-tail";
    tail.textContent = card.excerpt;
    pane.append(tail);
  } else if (card.lane === "acp") {
    // A chat session has no PTY screen to mirror — say so instead of
    // leaving the pane looking broken.
    const note = document.createElement("div");
    note.className = "mc-detail__note";
    note.textContent = "Chat session — the conversation lives in its tab.";
    pane.append(note);
  }
  if (card.subagents.length > 0) pane.append(renderSubAgents(card.subagents));
  if (attention) pane.append(renderAttentionBody(attention, cb));
  return pane;
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

export function elapsedLabel(sinceMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function activityLine(card: AgentCard): string {
  return card.last_command ?? card.last_output_line ?? card.cwd ?? "…";
}

/// Tinted harness brand mark (claude/codex/copilot/pi/…), or null when
/// we have no logo for the executor — callers fall back to text-only.
function brandMark(card: AgentCard, size: number): HTMLElement | null {
  const key = (card.executor ?? "").toLowerCase();
  const svg = key ? brandIconSvg(key, size) : null;
  if (!svg) return null;
  const span = document.createElement("span");
  span.className = "mc-brand";
  span.style.color = BRAND_COLORS[key] ?? "var(--muted)";
  span.innerHTML = svg;
  return span;
}

/// What to call this agent. A tab that was never renamed carries the
/// literal "untitled", and a rail of those tells you nothing — fall back
/// to the last segment of its cwd, which for a worktree is the branch
/// slug and for a repo is the repo. Exported for the detail pane so both
/// surfaces agree on the name.
export function displayTitle(card: AgentCard): string {
  const t = card.tab_title.trim();
  if (t && t.toLowerCase() !== "untitled") return t;
  const leaf = (card.cwd ?? "").replace(/\/+$/, "").split("/").pop();
  return leaf || t || "untitled";
}

function vendorLabel(card: AgentCard): string {
  if (card.vendor !== "unknown") return card.vendor;
  return card.raw_command_label ?? "shell";
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
  onSubmit: (sessionId: string, text: string, scope: ReplyScope) => Promise<void>,
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
