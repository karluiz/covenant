import { formatChord } from "../platform";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
  drawSelection,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";

import { Icons } from "../icons";
import { currentEditorMode, editorHighlight, editorTheme } from "../structure/theme";
import { draftsApi, type DraftDocument, type SuggestSection } from "./api";

export interface DraftWizardOpts {
  host: HTMLElement;
  repoRoot: string;
  slug: string | null;
  onBack: () => void;
  onClose: () => void;
  autoPublish?: boolean;
  /** Pre-populate the editor from a spec markdown string (e.g. emitted by the agent). */
  initialBody?: string;
  /** When true, publish to `.covenant/canon/context/` instead of `docs/specs/`. */
  canonContext?: boolean;
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
  {
    key: "Goal", label: "Goal",
    hint: "One sentence. The user-visible problem this resolves.",
    placeholder:
`One sentence describing the outcome (not the implementation).

Examples:
  Open an in-app reference without leaving Covenant when I forget what AOM does.
  Allow the Operator to escalate before consuming a session's full token budget.
  Persist tab order across restarts so my workspace is the same every morning.`,
    required: true,
  },
  {
    key: "Out of scope", label: "Out of scope",
    hint: "What looks related but is NOT this task — the broader, the safer.",
    placeholder:
`Bullets. The agent uses this to recognize when it's drifting and should stop.

- Refactors of unrelated modules (e.g. don't touch storage just because you're nearby).
- Adjacent UX improvements that deserve their own spec.
- Performance tuning unless it blocks the goal.
- Schema migrations beyond what this feature requires.`,
    helpSection: "out-of-scope", required: false,
  },
  {
    key: "Acceptance criteria", label: "Acceptance criteria",
    hint: "3–5 observable bullets. The agent uses these to know when to stop.",
    // Getter, not a literal: this sample names a real Covenant chord, and
    // the platform isn't known when this module is evaluated.
    get placeholder() {
      return `Each bullet must be checkable by hand or by a test.

- [ ] User can press ${formatChord(["mod", "K"])} and see the agent's last decision.
- [ ] Selecting a suggestion calls \`apply_suggestion\` and updates the tab.
- [ ] Closing the panel returns focus to the active terminal.
- [ ] \`cargo test -p covenant\` passes (no regression).`;
    },
    helpSection: "acceptance-criteria", required: true,
  },
  {
    key: "File boundaries", label: "File boundaries",
    hint: "Hint at the blast radius. Lets the agent escalate instead of widening silently.",
    placeholder:
`- **Create**: \`crates/app/src/foo.rs\` (≤ 250 lines)
- **Touch**: \`ui/src/main.ts\` (≤ 20 lines), \`ui/src/api.ts\` (≤ 10 lines)
- **DO NOT touch**: \`crates/agent/\`, \`crates/operator/\`, anything outside the feature surface.`,
    required: false,
  },
  {
    key: "Complexity", label: "Complexity",
    hint: "How big is this? Used to decide if it fits one AOM session.",
    placeholder: "small",
    required: true,
  },
  {
    key: "Open questions", label: "Open questions",
    hint: "Decisions the agent must NOT make alone — escalate instead.",
    placeholder:
`If any. Each item makes the agent pause for your call rather than guess.

- Should drafts be selectable as missions, or always require publish first?
- What's the fallback when the LLM cap is reached mid-session?
- Default cadence for the autosave: 1.5s vs 5s?`,
    helpSection: "open-questions", required: false,
  },
];

const COMPLEXITY_VALUES = ["small", "medium", "large"] as const;

export class DraftWizard {
  private title = "Untitled draft";
  private slug: string | null;
  private values = new Map<string, string>();
  private complexity: typeof COMPLEXITY_VALUES[number] = "small";
  private llmCalls = 0;
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
    } else if (this.opts.initialBody) {
      const sections = parseBody(this.opts.initialBody);
      for (const s of SECTIONS) {
        this.values.set(s.key, sections.get(s.key) ?? "");
      }
      // Seed complexity if valid
      const cmpx = (sections.get("Complexity") ?? "").trim().toLowerCase();
      if ((COMPLEXITY_VALUES as readonly string[]).includes(cmpx)) {
        this.complexity = cmpx as typeof COMPLEXITY_VALUES[number];
        this.values.set("Complexity", this.complexity);
      }
    } else {
      for (const s of SECTIONS) this.values.set(s.key, "");
    }
    this.render();
    this.autoSaveInterval = setInterval(() => { if (this.dirty) void this.save(); }, 30_000);
    if (this.opts.autoPublish && this.slug) {
      queueMicrotask(() => { void this.openPublishModal(); });
    }
  }

  dispose(): void {
    this.debounced.cancel();
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
          <button id="wiz-save" type="button" class="drafts-secondary">Save</button>
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
      ? `<button type="button" class="wiz-help" data-help="${s.helpSection}" data-section-label="${escapeAttr(s.label)}" ${this.llmCalls >= 20 ? "disabled" : ""}>${Icons.sparkles({ size: 13 })}<span>Help</span></button>`
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
      const mode = currentEditorMode();

      const view = new EditorView({
        state: EditorState.create({
          doc: initialValue,
          extensions: [
            editorTheme(mode),
            editorHighlight(mode),
            highlightActiveLine(),
            drawSelection(),
            history(),
            bracketMatching(),
            indentOnInput(),
            EditorView.lineWrapping,
            cmPlaceholder(s.placeholder),
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
    const ok = canPublish(this.values);
    const btn = this.opts.host.querySelector<HTMLButtonElement>("#wiz-publish");
    if (btn) btn.disabled = !ok;
  }

  private readonly debounced = createDebouncedSaver(1500, () => { void this.save(); });

  private markDirty(): void {
    this.dirty = true;
    this.debounced.trigger();
  }

  private buildBody(): string {
    return buildBody(this.title, this.values, SECTIONS.map(s => s.key));
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
    const sectionLabel = btn.dataset.sectionLabel ?? section;
    if (!this.slug) await this.save();
    const helpLabelHtml = `${Icons.sparkles({ size: 13 })}<span>Help</span>`;
    btn.disabled = true;
    btn.innerHTML = `${Icons.sparkles({ size: 13 })}<span>…</span>`;
    let suggestions: string[];
    try {
      suggestions = await draftsApi.suggest(this.opts.repoRoot, this.slug!, section);
    } catch (e) {
      btn.innerHTML = `${Icons.sparkles({ size: 13 })}<span>unavailable</span>`;
      console.error(e);
      return;
    } finally {
      btn.disabled = false;
    }
    btn.innerHTML = helpLabelHtml;
    this.showSuggestionsPopover(btn, section, sectionLabel, suggestions);
  }

  private showSuggestionsPopover(
    anchor: HTMLElement,
    section: SuggestSection,
    sectionLabel: string,
    suggestions: string[],
  ): void {
    const existing = document.getElementById("wiz-popover");
    existing?.remove();
    const popover = document.createElement("div");
    popover.id = "wiz-popover";
    popover.className = "wiz-popover";

    const renderBody = (items: string[], regenerating: boolean): string => {
      if (regenerating) {
        return `<div class="wiz-popover-empty">${Icons.sparkles({ size: 14 })} Generating…</div>`;
      }
      if (items.length === 0) {
        return `<div class="wiz-popover-empty">No suggestions for this section yet — try filling in a bit more context first.</div>`;
      }
      return `<ul class="wiz-popover-list">${items
        .map(
          (s, i) => `
        <li class="wiz-popover-card">
          <p class="wiz-popover-text">${escapeHtml(s)}</p>
          <button type="button" class="wiz-popover-insert" data-i="${i}">
            ${Icons.plus({ size: 12 })}<span>Insert</span>
          </button>
        </li>`,
        )
        .join("")}</ul>`;
    };

    const render = (items: string[], regenerating = false): void => {
      popover.innerHTML = `
        <header class="wiz-popover-head">
          <div class="wiz-popover-head-title">
            ${Icons.sparkles({ size: 13 })}
            <span>Suggestions for <strong>${escapeHtml(sectionLabel)}</strong></span>
          </div>
          <button type="button" class="wiz-popover-x" aria-label="Close">${Icons.x({ size: 14 })}</button>
        </header>
        <div class="wiz-popover-body">${renderBody(items, regenerating)}</div>
        <footer class="wiz-popover-foot">
          <button type="button" class="wiz-popover-regen" ${regenerating ? "disabled" : ""}>
            ${Icons.refresh({ size: 12 })}<span>Regenerate</span>
          </button>
        </footer>
      `;
      wireHandlers(items);
    };

    const sectionKey = sectionToKey(section);
    const insertSuggestion = (text: string): void => {
      const view = this.editors.get(sectionKey);
      if (!view) return;
      const doc = view.state.doc;
      const current = doc.toString();
      const sep = current.endsWith("\n") || current === "" ? "" : "\n";
      const insertBlob = `${sep}- ${text}\n`;
      view.dispatch({
        changes: { from: doc.length, insert: insertBlob },
        scrollIntoView: true,
      });
      // Brief flash on the inserted range so the user sees where it landed.
      const dom = view.contentDOM;
      dom.classList.add("wiz-editor-flash");
      window.setTimeout(() => dom.classList.remove("wiz-editor-flash"), 900);
      // Don't dismiss — user might want to insert another suggestion.
    };

    const close = (): void => {
      popover.remove();
      document.removeEventListener("keydown", onKey);
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };

    const wireHandlers = (items: string[]): void => {
      popover.querySelectorAll<HTMLButtonElement>(".wiz-popover-insert").forEach((b) => {
        b.addEventListener("click", () => {
          const i = Number(b.dataset.i!);
          insertSuggestion(items[i]!);
        });
      });
      popover.querySelector<HTMLButtonElement>(".wiz-popover-x")
        ?.addEventListener("click", close);
      popover.querySelector<HTMLButtonElement>(".wiz-popover-regen")
        ?.addEventListener("click", async () => {
          render([], true);
          try {
            const next = await draftsApi.suggest(this.opts.repoRoot, this.slug!, section);
            render(next);
          } catch (e) {
            console.error(e);
            render(items);
          }
        });
    };

    document.body.appendChild(popover);
    render(suggestions);
    document.addEventListener("keydown", onKey);

    const rect = anchor.getBoundingClientRect();
    popover.style.position = "absolute";
    popover.style.top = `${rect.bottom + window.scrollY + 4}px`;
    popover.style.left = `${rect.left + window.scrollX}px`;
    // Clamp inside viewport so the popover never bleeds off the right edge.
    const popRect = popover.getBoundingClientRect();
    const margin = 8;
    if (popRect.right > window.innerWidth - margin) {
      const alignedLeft = rect.right - popRect.width + window.scrollX;
      const clampedLeft = Math.max(margin + window.scrollX, alignedLeft);
      popover.style.left = `${clampedLeft}px`;
    }
  }

  private async openPublishModal(): Promise<void> {
    await this.save();
    const suggestedId = await draftsApi.nextId(this.opts.repoRoot);
    const suggestedSlug = slugify(this.title);

    // Build modal DOM
    const backdrop = document.createElement("div");
    backdrop.className = "wiz-modal-backdrop";

    const card = document.createElement("div");
    card.className = "wiz-modal";

    const renderPreview = (): string => {
      const idVal = (card.querySelector<HTMLInputElement>("#pub-id")?.value ?? "").trim();
      const slugVal = (card.querySelector<HTMLInputElement>("#pub-slug")?.value ?? "").trim();
      return `docs/specs/${idVal}-${slugVal}.md`;
    };

    const validate = (): { idOk: boolean; slugOk: boolean } => {
      const idVal = (card.querySelector<HTMLInputElement>("#pub-id")?.value ?? "").trim();
      const slugVal = (card.querySelector<HTMLInputElement>("#pub-slug")?.value ?? "").trim();
      return {
        idOk: /^\d+\.\d+$/.test(idVal),
        slugOk: /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slugVal),
      };
    };

    card.innerHTML = `
      <h3>Publish draft</h3>
      <label for="pub-id">Spec ID</label>
      <input id="pub-id" type="text" value="${escapeAttr(suggestedId)}" autocomplete="off" spellcheck="false" />
      <div class="wiz-modal-error" id="pub-id-err" style="display:none">Must match &lt;u32&gt;.&lt;u32&gt; (e.g. 3.10)</div>
      <label for="pub-slug">Slug</label>
      <input id="pub-slug" type="text" value="${escapeAttr(suggestedSlug)}" autocomplete="off" spellcheck="false" />
      <div class="wiz-modal-error" id="pub-slug-err" style="display:none">Must be kebab-case (e.g. my-feature)</div>
      <div class="wiz-modal-preview" id="pub-preview">docs/specs/${escapeHtml(suggestedId)}-${escapeHtml(suggestedSlug)}.md</div>
      <div class="wiz-modal-error" id="pub-api-err" style="display:none"></div>
      <div class="wiz-modal-actions">
        <button id="pub-cancel" type="button">Cancel</button>
        <button id="pub-confirm" type="button" class="primary">Publish</button>
      </div>
    `;

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    const idInput = card.querySelector<HTMLInputElement>("#pub-id")!;
    const slugInput = card.querySelector<HTMLInputElement>("#pub-slug")!;
    const preview = card.querySelector<HTMLDivElement>("#pub-preview")!;
    const idErr = card.querySelector<HTMLDivElement>("#pub-id-err")!;
    const slugErr = card.querySelector<HTMLDivElement>("#pub-slug-err")!;
    const apiErr = card.querySelector<HTMLDivElement>("#pub-api-err")!;
    const confirmBtn = card.querySelector<HTMLButtonElement>("#pub-confirm")!;
    const cancelBtn = card.querySelector<HTMLButtonElement>("#pub-cancel")!;

    const updateState = (): void => {
      const { idOk, slugOk } = validate();
      idInput.classList.toggle("invalid", !idOk);
      slugInput.classList.toggle("invalid", !slugOk);
      idErr.style.display = idOk ? "none" : "";
      slugErr.style.display = slugOk ? "none" : "";
      confirmBtn.disabled = !idOk || !slugOk;
      preview.textContent = renderPreview();
    };

    idInput.addEventListener("input", updateState);
    slugInput.addEventListener("input", updateState);
    updateState();

    const close = (): void => {
      backdrop.remove();
      // Return focus to publish button if still in DOM
      this.opts.host.querySelector<HTMLButtonElement>("#wiz-publish")?.focus();
    };

    cancelBtn.addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

    const escHandler = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.stopPropagation(); close(); document.removeEventListener("keydown", escHandler, true); }
    };
    document.addEventListener("keydown", escHandler, true);

    confirmBtn.addEventListener("click", () => {
      void (async () => {
        const id = idInput.value.trim();
        const finalSlug = slugInput.value.trim();
        confirmBtn.disabled = true;
        apiErr.style.display = "none";
        try {
          const dest = await draftsApi.publish(this.opts.repoRoot, this.slug!, id, finalSlug, this.opts.canonContext);
          document.removeEventListener("keydown", escHandler, true);
          backdrop.remove();
          this.showPublishedToast(dest, id, finalSlug);
        } catch (e) {
          apiErr.textContent = `Publish failed: ${String(e)}`;
          apiErr.style.display = "";
          confirmBtn.disabled = false;
        }
      })();
    });

    idInput.focus();
  }

  private showPublishedToast(destPath: string, id: string, _slug: string): void {
    const toast = document.createElement("div");
    toast.className = "drafts-toast";
    toast.innerHTML = `
      <span>Published as <strong>${escapeHtml(id)}</strong></span>
      <button id="toast-open" type="button">Open in Set Spec</button>
      <button class="drafts-toast-close" type="button" aria-label="Close">×</button>
    `;
    document.body.appendChild(toast);

    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => { toast.remove(); }, 8000);

    const closeToast = (): void => {
      if (timer) { clearTimeout(timer); timer = null; }
      toast.remove();
    };

    toast.querySelector(".drafts-toast-close")?.addEventListener("click", closeToast);
    toast.querySelector("#toast-open")?.addEventListener("click", () => {
      closeToast();
      window.dispatchEvent(new CustomEvent("mission:set", { detail: { path: destPath } }));
      this.opts.onBack();
    });
  }
}

// ---------------------------------------------------------------------------
// Exported pure helpers (tested in wizard.test.ts)
// ---------------------------------------------------------------------------

/** Returns true when all three required publish fields have content. */
export function canPublish(values: Map<string, string>): boolean {
  const goal = (values.get("Goal") ?? "").trim();
  const accept = (values.get("Acceptance criteria") ?? "").trim();
  const complexity = (values.get("Complexity") ?? "").trim();
  return goal.length > 0 && accept.length > 0 && complexity.length > 0;
}

export interface DebouncedSaver {
  trigger(): void;
  flush(): void;
  cancel(): void;
}

/** Creates a debounced save helper. Exported for testing with fake timers. */
export function createDebouncedSaver(delayMs: number, save: () => void): DebouncedSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    trigger() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; save(); }, delayMs);
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; save(); }
    },
    cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}

/**
 * Builds a markdown body from title + section values.
 * Exported for testing; the wizard class delegates to this.
 */
export function buildBody(title: string, values: Map<string, string>, sectionKeys: string[]): string {
  const lines: string[] = [`# Draft — ${title}`, ""];
  for (const key of sectionKeys) {
    lines.push(`## ${key}`);
    lines.push(values.get(key) ?? "");
    lines.push("");
  }
  return lines.join("\n");
}

export function parseBody(body: string): Map<string, string> {
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
