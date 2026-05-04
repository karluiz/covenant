import { draftsApi, type DraftSummary, type PublishedSpec } from "../drafts/api";
import {
  listSuperpowersMissions,
  type MissionRef,
  type SuperpowersMissionEntry,
} from "../api";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type SelectedRef =
  | { source: "card"; path: string }
  | { source: "input"; path: string }
  | null;

export interface PickerState {
  specs: PublishedSpec[];
  drafts: DraftSummary[];
  superpowers: SuperpowersMissionEntry[];
  selected: SelectedRef;
  inputValue: string;
  loading: boolean;
  error: string | null;
}

export type PickerResult =
  | { kind: "set"; path: string }
  | { kind: "setRef"; mref: MissionRef }
  | { kind: "publishDraft"; slug: string }
  | { kind: "spawnTab"; initialCommand: string }
  | null;

export interface MissionPickerOpts {
  repoRoot: string;
  currentMissionPath: string | null;
  onBrowse: () => Promise<string | null>;
}

/// Compute the effective path to submit. Card selection wins over text input
/// when both are present. Returns null when nothing is actionable.
export function effectivePath(s: PickerState): string | null {
  if (s.selected?.source === "card") return s.selected.path;
  const trimmed = s.inputValue.trim();
  if (trimmed.length > 0) return trimmed;
  return null;
}

/// "Set mission" button is enabled when there is a non-empty effective path
/// and we're not still loading the list.
export function canSubmit(s: PickerState): boolean {
  if (s.loading) return false;
  return effectivePath(s) !== null;
}

/// Apply card click: select the card; clear the input so it's obvious which
/// path will be used.
export function selectCard(s: PickerState, path: string): PickerState {
  return { ...s, selected: { source: "card", path }, inputValue: "" };
}

/// Apply user typing into the path input: deselect any card, keep input value.
export function typeInput(s: PickerState, value: string): PickerState {
  return {
    ...s,
    selected: value.trim().length > 0 ? { source: "input", path: value.trim() } : null,
    inputValue: value,
  };
}

export function initialState(currentMissionPath: string | null): PickerState {
  return {
    specs: [],
    drafts: [],
    superpowers: [],
    selected: currentMissionPath ? { source: "card", path: currentMissionPath } : null,
    inputValue: "",
    loading: true,
    error: null,
  };
}

// ─────────────── DOM impl below ───────────────

export function openMissionPicker(opts: MissionPickerOpts): Promise<PickerResult> {
  return new Promise((resolve) => {
    let state = initialState(opts.currentMissionPath);

    const overlay = document.createElement("div");
    overlay.className = "mission-picker-overlay";
    const card = document.createElement("div");
    card.className = "mission-picker-card";
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    let unlistenSp: UnlistenFn | null = null;
    const cleanup = (result: PickerResult): void => {
      overlay.remove();
      window.removeEventListener("keydown", onKey);
      if (unlistenSp) { unlistenSp(); unlistenSp = null; }
      resolve(result);
    };

    const render = (): void => {
      card.innerHTML = renderCard(state);
      bindCard(card, state, opts, {
        onChange: (next) => { state = next; render(); },
        onSubmit: () => {
          const p = effectivePath(state);
          if (!p) return;
          cleanup({ kind: "set", path: p });
        },
        onCancel: () => cleanup(null),
        onPublishDraft: (slug) => cleanup({ kind: "publishDraft", slug }),
        onSelectSuperpowers: (mref) => cleanup({ kind: "setRef", mref }),
        onSpawnTab: (initialCommand) => cleanup({ kind: "spawnTab", initialCommand }),
      });
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") { e.preventDefault(); cleanup(null); return; }
      if (e.key === "Enter" && canSubmit(state)) {
        e.preventDefault();
        const p = effectivePath(state);
        if (p) cleanup({ kind: "set", path: p });
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        state = navigateCards(state, e.key === "ArrowDown" ? 1 : -1);
        render();
      }
    };
    window.addEventListener("keydown", onKey);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(null); });

    render();

    // Parallel fetch.
    Promise.all([
      draftsApi.listPublishedSpecs(opts.repoRoot),
      draftsApi.list(opts.repoRoot),
      listSuperpowersMissions().catch(() => [] as SuperpowersMissionEntry[]),
    ]).then(([specs, drafts, superpowers]) => {
      state = { ...state, specs, drafts, superpowers, loading: false, error: null };
      // If the current mission path matches a card, keep it selected.
      render();
    }).catch((err) => {
      state = { ...state, loading: false, error: String(err) };
      render();
    });

    // Refresh the superpowers section when the backend signals a change.
    listen("superpowers-missions-changed", () => {
      listSuperpowersMissions()
        .then((superpowers) => {
          state = { ...state, superpowers };
          render();
        })
        .catch((err) => console.warn("superpowers refresh failed", err));
    }).then((u) => { unlistenSp = u; }).catch(() => {});
  });
}

function navigateCards(s: PickerState, delta: number): PickerState {
  if (s.specs.length === 0) return s;
  const currentIdx = s.selected?.source === "card"
    ? s.specs.findIndex(c => c.path === s.selected!.path)
    : -1;
  const nextIdx = ((currentIdx + delta) + s.specs.length) % s.specs.length;
  return selectCard(s, s.specs[nextIdx]!.path);
}

function renderCard(s: PickerState): string {
  return `
    <header class="mission-picker-header">
      <h3>Set mission spec</h3>
      <button type="button" class="mission-picker-close" aria-label="Close">×</button>
    </header>
    ${renderError(s)}
    ${renderSpecsSection(s)}
    ${renderSuperpowersSection(s)}
    ${renderDraftsSection(s)}
    ${renderPathRow(s)}
    <div class="mission-picker-actions">
      <button type="button" class="mission-picker-cancel">Cancel</button>
      <button type="button" class="mission-picker-submit"
              ${canSubmit(s) ? "" : "disabled"}>Set mission</button>
    </div>
  `;
}

function renderError(s: PickerState): string {
  if (!s.error) return "";
  return `<div class="mission-picker-error">
    Failed to load specs: ${escapeHtml(s.error)}
    <button type="button" class="mission-picker-retry">Retry</button>
  </div>`;
}

function renderSpecsSection(s: PickerState): string {
  if (s.loading) {
    return `<section class="mission-picker-specs">
      <h4>Published</h4>
      <div class="mission-picker-skeleton">${"<div class=\"skel-row\"></div>".repeat(3)}</div>
    </section>`;
  }
  if (s.specs.length === 0) {
    return `<section class="mission-picker-specs">
      <h4>Published (0)</h4>
      <div class="mission-picker-empty">
        No published specs yet. Write one in
        <button type="button" class="mission-picker-link" data-action="open-drafts">Drafts (⌘⇧D)</button>.
      </div>
    </section>`;
  }
  const cards = s.specs.map(spec => {
    const isSelected = s.selected?.source === "card" && s.selected.path === spec.path;
    return `
      <button type="button" class="mission-picker-spec ${isSelected ? "selected" : ""}"
              data-path="${escapeAttr(spec.path)}">
        <span class="mission-picker-id">${escapeHtml(spec.id)}</span>
        <span class="mission-picker-spec-body">
          <span class="mission-picker-title">${escapeHtml(spec.title)}</span>
          <span class="mission-picker-goal">${escapeHtml(spec.goal)}</span>
        </span>
      </button>
    `;
  }).join("");
  return `<section class="mission-picker-specs">
    <h4>Published (${s.specs.length})</h4>
    <div class="mission-picker-list">${cards}</div>
  </section>`;
}

function renderSuperpowersHeader(count: number): string {
  return `<div class="mission-picker-sp-header">
    <h4>Superpowers (${count})</h4>
    <button type="button" class="mission-picker-sp-new" data-action="sp-new">+ New Superpowers mission</button>
  </div>`;
}

function renderSuperpowersSection(s: PickerState): string {
  if (s.loading) return "";
  if (s.superpowers.length === 0) {
    return `<section class="mission-picker-superpowers">
      ${renderSuperpowersHeader(0)}
      <div class="mission-picker-empty">No Superpowers specs yet.</div>
    </section>`;
  }
  const items = s.superpowers.map((e) => {
    const planBadge = e.plan_path
      ? `<span class="mission-picker-badge mission-picker-badge--ok">plan ✓</span>`
      : `<button type="button" class="mission-picker-badge mission-picker-badge--missing mission-picker-plan-missing"
                 data-spec="${escapeAttr(e.spec_path)}"
                 title="Generate plan with writing-plans skill">plan ✗</button>`;
    return `
      <button type="button" class="mission-picker-sp-row"
              data-spec="${escapeAttr(e.spec_path)}"
              data-plan="${escapeAttr(e.plan_path ?? "")}">
        <span class="mission-picker-title">${escapeHtml(e.spec_filename)}</span>
        <span class="mission-picker-goal">${escapeHtml(e.goal_preview)}</span>
        <span class="mission-picker-badge mission-picker-badge--ok">spec ✓</span>
        ${planBadge}
      </button>
    `;
  }).join("");
  return `<section class="mission-picker-superpowers">
    ${renderSuperpowersHeader(s.superpowers.length)}
    <div class="mission-picker-list">${items}</div>
  </section>`;
}

function renderDraftsSection(s: PickerState): string {
  if (s.drafts.length === 0) return "";
  const items = s.drafts.map(d => `
    <div class="mission-picker-draft" data-slug="${escapeAttr(d.slug)}">
      <span class="mission-picker-draft-title">${escapeHtml(d.title)}</span>
      <button type="button" class="mission-picker-publish" data-slug="${escapeAttr(d.slug)}">Publish to use</button>
    </div>
  `).join("");
  return `<details class="mission-picker-drafts">
    <summary>Drafts (${s.drafts.length})</summary>
    <div class="mission-picker-draft-list">${items}</div>
  </details>`;
}

function renderPathRow(s: PickerState): string {
  return `
    <div class="mission-picker-or">or pick another file</div>
    <div class="mission-picker-path-row">
      <input type="text" class="mission-picker-input"
             autocomplete="off" spellcheck="false"
             placeholder="/absolute/path/to/spec.md"
             value="${escapeAttr(s.inputValue)}" />
      <button type="button" class="mission-picker-browse">Browse…</button>
    </div>
  `;
}

interface BindCallbacks {
  onChange: (next: PickerState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onPublishDraft: (slug: string) => void;
  onSelectSuperpowers: (mref: MissionRef) => void;
  onSpawnTab: (initialCommand: string) => void;
}

function bindCard(
  card: HTMLElement,
  state: PickerState,
  opts: MissionPickerOpts,
  cb: BindCallbacks,
): void {
  card.querySelector(".mission-picker-close")?.addEventListener("click", () => cb.onCancel());
  card.querySelector(".mission-picker-cancel")?.addEventListener("click", () => cb.onCancel());
  card.querySelector(".mission-picker-submit")?.addEventListener("click", () => cb.onSubmit());
  card.querySelector(".mission-picker-retry")?.addEventListener("click", () => {
    // Re-trigger the open path: simplest is to dispatch a synthetic open event.
    // Caller is the closure in openMissionPicker — easier to reload via state reset.
    cb.onChange({ ...state, loading: true, error: null });
    Promise.all([
      draftsApi.listPublishedSpecs(opts.repoRoot),
      draftsApi.list(opts.repoRoot),
    ]).then(([specs, drafts]) => cb.onChange({ ...state, specs, drafts, loading: false, error: null }))
      .catch((err) => cb.onChange({ ...state, loading: false, error: String(err) }));
  });
  card.querySelectorAll<HTMLButtonElement>(".mission-picker-spec").forEach(btn => {
    const path = btn.dataset.path!;
    btn.addEventListener("click", () => cb.onChange(selectCard(state, path)));
    btn.addEventListener("dblclick", () => {
      cb.onChange(selectCard(state, path));
      cb.onSubmit();
    });
  });
  card.querySelectorAll<HTMLButtonElement>(".mission-picker-sp-row").forEach((btn) => {
    btn.addEventListener("click", () => {
      const specPath = btn.dataset.spec ?? "";
      const planPath = btn.dataset.plan ?? "";
      if (!specPath) return;
      cb.onSelectSuperpowers({
        kind: "superpowers",
        spec_path: specPath,
        plan_path: planPath.length > 0 ? planPath : null,
      });
    });
  });
  // plan ✗ badges spawn a tab that runs the writing-plans skill.
  // stopPropagation so the row's click handler (select mission) doesn't fire.
  card.querySelectorAll<HTMLButtonElement>(".mission-picker-plan-missing").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const specPath = btn.dataset.spec ?? "";
      if (!specPath) return;
      cb.onSpawnTab(`Use the writing-plans skill to create the plan for ${specPath}`);
    });
  });
  // "+ New Superpowers mission" header button. Opens a small topic
  // prompt then spawns a fresh tab whose initial command runs the
  // brainstorming skill on that topic.
  card.querySelector<HTMLButtonElement>('[data-action="sp-new"]')?.addEventListener("click", async (e) => {
    e.stopPropagation();
    const topic = await openNewSuperpowersTopicModal();
    if (!topic) return;
    cb.onSpawnTab(`Use the brainstorming skill to design: ${topic}`);
  });
  card.querySelectorAll<HTMLButtonElement>(".mission-picker-publish").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const slug = btn.dataset.slug!;
      cb.onPublishDraft(slug);
    });
  });
  card.querySelector<HTMLInputElement>(".mission-picker-input")?.addEventListener("input", (e) => {
    cb.onChange(typeInput(state, (e.target as HTMLInputElement).value));
  });
  card.querySelector(".mission-picker-browse")?.addEventListener("click", async () => {
    const picked = await opts.onBrowse();
    if (picked) cb.onChange(typeInput(state, picked));
  });
  card.querySelector('[data-action="open-drafts"]')?.addEventListener("click", () => {
    cb.onCancel();
    window.dispatchEvent(new CustomEvent("drafts:toggle"));
  });
}

function openNewSuperpowersTopicModal(): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "mission-picker-newmodal";
    modal.innerHTML = `
      <h4>New Superpowers mission</h4>
      <label>Topic <input type="text" id="sp-topic" placeholder="what do you want to brainstorm?" /></label>
      <div class="mission-picker-newmodal-actions">
        <button type="button" id="sp-cancel">Cancel</button>
        <button type="button" id="sp-create">Create tab</button>
      </div>
    `;
    document.body.appendChild(modal);
    const input = modal.querySelector<HTMLInputElement>("#sp-topic")!;
    input.focus();
    const close = (val: string | null): void => {
      modal.remove();
      resolve(val);
    };
    modal.querySelector<HTMLButtonElement>("#sp-cancel")!.addEventListener("click", () => close(null));
    modal.querySelector<HTMLButtonElement>("#sp-create")!.addEventListener("click", () => {
      const v = input.value.trim();
      close(v || null);
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        const v = input.value.trim();
        close(v || null);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        close(null);
      }
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]!));
}
function escapeAttr(s: string): string { return escapeHtml(s); }
