// DraftsPanel — full-page panel for creating and managing mission spec drafts.
// Mirrors DocsPanel: shares the #layout grid row 2 with #workspace,
// #settings-page, and #docs-page; when open it replaces the workspace.
// Closing requires Esc or the × button (wired in main.ts).
//
// This is a skeleton (Task 8). Full list + wizard views are added in Task 9+.

export class DraftsPanel {
  private isOpenState = false;
  public onClosed: (() => void) | null = null;

  constructor(
    private readonly pageHost: HTMLElement,
    private readonly workspace: HTMLElement,
  ) {}

  isOpen(): boolean {
    return this.isOpenState;
  }

  toggle(): void {
    if (this.isOpenState) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpenState) return;
    this.isOpenState = true;
    this.workspace.hidden = true;
    this.pageHost.hidden = false;
  }

  close(): void {
    if (!this.isOpenState) return;
    this.isOpenState = false;
    this.pageHost.hidden = true;
    this.workspace.hidden = false;
    this.onClosed?.();
  }
}
