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
  piExtensionUiResponse,
  piFollowUp,
  piSendPrompt,
  piSteer,
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
  /// Container the tool / thinking inline blocks attach to. Lives inside
  /// the assistant message so the visual flow is: thinking → tool call →
  /// tool result → more text, in the order they were emitted.
  blocksEl: HTMLElement;
  /// Lazily-created inline thinking block. Pi can emit thinking before
  /// any text, so we don't materialize this until the first delta lands.
  thinkingEl: HTMLElement | null;
  thinkingBuffer: string;
}

/// Per-tool-call DOM bookkeeping. The reader receives separate start,
/// update (streaming partial output), and end events keyed by
/// `toolCallId`; this struct holds the DOM nodes we mutate as each one
/// arrives.
interface ToolDom {
  /// The outer card.
  root: HTMLElement;
  /// Body — appended to on tool_execution_update / tool_execution_end.
  bodyEl: HTMLElement;
  /// Toggle for expanding/collapsing the body.
  toggleEl: HTMLElement;
  /// Aggregated text the tool has streamed so far (so we can replace
  /// rather than append non-idempotent partials from Pi).
  partialBuffer: string;
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
  private queueEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private abortBtn!: HTMLButtonElement;
  private steerBtn!: HTMLButtonElement;
  private followUpBtn!: HTMLButtonElement;

  private busy = false;
  private currentTurn: TurnDom | null = null;
  /// Live tool-call cards keyed by Pi's toolCallId. Cleared when the
  /// reader sees `agent_end` so a new turn starts with a clean slate.
  private tools: Map<string, ToolDom> = new Map();
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
      <div class="pi-chat-queue" hidden aria-live="polite"></div>
      <form class="pi-chat-input" autocomplete="off">
        <textarea
          class="pi-chat-textarea"
          rows="2"
          placeholder="Message Pi…  (⌘↩ to send)"
          aria-label="Message Pi"
        ></textarea>
        <div class="pi-chat-actions">
          <button type="button" class="pi-chat-steer" hidden title="Queue an instruction to take effect before Pi's next LLM call">Steer…</button>
          <button type="button" class="pi-chat-followup" hidden title="Queue an instruction for after Pi finishes the current turn">Follow up…</button>
          <button type="button" class="pi-chat-abort" hidden>Abort</button>
          <button type="submit" class="pi-chat-send">Send</button>
        </div>
      </form>
    `;
    this.statusEl = requireChild(this.host, ".pi-chat-status");
    this.messagesEl = requireChild(this.host, ".pi-chat-messages");
    this.queueEl = requireChild(this.host, ".pi-chat-queue");
    this.inputEl = requireChild(this.host, ".pi-chat-textarea") as HTMLTextAreaElement;
    this.sendBtn = requireChild(this.host, ".pi-chat-send") as HTMLButtonElement;
    this.abortBtn = requireChild(this.host, ".pi-chat-abort") as HTMLButtonElement;
    this.steerBtn = requireChild(this.host, ".pi-chat-steer") as HTMLButtonElement;
    this.followUpBtn = requireChild(this.host, ".pi-chat-followup") as HTMLButtonElement;

    const form = requireChild(this.host, "form.pi-chat-input") as HTMLFormElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.handleSend();
    });
    this.abortBtn.addEventListener("click", () => void this.handleAbort());
    this.steerBtn.addEventListener("click", () => void this.handleSteer());
    this.followUpBtn.addEventListener("click", () => void this.handleFollowUp());
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
        this.tools.clear();
        this.renderQueue({ steering: [], followUp: [] });
        break;
      case "tool_execution_start":
        this.onToolStart(event.toolCallId, event.toolName, event.args);
        break;
      case "tool_execution_update":
        this.onToolUpdate(event.toolCallId, event.partialResult);
        break;
      case "tool_execution_end":
        this.onToolEnd(event.toolCallId, event.result, event.isError ?? false);
        break;
      case "queue_update":
        this.renderQueue({ steering: event.steering, followUp: event.followUp });
        break;
      case "extension_ui_request":
        this.openExtensionUi(event);
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

  private applyDelta(_message: PiAgentMessage, delta: unknown): void {
    const turn = this.ensureCurrentTurn();
    // The delta type is structurally the same as PiDeltaEvent; we narrow
    // on the runtime `type` field rather than reach into the discriminated
    // union from the caller's site (keeps this function self-contained).
    const d = delta as { type: string } & Record<string, unknown>;
    if (d.type === "text_delta" && typeof d.delta === "string") {
      turn.assistantBuffer += d.delta;
      turn.assistantTextEl.textContent = turn.assistantBuffer;
      this.scrollToBottom();
    } else if (d.type === "thinking_delta" && typeof d.delta === "string") {
      this.appendThinkingDelta(turn, d.delta);
    }
    // toolcall_* deltas are carried as their own tool_execution_* events
    // (more useful for rendering); ignore the per-content-block variants
    // so we don't double-render.
  }

  private appendThinkingDelta(turn: TurnDom, delta: string): void {
    if (!turn.thinkingEl) {
      const box = document.createElement("details");
      box.className = "pi-thinking";
      box.innerHTML = `
        <summary class="pi-thinking-summary">thinking…</summary>
        <pre class="pi-thinking-body"></pre>
      `;
      turn.blocksEl.appendChild(box);
      turn.thinkingEl = requireChild(box, ".pi-thinking-body");
    }
    turn.thinkingBuffer += delta;
    turn.thinkingEl.textContent = turn.thinkingBuffer;
    this.scrollToBottom();
  }

  // -------------------------------------------------------------------------
  // Tool execution rendering
  // -------------------------------------------------------------------------

  private onToolStart(toolCallId: string, toolName: string, args: unknown): void {
    const turn = this.ensureCurrentTurn();
    const card = document.createElement("div");
    card.className = "pi-tool pi-tool-running";
    card.innerHTML = `
      <div class="pi-tool-head">
        <span class="pi-tool-toggle" aria-expanded="true">▾</span>
        <span class="pi-tool-icon" aria-hidden="true">🔧</span>
        <span class="pi-tool-name"></span>
        <span class="pi-tool-state">running…</span>
      </div>
      <div class="pi-tool-args"></div>
      <div class="pi-tool-body"></div>
    `;
    (card.querySelector(".pi-tool-name") as HTMLElement).textContent = toolName;
    const argsEl = card.querySelector(".pi-tool-args") as HTMLElement;
    argsEl.textContent = compactArgs(args);
    const toggleEl = requireChild(card, ".pi-tool-toggle");
    const bodyEl = requireChild(card, ".pi-tool-body");
    toggleEl.addEventListener("click", () => {
      const expanded = toggleEl.getAttribute("aria-expanded") !== "false";
      toggleEl.setAttribute("aria-expanded", String(!expanded));
      toggleEl.textContent = expanded ? "▸" : "▾";
      argsEl.hidden = expanded;
      bodyEl.hidden = expanded;
    });
    turn.blocksEl.appendChild(card);
    this.tools.set(toolCallId, {
      root: card,
      bodyEl,
      toggleEl,
      partialBuffer: "",
    });
    this.scrollToBottom();
  }

  private onToolUpdate(toolCallId: string, partialResult: unknown): void {
    const dom = this.tools.get(toolCallId);
    if (!dom) return;
    // Pi's partialResult shape is `{ content: [...], details?: ... }`.
    // Render text-content blocks; fall back to JSON for everything else
    // so the user always sees something actionable while the tool runs.
    const text = extractToolText(partialResult);
    if (text !== null) {
      dom.partialBuffer = text;
      dom.bodyEl.textContent = text;
      this.scrollToBottom();
    }
  }

  private onToolEnd(toolCallId: string, result: unknown, isError: boolean): void {
    const dom = this.tools.get(toolCallId);
    if (!dom) return;
    const text = extractToolText(result);
    if (text !== null) {
      dom.bodyEl.textContent = text;
    } else {
      // Fall back to JSON-stringified result if no text content.
      try {
        dom.bodyEl.textContent = JSON.stringify(result, null, 2);
      } catch {
        dom.bodyEl.textContent = String(result);
      }
    }
    dom.root.classList.remove("pi-tool-running");
    dom.root.classList.add(isError ? "pi-tool-error" : "pi-tool-done");
    const stateEl = dom.root.querySelector(".pi-tool-state") as HTMLElement | null;
    if (stateEl) stateEl.textContent = isError ? "error" : "done";
    this.scrollToBottom();
  }

  // -------------------------------------------------------------------------
  // Queue indicator
  // -------------------------------------------------------------------------

  private renderQueue(q: { steering: string[]; followUp: string[] }): void {
    const total = q.steering.length + q.followUp.length;
    if (total === 0) {
      this.queueEl.hidden = true;
      this.queueEl.innerHTML = "";
      return;
    }
    this.queueEl.hidden = false;
    const parts: string[] = [];
    if (q.steering.length > 0) parts.push(`steering (${q.steering.length})`);
    if (q.followUp.length > 0) parts.push(`follow-up (${q.followUp.length})`);
    this.queueEl.textContent = `Pending: ${parts.join(" · ")}`;
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
  // Extension UI requests (PI-9 — select + confirm only; other methods
  // get logged + ignored. The full surface arrives in a follow-up).
  // -------------------------------------------------------------------------

  private openExtensionUi(
    event: { id: string; method: string } & Record<string, unknown>,
  ): void {
    const respond = (payload: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
      void piExtensionUiResponse(this.sessionId, event.id, payload).catch((err) => {
        // Cancellation already sent or session gone — log + move on.
        console.warn("piExtensionUiResponse failed", err);
      });
    };

    if (event.method === "select") {
      this.showSelectDialog(event, respond);
      return;
    }
    if (event.method === "confirm") {
      this.showConfirmDialog(event, respond);
      return;
    }

    // Fire-and-forget UI methods we don't render yet (notify / setStatus /
    // setWidget / setTitle / set_editor_text). Pi doesn't wait for a
    // response on these — surface the payload as a system note so the
    // user at least sees the extension is doing something.
    if (
      event.method === "notify" ||
      event.method === "setStatus" ||
      event.method === "setWidget" ||
      event.method === "setTitle" ||
      event.method === "setEditorText"
    ) {
      const summary =
        typeof event.message === "string"
          ? event.message
          : typeof event.title === "string"
            ? event.title
            : typeof event.statusText === "string"
              ? event.statusText
              : `(${event.method})`;
      this.appendSystemNote(`extension: ${summary}`, "info");
      return;
    }

    // Blocking methods we don't handle yet — `input` / `editor`. Auto-
    // cancel so the extension doesn't hang waiting forever.
    this.appendSystemNote(
      `extension requested ${event.method} (not yet supported) — auto-cancelled`,
      "error",
    );
    respond({ cancelled: true });
  }

  private showSelectDialog(
    event: { id: string } & Record<string, unknown>,
    respond: (payload: { value?: string; cancelled?: boolean }) => void,
  ): void {
    const title = typeof event.title === "string" ? event.title : "Select";
    const options = Array.isArray(event.options)
      ? event.options.filter((o): o is string => typeof o === "string")
      : [];
    if (options.length === 0) {
      respond({ cancelled: true });
      return;
    }
    const overlay = this.makeDialogOverlay();
    const optionsHtml = options
      .map((o, i) => {
        return `<button type="button" class="pi-ext-option" data-index="${i}">${escapeHtml(o)}</button>`;
      })
      .join("");
    overlay.innerHTML = `
      <div class="pi-ext-dialog" role="dialog" aria-label="${escapeHtml(title)}">
        <h3>${escapeHtml(title)}</h3>
        <div class="pi-ext-options">${optionsHtml}</div>
        <button type="button" class="pi-ext-cancel">Cancel</button>
      </div>
    `;
    const close = (payload: { value?: string; cancelled?: boolean }) => {
      respond(payload);
      overlay.remove();
    };
    overlay.querySelectorAll<HTMLButtonElement>(".pi-ext-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.index);
        close({ value: options[i] });
      });
    });
    overlay
      .querySelector<HTMLButtonElement>(".pi-ext-cancel")!
      .addEventListener("click", () => close({ cancelled: true }));
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close({ cancelled: true });
      }
    });
    this.host.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>(".pi-ext-option")?.focus();
  }

  private showConfirmDialog(
    event: { id: string } & Record<string, unknown>,
    respond: (payload: { confirmed?: boolean; cancelled?: boolean }) => void,
  ): void {
    const title = typeof event.title === "string" ? event.title : "Confirm";
    const message = typeof event.message === "string" ? event.message : "";
    const overlay = this.makeDialogOverlay();
    overlay.innerHTML = `
      <div class="pi-ext-dialog" role="dialog" aria-label="${escapeHtml(title)}">
        <h3>${escapeHtml(title)}</h3>
        ${message ? `<p>${escapeHtml(message)}</p>` : ""}
        <div class="pi-ext-actions">
          <button type="button" class="pi-ext-cancel">Cancel</button>
          <button type="button" class="pi-ext-ok">OK</button>
        </div>
      </div>
    `;
    const close = (payload: { confirmed?: boolean; cancelled?: boolean }) => {
      respond(payload);
      overlay.remove();
    };
    overlay
      .querySelector<HTMLButtonElement>(".pi-ext-ok")!
      .addEventListener("click", () => close({ confirmed: true }));
    overlay
      .querySelector<HTMLButtonElement>(".pi-ext-cancel")!
      .addEventListener("click", () => close({ confirmed: false }));
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close({ cancelled: true });
      }
      if (e.key === "Enter") {
        e.preventDefault();
        close({ confirmed: true });
      }
    });
    this.host.appendChild(overlay);
    overlay.querySelector<HTMLButtonElement>(".pi-ext-ok")?.focus();
  }

  private makeDialogOverlay(): HTMLElement {
    const overlay = document.createElement("div");
    overlay.className = "pi-ext-overlay";
    overlay.tabIndex = -1;
    return overlay;
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

  private async handleSteer(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (text.length === 0) {
      this.flashInput("Type the steering instruction first");
      return;
    }
    this.inputEl.value = "";
    this.appendSystemNote(`↳ steer: ${text}`, "info");
    try {
      await piSteer(this.sessionId, text);
    } catch (err) {
      this.appendSystemNote(`steer failed: ${String(err)}`, "error");
    }
  }

  private async handleFollowUp(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (text.length === 0) {
      this.flashInput("Type the follow-up instruction first");
      return;
    }
    this.inputEl.value = "";
    this.appendSystemNote(`↳ follow-up: ${text}`, "info");
    try {
      await piFollowUp(this.sessionId, text);
    } catch (err) {
      this.appendSystemNote(`follow-up failed: ${String(err)}`, "error");
    }
  }

  private flashInput(message: string): void {
    this.inputEl.placeholder = message;
    this.inputEl.classList.add("pi-chat-textarea-flash");
    window.setTimeout(() => {
      this.inputEl.placeholder = "Message Pi…  (⌘↩ to send)";
      this.inputEl.classList.remove("pi-chat-textarea-flash");
    }, 1500);
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
      <div class="pi-msg-blocks"></div>
      <div class="pi-msg-content"><span class="pi-msg-text"></span></div>
    `;
    this.messagesEl.appendChild(root);
    const assistantTextEl = requireChild(root, ".pi-msg-text");
    const blocksEl = requireChild(root, ".pi-msg-blocks");
    return {
      root,
      assistantTextEl,
      assistantBuffer: "",
      blocksEl,
      thinkingEl: null,
      thinkingBuffer: "",
    };
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
    // Steer / follow-up only make sense mid-turn — they queue an
    // instruction relative to Pi's in-flight processing.
    this.steerBtn.hidden = !busy;
    this.followUpBtn.hidden = !busy;
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

/// One-line preview of a tool's arguments. Strings stay quoted, scalars
/// inline. We cap at ~120 chars so tool calls with huge prompts/files
/// don't overflow the chat column; the user can expand the card to see
/// the streaming body.
function compactArgs(args: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(args);
  } catch {
    raw = String(args);
  }
  if (raw.length <= 120) return raw;
  return raw.slice(0, 117) + "…";
}

/// Pull text out of Pi's tool-result shape `{ content: [{type:"text",text:"..."},...] }`.
/// Returns `null` when the result has no text-type entries — the caller
/// falls back to JSON for non-text payloads (binary, structured data).
export function extractToolText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { content?: unknown };
  if (!Array.isArray(v.content)) return null;
  const parts: string[] = [];
  for (const entry of v.content) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as { type?: unknown }).type === "text" &&
      typeof (entry as { text?: unknown }).text === "string"
    ) {
      parts.push((entry as { text: string }).text);
    }
  }
  return parts.length === 0 ? null : parts.join("");
}
