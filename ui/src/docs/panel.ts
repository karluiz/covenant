// In-app reference hub. Bound to ⌘? (and ⌘/ as the no-shift alias)
// from main.ts. Static content baked into the bundle — no IPC, no
// state to persist, no markdown library. Sections live as small
// pre-formatted HTML strings under ./content/.
//
// V2: rendered as a full PAGE (not a modal), mirroring settings. It
// shares grid row 2 of #layout with #workspace and #settings-page;
// when open, it replaces the workspace. The tabbar stays visible.
// Closing requires explicit × or Esc (Esc is routed in main.ts).
// Always opens to AOM (per spec).

import { Icons } from "../icons";

import { aomDoc } from "./content/aom";
import { agentsDoc } from "./content/agents";
import { blocksDoc } from "./content/blocks";
import { recallDoc } from "./content/recall";
import { projectNotesDoc } from "./content/project-notes";

export type DocSectionId =
  | "aom"
  | "agents"
  | "blocks"
  | "recall"
  | "project-notes";

export interface DocSection {
  id: DocSectionId;
  title: string;
  subtitle: string;
  /// Pre-formatted HTML. Authored by us, bundled at build time, never
  /// from user input — set via innerHTML directly. Allowed tags: p,
  /// h3, ul/li, kbd, code, strong, em.
  body: string;
}

const SECTIONS: readonly DocSection[] = [
  aomDoc,
  agentsDoc,
  blocksDoc,
  projectNotesDoc,
  recallDoc,
];

const DEFAULT_SECTION: DocSectionId = "aom";

export class DocsPanel {
  private isOpenState = false;
  private current: DocSectionId = DEFAULT_SECTION;

  /// Optional callback fired when the page closes (any reason). Used
  /// by main to refit the active terminal once the workspace becomes
  /// visible again.
  public onClosed: (() => void) | null = null;

  // Capture-phase ESC: the global window-level handler runs in bubble
  // phase, but xterm.js swallows ESC when the terminal has focus, so it
  // never reaches window. Capturing on document while open guarantees
  // ESC closes the page regardless of focus.
  private onEscKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    }
  };

  constructor(
    private readonly pageHost: HTMLElement,
    private readonly workspace: HTMLElement,
  ) {}

  isOpen(): boolean {
    return this.isOpenState;
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen()) return;
    // Reset to default each open — the spec explicitly defers
    // "remember last section" to v2.
    this.current = DEFAULT_SECTION;

    this.workspace.hidden = true;
    this.pageHost.hidden = false;
    this.isOpenState = true;
    document.addEventListener("keydown", this.onEscKeydown, true);
    this.render();
  }

  close(): void {
    if (!this.isOpen()) return;
    document.removeEventListener("keydown", this.onEscKeydown, true);
    this.pageHost.innerHTML = "";
    this.pageHost.hidden = true;
    this.workspace.hidden = false;
    this.isOpenState = false;
    if (this.onClosed) this.onClosed();
  }

  private render(): void {
    const section =
      SECTIONS.find((s) => s.id === this.current) ?? SECTIONS[0];

    this.pageHost.innerHTML = "";

    const header = document.createElement("header");
    header.className = "docs-page-header";
    header.innerHTML = `
      <div class="docs-content-titles">
        <h2 class="docs-content-title">${escapeHtml(section.title)}</h2>
        <p class="docs-content-subtitle">${escapeHtml(section.subtitle)}</p>
      </div>
      <button type="button" class="docs-close" aria-label="Close" title="Close (Esc)">${Icons.x({ size: 14 })}</button>
    `;
    this.pageHost.appendChild(header);

    const wrap = document.createElement("div");
    wrap.className = "docs-body-wrap";
    this.pageHost.appendChild(wrap);

    const sidebar = document.createElement("aside");
    sidebar.className = "docs-sidebar";
    sidebar.innerHTML = `
      <header class="docs-sidebar-head">
        <span class="docs-sidebar-label">Covenant Docs</span>
      </header>
      <nav class="docs-nav" aria-label="documentation sections">
        ${SECTIONS.map((s) => {
          const active = s.id === this.current;
          return `
            <button
              type="button"
              class="docs-nav-item${active ? " is-active" : ""}"
              data-section="${s.id}"
              ${active ? 'aria-current="page"' : ""}
            >
              <span class="docs-nav-label">${escapeHtml(navLabel(s))}</span>
            </button>
          `;
        }).join("")}
      </nav>
    `;
    wrap.appendChild(sidebar);

    const body = document.createElement("article");
    body.className = "docs-body";
    body.innerHTML = section.body;
    wrap.appendChild(body);

    header
      .querySelector<HTMLButtonElement>(".docs-close")!
      .addEventListener("click", () => this.close());

    sidebar
      .querySelectorAll<HTMLButtonElement>(".docs-nav-item")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.section as DocSectionId | undefined;
          if (!id || id === this.current) return;
          this.current = id;
          this.render();
        });
      });
  }
}

/// Sidebar label = the part of the title before " — " when present,
/// else the full title. Keeps the 220px column legible without forcing
/// content authors to maintain a separate field.
function navLabel(s: DocSection): string {
  const dash = s.title.indexOf(" — ");
  return dash > 0 ? s.title.slice(0, dash) : s.title;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
