// Keyboard shortcuts modal — ⌘⇧K.
//
// Read-only overlay that lists every binding from `registry.ts`,
// grouped by category. Reuses the `release-overlay` / `release-card`
// chrome (same modal posture as the changelog) plus a small grid for
// the rows.

import { CATEGORY_ORDER, SHORTCUTS, type ShortcutEntry } from "./registry";

export class ShortcutsPanel {
  private modal: HTMLElement | null = null;
  // Capture-phase ESC handler. The global window-level handler runs in the
  // bubble phase, but xterm.js's textarea swallows ESC (stopPropagation) when
  // the terminal has focus, so it never reaches window. Capturing on document
  // while the modal is open guarantees ESC closes it regardless of focus.
  private onKeydown = (e: KeyboardEvent): void => {
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

  open(): void {
    if (this.isOpen()) return;

    const overlay = document.createElement("div");
    overlay.className = "release-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const card = document.createElement("div");
    card.className = "release-card";
    overlay.appendChild(card);

    const grouped = new Map<string, ShortcutEntry[]>();
    for (const s of SHORTCUTS) {
      const arr = grouped.get(s.category) ?? [];
      arr.push(s);
      grouped.set(s.category, arr);
    }

    const sections = CATEGORY_ORDER.filter((c) => grouped.has(c))
      .map((cat) => {
        const rows = grouped
          .get(cat)!
          .map(
            (s) => `
              <div class="shortcut-row">
                <div class="shortcut-keys">${s.keys.map((k) => `<kbd>${esc(k)}</kbd>`).join("")}</div>
                <div class="shortcut-text">
                  <div class="shortcut-label">${esc(s.label)}</div>
                  <div class="shortcut-desc">${esc(s.description)}</div>
                </div>
              </div>`,
          )
          .join("");
        return `
          <section class="shortcut-section">
            <h3>${esc(cat)}</h3>
            <div class="shortcut-grid">${rows}</div>
          </section>`;
      })
      .join("");

    card.innerHTML = `
      <header class="release-header">
        <div>
          <h2>Keyboard shortcuts</h2>
        </div>
        <button type="button" class="release-close" aria-label="Close (Esc)"><kbd class="settings-esc">esc</kbd></button>
      </header>
      <div class="release-body shortcuts-body">${sections}</div>
    `;

    card
      .querySelector<HTMLButtonElement>(".release-close")!
      .addEventListener("click", () => this.close());

    this.mountHost.appendChild(overlay);
    this.modal = overlay;
    document.addEventListener("keydown", this.onKeydown, true);
  }

  close(): void {
    if (this.modal) {
      document.removeEventListener("keydown", this.onKeydown, true);
      this.modal.remove();
      this.modal = null;
    }
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
