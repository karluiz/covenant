// Structure (file tree) sidebar view — Zed-style lazy-loaded tree.
//
// One root = active tab's cwd. Folders load their children only when
// expanded; expanded state persists per-cwd in localStorage. Honors
// the backend's hardcoded ignore set + .gitignore (we don't see those
// entries at all). Manual refresh button re-lists from root.

import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { resolveFileIcon, resolveFolderIcon } from "./file-icons";
import { ContextMenu, type MenuItem } from "../menu/context-menu";
import { formatChord } from "../platform";
import {
  shareFileAsGist,
  copyGistLink,
  revokeGist,
  isGistShared,
  ensureGistSharesLoaded,
  GIST_SHARES_EVENT,
} from "../gist/share";
import { pushInfoToast } from "../notifications/toast";
import {
  structureClipboardFiles,
  getDirContext,
  gitRepoSummary,
  structureClipboardSetFiles,
  structureCopyInto,
  structureCreatePath,
  structureListDir,
  structureMoveInto,
  structureRenamePath,
  structureTrashPath,
  type DirEntry,
  type GitRepoSummary,
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

/// "New Group Here" — a group rooted at `dir`, named after its
/// basename, with a shell tab inside. Same anchor as `covenant <path>`,
/// so it also reuses an existing group already rooted there.
/// ponytail: dynamic import of main.ts to reach the TabManager singleton
/// without a static cycle (main → tree). Thread a callback in if the
/// tree ever needs more than one manager call.
async function openGroupAt(dir: string): Promise<void> {
  const { tabsManager } = await import("../main");
  await tabsManager?.openCliPath(dir, true);
}

const LS_KEY_PREFIX = "covenant.structure.expanded.";
const LS_KEY_SHOW_IGNORED = "covenant.structure.showIgnored";

// ponytail: module-level 5s memo — repo_summary spawns per-worktree git
// subprocesses and decorate fires on every cd; server-side cache if this
// ever needs cross-component sharing.
const repoSummaryCache = new Map<string, { at: number; p: Promise<GitRepoSummary> }>();
function cachedRepoSummary(cwd: string): Promise<GitRepoSummary> {
  const hit = repoSummaryCache.get(cwd);
  if (hit && Date.now() - hit.at < 5000) return hit.p;
  const p = gitRepoSummary(cwd);
  repoSummaryCache.set(cwd, { at: Date.now(), p });
  p.catch(() => {
    // Don't memoize failures — but only evict our own entry, not a
    // fresher refetch that replaced it while we were in flight.
    if (repoSummaryCache.get(cwd)?.p === p) repoSummaryCache.delete(cwd);
  });
  return p;
}
/// Test-only escape hatch: the memo above is module-level and otherwise
/// outlives any one `StructureTree` instance, so tests that reuse the same
/// cwd across cases with different mocked summaries need to clear it.
export function __resetRepoSummaryCacheForTests(): void {
  repoSummaryCache.clear();
}

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
  private readonly branchEl: HTMLElement;
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

  /// Worktree root the view is pinned to, or null when following the
  /// terminal's cwd. While pinned, `setCwd` records but does not re-root.
  private pinnedRoot: string | null = null;
  /// Last cwd the terminal reported — the root `unpin()` returns to.
  private lastTerminalCwd: string | null = null;

  /// Shared floating-menu chrome — same component the editor / tabs use,
  /// so all context menus look and behave identically.
  private readonly contextMenu = new ContextMenu(document.body);

  /// Bespoke popover for the worktree selector (DESIGN.md rule 14 — rich
  /// rows with an icon + MAIN badge + branch hint don't fit ContextMenu's
  /// item shape, so this wears the shared `.ui-select__*` chrome directly
  /// instead of `.ctx-menu`). Body-portaled, one at a time.
  private worktreePopover: HTMLDivElement | null = null;
  private worktreePopoverOutside: ((e: PointerEvent) => void) | null = null;
  private worktreePopoverKey: ((e: KeyboardEvent) => void) | null = null;
  private worktreePopoverReposition: (() => void) | null = null;

  /// Path of the file currently open in the editor pane, or null when
  /// no file is open. The matching row gets `.is-active` (CSS gives it
  /// an accent tint + 2px left stripe). Set by manager.ts from
  /// openEditor / editor onClose.
  private activePath: string | null = null;
  private activeNode: NodeState | null = null;
  /// Path of the row currently being dragged within the tree (internal
  /// drag-to-move), or null when no internal drag is in flight. Used to
  /// distinguish our HTML5 drag from unrelated drags and to know the
  /// source on drop. (Finder→tree drops go through `file-drop.ts` and the
  /// native `onDragDropEvent` path, not this.)
  private draggingPath: string | null = null;
  /// Row currently showing the `.structure-drop-target` highlight during
  /// an internal drag.
  private dragHighlight: HTMLElement | null = null;
  /// Floating label that follows the pointer during an internal drag.
  private dragGhost: HTMLElement | null = null;
  /// Monotonic counter. Each call to `revealActivePath` captures the
  /// current value and bails on any await if a newer reveal has
  /// started — avoids two reveals interleaving DOM updates.
  private revealGen = 0;

  /// Copy/paste clipboard (VS Code-style ⌘C/⌘V). The OS clipboard is the
  /// source of truth — Copy writes the path there too, so Finder↔tree
  /// copy/paste works both ways. This field is only the fallback for
  /// platforms where the native clipboard isn't wired yet (non-macOS).
  /// Paste uses the same collision-safe `copy_into` as Finder drops —
  /// pasting into the same folder yields `name (2)`, i.e. duplicate.
  private clipboardPath: string | null = null;
  /// Last row the user clicked or right-clicked — the target for keyboard
  /// ⌘C/⌘V and the `.is-selected` outline. Distinct from `activeNode`
  /// (the file currently open in the editor).
  private selectedNode: NodeState | null = null;

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

    this.branchEl = document.createElement("div");
    this.branchEl.className = "structure-branch";
    this.branchEl.hidden = true;
    this.root.appendChild(this.branchEl);

    this.listEl = document.createElement("ul");
    this.listEl.className = "structure-list";
    this.root.appendChild(this.listEl);

    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "structure-empty";
    this.emptyEl.textContent = "Empty directory";
    this.emptyEl.hidden = true;
    this.root.appendChild(this.emptyEl);

    this.host.appendChild(this.root);

    // Right-click on the list background / empty area / header (anywhere
    // not on a row). The per-row handler in makeNode() owns right-clicks
    // on a node; here we catch everything else so (a) the native WebView
    // menu (Reload / AutoFill) never appears inside the tree, and (b) the
    // user can create entries at the tree root from empty space.
    this.root.addEventListener("contextmenu", (ev) => {
      if ((ev.target as HTMLElement).closest(".structure-node")) return;
      ev.preventDefault();
      if (!this.cwd) return;
      void this.openRootContextMenu(ev.clientX, ev.clientY);
    });

    // Focusable so ⌘C/⌘V land here when the tree (not the editor) is
    // focused. tabIndex -1 = programmatic focus only, not in tab order.
    this.root.tabIndex = -1;
    this.root.addEventListener("keydown", (ev) => this.onKeyDown(ev));

    // Badge shared-as-gist rows, and re-badge whenever a share is
    // published / revoked anywhere (tree menu or editor button).
    ensureGistSharesLoaded();
    window.addEventListener(GIST_SHARES_EVENT, () => this.refreshGistBadges());
  }

  /// Sync every rendered file row's gist badge with the share cache.
  private refreshGistBadges(): void {
    const rows = this.listEl.querySelectorAll<HTMLElement>(
      'li.structure-node[data-kind="file"] > .structure-row',
    );
    for (const row of rows) {
      const path = row.parentElement?.dataset.path ?? "";
      const badge = row.querySelector(".structure-gist-badge");
      if (isGistShared(path)) {
        if (!badge) row.appendChild(makeGistBadge());
      } else {
        badge?.remove();
      }
    }
  }

  /// VS Code-style ⌘C (copy selected node) / ⌘V (paste into the selected
  /// node's folder). Only fires when the tree holds focus — clicking a file
  /// hands focus to the editor, so its ⌘C/⌘V win there; use right-click Copy
  /// on a file instead. ponytail: keyboard target = last-clicked node; no
  /// arrow-key navigation, add if users ask.
  private onKeyDown(ev: KeyboardEvent): void {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey) return;
    const key = ev.key.toLowerCase();
    if (key === "c" && this.selectedNode) {
      ev.preventDefault();
      this.copyToClipboard(this.selectedNode.entry.path);
    } else if (key === "v") {
      ev.preventDefault();
      void this.pasteClipboard(this.selectedNode);
    }
  }

  /// Mark a row as selected (keyboard ⌘C/⌘V target + `.is-selected`
  /// outline). Cleared implicitly on refresh when rows are rebuilt.
  private selectNode(node: NodeState | null): void {
    if (this.selectedNode === node) return;
    this.selectedNode?.el
      .querySelector(".structure-row")
      ?.classList.remove("is-selected");
    this.selectedNode = node;
    node?.el.querySelector(".structure-row")?.classList.add("is-selected");
  }

  /// Destination directory for a paste, given the selected node: into a
  /// folder itself, into a file's parent, or the tree root when nothing is
  /// selected. Then copy the clipboard path in via `ingestDrop` (same
  /// collision-safe copy + expand + refresh as a Finder drop).
  private copyToClipboard(path: string): void {
    this.clipboardPath = path;
    void structureClipboardSetFiles([path]).catch(() => {});
  }

  /// What a Paste would ingest: the OS clipboard (Finder ⌘C, and our own
  /// Copy, which writes there) falling back to the in-memory path.
  private async clipboardSources(): Promise<string[]> {
    const os = await structureClipboardFiles().catch(() => [] as string[]);
    if (os.length > 0) return os;
    return this.clipboardPath ? [this.clipboardPath] : [];
  }

  private async pasteClipboard(target: NodeState | null): Promise<void> {
    const src = await this.clipboardSources();
    if (src.length === 0 || !this.cwd) return;
    let destDir: string;
    if (!target) destDir = this.cwd;
    else if (target.entry.kind === "dir" && !target.entry.is_symlink)
      destDir = target.entry.path;
    else destDir = parentDir(target.entry.path, this.cwd);
    await this.ingestDrop(src, destDir);
  }

  /// Pointer-based drag-to-move. We can't use HTML5 DnD here: the Tauri
  /// webview has `dragDropEnabled` on (for the Finder→tree native drop), and
  /// on macOS WKWebView that swallows in-page HTML5 `dragstart`/`drop`. So we
  /// synthesize the drag from pointer events, exactly like the tab strip does
  /// (see `installTabPointerDrag` in tabs/manager.ts).
  private beginRowDrag(e: PointerEvent, node: NodeState): void {
    const startX = e.clientX;
    const startY = e.clientY;
    let activated = false;

    const onMove = (ev: PointerEvent): void => {
      if (!activated) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (dx * dx + dy * dy < 5 * 5) return; // movement threshold
        activated = true;
        this.draggingPath = node.entry.path;
        document.body.classList.add("structure-dragging");
        this.dragGhost = this.makeDragGhost(node.entry.name);
        document.body.appendChild(this.dragGhost);
      }
      if (this.dragGhost) {
        this.dragGhost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 6}px)`;
      }
      const elemAtPoint = document.elementFromPoint(ev.clientX, ev.clientY);
      const acpComposer = elemAtPoint?.closest<HTMLElement>(".acp-composer");
      if (acpComposer) {
        this.setDragHighlight(acpComposer);
      } else {
        const target = this.resolveDropTarget(elemAtPoint);
        if (target) this.setDragHighlight(target.highlight);
        else this.clearDragHighlight();
      }
    };

    const onUp = (ev: PointerEvent): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const wasDragging = activated;
      if (this.dragGhost) {
        this.dragGhost.remove();
        this.dragGhost = null;
      }
      document.body.classList.remove("structure-dragging");
      this.clearDragHighlight();
      const src = this.draggingPath;
      this.draggingPath = null;
      if (!wasDragging) return; // a plain click — let the row handler run
      // Swallow the click that the browser fires after this pointerup so a
      // drag that ends on the source row doesn't also toggle/open it.
      const swallow = (ce: Event): void => {
        ce.stopPropagation();
        ce.preventDefault();
        window.removeEventListener("click", swallow, true);
      };
      window.addEventListener("click", swallow, true);
      setTimeout(() => window.removeEventListener("click", swallow, true), 0);

      const elemAtPoint = document.elementFromPoint(ev.clientX, ev.clientY);
      const acpComposer = elemAtPoint?.closest<HTMLElement>(".acp-composer");
      if (src && acpComposer) {
        window.dispatchEvent(
          new CustomEvent("covenant:acp-file-drop", {
            detail: { path: src, target: elemAtPoint },
          }),
        );
        return;
      }
      const target = this.resolveDropTarget(elemAtPoint);
      if (src && target) void this.moveEntry(src, target.dir);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  private makeDragGhost(label: string): HTMLElement {
    const g = document.createElement("div");
    g.className = "structure-drag-ghost";
    g.textContent = label;
    return g;
  }

  private setDragHighlight(el: HTMLElement): void {
    if (this.dragHighlight === el) return;
    this.clearDragHighlight();
    el.classList.add("structure-drop-target");
    this.dragHighlight = el;
  }

  private clearDragHighlight(): void {
    if (this.dragHighlight) {
      this.dragHighlight.classList.remove("structure-drop-target");
      this.dragHighlight = null;
    }
  }

  /// Move a single dragged entry into `destDir` (internal drag-to-move).
  /// No-ops when dropped into the folder it already lives in. Reroutes an
  /// open editor via the `rename` change event when the moved file was
  /// open, then refreshes.
  private async moveEntry(src: string, destDir: string): Promise<void> {
    if (this.cwd && parentDir(src, this.cwd) === destDir) return; // already there
    let created: string[];
    try {
      created = await structureMoveInto([src], destDir);
    } catch (err) {
      this.showError(`Move failed: ${err}`);
      return;
    }
    const newPath = created[0];
    if (newPath && newPath !== src) {
      this.onChange?.({ kind: "rename", oldPath: src, newPath });
    }
    if (this.cwd && destDir !== this.cwd) {
      this.expandedPaths.add(destDir);
      saveExpanded(this.cwd, this.expandedPaths);
    }
    await this.refresh();
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    if (!this.cwd) this.renderWaiting();
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

  /// The tree's root container element. Used by the file-drop module to
  /// test whether a drop position landed inside the tree at all.
  get element(): HTMLElement {
    return this.root;
  }

  /// Resolve where a dropped OS file should land, given the DOM element
  /// under the pointer. Returns the destination directory plus the row
  /// element to highlight, or null if the point isn't over the tree (so
  /// the caller can ignore drops onto the terminal / other panels).
  ///
  /// - Over a folder row → into that folder.
  /// - Over a file row → into that file's parent folder.
  /// - Over empty tree space → into the tree root (cwd).
  resolveDropTarget(
    el: Element | null,
  ): { dir: string; highlight: HTMLElement } | null {
    if (!this.cwd || !el || !this.root.contains(el)) return null;
    const li = el.closest<HTMLElement>(".structure-node");
    const path = li?.dataset.path;
    if (li && path) {
      const row = li.querySelector<HTMLElement>(".structure-row") ?? li;
      if (li.dataset.kind === "dir") {
        return { dir: path, highlight: row };
      }
      // File row → drop into its parent directory.
      return { dir: parentDir(path, this.cwd), highlight: row };
    }
    // Empty space within the tree → root.
    return { dir: this.cwd, highlight: this.root };
  }

  /// Copy dropped OS paths into `destDir` (Finder → tree drag-drop).
  /// On success, expands the target folder and refreshes so the new
  /// entries are visible; on failure surfaces the error inline.
  async ingestDrop(sources: string[], destDir: string): Promise<void> {
    if (sources.length === 0) return;
    try {
      await structureCopyInto(sources, destDir);
    } catch (err) {
      this.showError(`Drop failed: ${err}`);
      return;
    }
    // Keep the destination expanded across the refresh so the dropped
    // entries don't land in a collapsed folder the user can't see.
    if (this.cwd && destDir !== this.cwd) {
      this.expandedPaths.add(destDir);
      saveExpanded(this.cwd, this.expandedPaths);
    }
    await this.refresh();
  }

  /// The terminal reports its cwd. Recorded always; while the view is
  /// pinned to another worktree the report does not re-root the tree.
  async setCwd(cwd: string): Promise<void> {
    this.lastTerminalCwd = cwd;
    if (this.pinnedRoot) return;
    await this.reroot(cwd);
  }

  /// Pin the view to a sibling worktree root. Shell cds stop re-rooting
  /// the tree until `unpin()`.
  async pinTo(path: string): Promise<void> {
    this.pinnedRoot = path;
    await this.reroot(path);
    if (this.cwd) this.renderHeader(this.cwd); // reroot may early-return; indicator must still update
  }

  /// Return to following the terminal's cwd.
  async unpin(): Promise<void> {
    this.pinnedRoot = null;
    if (this.lastTerminalCwd) await this.reroot(this.lastTerminalCwd);
    if (this.cwd) this.renderHeader(this.cwd);
  }

  get pinned(): string | null {
    return this.pinnedRoot;
  }

  /// Re-root the tree at `cwd`. Idempotent: passing the same cwd re-uses
  /// the existing expanded state from localStorage. Triggers a fresh
  /// `list_dir` against the new root.
  private async reroot(cwd: string): Promise<void> {
    if (this.cwd === cwd && this.nodes.length > 0) return;
    this.clearActive();
    this.activePath = null;
    this.cwd = cwd;
    this.expandedPaths = loadExpanded(cwd);
    this.renderHeader(cwd);
    this.renderBranch(cwd);
    await this.refreshRoot();
  }

  /// Manual refresh: forget loaded children at all depths and re-list.
  async refresh(): Promise<void> {
    if (this.cwd) await this.refreshRoot();
  }

  private renderWaiting(): void {
    this.branchEl.hidden = true;
    this.headerEl.innerHTML = "";
    const label = document.createElement("span");
    label.className = "structure-cwd";
    label.title = "Waiting for the terminal to report its current directory";
    label.textContent = "Waiting for shell cwd…";
    this.headerEl.appendChild(label);

    this.listEl.innerHTML = "";
    this.emptyEl.textContent = "Waiting for the terminal to report its current directory.";
    this.emptyEl.hidden = false;
  }

  private renderHeader(cwd: string): void {
    this.headerEl.innerHTML = "";
    const label = document.createElement("span");
    label.className = "structure-cwd";
    label.title = cwd;
    label.textContent = shortenCwd(cwd);
    this.headerEl.appendChild(label);

    if (this.pinnedRoot) {
      const pin = document.createElement("span");
      pin.className = "structure-cwd-pin";
      pin.innerHTML = Icons.pin({ size: 10 });
      label.prepend(pin);
    }
    this.decorateWorktreeSelector(cwd, label);

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

    const changes = document.createElement("button");
    changes.type = "button";
    changes.className = "structure-action";
    changes.innerHTML = Icons.gitCompare({ size: 12 });
    attachTooltip(changes, "View changes (git diff)");
    changes.addEventListener("click", () => {
      window.dispatchEvent(
        new CustomEvent("covenant:open-changes", { detail: { cwd } }),
      );
    });
    this.headerEl.appendChild(changes);

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

  /// Fill the branch bar under the path. Async: the branch comes from a
  /// git probe (get_dir_context, cached 5s). Captures `cwd` so a re-root
  /// mid-flight drops a stale result. Hidden when the cwd is not a repo.
  private renderBranch(cwd: string): void {
    this.branchEl.hidden = true;
    this.branchEl.innerHTML = "";
    if (!cwd) return;
    void getDirContext(cwd)
      .then((ctx) => {
        if (this.cwd !== cwd) return; // re-rooted while awaiting
        const branch = ctx.git?.branch;
        if (!branch) return; // not a repo → stay hidden
        const chip = document.createElement("span");
        chip.className = "structure-branch-chip";
        chip.title = branch;
        chip.innerHTML =
          Icons.gitBranch({ size: 11 }) +
          `<span class="structure-branch-name"></span>`;
        chip.querySelector(".structure-branch-name")!.textContent = branch;
        this.branchEl.appendChild(chip);
        this.branchEl.hidden = false;
      })
      .catch(() => {
        /* probe failed — leave the bar hidden */
      });
  }

  /// Upgrade the plain cwd label into a worktree selector when the repo
  /// has sibling worktrees. Async probe; a stale result (re-rooted while
  /// awaiting, or header rebuilt) is dropped via the isConnected check.
  private decorateWorktreeSelector(cwd: string, label: HTMLElement): void {
    void cachedRepoSummary(cwd)
      .then((repo) => {
        if (this.cwd !== cwd || !label.isConnected) return;
        // A pinned tree always needs the selector, even with a single
        // worktree left — otherwise pinning then pruning the last linked
        // worktree strands the view with no UI path to unpin.
        if (repo.worktrees.length < 2 && !this.pinnedRoot) return;
        label.classList.add("structure-cwd-selector");

        // Wrap the existing text node so `text-overflow: ellipsis` still
        // applies once the label becomes an inline-flex selector — a bare
        // text node is an anonymous flex item and ignores ellipsis, which
        // instead clips the chevron.
        const textNode = Array.from(label.childNodes).find(
          (n) => n.nodeType === Node.TEXT_NODE,
        );
        if (textNode) {
          const textSpan = document.createElement("span");
          textSpan.className = "structure-cwd-text";
          textSpan.textContent = textNode.textContent;
          textNode.replaceWith(textSpan);
        }

        const chevron = document.createElement("span");
        chevron.className = "structure-cwd-chevron";
        chevron.innerHTML = Icons.chevronsUpDown({ size: 10 });
        label.appendChild(chevron);
        label.setAttribute("role", "button");
        label.setAttribute("tabindex", "0");
        label.removeAttribute("title");
        attachTooltip(
          label,
          this.pinnedRoot
            ? `Pinned to ${cwd} — click to change`
            : "Switch which worktree the tree shows",
        );
        // Re-fetch on open (5s memo keeps the common case free) so a
        // worktree spawned after this header rendered still shows up —
        // the handlers used to close over the decoration-time `repo`.
        const open = (): void => {
          void cachedRepoSummary(cwd)
            .then((fresh) => {
              if (this.cwd !== cwd || !label.isConnected) return;
              this.openWorktreeMenu(label, fresh);
            })
            .catch(() => {});
        };
        label.addEventListener("click", () => open());
        label.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            if (ev.key === " ") ev.preventDefault();
            open();
          }
        });
      })
      .catch(() => {
        /* not a repo or probe failed — stay a plain label */
      });
  }

  /// Dropdown listing "Follow terminal" + every worktree (main first).
  /// Rich rows (MAIN badge, branch hint) don't fit ContextMenu's item
  /// shape, so this is a bespoke popover wearing the shared
  /// `.ui-select__*` chrome (DESIGN.md rule 14) rather than `.ctx-menu`.
  private openWorktreeMenu(anchor: HTMLElement, repo: GitRepoSummary): void {
    this.closeWorktreeMenu();
    if (!anchor.isConnected) return;

    const viewed = this.cwd;
    const rows = [...repo.worktrees].sort(
      (a, b) => Number(b.is_main) - Number(a.is_main),
    );
    const viewedRoot =
      rows
        .filter((wt) => viewed === wt.path || (viewed?.startsWith(wt.path + "/") ?? false))
        .sort((a, b) => b.path.length - a.path.length)[0]?.path ?? null;

    const pop = document.createElement("div");
    pop.className = "ui-select__popover structure-wt-popover";
    pop.setAttribute("role", "listbox");
    pop.setAttribute("aria-label", "Worktrees");
    document.body.appendChild(pop);
    this.worktreePopover = pop;

    const addOption = (opts: {
      label: string;
      selected: boolean;
      badge?: string;
      branch?: string;
      onSelect: () => void;
    }): void => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "ui-select__option";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(opts.selected));
      row.classList.toggle("is-selected", opts.selected);
      const check = document.createElement("span");
      check.className = "ui-select__option-check";
      check.setAttribute("aria-hidden", "true");
      check.textContent = opts.selected ? "✓" : "";
      row.appendChild(check);
      const label = document.createElement("span");
      label.className = "ui-select__option-label";
      label.textContent = opts.label;
      row.appendChild(label);
      if (opts.badge) {
        const badge = document.createElement("span");
        badge.className = "structure-wt-badge";
        badge.textContent = opts.badge;
        row.appendChild(badge);
      }
      if (opts.branch) {
        const branch = document.createElement("span");
        branch.className = "structure-wt-branch";
        branch.textContent = opts.branch;
        row.appendChild(branch);
      }
      row.addEventListener("click", () => {
        this.closeWorktreeMenu();
        opts.onSelect();
      });
      pop.appendChild(row);
    };

    addOption({
      label: "Follow terminal",
      selected: !this.pinnedRoot,
      onSelect: () => void this.unpin(),
    });

    const divider = document.createElement("div");
    divider.className = "structure-wt-divider";
    pop.appendChild(divider);

    for (const wt of rows) {
      addOption({
        label: wt.path.split("/").pop() ?? wt.path,
        selected: wt.path === viewedRoot,
        badge: wt.is_main ? "MAIN" : undefined,
        branch: wt.branch ?? undefined,
        onSelect: () => void this.pinTo(wt.path),
      });
    }

    this.positionWorktreePopover(anchor);

    // Mirrors CustomSelect's dismissal: outside pointerdown, Escape, and
    // reposition (not dismiss) on scroll/resize while open.
    this.worktreePopoverOutside = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (!anchor.isConnected) {
        this.closeWorktreeMenu();
        return;
      }
      if (pop.contains(target)) return;
      if (anchor.contains(target)) return;
      this.closeWorktreeMenu();
    };
    this.worktreePopoverKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      this.closeWorktreeMenu();
      anchor.focus();
    };
    this.worktreePopoverReposition = (): void => this.positionWorktreePopover(anchor);

    setTimeout(() => {
      if (!this.worktreePopover) return;
      document.addEventListener("pointerdown", this.worktreePopoverOutside!);
      document.addEventListener("keydown", this.worktreePopoverKey!);
      window.addEventListener("resize", this.worktreePopoverReposition!);
      window.addEventListener("scroll", this.worktreePopoverReposition!, true);
    }, 0);
  }

  private positionWorktreePopover(anchor: HTMLElement): void {
    if (!this.worktreePopover || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const pop = this.worktreePopover;
    pop.style.minWidth = `${Math.max(rect.width, 200)}px`;
    pop.style.maxWidth = `${Math.max(200, window.innerWidth - margin * 2)}px`;
    const popRect = pop.getBoundingClientRect();
    const left = Math.min(
      Math.max(margin, rect.left),
      Math.max(margin, window.innerWidth - popRect.width - margin),
    );
    const top = Math.min(window.innerHeight - margin, rect.bottom + 4);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  private closeWorktreeMenu(): void {
    if (this.worktreePopover) {
      this.worktreePopover.remove();
      this.worktreePopover = null;
    }
    if (this.worktreePopoverOutside) {
      document.removeEventListener("pointerdown", this.worktreePopoverOutside);
      this.worktreePopoverOutside = null;
    }
    if (this.worktreePopoverKey) {
      document.removeEventListener("keydown", this.worktreePopoverKey);
      this.worktreePopoverKey = null;
    }
    if (this.worktreePopoverReposition) {
      window.removeEventListener("resize", this.worktreePopoverReposition);
      window.removeEventListener("scroll", this.worktreePopoverReposition, true);
      this.worktreePopoverReposition = null;
    }
  }

  private async refreshRoot(): Promise<void> {
    if (!this.cwd) return;
    const gen = ++this.refreshGen;
    ++this.revealGen;           // abort any in-flight revealActivePath — it will bail at its post-await staleness check
    const cwd = this.cwd;
    this.listEl.innerHTML = "";
    this.nodes = [];
    // Reset activeNode so clearActive() doesn't query a detached element
    // during the upcoming await. activePath is intentionally preserved so
    // applyActiveClass() can re-find the leaf on the freshly-built DOM.
    this.activeNode = null;
    this.emptyEl.textContent = "Empty directory";
    this.emptyEl.hidden = true;
    let entries: DirEntry[];
    try {
      entries = await structureListDir(cwd, this.showIgnored);
    } catch (err) {
      if (gen !== this.refreshGen) return;
      // Pinned worktree vanished (pruned/deleted) — fall back to the terminal.
      if (this.pinnedRoot === cwd && this.lastTerminalCwd) {
        this.pinnedRoot = null;
        void this.reroot(this.lastTerminalCwd);
        return;
      }
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
    // Re-apply the active-file marker on the freshly-rendered nodes.
    // This is a lightweight walk (no expand, no scroll) so it won't
    // steal the user's scroll position on a routine refresh.
    this.applyActiveClass();
  }

  private makeNode(entry: DirEntry, depth: number): NodeState {
    const li = document.createElement("li");
    li.className = "structure-node";
    li.dataset.kind = entry.kind;
    li.dataset.path = entry.path;
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
    const resolved =
      entry.kind === "dir"
        ? resolveFolderIcon(entry.name, false)
        : resolveFileIcon(entry.name);
    icon.innerHTML = resolved.svg;
    icon.style.color = resolved.color;
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

    if (entry.kind === "file" && isGistShared(entry.path)) {
      row.appendChild(makeGistBadge());
    }

    const node: NodeState = { entry, expanded: false, children: null, depth, el: li };

    // Internal drag source (pointer-based — see beginRowDrag). Only the
    // primary button starts a drag; the chevron still toggles on click.
    row.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      // Prevent WebKit's text-selection sweep when dragging across rows.
      ev.preventDefault();
      this.beginRowDrag(ev, node);
    });

    row.addEventListener("click", (ev) => {
      // Ignore the 2nd+ click of a rapid double-click: a single click
      // already toggles a folder, so a double-click would toggle twice
      // (open then immediately close) and feel broken.
      if (ev.detail > 1) return;
      this.selectNode(node);
      if (entry.kind === "dir" && !entry.is_symlink) {
        // Keep focus in the tree so ⌘C/⌘V land here (no editor opens).
        this.root.focus({ preventScroll: true });
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
      this.selectNode(node);
      // ContextMenu.show handles the <html> CSS zoom counter-scaling.
      void this.openContextMenu(ev.clientX, ev.clientY, node);
    });

    return node;
  }

  private async openContextMenu(x: number, y: number, node: NodeState): Promise<void> {
    const items: MenuItem[] = [];
    const pending = await this.clipboardSources();

    // For directories, offer creating new entries inside them. We
    // skip this for files (parent is implicit) and for symlinked
    // dirs (we don't traverse those).
    if (node.entry.kind === "dir" && !node.entry.is_symlink) {
      items.push(
        { label: "New File", onClick: () => void this.startCreateInDir(node, "file") },
        { label: "New Folder", onClick: () => void this.startCreateInDir(node, "dir") },
        { divider: true },
        { label: "New Group Here", onClick: () => void openGroupAt(node.entry.path) },
        { divider: true },
      );
    }

    items.push(
      { label: "Reveal in Finder", onClick: () => this.revealInFinder(node.entry.path) },
      { divider: true },
      {
        label: "Copy",
        shortcut: formatChord(["mod", "C"]),
        onClick: () => this.copyToClipboard(node.entry.path),
      },
    );
    if (pending.length > 0) {
      items.push({
        label: pending.length > 1 ? `Paste ${pending.length} items` : "Paste",
        shortcut: formatChord(["mod", "V"]),
        onClick: () => void this.pasteClipboard(node),
      });
    }
    items.push(
      { divider: true },
      { label: "Rename", onClick: () => this.startRename(node) },
      {
        label: "Move to Trash",
        danger: true,
        onClick: () => void this.confirmAndTrash(node),
      },
    );

    if (node.entry.kind === "file" && isShareableAsGist(node.entry.path)) {
      items.push({ divider: true });
      if (isGistShared(node.entry.path)) {
        items.push(
          {
            label: "Update gist",
            onClick: () =>
              void shareFileAsGist(node.entry.path).catch((err) => gistErrorToast("Update", err)),
          },
          {
            label: "Copy gist link",
            onClick: () =>
              void copyGistLink(node.entry.path).catch((err) => gistErrorToast("Copy", err)),
          },
          {
            label: "Revoke gist",
            danger: true,
            onClick: () =>
              void revokeGist(node.entry.path).catch((err) => gistErrorToast("Revoke", err)),
          },
        );
      } else {
        items.push({
          label: "Share as gist",
          onClick: () =>
            void shareFileAsGist(node.entry.path).catch((err) => gistErrorToast("Share", err)),
        });
      }
    }

    this.contextMenu.show(x, y, items);
  }

  private revealInFinder(path: string): void {
    void (async () => {
      try {
        const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
        await revealItemInDir(path);
      } catch (err) {
        this.showError(`Reveal failed: ${err}`);
      }
    })();
  }

  /// Context menu for the empty list background / header — i.e. the tree
  /// root, with no node under the cursor. Offers creating entries at the
  /// root and revealing the root in Finder.
  private async openRootContextMenu(x: number, y: number): Promise<void> {
    const dir = this.cwd;
    if (!dir) return;
    const pending = await this.clipboardSources();
    const items: MenuItem[] = [
      { label: "New File", onClick: () => this.startCreateInRoot("file") },
      { label: "New Folder", onClick: () => this.startCreateInRoot("dir") },
      { divider: true },
      { label: "Reveal in Finder", onClick: () => this.revealInFinder(dir) },
    ];
    if (pending.length > 0) {
      items.push({
        label: pending.length > 1 ? `Paste ${pending.length} items` : "Paste",
        shortcut: formatChord(["mod", "V"]),
        onClick: () => void this.pasteClipboard(null),
      });
    }
    this.contextMenu.show(x, y, items);
  }

  /// Begin an inline "new file/folder" row at the tree root (this.cwd).
  private startCreateInRoot(kind: "file" | "dir"): void {
    if (!this.cwd) return;
    this.startInlineCreate(this.cwd, kind, this.listEl, 0, null);
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
    const draftResolved =
      kind === "dir" ? resolveFolderIcon("", false) : resolveFileIcon("");
    icon.innerHTML = draftResolved.svg;
    icon.style.color = draftResolved.color;
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

  private refreshFolderIcon(node: NodeState): void {
    if (node.entry.kind !== "dir") return;
    const iconEl = node.el.querySelector<HTMLElement>(".structure-icon");
    if (!iconEl) return;
    const r = resolveFolderIcon(node.entry.name, node.expanded);
    iconEl.innerHTML = r.svg;
    iconEl.style.color = r.color;
  }

  private async expand(node: NodeState): Promise<void> {
    if (node.expanded) return;
    if (node.entry.kind !== "dir") return;
    node.expanded = true;
    node.el.classList.add("structure-node-expanded");
    this.refreshFolderIcon(node);
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
    this.refreshFolderIcon(node);
    const childList = node.el.querySelector(".structure-children");
    if (childList instanceof HTMLElement) childList.hidden = true;
    if (this.cwd) {
      this.expandedPaths.delete(node.entry.path);
      saveExpanded(this.cwd, this.expandedPaths);
    }
  }

  /// Public entry point: tell the tree which file is currently open in
  /// the editor pane. Pass `null` to clear. Same-path repeated calls
  /// are no-ops so callers can be lazy.
  ///
  /// Effects when path changes to a non-null value:
  ///   - clear `.is-active` from the previously-marked row (if any)
  ///   - if path is outside this tree's cwd, stop (no marker)
  ///   - otherwise: walk ancestors, expand collapsed ones, mark the
  ///     leaf row, and scrollIntoView({ block: "nearest" })
  ///
  /// Set by manager.ts after `editor.open(path)` and again with `null`
  /// from the editor's `onClose` callback.
  setActivePath(path: string | null): void {
    if (path === this.activePath) return;
    this.clearActive();
    this.activePath = path;
    if (path === null) return;
    void this.revealActivePath(path);
  }

  private clearActive(): void {
    const prev = this.activeNode;
    if (prev) {
      const row = prev.el.querySelector(".structure-row");
      row?.classList.remove("is-active");
    }
    this.activeNode = null;
  }

  /// Walk loaded nodes from cwd to find the NodeState for `path`.
  /// Returns null if any ancestor isn't expanded (with loaded children)
  /// or if the leaf doesn't exist. Pure read — does not expand anything.
  private findLeafNode(path: string): NodeState | null {
    if (!this.cwd) return null;
    if (path !== this.cwd && !path.startsWith(this.cwd + "/")) return null;
    const rel = path === this.cwd ? "" : path.slice(this.cwd.length + 1);
    if (rel === "") return null;
    const segments = rel.split("/");
    let level: NodeState[] = this.nodes;
    let prefix = this.cwd;
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = `${prefix}/${segments[i]}`;
      const dirNode = level.find((n) => n.entry.path === prefix);
      if (!dirNode || !dirNode.expanded || !dirNode.children) return null;
      level = dirNode.children;
    }
    return level.find((n) => n.entry.path === path) ?? null;
  }

  /// Full reveal: expand ancestors + apply class + scroll. Used on a
  /// fresh open. Refresh re-apply uses applyActiveClass instead so a
  /// routine refresh doesn't steal the user's scroll position.
  private async revealActivePath(path: string): Promise<void> {
    if (!this.cwd) return;
    if (path !== this.cwd && !path.startsWith(this.cwd + "/")) return;
    const gen = ++this.revealGen;
    const rel = path === this.cwd ? "" : path.slice(this.cwd.length + 1);
    if (rel === "") return;
    const segments = rel.split("/");
    let level: NodeState[] = this.nodes;
    let prefix = this.cwd;
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = `${prefix}/${segments[i]}`;
      const dirNode = level.find((n) => n.entry.path === prefix);
      if (!dirNode || dirNode.entry.kind !== "dir") return;
      if (!dirNode.expanded) {
        await this.expand(dirNode);
        if (gen !== this.revealGen) return;
      }
      level = dirNode.children ?? [];
    }
    const leaf = level.find((n) => n.entry.path === path);
    if (!leaf) return;
    const row = leaf.el.querySelector(".structure-row");
    if (!(row instanceof HTMLElement)) return;
    row.classList.add("is-active");
    this.activeNode = leaf;
    row.scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  /// Lightweight: walks the currently-loaded nodes to re-apply the
  /// `.is-active` class without expanding anything new and without
  /// scrolling. Called from refreshRoot after a re-render so a refresh
  /// during which the active path hasn't changed keeps the marker
  /// visible on the new DOM nodes.
  private applyActiveClass(): void {
    if (!this.activePath) return;
    const leaf = this.findLeafNode(this.activePath);
    if (!leaf) return;
    const row = leaf.el.querySelector(".structure-row");
    if (!(row instanceof HTMLElement)) return;
    row.classList.add("is-active");
    this.activeNode = leaf;
  }

  private showError(msg: string): void {
    this.emptyEl.hidden = true;
    this.listEl.innerHTML = "";
    const err = document.createElement("div");
    err.className = "structure-error";
    err.textContent = msg;
    this.listEl.appendChild(err);
  }
}

/// Parent directory of `path`, falling back to `fallback` (the cwd) if
/// `path` has no `/` separator. Trailing slashes are ignored.
function parentDir(path: string, fallback: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return fallback;
  return trimmed.slice(0, idx);
}

/// Gists are text-only (the backend reads the file as UTF-8). Hide the
/// gist actions for extensions that are never text, so the menu doesn't
/// offer an action that can only fail.
// ponytail: extension sniff, not content sniff — a binary with a .txt
// extension still fails, and `gistErrorToast` explains why.
const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tiff", "heic", "avif",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war",
  "mp3", "wav", "flac", "ogg", "m4a", "aac",
  "mp4", "mov", "avi", "mkv", "webm",
  "ttf", "otf", "woff", "woff2", "eot",
  "so", "dylib", "dll", "exe", "bin", "o", "a", "rlib", "wasm", "class", "pyc",
  "db", "sqlite", "sqlite3", "psd", "sketch", "fig",
]);

export function isShareableAsGist(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return true; // no extension (or dotfile) — assume text
  return !BINARY_EXTS.has(name.slice(idx + 1).toLowerCase());
}

/// Trailing row indicator for a file with a live gist share — the visual
/// answer to "is this shared?" before opening the context menu.
function makeGistBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "structure-gist-badge";
  badge.innerHTML = Icons.share({ size: 10 });
  attachTooltip(badge, "Shared as gist");
  return badge;
}

function gistErrorToast(verb: string, err: unknown): void {
  const raw = String(err);
  const message = /valid UTF-8/i.test(raw)
    ? "Gists are text-only — this file isn't valid UTF-8."
    : `${verb} failed: ${raw}`;
  pushInfoToast({ message });
}

function shortenCwd(cwd: string): string {
  // Show last 2 segments for compactness. Full path on hover.
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) return cwd;
  return ".../" + parts.slice(-2).join("/");
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
