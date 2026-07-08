import "./styles.css";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { pushInfoToast } from "../notifications/toast";
import { renderMarkdown } from "../mission/preview";
import type { CanonStatus, Org, CanonEvalProgress } from "../api";
import {
  canonLocalStatus, canonMyOrgs, canonPublish,
  canonReadLocal, canonExport, canonRunEvals, onCanonEvalProgress,
} from "../api";
import { resolveActiveOrg, orgInitials, orgHue } from "./org";
import { openCreateOrgExperience } from "./create-org/view";
// Re-exported so existing consumers (cockpit, tests) keep importing from
// "../panel"; the definitions live in ./org to avoid a panel↔create-org cycle.
export { slugify, orgInitials, orgHue } from "./org";

/** Format a token count for the compact inference readout: 1500 → "1.5k",
 *  2_400_000 → "2.4M". Shared with the cockpit's Loop section. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** One labelled cell of the inference stat strip. `hero` tints the value with
 *  the group accent — the loop's standout number. Shared with the cockpit's
 *  Loop section. */
export function statCell(value: string, label: string, hero = false): HTMLElement {
  const cell = document.createElement("div");
  cell.className = hero ? "canon-stat is-hero" : "canon-stat";
  const v = document.createElement("span");
  v.className = "canon-stat-val";
  v.textContent = value;
  const l = document.createElement("span");
  l.className = "canon-stat-lbl";
  l.textContent = label;
  cell.append(v, l);
  return cell;
}

/** A labelled progress meter: name + value on top, a thin accent bar below.
 *  Used for adoption (installs, scaled to the busiest skill) and eval
 *  pass-rate. Shared with the cockpit's Loop section. */
export function meterRow(name: string, value: string, pct: number, ok = false): HTMLElement {
  const row = document.createElement("div");
  row.className = "canon-meter";
  const top = document.createElement("div");
  top.className = "canon-meter-top";
  const n = document.createElement("span");
  n.className = "canon-name";
  n.textContent = name;
  const v = document.createElement("span");
  v.className = "canon-meta";
  v.textContent = value;
  top.append(n, v);
  const track = document.createElement("div");
  track.className = "canon-bar";
  const fill = document.createElement("div");
  fill.className = ok ? "canon-bar-fill is-ok" : "canon-bar-fill";
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  track.appendChild(fill);
  row.append(top, track);
  return row;
}

/** Drop a leading YAML frontmatter block (--- … ---) so it doesn't render as
 *  a paragraph. The skill name already lives in the reader header. */
function stripFrontmatter(md: string): string {
  return md.replace(/^﻿?\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
}

/** Full-screen rendered-markdown reader for a SKILL.md — same vibe as the
 *  spec preview. renderMarkdown HTML-escapes every segment, so the untrusted
 *  registry content is safe to innerHTML here. Esc / backdrop / esc button closes. */
export function openMarkdownReader(
  title: string,
  fetchMd: () => Promise<string>,
  stats?: string[],
): void {
  const overlay = document.createElement("div");
  overlay.className = "canon-reader";
  overlay.innerHTML = `
    <header class="canon-reader-head">
      <div class="canon-reader-headings">
        <span class="canon-reader-title"></span>
        <span class="canon-reader-stats"></span>
      </div>
      <button type="button" class="canon-reader-close" aria-label="Close (Esc)"><kbd class="settings-esc">esc</kbd></button>
    </header>
    <article class="canon-reader-body mission-page-preview-body">Loading…</article>`;
  (overlay.querySelector(".canon-reader-title") as HTMLElement).textContent = title;
  const statsEl = overlay.querySelector(".canon-reader-stats") as HTMLElement;
  if (stats && stats.length) statsEl.textContent = stats.join("  ·  ");
  else statsEl.remove();
  const body = overlay.querySelector(".canon-reader-body") as HTMLElement;

  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  overlay.querySelector(".canon-reader-close")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
  void fetchMd()
    .then((md) => { body.innerHTML = renderMarkdown(stripFrontmatter(md).trim() || "(empty)"); })
    .catch((e) => { body.textContent = `Failed to load: ${String(e)}`; });
}

/** A skill/package card: name + meta + actions, a one-line description,
 *  and a Preview toggle that lazy-loads the full SKILL.md (rendered as
 *  plain text — registry content is untrusted, never innerHTML). Shared by
 *  the rail panel (CanonPanel) and the cockpit's Skills/Registry sections. */
export function skillCard(opts: {
  name: string;
  meta: string;
  description?: string;
  className: string;
  fetchPreview: () => Promise<string>;
  actions: HTMLButtonElement[];
  stats?: string[];
}): HTMLElement {
  const card = document.createElement("div");
  card.className = opts.className;

  const head = document.createElement("div");
  head.className = "canon-card-head";
  const name = document.createElement("span");
  name.className = "canon-name";
  name.textContent = opts.name;
  const meta = document.createElement("span");
  meta.className = "canon-meta";
  meta.textContent = opts.meta;
  head.append(name, meta);

  const pre = document.createElement("pre");
  pre.className = "canon-preview";
  pre.hidden = true;
  let loaded = false;
  const prev = document.createElement("button");
  prev.className = "canon-preview-btn canon-icon-btn";
  prev.innerHTML = Icons.eye({ size: 15 });
  prev.setAttribute("aria-label", "Preview");
  attachTooltip(prev, "Preview SKILL.md");
  prev.addEventListener("click", () => {
    const show = pre.hidden;
    pre.hidden = !show;
    prev.innerHTML = show ? Icons.eyeOff({ size: 15 }) : Icons.eye({ size: 15 });
    if (show && !loaded) {
      loaded = true;
      pre.textContent = "Loading…";
      void opts.fetchPreview()
        .then((md) => { pre.textContent = md.trim() || "(empty)"; })
        .catch((e) => { pre.textContent = `Failed to load: ${String(e)}`; loaded = false; });
    }
  });
  const expand = iconButton(
    Icons.maximize({ size: 14 }),
    "Open full screen",
    () => openMarkdownReader(opts.name, opts.fetchPreview, opts.stats),
  );
  head.append(prev, expand, ...opts.actions);
  card.appendChild(head);

  if (opts.description?.trim()) {
    const desc = document.createElement("p");
    desc.className = "canon-result-desc";
    desc.textContent = opts.description;
    card.appendChild(desc);
  }
  card.appendChild(pre);
  return card;
}

/** Compact square action button: an icon + a tooltip (no visible text), so
 *  rows stay legible in the narrow rail. The SVG string is trusted (from Icons). */
export function iconButton(svg: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "canon-icon-btn";
  b.innerHTML = svg;
  b.setAttribute("aria-label", label);
  attachTooltip(b, label);
  b.addEventListener("click", onClick);
  return b;
}

/** A downward chevron for the org chip — trusted static markup. */
const CANON_CHEVRON =
  '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** The signature device: a sharp initials tile carrying the org's identity
 *  color, reused in the chip and every menu row. Color lives in CSS via the
 *  --mono-h custom property so light/dark can tune tone. */
function orgMonogram(org: Org): HTMLElement {
  const m = document.createElement("span");
  m.className = "canon-mono";
  m.textContent = orgInitials(org.name);
  m.style.setProperty("--mono-h", String(orgHue(org.slug)));
  return m;
}

export interface CanonPanelOpts {
  groupId: string;
  groupLabel: string;
  groupColor?: string | null;
  groupRootDir?: string | null;
  onClose?: () => void;
  /** Open a folder picker to set the group's project folder (empty state CTA). */
  onPickFolder?: () => void;
  /** Active Canon org slug for this group (from the tab manifest), or null. */
  getActiveOrg?: () => string | null;
  /** Persist the chosen org slug on the group. */
  setActiveOrg?: (slug: string | null) => void;
  /** Open the full-screen Canon cockpit for this group. Construction (and
   *  any manager access it needs) stays in main.ts — the panel never
   *  imports manager internals. */
  onExpand?: () => void;
}

export class CanonPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private orgChip: HTMLElement;
  private orgs: Org[] = [];

  /** The root element of the panel — used in tests and by callers that need
   *  to query the rendered content without going through a host element. */
  get element(): HTMLElement { return this.root; }

  constructor(private opts: CanonPanelOpts) {
    this.root = document.createElement("div");
    this.root.className = "canon-panel";

    const head = document.createElement("div");
    head.className = "canon-head";
    if (opts.groupColor) head.style.setProperty("--canon-accent", opts.groupColor);
    const mark = document.createElement("span");
    mark.className = "canon-mark";
    head.appendChild(mark);
    const title = document.createElement("span");
    title.className = "canon-title";
    title.textContent = `Canon — ${opts.groupLabel}`;
    head.appendChild(title);

    // Head holds only chrome (title + expand). Closing is handled by the rail
    // toggle in the titlebar, so no redundant × here. The org selector and
    // Project action live in a toolbar at the top of the body — the narrow
    // rail head can't fit them without truncating the title.
    if (opts.onExpand) {
      head.appendChild(iconButton(Icons.maximize({ size: 14 }), "Open Canon full screen", () => opts.onExpand?.()));
    }

    // Toolbar: active-org selector + Project. Persistent (not wiped by
    // renderStatus, which only rewrites `body`), so it sits between head and body.
    const toolbar = document.createElement("div");
    toolbar.className = "canon-toolbar";
    this.orgChip = this.renderOrgChip();
    toolbar.appendChild(this.orgChip);

    // Project every Canon source (agents/skills/context) to executor-native files.
    if (opts.groupRootDir) {
      const exportBtn = document.createElement("button");
      exportBtn.className = "canon-project-btn";
      exportBtn.innerHTML = Icons.boxes({ size: 14 }) + "<span>Project</span>";
      attachTooltip(exportBtn, "Project Canon to executors (.claude, AGENTS.md, copilot)");
      exportBtn.addEventListener("click", () => void this.exportNow(exportBtn));
      toolbar.appendChild(exportBtn);
    }

    this.body = document.createElement("div");
    this.body.className = "canon-body";

    this.root.append(head, toolbar, this.body);
  }

  setOrgs(orgs: Org[]): void {
    this.orgs = orgs;
    this.updateOrgChip();
  }

  /** The org whose registry this group works against: the group's saved
   *  choice, else the personal org, else the first org, else null. */
  activeOrg(): Org | null {
    return resolveActiveOrg(this.orgs, this.opts.getActiveOrg?.() ?? null);
  }

  private updateOrgChip(): void {
    this.fillChip(this.orgChip);
  }

  private renderOrgChip(): HTMLElement {
    const chip = document.createElement("button");
    chip.className = "canon-org-chip";
    attachTooltip(chip, "Switch organization");
    chip.addEventListener("click", () => this.openOrgMenu(chip));
    this.fillChip(chip);
    return chip;
  }

  /** (Re)build the chip's contents: monogram + name + role + chevron, or a
   *  quiet empty state when the caller belongs to no org. */
  private fillChip(chip: HTMLElement): void {
    const active = this.activeOrg();
    chip.replaceChildren();
    chip.classList.toggle("is-empty", !active);
    const caret = document.createElement("span");
    caret.className = "canon-org-chip-caret";
    caret.innerHTML = CANON_CHEVRON;
    if (!active) {
      const name = document.createElement("span");
      name.className = "canon-org-chip-name";
      name.textContent = "No organization";
      chip.append(name, caret);
      return;
    }
    const text = document.createElement("span");
    text.className = "canon-org-chip-text";
    const name = document.createElement("span");
    name.className = "canon-org-chip-name";
    name.textContent = active.name;
    const role = document.createElement("span");
    role.className = "canon-org-chip-role";
    role.textContent = active.role;
    text.append(name, role);
    chip.append(orgMonogram(active), text, caret);
  }

  /** A lightweight absolutely-positioned menu listing every org the caller
   *  belongs to (checkmark on the active one) plus a "Create organization…"
   *  row. Dismissed on outside-click or Esc. */
  private openOrgMenu(anchor: HTMLElement): void {
    const existing = document.querySelector(".canon-org-menu");
    if (existing) { existing.remove(); return; }

    const menu = document.createElement("div");
    menu.className = "canon-org-menu";
    const active = this.activeOrg();

    const close = (): void => {
      menu.remove();
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("keydown", onKey);
    };
    const onOutside = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node) && e.target !== anchor) close();
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };

    for (const org of this.orgs) {
      const row = document.createElement("button");
      row.className = "canon-org-menu-row";
      const isActive = !!active && org.slug === active.slug;
      if (isActive) row.classList.add("is-active");
      const name = document.createElement("span");
      name.className = "canon-org-menu-name";
      name.textContent = org.name;
      const role = document.createElement("span");
      role.className = "canon-org-menu-role";
      role.textContent = isActive ? "current" : org.role;
      row.append(orgMonogram(org), name, role);
      row.addEventListener("click", () => {
        this.opts.setActiveOrg?.(org.slug);
        close();
        void this.refresh();
      });
      menu.appendChild(row);
    }

    const createRow = document.createElement("button");
    createRow.className = "canon-org-menu-row canon-org-menu-create";
    const tile = document.createElement("span");
    tile.className = "canon-org-create-tile";
    tile.textContent = "+";
    const lbl = document.createElement("span");
    lbl.className = "canon-org-menu-name";
    lbl.textContent = "Create organization";
    createRow.append(tile, lbl);
    createRow.addEventListener("click", () => {
      close();
      openCreateOrgExperience({
        onCreated: (slug) => {
          this.opts.setActiveOrg?.(slug);
          void this.refresh();
        },
      });
    });
    menu.appendChild(createRow);

    // Left-align the menu under the chip and match its width. (Right-aligning
    // made a wide chip's menu extend left, bleeding past the rail edge.)
    const rect = anchor.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${rect.left}px`;
    menu.style.minWidth = `${Math.round(rect.width)}px`;

    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey);

    document.body.appendChild(menu);
    // Clamp if it would overflow the right viewport edge.
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth - 8) {
      menu.style.left = `${Math.max(8, window.innerWidth - 8 - mr.width)}px`;
    }
  }

  /** The group this panel is scoped to — used to re-scope on group switch. */
  get groupId(): string {
    return this.opts.groupId;
  }

  mount(host: HTMLElement): this {
    host.appendChild(this.root);
    void this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd) {
      const empty = document.createElement("div");
      empty.className = "rail-empty";
      empty.innerHTML = Icons.folderPlus({ size: 28 })
        + `<div class="rail-empty-title">No project folder</div>`
        + `<div class="rail-empty-hint">Canon reads skills, agents and context from the group’s repo. Point this group at a folder to get started.</div>`;
      if (this.opts.onPickFolder) {
        const actions = document.createElement("div");
        actions.className = "rail-empty-actions";
        const btn = document.createElement("button");
        btn.className = "rail-empty-btn";
        btn.textContent = "Choose folder…";
        btn.addEventListener("click", () => this.opts.onPickFolder?.());
        actions.appendChild(btn);
        empty.appendChild(actions);
      }
      this.body.replaceChildren(empty);
      return;
    }
    // Loading state on the first fetch only (empty body) — the shared
    // `.rail-notice.is-loading` treatment used by every rail panel (Beacon et
    // al.); background refreshes keep the existing content.
    if (this.body.childElementCount === 0) {
      const loading = document.createElement("div");
      loading.className = "rail-notice is-loading";
      loading.textContent = "Loading Canon";
      this.body.replaceChildren(loading);
    }
    try {
      const [status, orgs] = await Promise.all([
        canonLocalStatus(cwd),
        canonMyOrgs().catch(() => [] as Org[]),
      ]);
      this.orgs = orgs;
      this.updateOrgChip();
      this.renderStatus(status);
    } catch (e) {
      this.body.textContent = `Failed to read Canon: ${String(e)}`;
    }
  }

  /** Compact summary: an installed-skill count + a compact card list.
   *  Registry search, adoption/inference/eval dashboards, and context-file
   *  management now live in the full-screen cockpit (see cockpit/view.ts) —
   *  open it via the expand button in the head for those. */
  renderStatus(s: CanonStatus): void {
    this.body.replaceChildren();
    const cwd = this.opts.groupRootDir ?? null;

    const skills = document.createElement("section");
    skills.className = "canon-skills";
    const sh = document.createElement("h3");
    sh.textContent = "Skills";
    skills.appendChild(sh);
    if (s.installed.length === 0) {
      const p = document.createElement("p");
      p.textContent = "No skills installed.";
      skills.appendChild(p);
    } else {
      const count = document.createElement("p");
      count.className = "canon-skills-count";
      count.textContent = `${s.installed.length} ${s.installed.length === 1 ? "skill" : "skills"} installed`;
      skills.appendChild(count);
      for (const i of s.installed) {
        const actions: HTMLButtonElement[] = [];
        if (this.orgs.length > 0 && !i.source.startsWith("registry:")) {
          actions.push(iconButton(Icons.upload({ size: 15 }), "Publish to registry", () => void this.publish(i.name)));
        }
        const runBtn = iconButton(Icons.play({ size: 15 }), "Run evals", () => void this.runEvals(i.name, runBtn));
        actions.push(runBtn);
        skills.appendChild(skillCard({
          name: i.name,
          meta: `${i.version} · ${i.source}`,
          className: "canon-skill-row",
          fetchPreview: () => (cwd ? canonReadLocal(cwd, i.name) : Promise.resolve("(no project folder)")),
          actions,
          stats: [`v${i.version}`, i.source],
        }));
      }
    }

    this.body.replaceChildren(skills);
  }

  private async runEvals(skill: string, btn: HTMLButtonElement): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd) return;
    if (!window.confirm(`Run evals for "${skill}"? Each eval is a full agent run plus a judge call — this can take minutes and costs tokens.`)) {
      return;
    }
    btn.disabled = true;
    let unlisten: (() => void) | undefined;
    let doneReason = "";
    try {
      unlisten = await onCanonEvalProgress((e: CanonEvalProgress) => {
        if (e.skill !== skill) return;
        if (e.status === "running") pushInfoToast({ message: `Eval ${e.eval_id}: running…` });
        else if (e.status === "pass") pushInfoToast({ message: `Eval ${e.eval_id}: PASS` });
        else if (e.status === "fail") pushInfoToast({ message: `Eval ${e.eval_id}: FAIL — ${e.reason}` });
        else if (e.status === "skipped") pushInfoToast({ message: `Evals skipped: ${e.reason}` });
        else if (e.status === "error") pushInfoToast({ message: `Eval ${e.eval_id}: error — ${e.reason}` });
        else if (e.status === "done") doneReason = e.reason;
      });
      await canonRunEvals(cwd, skill);
      // The backend signals an empty run via the done note — don't claim
      // "finished" when nothing actually ran.
      pushInfoToast({
        message:
          doneReason === "no evals found"
            ? `No evals for ${skill} — add .toml files under .covenant/canon/skills/${skill}/evals/`
            : `Evals finished for ${skill}`,
      });
      await this.refresh();
    } catch (e) {
      pushInfoToast({ message: `Run evals failed: ${String(e)}` });
    } finally {
      unlisten?.();
      btn.disabled = false;
    }
  }

  private async exportNow(btn: HTMLButtonElement): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd) return;
    btn.disabled = true;
    try {
      await canonExport(cwd);
      await this.refresh();
      pushInfoToast({ message: `Canon exported to .claude · AGENTS.md · copilot (${this.opts.groupLabel})` });
    } catch (e) {
      pushInfoToast({ message: `Canon export failed: ${String(e)}` });
    } finally {
      btn.disabled = false;
    }
  }

  private async publish(name: string): Promise<void> {
    const cwd = this.opts.groupRootDir;
    const active = this.activeOrg();
    if (!cwd || !active) return;
    const org = active.slug;
    try {
      await canonPublish(cwd, org, name);
      await this.refresh();
      pushInfoToast({ message: `Published ${name} to ${org}` });
    } catch (e) {
      pushInfoToast({ message: `Publish failed: ${String(e)}` });
    }
  }

  close(): void {
    this.root.remove();
    this.opts.onClose?.();
  }
}
