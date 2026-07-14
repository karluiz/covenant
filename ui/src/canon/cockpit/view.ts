// Canon Cockpit — full-screen overlay shell for org-scoped Canon management.
// Left-nav section routing (org/members/skills/registry/context/loop); each
// section is a stub in this task — Tasks 6-8 fill in real content. Launched
// from the expand button in the rail's CanonPanel head (see panel.ts).
//
// Opaque full-screen overlay by design — mirrors ContextMinerView's
// mount/close/Esc handling (see miner.css header comment for the
// vibrancy-bleed gotcha this avoids).

import "./cockpit.css";
import type { CanonStatus, Org, Member, Operator, PkgMeta, MarketplaceListing } from "../../api";
import {
  canonOrgMembers,
  canonAddMember,
  canonRemoveMember,
  canonMyOrgs,
  canonLocalStatus,
  canonReadLocal,
  canonReadSource,
  canonPublish,
  canonSearch,
  canonPreview,
  canonInstallRegistry,
  scoreSummaryFiltered,
  canonEvalSummary,
  operatorList,
  operatorDelete,
  operatorSetOrg,
  operatorCreateFromSoul,
  marketplacePublish,
  marketplaceSearch,
  marketplaceInstallCount,
} from "../../api";
import { skillCard, iconButton, statCell, meterRow, fmtTokens } from "../panel";
import { resolveActiveOrg, orgInitials, orgHue } from "../org";
import { openCreateOrgExperience } from "../create-org/view";
import { openOperatorModal, wireOperatorModal, renderOperatorList } from "../../operator/creator";
import { operatorsForOrg, isStaleOrg } from "../../operator/org-filter";
import { scheduleCloudPush } from "../../settings/cloud_push";
import { pushInfoToast } from "../../notifications/toast";
import { suffixSoulName } from "../../settings/marketplace_install";
import { Icons } from "../../icons";
import { attachTooltip } from "../../tooltip/tooltip";
import { liftRow, groupVerdict } from "./lift";

export type SectionKey = "org" | "members" | "operators" | "agents" | "commands" | "mcp" | "spec" | "memory" | "skills" | "registry" | "context" | "loop";

export interface CanonCockpitOpts {
  groupId: string;
  groupLabel: string;
  groupRootDir: string | null;
  orgs: Org[];
  getActiveOrg: () => string | null;
  setActiveOrg: (slug: string | null) => void;
  /** Launch the repo-mining Context Miner for this group (same flow the
   *  rail panel used to expose directly — now only reachable from here). */
  onNewContext?: () => void;
  /** Called after the overlay is torn down — lets the caller refresh the
   *  still-mounted rail panel, whose org chip otherwise goes stale until
   *  its next own refresh (e.g. after this cockpit switched/created an org). */
  onClose?: () => void;
}

/** A small uppercase subhead inside the Loop section (Adoption / Inference /
 *  Eval pass-rate) — mirrors panel.ts's rail-only helper of the same name. */
function loopSubhead(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "canon-subhead";
  el.textContent = text;
  return el;
}

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "org", label: "Org" },
  { key: "members", label: "Members" },
  { key: "operators", label: "Operators" },
  { key: "agents", label: "Subagents" },
  { key: "commands", label: "Commands" },
  { key: "mcp", label: "MCP" },
  { key: "spec", label: "Specs" },
  { key: "memory", label: "Memory" },
  { key: "skills", label: "Skills" },
  { key: "registry", label: "Registry" },
  { key: "context", label: "Context" },
  { key: "loop", label: "Loop" },
];

/** Title + one-line description for each section's header. */
const SECTION_HEAD: Record<SectionKey, [string, string]> = {
  org: ["Organization", "The registry this group publishes to and installs from."],
  members: ["Members", "People with access to this organization's Canon."],
  operators: ["Operators", "Versions of you, delegated — org-scoped personas that direct your executors."],
  agents: ["Subagents", "Repo-level subagent files projected into executor context."],
  commands: ["Commands", "Slash commands projected to your executors."],
  mcp: ["MCP", "Model Context Protocol servers projected to your executors."],
  spec: ["Specs", "Task-anchor specs published in this repo (docs/specs)."],
  memory: ["Memory", "Durable facts this group carries into every executor's managed block."],
  skills: ["Skills", "Skills installed in this group, projected to your executors."],
  registry: ["Registry", "Browse and install skills and operators shared across the organization."],
  context: ["Context", "Repo-mined context this group carries into every session."],
  loop: ["Loop", "Adoption, inference footprint, and eval pass-rate for this group."],
};

export class CanonCockpitView {
  private root: HTMLElement;
  private nav: HTMLElement;
  private content: HTMLElement;
  private current: SectionKey = "org";

  /** The root element of the overlay — used by tests and by callers that
   *  need to query the rendered content without going through document. */
  get element(): HTMLElement { return this.root; }

  constructor(private opts: CanonCockpitOpts) {
    this.root = document.createElement("div");
    this.root.className = "canon-cockpit";

    this.nav = document.createElement("nav");
    this.nav.className = "canon-cockpit-nav";
    const title = document.createElement("div");
    title.className = "canon-cockpit-nav-title";
    title.textContent = `Canon — ${this.opts.groupLabel}`;
    this.nav.appendChild(title);
    for (const s of SECTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "canon-cockpit-nav-btn";
      b.dataset.section = s.key;
      b.textContent = s.label;
      b.addEventListener("click", () => this.showSection(s.key));
      this.nav.appendChild(b);
    }

    this.content = document.createElement("section");
    this.content.className = "canon-cockpit-content";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "canon-cockpit-close";
    close.setAttribute("aria-label", "Close (Esc)");
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.close());

    this.root.append(this.nav, this.content, close);
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.close();
  };

  open(): void {
    document.body.appendChild(this.root);
    // Lets cockpit.css re-stack the rail's SKILL.md reader (openMarkdownReader,
    // z-index 60, positioned for the narrow rail panel) above the full-screen
    // cockpit overlay (z-index 9600) instead of rendering behind it.
    document.body.classList.add("canon-cockpit-open");
    document.addEventListener("keydown", this.onKey);
    this.showSection(this.current);
  }

  close(): void {
    this.root.remove();
    document.body.classList.remove("canon-cockpit-open");
    document.removeEventListener("keydown", this.onKey);
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
    const body =
      key === "org" ? this.renderOrgSection()
      : key === "members" ? this.renderMembersSection()
      : key === "operators" ? this.renderOperatorsSection()
      : key === "agents" ? this.renderAgentsSection()
      : key === "commands" ? this.renderCommandsSection()
      : key === "mcp" ? this.renderMcpSection()
      : key === "spec" ? this.renderSpecSection()
      : key === "memory" ? this.renderMemorySection()
      : key === "skills" ? this.renderSkillsSection()
      : key === "registry" ? this.renderRegistrySection()
      : key === "context" ? this.renderContextSection()
      : this.renderLoopSection();
    // Full-bleed header (divider spans the whole pane) + a contained content
    // column below it — the Capabilities layout.
    const wrap = document.createElement("div");
    wrap.className = "canon-cockpit-section-wrap";
    wrap.append(this.sectionHead(SECTION_HEAD[key][0], SECTION_HEAD[key][1]), body);
    return wrap;
  }

  /** A consistent section header: title + one-line description. Gives every
   *  section the same top structure instead of dropping straight into content. */
  private sectionHead(title: string, desc: string): HTMLElement {
    const head = document.createElement("header");
    head.className = "canon-cockpit-sec-head";
    const h = document.createElement("h2");
    h.className = "canon-cockpit-sec-title";
    h.textContent = title;
    const p = document.createElement("p");
    p.className = "canon-cockpit-sec-desc";
    p.textContent = desc;
    head.append(h, p);
    return head;
  }

  /** The org this cockpit is scoped to. Delegates to the shared resolver in
   *  org.ts — keep the resolution order in one place. */
  private activeOrg(): Org | null {
    return resolveActiveOrg(this.opts.orgs, this.opts.getActiveOrg());
  }

  private note(text: string): HTMLElement {
    const p = document.createElement("p");
    p.className = "canon-cockpit-note";
    p.textContent = text;
    return p;
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
        card.appendChild(edit);
      }
      el.appendChild(card);
    } else {
      el.appendChild(this.note("No organization selected."));
    }

    // Switch organization — a labeled list of every org the caller belongs to.
    if (this.opts.orgs.length > 0) {
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

    el.appendChild(this.renderCreateOrgRow());
    return el;
  }

  /** Refetch orgs so the just-created/renamed org is in the snapshot before
   *  switching (activeOrg() resolves against opts.orgs). */
  private refreshOrgs(slug: string): void {
    void canonMyOrgs().then((fresh) => {
      this.opts.orgs = fresh;
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
      el.appendChild(this.note("No organization selected."));
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

    const load = (): void => {
      void canonOrgMembers(orgSlug)
        .then((members) => {
          list.replaceChildren();
          if (members.length === 0) {
            list.appendChild(this.note("No members yet."));
            return;
          }
          for (const m of members) {
            list.appendChild(this.renderMemberRow(m, orgSlug, isOwner, load, errorEl));
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

  private renderMemberRow(
    m: Member,
    orgSlug: string,
    isOwner: boolean,
    reload: () => void,
    errorEl: HTMLElement,
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "canon-cockpit-member-row";
    const login = document.createElement("span");
    login.className = "canon-cockpit-member-login";
    login.textContent = m.login;
    const role = document.createElement("span");
    role.className = "canon-cockpit-member-role";
    role.textContent = m.role;
    row.append(login, role);

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

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "GitHub login";

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

    row.append(input, add);
    return row;
  }

  // ── Operators section ────────────────────────────────────────────────

  /** Org-scoped operator roster — the immersive creator (`../../operator/creator`)
   *  reused verbatim from the settings pane, wired so saves assign/clear the
   *  active org instead of leaving the operator on whatever org it had. */
  private renderOperatorsSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-operators";

    const bar = document.createElement("div");
    bar.className = "canon-cockpit-actions";
    const newBtn = iconButton(Icons.plus({ size: 15 }), "New operator", () => {
      const active = this.activeOrg();
      const handle = openOperatorModal({ mode: "create" });
      wireOperatorModal(handle, {
        assignOrgSlug: active && !active.personal ? active.slug : null,
        onSaved: () => this.showSection("operators"),
      });
    });
    newBtn.dataset.role = "op-new";
    bar.appendChild(newBtn);
    el.appendChild(bar);

    const list = document.createElement("div");
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    void operatorList()
      .then((all) => {
        const known = new Set(this.opts.orgs.map((o) => o.slug));
        const active = this.activeOrg();
        const ops = operatorsForOrg(all, active, known);
        list.replaceChildren();
        if (ops.length === 0) {
          list.appendChild(this.note("No operators in this org yet."));
          return;
        }
        list.appendChild(renderOperatorList(ops, {
          isStale: (op) => isStaleOrg(op, known),
          onEdit: (op) => {
            const handle = openOperatorModal({ mode: "edit", existing: op });
            wireOperatorModal(handle, {
              // Rescue stale-org operators: saving from the personal view
              // clears the dead slug back to the personal roster.
              assignOrgSlug: isStaleOrg(op, known) ? null : undefined,
              onSaved: () => this.showSection("operators"),
              onDelete: (o) => this.deleteOperator(o),
            });
          },
          onDuplicate: (op) => {
            const handle = openOperatorModal({ mode: "create", existing: { ...op, name: `${op.name} copy` } });
            wireOperatorModal(handle, {
              assignOrgSlug: active && !active.personal ? active.slug : null,
              onSaved: () => this.showSection("operators"),
            });
          },
          onPublish: (op) => {
            void marketplacePublish(op.id).then(() => pushInfoToast({ message: `${op.name} submitted — pending review` }));
          },
          onDelete: (op) => this.deleteOperator(op),
        }));
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load operators: ${this.friendlyError(e)}`));
      });

    return el;
  }

  /** Ported from `OperatorsPane.deleteOperator` (settings/operators.ts) so the
   *  cockpit's roster enforces the same guards: can't delete the default
   *  operator, can't delete the last operator system-wide. */
  private async deleteOperator(op: Operator): Promise<void> {
    if (op.is_default) {
      alert("Cannot delete the default operator. Set a different default first.");
      return;
    }
    const all = await operatorList().catch(() => [] as Operator[]);
    if (all.length <= 1) {
      alert("Cannot delete the last operator.");
      return;
    }
    if (!confirm(`Delete operator "${op.name}"? Tabs pinned to it will fall back to the default.`)) {
      return;
    }
    try {
      await operatorDelete(op.id);
      // Notify the rest of the app — tabs/manager.ts drops the cache entry
      // and clears any pane.operator pointer; the status bar re-renders
      // without the dangling avatar.
      window.dispatchEvent(new CustomEvent("operator:deleted", { detail: { id: op.id } }));
      scheduleCloudPush();
      pushInfoToast({ message: `Deleted operator: ${op.name}` });
      this.showSection("operators");
    } catch (e) {
      alert(`Delete failed: ${e}`);
    }
  }

  // ── Agents section ───────────────────────────────────────────────────

  private renderAgentsSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-agents";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.note("No project folder linked for this group — point it at a repo from the rail to manage agents."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-agents-list";
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    void canonLocalStatus(cwd)
      .then((status) => {
        list.replaceChildren();
        if (status.agents.length === 0) {
          list.appendChild(this.note("No agents authored yet."));
          return;
        }
        for (const a of status.agents) {
          list.appendChild(skillCard({
            name: a.name,
            meta: "agent",
            className: "canon-skill-row",
            fetchPreview: () => canonReadSource(cwd, "agent", a.name),
            actions: [],
          }));
        }
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load agents: ${this.friendlyError(e)}`));
      });

    return el;
  }

  // ── Commands section ─────────────────────────────────────────────────

  private renderCommandsSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-commands";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.note("No project folder linked for this group — point it at a repo from the rail to manage commands."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-commands-list";
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    void canonLocalStatus(cwd)
      .then((status) => {
        list.replaceChildren();
        if (status.commands.length === 0) {
          list.appendChild(this.note("No commands authored yet."));
          return;
        }
        for (const c of status.commands) {
          list.appendChild(skillCard({
            name: c.name,
            meta: c.description ?? "command",
            className: "canon-skill-row",
            fetchPreview: () => canonReadSource(cwd, "command", c.name),
            actions: [],
          }));
        }
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load commands: ${this.friendlyError(e)}`));
      });

    return el;
  }

  // ── MCP section ──────────────────────────────────────────────────────

  private renderMcpSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-mcp";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.note("No project folder linked for this group — point it at a repo from the rail to manage MCP servers."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-mcp-list";
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    void canonLocalStatus(cwd)
      .then((status) => {
        list.replaceChildren();
        if (status.mcp.length === 0) {
          list.appendChild(this.note("No MCP servers authored yet."));
          return;
        }
        for (const m of status.mcp) {
          list.appendChild(skillCard({
            name: m.name,
            meta: m.description ?? m.transport,
            className: "canon-skill-row",
            fetchPreview: () => canonReadSource(cwd, "mcp", m.name),
            actions: [],
          }));
        }
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load MCP servers: ${this.friendlyError(e)}`));
      });

    return el;
  }

  // ── Specs section ────────────────────────────────────────────────────

  private renderSpecSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-spec";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.note("No project folder linked for this group — point it at a repo from the rail to see specs."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-spec-list";
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    void canonLocalStatus(cwd)
      .then((status) => {
        list.replaceChildren();
        if (status.specs.length === 0) {
          list.appendChild(this.note("No specs published yet."));
          return;
        }
        for (const sp of status.specs) {
          list.appendChild(skillCard({
            name: sp.name,
            meta: sp.title,
            className: "canon-skill-row",
            fetchPreview: () => canonReadSource(cwd, "spec", sp.name),
            actions: [],
          }));
        }
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load specs: ${this.friendlyError(e)}`));
      });

    return el;
  }

  // ── Memory section ───────────────────────────────────────────────────

  private renderMemorySection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-memory";
    const cwd = this.opts.groupRootDir;

    if (!cwd) {
      el.appendChild(this.note("No project folder linked for this group — point it at a repo from the rail to manage memory."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-memory-list";
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    void canonLocalStatus(cwd)
      .then((status) => {
        list.replaceChildren();
        if (status.memory.length === 0) {
          list.appendChild(this.note("No memories authored yet."));
          return;
        }
        for (const m of status.memory) {
          list.appendChild(skillCard({
            name: m.name,
            meta: m.description ?? "memory",
            className: "canon-skill-row",
            fetchPreview: () => canonReadSource(cwd, "memory", m.name),
            actions: [],
          }));
        }
      })
      .catch((e) => {
        list.replaceChildren();
        list.appendChild(this.note(`Failed to load memory: ${this.friendlyError(e)}`));
      });

    return el;
  }

  // ── Skills section ────────────────────────────────────────────────────

  private renderSkillsSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-skills";
    const cwd = this.opts.groupRootDir;
    if (!cwd) {
      el.appendChild(this.note("No project folder linked for this group — point it at a repo from the rail to manage skills."));
      return el;
    }

    const errorEl = document.createElement("p");
    errorEl.className = "canon-cockpit-error";
    errorEl.hidden = true;

    const list = document.createElement("div");
    list.className = "canon-cockpit-skills-list";
    list.appendChild(this.note("Loading…"));

    const load = (): void => {
      void canonLocalStatus(cwd)
        .then((status) => {
          list.replaceChildren();
          if (status.installed.length === 0) {
            list.appendChild(this.note("No skills installed."));
            return;
          }
          const active = this.activeOrg();
          for (const i of status.installed) {
            const actions: HTMLButtonElement[] = [];
            if (active && !i.source.startsWith("registry:")) {
              const pub = iconButton(Icons.upload({ size: 15 }), "Publish to registry", () => {
                errorEl.hidden = true;
                pub.disabled = true;
                void canonPublish(cwd, active.slug, i.name)
                  .then(load)
                  .catch((e) => {
                    errorEl.hidden = false;
                    errorEl.textContent = this.friendlyError(e);
                    pub.disabled = false;
                  });
              });
              actions.push(pub);
            }
            list.appendChild(skillCard({
              name: i.name,
              meta: `${i.version} · ${i.source}`,
              className: "canon-skill-row",
              fetchPreview: () => canonReadLocal(cwd, i.name),
              actions,
              stats: [`v${i.version}`, i.source],
            }));
          }
        })
        .catch((e) => {
          list.replaceChildren();
          list.appendChild(this.note(`Failed to load skills: ${this.friendlyError(e)}`));
        });
    };

    el.append(list, errorEl);
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
      el.appendChild(this.note("No organization selected — pick or create one in the Org section to browse its registry."));
      return el;
    }
    if (!cwd) {
      el.appendChild(this.note("No project folder linked for this group — point it at a repo from the rail to install packages."));
      return el;
    }

    // Skills | Operators kind toggle — same registry surface, two catalogs.
    let kind: "skills" | "operators" = "skills";
    const toggleRow = document.createElement("div");
    toggleRow.className = "canon-reg-kind-toggle";
    const skillsBtn = document.createElement("button");
    skillsBtn.type = "button";
    skillsBtn.className = "canon-reg-kind";
    skillsBtn.textContent = "Skills";
    const opsBtn = document.createElement("button");
    opsBtn.type = "button";
    opsBtn.className = "canon-reg-kind";
    opsBtn.textContent = "Operators";
    toggleRow.append(skillsBtn, opsBtn);

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

    const runSkillsSearch = (active: Org): void => {
      results.replaceChildren(this.note("Searching…"));
      void canonSearch(active.slug, input.value.trim() || null)
        .then((rows: PkgMeta[]) => {
          results.replaceChildren();
          if (rows.length === 0) {
            results.appendChild(this.note("No packages found."));
            return;
          }
          for (const r of rows) {
            const inst = iconButton(Icons.download({ size: 15 }), "Install", () => {
              const org = this.activeOrg();
              if (!org) return;
              errorEl.hidden = true;
              inst.disabled = true;
              void canonInstallRegistry(cwd, org.slug, r.name, r.version, this.opts.groupLabel, null)
                .then(() => { inst.innerHTML = Icons.check({ size: 15 }); })
                .catch((e) => {
                  errorEl.hidden = false;
                  errorEl.textContent = this.friendlyError(e);
                  inst.disabled = false;
                });
            });
            const installs = `${r.installs} ${r.installs === 1 ? "install" : "installs"}`;
            results.appendChild(skillCard({
              name: r.name,
              meta: `${r.version} · ${installs} · ${r.publisher_login}`,
              description: r.description,
              className: "canon-search-result",
              fetchPreview: () => canonPreview(active.slug, r.name, r.version).then((p) => p.skill_md),
              actions: [inst],
              stats: [`shared by ${r.publisher_login}`, `v${r.version}`, installs, r.sha.slice(0, 7)],
            }));
          }
        })
        .catch((e) => {
          results.replaceChildren();
          errorEl.hidden = false;
          errorEl.textContent = this.friendlyError(e);
        });
    };

    const runOperatorsSearch = (): void => {
      results.replaceChildren(this.note("Searching…"));
      void marketplaceSearch(input.value.trim() || undefined)
        .then((rows: MarketplaceListing[]) => {
          results.replaceChildren();
          if (rows.length === 0) {
            results.appendChild(this.note("No operators found."));
            return;
          }
          for (const r of rows) {
            const inst = iconButton(Icons.download({ size: 15 }), "Install", () => {
              inst.disabled = true;
              void (async () => {
                const existing = new Set((await operatorList()).map((o) => o.name.toLowerCase()));
                const raw = suffixSoulName(r.soul_md, existing);
                const created = await operatorCreateFromSoul(raw);
                const org = this.activeOrg();
                if (org && !org.personal) await operatorSetOrg(created.id, org.slug);
                marketplaceInstallCount(r.id).catch(() => {});
                inst.innerHTML = Icons.check({ size: 15 });
              })().catch((e) => {
                inst.disabled = false;
                errorEl.hidden = false;
                errorEl.textContent = this.friendlyError(e);
              });
            });
            results.appendChild(skillCard({
              name: r.name,
              meta: `@${r.author_login} · ${r.installs} ${r.installs === 1 ? "install" : "installs"}`,
              description: r.tagline,
              className: "canon-search-result",
              fetchPreview: () => Promise.resolve(r.soul_md),
              actions: [inst],
            }));
          }
        })
        .catch((e) => {
          results.replaceChildren();
          errorEl.hidden = false;
          errorEl.textContent = this.friendlyError(e);
        });
    };

    const runSearch = (): void => {
      errorEl.hidden = true;
      if (kind === "operators") {
        runOperatorsSearch();
        return;
      }
      const active = this.activeOrg();
      if (!active) {
        errorEl.hidden = false;
        errorEl.textContent = "No organization selected.";
        return;
      }
      runSkillsSearch(active);
    };

    const applyKindUI = (next: "skills" | "operators"): void => {
      kind = next;
      skillsBtn.setAttribute("aria-pressed", String(next === "skills"));
      skillsBtn.classList.toggle("is-active", next === "skills");
      opsBtn.setAttribute("aria-pressed", String(next === "operators"));
      opsBtn.classList.toggle("is-active", next === "operators");
      input.value = "";
      input.placeholder = next === "skills" ? `Search ${initialActive.slug} registry…` : "Search operators…";
    };
    skillsBtn.addEventListener("click", () => { applyKindUI("skills"); runSearch(); });
    opsBtn.addEventListener("click", () => { applyKindUI("operators"); runSearch(); });
    applyKindUI("skills");

    go.addEventListener("click", runSearch);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });

    searchRow.append(input, go);
    el.append(toggleRow, searchRow, errorEl, results);
    return el;
  }

  // ── Context section ──────────────────────────────────────────────────

  private renderContextSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-context";
    const cwd = this.opts.groupRootDir;

    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "canon-new-context-btn";
    newBtn.textContent = "New context";
    newBtn.addEventListener("click", () => this.opts.onNewContext?.());
    el.appendChild(newBtn);

    if (!cwd) {
      el.appendChild(this.note("No project folder linked for this group — point it at a repo from the rail to manage context."));
      return el;
    }

    const list = document.createElement("div");
    list.className = "canon-cockpit-context-list";
    list.appendChild(this.note("Loading…"));
    el.appendChild(list);

    void canonLocalStatus(cwd)
      .then((status) => {
        list.replaceChildren();
        if (status.contexts.length === 0) {
          list.appendChild(this.note("No context files yet."));
          return;
        }
        for (const c of status.contexts) {
          const row = document.createElement("div");
          row.className = "canon-context-row";
          row.textContent = c.name;
          list.appendChild(row);
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

    // Adoption — org-wide installs for this group's registry-sourced skills.
    // Needs both a local skill list (to know what's registry-sourced) and an
    // active org (to know install counts), so it's the one two-hop fetch here.
    const adoptionBox = document.createElement("div");
    el.appendChild(adoptionBox);
    if (cwd && active) {
      const orgSlug = active.slug;
      void Promise.all([
        canonLocalStatus(cwd).catch(() => ({ installed: [], agents: [], contexts: [], memory: [], commands: [], mcp: [], specs: [] }) as CanonStatus),
        canonSearch(orgSlug, null).catch(() => [] as PkgMeta[]),
      ]).then(([status, pkgs]) => {
        const registrySkills = status.installed.filter((i) => i.source.startsWith("registry:"));
        if (registrySkills.length === 0) return;
        const adoption = new Map(pkgs.map((p) => [p.name, p.installs]));
        adoptionBox.appendChild(loopSubhead("Adoption"));
        const maxInstalls = Math.max(1, ...registrySkills.map((i) => adoption.get(i.name) ?? 0));
        for (const i of registrySkills) {
          const n = adoption.get(i.name);
          const value = n === undefined ? "—" : `${n} ${n === 1 ? "install" : "installs"}`;
          adoptionBox.appendChild(meterRow(i.name, value, ((n ?? 0) / maxInstalls) * 100));
        }
      });
    }

    // Inference — this group's footprint from the four Covenant primitives.
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

    // Eval — context-TDD pass-rate from the local runner.
    const evalBox = document.createElement("div");
    el.appendChild(evalBox);
    if (cwd) {
      void canonEvalSummary(cwd)
        .then((evalSummary) => {
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
            const row = meterRow(r.skill, lv.label, bar, lv.sign === "pos");
            row.classList.add(`lift-${lv.sign}`);
            evalBox.appendChild(row);
          }
        })
        .catch(() => {});
    }

    return el;
  }
}
