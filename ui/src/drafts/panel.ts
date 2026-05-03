// DraftsPanel — full-page panel for creating and managing mission spec drafts.
// Mirrors DocsPanel: shares the #layout grid row 2 with #workspace,
// #settings-page, and #docs-page; when open it replaces the workspace.
// Closing requires Esc or the × button (wired in main.ts).

import { draftsApi, type DraftSummary } from "./api";
import { DraftWizard } from "./wizard";

type View = "list" | "wizard";

export class DraftsPanel {
  private isOpenState = false;
  private view: View = "list";
  private currentSlug: string | null = null;
  private wizard: DraftWizard | null = null;
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

  openWizard(slug: string | null): void {
    this.view = "wizard";
    this.currentSlug = slug;
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
    let drafts: DraftSummary[] = [];
    try {
      drafts = await draftsApi.list(root);
    } catch (e) {
      this.pageHost.innerHTML = `<div class="drafts-empty">Failed to list drafts: ${escapeHtml(String(e))}</div>`;
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
      <header class="drafts-header">
        <h1>Drafts</h1>
        <div class="drafts-actions">
          <button id="drafts-new" type="button" class="drafts-primary">+ New draft</button>
          <button id="drafts-close" type="button" class="drafts-close" aria-label="Close">×</button>
        </div>
      </header>
      <ul class="drafts-list">
        ${rows || `<li class="drafts-empty">No drafts yet. Click <strong>+ New draft</strong> to start.</li>`}
      </ul>
    `;
    this.pageHost
      .querySelector("#drafts-new")
      ?.addEventListener("click", () => this.openWizard(null));
    this.pageHost
      .querySelector("#drafts-close")
      ?.addEventListener("click", () => this.close());
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
  }

  private async renderWizard(): Promise<void> {
    this.wizard?.dispose();
    this.wizard = new DraftWizard({
      host: this.pageHost,
      repoRoot: this.getRepoRoot(),
      slug: this.currentSlug,
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
