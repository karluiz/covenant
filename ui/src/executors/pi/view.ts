// PiChatView — Pi RPC tab body (PI-3 MVP).
//
// Replaces xterm.js in the tab slot for Pi sessions. Subscribes to the
// session's `session://{id}/pi` event stream, renders user/assistant
// turns with streaming text deltas, and lets the user type a prompt or
// abort the in-flight turn.
//
// Scope (MVP):
//   - text content rendering (thinking + toolCall blocks ship in PI-4)
//   - text_delta streaming into the current assistant block
//   - Send + Abort buttons; busy state derived from agent_start/agent_end
//   - process_exited synthetic event surfaces a crash banner
//
// Deferred to PI-4:
//   - tool_execution_* event rendering
//   - thinking_delta + collapsed thinking blocks
//   - queue indicator (steering / follow_up)
//   - model selector popover
//   - extension_ui_request dialogs (PI-7)

import type {
  PiAgentMessage,
  PiAssistantContent,
  PiAssistantMessage,
  PiEvent,
  PiUserMessage,
  SessionId,
} from "../../api";
import {
  closePiSession,
  piAbort,
  piSendPrompt,
  subscribePiEvents,
} from "../../api";

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/// One rendered turn = one user message + the assistant response that
/// followed it. We track the assistant block separately from the agent's
/// own `AgentMessage` shape because we mutate it as text deltas arrive
/// (the canonical `message` object on the event is *immutable* per frame,
/// but we want one stable DOM node to append into).
interface TurnDom {
  root: HTMLElement;
  /// Concatenated text of the current assistant turn. Built incrementally
  /// from text_delta events; falls back to the final `turn_end` message
  /// when no deltas were observed.
  assistantTextEl: HTMLElement;
  assistantBuffer: string;
}

export interface PiChatViewOptions {
  /// The Covenant SessionId returned by `spawn_pi_session`. All event
  /// subscription + commands key off this id.
  sessionId: SessionId;
  /// Element the view will fill. Caller owns sizing/positioning; the view
  /// applies its own internal flex layout.
  host: HTMLElement;
  /// Fired when the user clicks the close affordance (or the underlying
  /// process exits and the user dismisses the crash banner). Callers
  /// typically call `closePiSession()` here and remove the tab.
  onClose?: () => void;
}

/// Public surface kept narrow: mount on construction, [`destroy`] to
/// unmount + unsubscribe. No imperative re-render entry — the view drives
/// itself off events.
export class PiChatView {
  private readonly host: HTMLElement;
  private readonly sessionId: SessionId;
  private readonly onCloseCb?: () => void;

  private unlisten: (() => void) | null = null;
  private destroyed = false;

  private statusEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private abortBtn!: HTMLButtonElement;

  private busy = false;
  private currentTurn: TurnDom | null = null;
  /// Bumped on every render so screen readers (aria-live) re-announce
  /// rather than getting wedged on identical content during streaming.
  private liveTick = 0;

  constructor(opts: PiChatViewOptions) {
    this.host = opts.host;
    this.sessionId = opts.sessionId;
    this.onCloseCb = opts.onClose;
    this.mount();
    void this.subscribe();
  }

  /// Tear down DOM + event subscription. Idempotent.
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.unlisten) {
      try {
        this.unlisten();
      } catch {
        /* listener already gone */
      }
      this.unlisten = null;
    }
    this.host.innerHTML = "";
    this.host.classList.remove("pi-chat-view");
  }

  // -------------------------------------------------------------------------
  // Mount
  // -------------------------------------------------------------------------

  private mount(): void {
    this.host.classList.add("pi-chat-view");
    this.host.innerHTML = `
      <div class="pi-chat-header">
        <span class="pi-chat-title">Pi</span>
        <span class="pi-chat-status" data-state="idle" aria-live="polite">idle</span>
      </div>
      <div class="pi-chat-messages" role="log" aria-live="polite"></div>
      <form class="pi-chat-input" autocomplete="off">
        <textarea
          class="pi-chat-textarea"
          rows="2"
          placeholder="Message Pi…  (⌘↩ to send)"
          aria-label="Message Pi"
        ></textarea>
        <div class="pi-chat-actions">
          <button type="button" class="pi-chat-abort" hidden>Abort</button>
          <button type="submit" class="pi-chat-send">Send</button>
        </div>
      </form>
    `;
    this.statusEl = requireChild(this.host, ".pi-chat-status");
    this.messagesEl = requireChild(this.host, ".pi-chat-messages");
    this.inputEl = requireChild(this.host, ".pi-chat-textarea") as HTMLTextAreaElement;
    this.sendBtn = requireChild(this.host, ".pi-chat-send") as HTMLButtonElement;
    this.abortBtn = requireChild(this.host, ".pi-chat-abort") as HTMLButtonElement;

    const form = requireChild(this.host, "form.pi-chat-input") as HTMLFormElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.handleSend();
    });
    this.abortBtn.addEventListener("click", () => void this.handleAbort());
    this.inputEl.addEventListener("keydown", (e) => {
      // ⌘↩ / Ctrl+↩ submits. Plain Enter inserts a newline so multi-line
      // prompts work without an explicit "shift to newline" hint.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.handleSend();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Event subscription
  // -------------------------------------------------------------------------

  private async subscribe(): Promise<void> {
    try {
      this.unlisten = await subscribePiEvents(this.sessionId, (event) => {
        if (this.destroyed) return;
        this.handleEvent(event);
      });
    } catch (err) {
      this.setStatus("error", `subscribe failed: ${String(err)}`);
    }
  }

  private handleEvent(event: PiEvent): void {
    switch (event.type) {
      case "agent_start":
        this.setBusy(true);
        this.ensureCurrentTurn();
        this.setStatus("running", "running…");
        break;
      case "turn_start":
        // No-op for the MVP — turn_end carries the final message; we
        // build the streaming view from message_update deltas.
        break;
      case "message_start":
        this.ensureCurrentTurn();
        break;
      case "message_update":
        this.applyDelta(event.message, event.assistantMessageEvent);
        break;
      case "message_end":
        // The accumulated text in `currentTurn.assistantBuffer` is the
        // source of truth; the final message may include additional
        // content blocks we render in PI-4 (thinking / toolCall).
        break;
      case "turn_end":
        this.finalizeTurn(event.message);
        break;
      case "agent_end":
        this.setBusy(false);
        this.setStatus("idle", "idle");
        this.currentTurn = null;
        break;
      case "auto_retry_start":
        this.setStatus(
          "retry",
          `retrying (${event.attempt}/${event.maxAttempts}): ${event.errorMessage ?? "transient error"}`,
        );
        break;
      case "auto_retry_end":
        if (event.success) {
          this.setStatus("running", "retry succeeded; resuming…");
        } else {
          this.setStatus(
            "error",
            `retry failed: ${event.finalError ?? "unknown error"}`,
          );
        }
        break;
      case "compaction_start":
        this.setStatus("compacting", `compacting (${event.reason})…`);
        break;
      case "compaction_end":
        if (event.aborted) {
          this.setStatus("idle", "compaction aborted");
        } else {
          this.setStatus("running", "compaction done");
        }
        break;
      case "extension_error":
        this.appendSystemNote(
          `extension error in ${event.extensionPath} on ${event.event}: ${event.error}`,
          "error",
        );
        break;
      case "process_exited":
        this.setBusy(false);
        this.setStatus(
          "exited",
          event.code === null ? "process exited" : `process exited (code ${event.code})`,
        );
        this.appendSystemNote(
          "Pi process exited. Close this tab and reopen to start a new session.",
          "error",
        );
        break;
      // tool_execution_*, queue_update, extension_ui_request → PI-4/7.
      default:
        break;
    }
  }

  private applyDelta(message: PiAgentMessage, delta: PiEvent extends never ? never : unknown): void {
    void message; // reserved for PI-4 when we render non-text content
    const turn = this.ensureCurrentTurn();
    // The delta type is structurally the same as PiDeltaEvent; we narrow
    // on the runtime `type` field rather than reach into the discriminated
    // union from the caller's site (keeps this function self-contained).
    const d = delta as { type: string } & Record<string, unknown>;
    if (d.type === "text_delta" && typeof d.delta === "string") {
      turn.assistantBuffer += d.delta;
      turn.assistantTextEl.textContent = turn.assistantBuffer;
      this.scrollToBottom();
    }
    // thinking_delta / toolcall_* deferred to PI-4.
  }

  private finalizeTurn(message: PiAssistantMessage): void {
    const turn = this.ensureCurrentTurn();
    // If no text_delta events ever arrived (model emitted in one shot,
    // or we missed early frames), pull the final text from `message`.
    if (turn.assistantBuffer.length === 0) {
      const finalText = message.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (finalText.length > 0) {
        turn.assistantBuffer = finalText;
        turn.assistantTextEl.textContent = finalText;
      }
    }
    // If the message had stop_reason "error" or "aborted", reflect it.
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      turn.root.classList.add(`pi-msg-stop-${message.stopReason}`);
    }
    this.scrollToBottom();
  }

  // -------------------------------------------------------------------------
  // User actions
  // -------------------------------------------------------------------------

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (text.length === 0) return;
    this.inputEl.value = "";
    this.appendUserMessage({ role: "user", content: text });
    this.currentTurn = this.beginAssistantTurn();
    this.setBusy(true);
    this.setStatus("running", "sending…");
    try {
      await piSendPrompt(this.sessionId, text);
    } catch (err) {
      this.setBusy(false);
      this.setStatus("error", `send failed: ${String(err)}`);
      this.appendSystemNote(`send failed: ${String(err)}`, "error");
    }
  }

  private async handleAbort(): Promise<void> {
    try {
      await piAbort(this.sessionId);
      this.setStatus("aborting", "aborting…");
    } catch (err) {
      this.setStatus("error", `abort failed: ${String(err)}`);
    }
  }

  /// Convenience for callers that own tab lifecycle: tears down the view
  /// AND tells the backend to close the underlying session. Use this
  /// when the tab is being permanently removed; use [`destroy`] when the
  /// session is being kept alive but the view is just being unmounted.
  async closeSession(): Promise<void> {
    this.destroy();
    try {
      await closePiSession(this.sessionId);
    } catch {
      /* already gone */
    }
    this.onCloseCb?.();
  }

  // -------------------------------------------------------------------------
  // DOM helpers
  // -------------------------------------------------------------------------

  private appendUserMessage(msg: PiUserMessage): void {
    const el = document.createElement("div");
    el.className = "pi-msg pi-msg-user";
    el.innerHTML = `
      <div class="pi-msg-role">you</div>
      <div class="pi-msg-content">${escapeHtml(msg.content)}</div>
    `;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  /// Idempotent: returns the in-flight assistant turn or creates one.
  /// Called from event handlers that may race with handleSend()'s
  /// optimistic insertion.
  private ensureCurrentTurn(): TurnDom {
    if (this.currentTurn) return this.currentTurn;
    this.currentTurn = this.beginAssistantTurn();
    return this.currentTurn;
  }

  private beginAssistantTurn(): TurnDom {
    const root = document.createElement("div");
    root.className = "pi-msg pi-msg-assistant";
    root.innerHTML = `
      <div class="pi-msg-role">pi</div>
      <div class="pi-msg-content"><span class="pi-msg-text"></span></div>
    `;
    this.messagesEl.appendChild(root);
    const assistantTextEl = requireChild(root, ".pi-msg-text");
    return { root, assistantTextEl, assistantBuffer: "" };
  }

  private appendSystemNote(text: string, kind: "info" | "error" = "info"): void {
    const el = document.createElement("div");
    el.className = `pi-msg pi-msg-system pi-msg-system-${kind}`;
    el.textContent = text;
    this.messagesEl.appendChild(el);
    this.scrollToBottom();
  }

  private setStatus(
    state: "idle" | "running" | "retry" | "compacting" | "aborting" | "exited" | "error",
    label: string,
  ): void {
    this.statusEl.dataset.state = state;
    this.statusEl.textContent = label;
    // bump live region so a11y readers re-announce on same-string churn
    this.liveTick += 1;
    this.statusEl.setAttribute("data-tick", String(this.liveTick));
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.sendBtn.disabled = busy;
    this.abortBtn.hidden = !busy;
  }

  private scrollToBottom(): void {
    // requestAnimationFrame so the layout settles before we measure.
    requestAnimationFrame(() => {
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    });
  }
}

function requireChild(root: HTMLElement, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`pi-chat-view: missing ${selector}`);
  return el;
}

/// For tests / future render helpers — collapse an AssistantMessage's
/// text content into a single string. Exported so PI-4 work and tests
/// can share the same flattening rule.
export function assistantText(message: PiAssistantMessage): string {
  const parts: string[] = [];
  for (const c of message.content) {
    if (isText(c)) parts.push(c.text);
  }
  return parts.join("");
}

function isText(c: PiAssistantContent): c is { type: "text"; text: string } {
  return c.type === "text" && typeof (c as { text?: unknown }).text === "string";
}
