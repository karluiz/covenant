import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { draftsApi } from "../drafts/api";
import type { DraftSummary, PublishedSpec } from "../drafts/api";
import { listSuperpowersMissions, specAuthorListDrafts, type MissionRef } from "../api";
import type { SuperpowersMissionEntry, SpecDraftSummary } from "../api";
import { Icons } from "../icons";
import { renderMarkdown } from "../ui/markdown";
import { scoreSpec, type SpecScore } from "../spec-score/engine";
import { makeSpecScoreChip, renderBreakdown } from "../spec-score/badge";
import { deepScore } from "../spec-score/deep";
import { formatChord } from "../platform";
import { attachTooltip } from "../tooltip/tooltip";

/** Kind filter for the picker's rail — replaces the old per-section fold state:
 *  one tab narrows the list instead of expanding/collapsing an accordion. */
export type KindTab = "all" | "inprogress" | "published" | "superpowers" | "drafts";

const GRADE_TOOLTIP = "S ≥ 95 · A ≥ 85 · B ≥ 70 · C ≥ 50 · D < 50";

export type SelectedRef =
  | { source: "card"; path: string }
  | { source: "input"; path: string }
  | null;

export interface PageState {
  specs: PublishedSpec[];
  drafts: DraftSummary[];
  superpowers: SuperpowersMissionEntry[];
  /** Spec Creator's in-progress/ready JSON drafts (~/.covenant/spec-drafts). */
  inProgress: SpecDraftSummary[];
  selected: SelectedRef;
  inputValue: string;
  query: string;
  loading: boolean;
  error: string | null;
}

export function initialState(currentMissionPath: string | null): PageState {
  return {
    specs: [],
    drafts: [],
    superpowers: [],
    inProgress: [],
    selected: currentMissionPath ? { source: "card", path: currentMissionPath } : null,
    inputValue: "",
    query: "",
    loading: true,
    error: null,
  };
}

export function filterSpecs(specs: PublishedSpec[], query: string): PublishedSpec[] {
  const q = query.trim().toLowerCase();
  if (!q) return specs;
  return specs.filter(
    (s) =>
      s.id.toLowerCase().includes(q) ||
      s.title.toLowerCase().includes(q) ||
      s.goal.toLowerCase().includes(q),
  );
}

export function selectCard(s: PageState, path: string): PageState {
  return { ...s, selected: { source: "card", path }, inputValue: "" };
}

export function typeInput(s: PageState, value: string): PageState {
  const trimmed = value.trim();
  return {
    ...s,
    selected: trimmed.length > 0 ? { source: "input", path: trimmed } : null,
    inputValue: value,
  };
}

export function effectivePath(s: PageState): string | null {
  if (s.selected?.source === "card") return s.selected.path;
  const t = s.inputValue.trim();
  return t.length > 0 ? t : null;
}

export function canSubmit(s: PageState): boolean {
  if (s.loading) return false;
  return effectivePath(s) !== null;
}

export function navigate(
  s: PageState,
  delta: number,
  visibleSpecs: PublishedSpec[],
): PageState {
  if (visibleSpecs.length === 0) return s;
  const cur =
    s.selected?.source === "card"
      ? visibleSpecs.findIndex((x) => x.path === s.selected!.path)
      : -1;
  const next = ((cur + delta) + visibleSpecs.length) % visibleSpecs.length;
  return selectCard(s, visibleSpecs[next]!.path);
}

export type PageResult =
  | { kind: "set"; path: string }
  | { kind: "setRef"; mref: MissionRef }
  | { kind: "publishDraft"; slug: string }
  | { kind: "spawnTab"; initialCommand: string }
  | { kind: "newSuperpowersMission" }
  | null;

export interface MissionPageOpts {
  repoRoot: string;
  currentMissionPath: string | null;
  onBrowse: () => Promise<string | null>;
}

export class MissionPage {
  private isOpenState = false;
  /// Invalidates async list/preview loads from a previous picker open.
  private openGeneration = 0;
  private state: PageState = initialState(null);
  /** Which kind of spec the rail shows. Persists across innerHTML re-renders. */
  private activeKindTab: KindTab = "all";
  /** "Or paste a path…" starts folded; persists across innerHTML re-renders. */
  private pathRowOpen = false;
  private opts: MissionPageOpts | null = null;
  private resolve: ((r: PageResult) => void) | null = null;
  private unlistenSp: UnlistenFn | null = null;
  public onClosed: (() => void) | null = null;

  // Preview pane state — populated lazily by loadPreview() on selection.
  private previewBody = "";
  private previewPath = "";
  /** SpecScore per published-spec path; null = unreadable (no badge, no retry). */
  private scoreCache = new Map<string, SpecScore | null>();
  private previewLoading = false;
  private previewTruncated = false;
  private previewError: string | null = null;

  constructor(
    private readonly pageHost: HTMLElement,
    private readonly workspace: HTMLElement,
  ) {}

  isOpen(): boolean { return this.isOpenState; }

  open(opts: MissionPageOpts): Promise<PageResult> {
    if (this.isOpenState) {
      // Already open: cancel previous waiter, restart with new opts.
      this.finish(null);
    }
    const generation = ++this.openGeneration;
    this.opts = opts;
    this.state = initialState(opts.currentMissionPath);
    this.activeKindTab = "all";
    this.pathRowOpen = false;
    this.previewBody = "";
    this.previewPath = "";
    this.previewLoading = false;
    this.previewTruncated = false;
    this.previewError = null;
    this.scoreCache.clear();
    this.workspace.hidden = true;
    this.pageHost.hidden = false;
    this.isOpenState = true;

    const promise = new Promise<PageResult>((res) => { this.resolve = res; });
    this.render();
    void this.fetchAll(generation);
    void this.subscribeSuperpowers(generation);
    return promise;
  }

  close(): void { this.finish(null); }

  private finish(result: PageResult): void {
    if (!this.isOpenState) return;
    this.openGeneration++;
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler, true);
      this.keyHandler = null;
    }
    this.pageHost.innerHTML = "";
    this.pageHost.hidden = true;
    this.workspace.hidden = false;
    this.isOpenState = false;
    if (this.unlistenSp) { this.unlistenSp(); this.unlistenSp = null; }
    const r = this.resolve;
    this.resolve = null;
    if (r) r(result);
    if (this.onClosed) this.onClosed();
  }

  private setState(patch: Partial<PageState>): void {
    if (!this.isOpenState) return;
    this.state = { ...this.state, ...patch };
    this.render();
  }

  private async fetchAll(generation: number = this.openGeneration): Promise<void> {
    if (!this.opts || generation !== this.openGeneration) return;
    const root = this.opts.repoRoot;
    try {
      const [specs, drafts, superpowers, inProgress] = await Promise.all([
        draftsApi.listPublishedSpecs(root),
        draftsApi.list(root),
        listSuperpowersMissions(root).catch(() => []),
        specAuthorListDrafts(root).catch(() => [] as SpecDraftSummary[]),
      ]);
      if (generation !== this.openGeneration || !this.isOpenState) return;
      // Only the drafts still being worked on — Published ones live in `specs`.
      const active = inProgress.filter((d) => d.status !== "Published");
      this.setState({ specs, drafts, superpowers, inProgress: active, loading: false, error: null });
      let sel = this.state.selected;
      // Nothing anchored yet → preview the top spec so the pane is never an empty void.
      if (!sel && specs.length > 0) {
        this.state = selectCard(this.state, specs[0]!.path);
        sel = this.state.selected;
        this.render();
      }
      if (sel?.source === "card") void this.loadPreview(sel.path, generation);
    } catch (err) {
      if (generation !== this.openGeneration || !this.isOpenState) return;
      this.setState({ loading: false, error: String(err) });
    }
  }

  private async subscribeSuperpowers(generation: number = this.openGeneration): Promise<void> {
    if (!this.opts || generation !== this.openGeneration) return;
    const root = this.opts.repoRoot;
    try {
      const unlisten = await listen("superpowers-missions-changed", () => {
        listSuperpowersMissions(root)
          .then((superpowers) => {
            if (generation === this.openGeneration) this.setState({ superpowers });
          })
          .catch(() => {});
      });
      if (generation !== this.openGeneration || !this.isOpenState) {
        unlisten();
        return;
      }
      this.unlistenSp = unlisten;
    } catch { /* ignore */ }
  }

  private async loadPreview(
    path: string,
    generation: number = this.openGeneration,
  ): Promise<void> {
    if (generation !== this.openGeneration || !this.isOpenState) return;
    this.previewPath = path;
    this.previewLoading = true;
    this.previewError = null;
    this.render();
    try {
      const r = await draftsApi.readSpecBody(path);
      // Race-guard: skip if user moved on to another card or closed the picker.
      if (this.previewPath !== path || generation !== this.openGeneration || !this.isOpenState) return;
      this.previewBody = r.body;
      this.previewTruncated = r.truncated;
      this.previewLoading = false;
      this.render();
    } catch (err) {
      if (this.previewPath !== path || generation !== this.openGeneration || !this.isOpenState) return;
      this.previewBody = "";
      this.previewError = String(err);
      this.previewLoading = false;
      this.render();
    }
  }

  private render(): void {
    if (!this.isOpenState) return;
    const s = this.state;
    const visible = filterSpecs(s.specs, s.query);
    void this.fillScores(visible);

    // Preserve focus + caret across innerHTML wipe (search/path inputs).
    const active = document.activeElement as HTMLElement | null;
    let restoreClass: string | null = null;
    let caretStart: number | null = null;
    let caretEnd: number | null = null;
    if (active && this.pageHost.contains(active)) {
      if (active.classList.contains("mission-page-search")) restoreClass = "mission-page-search";
      else if (active.classList.contains("mission-page-input")) restoreClass = "mission-page-input";
      if (restoreClass) {
        const inp = active as HTMLInputElement;
        caretStart = inp.selectionStart;
        caretEnd = inp.selectionEnd;
      }
    }

    this.pageHost.innerHTML = "";

    const currentSpec = this.opts?.currentMissionPath
      ? s.specs.find((sp) => sp.path === this.opts!.currentMissionPath)
      : undefined;
    const currentJump = currentSpec
      ? `<button type="button" class="mission-page-current-jump">Currently set → <b>${escapeHtml(currentSpec.id)} · ${escapeHtml(currentSpec.title)}</b></button>`
      : "";

    const header = document.createElement("header");
    header.className = "mission-page-header";
    header.innerHTML = `
      <div class="mission-page-titlebar">
        <span class="mission-page-title-icon" aria-hidden="true">${Icons.target({ size: 16 })}</span>
        <div>
          <h2 class="mission-page-title">Set spec</h2>
          <p class="mission-page-subtitle">Choose the spec that anchors this tab.</p>
          ${currentJump}
        </div>
      </div>
      <button type="button" class="mission-page-close" aria-label="Close (Esc)"><kbd class="settings-esc">esc</kbd></button>
    `;
    this.pageHost.appendChild(header);

    const body = document.createElement("div");
    body.className = "mission-page-body";
    this.pageHost.appendChild(body);

    body.appendChild(this.renderSidebar(visible));
    body.appendChild(this.renderPreview());

    const footer = document.createElement("footer");
    footer.className = "mission-page-footer";
    footer.innerHTML = `
      <div class="mission-page-kbd-hints">
        <span><kbd>&uarr;</kbd><kbd>&darr;</kbd> navigate</span>
        <span><kbd>&crarr;</kbd> set spec</span>
        <span><kbd>esc</kbd> close</span>
      </div>
      <div class="mission-page-footer-actions">
        <button type="button" class="mission-page-cancel">Cancel</button>
        <button type="button" class="mission-page-submit" ${canSubmit(s) ? "" : "disabled"}>Set spec</button>
      </div>
    `;
    this.pageHost.appendChild(footer);

    this.bindEvents(visible);

    if (restoreClass) {
      const next = this.pageHost.querySelector<HTMLInputElement>("." + restoreClass);
      if (next) {
        next.focus();
        if (caretStart != null) {
          try { next.setSelectionRange(caretStart, caretEnd ?? caretStart); } catch { /* ignore */ }
        }
      }
    }
  }

  private renderSidebar(visible: PublishedSpec[]): HTMLElement {
    const s = this.state;
    const aside = document.createElement("aside");
    aside.className = "mission-page-sidebar";
    aside.innerHTML = `
      <div class="mission-page-search-row">
        <input type="search" class="mission-page-search" placeholder="Search specs…"
               autocomplete="off" spellcheck="false" value="${escapeAttr(s.query)}" />
      </div>
      ${this.renderError()}
      ${this.renderKindTabs(visible)}
      <div class="mission-page-groups">
        ${this.renderInProgressGroup()}
        ${this.renderPublishedGroup(visible)}
        ${this.renderSuperpowersGroup()}
        ${this.renderDraftsGroup()}
      </div>
      ${this.renderPathRow()}
    `;
    return aside;
  }

  /** Kind-filter tab row (DESIGN.md's registry/catalog tab convention): one
   *  active kind narrows the list below to a flat feed, replacing the old
   *  per-section fold state — there's nothing left to expand/collapse. */
  private renderKindTabs(visible: PublishedSpec[]): string {
    const s = this.state;
    const q = s.query.trim().toLowerCase();
    const ipCount = q ? s.inProgress.filter((d) => draftLabel(d).toLowerCase().includes(q)).length : s.inProgress.length;
    const pubCount = visible.length;
    const spCount = q
      ? s.superpowers.filter((e) => {
          const { title } = humanizeSpecFilename(e.spec_filename);
          return (
            title.toLowerCase().includes(q) ||
            e.spec_filename.toLowerCase().includes(q) ||
            (e.goal_preview ?? "").toLowerCase().includes(q)
          );
        }).length
      : s.superpowers.length;
    const draftCount = q ? s.drafts.filter((d) => d.title.toLowerCase().includes(q)).length : s.drafts.length;

    const tabs: Array<{ key: KindTab; label: string; count: number; icon: string; hide?: boolean }> = [
      { key: "all", label: "All", count: ipCount + pubCount + spCount + draftCount, icon: "" },
      { key: "inprogress", label: "In progress", count: ipCount, icon: Icons.history({ size: 12 }), hide: s.inProgress.length === 0 },
      { key: "published", label: "Published", count: pubCount, icon: Icons.fileText({ size: 12 }) },
      { key: "superpowers", label: "Superpowers", count: spCount, icon: "&#10022;", hide: s.superpowers.length === 0 },
      { key: "drafts", label: "Drafts", count: draftCount, icon: Icons.filePen({ size: 12 }), hide: s.drafts.length === 0 },
    ];
    return `<div class="mission-page-kind-tabs" role="tablist">
      ${tabs.filter((t) => !t.hide).map((t) => `
        <button type="button" class="mission-page-kind-tab ${this.activeKindTab === t.key ? "is-active" : ""}"
                data-kind="${t.key}" role="tab" aria-selected="${this.activeKindTab === t.key}">
          ${t.icon ? `<span class="mission-page-kind-tab-ico" aria-hidden="true">${t.icon}</span>` : ""}
          ${escapeHtml(t.label)}
          <span class="mission-page-kind-tab-ct">${t.count}</span>
        </button>`).join("")}
    </div>`;
  }

  /** Wraps one kind's rows. Renders "" when a different tab is active — the
   *  label + count only show up in "All", where the active tab isn't already
   *  saying what's listed. */
  private group(kind: KindTab, title: string, count: string, bodyHTML: string, actionHTML = ""): string {
    if (this.activeKindTab !== "all" && this.activeKindTab !== kind) return "";
    if (this.activeKindTab !== "all") {
      return `<div class="mission-page-group" data-kind="${kind}">
        ${actionHTML ? `<div class="mission-page-group-action-row">${actionHTML}</div>` : ""}
        <div class="mission-page-list">${bodyHTML}</div>
      </div>`;
    }
    return `<div class="mission-page-group" data-kind="${kind}">
      <div class="mission-page-group-head">
        <span class="mission-page-group-title">${escapeHtml(title)}</span>
        ${count ? `<span class="mission-page-group-count">${escapeHtml(count)}</span>` : ""}
        ${actionHTML ? `<span class="mission-page-group-action">${actionHTML}</span>` : ""}
      </div>
      <div class="mission-page-list">${bodyHTML}</div>
    </div>`;
  }

  private renderInProgressGroup(): string {
    const s = this.state;
    if (s.loading || s.inProgress.length === 0) return "";
    const q = s.query.trim().toLowerCase();
    const filtered = q
      ? s.inProgress.filter((d) => draftLabel(d).toLowerCase().includes(q))
      : s.inProgress;
    const count = q && filtered.length !== s.inProgress.length
      ? `${filtered.length}/${s.inProgress.length}`
      : `${s.inProgress.length}`;
    if (filtered.length === 0) {
      return this.group("inprogress", "In progress", count, `<div class="mission-page-empty">No matches for "${escapeHtml(s.query)}".</div>`);
    }
    const items = filtered.map((d) => `
      <button type="button" class="mission-page-spec mission-page-wip-row" data-draft="${escapeAttr(d.id)}"
              data-tip="Resume in Spec Creator">
        <span class="mission-page-id">${d.status === "Ready" ? "RDY" : "WIP"}</span>
        <span class="mission-page-spec-body">
          <span class="mission-page-spec-title">${escapeHtml(draftLabel(d))}</span>
          <span class="mission-page-spec-goal">${escapeHtml(draftMeta(d))}</span>
        </span>
        <span class="mission-page-badge mission-page-badge-wip">${escapeHtml(phaseBadge(d.status))}</span>
      </button>
    `).join("");
    return this.group("inprogress", "In progress", count, items);
  }

  private renderError(): string {
    if (!this.state.error) return "";
    return `<div class="mission-page-error">
      Failed to load: ${escapeHtml(this.state.error)}
      <button type="button" class="mission-page-retry">Retry</button>
    </div>`;
  }

  private renderPublishedGroup(visible: PublishedSpec[]): string {
    const s = this.state;
    const specAction = `<button type="button" class="mission-page-sp-new" data-action="spec-new">✦ Spec Creator</button>`;
    if (s.loading) {
      return `<div class="mission-page-group" data-kind="published">
        <div class="mission-page-group-head"><span class="mission-page-group-title">Published</span></div>
        <div class="mission-page-skeleton">${"<div class=\"skel-row\"></div>".repeat(3)}</div>
      </div>`;
    }
    if (s.specs.length === 0) {
      const body = `<div class="mission-page-empty">
          No published specs yet. Start the
          <button type="button" class="mission-page-link" data-action="spec-new">Spec Creator (${formatChord(["mod", "N"])})</button>,
          or write one in
          <button type="button" class="mission-page-link" data-action="open-drafts">Drafts (${formatChord(["mod", "shift", "D"])})</button>.
        </div>`;
      return this.group("published", "Published", "0", body, specAction);
    }
    if (visible.length === 0) {
      const body = `<div class="mission-page-empty">No matches for "${escapeHtml(s.query)}".</div>`;
      return this.group("published", "Published", `0/${s.specs.length}`, body, specAction);
    }
    const cards = visible.map((spec) => {
      const isSelected = s.selected?.source === "card" && s.selected.path === spec.path;
      const isCurrent = spec.path === (this.opts?.currentMissionPath ?? null);
      const isNew = isRecentlyUpdated(spec.updated_at);
      return `
        <button type="button" class="mission-page-spec ${isSelected ? "selected" : ""} ${isNew ? "is-new" : ""}"
                data-path="${escapeAttr(spec.path)}">
          <span class="mission-page-id">${escapeHtml(spec.id)}</span>
          <span class="mission-page-spec-body">
            <span class="mission-page-spec-title">${escapeHtml(spec.title)}</span>
            <span class="mission-page-spec-goal">${escapeHtml(spec.goal)}</span>
          </span>
          <span class="mission-page-badges">
            ${this.scoreBadgeHtml(spec.path)}
            ${spec.worktree_label ? `<span class="mission-page-badge mission-page-badge-wt">${escapeHtml(spec.worktree_label)}</span>` : ""}
            ${isCurrent ? `<span class="mission-page-badge mission-page-badge-current" data-tip="Currently set on this tab">current</span>` : ""}
            ${!isCurrent && isNew ? `<span class="mission-page-dot-new" data-tip="Updated in the last 24h"></span>` : ""}
          </span>
        </button>
      `;
    }).join("");
    const count = visible.length !== s.specs.length ? `${visible.length}/${s.specs.length}` : `${visible.length}`;
    return this.group("published", "Published", count, cards, specAction);
  }

  private scoreBadgeHtml(path: string): string {
    const s = this.scoreCache.get(path);
    return s ? `<span class="spec-score-badge" data-grade="${s.grade}" data-tip="${escapeAttr(GRADE_TOOLTIP)}">${s.score} ${s.grade}</span>` : "";
  }

  /** Compute SpecScores for visible rows that lack one; re-render once when any
   *  land. Unreadable specs cache as null so failures don't retry every render. */
  private async fillScores(visible: PublishedSpec[]): Promise<void> {
    const missing = visible.filter((s) => !this.scoreCache.has(s.path));
    if (missing.length === 0) return;
    const generation = this.openGeneration;
    let landed = false;
    await Promise.all(
      missing.map(async (s) => {
        try {
          const { body } = await draftsApi.readSpecBody(s.path, 65536);
          this.scoreCache.set(s.path, scoreSpec(body));
          landed = true;
        } catch {
          this.scoreCache.set(s.path, null);
        }
      }),
    );
    if (landed && generation === this.openGeneration && this.isOpenState) this.render();
  }

  private renderSuperpowersGroup(): string {
    const s = this.state;
    if (s.loading || s.superpowers.length === 0) return "";
    const q = s.query.trim().toLowerCase();
    const filtered = q
      ? s.superpowers.filter((e) => {
          const { title } = humanizeSpecFilename(e.spec_filename);
          return (
            title.toLowerCase().includes(q) ||
            e.spec_filename.toLowerCase().includes(q) ||
            (e.goal_preview ?? "").toLowerCase().includes(q)
          );
        })
      : s.superpowers;
    const countLabel = q && filtered.length !== s.superpowers.length
      ? `${filtered.length}/${s.superpowers.length}`
      : `${s.superpowers.length}`;
    const spAction = `<button type="button" class="mission-page-sp-new" data-action="sp-new">+ New Superpowers mission</button>`;
    if (filtered.length === 0) {
      const body = `<div class="mission-page-empty">No matches for "${escapeHtml(s.query)}".</div>`;
      return this.group("superpowers", "Superpowers", countLabel, body, spAction);
    }
    const items = filtered.map((e) => {
      const { title, date } = humanizeSpecFilename(e.spec_filename);
      const goal = cleanGoalPreview(e.goal_preview ?? "");
      const planMissing = !e.plan_path;
      const statusBadge = planMissing
        ? `<span class="mission-page-badge mission-page-badge--missing mission-page-plan-missing"
                   role="button" tabindex="0"
                   data-spec="${escapeAttr(e.spec_path)}"
                   data-tip="Generate a plan with the writing-plans skill">no plan</span>`
        : `<span class="mission-page-status-ok" data-tip="Spec ✓ · Plan ✓" aria-label="ready">✓</span>`;
      return `
        <button type="button" class="mission-page-spec mission-page-sp-row"
                data-spec="${escapeAttr(e.spec_path)}"
                data-plan="${escapeAttr(e.plan_path ?? "")}"
                data-tip="${escapeAttr(e.spec_filename)}">
          <span class="mission-page-id">${escapeHtml(date)}</span>
          <span class="mission-page-spec-body">
            <span class="mission-page-spec-title">${escapeHtml(title)}</span>
            <span class="mission-page-spec-goal">${goal ? escapeHtml(goal) : "&nbsp;"}</span>
          </span>
          ${e.worktree_label ? `<span class="mission-page-badge mission-page-badge-wt">${escapeHtml(e.worktree_label)}</span>` : ""}
          ${statusBadge}
        </button>
      `;
    }).join("");
    return this.group("superpowers", "Superpowers", countLabel, items, spAction);
  }

  private renderDraftsGroup(): string {
    const s = this.state;
    if (s.drafts.length === 0) return "";
    const q = s.query.trim().toLowerCase();
    const filtered = q ? s.drafts.filter((d) => d.title.toLowerCase().includes(q)) : s.drafts;
    const count = q && filtered.length !== s.drafts.length ? `${filtered.length}/${s.drafts.length}` : `${s.drafts.length}`;
    if (filtered.length === 0) {
      return this.group("drafts", "Drafts", count, `<div class="mission-page-empty">No matches for "${escapeHtml(s.query)}".</div>`);
    }
    const items = filtered.map((d) => `
      <div class="mission-page-draft" data-slug="${escapeAttr(d.slug)}">
        <span class="mission-page-spec-title">${escapeHtml(d.title)}</span>
        ${d.worktree_label
          // Publishing resolves the slug against the CURRENT worktree, so it
          // can only act on drafts that live here. Elsewhere: label, no button.
          ? `<span class="mission-page-badge mission-page-badge-wt">${escapeHtml(d.worktree_label)}</span>`
          : `<button type="button" class="mission-page-publish" data-slug="${escapeAttr(d.slug)}">Publish to use</button>`}
      </div>
    `).join("");
    return this.group("drafts", "Drafts", count, items);
  }

  /** Folded by default — stays out of the way until the user actually needs to
   *  paste an arbitrary path; open already if one's mid-edit (input non-empty). */
  private renderPathRow(): string {
    const s = this.state;
    const open = this.pathRowOpen || s.inputValue.trim().length > 0;
    return `
      <div class="mission-page-pathrow">
        <button type="button" class="mission-page-path-toggle" aria-expanded="${open}">
          ${Icons.fileText({ size: 12 })} Or paste a file path…
        </button>
        <div class="mission-page-path-controls" ${open ? "" : "hidden"}>
          <input type="text" class="mission-page-input"
                 autocomplete="off" spellcheck="false"
                 placeholder="/absolute/path/to/spec.md"
                 value="${escapeAttr(s.inputValue)}" />
          <button type="button" class="mission-page-browse">Browse…</button>
        </div>
      </div>
    `;
  }

  private renderPreview(): HTMLElement {
    const main = document.createElement("main");
    main.className = "mission-page-preview";
    if (!this.previewPath) {
      main.innerHTML = `
        <div class="mission-page-preview-empty mission-page-preview-empty--hero">
          <span class="mission-page-preview-empty-icon" aria-hidden="true">${Icons.target({ size: 40 })}</span>
          <h3>Select a spec</h3>
          <p>Pick a published spec, a Superpowers spec, or paste a Markdown path to preview it here before setting it on the tab.</p>
        </div>`;
      return main;
    }
    if (this.previewLoading) {
      main.innerHTML = `<div class="mission-page-preview-empty">Loading…</div>`;
      return main;
    }
    if (this.previewError) {
      main.innerHTML = `<div class="mission-page-preview-empty">File not found — will be set as path-only mission.</div>`;
      return main;
    }
    const truncatedNote = this.previewTruncated
      ? `<div class="mission-page-preview-truncated">⚠ Truncated (file > 200 KB)</div>`
      : "";
    main.innerHTML = `${truncatedNote}<article class="mission-page-preview-body markdown-body markdown-doc">${renderMarkdown(this.previewBody)}</article>`;
    // SpecScore header — any published spec (it already has a badge in the
    // list) or any doc with a Goal heading, numbered or not; other arbitrary
    // markdown previews stay unscored.
    if (this.scoreCache.get(this.previewPath) || /^#{1,3}\s+(?:\d+[.)]\s*)?Goal\b/m.test(this.previewBody)) {
      const body = this.previewBody;
      let score = scoreSpec(body);
      const bar = document.createElement("div");
      bar.className = "mission-page-preview-score";
      const chip = makeSpecScoreChip();
      chip.update(score);
      let breakdown: HTMLElement | null = null;
      const renderBk = () => {
        const next = renderBreakdown(score, {
          onDeep: async () => {
            score = await deepScore(body, score);
            chip.update(score);
            if (breakdown) renderBk();
          },
        });
        if (breakdown) breakdown.replaceWith(next);
        else bar.after(next);
        breakdown = next;
      };
      chip.setOnClick(() => {
        if (breakdown) {
          breakdown.remove();
          breakdown = null;
        } else {
          renderBk();
        }
      });
      bar.append(chip.el);
      main.prepend(bar);
    }
    return main;
  }

  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  private bindEvents(visible: PublishedSpec[]): void {
    const host = this.pageHost;

    host.querySelector(".mission-page-close")?.addEventListener("click", () => this.finish(null));
    host.querySelector(".mission-page-cancel")?.addEventListener("click", () => this.finish(null));
    host.querySelector(".mission-page-submit")?.addEventListener("click", () => this.submit());
    host.querySelector(".mission-page-retry")?.addEventListener("click", () => {
      this.setState({ loading: true, error: null });
      void this.fetchAll();
    });

    const search = host.querySelector<HTMLInputElement>(".mission-page-search");
    if (search) {
      search.addEventListener("input", () => {
        this.state = { ...this.state, query: search.value };
        this.render();
      });
    }

    host.querySelectorAll<HTMLButtonElement>(".mission-page-spec[data-path]").forEach((btn) => {
      const path = btn.dataset.path!;
      btn.addEventListener("click", () => {
        this.state = selectCard(this.state, path);
        void this.loadPreview(path);
        this.render();
      });
      btn.addEventListener("dblclick", () => {
        this.state = selectCard(this.state, path);
        this.submit();
      });
    });

    // In-progress Spec Creator drafts → resume the immersive creator on that draft.
    host.querySelectorAll<HTMLButtonElement>(".mission-page-wip-row").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const draftId = btn.dataset.draft;
        if (!draftId) return;
        this.finish(null);
        window.dispatchEvent(new CustomEvent("spec-chat:open", { detail: { draftId } }));
      });
    });

    host.querySelectorAll<HTMLButtonElement>(".mission-page-kind-tab").forEach((btn) => {
      const kind = btn.dataset.kind as KindTab | undefined;
      btn.addEventListener("click", () => {
        if (!kind || this.activeKindTab === kind) return;
        this.activeKindTab = kind;
        this.render();
      });
    });

    host.querySelector<HTMLButtonElement>(".mission-page-current-jump")?.addEventListener("click", () => {
      if (!this.opts?.currentMissionPath) return;
      const path = this.opts.currentMissionPath;
      this.activeKindTab = "published";
      this.state = selectCard(this.state, path);
      void this.loadPreview(path);
      this.render();
      this.pageHost.querySelector(`.mission-page-spec[data-path="${CSS.escape(path)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });

    host.querySelector<HTMLButtonElement>(".mission-page-path-toggle")?.addEventListener("click", () => {
      this.pathRowOpen = !this.pathRowOpen;
      this.render();
    });

    // Rows use a custom `data-tip` attribute (never native `title=`), all wired
    // through the shared attachTooltip so they behave like the rest of chrome.
    host.querySelectorAll<HTMLElement>("[data-tip]").forEach((el) => {
      const tip = el.dataset.tip;
      if (tip) attachTooltip(el, tip, { placement: "right" });
    });

    host.querySelectorAll<HTMLButtonElement>(".mission-page-sp-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        const specPath = btn.dataset.spec ?? "";
        const planPath = btn.dataset.plan ?? "";
        if (!specPath) return;
        this.finish({
          kind: "setRef",
          mref: {
            kind: "superpowers",
            spec_path: specPath,
            plan_path: planPath.length > 0 ? planPath : null,
          },
        });
      });
    });

    host.querySelectorAll<HTMLElement>(".mission-page-plan-missing").forEach((btn) => {
      const trigger = (e: Event) => {
        e.stopPropagation();
        const specPath = btn.dataset.spec ?? "";
        if (!specPath) return;
        this.finish({
          kind: "spawnTab",
          initialCommand: `Use the writing-plans skill to create the plan for ${specPath}`,
        });
      };
      btn.addEventListener("click", trigger);
      btn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") trigger(e);
      });
    });

    host.querySelector<HTMLButtonElement>('[data-action="sp-new"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      this.finish({ kind: "newSuperpowersMission" });
    });

    host.querySelectorAll<HTMLButtonElement>(".mission-page-publish").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const slug = btn.dataset.slug!;
        this.finish({ kind: "publishDraft", slug });
      });
    });

    const input = host.querySelector<HTMLInputElement>(".mission-page-input");
    if (input) {
      input.addEventListener("input", () => {
        this.state = typeInput(this.state, input.value);
        this.render();
      });
    }

    host.querySelector(".mission-page-browse")?.addEventListener("click", async () => {
      if (!this.opts) return;
      const picked = await this.opts.onBrowse();
      if (picked) {
        this.state = typeInput(this.state, picked);
        this.render();
      }
    });

    host.querySelector('[data-action="open-drafts"]')?.addEventListener("click", () => {
      this.finish(null);
      window.dispatchEvent(new CustomEvent("drafts:toggle"));
    });

    // Launch the AI Spec Creator (spec-chat). Mirrors the open-drafts pattern:
    // close the picker, then open the overlay. There can be two of these
    // (the section-head button + the inline empty-state link), so bind all.
    host.querySelectorAll<HTMLButtonElement>('[data-action="spec-new"]').forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.finish(null);
        window.dispatchEvent(new CustomEvent("spec-chat:open"));
      });
    });

    if (this.keyHandler) window.removeEventListener("keydown", this.keyHandler, true);
    this.keyHandler = (e: KeyboardEvent) => {
      if (!this.isOpenState) return;
      if (e.key === "Escape") { e.preventDefault(); this.finish(null); return; }
      if (e.key === "Enter" && canSubmit(this.state)) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        // Don't hijack Enter inside the path text input — let user paste/edit freely.
        if (tag === "INPUT") return;
        e.preventDefault();
        this.submit();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = navigate(this.state, e.key === "ArrowDown" ? 1 : -1, visible);
        this.state = next;
        if (next.selected?.source === "card") void this.loadPreview(next.selected.path);
        this.render();
        return;
      }
      if (e.metaKey && !e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        host.querySelector<HTMLInputElement>(".mission-page-search")?.focus();
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        const active = document.activeElement;
        if (!active || !active.classList.contains("mission-page-input")) {
          e.preventDefault();
          host.querySelector<HTMLInputElement>(".mission-page-input")?.focus();
        }
      }
    };
    window.addEventListener("keydown", this.keyHandler, true);
  }

  private submit(): void {
    const p = effectivePath(this.state);
    if (!p) return;
    this.finish({ kind: "set", path: p });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

function escapeAttr(s: string): string { return escapeHtml(s); }

/** Spec was created/modified within the last 24h — flag it as "new". */
const RECENT_SPEC_WINDOW_MS = 24 * 60 * 60 * 1000;
function isRecentlyUpdated(updatedAt: string | undefined): boolean {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < RECENT_SPEC_WINDOW_MS;
}

function cleanGoalPreview(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^>\s*/, "");
  s = s.replace(/^\*\*Date:\*\*\s*\d{4}-\d{2}-\d{2}\s*/i, "");
  s = s.replace(/^Date:\s*\d{4}-\d{2}-\d{2}\s*/i, "");
  s = s.replace(/\*\*/g, "");
  return s.trim();
}

/** Title for a Spec Creator draft: first line of its opening user message. */
function draftLabel(d: SpecDraftSummary): string {
  const firstUser = d.messages.find((m) => m.role === "User");
  const t = (firstUser?.content ?? "").trim().split("\n")[0]?.trim() ?? "";
  if (!t) return "Untitled draft";
  return t.length > 56 ? t.slice(0, 56) + "…" : t;
}

function draftMeta(d: SpecDraftSummary): string {
  const n = d.messages.length;
  return `${n} message${n === 1 ? "" : "s"} · ${relTime(d.last_updated)}`;
}

/** Right-hand badge text: the phase for in-progress drafts, else "ready". */
function phaseBadge(status: SpecDraftSummary["status"]): string {
  if (status === "Ready") return "ready";
  if (typeof status === "object" && "InProgress" in status) return status.InProgress.phase;
  return "draft";
}

function relTime(iso: string): string {
  const dt = Date.now() - new Date(iso).getTime();
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

export function humanizeSpecFilename(filename: string): { title: string; date: string } {
  // Strip extension
  let base = filename.replace(/\.md$/i, "");
  // Extract leading YYYY-MM-DD
  const dateMatch = base.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  let date = "";
  if (dateMatch) {
    date = dateMatch[1]!.slice(5); // MM-DD
    base = dateMatch[2]!;
  }
  // Strip trailing -design / -plan / -spec
  base = base.replace(/-(design|plan|spec)$/i, "");
  // dashes → spaces, capitalize first
  const title = base.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  return { title, date };
}

export function openNewSuperpowersTopicModal(): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "mission-page-newmodal";
    modal.innerHTML = `
      <h4>New Superpowers mission</h4>
      <label>Topic <input type="text" id="sp-topic" placeholder="what do you want to brainstorm?" /></label>
      <div class="mission-page-newmodal-actions">
        <button type="button" id="sp-cancel">Cancel</button>
        <button type="button" id="sp-create">Create tab</button>
      </div>
    `;
    document.body.appendChild(modal);
    const input = modal.querySelector<HTMLInputElement>("#sp-topic")!;
    input.focus();
    const close = (val: string | null): void => { modal.remove(); resolve(val); };
    modal.querySelector<HTMLButtonElement>("#sp-cancel")!.addEventListener("click", () => close(null));
    modal.querySelector<HTMLButtonElement>("#sp-create")!.addEventListener("click", () => {
      const v = input.value.trim();
      close(v || null);
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); close(input.value.trim() || null); }
      else if (ev.key === "Escape") { ev.preventDefault(); close(null); }
    });
  });
}
