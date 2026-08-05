// Canon Cockpit — full-screen overlay shell for org-scoped Canon management.
// Left-nav section routing (org/members/skills/registry/context/loop); each
// section is a stub in this task — Tasks 6-8 fill in real content. Launched
// from the expand button in the rail's CanonPanel head (see panel.ts).
//
// Opaque full-screen overlay by design — mirrors ContextMinerView's
// mount/close/Esc handling (see miner.css header comment for the
// vibrancy-bleed gotcha this avoids).

import "./cockpit.css";
import type { CanonStatus, Org, Member, Operator, PkgMeta, CanonPkgKind, CanonNewKind, ProjectionStatus } from "../../api";
import {
  canonOrgDefaults,
  canonOrgDefaultSet,
  canonOrgDefaultUnset,
  canonUnitInstalled,
  canonOrgMembers,
  canonAddMember,
  canonRemoveMember,
  canonDeleteOrg,
  canonMyOrgs,
  canonLocalStatus,
  canonReadLocal,
  canonReadSource,
  canonProjectionStatus,
  canonExport,
  canonUnitPath,
  canonDeleteUnit,
  canonPublish,
  canonAdopt,
  canonNewUnit,
  canonImportSkill,
  canonUninstallSkill,
  canonSearch,
  canonPreview,
  canonInstallRegistry,
  canonInstallRegistryUnit,
  scoreSummaryFiltered,
  scoreSkillUsage,
  canonEvalSummary,
  operatorList,
  operatorDelete,
} from "../../api";
import { scoreCurrentUser } from "../../score/api";
import { skillCard, iconButton, statCell, meterRow, fmtTokens, evalScoreLabel } from "../panel";
import { openMcpReader } from "../mcp-reader";
import { resolveActiveOrg, orgInitials, orgHue } from "../org";
import { openCreateOrgExperience } from "../create-org/view";
import { openConfirmTyped } from "../../workspaces/confirm-typed";
import { openConfirmPrompt } from "../../workspaces/confirm-prompt";
import { openOperatorModal, wireOperatorModal, renderOperatorList } from "../../operator/creator";
import { operatorsForOrg, isStaleOrg } from "../../operator/org-filter";
import { pullOrgOperators } from "../../operator/org-sync";
import { pushInfoToast } from "../../notifications/toast";
import { Icons } from "../../icons";
import { attachTooltip } from "../../tooltip/tooltip";
import { evalCountLabel, liftRow, groupVerdict } from "./lift";
import { draftEvals, openEvalManager, runEvals } from "../evals";
import { makeSpecScoreHoverBadge } from "../../spec-score/badge";
import { scoreSpec } from "../../spec-score/engine";

export type SectionKey = "overview" | "org" | "members" | "operators" | "agents" | "commands" | "mcp" | "spec" | "memory" | "skills" | "registry" | "context" | "loop";

export interface CanonCockpitOpts {
  groupId: string;
  groupLabel: string;
  groupRootDir: string | null;
  orgs: Org[];
  /** False when the initial `canonMyOrgs()` fetch failed (offline/backend
   *  down) — `orgs` is then an empty placeholder, not a real "belongs to no
   *  org" result. The operators section uses this to tell "deleted org"
   *  from "don't know yet" so it never mis-flags or clobbers a valid
   *  org-assigned operator while offline (see operator/org-filter.ts). */
  orgsFetched: boolean;
  getActiveOrg: () => string | null;
  setActiveOrg: (slug: string | null) => void;
  /** Launch the repo-mining Context Miner for this group (same flow the
   *  rail panel used to expose directly — now only reachable from here). */
  onNewContext?: () => void;
  /** Open a file in the workspace editor (the cockpit closes first). Used by
   *  the per-kind "New …" actions to drop the author straight into the
   *  scaffold they just created. */
  onOpenFile?: (path: string) => void;
  /** Open the immersive Spec Creator grounded in this group's repo. Specs are
   *  authored there, not scaffolded — the creator is a better surface than an
   *  empty file, as long as it is scoped to the repo being worked on. */
  onNewSpec?: (repoRoot: string) => void;
  /** Section to land on instead of Organization — lets anything in the app
   *  say "open Canon at the Registry" (`covenant:open-canon`) rather than
   *  dropping the user on the least actionable screen. */
  section?: SectionKey;
  /** Called after the overlay is torn down — lets the caller refresh the
   *  still-mounted rail panel, whose org chip otherwise goes stale until
   *  its next own refresh (e.g. after this cockpit switched/created an org). */
  onClose?: () => void;
}

/** Order specs by their dotted number, not by filename: sorting the raw names
 *  is lexicographic, so "3.10" lands between "3.1" and "3.2". Unnumbered specs
 *  sort last, alphabetically. */
export function sortSpecs<T extends { name: string }>(specs: readonly T[]): T[] {
  const parts = (name: string): number[] =>
    (/^[\d.]+(?=-)/.exec(name)?.[0] ?? "").split(".").filter(Boolean).map(Number);
  return [...specs].sort((a, b) => {
    const [x, y] = [parts(a.name), parts(b.name)];
    if (!x.length || !y.length) return (y.length - x.length) || a.name.localeCompare(b.name);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    }
    return 0;
  });
}

/** "3h ago" for the projection strip. Same rounding the Capabilities panel
 *  uses; not worth a shared module for four lines. */
function relTime(unixSecs: number): string {
  const diff = Math.max(0, Math.floor(Date.now() / 1000 - unixSecs));
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Is an installed skill current, behind the registry, or edited in place?
 *
 *  A registry without a staleness signal is a download page. Both comparisons
 *  are ones we can actually trust: the version string comes from the same
 *  `skill.toml` on both sides, and "modified" is the backend comparing the
 *  file's hash against the sha IT recorded at install — the registry's own
 *  digest is never assumed to be computed the same way.
 *
 *  Returns null when there's nothing to say — a badge on every row is noise. */
export function skillCurrency(
  installed: { name: string; version: string },
  publishedVersion: string | undefined,
  modified: readonly string[],
): string | null {
  if (modified.includes(installed.name)) return "modified locally";
  if (publishedVersion && publishedVersion !== installed.version) {
    return `update available · v${publishedVersion}`;
  }
  return null;
}

/** Installed units nothing has used. Context that ships into every prompt and
 *  earns nothing is the one thing Observe should say out loud — it's what
 *  tells the next Generate what to stop authoring. Zero is the only threshold
 *  worth acting on, so there is no window to configure. */
export function unusedUnits(
  installed: readonly { name: string }[],
  usage: readonly { skill: string; uses: number }[],
): string[] {
  const uses = new Map(usage.map((u) => [u.skill, u.uses]));
  return installed.filter((i) => (uses.get(i.name) ?? 0) === 0).map((i) => i.name);
}

/** What this repo carries, per kind — the Overview's inventory. Ordered as the
 *  nav is, so the two read the same way. */
export function inventoryRows(s: CanonStatus): { section: SectionKey; label: string; count: number }[] {
  return [
    { section: "agents", label: "Subagents", count: s.agents.length },
    { section: "commands", label: "Commands", count: s.commands.length },
    { section: "mcp", label: "MCP servers", count: s.mcp.length },
    { section: "spec", label: "Specs", count: s.specs.length },
    { section: "memory", label: "Memory", count: s.memory.length },
    { section: "skills", label: "Skills", count: s.installed.length + s.detectedSkills.length },
    { section: "context", label: "Context", count: s.contexts.length },
  ];
}

/** A small uppercase subhead inside the Loop section (Adoption / Inference /
 *  Eval pass-rate) — mirrors panel.ts's rail-only helper of the same name. */
function loopSubhead(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "canon-subhead";
  el.textContent = text;
  return el;
}

/** The org-wide pass-rate segment for a registry card, or null when nobody has
 *  run this version's evals — "0/0 eval runs" would read as a broken package
 *  rather than an unmeasured one.
 *
 *  The row key is (package_id, github_id, eval_id), so this counts
 *  (person × eval) pairs, not a suite of evals — two members each running
 *  seven evals total 14. It says "eval runs" and not "evals" on purpose:
 *  eval definitions are hand-authored per machine under
 *  .covenant/canon/evals/<kind>/<name>/ and never travel with the package
 *  (install_from_dir / read_skill_package only touch skill.toml + SKILL.md),
 *  so there is no shared suite size to report. Do not "tidy" this back to
 *  "evals" — that would claim a number this data doesn't have. */
export function evalChip(p: PkgMeta): string | null {
  return p.eval_total > 0 ? `${p.eval_passed}/${p.eval_total} eval runs` : null;
}

/** The nav, grouped by what each section is FOR — the lifecycle Canon exists
 *  to run (docs/canon-context-is-the-new-code.md), not the directory layout.
 *  A flat list of twelve made "Loop" sit beside "MCP" as if they were the same
 *  kind of thing; the group label does the teaching instead. */
const SECTION_GROUPS: { title: string | null; items: { key: SectionKey; label: string }[] }[] = [
  { title: null, items: [{ key: "overview", label: "Overview" }] },
  {
    title: "Authoring",
    items: [
      { key: "agents", label: "Subagents" },
      { key: "commands", label: "Commands" },
      { key: "mcp", label: "MCP" },
      { key: "spec", label: "Specs" },
      { key: "memory", label: "Memory" },
      { key: "skills", label: "Skills" },
      { key: "context", label: "Context" },
    ],
  },
  {
    title: "Sharing",
    items: [
      { key: "org", label: "Organization" },
      { key: "members", label: "Members" },
      { key: "operators", label: "Operators" },
      { key: "registry", label: "Registry" },
    ],
  },
  // "Loop" named an abstraction; every other label names something you can
  // point at. What the section actually answers is whether the context earned
  // its keep.
  { title: "Impact", items: [{ key: "loop", label: "Impact" }] },
];


/** The single-file kinds that render identically — a filter, an inline create
 *  bar, and one card per unit. Only the copy, the glyph and the list differ, so
 *  they share `renderUnitSection` and adding a kind is one entry here.
 *
 *  Skills (skills.sh import + uninstall) and Context (miner-driven, no create
 *  bar) keep their own renderers: folding them in costs more branching than the
 *  duplication it removes. Specs route to the Spec Creator, so no entry.
 *
 *  A section with an entry here is also the set whose header carries "New" —
 *  the two lists were always the same list. */
interface UnitSpec {
  /** Authoring/reading/deleting kind — narrower than `CanonNewKind` on
   *  purpose: a skill is not one of these (it has its own renderer). */
  kind: "agent" | "command" | "mcp" | "memory";
  /** Registry kind, or null for kinds the registry doesn't carry (memory) —
   *  which is also what gates the publish/adopt row actions. */
  pkg: CanonPkgKind | null;
  icon: (size: number) => string;
  /** Title-cased singular, used in the empty-state CTA ("New subagent"). */
  noun: string;
  /** Lowercase plural, used in the filter placeholder and the error line. */
  plural: string;
  emptyTitle: string;
  emptyHint: string;
  noRepoHint: string;
  /** Its empty state tells you to crawl the repo, so it carries the door. */
  crawlable?: true;
  /** Can this kind be run through the eval harness? Absent for mcp — an MCP
   *  server is a connection, not context, so there is nothing to judge. */
  evaluable?: true;
  list: (s: CanonStatus) => readonly UnitRow[];
}

/** The shape every unit row shares once the per-kind fields are optional. */
interface UnitRow {
  name: string;
  description?: string | null;
  detectedIn?: string | null;
  transport?: string;
}

const DETECTED_HINT = "Canon detects and adopts what's already in the repo.";

export const UNIT_SPECS: Partial<Record<SectionKey, UnitSpec>> = {
  agents: {
    kind: "agent", pkg: "agent", icon: (size) => Icons.bot({ size }),
    noun: "subagent", plural: "subagents",
    emptyTitle: "No subagents yet",
    emptyHint: `Install a subagent, or crawl the repo for context — ${DETECTED_HINT}`,
    noRepoHint: "Point this group at a repo from the rail to manage subagents.",
    crawlable: true,
    evaluable: true,
    list: (s) => s.agents,
  },
  commands: {
    kind: "command", pkg: "command", icon: (size) => Icons.terminalSquare({ size }),
    noun: "command", plural: "commands",
    emptyTitle: "No commands yet",
    emptyHint: `Install a command, or crawl the repo for context — ${DETECTED_HINT}`,
    noRepoHint: "Point this group at a repo from the rail to manage commands.",
    crawlable: true,
    evaluable: true,
    list: (s) => s.commands,
  },
  mcp: {
    kind: "mcp", pkg: "mcp", icon: (size) => Icons.radioTower({ size }),
    noun: "MCP server", plural: "MCP servers",
    emptyTitle: "No MCP servers yet",
    emptyHint: `Install an MCP server, or crawl the repo for context — ${DETECTED_HINT}`,
    noRepoHint: "Point this group at a repo from the rail to manage MCP servers.",
    crawlable: true,
    list: (s) => s.mcp,
  },
  memory: {
    kind: "memory", pkg: null, icon: (size) => Icons.database({ size }),
    noun: "memory", plural: "memories",
    emptyTitle: "No memories yet",
    emptyHint: "Durable facts that ride into every executor's managed block.",
    noRepoHint: "Point this group at a repo from the rail to manage memory.",
    evaluable: true,
    list: (s) => s.memory,
  },
};

/** Title + one-line description for each section's header. */
const SECTION_HEAD: Record<SectionKey, [string, string]> = {
  overview: ["Overview", "What this repo's Canon carries, and what needs attention."],
  org: ["Organization", "The registry this group publishes to and installs from."],
  members: ["Members", "People with access to this organization's Canon."],
  operators: ["Operators", "Versions of you, delegated — org-scoped personas that direct your executors."],
  agents: ["Subagents", "Repo-level subagent files projected into executor context."],
  commands: ["Commands", "Slash commands projected to your executors."],
  mcp: ["MCP", "Model Context Protocol servers projected to your executors."],
  spec: ["Specs", "Task-anchor specs published in this repo (docs/specs)."],
  memory: ["Memory", "Durable facts this group carries into every executor's managed block."],
  skills: ["Skills", "Skills installed in this group, projected to your executors."],
  registry: ["Registry", "Browse and install everything your organization publishes — skills, operators, subagents, commands, context and MCP servers."],
  context: ["Context", "Repo-mined context this group carries into every session."],
  loop: ["Impact", "Whether this group's context earned its keep — adoption, dead weight, inference footprint and eval lift."],
};

export class CanonCockpitView {
  private root: HTMLElement;
  private nav: HTMLElement;
  private content: HTMLElement;
  private closeBtn: HTMLButtonElement;
  private current: SectionKey = "overview";
  /** One repo walk per cockpit open, shared by every section that reads it.
   *  Sections re-render on every mutation (`showSection(this.current)`), so
   *  without this each adopt/publish/uninstall walked the whole repo again to
   *  redraw one row. Mutations call `invalidateStatus()` before re-rendering. */
  private statusCache: Promise<CanonStatus> | null = null;
  /** A name the ⌘K finder picked, applied by the next section's filter. */
  private pendingFilter: string | null = null;

  /** The root element of the overlay — used by tests and by callers that
   *  need to query the rendered content without going through document. */
  get element(): HTMLElement { return this.root; }

  constructor(private opts: CanonCockpitOpts) {
    if (opts.section) this.current = opts.section;
    this.root = document.createElement("div");
    this.root.className = "canon-cockpit";

    this.nav = document.createElement("nav");
    this.nav.className = "canon-cockpit-nav";
    const title = document.createElement("div");
    title.className = "canon-cockpit-nav-title";
    title.textContent = `Canon — ${this.opts.groupLabel}`;
    this.nav.appendChild(title);
    for (const group of SECTION_GROUPS) {
      if (group.title) {
        const head = document.createElement("div");
        head.className = "canon-cockpit-nav-group";
        head.textContent = group.title;
        this.nav.appendChild(head);
      }
      for (const s of group.items) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "canon-cockpit-nav-btn";
        b.dataset.section = s.key;
        b.textContent = s.label;
        b.addEventListener("click", () => this.showSection(s.key));
        this.nav.appendChild(b);
      }
    }

    this.content = document.createElement("section");
    this.content.className = "canon-cockpit-content";

    // The esc pill lives INSIDE each section's sticky header (sectionHead
    // re-parents this one instance), not as an absolute overlay on the root.
    // Overlaying it above the scrolling cards made it flicker on WebKit
    // whenever a card hover animated beneath it (see cockpit.css history —
    // the translateZ(0) promotion only papered over it).
    const close = document.createElement("button");
    close.type = "button";
    close.className = "canon-cockpit-close";
    close.setAttribute("aria-label", "Close (Esc)");
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.close());
    this.closeBtn = close;

    this.root.append(this.nav, this.content);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    // A torn-down cockpit owns no keys, whatever happened to its listener.
    if (!this.root.isConnected) return;
    if (e.key === "Escape") { this.close(); return; }
    // ⌘K is the app's agent-panel toggle; while this modal is open it belongs
    // to the modal, hence capture + stopPropagation.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      e.stopPropagation();
      this.openFinder();
    }
  };

  open(): void {
    document.body.appendChild(this.root);
    // Lets cockpit.css re-stack the rail's SKILL.md reader (openMarkdownReader,
    // z-index 60, positioned for the narrow rail panel) above the full-screen
    // cockpit overlay (z-index 9600) instead of rendering behind it.
    document.body.classList.add("canon-cockpit-open");
    document.addEventListener("keydown", this.onKey, true);
    this.showSection(this.current);
  }

  close(): void {
    this.root.remove();
    document.body.classList.remove("canon-cockpit-open");
    document.removeEventListener("keydown", this.onKey, true);
    this.opts.onClose?.();
  }

  showSection(key: SectionKey): void {
    this.current = key;
    for (const b of this.nav.querySelectorAll("button")) {
      b.classList.toggle("is-active", (b as HTMLElement).dataset.section === key);
    }
    this.content.replaceChildren(this.renderSection(key));
  }

  private renderSection(key: SectionKey): HTMLElement {
    let headAction: HTMLElement | undefined;
    const unitSpec = UNIT_SPECS[key];
    if (unitSpec && this.opts.groupRootDir && this.canCreate()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "canon-sec-head-action";
      btn.innerHTML = Icons.plus({ size: 14 }) + "<span>New</span>";
      // Toggles the create bar (wired by the section's newUnitBar).
      headAction = btn;
    } else if (key === "operators" && this.canCreate()) {
      // Same head action as every other kind; the click opens the immersive
      // creator instead of an inline name bar (an operator is more than a name).
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "canon-sec-head-action";
      btn.innerHTML = Icons.plus({ size: 14 }) + "<span>New</span>";
      btn.addEventListener("click", () => this.openNewOperator());
      headAction = btn;
    } else if (key === "spec" && this.opts.groupRootDir && this.opts.onNewSpec && this.canCreate()) {
      const root = this.opts.groupRootDir;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "canon-sec-head-action";
      btn.innerHTML = Icons.plus({ size: 14 }) + "<span>New spec</span>";
      btn.addEventListener("click", () => { this.close(); this.opts.onNewSpec?.(root); });
      headAction = btn;
    } else if (key === "context" && this.opts.groupRootDir && this.opts.onNewContext) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "canon-sec-head-action";
      btn.textContent = "New context";
      btn.hidden = true; // revealed once the list confirms it has files
      btn.addEventListener("click", () => this.opts.onNewContext?.());
      headAction = btn;
    } else if (key === "skills" && this.opts.groupRootDir && this.canCreate()) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "canon-sec-head-action";
      btn.innerHTML = Icons.plus({ size: 14 }) + "<span>Add</span>";
      // Toggles the skills.sh import row (wired in renderSkillsSection).
      headAction = btn;
    }
    const body =
      key === "overview" ? this.renderOverviewSection()
      : key === "org" ? this.renderOrgSection()
      : key === "members" ? this.renderMembersSection()
      : key === "operators" ? this.renderOperatorsSection()
      : unitSpec ? this.renderUnitSection(key, unitSpec, headAction)
      : key === "spec" ? this.renderSpecSection()
      : key === "skills" ? this.renderSkillsSection(headAction)
      : key === "registry" ? this.renderRegistrySection()
      : key === "context" ? this.renderContextSection(headAction)
      : this.renderLoopSection();
    // Full-bleed header (divider spans the whole pane) + a contained content
    // column below it — the Capabilities layout.
    const wrap = document.createElement("div");
    wrap.className = "canon-cockpit-section-wrap";
    wrap.append(this.sectionHead(SECTION_HEAD[key][0], SECTION_HEAD[key][1], headAction), body);
    return wrap;
  }

  /** A consistent section header: title + one-line description, with an
   *  optional right-aligned action (e.g. Context's "New context"). Gives
   *  every section the same top structure instead of dropping straight
   *  into content. */
  private sectionHead(title: string, desc: string, action?: HTMLElement): HTMLElement {
    const head = document.createElement("header");
    head.className = "canon-cockpit-sec-head";
    const text = document.createElement("div");
    text.className = "canon-cockpit-sec-text";
    const h = document.createElement("h2");
    h.className = "canon-cockpit-sec-title";
    h.textContent = title;
    const p = document.createElement("p");
    p.className = "canon-cockpit-sec-desc";
    p.textContent = desc;
    text.append(h, p);
    head.appendChild(text);
    const actions = document.createElement("div");
    actions.className = "canon-cockpit-sec-actions";
    if (action) actions.appendChild(action);
    actions.appendChild(this.closeBtn);
    head.appendChild(actions);
    return head;
  }

  /** The org this cockpit is scoped to. Delegates to the shared resolver in
   *  org.ts — keep the resolution order in one place. */
  private activeOrg(): Org | null {
    return resolveActiveOrg(this.opts.orgs, this.opts.getActiveOrg());
  }

  /** The repo's Canon status, fetched once and shared. A rejection is never
   *  cached — an offline read would otherwise stick for the cockpit's life. */
  private status(cwd: string): Promise<CanonStatus> {
    if (!this.statusCache) {
      this.statusCache = canonLocalStatus(cwd).catch((e) => {
        this.statusCache = null;
        throw e;
      });
    }
    return this.statusCache;
  }

  /** Drop the cached status so the next render sees the repo as it now is.
   *  Call before any re-render that follows a write (create/adopt/install/
   *  uninstall) — not after, or the re-render races the invalidation. */
  private invalidateStatus(): void {
    this.statusCache = null;
  }

  private note(text: string): HTMLElement {
    const p = document.createElement("p");
    p.className = "canon-cockpit-note";
    p.textContent = text;
    return p;
  }

  /** A shared filter toolbar sitting above a section's list. Filters live,
   *  client-side, by substring over each `.canon-skill-row`'s text (name +
   *  meta). Starts hidden — the section reveals it once its list confirms it
   *  has rows (a lone filter box over an empty state reads as noise). A
   *  "no matches" note appears when a query hides everything.
   *
   *  Returns `{ element, reveal }` like `newUnitBar` — `reveal()` also
   *  re-applies a query the finder pre-filled, which lands before the rows do. */
  private filterToolbar(list: HTMLElement, placeholder: string): { element: HTMLElement; reveal: () => void } {
    const bar = document.createElement("div");
    // NOT "canon-toolbar" — that class belongs to the rail panel's org-chip
    // toolbar (canon/styles.css) and carries padding + a border-bottom that
    // inset this input and drew a stray divider. Own, unique class.
    bar.className = "canon-filter-bar";
    bar.hidden = true;
    bar.innerHTML = Icons.search({ size: 14 });
    const input = document.createElement("input");
    input.type = "text";
    input.className = "canon-filter";
    input.placeholder = placeholder;
    input.setAttribute("aria-label", placeholder);
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      let shown = 0;
      for (const row of Array.from(list.children)) {
        if (!(row instanceof HTMLElement) || !row.classList.contains("canon-skill-row")) continue;
        const match = (row.textContent ?? "").toLowerCase().includes(q);
        row.hidden = !match;
        if (match) shown++;
      }
      let none = list.querySelector<HTMLElement>(".canon-filter-none");
      if (q && shown === 0) {
        if (!none) {
          none = this.note("No matches.");
          none.classList.add("canon-filter-none");
          list.appendChild(none);
        }
        none.hidden = false;
      } else if (none) {
        none.hidden = true;
      }
    });
    bar.appendChild(input);
    // A ⌘K pick lands here before the section's rows exist; `reveal()` runs the
    // filter once they do.
    if (this.pendingFilter) {
      input.value = this.pendingFilter;
      this.pendingFilter = null;
    }
    return {
      element: bar,
      reveal: () => {
        bar.hidden = false;
        if (input.value) input.dispatchEvent(new Event("input"));
      },
    };
  }

  /** Every unit the shared status knows about, flattened for the finder.
   *  Exported shape is deliberately flat — kind label + name + the section
   *  that owns it is everything a search result needs. */
  private static finderRows(s: CanonStatus): { section: SectionKey; kind: string; name: string }[] {
    const rows: { section: SectionKey; kind: string; name: string }[] = [];
    const push = (section: SectionKey, kind: string, names: readonly { name: string }[]): void => {
      for (const u of names) rows.push({ section, kind, name: u.name });
    };
    push("skills", "skill", s.installed);
    push("skills", "skill", s.detectedSkills);
    push("agents", "subagent", s.agents);
    push("commands", "command", s.commands);
    push("mcp", "mcp", s.mcp);
    push("memory", "memory", s.memory);
    push("context", "context", s.contexts);
    push("spec", "spec", s.specs);
    return rows;
  }

  /** ⌘K — one search across every kind, instead of seven per-section filters
   *  that can't see each other. Picking a row opens its section with the name
   *  pre-filled in that section's filter. Reuses the command palette's chrome
   *  (styles.css) rather than growing a second overlay language. */
  private openFinder(): void {
    const cwd = this.opts.groupRootDir;
    if (!cwd) {
      pushInfoToast({ message: "Point this group at a repo to search its Canon." });
      return;
    }
    if (document.querySelector(".canon-finder")) return;

    const overlay = document.createElement("div");
    overlay.className = "command-palette-overlay canon-finder";
    const card = document.createElement("div");
    card.className = "command-palette-card";
    card.innerHTML = `
      <div class="command-palette-input-row">
        <span class="cp-caret">›</span>
        <input type="text" class="command-palette-input" placeholder="Search this repo's Canon…"
               autocomplete="off" spellcheck="false" aria-label="Search this repo's Canon" />
      </div>
      <div class="command-palette-list" role="listbox"></div>`;
    overlay.appendChild(card);

    const input = card.querySelector<HTMLInputElement>(".command-palette-input")!;
    const listEl = card.querySelector<HTMLElement>(".command-palette-list")!;
    let rows: { section: SectionKey; kind: string; name: string }[] = [];
    let shown: typeof rows = [];
    let active = 0;

    const close = (): void => { overlay.remove(); };
    const choose = (row: { section: SectionKey; name: string } | undefined): void => {
      if (!row) return;
      close();
      this.pendingFilter = row.name;
      this.showSection(row.section);
    };
    const render = (): void => {
      const q = input.value.trim().toLowerCase();
      shown = (q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows).slice(0, 40);
      active = 0;
      listEl.replaceChildren();
      if (shown.length === 0) {
        const none = document.createElement("div");
        none.className = "command-palette-empty";
        none.textContent = rows.length === 0 ? "Nothing in Canon yet" : "No matches";
        listEl.appendChild(none);
        return;
      }
      shown.forEach((r, i) => {
        const item = document.createElement("div");
        item.className = i === 0 ? "command-palette-item active" : "command-palette-item";
        item.setAttribute("role", "option");
        const main = document.createElement("span");
        main.className = "cp-main";
        const title = document.createElement("span");
        title.className = "cp-title";
        title.textContent = r.name;
        main.appendChild(title);
        const sub = document.createElement("span");
        sub.className = "cp-sub";
        sub.textContent = r.kind;
        item.append(main, sub);
        item.addEventListener("click", () => choose(r));
        listEl.appendChild(item);
      });
    };
    const move = (delta: number): void => {
      const items = listEl.querySelectorAll<HTMLElement>(".command-palette-item");
      if (!items.length) return;
      active = (active + delta + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle("active", i === active));
      items[active].scrollIntoView({ block: "nearest" });
    };

    input.addEventListener("input", render);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    // Own every key while open — Escape must close the finder, not the cockpit.
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Enter") { e.preventDefault(); choose(shown[active]); }
    }, true);

    document.body.appendChild(overlay);
    input.focus();
    void this.status(cwd)
      .then((s) => { rows = CanonCockpitView.finderRows(s); render(); })
      .catch(() => { rows = []; render(); });
  }

  /** Homologated empty state — every section renders the same icon + title +
   *  hint block (the rail's .rail-empty chrome) when it has nothing to show.
   *  `note()` stays for transient states (Loading… / errors / search-empty). */
  private emptyState(opts: {
    icon: string;
    title: string;
    hint: string;
    action?: { label: string; onClick: () => void };
    /** Secondary CTA — used where the hint says "crawl the repo" and the door
     *  to the miner would otherwise be in another section. */
    altAction?: { label: string; onClick: () => void };
  }): HTMLElement {
    const el = document.createElement("div");
    el.className = "rail-empty canon-cockpit-empty";
    el.innerHTML = opts.icon
      + `<div class="rail-empty-title">${opts.title}</div>`
      + `<div class="rail-empty-hint">${opts.hint}</div>`;
    if (opts.action || opts.altAction) {
      const actions = document.createElement("div");
      actions.className = "rail-empty-actions";
      for (const a of [opts.action, opts.altAction]) {
        if (!a) continue;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "rail-empty-btn";
        btn.textContent = a.label;
        btn.addEventListener("click", a.onClick);
        actions.appendChild(btn);
      }
      el.appendChild(actions);
    }
    return el;
  }

  /** The Context Miner, as an empty-state CTA. Five empty states tell you to
   *  crawl the repo; without this the only door is the Context section. */
  private crawlAction(): { label: string; onClick: () => void } | undefined {
    const crawl = this.opts.onNewContext;
    if (!crawl || !this.opts.groupRootDir) return undefined;
    return { label: "Crawl repo", onClick: () => crawl() };
  }

  /** Shared empty state for org-gated sections (Members, Registry). */
  private emptyNoOrg(hint: string): HTMLElement {
    return this.emptyState({
      icon: Icons.boxes({ size: 28 }),
      title: "No organization",
      hint,
      action: { label: "Open Org", onClick: () => this.showSection("org") },
    });
  }

  /** Shared empty state for repo-gated sections (Subagents, Commands, …). */
  private emptyNoRepo(hint: string): HTMLElement {
    return this.emptyState({
      icon: Icons.folderPlus({ size: 28 }),
      title: "No project folder",
      hint,
    });
  }

  /** An uppercase section-group label (e.g. "Switch organization"). */
  private groupLabel(text: string): HTMLElement {
    const l = document.createElement("div");
    l.className = "canon-cockpit-grouplabel";
    l.textContent = text;
    return l;
  }

  /** Map raw API errors to a readable line. The server returns plain-text
   *  bodies via invoke's rejection — sniff for the common cases the brief
   *  calls out, fall back to the raw message otherwise. */
  private friendlyError(e: unknown): string {
    const s = String(e);
    if (/forbidden|403/i.test(s)) return "Only owners can add members.";
    if (/not.?found|404/i.test(s)) return "No Covenant user with that login.";
    return s;
  }

  /** Upload-to-registry icon button for a single-file unit row, or null
   *  when no org is active (nothing to publish into). Shared by the
   *  Subagents/Commands/MCP/Context sections. */
  private unitPublishAction(cwd: string, kind: CanonPkgKind, name: string): HTMLButtonElement | null {
    const active = this.activeOrg();
    if (!active) return null;
    const pub = iconButton(Icons.upload({ size: 15 }), "Publish to registry", () => {
      pub.disabled = true;
      void canonPublish(cwd, active.slug, name, kind)
        .then(() => { pushInfoToast({ message: `Published ${name} to ${active.slug}` }); pub.disabled = false; })
        .catch((e) => {
          const msg = this.friendlyError(e);
          pushInfoToast({ message: msg.includes("already published") || msg.includes("Conflict")
            ? `${name} is already published (unchanged)` : `Publish failed: ${msg}` });
          pub.disabled = false;
        });
    });
    return pub;
  }

  /** Adopt a detected item into Canon, then refresh the section. */
  private unitAdoptAction(cwd: string, kind: CanonPkgKind, name: string): HTMLButtonElement {
    const btn = iconButton(Icons.download({ size: 15 }), "Adopt into Canon", () => {
      btn.disabled = true;
      void canonAdopt(cwd, kind, name)
        .then(() => { this.invalidateStatus(); this.showSection(this.current); })
        .catch((e) => {
          btn.disabled = false;
          pushInfoToast({ message: `Adopt failed: ${this.friendlyError(e)}` });
        });
    });
    return btn;
  }

  /** Open a unit's source in the workspace editor — the row's answer to the
   *  most common move after reading a preview. Resolves the path backend-side
   *  so a detected unit opens where it actually sits. */
  private unitOpenAction(cwd: string, kind: Parameters<typeof canonUnitPath>[1], name: string): HTMLButtonElement | null {
    if (!this.opts.onOpenFile) return null;
    const btn = iconButton(Icons.pencil({ size: 15 }), "Open in editor", () => {
      btn.disabled = true;
      void canonUnitPath(cwd, kind, name)
        .then((path) => { this.close(); this.opts.onOpenFile?.(path); })
        .catch((e) => {
          btn.disabled = false;
          pushInfoToast({ message: `Couldn't open ${name}: ${this.friendlyError(e)}` });
        });
    });
    return btn;
  }

  /** Delete an adopted unit. Detected rows don't get one — a foreign file
   *  Canon merely noticed is not Canon's to remove (the backend agrees). */
  private unitDeleteAction(cwd: string, kind: Parameters<typeof canonDeleteUnit>[1], name: string): HTMLButtonElement {
    const btn = iconButton(Icons.trash({ size: 15 }), "Delete", () => {
      openConfirmPrompt({
        label: "Delete unit",
        message: `Delete "${name}"? Removes it from this repo and every executor projection.`,
        confirmText: "Delete",
        onConfirm: () => {
          btn.disabled = true;
          void canonDeleteUnit(cwd, kind, name)
            .then(() => { this.invalidateStatus(); this.showSection(this.current); })
            .catch((e) => {
              btn.disabled = false;
              pushInfoToast({ message: `Delete failed: ${this.friendlyError(e)}` });
            });
        },
      });
    });
    return btn;
  }

  /** Uninstall an installed skill, behind the confirm card. Shared by the
   *  Skills list and Loop's dead-weight list — the row that reports a skill
   *  isn't earning its keep is the right place to remove it. */
  private skillUninstallAction(cwd: string, name: string, onDone: () => void, labeled = false): HTMLButtonElement {
    let btn: HTMLButtonElement;
    const confirm = (): void => {
      openConfirmPrompt({
        label: "Uninstall skill",
        message: `Uninstall "${name}"? Removes it from this repo and every executor projection.`,
        confirmText: "Uninstall",
        onConfirm: () => {
          btn.disabled = true;
          void canonUninstallSkill(cwd, name)
            .then(() => { this.invalidateStatus(); onDone(); })
            .catch((e) => {
              btn.disabled = false;
              pushInfoToast({ message: `Uninstall failed: ${this.friendlyError(e)}` });
            });
        },
      });
    };
    if (labeled) {
      // Loop's dead-weight list is a decision queue: the resolving action is a
      // visible labelled button, not a hover-revealed icon.
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "canon-unused-action";
      btn.textContent = "Uninstall";
      btn.setAttribute("aria-label", "Uninstall skill");
      btn.addEventListener("click", confirm);
    } else {
      btn = iconButton(Icons.trash({ size: 15 }), "Uninstall skill", confirm);
    }
    return btn;
  }

  /** Authoring gate. Inside an organization only owners inscribe new units;
   *  with no active org (or an org list we never managed to fetch) this is
   *  just your own repo, so authoring stays open. A surface gate, not a
   *  security boundary — the file is writable outside the app regardless. */
  private canCreate(): boolean {
    const active = this.activeOrg();
    return !active || active.role === "owner";
  }

  /** The inline "name it and go" bar behind a section's New action: writes the
   *  scaffold, closes the cockpit, and opens the file in the editor. Shares the
   *  `.canon-import-bar` chrome with the skills.sh import row. */
  private newUnitBar(
    cwd: string,
    kind: CanonNewKind,
    headBtn: HTMLElement | undefined,
    onCreated: () => void,
  ): { element: HTMLElement; reveal: () => void } {
    const bar = document.createElement("form");
    bar.className = "canon-import-bar";
    bar.hidden = true;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "canon-import-input";
    input.placeholder = `New ${kind} name`;
    input.setAttribute("aria-label", `New ${kind} name`);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "canon-import-btn";
    submit.textContent = "Create";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "canon-import-close canon-icon-btn";
    dismiss.innerHTML = Icons.x({ size: 15 });
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.addEventListener("click", () => { bar.hidden = true; });
    bar.append(input, submit, dismiss);

    const reveal = (): void => { bar.hidden = false; input.focus(); };
    headBtn?.addEventListener("click", () => {
      bar.hidden = !bar.hidden;
      if (!bar.hidden) input.focus();
    });

    bar.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      submit.disabled = true;
      input.disabled = true;
      void canonNewUnit(cwd, kind, name)
        .then((path) => {
          const org = this.activeOrg();
          pushInfoToast({
            message: org
              ? `Created ${name} — publish it to ${org.slug} when it's ready`
              : `Created ${name}`,
          });
          input.value = "";
          bar.hidden = true;
          this.invalidateStatus();
          onCreated();
          if (this.opts.onOpenFile) {
            this.close();
            this.opts.onOpenFile(path);
          }
        })
        .catch((err) => pushInfoToast({ message: `Create failed: ${this.friendlyError(err)}` }))
        .finally(() => { submit.disabled = false; input.disabled = false; });
    });

    return { element: bar, reveal };
  }

  // ── Overview section ─────────────────────────────────────────────────

  /** The landing screen: what this repo carries, and the two things that
   *  actually need a decision — org defaults it's missing, and installed
   *  context nothing uses. Everything here is composed from data the other
   *  sections already fetch; it adds no backend call of its own beyond the
   *  usage numbers Loop also reads. */
  private renderOverviewSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-overview";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.emptyNoRepo("Point this group at a repo from the rail to see what its Canon carries."));
      return el;
    }

    // Projection first: Canon's whole claim is one source projected into every
    // executor, and until now the UI never said where anything landed.
    const projection = document.createElement("div");
    projection.className = "canon-projection";
    el.appendChild(projection);
    void canonProjectionStatus(cwd)
      .then((proj) => this.renderProjectionStrip(cwd, projection, proj))
      .catch(() => { projection.remove(); });

    // Attention next — a landing screen that opens with an inventory buries
    // the lines that ask for a decision.
    const attention = document.createElement("div");
    const inventory = document.createElement("div");
    inventory.className = "canon-cockpit-list canon-cockpit-inventory";
    inventory.appendChild(this.note("Loading…"));
    el.append(attention, this.groupLabel("Inventory"), inventory);

    void this.status(cwd)
      .then((status) => {
        inventory.replaceChildren();
        for (const row of inventoryRows(status)) {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "canon-cockpit-listitem";
          const name = document.createElement("span");
          name.className = "canon-cockpit-listitem-name";
          name.textContent = row.label;
          const count = document.createElement("span");
          count.className = "canon-cockpit-listitem-meta";
          count.textContent = String(row.count);
          item.append(name, count);
          item.addEventListener("click", () => this.showSection(row.section));
          inventory.appendChild(item);
        }
      })
      .catch((e) => {
        inventory.replaceChildren();
        inventory.appendChild(this.note(`Failed to read this repo: ${this.friendlyError(e)}`));
      });

    void this.renderAttention(cwd, attention);
    return el;
  }

  /** Where this repo's Canon actually lands: one chip per executor, its state,
   *  and when the sources were last edited. Re-project is right there when
   *  something drifted — a managed block someone hand-edited is the one
   *  failure mode that silently un-does the whole distribution story. */
  private renderProjectionStrip(cwd: string, host: HTMLElement, proj: ProjectionStatus): void {
    host.replaceChildren();
    if (proj.executors.length === 0) {
      host.remove();
      return;
    }
    const label = document.createElement("span");
    label.className = "canon-projection-label";
    label.textContent = "Projected to";
    host.appendChild(label);

    for (const ex of proj.executors) {
      const chip = document.createElement("span");
      chip.className = `canon-projection-chip is-${ex.state}`;
      chip.textContent = ex.tool;
      attachTooltip(chip, ex.state === "synced" ? "In sync with the Canon source"
        : ex.state === "stale" ? "Projected block is older than the source — re-project"
        : "Never projected here");
      host.appendChild(chip);
    }

    if (proj.source_edited_unix != null) {
      const edited = document.createElement("span");
      edited.className = "canon-projection-edited";
      edited.textContent = `sources edited ${relTime(proj.source_edited_unix)}`;
      host.appendChild(edited);
    }

    if (proj.executors.some((e) => e.state === "stale")) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "canon-cockpit-listitem-action";
      btn.textContent = "Re-project";
      btn.addEventListener("click", () => {
        btn.disabled = true;
        void canonExport(cwd)
          .then(() => canonProjectionStatus(cwd))
          .then((fresh) => {
            pushInfoToast({ message: "Re-projected into every executor" });
            this.renderProjectionStrip(cwd, host, fresh);
          })
          .catch((e) => {
            btn.disabled = false;
            pushInfoToast({ message: `Re-project failed: ${this.friendlyError(e)}` });
          });
      });
      host.appendChild(btn);
    }
  }

  /** The Overview's attention block: org-default drift and dead weight, each
   *  a single sentence with the action that resolves it. Renders nothing when
   *  there's nothing to decide — an empty "all good" box is noise. */
  private async renderAttention(cwd: string, host: HTMLElement): Promise<void> {
    const active = this.activeOrg();
    const [status, usage, defaults] = await Promise.all([
      this.status(cwd).catch(() => null),
      scoreSkillUsage(this.opts.groupLabel ?? null).catch(() => []),
      active ? canonOrgDefaults(active.slug).catch(() => []) : Promise.resolve([]),
    ]);
    if (!status) return;

    const rows: HTMLElement[] = [];

    // Org defaults this repo is missing — the owner's "every repo should have
    // this", checked where it's actually felt instead of only in Organization.
    if (active && defaults.length > 0) {
      const installed = await Promise.all(
        defaults.map((d) => canonUnitInstalled(cwd, d.kind, d.name).catch(() => false)),
      );
      const missing = defaults.filter((_, i) => !installed[i]);
      if (missing.length > 0) {
        const install = document.createElement("button");
        install.type = "button";
        install.className = "canon-cockpit-listitem-action";
        install.textContent = "Install all";
        install.addEventListener("click", () => {
          install.disabled = true;
          install.textContent = "Installing…";
          void Promise.all(missing.map((d) => (d.kind === "skill"
            ? canonInstallRegistry(cwd, active.slug, d.name, "latest", this.opts.groupLabel, null).then(() => undefined)
            : canonInstallRegistryUnit(cwd, active.slug, d.name, "latest", d.kind))
            .catch((e) => { pushInfoToast({ message: `${d.name}: ${this.friendlyError(e)}` }); })))
            .then(() => { this.invalidateStatus(); this.showSection("overview"); });
        });
        rows.push(this.attentionRow(
          `${missing.length} of ${defaults.length} org defaults missing here`,
          missing.map((d) => d.name).join(" · "),
          install,
        ));
      }
    }

    // Dead weight — installed, projected into every prompt, never used.
    const unused = unusedUnits(status.installed, usage);
    if (unused.length > 0) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "canon-cockpit-listitem-action";
      open.textContent = "Review";
      open.addEventListener("click", () => this.showSection("loop"));
      rows.push(this.attentionRow(
        unused.length === 1
          ? "1 installed skill has never been used"
          : `${unused.length} installed skills have never been used`,
        unused.join(" · "),
        open,
      ));
    }

    if (rows.length === 0) return;
    host.appendChild(this.groupLabel("Needs attention"));
    const list = document.createElement("div");
    list.className = "canon-cockpit-list";
    list.append(...rows);
    host.appendChild(list);
  }

  /** One attention line: a headline, the names behind it, and its action. */
  private attentionRow(headline: string, detail: string, action: HTMLElement): HTMLElement {
    const row = document.createElement("div");
    row.className = "canon-cockpit-listitem is-attention";
    const text = document.createElement("span");
    text.className = "canon-cockpit-listitem-name";
    text.textContent = headline;
    const sub = document.createElement("span");
    sub.className = "canon-cockpit-listitem-meta";
    sub.textContent = detail;
    row.append(text, sub, action);
    return row;
  }

  // ── Org section ──────────────────────────────────────────────────────

  /** A sharp identity monogram tile (shares the .canon-mono styling with the
   *  rail chip/menu). `size` in px drives --mono-size. */
  private monogram(org: Org, size: number): HTMLElement {
    const m = document.createElement("span");
    m.className = "canon-mono";
    m.textContent = orgInitials(org.name);
    m.style.setProperty("--mono-h", String(orgHue(org.slug)));
    m.style.setProperty("--mono-size", `${size}px`);
    return m;
  }

  private renderOrgSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-org";
    const active = this.activeOrg();

    // Identity card — the active org as a proper subject, not a bare title.
    if (active) {
      const card = document.createElement("div");
      card.className = "canon-cockpit-idcard";
      const text = document.createElement("div");
      text.className = "canon-cockpit-idcard-text";
      const name = document.createElement("div");
      name.className = "canon-cockpit-idcard-name";
      name.textContent = active.name;
      const meta = document.createElement("div");
      meta.className = "canon-cockpit-idcard-meta";
      const slug = document.createElement("span");
      slug.className = "canon-cockpit-idcard-slug";
      slug.textContent = `registry / ${active.slug}`;
      const badge = document.createElement("span");
      badge.className = "canon-cockpit-badge";
      badge.classList.toggle("is-owner", active.role === "owner");
      badge.textContent = active.role;
      meta.append(slug, badge);
      text.append(name, meta);
      card.append(this.monogram(active, 48), text);
      // Owner-only display-name rename — same immersive surface as create.
      if (active.role === "owner") {
        const edit = iconButton(Icons.pencil({ size: 14 }), "Rename organization", () => {
          openCreateOrgExperience({
            rename: { slug: active.slug, name: active.name },
            onCreated: () => this.refreshOrgs(active.slug),
          });
        });
        edit.classList.add("canon-cockpit-idcard-edit");
        const del = iconButton(Icons.trash({ size: 14 }), "Delete organization", () => {
          openConfirmTyped({
            label: "Delete organization",
            message: `This permanently deletes "${active.name}" and every skill, agent, command and package published under its registry namespace. Can't be undone.`,
            expected: active.name,
            confirmText: "Delete organization",
            onConfirm: () => {
              void canonDeleteOrg(active.slug)
                .then(() => {
                  const remaining = this.opts.orgs.filter((o) => o.slug !== active.slug);
                  this.opts.orgs = remaining;
                  this.opts.setActiveOrg(remaining[0]?.slug ?? null);
                  this.showSection("org");
                })
                .catch((e) => pushInfoToast({ message: `Couldn't delete organization: ${this.friendlyError(e)}` }));
            },
          });
        });
        del.classList.add("canon-cockpit-idcard-edit");
        card.append(edit, del);
      }
      el.appendChild(card);
    } else {
      el.appendChild(this.emptyState({
        icon: Icons.boxes({ size: 28 }),
        title: "No organization selected",
        hint: this.opts.orgs.length > 0
          ? "Pick an organization below to load its Canon."
          : "Create an organization to publish and install skills across your team.",
        action: this.opts.orgs.length === 0
          ? { label: "Create organization", onClick: () => openCreateOrgExperience({ onCreated: (slug) => this.refreshOrgs(slug) }) }
          : undefined,
      }));
    }

    // Switch organization — a labeled list of every org the caller belongs to.
    if (this.opts.orgs.length > 0) {
      if (active) el.appendChild(this.renderOrgDefaultsBlock(active));
      el.appendChild(this.groupLabel("Switch organization"));
      const list = document.createElement("div");
      list.className = "canon-cockpit-list";
      for (const org of this.opts.orgs) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "canon-cockpit-listitem";
        const isActive = !!active && org.slug === active.slug;
        if (isActive) row.classList.add("is-active");
        const name = document.createElement("span");
        name.className = "canon-cockpit-listitem-name";
        name.textContent = org.name;
        const role = document.createElement("span");
        role.className = "canon-cockpit-listitem-meta";
        role.textContent = isActive ? "current" : org.role;
        row.append(this.monogram(org, 26), name, role);
        row.addEventListener("click", () => {
          this.opts.setActiveOrg(org.slug);
          this.showSection("org");
        });
        list.appendChild(row);
      }
      el.appendChild(list);
    }

    // The empty state above already carries the create action when the
    // caller belongs to no org — don't render the button twice.
    if (active || this.opts.orgs.length > 0) el.appendChild(this.renderCreateOrgRow());
    return el;
  }

  /** Org defaults — owner-curated packages every repo of the org should
   *  have, diffed against the current repo. Install stays an explicit click
   *  (MCP configs project into `.mcp.json` that executors run). */
  private renderOrgDefaultsBlock(active: Org): HTMLElement {
    const wrap = document.createElement("div");
    wrap.appendChild(this.groupLabel("Org defaults"));
    const list = document.createElement("div");
    list.className = "canon-cockpit-list";
    list.appendChild(this.note("Loading…"));
    wrap.appendChild(list);
    const cwd = this.opts.groupRootDir;
    void canonOrgDefaults(active.slug)
      .then(async (defs) => {
        list.replaceChildren();
        if (defs.length === 0) {
          list.appendChild(this.note(active.role === "owner"
            ? "No defaults yet — pin packages from the Registry to suggest them in every repo."
            : "No defaults defined for this org."));
          return;
        }
        const installed = cwd
          ? await Promise.all(defs.map((d) => canonUnitInstalled(cwd, d.kind, d.name).catch(() => false)))
          : defs.map(() => false);
        defs.forEach((d, i) => {
          const row = document.createElement("div");
          row.className = "canon-cockpit-listitem";
          const name = document.createElement("span");
          name.className = "canon-cockpit-listitem-name";
          name.textContent = d.name;
          const meta = document.createElement("span");
          meta.className = "canon-cockpit-listitem-meta";
          meta.textContent = d.kind;
          row.append(name, meta);
          if (cwd) {
            if (installed[i]) {
              const ok = document.createElement("span");
              ok.className = "canon-cockpit-listitem-meta canon-default-ok";
              ok.innerHTML = Icons.check({ size: 13 });
              attachTooltip(ok, "Installed in this repo");
              row.appendChild(ok);
            } else {
              const inst = iconButton(Icons.download({ size: 14 }), "Install into this repo", () => {
                inst.disabled = true;
                const install = d.kind === "skill"
                  ? canonInstallRegistry(cwd, active.slug, d.name, "latest", this.opts.groupLabel, null).then(() => undefined)
                  : canonInstallRegistryUnit(cwd, active.slug, d.name, "latest", d.kind);
                void install
                  .then(() => { this.invalidateStatus(); inst.innerHTML = Icons.check({ size: 14 }); })
                  .catch((e) => {
                    inst.disabled = false;
                    pushInfoToast({ message: `Install failed: ${this.friendlyError(e)}` });
                  });
              });
              row.appendChild(inst);
            }
          }
          list.appendChild(row);
        });
      })
      .catch(() => {
        list.replaceChildren();
        list.appendChild(this.note("Org defaults unavailable (offline)."));
      });
    return wrap;
  }

  /** Refetch orgs so the just-created/renamed org is in the snapshot before
   *  switching (activeOrg() resolves against opts.orgs). */
  private refreshOrgs(slug: string): void {
    void canonMyOrgs().then((fresh) => {
      this.opts.orgs = fresh;
      this.opts.orgsFetched = true;
      this.opts.setActiveOrg(slug);
      this.showSection("org");
    });
  }

  private renderCreateOrgRow(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "canon-cockpit-org-create";
    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "canon-cockpit-create-btn";
    createBtn.textContent = "Create organization";
    createBtn.addEventListener("click", () => {
      openCreateOrgExperience({ onCreated: (slug) => this.refreshOrgs(slug) });
    });
    wrap.appendChild(createBtn);
    return wrap;
  }

  // ── Members section ──────────────────────────────────────────────────

  private renderMembersSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-members";
    const active = this.activeOrg();
    if (!active) {
      el.appendChild(this.emptyNoOrg("Members are people with access to an organization's Canon — pick or create one first."));
      return el;
    }

    const isOwner = active.role === "owner";
    const orgSlug = active.slug;

    const list = document.createElement("div");
    list.className = "canon-cockpit-members-list";
    list.appendChild(this.note("Loading…"));

    const errorEl = document.createElement("p");
    errorEl.className = "canon-cockpit-error";
    errorEl.hidden = true;

    // Score sign-in shares the GitHub identity — used only for the "you"
    // badge, so a null (signed out) simply shows no badge.
    const me: Promise<string | null> = scoreCurrentUser()
      .then((u) => u?.login ?? null)
      .catch(() => null);

    const load = (): void => {
      void Promise.all([canonOrgMembers(orgSlug), me])
        .then(([members, myLogin]) => {
          if (this.current !== "members") return;
          list.replaceChildren();
          this.stampMemberCount(members.length);
          if (members.length === 0) {
            list.appendChild(this.emptyState({
              icon: Icons.github({ size: 28 }),
              title: "No members yet",
              hint: isOwner
                ? "Add teammates by their GitHub login to share this organization's Canon."
                : "The organization owner can add teammates by GitHub login.",
            }));
            return;
          }
          for (const m of members) {
            list.appendChild(this.renderMemberRow(m, orgSlug, isOwner, load, errorEl, myLogin));
          }
        })
        .catch((e) => {
          list.replaceChildren();
          list.appendChild(this.note(`Failed to load members: ${this.friendlyError(e)}`));
        });
    };

    if (isOwner) {
      el.appendChild(this.renderAddMemberRow(orgSlug, load, errorEl));
    }
    el.append(list, errorEl);
    load();
    return el;
  }

  /** "N people" count appended to the sticky section title after the roster
   *  loads. Idempotent — reload() replaces any previous stamp. */
  private stampMemberCount(n: number): void {
    const title = this.content.querySelector(".canon-cockpit-sec-title");
    if (!title) return;
    title.querySelector(".canon-cockpit-sec-count")?.remove();
    const c = document.createElement("span");
    c.className = "canon-cockpit-sec-count";
    c.textContent = n === 1 ? "1 person" : `${n} people`;
    title.appendChild(c);
  }

  /** GitHub avatar via the public `github.com/<login>.png` redirect — no API,
   *  no token, no rate limit. Falls back to a deterministic initial dot
   *  (hue hashed from the login) when the image can't load. */
  private memberAvatar(login: string, isOwner: boolean): HTMLElement {
    const img = document.createElement("img");
    img.className = "canon-cockpit-member-avatar" + (isOwner ? " is-owner" : "");
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      const dot = document.createElement("span");
      dot.className = img.className + " is-fallback";
      dot.style.background = `hsl(${orgHue(login)} 32% 34%)`;
      dot.textContent = (login[0] ?? "?").toUpperCase();
      img.replaceWith(dot);
    }, { once: true });
    img.src = `https://github.com/${encodeURIComponent(login)}.png?size=56`;
    return img;
  }

  private renderMemberRow(
    m: Member,
    orgSlug: string,
    isOwner: boolean,
    reload: () => void,
    errorEl: HTMLElement,
    myLogin: string | null,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "canon-cockpit-member-row";

    const id = document.createElement("div");
    id.className = "canon-cockpit-member-id";
    const login = document.createElement("span");
    login.className = "canon-cockpit-member-login";
    login.textContent = m.login;
    id.appendChild(login);
    if (myLogin && m.login.toLowerCase() === myLogin.toLowerCase()) {
      const you = document.createElement("span");
      you.className = "canon-cockpit-member-you";
      you.textContent = "you";
      id.appendChild(you);
    }

    const role = document.createElement("span");
    role.className = `canon-cockpit-member-role ${m.role === "owner" ? "is-owner" : "is-member"}`;
    role.textContent = m.role;
    row.append(this.memberAvatar(m.login, m.role === "owner"), id, role);

    if (isOwner && m.role !== "owner") {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "canon-cockpit-member-remove";
      rm.textContent = "Remove";
      attachTooltip(rm, `Remove ${m.login}`);
      rm.addEventListener("click", () => {
        errorEl.hidden = true;
        rm.disabled = true;
        void canonRemoveMember(orgSlug, m.login)
          .then(reload)
          .catch((e) => {
            errorEl.hidden = false;
            errorEl.textContent = this.friendlyError(e);
            rm.disabled = false;
          });
      });
      row.appendChild(rm);
    }
    return row;
  }

  private renderAddMemberRow(orgSlug: string, reload: () => void, errorEl: HTMLElement): HTMLElement {
    const row = document.createElement("div");
    row.className = "canon-cockpit-add-member";

    const field = document.createElement("div");
    field.className = "canon-cockpit-add-field";
    const at = document.createElement("span");
    at.className = "canon-cockpit-add-at";
    at.textContent = "@";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "github login";

    // Live preview: the same public avatar redirect used by the rows doubles
    // as an existence check — onload = found, onerror = not found. Purely
    // informational; it never gates the submit (offline must still work).
    const preview = document.createElement("span");
    preview.className = "canon-cockpit-add-preview";
    let previewTimer: number | undefined;
    input.addEventListener("input", () => {
      window.clearTimeout(previewTimer);
      preview.replaceChildren();
      preview.classList.remove("is-missing");
      const login = input.value.trim();
      if (!login) return;
      previewTimer = window.setTimeout(() => {
        const img = new Image();
        img.className = "canon-cockpit-add-preview-avatar";
        img.referrerPolicy = "no-referrer";
        const done = (found: boolean): void => {
          if (input.value.trim() !== login) return; // stale response
          preview.classList.toggle("is-missing", !found);
          const label = document.createElement("span");
          label.textContent = found ? "found" : "not found";
          preview.replaceChildren(...(found ? [img, label] : [label]));
        };
        img.onload = () => done(true);
        img.onerror = () => done(false);
        img.src = `https://github.com/${encodeURIComponent(login)}.png?size=36`;
      }, 400);
    });
    field.append(at, input, preview);

    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Add";

    const submit = (): void => {
      const login = input.value.trim();
      if (!login) return;
      errorEl.hidden = true;
      add.disabled = true;
      void canonAddMember(orgSlug, login)
        .then(() => {
          input.value = "";
          preview.replaceChildren();
          preview.classList.remove("is-missing");
          reload();
        })
        .catch((e) => {
          errorEl.hidden = false;
          errorEl.textContent = this.friendlyError(e);
        })
        .finally(() => { add.disabled = false; });
    };
    add.addEventListener("click", submit);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

    row.append(field, add);
    return row;
  }

  // ── Operators section ────────────────────────────────────────────────

  /** Org-scoped operator roster — the immersive creator (`../../operator/creator`)
   *  reused verbatim from the settings pane, wired so saves assign/clear the
   *  active org instead of leaving the operator on whatever org it had. */
  private renderOperatorsSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-operators";

    const list = document.createElement("div");
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    // Sync the roster from the server; if anything landed, re-render so the
    // pulled operators appear without leaving the section.
    void pullOrgOperators(this.activeOrg()?.slug).then((changed) => {
      if (changed && this.current === "operators") this.showSection("operators");
    });

    void operatorList()
      .then((all) => {
        const known: Set<string> | null = this.opts.orgsFetched
          ? new Set(this.opts.orgs.map((o) => o.slug))
          : null;
        const active = this.activeOrg();
        const ops = operatorsForOrg(all, active, known);
        // Server writes are owner-gated: members see the org roster
        // read-only and can only duplicate into their personal roster.
        const canManage = this.canCreate();
        list.replaceChildren();
        if (ops.length === 0) {
          list.appendChild(this.emptyState({
            icon: Icons.headphones({ size: 28 }),
            title: "No operators in this org",
            hint: "Operators are versions of you — org-scoped personas that direct your executors.",
            action: canManage ? { label: "New operator", onClick: () => this.openNewOperator() } : undefined,
          }));
          return;
        }
        list.appendChild(renderOperatorList(ops, {
          isStale: (op) => isStaleOrg(op, known),
          onEdit: canManage ? (op) => {
            const handle = openOperatorModal({ mode: "edit", existing: op });
            wireOperatorModal(handle, {
              // Rescue stale-org operators: saving from the personal view
              // clears the dead slug back to the personal roster.
              assignOrgSlug: isStaleOrg(op, known) ? null : undefined,
              onSaved: () => this.showSection("operators"),
              onDelete: (o) => this.deleteOperator(o),
            });
          } : undefined,
          onDuplicate: (op) => {
            const handle = openOperatorModal({ mode: "create", existing: { ...op, name: `${op.name} copy` } });
            wireOperatorModal(handle, {
              // Members duplicate into their personal roster; owners into the org.
              assignOrgSlug: canManage && active && !active.personal ? active.slug : null,
              onSaved: () => this.showSection("operators"),
            });
          },
          onDelete: canManage ? (op) => this.deleteOperator(op) : undefined,
        }));
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load operators: ${this.friendlyError(e)}`));
      });

    return el;
  }

  /** Open the immersive operator creator scoped to the active org — shared
   *  by the actions-bar button and the empty state's CTA. */
  private openNewOperator(): void {
    const active = this.activeOrg();
    const handle = openOperatorModal({ mode: "create" });
    wireOperatorModal(handle, {
      assignOrgSlug: active && !active.personal ? active.slug : null,
      onSaved: () => this.showSection("operators"),
    });
  }

  /** Ported from `OperatorsPane.deleteOperator` (settings/operators.ts) so the
   *  cockpit's roster enforces the same guards: can't delete the default
   *  operator, can't delete the last operator system-wide. */
  private async deleteOperator(op: Operator): Promise<void> {
    if (op.is_default) {
      pushInfoToast({ message: "Cannot delete the default operator — set a different default first." });
      return;
    }
    const all = await operatorList().catch(() => [] as Operator[]);
    if (all.length <= 1) {
      pushInfoToast({ message: "Cannot delete the last operator." });
      return;
    }
    openConfirmPrompt({
      label: "Delete operator",
      message: `Delete "${op.name}"? Tabs pinned to it will fall back to the default.`,
      confirmText: "Delete",
      onConfirm: () => {
        void operatorDelete(op.id)
          .then(() => {
            // Notify the rest of the app — tabs/manager.ts drops the cache entry
            // and clears any pane.operator pointer; the status bar re-renders
            // without the dangling avatar.
            window.dispatchEvent(new CustomEvent("operator:deleted", { detail: { id: op.id } }));
            pushInfoToast({ message: `Deleted operator: ${op.name}` });
            this.showSection("operators");
          })
          .catch((e) => pushInfoToast({ message: `Delete failed: ${this.friendlyError(e)}` }));
      },
    });
  }

  // ── Unit sections — Subagents / Commands / MCP / Memory ──────────────

  /** One renderer for every kind in `UNIT_SPECS` — what used to be four copies
   *  of this function differing only in glyph, copy and which list it read. */
  private renderUnitSection(key: SectionKey, spec: UnitSpec, headBtn?: HTMLElement): HTMLElement {
    const el = document.createElement("div");
    el.className = `canon-cockpit-section is-${key}`;
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.emptyNoRepo(spec.noRepoHint));
      return el;
    }

    const list = document.createElement("div");
    list.className = `canon-cockpit-${key}-list`;
    list.appendChild(this.note("Loading…"));
    const toolbar = this.filterToolbar(list, `Filter ${spec.plural}…`);
    const create = this.newUnitBar(cwd, spec.kind, headBtn, () => this.showSection(key));
    el.append(create.element, toolbar.element, list);

    void Promise.all([
      this.status(cwd),
      spec.evaluable ? canonEvalSummary(cwd).catch(() => []) : Promise.resolve([]),
    ])
      .then(([status, evals]) => {
        const sums = new Map(evals.map((e) => [`${e.kind}/${e.name}`, e]));
        const units = spec.list(status);
        list.replaceChildren();
        if (units.length === 0) {
          list.appendChild(this.emptyState({
            icon: spec.icon(28),
            title: spec.emptyTitle,
            hint: spec.emptyHint,
            action: this.canCreate() ? { label: `New ${spec.noun}`, onClick: create.reveal } : undefined,
            altAction: spec.crawlable ? this.crawlAction() : undefined,
          }));
          return;
        }
        // No registry kind (memory) means neither publish nor adopt applies.
        const pkg = spec.pkg;
        for (const u of units) {
          const detected = !!u.detectedIn;
          // Open · Publish (Adopt while detected) · Delete — the same row
          // verbs everywhere, minus what a kind or a role can't do.
          const actions: HTMLButtonElement[] = [];
          const open = this.unitOpenAction(cwd, spec.kind, u.name);
          if (open) actions.push(open);
          if (pkg && detected) actions.push(this.unitAdoptAction(cwd, pkg, u.name));
          else if (pkg) {
            const publish = this.unitPublishAction(cwd, pkg, u.name);
            if (publish) actions.push(publish);
          }
          if (spec.evaluable && !detected) {
            const draftBtn = iconButton(Icons.sparkles({ size: 15 }), "Draft evals", () => {
              draftEvals(cwd, spec.kind, u.name, draftBtn, () => {});
            });
            actions.push(draftBtn);
            const manageBtn = iconButton(Icons.checklist({ size: 15 }), "Manage evals", () => {
              void openEvalManager(cwd, spec.kind, u.name, () => {
                this.invalidateStatus();
                this.showSection(key);
              });
            });
            actions.push(manageBtn);
            const runBtn = iconButton(Icons.play({ size: 15 }), "Run evals", () => {
              runEvals(cwd, spec.kind, u.name, runBtn, () => {
                this.invalidateStatus();
                this.showSection(key);
              });
            });
            actions.push(runBtn);
          }
          if (!detected && this.canCreate()) actions.push(this.unitDeleteAction(cwd, spec.kind, u.name));
          const evalBit = spec.evaluable && !detected
            ? evalCountLabel(sums.get(`${spec.kind}/${u.name}`))
            : "";
          list.appendChild(skillCard({
            name: u.name,
            meta: detected
              ? `detected · ${u.detectedIn}`
              : [u.description ?? u.transport ?? "", evalBit].filter(Boolean).join(" · "),
            className: detected ? "canon-skill-row is-detected" : "canon-skill-row",
            leadIcon: spec.icon(15),
            fetchPreview: () => canonReadSource(cwd, spec.kind, u.name),
            // An MCP config has no prose to render as markdown — expand opens
            // the tool explorer instead.
            onExpand: spec.kind === "mcp"
              ? () => openMcpReader(u.name, () => canonReadSource(cwd, "mcp", u.name))
              : undefined,
            actions,
          }));
        }
        toolbar.reveal();
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load ${spec.plural}: ${this.friendlyError(e)}`));
      });

    return el;
  }


  // ── Specs section ────────────────────────────────────────────────────

  private renderSpecSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-spec";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.emptyNoRepo("Point this group at a repo from the rail to see its specs."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-spec-list";
    list.appendChild(this.note("Loading…"));
    const toolbar = this.filterToolbar(list, "Filter specs…");
    el.append(toolbar.element, list);

    void this.status(cwd)
      .then((status) => {
        list.replaceChildren();
        if (status.specs.length === 0) {
          list.appendChild(this.emptyState({
            icon: Icons.fileText({ size: 28 }),
            title: "No specs published",
            hint: "Specs published to docs/specs anchor tasks for your executors.",
            action: this.opts.onNewSpec && this.canCreate()
              ? { label: "New spec", onClick: () => { this.close(); this.opts.onNewSpec?.(cwd); } }
              : undefined,
          }));
          return;
        }
        for (const sp of sortSpecs(status.specs)) {
          const id = /^[\d.]+(?=-)/.exec(sp.name)?.[0] ?? "";
          const card = skillCard({
            // Numbered specs put the index in the shared leading slot; a
            // slug without a number falls back to a file glyph + its name.
            ...(id ? { idx: id } : { name: sp.name, leadIcon: Icons.fileText({ size: 15 }) }),
            // The title repeats the number the row already shows ("3.12 — Operators
            // Experience and Level") — drop the prefix and let the idx carry it.
            meta: sp.title.replace(/^[\d.]+\s+—\s+/, ""),
            className: "canon-skill-row canon-spec-row",
            fetchPreview: () => canonReadSource(cwd, "spec", sp.name),
            readerTitle: sp.name,
            actions: [],
          });
          // SpecScore badge (hover reveals the 7-dim breakdown) — same
          // component the doc viewer header uses.
          const badge = makeSpecScoreHoverBadge();
          card.querySelector(".canon-card-head")
            ?.insertBefore(badge.el, card.querySelector(".canon-preview-btn"));
          void canonReadSource(cwd, "spec", sp.name)
            .then((md) => badge.update(scoreSpec(md)))
            .catch(() => { /* unscored row is fine */ });
          list.appendChild(card);
        }
        toolbar.reveal();
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load specs: ${this.friendlyError(e)}`));
      });

    return el;
  }

  // ── Skills section ────────────────────────────────────────────────────

  private renderSkillsSection(addBtn?: HTMLElement): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-skills";
    const cwd = this.opts.groupRootDir;
    if (!cwd) {
      el.appendChild(this.emptyNoRepo("Point this group at a repo from the rail to manage skills."));
      return el;
    }

    const errorEl = document.createElement("p");
    errorEl.className = "canon-cockpit-error";
    errorEl.hidden = true;

    const list = document.createElement("div");
    list.className = "canon-cockpit-skills-list";
    list.appendChild(this.note("Loading…"));
    const toolbar = this.filterToolbar(list, "Filter skills…");

    // Import from skills.sh: paste "owner/repo --skill name", run npx, auto-adopt.
    // Hidden until the header "Add" button reveals it (dismiss with ✕).
    const importBar = document.createElement("form");
    importBar.className = "canon-import-bar";
    importBar.hidden = true;
    const importInput = document.createElement("input");
    importInput.type = "text";
    importInput.className = "canon-import-input";
    importInput.placeholder = "new-skill-name   ·   or   owner/repo --skill name";
    importInput.setAttribute("aria-label", "New skill name, or a skills.sh reference");
    const importBtn = document.createElement("button");
    importBtn.type = "submit";
    importBtn.className = "canon-import-btn";
    importBtn.textContent = "Import";
    const importClose = document.createElement("button");
    importClose.type = "button";
    importClose.className = "canon-import-close canon-icon-btn";
    importClose.innerHTML = Icons.x({ size: 15 });
    importClose.setAttribute("aria-label", "Dismiss");
    importClose.addEventListener("click", () => { importBar.hidden = true; });
    importBar.append(importInput, importBtn, importClose);
    addBtn?.addEventListener("click", () => {
      importBar.hidden = !importBar.hidden;
      if (!importBar.hidden) importInput.focus();
    });
    importBar.addEventListener("submit", (e) => {
      e.preventDefault();
      const ref = importInput.value.trim();
      if (!ref) return;
      importBtn.disabled = true;
      importInput.disabled = true;
      // ponytail: one input, two intents. A "/" means it's an owner/repo
      // reference for skills.sh; anything else is the name of a new skill.
      const run = ref.includes("/")
        ? canonImportSkill(cwd, ref).then((names) => {
            pushInfoToast({
              message: names.length ? `Imported: ${names.join(", ")}` : "Nothing new to import",
            });
            importInput.value = "";
            reload();
          })
        : canonNewUnit(cwd, "skill", ref).then((path) => {
            const org = this.activeOrg();
            pushInfoToast({
              message: org
                ? `Created ${ref} — publish it to ${org.slug} when it's ready`
                : `Created ${ref}`,
            });
            importInput.value = "";
            reload();
            if (this.opts.onOpenFile) {
              this.close();
              this.opts.onOpenFile(path);
            }
          });
      void run
        .catch((err) => pushInfoToast({ message: `Failed: ${this.friendlyError(err)}` }))
        .finally(() => {
          importBtn.disabled = false;
          importInput.disabled = false;
        });
    });

    /** Every write in this section changes the repo — drop the shared status
     *  before re-reading it, or the list redraws from a stale snapshot. */
    const reload = (): void => { this.invalidateStatus(); load(); };

    const load = (): void => {
      const org = this.activeOrg();
      void Promise.all([
        this.status(cwd),
        // What the org publishes, to tell "current" from "3 versions behind";
        // and the local eval results, so the verdict sits next to the unit it
        // judges instead of only in Loop. Both optional — a row still renders.
        org ? canonSearch(org.slug, null, "skill").catch(() => [] as PkgMeta[]) : Promise.resolve([] as PkgMeta[]),
        canonEvalSummary(cwd).catch(() => []),
      ])
        .then(([status, published, evals]) => {
          const latest = new Map(published.map((p) => [p.name, p.version]));
          // Keyed by kind/name, not name alone — this repo can carry a
          // command named "green" as well as a skill named "green"; a
          // name-only map would let one's lift render on the other's card.
          // Authored-but-never-run units (total 0) have no lift to show —
          // without the filter they'd render a bogus "run baseline" chip.
          const lifts = new Map(
            evals.filter((e) => e.total > 0).map((e) => [`${e.kind}/${e.name}`, liftRow(e)]),
          );
          const sums = new Map(evals.map((e) => [`${e.kind}/${e.name}`, e]));
          list.replaceChildren();
          if (status.installed.length === 0 && status.detectedSkills.length === 0) {
            list.appendChild(this.emptyState({
              icon: Icons.packageBox({ size: 28 }),
              title: "No skills installed",
              hint: "Install from your organization's registry, or crawl the repo for context — Canon detects and adopts what's already in the repo.",
              // Installing what the org already published beats authoring from
              // scratch as the first move here; the header's Add action is the
              // door to a new skill.
              action: { label: "Browse registry", onClick: () => this.showSection("registry") },
              altAction: this.crawlAction(),
            }));
            return;
          }
          const active = this.activeOrg();
          for (const i of status.installed) {
            const actions: HTMLButtonElement[] = [];
            const open = this.unitOpenAction(cwd, "skill", i.name);
            if (open) actions.push(open);
            if (active && !i.source.startsWith("registry:")) {
              const pub = iconButton(Icons.upload({ size: 15 }), "Publish to registry", () => {
                errorEl.hidden = true;
                pub.disabled = true;
                void canonPublish(cwd, active.slug, i.name, "skill")
                  .then(reload)
                  .catch((e) => {
                    errorEl.hidden = false;
                    errorEl.textContent = this.friendlyError(e);
                    pub.disabled = false;
                  });
              });
              actions.push(pub);
            }
            const draftBtn = iconButton(Icons.sparkles({ size: 15 }), "Draft evals", () => {
              draftEvals(cwd, "skill", i.name, draftBtn, () => {});
            });
            actions.push(draftBtn);
            const manageBtn = iconButton(Icons.checklist({ size: 15 }), "Manage evals", () => {
              void openEvalManager(cwd, "skill", i.name, () => { this.invalidateStatus(); load(); });
            });
            actions.push(manageBtn);
            const runBtn = iconButton(Icons.play({ size: 15 }), "Run evals", () => {
              runEvals(cwd, "skill", i.name, runBtn, () => { this.invalidateStatus(); load(); });
            });
            actions.push(runBtn);
            actions.push(this.skillUninstallAction(cwd, i.name, reload));
            const currency = skillCurrency(i, latest.get(i.name), status.modifiedSkills ?? []);
            const lift = lifts.get(`skill/${i.name}`);
            const evalBit = evalCountLabel(sums.get(`skill/${i.name}`));
            const stats = [`v${i.version}`, i.source, evalBit];
            if (currency) stats.push(currency);
            if (lift) stats.push(`lift ${lift.label}`);
            list.appendChild(skillCard({
              name: i.name,
              meta: [currency, evalBit, lift ? `lift ${lift.label}` : "", `${i.version} · ${i.source}`]
                .filter(Boolean).join(" · "),
              // Local installs don't carry a description field — the empty
              // string opts into skillCard's SKILL.md frontmatter fallback,
              // matching the registry cards' always-visible description.
              description: "",
              className: "canon-skill-row",
              leadIcon: Icons.packageBox({ size: 15 }),
              fetchPreview: () => canonReadLocal(cwd, i.name),
              actions,
              stats,
            }));
          }
          for (const d of status.detectedSkills) {
            list.appendChild(skillCard({
              name: d.name,
              meta: `detected · ${d.detectedIn}`,
              description: "",
              className: "canon-skill-row is-detected",
              leadIcon: Icons.packageBox({ size: 15 }),
              // Not adopted yet → no `.covenant/canon` source; read_source
              // falls back to the executor dir it was detected in.
              fetchPreview: () => canonReadSource(cwd, "skill", d.name),
              actions: [this.unitAdoptAction(cwd, "skill", d.name)],
            }));
          }
          toolbar.reveal();
        })
        .catch((e) => {
          list.replaceChildren();
          list.appendChild(this.note(`Failed to load skills: ${this.friendlyError(e)}`));
        });
    };

    el.append(importBar, toolbar.element, list, errorEl);
    load();
    return el;
  }

  // ── Registry section ─────────────────────────────────────────────────

  private renderRegistrySection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-registry";
    const initialActive = this.activeOrg();
    const cwd = this.opts.groupRootDir;

    if (!initialActive) {
      el.appendChild(this.emptyNoOrg("Pick or create an organization to browse and install from its registry."));
      return el;
    }
    if (!cwd) {
      el.appendChild(this.emptyNoRepo("Point this group at a repo from the rail to install packages."));
      return el;
    }

    // Kind tabs — one registry surface, six catalogs. Each kind wears the
    // icon that carries its identity (see DESIGN.md § Registry / catalog tabs)
    // so the row is scannable by glyph before you read a word; active state is
    // the shared accent underline. Every kind is a /cdlc/packages search;
    // operators are shared via the org roster sync, not a public registry.
    type RegTab = { key: SectionKey; label: string; wire: CanonPkgKind; icon: string; icon28: string };
    const REG_TABS: RegTab[] = [
      { key: "skills", label: "Skills", wire: "skill", icon: Icons.sparkles({ size: 15 }), icon28: Icons.sparkles({ size: 28 }) },
      { key: "agents", label: "Subagents", wire: "agent", icon: Icons.bot({ size: 15 }), icon28: Icons.bot({ size: 28 }) },
      { key: "commands", label: "Commands", wire: "command", icon: Icons.terminalSquare({ size: 15 }), icon28: Icons.terminalSquare({ size: 28 }) },
      { key: "context", label: "Context", wire: "context", icon: Icons.fileText({ size: 15 }), icon28: Icons.fileText({ size: 28 }) },
      { key: "mcp", label: "MCP", wire: "mcp", icon: Icons.radioTower({ size: 15 }), icon28: Icons.radioTower({ size: 28 }) },
    ];
    let tab: RegTab = REG_TABS[0];
    // Flips on the first explicit search or tab click so the async census
    // seed below never clobbers results the user asked for.
    let userSearched = false;
    // Empty-query rows per kind, filled by the seed fan-out and by browse
    // fetches — tab switches render from here instantly, then revalidate.
    const census = new Map<CanonPkgKind, PkgMeta[]>();
    // Monotonic ticket per explicit search — a response landing after a newer
    // search (or a tab switch, which also runs one) is dropped, not rendered.
    let searchSeq = 0;
    let debounceId: number | undefined;
    // Org defaults keyed `${kind}/${name}` — owners pin/unpin from the cards.
    const defaults = new Set<string>();
    void canonOrgDefaults(initialActive.slug)
      .then((defs) => defs.forEach((d) => defaults.add(`${d.kind}/${d.name}`)))
      .catch(() => {});
    const isOwner = initialActive.role === "owner";
    const toggleRow = document.createElement("div");
    toggleRow.className = "canon-reg-kind-toggle";
    const tabBtns = new Map<string, HTMLButtonElement>();
    const countEls = new Map<string, HTMLElement>();
    for (const t of REG_TABS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "canon-reg-kind";
      const ico = document.createElement("span");
      ico.className = "canon-reg-kind-ico";
      ico.innerHTML = t.icon;
      const lbl = document.createElement("span");
      lbl.textContent = t.label;
      const ct = document.createElement("span");
      ct.className = "canon-reg-kind-ct";
      countEls.set(t.key, ct);
      b.append(ico, lbl, ct);
      b.addEventListener("click", () => { applyKindUI(t); runSearch(); });
      tabBtns.set(t.key, b);
      toggleRow.appendChild(b);
    }

    const searchRow = document.createElement("div");
    searchRow.className = "canon-cockpit-search-row";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "canon-cockpit-search-input";
    const go = document.createElement("button");
    go.type = "button";
    go.className = "canon-cockpit-search-go";
    go.textContent = "Search";

    const errorEl = document.createElement("p");
    errorEl.className = "canon-cockpit-error";
    errorEl.hidden = true;

    const results = document.createElement("div");
    results.className = "canon-cockpit-search-results";

    const renderRows = (active: Org, wire: CanonPkgKind, rows: PkgMeta[]): void => {
      results.replaceChildren();
      if (rows.length === 0) {
        const q = input.value.trim();
        results.appendChild(q
          ? this.note(`No matches for “${q}”.`)
          : this.emptyState({
              icon: tab.icon28,
              title: `No ${tab.key === "mcp" ? "MCP packages" : tab.label.toLowerCase()} in ${active.slug} yet`,
              hint: `Publish one from this repo's ${tab.label} section.`,
              action: { label: `Go to ${tab.label}`, onClick: () => this.showSection(tab.key) },
            }));
        return;
      }
      for (const r of rows) {
        const inst = iconButton(Icons.download({ size: 15 }), "Install", () => {
          const org = this.activeOrg();
          if (!org) return;
          errorEl.hidden = true;
          inst.disabled = true;
          const install = wire === "skill"
            ? canonInstallRegistry(cwd, org.slug, r.name, r.version, this.opts.groupLabel, null)
            : canonInstallRegistryUnit(cwd, org.slug, r.name, r.version, wire);
          void install
            .then(() => { this.invalidateStatus(); inst.innerHTML = Icons.check({ size: 15 }); })
            .catch((e) => {
              errorEl.hidden = false;
              errorEl.textContent = this.friendlyError(e);
              inst.disabled = false;
            });
        });
        const installs = `${r.installs} ${r.installs === 1 ? "install" : "installs"}`;
        const evals = evalChip(r);
        const score = evalScoreLabel(r);
        const meta = wire === "skill"
          ? [r.version, installs, evals, score, r.publisher_login].filter(Boolean).join(" · ")
          : `${installs} · ${r.publisher_login}`;
        const stats = wire === "skill"
          ? [`shared by ${r.publisher_login}`, `v${r.version}`, installs, r.sha.slice(0, 7)]
          : [`shared by ${r.publisher_login}`, installs];
        const key = `${wire}/${r.name}`;
        if (defaults.has(key)) stats.push("org default");
        const actions = [inst];
        if (isOwner) {
          const pin = iconButton(Icons.pin({ size: 15 }), "Org default — suggested in every repo of the org", () => {
            pin.disabled = true;
            const on = !defaults.has(key);
            const call = on
              ? canonOrgDefaultSet(active.slug, wire, r.name)
              : canonOrgDefaultUnset(active.slug, wire, r.name);
            void call
              .then(() => {
                if (on) defaults.add(key); else defaults.delete(key);
                pin.classList.toggle("is-active", on);
                pin.disabled = false;
              })
              .catch((e) => {
                pin.disabled = false;
                errorEl.hidden = false;
                errorEl.textContent = this.friendlyError(e);
              });
          });
          pin.classList.add("canon-default-pin");
          pin.classList.toggle("is-active", defaults.has(key));
          actions.unshift(pin);
        }
        results.appendChild(skillCard({
          name: r.name,
          meta,
          description: r.description,
          className: "canon-search-result",
          fetchPreview: () => canonPreview(active.slug, r.name, r.version, wire).then((p) => p.skill_md),
          actions,
          stats,
        }));
      }
    };

    const runPkgSearch = (active: Org, wire: CanonPkgKind): void => {
      const query = input.value.trim() || null;
      // Browsing (empty query) paints from the census instantly and
      // revalidates in the background; typed searches always hit the network.
      const cached = query === null ? census.get(wire) : undefined;
      if (cached) renderRows(active, wire, cached);
      else results.replaceChildren(this.note("Searching…"));
      const seq = ++searchSeq;
      void canonSearch(active.slug, query, wire)
        .then((rows: PkgMeta[]) => {
          if (query === null) {
            census.set(wire, rows);
            const t = REG_TABS.find((x) => x.wire === wire);
            const ct = t && countEls.get(t.key);
            if (ct) ct.textContent = String(rows.length);
          }
          if (seq !== searchSeq) return; // a newer search owns the list
          renderRows(active, wire, rows);
        })
        .catch((e) => {
          if (seq !== searchSeq) return;
          if (!cached) results.replaceChildren();
          errorEl.hidden = false;
          errorEl.textContent = this.friendlyError(e);
        });
    };

    const runSearch = (): void => {
      userSearched = true;
      errorEl.hidden = true;
      const active = this.activeOrg();
      if (!active) {
        errorEl.hidden = false;
        errorEl.textContent = "No organization selected.";
        return;
      }
      runPkgSearch(active, tab.wire);
    };

    const applyKindUI = (next: RegTab): void => {
      tab = next;
      window.clearTimeout(debounceId);
      for (const [key, b] of tabBtns) {
        const isActive = key === next.key;
        b.setAttribute("aria-pressed", String(isActive));
        b.classList.toggle("is-active", isActive);
      }
      input.value = "";
      input.placeholder = `Search ${initialActive.slug} ${next.wire === "mcp" ? "MCP" : next.label.toLowerCase()}…`;
    };
    applyKindUI(REG_TABS[0]);

    // Per-catalog counts + initial listing. No census endpoint for the remote
    // registry, so fan out one empty-query search per kind: each resolves its
    // tab badge, and the active kind's rows seed the results list so the
    // section never opens empty.
    // ponytail: 5 parallel searches on open; a canon_registry_census command
    // returning all counts in one call is the upgrade path if this shows up hot.
    results.replaceChildren(this.note("Loading…"));
    for (const t of REG_TABS) {
      const ct = countEls.get(t.key);
      if (!ct) continue;
      void canonSearch(initialActive.slug, null, t.wire)
        .then((rows) => {
          census.set(t.wire, rows);
          ct.textContent = String(rows.length);
          if (t.wire === tab.wire && !userSearched) renderRows(initialActive, t.wire, rows);
        })
        .catch((e) => {
          if (t.wire === tab.wire && !userSearched) {
            results.replaceChildren();
            errorEl.hidden = false;
            errorEl.textContent = this.friendlyError(e);
          }
        });
    }

    go.addEventListener("click", runSearch);
    input.addEventListener("input", () => {
      window.clearTimeout(debounceId);
      debounceId = window.setTimeout(runSearch, 300);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      window.clearTimeout(debounceId);
      runSearch();
    });

    searchRow.append(input, go);
    el.append(toggleRow, searchRow, errorEl, results);
    return el;
  }

  // ── Context section ──────────────────────────────────────────────────

  private renderContextSection(headAction?: HTMLElement): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-context";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.emptyNoRepo("Point this group at a repo from the rail to mine and manage context."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-context-list";
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    void Promise.all([this.status(cwd), canonEvalSummary(cwd).catch(() => [])])
      .then(([status, evals]) => {
        const sums = new Map(evals.map((e) => [`${e.kind}/${e.name}`, e]));
        list.replaceChildren();
        if (status.contexts.length === 0) {
          list.appendChild(this.emptyState({
            icon: Icons.noteText({ size: 28 }),
            title: "No context files yet",
            hint: "Mine this repo into curated context every session carries.",
            action: this.opts.onNewContext
              ? { label: "New context", onClick: () => this.opts.onNewContext?.() }
              : undefined,
          }));
          return;
        }
        if (headAction) headAction.hidden = false;
        for (const c of status.contexts) {
          const actions: HTMLButtonElement[] = [];
          const open = this.unitOpenAction(cwd, "context", c.name);
          if (open) actions.push(open);
          const pub = this.unitPublishAction(cwd, "context", c.name);
          if (pub) actions.push(pub);
          const draftBtn = iconButton(Icons.sparkles({ size: 15 }), "Draft evals", () => {
            draftEvals(cwd, "context", c.name, draftBtn, () => {});
          });
          actions.push(draftBtn);
          const manageBtn = iconButton(Icons.checklist({ size: 15 }), "Manage evals", () => {
            void openEvalManager(cwd, "context", c.name, () => {
              this.invalidateStatus();
              this.showSection("context");
            });
          });
          actions.push(manageBtn);
          const runBtn = iconButton(Icons.play({ size: 15 }), "Run evals", () => {
            runEvals(cwd, "context", c.name, runBtn, () => {
              this.invalidateStatus();
              this.showSection("context");
            });
          });
          actions.push(runBtn);
          if (this.canCreate()) actions.push(this.unitDeleteAction(cwd, "context", c.name));
          list.appendChild(skillCard({
            name: c.name,
            meta: [c.summary ?? "context", evalCountLabel(sums.get(`context/${c.name}`))].join(" · "),
            className: "canon-skill-row",
            fetchPreview: () => canonReadSource(cwd, "context", c.name),
            actions,
          }));
        }
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load context files: ${this.friendlyError(e)}`));
      });

    return el;
  }

  // ── Loop section — Observe/Adapt: adoption + inference footprint ─────

  private renderLoopSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-loop canon-loop canon-cockpit-loop-body";
    const cwd = this.opts.groupRootDir;
    const active = this.activeOrg();

    // Nothing to observe without a repo or an org — the homologated empty
    // state instead of three silently-empty boxes.
    if (!cwd && !active) {
      el.appendChild(this.emptyState({
        icon: Icons.zap({ size: 28 }),
        title: "Nothing to measure yet",
        hint: "Link a repo and pick an organization to see adoption, inference footprint and eval lift.",
      }));
      return el;
    }

    // Inference — this group's footprint, first: the cost context everything
    // below is judged against (summary before detail).
    const inferenceBox = document.createElement("div");
    el.appendChild(inferenceBox);
    void scoreSummaryFiltered(this.opts.groupLabel ?? null)
      .then((sc) => {
        inferenceBox.appendChild(loopSubhead("Inference · this group"));
        const stats = document.createElement("div");
        stats.className = "canon-stats";
        stats.append(
          statCell(fmtTokens(sc.total_tokens), "tokens", true),
          statCell(sc.total_prompts.toLocaleString(), "prompts"),
          statCell(String(sc.total_specs), "specs"),
          statCell(String(sc.total_commits), "commits"),
        );
        inferenceBox.appendChild(stats);
      })
      .catch(() => {});

    // Dead weight — installed, projected into every prompt, never used. The
    // sentence that closes the loop: it's what tells the next Generate what to
    // stop authoring. Renders right under the footprint as the decision queue.
    const unusedBox = document.createElement("div");
    el.appendChild(unusedBox);
    if (cwd) {
      void Promise.all([
        this.status(cwd),
        scoreSkillUsage(this.opts.groupLabel ?? null).catch(() => []),
      ]).then(([status, usage]) => {
        const unused = unusedUnits(status.installed, usage);
        if (unused.length === 0) return;
        unusedBox.appendChild(loopSubhead("Unused"));
        unusedBox.appendChild(this.note("Installed and projected into every prompt, never used. Uninstall what isn't earning its keep."));
        for (const name of unused) {
          unusedBox.appendChild(skillCard({
            name,
            meta: "0 uses",
            className: "canon-skill-row",
            leadIcon: Icons.packageBox({ size: 15 }),
            fetchPreview: () => canonReadLocal(cwd, name),
            actions: [this.skillUninstallAction(cwd, name, () => this.showSection("loop"), true)],
          }));
        }
      }).catch(() => {});
    }

    // Adoption — org-wide installs, plus local uses, for this group's
    // registry-sourced units. Skills are the ones whose local record carries a
    // `registry:` source; shared contexts have no source field, so a local
    // context counts as registry-sourced iff the org publishes that name.
    // Needs the local list AND the org's packages, hence the multi-hop fetch.
    const adoptionBox = document.createElement("div");
    el.appendChild(adoptionBox);
    if (cwd && active) {
      const orgSlug = active.slug;
      void Promise.all([
        this.status(cwd).catch(() => ({ installed: [], agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [], detectedSkills: [] }) as CanonStatus),
        canonSearch(orgSlug, null, "skill").catch(() => [] as PkgMeta[]),
        canonSearch(orgSlug, null, "context").catch(() => [] as PkgMeta[]),
        scoreSkillUsage(this.opts.groupLabel ?? null).catch(() => []),
      ]).then(([status, skillPkgs, contextPkgs, usage]) => {
        const skillInstalls = new Map(skillPkgs.map((p) => [p.name, p.installs]));
        const contextInstalls = new Map(contextPkgs.map((p) => [p.name, p.installs]));
        const rows: { name: string; installs: number | undefined; kind: string }[] = [
          ...status.installed
            .filter((i) => i.source.startsWith("registry:"))
            .map((i) => ({ name: i.name, installs: skillInstalls.get(i.name), kind: "skill" })),
          ...status.contexts
            .filter((c) => contextInstalls.has(c.name))
            .map((c) => ({ name: c.name, installs: contextInstalls.get(c.name), kind: "context" })),
        ];
        if (rows.length === 0) return;
        const uses = new Map(usage.map((u) => [u.skill, u.uses]));
        adoptionBox.appendChild(loopSubhead("Adoption"));
        const maxInstalls = Math.max(1, ...rows.map((r) => r.installs ?? 0));
        for (const r of rows) {
          const n = r.installs;
          const used = uses.get(r.name) ?? 0;
          const parts = [
            n === undefined ? "—" : `${n} ${n === 1 ? "install" : "installs"}`,
            `${used} ${used === 1 ? "use" : "uses"}`,
          ];
          if (r.kind === "context") parts.push("context");
          adoptionBox.appendChild(meterRow(r.name, parts.join(" · "), ((n ?? 0) / maxInstalls) * 100));
        }
      });
    }

    // Eval — context-TDD pass-rate from the local runner.
    const evalBox = document.createElement("div");
    el.appendChild(evalBox);
    if (cwd) {
      void canonEvalSummary(cwd)
        .then((allSummary) => {
          // Loop is a results dashboard — authored-but-never-run rows (total
          // 0) belong on the unit lists as "not run", not here as fake 0%s.
          const evalSummary = allSummary.filter((r) => r.total > 0);
          if (evalSummary.length === 0) {
            evalBox.appendChild(this.note("Run evals on a skill to measure its context-lift (with vs without)."));
            return;
          }
          evalBox.appendChild(loopSubhead("Context lift"));
          const verdict = document.createElement("div");
          verdict.className = "canon-loop-verdict";
          verdict.textContent = groupVerdict(evalSummary);
          evalBox.appendChild(verdict);
          for (const r of evalSummary) {
            const lv = liftRow(r);
            // meterRow(label, value, percent, positive?) — reuse the existing helper.
            // Bar width = |pct| for a clean A/B (capped at 100), else the absolute pass-rate.
            const bar = lv.sign === "none"
              ? (r.total > 0 ? (r.passed / r.total) * 100 : 0)
              : Math.min(100, Math.abs(lv.pct));
            const row = meterRow(`${r.kind}/${r.name}`, lv.label, bar, lv.sign === "pos");
            row.classList.add(`lift-${lv.sign}`);
            evalBox.appendChild(row);
          }
        })
        .catch(() => {});
    }

    return el;
  }
}
