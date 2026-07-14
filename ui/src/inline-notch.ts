/// Inline notch slot — replaces the floating overlay window when Covenant
/// is in macOS fullscreen. Lives in the bottom of the left vertical
/// tabbar (`#tabbar-host > #inline-notch-host`) so it never overlaps the
/// terminal pane. The stream renders TURNS (one row per agent work cycle,
/// aggregated by ui/src/activity/turns.ts), not raw phase events — see
/// docs/superpowers/specs/2026-07-14-activity-turns-design.md.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { ExecutorPhase } from "../notch/store";
import { attachTooltip } from "./tooltip/tooltip";
import { Icons } from "./icons";
import { TurnAggregator, liveTail, type Turn } from "./activity/turns";

type StatePayload = {
  session: string;
  phase: ExecutorPhase;
  agent?: string | null;
  tab_label?: string | null;
  /// Tokens charged to this session between the previous notch:state
  /// emit and this one. Attached by the bridge in `notch.rs::emit_with_tokens`.
  tokens_delta?: number;
};

type ActiveSessionPayload = {
  session_id: string | null;
  agent?: string | null;
  tab_label?: string | null;
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
function phaseActive(p: ExecutorPhase): boolean {
  switch (p.kind) {
    case "done":
    case "waiting":
    case "idle":
      return false;
    default:
      return true;
  }
}

/// Map a turn onto the shared rail `data-spine` vocabulary
/// (live | run | ok | fail | idle) that colours the left spine.
function spineForTurn(t: Turn): string {
  if (t.waiting) return "run";
  switch (t.status) {
    case "live": return "live";
    case "done": return "ok";
    case "ended": return "idle";
  }
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
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
  // Keep `.inline-notch` on the host: the shared collapse rule
  // (`#activity-sidebar.is-collapsed .inline-notch-body`) and the body's
  // flex layout (`.inline-notch .inline-notch-body`) still drive the
  // collapsible region. Zero the host's own padding so the rail panel is
  // edge-to-edge (hairline borders reach the rail's sides).
  host.classList.add("inline-notch");
  host.style.padding = "0";
  host.innerHTML = `
    <div class="rail-panel">
      <div class="rail-header">
        <div class="rail-title">
          <span class="rail-dot"></span>
          <span class="rail-title-label">Activity</span>
        </div>
        <div class="rail-actions">
          <button class="rail-btn rail-collapse" type="button" aria-expanded="true"></button>
        </div>
      </div>
      <div class="inline-notch-body" style="gap:0">
        <div class="rail-controls">
          <div class="rail-select" role="button" tabindex="0">
            <span class="rail-select-stack"></span>
            <span class="rail-select-label">All agents</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
          </div>
        </div>
        <div class="rail-substream">
          <span>activity</span>
          <button class="clear" type="button">clear</button>
        </div>
        <div class="rail-body"></div>
      </div>
    </div>
  `;
  host.hidden = true;

  const railDot = host.querySelector<HTMLElement>(".rail-dot")!;
  const collapseBtn = host.querySelector<HTMLButtonElement>(".rail-collapse")!;
  const streamEl = host.querySelector<HTMLElement>(".rail-body")!;
  const clearBtn = host.querySelector<HTMLButtonElement>(".clear")!;
  const selectEl = host.querySelector<HTMLElement>(".rail-select")!;
  const pickerStack = host.querySelector<HTMLElement>(".rail-select-stack")!;
  const pickerLabel = host.querySelector<HTMLElement>(".rail-select-label")!;

  const COLLAPSED_KEY = "covenant.inlineNotch.collapsed";
  const setCollapseIcon = (collapsed: boolean): void => {
    // chevrons-up-down = "expand" (currently collapsed);
    // chevrons-down-up = "collapse" (currently expanded).
    collapseBtn.innerHTML = collapsed
      ? Icons.chevronsUpDown({ size: 15 })
      : Icons.chevronsDownUp({ size: 15 });
  };
  const initialCollapsed = localStorage.getItem(COLLAPSED_KEY) === "1";
  host.classList.toggle("is-collapsed", initialCollapsed);
  collapseBtn.setAttribute("aria-expanded", initialCollapsed ? "false" : "true");
  setCollapseIcon(initialCollapsed);
  attachTooltip(collapseBtn, "Collapse activity");
  collapseBtn.addEventListener("click", () => {
    const next = !host.classList.contains("is-collapsed");
    host.classList.toggle("is-collapsed", next);
    collapseBtn.setAttribute("aria-expanded", next ? "false" : "true");
    setCollapseIcon(next);
    localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
  });

  /// Multi-agent filter. `null` = combined ("All agents"). Empty set
  /// falls back to null so the user can't land in a no-rows view.
  let selectedAgents: Set<string> | null = null;
  let dropdownEl: HTMLElement | null = null;
  let dismissDropdown: ((e: Event) => void) | null = null;

  const agg = new TurnAggregator();
  /// Turn ids the user unfolded to see the event list.
  const expanded = new Set<string>();
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
    for (const row of streamEl.querySelectorAll<HTMLElement>(".rail-row[data-row-id]")) {
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
      const row = streamEl.querySelector<HTMLElement>(`.rail-row[data-row-id="${anchor.rowId}"]`);
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
    // How many buffered turns belong to this agent. Cheap because the
    // aggregator caps history; runs on every picker open.
    let n = 0;
    for (const t of agg.turns) {
      if (t.agent === agent) n++;
    }
    return n;
  }

  function passes(turn: Turn): boolean {
    if (selectedAgents === null) return true;
    return turn.agent != null && selectedAgents.has(turn.agent);
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
      // `.rail-select-stack i` carries the shared size/border; only the
      // per-agent gradient is set inline.
      const dot = document.createElement("i");
      dot.style.background = `linear-gradient(135deg, ${agentColor(a)}, #c7a8ff)`;
      pickerStack.appendChild(dot);
    }
    if (visible.length > show.length) {
      const more = document.createElement("span");
      more.textContent = `+${visible.length - show.length}`;
      more.style.cssText = "font-size:10px;color:var(--fg-dim);margin-left:4px;align-self:center;";
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
    // Reuse the canonical CustomSelect popover chrome (.ui-select__*) so
    // this bespoke multi-select matches every other Covenant select; the
    // inline-notch-* classes only carry the extras (head, count, dot).
    drop.className = "ui-select__popover inline-notch-picker-drop";
    drop.setAttribute("role", "listbox");

    function addOpt(args: { isAll?: boolean; agent?: string; selected: boolean; label: string; count: number; onClick: () => void }): void {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ui-select__option inline-notch-picker-opt";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(args.selected));
      if (args.selected) row.classList.add("is-selected");
      const check = document.createElement("span");
      check.className = "ui-select__option-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = args.selected ? "✓" : "";
      row.appendChild(check);
      const av = document.createElement("span");
      av.className = "inline-notch-av-dot";
      av.style.background = args.agent
        ? `linear-gradient(135deg, ${agentColor(args.agent)}, #c7a8ff)`
        : "linear-gradient(135deg, #7c5cff, #c7a8ff)";
      row.appendChild(av);
      const name = document.createElement("span");
      name.className = "ui-select__option-label inline-notch-picker-name";
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
      count: agg.turns.length,
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
    const r = selectEl.getBoundingClientRect();
    drop.style.top = `${r.bottom + 6}px`;
    drop.style.left = `${r.left}px`;
    drop.style.minWidth = `${r.width}px`;
    dropdownEl = drop;
    dismissDropdown = (e: Event) => {
      const t = e.target as Node;
      if (drop.contains(t) || selectEl.contains(t)) return;
      closeDropdown();
    };
    setTimeout(() => document.addEventListener("mousedown", dismissDropdown!), 0);
  }

  selectEl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (dropdownEl) closeDropdown();
    else openDropdown();
  });
  selectEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (dropdownEl) closeDropdown();
      else openDropdown();
    }
  });

  function render(): void {
    // The header no longer carries the per-agent identity (that moved to the
    // picker below). It only drives the live status dot: `is-run` when the
    // focused executor is actively thinking/running, default otherwise. We
    // still compute the same focus session as before to decide that.
    const activePhase = activeSession ? phases.get(activeSession) : null;
    const focus =
      (activePhase && (activePhase.phase.kind !== "idle" || activePhase.agent)
        ? activePhase
        : null) ??
      [...phases.values()].find((p) => p.phase.kind !== "idle") ??
      (activeMeta?.agent ? { ...activeMeta, phase: { kind: "idle" } as ExecutorPhase } : null);
    const active = !!focus && phaseActive(focus.phase);
    railDot.className = "rail-dot" + (active ? " is-run" : "");

    const scrollAnchor = captureStreamScrollAnchor();

    // Show the agent name in the row only when the user is looking at the
    // combined / multi-agent view — otherwise it's redundant noise.
    const showWho = selectedAgents === null || selectedAgents.size > 1;

    // Stream: one row per TURN, reverse-chrono. Filter by selected agents.
    streamEl.innerHTML = agg.turns
      .filter(passes)
      .slice()
      .reverse()
      .map((t) => {
        // "[agent] · message" inside rail-name; the agent fragment keeps its
        // per-agent colour as the only identity cue (replacing the old dot).
        const namePrefix = showWho && t.agent
          ? `<span style="color:${agentColor(t.agent)}">${escapeHtml(fmtAgent(t.agent))}</span> · `
          : "";
        // Live: the latest meaningful event. Frozen: outcome + duration —
        // the done summary stays available in the tooltip.
        const tail = t.status === "live"
          ? liveTail(t)
          : `${t.status} · ${fmtDuration((t.endedAt ?? t.lastTs) - t.startedAt)}`;

        const cmds = t.events.filter((e) => e.kind === "run").length;
        const files = new Set(
          t.events.filter((e) => e.kind === "write").map((e) => e.label),
        ).size;
        const metaParts = [escapeHtml(t.tag)];
        if (cmds > 0) metaParts.push(`${cmds} cmd${cmds === 1 ? "" : "s"}`);
        if (files > 0) metaParts.push(`${files} file${files === 1 ? "" : "s"}`);
        if (t.readFiles.size > 0) metaParts.push(`${t.readFiles.size} read`);
        let meta = metaParts.join(" · ");
        if (t.tokens > 0) meta += ` · <span class="rail-num">${fmtTokens(t.tokens)} tok</span>`;

        const isOpen = expanded.has(t.id);
        const foldable = t.events.length > 0;
        const eventsHtml = isOpen && foldable
          ? `<div class="activity-turn-events">${
              t.eventsDropped
                ? `<div class="activity-ev activity-ev-dropped">earlier events dropped</div>`
                : ""
            }${t.events
              .map(
                (e) => `
                <div class="activity-ev" data-kind="${e.kind}">
                  <span class="activity-ev-label">${escapeHtml(e.label)}</span>
                  <span class="activity-ev-when">${fmtTime(e.ts)}</span>
                </div>`,
              )
              .join("")}</div>`
          : "";

        const tipTail = t.events.length > 0 ? liveTail(t) : tail;
        return `
          <div class="rail-row activity-turn${isOpen ? " is-expanded" : ""}${foldable ? " is-foldable" : ""}" data-spine="${spineForTurn(t)}" data-row-id="${escapeHtml(t.id)}" data-tip-message="${escapeHtml(tipTail)}" data-tip-tag="${escapeHtml(t.tag)}" tabindex="0">
            <div class="rail-row-line">
              <span class="activity-chev">${Icons.chevronRight({ size: 11 })}</span>
              <span class="rail-name">${namePrefix}${escapeHtml(tail)}</span>
              <span class="rail-when">${fmtTime(t.lastTs)}</span>
            </div>
            <div class="rail-meta">${meta}</div>
            ${eventsHtml}
          </div>`;
      })
      .join("");

    streamEl.querySelectorAll<HTMLElement>(".rail-row").forEach((row) => {
      attachTooltip(row, {
        title: row.dataset.tipMessage ?? "",
        meta: row.dataset.tipTag ?? "",
      });
      row.addEventListener("click", () => {
        const id = row.dataset.rowId;
        if (!id || !row.classList.contains("is-foldable")) return;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        render();
      });
    });
    restoreStreamScrollAnchor(scrollAnchor);
  }

  // Always-on: the host's visibility is now controlled by CSS via
  // body.sidebar-view-activity, not by the backend's inline-mode signal.
  host.hidden = false;

  clearBtn.addEventListener("click", () => {
    agg.clear();
    expanded.clear();
    render();
  });

  const onNotchState = (ev: { payload: StatePayload }): void => {
    const sid = ev.payload.session;
    const tab = ev.payload.tab_label ?? `session ${sid.slice(0, 6)}`;
    const agent = ev.payload.agent ?? null;
    phases.set(sid, { tab, agent, phase: ev.payload.phase });
    agg.push(
      {
        session: sid,
        tag: tab,
        agent,
        phase: ev.payload.phase,
        tokens: ev.payload.tokens_delta ?? 0,
      },
      Date.now(),
    );
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
