/// Inline notch slot — replaces the floating overlay window when Covenant
/// is in macOS fullscreen. Lives in the bottom of the left vertical
/// tabbar (`#tabbar-host > #inline-notch-host`) so it never overlaps the
/// terminal pane. Layout matches docs/mockups/fullscreen-notch-slot-v2.html
/// (option D combo): active-tab agent header on top, chronological
/// activity stream below.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { ExecutorPhase } from "../notch/store";
import { attachTooltip } from "./tooltip/tooltip";

const MAX_ROWS = 40;

type StatePayload = {
  session: string;
  phase: ExecutorPhase;
  agent?: string | null;
  tab_label?: string | null;
};

type ActiveSessionPayload = {
  session_id: string | null;
  agent?: string | null;
  tab_label?: string | null;
};

type Row = {
  id: string;
  ts: number;
  firstTs: number;
  session: string;
  tag: string;          // tab label
  kind: "run" | "ok" | "warn" | "err" | "info";
  message: string;
  count: number;
};

type StreamScrollAnchor = {
  atLiveTop: boolean;
  rowId: string | null;
  viewportOffset: number;
  scrollTop: number;
  scrollHeight: number;
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

function fmtDuration(ms: number): string {
  const s = Math.max(1, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtAgent(agent: string | null | undefined): string {
  switch (agent) {
    case "pi": return "Pi";
    case "claude": return "Claude";
    case "codex": return "Codex";
    case "copilot": return "Copilot";
    case "opencode": return "opencode";
    case "aider": return "aider";
    case "gemini": return "Gemini";
    case "hermes": return "Hermes";
    default: return agent ? agent : "agent";
  }
}

/// Mount the inline slot into `host`. Visibility is driven by
/// `notch:inline-mode` events from the backend (true when main window is
/// fullscreen, false otherwise).
export function mountInlineNotch(host: HTMLElement): void {
  host.classList.add("inline-notch");
  host.innerHTML = `
    <button class="inline-notch-head" type="button" aria-expanded="true">
      <div class="inline-notch-av" aria-hidden="true"></div>
      <div class="inline-notch-meta">
        <div class="inline-notch-name">no agent</div>
        <div class="inline-notch-sub">idle</div>
      </div>
      <span class="inline-notch-chev" aria-hidden="true">▾</span>
    </button>
    <div class="inline-notch-body">
      <div class="inline-notch-picker">
        <button class="inline-notch-picker-btn" type="button">
          <span class="inline-notch-picker-stack"></span>
          <span class="inline-notch-picker-label">All agents</span>
          <span class="inline-notch-picker-arrow">▾</span>
        </button>
      </div>
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
  attachTooltip(headBtn, "Collapse notifications");
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
  const pickerBtn = host.querySelector<HTMLButtonElement>(".inline-notch-picker-btn")!;
  const pickerStack = host.querySelector<HTMLElement>(".inline-notch-picker-stack")!;
  const pickerLabel = host.querySelector<HTMLElement>(".inline-notch-picker-label")!;

  /// Multi-agent filter. `null` = combined ("All agents"). Empty set
  /// falls back to null so the user can't land in a no-rows view.
  let selectedAgents: Set<string> | null = null;
  let dropdownEl: HTMLElement | null = null;
  let dismissDropdown: ((e: Event) => void) | null = null;

  const rows: Row[] = [];
  let nextRowId = 1;
  const phases = new Map<string, { tab: string; agent: string | null; phase: ExecutorPhase }>();
  let activeSession: string | null = null;
  let activeMeta: { tab: string; agent: string | null } | null = null;

  function captureStreamScrollAnchor(): StreamScrollAnchor {
    const atLiveTop = streamEl.scrollTop <= 2;
    if (atLiveTop) {
      return {
        atLiveTop,
        rowId: null,
        viewportOffset: 0,
        scrollTop: streamEl.scrollTop,
        scrollHeight: streamEl.scrollHeight,
      };
    }

    const streamRect = streamEl.getBoundingClientRect();
    for (const row of streamEl.querySelectorAll<HTMLElement>(".row[data-row-id]")) {
      const rowRect = row.getBoundingClientRect();
      if (rowRect.bottom > streamRect.top && rowRect.top < streamRect.bottom) {
        return {
          atLiveTop,
          rowId: row.dataset.rowId ?? null,
          viewportOffset: rowRect.top - streamRect.top,
          scrollTop: streamEl.scrollTop,
          scrollHeight: streamEl.scrollHeight,
        };
      }
    }

    return {
      atLiveTop,
      rowId: null,
      viewportOffset: 0,
      scrollTop: streamEl.scrollTop,
      scrollHeight: streamEl.scrollHeight,
    };
  }

  function restoreStreamScrollAnchor(anchor: StreamScrollAnchor): void {
    if (anchor.atLiveTop) {
      streamEl.scrollTop = 0;
      return;
    }

    if (anchor.rowId) {
      const row = streamEl.querySelector<HTMLElement>(`.row[data-row-id="${anchor.rowId}"]`);
      if (row) {
        const streamRect = streamEl.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        streamEl.scrollTop += rowRect.top - streamRect.top - anchor.viewportOffset;
        return;
      }
    }

    // Fallback for the rare case where the user's anchor row aged out of
    // MAX_ROWS during this render. Keep their relative distance stable
    // rather than snapping back to the newest events.
    streamEl.scrollTop = anchor.scrollTop + (streamEl.scrollHeight - anchor.scrollHeight);
  }

  /* ── multi-agent picker ──────────────────────────────────────── */

  function knownAgents(): string[] {
    // Distinct, stable-ordered agent names from every session we've seen
    // emit a phase. Ignore null/empty so the picker doesn't grow a
    // "(no agent)" row for sessions still booting up.
    const seen = new Set<string>();
    for (const p of phases.values()) {
      if (p.agent) seen.add(p.agent);
    }
    return [...seen].sort();
  }

  function agentCount(agent: string): number {
    // How many of the buffered rows belong to this agent. Cheap because
    // MAX_ROWS caps the array; runs on every picker open.
    let n = 0;
    for (const r of rows) {
      if (phases.get(r.session)?.agent === agent) n++;
    }
    return n;
  }

  function passes(sessionId: string): boolean {
    if (selectedAgents === null) return true;
    const agent = phases.get(sessionId)?.agent;
    return agent != null && selectedAgents.has(agent);
  }

  function agentColor(agent: string): string {
    // Reuse the tab-color hash on agent names so chips/swatches are
    // stable across renders without a separate palette table.
    return TAB_COLORS[hash(agent) % TAB_COLORS.length];
  }

  function renderPicker(): void {
    const all = knownAgents();
    const visible = selectedAgents === null
      ? all
      : all.filter((a) => selectedAgents!.has(a));

    pickerStack.innerHTML = "";
    const show = visible.slice(0, 3);
    for (const a of show) {
      const dot = document.createElement("span");
      dot.className = "inline-notch-av-dot";
      dot.style.background = `linear-gradient(135deg, ${agentColor(a)}, #c7a8ff)`;
      pickerStack.appendChild(dot);
    }
    if (visible.length > show.length) {
      const more = document.createElement("span");
      more.className = "inline-notch-picker-more";
      more.textContent = `+${visible.length - show.length}`;
      pickerStack.appendChild(more);
    }
    pickerLabel.textContent = selectedAgents === null
      ? "All agents"
      : visible.length === 0
        ? "No agents"
        : visible.length === 1
          ? fmtAgent(visible[0])
          : visible.map(fmtAgent).join(" + ");
  }

  function closeDropdown(): void {
    dropdownEl?.remove();
    dropdownEl = null;
    if (dismissDropdown) {
      document.removeEventListener("mousedown", dismissDropdown);
      dismissDropdown = null;
    }
  }

  function openDropdown(): void {
    closeDropdown();
    const drop = document.createElement("div");
    drop.className = "inline-notch-picker-drop";

    function addOpt(args: { isAll?: boolean; agent?: string; selected: boolean; label: string; count: number; onClick: () => void }): void {
      const row = document.createElement("div");
      row.className = "inline-notch-picker-opt";
      if (args.selected) row.classList.add("is-selected");
      const check = document.createElement("span");
      check.className = "inline-notch-picker-check";
      check.textContent = "✓";
      row.appendChild(check);
      const av = document.createElement("span");
      av.className = "inline-notch-av-dot";
      av.style.background = args.agent
        ? `linear-gradient(135deg, ${agentColor(args.agent)}, #c7a8ff)`
        : "linear-gradient(135deg, #7c5cff, #c7a8ff)";
      row.appendChild(av);
      const name = document.createElement("span");
      name.className = "inline-notch-picker-name";
      name.textContent = args.label;
      row.appendChild(name);
      const count = document.createElement("span");
      count.className = "inline-notch-picker-count";
      count.textContent = String(args.count);
      row.appendChild(count);
      row.addEventListener("click", (e) => { e.stopPropagation(); args.onClick(); });
      drop.appendChild(row);
    }

    const head = document.createElement("div");
    head.className = "inline-notch-picker-drop-head";
    head.textContent = "Show activity for";
    drop.appendChild(head);

    addOpt({
      isAll: true,
      selected: selectedAgents === null,
      label: "All agents",
      count: rows.length,
      onClick: () => { selectedAgents = null; closeDropdown(); renderPicker(); render(); },
    });

    const all = knownAgents();
    if (all.length > 0) {
      const sep = document.createElement("div");
      sep.className = "inline-notch-picker-drop-sep";
      drop.appendChild(sep);
      const subhead = document.createElement("div");
      subhead.className = "inline-notch-picker-drop-head";
      subhead.textContent = "Or pick agents";
      drop.appendChild(subhead);
      for (const a of all) {
        const selected = selectedAgents !== null && selectedAgents.has(a);
        addOpt({
          agent: a,
          selected,
          label: fmtAgent(a),
          count: agentCount(a),
          onClick: () => {
            const next = new Set(selectedAgents ?? []);
            if (selected) next.delete(a); else next.add(a);
            selectedAgents = next.size === 0 ? null : next;
            renderPicker();
            render();
            // Re-render the open dropdown in-place so multi-select feels
            // natural (no flicker, no need to re-anchor).
            closeDropdown();
            openDropdown();
          },
        });
      }
    }

    document.body.appendChild(drop);
    const r = pickerBtn.getBoundingClientRect();
    drop.style.top = `${r.bottom + 6}px`;
    drop.style.left = `${r.left}px`;
    drop.style.minWidth = `${r.width}px`;
    dropdownEl = drop;
    dismissDropdown = (e: Event) => {
      const t = e.target as Node;
      if (drop.contains(t) || pickerBtn.contains(t)) return;
      closeDropdown();
    };
    setTimeout(() => document.addEventListener("mousedown", dismissDropdown!), 0);
  }

  pickerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dropdownEl) closeDropdown();
    else openDropdown();
  });

  function render(): void {
    // Header reflects the active session's executor, falling back to
    // any running session if no active one is set.
    const activePhase = activeSession ? phases.get(activeSession) : null;
    const focus =
      (activePhase && (activePhase.phase.kind !== "idle" || activePhase.agent)
        ? activePhase
        : null) ??
      [...phases.values()].find((p) => p.phase.kind !== "idle") ??
      (activeMeta?.agent ? { ...activeMeta, phase: { kind: "idle" } as ExecutorPhase } : null);
    if (focus) {
      headName.innerHTML = `${escapeHtml(fmtAgent(focus.agent))} · <span class="tab-id">${escapeHtml(focus.tab)}</span>`;
      headSub.textContent = `▸ ${phaseLabel(focus.phase)}`;
      headAv.style.background = `linear-gradient(135deg, ${tabColorFor(focus.tab)}, #c7a8ff)`;
    } else {
      headName.textContent = "no agent";
      headSub.textContent = "idle";
      headAv.style.background = "";
    }
    const scrollAnchor = captureStreamScrollAnchor();

    // Show the "who" badge only when the user is looking at combined /
    // multi-agent view — otherwise it's redundant noise.
    const showWho = selectedAgents === null || selectedAgents.size > 1;

    // Stream: reverse-chrono, most recent first. Filter by selected agents.
    streamEl.innerHTML = rows
      .filter((r) => passes(r.session))
      .slice()
      .reverse()
      .map((r) => {
        const agent = phases.get(r.session)?.agent ?? null;
        const who = showWho && agent
          ? `<span class="who"><span class="who-dot" style="background:${agentColor(agent)}"></span>${escapeHtml(fmtAgent(agent))}</span>`
          : "";
        return `
          <div class="row ${r.kind}" data-row-id="${escapeHtml(r.id)}" data-tip-message="${escapeHtml(r.message)}" data-tip-tag="${escapeHtml(r.tag)}">
            <span class="ts">${fmtTime(r.ts)}</span>
            <span class="row-copy">
              ${who}<span class="msg">${escapeHtml(r.message)}</span>
              <span class="row-meta">
                <span class="tag">${escapeHtml(r.tag)}</span>
                ${r.count > 1 ? `<span class="count">×${r.count}</span>` : ""}
                ${r.ts > r.firstTs ? `<span class="dur">${fmtDuration(r.ts - r.firstTs)}</span>` : ""}
              </span>
            </span>
          </div>`;
      })
      .join("");

    streamEl.querySelectorAll<HTMLElement>(".row").forEach((row) => {
      attachTooltip(row, {
        title: row.dataset.tipMessage ?? "",
        meta: row.dataset.tipTag ?? "",
      });
    });
    restoreStreamScrollAnchor(scrollAnchor);
  }

  function pushRow(input: Omit<Row, "id" | "firstTs" | "count">): void {
    const prev = rows[rows.length - 1];
    // Heartbeats and redraws can generate many identical rows ("thinking",
    // "running commands", …). Coalesce adjacent repeats into one richer row
    // so the feed says "what changed" instead of becoming a metronome.
    if (
      prev &&
      prev.session === input.session &&
      prev.kind === input.kind &&
      prev.message === input.message &&
      Date.now() - prev.ts < 30_000
    ) {
      prev.ts = input.ts;
      prev.tag = input.tag;
      prev.count += 1;
      return;
    }
    rows.push({ ...input, id: String(nextRowId++), firstTs: input.ts, count: 1 });
    if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
  }

  // Always-on: the host's visibility is now controlled by CSS via
  // body.sidebar-view-activity, not by the backend's inline-mode signal.
  host.hidden = false;

  clearBtn.addEventListener("click", () => {
    rows.length = 0;
    render();
  });

  const onNotchState = (ev: { payload: StatePayload }): void => {
    const sid = ev.payload.session;
    const tab = ev.payload.tab_label ?? `session ${sid.slice(0, 6)}`;
    phases.set(sid, { tab, agent: ev.payload.agent ?? null, phase: ev.payload.phase });
    pushRow({
      ts: Date.now(),
      session: sid,
      tag: tab,
      kind: phaseKind(ev.payload.phase),
      message: phaseLabel(ev.payload.phase),
    });
    renderPicker();
    render();
  };

  void listen<StatePayload>("notch:state", onNotchState)
    // Replay current state only after the listener is definitely installed;
    // otherwise `notch_ready` can emit the Pi snapshot into the void and
    // leave the Activity sidebar stuck at "no agent".
    .then(() => invoke("notch_ready").catch(() => {}))
    .catch(() => {});

  window.addEventListener("ui:active-session", (ev) => {
    const detail = (ev as CustomEvent<ActiveSessionPayload>).detail;
    activeSession = detail?.session_id ?? null;
    activeMeta = detail?.session_id
      ? {
          tab: detail.tab_label ?? `session ${detail.session_id.slice(0, 6)}`,
          agent: detail.agent ?? null,
        }
      : null;
    render();
  });

  // Paint the empty "no agent" state so the sidebar isn't blank on first open.
  renderPicker();
  render();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
