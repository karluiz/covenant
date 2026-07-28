import type { AttentionItem } from "../api";
import { formatChord } from "../platform";
import { renderReply, type ReplyScope } from "./tile";

export interface AttentionCallbacks {
  /// operator-escalation reply (existing operator resolution pipe)
  onOperatorReply: (sessionId: string, text: string, scope: ReplyScope) => Promise<void>;
  /// acp-permission answer
  onPermission: (sessionId: string, requestKey: string, optionId: string) => void;
  /// pty-waiting reply — writes text + Enter to the PTY
  onPtyReply: (sessionId: string, text: string) => void;
}

/// Kind-specific interaction for a blocked session, rendered inside the
/// detail pane: the question line plus the answer affordance. The tail
/// is NOT rendered here — the pane already shows card.excerpt.
export function renderAttentionBody(
  item: AttentionItem,
  cb: AttentionCallbacks,
): DocumentFragment {
  const frag = document.createDocumentFragment();

  const q = document.createElement("p");
  q.className = "mc-detail__question";
  q.textContent = item.question ?? item.permission?.title ?? "(waiting on you)";
  frag.append(q);

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
      frag.append(opts);
      break;
    }
    case "pty-waiting":
      frag.append(renderPtyComposer(item.session_id, cb.onPtyReply));
      break;
    case "operator-escalation":
      frag.append(renderReply(item.session_id, cb.onOperatorReply));
      break;
  }
  return frag;
}

export function agoLabel(sinceMs: number): string {
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
