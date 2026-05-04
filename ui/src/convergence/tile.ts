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

const truncate = (s: string | null, max: number): string =>
  !s ? "" : s.length > max ? s.slice(0, max - 1) + "…" : s;

const fmtUsd = (v: number): string => `$${v.toFixed(2)}`;

const avatarKey = (tab?: TabMeta): string =>
  `${tab?.operatorAvatar ?? ""}|${tab?.operatorName ?? ""}`;

function paintAvatar(avatar: HTMLElement, tab?: TabMeta): void {
  if (avatar.dataset.avatarKey === avatarKey(tab)) return;
  avatar.title = tab?.operatorName ?? "no operator";
  avatar.classList.remove("convergence-tile__avatar--empty");
  if (tab?.operatorAvatar) {
    avatar.innerHTML = renderAvatarHtml(tab.operatorAvatar, 24);
  } else if (tab?.operatorName) {
    avatar.textContent = tab.operatorName.slice(0, 2).toUpperCase();
  } else {
    avatar.textContent = "";
    avatar.classList.add("convergence-tile__avatar--empty");
  }
  avatar.dataset.avatarKey = avatarKey(tab);
}

function buildReplyForm(
  sessionId: string,
  onReplySubmit: ReplySubmit,
): HTMLElement {
  const form = document.createElement("div");
  form.className = "convergence-tile__reply";
  form.dataset.noTileClick = "1";
  // Block bubbling so the outer tile click handler does not activate the tab,
  // and so keystrokes/pointer events do not reach the terminal underneath.
  const stop = (e: Event) => e.stopPropagation();
  form.addEventListener("click", stop);
  form.addEventListener("mousedown", stop);
  form.addEventListener("pointerdown", stop);
  form.addEventListener("keydown", (e) => e.stopPropagation());

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

  const controls = document.createElement("div");
  controls.className = "convergence-tile__reply-controls";
  controls.append(scope, send);
  form.append(input, controls);
  return form;
}

function paintDecision(el: HTMLElement, state: ConvergenceTileState): void {
  if (state.last_decision_action) {
    el.classList.remove("convergence-tile__decision--empty");
    let action = el.querySelector<HTMLElement>(".convergence-tile__action");
    let rationale = el.querySelector<HTMLElement>(
      ".convergence-tile__rationale",
    );
    if (!action || !rationale) {
      el.replaceChildren();
      action = document.createElement("span");
      action.className = "convergence-tile__action";
      rationale = document.createElement("span");
      rationale.className = "convergence-tile__rationale";
      el.append(action, rationale);
    }
    action.textContent = state.last_decision_action;
    rationale.textContent = state.last_decision_rationale ?? "";
  } else {
    el.classList.add("convergence-tile__decision--empty");
    el.replaceChildren();
    el.textContent = "no decisions yet";
  }
}

/**
 * Builds the tile skeleton (stable nodes only). All data-bearing fields are
 * painted by `updateTile` so render and refresh share one code path. The
 * skeleton order matters: head, [mission], vendor, pill, decision, activity,
 * [cost], [reply].
 */
export function renderTile(
  state: ConvergenceTileState,
  tab?: TabMeta,
  onReplySubmit?: ReplySubmit,
): HTMLElement {
  // Use a div (not button) — nesting inputs/select/buttons inside a <button>
  // is invalid HTML and produces erratic focus/drag behavior (typing in the
  // reply input would bubble strange events to the terminal underneath).
  const tile = document.createElement("div");
  tile.className = "convergence-tile";
  tile.setAttribute("role", "button");
  tile.tabIndex = 0;
  tile.dataset.sessionId = state.session_id;

  const head = document.createElement("div");
  head.className = "convergence-tile__head";
  const stripe = document.createElement("span");
  stripe.className = "convergence-tile__stripe";
  const avatar = document.createElement("span");
  avatar.className = "convergence-tile__avatar";
  const title = document.createElement("span");
  title.className = "convergence-tile__title";
  head.append(stripe, avatar, title);

  const vendor = document.createElement("span");
  vendor.className = "convergence-tile__vendor";
  const pill = document.createElement("span");
  pill.className = "convergence-tile__pill";
  const decision = document.createElement("div");
  decision.className = "convergence-tile__decision";

  const activity = document.createElement("div");
  activity.className = "convergence-tile__activity";
  const cmd = document.createElement("div");
  cmd.className = "convergence-tile__cmd";
  const out = document.createElement("div");
  out.className = "convergence-tile__out";
  activity.append(cmd, out);

  tile.append(head, vendor, pill, decision, activity);
  updateTile(tile, state, tab, onReplySubmit);
  return tile;
}

/**
 * Mutates an existing tile in place. Avatar IMG nodes are only swapped when
 * the operator id/avatar changes — that's the whole point: the 1Hz poll must
 * not flicker the avatar. Optional sections (mission, cost, reply) are
 * created/removed on demand; reply is preserved across ticks so a focused
 * input keeps focus and typed text.
 */
export function updateTile(
  tile: HTMLElement,
  state: ConvergenceTileState,
  tab?: TabMeta,
  onReplySubmit?: ReplySubmit,
): void {
  tile.dataset.status = state.status;

  const stripe = tile.querySelector<HTMLElement>(".convergence-tile__stripe");
  if (stripe) stripe.style.background = state.color ?? "";

  const avatar = tile.querySelector<HTMLElement>(".convergence-tile__avatar");
  if (avatar) paintAvatar(avatar, tab);

  const title = tile.querySelector<HTMLElement>(".convergence-tile__title");
  if (title) title.textContent = truncate(state.title || "untitled", 40);

  // mission line: add/update/remove (between head and vendor)
  const head = tile.querySelector(".convergence-tile__head");
  let mission = tile.querySelector<HTMLElement>(".convergence-tile__mission");
  if (state.mission_name) {
    const text = `📍 ${state.mission_name}`;
    if (!mission) {
      mission = document.createElement("div");
      mission.className = "convergence-tile__mission";
      head?.after(mission);
    }
    if (mission.textContent !== text) mission.textContent = text;
  } else if (mission) {
    mission.remove();
  }

  const vendor = tile.querySelector<HTMLElement>(".convergence-tile__vendor");
  if (vendor) {
    vendor.dataset.vendor = state.vendor;
    vendor.textContent =
      state.vendor === "unknown"
        ? state.raw_command_label ?? "unknown"
        : state.vendor;
  }

  const pill = tile.querySelector<HTMLElement>(".convergence-tile__pill");
  if (pill) {
    pill.dataset.status = state.status;
    pill.textContent = STATUS_LABEL[state.status];
  }

  const decision = tile.querySelector<HTMLElement>(
    ".convergence-tile__decision",
  );
  if (decision) paintDecision(decision, state);

  const cmd = tile.querySelector<HTMLElement>(".convergence-tile__cmd");
  if (cmd)
    cmd.textContent = state.last_command
      ? `$ ${truncate(state.last_command, 80)}`
      : "—";
  const out = tile.querySelector<HTMLElement>(".convergence-tile__out");
  if (out) out.textContent = truncate(state.last_output_line, 100);

  // cost footer: add/update/remove (before reply if present, else last)
  let cost = tile.querySelector<HTMLElement>(".convergence-tile__cost");
  if (state.cost_usd !== null && state.budget_usd !== null) {
    const text = `${fmtUsd(state.cost_usd)} / ${fmtUsd(state.budget_usd)} budget`;
    if (!cost) {
      cost = document.createElement("div");
      cost.className = "convergence-tile__cost";
      const reply = tile.querySelector(".convergence-tile__reply");
      if (reply) tile.insertBefore(cost, reply);
      else tile.append(cost);
    }
    if (cost.textContent !== text) cost.textContent = text;
  } else if (cost) {
    cost.remove();
  }

  // reply form: present iff blocked. Never recreated when already present —
  // that would lose focus and any typed value.
  const reply = tile.querySelector<HTMLElement>(".convergence-tile__reply");
  if (state.status === "blocked" && onReplySubmit) {
    if (!reply) tile.append(buildReplyForm(state.session_id, onReplySubmit));
  } else if (reply) {
    reply.remove();
  }
}
