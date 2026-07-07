import type { SpawnSpec } from "./types";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { spawnShortcutLabel, acpExecutorFor } from "./shortcuts";

const escHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/// Brand color per executor. Matched by spec.id first, then by the
/// command's basename (so a custom "claude-2" spawn still gets the
/// Claude tint). Fallback is the generic green dot.
const BRAND_COLORS: Record<string, string> = {
  claude: "#e98b6c",
  codex: "#10a37f",
  copilot: "#79c0ff",
  opencode: "#b794f4",
  pi: "#f0a050",
  gemini: "#5fb3c4",
  ollama: "#a78bfa",
};

function brandColor(spec: SpawnSpec | undefined): string {
  if (!spec) return "#6dd29a";
  const id = spec.id.toLowerCase();
  for (const key of Object.keys(BRAND_COLORS)) {
    if (id.includes(key)) return BRAND_COLORS[key]!;
  }
  const cmd = (spec.command || "").split("/").pop()?.toLowerCase() ?? "";
  for (const key of Object.keys(BRAND_COLORS)) {
    if (cmd.includes(key)) return BRAND_COLORS[key]!;
  }
  return "#6dd29a";
}

export interface SpawnsChipDeps {
  list: () => Promise<SpawnSpec[]>;
  getBoundId: () => string | null;
  /** Pick a different executor (writes its command line into the PTY). */
  onSelect: (id: string) => void;
  /** Quick-run the currently bound executor without opening the popover. */
  onRun: (id: string) => void;
  onAdd: () => void;
}

export class SpawnsChip {
  private readonly host: HTMLElement;
  private button: HTMLButtonElement | null = null;
  private popover: HTMLDivElement | null = null;
  private specs: SpawnSpec[] = [];

  constructor(host: HTMLElement, private deps: SpawnsChipDeps) {
    this.host = host;
    this.render();
  }

  async refresh(): Promise<void> {
    this.specs = await this.deps.list();
    this.render();
  }

  private render(): void {
    const bound =
      this.specs.find((s) => s.id === this.deps.getBoundId()) ??
      this.specs.find((s) => s.default) ??
      this.specs[0];
    this.host.innerHTML = "";
    const btn = document.createElement("button");
    btn.className = "spawns-chip";
    btn.type = "button";
    const color = brandColor(bound);
    btn.style.setProperty("--spawn-accent", color);
    btn.innerHTML = `
      <span class="spawns-chip__dot" style="background:${color};box-shadow:0 0 6px ${color}99;"></span>
      <span class="spawns-chip__label">${escHtml(bound?.label ?? "Spawn")}</span>
      <span class="spawns-chip__caret"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></span>
      <span class="spawns-chip__run" role="button" aria-label="Run ${escHtml(bound?.label ?? "executor")}">${Icons.play({ size: 10 })}</span>
    `;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      // Play button: quick-run the bound executor without opening
      // the popover. Anywhere else on the chip → open the picker.
      const runEl = (e.target as HTMLElement).closest(".spawns-chip__run");
      if (runEl && bound?.id) {
        this.deps.onRun(bound.id);
        return;
      }
      void this.toggle();
    });
    this.button = btn;
    this.host.appendChild(btn);
    const runEl = btn.querySelector<HTMLElement>(".spawns-chip__run");
    if (runEl) attachTooltip(runEl, `Run ${bound?.label ?? "executor"}`);
  }

  private async toggle(): Promise<void> {
    if (this.popover) {
      this.close();
      return;
    }
    await this.refresh();
    this.open();
  }

  /// Open the popover programmatically. Used by the onboarding wizard
  /// to show the spawn picker without simulating a click on the chip
  /// (which can race with the chip's own click handler if the popover
  /// state is stale).
  async openPopover(): Promise<void> {
    if (this.popover) return;
    await this.refresh();
    this.open();
  }

  private open(): void {
    const pop = document.createElement("div");
    pop.className = "spawns-popover";
    const rect = this.button!.getBoundingClientRect();
    pop.style.top = `${Math.round(rect.bottom + 4)}px`;
    pop.style.left = `${Math.round(rect.left)}px`;
    const boundId = this.deps.getBoundId();
    pop.innerHTML =
      this.specs
        .map(
          (s, i) => {
          const c = brandColor(s);
          const kbd = spawnShortcutLabel(i);
          return `
        <button class="spawns-popover__item${s.id === boundId ? " is-active" : ""}" data-id="${s.id}" type="button" style="--spawn-accent:${c};">
          <span class="dot" style="background:${c};box-shadow:0 0 6px ${c}99;"></span>
          <span class="label">${escHtml(s.label)}</span>
          ${s.acp && acpExecutorFor(s) ? `<span class="spawn-acp-badge">ACP</span>` : ""}
          ${kbd ? `<span class="spawn-kbd">${kbd}</span>` : ""}
        </button>`;
        }
        )
        .join("") +
      `<div class="spawns-popover__sep"></div>
       <button class="spawns-popover__add" type="button">+ add executor…</button>`;
    pop.addEventListener("click", (e) => {
      const item = (e.target as HTMLElement).closest("[data-id]") as HTMLElement | null;
      if (item?.dataset["id"]) {
        this.deps.onSelect(item.dataset["id"]);
        this.close();
        return;
      }
      if ((e.target as HTMLElement).closest(".spawns-popover__add")) {
        this.deps.onAdd();
        this.close();
      }
    });
    document.body.appendChild(pop);
    this.popover = pop;
    setTimeout(
      () => document.addEventListener("click", this.closeOnOutside, { once: true }),
      0
    );
  }

  private closeOnOutside = (e: MouseEvent): void => {
    if (this.popover && !this.popover.contains(e.target as Node)) {
      this.close();
    }
  };

  private close(): void {
    this.popover?.remove();
    this.popover = null;
  }
}
