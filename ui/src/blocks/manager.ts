// Sidebar block list. Consumes BlockEvents from the backend, assembles
// them into Block records, and renders an append-only list inside a host
// element. Rendering is intentionally crude (innerHTML rebuild on each
// change) — at M1 traffic levels this is fine; we'll diff at M5+ if it
// matters.

import type { BlockEvent } from "../api";

interface Block {
  id: string;
  command: string;
  cwd: string;
  startedAtMs: number;
  finishedAtMs?: number;
  exitCode: number | null | undefined;
}

export class BlockManager {
  private blocks: Block[] = [];
  private inFlight?: Block;
  private currentCwd = "";

  constructor(private readonly host: HTMLElement) {
    this.host.classList.add("blocks-host");
    this.renderEmpty();
  }

  handleEvent(event: BlockEvent): void {
    switch (event.kind) {
      case "prompt_start":
        // No visible side effect today. Future: pulse a "shell idle"
        // indicator.
        break;

      case "cwd_changed":
        this.currentCwd = event.path;
        if (this.inFlight) this.inFlight.cwd = this.currentCwd;
        break;

      case "command_submitted": {
        const trimmed = event.command.trim();
        const block: Block = {
          id: crypto.randomUUID(),
          command: trimmed.length === 0 ? "(empty command)" : trimmed,
          cwd: this.currentCwd,
          startedAtMs: performance.now(),
          exitCode: undefined,
        };
        this.blocks.push(block);
        this.inFlight = block;
        this.render();
        break;
      }

      case "command_finished":
        if (this.inFlight) {
          this.inFlight.exitCode = event.exit_code;
          this.inFlight.finishedAtMs = performance.now();
          this.inFlight = undefined;
          this.render();
        }
        break;
    }
  }

  private renderEmpty(): void {
    this.host.innerHTML = `
      <header class="blocks-header">blocks</header>
      <div class="blocks-empty">run a command to see it here</div>
    `;
  }

  private render(): void {
    if (this.blocks.length === 0) {
      this.renderEmpty();
      return;
    }

    const items = this.blocks
      .map((b) => {
        const status = renderStatus(b);
        const cwd = b.cwd ? escapeHtml(shortenCwd(b.cwd)) : "";
        return `
          <li class="block-item">
            ${cwd ? `<div class="block-cwd">${cwd}</div>` : ""}
            <div class="block-cmd">$ ${escapeHtml(b.command)}</div>
            <div class="block-meta">${status}</div>
          </li>
        `;
      })
      .join("");

    this.host.innerHTML = `
      <header class="blocks-header">
        <span>blocks</span>
        <span class="blocks-count">${this.blocks.length}</span>
      </header>
      <ul class="blocks-list">${items}</ul>
    `;

    const list = this.host.querySelector<HTMLUListElement>(".blocks-list");
    if (list) list.scrollTop = list.scrollHeight;
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m${rs.toString().padStart(2, "0")}s`;
}

function shortenCwd(path: string): string {
  // Replace the user's home with `~` for legibility. We don't have HOME
  // on the renderer side, so detect the common /Users/<name> macOS shape.
  const m = /^\/Users\/[^/]+(\/.*)?$/.exec(path);
  if (m) return `~${m[1] ?? ""}`;
  return path;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
