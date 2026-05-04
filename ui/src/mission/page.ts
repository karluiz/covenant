import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { draftsApi } from "../drafts/api";
import type { DraftSummary, PublishedSpec } from "../drafts/api";
import { listSuperpowersMissions, type MissionRef } from "../api";
import type { SuperpowersMissionEntry } from "../api";
import { Icons } from "../icons";
import { renderMarkdown } from "./preview";

export type SelectedRef =
  | { source: "card"; path: string }
  | { source: "input"; path: string }
  | null;

export interface PageState {
  specs: PublishedSpec[];
  drafts: DraftSummary[];
  superpowers: SuperpowersMissionEntry[];
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
  private state: PageState = initialState(null);
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
    void this.fetchAll();
    void this.subscribeSuperpowers();
    return promise;
  }

  close(): void { this.finish(null); }

  private finish(result: PageResult): void {
    if (!this.isOpenState) return;
    if (this.keyHandler) {
      window.removeEventListener("keydown", this.keyHandler);
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
    this.state = { ...this.state, ...patch };
    this.render();
  }

  private async fetchAll(): Promise<void> {
    if (!this.opts) return;
    const root = this.opts.repoRoot;
    try {
      const [specs, drafts, superpowers] = await Promise.all([
        draftsApi.listPublishedSpecs(root),
        draftsApi.list(root),
        listSuperpowersMissions(root).catch(() => []),
      ]);
      this.setState({ specs, drafts, superpowers, loading: false, error: null });
      const sel = this.state.selected;
      if (sel?.source === "card") void this.loadPreview(sel.path);
    } catch (err) {
      this.setState({ loading: false, error: String(err) });
    }
  }

  private async subscribeSuperpowers(): Promise<void> {
    if (!this.opts) return;
    const root = this.opts.repoRoot;
    try {
      this.unlistenSp = await listen("superpowers-missions-changed", () => {
        listSuperpowersMissions(root)
          .then((superpowers) => this.setState({ superpowers }))
          .catch(() => {});
      });
    } catch { /* ignore */ }
  }

  private async loadPreview(path: string): Promise<void> {
    this.previewPath = path;
    this.previewLoading = true;
    this.previewError = null;
    this.render();
    try {
      const r = await draftsApi.readSpecBody(path);
      // Race-guard: skip if user moved on to another card.
      if (this.previewPath !== path) return;
      this.previewBody = r.body;
      this.previewTruncated = r.truncated;
      this.previewLoading = false;
      this.render();
    } catch (err) {
      if (this.previewPath !== path) return;
      this.previewBody = "";
      this.previewError = String(err);
      this.previewLoading = false;
      this.render();
    }
  }

  private render(): void {
    const s = this.state;
    const visible = filterSpecs(s.specs, s.query);
    this.pageHost.innerHTML = "";

    const header = document.createElement("header");
    header.className = "mission-page-header";
    header.innerHTML = `
      <h2 class="mission-page-title">Set mission</h2>
      <button type="button" class="mission-page-close" aria-label="Close" title="Close (Esc)">${Icons.x({ size: 14 })}</button>
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
      <button type="button" class="mission-page-submit" ${canSubmit(s) ? "" : "disabled"}>Set mission</button>
    `;
    this.pageHost.appendChild(footer);

    this.bindEvents(visible);
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
      ${this.renderPublishedSection(visible)}
      ${this.renderSuperpowersSection()}
      ${this.renderDraftsSection()}
      ${this.renderPathRow()}
    `;
    return aside;
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
    if (s.loading) {
      return `<section class="mission-page-section">
        <h4>Published</h4>
        <div class="mission-page-skeleton">${"<div class=\"skel-row\"></div>".repeat(3)}</div>
      </section>`;
    }
    if (s.specs.length === 0) {
      return `<section class="mission-page-section">
        <h4>Published (0)</h4>
        <div class="mission-page-empty">
          No published specs yet. Write one in
          <button type="button" class="mission-page-link" data-action="open-drafts">Drafts (⌘⇧D)</button>.
        </div>
      </section>`;
    }
    if (visible.length === 0) {
      return `<section class="mission-page-section">
        <h4>Published (${s.specs.length})</h4>
        <div class="mission-page-empty">No matches for "${escapeHtml(s.query)}".</div>
      </section>`;
    }
    const cards = visible.map((spec) => {
      const isSelected = s.selected?.source === "card" && s.selected.path === spec.path;
      const isCurrent = spec.path === (this.opts?.currentMissionPath ?? null);
      return `
        <button type="button" class="mission-page-spec ${isSelected ? "selected" : ""}"
                data-path="${escapeAttr(spec.path)}">
          <span class="mission-page-id">${escapeHtml(spec.id)}</span>
          <span class="mission-page-spec-body">
            <span class="mission-page-spec-title">${escapeHtml(spec.title)}</span>
            <span class="mission-page-spec-goal">${escapeHtml(spec.goal)}</span>
          </span>
          ${isCurrent ? `<span class="mission-page-badge">current</span>` : ""}
        </button>
      `;
    }).join("");
    return `<section class="mission-page-section">
      <h4>Published (${visible.length}${visible.length !== s.specs.length ? `/${s.specs.length}` : ""})</h4>
      <div class="mission-page-list">${cards}</div>
    </section>`;
  }

  private renderSuperpowersSection(): string {
    const s = this.state;
    if (s.loading || s.superpowers.length === 0) return "";
    const items = s.superpowers.map((e) => {
      const planBadge = e.plan_path
        ? `<span class="mission-page-badge mission-page-badge--ok">plan ✓</span>`
        : `<button type="button" class="mission-page-badge mission-page-badge--missing mission-page-plan-missing"
                   data-spec="${escapeAttr(e.spec_path)}"
                   title="Generate plan with writing-plans skill">plan ✗</button>`;
      return `
        <button type="button" class="mission-page-sp-row"
                data-spec="${escapeAttr(e.spec_path)}"
                data-plan="${escapeAttr(e.plan_path ?? "")}">
          <span class="mission-page-spec-title">${escapeHtml(e.spec_filename)}</span>
          <span class="mission-page-spec-goal">${escapeHtml(e.goal_preview)}</span>
          <span class="mission-page-badge mission-page-badge--ok">spec ✓</span>
          ${planBadge}
        </button>
      `;
    }).join("");
    return `<section class="mission-page-section">
      <div class="mission-page-section-head">
        <h4>Superpowers (${s.superpowers.length})</h4>
        <button type="button" class="mission-page-sp-new" data-action="sp-new">+ New Superpowers mission</button>
      </div>
      <div class="mission-page-list">${items}</div>
    </section>`;
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
    return `<details class="mission-page-section mission-page-drafts">
      <summary>Drafts (${s.drafts.length})</summary>
      <div class="mission-page-list">${items}</div>
    </details>`;
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
      main.innerHTML = `<div class="mission-page-preview-empty">Select a spec on the left to preview.</div>`;
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
    main.innerHTML = `${truncatedNote}<article class="mission-page-preview-body">${renderMarkdown(this.previewBody)}</article>`;
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

    host.querySelectorAll<HTMLButtonElement>(".mission-page-spec").forEach((btn) => {
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

    host.querySelectorAll<HTMLButtonElement>(".mission-page-plan-missing").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const specPath = btn.dataset.spec ?? "";
        if (!specPath) return;
        this.finish({
          kind: "spawnTab",
          initialCommand: `Use the writing-plans skill to create the plan for ${specPath}`,
        });
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

    if (this.keyHandler) window.removeEventListener("keydown", this.keyHandler);
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
    window.addEventListener("keydown", this.keyHandler);
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
