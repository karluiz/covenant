// Release log modal — status-bar version chip.
//
// Renders the bundled CHANGELOG.md (inlined at build time as
// `__APP_CHANGELOG__`). Pure read-only; no fetch, no editing.
//
// Auto-show on first launch after a version bump: we stash the last
// seen version in localStorage and pop the modal with a "What's new
// in vX" header when it differs from `__APP_VERSION__`.

import { renderMarkdown } from "./markdown";

const LAST_SEEN_KEY = "covenant.release.last-seen-version";

export class ReleasePanel {
  private modal: HTMLElement | null = null;
  // Capture-phase ESC: the global window-level handler runs in bubble
  // phase, but xterm.js swallows ESC when the terminal has focus, so it
  // never reaches window. Capturing on document while open guarantees
  // ESC closes the panel regardless of focus.
  private onEscKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  constructor(private readonly mountHost: HTMLElement) {}

  isOpen(): boolean {
    return this.modal !== null;
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  /// Read the persisted last-seen version. Returns null on first
  /// launch / cleared storage.
  static lastSeenVersion(): string | null {
    try {
      return localStorage.getItem(LAST_SEEN_KEY);
    } catch {
      return null;
    }
  }

  /// Stamp the current version as seen — call after the user has had
  /// a chance to read the modal (we do it on close).
  static markSeen(version: string): void {
    try {
      localStorage.setItem(LAST_SEEN_KEY, version);
    } catch {
      /* storage full / private mode — fine to skip */
    }
  }

  /// Open with the standard header. Use `openWhatsNew` for the
  /// auto-show path so the header reads as "What's new" instead of
  /// "Release log".
  open(opts?: { whatsNew?: boolean }): void {
    if (this.isOpen()) return;

    const overlay = document.createElement("div");
    overlay.className = "release-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const card = document.createElement("div");
    card.className = "release-card";
    overlay.appendChild(card);

    const title = opts?.whatsNew
      ? `What's new in v${__APP_VERSION__}`
      : "Release log";
    const subtitle = opts?.whatsNew
      ? "Highlights from the latest update — older versions below."
      : `Covenant v${__APP_VERSION__}`;

    card.innerHTML = `
      <header class="release-header">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <small class="release-subtitle">${escapeHtml(subtitle)}</small>
        </div>
        <button type="button" class="release-close" aria-label="Close">×</button>
      </header>
      <div class="release-body markdown-body">${renderMarkdown(__APP_CHANGELOG__)}</div>
    `;

    card
      .querySelector<HTMLButtonElement>(".release-close")!
      .addEventListener("click", () => this.close());

    this.mountHost.appendChild(overlay);
    this.modal = overlay;
    document.addEventListener("keydown", this.onEscKeydown, true);
  }

  /// Convenience for the auto-show path. Opens with the "What's new"
  /// header AND stamps the version as seen on close so the modal
  /// doesn't reopen on the next launch.
  openWhatsNew(): void {
    this.open({ whatsNew: true });
  }

  close(): void {
    if (this.modal) {
      document.removeEventListener("keydown", this.onEscKeydown, true);
      this.modal.remove();
      this.modal = null;
      // Always stamp on close — manual or auto. The user has now
      // had eyes on the changelog at least once for this version.
      ReleasePanel.markSeen(__APP_VERSION__);
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
