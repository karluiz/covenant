import "./styles.css";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { pushInfoToast } from "../notifications/toast";
import { renderMarkdown } from "../ui/markdown";
import type { CanonStatus, Org, CanonEvalProgress } from "../api";
import {
  canonLocalStatus, canonMyOrgs, canonPublish,
  canonReadLocal, canonReadSource, canonExport, canonRunEvals, onCanonEvalProgress,
  canonEvalSummary,
} from "../api";
import { liftClass, type LiftBadge } from "./cockpit/lift";
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
    <article class="canon-reader-body mission-page-preview-body markdown-body markdown-doc">Loading…</article>`;
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

/** Right-pointing chevron for fold headers — `.rail-chev` rotates it 90° open. */
const FOLD_CHEVRON =
  '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Hover-revealed row action for the shared `.rail-row-actions` dock. */
function railAction(svg: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "rail-row-action is-neutral";
  b.innerHTML = svg;
  b.setAttribute("aria-label", label);
  attachTooltip(b, label);
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

/** Split a spec slug like "3.1-master-operator-mission" into a mono index and
 *  a readable title: the frontmatter title with its redundant index prefix
 *  stripped, else the de-slugged remainder of the name. */
export function specParts(name: string, title: string): { idx: string; label: string } {
  const idx = /^\d+(?:\.\d+)*/.exec(name)?.[0] ?? "";
  const fromTitle = title.replace(/^\s*\d+(?:\.\d+)*\s*[—–:-]*\s*/, "").trim();
  if (fromTitle) return { idx, label: fromTitle };
  const rest = name.slice(idx.length).replace(/^-+/, "").replace(/-+/g, " ").trim();
  return { idx, label: rest ? rest[0].toUpperCase() + rest.slice(1) : name };
}

/** One row of the rail inventory, materialized by railRow(). */
interface RailRowSpec {
  idx?: string;
  title: string;
  meta?: string;
  /** Extra hover actions (Publish / Run evals); the Open action is implicit. */
  actions?: HTMLButtonElement[];
  onOpen: () => void;
  /** Skill name for lift-badge fill; only set on skill rows. */
  liftName?: string;
}

/** A small lift chip for a skill row — `canon-lift-badge lift-<kind>` + short text. */
export function liftBadgeEl(b: LiftBadge): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = `canon-lift-badge lift-${b.kind}`;
  el.textContent = b.text;
  return el;
}

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
      // Owner-only display-name edit (the slug is the org's identity and
      // never changes). A span, not a button — rows are already <button>s.
      if (org.role === "owner") {
        const edit = document.createElement("span");
        edit.className = "canon-org-menu-edit";
        edit.innerHTML = Icons.pencil({ size: 12 });
        edit.setAttribute("role", "button");
        edit.setAttribute("aria-label", "Rename organization");
        attachTooltip(edit, "Rename organization");
        edit.addEventListener("click", (e) => {
          e.stopPropagation();
          close();
          openCreateOrgExperience({
            rename: { slug: org.slug, name: org.name },
            onCreated: () => void this.refresh(),
          });
        });
        row.appendChild(edit);
      }
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

  /** Compact rail inventory: a census strip (one count cell per kind), then a
   *  fold per POPULATED kind only — empty kinds never render a section, the
   *  census is their single trace. Registry search, adoption/inference/eval
   *  dashboards, and context-file management live in the full-screen cockpit
   *  (see cockpit/view.ts) — open it via the expand button for those. */
  renderStatus(s: CanonStatus): void {
    this.body.replaceChildren();
    const cwd = this.opts.groupRootDir ?? null;
    const readSource = (kind: Parameters<typeof canonReadSource>[1], name: string) => () =>
      cwd ? canonReadSource(cwd, kind, name) : Promise.resolve("(no project folder)");

    const skillSpecs: RailRowSpec[] = s.installed.map((i) => {
      const actions: HTMLButtonElement[] = [];
      if (this.orgs.length > 0 && !i.source.startsWith("registry:")) {
        actions.push(railAction(Icons.upload({ size: 13 }), "Publish to registry", () => void this.publish(i.name)));
      }
      const runBtn = railAction(Icons.play({ size: 13 }), "Run evals", () => void this.runEvals(i.name, runBtn));
      actions.push(runBtn);
      const fetch = () => (cwd ? canonReadLocal(cwd, i.name) : Promise.resolve("(no project folder)"));
      return {
        title: i.name,
        meta: `v${i.version} · ${i.source}`,
        actions,
        onOpen: () => openMarkdownReader(i.name, fetch, [`v${i.version}`, i.source]),
        liftName: i.name,
      };
    });

    const kinds: { label: string; rows: RailRowSpec[] }[] = [
      { label: "Agents", rows: s.agents.map((a) => ({ title: a.name, meta: "agent", onOpen: () => openMarkdownReader(a.name, readSource("agent", a.name)) })) },
      { label: "Context", rows: s.contexts.map((c) => ({ title: c.name, meta: c.summary ?? "context", onOpen: () => openMarkdownReader(c.name, readSource("context", c.name)) })) },
      { label: "Memory", rows: s.memory.map((m) => ({ title: m.name, meta: m.description ?? "memory", onOpen: () => openMarkdownReader(m.name, readSource("memory", m.name)) })) },
      { label: "Commands", rows: s.commands.map((c) => ({ title: c.name, meta: c.description ?? "command", onOpen: () => openMarkdownReader(c.name, readSource("command", c.name)) })) },
      { label: "MCP", rows: s.mcp.map((m) => ({ title: m.name, meta: m.description ?? m.transport, onOpen: () => openMarkdownReader(m.name, readSource("mcp", m.name)) })) },
      { label: "Specs", rows: s.specs.map((sp) => {
        const { idx, label } = specParts(sp.name, sp.title);
        return { idx, title: label, meta: sp.name, onOpen: () => openMarkdownReader(sp.title, readSource("spec", sp.name)) };
      }) },
      { label: "Skills", rows: skillSpecs },
    ];

    // ── Census strip: the whole inventory in one glance ──
    const folds = new Map<string, HTMLElement>();
    const skillRowByName = new Map<string, HTMLElement>();
    const census = document.createElement("div");
    census.className = "canon-census";
    for (const k of kinds) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = k.rows.length > 0 ? "canon-census-cell has" : "canon-census-cell";
      cell.disabled = k.rows.length === 0;
      const n = document.createElement("span");
      n.className = "canon-census-n";
      n.textContent = String(k.rows.length);
      const l = document.createElement("span");
      l.className = "canon-census-k";
      l.textContent = k.label;
      cell.append(n, l);
      cell.addEventListener("click", () => {
        const sec = folds.get(k.label);
        if (!sec) return;
        const head = sec.querySelector<HTMLButtonElement>(".rail-group-head");
        if (head && !head.classList.contains("open")) head.click();
        sec.scrollIntoView?.({ block: "start", behavior: "smooth" });
      });
      census.appendChild(cell);
    }
    this.body.appendChild(census);

    // ── One hint replaces the per-kind "No X authored." wall ──
    const authoredCount = s.agents.length + s.contexts.length + s.memory.length
      + s.commands.length + s.mcp.length + s.installed.length;
    if (authoredCount === 0) {
      const hint = document.createElement("div");
      hint.className = "canon-authored-hint";
      hint.append("Nothing authored yet");
      if (this.opts.onExpand) {
        hint.append(" — ");
        const cta = document.createElement("button");
        cta.type = "button";
        cta.textContent = "open the cockpit";
        cta.addEventListener("click", () => this.opts.onExpand?.());
        hint.append(cta, " to author.");
      } else {
        hint.append(".");
      }
      this.body.appendChild(hint);
    }

    // ── Filter (only once the list is worth filtering) ──
    const allRows: { el: HTMLElement; hay: string; fold: HTMLElement }[] = [];
    const total = kinds.reduce((n, k) => n + k.rows.length, 0);
    let search: HTMLInputElement | null = null;
    if (total > 8) {
      const wrap = document.createElement("div");
      wrap.className = "rail-search";
      wrap.innerHTML = Icons.search({ size: 14 });
      search = document.createElement("input");
      search.type = "search";
      search.placeholder = "Filter…";
      wrap.appendChild(search);
      this.body.appendChild(wrap);
    }

    // ── Folds: populated kinds only ──
    for (const k of kinds) {
      if (k.rows.length === 0) continue;
      const sec = document.createElement("section");
      sec.className = "rail-group canon-group";
      const head = document.createElement("button");
      head.type = "button";
      head.className = "rail-group-head open";
      head.setAttribute("aria-expanded", "true");
      const chev = document.createElement("span");
      chev.className = "rail-chev";
      chev.innerHTML = FOLD_CHEVRON;
      const gname = document.createElement("span");
      gname.className = "rail-gname";
      gname.textContent = k.label;
      const gcount = document.createElement("span");
      gcount.className = "rail-gcount";
      gcount.textContent = String(k.rows.length);
      head.append(chev, gname, gcount);
      const rowsWrap = document.createElement("div");
      rowsWrap.className = "canon-group-rows";
      for (const r of k.rows) {
        const el = this.railRow(r);
        if (r.liftName) skillRowByName.set(r.liftName, el);
        allRows.push({ el, hay: `${r.idx ?? ""} ${r.title} ${r.meta ?? ""}`.toLowerCase(), fold: sec });
        rowsWrap.appendChild(el);
      }
      head.addEventListener("click", () => {
        const open = head.classList.toggle("open");
        head.setAttribute("aria-expanded", String(open));
        rowsWrap.hidden = !open;
      });
      sec.append(head, rowsWrap);
      folds.set(k.label, sec);
      this.body.appendChild(sec);
    }

    // Lift → Adapt: badge each skill row with its context-lift once evals resolve.
    // The chip sits in the name line (next to the skill), not past the actions.
    if (cwd && skillRowByName.size > 0) {
      void canonEvalSummary(cwd)
        .then((summary) => {
          for (const es of summary) {
            const row = skillRowByName.get(es.skill);
            row?.querySelector(".rail-row-line")?.appendChild(liftBadgeEl(liftClass(es)));
          }
        })
        .catch(() => {});
    }

    search?.addEventListener("input", () => {
      const q = search!.value.trim().toLowerCase();
      for (const r of allRows) r.el.hidden = q !== "" && !r.hay.includes(q);
      for (const sec of folds.values()) {
        sec.hidden = allRows.filter((r) => r.fold === sec).every((r) => r.el.hidden);
      }
    });
  }

  /** One flat inventory row: optional mono index + title, a mono meta line,
   *  and a hover-revealed action dock. The whole row opens the reader. */
  private railRow(r: RailRowSpec): HTMLElement {
    const row = document.createElement("div");
    row.className = "rail-row canon-row";
    row.setAttribute("role", "button");
    row.tabIndex = 0;
    const line = document.createElement("div");
    line.className = "rail-row-line";
    if (r.idx) {
      const idx = document.createElement("span");
      idx.className = "canon-idx";
      idx.textContent = r.idx;
      line.appendChild(idx);
    }
    const name = document.createElement("span");
    name.className = "rail-name";
    name.textContent = r.title;
    line.appendChild(name);
    row.appendChild(line);
    if (r.meta) {
      const meta = document.createElement("div");
      meta.className = r.idx ? "rail-meta canon-meta-indent" : "rail-meta";
      meta.textContent = r.meta;
      row.appendChild(meta);
    }
    const acts = document.createElement("div");
    acts.className = "rail-row-actions";
    acts.append(...(r.actions ?? []), railAction(Icons.maximize({ size: 13 }), "Open", r.onOpen));
    row.appendChild(acts);
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".rail-row-actions")) return;
      r.onOpen();
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target === row) r.onOpen();
    });
    return row;
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
