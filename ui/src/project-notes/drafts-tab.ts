import {
  specAuthorListDrafts as defaultListDrafts,
  specAuthorDeleteDraft as defaultDeleteDraft,
  type SpecDraftSummary,
} from "../api";
import { Icons } from "../icons";

export interface DraftsTabOpts {
  groupId: string;
  /** This group's project folder; scopes the list to drafts authored here.
   *  Null → unfiltered (shows all drafts). */
  groupRootDir: string | null;
  /** Resume a Spec Creator draft by id (opens the immersive surface). */
  onOpenDraft: (draftId: string) => void;
  /** Start a new AI-assisted spec (opens the Spec Creator entrance). */
  onNewSpec: () => void;
  /** Injectable for tests. */
  listDrafts?: (repoRoot: string | null) => Promise<SpecDraftSummary[]>;
  deleteDraft?: (id: string) => Promise<void>;
}

/**
 * Drafts tab — a window onto the Spec Creator's drafts (~/.covenant/spec-drafts).
 * This is the SAME storage the Spec Creator entrance reads, so the two lists
 * always match. Clicking a draft resumes it; the trash button removes it.
 */
export class DraftsTab {
  private container: HTMLElement;
  private listEl: HTMLElement;
  private newBtn: HTMLButtonElement;
  private listDrafts: (repoRoot: string | null) => Promise<SpecDraftSummary[]>;
  private deleteDraft: (id: string) => Promise<void>;

  constructor(private opts: DraftsTabOpts) {
    this.listDrafts = opts.listDrafts ?? defaultListDrafts;
    this.deleteDraft = opts.deleteDraft ?? defaultDeleteDraft;

    this.container = document.createElement("div");
    this.container.className = "pn-drafts-tab";

    this.newBtn = document.createElement("button");
    this.newBtn.type = "button";
    this.newBtn.className = "pn-drafts-new";
    this.newBtn.textContent = "+ New spec (AI-assisted)";
    this.newBtn.addEventListener("click", () => this.opts.onNewSpec());

    this.listEl = document.createElement("div");
    this.listEl.className = "pn-drafts-list";

    this.container.appendChild(this.newBtn);
    this.container.appendChild(this.listEl);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    try {
      const drafts = await this.listDrafts(this.opts.groupRootDir);
      this.renderList(drafts);
    } catch (err) {
      console.error("drafts list failed", err);
      this.listEl.replaceChildren();
      const wrap = document.createElement("div");
      wrap.className = "pn-empty pn-empty-inline";
      const title = document.createElement("div");
      title.className = "pn-empty-title";
      title.textContent = "Failed to load drafts";
      const hint = document.createElement("div");
      hint.className = "pn-empty-hint";
      hint.textContent = (err as Error)?.message ?? "Unknown error";
      wrap.appendChild(title);
      wrap.appendChild(hint);
      this.listEl.appendChild(wrap);
    }
  }

  private renderList(drafts: SpecDraftSummary[]): void {
    this.listEl.replaceChildren();
    if (drafts.length === 0) {
      this.listEl.innerHTML =
        `<div class="pn-empty">
           <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h12l4 4v12H4z"/><path d="M14 4v4h4"/><path d="M8 13h8M8 17h5"/></svg>
           <div class="pn-empty-title">No drafts yet</div>
           <div class="pn-empty-hint">Click <span class="pn-kbd">+ New spec (AI-assisted)</span> to start one</div>
         </div>`;
      return;
    }
    for (const d of drafts) this.listEl.appendChild(this.buildItem(d));
  }

  private buildItem(d: SpecDraftSummary): HTMLElement {
    const item = document.createElement("div");
    item.className = "pn-drafts-item";
    item.setAttribute("role", "button");
    item.tabIndex = 0;

    const title = document.createElement("span");
    title.className = "pn-drafts-title";
    title.textContent = draftTitle(d);

    const meta = document.createElement("span");
    meta.className = "pn-drafts-meta";
    const n = d.messages.length;
    meta.textContent = `${n} message${n === 1 ? "" : "s"} · ${relTime(d.last_updated)}`;

    const del = document.createElement("button");
    del.type = "button";
    del.className = "pn-drafts-del";
    del.setAttribute("aria-label", "Delete draft");
    del.innerHTML = Icons.trash({ size: 13 });
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      del.disabled = true; // guard against a double-fire while delete is in flight
      try {
        await this.deleteDraft(d.id);
        item.remove();
        if (this.listEl.querySelectorAll(".pn-drafts-item").length === 0) this.renderList([]);
      } catch {
        del.disabled = false;
      }
    });

    item.appendChild(title);
    item.appendChild(meta);
    item.appendChild(del);

    const open = (): void => this.opts.onOpenDraft(d.id);
    item.addEventListener("click", open);
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
    return item;
  }
}

/** First line of the opening user message, else a placeholder. */
function draftTitle(d: SpecDraftSummary): string {
  const firstUser = d.messages.find((m) => m.role === "User");
  const t = (firstUser?.content ?? "").trim().split("\n")[0]?.trim() ?? "";
  if (!t) return "Untitled draft";
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}

function relTime(iso: string): string {
  const dt = Date.now() - new Date(iso).getTime();
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}
