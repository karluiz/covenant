import type { AttentionItem } from "../api";
import { renderAvatarHtml } from "../operator/avatars";
import { formatChord } from "../platform";
import { renderReply, type ReplyScope } from "./tile";

export interface AttentionCallbacks {
  onFocus: (sessionId: string, keepOpen: boolean) => void;
  /// operator-escalation reply (existing operator resolution pipe)
  onOperatorReply: (sessionId: string, text: string, scope: ReplyScope) => Promise<void>;
  /// acp-permission answer
  onPermission: (sessionId: string, requestKey: string, optionId: string) => void;
  /// pty-waiting reply — writes text + Enter to the PTY
  onPtyReply: (sessionId: string, text: string) => void;
}

/// One card of the "needs you" queue. Same chassis as the grid card, but
/// the body is the inline answer affordance for the item's kind.
export function renderAttentionCard(
  item: AttentionItem,
  cb: AttentionCallbacks,
): HTMLElement {
  const root = document.createElement("article");
  root.className = "mc-card mc-card--blocked mc-attention-card";
  root.dataset.sessionId = item.session_id;

  root.append(renderHeader(item, cb));

  const q = document.createElement("p");
  q.className = "mc-card__question";
  q.textContent = item.question ?? item.permission?.title ?? "(waiting on you)";
  root.append(q);

  if (item.excerpt) {
    const tail = document.createElement("pre");
    tail.className = "mc-card__tail";
    tail.textContent = item.excerpt;
    root.append(tail);
  }

  switch (item.kind) {
    case "acp-permission": {
      // ponytail: options answer the prompt; free-text reply deferred — a
      // permission resolves by option, not prose.
      const opts = document.createElement("div");
      opts.className = "mc-perm-opts";
      for (const o of item.permission?.options ?? []) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = o.name ?? o.kind.replace(/_/g, " ");
        btn.addEventListener("click", () => {
          if (item.permission) cb.onPermission(item.session_id, item.permission.request_key, o.option_id);
        });
        opts.append(btn);
      }
      root.append(opts);
      break;
    }
    case "pty-waiting":
      root.append(renderPtyComposer(item.session_id, cb.onPtyReply));
      break;
    case "operator-escalation":
      root.append(renderReply(item.session_id, cb.onOperatorReply));
      break;
  }
  return root;
}

function renderHeader(item: AttentionItem, cb: AttentionCallbacks): HTMLElement {
  const head = document.createElement("div");
  head.className = "mc-card__head";

  const dot = document.createElement("span");
  dot.className = "mc-dot mc-dot--blocked";

  const exec = document.createElement("strong");
  exec.className = "mc-card__exec";
  exec.textContent = item.executor ?? "agent";

  const tab = document.createElement("button");
  tab.type = "button";
  tab.className = "mc-card__tab";
  tab.textContent = `→ ${item.tab_title}`;
  tab.addEventListener("click", (e) => {
    e.stopPropagation();
    cb.onFocus(item.session_id, false);
  });

  const pill = document.createElement("span");
  pill.className = "mc-pill mc-pill--blocked";
  pill.textContent = kindLabel(item.kind);

  head.append(dot, exec, tab, pill);

  if (item.operator_name) {
    const op = document.createElement("span");
    op.className = "mc-oplabel";
    op.innerHTML = `${renderAvatarHtml(item.operator_avatar ?? "👤", 18)}<span>${item.operator_name}</span>`;
    head.append(op);
  }

  if (item.since_unix_ms != null && item.since_unix_ms > 0) {
    const age = document.createElement("span");
    age.className = "mc-attention-card__age";
    age.textContent = agoLabel(item.since_unix_ms);
    head.append(age);
  }
  return head;
}

function kindLabel(kind: AttentionItem["kind"]): string {
  switch (kind) {
    case "acp-permission": return "PERMISSION";
    case "pty-waiting": return "WAITING";
    case "operator-escalation": return "NEEDS YOU";
  }
}

function agoLabel(sinceMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/// Reply straight into the waiting PTY — no scope select (scopes are an
/// operator-memory concept; a raw terminal prompt just needs bytes).
function renderPtyComposer(
  sessionId: string,
  onPtyReply: AttentionCallbacks["onPtyReply"],
): HTMLElement {
  const wrap = document.createElement("form");
  wrap.className = "mc-reply";
  wrap.addEventListener("submit", (e) => e.preventDefault());

  const textarea = document.createElement("textarea");
  textarea.className = "mc-reply__textarea";
  textarea.placeholder = "Type a reply — sent to the terminal…";
  textarea.rows = 2;

  const controls = document.createElement("div");
  controls.className = "mc-reply__controls";
  const send = document.createElement("button");
  send.type = "button";
  send.className = "mc-reply__send";
  send.textContent = `Send ${formatChord(["mod", "enter"])}`;

  const submit = () => {
    const text = textarea.value.trim();
    if (!text) return;
    onPtyReply(sessionId, text);
    textarea.value = "";
  };
  send.addEventListener("click", submit);
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });

  controls.append(send);
  wrap.append(textarea, controls);
  return wrap;
}
