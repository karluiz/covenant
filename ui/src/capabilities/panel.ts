// Capabilities panel — T7–T9 MVP.
//
// Full-page route (like SettingsPanel) that lists Claude / Copilot / opencode /
// Shared capabilities discovered from the host filesystem via Tauri commands.
// Detail pane is a plain <textarea> for now; Monaco is a follow-up. Watcher
// integration (live updates) is also deferred — there's a manual Refresh.

import { open as openDialog } from "@tauri-apps/plugin-dialog";

import {
  type CapabilityListItem,
  type CapabilitiesDetect,
  capabilitiesDelete,
  capabilitiesDetect,
  capabilitiesList,
  capabilitiesListDir,
  capabilitiesRead,
  capabilitiesScaffold,
  capabilitiesWrite,
} from "../api";
import { pushInfoToast } from "../notifications/toast";

type ToolKey = "claude" | "copilot" | "opencode" | "shared";
type SectionKey = "skills" | "commands" | "hooks" | "mcps" | "plugins" | "agents";

const PROJECT_ROOT_KEY = "capabilities.projectRoot";

interface SectionDef {
  key: SectionKey;
  label: string;
  kinds: readonly CapabilityListItem["kind"][];
}

const SECTIONS_BY_TOOL: Record<ToolKey, SectionDef[]> = {
  claude: [
    { key: "skills", label: "Skills", kinds: ["skill"] },
    { key: "commands", label: "Commands", kinds: ["command"] },
    { key: "hooks", label: "Hooks", kinds: ["hook"] },
    { key: "mcps", label: "MCPs", kinds: ["mcp"] },
  ],
  copilot: [
    { key: "mcps", label: "MCPs", kinds: ["mcp"] },
    { key: "plugins", label: "Plugins", kinds: ["plugin"] },
  ],
  opencode: [
    { key: "agents", label: "Agents", kinds: ["agent"] },
    { key: "mcps", label: "MCPs", kinds: ["mcp"] },
  ],
  shared: [{ key: "skills", label: "Skills", kinds: ["skill"] }],
};

export class CapabilitiesPanel {
  private isOpenState = false;
  private items: CapabilityListItem[] = [];
  private detect: CapabilitiesDetect | null = null;
  private activeTool: ToolKey = "claude";
  private activeSection: SectionKey = "skills";
  private showUser = true;
  private showProject = true;
  private search = "";
  private selectedId: string | null = null;
  private dirty = false;
  private newFormOpen = false;
  private projectRoot: string | null = null;

  public onClosed: (() => void) | null = null;

  constructor(
    private readonly pageHost: HTMLElement,
    private readonly workspace: HTMLElement,
  ) {
    this.projectRoot = localStorage.getItem(PROJECT_ROOT_KEY);
  }

  isOpen(): boolean {
    return this.isOpenState;
  }

  async toggle(contextRoot?: string | null): Promise<void> {
    if (this.isOpen()) this.close();
    else await this.open(contextRoot);
  }

  async open(contextRoot?: string | null): Promise<void> {
    if (this.isOpenState) return;
    if (contextRoot && contextRoot !== this.projectRoot) {
      this.projectRoot = contextRoot;
      localStorage.setItem(PROJECT_ROOT_KEY, contextRoot);
    }
    this.workspace.hidden = true;
    this.pageHost.hidden = false;
    this.isOpenState = true;
    this.render(); // initial shell while we fetch
    await this.refresh();
  }

  close(): void {
    if (!this.isOpenState) return;
    if (this.dirty) {
      const ok = confirm("Discard unsaved changes?");
      if (!ok) return;
    }
    this.pageHost.innerHTML = "";
    this.pageHost.hidden = true;
    this.workspace.hidden = false;
    this.isOpenState = false;
    this.dirty = false;
    if (this.onClosed) this.onClosed();
  }

  private async refresh(): Promise<void> {
    try {
      this.detect = await capabilitiesDetect();
      this.items = await capabilitiesList(this.projectRoot);
    } catch (err) {
      console.error("capabilities refresh failed", err);
      pushInfoToast({ message: `Capabilities: ${String(err)}` });
      this.detect = { claude: false, copilot: false, opencode: false, shared: false };
      this.items = [];
    }
    // Reset selection if it's no longer present.
    if (this.selectedId && !this.items.find((c) => c.id === this.selectedId)) {
      this.selectedId = null;
    }
    this.render();
  }

  private filtered(): CapabilityListItem[] {
    const sections = SECTIONS_BY_TOOL[this.activeTool];
    const def = sections.find((s) => s.key === this.activeSection) ?? sections[0];
    this.activeSection = def.key;
    const kinds = new Set(def.kinds);
    const q = this.search.trim().toLowerCase();
    return this.items.filter((c) => {
      if (c.tool !== this.activeTool) return false;
      if (!kinds.has(c.kind)) return false;
      const isProject = c.scope_label.startsWith("project:");
      if (isProject && !this.showProject) return false;
      if (!isProject && !this.showUser) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        (c.description ?? "").toLowerCase().includes(q) ||
        c.path.toLowerCase().includes(q)
      );
    });
  }

  private selected(): CapabilityListItem | null {
    if (!this.selectedId) return null;
    return this.items.find((c) => c.id === this.selectedId) ?? null;
  }

  private render(): void {
    this.pageHost.innerHTML = "";
    this.pageHost.appendChild(this.renderHeader());

    const body = document.createElement("div");
    body.className = "capabilities-body";
    this.pageHost.appendChild(body);

    body.appendChild(this.renderNav());
    body.appendChild(this.renderMain());
  }

  private renderHeader(): HTMLElement {
    const header = document.createElement("header");
    header.className = "capabilities-page-header";
    header.innerHTML = `
      <h2>Capabilities</h2>
      <div class="capabilities-header-actions">
        <button type="button" class="cap-btn" data-act="refresh">Refresh</button>
        <button type="button" class="cap-btn cap-btn-primary" data-act="new">+ New</button>
        <button type="button" class="cap-btn cap-close" data-act="close" aria-label="Close" title="Close (Esc)">×</button>
      </div>
    `;
    header.querySelector<HTMLButtonElement>('[data-act="refresh"]')!.onclick = () => {
      void this.refresh();
    };
    header.querySelector<HTMLButtonElement>('[data-act="new"]')!.onclick = () => {
      this.newFormOpen = !this.newFormOpen;
      this.render();
    };
    header.querySelector<HTMLButtonElement>('[data-act="close"]')!.onclick = () => this.close();
    return header;
  }

  private renderNav(): HTMLElement {
    const nav = document.createElement("nav");
    nav.className = "capabilities-nav";

    nav.appendChild(navGroupTitle("Tool"));
    const tools: { key: ToolKey; label: string }[] = [
      { key: "claude", label: "Claude" },
      { key: "copilot", label: "Copilot" },
      { key: "opencode", label: "opencode" },
      { key: "shared", label: "Shared" },
    ];
    for (const t of tools) {
      const installed = this.detect ? this.detect[t.key] : true;
      const a = document.createElement("a");
      a.className = "cap-nav-item";
      if (this.activeTool === t.key) a.classList.add("active");
      if (!installed) a.classList.add("disabled");
      a.textContent = installed ? t.label : `${t.label} (not installed)`;
      a.onclick = () => {
        this.activeTool = t.key;
        this.activeSection = SECTIONS_BY_TOOL[t.key][0].key;
        this.selectedId = null;
        this.render();
      };
      nav.appendChild(a);
    }

    nav.appendChild(navGroupTitle("Section"));
    for (const s of SECTIONS_BY_TOOL[this.activeTool]) {
      const a = document.createElement("a");
      a.className = "cap-nav-item";
      if (this.activeSection === s.key) a.classList.add("active");
      a.textContent = s.label;
      a.onclick = () => {
        this.activeSection = s.key;
        this.selectedId = null;
        this.render();
      };
      nav.appendChild(a);
    }

    nav.appendChild(navGroupTitle("Scope"));
    const scopeBox = document.createElement("div");
    scopeBox.className = "cap-nav-scope";
    scopeBox.innerHTML = `
      <label class="cap-check"><input type="checkbox" data-scope="user" ${this.showUser ? "checked" : ""}> User</label>
      <label class="cap-check"><input type="checkbox" data-scope="project" ${this.showProject ? "checked" : ""}> Project</label>
      <div class="cap-project-path" title="${this.projectRoot ? escapeHtml(this.projectRoot) : ""}">${this.projectRoot ? escapeHtml(this.projectRoot) : "no project root"}</div>
      <div class="cap-nav-scope-actions">
        <button type="button" class="cap-btn cap-btn-small" data-act="set-root">Set…</button>
        ${this.projectRoot ? `<button type="button" class="cap-btn cap-btn-small" data-act="clear-root">Clear</button>` : ""}
      </div>
    `;
    scopeBox.querySelector<HTMLInputElement>('[data-scope="user"]')!.onchange = (e) => {
      this.showUser = (e.target as HTMLInputElement).checked;
      this.render();
    };
    scopeBox.querySelector<HTMLInputElement>('[data-scope="project"]')!.onchange = (e) => {
      this.showProject = (e.target as HTMLInputElement).checked;
      this.render();
    };
    scopeBox.querySelector<HTMLButtonElement>('[data-act="set-root"]')!.onclick = async () => {
      const picked = await openDialog({
        title: "Pick project root",
        multiple: false,
        directory: true,
        defaultPath: this.projectRoot ?? undefined,
      });
      if (typeof picked !== "string") return;
      this.projectRoot = picked;
      localStorage.setItem(PROJECT_ROOT_KEY, picked);
      await this.refresh();
    };
    const clearBtn = scopeBox.querySelector<HTMLButtonElement>('[data-act="clear-root"]');
    if (clearBtn) {
      clearBtn.onclick = async () => {
        this.projectRoot = null;
        localStorage.removeItem(PROJECT_ROOT_KEY);
        await this.refresh();
      };
    }
    nav.appendChild(scopeBox);

    return nav;
  }

  private renderMain(): HTMLElement {
    const main = document.createElement("div");
    main.className = "capabilities-main";

    const searchBar = document.createElement("div");
    searchBar.className = "cap-search-bar";
    searchBar.innerHTML = `<input type="text" class="cap-search" placeholder="Filter by name, path or description" value="${escapeHtml(this.search)}">`;
    const input = searchBar.querySelector<HTMLInputElement>(".cap-search")!;
    input.oninput = () => {
      this.search = input.value;
      this.renderSplitOnly();
    };
    main.appendChild(searchBar);

    if (this.newFormOpen) main.appendChild(this.renderNewForm());

    main.appendChild(this.renderSplit());
    return main;
  }

  private renderSplit(): HTMLElement {
    const split = document.createElement("div");
    split.className = "capabilities-split";
    split.appendChild(this.renderList());
    split.appendChild(this.renderDetail());
    return split;
  }

  private renderNewForm(): HTMLElement {
    const form = document.createElement("form");
    form.className = "cap-new-form";
    const tool = this.activeTool;
    // Kinds supported by scaffold for this tool.
    const kinds: { value: string; label: string }[] = (() => {
      if (tool === "claude") {
        return [
          { value: "skill", label: "Skill" },
          { value: "command", label: "Slash command" },
          { value: "hook", label: "Hook (snippet file)" },
          { value: "mcp", label: "MCP server (snippet file)" },
        ];
      }
      if (tool === "opencode") return [{ value: "skill", label: "Agent / skill" }];
      if (tool === "shared") return [{ value: "skill", label: "Skill" }];
      if (tool === "copilot") return [{ value: "mcp", label: "MCP server (snippet file)" }];
      return [];
    })();
    form.innerHTML = `
      <h3>New ${tool} capability</h3>
      <div class="cap-form-row">
        <label>Kind
          <select name="kind">
            ${kinds.map((k) => `<option value="${k.value}">${k.label}</option>`).join("")}
          </select>
        </label>
        <label>Name <input type="text" name="name" required placeholder="my-skill" autocomplete="off"></label>
      </div>
      <label class="cap-form-row-wide">Description <input type="text" name="description" placeholder="One-line summary"></label>
      <fieldset class="cap-form-row">
        <legend>Scope</legend>
        <label><input type="radio" name="scope" value="user" checked> User</label>
        <label><input type="radio" name="scope" value="project" ${this.projectRoot ? "" : "disabled"}> Project ${this.projectRoot ? "" : "(set a root first)"}</label>
      </fieldset>
      <div class="cap-form-actions">
        <button type="submit" class="cap-btn cap-btn-primary">Create</button>
        <button type="button" class="cap-btn" data-act="cancel">Cancel</button>
      </div>
    `;
    form.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.onclick = () => {
      this.newFormOpen = false;
      this.render();
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      const kind = String(data.get("kind") ?? "");
      const name = String(data.get("name") ?? "").trim();
      const description = String(data.get("description") ?? "").trim();
      const scope = String(data.get("scope") ?? "user");
      if (!name) {
        pushInfoToast({ message: "Name is required" });
        return;
      }
      try {
        const projectArg = scope === "project" ? this.projectRoot : null;
        const newPath = await capabilitiesScaffold(tool, kind, name, description, projectArg);
        pushInfoToast({ message: `Created ${newPath}` });
        this.newFormOpen = false;
        await this.refresh();
        // Try to auto-select the new item by path.
        const match = this.items.find((c) => c.path === newPath);
        if (match) {
          this.selectedId = match.id;
          this.render();
          await this.loadSelectedIntoEditor();
        }
      } catch (err) {
        pushInfoToast({ message: `Create failed: ${String(err)}` });
      }
    };
    return form;
  }

  // Re-renders only the list+detail split (used for fast search filtering).
  private renderSplitOnly(): void {
    const old = this.pageHost.querySelector(".capabilities-split");
    if (!old) {
      this.render();
      return;
    }
    old.replaceWith(this.renderSplit());
  }

  private renderList(): HTMLElement {
    const list = document.createElement("div");
    list.className = "capabilities-list";
    const installed = this.detect ? this.detect[this.activeTool] : true;
    if (!installed) {
      list.innerHTML = `<div class="cap-empty">${this.activeTool} not installed on this host.</div>`;
      return list;
    }
    const filtered = this.filtered();
    if (filtered.length === 0) {
      list.innerHTML = `<div class="cap-empty">No items.</div>`;
      return list;
    }
    for (const c of filtered) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "cap-list-item";
      if (this.selectedId === c.id) row.classList.add("cap-list-item-active");
      const ro = c.read_only ? `<span class="cap-badge cap-badge-ro">RO</span>` : "";
      row.innerHTML = `
        <div class="cap-list-row1">
          <span class="cap-list-name">${escapeHtml(c.name)}</span>
          ${ro}
        </div>
        <div class="cap-list-row2">
          <span class="cap-list-scope">${escapeHtml(c.scope_label)}</span>
          ${c.description ? `<span class="cap-list-desc">${escapeHtml(truncate(c.description, 60))}</span>` : ""}
        </div>
      `;
      row.onclick = async () => {
        if (this.dirty) {
          const ok = confirm("Discard unsaved changes?");
          if (!ok) return;
          this.dirty = false;
        }
        this.selectedId = c.id;
        this.render();
        await this.loadSelectedIntoEditor();
      };
      list.appendChild(row);
    }
    return list;
  }

  private renderDetail(): HTMLElement {
    const detail = document.createElement("div");
    detail.className = "capabilities-detail";
    const sel = this.selected();
    if (!sel) {
      detail.innerHTML = `<div class="cap-empty">Select a capability to view its content.</div>`;
      return detail;
    }
    const isJsonSource = sel.kind === "hook" || sel.kind === "mcp";
    const isPlugin = sel.kind === "plugin";
    detail.innerHTML = `
      <div class="cap-detail-meta">
        <div><strong>${escapeHtml(sel.name)}</strong>${sel.description ? ` <span class="cap-detail-desc">— ${escapeHtml(sel.description)}</span>` : ""}</div>
        <div class="cap-detail-row"><span class="cap-detail-key">Path:</span> <code>${escapeHtml(sel.path)}</code></div>
        <div class="cap-detail-row"><span class="cap-detail-key">Scope:</span> ${escapeHtml(sel.scope_label)}</div>
        <div class="cap-detail-row"><span class="cap-detail-key">Tool:</span> ${escapeHtml(sel.tool)} / ${escapeHtml(sel.kind)}</div>
        ${isJsonSource ? `<div class="cap-detail-row cap-warn">Editing the entire settings.json — be careful.</div>` : ""}
      </div>
      ${
        isPlugin
          ? `<div class="cap-plugin-view"><div class="cap-plugin-listing">loading…</div></div>`
          : `<textarea class="cap-editor" spellcheck="false" ${sel.read_only ? "disabled" : ""}></textarea>`
      }
      <div class="cap-detail-actions">
        ${
          sel.read_only
            ? `<span class="cap-readonly-msg">Plugin-scoped — read-only. <em>(Fork-to-user is a TODO.)</em></span>`
            : `
              <button type="button" class="cap-btn cap-btn-primary" data-act="save" disabled>Save</button>
              <button type="button" class="cap-btn cap-btn-danger" data-act="delete">Delete</button>
              <span class="cap-dirty-flag" hidden>unsaved changes</span>
            `
        }
      </div>
    `;
    const textarea = detail.querySelector<HTMLTextAreaElement>(".cap-editor");
    const saveBtn = detail.querySelector<HTMLButtonElement>('[data-act="save"]');
    const deleteBtn = detail.querySelector<HTMLButtonElement>('[data-act="delete"]');
    const dirtyFlag = detail.querySelector<HTMLElement>(".cap-dirty-flag");
    if (textarea) {
      textarea.oninput = () => {
        this.dirty = true;
        if (saveBtn) saveBtn.disabled = false;
        if (dirtyFlag) dirtyFlag.hidden = false;
      };
    }
    if (saveBtn && textarea) {
      saveBtn.onclick = async () => {
        const cur = this.selected();
        if (!cur) return;
        try {
          await capabilitiesWrite(cur.path, textarea.value);
          this.dirty = false;
          saveBtn.disabled = true;
          if (dirtyFlag) dirtyFlag.hidden = true;
          pushInfoToast({ message: "Saved." });
        } catch (err) {
          pushInfoToast({ message: `Save failed: ${String(err)}` });
        }
      };
    }
    if (deleteBtn) {
      deleteBtn.onclick = async () => {
        const cur = this.selected();
        if (!cur) return;
        const ok = confirm(`Delete ${cur.name}?\n\n${cur.path}\n\nA .bak.<timestamp> snapshot will be kept next to the file.`);
        if (!ok) return;
        try {
          await capabilitiesDelete(cur.path);
          this.selectedId = null;
          this.dirty = false;
          pushInfoToast({ message: "Deleted." });
          await this.refresh();
        } catch (err) {
          pushInfoToast({ message: `Delete failed: ${String(err)}` });
        }
      };
    }
    return detail;
  }

  private async loadSelectedIntoEditor(): Promise<void> {
    const sel = this.selected();
    if (!sel) return;
    if (sel.kind === "plugin") {
      await this.loadPluginListing(sel);
      return;
    }
    const textarea = this.pageHost.querySelector<HTMLTextAreaElement>(".cap-editor");
    if (!textarea) return;
    textarea.value = "loading...";
    try {
      const body = await capabilitiesRead(sel.path);
      textarea.value = body;
      this.dirty = false;
    } catch (err) {
      textarea.value = `# read error: ${String(err)}`;
    }
  }

  private async loadPluginListing(sel: CapabilityListItem): Promise<void> {
    const host = this.pageHost.querySelector<HTMLElement>(".cap-plugin-listing");
    if (!host) return;
    host.textContent = "loading…";
    try {
      const entries = await capabilitiesListDir(sel.path);
      if (entries.length === 0) {
        host.innerHTML = `<div class="cap-empty">Empty plugin directory.</div>`;
        return;
      }
      const rows = entries
        .map((e) => {
          const sizeLabel = e.is_dir ? "" : ` <span class="cap-plugin-size">${formatSize(e.size)}</span>`;
          const icon = e.is_dir ? "📁" : "📄";
          return `<div class="cap-plugin-row"><span class="cap-plugin-icon">${icon}</span><span class="cap-plugin-name">${escapeHtml(e.name)}</span>${sizeLabel}</div>`;
        })
        .join("");
      host.innerHTML = rows;
    } catch (err) {
      host.innerHTML = `<div class="cap-empty">Failed to list: ${escapeHtml(String(err))}</div>`;
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function navGroupTitle(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "cap-nav-group-title";
  el.textContent = text;
  return el;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
