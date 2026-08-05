import "./styles.css";
import "../canon/cockpit/cockpit.css";
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
  /** This group's project folder. Retained but currently unused — scoped
   *  the drafts tab per group before it was removed in v2. */
  groupRootDir?: string | null;
  defaultTab?: PanelTab;
  onClose?: () => void;
  /** Resume a Spec Creator draft by id. Retained but currently unused — was
   *  called from the drafts tab, which was removed in v2. */
  onOpenDraft?: (draftId: string) => void;
  /** Start a new AI-assisted spec. Retained but currently unused — was
   *  called from the drafts tab, which was removed in v2. */
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
  private expandRoot: HTMLElement | null = null;
  private tabHosts: Partial<Record<PanelTab, HTMLElement>> = {};
  private tabViews: Partial<Record<PanelTab, { refresh?(): unknown }>> = {};

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
    actions.appendChild(fsBtn);

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
    this.collapseExpanded();
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
    if (this.expandRoot) { this.collapseExpanded(); return; }
    this.openExpanded();
  }

  private collapseExpanded(): void {
    this.expandRoot?.remove();
    this.expandRoot = null;
    document.body.classList.remove("canon-cockpit-open");
  }

  private openExpanded(): void {
    const groups: { label: string; items: { key: PanelTab; label: string; desc: string }[] }[] = [
      { label: "Library", items: [
        { key: "commands", label: "Commands", desc: "Shell snippets you run in this project." },
        { key: "prompts",  label: "Prompts",  desc: "Reusable prompts you send to an agent." },
      ]},
      { label: "Knowledge", items: [
        { key: "notes", label: "Notes", desc: "Things worth keeping — captures and your own notes." },
      ]},
    ];

    const root = document.createElement("div");
    root.className = "canon-cockpit";

    const nav = document.createElement("nav");
    nav.className = "canon-cockpit-nav";
    const navTitle = document.createElement("div");
    navTitle.className = "canon-cockpit-nav-title";
    navTitle.textContent = `${this.opts.groupLabel} — COVENANT`;
    nav.appendChild(navTitle);

    const content = document.createElement("section");
    content.className = "canon-cockpit-content";

    const buttons: Partial<Record<PanelTab, HTMLButtonElement>> = {};
    // Sections are built once and toggled, for the same reason the rail's tabs
    // are: replaceChildren() on every nav click discarded whatever was typed.
    // Each section owns its own esc pill — one shared button can only ever live
    // in one head.
    const wraps: Partial<Record<PanelTab, HTMLElement>> = {};
    const views: Partial<Record<PanelTab, { refresh?(): unknown }>> = {};

    const build = (key: PanelTab, label: string, desc: string): HTMLElement => {
      const wrap = document.createElement("div");
      wrap.className = "canon-cockpit-section-wrap";
      const head = document.createElement("header");
      head.className = "canon-cockpit-sec-head";
      const h = document.createElement("h2");
      h.className = "canon-cockpit-sec-title";
      h.textContent = label;
      const p = document.createElement("p");
      p.className = "canon-cockpit-sec-desc";
      p.textContent = desc;
      const text = document.createElement("div");
      text.className = "canon-cockpit-sec-text";
      text.append(h, p);
      const actions = document.createElement("div");
      actions.className = "canon-cockpit-sec-actions";
      // In-flow inside the sticky sec-head (same fix as the Canon cockpit):
      // overlaying the pill above scrolling content made it flicker on WebKit
      // when hover effects repainted beneath it.
      const close = document.createElement("button");
      close.type = "button";
      close.className = "canon-cockpit-close";
      close.setAttribute("aria-label", "Close (Esc)");
      close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
      close.addEventListener("click", () => this.collapseExpanded());
      actions.appendChild(close);
      head.append(text, actions);
      const body = document.createElement("div");
      body.className = "pn-body pn-body--flush";
      const opts = { groupId: this.opts.groupId };
      views[key] =
        key === "commands" ? new CommandsTab(opts).mount(body)
        : key === "prompts" ? new PromptsTab(opts).mount(body)
        : new NotesTab(opts).mount(body);
      wrap.append(head, body);
      return wrap;
    };

    const select = (key: PanelTab, label: string, desc: string): void => {
      for (const b of nav.querySelectorAll(".canon-cockpit-nav-btn")) b.classList.remove("is-active");
      buttons[key]?.classList.add("is-active");
      const existed = !!wraps[key];
      if (!existed) {
        wraps[key] = build(key, label, desc);
        content.appendChild(wraps[key]!);
      }
      for (const k of Object.keys(wraps) as PanelTab[]) {
        wraps[k]!.hidden = k !== key;
      }
      if (existed) void views[key]?.refresh?.();
    };

    for (const g of groups) {
      const gl = document.createElement("div");
      gl.className = "canon-cockpit-grouplabel";
      gl.textContent = g.label;
      nav.appendChild(gl);
      for (const item of g.items) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "canon-cockpit-nav-btn";
        b.textContent = item.label;
        b.addEventListener("click", () => select(item.key, item.label, item.desc));
        buttons[item.key] = b;
        nav.appendChild(b);
      }
    }

    root.append(nav, content);
    document.body.appendChild(root);
    document.body.classList.add("canon-cockpit-open");
    this.expandRoot = root;
    // Open on the tab the rail currently shows (falls back to commands).
    const first = (["commands", "prompts", "notes"] as PanelTab[]).includes(this.currentTab)
      ? this.currentTab : "commands";
    const found = groups.flatMap(g => g.items).find(i => i.key === first)!;
    select(found.key, found.label, found.desc);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (this.expandRoot) this.collapseExpanded();
    else this.close();
  };

  /** Tabs are built once and toggled. Rebuilding them on every switch threw
   *  away the notes composer's draft, the list scroll, and any open editor. */
  private updateTabUI(): void {
    for (const t of Object.keys(this.tabButtons) as PanelTab[]) {
      this.tabButtons[t].classList.toggle("is-active", t === this.currentTab);
    }
    this.body.classList.add("pn-body--flush");
    const existed = !!this.tabHosts[this.currentTab];
    this.ensureTab(this.currentTab);
    for (const t of Object.keys(this.tabHosts) as PanelTab[]) {
      this.tabHosts[t]!.hidden = t !== this.currentTab;
    }
    // A fresh tab already fetched on mount; only a revisit needs a re-read
    // (an agent may have appended over MCP while it was hidden).
    if (existed) void this.tabViews[this.currentTab]?.refresh?.();
  }

  private ensureTab(tab: PanelTab): HTMLElement {
    const cached = this.tabHosts[tab];
    if (cached) return cached;
    const host = document.createElement("div");
    host.className = "pn-tabhost";
    this.body.appendChild(host);
    const opts = { groupId: this.opts.groupId };
    this.tabViews[tab] =
      tab === "commands" ? new CommandsTab(opts).mount(host)
      : tab === "prompts" ? new PromptsTab(opts).mount(host)
      : new NotesTab(opts).mount(host);
    this.tabHosts[tab] = host;
    return host;
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

