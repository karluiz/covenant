import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";

import { editorHighlight, editorTheme } from "../structure/theme";
import { draftsApi, type DraftDocument, type SuggestSection } from "./api";

export interface DraftWizardOpts {
  host: HTMLElement;
  repoRoot: string;
  slug: string | null;
  onBack: () => void;
  onClose: () => void;
}

interface SectionDef {
  key: string;       // markdown heading (## Goal, etc.)
  label: string;
  hint: string;
  placeholder: string;
  helpSection?: SuggestSection;
  required: boolean;
}

const SECTIONS: SectionDef[] = [
  { key: "Goal", label: "Goal", hint: "One sentence. The user-visible problem this resolves.",
    placeholder: "Open an in-app reference without leaving Covenant when I forget what AOM does.",
    required: true },
  { key: "Out of scope", label: "Out of scope", hint: "What looks related but is NOT this task.",
    placeholder: "- thing the agent might be tempted to also build\n- adjacent improvement",
    helpSection: "out-of-scope", required: false },
  { key: "Acceptance criteria", label: "Acceptance criteria", hint: "3–5 bullets, each observable.",
    placeholder: "- [ ] user can do X via Y\n- [ ] command Z passes",
    helpSection: "acceptance-criteria", required: true },
  { key: "File boundaries", label: "File boundaries", hint: "Hint at the blast radius.",
    placeholder: "- **Create**: `path/to/file.rs` (≤ 200 lines)\n- **DO NOT touch**: `crates/agent/`",
    required: false },
  { key: "Complexity", label: "Complexity", hint: "small | medium | large", placeholder: "small",
    required: true },
  { key: "Open questions", label: "Open questions", hint: "Decisions the agent shouldn't make alone.",
    placeholder: "- decision X\n- tradeoff Y",
    helpSection: "open-questions", required: false },
];

const COMPLEXITY_VALUES = ["small", "medium", "large"] as const;

export class DraftWizard {
  private title = "Untitled draft";
  private slug: string | null;
  private values = new Map<string, string>();
  private complexity: typeof COMPLEXITY_VALUES[number] = "small";
  private llmCalls = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private autoSaveInterval: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  /** CM6 EditorView instances keyed by section key. */
  private editors = new Map<string, EditorView>();

  constructor(private opts: DraftWizardOpts) {
    this.slug = opts.slug;
  }

  async mount(): Promise<void> {
    if (this.slug) {
      try {
        const doc = await draftsApi.read(this.opts.repoRoot, this.slug);
        this.hydrateFromDoc(doc);
      } catch (e) {
        this.opts.host.innerHTML = `<div class="drafts-empty">Failed to load: ${String(e)}</div>`;
        return;
      }
    } else {
      for (const s of SECTIONS) this.values.set(s.key, "");
    }
    this.render();
    this.autoSaveInterval = setInterval(() => { if (this.dirty) void this.save(); }, 30_000);
  }

  dispose(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);
    for (const view of this.editors.values()) view.destroy();
    this.editors.clear();
  }

  private hydrateFromDoc(doc: DraftDocument): void {
    this.title = doc.frontmatter.title;
    this.slug = doc.frontmatter.slug;
    this.llmCalls = doc.frontmatter.llm_calls;
    const sections = parseBody(doc.body);
    for (const s of SECTIONS) {
      const v = sections.get(s.key) ?? "";
      this.values.set(s.key, v);
      if (s.key === "Complexity") {
        const m = v.trim().toLowerCase();
        if ((COMPLEXITY_VALUES as readonly string[]).includes(m)) {
          this.complexity = m as typeof COMPLEXITY_VALUES[number];
        }
      }
    }
  }

  private render(): void {
    // Destroy any existing editor instances before re-rendering DOM.
    for (const view of this.editors.values()) view.destroy();
    this.editors.clear();

    const sectionsHtml = SECTIONS.map(s => this.renderSection(s)).join("");
    this.opts.host.innerHTML = `
      <header class="drafts-header">
        <button id="wiz-back" type="button" class="drafts-back" aria-label="Back">←</button>
        <input id="wiz-title" type="text" class="wiz-title" value="${escapeAttr(this.title)}" />
        <div class="drafts-actions">
          <button id="wiz-save" type="button">Save</button>
          <button id="wiz-publish" type="button" class="drafts-primary" disabled>Publish</button>
          <button id="wiz-close" type="button" class="drafts-close" aria-label="Close">×</button>
        </div>
      </header>
      <div class="wiz-body">${sectionsHtml}</div>
    `;
    this.bindEvents();
    this.mountEditors();
    this.updatePublishEnabled();
  }

  private renderSection(s: SectionDef): string {
    if (s.key === "Complexity") {
      return `
        <section class="wiz-section" data-key="${escapeAttr(s.key)}">
          <h2>${s.label} <span class="wiz-hint">— ${escapeHtml(s.hint)}</span></h2>
          <div class="wiz-segmented">
            ${COMPLEXITY_VALUES.map(v => `
              <button type="button" data-complexity="${v}" class="${this.complexity === v ? "active" : ""}">${v}</button>
            `).join("")}
          </div>
        </section>
      `;
    }
    const helpBtn = s.helpSection
      ? `<button type="button" class="wiz-help" data-help="${s.helpSection}" ${this.llmCalls >= 20 ? "disabled" : ""}>✨ Help</button>`
      : "";
    return `
      <section class="wiz-section" data-key="${escapeAttr(s.key)}">
        <h2>${s.label} <span class="wiz-hint">— ${escapeHtml(s.hint)}</span> ${helpBtn}</h2>
        <div class="wiz-editor" data-key="${escapeAttr(s.key)}"></div>
      </section>
    `;
  }

  /** Mount a CM6 EditorView into every `.wiz-editor` container. */
  private mountEditors(): void {
    for (const s of SECTIONS) {
      if (s.key === "Complexity") continue;
      const container = this.opts.host.querySelector<HTMLDivElement>(
        `.wiz-editor[data-key="${cssEscape(s.key)}"]`
      );
      if (!container) continue;

      const key = s.key;
      const initialValue = this.values.get(key) ?? "";

      const view = new EditorView({
        state: EditorState.create({
          doc: initialValue,
          extensions: [
            editorTheme,
            editorHighlight,
            highlightActiveLine(),
            drawSelection(),
            history(),
            bracketMatching(),
            indentOnInput(),
            EditorView.lineWrapping,
            markdown(),
            keymap.of([
              ...historyKeymap,
              ...defaultKeymap,
            ]),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) {
                this.values.set(key, u.state.doc.toString());
                this.markDirty();
                this.updatePublishEnabled();
              }
            }),
          ],
        }),
        parent: container,
      });

      // Blur → autosave (mirror textarea blur behavior).
      view.contentDOM.addEventListener("blur", () => { void this.save(); });

      this.editors.set(key, view);
    }
  }

  private bindEvents(): void {
    const host = this.opts.host;
    host.querySelector("#wiz-back")?.addEventListener("click", () => { void this.save().then(() => this.opts.onBack()); });
    host.querySelector("#wiz-close")?.addEventListener("click", () => { void this.save().then(() => this.opts.onClose()); });
    host.querySelector("#wiz-save")?.addEventListener("click", () => { void this.save(); });
    host.querySelector("#wiz-publish")?.addEventListener("click", () => { void this.openPublishModal(); });
    (host.querySelector("#wiz-title") as HTMLInputElement | null)?.addEventListener("input", (e) => {
      this.title = (e.target as HTMLInputElement).value;
      this.markDirty();
    });
    host.querySelectorAll<HTMLButtonElement>("[data-complexity]").forEach(btn => {
      btn.addEventListener("click", () => {
        this.complexity = btn.dataset.complexity as typeof COMPLEXITY_VALUES[number];
        this.values.set("Complexity", this.complexity);
        host.querySelectorAll<HTMLButtonElement>("[data-complexity]").forEach(b =>
          b.classList.toggle("active", b === btn));
        this.markDirty();
        this.updatePublishEnabled();
      });
    });
    host.querySelectorAll<HTMLButtonElement>(".wiz-help").forEach(btn => {
      btn.addEventListener("click", () => void this.handleHelp(btn));
    });
  }

  private updatePublishEnabled(): void {
    const goal = (this.values.get("Goal") ?? "").trim();
    const accept = (this.values.get("Acceptance criteria") ?? "").trim();
    const ok = goal.length > 0 && accept.length > 0;
    const btn = this.opts.host.querySelector<HTMLButtonElement>("#wiz-publish");
    if (btn) btn.disabled = !ok;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { void this.save(); }, 1500);
  }

  private buildBody(): string {
    const lines: string[] = [`# Draft — ${this.title}`, ""];
    for (const s of SECTIONS) {
      lines.push(`## ${s.key}`);
      lines.push(this.values.get(s.key) ?? "");
      lines.push("");
    }
    return lines.join("\n");
  }

  private async save(): Promise<void> {
    if (!this.dirty) return;
    if (!this.slug) {
      const base = slugify(this.title);
      this.slug = await this.uniqueSlug(base);
    }
    const body = this.buildBody();
    try {
      const doc = await draftsApi.save(this.opts.repoRoot, this.slug, this.title, body);
      this.llmCalls = doc.frontmatter.llm_calls;
      this.dirty = false;
    } catch (e) {
      console.error("save_draft failed", e);
    }
  }

  private async uniqueSlug(base: string): Promise<string> {
    const existing = new Set((await draftsApi.list(this.opts.repoRoot)).map(d => d.slug));
    if (!existing.has(base)) return base;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  }

  private async handleHelp(btn: HTMLButtonElement): Promise<void> {
    const section = btn.dataset.help as SuggestSection;
    if (!this.slug) await this.save();
    btn.disabled = true;
    btn.textContent = "✨ …";
    let suggestions: string[];
    try {
      suggestions = await draftsApi.suggest(this.opts.repoRoot, this.slug!, section);
    } catch (e) {
      btn.textContent = "✨ unavailable";
      console.error(e);
      return;
    } finally {
      btn.disabled = false;
    }
    btn.textContent = "✨ Help";
    this.showSuggestionsPopover(btn, section, suggestions);
  }

  private showSuggestionsPopover(anchor: HTMLElement, section: SuggestSection, suggestions: string[]): void {
    const existing = document.getElementById("wiz-popover");
    existing?.remove();
    const popover = document.createElement("div");
    popover.id = "wiz-popover";
    popover.className = "wiz-popover";
    popover.innerHTML = suggestions.map((s, i) => `
      <button type="button" class="wiz-suggestion" data-i="${i}">${escapeHtml(s)}</button>
    `).join("") + `<button type="button" class="wiz-popover-close">Dismiss</button>`;
    document.body.appendChild(popover);
    const rect = anchor.getBoundingClientRect();
    popover.style.position = "absolute";
    popover.style.top = `${rect.bottom + window.scrollY + 4}px`;
    popover.style.left = `${rect.left + window.scrollX}px`;
    const sectionKey = sectionToKey(section);
    popover.querySelectorAll<HTMLButtonElement>(".wiz-suggestion").forEach(b => {
      b.addEventListener("click", () => {
        const i = Number(b.dataset.i!);
        const view = this.editors.get(sectionKey);
        if (view) {
          const doc = view.state.doc;
          const current = doc.toString();
          const sep = current.endsWith("\n") || current === "" ? "" : "\n";
          const insert = `${sep}- ${suggestions[i]}\n`;
          view.dispatch({
            changes: { from: doc.length, insert },
          });
          // updateListener will sync this.values + markDirty + updatePublishEnabled.
        }
        popover.remove();
      });
    });
    popover.querySelector(".wiz-popover-close")?.addEventListener("click", () => popover.remove());
  }

  private async openPublishModal(): Promise<void> {
    await this.save();
    const suggestedId = await draftsApi.nextId(this.opts.repoRoot);
    const suggestedSlug = slugify(this.title);
    const id = prompt(`Spec ID (suggested: ${suggestedId}):`, suggestedId);
    if (!id) return;
    const finalSlug = prompt(`Slug (suggested: ${suggestedSlug}):`, suggestedSlug);
    if (!finalSlug) return;
    try {
      const dest = await draftsApi.publish(this.opts.repoRoot, this.slug!, id, finalSlug);
      alert(`Published as ${dest}`);
      this.opts.onBack();
    } catch (e) {
      alert(`Publish failed: ${e}`);
    }
  }
}

function parseBody(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = body.split("\n");
  let current: string | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) out.set(current, buf.join("\n").trim());
      current = m[1];
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  if (current) out.set(current, buf.join("\n").trim());
  return out;
}

function slugify(title: string): string {
  const out = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "untitled";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]!));
}
function escapeAttr(s: string): string { return escapeHtml(s); }
function cssEscape(s: string): string { return s.replace(/"/g, '\\"'); }
function sectionToKey(s: SuggestSection): string {
  return s === "out-of-scope" ? "Out of scope"
    : s === "acceptance-criteria" ? "Acceptance criteria"
    : "Open questions";
}
