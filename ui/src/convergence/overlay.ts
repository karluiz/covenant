import {
  acpRespondPermission,
  getConvergenceSnapshot,
  operatorList,
  setOperatorEnabled,
  submitConvergenceReply,
  writeToSession,
  type AttentionItem,
  type ConvergenceSnapshot,
} from "../api";
import type { AgentCard, SessionId } from "../api";
import { Icons } from "../icons";
import { formatChord } from "../platform";
import { agoLabel } from "./attention";
import { groupFindings } from "./findings";
import { renderGroupBand, renderGroupDetail, type GroupView } from "./group";
import { attentionIndex, groupAgents, sortAgents } from "./model";
import { elapsedLabel, renderAgentRow, renderDetailPane, type ReplyScope } from "./tile";

export interface TabMeta {
  sessionId: string;
  title: string;
  color: string | null;
  /// Tab-group display name. Null = ungrouped.
  group: string | null;
  /// Rail bucket key + the key supervision and findings are stored under.
  groupId?: string | null;
  /// Supervisor attached to this session's group, if any.
  supervisor?: { operatorId: string; intervene: boolean } | null;
}

export interface ConvergenceTabBridge {
  listTabs(): TabMeta[];
  activateBySessionId(sessionId: string, opts?: { keepOverlayOpen?: boolean }): boolean;
  /// Group supervision controls. Optional — a bridge without them just
  /// renders the group detail read-only.
  setGroupSupervisor?(groupId: string, operatorId: string | null): void;
  setGroupIntervene?(groupId: string, intervene: boolean): void;
}

type Filter = "all" | "needs you" | "working" | "idle";
const POLL_MS = 1000;

export class ConvergenceOverlay {
  private root: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private railEl: HTMLElement | null = null;
  private detailHostEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private empty: HTMLElement | null = null;
  private reconnectEl: HTMLElement | null = null;
  private pollHandle: number | null = null;
  private visible = false;
  private escHandler: ((e: KeyboardEvent) => void) | null = null;
  private snap: ConvergenceSnapshot | null = null; // last-good
  private filter: Filter = "all";
  private activeSessionId: string | null = null;
  /// Non-null → the detail pane shows this GROUP instead of an agent.
  /// Cleared by any explicit navigation to an agent row.
  private activeGroupId: string | null = null;
  /// session_id → group id, refreshed with each poll's hints.
  private groupBySession: Map<string, string | null> = new Map();
  /// group id → name + attached supervisor, from the same hints.
  private groupMeta: Map<string, { name: string; supervisor: { operatorId: string; intervene: boolean } | null }> =
    new Map();
  /// operator id → {name, avatar}. Fetched once per open — operators
  /// don't get renamed mid-session often enough to poll for it.
  private operatorNames: Map<string, { name: string; avatar: string }> = new Map();
  /// Serialized render inputs of the last rail/pane build. A 1s poll
  /// with identical data must NOT rebuild the DOM — replacing a button
  /// under the cursor restarts :hover and reads as flicker. Time-derived
  /// labels (ages) tick in place instead.
  private lastRailKey = "";
  private lastDetailKey = "";

  constructor(private bridge: ConvergenceTabBridge) {}

  isVisible(): boolean { return this.visible; }
  toggle(): void { if (this.visible) this.close(); else this.open(); }

  open(): void {
    if (this.visible) return;
    this.mount();
    this.visible = true;
    void this.loadOperatorNames();
    void this.refresh();
    this.pollHandle = window.setInterval(() => void this.refresh(), POLL_MS);
  }

  /// Resolve supervisor ids to names/avatars. Failure is non-fatal — the
  /// band falls back to the generic "supervisor" label.
  private async loadOperatorNames(): Promise<void> {
    try {
      const ops = await operatorList();
      this.operatorNames = new Map(ops.map((o) => [o.id, { name: o.name, avatar: o.emoji }]));
      if (this.visible && this.snap) { this.lastRailKey = ""; this.render(); }
    } catch (err) {
      console.warn("[convergence] operator list failed", err);
    }
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    if (this.pollHandle !== null) { window.clearInterval(this.pollHandle); this.pollHandle = null; }
    if (this.escHandler !== null) {
      document.removeEventListener("keydown", this.escHandler, { capture: true });
      this.escHandler = null;
    }
    this.root?.remove();
    this.root = this.bodyEl = this.railEl = this.detailHostEl = this.summaryEl = this.empty = this.reconnectEl = null;
    this.snap = null;
    this.lastRailKey = "";
    this.lastDetailKey = "";
    this.filter = "all";
    this.activeSessionId = null;
    this.activeGroupId = null;
  }

  private mount(): void {
    const root = document.createElement("div");
    root.className = "convergence-overlay";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Convergence Mode");

    const header = document.createElement("div");
    header.className = "convergence-overlay__header";
    const title = document.createElement("h1");
    title.className = "convergence-overlay__title";
    title.textContent = "CONVERGENCE";
    const exit = document.createElement("button");
    exit.type = "button";
    exit.className = "release-close";
    exit.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    exit.setAttribute("aria-label", "Exit Convergence Mode");
    exit.addEventListener("click", () => this.close());
    header.append(title, exit);

    const strip = document.createElement("div");
    strip.className = "mc-strip";
    const summary = document.createElement("div");
    summary.className = "mc-strip__summary";
    const reconnect = document.createElement("span");
    reconnect.className = "mc-reconnecting";
    reconnect.textContent = "reconnecting…";
    reconnect.hidden = true;
    const filters = document.createElement("div");
    filters.className = "mc-strip__filters";
    for (const f of ["all", "needs you", "working", "idle"] as const) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "mc-fchip" + (this.filter === f ? " mc-fchip--on" : "");
      chip.textContent = f;
      chip.dataset.filter = f;
      chip.addEventListener("click", () => { this.filter = f; this.render(); });
      filters.append(chip);
    }
    strip.append(summary, reconnect, filters);

    const body = document.createElement("div");
    body.className = "mc-body";
    const rail = document.createElement("div");
    rail.className = "mc-rail";
    const detailHost = document.createElement("div");
    detailHost.className = "mc-detail-host";
    body.append(rail, detailHost);

    const empty = document.createElement("div");
    empty.className = "convergence-overlay__empty";
    empty.hidden = true;
    empty.innerHTML = `
      <div class="convergence-overlay__empty-icon">${Icons.link2({ size: 56 })}</div>
      <div class="convergence-overlay__empty-title">No agents running</div>
      <div class="convergence-overlay__empty-body">
        Convergence shows every agent across your tabs.<br/>
        Run an executor in any terminal (claude, codex, …) or open an ACP chat — it appears here automatically.
      </div>
      <kbd class="convergence-overlay__empty-hint">${formatChord(["mod", "shift", "M"])} to toggle convergence</kbd>`;

    root.append(header, strip, body, empty);
    document.body.append(root);

    this.root = root;
    this.bodyEl = body;
    this.railEl = rail;
    this.detailHostEl = detailHost;
    this.summaryEl = summary;
    this.empty = empty;
    this.reconnectEl = reconnect;

    this.escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest(".mc-reply")) { e.preventDefault(); e.stopPropagation(); active.blur(); return; }
        e.preventDefault(); e.stopPropagation(); this.close(); return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const active = document.activeElement as HTMLElement | null;
        if (active?.tagName === "TEXTAREA" && (active as HTMLTextAreaElement).value.length > 0) return;
        e.preventDefault();
        this.moveActive(e.key === "ArrowDown" ? 1 : -1);
      }
      if (e.key === "Enter" && this.activeSessionId) {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest(".mc-reply") || active?.closest("button, input, select, textarea")) return;
        this.bridge.activateBySessionId(this.activeSessionId);
        this.close();
      }
      if (e.key >= "1" && e.key <= "9" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest("textarea, input, select")) return;
        const target = this.visibleAgents()[Number(e.key) - 1];
        if (!target) return;
        e.preventDefault();
        this.navigateTo(target.session_id);
      }
    };
    document.addEventListener("keydown", this.escHandler, { capture: true });
  }

  /// Test seam — drives one refresh and resolves when render is done.
  refreshForTest(): Promise<void> { return this.refresh(); }

  private async refresh(): Promise<void> {
    if (!this.visible) return;
    const hints = this.bridge.listTabs();
    // Bucket by group ID (two groups may share a name); the name is the
    // bucket's label. A hint without an id falls back to its name so a
    // bridge that only knows names still groups.
    this.groupBySession = new Map(hints.map((t) => [t.sessionId, t.groupId ?? t.group]));
    this.groupMeta = new Map(
      hints
        .filter((t) => (t.groupId ?? t.group) !== null)
        .map((t) => [
          (t.groupId ?? t.group) as string,
          { name: t.group ?? "group", supervisor: t.supervisor ?? null },
        ]),
    );
    // Backend hint shape is exactly {session_id, title, color} — group
    // is a UI-side concern and never crosses the wire.
    const tabs = hints.map((t) => ({
      session_id: t.sessionId, title: t.title, color: t.color,
    }));
    try {
      const next = await getConvergenceSnapshot(tabs);
      if (!this.visible) return; // close() raced during the await — discard
      this.snap = next;
      if (this.reconnectEl) this.reconnectEl.hidden = true;
    } catch (err) {
      console.warn("convergence snapshot failed", err);
      if (this.reconnectEl) this.reconnectEl.hidden = false;
      if (!this.snap) this.renderEmptyError();
      return;
    }
    this.render();
  }

  /// Rail buckets, group-aware. The flat rail order (keys 1–9, ↑↓,
  /// triage advance) is exactly this flattened — visual and logical
  /// order must never diverge.
  private groupedVisible() {
    if (!this.snap) return [];
    const flat = sortAgents(this.snap.agents, this.snap.attention).filter((card) => {
      switch (this.filter) {
        case "all": return true;
        case "needs you": return card.status === "blocked";
        case "working": return card.status === "working";
        case "idle": return card.status === "idle";
      }
    });
    return groupAgents(flat, (sid) => this.groupBySession.get(sid) ?? null);
  }

  private visibleAgents() {
    return this.groupedVisible().flatMap((g) => g.cards);
  }

  private render(): void {
    if (!this.bodyEl || !this.railEl || !this.detailHostEl || !this.empty || !this.summaryEl || !this.snap) return;
    const agents = this.snap.agents;
    const attention = this.snap.attention;
    if (agents.length === 0 && attention.length === 0) {
      this.railEl.replaceChildren();
      this.detailHostEl.replaceChildren();
      this.bodyEl.hidden = true;
      this.empty.hidden = false;
      this.summaryEl.textContent = "";
      this.lastRailKey = "";
      this.lastDetailKey = "";
      return;
    }
    this.empty.hidden = true;
    this.bodyEl.hidden = false;

    const working = agents.filter((a) => a.status === "working").length;
    const idle = agents.filter((a) => a.status === "idle").length;
    const cost = agents.reduce((acc, a) => acc + (a.cost_usd ?? 0), 0);
    const supervised = [...this.groupMeta.values()].filter((g) => g.supervisor).length;
    this.summaryEl.innerHTML =
      `<b>${agents.length}</b> agents · ` +
      (attention.length ? `<b class="mc-strip__alert">${attention.length} needs you</b> · ` : "") +
      `${working} working · ${idle} idle` +
      (cost >= 0.005 ? ` · <b>$${cost.toFixed(2)}</b>` : "") +
      (supervised ? ` · <b class="mc-strip__sup">${supervised} supervised</b>` : "");

    this.root?.querySelectorAll<HTMLElement>(".mc-fchip").forEach((c) => {
      c.classList.toggle("mc-fchip--on", c.dataset.filter === this.filter);
    });

    const at = attentionIndex(this.snap.attention);
    const grouped = this.groupedVisible();
    const list = grouped.flatMap((g) => g.cards);
    if (!this.activeSessionId || !list.some((a) => a.session_id === this.activeSessionId)) {
      this.activeSessionId = list[0]?.session_id ?? null;
    }
    // A group that stops existing (last tab closed, filter hid it) must
    // not leave the pane stuck on a dead group.
    if (this.activeGroupId && !grouped.some((b) => b.key === this.activeGroupId)) {
      this.activeGroupId = null;
    }
    // Skip the rebuild when nothing the rows *display* changed — only
    // tick the time labels in place (see lastRailKey).
    const railKey = JSON.stringify({
      f: this.filter,
      sel: this.activeSessionId,
      gsel: this.activeGroupId,
      g: grouped.map((b) => [
        b.key,
        this.groupMeta.get(b.key ?? "")?.name ?? null,
        this.groupMeta.get(b.key ?? "")?.supervisor ?? null,
        b.key ? groupFindings(b.key).length : 0,
        b.cards.map((c) => [
          c.session_id, c.status, c.executor, c.operator_name,
          c.phase_label, c.last_command, c.last_output_line, c.cwd,
        ]),
      ]),
    });
    if (railKey === this.lastRailKey && this.railEl.childElementCount > 0) {
      this.tickRailAges(list, at);
      this.renderDetail(at);
      return;
    }
    this.lastRailKey = railKey;

    this.railEl.replaceChildren();
    if (list.length === 0) {
      const none = document.createElement("div");
      none.className = "mc-rail__empty";
      none.innerHTML = `No agents match <code>${this.filter}</code>. <button type="button" class="mc-rail__reset">Show all</button>`;
      none.querySelector(".mc-rail__reset")?.addEventListener("click", () => { this.filter = "all"; this.render(); });
      this.railEl.append(none);
    }

    // Bands when tabs span groups — or, whatever the shape, when the
    // group is supervised: "who is watching this" is the one thing worth
    // a header even in a single-bucket rail.
    const spansGroups = grouped.length > 1;
    for (const bucket of grouped) {
      const view = bucket.key ? this.groupView(bucket.key, bucket.cards) : null;
      if (view && (spansGroups || view.supervisor)) {
        this.railEl.append(
          renderGroupBand(view, view.id === this.activeGroupId, this.groupCallbacks()),
        );
      }
      for (const card of bucket.cards) {
        const item = at.get(card.session_id);
        // Blocked rows show how long they've been waiting on the human;
        // everything else shows session uptime (Ulid-decoded start).
        const age =
          item?.since_unix_ms != null && item.since_unix_ms > 0
            ? agoLabel(item.since_unix_ms)
            : card.started_at_unix_ms != null
              ? elapsedLabel(card.started_at_unix_ms)
              : null;
        this.railEl.append(
          renderAgentRow(card, {
            selected: card.session_id === this.activeSessionId,
            age,
          }, {
            onSelect: (sid) => this.navigateTo(sid),
            onFocus: (sid) => { if (this.bridge.activateBySessionId(sid)) this.close(); },
          }),
        );
      }
    }
    this.renderDetail(at);
  }

  /// A focused composer means the human is mid-draft — a 1s poll must
  /// not replace the textarea under their fingers. Checked BEFORE the
  /// card lookup: if the active session drops out of the filtered list
  /// (or off "blocked") while the draft is focused, there's no matching
  /// card this render, but the last-rendered pane must still survive.
  private renderDetail(at: Map<string, AttentionItem>): void {
    const host = this.detailHostEl;
    if (!host || !this.snap) return;
    const active = document.activeElement;
    if (active?.tagName === "TEXTAREA" && host.contains(active)) return;
    if (this.activeGroupId) { this.renderGroupPane(this.activeGroupId); return; }
    const card = this.snap.agents.find((a) => a.session_id === this.activeSessionId);
    if (!card) { host.replaceChildren(); this.lastDetailKey = ""; return; }
    // Identical data → keep the DOM (hover survives); tick ages only.
    const detailKey = JSON.stringify([card, at.get(card.session_id) ?? null]);
    if (detailKey === this.lastDetailKey && host.childElementCount > 0) {
      this.tickDetailAges(card);
      return;
    }
    this.lastDetailKey = detailKey;
    const scroll = host.scrollTop;
    host.replaceChildren(
      renderDetailPane(card, at.get(card.session_id) ?? null, {
        onFocus: (sid, keepOpen) => {
          const ok = this.bridge.activateBySessionId(sid, { keepOverlayOpen: keepOpen });
          if (ok && !keepOpen) this.close();
        },
        onStop: this.stopOperator.bind(this),
        onOperatorReply: async (sid, text, scope) => {
          await this.submitReply(sid, text, scope);
          this.advanceAfterAnswer(sid);
        },
        onPermission: (sid, key, opt) => {
          void acpRespondPermission(sid as SessionId, key, opt).catch((err) =>
            console.warn("[convergence] respond permission failed", sid, err),
          );
          this.advanceAfterAnswer(sid);
          void this.refresh();
        },
        onPtyReply: (sid, text) => {
          void writeToSession(sid as SessionId, new TextEncoder().encode(text + "\r")).catch(
            (err) => console.warn("[convergence] pty reply failed", sid, err),
          );
          this.advanceAfterAnswer(sid);
          void this.refresh();
        },
      }),
    );
    host.scrollTop = scroll;
  }

  /// Assemble a bucket's group view: label + supervisor (name resolved
  /// through the operator list) + roll-up + retained findings.
  private groupView(groupId: string, cards: AgentCard[]): GroupView {
    const meta = this.groupMeta.get(groupId);
    const sup = meta?.supervisor ?? null;
    const op = sup ? this.operatorNames.get(sup.operatorId) : undefined;
    return {
      id: groupId,
      name: meta?.name ?? groupId,
      supervisor: sup
        ? {
            operatorId: sup.operatorId,
            name: op?.name ?? "supervisor",
            avatar: op?.avatar ?? "👤",
            intervene: sup.intervene,
          }
        : null,
      tabs: cards.length,
      blocked: cards.filter((c) => c.status === "blocked").length,
      costUsd: cards.reduce((acc, c) => acc + (c.cost_usd ?? 0), 0),
      findings: groupFindings(groupId),
      firstSessionId: cards[0]?.session_id ?? null,
    };
  }

  private groupCallbacks() {
    return {
      onSelect: (gid: string) => this.navigateToGroup(gid),
      onOpen: (sid: string) => { if (this.bridge.activateBySessionId(sid)) this.close(); },
      onDetach: (gid: string) => {
        this.bridge.setGroupSupervisor?.(gid, null);
        this.lastRailKey = "";
        void this.refresh();
      },
      onToggleIntervene: (gid: string, next: boolean) => {
        this.bridge.setGroupIntervene?.(gid, next);
        this.lastRailKey = "";
        void this.refresh();
      },
    };
  }

  /// The group branch of the detail host. Same rebuild-avoidance contract
  /// as `renderDetail`: identical data keeps the DOM (hover survives).
  private renderGroupPane(groupId: string): void {
    const host = this.detailHostEl;
    if (!host) return;
    const cards = this.groupedVisible().find((b) => b.key === groupId)?.cards ?? [];
    const view = this.groupView(groupId, cards);
    const key = JSON.stringify(["group", view]);
    if (key === this.lastDetailKey && host.childElementCount > 0) {
      // Same data, older clock — tick the finding ages in place.
      host.querySelectorAll<HTMLElement>(".mc-gdetail__find time").forEach((el, i) => {
        const f = view.findings[i];
        if (f) el.textContent = agoLabel(f.atUnixMs);
      });
      return;
    }
    this.lastDetailKey = key;
    const scroll = host.scrollTop;
    host.replaceChildren(renderGroupDetail(view, this.groupCallbacks()));
    host.scrollTop = scroll;
  }

  private renderEmptyError(): void {
    if (!this.railEl || !this.detailHostEl || !this.empty || !this.summaryEl) return;
    this.empty.hidden = true;
    if (this.bodyEl) this.bodyEl.hidden = false;
    this.summaryEl.textContent = "";
    this.lastRailKey = "";
    this.lastDetailKey = "";
    this.railEl.replaceChildren();
    this.detailHostEl.replaceChildren();
    const err = document.createElement("div");
    err.className = "mc-rail__empty";
    err.innerHTML = `Couldn't load agent status. <button type="button" class="mc-rail__reset">Retry</button>`;
    err.querySelector(".mc-rail__reset")?.addEventListener("click", () => void this.refresh());
    this.railEl.append(err);
  }

  private moveActive(delta: number): void {
    const list = this.visibleAgents();
    if (list.length === 0) return;
    const idx = list.findIndex((a) => a.session_id === this.activeSessionId);
    const next = (idx === -1 ? 0 : idx + delta + list.length) % list.length;
    this.navigateTo(list[next].session_id);
  }

  /// In-place tick of the rail's time labels when a rebuild is skipped.
  private tickRailAges(list: AgentCard[], at: Map<string, AttentionItem>): void {
    if (!this.railEl) return;
    for (const card of list) {
      const el = this.railEl.querySelector<HTMLElement>(
        `.mc-row[data-session-id="${card.session_id}"] .mc-row__age`,
      );
      if (!el) continue;
      const item = at.get(card.session_id);
      el.textContent =
        item?.since_unix_ms != null && item.since_unix_ms > 0
          ? agoLabel(item.since_unix_ms)
          : card.started_at_unix_ms != null
            ? elapsedLabel(card.started_at_unix_ms)
            : "";
    }
  }

  /// In-place tick of subagent elapsed labels when a rebuild is skipped.
  private tickDetailAges(card: AgentCard): void {
    const ages = this.detailHostEl?.querySelectorAll<HTMLElement>(".mc-subrow__age");
    if (!ages) return;
    card.subagents.forEach((r, i) => {
      const el = ages[i];
      if (el) el.textContent = r.running ? elapsedLabel(r.started_unix_ms) : "done";
    });
  }

  /// Explicit navigation to a session — overrides the draft-guard
  /// (clicks/keys don't blur a focused textarea in the app's webview).
  /// Poll-triggered renders never go through here, so the draft-survival
  /// path is untouched.
  private navigateTo(sid: string): void {
    if (sid !== this.activeSessionId || this.activeGroupId) this.blurComposerIfFocused();
    this.activeSessionId = sid;
    this.activeGroupId = null;
    this.render();
  }

  /// Select a group band. ponytail: bands are pointer/Tab targets only —
  /// ↑↓ and 1–9 stay a pure agent triage ring, so answering a queue never
  /// lands you on a header.
  private navigateToGroup(gid: string): void {
    this.blurComposerIfFocused();
    this.activeGroupId = gid;
    this.render();
  }

  /// Chained triage: after answering a blocked session, jump to the next
  /// blocked one (rail order, wrapping) instead of idling on the answered
  /// pane. No-op when nothing else is blocked.
  private advanceAfterAnswer(from: string): void {
    const list = this.visibleAgents();
    const idx = list.findIndex((a) => a.session_id === from);
    const isNextBlocked = (a: AgentCard) => a.status === "blocked" && a.session_id !== from;
    const next = list.slice(idx + 1).find(isNextBlocked) ?? list.find(isNextBlocked);
    if (next) this.navigateTo(next.session_id);
  }

  /// Blur a focused textarea inside the detail host, if any. Called only
  /// when explicit navigation is about to change `activeSessionId` — the
  /// draft-guard in `renderDetail` must not survive an intentional row
  /// change, only a background poll tick.
  private blurComposerIfFocused(): void {
    const host = this.detailHostEl;
    if (!host) return;
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && host.contains(active)) {
      active.blur();
    }
  }

  /// Disable the operator on this session. Fire-and-forget; the next 1s
  /// poll re-renders the card without its operator badge (the card stays —
  /// it's still an agent session).
  private stopOperator(sessionId: string): void {
    void setOperatorEnabled(sessionId as SessionId, false).catch((err) =>
      console.warn("[convergence] stopOperator failed", sessionId, err),
    );
    void this.refresh();
  }

  async submitReply(sessionId: string, text: string, scope: ReplyScope): Promise<void> {
    try {
      await submitConvergenceReply(sessionId, text, scope);
    } catch (err) {
      console.warn("[convergence] submitReply failed", err);
    }
  }
}
