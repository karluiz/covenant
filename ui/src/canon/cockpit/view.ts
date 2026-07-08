// Canon Cockpit — full-screen overlay shell for org-scoped Canon management.
// Left-nav section routing (org/members/skills/registry/context/loop); each
// section is a stub in this task — Tasks 6-8 fill in real content. Launched
// from the expand button in the rail's CanonPanel head (see panel.ts).
//
// Opaque full-screen overlay by design — mirrors ContextMinerView's
// mount/close/Esc handling (see miner.css header comment for the
// vibrancy-bleed gotcha this avoids).

import "./cockpit.css";
import type { Org, Member } from "../../api";
import { canonOrgMembers, canonAddMember, canonRemoveMember, canonCreateOrg } from "../../api";
import { slugify } from "../panel";
import { attachTooltip } from "../../tooltip/tooltip";

export type SectionKey = "org" | "members" | "skills" | "registry" | "context" | "loop";

export interface CanonCockpitOpts {
  groupId: string;
  groupLabel: string;
  groupRootDir: string | null;
  orgs: Org[];
  getActiveOrg: () => string | null;
  setActiveOrg: (slug: string | null) => void;
}

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "org", label: "Org" },
  { key: "members", label: "Members" },
  { key: "skills", label: "Skills" },
  { key: "registry", label: "Registry" },
  { key: "context", label: "Context" },
  { key: "loop", label: "Loop" },
];

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
    document.addEventListener("keydown", this.onKey);
    this.showSection(this.current);
  }

  close(): void {
    this.root.remove();
    document.removeEventListener("keydown", this.onKey);
  }

  showSection(key: SectionKey): void {
    this.current = key;
    for (const b of this.nav.querySelectorAll("button")) {
      b.classList.toggle("is-active", (b as HTMLElement).dataset.section === key);
    }
    this.content.replaceChildren(this.renderSection(key));
  }

  private renderSection(key: SectionKey): HTMLElement {
    switch (key) {
      case "org": return this.renderOrgSection();
      case "members": return this.renderMembersSection();
      default: {
        // Stub — real content lands in Tasks 7-8.
        const el = document.createElement("div");
        el.className = `canon-cockpit-section is-${key}`;
        el.textContent = key;
        return el;
      }
    }
  }

  /** The org this cockpit is scoped to: the group's saved choice, else the
   *  personal org, else the first org, else null. Mirrors CanonPanel's
   *  `activeOrg()` in panel.ts — keep the resolution order in sync. */
  private activeOrg(): Org | null {
    if (this.opts.orgs.length === 0) return null;
    const saved = this.opts.getActiveOrg();
    if (saved) {
      const hit = this.opts.orgs.find((o) => o.slug === saved);
      if (hit) return hit;
    }
    return this.opts.orgs.find((o) => o.personal) ?? this.opts.orgs[0];
  }

  private note(text: string): HTMLElement {
    const p = document.createElement("p");
    p.className = "canon-cockpit-note";
    p.textContent = text;
    return p;
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

  private renderOrgSection(): HTMLElement {
    const el = document.createElement("div");
    el.className = "canon-cockpit-section is-org";
    const active = this.activeOrg();

    const head = document.createElement("div");
    head.className = "canon-cockpit-org-active";
    if (active) {
      const name = document.createElement("h2");
      name.className = "canon-cockpit-org-name";
      name.textContent = active.name;
      const meta = document.createElement("div");
      meta.className = "canon-cockpit-org-meta";
      meta.textContent = `${active.slug} · ${active.role}`;
      head.append(name, meta);
    } else {
      head.appendChild(this.note("No organization selected."));
    }
    el.appendChild(head);

    if (this.opts.orgs.length > 0) {
      const switcher = document.createElement("div");
      switcher.className = "canon-cockpit-org-switcher";
      for (const org of this.opts.orgs) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "canon-cockpit-org-row";
        if (active && org.slug === active.slug) row.classList.add("is-active");
        row.textContent = org.name;
        attachTooltip(row, `${org.slug} · ${org.role}`);
        row.addEventListener("click", () => {
          this.opts.setActiveOrg(org.slug);
          this.showSection("org");
        });
        switcher.appendChild(row);
      }
      el.appendChild(switcher);
    }

    el.appendChild(this.renderCreateOrgRow());
    return el;
  }

  private renderCreateOrgRow(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "canon-cockpit-org-create";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Organization name";
    const slugInput = document.createElement("input");
    slugInput.type = "text";
    slugInput.placeholder = "slug";
    let slugEdited = false;
    slugInput.addEventListener("input", () => { slugEdited = true; });
    nameInput.addEventListener("input", () => {
      if (!slugEdited) slugInput.value = slugify(nameInput.value);
    });

    const errorEl = document.createElement("p");
    errorEl.className = "canon-cockpit-error";
    errorEl.hidden = true;

    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.textContent = "Create organization";
    createBtn.addEventListener("click", () => {
      const name = nameInput.value.trim();
      const slug = slugInput.value.trim();
      if (!name || !slug) {
        errorEl.hidden = false;
        errorEl.textContent = "Name and slug required.";
        return;
      }
      errorEl.hidden = true;
      createBtn.disabled = true;
      void canonCreateOrg(slug, name)
        .then(() => {
          this.opts.setActiveOrg(slug);
          this.showSection("org");
        })
        .catch((e) => {
          errorEl.hidden = false;
          errorEl.textContent = this.friendlyError(e);
        })
        .finally(() => { createBtn.disabled = false; });
    });

    wrap.append(nameInput, slugInput, createBtn, errorEl);
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
}
