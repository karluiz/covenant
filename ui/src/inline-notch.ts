/// Inline notch slot — replaces the floating overlay window when Covenant
/// is in macOS fullscreen. Lives in the bottom of the left vertical
/// tabbar (`#tabbar-host > #inline-notch-host`) so it never overlaps the
/// terminal pane. Layout matches docs/mockups/fullscreen-notch-slot-v2.html
/// (option D combo): active-tab agent header on top, chronological
/// activity stream below.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { ExecutorPhase } from "../notch/store";

const MAX_ROWS = 40;

type StatePayload = {
  session: string;
  phase: ExecutorPhase;
  tab_label?: string | null;
};

type Row = {
  ts: number;
  session: string;
  tag: string;          // tab label
  kind: "run" | "ok" | "warn" | "err" | "info";
  message: string;
};

const TAB_COLORS = ["#7c5cff", "#5ad1ff", "#7cffb2", "#ffcb5a", "#ffb13a", "#ff7cb2"];
function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}
const tabColorFor = (sid: string) => TAB_COLORS[hash(sid) % TAB_COLORS.length];

function phaseKind(p: ExecutorPhase): Row["kind"] {
  switch (p.kind) {
    case "done": return "ok";
    case "waiting": return "warn";
    case "idle": return "info";
    default: return "run";
  }
}

function phaseLabel(p: ExecutorPhase): string {
  switch (p.kind) {
    case "thinking": return "thinking";
    case "running": return `running ${p.cmd}`;
    case "writing": return `writing ${p.file}`;
    case "reading": return `reading ${p.file}`;
    case "waiting": return `waiting · ${p.reason}`;
    case "done": return p.summary ?? "done";
    case "idle": return "idle";
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/// Mount the inline slot into `host`. Visibility is driven by
/// `notch:inline-mode` events from the backend (true when main window is
/// fullscreen, false otherwise).
export function mountInlineNotch(host: HTMLElement): void {
  host.classList.add("inline-notch");
  host.innerHTML = `
    <button class="inline-notch-head" type="button" aria-expanded="true" title="Collapse notifications">
      <div class="inline-notch-av" aria-hidden="true"></div>
      <div class="inline-notch-meta">
        <div class="inline-notch-name">no agent</div>
        <div class="inline-notch-sub">idle</div>
      </div>
      <span class="inline-notch-chev" aria-hidden="true">▾</span>
    </button>
    <div class="inline-notch-body">
      <div class="inline-notch-stream-head">
        <span class="label">activity</span>
        <button class="clear" type="button">clear</button>
      </div>
      <div class="inline-notch-stream"></div>
    </div>
  `;
  host.hidden = true;

  const COLLAPSED_KEY = "covenant.inlineNotch.collapsed";
  const initialCollapsed = localStorage.getItem(COLLAPSED_KEY) === "1";
  host.classList.toggle("is-collapsed", initialCollapsed);
  const headBtn = host.querySelector<HTMLButtonElement>(".inline-notch-head")!;
  headBtn.setAttribute("aria-expanded", initialCollapsed ? "false" : "true");
  headBtn.addEventListener("click", (ev) => {
    // Don't toggle when the user clicks the "clear" button inside the body —
    // that's handled separately. (The button isn't a child of head, but be safe.)
    if ((ev.target as HTMLElement).closest(".clear")) return;
    const next = !host.classList.contains("is-collapsed");
    host.classList.toggle("is-collapsed", next);
    headBtn.setAttribute("aria-expanded", next ? "false" : "true");
    localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
  });

  const headName = host.querySelector<HTMLElement>(".inline-notch-name")!;
  const headSub = host.querySelector<HTMLElement>(".inline-notch-sub")!;
  const headAv = host.querySelector<HTMLElement>(".inline-notch-av")!;
  const streamEl = host.querySelector<HTMLElement>(".inline-notch-stream")!;
  const clearBtn = host.querySelector<HTMLButtonElement>(".clear")!;

  const rows: Row[] = [];
  const phases = new Map<string, { tab: string; phase: ExecutorPhase }>();
  let activeSession: string | null = null;

  function render(): void {
    // Header reflects the active session's executor, falling back to
    // any running session if no active one is set.
    const focus =
      (activeSession && phases.get(activeSession)) ??
      [...phases.values()].find((p) => p.phase.kind !== "idle") ??
      null;
    if (focus) {
      headName.innerHTML = `claude · <span class="tab-id">${escapeHtml(focus.tab)}</span>`;
      headSub.textContent = `▸ ${phaseLabel(focus.phase)}`;
      headAv.style.background = `linear-gradient(135deg, ${tabColorFor(focus.tab)}, #c7a8ff)`;
    } else {
      headName.textContent = "no agent";
      headSub.textContent = "idle";
      headAv.style.background = "";
    }
    // Stream: reverse-chrono, most recent first.
    streamEl.innerHTML = rows
      .slice()
      .reverse()
      .map(
        (r) => `
          <div class="row ${r.kind}">
            <span class="ts">${fmtTime(r.ts)}</span>
            <span class="msg">${escapeHtml(r.message)}</span>
            <span class="tag">${escapeHtml(r.tag)}</span>
          </div>`,
      )
      .join("");
  }

  function pushRow(r: Row): void {
    rows.push(r);
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
  }

  // Always-on: the host's visibility is now controlled by CSS via
  // body.sidebar-view-activity, not by the backend's inline-mode signal.
  host.hidden = false;

  clearBtn.addEventListener("click", () => {
    rows.length = 0;
    render();
  });

  listen<StatePayload>("notch:state", (ev) => {
    const sid = ev.payload.session;
    const tab = ev.payload.tab_label ?? `session ${sid.slice(0, 6)}`;
    phases.set(sid, { tab, phase: ev.payload.phase });
    pushRow({
      ts: Date.now(),
      session: sid,
      tag: tab,
      kind: phaseKind(ev.payload.phase),
      message: phaseLabel(ev.payload.phase),
    });
    render();
  });

  listen<{ session_id: string | null }>("ui:active-session", (ev) => {
    activeSession = ev.payload.session_id;
    render();
  });

  // Replay current state in case fullscreen toggled before we mounted.
  invoke("notch_ready").catch(() => {});

  // Paint the empty "no agent" state so the sidebar isn't blank on first open.
  render();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
