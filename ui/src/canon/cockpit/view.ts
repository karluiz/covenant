// Canon Cockpit — full-screen overlay shell for org-scoped Canon management.
// Left-nav section routing (org/members/skills/registry/context/loop); each
// section is a stub in this task — Tasks 6-8 fill in real content. Launched
// from the expand button in the rail's CanonPanel head (see panel.ts).
//
// Opaque full-screen overlay by design — mirrors ContextMinerView's
// mount/close/Esc handling (see miner.css header comment for the
// vibrancy-bleed gotcha this avoids).

import "./cockpit.css";
import type { Org } from "../../api";

export type SectionKey = "org" | "members" | "skills" | "registry" | "context" | "loop";

export interface CanonCockpitOpts {
  groupId: string;
  groupLabel: string;
  groupRootDir: string | null;
  orgs: Org[];
  getActiveOrg: () => string | null;
  setActiveOrg: (slug: string | null) => void;
}

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "org", label: "Org" },
  { key: "members", label: "Members" },
  { key: "skills", label: "Skills" },
  { key: "registry", label: "Registry" },
  { key: "context", label: "Context" },
  { key: "loop", label: "Loop" },
];

export class CanonCockpitView {
  private root: HTMLElement;
  private nav: HTMLElement;
  private content: HTMLElement;
  private current: SectionKey = "org";

  /** The root element of the overlay — used by tests and by callers that
   *  need to query the rendered content without going through document. */
  get element(): HTMLElement { return this.root; }

  constructor(private opts: CanonCockpitOpts) {
    this.root = document.createElement("div");
    this.root.className = "canon-cockpit";

    this.nav = document.createElement("nav");
    this.nav.className = "canon-cockpit-nav";
    const title = document.createElement("div");
    title.className = "canon-cockpit-nav-title";
    title.textContent = `Canon — ${this.opts.groupLabel}`;
    this.nav.appendChild(title);
    for (const s of SECTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "canon-cockpit-nav-btn";
      b.dataset.section = s.key;
      b.textContent = s.label;
      b.addEventListener("click", () => this.showSection(s.key));
      this.nav.appendChild(b);
    }

    this.content = document.createElement("section");
    this.content.className = "canon-cockpit-content";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "canon-cockpit-close";
    close.setAttribute("aria-label", "Close (Esc)");
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.close());

    this.root.append(this.nav, this.content, close);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.close();
  };

  open(): void {
    document.body.appendChild(this.root);
    document.addEventListener("keydown", this.onKey);
    this.showSection(this.current);
  }

  close(): void {
    this.root.remove();
    document.removeEventListener("keydown", this.onKey);
  }

  showSection(key: SectionKey): void {
    this.current = key;
    for (const b of this.nav.querySelectorAll("button")) {
      b.classList.toggle("is-active", (b as HTMLElement).dataset.section === key);
    }
    this.content.replaceChildren(this.renderSection(key));
  }

  private renderSection(key: SectionKey): HTMLElement {
    // Stub — real content lands in Tasks 6-8. `opts` is already threaded
    // through so those tasks don't need to touch the constructor signature.
    const el = document.createElement("div");
    el.className = `canon-cockpit-section is-${key}`;
    el.textContent = key;
    return el;
  }
}
