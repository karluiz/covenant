import { Icons } from "../icons";
import { renderAvatarHtml } from "../operator/avatars";
import { attachTooltip } from "../tooltip/tooltip";
import { agoLabel } from "./attention";
import type { GroupFinding } from "./findings";

/// Everything the rail band and the group detail pane render. Assembled
/// per render from the snapshot + tab hints + the findings ring.
export interface GroupView {
  id: string;
  name: string;
  /// True when this band stands for another WORKSPACE, not a tab group.
  /// Those carry no supervisor affordances — you attach an operator to a
  /// group, never to a workspace — and say where they are instead.
  foreign?: boolean;
  supervisor: {
    operatorId: string;
    /// Resolved display name; falls back to "supervisor" when the
    /// operator list hasn't loaded (or the operator was deleted).
    name: string;
    avatar: string;
    intervene: boolean;
  } | null;
  tabs: number;
  blocked: number;
  costUsd: number;
  findings: readonly GroupFinding[];
  /// First session in the bucket — the target of "Open group".
  firstSessionId: string | null;
}

export interface GroupCallbacks {
  onSelect: (groupId: string) => void;
  onOpen: (sessionId: string) => void;
  onDetach: (groupId: string) => void;
  onToggleIntervene: (groupId: string, next: boolean) => void;
}

/// The rail's group header: name + roll-up, and — when supervised — who
/// is watching. Selectable: it drives the same detail host the agent rows
/// do. Keeps the historical `mc-rail__group` class so rail styling and
/// tests that walk `.mc-rail > *` keep recognising it as a header.
export function renderGroupBand(
  v: GroupView,
  selected: boolean,
  cb: GroupCallbacks,
): HTMLElement {
  const band = document.createElement("button");
  band.type = "button";
  band.className =
    "mc-rail__group mc-gband" +
    (v.supervisor ? " mc-gband--supervised" : "") +
    (selected ? " mc-gband--selected" : "");
  band.dataset.groupId = v.id;

  const top = document.createElement("div");
  top.className = "mc-gband__top";
  const name = document.createElement("span");
  name.className = "mc-gband__name";
  name.textContent = v.name;
  const meta = document.createElement("span");
  meta.className = "mc-gband__meta";
  meta.textContent = rollup(v);
  top.append(name, meta);
  band.append(top);

  const sub = document.createElement("div");
  sub.className = "mc-gband__sup";
  if (v.foreign) {
    sub.classList.add("mc-gband__sup--none");
    sub.textContent = "another workspace";
  } else if (v.supervisor) {
    const icon = document.createElement("span");
    icon.className = "mc-gband__icon";
    icon.innerHTML = Icons.headphones({ size: 11 });
    const who = document.createElement("span");
    who.className = "mc-gband__who";
    who.textContent = v.supervisor.name;
    const mode = document.createElement("span");
    mode.className = "mc-gband__mode";
    mode.textContent = [
      v.supervisor.intervene ? "decides" : "observes only",
      v.findings.length ? `${v.findings.length} findings` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    sub.append(icon, who, mode);
  } else {
    sub.classList.add("mc-gband__sup--none");
    sub.textContent = "no supervisor";
  }
  band.append(sub);

  band.addEventListener("click", () => cb.onSelect(v.id));
  return band;
}

/// The detail pane for a selected group: who supervises it, the roll-up,
/// and the findings that supervisor has produced this session.
export function renderGroupDetail(v: GroupView, cb: GroupCallbacks): HTMLElement {
  const pane = document.createElement("section");
  pane.className = "mc-detail mc-gdetail";
  pane.dataset.groupId = v.id;

  const head = document.createElement("div");
  head.className = "mc-detail__head";
  const title = document.createElement("h2");
  title.className = "mc-detail__title";
  title.textContent = v.name;
  head.append(title);
  if (v.supervisor) {
    const pill = document.createElement("span");
    pill.className = "mc-pill mc-pill--supervised";
    pill.textContent = "supervised";
    head.append(pill);
  }
  const actions = document.createElement("div");
  actions.className = "mc-detail__actions";
  if (v.firstSessionId) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "mc-detail__open";
    open.textContent = v.foreign ? "Switch to workspace" : "Open group";
    attachTooltip(
      open,
      v.foreign
        ? "Switch to that workspace, land on this tab, and close Convergence."
        : "Jump to this group's first tab and close Convergence.",
    );
    const sid = v.firstSessionId;
    open.addEventListener("click", () => cb.onOpen(sid));
    actions.append(open);
  }
  if (v.supervisor) {
    const detach = document.createElement("button");
    detach.type = "button";
    detach.className = "mc-stop";
    detach.textContent = "Detach";
    attachTooltip(detach, "Remove the supervisor from this group. Reversible from the group menu.");
    detach.addEventListener("click", () => cb.onDetach(v.id));
    actions.append(detach);
  }
  head.append(actions);
  pane.append(head);

  if (v.supervisor) {
    const who = document.createElement("div");
    who.className = "mc-detail__meta mc-gdetail__who";
    const avatar = document.createElement("span");
    avatar.className = "mc-oplabel";
    avatar.innerHTML = renderAvatarHtml(v.supervisor.avatar, 18);
    const name = document.createElement("strong");
    name.textContent = v.supervisor.name;
    who.append(avatar, name);

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className =
      "mc-gdetail__intervene" + (v.supervisor.intervene ? " mc-gdetail__intervene--on" : "");
    toggle.textContent = v.supervisor.intervene ? "Decides" : "Observes only";
    attachTooltip(
      toggle,
      v.supervisor.intervene
        ? "Answers for you in this group's unpinned panes, and escalates what it won't decide. Click to downgrade to watching."
        : "Watches without acting — an executor's question comes back to you. Click to let it decide.",
    );
    const next = !v.supervisor.intervene;
    toggle.addEventListener("click", () => cb.onToggleIntervene(v.id, next));
    who.append(toggle);
    pane.append(who);
  } else {
    const note = document.createElement("div");
    note.className = "mc-detail__note";
    note.textContent = v.foreign
      ? "These agents are running in another workspace. Their tabs are detached, not closed — output keeps flowing."
      : "No supervisor attached — right-click the group in the tab bar to attach one.";
    pane.append(note);
  }

  pane.append(stats(v));

  // Findings belong to a supervised GROUP. A workspace band has no
  // supervisor to produce them — an empty "Findings" header would read
  // as a broken feature rather than an inapplicable one.
  if (v.foreign) return pane;

  const label = document.createElement("div");
  label.className = "mc-gdetail__label";
  label.textContent = "Findings";
  pane.append(label);

  if (v.findings.length === 0) {
    const none = document.createElement("div");
    none.className = "mc-gdetail__empty";
    none.textContent = v.supervisor
      ? "Nothing flagged yet. Findings land here when a session in this group fails."
      : "Findings need a supervisor.";
    pane.append(none);
  } else {
    const feed = document.createElement("div");
    feed.className = "mc-gdetail__feed";
    for (const f of v.findings) {
      const row = document.createElement("div");
      row.className = "mc-gdetail__find";
      const when = document.createElement("time");
      when.textContent = agoLabel(f.atUnixMs);
      const msg = document.createElement("p");
      msg.textContent = f.message;
      row.append(when, msg);
      feed.append(row);
    }
    pane.append(feed);
  }
  return pane;
}

function stats(v: GroupView): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "mc-gdetail__stats";
  const cells: Array<[string, string, boolean]> = [
    [String(v.tabs), "tabs", false],
    [String(v.blocked), "needs you", v.blocked > 0],
    [String(v.findings.length), "findings", false],
  ];
  if (v.costUsd >= 0.005) cells.push([`$${v.costUsd.toFixed(2)}`, "spend", false]);
  for (const [value, label, alert] of cells) {
    const cell = document.createElement("div");
    cell.className = "mc-gdetail__stat" + (alert ? " mc-gdetail__stat--alert" : "");
    const b = document.createElement("b");
    b.textContent = value;
    const s = document.createElement("span");
    s.textContent = label;
    cell.append(b, s);
    wrap.append(cell);
  }
  return wrap;
}

function rollup(v: GroupView): string {
  return [
    `${v.tabs} ${v.tabs === 1 ? "tab" : "tabs"}`,
    v.costUsd >= 0.005 ? `$${v.costUsd.toFixed(2)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
