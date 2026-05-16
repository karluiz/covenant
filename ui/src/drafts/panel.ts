// DraftsPanel — full-page wizard for creating mission spec drafts with
// AI assistance. The list view + Published-specs tab have been removed:
// review/edit of existing drafts is now handled by the project notes
// panel's Drafts tab (clicking a draft opens its `.md` in the editor).
// This page hosts only the creation wizard. Opened via
// `drafts:open-wizard` from the project notes panel (Task 8 wires it).
// Closed via Esc or the wizard's internal close button.

import { DraftWizard } from "./wizard";

export interface DraftsPanelOpenOpts {
  /** Absolute path to the repo whose `docs/specs/` we write to. */
  repoRoot?: string;
  /** Existing draft slug to resume, or null/undefined to start fresh. */
  slug?: string | null;
  /** Wizard auto-publish on save (used by existing chat-based flow). */
  autoPublish?: boolean;
  /** Pre-fill the wizard body (used by existing chat-based flow). */
  initialBody?: string;
}

export class DraftsPanel {
  private isOpenState = false;
  private wizard: DraftWizard | null = null;
  private currentSlug: string | null = null;
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

  /// Open the wizard. If `opts.repoRoot` is provided, the panel's repo
  /// root is updated for this session (callers from ProjectNotesPanel
  /// inject the active group's rootDir).
  open(opts?: DraftsPanelOpenOpts): void {
    this.isOpenState = true;
    this.pageHost.hidden = false;
    this.workspace.hidden = true;
    if (opts?.repoRoot) {
      const root = opts.repoRoot;
      this.getRepoRoot = () => root;
    }
    this.currentSlug = opts?.slug ?? null;
    this.wizardOpts = {
      autoPublish: opts?.autoPublish,
      initialBody: opts?.initialBody,
    };
    void this.renderWizard();
  }

  close(): void {
    this.isOpenState = false;
    this.pageHost.hidden = true;
    this.workspace.hidden = false;
    this.wizard?.dispose();
    this.wizard = null;
    this.onClosed?.();
  }

  /// Back-compat shim. Older callers may invoke `openWizard(slug)`; route
  /// through `open()` so the wizard boots with the slug.
  openWizard(slug: string | null, opts?: { autoPublish?: boolean; initialBody?: string }): void {
    this.open({ slug, autoPublish: opts?.autoPublish, initialBody: opts?.initialBody });
  }

  private async renderWizard(): Promise<void> {
    this.wizard?.dispose();
    this.wizard = new DraftWizard({
      host: this.pageHost,
      repoRoot: this.getRepoRoot(),
      slug: this.currentSlug,
      autoPublish: this.wizardOpts.autoPublish,
      initialBody: this.wizardOpts.initialBody,
      onBack: () => this.close(),
      onClose: () => this.close(),
    });
    await this.wizard.mount();
  }
}
