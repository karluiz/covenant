import {
  somnusEnvCreate,
  somnusEnvUpdate,
  somnusTreeCreate,
  somnusTreeDelete,
  somnusTreeDuplicate,
  somnusTreeImport,
  somnusTreeList,
  somnusTreeUpdate,
  type SomnusTreeNode,
} from "../api";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { emptyDraft, parseDraft } from "./draft";
import { showMenu, type MenuItem } from "./menu";
import { openConfirmPrompt } from "../workspaces/confirm-prompt";
import { parsePostman } from "./postman";

export interface TreeRow {
  node: SomnusTreeNode;
  depth: number;
  hasChildren: boolean;
}

/// Visible rows for the current open set — pure, tested.
export function flattenTree(nodes: SomnusTreeNode[], open: ReadonlySet<string>): TreeRow[] {
  const byParent = new Map<string | null, SomnusTreeNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parent_id) ?? [];
    list.push(node);
    byParent.set(node.parent_id, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sort - b.sort);
  const out: TreeRow[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const node of byParent.get(parent) ?? []) {
      const kids = byParent.get(node.id) ?? [];
      out.push({ node, depth, hasChildren: kids.length > 0 });
      if (node.kind !== "request" && open.has(node.id)) walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export interface TreeOpts {
  onOpen: (node: SomnusTreeNode) => void;
  onEnvImported: () => void;
  notify: (msg: string, isError?: boolean) => void;
}

export class CollectionsTree {
  readonly element: HTMLElement;
  private listHost: HTMLElement;
  private fileInput: HTMLInputElement;
  private nodes: SomnusTreeNode[] = [];
  private open = new Set<string>();
  private openInitialized = false;

  constructor(private opts: TreeOpts) {
    this.element = document.createElement("div");
    this.element.className = "somnus-tree";

    const toolbar = document.createElement("div");
    toolbar.className = "somnus-tree-toolbar";
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "rail-btn";
    newBtn.setAttribute("aria-label", "New collection");
    newBtn.innerHTML = Icons.plus({ size: 14 });
    attachTooltip(newBtn, "New collection");
    newBtn.addEventListener("click", () => {
      void somnusTreeCreate(null, "collection", "New collection", null)
        .then(() => this.refresh())
        .catch((e) => this.opts.notify(String(e), true));
    });
    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "rail-btn";
    importBtn.setAttribute("aria-label", "Import Postman JSON");
    importBtn.innerHTML = Icons.download({ size: 14 });
    attachTooltip(importBtn, "Import Postman collection / environment");
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = ".json,application/json";
    this.fileInput.className = "hidden";
    this.fileInput.addEventListener("change", () => void this.importFile());
    importBtn.addEventListener("click", () => this.fileInput.click());
    toolbar.append(newBtn, importBtn, this.fileInput);

    this.listHost = document.createElement("div");
    this.listHost.className = "somnus-tree-list";
    this.element.append(toolbar, this.listHost);
  }

  getNodes(): SomnusTreeNode[] {
    return this.nodes;
  }

  async refresh(): Promise<void> {
    try {
      this.render(await somnusTreeList());
    } catch (e) {
      this.opts.notify(String(e), true);
    }
  }

  render(nodes: SomnusTreeNode[]): void {
    this.nodes = nodes;
    if (!this.openInitialized) {
      // Collections start open so content is discoverable on first load.
      for (const node of nodes) if (node.kind === "collection") this.open.add(node.id);
      this.openInitialized = true;
    }
    this.listHost.replaceChildren();
    if (nodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rail-empty";
      empty.innerHTML = `<div class="rail-empty-title">No collections yet</div><div class="rail-empty-hint">Save a request with ⌘S or import from Postman.</div>`;
      this.listHost.append(empty);
      return;
    }
    for (const row of flattenTree(nodes, this.open)) this.listHost.append(this.buildRow(row));
  }

  private buildRow({ node, depth }: TreeRow): HTMLElement {
    const row = document.createElement("div");
    row.className = "rail-row somnus-tree-row";
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");

    if (node.kind === "request") {
      const chip = document.createElement("span");
      chip.className = "somnus-chip";
      const method = parseDraft(node.request).method;
      chip.dataset.method = method;
      chip.textContent = method;
      row.append(chip);
    } else {
      const chev = document.createElement("span");
      chev.className = "somnus-chevron";
      chev.classList.toggle("is-open", this.open.has(node.id));
      chev.innerHTML = Icons.chevronRight({ size: 12 });
      row.append(chev);
    }

    const name = document.createElement("span");
    name.className = "rail-name";
    name.textContent = node.name;
    row.append(name);

    const more = document.createElement("button");
    more.type = "button";
    more.className = "rail-row-action";
    more.setAttribute("aria-label", "Actions");
    more.innerHTML = Icons.moreHorizontal({ size: 13 });
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      this.openMenu(node, row, r.left, r.bottom + 2);
    });
    row.append(more);

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openMenu(node, row, e.clientX, e.clientY);
    });
    row.addEventListener("click", () => {
      if (node.kind === "request") this.opts.onOpen(node);
      else {
        if (this.open.has(node.id)) this.open.delete(node.id);
        else this.open.add(node.id);
        this.render(this.nodes);
      }
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") row.click();
    });
    return row;
  }

  private openMenu(node: SomnusTreeNode, row: HTMLElement, x: number, y: number): void {
    const container = node.kind !== "request";
    const items: MenuItem[] = [];
    if (!container) items.push({ label: "Open", onPick: () => this.opts.onOpen(node) });
    if (container) {
      items.push(
        { label: "New folder", onPick: () => this.createChild(node.id, "folder", "New folder") },
        { label: "New request", onPick: () => this.createChild(node.id, "request", "New request") },
      );
    }
    items.push(
      { label: "Rename", onPick: () => this.renameInline(node, row) },
      {
        label: "Duplicate",
        onPick: () =>
          void somnusTreeDuplicate(node.id)
            .then(() => this.refresh())
            .catch((e) => this.opts.notify(String(e), true)),
      },
      {
        label: "Delete",
        danger: true,
        onPick: () =>
          openConfirmPrompt({
            label: "Somnus",
            message: `Delete "${node.name}" and everything inside?`,
            confirmText: "Delete",
            onConfirm: () => {
              void somnusTreeDelete(node.id)
                .then(() => this.refresh())
                .catch((e) => this.opts.notify(String(e), true));
            },
          }),
      },
    );
    showMenu(x, y, items);
  }

  private createChild(parentId: string, kind: "folder" | "request", name: string): void {
    const request = kind === "request" ? JSON.stringify(emptyDraft()) : null;
    void somnusTreeCreate(parentId, kind, name, request)
      .then(async (id) => {
        this.open.add(parentId);
        await this.refresh();
        const created = this.nodes.find((n) => n.id === id);
        if (created && kind === "request") this.opts.onOpen(created);
      })
      .catch((e) => this.opts.notify(String(e), true));
  }

  private renameInline(node: SomnusTreeNode, row: HTMLElement): void {
    const name = row.querySelector(".rail-name");
    if (!name) return;
    const input = document.createElement("input");
    input.className = "rail-search somnus-rename";
    input.type = "text";
    input.value = node.name;
    input.spellcheck = false;
    name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (): void => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (next && next !== node.name) {
        void somnusTreeUpdate(node.id, next, null)
          .then(() => this.refresh())
          .catch((e) => this.opts.notify(String(e), true));
      } else {
        this.render(this.nodes);
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit();
      if (e.key === "Escape") {
        done = true;
        this.render(this.nodes);
      }
    });
    input.addEventListener("blur", commit);
  }

  private async importFile(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = "";
    if (!file) return;
    const text = await file.text();
    const parsed = parsePostman(text);
    if (!parsed) {
      this.opts.notify("Not a Postman v2.1 collection or environment", true);
      return;
    }
    try {
      if (parsed.kind === "collection") {
        const count = await somnusTreeImport(parsed.name, parsed.nodes);
        await this.refresh();
        const skipped = parsed.skipped.length ? `, ${parsed.skipped.length} items skipped` : "";
        this.opts.notify(`${count} requests imported${skipped}`);
      } else {
        const id = await somnusEnvCreate(parsed.name);
        await somnusEnvUpdate(id, parsed.name, JSON.stringify(parsed.vars));
        this.opts.onEnvImported();
        this.opts.notify(`Environment "${parsed.name}" imported (${parsed.vars.length} variables)`);
      }
    } catch (e) {
      this.opts.notify(String(e), true);
    }
  }
}
