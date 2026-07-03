// AcpChatView — Copilot ACP tab body (A2).
//
// Replaces xterm.js in the tab slot for ACP sessions. Subscribes to the
// session's `session://{id}/acp` event stream, renders the streamed agent
// output as a structured chat log — prose bubbles, tool-call cards (diffs,
// shell output + exit chips), and interactive permission cards — instead
// of raw shell bytes.
//
// Architecture: all stream-shaping logic lives in the exported, DOM-free
// `reduceAcpEvent` reducer (+ `markPermAnswered` helper) so it's unit
// testable without a document. `AcpChatView` is a thin incremental
// renderer on top: it owns one `AcpStreamState`, feeds every inbound
// event through the reducer, then patches only the DOM node(s) the event
// actually touched (tool cards update in place via `tools`/`toolDoms`
// maps; a run of same-role prose chunks updates one growing `<div>`
// rather than appending a new one per delta).

import type {
  AcpAvailableCommand,
  AcpContentBlock,
  AcpPermissionOption,
  AcpPermissionRequest,
  AcpSessionUpdate,
  AcpTabEvent,
  AcpToolCallFields,
  SessionId,
} from "../../api";
import {
  acpCancel,
  acpGetCommands,
  acpRespondPermission,
  acpSendPrompt,
  closeAcpSession,
  spawnAcpSession,
  structureListDir,
  subscribeAcpEvents,
} from "../../api";
import type { DirEntry } from "../../api";
import { brandIconSvg } from "../../icons/brands";

const COPILOT_LOGO = brandIconSvg("copilot", 16) ?? "◈";

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// -----------------------------------------------------------------------
// Pure stream model — reducer + item types. No DOM. See view.test.ts.
// -----------------------------------------------------------------------

export interface AcpUserItem {
  kind: "user";
  text: string;
}

export interface AcpProseItem {
  kind: "prose";
  role: "assistant" | "thought";
  text: string;
}

export interface AcpToolItem {
  kind: "tool";
  toolCallId: string;
  /// Merged fields across `tool_call` + any `tool_call_update`s — same
  /// merge semantics as `merge_tool` in `crates/agent/src/acp/run.rs`
  /// (later non-empty value wins, per field).
  fields: AcpToolCallFields;
}

export interface AcpPermItem {
  kind: "perm";
  requestKey: string;
  request: AcpPermissionRequest;
  /// Set once the user answers (by `markPermAnswered`). A one-line
  /// human-readable record, e.g. "Allowed once · `git push`".
  answered?: string;
}

export interface AcpNoticeItem {
  kind: "notice";
  text: string;
  /// "divider": thin turn-end marker (from `prompt_done`).
  /// "dead": the ACP process died — the view renders a restart affordance.
  /// "info" / "error": free-form system notes (subscribe/send failures).
  variant: "divider" | "dead" | "info" | "error";
}

export type AcpStreamItem = AcpUserItem | AcpProseItem | AcpToolItem | AcpPermItem | AcpNoticeItem;

export interface AcpStreamState {
  items: AcpStreamItem[];
  tools: Map<string, AcpToolItem>;
  pendingPerms: Map<string, AcpPermItem>;
  inFlight: boolean;
  /// Latest slash-command roster from `available_commands_update` —
  /// replaced wholesale on every update (the wire sends the full list).
  commands: AcpAvailableCommand[];
}

export function createAcpStreamState(): AcpStreamState {
  return { items: [], tools: new Map(), pendingPerms: new Map(), inFlight: false, commands: [] };
}

/// The trailing `@fragment` immediately before the caret, if any —
/// `start` is the index of the `@` itself. Fragments may contain `/`
/// (nested paths) but never whitespace or a second `@`.
export interface MentionFragment {
  start: number;
  fragment: string;
}

export function mentionFragmentAt(value: string, caret: number): MentionFragment | null {
  const upTo = value.slice(0, caret);
  const m = /(?:^|\s)@([^\s@]*)$/.exec(upTo);
  if (!m) return null;
  return { start: caret - m[1].length - 1, fragment: m[1] };
}

/// Prefix-filter the slash roster against the composer's current `/token`.
/// `input` is the full composer value; returns [] unless the value is a
/// single leading slash-token (commands are only recognized there).
export function filterSlashCommands(
  commands: AcpAvailableCommand[],
  input: string,
): AcpAvailableCommand[] {
  const m = /^\/(\S*)$/.exec(input);
  if (!m) return [];
  const prefix = m[1].toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(prefix));
}

/// Best-effort plain text out of a content block: direct `text`, or the
/// nested `{content:{text}}` shape some ACP agents emit. Diff blocks
/// (`{path, newText}`) return `null` — those render in the tool card's
/// diff view, not as prose. Mirrors `ContentBlock::as_text` in
/// `crates/agent/src/acp/protocol.rs`.
function contentText(block: AcpContentBlock): string | null {
  const b = block as { text?: unknown; path?: unknown; content?: { text?: unknown } };
  if (typeof b.text === "string") return b.text;
  if (typeof b.path === "string") return null;
  if (b.content && typeof b.content.text === "string") return b.content.text;
  return null;
}

/// Appends `text` to the state's trailing prose item if it's the same
/// role, else starts a new one. Because this only ever looks at
/// `items[items.length - 1]`, any other item type appended in between
/// (a tool card, a user bubble, a permission card) naturally forces the
/// next chunk to start a fresh item at the correct chronological
/// position — no separate "current turn" cursor needed.
function appendProse(state: AcpStreamState, role: "assistant" | "thought", text: string | null): void {
  if (text === null || text.length === 0) return;
  const last = state.items[state.items.length - 1];
  if (last && last.kind === "prose" && last.role === role) {
    last.text += text;
    return;
  }
  state.items.push({ kind: "prose", role, text });
}

function isToolUpdate(u: AcpSessionUpdate): u is Extract<AcpSessionUpdate, { toolCallId: string }> {
  return "toolCallId" in u;
}

/// Later non-empty field wins. Identical semantics to `merge_tool` in
/// `crates/agent/src/acp/run.rs`: `null`/`undefined` on the incoming frame
/// means "unchanged", not "clear the field" (tool_call_update frames omit
/// fields that haven't changed since the initial tool_call).
function mergeToolFields(existing: AcpToolCallFields, incoming: AcpToolCallFields): void {
  if (incoming.title != null) existing.title = incoming.title;
  if (incoming.kind != null) existing.kind = incoming.kind;
  if (incoming.status != null) existing.status = incoming.status;
  if (incoming.rawInput != null) existing.rawInput = incoming.rawInput;
  if (incoming.rawOutput != null) existing.rawOutput = incoming.rawOutput;
  if (incoming.content.length > 0) existing.content = incoming.content;
}

function upsertTool(state: AcpStreamState, f: AcpToolCallFields): void {
  const existing = state.tools.get(f.toolCallId);
  if (!existing) {
    const item: AcpToolItem = { kind: "tool", toolCallId: f.toolCallId, fields: f };
    state.items.push(item);
    state.tools.set(f.toolCallId, item);
    return;
  }
  mergeToolFields(existing.fields, f);
}

/// Mutates `state` in place to reflect one event from the ACP tab
/// session's event stream. Pure aside from that mutation — no DOM, no
/// I/O — so the stream-shaping contract (chunk accumulation, tool merge
/// semantics, permission bookkeeping, turn/session lifecycle) is testable
/// on its own.
export function reduceAcpEvent(state: AcpStreamState, ev: AcpTabEvent): void {
  switch (ev.type) {
    case "update": {
      const u = ev.update.update;
      // `AcpSessionUpdate`'s catch-all member (`{ sessionUpdate: string }`,
      // for future/unrecognized wire kinds) has a plain `string` in the
      // discriminant, so `===` narrowing alone doesn't exclude it — pair
      // it with an `in` check on the field only the real variant has.
      if (u.sessionUpdate === "agent_message_chunk" && "content" in u) {
        appendProse(state, "assistant", contentText(u.content));
      } else if (u.sessionUpdate === "agent_thought_chunk" && "content" in u) {
        appendProse(state, "thought", contentText(u.content));
      } else if (isToolUpdate(u)) {
        upsertTool(state, {
          toolCallId: u.toolCallId,
          title: u.title,
          kind: u.kind,
          status: u.status,
          rawInput: u.rawInput,
          rawOutput: u.rawOutput,
          content: u.content,
        });
      } else if (u.sessionUpdate === "available_commands_update" && "availableCommands" in u) {
        state.commands = u.availableCommands;
      }
      // Unrecognized/future `sessionUpdate` kinds are ignored — the
      // protocol is public preview (see protocol.rs's `Unknown` catch-all).
      break;
    }
    case "permission_pending": {
      // A replayed/duplicate frame for a request that's already pending
      // must not spawn a second card — first one wins.
      if (state.pendingPerms.has(ev.requestKey)) return;
      const item: AcpPermItem = { kind: "perm", requestKey: ev.requestKey, request: ev.request };
      state.items.push(item);
      state.pendingPerms.set(ev.requestKey, item);
      break;
    }
    case "prompt_done": {
      state.inFlight = false;
      // end_turn is the boring, expected outcome — a loud divider per
      // turn is noise. Only surface stop reasons that carry information
      // (timeout, cancelled, refusal, max_tokens, errors).
      if (ev.stopReason !== "end_turn") {
        state.items.push({ kind: "notice", text: `Turn finished — ${ev.stopReason}`, variant: "divider" });
      }
      break;
    }
    case "session_dead": {
      state.inFlight = false;
      state.items.push({
        kind: "notice",
        text: "Copilot process exited. Restart to continue.",
        variant: "dead",
      });
      break;
    }
  }
}

/// Records the user's answer on a pending permission item and drops it
/// from `pendingPerms` (it stays in `items` as an answered record). Not
/// wire-driven — the view calls this optimistically right after the user
/// clicks an option, before `acpRespondPermission` resolves.
export function markPermAnswered(state: AcpStreamState, requestKey: string, label: string): void {
  const item = state.pendingPerms.get(requestKey);
  if (!item) return;
  item.answered = label;
  state.pendingPerms.delete(requestKey);
}

// -----------------------------------------------------------------------
// View
// -----------------------------------------------------------------------

export interface AcpChatViewOptions {
  /// The Covenant SessionId returned by `spawnAcpSession`. All event
  /// subscription + commands key off this id (reassigned on restart).
  sessionId: SessionId;
  /// Element the view will fill. Caller owns sizing/positioning; the view
  /// applies its own internal flex layout.
  host: HTMLElement;
  /// Fired when the user clicks the close affordance. Callers typically
  /// remove the tab here.
  onClose?: () => void;
  /// Current model id reported by the ACP handshake (e.g.
  /// "claude-sonnet-4.6"). Shown in the header meta; null hides it.
  model?: string | null;
  /// Working directory of the ACP session. Threaded through to
  /// `spawnAcpSession` on restart.
  cwd?: string | null;
}

interface ToolCardDom {
  root: HTMLElement;
  chipEl: HTMLElement;
  dotEl: HTMLElement;
  titleEl: HTMLElement;
  exitEl: HTMLElement;
  toggleEl: HTMLElement;
  bodyEl: HTMLElement;
}

interface PermCardDom {
  root: HTMLElement;
  waitingEl: HTMLElement;
  optionsEl: HTMLElement;
  recordEl: HTMLElement;
}

/// Public surface kept narrow: mount on construction, [`destroy`] to
/// unmount + unsubscribe. No imperative re-render entry — the view drives
/// itself off events (mirrors `PiChatView`).
export class AcpChatView {
  private readonly host: HTMLElement;
  private sessionId: SessionId;
  private readonly onCloseCb?: () => void;
  private readonly cwd: string | null;
  private model: string | null;
  private metaEl!: HTMLElement;

  private readonly state: AcpStreamState = createAcpStreamState();
  private unlisten: (() => void) | null = null;
  private destroyed = false;

  private statusEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;

  private readonly toolDoms: Map<string, ToolCardDom> = new Map();
  private readonly permDoms: Map<string, PermCardDom> = new Map();

  private slashEl!: HTMLElement;
  private slashItems: AcpAvailableCommand[] = [];
  private slashSel = 0;

  private mentionEl!: HTMLElement;
  private mentionItems: DirEntry[] = [];
  private mentionSel = 0;
  private mentionFrag: MentionFragment | null = null;
  /// cwd-relative paths picked via @-mention; filtered against the final
  /// text on send (deleting the token drops the attachment).
  private readonly mentions: Set<string> = new Set();
  /// Monotonic token so a slow structureListDir can't clobber a newer one.
  private mentionListToken = 0;
  /// The DOM node backing the trailing prose item, if any — kept in sync
  /// with `state.items[items.length - 1]` by identity so a run of
  /// same-role chunks updates one node instead of appending N.
  private lastProseItem: AcpProseItem | null = null;
  private lastProseEl: HTMLElement | null = null;

  private stickToBottom = true;

  constructor(opts: AcpChatViewOptions) {
    this.host = opts.host;
    this.sessionId = opts.sessionId;
    this.onCloseCb = opts.onClose;
    this.cwd = opts.cwd ?? null;
    this.model = opts.model ?? null;
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
    this.host.classList.remove("acp-chat-view");
  }

  /// Convenience for callers that own tab lifecycle: tears down the view
  /// AND tells the backend to close the underlying session. Use this
  /// when the tab is being permanently removed; use [`destroy`] when the
  /// session is being kept alive but the view is just being unmounted.
  async closeSession(): Promise<void> {
    this.destroy();
    try {
      await closeAcpSession(this.sessionId);
    } catch {
      /* already gone */
    }
    this.onCloseCb?.();
  }

  focusComposer(): void {
    this.inputEl?.focus();
  }

  // -------------------------------------------------------------------------
  // Mount
  // -------------------------------------------------------------------------

  private mount(): void {
    this.host.classList.add("acp-chat-view");
    this.host.innerHTML = `
      <div class="acp-chat-header">
        <span class="acp-chat-logo" aria-hidden="true">${COPILOT_LOGO}</span>
        <span class="acp-chat-title">Copilot</span>
        <span class="acp-chat-meta"></span>
        <span class="acp-chat-status" data-state="idle" aria-live="polite">idle</span>
      </div>
      <div class="acp-chat-messages" role="log" aria-live="polite">
        <div class="acp-chat-empty" role="note">
          <h3>Copilot panel, not a terminal</h3>
          <p>This is a structured chat session with GitHub Copilot's coding agent. Your prompt goes to <code>copilot --acp</code>; Covenant renders replies, tool runs, and permission requests as chat UI instead of raw shell output.</p>
          <ul>
            <li>Tool calls that edit files or run shell commands show up as cards you can inspect.</li>
            <li>When Copilot needs permission to act, you'll see a card with the wire's own options.</li>
            <li>Press <kbd>↩</kbd> to send; <kbd>⇧↩</kbd> for a new line.</li>
          </ul>
        </div>
      </div>
      <form class="acp-chat-input" autocomplete="off">
        <div class="acp-slash-menu" role="listbox" hidden></div>
        <div class="acp-slash-menu acp-mention-menu" role="listbox" hidden></div>
        <textarea
          class="acp-chat-textarea"
          rows="2"
          placeholder="Message Copilot…  (↩ send · ⇧↩ newline)"
          aria-label="Message Copilot"
        ></textarea>
        <div class="acp-chat-actions">
          <button type="button" class="acp-chat-cancel" hidden>Cancel</button>
          <button type="submit" class="acp-chat-send">Send</button>
        </div>
      </form>
    `;
    this.statusEl = requireChild(this.host, ".acp-chat-status");
    this.metaEl = requireChild(this.host, ".acp-chat-meta");
    this.renderMeta();
    this.messagesEl = requireChild(this.host, ".acp-chat-messages");
    this.messagesEl.addEventListener(
      "scroll",
      () => {
        const el = this.messagesEl;
        this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      },
      { passive: true },
    );
    this.emptyEl = requireChild(this.host, ".acp-chat-empty");
    this.inputEl = requireChild(this.host, ".acp-chat-textarea") as HTMLTextAreaElement;
    this.sendBtn = requireChild(this.host, ".acp-chat-send") as HTMLButtonElement;
    this.cancelBtn = requireChild(this.host, ".acp-chat-cancel") as HTMLButtonElement;

    const form = requireChild(this.host, "form.acp-chat-input") as HTMLFormElement;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.handleSend();
    });
    this.cancelBtn.addEventListener("click", () => void this.handleCancel());
    this.slashEl = requireChild(this.host, ".acp-slash-menu");
    this.mentionEl = requireChild(this.host, ".acp-mention-menu");
    this.inputEl.addEventListener("input", () => {
      this.updateSlashMenu();
      void this.updateMentionMenu();
    });
    this.inputEl.addEventListener("keydown", (e) => {
      // Popup navigation wins over send while a menu is open. The two
      // menus are mutually exclusive (slash needs a leading /token,
      // mention needs a trailing @fragment).
      if (!this.mentionEl.hidden) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? 1 : -1;
          const n = this.mentionItems.length;
          this.mentionSel = (this.mentionSel + delta + n) % n;
          this.renderMentionMenu();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          this.pickMention(this.mentionItems[this.mentionSel]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.hideMentionMenu();
          return;
        }
      }
      if (!this.slashEl.hidden) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          const delta = e.key === "ArrowDown" ? 1 : -1;
          const n = this.slashItems.length;
          this.slashSel = (this.slashSel + delta + n) % n;
          this.renderSlashMenu();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          this.pickSlashCommand(this.slashItems[this.slashSel]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.hideSlashMenu();
          return;
        }
      }
      if (e.key !== "Enter") return;
      // Chat convention: Enter sends, ⇧↩ inserts a newline. ⌘↩ keeps
      // sending too (muscle memory from the original binding).
      if (e.shiftKey) return; // let the textarea insert the newline
      e.preventDefault();
      void this.handleSend();
    });
  }

  // -------------------------------------------------------------------------
  // Slash-command autocomplete — roster comes from the agent's
  // `available_commands_update`; picking one just inserts `/name ` because
  // commands are invoked as plain prompt text (verified vs copilot 1.0.68).
  // -------------------------------------------------------------------------

  private updateSlashMenu(): void {
    this.slashItems = filterSlashCommands(this.state.commands, this.inputEl.value);
    if (this.slashItems.length === 0) {
      this.hideSlashMenu();
      return;
    }
    this.slashSel = Math.min(this.slashSel, this.slashItems.length - 1);
    this.slashEl.hidden = false;
    this.renderSlashMenu();
  }

  private renderSlashMenu(): void {
    this.slashEl.textContent = "";
    this.slashItems.forEach((cmd, i) => {
      const row = document.createElement("div");
      row.className = "acp-slash-row";
      row.setAttribute("role", "option");
      if (i === this.slashSel) row.classList.add("acp-slash-selected");
      const name = document.createElement("span");
      name.className = "acp-slash-name";
      name.textContent = `/${cmd.name}`;
      row.appendChild(name);
      const hint = cmd.input?.hint;
      if (hint) {
        const hintEl = document.createElement("span");
        hintEl.className = "acp-slash-hint";
        hintEl.textContent = hint;
        row.appendChild(hintEl);
      }
      if (cmd.description) {
        const desc = document.createElement("span");
        desc.className = "acp-slash-desc";
        desc.textContent = cmd.description;
        row.appendChild(desc);
      }
      // mousedown (not click) so the textarea never loses focus.
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.pickSlashCommand(cmd);
      });
      this.slashEl.appendChild(row);
    });
  }

  private pickSlashCommand(cmd: AcpAvailableCommand | undefined): void {
    if (!cmd) return;
    this.inputEl.value = `/${cmd.name} `;
    this.inputEl.focus();
    this.hideSlashMenu();
  }

  private hideSlashMenu(): void {
    this.slashEl.hidden = true;
    this.slashEl.textContent = "";
    this.slashItems = [];
    this.slashSel = 0;
  }

  // -------------------------------------------------------------------------
  // @-mention file picker — lists the session cwd via structureListDir;
  // picking a file inserts `@rel/path ` and records it as an attachment
  // (embedded as an ACP `resource` block on send). Dirs descend in place.
  // -------------------------------------------------------------------------

  private async updateMentionMenu(): Promise<void> {
    if (!this.cwd) return; // no jail root — mentions disabled
    const frag = mentionFragmentAt(this.inputEl.value, this.inputEl.selectionStart ?? 0);
    if (!frag) {
      this.hideMentionMenu();
      return;
    }
    this.mentionFrag = frag;
    const slash = frag.fragment.lastIndexOf("/");
    const dirPart = slash >= 0 ? frag.fragment.slice(0, slash + 1) : "";
    const base = (slash >= 0 ? frag.fragment.slice(slash + 1) : frag.fragment).toLowerCase();
    const token = ++this.mentionListToken;
    let entries: DirEntry[];
    try {
      entries = await structureListDir(`${this.cwd}/${dirPart}`);
    } catch {
      this.hideMentionMenu();
      return;
    }
    // A newer keystroke superseded this listing, or the fragment vanished.
    if (token !== this.mentionListToken || this.destroyed) return;
    this.mentionItems = entries
      .filter((e) => e.name.toLowerCase().startsWith(base))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
      .slice(0, 20);
    if (this.mentionItems.length === 0) {
      this.hideMentionMenu();
      return;
    }
    this.mentionSel = Math.min(this.mentionSel, this.mentionItems.length - 1);
    this.mentionEl.hidden = false;
    this.renderMentionMenu();
  }

  private renderMentionMenu(): void {
    this.mentionEl.textContent = "";
    this.mentionItems.forEach((entry, i) => {
      const row = document.createElement("div");
      row.className = "acp-slash-row";
      row.setAttribute("role", "option");
      if (i === this.mentionSel) row.classList.add("acp-slash-selected");
      const name = document.createElement("span");
      name.className = "acp-slash-name";
      name.textContent = entry.kind === "dir" ? `${entry.name}/` : entry.name;
      row.appendChild(name);
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.pickMention(entry);
      });
      this.mentionEl.appendChild(row);
    });
  }

  private pickMention(entry: DirEntry | undefined): void {
    const frag = this.mentionFrag;
    if (!entry || !frag) return;
    const slash = frag.fragment.lastIndexOf("/");
    const dirPart = slash >= 0 ? frag.fragment.slice(0, slash + 1) : "";
    const caret = this.inputEl.selectionStart ?? this.inputEl.value.length;
    const before = this.inputEl.value.slice(0, frag.start);
    const after = this.inputEl.value.slice(caret);
    if (entry.kind === "dir") {
      const repl = `@${dirPart}${entry.name}/`;
      this.inputEl.value = `${before}${repl}${after}`;
      const pos = before.length + repl.length;
      this.inputEl.setSelectionRange(pos, pos);
      this.inputEl.focus();
      void this.updateMentionMenu(); // descend: relist the picked dir
      return;
    }
    const rel = `${dirPart}${entry.name}`;
    const repl = `@${rel} `;
    this.inputEl.value = `${before}${repl}${after}`;
    const pos = before.length + repl.length;
    this.inputEl.setSelectionRange(pos, pos);
    this.mentions.add(rel);
    this.inputEl.focus();
    this.hideMentionMenu();
  }

  private hideMentionMenu(): void {
    this.mentionEl.hidden = true;
    this.mentionEl.textContent = "";
    this.mentionItems = [];
    this.mentionSel = 0;
    this.mentionFrag = null;
  }

  /// Header meta: "model · ~/short/cwd" — plain textContent, both values
  /// can be wire/user controlled and must never hit innerHTML.
  private renderMeta(): void {
    const home = /^\/Users\/[^/]+/;
    const cwd = this.cwd ? this.cwd.replace(home, "~") : null;
    this.metaEl.textContent = [this.model, cwd].filter(Boolean).join(" · ");
  }

  // -------------------------------------------------------------------------
  // Event subscription + dispatch
  // -------------------------------------------------------------------------

  private async subscribe(): Promise<void> {
    try {
      const unlisten = await subscribeAcpEvents(this.sessionId, (ev) => {
        if (this.destroyed) return;
        this.handleEvent(ev);
      });
      // destroy() may have run while the await was in flight — its
      // unsubscribe pass saw `this.unlisten === null` and skipped, so
      // detach here instead of leaking a live Tauri listener.
      if (this.destroyed) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      // Seed the slash roster: its initial broadcast raced this listener's
      // registration, so pull the backend's cached copy. Live updates keep
      // flowing through the event stream and replace it.
      try {
        const commands = await acpGetCommands(this.sessionId);
        if (!this.destroyed && this.state.commands.length === 0) {
          this.state.commands = commands;
        }
      } catch {
        /* roster is a nicety — the composer still works without it */
      }
    } catch (err) {
      if (!this.destroyed) this.appendNotice(`subscribe failed: ${String(err)}`, "error");
    }
  }

  private handleEvent(ev: AcpTabEvent): void {
    reduceAcpEvent(this.state, ev);
    switch (ev.type) {
      case "update": {
        const u = ev.update.update;
        if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_thought_chunk") {
          this.renderProseTail();
        } else if ("toolCallId" in u) {
          this.renderTool(u.toolCallId);
        }
        break;
      }
      case "permission_pending":
        this.renderPerm(ev.requestKey);
        break;
      case "prompt_done":
        this.setInFlight(false);
        this.renderNoticeTail();
        break;
      case "session_dead":
        this.setInFlight(false);
        this.renderNoticeTail();
        break;
    }
    this.scrollToBottom();
  }

  // -------------------------------------------------------------------------
  // Prose rendering — escape-then-format only (no markdown lib, never
  // innerHTML of raw agent text: escape first, THEN apply the two
  // whitelisted transforms below).
  // -------------------------------------------------------------------------

  private renderProseTail(): void {
    const item = this.state.items[this.state.items.length - 1];
    if (!item || item.kind !== "prose") return;
    if (this.lastProseItem === item && this.lastProseEl) {
      this.lastProseEl.innerHTML = formatProse(item.text);
      return;
    }
    this.hideEmptyState();
    const el = document.createElement("div");
    el.className = item.role === "thought" ? "acp-msg acp-msg-thought" : "acp-msg acp-msg-assistant";
    el.innerHTML = `<div class="acp-msg-role">${item.role === "thought" ? "thinking" : "copilot"}</div><div class="acp-msg-content"></div>`;
    const contentEl = requireChild(el, ".acp-msg-content");
    contentEl.innerHTML = formatProse(item.text);
    this.messagesEl.appendChild(el);
    this.lastProseItem = item;
    this.lastProseEl = contentEl;
  }

  // -------------------------------------------------------------------------
  // Tool call cards
  // -------------------------------------------------------------------------

  private renderTool(toolCallId: string): void {
    const item = this.state.tools.get(toolCallId);
    if (!item) return;
    let dom = this.toolDoms.get(toolCallId);
    if (!dom) {
      dom = this.buildToolCard();
      this.toolDoms.set(toolCallId, dom);
      this.hideEmptyState();
      this.messagesEl.appendChild(dom.root);
    }
    this.updateToolCard(dom, item.fields);
  }

  private buildToolCard(): ToolCardDom {
    const root = document.createElement("div");
    root.className = "acp-tool";
    root.innerHTML = `
      <div class="acp-tool-head">
        <span class="acp-status-dot" data-state="pending"></span>
        <span class="acp-chip" data-kind="tool">tool</span>
        <span class="acp-tool-title"></span>
        <span class="acp-exit-chip" hidden></span>
        <span class="acp-tool-toggle" aria-expanded="true">▾</span>
      </div>
      <div class="acp-tool-body"></div>
    `;
    const chipEl = requireChild(root, ".acp-chip");
    const dotEl = requireChild(root, ".acp-status-dot");
    const titleEl = requireChild(root, ".acp-tool-title");
    const exitEl = requireChild(root, ".acp-exit-chip");
    const toggleEl = requireChild(root, ".acp-tool-toggle");
    const bodyEl = requireChild(root, ".acp-tool-body");
    toggleEl.addEventListener("click", () => {
      const expanded = toggleEl.getAttribute("aria-expanded") !== "false";
      toggleEl.setAttribute("aria-expanded", String(!expanded));
      toggleEl.textContent = expanded ? "▸" : "▾";
      bodyEl.hidden = expanded;
    });
    return { root, chipEl, dotEl, titleEl, exitEl, toggleEl, bodyEl };
  }

  private updateToolCard(dom: ToolCardDom, f: AcpToolCallFields): void {
    const kind = f.kind ?? "tool";
    dom.chipEl.dataset.kind = kind;
    dom.chipEl.textContent = kind;

    const state = statusToState(f.status);
    dom.dotEl.dataset.state = state;
    dom.root.dataset.status = state;

    const command = commandOf(f.rawInput);
    dom.titleEl.textContent = f.title ?? command ?? f.toolCallId;

    const code = exitCodeOf(f.rawOutput);
    if (code !== null) {
      dom.exitEl.hidden = false;
      dom.exitEl.textContent = `exit ${code}`;
      dom.exitEl.dataset.ok = String(code === 0);
    } else {
      dom.exitEl.hidden = true;
    }

    dom.bodyEl.innerHTML = "";
    const diffs = diffBlocksOf(f.content);
    if (diffs.length > 0) {
      for (const d of diffs) dom.bodyEl.appendChild(buildDiffBlock(d));
    } else if (command !== null) {
      const cmdEl = document.createElement("div");
      cmdEl.className = "acp-shell-cmd";
      cmdEl.innerHTML = `<code>${escapeHtml(command)}</code>`;
      dom.bodyEl.appendChild(cmdEl);
      const out = joinContentText(f.content);
      if (out.length > 0) {
        const outEl = document.createElement("pre");
        outEl.className = "acp-shell-out";
        outEl.textContent = out;
        dom.bodyEl.appendChild(outEl);
      }
    } else {
      const out = joinContentText(f.content);
      if (out.length > 0) {
        const outEl = document.createElement("pre");
        outEl.className = "acp-shell-out";
        outEl.textContent = out;
        dom.bodyEl.appendChild(outEl);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Permission cards
  // -------------------------------------------------------------------------

  private renderPerm(requestKey: string): void {
    const item = this.state.pendingPerms.get(requestKey);
    if (!item) return;
    this.hideEmptyState();
    const dom = this.buildPermCard(item);
    this.permDoms.set(requestKey, dom);
    this.messagesEl.appendChild(dom.root);
  }

  private buildPermCard(item: AcpPermItem): PermCardDom {
    const { request } = item;
    const kind = request.toolCall.kind ?? "tool";
    const command = commandOf(request.toolCall.rawInput);
    // Edit/read-kind tool calls carry no `command` — surface the file
    // target instead so the card isn't blank about what's being touched.
    const target = command ?? fileNameOf(request.toolCall.rawInput);
    const title = request.toolCall.title ?? target ?? request.toolCall.toolCallId;

    const root = document.createElement("div");
    root.className = "acp-perm";
    root.innerHTML = `
      <div class="acp-perm-head">
        <span class="acp-chip" data-kind="${escapeHtml(kind)}">${escapeHtml(kind)}</span>
        <span class="acp-perm-title">${escapeHtml(title)}</span>
      </div>
      ${target !== null ? `<div class="acp-perm-cmd"><code>${escapeHtml(target)}</code></div>` : ""}
      <div class="acp-perm-waiting">Waiting for your decision…</div>
      <div class="acp-perm-record" hidden></div>
      <div class="acp-perm-options"></div>
    `;
    const waitingEl = requireChild(root, ".acp-perm-waiting");
    const recordEl = requireChild(root, ".acp-perm-record");
    const optionsEl = requireChild(root, ".acp-perm-options");
    for (const option of request.options) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "acp-perm-option";
      btn.dataset.optionKind = option.kind;
      btn.textContent = option.name ?? option.kind;
      btn.addEventListener("click", () => {
        this.answerPerm(item, option, { root, waitingEl, optionsEl, recordEl });
      });
      optionsEl.appendChild(btn);
    }
    return { root, waitingEl, optionsEl, recordEl };
  }

  private answerPerm(item: AcpPermItem, option: AcpPermissionOption, dom: PermCardDom): void {
    if (item.answered) return; // already answered — buttons should be disabled, but guard anyway
    const command = commandOf(item.request.toolCall.rawInput);
    const label = permAnswerLabel(option, command);

    dom.optionsEl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
      b.disabled = true;
    });
    markPermAnswered(this.state, item.requestKey, label);
    dom.waitingEl.hidden = true;
    dom.recordEl.hidden = false;
    dom.recordEl.innerHTML = formatProse(label);

    void acpRespondPermission(this.sessionId, item.requestKey, option.optionId).catch((err) => {
      dom.recordEl.innerHTML = `${formatProse(label)} <span class="acp-perm-error">(send failed: ${escapeHtml(String(err))})</span>`;
    });
  }

  // -------------------------------------------------------------------------
  // Notices (turn dividers, dead-session restart, system notes)
  // -------------------------------------------------------------------------

  private renderNoticeTail(): void {
    const item = this.state.items[this.state.items.length - 1];
    if (!item || item.kind !== "notice") return;
    this.hideEmptyState();
    this.messagesEl.appendChild(this.buildNoticeNode(item));
  }

  private buildNoticeNode(item: AcpNoticeItem): HTMLElement {
    if (item.variant === "divider") {
      const el = document.createElement("div");
      el.className = "acp-turn-divider";
      el.textContent = item.text;
      return el;
    }
    const el = document.createElement("div");
    el.className = `acp-msg-system acp-msg-system-${item.variant}`;
    el.textContent = item.text;
    if (item.variant === "dead") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "acp-restart-btn";
      btn.textContent = "Restart session";
      btn.addEventListener("click", () => void this.restart());
      el.appendChild(btn);
    }
    return el;
  }

  /// Pushed directly (not via `reduceAcpEvent`, since it's not a wire
  /// event) — used for local subscribe/send/cancel/restart failures.
  private appendNotice(text: string, variant: "info" | "error"): void {
    this.state.items.push({ kind: "notice", text, variant });
    this.hideEmptyState();
    this.messagesEl.appendChild(this.buildNoticeNode({ kind: "notice", text, variant }));
    this.scrollToBottom();
  }

  // -------------------------------------------------------------------------
  // Composer
  // -------------------------------------------------------------------------

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (text.length === 0 || this.state.inFlight) return;
    this.hideSlashMenu();
    this.hideMentionMenu();
    // Only mentions whose @token survived editing become attachments.
    const attachments = [...this.mentions].filter((p) => text.includes(`@${p}`));
    this.mentions.clear();
    this.inputEl.value = "";
    this.state.items.push({ kind: "user", text });
    this.hideEmptyState();
    const el = document.createElement("div");
    el.className = "acp-msg acp-msg-user";
    el.innerHTML = `<div class="acp-msg-role">you</div><div class="acp-msg-content">${escapeHtml(text)}</div>`;
    this.messagesEl.appendChild(el);
    this.stickToBottom = true;
    this.setInFlight(true);
    this.scrollToBottom();
    try {
      await acpSendPrompt(this.sessionId, text, attachments.length > 0 ? attachments : undefined);
    } catch (err) {
      this.setInFlight(false);
      this.appendNotice(`send failed: ${String(err)}`, "error");
    }
  }

  private async handleCancel(): Promise<void> {
    try {
      await acpCancel(this.sessionId);
      this.statusEl.dataset.state = "aborting";
      this.statusEl.textContent = "cancelling…";
    } catch (err) {
      this.appendNotice(`cancel failed: ${String(err)}`, "error");
    }
  }

  private async restart(): Promise<void> {
    if (this.unlisten) {
      try {
        this.unlisten();
      } catch {
        /* already gone */
      }
      this.unlisten = null;
    }
    try {
      const spawned = await spawnAcpSession({ cwd: this.cwd });
      // destroy() may have run during the spawn await — don't adopt the
      // fresh session or resubscribe on a torn-down view. (subscribe()
      // has its own post-await guard for a destroy racing ITS await.)
      if (this.destroyed) {
        void closeAcpSession(spawned.sessionId).catch(() => {
          /* best-effort — nothing to surface on a destroyed view */
        });
        return;
      }
      this.sessionId = spawned.sessionId;
      this.model = spawned.model ?? this.model;
      this.renderMeta();
      this.setInFlight(false);
      await this.subscribe();
      this.appendNotice("Session restarted.", "info");
    } catch (err) {
      if (!this.destroyed) this.appendNotice(`restart failed: ${String(err)}`, "error");
    }
  }

  private setInFlight(busy: boolean): void {
    this.state.inFlight = busy;
    this.sendBtn.disabled = busy;
    this.cancelBtn.hidden = !busy;
    this.statusEl.dataset.state = busy ? "running" : "idle";
    this.statusEl.textContent = busy ? "running…" : "idle";
  }

  private hideEmptyState(): void {
    this.emptyEl.hidden = true;
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      if (!this.stickToBottom) return;
      const el = this.messagesEl;
      el.scrollTop = el.scrollHeight;
    });
  }
}

function requireChild(root: HTMLElement, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`acp-chat-view: missing ${selector}`);
  return el;
}

// -----------------------------------------------------------------------
// Rendering helpers (pure — exported where useful for future reuse/tests)
// -----------------------------------------------------------------------

/// Escape-then-format: plain text with `\n` -> `<br>` and backtick spans
/// -> `<code>`. No markdown library, and the raw agent string is escaped
/// FIRST — only the escaped string ever gets the two whitelisted tags
/// spliced in, so this is safe against untrusted agent output.
export function formatProse(text: string): string {
  const escaped = escapeHtml(text);
  const withCode = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
  return withCode.replace(/\n/g, "<br>");
}

function statusToState(status: string | null | undefined): "ok" | "running" | "fail" | "pending" {
  switch (status) {
    case "completed":
      return "ok";
    case "failed":
      return "fail";
    case "pending":
    case "in_progress":
      return "running";
    default:
      return "pending";
  }
}

/// `rawInput.command` — mirrors `ToolCallFields::command()` /
/// `PermissionToolCall::command()` in `crates/agent/src/acp/protocol.rs`.
function commandOf(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const cmd = (rawInput as { command?: unknown }).command;
  return typeof cmd === "string" ? cmd : null;
}

/// `rawInput.fileName` — edit/read-kind tool calls carry this instead of
/// `command`; mirrors `tool_call_target`'s `rawInput.fileName` fallback in
/// `crates/app/src/acp_commands.rs`.
function fileNameOf(rawInput: unknown): string | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const name = (rawInput as { fileName?: unknown }).fileName;
  return typeof name === "string" ? name : null;
}

/// `rawOutput.contents[].exitCode` where `type === "shell_exit"` — mirrors
/// `ToolCallFields::exit_code()`.
function exitCodeOf(rawOutput: unknown): number | null {
  if (!rawOutput || typeof rawOutput !== "object") return null;
  const contents = (rawOutput as { contents?: unknown }).contents;
  if (!Array.isArray(contents)) return null;
  for (const entry of contents) {
    if (
      entry &&
      typeof entry === "object" &&
      (entry as { type?: unknown }).type === "shell_exit" &&
      typeof (entry as { exitCode?: unknown }).exitCode === "number"
    ) {
      return (entry as { exitCode: number }).exitCode;
    }
  }
  return null;
}

function joinContentText(content: AcpContentBlock[]): string {
  const parts: string[] = [];
  for (const c of content) {
    const t = contentText(c);
    if (t !== null) parts.push(t);
  }
  return parts.join("\n");
}

interface DiffBlockLike {
  path: string;
  oldText?: string | null;
  newText: string;
}

function diffBlocksOf(content: AcpContentBlock[]): DiffBlockLike[] {
  const out: DiffBlockLike[] = [];
  for (const c of content) {
    const b = c as { path?: unknown; newText?: unknown; oldText?: unknown };
    if (typeof b.path === "string" && typeof b.newText === "string") {
      out.push({
        path: b.path,
        newText: b.newText,
        oldText: typeof b.oldText === "string" ? b.oldText : null,
      });
    }
  }
  return out;
}

/// Renders a collapsible diff block. This is a spike-level line diff, not
/// a real LCS/Myers diff: lines from `newText` that don't match the line
/// at the same index in `oldText` render as additions (green); everything
/// else renders as context. Good enough to show "this tool call edited
/// this file" at a glance; a proper diff algorithm is out of scope here.
function buildDiffBlock(d: DiffBlockLike): HTMLElement {
  const details = document.createElement("details");
  details.className = "acp-diff";
  details.open = true;
  const newLines = d.newText.split("\n");
  const oldLines = (d.oldText ?? "").split("\n");
  const rows = newLines
    .map((line, i) => {
      const isContext = d.oldText != null && oldLines[i] === line;
      const cls = isContext ? "acp-diff-ctx" : "acp-diff-add";
      const marker = isContext ? " " : "+";
      return `<div class="acp-diff-line ${cls}">${marker} ${escapeHtml(line)}</div>`;
    })
    .join("");
  details.innerHTML = `
    <summary class="acp-diff-summary">${escapeHtml(d.path)}</summary>
    <div class="acp-diff-body">${rows}</div>
  `;
  return details;
}

function optionVerb(option: AcpPermissionOption): string {
  switch (option.kind) {
    case "allow_once":
      return "Allowed once";
    case "allow_always":
      return "Allowed always";
    case "reject_once":
      return "Denied";
    default:
      return option.name ?? option.kind;
  }
}

function permAnswerLabel(option: AcpPermissionOption, command: string | null): string {
  const verb = optionVerb(option);
  return command ? `${verb} · \`${command}\`` : verb;
}
