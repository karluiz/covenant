import "./styles.css";
import { CommandsTab } from "./commands-tab";
import { NotesTab } from "./notes-tab";
import { PromptsTab } from "./prompts-tab";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";

export type PanelTab = "commands" | "prompts" | "notes";

export interface PanelOpts {
  groupId: string;
  groupLabel: string;
  /** Optional group accent color — drives the left-edge bar and title dot. */
  groupColor?: string | null;
  /** This group's project folder; scopes the drafts tab per group. */
  groupRootDir?: string | null;
  defaultTab?: PanelTab;
  onClose?: () => void;
  /** Resume a Spec Creator draft by id (called from drafts tab). */
  onOpenDraft?: (draftId: string) => void;
  /** Start a new AI-assisted spec (called from drafts tab). */
  onNewSpec?: () => void;
}

const LAST_TAB_STORAGE_KEY = "covenant.project-notes.last-tab";

function readLastTab(groupId: string): PanelTab {
  try {
    const raw = localStorage.getItem(`${LAST_TAB_STORAGE_KEY}:${groupId}`);
    if (raw === "commands" || raw === "prompts" || raw === "notes") return raw;
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

    // Inner flex container adopts the shared rail design system. The root
    // .pn-panel keeps its fixed overlay positioning; this wrapper carries the
    // rail chrome (header / controls / body). Transparent background so
    // .pn-panel's left accent bar (inset box-shadow) still shows through.
    const inner = document.createElement("div");
    inner.className = "rail-panel";
    inner.style.background = "transparent";

    const header = document.createElement("div");
    header.className = "rail-header";

    const titleEl = document.createElement("div");
    titleEl.className = "rail-title";
    const dot = document.createElement("span");
    dot.className = "rail-dot";
    dot.setAttribute("aria-hidden", "true");
    // The dot carries the per-group accent color (was the title dot before).
    if (opts.groupColor) dot.style.background = opts.groupColor;
    const titleLabel = document.createElement("span");
    titleLabel.className = "rail-title-label";
    titleLabel.textContent = opts.groupLabel;
    titleEl.appendChild(dot);
    titleEl.appendChild(titleLabel);

    const actions = document.createElement("div");
    actions.className = "rail-actions";
    const fsBtn = document.createElement("button");
    fsBtn.className = "rail-btn";
    fsBtn.setAttribute("aria-label", "Toggle fullscreen");
    fsBtn.innerHTML = Icons.maximize({ size: 15 });
    fsBtn.addEventListener("click", () => this.toggleFullscreen());
    attachTooltip(fsBtn, "Toggle fullscreen");
    const closeBtn = document.createElement("button");
    closeBtn.className = "rail-btn";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = Icons.x({ size: 15 });
    closeBtn.addEventListener("click", () => this.close());
    attachTooltip(closeBtn, "Close");
    actions.appendChild(fsBtn);
    actions.appendChild(closeBtn);

    header.appendChild(titleEl);
    header.appendChild(actions);

    const controls = document.createElement("div");
    controls.className = "rail-controls";
    const tabs = document.createElement("div");
    tabs.className = "rail-tabs";
    this.tabButtons = {} as Record<PanelTab, HTMLButtonElement>;
    for (const t of ["commands", "prompts", "notes"] as PanelTab[]) {
      const b = document.createElement("button");
      b.className = "rail-tab";
      b.textContent = t;
      b.dataset.tab = t;
      b.addEventListener("click", () => this.switchTab(t));
      tabs.appendChild(b);
      this.tabButtons[t] = b;
    }
    controls.appendChild(tabs);

    this.body = document.createElement("div");
    this.body.className = "pn-body";

    inner.appendChild(header);
    inner.appendChild(controls);
    inner.appendChild(this.body);
    this.root.appendChild(inner);

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
      this.tabButtons[t].classList.toggle("is-active", t === this.currentTab);
    }
    this.body.replaceChildren();
    this.body.classList.add("pn-body--flush");
    if (this.currentTab === "commands") {
      new CommandsTab({ groupId: this.opts.groupId }).mount(this.body);
    } else if (this.currentTab === "prompts") {
      new PromptsTab({ groupId: this.opts.groupId }).mount(this.body);
    } else {
      new NotesTab({ groupId: this.opts.groupId }).mount(this.body);
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

