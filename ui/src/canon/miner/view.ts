// Canon Context Miner — immersive full-screen view. Setup bar → live mining
// run → 3-zone curation (activity / cards / live preview) → write accepted
// findings to a compiled skill package. The reducer in `./state` owns all
// the logic; this module is DOM plumbing on top of it.
//
// Opaque full-screen overlay by design — see miner.css header comment for
// the vibrancy-bleed gotcha this avoids.

import "./miner.css";
import { Icons } from "../../icons";
import { attachTooltip } from "../../tooltip/tooltip";
import { startSky } from "../../spec-chat/entrance";
import { pushInfoToast } from "../../notifications/toast";
import {
  canonCompileFindings,
  canonMineStart,
  canonMineStop,
  subscribeMinerEvents,
  type MinerEvent,
} from "../../api";
import {
  acceptedFindings,
  compilePreview,
  createMinerState,
  editFindingBody,
  KIND_LABELS,
  KIND_ORDER,
  reduceMinerEvent,
  setFindingKind,
  setFindingStatus,
  type MinerState,
} from "./state";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface ContextMinerOpts {
  repoRoot: string;
  groupName: string | null;
}

// Mirrors `CATEGORIES` in crates/agent/src/context_miner.rs and the private
// ordering `compilePreview` (state.ts) uses — duplicated here (small) so
// card groups render in the same order the compiled output will.
const CATEGORY_ORDER: string[] = ["convention", "pattern", "gotcha", "domain_rule", "glossary", "workflow"];
const CATEGORY_LABELS: Record<string, string> = {
  convention: "Conventions",
  pattern: "Patterns",
  gotcha: "Gotchas",
  domain_rule: "Domain rules",
  glossary: "Glossary",
  workflow: "Workflows",
};

function toKebab(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-");
}

function shortArg(arg: string): string {
  const trimmed = arg.trim();
  return trimmed.length > 48 ? `${trimmed.slice(0, 45)}…` : trimmed;
}

export class ContextMinerView {
  private root: HTMLElement;
  private headEl: HTMLElement;
  private bodyEl: HTMLElement;

  private state: MinerState = createMinerState();
  private runId: string | null = null;
  private unlisten: UnlistenFn | null = null;

  private skillName = "";
  private focus = "";
  private thorough = false;

  // Mining-view zone refs — set by showMining(), cleared by restart().
  private activityEl: HTMLElement | null = null;
  private activityListEl: HTMLElement | null = null;
  private cardsEl: HTMLElement | null = null;
  private cardsEmptyEl: HTMLElement | null = null;
  private previewPre: HTMLPreElement | null = null;
  private footerEl: HTMLElement | null = null;
  private cardEls = new Map<string, HTMLElement>();
  private categoryEls = new Map<string, HTMLElement>();
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
    this.stopSky();
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

  private acceptNewestPending(): void {
    const pending = this.state.findings.filter((f) => f.status === "pending");
    const target = pending[pending.length - 1];
    if (!target) return;
    setFindingStatus(this.state, target.id, "accepted");
    this.renderCard(target.id);
    this.renderFooter();
    this.renderPreview();
  }

  private discardNewestPending(): void {
    const pending = this.state.findings.filter((f) => f.status === "pending");
    const target = pending[pending.length - 1];
    if (!target) return;
    setFindingStatus(this.state, target.id, "discarded");
    this.renderCard(target.id);
    this.renderFooter();
    this.renderPreview();
  }

  // ── Header ───────────────────────────────────────────────────────────

  private refreshHead(): void {
    this.headEl.innerHTML = "";

    const brand = document.createElement("div");
    brand.className = "canon-miner-brand";
    brand.textContent = "Context Miner";
    this.headEl.appendChild(brand);

    if (this.runId) {
      const dot = document.createElement("span");
      dot.className = "canon-miner-dot";
      if (this.state.done) dot.classList.add(this.state.stopped ? "is-stopped" : "is-done");
      const name = document.createElement("span");
      name.className = "canon-miner-name";
      name.textContent = this.skillName;
      this.headEl.append(dot, name);
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
    title.textContent = "Mine context";

    const sub = document.createElement("div");
    sub.className = "canon-miner-setup-sub";
    sub.textContent = this.opts.groupName
      ? `${this.opts.groupName} · ${this.opts.repoRoot}`
      : this.opts.repoRoot;

    const note = document.createElement("p");
    note.className = "canon-miner-note";
    note.textContent = "Findings route to skills, memory, commands or subagents during curation.";

    const { wrap: nameWrap, input: nameInput } = this.field(
      "Package name",
      "e.g. testing-conventions",
      this.skillName,
    );
    const commitKebab = () => {
      nameInput.value = toKebab(nameInput.value);
      this.skillName = nameInput.value;
    };
    nameInput.addEventListener("input", commitKebab);
    nameInput.addEventListener("blur", () => {
      nameInput.value = nameInput.value.replace(/^-+|-+$/g, "");
      this.skillName = nameInput.value;
    });

    const { wrap: focusWrap, input: focusInput } = this.field(
      "Focus",
      "what to capture: testing conventions, KYC domain rules…",
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
    startBtn.innerHTML = `${Icons.play({ size: 13 })}<span>Start mining</span>`;
    startBtn.addEventListener("click", () => {
      errorEl.textContent = "";
      if (!this.skillName) {
        errorEl.textContent = "Enter a package name.";
        return;
      }
      void this.start(errorEl, startBtn);
    });

    // Staged rise choreography for the card contents (entrance).
    [title, sub, note, nameWrap, focusWrap, thoroughRow, startBtn].forEach((el, i) => {
      el.classList.add("canon-miner-rise");
      (el as HTMLElement).style.setProperty("--rise-delay", `${90 + i * 65}ms`);
    });
    card.append(title, sub, note, nameWrap, focusWrap, thoroughRow, errorEl, startBtn);

    // Constellation sky behind the card — the same particle field as the
    // Spec Creator's immersive entrance (reused via startSky).
    const sky = document.createElement("canvas");
    sky.className = "canon-miner-sky";
    setup.append(sky, card);
    this.bodyEl.appendChild(setup);

    requestAnimationFrame(() => {
      this.skyTeardown = startSky(sky);
      setup.classList.add("open");
      nameInput.focus();
    });
  }

  private async start(errorEl: HTMLElement, startBtn: HTMLButtonElement): Promise<void> {
    startBtn.disabled = true;
    try {
      const runId = await canonMineStart(this.opts.repoRoot, this.skillName, this.focus, this.thorough);
      this.runId = runId;
      this.showMining();
      this.refreshHead();
      this.unlisten = await subscribeMinerEvents(runId, (ev: MinerEvent) => {
        reduceMinerEvent(this.state, ev);
        this.applyEvent(ev);
      });
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
    this.cardEls.clear();
    this.categoryEls.clear();

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
    this.cardsEmptyEl = document.createElement("div");
    this.cardsEmptyEl.className = "canon-miner-cards-empty";
    this.cardsEmptyEl.textContent = "Findings will appear here as the miner works…";
    this.cardsEl.appendChild(this.cardsEmptyEl);

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

    this.renderFooter();
    this.renderPreview();
  }

  private applyEvent(ev: MinerEvent): void {
    switch (ev.kind) {
      case "tool_start":
        this.appendActivityRow(ev.id, ev.tool, ev.arg);
        break;
      case "tool_result":
        this.updateActivityRow(ev.id, ev.summary, ev.ok);
        break;
      case "finding":
        this.appendFindingCard(ev.id);
        this.renderFooter();
        break;
      case "run_done":
        this.handleRunDone();
        break;
      case "error":
        this.appendErrorNote(ev.message);
        break;
      case "text_delta":
        // Narration text isn't surfaced in this view — activity rows and
        // finding cards already carry the visible signal of progress.
        break;
    }
  }

  private handleRunDone(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
    this.refreshHead();
    if (this.state.findings.length === 0) {
      this.showEmptyDone();
    } else {
      this.renderFooter();
    }
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

  // ── Cards zone ───────────────────────────────────────────────────────

  private categoryContainer(category: string): HTMLElement {
    let el = this.categoryEls.get(category);
    if (el) return el;
    el = document.createElement("div");
    el.className = "canon-miner-category";
    const head = document.createElement("div");
    head.className = "canon-miner-category-head";
    head.textContent = CATEGORY_LABELS[category] ?? category;
    el.appendChild(head);
    this.categoryEls.set(category, el);

    // Insert in fixed category order regardless of arrival order.
    const myIdx = CATEGORY_ORDER.indexOf(category);
    let before: HTMLElement | null = null;
    if (this.cardsEl) {
      for (const child of Array.from(this.cardsEl.children)) {
        if (!(child instanceof HTMLElement) || !child.classList.contains("canon-miner-category")) continue;
        const otherCat = [...this.categoryEls.entries()].find(([, v]) => v === child)?.[0];
        if (otherCat && (myIdx < 0 || CATEGORY_ORDER.indexOf(otherCat) > myIdx)) {
          before = child;
          break;
        }
      }
      this.cardsEl.insertBefore(el, before);
    }
    return el;
  }

  private appendFindingCard(id: string): void {
    const card = this.state.findings.find((f) => f.id === id);
    if (!card || !this.cardsEl) return;
    if (this.cardsEmptyEl?.isConnected) this.cardsEmptyEl.remove();
    const container = this.categoryContainer(card.finding.category);
    const wrapper = document.createElement("div");
    container.appendChild(wrapper);
    this.cardEls.set(id, wrapper);
    this.renderCard(id);
  }

  private renderCard(id: string): void {
    const card = this.state.findings.find((f) => f.id === id);
    const wrapper = this.cardEls.get(id);
    if (!card || !wrapper) return;
    wrapper.innerHTML = "";
    wrapper.onclick = null;

    if (card.status === "discarded") {
      wrapper.className = "canon-miner-discarded";
      wrapper.textContent = card.finding.title;
      wrapper.onclick = () => {
        // No "restore to pending" in the Task 4 reducer API — mutate the
        // card directly, it's a plain object, not an encapsulated class.
        card.status = "pending";
        this.renderCard(id);
        this.renderFooter();
        this.renderPreview();
      };
      return;
    }

    wrapper.className = card.status === "accepted" ? "canon-miner-card is-accepted" : "canon-miner-card";

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
      editFindingBody(this.state, id, body.textContent ?? "");
      this.renderPreview();
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
      setFindingStatus(this.state, id, "accepted");
      this.renderCard(id);
      this.renderFooter();
      this.renderPreview();
    });
    const discardBtn = document.createElement("button");
    discardBtn.className = "canon-miner-btn is-danger";
    discardBtn.innerHTML = `${Icons.trash({ size: 12 })}<span>Discard</span>`;
    discardBtn.addEventListener("click", () => {
      setFindingStatus(this.state, id, "discarded");
      this.renderCard(id);
      this.renderFooter();
      this.renderPreview();
    });
    actions.append(acceptBtn, discardBtn);

    const kindRow = document.createElement("div");
    kindRow.className = "canon-miner-kindrow";
    for (const k of KIND_ORDER) {
      const chip = document.createElement("button");
      chip.className = card.kind === k ? "canon-miner-kindchip is-active" : "canon-miner-kindchip";
      chip.textContent = KIND_LABELS[k];
      chip.addEventListener("click", () => {
        setFindingKind(this.state, id, k);
        this.renderCard(id);
        this.renderPreview();
      });
      kindRow.appendChild(chip);
    }

    wrapper.append(top, body, evidence, kindRow, actions);
  }

  // ── Preview zone ─────────────────────────────────────────────────────

  private renderPreview(): void {
    if (!this.previewPre) return;
    this.previewPre.textContent = compilePreview(this.skillName, this.state);
  }

  // ── Footer ───────────────────────────────────────────────────────────

  private renderFooter(): void {
    if (!this.footerEl) return;
    this.footerEl.innerHTML = "";

    const accepted = this.state.findings.filter((f) => f.status === "accepted").length;
    const pending = this.state.findings.filter((f) => f.status === "pending").length;
    const countEl = document.createElement("span");
    countEl.textContent = `${accepted} accepted · ${pending} pending`;

    const spacer = document.createElement("div");
    spacer.className = "canon-miner-footer-spacer";

    const writeBtn = document.createElement("button");
    writeBtn.className = "canon-miner-btn is-primary";
    writeBtn.innerHTML = `${Icons.download({ size: 12 })}<span>Write to repo</span>`;
    const canWrite = acceptedFindings(this.state).length > 0 && (this.state.done || this.state.stopped);
    writeBtn.disabled = !canWrite;
    writeBtn.addEventListener("click", () => void this.writeToRepo(writeBtn, false));

    this.footerEl.append(countEl, spacer, writeBtn);
  }

  // ponytail: only skills collision-guard; other kinds dedupe by slug
  private async writeToRepo(writeBtn: HTMLButtonElement, overwrite: boolean): Promise<void> {
    writeBtn.disabled = true;
    try {
      const findings = acceptedFindings(this.state);
      const report = await canonCompileFindings(this.opts.repoRoot, this.skillName, findings, overwrite);
      const parts: string[] = [];
      if (report.skills) parts.push("1 skill");
      if (report.memory.length) parts.push(`${report.memory.length} memory`);
      if (report.commands.length) parts.push(`${report.commands.length} command`);
      if (report.agents.length) parts.push(`${report.agents.length} subagent`);
      pushInfoToast({ message: `Written: ${parts.join(", ") || "nothing"}` });
      this.destroy();
    } catch (e) {
      const msg = String(e);
      if (!overwrite && msg.includes("already exists")) {
        this.showOverwriteConfirm(writeBtn);
      } else {
        pushInfoToast({ message: `Write failed: ${msg}` });
        writeBtn.disabled = false;
      }
    }
  }

  private showOverwriteConfirm(writeBtn: HTMLButtonElement): void {
    if (!this.footerEl) return;
    const note = document.createElement("span");
    note.className = "canon-miner-confirm";
    note.textContent = "Skill already exists —";

    const overwriteBtn = document.createElement("button");
    overwriteBtn.className = "canon-miner-btn is-danger";
    overwriteBtn.textContent = "Overwrite";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "canon-miner-btn";
    cancelBtn.textContent = "Cancel";

    const cleanup = () => { note.remove(); overwriteBtn.remove(); cancelBtn.remove(); };
    overwriteBtn.addEventListener("click", () => { cleanup(); void this.writeToRepo(writeBtn, true); });
    cancelBtn.addEventListener("click", () => { cleanup(); writeBtn.disabled = false; });

    this.footerEl.insertBefore(note, writeBtn);
    this.footerEl.insertBefore(overwriteBtn, writeBtn);
    this.footerEl.insertBefore(cancelBtn, writeBtn);
  }

  // ── Empty-done state ─────────────────────────────────────────────────

  private showEmptyDone(): void {
    this.clearBody();
    const wrap = document.createElement("div");
    wrap.className = "canon-miner-empty-state";
    const note = document.createElement("div");
    note.textContent = "Nothing mined — try a broader focus.";
    const restartBtn = document.createElement("button");
    restartBtn.className = "canon-miner-btn is-primary";
    restartBtn.innerHTML = `${Icons.refresh({ size: 13 })}<span>Restart</span>`;
    restartBtn.addEventListener("click", () => this.restart());
    wrap.append(note, restartBtn);
    this.bodyEl.appendChild(wrap);
  }

  private restart(): void {
    this.runId = null;
    this.state = createMinerState();
    this.cardEls.clear();
    this.categoryEls.clear();
    this.activityEl = null;
    this.activityListEl = null;
    this.cardsEl = null;
    this.cardsEmptyEl = null;
    this.previewPre = null;
    this.footerEl = null;
    this.refreshHead();
    this.showSetup();
  }
}
