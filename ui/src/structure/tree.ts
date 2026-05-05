// Structure (file tree) sidebar view — Zed-style lazy-loaded tree.
//
// One root = active tab's cwd. Folders load their children only when
// expanded; expanded state persists per-cwd in localStorage. Honors
// the backend's hardcoded ignore set + .gitignore (we don't see those
// entries at all). Manual refresh button re-lists from root.

import { Icons } from "../icons";
import {
  structureCreatePath,
  structureListDir,
  structureRenamePath,
  structureTrashPath,
  type DirEntry,
} from "../api";

export type FileClickHandler = (path: string) => void;
/// Fires when a tree mutation (rename / trash) succeeds so the
/// caller can close / re-route an open editor pointing at the
/// affected path. `kind` is "rename" with old + new path, or
/// "trash" with the deleted path.
export type TreeChangeHandler = (
  change:
    | { kind: "rename"; oldPath: string; newPath: string }
    | { kind: "trash"; path: string },
) => void;

interface NodeState {
  entry: DirEntry;
  expanded: boolean;
  children: NodeState[] | null; // null = not loaded
  depth: number;
  el: HTMLLIElement;
}

const LS_KEY_PREFIX = "covenant.structure.expanded.";
const LS_KEY_SHOW_IGNORED = "covenant.structure.showIgnored";

function loadExpanded(cwd: string): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY_PREFIX + cwd);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr);
  } catch {
    /* corrupt — ignore */
  }
  return new Set();
}

function saveExpanded(cwd: string, paths: Set<string>): void {
  try {
    localStorage.setItem(LS_KEY_PREFIX + cwd, JSON.stringify([...paths]));
  } catch {
    /* quota — non-fatal */
  }
}

function loadShowIgnored(): boolean {
  try {
    return localStorage.getItem(LS_KEY_SHOW_IGNORED) === "1";
  } catch {
    return false;
  }
}

function saveShowIgnored(value: boolean): void {
  try {
    localStorage.setItem(LS_KEY_SHOW_IGNORED, value ? "1" : "0");
  } catch {
    /* quota — non-fatal */
  }
}

export class StructureTree {
  private readonly root: HTMLElement;
  private readonly listEl: HTMLUListElement;
  private readonly headerEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private cwd: string | null = null;
  private nodes: NodeState[] = [];
  private expandedPaths: Set<string> = new Set();
  private visible = false;
  /// User toggle for surfacing gitignored files (e.g. `.env`). Persisted
  /// globally — once a user opts in we keep it on across cwds.
  private showIgnored: boolean = loadShowIgnored();
  /// Monotonic generation counter. Each `refreshRoot` captures the
  /// current value and re-checks after its `await structureListDir(…)`
  /// — if a newer refresh has started in the meantime (cwd flip,
  /// toggle, manual button) the older callback bails before touching
  /// the DOM. Without this, two interleaved refreshes both clear
  /// `listEl` and then both append, doubling every entry.
  private refreshGen = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly onFileClick: FileClickHandler,
    private readonly onChange?: TreeChangeHandler,
  ) {
    this.root = document.createElement("div");
    this.root.className = "structure-host";
    this.root.hidden = true;

    this.headerEl = document.createElement("header");
    this.headerEl.className = "structure-header";
    this.root.appendChild(this.headerEl);

    this.listEl = document.createElement("ul");
    this.listEl.className = "structure-list";
    this.root.appendChild(this.listEl);

    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "structure-empty";
    this.emptyEl.textContent = "Empty directory";
    this.emptyEl.hidden = true;
    this.root.appendChild(this.emptyEl);

    this.host.appendChild(this.root);
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /// Re-root the tree at `cwd`. Idempotent: passing the same cwd re-uses
  /// the existing expanded state from localStorage. Triggers a fresh
  /// `list_dir` against the new root.
  async setCwd(cwd: string): Promise<void> {
    if (this.cwd === cwd && this.nodes.length > 0) return;
    this.cwd = cwd;
    this.expandedPaths = loadExpanded(cwd);
    this.renderHeader(cwd);
    await this.refreshRoot();
  }

  /// Manual refresh: forget loaded children at all depths and re-list.
  async refresh(): Promise<void> {
    if (this.cwd) await this.refreshRoot();
  }

  private renderHeader(cwd: string): void {
    this.headerEl.innerHTML = "";
    const label = document.createElement("span");
    label.className = "structure-cwd";
    label.title = cwd;
    label.textContent = shortenCwd(cwd);
    this.headerEl.appendChild(label);

    const newFile = document.createElement("button");
    newFile.type = "button";
    newFile.className = "structure-action";
    newFile.title = "New file";
    newFile.innerHTML = Icons.filePen({ size: 12 });
    newFile.addEventListener("click", () => {
      this.startCreateAtRoot("file");
    });
    this.headerEl.appendChild(newFile);

    const newFolder = document.createElement("button");
    newFolder.type = "button";
    newFolder.className = "structure-action";
    newFolder.title = "New folder";
    newFolder.innerHTML = Icons.folder({ size: 12 });
    newFolder.addEventListener("click", () => {
      this.startCreateAtRoot("dir");
    });
    this.headerEl.appendChild(newFolder);

    const showIgnored = document.createElement("button");
    showIgnored.type = "button";
    showIgnored.className = "structure-action structure-toggle-ignored";
    showIgnored.title = this.showIgnored
      ? "Hide gitignored files (.env, build artifacts, …)"
      : "Show gitignored files (.env, build artifacts, …)";
    if (this.showIgnored) showIgnored.classList.add("structure-action-active");
    showIgnored.innerHTML = Icons.eye({ size: 12 });
    showIgnored.addEventListener("click", () => {
      this.showIgnored = !this.showIgnored;
      saveShowIgnored(this.showIgnored);
      this.renderHeader(cwd);
      void this.refresh();
    });
    this.headerEl.appendChild(showIgnored);

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "structure-refresh";
    refresh.title = "Refresh";
    refresh.textContent = "↻";
    refresh.addEventListener("click", () => {
      void this.refresh();
    });
    this.headerEl.appendChild(refresh);
  }

  private async refreshRoot(): Promise<void> {
    if (!this.cwd) return;
    const gen = ++this.refreshGen;
    const cwd = this.cwd;
    this.listEl.innerHTML = "";
    this.nodes = [];
    let entries: DirEntry[];
    try {
      entries = await structureListDir(cwd, this.showIgnored);
    } catch (err) {
      if (gen !== this.refreshGen) return;
      this.showError(String(err));
      return;
    }
    // A newer refresh ran while we were awaiting — drop our result so
    // we don't double-append into the list the newer call cleared.
    if (gen !== this.refreshGen) return;
    if (entries.length === 0) {
      this.emptyEl.hidden = false;
      return;
    }
    this.emptyEl.hidden = true;
    for (const entry of entries) {
      const node = this.makeNode(entry, 0);
      this.nodes.push(node);
      this.listEl.appendChild(node.el);
      // Restore expanded state (depth-first). Bail if a newer refresh
      // started — `expand` runs more awaits and would otherwise append
      // children into a stale tree.
      if (this.expandedPaths.has(entry.path) && entry.kind === "dir") {
        await this.expand(node);
        if (gen !== this.refreshGen) return;
      }
    }
  }

  private makeNode(entry: DirEntry, depth: number): NodeState {
    const li = document.createElement("li");
    li.className = "structure-node";
    li.dataset.kind = entry.kind;
    li.style.setProperty("--depth", String(depth));

    const row = document.createElement("div");
    row.className = "structure-row";
    li.appendChild(row);

    const chevron = document.createElement("span");
    chevron.className = "structure-chevron";
    if (entry.kind === "dir") {
      chevron.innerHTML = Icons.chevronRight({ size: 11 });
    }
    row.appendChild(chevron);

    const icon = document.createElement("span");
    icon.className = "structure-icon";
    icon.innerHTML =
      entry.kind === "dir"
        ? Icons.folder({ size: 13 })
        : Icons.fileText({ size: 13 });
    row.appendChild(icon);

    const name = document.createElement("span");
    name.className = "structure-name";
    name.textContent = entry.name;
    if (entry.is_symlink) {
      const badge = document.createElement("span");
      badge.className = "structure-symlink-badge";
      badge.title = "Symlink (not traversed)";
      badge.textContent = "↪";
      name.appendChild(badge);
    }
    row.appendChild(name);

    const node: NodeState = { entry, expanded: false, children: null, depth, el: li };

    row.addEventListener("click", () => {
      if (entry.kind === "dir" && !entry.is_symlink) {
        if (node.expanded) {
          this.collapse(node);
        } else {
          void this.expand(node);
        }
      } else if (entry.kind === "file") {
        this.onFileClick(entry.path);
      }
    });

    row.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.openContextMenu(ev.clientX, ev.clientY, node);
    });

    return node;
  }

  private openContextMenu(x: number, y: number, node: NodeState): void {
    closeAnyContextMenu();

    const menu = document.createElement("div");
    menu.className = "structure-context-menu";
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.dataset.kind = "structure-context-menu";

    // For directories, offer creating new entries inside them. We
    // skip this for files (parent is implicit) and for symlinked
    // dirs (we don't traverse those).
    if (node.entry.kind === "dir" && !node.entry.is_symlink) {
      menu.appendChild(
        makeMenuItem("New File", () => {
          closeAnyContextMenu();
          void this.startCreateInDir(node, "file");
        }),
      );
      menu.appendChild(
        makeMenuItem("New Folder", () => {
          closeAnyContextMenu();
          void this.startCreateInDir(node, "dir");
        }),
      );
    }

    menu.appendChild(
      makeMenuItem("Reveal in Finder", () => {
        closeAnyContextMenu();
        void (async () => {
          try {
            const { revealItemInDir } = await import(
              "@tauri-apps/plugin-opener"
            );
            await revealItemInDir(node.entry.path);
          } catch (err) {
            this.showError(`Reveal failed: ${err}`);
          }
        })();
      }),
    );

    const rename = makeMenuItem("Rename", () => {
      closeAnyContextMenu();
      this.startRename(node);
    });
    menu.appendChild(rename);

    const del = makeMenuItem("Move to Trash", () => {
      closeAnyContextMenu();
      void this.confirmAndTrash(node);
    });
    del.classList.add("danger");
    menu.appendChild(del);

    document.body.appendChild(menu);

    // Clamp to viewport so it doesn't render off-screen.
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = `${window.innerWidth - rect.width - 4}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = `${window.innerHeight - rect.height - 4}px`;
      }
    });

    const dismiss = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && menu.contains(e.target as Node)) return;
      closeAnyContextMenu();
    };
    setTimeout(() => {
      document.addEventListener("click", dismiss, { once: true });
      document.addEventListener("keydown", dismiss, { once: true });
    }, 0);
    menu.dataset.dismissBound = "1";
  }

  /// Swap the node's name span for an inline `<input>` and let the
  /// user type a new name. Enter renames; Esc / blur cancels.
  private startRename(node: NodeState): void {
    const nameEl = node.el.querySelector(".structure-name");
    if (!(nameEl instanceof HTMLElement)) return;

    const oldName = node.entry.name;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "structure-rename-input";
    input.value = oldName;
    input.spellcheck = false;

    nameEl.replaceWith(input);
    input.focus();
    // Select the stem (everything before the final dot) so the
    // extension stays untouched in the typical rename case.
    const dot = oldName.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      const restoreSpan = (text: string) => {
        const span = document.createElement("span");
        span.className = "structure-name";
        span.textContent = text;
        input.replaceWith(span);
      };
      if (!commit || next === oldName || next.length === 0 || next.includes("/")) {
        restoreSpan(oldName);
        return;
      }
      const oldPath = node.entry.path;
      const slash = oldPath.lastIndexOf("/");
      const newPath = slash >= 0 ? oldPath.slice(0, slash + 1) + next : next;
      restoreSpan(next);
      void this.applyRename(oldPath, newPath);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  private async applyRename(oldPath: string, newPath: string): Promise<void> {
    try {
      await structureRenamePath(oldPath, newPath);
    } catch (err) {
      this.showError(`Rename failed: ${err}`);
      await this.refresh();
      return;
    }
    this.onChange?.({ kind: "rename", oldPath, newPath });
    await this.refresh();
  }

  /// Inline-create at the tree root. Adds a placeholder `<li>` with an
  /// input at the top of the list; Enter commits, Escape/blur cancels.
  /// We deliberately don't pre-mutate the data model: only after the
  /// backend confirms creation do we re-list, which keeps the row in
  /// the correct sort position.
  private startCreateAtRoot(kind: "file" | "dir"): void {
    if (!this.cwd) return;
    this.startInlineCreate(this.cwd, kind, this.listEl, 0, null);
  }

  /// Inline-create inside an expanded directory node. Expands the dir
  /// first if it isn't already (so the input shows up where the new
  /// child will land).
  private async startCreateInDir(
    node: NodeState,
    kind: "file" | "dir",
  ): Promise<void> {
    if (node.entry.kind !== "dir" || node.entry.is_symlink) return;
    if (!node.expanded) await this.expand(node);
    let childList = node.el.querySelector<HTMLUListElement>(".structure-children");
    if (!childList) {
      childList = document.createElement("ul");
      childList.className = "structure-children";
      node.el.appendChild(childList);
    }
    childList.hidden = false;
    this.startInlineCreate(node.entry.path, kind, childList, node.depth + 1, node);
  }

  private startInlineCreate(
    parentPath: string,
    kind: "file" | "dir",
    container: HTMLUListElement,
    depth: number,
    parentNode: NodeState | null,
  ): void {
    // If a creation row is already open, focus it instead of stacking.
    const existing = container.querySelector(".structure-create-row");
    if (existing instanceof HTMLElement) {
      const input = existing.querySelector("input");
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }

    const li = document.createElement("li");
    li.className = "structure-node structure-create-row";
    li.dataset.kind = kind === "dir" ? "dir" : "file";
    li.style.setProperty("--depth", String(depth));

    const row = document.createElement("div");
    row.className = "structure-row";
    li.appendChild(row);

    const chevron = document.createElement("span");
    chevron.className = "structure-chevron";
    if (kind === "dir") chevron.innerHTML = Icons.chevronRight({ size: 11 });
    row.appendChild(chevron);

    const icon = document.createElement("span");
    icon.className = "structure-icon";
    icon.innerHTML =
      kind === "dir"
        ? Icons.folder({ size: 13 })
        : Icons.fileText({ size: 13 });
    row.appendChild(icon);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "structure-rename-input";
    input.placeholder = kind === "dir" ? "new-folder" : "new-file";
    input.spellcheck = false;
    row.appendChild(input);

    container.insertBefore(li, container.firstChild);
    input.focus();

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      li.remove();
      if (!commit || name.length === 0 || name.includes("/")) return;
      const sep = parentPath.endsWith("/") ? "" : "/";
      const newPath = `${parentPath}${sep}${name}`;
      void this.applyCreate(newPath, kind, parentNode);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
  }

  private async applyCreate(
    path: string,
    kind: "file" | "dir",
    parentNode: NodeState | null,
  ): Promise<void> {
    try {
      await structureCreatePath(path, kind);
    } catch (err) {
      this.showError(`Create failed: ${err}`);
      await this.refresh();
      return;
    }
    // Persist the parent's expanded state so the post-refresh tree
    // doesn't snap closed and hide the just-created entry.
    if (parentNode && this.cwd) {
      this.expandedPaths.add(parentNode.entry.path);
      saveExpanded(this.cwd, this.expandedPaths);
    }
    await this.refresh();
    // For files, jump straight into editing it — matches what the
    // user wanted when they clicked "New File".
    if (kind === "file") this.onFileClick(path);
  }

  private async confirmAndTrash(node: NodeState): Promise<void> {
    const ok = await confirmTrash(node.entry.name, node.entry.kind);
    if (!ok) return;
    try {
      await structureTrashPath(node.entry.path);
    } catch (err) {
      this.showError(`Move to Trash failed: ${err}`);
      return;
    }
    this.onChange?.({ kind: "trash", path: node.entry.path });
    await this.refresh();
  }

  private async expand(node: NodeState): Promise<void> {
    if (node.expanded) return;
    if (node.entry.kind !== "dir") return;
    node.expanded = true;
    node.el.classList.add("structure-node-expanded");
    if (this.cwd) {
      this.expandedPaths.add(node.entry.path);
      saveExpanded(this.cwd, this.expandedPaths);
    }
    if (node.children !== null) {
      // Already loaded — just re-show.
      const childList = node.el.querySelector(".structure-children");
      if (childList instanceof HTMLElement) childList.hidden = false;
      return;
    }
    let entries: DirEntry[];
    try {
      entries = await structureListDir(node.entry.path, this.showIgnored);
    } catch (err) {
      const errEl = document.createElement("div");
      errEl.className = "structure-error";
      errEl.textContent = String(err);
      node.el.appendChild(errEl);
      return;
    }
    const childList = document.createElement("ul");
    childList.className = "structure-children";
    node.children = [];
    for (const entry of entries) {
      const child = this.makeNode(entry, node.depth + 1);
      node.children.push(child);
      childList.appendChild(child.el);
      if (this.expandedPaths.has(entry.path) && entry.kind === "dir") {
        await this.expand(child);
      }
    }
    node.el.appendChild(childList);
  }

  private collapse(node: NodeState): void {
    if (!node.expanded) return;
    node.expanded = false;
    node.el.classList.remove("structure-node-expanded");
    const childList = node.el.querySelector(".structure-children");
    if (childList instanceof HTMLElement) childList.hidden = true;
    if (this.cwd) {
      this.expandedPaths.delete(node.entry.path);
      saveExpanded(this.cwd, this.expandedPaths);
    }
  }

  private showError(msg: string): void {
    this.listEl.innerHTML = "";
    const err = document.createElement("div");
    err.className = "structure-error";
    err.textContent = msg;
    this.listEl.appendChild(err);
  }
}

function shortenCwd(cwd: string): string {
  // Show last 2 segments for compactness. Full path on hover.
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) return cwd;
  return ".../" + parts.slice(-2).join("/");
}

function makeMenuItem(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "structure-context-menu-item";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function closeAnyContextMenu(): void {
  document
    .querySelectorAll('[data-kind="structure-context-menu"]')
    .forEach((el) => el.remove());
}

/// Modal confirmation for moving a path to Trash. Resolves with
/// `true` if the user confirms, `false` on cancel / Escape.
function confirmTrash(name: string, kind: "file" | "dir"): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "structure-confirm-overlay";

    const dialog = document.createElement("div");
    dialog.className = "structure-confirm-dialog";

    const heading = document.createElement("h3");
    heading.textContent = `Move ${kind === "dir" ? "folder" : "file"} to Trash?`;
    dialog.appendChild(heading);

    const body = document.createElement("p");
    body.textContent = name;
    dialog.appendChild(body);

    const note = document.createElement("p");
    note.className = "structure-confirm-note";
    note.textContent = "You can restore it from the system Trash.";
    dialog.appendChild(note);

    const actions = document.createElement("div");
    actions.className = "structure-confirm-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "structure-confirm-cancel";
    cancel.textContent = "Cancel";
    actions.appendChild(cancel);

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "structure-confirm-ok";
    confirm.textContent = "Move to Trash";
    actions.appendChild(confirm);

    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const close = (result: boolean) => {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter") close(true);
    };

    cancel.addEventListener("click", () => close(false));
    confirm.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener("keydown", onKey);

    requestAnimationFrame(() => confirm.focus());
  });
}
