import "./styles.css";
import { CommandsTab } from "./commands-tab";
import { NotesTab } from "./notes-tab";
import { DocsTab } from "./docs-tab";

export type PanelTab = "commands" | "notes" | "docs";

export interface PanelOpts {
  groupId: string;
  groupLabel: string;
  /** Optional group accent color — drives the left-edge bar and title dot. */
  groupColor?: string | null;
  defaultTab?: PanelTab;
  onClose?: () => void;
}

const LAST_TAB_STORAGE_KEY = "covenant.project-notes.last-tab";

function readLastTab(groupId: string): PanelTab {
  try {
    const raw = localStorage.getItem(`${LAST_TAB_STORAGE_KEY}:${groupId}`);
    if (raw === "commands" || raw === "notes" || raw === "docs") return raw;
  } catch {}
  return "commands";
}

function writeLastTab(groupId: string, tab: PanelTab): void {
  try {
    localStorage.setItem(`${LAST_TAB_STORAGE_KEY}:${groupId}`, tab);
  } catch {}
}

export class ProjectNotesPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private tabButtons: Record<PanelTab, HTMLButtonElement>;
  private currentTab: PanelTab;
  private fullscreen = false;

  constructor(private opts: PanelOpts) {
    this.currentTab = opts.defaultTab ?? readLastTab(opts.groupId);
    this.root = document.createElement("div");
    this.root.className = "pn-panel";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", `Project Notes — ${opts.groupLabel}`);
    if (opts.groupColor) {
      this.root.style.setProperty("--pn-accent", opts.groupColor);
    }

    const header = document.createElement("div");
    header.className = "pn-header";
    header.innerHTML = `
      <span class="pn-title">
        <span class="pn-title-dot" aria-hidden="true"></span>
        <span class="pn-title-label"></span>
      </span>
      <div class="pn-actions">
        <button class="pn-fs" aria-label="Toggle fullscreen">⤢</button>
        <button class="pn-close" aria-label="Close">×</button>
      </div>
    `;
    (header.querySelector(".pn-title-label") as HTMLElement).textContent =
      opts.groupLabel;
    header.querySelector(".pn-close")!.addEventListener("click", () => this.close());
    header.querySelector(".pn-fs")!.addEventListener("click", () => this.toggleFullscreen());

    const tabs = document.createElement("div");
    tabs.className = "pn-tabs";
    this.tabButtons = {} as Record<PanelTab, HTMLButtonElement>;
    for (const t of ["commands", "notes", "docs"] as PanelTab[]) {
      const b = document.createElement("button");
      b.textContent = t[0].toUpperCase() + t.slice(1);
      b.dataset.tab = t;
      b.addEventListener("click", () => this.switchTab(t));
      tabs.appendChild(b);
      this.tabButtons[t] = b;
    }

    this.body = document.createElement("div");
    this.body.className = "pn-body";

    this.root.appendChild(header);
    this.root.appendChild(tabs);
    this.root.appendChild(this.body);

    this.updateTabUI();
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.root);
    document.addEventListener("keydown", this.onKey);
    return this;
  }

  close(): void {
    document.removeEventListener("keydown", this.onKey);
    this.root.remove();
    this.opts.onClose?.();
  }

  switchTab(tab: PanelTab): void {
    this.currentTab = tab;
    writeLastTab(this.opts.groupId, tab);
    this.updateTabUI();
  }

  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    this.root.classList.toggle("pn-fullscreen", this.fullscreen);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.close();
  };

  private updateTabUI(): void {
    for (const t of Object.keys(this.tabButtons) as PanelTab[]) {
      this.tabButtons[t].classList.toggle("active", t === this.currentTab);
    }
    this.body.replaceChildren();
    if (this.currentTab === "commands") {
      new CommandsTab({ groupId: this.opts.groupId }).mount(this.body);
    } else if (this.currentTab === "notes") {
      new NotesTab({ groupId: this.opts.groupId }).mount(this.body);
    } else {
      void new DocsTab({ groupId: this.opts.groupId }).mount(this.body);
    }
  }

  // Exposed for subsequent tasks to plug in.
  get bodyEl(): HTMLElement {
    return this.body;
  }
  get groupId(): string {
    return this.opts.groupId;
  }
  get activeTab(): PanelTab {
    return this.currentTab;
  }
}

