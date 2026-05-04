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

function truncate(s: string | null, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

export function renderTile(state: ConvergenceTileState, tab?: TabMeta): HTMLElement {
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
    // Reuse the operator avatar helper (parses `pack:` prefix → <img>,
    // otherwise emits an emoji span). Helper escapes content.
    avatar.innerHTML = renderAvatarHtml(tab.operatorAvatar, 24);
  } else if (tab?.operatorName) {
    avatar.textContent = tab.operatorName.slice(0, 2).toUpperCase();
  } else {
    // Empty placeholder slot to avoid layout shift when cache fills.
    avatar.classList.add("convergence-tile__avatar--empty");
  }

  const title = document.createElement("span");
  title.className = "convergence-tile__title";
  title.textContent = truncate(state.title || "untitled", 40);
  head.append(stripe, avatar, title);

  // (2) Status pill
  const pill = document.createElement("span");
  pill.className = "convergence-tile__pill";
  pill.dataset.status = state.status;
  pill.textContent = STATUS_LABEL[state.status];

  // (3) Last decision (action + rationale, 2-line clamp via CSS)
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

  // (4) Last command + output preview
  const activity = document.createElement("div");
  activity.className = "convergence-tile__activity";
  const cmd = document.createElement("div");
  cmd.className = "convergence-tile__cmd";
  cmd.textContent = state.last_command ? `$ ${truncate(state.last_command, 80)}` : "—";
  const out = document.createElement("div");
  out.className = "convergence-tile__out";
  out.textContent = truncate(state.last_output_line, 100);
  activity.append(cmd, out);

  tile.append(head, pill, decision, activity);

  // (5) Cost footer ONLY when enrolled in AOM
  if (state.cost_usd !== null && state.budget_usd !== null) {
    const cost = document.createElement("div");
    cost.className = "convergence-tile__cost";
    cost.textContent = `${fmtUsd(state.cost_usd)} / ${fmtUsd(state.budget_usd)} budget`;
    tile.append(cost);
  }

  return tile;
}
