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

export class BlockManager {
  private readonly blocksById = new Map<string, Block>();
  private readonly order: string[] = [];
  private currentCwd = "";
  private readonly menu: ContextMenu;

  constructor(
    private readonly host: HTMLElement,
    private readonly sessionId: SessionId,
  ) {
    this.host.classList.add("blocks-host");
    this.menu = new ContextMenu(document.body);
    this.renderEmpty();
  }

  handleEvent(event: SessionUiEvent): void {
    switch (event.kind) {
      case "prompt_start":
        // Future: pulse a "shell idle" indicator.
        break;

      case "cwd_changed":
        this.currentCwd = event.cwd;
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

  private renderEmpty(): void {
    this.host.innerHTML = `
      <header class="blocks-header">blocks</header>
      <div class="blocks-empty">run a command to see it here</div>
    `;
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

    this.host.innerHTML = `
      <header class="blocks-header">
        <span>blocks</span>
        <span class="blocks-count">${this.order.length}</span>
      </header>
      <ul class="blocks-list">${items}</ul>
    `;

    // Wire fix-suggestion click handlers (rebuilt every render).
    this.host
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

    // Wire right-click context menu on each block item.
    this.host
      .querySelectorAll<HTMLElement>(".block-item")
      .forEach((el) => {
        el.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          const blockId = el.dataset.blockId;
          const block = blockId ? this.blocksById.get(blockId) : undefined;
          if (!block) return;
          this.openBlockContextMenu(block, e.clientX, e.clientY);
        });
      });

    const list = this.host.querySelector<HTMLUListElement>(".blocks-list");
    if (list) list.scrollTop = list.scrollHeight;
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
    <div class="block-fix">
      <button
        type="button"
        class="block-fix-cmd"
        data-cmd="${escapeHtml(b.fix.command)}"
        title="Click to type into the terminal (won't auto-execute)"
      >
        <span class="block-fix-icon">${Icons.lightbulb({ size: 12 })}</span>
        <span class="block-fix-cmd-text">${escapeHtml(b.fix.command)}</span>
      </button>
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
