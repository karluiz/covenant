export interface DraftWizardOpts {
  host: HTMLElement;
  repoRoot: string;
  slug: string | null;
  onBack: () => void;
  onClose: () => void;
}

export class DraftWizard {
  constructor(private opts: DraftWizardOpts) {}

  async mount(): Promise<void> {
    this.opts.host.innerHTML = `<div class="drafts-empty">Wizard coming next task.</div>`;
  }

  dispose(): void {}
}
