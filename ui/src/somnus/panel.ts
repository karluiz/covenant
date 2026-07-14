import {
  somnusEnvActivate,
  somnusEnvList,
  somnusHistory,
  somnusHistoryClear,
  somnusHistoryDelete,
  somnusSend,
  somnusTreeCreate,
  somnusTreeUpdate,
  type SomnusDraft,
  type SomnusEnvironment,
  type SomnusHistoryEntry,
  type SomnusResponse,
  type SomnusTreeNode,
} from "../api";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { CustomSelect } from "../ui/select";
import { RequestComposer } from "./composer";
import { CollectionsTree } from "./tree";
import { EnvEditor } from "./envs";
import { RequestTabs, type TabView } from "./tabs";
import { confirmPopover, dismissable } from "./menu";
import { jsonTree, parseJsonBody } from "./json-tree";
import {
  buildRequest,
  draftFromEntry,
  draftKey,
  emptyDraft,
  findUnresolvedDraft,
  parseDraft,
} from "./draft";
import { envVarsToMap, findUnresolved } from "./vars";

/// Map an attempt outcome to a rail-row `data-spine` value.
export function statusSpine(status: number | null, error: string | null): string {
  if (error !== null || status === null) return "fail";
  return status < 400 ? "ok" : "fail";
}

export function fmtSize(bytes: number | null): string {
  if (bytes === null || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/// Pretty-print JSON bodies for display; pass through anything unparsable.
export function prettyBody(body: string): string {
  const t = body.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return body;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return body;
  }
}

export function relTimeMs(unixMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - unixMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

interface OpenTab {
  treeId: string | null;
  name: string;
  draft: SomnusDraft;
  savedKey: string; // draftKey at last load/save — dirty = savedKey !== draftKey(draft)
}

export class SomnusPanel {
  private root: HTMLElement;
  private expandBtn: HTMLButtonElement;
  private responseHost: HTMLElement;
  private historyHost: HTMLElement;
  private sending = false;
  private loadedHistory = false;
  private expanded = false;
  private expandTooltipDetach: () => void;
  private onEsc = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.expanded) {
      // Popover wins over surface: window-capture fires before dismissable's
      // document-capture listener — let Esc dismiss an open popover first.
      if (document.querySelector(".ui-select__popover")) return;
      e.stopPropagation();
      this.closeSurface();
    }
  };

  private composer: RequestComposer;
  private tree: CollectionsTree;
  private envEditor: EnvEditor;
  private reqTabs: RequestTabs;
  private tabs: OpenTab[] = [];
  private active = 0;
  private envs: SomnusEnvironment[] = [];
  private sideTab: "collections" | "envs" | "history" = "collections";
  private sideBtns = new Map<"collections" | "envs" | "history", HTMLButtonElement>();

  constructor(
    host: HTMLElement,
    private opts: { onClose: () => void },
  ) {
    this.root = document.createElement("div");
    this.root.className = "rail-panel";

    // ── Header ──
    const header = document.createElement("div");
    header.className = "rail-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "rail-title";
    const dot = document.createElement("span");
    dot.className = "rail-dot is-idle";
    const label = document.createElement("span");
    label.className = "rail-title-label";
    label.textContent = "Somnus";
    titleWrap.append(dot, label);

    const actions = document.createElement("div");
    actions.className = "rail-actions";
    this.expandBtn = document.createElement("button");
    this.expandBtn.className = "rail-btn";
    this.expandBtn.setAttribute("aria-label", "Expand");
    this.expandBtn.innerHTML = Icons.maximize({ size: 15 });
    this.expandBtn.addEventListener("click", () => this.setExpanded(!this.expanded));
    this.expandTooltipDetach = attachTooltip(this.expandBtn, "Expand");
    const clearBtn = document.createElement("button");
    clearBtn.className = "rail-btn";
    clearBtn.setAttribute("aria-label", "Clear history");
    clearBtn.innerHTML = Icons.trash({ size: 15 });
    clearBtn.addEventListener("click", () => {
      confirmPopover(clearBtn, "Clear all Somnus history?", "Clear", () => {
        void somnusHistoryClear()
          .then(() => this.refreshHistory())
          .catch((e) => console.error("somnus clear failed", e));
      });
    });
    attachTooltip(clearBtn, "Clear history");
    const close = document.createElement("button");
    close.className = "rail-btn";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = Icons.x({ size: 15 });
    close.addEventListener("click", () => this.closeSurface());
    attachTooltip(close, "Close");
    actions.append(this.expandBtn, clearBtn, close);

    const escBtn = document.createElement("button");
    escBtn.className = "somnus-close";
    escBtn.setAttribute("aria-label", "Close (Esc)");
    escBtn.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    escBtn.addEventListener("click", () => this.closeSurface());
    actions.prepend(escBtn);

    header.append(titleWrap, actions);

    this.reqTabs = new RequestTabs({
      onSelect: (i) => this.selectTab(i),
      onClose: (i) => this.closeTab(i),
      onNew: () => this.newTab(),
    });

    this.composer = new RequestComposer({
      onSend: () => void this.send(),
      onSave: () => void this.saveActive(),
      onDirty: () => this.composerDirty(),
      onEnvChange: (id) => void this.setActiveEnv(id),
    });

    const body = document.createElement("div");
    body.className = "rail-body";
    this.responseHost = document.createElement("div");
    this.responseHost.className = "somnus-response";

    const side = document.createElement("div");
    side.className = "somnus-side";
    const sideTabs = document.createElement("div");
    sideTabs.className = "rail-tabs somnus-side-tabs";
    const sideDefs: ["collections" | "envs" | "history", string][] = [
      ["collections", "Collections"],
      ["envs", "Env"],
      ["history", "History"],
    ];
    for (const [id, sideLabel] of sideDefs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rail-tab";
      btn.textContent = sideLabel;
      btn.addEventListener("click", () => this.setSideTab(id));
      sideTabs.append(btn);
      this.sideBtns.set(id, btn);
    }
    this.tree = new CollectionsTree({
      onOpen: (node) => this.openNode(node),
      onEnvImported: () => void this.refreshEnvs(),
      notify: (msg, isError) => this.notify(msg, isError),
    });
    this.envEditor = new EnvEditor({ onChanged: () => void this.refreshEnvs() });
    this.historyHost = document.createElement("div");
    this.historyHost.className = "somnus-history";
    side.append(sideTabs, this.tree.element, this.envEditor.element, this.historyHost);

    body.append(this.responseHost, side);
    this.root.append(header, this.reqTabs.element, this.composer.element, body);
    host.replaceChildren(this.root);

    this.root.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void this.saveActive();
      }
    });

    this.tabs = [this.freshTab()];
    this.selectTab(0);
    this.setSideTab("collections");
    this.reqTabs.render(this.tabViews(), this.active);
  }

  /// Called when the panel opens.
  render(): void {
    if (!this.loadedHistory) void this.refreshHistory();
    void this.tree.refresh();
    void this.refreshEnvs();
  }

  /// Called when the panel hides. Also drops fullscreen if active.
  close(): void {
    this.setExpanded(false);
  }

  // ── Tabs / drafts ──

  private freshTab(): OpenTab {
    const draft = emptyDraft();
    return { treeId: null, name: "", draft, savedKey: draftKey(draft) };
  }

  private tabViews(): TabView[] {
    return this.tabs.map((t) => ({
      title: t.name || t.draft.url.replace(/^https?:\/\//, "") || "Untitled",
      method: t.draft.method,
      dirty: draftKey(t.draft) !== t.savedKey,
    }));
  }

  private renderTabsBar(): void {
    this.reqTabs.render(this.tabViews(), this.active);
  }

  private composerDirty(): void {
    const tab = this.tabs[this.active];
    if (!tab) return;
    tab.draft = this.composer.getDraft();
    this.renderTabsBar();
  }

  private selectTab(i: number): void {
    this.active = Math.max(0, Math.min(i, this.tabs.length - 1));
    this.composer.setDraft(this.tabs[this.active].draft);
    this.composer.markUnresolved([], false);
    this.renderTabsBar();
  }

  private newTab(): void {
    this.tabs.push(this.freshTab());
    this.selectTab(this.tabs.length - 1);
  }

  private closeTab(i: number): void {
    const tab = this.tabs[i];
    if (!tab) return;
    const doClose = (): void => {
      this.tabs.splice(i, 1);
      if (this.tabs.length === 0) this.tabs.push(this.freshTab());
      this.selectTab(this.active >= i && this.active > 0 ? this.active - 1 : this.active);
    };
    if (draftKey(tab.draft) !== tab.savedKey) {
      confirmPopover(this.reqTabs.element, "Discard unsaved changes?", "Discard", doClose);
    } else {
      doClose();
    }
  }

  /// From the collections tree. Expanded: open-in-tab (dedupe by treeId).
  /// Rail: replace the single active composer.
  private openNode(node: SomnusTreeNode): void {
    const draft = parseDraft(node.request);
    const tab: OpenTab = { treeId: node.id, name: node.name, draft, savedKey: draftKey(draft) };
    if (this.expanded) {
      const existing = this.tabs.findIndex((t) => t.treeId === node.id);
      if (existing !== -1) {
        this.selectTab(existing);
        return;
      }
      this.tabs.push(tab);
      this.selectTab(this.tabs.length - 1);
    } else {
      this.tabs[this.active] = tab;
      this.selectTab(this.active);
    }
  }

  private setSideTab(tab: "collections" | "envs" | "history"): void {
    this.sideTab = tab;
    for (const [id, btn] of this.sideBtns) btn.classList.toggle("is-active", id === this.sideTab);
    this.root.classList.toggle("somnus-side-collections", this.sideTab === "collections");
    this.root.classList.toggle("somnus-side-envs", this.sideTab === "envs");
    this.root.classList.toggle("somnus-side-history", this.sideTab === "history");
  }

  // ── Environments ──

  private async refreshEnvs(): Promise<void> {
    try {
      this.envs = await somnusEnvList();
    } catch (e) {
      console.error("somnus env list failed", e);
      return;
    }
    const active = this.envs.find((e) => e.is_active);
    this.composer.setEnvs(this.envs, active?.id ?? null);
    void this.envEditor.refresh();
  }

  private async setActiveEnv(id: string | null): Promise<void> {
    try {
      await somnusEnvActivate(id);
    } catch (e) {
      console.error("somnus env activate failed", e);
    }
    await this.refreshEnvs();
  }

  private activeVars(): Map<string, string> {
    const active = this.envs.find((e) => e.is_active);
    return active ? envVarsToMap(active.vars) : new Map();
  }

  // ── Send / response ──

  private async send(): Promise<void> {
    if (this.sending) return;
    const draft = this.composer.getDraft();
    const vars = this.activeVars();
    const missing = findUnresolvedDraft(draft, vars);
    this.composer.markUnresolved(missing, findUnresolved(draft.url, vars).length > 0);
    this.sending = true;
    this.composer.setSending(true);
    try {
      const resp = await somnusSend(buildRequest(draft, vars));
      this.renderResponse(resp);
    } catch (e) {
      this.renderError(String(e));
    } finally {
      this.sending = false;
      this.composer.setSending(false);
      void this.refreshHistory();
    }
  }

  // ── Save ──

  private async saveActive(): Promise<void> {
    const tab = this.tabs[this.active];
    if (!tab) return;
    tab.draft = this.composer.getDraft();
    // Snapshot what we're sending BEFORE any await: if the user keeps typing
    // during the round-trip, composerDirty replaces tab.draft — stamping
    // savedKey from the live draft would clear the dirty dot while the server
    // holds the pre-edit version (silent data loss on closeTab).
    const sent = tab.draft;
    const sentKey = draftKey(sent);
    if (tab.treeId) {
      try {
        await somnusTreeUpdate(tab.treeId, null, JSON.stringify(sent));
        tab.savedKey = sentKey;
        this.renderTabsBar();
        this.notify("Saved");
        void this.tree.refresh();
      } catch (e) {
        this.notify(String(e), true);
      }
      return;
    }
    this.savePopover(sent, (id, name) => {
      tab.treeId = id;
      tab.name = name;
      tab.savedKey = sentKey;
      this.renderTabsBar();
    });
  }

  /// Name + destination picker on .ui-select__popover chrome, anchored to the
  /// composer. Destinations: every collection/folder from the tree.
  private savePopover(draft: SomnusDraft, onSaved: (id: string, name: string) => void): void {
    const containers = this.tree.getNodes().filter((n) => n.kind !== "request");
    if (containers.length === 0) {
      // No collection yet — create one implicitly so ⌘S always works.
      void somnusTreeCreate(null, "collection", "My requests", null).then(() => {
        void this.tree.refresh().then(() => this.savePopover(draft, onSaved));
      });
      return;
    }
    const pop = document.createElement("div");
    pop.className = "ui-select__popover somnus-savepop";
    const nameInput = document.createElement("input");
    nameInput.className = "rail-search";
    nameInput.type = "text";
    nameInput.placeholder = "Request name";
    nameInput.spellcheck = false;
    nameInput.value = draft.url.split("?")[0].split("/").filter(Boolean).slice(-1)[0] ?? "";
    const destSel = new CustomSelect({
      className: "somnus-savedest",
      ariaLabel: "Save into",
      value: containers[0].id,
      options: containers.map((c) => ({ value: c.id, label: c.name })),
    });
    const row = document.createElement("div");
    row.className = "somnus-confirm-actions";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "ui-select__option";
    save.textContent = "Save";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ui-select__option";
    cancel.textContent = "Cancel";
    row.append(save, cancel);
    pop.append(nameInput, destSel.element, row);
    document.body.append(pop);
    const anchor = this.composer.element.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.left = `${Math.max(8, anchor.right - 280)}px`;
    pop.style.top = `${anchor.top + 34}px`;
    // Outside-click / Escape dismissal — the popover is body-portaled, so
    // without this it would outlive the surface (dismissable stopPropagations
    // Escape, so it won't also close the whole surface).
    const closePop = dismissable(pop);
    cancel.addEventListener("click", closePop);
    save.addEventListener("click", () => {
      const name = nameInput.value.trim() || "Untitled";
      void somnusTreeCreate(destSel.value, "request", name, JSON.stringify(draft))
        .then((id) => {
          closePop();
          onSaved(id, name);
          this.notify("Saved");
          void this.tree.refresh();
        })
        .catch((e) => this.notify(String(e), true));
    });
    nameInput.focus();
    nameInput.select();
  }

  /// DESIGN rule 10: Esc closes the WHOLE surface back to the terminal —
  /// expanded closes the rail too. The collapse button still returns to rail.
  private closeSurface(): void {
    this.setExpanded(false);
    this.opts.onClose();
  }

  private notify(msg: string, isError = false): void {
    const el = document.createElement("div");
    el.className = `somnus-toast${isError ? " is-error" : ""}`;
    el.textContent = msg;
    this.root.append(el);
    window.setTimeout(() => el.remove(), 4000);
  }

  private renderResponse(resp: SomnusResponse): void {
    this.responseHost.replaceChildren();
    const status = document.createElement("div");
    status.className = "somnus-resp-status";
    status.setAttribute("data-spine", statusSpine(resp.status, null));
    status.textContent = [
      `${resp.status} ${resp.status_text}`.trim(),
      fmtDuration(resp.duration_ms),
      fmtSize(resp.size_bytes),
    ]
      .filter(Boolean)
      .join(" · ");
    this.responseHost.append(status);

    if (resp.headers.length) {
      const det = document.createElement("details");
      det.className = "somnus-resp-headers";
      const sum = document.createElement("summary");
      sum.textContent = `Response headers (${resp.headers.length})`;
      det.append(sum);
      const list = document.createElement("pre");
      list.textContent = resp.headers.map(([k, v]) => `${k}: ${v}`).join("\n");
      det.append(list);
      this.responseHost.append(det);
    }

    if (resp.body_binary) {
      const note = document.createElement("div");
      note.className = "rail-notice";
      note.textContent = `binary (${fmtSize(resp.size_bytes)})`;
      this.responseHost.append(note);
    } else {
      if (resp.body_truncated) {
        const note = document.createElement("div");
        note.className = "rail-notice";
        note.textContent = `Response truncated (${fmtSize(resp.size_bytes)} total)`;
        this.responseHost.append(note);
      }
      const parsed = parseJsonBody(resp.body);
      if (parsed !== undefined) {
        const tree = document.createElement("div");
        tree.className = "somnus-json-tree";
        tree.append(jsonTree(parsed));
        this.responseHost.append(tree);
      } else {
        const pre = document.createElement("pre");
        pre.className = "somnus-resp-body";
        pre.textContent = prettyBody(resp.body);
        this.responseHost.append(pre);
      }
    }
  }

  private renderError(message: string): void {
    this.responseHost.replaceChildren();
    const clean = message.replace(/^somnus:\s*/i, "");
    const dash = clean.indexOf(" — ");
    const el = document.createElement("div");
    el.className = "rail-empty is-error";
    el.innerHTML =
      Icons.alertTriangle({ size: 24 }) +
      `<div class="rail-empty-title"></div>` +
      `<div class="rail-empty-hint"></div>`;
    const titleEl = el.querySelector(".rail-empty-title");
    const hintEl = el.querySelector(".rail-empty-hint");
    if (titleEl) titleEl.textContent = dash === -1 ? clean : clean.slice(0, dash);
    if (hintEl) hintEl.textContent = dash === -1 ? "" : clean.slice(dash + 3);
    this.responseHost.append(el);
  }

  // ── History ──

  private async refreshHistory(): Promise<void> {
    try {
      const rows = await somnusHistory(50);
      this.loadedHistory = true;
      this.renderHistory(rows);
    } catch (e) {
      console.error("somnus history load failed", e);
    }
  }

  private renderHistory(rows: SomnusHistoryEntry[]): void {
    this.historyHost.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rail-notice";
      empty.textContent = "Sent requests will appear here.";
      this.historyHost.append(empty);
      return;
    }
    for (const entry of rows) {
      const row = document.createElement("div");
      row.className = "rail-row";
      row.setAttribute("data-spine", statusSpine(entry.status, entry.error));
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");

      const line = document.createElement("div");
      line.className = "rail-row-line";
      const name = document.createElement("span");
      name.className = "rail-name";
      name.textContent = entry.url;
      const when = document.createElement("span");
      when.className = "rail-when";
      when.textContent = relTimeMs(entry.created_at_unix_ms);
      line.append(name, when);

      const meta = document.createElement("div");
      meta.className = "rail-meta";
      const bits = [
        entry.method,
        entry.error ? "network error" : entry.status !== null ? String(entry.status) : "",
        fmtDuration(entry.duration_ms),
      ].filter(Boolean);
      meta.textContent = bits.join(" · ");
      row.append(line, meta);

      const saveAct = document.createElement("button");
      saveAct.type = "button";
      saveAct.className = "rail-row-action";
      saveAct.setAttribute("aria-label", "Save to collection");
      saveAct.innerHTML = Icons.save({ size: 13 });
      attachTooltip(saveAct, "Save to collection");
      saveAct.addEventListener("click", (e) => {
        e.stopPropagation();
        this.savePopover(draftFromEntry(entry), () => undefined);
      });
      row.append(saveAct);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "rail-row-action";
      del.setAttribute("aria-label", "Delete entry");
      del.innerHTML = Icons.trash({ size: 13 });
      attachTooltip(del, "Delete entry");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void somnusHistoryDelete(entry.id)
          .then(() => this.refreshHistory())
          .catch((err) => console.error("somnus delete failed", err));
      });
      row.append(del);

      const load = (): void => this.loadEntry(entry);
      row.addEventListener("click", load);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") load();
      });
      this.historyHost.append(row);
    }
  }

  private loadEntry(entry: SomnusHistoryEntry): void {
    const draft = draftFromEntry(entry);
    this.tabs[this.active] = { treeId: null, name: "", draft, savedKey: draftKey(emptyDraft()) };
    this.selectTab(this.active);
    if (entry.error) {
      this.renderError(entry.error);
    } else if (entry.status !== null) {
      this.renderResponse({
        status: entry.status,
        status_text: "",
        headers: entry.resp_headers,
        body: entry.resp_body ?? "",
        // Stored bodies are capped at STORE_CAP (2 MB, matches somnus.rs) —
        // if the original was bigger, this replay is a truncated (likely
        // unparsable) prefix. Say so.
        body_truncated: entry.resp_body !== null && (entry.size_bytes ?? 0) > 2 * 1024 * 1024,
        body_binary: entry.resp_body === null,
        duration_ms: entry.duration_ms ?? 0,
        size_bytes: entry.size_bytes ?? 0,
      });
    }
  }

  // ── Fullscreen ──

  private setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    document.body.classList.toggle("somnus-expanded", expanded);
    this.expandBtn.innerHTML = expanded
      ? Icons.chevronsDownUp({ size: 15 })
      : Icons.maximize({ size: 15 });
    this.expandTooltipDetach();
    this.expandTooltipDetach = attachTooltip(this.expandBtn, expanded ? "Collapse" : "Expand");
    if (expanded) window.addEventListener("keydown", this.onEsc, true);
    else window.removeEventListener("keydown", this.onEsc, true);
  }
}
