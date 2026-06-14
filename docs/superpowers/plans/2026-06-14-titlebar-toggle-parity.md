# Titlebar right-cluster toggle-parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 8 buttons + fold in `#app-titlebar-right` behave as one uniform set of toggles with equal visual weight, where the fold button is the single collapse authority.

**Architecture:** Introduce one `RightRailController` (a pure state machine, unit-tested in isolation) that owns the right-rail "slot": it closes the previously-open target before opening the next, drives `body.blocks-globally-collapsed`, and lights exactly one (or zero) titlebar buttons. Every rail button's click handler becomes `controller.toggle(target)`; the fold button becomes `controller.toggleFold()`. The Browser/globe button is the one deliberate exception — it toggles a main-area browser **tab**, not a rail panel, so it gets identical look/affordance but is not governed by the fold.

**Tech Stack:** TypeScript (strict), vitest + jsdom (tests run from the **worktree root** via `npx vitest run`), Tauri 2. No new deps.

**Deliberate behavior change (call out at review):** Under the peer-toggle model, clicking an already-active panel button (Notes/Teammate/Tasker) — or the fold — now **folds the rail** (all dim), instead of restoring the previously-shown view. This is what "all behave the same as toggles" requires. The old "restore previous view on panel close" dance (`projectNotesReturnView`) is removed. If undesired, it's a localized revert (see Task 3, note).

**Commit granularity (user preference — overrides per-step commits):** one commit per *feature*, not per TDD step. Four commits total: (A) controller+tests, (B) titlebar wiring, (C) browser toggle + manager helpers, (D) weight. Commit at the end of Tasks 2, 3, 4, 5 respectively.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `ui/src/titlebar/right-rail.ts` | The `RightRailController` state machine + `RailTarget`/`RailAdapters` types. No DOM, no Tauri — pure logic via injected adapters. | Create |
| `ui/src/titlebar/right-rail.test.ts` | Unit tests for every controller transition, using a fake recording adapter. | Create |
| `ui/src/tabs/manager.ts` | Add `hasBrowserTab()` + `firstBrowserTabId()` query helpers. | Modify (near `activeKind()` ~`:2675`) |
| `ui/src/main.ts` | Build the adapters from existing functions; refactor panel open/close to "dumb"; replace all 8 button handlers + fold with controller calls; reconcile external `openProjectNotes` callers; add browser toggle + active-sync. | Modify |

---

## Task 1: TabManager browser-tab query helpers

**Files:**
- Modify: `ui/src/tabs/manager.ts` (add two methods next to `activeKind()` near line 2675)

These are pure array reads over the existing `private readonly tabs: Tab[]` (`manager.ts:661`), where `Tab.id: string` and `Tab.kind: "shell" | "pi" | "browser"`. TabManager pulls in Tauri and isn't unit-testable in jsdom, so this task is verified by typecheck; behavior is exercised in Task 4's manual check.

- [ ] **Step 1: Add the two helpers**

Find `activeKind(): "shell" | "pi" | "browser" | null {` (`manager.ts:2675`). Immediately **above** it, insert:

```ts
  /// True when at least one browser tab is open. Drives the titlebar globe's
  /// toggle/active state (the globe targets a tab, not a rail panel).
  hasBrowserTab(): boolean {
    return this.tabs.some((t) => t.kind === "browser");
  }

  /// Id of the first open browser tab, or null. Used by the globe toggle to
  /// close an existing browser tab instead of spawning another.
  firstBrowserTabId(): string | null {
    return this.tabs.find((t) => t.kind === "browser")?.id ?? null;
  }

```

- [ ] **Step 2: Typecheck**

Run (from worktree root): `npx tsc --noEmit`
Expected: PASS (no new errors). Do not commit yet — committed together with Task 4 (commit C).

---

## Task 2: RightRailController (pure state machine) — TDD

**Files:**
- Create: `ui/src/titlebar/right-rail.ts`
- Create: `ui/src/titlebar/right-rail.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/titlebar/right-rail.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { RightRailController, type RailTarget, type RailAdapters } from "./right-rail";

/** Recording fake — captures the exact adapter call sequence. */
function makeFake() {
  const calls: string[] = [];
  const adapters: RailAdapters = {
    open: (t) => calls.push(`open:${t}`),
    close: (t) => calls.push(`close:${t}`),
    setFolded: (f) => calls.push(`fold:${f}`),
    highlight: (t) => calls.push(`hi:${t ?? "none"}`),
  };
  return { calls, adapters };
}

describe("RightRailController", () => {
  let fake: ReturnType<typeof makeFake>;
  beforeEach(() => { fake = makeFake(); });

  it("toggle from folded opens target, unfolds, highlights it", () => {
    const c = new RightRailController(fake.adapters, null);
    fake.calls.length = 0;
    c.toggle("blocks");
    expect(c.target).toBe("blocks");
    expect(fake.calls).toEqual(["open:blocks", "fold:false", "hi:blocks"]);
  });

  it("toggle to a different target closes the old one first (exclusivity)", () => {
    const c = new RightRailController(fake.adapters, "blocks");
    fake.calls.length = 0;
    c.toggle("teammate");
    expect(c.target).toBe("teammate");
    expect(fake.calls).toEqual(["close:blocks", "open:teammate", "fold:false", "hi:teammate"]);
  });

  it("toggle on the active target folds and clears the highlight", () => {
    const c = new RightRailController(fake.adapters, "notes");
    fake.calls.length = 0;
    c.toggle("notes");
    expect(c.target).toBeNull();
    expect(fake.calls).toEqual(["close:notes", "fold:true", "hi:none"]);
  });

  it("toggleFold while open folds + clears, remembering the target", () => {
    const c = new RightRailController(fake.adapters, "tasker");
    fake.calls.length = 0;
    c.toggleFold();
    expect(c.target).toBeNull();
    expect(fake.calls).toEqual(["close:tasker", "fold:true", "hi:none"]);
  });

  it("toggleFold while folded restores the last target", () => {
    const c = new RightRailController(fake.adapters, "tasker");
    c.toggleFold();           // fold (remembers tasker)
    fake.calls.length = 0;
    c.toggleFold();           // restore
    expect(c.target).toBe("tasker");
    expect(fake.calls).toEqual(["open:tasker", "fold:false", "hi:tasker"]);
  });

  it("toggleFold while folded with no history restores blocks", () => {
    const c = new RightRailController(fake.adapters, null);
    fake.calls.length = 0;
    c.toggleFold();
    expect(c.target).toBe("blocks");
    expect(fake.calls).toEqual(["open:blocks", "fold:false", "hi:blocks"]);
  });

  it("clicking a toggle while folded unfolds with no stale target", () => {
    const c = new RightRailController(fake.adapters, "blocks");
    c.toggleFold();           // fold blocks
    fake.calls.length = 0;
    c.toggle("teammate");
    expect(c.target).toBe("teammate");
    expect(fake.calls).toEqual(["open:teammate", "fold:false", "hi:teammate"]);
  });

  it("handleExternalClose syncs state without re-closing the panel", () => {
    const c = new RightRailController(fake.adapters, "notes");
    fake.calls.length = 0;
    c.handleExternalClose("notes");   // panel closed itself
    expect(c.target).toBeNull();
    expect(fake.calls).toEqual(["fold:true", "hi:none"]); // no close:notes
  });

  it("handleExternalClose for a non-current target is a no-op", () => {
    const c = new RightRailController(fake.adapters, "blocks");
    fake.calls.length = 0;
    c.handleExternalClose("notes");
    expect(c.target).toBe("blocks");
    expect(fake.calls).toEqual([]);
  });

  it("syncView swaps highlight between blocks/structure without open/close", () => {
    const c = new RightRailController(fake.adapters, "blocks");
    fake.calls.length = 0;
    c.syncView("structure");
    expect(c.target).toBe("structure");
    expect(fake.calls).toEqual(["hi:structure"]);
  });

  it("syncView is a no-op when current is not a view", () => {
    const c = new RightRailController(fake.adapters, "teammate");
    fake.calls.length = 0;
    c.syncView("blocks");
    expect(c.target).toBe("teammate");
    expect(fake.calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from worktree root): `npx vitest run ui/src/titlebar/right-rail.test.ts`
Expected: FAIL — `Cannot find module './right-rail'`.

- [ ] **Step 3: Implement the controller**

Create `ui/src/titlebar/right-rail.ts`:

```ts
/// Targets that live IN the right rail. The Browser/globe button is
/// intentionally NOT a RailTarget — it toggles a main-area browser tab and is
/// not governed by the fold (see main.ts `toggleBrowser`).
export type RailTarget =
  | "blocks"
  | "structure"
  | "activity"
  | "recall"
  | "notes"
  | "teammate"
  | "tasker";

/// Side-effects the controller drives. Implementations live in main.ts and
/// know nothing about each other — the controller sequences them. Keeping this
/// an interface is what makes the controller unit-testable without the DOM.
export interface RailAdapters {
  /// Show the target's panel/view. Must NOT do exclusivity or highlighting.
  open(target: RailTarget): void;
  /// Hide the target's panel/view (idempotent). Must NOT restore other state.
  close(target: RailTarget): void;
  /// Collapse/expand the right rail (body class + persistence + refit).
  setFolded(folded: boolean): void;
  /// Light exactly one rail button, or none when target is null. Must not
  /// touch the globe button.
  highlight(target: RailTarget | null): void;
}

const VIEW_TARGETS: ReadonlySet<RailTarget> = new Set(["blocks", "structure", "activity", "recall"]);

/// Single source of truth for "what is the right rail showing." `null` == folded.
export class RightRailController {
  private current: RailTarget | null;
  private last: RailTarget;

  constructor(
    private readonly adapters: RailAdapters,
    initial: RailTarget | null,
  ) {
    this.current = initial;
    this.last = initial ?? "blocks";
  }

  get target(): RailTarget | null {
    return this.current;
  }

  /// Click handler for every rail button: open it, or fold if it's already active.
  toggle(target: RailTarget): void {
    this.setTarget(this.current === target ? null : target);
  }

  /// The fold button: collapse what's open, or restore the last target.
  toggleFold(): void {
    this.setTarget(this.current === null ? this.last : null);
  }

  /// External request to open a target (group-chip, ⌘⇧J, draft flows).
  open(target: RailTarget): void {
    this.setTarget(target);
  }

  /// A panel closed itself (its own close button or an external close event).
  /// Sync controller state without calling close() again.
  handleExternalClose(target: RailTarget): void {
    if (this.current === target) this.setTarget(null, true);
  }

  /// A tab reported its underlying view (blocks<->structure). Update the
  /// highlight in place, only when a view is currently the rail target.
  syncView(view: "blocks" | "structure"): void {
    if (this.current === view) return;
    if (this.current === "blocks" || this.current === "structure") {
      this.current = view;
      this.last = view;
      this.adapters.highlight(view);
    }
  }

  /// The one mutation path. `skipClose` is set when the old target already
  /// closed itself (avoids a re-entrant double-close).
  private setTarget(next: RailTarget | null, skipClose = false): void {
    if (this.current === next) return;
    if (this.current !== null && !skipClose) this.adapters.close(this.current);
    if (next !== null) this.adapters.open(next);
    this.adapters.setFolded(next === null);
    this.adapters.highlight(next);
    if (next !== null) this.last = next;
    this.current = next;
  }

  /// Reserved for callers that need to know if a target is a sidebar view.
  static isView(target: RailTarget): boolean {
    return VIEW_TARGETS.has(target);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from worktree root): `npx vitest run ui/src/titlebar/right-rail.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit (commit A — controller + tests)**

```bash
git add ui/src/titlebar/right-rail.ts ui/src/titlebar/right-rail.test.ts
git commit -m "feat(titlebar): RightRailController state machine for the right cluster"
```

---

## Task 3: Wire the controller into `main.ts`

**Files:**
- Modify: `ui/src/main.ts`

This is mechanical wiring: build adapters from the existing functions, make the panel open/close "dumb", and replace handlers. All edits are anchored by existing code. No tests here (integration verified by typecheck + build + the Task 6 manual checklist).

- [ ] **Step 1: Import the controller**

At the top of `ui/src/main.ts`, with the other imports, add:

```ts
import { RightRailController, type RailTarget } from "./titlebar/right-rail";
```

- [ ] **Step 2: Make Teammate open/close "dumb" (controller owns exclusivity + highlight)**

Replace `closeTeammateIfOpen` (`main.ts:699-705`) with a version that no longer touches highlights:

```ts
  /// Hide the teammate rail. Controller owns highlight/exclusivity, so this
  /// only tears down the teammate panel's own DOM/body state.
  const closeTeammatePanel = (): void => {
    if (!document.body.classList.contains("sidebar-view-teammate")) return;
    document.body.classList.remove("sidebar-view-teammate");
    teammatePanelHost.setAttribute("hidden", "");
    teammatePanel.close();
  };
  const openTeammatePanel = async (): Promise<void> => {
    document.body.classList.add("sidebar-view-teammate");
    teammatePanelHost.removeAttribute("hidden");
    const ops = await operatorList();
    const def = ops.find((o) => o.is_default) ?? ops[0];
    if (def) {
      await teammatePanel.openFor(def);
    } else {
      teammatePanelHost.innerHTML =
        `<div class="teammate-panel-empty">No operators configured yet. Open Settings → Operators.</div>`;
    }
  };
```

Replace the `teammate:close` listener (`main.ts:706`) so an external close syncs the controller:

```ts
  window.addEventListener("teammate:close", () => {
    closeTeammatePanel();
    rail.handleExternalClose("teammate");
  });
```

Delete the entire old `if (teammateBtn) { ... }` click-handler block (`main.ts:708-742`) — the handler is re-added in Step 7.

- [ ] **Step 3: Make Tasker open/close "dumb"**

Replace `closeTaskerIfOpen` (`main.ts:769-775`) and the `if (taskerBtn) { ... }` block (`main.ts:777-801`) with:

```ts
  const closeTaskerPanel = (): void => {
    if (!document.body.classList.contains("sidebar-view-tasker")) return;
    document.body.classList.remove("sidebar-view-tasker");
    taskerPanelHost.classList.add("hidden");
    taskerPanel.close();
  };
  const openTaskerPanel = (): void => {
    document.body.classList.add("sidebar-view-tasker");
    taskerPanelHost.classList.remove("hidden");
    taskerPanel.render();
  };
```

(The `taskerBtn` icon/tooltip wiring moves to Step 7; keep `Icons.checklist({ size: 14 })`.)

- [ ] **Step 4: Make Project Notes "dumb" + route external callers through the controller**

Replace `openProjectNotes` (`main.ts:1129-1176`) with a version that drops its own exclusivity, highlight toggling, and the `projectNotesReturnView` restore. Also delete the `let projectNotesReturnView` declaration (`main.ts:1126`).

```ts
  // Project Notes panel — singleton right sidebar. Controller owns exclusivity
  // and highlight; this just mounts/unmounts the panel + its body class.
  let activeProjectNotesPanel: ProjectNotesPanel | null = null;
  let pendingNotesArgs: {
    groupId: string;
    groupLabel: string;
    groupColor: string | null;
    defaultTab?: "commands" | "notes" | "docs" | "drafts";
  } | null = null;

  window.addEventListener("project-notes:close", () => {
    activeProjectNotesPanel?.close();
  });

  /// External entry point (group chip, ⌘⇧J, draft flows): set args, then let
  /// the controller close whatever's open and open notes.
  function requestProjectNotes(
    groupId: string,
    groupLabel: string,
    groupColor: string | null,
    opts?: { defaultTab?: "commands" | "notes" | "docs" | "drafts" },
  ): void {
    pendingNotesArgs = { groupId, groupLabel, groupColor, defaultTab: opts?.defaultTab };
    rail.open("notes");
  }

  /// "Dumb" opener invoked by the controller's open("notes"). Uses pending args
  /// if a specific group was requested, else the active group.
  function mountProjectNotes(): void {
    let args = pendingNotesArgs;
    pendingNotesArgs = null;
    if (!args) {
      const g = manager.activeGroup();
      if (!g) return;
      args = { groupId: g.id, groupLabel: g.name, groupColor: g.color ?? null };
    }
    if (activeProjectNotesPanel) activeProjectNotesPanel.close();
    document.body.classList.add("project-notes-open");
    const groupRootDir = manager.groupRootDirFor(args.groupId);
    activeProjectNotesPanel = new ProjectNotesPanel({
      groupId: args.groupId,
      groupLabel: args.groupLabel,
      groupColor: args.groupColor,
      groupRootDir,
      defaultTab: args.defaultTab,
      onClose: () => {
        activeProjectNotesPanel = null;
        document.body.classList.remove("project-notes-open");
        rail.handleExternalClose("notes");
      },
      onOpenFile: (absolutePath) => {
        manager.openFileAtLine(absolutePath);
        activeProjectNotesPanel?.close();
      },
      onOpenWizard: (_repoRoot) => {
        window.dispatchEvent(new CustomEvent("spec-chat:open"));
      },
      onSetRootDir: (gid) => manager.pickGroupRootDir(gid),
    }).mount(document.body);
  }
```

Update the four `openProjectNotes(...)` external callers to `requestProjectNotes(...)`:
- `main.ts:760` (group active button) → `if (g) requestProjectNotes(g.id, g.name, g.color ?? null);` — but this whole `projectNotesBtn` handler is replaced in Step 7; ensure Step 7 uses `rail.toggle("notes")`.
- `main.ts:1179` `onOpenProjectNotes: openProjectNotes` → `onOpenProjectNotes: requestProjectNotes`.
- `main.ts:1190` → `requestProjectNotes(g.id, g.name, g.color ?? null, { defaultTab: "drafts" });`
- `main.ts:1209` (⌘⇧J) → `requestProjectNotes(g.id, g.name, g.color ?? null);`
- `main.ts:1945` → `requestProjectNotes(g.id, g.name, g.color ?? null, { defaultTab: "drafts" });`

> Note (revert hook for the deliberate behavior change): if you later want panel-close to restore the previous view instead of folding, reintroduce `projectNotesReturnView` and have `onClose` call `rail.open(previousView)` instead of `handleExternalClose("notes")`.

- [ ] **Step 5: Replace `syncSidebarTitlebarButtons` / `pickView` / `setView` with controller adapters**

Replace the block `main.ts:510-592` (from `const syncSidebarTitlebarButtons` through `syncSidebarTitlebarButtons(activeSidebarTitlebarView);`) with the adapter definitions, controller construction, and view wiring. `viewBlocksBtn`..`viewRecallBtn`, `projectNotesBtn`, `teammateBtn`, `taskerBtn` must all be resolved **before** this block — move their `document.getElementById` lookups up if needed (they currently live further down; hoist the `const projectNotesBtn`, `const teammateBtn`, `const taskerBtn` lookups to just below the view-button lookups at `main.ts:501-504`).

```ts
  type SidebarTitlebarView = "blocks" | "structure" | "activity" | "recall";
  const ACTIVITY_KEY = "covenant.sidebar-view-activity";
  const BLOCKS_GLOBAL_KEY = "covenant.blocks-globally-collapsed";
  let activeSidebarTitlebarView: SidebarTitlebarView =
    localStorage.getItem(ACTIVITY_KEY) === "1" ? "activity" : "blocks";

  // Map every rail target to its titlebar button. Globe is absent on purpose.
  const railButtons: Record<RailTarget, HTMLElement | null> = {
    blocks: viewBlocksBtn,
    structure: viewFilesBtn,
    activity: viewActivityBtn,
    recall: viewRecallBtn,
    notes: projectNotesBtn,
    teammate: teammateBtn,
    tasker: taskerBtn,
  };

  const highlightRail = (target: RailTarget | null): void => {
    (Object.keys(railButtons) as RailTarget[]).forEach((k) =>
      railButtons[k]?.classList.toggle("titlebar-view-active", k === target),
    );
    document.body.classList.toggle("sidebar-view-activity", target === "activity");
  };

  const openRail = (target: RailTarget): void => {
    switch (target) {
      case "blocks":
      case "structure":
      case "recall":
        localStorage.removeItem(ACTIVITY_KEY);
        activeSidebarTitlebarView = target;
        window.dispatchEvent(new CustomEvent("sidebar-view:set", { detail: { view: target } }));
        break;
      case "activity":
        localStorage.setItem(ACTIVITY_KEY, "1");
        activeSidebarTitlebarView = "activity";
        break;
      case "notes":
        mountProjectNotes();
        break;
      case "teammate":
        void openTeammatePanel();
        break;
      case "tasker":
        openTaskerPanel();
        break;
    }
  };

  const closeRail = (target: RailTarget): void => {
    switch (target) {
      case "notes":
        activeProjectNotesPanel?.close();
        break;
      case "teammate":
        closeTeammatePanel();
        break;
      case "tasker":
        closeTaskerPanel();
        break;
      // Views (blocks/structure/activity/recall) need no teardown — folding
      // hides the rail; the view content stays rendered underneath.
      default:
        break;
    }
  };

  const setRailFolded = (folded: boolean): void => {
    applyBlocksCollapsed(folded);
    if (folded) localStorage.setItem(BLOCKS_GLOBAL_KEY, "1");
    else localStorage.removeItem(BLOCKS_GLOBAL_KEY);
    setTimeout(() => manager.refitActive(), 320);
  };

  const initialFolded = localStorage.getItem(BLOCKS_GLOBAL_KEY) === "1";
  const rail = new RightRailController(
    { open: openRail, close: closeRail, setFolded: setRailFolded, highlight: highlightRail },
    initialFolded ? null : activeSidebarTitlebarView,
  );
  // Paint the initial button state (fold state itself is applied at the
  // existing applyBlocksCollapsed call during boot).
  highlightRail(rail.target);

  // Guard: blocks/files are terminal-tab features; recall/activity are global.
  const clickView = (view: SidebarTitlebarView): void => {
    if ((view === "blocks" || view === "structure") && manager.activeKind() === "pi") {
      pushInfoToast({
        message: "Blocks and Files are available on terminal tabs. Switch to a shell tab first.",
      });
      return;
    }
    rail.toggle(view);
  };

  if (viewBlocksBtn && viewFilesBtn && viewActivityBtn) {
    viewBlocksBtn.innerHTML = Icons.terminal({ size: 14 });
    viewFilesBtn.innerHTML = Icons.folder({ size: 14 });
    viewActivityBtn.innerHTML = Icons.zap({ size: 14 });
    if (viewRecallBtn) viewRecallBtn.innerHTML = Icons.history({ size: 14 });
    attachTooltip(viewBlocksBtn, "Blocks");
    attachTooltip(viewFilesBtn, "Files");
    attachTooltip(viewActivityBtn, "Activity");
    if (viewRecallBtn) attachTooltip(viewRecallBtn, "Recall");
    viewBlocksBtn.addEventListener("click", () => clickView("blocks"));
    viewFilesBtn.addEventListener("click", () => clickView("structure"));
    viewActivityBtn.addEventListener("click", () => clickView("activity"));
    viewRecallBtn?.addEventListener("click", () => clickView("recall"));
    window.addEventListener("sidebar-view:active", (e) => {
      const v = (e as CustomEvent<{ view: "blocks" | "structure" }>).detail.view;
      rail.syncView(v);
    });
  }
```

- [ ] **Step 6: Re-add the Project Notes / Teammate / Tasker button handlers as toggles**

Where each button is set up (icons/tooltips), set the click handler to a controller toggle. Keep icon sizes at 14px (Project Notes drops from 16 — covered in Task 5, but set it here too for a single edit):

```ts
  if (projectNotesBtn) {
    projectNotesBtn.innerHTML = Icons.clipboard({ size: 14 });
    attachTooltip(projectNotesBtn, "Project notes");
    projectNotesBtn.addEventListener("click", () => rail.toggle("notes"));
  }
  if (teammateBtn) {
    teammateBtn.innerHTML = Icons.messageCircle({ size: 14 });
    attachTooltip(teammateBtn, "Teammate chat");
    teammateBtn.addEventListener("click", () => rail.toggle("teammate"));
  }
  if (taskerBtn) {
    taskerBtn.innerHTML = Icons.checklist({ size: 14 });
    attachTooltip(taskerBtn, "Tasker (⌘⌥K)");
    taskerBtn.addEventListener("click", () => rail.toggle("tasker"));
  }
```

Also update the Tasker keyboard shortcut (⌘⌥K, near `main.ts:1783`) and any teammate shortcut to call `rail.toggle("tasker")` / `rail.toggle("teammate")` instead of the old open/close helpers, so keyboard and button share one path. (Search for the old `closeTaskerIfOpen()` / `closeTeammateIfOpen()` call sites and the ⌘⌥K handler; replace their open/close logic with the matching `rail.toggle(...)`.)

- [ ] **Step 7: Replace the fold-right handler with `toggleFold`**

Replace the `foldRightBtn` click handler (`main.ts:821-828`) body with:

```ts
    foldRightBtn.addEventListener("click", () => rail.toggleFold());
```

Keep the surrounding `attachTooltip` and the initial `applyBlocksCollapsed(localStorage.getItem(BLOCKS_GLOBAL_KEY) === "1")` call (`main.ts:819-820`) — that applies the persisted fold state at boot, and the icon swap inside `applyBlocksCollapsed` still drives the fold button's glyph.

- [ ] **Step 8: Typecheck + full test run**

Run (from worktree root):
- `npx tsc --noEmit` → Expected: PASS.
- `npx vitest run` → Expected: PASS for `right-rail.test.ts`; pre-existing unrelated failures in the suite are acceptable (note them, don't fix).

- [ ] **Step 9: Build**

Run (from worktree root): `npm run build`
Expected: `tsc && vite build` completes with no errors.

- [ ] **Step 10: Commit (commit B — titlebar wiring)**

```bash
git add ui/src/main.ts
git commit -m "feat(titlebar): route all right-cluster buttons + fold through RightRailController"
```

---

## Task 4: Browser/globe toggle + active-state sync

**Files:**
- Modify: `ui/src/main.ts`

- [ ] **Step 1: Add the globe toggle + sync helpers**

Replace the globe click wiring (`main.ts:938-941`, `browserBtn?.addEventListener("click", () => void manager.openBrowserTab("", true));`) with:

```ts
  const syncBrowserActive = (): void => {
    browserBtn?.classList.toggle("titlebar-view-active", manager.hasBrowserTab());
  };
  const toggleBrowser = async (): Promise<void> => {
    const id = manager.firstBrowserTabId();
    if (id) manager.closeTab(id);
    else await manager.openBrowserTab("", true);
    syncBrowserActive();
  };
  browserBtn?.addEventListener("click", () => void toggleBrowser());
  syncBrowserActive();
```

- [ ] **Step 2: Re-sync the globe on any tab change**

In the existing `manager.onActiveTabChange` handler (`main.ts:1075-1077`), add a `syncBrowserActive()` call so closing/opening a browser tab via its own tab UI also updates the globe:

```ts
  manager.onActiveTabChange = (info) => {
    statusBar.setActiveTab(info);
    syncBrowserActive();
  };
```

(`syncBrowserActive` is defined earlier in `boot()`, so it's in scope here.)

- [ ] **Step 3: Typecheck + build**

Run (from worktree root): `npx tsc --noEmit` then `npm run build`
Expected: both PASS.

- [ ] **Step 4: Commit (commit C — browser toggle + manager helpers; includes Task 1)**

```bash
git add ui/src/main.ts ui/src/tabs/manager.ts
git commit -m "feat(titlebar): globe becomes a browser-tab toggle with active state"
```

---

## Task 5: Equal weight (Project Notes icon 16→14)

**Files:**
- Modify: `ui/src/main.ts`

- [ ] **Step 1: Confirm the icon size**

If Task 3 Step 6 already set `Icons.clipboard({ size: 14 })`, verify there is no remaining `Icons.clipboard({ size: 16 })` anywhere:

Run (from worktree root): `grep -rn "clipboard({ size: 16" ui/src`
Expected: no output. If any remain, change `16` → `14`.

- [ ] **Step 2: Verify build**

Run (from worktree root): `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit (commit D — weight)**

```bash
git add ui/src/main.ts
git commit -m "fix(titlebar): normalize Project Notes icon to 14px to match the row"
```

---

## Task 6: Manual in-app verification

**Files:** none (runtime verification)

Per project convention, run the app and walk the checklist before claiming done. Use the `respawn` skill or `npm run tauri:dev` (it needs the experimental `internal_browser` flag ON to see the globe).

- [ ] **Step 1: Launch the app** (`respawn` skill, or `npm run tauri:dev` in the worktree)

- [ ] **Step 2: Walk the checklist**

  - [ ] Each of the 8 buttons: click once → its panel/view shows + button lights; click again → it folds and the button dims. Exactly one rail button lit at a time.
  - [ ] Open any panel, click the fold button → the panel closes and **every** button dims (the old bug: a button stayed lit while the rail was hidden).
  - [ ] With the rail folded, click any toggle → rail unfolds and **only** that one lights.
  - [ ] Open Tasker, then click Blocks → Tasker closes (the old `pickView`-forgot-Tasker bug).
  - [ ] Open Teammate, then open Tasker → Teammate closes (exclusivity).
  - [ ] Globe: click → a browser tab opens + globe lights; click globe again → that tab closes + globe dims. Open a browser tab, close it via its own tab close button → globe dims.
  - [ ] Project Notes icon visually matches the size of Files/Activity/Teammate/Tasker icons.
  - [ ] Reload the app → the previously-active view (or folded state) is restored, with the correct single button lit.
  - [ ] ⌘⇧J opens Project Notes (and lights its button); ⌘⌥K toggles Tasker.

- [ ] **Step 3: Report results.** If all pass, the branch is ready for review/merge. If anything fails, debug with `superpowers:systematic-debugging` before claiming done.

---

## Self-Review

**Spec coverage:**
- Toggle parity (every button same toggle) → Tasks 2 (controller), 3 (view/panel handlers → `rail.toggle`), 4 (globe → `toggleBrowser`). ✓
- Equal weight (14px + shared active style) → Task 5 (icon) + Task 3 Step 6; globe active via Task 4. ✓
- Respect the fold (single authority, clears all highlights, unfold-on-click) → controller `setTarget`/`toggleFold` (Task 2) + fold handler (Task 3 Step 7). ✓
- Browser exception (toggle a tab, not rail-governed) → Tasks 1 + 4, and `RailTarget` excludes browser. ✓
- Root-cause (single owner of exclusivity) → controller closes-old-before-open; all cross-dispatch exclusivity removed (Task 3 Steps 2-5). ✓
- Tests (7+ transitions) → Task 2 has 12. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `RailTarget`, `RailAdapters`, `RightRailController.{toggle,toggleFold,open,handleExternalClose,syncView,target}` are used identically across Tasks 2 and 3. Adapter method names (`open`/`close`/`setFolded`/`highlight`) match between the interface, the fake in tests, and the main.ts construction. `hasBrowserTab`/`firstBrowserTabId` defined in Task 1 and consumed in Task 4. ✓
