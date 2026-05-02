// Tab manager: each tab owns one backend Session, its own xterm.js
// Terminal, and its own BlockManager. Switching tabs hides inactive
// panes via the [hidden] attribute — terminals are never re-mounted on
// activation, satisfying the CLAUDE.md TS conventions.
//
// M-UX1 adds: rename (double-click or context menu), color (right-click
// → swatches), and drag-reorder.
// M-UX2 adds: tab groups. A group is a named, color-bearing container.
// A tab can be in 0 or 1 group. Adding/removing rearranges `tabs[]` so
// grouped members stay adjacent (single visual run per group).
// All metadata is in-memory only — persistence ties to session
// restoration which is its own arch change (M7+ scope).

import { Terminal, type IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

import {
  closeSession,
  getSettings,
  isOperatorEnabled,
  resizeSession,
  setOperatorEnabled,
  spawnSession,
  writeToSession,
  type SessionId,
  type TerminalConfig,
} from "../api";
import { BlockManager } from "../blocks/manager";
import { ContextMenu, COLOR_SWATCHES } from "../menu/context-menu";

const DEFAULT_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const DEFAULT_FONT_SIZE = 13;

const TERMINAL_THEME = {
  background: "#0b0d10",
  foreground: "#d6d8db",
  cursor: "#7aa2f7",
  cursorAccent: "#0b0d10",
  selectionBackground: "#2a3148",
} as const;

function buildTerminalOptions(font: TerminalConfig | null): Record<string, unknown> {
  return {
    fontFamily: font?.font_family || DEFAULT_FONT_FAMILY,
    fontSize: font?.font_size || DEFAULT_FONT_SIZE,
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: "block",
    allowProposedApi: true,
    convertEol: false,
    scrollback: 10_000,
    theme: TERMINAL_THEME,
  };
}

interface Tab {
  id: string;
  sessionId: SessionId;
  /// Default name from the spawn sequence ("zsh 1"). Always present.
  defaultTitle: string;
  /// User-set name. When set, takes precedence over defaultTitle.
  customName: string | null;
  /// Hex color or null. Drives left-border + faint background tint.
  color: string | null;
  /// Group membership. Null = not in any group.
  groupId: string | null;
  /// Operator enabled on this tab — controls whether the backend's
  /// OperatorWatcher checks this session for prompts to answer.
  operatorEnabled: boolean;
  pane: HTMLElement;
  termHost: HTMLElement;
  blocksHost: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  /// Held so applyTerminalSettings can call webgl.clearTextureAtlas()
  /// when the font changes — the addon caches glyph bitmaps separately
  /// from the terminal options.
  webgl: WebglAddon | null;
  blocks: BlockManager;
  disposers: IDisposable[];
}

interface TabGroup {
  id: string;
  name: string;
  color: string | null;
  collapsed: boolean;
}

type RenameTarget =
  | { kind: "tab"; id: string }
  | { kind: "group"; id: string }
  | null;

type DragSource =
  | { kind: "tab"; id: string }
  | { kind: "group"; id: string }
  | null;

function tabDisplayName(t: Tab): string {
  return t.customName?.trim() || t.defaultTitle;
}

export class TabManager {
  private readonly tabs: Tab[] = [];
  private readonly groups: Map<string, TabGroup> = new Map();
  private activeId: string | null = null;
  private nextSeq = 1;
  private nextGroupSeq = 1;
  private readonly menu: ContextMenu;
  private renaming: RenameTarget = null;
  private dragging: DragSource = null;

  constructor(
    private readonly tabbarHost: HTMLElement,
    private readonly workspace: HTMLElement,
    newTabBtn: HTMLElement,
    private readonly onAllTabsClosed: () => void,
  ) {
    this.menu = new ContextMenu(document.body);
    newTabBtn.addEventListener("click", () => {
      void this.createTab();
    });
    window.addEventListener("resize", () => this.refitActive());
    window.addEventListener("beforeunload", () => {
      for (const tab of this.tabs) {
        void closeSession(tab.sessionId).catch(() => {});
      }
    });
  }

  /// Pointer-event-based drag implementation.
  ///
  /// We don't use HTML5 drag-and-drop because Tauri's WebKit on macOS
  /// doesn't reliably deliver `dragenter`/`dragover`/`drop` events to
  /// elements when the source lives in the same container — they get
  /// swallowed by the OS-level drag-region handling. Pointer events
  /// always fire, so we synthesize the whole flow ourselves.
  private installTabPointerDrag(pill: HTMLElement, tabId: string): void {
    pill.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; // left click only
      if ((e.target as HTMLElement).closest(".tab-close")) return;
      if (this.isRenamingTab(tabId)) return;
      // Prevent webkit's default text-selection initiation. Without
      // this, dragging over neighbouring tab labels triggers a text-
      // selection sweep (highlighted "zsh 2", "zsh 3", etc).
      e.preventDefault();
      this.beginPointerDrag(e, { kind: "tab", id: tabId });
    });
  }

  private installChipPointerDrag(chip: HTMLElement, groupId: string): void {
    chip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(".group-chip-chev")) return;
      if (this.isRenamingGroup(groupId)) return;
      e.preventDefault();
      this.beginPointerDrag(e, { kind: "group", id: groupId });
    });
  }

  private beginPointerDrag(e: PointerEvent, src: NonNullable<DragSource>): void {
    const startX = e.clientX;
    const startY = e.clientY;
    let activated = false;
    let ghost: HTMLElement | null = null;
    let sourceEl: HTMLElement | null = null;

    const cleanup = (): void => {
      document.body.classList.remove("tab-drag-active");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      this.tabbarHost
        .querySelectorAll(".tab-drop-left, .tab-drop-right, .group-chip-drop")
        .forEach((el) =>
          el.classList.remove(
            "tab-drop-left",
            "tab-drop-right",
            "group-chip-drop",
          ),
        );
      if (ghost) {
        ghost.remove();
        ghost = null;
      }
      if (sourceEl) {
        sourceEl.classList.remove("tab-dragging", "group-chip-dragging");
        sourceEl = null;
      }
      this.dragging = null;
    };

    const findSourceEl = (): HTMLElement | null => {
      const sel =
        src.kind === "tab"
          ? `.tab-btn[data-tab-id="${src.id}"]`
          : `.group-chip[data-group-id="${src.id}"]`;
      return this.tabbarHost.querySelector<HTMLElement>(sel);
    };

    let ghostOriginX = 0;
    let ghostOriginY = 0;

    const activate = (): void => {
      activated = true;
      this.dragging = src;
      // Globally disable text selection + tweak cursor while a drag
      // is in flight. Without this, hovering over neighbour tab labels
      // selects their text mid-drag.
      document.body.classList.add("tab-drag-active");
      sourceEl = findSourceEl();
      if (sourceEl) {
        sourceEl.classList.add(
          src.kind === "tab" ? "tab-dragging" : "group-chip-dragging",
        );
        ghost = sourceEl.cloneNode(true) as HTMLElement;
        ghost.classList.add("tab-ghost");
        const rect = sourceEl.getBoundingClientRect();
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        ghostOriginX = rect.left;
        ghostOriginY = rect.top;
        ghost.style.left = `${ghostOriginX}px`;
        ghost.style.top = `${ghostOriginY}px`;
        document.body.appendChild(ghost);
      }
    };

    const updateIndicators = (clientX: number, clientY: number): {
      kind: "pill" | "chip" | null;
      el: HTMLElement | null;
      side: "left" | "right";
    } => {
      this.tabbarHost
        .querySelectorAll(".tab-drop-left, .tab-drop-right, .group-chip-drop")
        .forEach((el) => {
          el.classList.remove(
            "tab-drop-left",
            "tab-drop-right",
            "group-chip-drop",
          );
          el.querySelector(".tab-drop-anchor")?.remove();
        });

      const target = document.elementFromPoint(clientX, clientY) as
        | HTMLElement
        | null;
      const chip = target?.closest<HTMLElement>(".group-chip") ?? null;
      if (chip) {
        const groupId = chip.dataset.groupId;
        if (
          groupId &&
          !(src.kind === "group" && src.id === groupId) &&
          !(src.kind === "tab" &&
            this.tabs.find((t) => t.id === src.id)?.groupId === groupId)
        ) {
          chip.classList.add("group-chip-drop");
          const rect = chip.getBoundingClientRect();
          return {
            kind: "chip",
            el: chip,
            side: clientX < rect.left + rect.width / 2 ? "left" : "right",
          };
        }
      }

      const pill = target?.closest<HTMLElement>(".tab-btn") ?? null;
      if (pill) {
        const tabId = pill.dataset.tabId;
        if (!tabId) return { kind: null, el: null, side: "left" };
        const tab = this.tabs.find((t) => t.id === tabId);
        if (!tab) return { kind: null, el: null, side: "left" };
        if (src.kind === "tab" && src.id === tabId) {
          return { kind: null, el: null, side: "left" };
        }
        if (src.kind === "group" && tab.groupId === src.id) {
          return { kind: null, el: null, side: "left" };
        }
        const rect = pill.getBoundingClientRect();
        const side: "left" | "right" =
          clientX < rect.left + rect.width / 2 ? "left" : "right";
        pill.classList.add(side === "left" ? "tab-drop-left" : "tab-drop-right");
        // Anchor dot at top of the indicator — visual cue for landing point.
        const anchor = document.createElement("span");
        anchor.className = "tab-drop-anchor";
        pill.appendChild(anchor);
        return { kind: "pill", el: pill, side };
      }
      return { kind: null, el: null, side: "left" };
    };

    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!activated) {
        if (dx * dx + dy * dy < 5 * 5) return;
        activate();
      }
      if (ghost) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        ghost.style.transform = `translate(${dx}px, ${dy}px) rotate(2deg) scale(0.96)`;
      }
      updateIndicators(ev.clientX, ev.clientY);
    };

    const onUp = (ev: PointerEvent): void => {
      if (!activated) {
        cleanup();
        return;
      }
      const drop = updateIndicators(ev.clientX, ev.clientY);
      if (drop.kind === "chip" && drop.el) {
        const groupId = drop.el.dataset.groupId!;
        if (src.kind === "tab") {
          this.addTabToGroup(src.id, groupId);
        } else if (src.kind === "group" && src.id !== groupId) {
          this.moveGroupRelativeToGroup(src.id, groupId, drop.side);
        }
      } else if (drop.kind === "pill" && drop.el) {
        const tabId = drop.el.dataset.tabId!;
        const tab = this.tabs.find((t) => t.id === tabId);
        if (!tab) {
          cleanup();
          return;
        }
        if (src.kind === "tab" && src.id !== tabId) {
          this.reorder(src.id, tabId, drop.side);
        } else if (src.kind === "group" && tab.groupId !== src.id) {
          this.moveGroupRelativeToTab(src.id, tabId, drop.side);
        }
      }
      cleanup();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  hasTabs(): boolean {
    return this.tabs.length > 0;
  }

  /// Push terminal font/size into every open tab. Called from main.ts
  /// when the user saves Settings (no restart needed).
  ///
  /// xterm.js caches glyph metrics + a WebGL texture atlas based on the
  /// current font. Changing fontFamily/fontSize without invalidating
  /// these caches makes new glyphs render against the OLD cell width —
  /// the visible result is "spread out" characters. To fix:
  ///   1. Wait for `document.fonts.ready` so the browser has actually
  ///      loaded the new font before xterm measures it.
  ///   2. Set options.
  ///   3. Clear the WebGL texture atlas if the addon exposes it.
  ///   4. Refit (recomputes cols/rows from new cell dims).
  ///   5. Resync the backend PTY.
  applyTerminalSettings(cfg: TerminalConfig): void {
    const family = cfg.font_family || DEFAULT_FONT_FAMILY;
    const size = cfg.font_size || DEFAULT_FONT_SIZE;

    void document.fonts.ready.then(() => {
      for (const tab of this.tabs) {
        try {
          tab.term.options.fontFamily = family;
          tab.term.options.fontSize = size;

          // Surefire WebGL refresh: dispose the addon + load a fresh
          // one. clearTextureAtlas() alone is a silent no-op in xterm
          // 5.x when the font changes after open(); the dispose-and-
          // recreate dance forces a full atlas rebuild against the
          // new font metrics.
          if (tab.webgl) {
            try {
              tab.webgl.dispose();
            } catch {
              /* ignore */
            }
            try {
              const next = new WebglAddon();
              tab.term.loadAddon(next);
              tab.webgl = next;
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn(
                "WebGL recreate failed; falling back to canvas",
                err,
              );
              tab.webgl = null;
            }
          }

          requestAnimationFrame(() => {
            try {
              tab.fit.fit();
            } catch {
              /* ignore */
            }
            tab.term.refresh(0, tab.term.rows - 1);
            void resizeSession(
              tab.sessionId,
              tab.term.cols,
              tab.term.rows,
            ).catch(() => {});
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("apply terminal settings failed for tab", tab.id, err);
        }
      }
    });
  }

  closeActive(): void {
    if (this.activeId) this.closeTab(this.activeId);
  }

  /// Backend session id (Ulid string) for whichever tab is currently
  /// in the foreground, or null when no tabs exist.
  activeSessionId(): SessionId | null {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    return tab?.sessionId ?? null;
  }

  activateByIndex(index: number): void {
    const tab = this.tabs[index];
    if (tab) this.activate(tab.id);
  }

  activateRelative(delta: number): void {
    if (this.tabs.length === 0) return;
    const currentIdx = this.tabs.findIndex((t) => t.id === this.activeId);
    if (currentIdx < 0) {
      this.activate(this.tabs[0].id);
      return;
    }
    const len = this.tabs.length;
    const nextIdx = ((currentIdx + delta) % len + len) % len;
    this.activate(this.tabs[nextIdx].id);
  }

  async createTab(): Promise<void> {
    const id = crypto.randomUUID();
    const seq = this.nextSeq++;

    const pane = document.createElement("div");
    pane.className = "tab-pane";
    pane.dataset.tabId = id;

    const termHost = document.createElement("div");
    termHost.className = "tab-terminal";
    pane.appendChild(termHost);

    const blocksHost = document.createElement("div");
    blocksHost.className = "tab-blocks";
    pane.appendChild(blocksHost);

    this.hideAllPanes();
    this.workspace.appendChild(pane);

    // Read terminal font/size from settings each spawn so a Save in
    // ⌘, applies on the next new tab without restart. Existing tabs
    // are updated live via applyTerminalSettings().
    const termCfg = await getSettings()
      .then((s) => s.terminal)
      .catch(() => null);
    const term = new Terminal(buildTerminalOptions(termCfg));
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHost);
    // WebGL addon disabled temporarily — its glyph atlas doesn't pick
    // up font changes from term.options.fontFamily reliably. DOM/canvas
    // renderer respects the font option natively. M-OP perf hit is
    // negligible at terminal byte rates.
    const webgl: WebglAddon | null = null;
    fit.fit();

    let blocks: BlockManager | null = null;
    let sessionId: SessionId;
    try {
      sessionId = await spawnSession({
        onOutput: (chunk) => term.write(chunk),
        onSessionEvent: (event) => blocks?.handleEvent(event),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("spawn_session failed", err);
      term.dispose();
      this.workspace.removeChild(pane);
      if (this.activeId) this.activate(this.activeId, { skipIfSame: false });
      return;
    }
    blocks = new BlockManager(blocksHost, sessionId);

    await resizeSession(sessionId, term.cols, term.rows).catch((e) =>
      // eslint-disable-next-line no-console
      console.error("initial resize failed", e),
    );

    const encoder = new TextEncoder();
    const dataDispose = term.onData((data) => {
      void writeToSession(sessionId, encoder.encode(data)).catch((e) =>
        // eslint-disable-next-line no-console
        console.error("write failed", e),
      );
    });
    const resizeDispose = term.onResize(({ cols, rows }) => {
      void resizeSession(sessionId, cols, rows).catch((e) =>
        // eslint-disable-next-line no-console
        console.error("resize failed", e),
      );
    });

    // Pick up the backend's per-session enabled state (driven by
    // settings.operator.enabled_default at attach() time).
    const operatorEnabled = await isOperatorEnabled(sessionId).catch(() => false);

    const tab: Tab = {
      id,
      sessionId,
      defaultTitle: `zsh ${seq}`,
      customName: null,
      color: null,
      groupId: null,
      operatorEnabled,
      pane,
      termHost,
      blocksHost,
      term,
      fit,
      webgl,
      blocks,
      disposers: [dataDispose, resizeDispose],
    };

    this.tabs.push(tab);
    this.activeId = id;
    this.renderTabbar();
    term.focus();
  }

  private async toggleOperator(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const next = !tab.operatorEnabled;
    try {
      await setOperatorEnabled(tab.sessionId, next);
      tab.operatorEnabled = next;
      this.renderTabbar();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("set_operator_enabled failed", err);
    }
  }

  closeTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;

    const tab = this.tabs[idx];
    for (const d of tab.disposers) d.dispose();
    void closeSession(tab.sessionId).catch(() => {});
    tab.term.dispose();
    if (tab.pane.parentElement === this.workspace) {
      this.workspace.removeChild(tab.pane);
    }
    this.tabs.splice(idx, 1);

    if (this.tabs.length === 0) {
      this.activeId = null;
      this.renderTabbar();
      this.onAllTabsClosed();
      return;
    }

    if (this.activeId === id) {
      const next = this.tabs[idx] ?? this.tabs[idx - 1];
      this.activeId = null;
      this.activate(next.id);
    } else {
      this.renderTabbar();
    }
  }

  activate(
    id: string,
    opts: { skipIfSame?: boolean } = { skipIfSame: true },
  ): void {
    if (opts.skipIfSame !== false && this.activeId === id) return;

    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;

    this.hideAllPanes();
    tab.pane.hidden = false;
    this.activeId = id;
    this.renderTabbar();

    requestAnimationFrame(() => {
      try {
        tab.fit.fit();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("fit failed on activation", err);
      }
      void resizeSession(tab.sessionId, tab.term.cols, tab.term.rows).catch(
        () => {},
      );
      tab.term.focus();
    });
  }

  // ─── Mutators for context-menu actions ──────────────

  private isRenamingTab(id: string): boolean {
    return this.renaming?.kind === "tab" && this.renaming.id === id;
  }

  private isRenamingGroup(id: string): boolean {
    return this.renaming?.kind === "group" && this.renaming.id === id;
  }

  private setColor(id: string, color: string | null): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.color = color;
    this.renderTabbar();
  }

  private setGroupColor(groupId: string, color: string | null): void {
    const g = this.groups.get(groupId);
    if (!g) return;
    g.color = color;
    this.renderTabbar();
  }

  private startTabRename(id: string): void {
    this.renaming = { kind: "tab", id };
    this.renderTabbar();
  }

  private startGroupRename(id: string): void {
    this.renaming = { kind: "group", id };
    this.renderTabbar();
  }

  private commitTabRename(id: string, value: string): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    const trimmed = value.trim();
    tab.customName = trimmed.length > 0 ? trimmed : null;
    this.renaming = null;
    this.renderTabbar();
  }

  private commitGroupRename(id: string, value: string): void {
    const g = this.groups.get(id);
    if (!g) return;
    const trimmed = value.trim();
    g.name = trimmed.length > 0 ? trimmed : `group ${this.nextGroupSeq - 1}`;
    this.renaming = null;
    this.renderTabbar();
  }

  private cancelRename(): void {
    if (!this.renaming) return;
    this.renaming = null;
    this.renderTabbar();
  }

  // ─── Group ops ──────────────────────────────────────

  private createGroupFromTab(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const id = crypto.randomUUID();
    const seq = this.nextGroupSeq++;
    this.groups.set(id, {
      id,
      name: `group ${seq}`,
      color: null,
      collapsed: false,
    });
    tab.groupId = id;
    // No reorder needed — tab stays where it is, becomes a single-
    // member group.
    this.renaming = { kind: "group", id };
    this.renderTabbar();
  }

  private toggleGroupCollapsed(groupId: string): void {
    const g = this.groups.get(groupId);
    if (!g) return;
    g.collapsed = !g.collapsed;
    this.renderTabbar();
  }

  /// Tab indices belonging to a group, in their current `tabs[]` order.
  private memberIndices(groupId: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.tabs.length; i++) {
      if (this.tabs[i].groupId === groupId) out.push(i);
    }
    return out;
  }

  /// Move an entire group (all its members, in order) so the first member
  /// lands `side`-of `targetTabId`. Self-drop or no-op cases are silent.
  private moveGroupRelativeToTab(
    groupId: string,
    targetTabId: string,
    side: "left" | "right",
  ): void {
    const memberIds = new Set(
      this.tabs.filter((t) => t.groupId === groupId).map((t) => t.id),
    );
    if (memberIds.size === 0) return;
    if (memberIds.has(targetTabId)) return;

    const members = this.tabs.filter((t) => memberIds.has(t.id));
    const remaining = this.tabs.filter((t) => !memberIds.has(t.id));

    const targetIdx = remaining.findIndex((t) => t.id === targetTabId);
    if (targetIdx < 0) return;
    const insertAt = side === "right" ? targetIdx + 1 : targetIdx;
    remaining.splice(insertAt, 0, ...members);

    this.tabs.length = 0;
    this.tabs.push(...remaining);
    this.renderTabbar();
  }

  /// Move an entire group so its members land `side`-of the entire
  /// target group's run.
  private moveGroupRelativeToGroup(
    movingId: string,
    targetGroupId: string,
    side: "left" | "right",
  ): void {
    if (movingId === targetGroupId) return;
    const targetMembers = this.tabs.filter((t) => t.groupId === targetGroupId);
    if (targetMembers.length === 0) return;
    const anchor =
      side === "right"
        ? targetMembers[targetMembers.length - 1]
        : targetMembers[0];
    this.moveGroupRelativeToTab(movingId, anchor.id, side);
  }

  private addTabToGroup(tabId: string, groupId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    const group = this.groups.get(groupId);
    if (!tab || !group) return;
    if (tab.groupId === groupId) return;

    tab.groupId = groupId;

    // Move the tab next to the last existing member of the group so
    // grouped tabs render as a single contiguous run.
    const myIdx = this.tabs.findIndex((t) => t.id === tabId);
    let lastGroupIdx = -1;
    for (let i = 0; i < this.tabs.length; i++) {
      if (i !== myIdx && this.tabs[i].groupId === groupId) lastGroupIdx = i;
    }
    if (lastGroupIdx >= 0) {
      const [moved] = this.tabs.splice(myIdx, 1);
      // After splice, indices in [lastGroupIdx+1, ..) shifted down by 1
      // if myIdx < lastGroupIdx; account for that.
      const insertAt =
        myIdx < lastGroupIdx ? lastGroupIdx : lastGroupIdx + 1;
      this.tabs.splice(insertAt, 0, moved);
    }
    this.renderTabbar();
  }

  private removeTabFromGroup(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const oldGroupId = tab.groupId;
    tab.groupId = null;
    if (oldGroupId) this.cleanupEmptyGroup(oldGroupId);
    this.renderTabbar();
  }

  private ungroup(groupId: string): void {
    for (const t of this.tabs) {
      if (t.groupId === groupId) t.groupId = null;
    }
    this.groups.delete(groupId);
    this.renderTabbar();
  }

  private cleanupEmptyGroup(groupId: string): void {
    const stillUsed = this.tabs.some((t) => t.groupId === groupId);
    if (!stillUsed) this.groups.delete(groupId);
  }

  // ─── Drag reorder ───────────────────────────────────

  private reorder(fromId: string, toId: string, side: "left" | "right"): void {
    if (fromId === toId) return;
    const fromIdx = this.tabs.findIndex((t) => t.id === fromId);
    const toIdx = this.tabs.findIndex((t) => t.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;

    // When reordering across a group boundary, inherit the destination
    // tab's group so dragging into a group is intuitive.
    const moved = this.tabs[fromIdx];
    const target = this.tabs[toIdx];
    const oldGroupId = moved.groupId;
    moved.groupId = target.groupId;

    this.tabs.splice(fromIdx, 1);
    let insertAt = this.tabs.findIndex((t) => t.id === toId);
    if (side === "right") insertAt += 1;
    this.tabs.splice(insertAt, 0, moved);

    if (oldGroupId && oldGroupId !== moved.groupId) {
      this.cleanupEmptyGroup(oldGroupId);
    }
    this.renderTabbar();
  }

  // ─── Render ─────────────────────────────────────────

  private hideAllPanes(): void {
    for (const t of this.tabs) {
      t.pane.hidden = true;
    }
  }

  private refitActive(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (!tab) return;
    try {
      tab.fit.fit();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("fit failed on resize", err);
    }
  }

  private renderTabbar(): void {
    this.tabbarHost.innerHTML = "";
    let prevGroupId: string | null | undefined = undefined;
    let pendingFirstGroupId: string | null = null;
    for (const tab of this.tabs) {
      const isNewGroupRun = tab.groupId !== prevGroupId && tab.groupId !== null;

      if (isNewGroupRun) {
        const group = this.groups.get(tab.groupId!);
        if (group) {
          const memberCount = this.memberIndices(group.id).length;
          const chipEl = this.renderGroupChip(group, memberCount);
          // Mark chip as having visible members → CSS fuses the seam
          // between chip and the first member tab.
          if (memberCount > 0 && !group.collapsed) {
            chipEl.classList.add("group-chip-has-members");
            pendingFirstGroupId = group.id;
          }
          this.tabbarHost.appendChild(chipEl);
        }
      }

      const group = tab.groupId ? this.groups.get(tab.groupId) : null;
      const hidden = group?.collapsed ?? false;
      if (!hidden) {
        const pillEl = this.renderTabPill(tab);
        if (
          pendingFirstGroupId !== null &&
          tab.groupId === pendingFirstGroupId
        ) {
          pillEl.classList.add("tab-grouped-first");
          pendingFirstGroupId = null;
        }
        this.tabbarHost.appendChild(pillEl);
      }
      prevGroupId = tab.groupId;
    }
  }

  private renderGroupChip(group: TabGroup, memberCount: number): HTMLElement {
    const chip = document.createElement("div");
    chip.className = "group-chip";
    chip.dataset.groupId = group.id;
    if (group.color) {
      chip.classList.add("group-chip-colored");
      chip.style.setProperty("--group-color", group.color);
    }
    if (group.collapsed) chip.classList.add("group-chip-collapsed");
    if (this.dragging?.kind === "group" && this.dragging.id === group.id) {
      chip.classList.add("group-chip-dragging");
    }

    // Chevron — opt-in click target for fold toggle. CSS draws a
    // triangle pseudo-element that rotates between collapsed/expanded.
    const chevron = document.createElement("button");
    chevron.type = "button";
    chevron.className = "group-chip-chev";
    chevron.title = group.collapsed ? "Expand group" : "Collapse group";
    chevron.setAttribute("aria-label", chevron.title);
    chevron.addEventListener("mousedown", (e) => e.stopPropagation());
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleGroupCollapsed(group.id);
    });
    chip.appendChild(chevron);

    const dot = document.createElement("span");
    dot.className = "group-chip-dot";
    chip.appendChild(dot);

    if (this.isRenamingGroup(group.id)) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "group-chip-input";
      input.value = group.name;
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          this.commitGroupRename(group.id, input.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.cancelRename();
        }
      });
      input.addEventListener("blur", () => {
        if (this.isRenamingGroup(group.id)) {
          this.commitGroupRename(group.id, input.value);
        }
      });
      input.addEventListener("click", (e) => e.stopPropagation());
      chip.appendChild(input);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      const label = document.createElement("span");
      label.className = "group-chip-label";
      label.textContent = group.name;
      chip.appendChild(label);
      if (group.collapsed) {
        const count = document.createElement("span");
        count.className = "group-chip-count";
        count.textContent = `(${memberCount})`;
        chip.appendChild(count);
      }
    }

    chip.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".group-chip-chev")) return;
      e.preventDefault();
      this.startGroupRename(group.id);
    });

    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openGroupContextMenu(group, e.clientX, e.clientY);
    });

    // ── Drag (move whole group) ──
    this.installChipPointerDrag(chip, group.id);

    return chip;
  }

  private renderTabPill(tab: Tab): HTMLElement {
    // <div role=button> instead of <button> so we can nest <input> for
    // the inline rename (button > input is invalid HTML).
    const pill = document.createElement("div");
    pill.setAttribute("role", "button");
    pill.tabIndex = 0;
    pill.className = `tab-btn ${tab.id === this.activeId ? "active" : ""}`;
    pill.dataset.tabId = tab.id;
    pill.title = tabDisplayName(tab);
    // Both the property AND the attribute — some webkit builds only
    // honor one or the other for div elements.
    // No native HTML5 draggable — we use pointer events instead
    // (see installTabPointerDrag).

    if (tab.color) {
      pill.classList.add("tab-colored");
      pill.style.setProperty("--tab-color", tab.color);
    }

    if (tab.groupId) {
      pill.classList.add("tab-grouped");
      const group = this.groups.get(tab.groupId);
      if (group?.color) {
        pill.style.setProperty("--group-color", group.color);
        pill.classList.add("tab-group-colored");
      }
    }

    if (tab.operatorEnabled) {
      const dot = document.createElement("span");
      dot.className = "tab-operator-dot";
      dot.title = "Operator enabled (dry-run)";
      pill.appendChild(dot);
    }

    if (this.isRenamingTab(tab.id)) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "tab-label-input";
      input.value = tab.customName ?? tab.defaultTitle;
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          this.commitTabRename(tab.id, input.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.cancelRename();
        }
      });
      input.addEventListener("blur", () => {
        if (this.isRenamingTab(tab.id)) {
          this.commitTabRename(tab.id, input.value);
        }
      });
      input.addEventListener("click", (e) => e.stopPropagation());
      pill.appendChild(input);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else {
      const label = document.createElement("span");
      label.className = "tab-label";
      label.textContent = tabDisplayName(tab);
      pill.appendChild(label);
    }

    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "Close tab (⌘W)";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTab(tab.id);
    });
    pill.appendChild(close);

    pill.addEventListener("click", (e) => {
      if (this.isRenamingTab(tab.id)) return;
      if ((e.target as HTMLElement).closest(".tab-close")) return;
      this.activate(tab.id);
    });

    pill.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".tab-close")) return;
      e.preventDefault();
      this.startTabRename(tab.id);
    });

    pill.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openTabContextMenu(tab, e.clientX, e.clientY);
    });

    // ── Drag and drop ──
    this.installTabPointerDrag(pill, tab.id);

    return pill;
  }

  private openTabContextMenu(tab: Tab, x: number, y: number): void {
    const items: Parameters<ContextMenu["show"]>[2] = [
      { label: "Rename", onClick: () => this.startTabRename(tab.id) },
      { divider: true },
      {
        swatches: COLOR_SWATCHES.map((sw) => ({
          color: sw.color,
          title: sw.title,
          onClick: () => this.setColor(tab.id, sw.color),
        })),
      },
      { divider: true },
    ];

    // Group operations. Show "Add to: <existing groups>" then "New
    // group from this tab" then "Remove from group" if applicable.
    const otherGroups = Array.from(this.groups.values()).filter(
      (g) => g.id !== tab.groupId,
    );
    for (const g of otherGroups) {
      items.push({
        label: `→ Move to "${g.name}"`,
        onClick: () => this.addTabToGroup(tab.id, g.id),
      });
    }
    items.push({
      label: "+ New group from this tab",
      onClick: () => this.createGroupFromTab(tab.id),
    });
    if (tab.groupId) {
      items.push({
        label: "Remove from group",
        onClick: () => this.removeTabFromGroup(tab.id),
      });
    }

    items.push({ divider: true });
    items.push({
      label: tab.operatorEnabled
        ? "🤖 Disable operator"
        : "🤖 Enable operator",
      onClick: () => this.toggleOperator(tab.id),
    });
    items.push({ divider: true });
    items.push({
      label: "Close tab",
      danger: true,
      onClick: () => this.closeTab(tab.id),
    });

    this.menu.show(x, y, items);
  }

  private openGroupContextMenu(group: TabGroup, x: number, y: number): void {
    this.menu.show(x, y, [
      { label: "Rename group", onClick: () => this.startGroupRename(group.id) },
      {
        label: group.collapsed ? "Expand group" : "Collapse group",
        onClick: () => this.toggleGroupCollapsed(group.id),
      },
      { divider: true },
      {
        swatches: COLOR_SWATCHES.map((sw) => ({
          color: sw.color,
          title: sw.title,
          onClick: () => this.setGroupColor(group.id, sw.color),
        })),
      },
      { divider: true },
      {
        label: "Ungroup",
        danger: true,
        onClick: () => this.ungroup(group.id),
      },
    ]);
  }
}
