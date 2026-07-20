// Canon Context Crawler — immersive full-screen view. Setup gate → live
// repo survey → 3-zone curation (activity / inventory / live preview) →
// write the selected units into `.covenant/canon/`. The reducer in
// `./state` owns all the logic; this module is DOM plumbing on top of it.
//
// The inventory is the point: one row per candidate context unit, each
// carrying the state Canon already holds it in (new / in canon / changed /
// detected). Only `new` rows arrive pre-selected — a `changed` row is an
// overwrite the user has to opt into.
//
// Opaque full-screen overlay by design — see miner.css header comment for
// the vibrancy-bleed gotcha this avoids.

import "./miner.css";
import { Icons } from "../../icons";
import { attachTooltip } from "../../tooltip/tooltip";
import { startSky } from "../../spec-chat/entrance";
import { pushInfoToast } from "../../notifications/toast";
import { iconButton } from "../panel";
import {
  canonAdopt,
  canonCompileUnits,
  canonInventoryStates,
  canonMineStart,
  canonMineStop,
  subscribeMinerEvents,
  type CanonPkgKind,
  type MinerEvent,
} from "../../api";
import {
  applyStates,
  compilePreview,
  createMinerState,
  editFindingBody,
  isSelectable,
  KIND_LABELS,
  KIND_ORDER,
  markUnitsUnknown,
  pendingUnits,
  reduceMinerEvent,
  selectedUnits,
  setFindingStatus,
  setUnitKind,
  setUnitSelected,
  STATE_LABELS,
  unitTarget,
  type FindingCard,
  type MinerState,
  type UnitRow,
} from "./state";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface ContextMinerOpts {
  repoRoot: string;
  groupName: string | null;
}

/** Crawler kind → the `CanonPkgKind` `canon_adopt` speaks. The crawler and
 *  Canon disagree on one word only (`subagent` vs `agent`); everything else
 *  is identity. Kinds absent here (memory) are not adoptable — nothing
 *  detects them, since no executor dir holds memory. */
const ADOPT_KIND: Record<string, CanonPkgKind> = {
  subagent: "agent",
  skill: "skill",
  command: "command",
  mcp: "mcp",
  context: "context",
};

function shortArg(arg: string): string {
  const trimmed = arg.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 45)}…` : trimmed;
}

/** Kind groups in KIND_ORDER, then anything else the backend surfaced
 *  (detected `mcp` rows are the live case — they are outside KIND_ORDER
 *  because the crawler never proposes one, but detection finds them). */
export function inventoryKinds(units: UnitRow[]): string[] {
  const extra = units
    .map((u) => u.kind)
    .filter((k, i, all) => !KIND_ORDER.includes(k as (typeof KIND_ORDER)[number]) && all.indexOf(k) === i);
  return [...KIND_ORDER, ...extra];
}

/** Why this row is in the state it is — the badge's tooltip. */
export function stateHint(u: UnitRow): string {
  switch (u.state) {
    case "new":
      return `Not in Canon yet — will be created at ${unitTarget(u.kind, u.slug)}`;
    case "exists":
      return `Already in Canon, unchanged — check it to rewrite ${unitTarget(u.kind, u.slug)}`;
    case "changed":
      return `Already in Canon with different content — checking this OVERWRITES ${unitTarget(u.kind, u.slug)}`;
    case "detected":
      return u.detectedIn
        ? `Foreign item in ${u.detectedIn}, no Canon source`
        : "Foreign item, no Canon source";
    case "unknown":
      // Two paths land here: a unit with nothing accepted yet (never sent for
      // resolution) and a resolution that failed outright. Both mean the same
      // thing to the user, so the hint covers both.
      return "This unit's destination was never verified against Canon, so it cannot be written. Accept a finding to resolve it — or restart the crawl if the check itself failed.";
  }
}

/** Rows a write would clobber: checked, already present in Canon, and
 *  actually reaching the write payload.
 *
 *  The intersection is by `u.name` across kinds, and that is safe ONLY
 *  because the backend rejects a same-name-different-kind unit outright —
 *  note the asymmetry it rides on: `reduceMinerEvent`'s dedupe keys on slug
 *  ALONE (a finding addresses its unit by name, so the frontend index must
 *  match the backend's), while `applyStates` keys on kind + slug (because
 *  `memory/x.md` and `skills/x/` are genuinely different files). Both are
 *  correct. If a same-name pair across kinds ever becomes supported, this
 *  name-only match silently mis-attributes and must become id-keyed. */
export function overwriteTargets(state: MinerState): UnitRow[] {
  const readyNames = new Set(selectedUnits(state).map((u) => u.name));
  return state.units.filter(
    (u) => isSelectable(u) && u.selected && u.state !== "new" && readyNames.has(u.name),
  );
}

export class ContextMinerView {
  private root: HTMLElement;
  private headEl: HTMLElement;
  private bodyEl: HTMLElement;

  private state: MinerState = createMinerState();
  private runId: string | null = null;
  private unlisten: UnlistenFn | null = null;

  private focus = "";
  private thorough = false;

  /** True while `canonCompileUnits` is in flight. `renderFooter` rebuilds the
   *  footer from scratch on every `renderInventory()`, so disabling the button
   *  imperatively is not enough — an in-flight `resolveStates` resolving
   *  mid-write would hand back a fresh, ENABLED button and buy a second write
   *  over a selection `applyStates` may have just mutated. */
  private writing = false;

  /** Set by `destroy()`. `start()` checks it after every `await`: a teardown
   *  landing inside those windows must not leave a listener attached to a
   *  detached view, nor a backend crawl running with nothing able to stop it. */
  private destroyed = false;

  /** Monotonic token for `resolveStates`. Rows are re-resolvable while the
   *  crawl runs, so two checks can be in flight; only the newest may land. */
  private resolveToken = 0;

  /** Unit ids whose findings are expanded. Survives re-renders. */
  private expanded = new Set<string>();

  /** Pending `scheduleResolve` timer. Lives in the view, not in `state.ts` —
   *  the reducer stays free of timers. */
  private curationTimer: number | null = null;

  // Crawl-view zone refs — set by showMining(), cleared by restart().
  private activityEl: HTMLElement | null = null;
  private activityListEl: HTMLElement | null = null;
  private cardsEl: HTMLElement | null = null;
  private previewPre: HTMLPreElement | null = null;
  private footerEl: HTMLElement | null = null;
  /** Teardown for the setup-phase constellation sky (see startSky). */
  private skyTeardown: (() => void) | null = null;

  private readonly onKeyDown = (e: KeyboardEvent): void => this.handleKeyDown(e);

  /** Stop the constellation sky if running (rAF + ResizeObserver). */
  private stopSky(): void {
    this.skyTeardown?.();
    this.skyTeardown = null;
  }

  /** Clear the body for a new phase — always tears the sky down first so its
   *  rAF loop doesn't leak when the setup DOM is replaced. */
  private clearBody(): void {
    this.stopSky();
    this.bodyEl.innerHTML = "";
  }

  constructor(private opts: ContextMinerOpts) {
    this.root = document.createElement("div");
    this.root.className = "canon-miner";

    this.headEl = document.createElement("div");
    this.headEl.className = "canon-miner-head";

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "canon-miner-body";

    this.root.append(this.headEl, this.bodyEl);
    document.body.appendChild(this.root);
    document.addEventListener("keydown", this.onKeyDown);

    this.refreshHead();
    this.showSetup();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopSky();
    this.cancelScheduledResolve();
    document.removeEventListener("keydown", this.onKeyDown);
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    if (this.runId && !this.state.done) {
      void canonMineStop(this.runId).catch(() => { /* best-effort on teardown */ });
    }
    this.root.remove();
  }

  // ── Keyboard ─────────────────────────────────────────────────────────

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.destroy();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target;
    if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.isContentEditable)) {
      return;
    }
    const key = e.key.toLowerCase();
    if (key === "a") this.acceptNewestPending();
    else if (key === "d") this.discardNewestPending();
  }

  private allFindings(): FindingCard[] {
    return this.state.units.flatMap((u) => u.findings);
  }

  /** `a` / `d` act on the newest pending finding, wherever it sits — the
   *  owning unit is auto-expanded so the keystroke's effect is visible. */
  private resolveNewestPending(status: "accepted" | "discarded"): void {
    if (!this.canCurate()) return; // same rule as the rows: curate after the crawl
    const owner = [...this.state.units]
      .reverse()
      .find((u) => u.findings.some((f) => f.status === "pending"));
    if (!owner) return;
    const pending = owner.findings.filter((f) => f.status === "pending");
    const target = pending[pending.length - 1];
    if (!target) return;
    setFindingStatus(this.state, target.id, status);
    this.expanded.add(owner.id);
    this.renderInventory();
    this.scheduleResolve();
  }

  private acceptNewestPending(): void {
    this.resolveNewestPending("accepted");
  }

  private discardNewestPending(): void {
    this.resolveNewestPending("discarded");
  }

  // ── Header ───────────────────────────────────────────────────────────

  private refreshHead(): void {
    this.headEl.innerHTML = "";

    const brand = document.createElement("div");
    brand.className = "canon-miner-brand";
    brand.textContent = "Context Crawler";
    this.headEl.appendChild(brand);

    if (this.runId) {
      const dot = document.createElement("span");
      dot.className = "canon-miner-dot";
      if (this.state.done) dot.classList.add(this.state.stopped ? "is-stopped" : "is-done");
      this.headEl.appendChild(dot);
      // Second line is the focus when the user narrowed the survey; a
      // whole-repo crawl has nothing to say here, so it says nothing.
      if (this.focus) {
        const name = document.createElement("span");
        name.className = "canon-miner-name";
        name.textContent = this.focus;
        this.headEl.appendChild(name);
      }
    }

    const spacer = document.createElement("div");
    spacer.className = "canon-miner-spacer";
    this.headEl.appendChild(spacer);

    if (this.runId && !this.state.done) {
      const stopBtn = document.createElement("button");
      stopBtn.className = "canon-miner-btn is-danger";
      stopBtn.innerHTML = `${Icons.square({ size: 12 })}<span>Stop</span>`;
      stopBtn.addEventListener("click", () => void this.stop(stopBtn));
      this.headEl.appendChild(stopBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "canon-miner-close";
    closeBtn.setAttribute("aria-label", "Close (Esc)");
    closeBtn.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    closeBtn.addEventListener("click", () => this.destroy());
    this.headEl.appendChild(closeBtn);
  }

  // ── Setup bar ────────────────────────────────────────────────────────

  private field(label: string, placeholder: string, initial: string): {
    wrap: HTMLElement;
    input: HTMLInputElement;
  } {
    const wrap = document.createElement("div");
    wrap.className = "canon-miner-field";
    const l = document.createElement("label");
    l.textContent = label;
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.value = initial;
    wrap.append(l, input);
    return { wrap, input };
  }

  private showSetup(): void {
    this.clearBody();

    const setup = document.createElement("div");
    setup.className = "canon-miner-setup";
    const card = document.createElement("div");
    card.className = "canon-miner-setup-card";

    const title = document.createElement("div");
    title.className = "canon-miner-setup-title";
    title.textContent = "Crawl this repository";

    const sub = document.createElement("div");
    sub.className = "canon-miner-setup-sub";
    sub.textContent = this.opts.groupName
      ? `${this.opts.groupName} · ${this.opts.repoRoot}`
      : this.opts.repoRoot;

    const note = document.createElement("p");
    note.className = "canon-miner-note";
    note.textContent = this.opts.groupName
      ? `Survey ${this.opts.groupName} for context Canon can hold. Everything found lands in an inventory you curate before anything is written.`
      : "Survey the repository for context Canon can hold. Everything found lands in an inventory you curate before anything is written.";

    const { wrap: focusWrap, input: focusInput } = this.field(
      "Focus (optional)",
      "leave empty to survey everything, or narrow it: 'the PTY layer'",
      this.focus,
    );
    focusInput.addEventListener("input", () => { this.focus = focusInput.value; });

    const thoroughRow = document.createElement("label");
    thoroughRow.className = "canon-miner-thorough";
    const thoroughCb = document.createElement("input");
    thoroughCb.type = "checkbox";
    thoroughCb.checked = this.thorough;
    thoroughCb.addEventListener("change", () => { this.thorough = thoroughCb.checked; });
    thoroughRow.append(thoroughCb, document.createTextNode("Thorough (deeper crawl, more tool calls)"));

    const errorEl = document.createElement("div");
    errorEl.className = "canon-miner-setup-error";

    const startBtn = document.createElement("button");
    startBtn.className = "canon-miner-btn is-primary canon-miner-start-btn";
    startBtn.innerHTML = `${Icons.play({ size: 13 })}<span>Start crawl</span>`;
    startBtn.addEventListener("click", () => {
      errorEl.textContent = "";
      void this.start(errorEl, startBtn);
    });

    // Staged rise choreography for the card contents (entrance).
    [title, sub, note, focusWrap, thoroughRow, startBtn].forEach((el, i) => {
      el.classList.add("canon-miner-rise");
      (el as HTMLElement).style.setProperty("--rise-delay", `${90 + i * 65}ms`);
    });
    card.append(title, sub, note, focusWrap, thoroughRow, errorEl, startBtn);

    // Constellation sky behind the card — the same particle field as the
    // Spec Creator's immersive entrance (reused via startSky).
    const sky = document.createElement("canvas");
    sky.className = "canon-miner-sky";
    setup.append(sky, card);
    this.bodyEl.appendChild(setup);

    requestAnimationFrame(() => {
      this.skyTeardown = startSky(sky);
      setup.classList.add("open");
      focusInput.focus();
    });
  }

  private async start(errorEl: HTMLElement, startBtn: HTMLButtonElement): Promise<void> {
    startBtn.disabled = true;
    try {
      const runId = await canonMineStart(this.opts.repoRoot, this.focus, this.thorough);
      // Escape between the call and its resolution means `destroy()` ran with
      // `this.runId` still null — its `canonMineStop` guard skipped and the
      // crawl would otherwise run on unreachable. Stop it here instead.
      if (this.destroyed) {
        void canonMineStop(runId).catch(() => { /* best-effort on teardown */ });
        return;
      }
      this.runId = runId;
      this.showMining();
      this.refreshHead();
      const unlisten = await subscribeMinerEvents(runId, (ev: MinerEvent) => {
        reduceMinerEvent(this.state, ev);
        this.applyEvent(ev);
      });
      // Same window, one await later: the subscribe resolved onto a view that
      // is already gone, so the listener would never be removed.
      if (this.destroyed) {
        unlisten();
        void canonMineStop(runId).catch(() => { /* best-effort on teardown */ });
        return;
      }
      this.unlisten = unlisten;
    } catch (e) {
      errorEl.textContent = String(e);
      startBtn.disabled = false;
    }
  }

  private async stop(stopBtn: HTMLButtonElement): Promise<void> {
    if (!this.runId || this.state.done) return;
    stopBtn.disabled = true;
    stopBtn.innerHTML = `${Icons.square({ size: 12 })}<span>Stopping…</span>`;
    try {
      await canonMineStop(this.runId);
    } catch {
      // best-effort — run_done still resolves the UI even if this call
      // never reached the backend (e.g. the run already finished).
    }
  }

  // ── Mining view (3-zone grid) ────────────────────────────────────────

  private showMining(): void {
    this.clearBody();

    const grid = document.createElement("div");
    grid.className = "canon-miner-grid";

    this.activityEl = document.createElement("div");
    this.activityEl.className = "canon-miner-activity";
    const actTitle = document.createElement("div");
    actTitle.className = "canon-miner-zone-title";
    actTitle.textContent = "Activity";
    this.activityListEl = document.createElement("div");
    this.activityEl.append(actTitle, this.activityListEl);

    this.cardsEl = document.createElement("div");
    this.cardsEl.className = "canon-miner-cards";

    this.previewPre = document.createElement("pre");
    const previewEl = document.createElement("div");
    previewEl.className = "canon-miner-preview";
    const prevTitle = document.createElement("div");
    prevTitle.className = "canon-miner-zone-title";
    prevTitle.textContent = "Preview";
    previewEl.append(prevTitle, this.previewPre);

    grid.append(this.activityEl, this.cardsEl, previewEl);

    this.footerEl = document.createElement("div");
    this.footerEl.className = "canon-miner-footer";

    this.bodyEl.append(grid, this.footerEl);

    this.renderInventory();
  }

  private applyEvent(ev: MinerEvent): void {
    switch (ev.kind) {
      case "tool_start":
        this.appendActivityRow(ev.id, ev.tool, ev.arg);
        break;
      case "tool_result":
        this.updateActivityRow(ev.id, ev.summary, ev.ok);
        break;
      case "unit_proposed":
      case "finding":
        // ponytail: the inventory re-renders WHOLE on every unit/finding
        // event rather than patching the one row that changed — every row
        // node is destroyed and rebuilt tens of times over a crawl. That is
        // affordable only because rows are inert until `done` (see
        // `canCurate`): nothing can hold focus, an open contenteditable, or a
        // text selection across a re-render, so there is no state to lose.
        // Scroll position is the one thing that does survive, restored
        // explicitly in `renderInventory`. Ceiling: this forecloses ever
        // making rows interactive mid-crawl, and gets janky in the hundreds
        // of units. Upgrade path: key rows by `u.id` and patch in place —
        // then the inertness gate can be lifted independently.
        this.renderInventory();
        break;
      case "run_done":
        void this.handleRunDone();
        break;
      case "error":
        this.appendErrorNote(ev.message);
        break;
      case "text_delta":
        // Narration text isn't surfaced in this view — activity rows and
        // inventory rows already carry the visible signal of progress.
        break;
    }
  }

  private async handleRunDone(): Promise<void> {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    this.refreshHead();
    // Resolve every unit against what Canon already holds, and fold in the
    // foreign items detected in the executor dirs. This is what stops a
    // second crawl of the same repo from proposing a duplicate set.
    await this.resolveStates(false);
    if (this.state.units.length === 0) this.showEmptyDone();
  }

  private cancelScheduledResolve(): void {
    if (this.curationTimer === null) return;
    window.clearTimeout(this.curationTimer);
    this.curationTimer = null;
  }

  /** Curation changes the bytes a unit would be written as — accepting a
   *  finding, discarding one, restoring one, editing a body. `pendingUnits`
   *  now sends exactly those bytes, so the badge every row carries is stale
   *  the instant any of that happens, and a stale badge is the whole safety
   *  model of this screen (writes are unconditional create-or-update with no
   *  confirm step).
   *
   *  Debounced because a curation pass is a burst — accept, accept, discard,
   *  edit — and each step would otherwise buy a round-trip. `resolveStates`
   *  owns the ordering (`resolveToken`); this only decides when to ask.
   *  `preserveSelection` keeps the user's checkboxes: re-resolving must not
   *  silently re-arm or disarm a row the user set by hand. */
  private scheduleResolve(): void {
    if (this.destroyed || this.writing || !this.state.done) return;
    this.cancelScheduledResolve();
    this.curationTimer = window.setTimeout(() => {
      this.curationTimer = null;
      // Re-check: the write button may have been pressed during the wait, and
      // a resolve landing mid-write would mutate the selection under it.
      if (this.destroyed || this.writing || !this.state.done) return;
      void this.resolveStates(true);
    }, 350);
  }

  /** Re-run the inventory check and re-apply it to the rows.
   *  `preserveSelection` keeps the user's checkboxes for rows that already
   *  existed — used after a kind re-route, where only the re-routed row
   *  should fall back to `applyStates`' honest default. `affected` names the
   *  rows whose badge this call is responsible for; on failure they drop to
   *  `unknown` rather than keep displaying a state nobody verified.
   *
   *  Concurrency: rows are re-resolvable while the crawl is live, so a chip
   *  clicked early can resolve AFTER `handleRunDone`'s full-run resolution and
   *  overwrite it with a result computed over a partial unit set. The token
   *  makes that impossible — only the newest request may land. */
  private async resolveStates(preserveSelection: boolean, affected?: string[]): Promise<void> {
    // A re-route resolve is meaningless mid-crawl: the unit set is still
    // growing, so the report would be partial. (Rows are non-interactive until
    // `done` anyway — this guard does not lean on that.)
    if (preserveSelection && !this.state.done) return;

    const token = ++this.resolveToken;
    const ids = affected
      ?? this.state.units.filter((u) => u.state !== "detected").map((u) => u.id);
    const before = new Map(this.state.units.map((u) => [u.id, u.selected]));
    try {
      const report = await canonInventoryStates(this.opts.repoRoot, pendingUnits(this.state));
      if (token !== this.resolveToken || this.destroyed) return;
      applyStates(this.state, report);
      if (preserveSelection) {
        for (const u of this.state.units) {
          // A re-routed row was re-keyed by setUnitKind, so its new id is
          // absent here and it keeps whatever applyStates just decided.
          const prev = before.get(u.id);
          if (prev !== undefined && isSelectable(u)) u.selected = prev;
        }
      }
    } catch (e) {
      if (token !== this.resolveToken || this.destroyed) return;
      // The badge would otherwise still read against the OLD kind's path —
      // "in canon" beside a target that was never checked. Say "unchecked"
      // and take the row out of the write path entirely.
      markUnitsUnknown(this.state, ids);
      this.state.error = String(e);
      this.appendErrorNote(String(e));
    }
    this.renderInventory();
  }

  // ── Activity zone ────────────────────────────────────────────────────

  private appendActivityRow(id: string, tool: string, arg: string): void {
    if (!this.activityEl || !this.activityListEl) return;
    const row = document.createElement("div");
    row.className = "canon-miner-activity-row";
    row.dataset.id = id;
    const line = document.createElement("div");
    line.className = "canon-miner-activity-line";
    const toolEl = document.createElement("span");
    toolEl.className = "canon-miner-activity-tool";
    toolEl.textContent = tool;
    const argEl = document.createElement("span");
    argEl.className = "canon-miner-activity-arg";
    argEl.textContent = shortArg(arg);
    attachTooltip(argEl, arg);
    line.append(toolEl, argEl);
    row.appendChild(line);
    this.activityListEl.appendChild(row);
    this.activityEl.scrollTop = this.activityEl.scrollHeight;
  }

  private updateActivityRow(id: string, summary: string, ok: boolean): void {
    if (!this.activityEl || !this.activityListEl) return;
    const row = this.activityListEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (!(row instanceof HTMLElement)) return;
    if (!ok) row.classList.add("is-fail");
    const summaryEl = document.createElement("div");
    summaryEl.className = "canon-miner-activity-summary";
    summaryEl.textContent = summary;
    row.appendChild(summaryEl);
    this.activityEl.scrollTop = this.activityEl.scrollHeight;
  }

  private appendErrorNote(message: string): void {
    if (!this.activityEl || !this.activityListEl) return;
    const row = document.createElement("div");
    row.className = "canon-miner-activity-row is-fail";
    row.textContent = `Error: ${message}`;
    this.activityListEl.appendChild(row);
    this.activityEl.scrollTop = this.activityEl.scrollHeight;
  }

  // ── Inventory zone ───────────────────────────────────────────────────

  /** Curation is a post-crawl activity: while the crawl runs the inventory is
   *  for watching, not editing. Every unit/finding event re-renders the list
   *  whole, and node removal does NOT fire `blur` in WebKit — so an open
   *  contenteditable finding body would be detached mid-edit and the typed
   *  text lost with no signal at all. Rows stay inert until `done`. */
  private canCurate(): boolean {
    return this.state.done;
  }

  private renderInventory(): void {
    if (!this.cardsEl) return;
    // A full re-render resets scrollTop to 0, which makes the list unbrowsable
    // during a crawl streaming a finding event every few seconds.
    const scroll = this.cardsEl.scrollTop;
    this.cardsEl.innerHTML = "";

    for (const kind of inventoryKinds(this.state.units)) {
      const rows = this.state.units.filter((u) => u.kind === kind);
      if (rows.length === 0) continue;
      const group = document.createElement("div");
      group.className = "canon-miner-category";
      const head = document.createElement("div");
      head.className = "canon-miner-category-head";
      head.textContent = KIND_LABELS[kind] ?? kind;
      group.appendChild(head);
      for (const u of rows) group.appendChild(this.unitRow(u));
      this.cardsEl.appendChild(group);
    }

    if (this.state.units.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rail-empty";
      const title = document.createElement("div");
      title.className = "rail-empty-title";
      title.textContent = this.state.done ? "Nothing to inventory" : "Crawling…";
      const hint = document.createElement("div");
      hint.className = "rail-empty-hint";
      hint.textContent = this.state.done
        ? "The crawl finished without proposing a unit. Try a narrower focus."
        : "Units appear here as the crawler surveys the repository.";
      empty.append(title, hint);
      this.cardsEl.appendChild(empty);
    } else if (!this.canCurate()) {
      const hint = document.createElement("div");
      hint.className = "canon-miner-curate-hint";
      hint.textContent = "Crawling — findings can be curated once the crawl finishes.";
      this.cardsEl.appendChild(hint);
    }

    this.cardsEl.scrollTop = scroll;
    this.renderPreview();
    this.renderFooter();
  }

  private unitRow(u: UnitRow): HTMLElement {
    const curate = this.canCurate();
    const row = document.createElement("div");
    row.className = curate ? "rail-row canon-miner-unit" : "rail-row canon-miner-unit is-inert";
    row.dataset.state = u.state;
    if (curate) row.tabIndex = 0;

    const line = document.createElement("div");
    line.className = "rail-row-line";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "canon-miner-unit-check";
    check.checked = u.selected;
    // A detected row is not ours to write (Adopt is its only verb); an
    // `unknown` row's destination was never verified, so it may not be armed
    // either. Curation as a whole waits for the crawl to finish.
    check.disabled = !curate || !isSelectable(u);
    check.setAttribute(
      "aria-label",
      u.state === "changed" ? `Overwrite ${u.name}` : `Write ${u.name}`,
    );
    check.addEventListener("click", (e) => e.stopPropagation());
    check.addEventListener("change", () => {
      setUnitSelected(this.state, u.id, check.checked);
      this.renderPreview();
      this.renderFooter();
    });
    line.appendChild(check);

    const name = document.createElement("span");
    name.className = "rail-name canon-miner-unit-name";
    name.textContent = u.name;
    line.appendChild(name);

    const badge = document.createElement("span");
    badge.className = `canon-miner-state-badge is-${u.state}`;
    badge.textContent = u.state === "detected" && u.detectedIn
      ? `detected · ${u.detectedIn}`
      : STATE_LABELS[u.state];
    attachTooltip(badge, stateHint(u));
    line.appendChild(badge);

    if (u.state !== "detected") {
      const count = document.createElement("span");
      count.className = "rail-num canon-miner-unit-count";
      count.textContent = String(u.findings.length);
      attachTooltip(count, `${u.findings.length} finding${u.findings.length === 1 ? "" : "s"}`);
      line.appendChild(count);
    }

    row.appendChild(line);

    const meta = document.createElement("div");
    meta.className = "canon-miner-unit-summary";
    // `unitTarget` returns "" for a kind with no Canon destination, so the
    // fallback chain ends in prose rather than a fabricated path.
    meta.textContent = u.summary || unitTarget(u.kind, u.slug) || "No Canon destination for this kind.";
    row.appendChild(meta);

    // The dock is only emitted when it holds something: `.rail-row` reserves
    // 82px of right padding for any row that *has* a `.rail-row-actions`,
    // and an always-present empty dock would steal that space from every row.
    const actions = document.createElement("div");
    actions.className = "rail-row-actions";
    const adoptKind = ADOPT_KIND[u.kind];
    if (curate && u.state === "detected" && adoptKind) {
      const adopt = iconButton(Icons.download({ size: 12 }), `Adopt ${u.name} into Canon`, () => {
        void this.adopt(u, adoptKind);
      });
      adopt.classList.add("rail-row-action", "is-neutral");
      actions.appendChild(adopt);
      row.appendChild(actions);
    }

    if (curate) {
      row.addEventListener("click", (e) => {
        const target = e.target;
        if (target instanceof Node && (target === check || actions.contains(target))) return;
        if (this.expanded.has(u.id)) this.expanded.delete(u.id);
        else this.expanded.add(u.id);
        this.renderInventory();
      });
    }

    if (curate && this.expanded.has(u.id)) {
      const wrap = document.createElement("div");
      wrap.className = "canon-miner-unit-body";
      wrap.addEventListener("click", (e) => e.stopPropagation());

      const path = unitTarget(u.kind, u.slug);
      if (path) {
        const target = document.createElement("div");
        target.className = "canon-miner-unit-target";
        target.textContent = path;
        wrap.appendChild(target);
      }

      if (u.state === "detected") {
        const note = document.createElement("div");
        note.className = "canon-miner-unit-note";
        note.textContent = "Found in an executor directory, with no Canon source behind it. Adopt to bring it under Canon.";
        wrap.appendChild(note);
      } else {
        // Kind lives on the unit, not the finding — `unitFindings` in
        // state.ts stamps every finding with its unit's kind on the way out,
        // so a per-finding kind chip would be a lie.
        wrap.appendChild(this.kindRow(u));
        for (const c of u.findings) wrap.appendChild(this.findingCard(c, u));
      }
      row.appendChild(wrap);
    }
    return row;
  }

  private async adopt(u: UnitRow, kind: CanonPkgKind): Promise<void> {
    try {
      await canonAdopt(this.opts.repoRoot, kind, u.name);
      u.state = "exists";
      u.selected = false;
      pushInfoToast({ message: `Adopted ${u.name} into Canon.` });
    } catch (e) {
      pushInfoToast({ message: `Adopt failed: ${String(e)}` });
    }
    this.renderInventory();
  }

  /** Re-route the whole unit to another kind, then re-resolve — the row's
   *  state was computed against the OLD kind's path on disk and is stale the
   *  instant the kind changes (setUnitKind deselects for exactly this
   *  reason; the re-check is what lets the row be re-armed honestly). */
  private kindRow(u: UnitRow): HTMLElement {
    const kindRow = document.createElement("div");
    kindRow.className = "canon-miner-kindrow";
    for (const k of KIND_ORDER) {
      const chip = document.createElement("button");
      chip.className = u.kind === k ? "canon-miner-kindchip is-active" : "canon-miner-kindchip";
      chip.textContent = KIND_LABELS[k];
      attachTooltip(chip, `Route this unit to ${unitTarget(k, u.slug)}`);
      chip.addEventListener("click", () => {
        if (u.kind === k) return;
        const wasExpanded = this.expanded.delete(u.id);
        setUnitKind(this.state, u.id, k);
        if (wasExpanded) this.expanded.add(u.id); // id was re-keyed by the kind change
        this.renderInventory();
        // Only this row's badge is this call's responsibility; the rest were
        // resolved honestly by handleRunDone and stay that way.
        void this.resolveStates(true, [u.id]);
      });
      kindRow.appendChild(chip);
    }
    return kindRow;
  }

  private findingCard(card: FindingCard, u: UnitRow): HTMLElement {
    const wrapper = document.createElement("div");

    if (card.status === "discarded") {
      wrapper.className = "canon-miner-discarded";
      wrapper.textContent = card.finding.title;
      wrapper.addEventListener("click", () => {
        // No "restore to pending" in the reducer API — the card is a plain
        // object, not an encapsulated class.
        card.status = "pending";
        this.renderInventory();
        this.scheduleResolve();
      });
      return wrapper;
    }

    wrapper.className = card.status === "accepted" ? "canon-miner-card is-accepted" : "canon-miner-card";
    // The unit owns the kind; the card only records where it will land.
    wrapper.dataset.kind = u.kind;

    const top = document.createElement("div");
    top.className = "canon-miner-card-top";
    const title = document.createElement("div");
    title.className = "canon-miner-card-title";
    title.textContent = card.finding.title;
    const badge = document.createElement("span");
    badge.className = `canon-miner-badge is-${card.finding.confidence}`;
    badge.textContent = card.finding.confidence;
    top.append(title, badge);

    const body = document.createElement("div");
    body.className = "canon-miner-card-body";
    body.textContent = card.editedBody ?? card.finding.bodyMd;
    body.addEventListener("click", () => {
      if (body.getAttribute("contenteditable") === "true") return;
      body.setAttribute("contenteditable", "true");
      body.focus();
      const range = document.createRange();
      range.selectNodeContents(body);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    body.addEventListener("blur", () => {
      body.removeAttribute("contenteditable");
      editFindingBody(this.state, card.id, body.textContent ?? "");
      this.renderPreview();
      this.scheduleResolve();
    });

    const evidence = document.createElement("div");
    evidence.className = "canon-miner-evidence";
    for (const loc of card.finding.evidence) {
      const chip = document.createElement("span");
      chip.className = "canon-miner-chip";
      chip.textContent = loc;
      evidence.appendChild(chip);
    }

    const actions = document.createElement("div");
    actions.className = "canon-miner-card-actions";
    const acceptBtn = document.createElement("button");
    acceptBtn.className = "canon-miner-btn is-primary";
    acceptBtn.innerHTML = `${Icons.check({ size: 12 })}<span>Accept</span>`;
    acceptBtn.disabled = card.status === "accepted";
    acceptBtn.addEventListener("click", () => {
      setFindingStatus(this.state, card.id, "accepted");
      this.renderInventory();
      this.scheduleResolve();
    });
    const discardBtn = document.createElement("button");
    discardBtn.className = "canon-miner-btn is-danger";
    discardBtn.innerHTML = `${Icons.trash({ size: 12 })}<span>Discard</span>`;
    discardBtn.addEventListener("click", () => {
      setFindingStatus(this.state, card.id, "discarded");
      this.renderInventory();
      this.scheduleResolve();
    });
    actions.append(acceptBtn, discardBtn);

    wrapper.append(top, body, evidence, actions);
    return wrapper;
  }

  // ── Preview zone ─────────────────────────────────────────────────────

  private renderPreview(): void {
    if (!this.previewPre) return;
    this.previewPre.textContent = compilePreview(this.state);
  }

  // ── Footer ───────────────────────────────────────────────────────────

  private renderFooter(): void {
    if (!this.footerEl) return;
    this.footerEl.innerHTML = "";

    const writable = this.state.units.filter((u) => u.state !== "detected");
    const ready = selectedUnits(this.state);
    const findings = this.allFindings().length;
    const countEl = document.createElement("span");
    countEl.textContent =
      `${writable.length} unit${writable.length === 1 ? "" : "s"} · ` +
      `${findings} finding${findings === 1 ? "" : "s"} · ${ready.length} to write`;

    // Writing is create-or-update with no confirm step, so the count of rows
    // that already exist in Canon is the only warning the user gets.
    const overwrites = overwriteTargets(this.state);
    let warnEl: HTMLElement | null = null;
    if (overwrites.length > 0) {
      warnEl = document.createElement("span");
      warnEl.className = "canon-miner-overwrite-warn";
      warnEl.textContent = `${overwrites.length} will be overwritten`;
      attachTooltip(warnEl, overwrites.map((u) => unitTarget(u.kind, u.slug)).join("\n"));
    }

    const spacer = document.createElement("div");
    spacer.className = "canon-miner-footer-spacer";

    const writeBtn = document.createElement("button");
    writeBtn.className = "canon-miner-btn is-primary";
    writeBtn.innerHTML = `${Icons.download({ size: 12 })}<span>Write to repo</span>`;
    // `this.writing` is load-bearing: this footer is rebuilt from scratch on
    // every renderInventory(), so without it a resolveStates landing mid-write
    // would hand back an enabled button and buy a second canonCompileUnits.
    const canWrite = !this.writing && ready.length > 0 && (this.state.done || this.state.stopped);
    writeBtn.disabled = !canWrite;
    attachTooltip(
      writeBtn,
      this.writing
        ? "Writing to the repository…"
        : canWrite
          ? `Create or update ${ready.length} unit${ready.length === 1 ? "" : "s"} under .covenant/canon/`
          : "Accept at least one finding on a checked unit first",
    );
    writeBtn.addEventListener("click", () => void this.writeToRepo(writeBtn));

    this.footerEl.append(countEl);
    if (warnEl) this.footerEl.appendChild(warnEl);
    this.footerEl.append(spacer, writeBtn);
  }

  /** `canon_compile_units` always creates-or-updates: there is no overwrite
   *  flag and no confirm dialog. The per-row state model is what replaced
   *  them — only `new` rows arrive checked, `changed` rows are an opt-in. */
  private async writeToRepo(writeBtn: HTMLButtonElement): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    // A curation resolve queued moments ago must not land on top of the
    // selection this write is about to consume. (`scheduleResolve`'s own
    // `writing` re-check covers the timer that already fired; this drops the
    // one still waiting.)
    this.cancelScheduledResolve();
    writeBtn.disabled = true;
    try {
      const units = selectedUnits(this.state);
      const report = await canonCompileUnits(this.opts.repoRoot, units);
      const parts: string[] = [];
      if (report.skills.length) parts.push(`${report.skills.length} skill`);
      if (report.memory.length) parts.push(`${report.memory.length} memory`);
      if (report.commands.length) parts.push(`${report.commands.length} command`);
      if (report.agents.length) parts.push(`${report.agents.length} subagent`);
      pushInfoToast({ message: `Written: ${parts.join(", ") || "nothing"}` });
      this.destroy();
    } catch (e) {
      pushInfoToast({ message: `Write failed: ${String(e)}` });
      this.writing = false;
      // Re-render rather than just re-enabling the button: `renderFooter` is
      // the single place that decides whether writing is armed.
      this.renderFooter();
    }
  }

  // ── Empty-done state ─────────────────────────────────────────────────

  private showEmptyDone(): void {
    this.clearBody();
    const wrap = document.createElement("div");
    wrap.className = "canon-miner-empty-state";
    const note = document.createElement("div");
    note.textContent = "Nothing to inventory — try a different focus.";
    const restartBtn = document.createElement("button");
    restartBtn.className = "canon-miner-btn is-primary";
    restartBtn.innerHTML = `${Icons.refresh({ size: 13 })}<span>Restart</span>`;
    restartBtn.addEventListener("click", () => this.restart());
    wrap.append(note, restartBtn);
    this.bodyEl.appendChild(wrap);
  }

  private restart(): void {
    this.runId = null;
    this.writing = false;
    this.cancelScheduledResolve();
    this.resolveToken++; // orphan any check still in flight from the last run
    this.state = createMinerState();
    this.expanded.clear();
    this.activityEl = null;
    this.activityListEl = null;
    this.cardsEl = null;
    this.previewPre = null;
    this.footerEl = null;
    this.refreshHead();
    this.showSetup();
  }
}
