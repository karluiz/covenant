import type { ConvergenceTileState, TileStatus } from "../api";
import { renderAvatarHtml } from "../operator/avatars";
import type { TabMeta } from "./overlay";

const STATUS_LABEL: Record<TileStatus, string> = {
  idle: "idle",
  working: "working",
  "awaiting-input": "awaiting input",
  blocked: "blocked",
  "operator-thinking": "operator thinking",
};

export type ReplyScope = "one-shot" | "mission" | "global";
export type ReplySubmit = (
  sessionId: string,
  text: string,
  scope: ReplyScope,
) => void | Promise<void>;

function truncate(s: string | null, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function buildReplyForm(
  sessionId: string,
  onReplySubmit: ReplySubmit,
): HTMLElement {
  const form = document.createElement("div");
  form.className = "convergence-tile__reply";
  form.dataset.noTileClick = "1";
  // Block bubbling so the outer tile click handler does not activate the tab.
  const stop = (e: Event) => e.stopPropagation();
  form.addEventListener("click", stop);
  form.addEventListener("mousedown", stop);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "convergence-tile__reply-input";
  input.placeholder = "Reply…";

  const scope = document.createElement("select");
  scope.className = "convergence-tile__reply-scope";
  for (const v of ["one-shot", "mission", "global"] as ReplyScope[]) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    if (v === "one-shot") opt.selected = true;
    scope.append(opt);
  }

  const send = document.createElement("button");
  send.type = "button";
  send.className = "convergence-tile__reply-send";
  send.textContent = "Send";

  const submit = async () => {
    const text = input.value.trim();
    if (!text || send.disabled) return;
    send.disabled = true;
    try {
      await onReplySubmit(sessionId, text, scope.value as ReplyScope);
      input.value = "";
      input.blur();
    } finally {
      send.disabled = false;
    }
  };

  send.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  });

  form.append(input, scope, send);
  return form;
}

export function renderTile(
  state: ConvergenceTileState,
  tab?: TabMeta,
  onReplySubmit?: ReplySubmit,
): HTMLElement {
  const tile = document.createElement("button");
  tile.type = "button";
  tile.className = "convergence-tile";
  tile.dataset.sessionId = state.session_id;
  tile.dataset.status = state.status;

  // (1) Title row + color stripe + operator avatar
  const head = document.createElement("div");
  head.className = "convergence-tile__head";
  const stripe = document.createElement("span");
  stripe.className = "convergence-tile__stripe";
  if (state.color) stripe.style.background = state.color;

  const avatar = document.createElement("span");
  avatar.className = "convergence-tile__avatar";
  avatar.title = tab?.operatorName ?? "no operator";
  if (tab?.operatorAvatar) {
    avatar.innerHTML = renderAvatarHtml(tab.operatorAvatar, 24);
  } else if (tab?.operatorName) {
    avatar.textContent = tab.operatorName.slice(0, 2).toUpperCase();
  } else {
    avatar.classList.add("convergence-tile__avatar--empty");
  }

  const title = document.createElement("span");
  title.className = "convergence-tile__title";
  title.textContent = truncate(state.title || "untitled", 40);
  head.append(stripe, avatar, title);

  // (2) Vendor badge
  const vendorBadge = document.createElement("span");
  vendorBadge.className = "convergence-tile__vendor";
  vendorBadge.dataset.vendor = state.vendor;
  if (state.vendor === "unknown") {
    vendorBadge.textContent = state.raw_command_label ?? "unknown";
  } else {
    vendorBadge.textContent = state.vendor;
  }

  // (3) Status pill
  const pill = document.createElement("span");
  pill.className = "convergence-tile__pill";
  pill.dataset.status = state.status;
  pill.textContent = STATUS_LABEL[state.status];

  // (4) Last decision
  const decision = document.createElement("div");
  decision.className = "convergence-tile__decision";
  if (state.last_decision_action) {
    const action = document.createElement("span");
    action.className = "convergence-tile__action";
    action.textContent = state.last_decision_action;
    const rationale = document.createElement("span");
    rationale.className = "convergence-tile__rationale";
    rationale.textContent = state.last_decision_rationale ?? "";
    decision.append(action, rationale);
  } else {
    decision.classList.add("convergence-tile__decision--empty");
    decision.textContent = "no decisions yet";
  }

  // (5) Last command + output preview
  const activity = document.createElement("div");
  activity.className = "convergence-tile__activity";
  const cmd = document.createElement("div");
  cmd.className = "convergence-tile__cmd";
  cmd.textContent = state.last_command ? `$ ${truncate(state.last_command, 80)}` : "—";
  const out = document.createElement("div");
  out.className = "convergence-tile__out";
  out.textContent = truncate(state.last_output_line, 100);
  activity.append(cmd, out);

  tile.append(head, vendorBadge, pill, decision, activity);

  // (6) Cost footer ONLY when enrolled in AOM
  if (state.cost_usd !== null && state.budget_usd !== null) {
    const cost = document.createElement("div");
    cost.className = "convergence-tile__cost";
    cost.textContent = `${fmtUsd(state.cost_usd)} / ${fmtUsd(state.budget_usd)} budget`;
    tile.append(cost);
  }

  // (7) Reply form when blocked
  if (state.status === "blocked" && onReplySubmit) {
    tile.append(buildReplyForm(state.session_id, onReplySubmit));
  }

  return tile;
}
