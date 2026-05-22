// Sidebar block list + inline fix suggestions.
//
// Consumes SessionUiEvents from the backend, assembles them into Block
// records keyed by the *backend* BlockId (so fix_suggested events can
// be correlated to their block), and renders an append-only list.
// Render is innerHTML rebuild on every change — fine at M2 traffic.
// Fix suggestions appear inline under the failed block; clicking the
// suggested command writes it into the PTY without a newline (the user
// reviews and presses Enter — SuggestOnly policy, M4).

import {
  getBlockOutput,
  injectCommand,
  recentBlocksByCwd,
  type HistoricalBlockRow,
  type SessionId,
  type SessionUiEvent,
} from "../api";
import { Icons } from "../icons";
import { ContextMenu } from "../menu/context-menu";

interface Block {
  id: string;
  command: string;
  cwd: string;
  startedAtMs: number;
  finishedAtMs?: number;
  exitCode: number | null | undefined;
  fix?: { command: string; rationale: string };
}

const COLLAPSE_KEY = "covenant.blocks-sidebar-collapsed";

export class BlockManager {
  private readonly blocksById = new Map<string, Block>();
  private readonly order: string[] = [];
  private currentCwd = "";
  private readonly menu: ContextMenu;
  /// Wrapper inside `host`. We render into THIS, not `host.innerHTML`
  /// directly, so a sibling RecallManager rooted in the same `host`
  /// doesn't get wiped on every block re-render.
  private readonly content: HTMLDivElement;
  private collapsed: boolean;
  /// Historical blocks loaded on first cwd_changed — gives the user
  /// "what was I doing here" context when reopening a tab. Loaded
  /// once per session (not refetched on subsequent cd's) so the
  /// history panel is stable.
  private historicalBlocks: HistoricalBlockRow[] = [];
  private historyLoaded = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly sessionId: SessionId,
    private readonly onBlockFinishedCb?: (exitCode: number) => void,
  ) {
    this.host.classList.add("blocks-host");
    this.menu = new ContextMenu(document.body);
    this.content = document.createElement("div");
    this.content.className = "blocks-content";
    this.host.appendChild(this.content);
    // Persisted across sessions — once you collapse it, it stays
    // collapsed for new tabs too. localStorage is shared per-origin.
    this.collapsed = localStorage.getItem(COLLAPSE_KEY) === "1";
    this.applyCollapsed();
    this.renderEmpty();
  }

  /// Make the blocks panel visible. Used by the contextual switcher
  /// (TabManager) when Recall has nothing useful to show.
  show(): void {
    this.content.hidden = false;
  }

  /// Hide the blocks panel — Recall is taking over the column.
  hide(): void {
    this.content.hidden = true;
  }

  private applyCollapsed(): void {
    this.host.classList.toggle("blocks-collapsed", this.collapsed);
  }

  private toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    if (this.collapsed) {
      localStorage.setItem(COLLAPSE_KEY, "1");
    } else {
      localStorage.removeItem(COLLAPSE_KEY);
    }
    this.applyCollapsed();
    if (this.order.length === 0) this.renderEmpty();
    else this.render();
  }

  handleEvent(event: SessionUiEvent): void {
    switch (event.kind) {
      case "prompt_start":
        // Future: pulse a "shell idle" indicator.
        break;

      case "cwd_changed":
        this.currentCwd = event.cwd;
        // First cwd we see for this tab → fetch history. Async, so
        // re-render fires when results land. Subsequent cd's don't
        // refetch — history stays as the "initial context" view.
        if (!this.historyLoaded && event.cwd) {
          this.historyLoaded = true;
          void recentBlocksByCwd(event.cwd, 30)
            .then((rows) => {
              this.historicalBlocks = rows;
              if (rows.length > 0) {
                if (this.order.length === 0) this.renderEmpty();
                else this.render();
              }
            })
            .catch((err) => {
              // eslint-disable-next-line no-console
              console.warn("recent_blocks_by_cwd failed", err);
            });
        }
        break;

      case "block_started": {
        const block: Block = {
          id: event.block,
          command:
            event.command.trim().length === 0
              ? "(empty command)"
              : event.command.trim(),
          cwd: event.cwd || this.currentCwd,
          startedAtMs: performance.now(),
          exitCode: undefined,
        };
        this.blocksById.set(block.id, block);
        this.order.push(block.id);
        this.render();
        break;
      }

      case "block_finished": {
        const block = this.blocksById.get(event.block);
        if (!block) return;
        block.exitCode = event.exit_code;
        block.finishedAtMs = block.startedAtMs + event.duration_ms;
        this.render();
        if (event.exit_code != null) this.onBlockFinishedCb?.(event.exit_code);
        break;
      }

      case "fix_suggested": {
        const block = this.blocksById.get(event.block);
        if (!block) return;
        block.fix = { command: event.command, rationale: event.rationale };
        this.render();
        break;
      }
    }
  }

  /// Render the "from previous sessions" section: a separator + a
  /// list of historical block items styled distinctly from the
  /// live ones (faded + italic) so the user reads them as past
  /// context, not current activity. Empty string when no history.
  private renderHistoricalSection(): string {
    if (this.historicalBlocks.length === 0) return "";
    const items = this.historicalBlocks
      .map((b, idx) => {
        const codeText =
          b.exit_code === null || b.exit_code === undefined
            ? "?"
            : String(b.exit_code);
        const ok = b.exit_code === 0;
        const dur = formatDuration(b.duration_ms);
        const when = formatRelativeAge(Date.now() - b.finished_at_unix_ms);
        return `
          <li class="block-item block-item-history" data-history-idx="${idx}">
            <div class="block-cmd">$ ${escapeHtml(b.command)}</div>
            <div class="block-meta">
              <span class="block-exit ${ok ? "ok" : "fail"}">exit ${escapeHtml(codeText)}</span>
              <span class="block-history-tab">…${escapeHtml(b.session_id_short)}</span>
              <span class="block-history-when">${when}</span>
              <span class="block-dur">${dur}</span>
            </div>
          </li>
        `;
      })
      .join("");
    return `
      <div class="blocks-history-sep">from previous sessions in this dir</div>
      <ul class="blocks-list blocks-list-history">${items}</ul>
    `;
  }

  private renderHeader(count: number): string {
    return `
      <header class="blocks-header">
        <span class="blocks-header-label">blocks</span>
        ${count > 0 ? `<span class="blocks-count">${count}</span>` : ""}
      </header>
    `;
  }

  private renderEmpty(): void {
    this.content.innerHTML = this.renderHeader(0);
    if (!this.collapsed) {
      const history = this.renderHistoricalSection();
      const empty = document.createElement("div");
      if (history.length > 0) {
        // History exists but no current-session blocks yet. The history
        // list expands to fill the sidebar (flex:1, scrolls); the
        // "(new commands appear below)" hint is a small inline line
        // beneath it — NOT a flex:1 block, otherwise it competes with
        // the history list for vertical space and the layout looks
        // half-empty.
        this.content.insertAdjacentHTML("beforeend", history);
        empty.className = "blocks-empty blocks-empty-inline";
        empty.textContent = "(new commands will appear below)";
      } else {
        // Truly empty (fresh tab, no history yet) — center the
        // friendly hint in the whole sidebar.
        empty.className = "blocks-empty";
        empty.textContent = "run a command to see it here";
      }
      this.content.appendChild(empty);
    }
    this.wireToggle();
    this.wireBlockContextMenus();
  }

  private render(): void {
    if (this.order.length === 0) {
      this.renderEmpty();
      return;
    }

    const items = this.order
      .map((id) => {
        const b = this.blocksById.get(id);
        if (!b) return "";
        const status = renderStatus(b);
        const cwd = b.cwd ? escapeHtml(shortenCwd(b.cwd)) : "";
        const fix = renderFix(b);
        return `
          <li class="block-item" data-block-id="${escapeHtml(b.id)}">
            ${cwd ? `<div class="block-cwd">${cwd}</div>` : ""}
            <div class="block-cmd">$ ${escapeHtml(b.command)}</div>
            <div class="block-meta">${status}</div>
            ${fix}
          </li>
        `;
      })
      .join("");

    const history = this.collapsed ? "" : this.renderHistoricalSection();
    this.content.innerHTML = `
      ${this.renderHeader(this.order.length)}
      ${history}
      ${this.collapsed ? "" : `<ul class="blocks-list">${items}</ul>`}
    `;
    this.wireToggle();

    // Wire fix-suggestion click handlers (rebuilt every render).
    this.content
      .querySelectorAll<HTMLElement>(".block-fix-cmd")
      .forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const cmd = el.dataset.cmd ?? "";
          if (cmd) {
            void injectCommand(this.sessionId, cmd).catch((err) => {
              // eslint-disable-next-line no-console
              console.error("inject_command failed", err);
            });
          }
        });
      });

    // Dismiss-suggestion handler. Drops `fix` from the in-memory block
    // and re-renders. The agent doesn't re-fire `fix_suggested` for the
    // same block, so this is sufficient for the session lifetime.
    this.content
      .querySelectorAll<HTMLElement>(".block-fix-dismiss")
      .forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          const blockId = el.dataset.blockId;
          if (!blockId) return;
          const block = this.blocksById.get(blockId);
          if (!block || !block.fix) return;
          delete block.fix;
          this.render();
        });
      });

    this.wireBlockContextMenus();

    const list = this.content.querySelector<HTMLUListElement>(".blocks-list");
    if (list) list.scrollTop = list.scrollHeight;
  }

  /// Wires right-click handlers on both current-session and historical
  /// block items. Called after every render path that produces items.
  private wireBlockContextMenus(): void {
    this.content
      .querySelectorAll<HTMLElement>(".block-item:not(.block-item-history)")
      .forEach((el) => {
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const blockId = el.dataset.blockId;
          const block = blockId ? this.blocksById.get(blockId) : undefined;
          if (!block) return;
          this.openBlockContextMenu(block, e.clientX, e.clientY);
        });
      });

    this.content
      .querySelectorAll<HTMLElement>(".block-item-history")
      .forEach((el) => {
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const idxStr = el.dataset.historyIdx;
          if (idxStr === undefined) return;
          const hb = this.historicalBlocks[Number(idxStr)];
          if (!hb) return;
          this.openHistoricalContextMenu(hb, e.clientX, e.clientY);
        });
      });
  }

  private wireToggle(): void {
    const btn = this.content.querySelector<HTMLButtonElement>(".blocks-toggle");
    if (btn) {
      btn.addEventListener("click", () => this.toggleCollapsed());
    }
  }

  private openBlockContextMenu(block: Block, x: number, y: number): void {
    const hasFinished = block.finishedAtMs !== undefined;
    this.menu.show(x, y, [
      {
        label: "Copy command",
        icon: Icons.copy(),
        onClick: () => copyToClipboard(block.command),
      },
      {
        label: "Execute command",
        icon: Icons.lightbulb(),
        onClick: () =>
          injectCommand(this.sessionId, block.command).catch((err) => {
            // eslint-disable-next-line no-console
            console.error("inject_command failed", err);
          }),
      },
      {
        label: "Copy output",
        icon: Icons.copy(),
        disabled: !hasFinished,
        onClick: async () => {
          try {
            const out = await getBlockOutput(block.id);
            if (out !== null && out.length > 0) {
              await copyToClipboard(out);
            }
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error("get_block_output failed", err);
          }
        },
      },
      ...(block.fix
        ? [
            { divider: true } as const,
            {
              label: "Inject fix into terminal",
              icon: Icons.lightbulb(),
              onClick: () =>
                injectCommand(this.sessionId, block.fix!.command).catch(
                  (err) => {
                    // eslint-disable-next-line no-console
                    console.error("inject failed", err);
                  },
                ),
            },
          ]
        : []),
    ]);
  }

  private openHistoricalContextMenu(
    hb: HistoricalBlockRow,
    x: number,
    y: number,
  ): void {
    this.menu.show(x, y, [
      {
        label: "Copy command",
        icon: Icons.copy(),
        onClick: () => copyToClipboard(hb.command),
      },
      {
        label: "Execute command",
        icon: Icons.lightbulb(),
        onClick: () =>
          injectCommand(this.sessionId, hb.command).catch((err) => {
            // eslint-disable-next-line no-console
            console.error("inject_command failed", err);
          }),
      },
    ]);
  }
}

function renderStatus(b: Block): string {
  if (b.finishedAtMs === undefined) {
    return `<span class="block-running">running…</span>`;
  }
  const dur = Math.max(0, Math.round(b.finishedAtMs - b.startedAtMs));
  const code = b.exitCode;
  const codeText = code === null || code === undefined ? "?" : String(code);
  const ok = code === 0;
  return `
    <span class="block-exit ${ok ? "ok" : "fail"}">exit ${escapeHtml(codeText)}</span>
    <span class="block-dur">${formatDuration(dur)}</span>
  `;
}

function renderFix(b: Block): string {
  if (!b.fix) return "";
  return `
    <div class="block-fix" data-block-id="${escapeHtml(b.id)}">
      <div class="block-fix-row">
        <button
          type="button"
          class="block-fix-cmd"
          data-cmd="${escapeHtml(b.fix.command)}"
          title="Click to type into the terminal (won't auto-execute)"
        >
          <span class="block-fix-icon">${Icons.lightbulb({ size: 12 })}</span>
          <span class="block-fix-cmd-text">${escapeHtml(b.fix.command)}</span>
        </button>
        <button
          type="button"
          class="block-fix-dismiss"
          data-block-id="${escapeHtml(b.id)}"
          title="Dismiss suggestion"
          aria-label="Dismiss suggestion"
        >${Icons.x({ size: 11 })}</button>
      </div>
      ${
        b.fix.rationale
          ? `<div class="block-fix-why">${escapeHtml(b.fix.rationale)}</div>`
          : ""
      }
    </div>
  `;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m${rs.toString().padStart(2, "0")}s`;
}

function shortenCwd(path: string): string {
  const m = /^\/Users\/[^/]+(\/.*)?$/.exec(path);
  if (m) return `~${m[1] ?? ""}`;
  return path;
}

/// Compact age label for historical blocks. "5m", "2h", "3d" — no
/// "ago" suffix because the column header already says "previous".
function formatRelativeAge(ms: number): string {
  if (ms < 0) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("clipboard write failed", err);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
