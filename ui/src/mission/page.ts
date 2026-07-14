import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { draftsApi } from "../drafts/api";
import type { DraftSummary, PublishedSpec } from "../drafts/api";
import { listSuperpowersMissions, specAuthorListDrafts, type MissionRef } from "../api";
import type { SuperpowersMissionEntry, SpecDraftSummary } from "../api";
import { Icons } from "../icons";
import { renderMarkdown } from "../ui/markdown";

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
  /** Section keys the user has folded shut. Persists across innerHTML re-renders. */
  private collapsed = new Set<string>(["superpowers", "drafts"]);
  private opts: MissionPageOpts | null = null;
  private resolve: ((r: PageResult) => void) | null = null;
  private unlistenSp: UnlistenFn | null = null;
  public onClosed: (() => void) | null = null;

  // Preview pane state — populated lazily by loadPreview() on selection.
  private previewBody = "";
  private previewPath = "";
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
    this.previewBody = "";
    this.previewPath = "";
    this.previewLoading = false;
    this.previewTruncated = false;
    this.previewError = null;
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

    const header = document.createElement("header");
    header.className = "mission-page-header";
    header.innerHTML = `
      <div class="mission-page-titlebar">
        <span class="mission-page-title-icon" aria-hidden="true">${Icons.target({ size: 16 })}</span>
        <div>
          <h2 class="mission-page-title">Set spec</h2>
          <p class="mission-page-subtitle">Choose the spec that anchors this tab.</p>
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
      <button type="button" class="mission-page-cancel">Cancel</button>
      <button type="button" class="mission-page-submit" ${canSubmit(s) ? "" : "disabled"}>Set spec</button>
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
      ${this.renderInProgressSection()}
      ${this.renderPublishedSection(visible)}
      ${this.renderSuperpowersSection()}
      ${this.renderDraftsSection()}
      ${this.renderPathRow()}
    `;
    return aside;
  }

  /** Foldable section wrapper. Open unless the user folded it — or always open
   *  while searching, so matches buried in a folded group stay visible. */
  private section(key: string, title: string, count: string, bodyHTML: string, actionHTML = ""): string {
    const open = this.state.query.trim().length > 0 || !this.collapsed.has(key);
    return `<details class="mission-page-section" data-section="${key}" ${open ? "open" : ""}>
      <summary>
        <span class="mission-page-sec-chevron" aria-hidden="true">${Icons.chevronRight({ size: 12 })}</span>
        <span class="mission-page-sec-title">${escapeHtml(title)}</span>
        ${count ? `<span class="mission-page-sec-count">${escapeHtml(count)}</span>` : ""}
        ${actionHTML ? `<span class="mission-page-sec-action">${actionHTML}</span>` : ""}
      </summary>
      <div class="mission-page-list">${bodyHTML}</div>
    </details>`;
  }

  private renderInProgressSection(): string {
    const s = this.state;
    if (s.loading || s.inProgress.length === 0) return "";
    const q = s.query.trim().toLowerCase();
    const filtered = q
      ? s.inProgress.filter((d) => draftLabel(d).toLowerCase().includes(q))
      : s.inProgress;
    if (filtered.length === 0) return "";
    const items = filtered.map((d) => `
      <button type="button" class="mission-page-spec mission-page-wip-row" data-draft="${escapeAttr(d.id)}"
              title="Resume in Spec Creator">
        <span class="mission-page-id">${d.status === "Ready" ? "RDY" : "WIP"}</span>
        <span class="mission-page-spec-body">
          <span class="mission-page-spec-title">${escapeHtml(draftLabel(d))}</span>
          <span class="mission-page-spec-goal">${escapeHtml(draftMeta(d))}</span>
        </span>
        <span class="mission-page-badge mission-page-badge-wip">${escapeHtml(phaseBadge(d.status))}</span>
      </button>
    `).join("");
    const count = q && filtered.length !== s.inProgress.length
      ? `${filtered.length}/${s.inProgress.length}`
      : `${s.inProgress.length}`;
    return this.section("inprogress", "In progress", count, items);
  }

  private renderError(): string {
    if (!this.state.error) return "";
    return `<div class="mission-page-error">
      Failed to load: ${escapeHtml(this.state.error)}
      <button type="button" class="mission-page-retry">Retry</button>
    </div>`;
  }

  private renderPublishedSection(visible: PublishedSpec[]): string {
    const s = this.state;
    const specAction = `<button type="button" class="mission-page-sp-new" data-action="spec-new">✦ Spec Creator</button>`;
    if (s.loading) {
      return `<section class="mission-page-section">
        <h4>Published</h4>
        <div class="mission-page-skeleton">${"<div class=\"skel-row\"></div>".repeat(3)}</div>
      </section>`;
    }
    if (s.specs.length === 0) {
      const body = `<div class="mission-page-empty">
          No published specs yet. Start the
          <button type="button" class="mission-page-link" data-action="spec-new">Spec Creator (⌘N)</button>,
          or write one in
          <button type="button" class="mission-page-link" data-action="open-drafts">Drafts (⌘⇧D)</button>.
        </div>`;
      return this.section("published", "Published", "0", body, specAction);
    }
    if (visible.length === 0) {
      const body = `<div class="mission-page-empty">No matches for "${escapeHtml(s.query)}".</div>`;
      return this.section("published", "Published", `0/${s.specs.length}`, body, specAction);
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
            ${spec.worktree_label ? `<span class="mission-page-badge mission-page-badge-wt">${escapeHtml(spec.worktree_label)}</span>` : ""}
            ${isCurrent ? `<span class="mission-page-badge">current</span>` : ""}
            ${!isCurrent && isNew ? `<span class="mission-page-badge mission-page-badge-new">new</span>` : ""}
          </span>
        </button>
      `;
    }).join("");
    const count = visible.length !== s.specs.length ? `${visible.length}/${s.specs.length}` : `${visible.length}`;
    return this.section("published", "Published", count, cards, specAction);
  }

  private renderSuperpowersSection(): string {
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
      return this.section("superpowers", "Superpowers", countLabel, body, spAction);
    }
    const items = filtered.map((e) => {
      const { title, date } = humanizeSpecFilename(e.spec_filename);
      const goal = cleanGoalPreview(e.goal_preview ?? "");
      const planMissing = !e.plan_path;
      const statusBadge = planMissing
        ? `<span class="mission-page-badge mission-page-badge--missing mission-page-plan-missing"
                   role="button" tabindex="0"
                   data-spec="${escapeAttr(e.spec_path)}"
                   title="Generate plan with writing-plans skill">no plan</span>`
        : `<span class="mission-page-status-ok" title="spec ✓ · plan ✓" aria-label="ready">✓</span>`;
      return `
        <button type="button" class="mission-page-spec mission-page-sp-row"
                data-spec="${escapeAttr(e.spec_path)}"
                data-plan="${escapeAttr(e.plan_path ?? "")}"
                title="${escapeAttr(e.spec_filename)}">
          <span class="mission-page-id">${escapeHtml(date)}</span>
          <span class="mission-page-spec-body">
            <span class="mission-page-spec-title">${escapeHtml(title)}</span>
            <span class="mission-page-spec-goal">${goal ? escapeHtml(goal) : "&nbsp;"}</span>
          </span>
          ${statusBadge}
        </button>
      `;
    }).join("");
    return this.section("superpowers", "Superpowers", countLabel, items, spAction);
  }

  private renderDraftsSection(): string {
    const s = this.state;
    if (s.drafts.length === 0) return "";
    const items = s.drafts.map((d) => `
      <div class="mission-page-draft" data-slug="${escapeAttr(d.slug)}">
        <span class="mission-page-spec-title">${escapeHtml(d.title)}</span>
        <button type="button" class="mission-page-publish" data-slug="${escapeAttr(d.slug)}">Publish to use</button>
      </div>
    `).join("");
    return this.section("drafts", "Drafts", `${s.drafts.length}`, items);
  }

  private renderPathRow(): string {
    const s = this.state;
    return `
      <section class="mission-page-section mission-page-pathrow">
        <h4>Or pick another file…</h4>
        <div class="mission-page-path-controls">
          <input type="text" class="mission-page-input"
                 autocomplete="off" spellcheck="false"
                 placeholder="/absolute/path/to/spec.md"
                 value="${escapeAttr(s.inputValue)}" />
          <button type="button" class="mission-page-browse">Browse…</button>
        </div>
      </section>
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

    // Persist fold state across the innerHTML wipe render() does on every keystroke.
    host.querySelectorAll<HTMLDetailsElement>("details.mission-page-section").forEach((det) => {
      const key = det.dataset.section;
      if (!key) return;
      det.addEventListener("toggle", () => {
        if (det.open) this.collapsed.delete(key);
        else this.collapsed.add(key);
      });
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
