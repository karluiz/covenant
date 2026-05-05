// DraftsPanel — full-page panel for creating and managing mission spec drafts.
// Mirrors DocsPanel: shares the #layout grid row 2 with #workspace,
// #settings-page, and #docs-page; when open it replaces the workspace.
// Closing requires Esc or the × button (wired in main.ts).

import { draftsApi, type DraftSummary, type PublishedSpec } from "./api";
import { Icons } from "../icons";
import { DraftWizard } from "./wizard";

type View = "list" | "wizard";
type Tab = "drafts" | "published";

export class DraftsPanel {
  private isOpenState = false;
  private view: View = "list";
  private tab: Tab = "drafts";
  private currentSlug: string | null = null;
  private wizard: DraftWizard | null = null;
  private wizardOpts: { autoPublish?: boolean; initialBody?: string } = {};
  public onClosed: (() => void) | null = null;
  public getRepoRoot: () => string = () => ".";

  constructor(
    private readonly pageHost: HTMLElement,
    private readonly workspace: HTMLElement,
  ) {
    pageHost.classList.add("drafts-page");
  }

  isOpen(): boolean {
    return this.isOpenState;
  }

  toggle(): void {
    this.isOpenState ? this.close() : this.open();
  }

  open(): void {
    this.isOpenState = true;
    this.pageHost.hidden = false;
    this.workspace.hidden = true;
    this.view = "list";
    this.currentSlug = null;
    void this.render();
  }

  close(): void {
    this.isOpenState = false;
    this.pageHost.hidden = true;
    this.workspace.hidden = false;
    this.wizard?.dispose();
    this.wizard = null;
    this.onClosed?.();
  }

  openWizard(slug: string | null, opts?: { autoPublish?: boolean; initialBody?: string }): void {
    this.view = "wizard";
    this.currentSlug = slug;
    this.wizardOpts = opts ?? {};
    void this.render();
  }

  private async render(): Promise<void> {
    if (this.view === "list") {
      await this.renderList();
    } else {
      await this.renderWizard();
    }
  }

  private async renderList(): Promise<void> {
    const root = this.getRepoRoot();
    const tabsHtml = `
      <nav class="drafts-tabs" role="tablist">
        <button type="button" role="tab" data-tab="drafts"
          aria-selected="${this.tab === "drafts"}"
          class="drafts-tab${this.tab === "drafts" ? " is-active" : ""}">Drafts</button>
        <button type="button" role="tab" data-tab="published"
          aria-selected="${this.tab === "published"}"
          class="drafts-tab${this.tab === "published" ? " is-active" : ""}">Published</button>
      </nav>
    `;
    const headerHtml = (newButton: boolean): string => `
      <div class="drafts-topbar">
        <header class="drafts-header">
          <h1>${this.tab === "drafts" ? "Drafts" : "Published specs"}</h1>
          <div class="drafts-actions">
            ${newButton ? `<button id="drafts-new-chat" type="button" class="drafts-secondary">${Icons.sparkles({ size: 12 })}<span>New via chat</span></button><button id="drafts-new" type="button" class="drafts-primary">${Icons.plus({ size: 13 })}<span>New draft</span></button>` : ""}
            <button id="drafts-close" type="button" class="drafts-close" aria-label="Close">×</button>
          </div>
        </header>
        ${tabsHtml}
      </div>
    `;

    if (this.tab === "drafts") {
      let drafts: DraftSummary[] = [];
      try {
        drafts = await draftsApi.list(root);
      } catch (e) {
        this.pageHost.innerHTML = `${headerHtml(true)}<div class="drafts-empty">Failed to list drafts: ${escapeHtml(String(e))}</div>`;
        this.bindCommonHeader();
        return;
      }
      const rows = drafts
        .map(
          (d) => `
        <li class="drafts-row" data-slug="${escapeAttr(d.slug)}">
          <button class="drafts-row-open" type="button" data-action="open">
            <span class="drafts-row-title">${escapeHtml(d.title)}</span>
            <span class="drafts-row-meta">${escapeHtml(formatDate(d.updated_at))}</span>
          </button>
          <button class="drafts-row-delete" type="button" data-action="delete" title="Delete">×</button>
        </li>
      `,
        )
        .join("");
      this.pageHost.innerHTML = `
        ${headerHtml(true)}
        <ul class="drafts-list${rows ? "" : " drafts-list--empty"}">
          ${rows || `<li class="drafts-empty">No drafts yet. Click <strong>+ New draft</strong> to start.</li>`}
        </ul>
      `;
      this.bindCommonHeader();
      this.pageHost
        .querySelector("#drafts-new")
        ?.addEventListener("click", () => this.openWizard(null));
      this.pageHost
        .querySelector("#drafts-new-chat")
        ?.addEventListener("click", () => {
          window.dispatchEvent(new CustomEvent("spec-chat:open"));
        });
      this.pageHost
        .querySelectorAll<HTMLLIElement>(".drafts-row")
        .forEach((row) => {
          const slug = row.dataset["slug"]!;
          row
            .querySelector('[data-action="open"]')
            ?.addEventListener("click", () => this.openWizard(slug));
          row
            .querySelector('[data-action="delete"]')
            ?.addEventListener("click", async (e) => {
              e.stopPropagation();
              if (!confirm(`Delete draft "${slug}"? Git history is preserved.`))
                return;
              await draftsApi.delete(this.getRepoRoot(), slug);
              await this.renderList();
            });
        });
      return;
    }

    // tab === "published"
    let published: PublishedSpec[] = [];
    try {
      published = await draftsApi.listPublishedSpecs(root);
    } catch (e) {
      this.pageHost.innerHTML = `${headerHtml(false)}<div class="drafts-empty">Failed to list published specs: ${escapeHtml(String(e))}</div>`;
      this.bindCommonHeader();
      return;
    }
    const rows = published
      .map(
        (p) => `
      <li class="drafts-row drafts-row--published" title="${escapeAttr(p.path)}">
        <div class="drafts-row-published-body">
          <span class="drafts-row-id">${escapeHtml(p.id)}</span>
          <span class="drafts-row-title">${escapeHtml(p.title)}</span>
          <span class="drafts-row-goal">${escapeHtml(p.goal)}</span>
          <span class="drafts-row-meta">${escapeHtml(formatDate(p.updated_at))}</span>
        </div>
      </li>
    `,
      )
      .join("");
    this.pageHost.innerHTML = `
      ${headerHtml(false)}
      <ul class="drafts-list${rows ? "" : " drafts-list--empty"}">
        ${rows || `<li class="drafts-empty">No published specs yet.</li>`}
      </ul>
    `;
    this.bindCommonHeader();
  }

  private bindCommonHeader(): void {
    this.pageHost
      .querySelector("#drafts-close")
      ?.addEventListener("click", () => this.close());
    this.pageHost
      .querySelectorAll<HTMLButtonElement>(".drafts-tab")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const next = btn.dataset["tab"] as Tab | undefined;
          if (!next || next === this.tab) return;
          this.tab = next;
          void this.renderList();
        });
      });
  }

  private async renderWizard(): Promise<void> {
    this.wizard?.dispose();
    this.wizard = new DraftWizard({
      host: this.pageHost,
      repoRoot: this.getRepoRoot(),
      slug: this.currentSlug,
      autoPublish: this.wizardOpts.autoPublish,
      initialBody: this.wizardOpts.initialBody,
      onBack: () => {
        this.view = "list";
        void this.render();
      },
      onClose: () => this.close(),
    });
    await this.wizard.mount();
  }
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
