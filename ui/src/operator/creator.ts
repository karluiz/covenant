// ui/src/operator/creator.ts
import {
  Operator,
  OperatorDraft,
  VoiceTone,
  operatorList,
  operatorSetDefault,
  operatorSetGithubAccess,
  operatorSetAcpEnabled,
  operatorSetPerceptionEnabled,
  operatorSetOrg,
  operatorListArchetypes,
  operatorSoulRead,
  operatorSoulParse,
  getSettings,
  listModelsAnthropic,
  listModelsAzureFoundry,
  listModelsOpenAiCompat,
  type ArchetypeView,
  type GithubAccess,
  type SoulView,
  type ModelInfo,
} from "../api";
import { PRESETS, type PresetKey } from "../settings/operator_presets";
import { setFrontmatterScalar } from "../settings/soul_frontmatter";
import { healMilkdownEscapes } from "./soul_heal";
import { renderOperatorChip } from "../settings/operator_chip";
import { AVATAR_PACK_V2, renderAvatarHtml } from "./avatars";
import { pushInfoToast } from "../notifications/toast";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { CustomSelect } from "../ui/select";
import "./operator-creator.css";

/// Blank SOUL.md template seeded into the editor when the user starts
/// from scratch (or opens create-mode before picking an archetype).
const BLANK_SOUL = `---\nname: New Operator\nvoice: terse\nescalate_threshold: 0.6\n---\n\n# New Operator\n\n`;

/// Starter skill vocabulary for the operator creator's suggestion chips —
/// useful before any other operator exists. At runtime the live union of
/// every operator's tags (the same vocabulary handoff_task routes on) is
/// folded in via loadSkillVocab().
export const STARTER_SKILLS = [
  "rust", "typescript", "frontend", "backend", "security", "devops",
  "testing", "database", "debugging", "refactoring", "docs", "api",
  "performance", "ci/cd", "ui/ux",
];

/// Merge starter skills with the live team union, case-insensitively
/// deduped, starters first, original casing preserved.
export function mergeSkillVocab(starters: string[], union: string[]): string[] {
  const seen = new Set<string>();
  return [...starters, ...union].filter(
    (s) => !!s && !seen.has(s.toLowerCase()) && !!seen.add(s.toLowerCase()),
  );
}

/// Cached team skill vocabulary, loaded once per session.
let skillVocab: string[] | null = null;
async function loadSkillVocab(): Promise<string[]> {
  if (skillVocab) return skillVocab;
  let union: string[] = [];
  try {
    union = (await operatorList()).flatMap((o) => o.tags ?? []);
  } catch {
    // ponytail: first run / offline — starters alone still suggest fine.
  }
  skillVocab = mergeSkillVocab(STARTER_SKILLS, union);
  return skillVocab;
}

/// One-click starter rules for the hard-constraints editor. Backslash-free
/// on purpose: Milkdown's markdown round-trip can mangle `\`-escapes.
/// Excludes rules the global hard blocklist already covers (sudo, rm -rf, …).
const HARD_CONSTRAINT_EXAMPLES = [
  "^git push --force",
  "^git commit",
  "^npm publish",
  "^terraform apply",
  "^docker push",
  "^gh release",
] as const;
// ─────────────────────────────────────────────────────────────────────────────
// Task 14 — two-step "New Operator" modal.
// Step 1: Identity (name, emoji, color, voice + chip preview)
// Step 2: Behavior (model, escalate_threshold, persona, hard_constraints)
// Public surface: openOperatorModal, canProceedFromStep1, saveOperator,
// wireOperatorModal.
// ─────────────────────────────────────────────────────────────────────────────

export type SectionKey = "start" | "identity" | "behaviour" | "soul";

export interface ModalDraft extends OperatorDraft {
  id?: string;
}

export interface ModalState {
  mode: "create" | "edit";
  draft: ModalDraft;
  /// Snapshot of `is_default` at modal-open time. Immutable for the
  /// modal lifetime; `setAsDefault` carries the user's intent.
  isDefault: boolean;
  /// User-toggleable. On save, if differs from `isDefault`, the
  /// `operator_set_default` Tauri command runs after create/update.
  setAsDefault: boolean;
  /// Present in edit/duplicate mode; needed for Delete + default flow.
  existing?: Operator;
  /// GitHub access level. Registry-side (not SOUL); persisted via the
  /// dedicated operator_set_github_access command after save, same
  /// pattern as setAsDefault.
  githubAccess: GithubAccess;
  /// dispatch_acp gate (background Copilot subtasks). Registry-side, same
  /// save pattern as githubAccess.
  acpEnabled: boolean;
  /// Perception gate (auto-answer trivial, safe ACP permission prompts).
  /// Registry-side, same save pattern as acpEnabled.
  perceptionEnabled: boolean;
  /// Active section in the immersive shell UI.
  activeSection: SectionKey;
  /// Raw SOUL.md text bound to the split-editor textarea. Authoritative
  /// source for create/update (routed through the from-soul commands).
  soulRaw: string;
  /// Baseline for the dirty check: soulRaw as loaded at open time (updated
  /// once the async edit-mode read lands). Close paths compare against this
  /// before discarding.
  initialSoulRaw: string;
  /// Operator id when editing an existing persona; drives
  /// `operator_update_from_soul`. Absent in create/duplicate mode.
  existingId?: string;
}

export interface ModalHandle {
  state: ModalState;
  el: HTMLElement;
  setName(s: string): void;
  setEmoji(s: string): void;
  setColor(s: string): void;
  setVoice(v: VoiceTone): void;
  setModel(s: string): void;
  setThreshold(n: number): void;
  setPersona(s: string): void;
  setHardConstraints(s: string): void;
  setAsDefault(b: boolean): void;
  setGithubAccess(a: GithubAccess): void;
  setAcpEnabled(b: boolean): void;
  setPerceptionEnabled(b: boolean): void;
  applyPreset(key: PresetKey): void;
  setSection(s: SectionKey): void;
}

export function canSave(m: ModalHandle): boolean {
  const n = m.state.draft.name.trim();
  return n.length > 0 && [...n].length <= 24;
}

// Back-compat alias used by the unit tests written against the
// earlier two-step wizard. Behaves identically to `canSave`.
export const canProceedFromStep1 = canSave;

function defaultDraft(): ModalDraft {
  return {
    name: "",
    emoji: "🟣",
    color: "#a855f7",
    voice: "Terse",
    tags: [],
    persona: "",
    escalate_threshold: 0.5,
    model: "claude-sonnet-4-6",
    hard_constraints: "",
  };
}

function draftFromExisting(op: Operator): ModalDraft {
  return {
    id: op.id,
    name: op.name,
    emoji: op.emoji,
    color: op.color,
    voice: op.voice,
    tags: [...op.tags],
    persona: op.persona,
    escalate_threshold: op.escalate_threshold,
    model: op.model,
    hard_constraints: op.hard_constraints,
  };
}

export function openOperatorModal(opts: {
  mode: "create" | "edit";
  preset?: PresetKey;
  existing?: Operator;
}): ModalHandle {
  let draft: ModalDraft;
  if (opts.existing) {
    draft = draftFromExisting(opts.existing);
  } else if (opts.preset) {
    const preset = PRESETS.find((p) => p.key === opts.preset);
    draft = preset ? { ...preset.seed() } : defaultDraft();
  } else {
    draft = defaultDraft();
  }

  const isDefault = opts.existing?.is_default ?? false;
  const state: ModalState = {
    mode: opts.mode,
    draft,
    isDefault,
    setAsDefault: isDefault,
    existing: opts.existing,
    githubAccess: opts.existing?.github_access ?? "Off",
    acpEnabled: opts.existing?.acp_enabled ?? false,
    perceptionEnabled: opts.existing?.perception_enabled ?? false,
    activeSection: opts.mode === "create" ? "start" : "identity",
    // SOUL.md is the authoritative source for the new split editor.
    // Edit mode loads it asynchronously below; create starts blank
    // (or from a picked archetype).
    soulRaw: BLANK_SOUL,
    initialSoulRaw: BLANK_SOUL,
    existingId: opts.mode === "edit" ? opts.existing?.id : undefined,
  };

  // Edit mode: pull the operator's real SOUL.md off disk and re-render.
  // Duplicate (create-mode + existing) also seeds from the source soul so
  // the user starts from the original body rather than a blank template.
  if (opts.existing && opts.existing.id) {
    void operatorSoulRead(opts.existing.id)
      .then((raw) => {
        // Souls saved in the Milkdown era carry escaped block syntax
        // (\*, \##, \-); heal on load, persisted on the next save.
        const healed = healMilkdownEscapes(raw);
        if (opts.mode === "create") {
          // Duplicate: keep the body but rename so it doesn't clash.
          state.soulRaw = setFrontmatterScalar(healed, "name", opts.existing!.name);
        } else {
          state.soulRaw = healed;
        }
        state.initialSoulRaw = state.soulRaw;
        render();
      })
      .catch((e) => {
        console.warn("operator_soul_read failed", e);
      });
  }

  const el = document.createElement("div");
  el.className = "op-creator";
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("open"));

  const h: ModalHandle = {
    state,
    el,
    setName(s) { state.draft.name = s; render(); },
    setEmoji(s) { state.draft.emoji = s; render(); },
    setColor(s) { state.draft.color = s; render(); },
    setVoice(v) { state.draft.voice = v; render(); },
    setModel(s) { state.draft.model = s; render(); },
    setThreshold(n) { state.draft.escalate_threshold = n; render(); },
    setPersona(s) { state.draft.persona = s; render(); },
    setHardConstraints(s) { state.draft.hard_constraints = s; render(); },
    // Native checkbox self-displays; no full render needed (would flash the modal).
    setAsDefault(b) { state.setAsDefault = b; },
    setGithubAccess(a) { state.githubAccess = a; render(); },
    setAcpEnabled(b) { state.acpEnabled = b; render(); },
    setPerceptionEnabled(b) { state.perceptionEnabled = b; render(); },
    setSection(s) {
      if (state.activeSection === s) return;
      state.activeSection = s;
      // Partial update: swap only the middle section + refresh rail active
      // states. A full render() would wipe the DOM and reload every avatar
      // image, flashing the whole modal on each rail click.
      const ed = getSoulEditor(h);
      const sectionHost = el.querySelector<HTMLElement>(".op-section");
      if (sectionHost) ed.mountSection(sectionHost, s);
      const rail = el.querySelector<HTMLElement>(".op-rail");
      if (rail) rail.replaceWith(renderRail(h));
    },
    applyPreset(key) {
      const preset = PRESETS.find((p) => p.key === key);
      if (!preset) return;
      // Preserve the operator's name if the user already typed one; otherwise
      // adopt the preset's name.
      const userName = state.draft.name.trim();
      state.draft = { ...preset.seed() };
      if (userName) state.draft.name = userName;
      render();
    },
  };

  function render(): void {
    // Preserve scroll across full-DOM rebuilds (voice/color/avatar/model
    // toggles all call render(), which would otherwise jump the modal
    // back to the top).
    const prevScroll = el.querySelector<HTMLElement>(".op-section")?.scrollTop ?? 0;
    el.innerHTML = "";
    // Reset the per-render soul-editor instance so this full render builds a
    // fresh one (seeded from the current soulRaw) shared by header/section/live.
    (el as HTMLElement & { __soulEditor?: SoulEditor | null }).__soulEditor = null;
    el.append(renderForm(h));
    const section = el.querySelector<HTMLElement>(".op-section");
    if (section) section.scrollTop = prevScroll;
  }
  // Stamp the render closure on the element so renderers (e.g. the
  // archetype gallery's onPick) can request a full re-render without the
  // closure being threaded through every helper.
  (el as HTMLElement & { __rerender?: () => void }).__rerender = render;
  render();
  return h;
}

/// Human explanation of the escalate-threshold slider, with a band-specific
/// tail so the value the user just dragged to actually means something.
function thresholdHint(t: number): string {
  const base =
    "How much doubt the operator tolerates before it stops and asks you instead of acting on its own. " +
    "Lower = cautious (pings you often); higher = autonomous (acts solo, only pausing for risky or irreversible steps). " +
    "Truly dangerous commands are always blocked regardless of this setting. ";
  let band: string;
  if (t <= 0.25) band = `Now at ${t.toFixed(2)}: very cautious — asks before almost anything non-trivial.`;
  else if (t <= 0.55) band = `Now at ${t.toFixed(2)}: balanced — asks on anything ambiguous or risky.`;
  else if (t <= 0.8) band = `Now at ${t.toFixed(2)}: confident — proceeds on most routine work, escalates real risk.`;
  else band = `Now at ${t.toFixed(2)}: near-autopilot — only stops for clearly irreversible or destructive actions.`;
  return base + band;
}

function labeled(text: string, child: HTMLElement): HTMLElement {
  const w = document.createElement("label");
  w.className = "op-modal-field";
  const t = document.createElement("span");
  t.className = "op-modal-label";
  t.textContent = text;
  w.append(t, child);
  return w;
}

const RAIL: { key: SectionKey; label: string; createOnly?: boolean }[] = [
  { key: "start", label: "Start", createOnly: true },
  { key: "identity", label: "Identity" },
  { key: "behaviour", label: "Behaviour" },
  { key: "soul", label: "The Soul" },
];

/// Animated teardown: drop the `.open` class to trigger the exit transition,
/// then remove the node once it completes.
function closeCreator(el: HTMLElement): void {
  el.classList.remove("open");
  setTimeout(() => el.remove(), 420);
}

/// Anything the user changed since open that a silent close would lose.
function isDirty(h: ModalHandle): boolean {
  const s = h.state;
  const ex = s.existing;
  return (
    s.soulRaw !== s.initialSoulRaw ||
    s.setAsDefault !== s.isDefault ||
    s.githubAccess !== (ex?.github_access ?? "Off") ||
    s.acpEnabled !== (ex?.acp_enabled ?? false) ||
    s.perceptionEnabled !== (ex?.perception_enabled ?? false)
  );
}

/// Single close path for every non-Save exit (Escape, esc pill, scrim,
/// Cancel). Clean → close. Dirty → arm the Cancel button as an inline
/// two-step confirm ("Discard changes?", 3s window) instead of losing the
/// user's work to an accidental Escape.
function requestClose(h: ModalHandle): void {
  if (!isDirty(h)) { closeCreator(h.el); return; }
  const cancel = h.el.querySelector<HTMLButtonElement>(".settings-cancel");
  if (!cancel || cancel.classList.contains("is-armed")) { closeCreator(h.el); return; }
  cancel.classList.add("is-armed");
  cancel.textContent = "Discard changes?";
  window.setTimeout(() => {
    cancel.classList.remove("is-armed");
    cancel.textContent = "Cancel";
  }, 3000);
}

function renderForm(h: ModalHandle): DocumentFragment {
  const frag = document.createDocumentFragment();

  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.addEventListener("click", () => requestClose(h));

  const creator = document.createElement("div");
  creator.className = "creator";
  creator.setAttribute("role", "dialog");
  creator.setAttribute("aria-label", h.state.mode === "edit" ? "Edit operator" : "New operator");

  creator.append(renderHeader(h));

  const stage = document.createElement("div");
  stage.className = "stage";
  stage.append(renderRail(h), renderSectionHost(h), renderSoulLive(h));
  creator.append(stage);

  creator.append(renderFooter(h));

  frag.append(scrim, creator);
  return frag;
}

function renderHeader(h: ModalHandle): HTMLElement {
  const header = document.createElement("header");
  const brand = document.createElement("div");
  brand.className = "brand";
  const brandLabel = h.state.mode === "edit" ? "Edit operator" : "New operator";
  brand.innerHTML = `${Icons.headphones({ size: 16 })}<span>${brandLabel}</span>`;
  const chipHost = document.createElement("div");
  chipHost.className = "op-hero-chip";
  chipHost.style.flex = "1";
  const kbd = document.createElement("button");
  kbd.type = "button";
  kbd.className = "settings-close";
  kbd.setAttribute("aria-label", "Close (Esc)");
  kbd.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
  kbd.addEventListener("click", () => requestClose(h));
  header.append(brand, chipHost, kbd);
  getSoulEditor(h).mountChip(chipHost);
  return header;
}

function renderRail(h: ModalHandle): HTMLElement {
  const rail = document.createElement("nav");
  rail.className = "op-rail";
  for (const item of RAIL) {
    if (item.createOnly && h.state.mode !== "create") continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "op-rail-item";
    if (h.state.activeSection === item.key) btn.classList.add("is-active");
    btn.textContent = item.label;
    btn.addEventListener("click", () => h.setSection(item.key));
    rail.append(btn);
  }
  return rail;
}

function renderSectionHost(h: ModalHandle): HTMLElement {
  const host = document.createElement("div");
  host.className = "op-section";
  getSoulEditor(h).mountSection(host, h.state.activeSection);
  return host;
}

function renderSoulLive(h: ModalHandle): HTMLElement {
  const live = document.createElement("div");
  live.className = "op-soul-live";
  getSoulEditor(h).mountLive(live);
  return live;
}

/// Shared per-render soul-editor instance. `render()` clears the stamp at the
/// top of each full rebuild, so header/section/live all share ONE editor
/// (seeded from the current soulRaw) within a single render pass; the next
/// render builds a fresh one. This is lossless because `commit()` keeps
/// `soulRaw` continuously in sync, so re-seeding from it is a no-op.
function getSoulEditor(h: ModalHandle): SoulEditor {
  const stamped = h.el as HTMLElement & { __soulEditor?: SoulEditor | null };
  if (!stamped.__soulEditor) stamped.__soulEditor = buildSoulEditor(h);
  return stamped.__soulEditor;
}

// ── Archetype gallery (create mode): seeds the editor with a soul ───────────
// Spotlight + filmstrip. One soul featured large (portrait, quote, voice,
// escalate threshold); a strip below switches which. The strip is built ONCE
// and a click only repaints the spotlight + toggles selection locally, then
// seeds the editor via onPick — no modal rerender, so no chrome-teardown /
// avatar-reload flicker.

// Cached so re-entering the section doesn't refetch / flash an empty spotlight.
let ARCHETYPE_CACHE: ArchetypeView[] | null = null;

function renderArchetypeGallery(
  onPick: (raw: string) => void,
  currentRaw: string,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "op-archetypes op-arch-spotlight";
  const title = document.createElement("div");
  title.className = "op-modal-label";
  title.textContent = "Start from a soul";
  wrap.append(title);

  const spot = document.createElement("div");
  spot.className = "op-spot";
  const strip = document.createElement("div");
  strip.className = "op-strip";
  wrap.append(spot, strip);

  // Repaint ONLY the featured card. Cheap enough that the single big avatar
  // (already cached from the strip) doesn't visibly reload.
  const paintSpot = (a: ArchetypeView) => {
    spot.style.setProperty("--sig", a.color ?? "#8b929b");
    const voice = a.voice ? `<span class="op-spot-voice">${escHtml(a.voice)}</span>` : "";
    const foot = [
      a.escalate_threshold != null
        ? `<span>escalate <b>${a.escalate_threshold.toFixed(2)}</b></span>`
        : "",
      a.tag ? `<span>·${escHtml(a.tag)}</span>` : "",
    ].join("");
    spot.innerHTML = `
      <div class="op-spot-av">${renderAvatarHtml(a.avatar ?? "🟣", 120)}</div>
      <div class="op-spot-body">
        <div class="op-spot-name">${escHtml(a.name)}${voice}</div>
        <p class="op-spot-quote">“${escHtml(a.tagline)}”</p>
        <div class="op-spot-foot">${foot}</div>
      </div>`;
  };

  const build = (list: ArchetypeView[]) => {
    if (!list.length) return;
    // Selection follows the current draft; unmatched (fresh / blank) previews
    // the first soul without marking any archetype thumb committed.
    let selIdx = list.findIndex((a) => a.raw === currentRaw);
    const blankSel = currentRaw === BLANK_SOUL;
    paintSpot(list[selIdx >= 0 ? selIdx : 0]);

    strip.innerHTML = "";
    const thumbs: HTMLButtonElement[] = [];
    // thumbIdx addresses the button (incl. Blank); listIdx (-1 for Blank)
    // addresses the soul to feature. Blank keeps the last preview in the spot.
    const select = (thumbIdx: number, listIdx: number, raw: string) => {
      thumbs.forEach((t, k) => t.classList.toggle("is-sel", k === thumbIdx));
      if (listIdx >= 0) paintSpot(list[listIdx]);
      onPick(raw);
    };
    list.forEach((s, j) => {
      const t = document.createElement("button");
      t.type = "button";
      t.className = "op-thumb";
      if (s.color) t.style.setProperty("--sig", s.color);
      if (j === selIdx) t.classList.add("is-sel");
      t.innerHTML = `<span class="op-thumb-av">${renderAvatarHtml(s.avatar ?? "🟣", 34)}</span>` +
        `<span class="op-thumb-name">${escHtml(s.name.replace(/^The /, ""))}</span>`;
      t.addEventListener("click", () => select(j, j, s.raw));
      thumbs.push(t);
      strip.append(t);
    });
    const blankIdx = list.length;
    const blank = document.createElement("button");
    blank.type = "button";
    blank.className = "op-thumb op-thumb-blank";
    if (blankSel) blank.classList.add("is-sel");
    blank.innerHTML = `<span class="op-thumb-av">＋</span><span class="op-thumb-name">Blank</span>`;
    blank.addEventListener("click", () => select(blankIdx, -1, BLANK_SOUL));
    thumbs.push(blank);
    strip.append(blank);
  };

  if (ARCHETYPE_CACHE) build(ARCHETYPE_CACHE);
  else {
    void operatorListArchetypes().then((list: ArchetypeView[]) => {
      ARCHETYPE_CACHE = list ?? [];
      build(ARCHETYPE_CACHE);
    }).catch((e) => {
      console.warn("operator_list_archetypes failed", e);
    });
  }
  return wrap;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Editor: rich identity/behaviour controls (left) + the soul prose &
//    live preview (right), with the full SOUL.md source as an escape hatch ──

const COLOR_SWATCHES = [
  "#6B7280", "#3b82f6", "#a855f7", "#5ad19a", "#e6b673",
  "#c4a7ff", "#ff8585", "#f472b6", "#34d399", "#fbbf24",
];

/// YAML-quote a hex colour — unquoted `#…` reads as a comment.
function yamlColor(c: string): string {
  return `'${c}'`;
}

/// Does a name need quoting to survive a YAML round-trip?
function nameNeedsQuote(s: string): boolean {
  return /[:#[\]{}",&*!|>%@`]/.test(s) || /^\s|\s$/.test(s);
}

/// Deterministically rebuild the full SOUL.md text from a parsed view.
/// Invoked whenever a form control changes a field — canonicalises the
/// frontmatter; the body is preserved verbatim.
function soulRawFromView(v: SoulView): string {
  const out: string[] = ["---"];
  const name = v.name && v.name.trim().length ? v.name : "New Operator";
  out.push(`name: ${nameNeedsQuote(name) ? JSON.stringify(name) : name}`);
  if (v.avatar) out.push(`avatar: ${v.avatar}`);
  if (v.color) out.push(`color: ${yamlColor(v.color)}`);
  if (v.model) out.push(`model: ${v.model}`);
  out.push(`voice: ${v.voice ?? "terse"}`);
  out.push(`escalate_threshold: ${v.escalate_threshold ?? 0.6}`);
  const tags = (v.tags ?? []).map((t) => t.trim()).filter(Boolean);
  if (tags.length) out.push(`tags: [${tags.join(", ")}]`);
  const hc = (v.hard_constraints ?? "").replace(/\s+$/, "");
  if (hc.length) {
    out.push("hard_constraints: |");
    for (const ln of hc.split("\n")) out.push(`  ${ln}`);
  }
  out.push("---", "", (v.body ?? "").replace(/\s+$/, ""), "");
  return out.join("\n");
}

function soulSection(title: string): HTMLElement {
  const s = document.createElement("div");
  s.className = "op-soul-section";
  const t = document.createElement("div");
  t.className = "op-soul-section-title";
  t.textContent = title;
  s.append(t);
  return s;
}

interface SoulEditor {
  mountSection(host: HTMLElement, section: SectionKey): void;
  mountLive(host: HTMLElement): void;
  mountChip(host: HTMLElement): void;
}

function buildSoulEditor(h: ModalHandle): SoulEditor {
  // Working structured view. Controls mutate this and regenerate the raw
  // SOUL.md; seeded from the modal's current soulRaw on first parse.
  let view: SoulView = {
    name: "", avatar: null, color: null, model: null, voice: "terse",
    escalate_threshold: 0.6, tags: [], hard_constraints: null, body: "",
    validation_error: null,
  };

  // SOUL body — plain-text markdown editor. A soul.md is authored source:
  // headings and bullets typed by hand. Milkdown's WYSIWYG round-trip
  // re-serializes and escapes that block syntax (## → \##, - → \-, * → \*),
  // corrupting the saved file. A raw textarea passes the body through verbatim,
  // and matches the inline editor (already a plain textarea). Programmatic
  // `.value = ` never fires an `input` event, so no re-entrancy guard is needed.
  const bodyEditor = document.createElement("textarea");
  bodyEditor.className = "op-soul-body";
  bodyEditor.spellcheck = false;
  bodyEditor.placeholder = [
    "Write this operator's soul — a delegation letter to yourself.",
    "",
    "## Mandate — whose version of you this is, what slice of your authority it holds",
    "## Disposition — how this facet of you weighs risk vs. throughput",
    "## Reflexes — the ALWAYS-YES / ESCALATE decisions you've already made",
    "## Voice — how this version of you talks",
  ].join("\n");
  bodyEditor.addEventListener("input", () => {
    view.body = bodyEditor.value;
    h.state.soulRaw = soulRawFromView(view);
    src.value = h.state.soulRaw;
    scheduleValidate();
  });
  function setBodyValue(md: string): void {
    bodyEditor.value = md;
  }

  // Live pane: raw source + error — always visible on right.

  // Always-visible, read-only mirror of the generated SOUL.md (front-matter +
  // body). No collapsible chevron — the WYSIWYG body editor + structured
  // controls are the source of truth; this just shows the file that gets saved.
  const rawDetails = document.createElement("div");
  rawDetails.className = "op-soul-rawwrap";
  const rawSummary = document.createElement("div");
  rawSummary.className = "op-soul-rawhead";
  const rawTitle = document.createElement("span");
  rawTitle.textContent = "SOUL.md source";
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "op-soul-copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(src.value).then(() => {
      copyBtn.textContent = "Copied";
      window.setTimeout(() => { copyBtn.textContent = "Copy"; }, 1200);
    });
  });
  rawSummary.append(rawTitle, copyBtn);
  const src = document.createElement("textarea");
  src.className = "op-soul-source";
  src.spellcheck = false;
  src.readOnly = true;
  rawDetails.append(rawSummary, src);

  const errLine = document.createElement("div");
  errLine.className = "op-soul-error";

  // Re-validate as the user types (body + hard constraints + structured
  // controls all funnel here) so errLine never goes stale and Save is
  // gated on the parse result instead of surfacing the error only after
  // the backend rejects the save.
  let validateTimer: number | null = null;
  function scheduleValidate(): void {
    if (validateTimer !== null) window.clearTimeout(validateTimer);
    validateTimer = window.setTimeout(() => {
      validateTimer = null;
      void operatorSoulParse(h.state.soulRaw)
        .then((v) => {
          if ((h.el as HTMLElement & { __soulEditor?: SoulEditor | null }).__soulEditor !== self) return;
          if (!v) return;
          errLine.textContent = v.validation_error ?? "";
          const save = h.el.querySelector<HTMLButtonElement>(".op-modal-save");
          if (save) {
            save.disabled =
              h.state.soulRaw.trim().length === 0 || !!v.validation_error;
          }
        })
        .catch(() => { /* transient IPC failure — keep last verdict */ });
    }, 400);
  }

  // Mount the live operator chip into whatever host currently holds it.
  function mountChipInner(host: HTMLElement): void {
    host.innerHTML = "";
    host.append(
      renderOperatorChip(
        { name: view.name || "New Operator", emoji: view.avatar || "🟣", color: view.color || "#6B7280" },
        "lg",
      ),
    );
  }

  // Funnel a control change into the raw text + state, refresh the header
  // chip + live preview, and (when `remountSection`) re-mount the active
  // section. `remountSection` is skipped while a text field is focused so
  // the caret survives.
  function commit(remountSection: boolean): void {
    h.state.soulRaw = soulRawFromView(view);
    src.value = h.state.soulRaw;
    scheduleValidate();
    const chipHost = h.el.querySelector<HTMLElement>(".op-hero-chip");
    if (chipHost) mountChipInner(chipHost);
    if (remountSection) {
      const sectionHost = h.el.querySelector<HTMLElement>(".op-section");
      if (sectionHost) mountSectionInner(sectionHost, h.state.activeSection);
    }
  }

  // Seed the whole soul from a raw file (archetype pick) WITHOUT re-mounting
  // the active section — the spotlight repaints itself locally, so a full
  // rerender here would only cause the flicker (chrome teardown + avatar
  // reload) we're avoiding. Refreshes state, view, live source and chip.
  async function seedFromRaw(raw: string): Promise<void> {
    h.state.soulRaw = raw;
    src.value = raw;
    try {
      const v = await operatorSoulParse(raw);
      if (v) { view = v; errLine.textContent = v.validation_error ?? ""; }
    } catch (e) {
      errLine.textContent = `Parse failed: ${e}`;
    }
    setBodyValue(view.body ?? "");
    const chipHost = h.el.querySelector<HTMLElement>(".op-hero-chip");
    if (chipHost) mountChipInner(chipHost);
  }

  function paintIdentity(controls: HTMLElement): void {
    controls.innerHTML = "";

    // ── Identity ──────────────────────────────────────────────────────
    const identity = soulSection("Identity");

    const name = document.createElement("input");
    name.type = "text";
    name.className = "op-modal-input";
    name.maxLength = 64;
    name.value = view.name ?? "";
    name.addEventListener("input", () => { view.name = name.value; commit(false); });
    identity.append(labeled("Name", name));

    const avField = document.createElement("div");
    avField.className = "op-modal-field";
    const avLbl = document.createElement("span");
    avLbl.className = "op-modal-label";
    avLbl.textContent = "Avatar";
    const grid = document.createElement("div");
    grid.className = "op-soul-avatar-grid";
    for (const a of AVATAR_PACK_V2) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "op-soul-avatar-cell";
      if (view.avatar === `pack2:${a.character}`) cell.classList.add("is-selected");
      cell.setAttribute("aria-label", a.label);
      const img = document.createElement("img");
      img.src = a.url; img.width = 44; img.height = 44; img.draggable = false;
      img.className = "op-avatar op-avatar-pixel"; img.alt = a.label;
      cell.append(img);
      // Hover-cycle through the character's emotional poses (250ms),
      // snapping back to the neutral pose on leave — mirrors the old pane.
      const poses = Object.values(a.urlsByEmotion).filter(Boolean) as string[];
      let cycle: number | null = null;
      cell.addEventListener("mouseenter", () => {
        if (poses.length < 2) return;
        let i = 0;
        cycle = window.setInterval(() => {
          i = (i + 1) % poses.length;
          img.src = poses[i];
        }, 250);
      });
      cell.addEventListener("mouseleave", () => {
        if (cycle !== null) { window.clearInterval(cycle); cycle = null; }
        img.src = a.url;
      });
      cell.addEventListener("click", () => { view.avatar = `pack2:${a.character}`; commit(true); });
      grid.append(cell);
    }
    avField.append(avLbl, grid);
    identity.append(avField);

    const colField = document.createElement("div");
    colField.className = "op-modal-field";
    const colLbl = document.createElement("span");
    colLbl.className = "op-modal-label";
    colLbl.textContent = "Color";
    const swatches = document.createElement("div");
    swatches.className = "op-soul-swatches";
    for (const c of COLOR_SWATCHES) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "op-soul-swatch";
      if ((view.color ?? "").toLowerCase() === c.toLowerCase()) sw.classList.add("is-selected");
      sw.style.background = c;
      sw.setAttribute("aria-label", c);
      sw.addEventListener("click", () => { view.color = c; commit(true); });
      swatches.append(sw);
    }
    const custom = document.createElement("input");
    custom.type = "color";
    custom.className = "op-soul-color-custom";
    custom.value = view.color ?? "#6B7280";
    custom.addEventListener("input", () => { view.color = custom.value; commit(false); });
    custom.addEventListener("change", () => { view.color = custom.value; commit(true); });
    swatches.append(custom);
    colField.append(colLbl, swatches);
    identity.append(colField);

    // ── Skills ────────────────────────────────────────────────────────
    // Skills are the team's routing vocabulary: handoff_task delegates to
    // the teammate whose skills overlap a task's required_skills, and a
    // successful routed handoff is what earns the Good Delegate badge. An
    // operator with no skills can never receive a handoff — so we make this
    // a first-class pill editor with suggestions, not a bare text field.
    const skills = document.createElement("div");
    skills.className = "op-skills";

    const pills = document.createElement("div");
    pills.className = "op-skills-pills";
    const entry = document.createElement("input");
    entry.type = "text";
    entry.className = "op-skills-entry";

    const has = (t: string) =>
      (view.tags ?? []).some((x) => x.toLowerCase() === t.toLowerCase());

    function addSkill(raw: string): void {
      const t = raw.trim();
      entry.value = "";
      if (t && !has(t)) {
        view.tags = [...(view.tags ?? []), t];
        commit(false);
      }
      renderPills();
      renderSuggest();
    }
    function removeSkill(t: string): void {
      view.tags = (view.tags ?? []).filter((x) => x !== t);
      commit(false);
      renderPills();
      renderSuggest();
    }
    function renderPills(): void {
      pills.querySelectorAll(".op-skill-pill").forEach((n) => n.remove());
      for (const t of view.tags ?? []) {
        const pill = document.createElement("span");
        pill.className = "op-skill-pill";
        const lbl = document.createElement("span");
        lbl.textContent = t;
        const x = document.createElement("button");
        x.type = "button"; x.className = "op-skill-pill-x"; x.textContent = "×";
        x.setAttribute("aria-label", `Remove ${t}`);
        x.addEventListener("click", () => removeSkill(t));
        pill.append(lbl, x);
        pills.insertBefore(pill, entry);
      }
      entry.placeholder = (view.tags?.length ?? 0) ? "" : "type a skill, Enter to add";
    }

    entry.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addSkill(entry.value); }
      else if (e.key === "Backspace" && !entry.value && (view.tags?.length ?? 0)) {
        removeSkill(view.tags![view.tags!.length - 1]);
      }
    });
    entry.addEventListener("blur", () => addSkill(entry.value));
    // Click anywhere in the field (not on a pill) focuses the entry.
    pills.addEventListener("click", (e) => { if (e.target === pills) entry.focus(); });
    pills.append(entry);
    renderPills();

    const hint = document.createElement("div");
    hint.className = "op-skills-hint";
    hint.textContent =
      "Skills are how operators delegate. When one hits work outside its lane, " +
      "handoff_task routes to the teammate whose skills overlap — and a successful " +
      "routed handoff is what earns the Good Delegate badge. No skills means this " +
      "operator can never receive a handoff.";

    const suggest = document.createElement("div");
    suggest.className = "op-skills-suggest";
    function renderSuggest(): void {
      suggest.innerHTML = "";
      const avail = (skillVocab ?? STARTER_SKILLS)
        .filter((s) => !has(s))
        .slice(0, 12);
      if (!avail.length) return;
      const lbl = document.createElement("span");
      lbl.className = "op-skills-suggest-lbl";
      lbl.textContent = "Suggested";
      suggest.append(lbl);
      for (const s of avail) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "op-skills-chip";
        chip.textContent = s;
        chip.addEventListener("click", () => addSkill(s));
        suggest.append(chip);
      }
    }
    renderSuggest();
    // Fold in the live team vocabulary (union of every operator's tags) once
    // it loads — same vocabulary handoff_task routes on.
    void loadSkillVocab().then(renderSuggest);

    skills.append(pills, hint, suggest);
    const skillField = document.createElement("div");
    skillField.className = "op-modal-field";
    const skillLbl = document.createElement("span");
    skillLbl.className = "op-modal-label";
    skillLbl.textContent = "Skills";
    skillField.append(skillLbl, skills);
    identity.append(skillField);
    controls.append(identity);
  }

  function paintBehaviour(controls: HTMLElement): void {
    controls.innerHTML = "";

    // ── Behaviour ─────────────────────────────────────────────────────
    const behaviour = soulSection("Behaviour");

    const voiceSelect = new CustomSelect({
      className: "op-modal-select",
      ariaLabel: "Operator voice",
      value: view.voice ?? "terse",
      options: [
        { value: "terse", label: "terse" },
        { value: "warm", label: "warm" },
        { value: "formal", label: "formal" },
      ],
    });
    voiceSelect.element.addEventListener("change", () => { view.voice = voiceSelect.value; commit(false); });
    behaviour.append(labeled("Voice", voiceSelect.element));

    const modelField = document.createElement("label");
    modelField.className = "op-modal-field";
    const modelLbl = document.createElement("span");
    modelLbl.className = "op-modal-label";
    modelLbl.textContent = "Model";
    const modelSelect = new CustomSelect({
      className: "op-modal-select",
      ariaLabel: "Operator model",
      value: view.model ?? "claude-sonnet-4-6",
      options: withCurrentModel([], view.model ?? undefined),
    });
    modelSelect.element.addEventListener("change", () => { view.model = modelSelect.value; commit(false); });
    void operatorModelOptions(view.model ?? undefined).then((opts) => {
      modelSelect.setOptions(opts, view.model ?? "claude-sonnet-4-6");
    });
    modelField.append(modelLbl, modelSelect.element);
    behaviour.append(modelField);

    const thr = document.createElement("input");
    thr.type = "range"; thr.min = "0"; thr.max = "1"; thr.step = "0.05";
    thr.value = String(view.escalate_threshold ?? 0.6);
    const thrField = labeled(
      `Escalate threshold · ${(view.escalate_threshold ?? 0.6).toFixed(2)}`,
      thr,
    );
    thr.addEventListener("input", () => {
      view.escalate_threshold = Number.parseFloat(thr.value);
      const lbl = thrField.querySelector<HTMLElement>(".op-modal-label");
      if (lbl) lbl.textContent = `Escalate threshold · ${(view.escalate_threshold ?? 0.6).toFixed(2)}`;
      const hintEl = thrField.querySelector<HTMLElement>(".op-modal-hint");
      if (hintEl) hintEl.textContent = thresholdHint(view.escalate_threshold ?? 0.6);
      commit(false);
    });
    const thrHint = document.createElement("small");
    thrHint.className = "op-modal-hint";
    thrHint.textContent = thresholdHint(view.escalate_threshold ?? 0.6);
    thrField.append(thrHint);
    behaviour.append(thrField);

    // ── GitHub access (registry-side, not part of the SOUL) ───────────
    const ghSeg = document.createElement("div");
    ghSeg.className = "op-soul-seg";
    const GH_OPTIONS: { value: GithubAccess; label: string }[] = [
      { value: "Off", label: "Off" },
      { value: "ReadOnly", label: "Read-only" },
      { value: "ReadWrite", label: "Read & write" },
    ];
    for (const opt of GH_OPTIONS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "op-soul-seg-btn";
      if (h.state.githubAccess === opt.value) btn.classList.add("is-selected");
      btn.textContent = opt.label;
      btn.addEventListener("click", () => h.setGithubAccess(opt.value));
      ghSeg.append(btn);
    }
    // div (not <label>) wrapper — a label would forward clicks on the
    // hint/label text to the first button, silently selecting "Off".
    // Mirrors the avatar-grid field structure above.
    const ghField = document.createElement("div");
    ghField.className = "op-modal-field";
    const ghLbl = document.createElement("span");
    ghLbl.className = "op-modal-label";
    ghLbl.textContent = "GitHub access";
    const ghHint = document.createElement("small");
    ghHint.className = "op-modal-hint";
    ghHint.textContent =
      "Read lets this operator list and read issues and PRs; read & write can also create issues, comment, and open PRs as you.";
    ghField.append(ghLbl, ghSeg, ghHint);
    behaviour.append(ghField);

    // ── Copilot delegation (dispatch_acp gate — registry-side) ────────
    const acpSeg = document.createElement("div");
    acpSeg.className = "op-soul-seg";
    for (const opt of [
      { value: false, label: "Off" },
      { value: true, label: "On" },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "op-soul-seg-btn";
      if (h.state.acpEnabled === opt.value) btn.classList.add("is-selected");
      btn.textContent = opt.label;
      btn.addEventListener("click", () => h.setAcpEnabled(opt.value));
      acpSeg.append(btn);
    }
    const acpField = document.createElement("div");
    acpField.className = "op-modal-field";
    const acpLbl = document.createElement("span");
    acpLbl.className = "op-modal-label";
    acpLbl.textContent = "Copilot delegation";
    const acpHint = document.createElement("small");
    acpHint.className = "op-modal-hint";
    acpHint.textContent =
      "Lets this operator dispatch self-contained subtasks to background GitHub Copilot sessions. File edits stay inside the workspace; risky commands are denied by policy.";
    acpField.append(acpLbl, acpSeg, acpHint);
    behaviour.append(acpField);

    // ── Perception (auto-answer trivial ACP prompts — registry-side) ──
    const perceptionSeg = document.createElement("div");
    perceptionSeg.className = "op-soul-seg";
    for (const opt of [
      { value: false, label: "Off" },
      { value: true, label: "On" },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "op-soul-seg-btn";
      if (h.state.perceptionEnabled === opt.value) btn.classList.add("is-selected");
      btn.textContent = opt.label;
      btn.addEventListener("click", () => h.setPerceptionEnabled(opt.value));
      perceptionSeg.append(btn);
    }
    const perceptionField = document.createElement("div");
    perceptionField.className = "op-modal-field";
    const perceptionLbl = document.createElement("span");
    perceptionLbl.className = "op-modal-label";
    perceptionLbl.textContent = "Perception";
    const perceptionHint = document.createElement("small");
    perceptionHint.className = "op-modal-hint";
    perceptionHint.textContent = "Auto-answer trivial, safe executor prompts";
    perceptionField.append(perceptionLbl, perceptionSeg, perceptionHint);
    behaviour.append(perceptionField);
    controls.append(behaviour);

    // ── Hard constraints (safety — extra deny rules) ──────────────────
    const adv = document.createElement("details");
    adv.className = "op-soul-advanced";
    if ((view.hard_constraints ?? "").trim().length) adv.open = true;
    const advSum = document.createElement("summary");
    advSum.textContent = "Hard constraints";
    const hcHint = document.createElement("div");
    hcHint.className = "op-hc-hint";
    hcHint.textContent =
      "Regex deny rules — a command matching any line is never auto-executed; the operator asks you first. One rule per line.";
    // Plain textarea, not Milkdown: these are regex deny rules where a
    // WYSIWYG round-trip would escape backslashes (\.env → \\.env), breaking
    // the pattern. Same reason the body editor is a textarea. Enter = newline,
    // which is exactly right for "one rule per line".
    const hc = document.createElement("textarea");
    hc.className = "op-soul-hard";
    hc.spellcheck = false;
    hc.rows = 4;
    hc.value = view.hard_constraints ?? "";
    hc.placeholder = "One deny rule per line (regex). e.g. ^git push --force";
    hc.addEventListener("input", () => { view.hard_constraints = hc.value; commit(false); });
    const hcChips = document.createElement("div");
    hcChips.className = "op-hc-chips";
    for (const rule of HARD_CONSTRAINT_EXAMPLES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "op-hc-chip";
      btn.textContent = rule;
      btn.addEventListener("click", () => {
        const cur = (view.hard_constraints ?? "").trim();
        if (cur.split("\n").some((l) => l.trim() === rule)) return;
        const next = cur ? `${cur}\n${rule}` : rule;
        view.hard_constraints = next;
        hc.value = next;
        commit(false);
      });
      hcChips.appendChild(btn);
    }
    adv.append(advSum, hcHint, hc, hcChips);
    controls.append(adv);
  }

  // Inner section mount — shared by `commit` and the returned `mountSection`.
  function mountSectionInner(host: HTMLElement, section: SectionKey): void {
    host.innerHTML = "";
    // Soul section: the host becomes a flex column so the body editor can
    // fill the full height instead of sitting in a fixed 320px box.
    host.classList.toggle("is-soul", section === "soul");
    if (section === "start") {
      host.append(
        renderArchetypeGallery((raw) => { void seedFromRaw(raw); }, h.state.soulRaw),
      );
      return;
    }
    if (section === "identity") { paintIdentity(host); return; }
    if (section === "behaviour") { paintBehaviour(host); return; }
    if (section === "soul") {
      const label = document.createElement("div");
      label.className = "op-soul-section-title";
      label.textContent = "The soul";
      // The four layers of a soul (AGENTS.md ontology) as one-click
      // heading inserters — a nudge toward Mandate/Disposition, not just
      // a bare reflex table.
      const chips = document.createElement("div");
      chips.className = "op-soul-layer-chips";
      const LAYERS: { label: string; heading: string }[] = [
        { label: "+ Mandate", heading: "## Mandate — whose version of you this is, what slice of your authority it holds" },
        { label: "+ Disposition", heading: "## Disposition — how this facet of you weighs risk vs. throughput" },
        { label: "+ Reflexes", heading: "## Reflexes — the ALWAYS-YES / ESCALATE decisions you've already made" },
        { label: "+ Voice", heading: "## Voice — how this version of you talks" },
      ];
      for (const layer of LAYERS) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "op-skills-chip";
        chip.textContent = layer.label;
        chip.addEventListener("click", () => {
          const cur = bodyEditor.value.replace(/\s+$/, "");
          bodyEditor.value = cur ? `${cur}\n\n${layer.heading}\n\n` : `${layer.heading}\n\n`;
          view.body = bodyEditor.value;
          commit(false);
          bodyEditor.focus();
          bodyEditor.selectionStart = bodyEditor.selectionEnd = bodyEditor.value.length;
        });
        chips.append(chip);
      }
      host.append(label, chips, bodyEditor);
    }
  }

  // Re-mount the chip + active section after a structured-control change.
  function repaintAll(): void {
    const chipHost = h.el.querySelector<HTMLElement>(".op-hero-chip");
    if (chipHost) mountChipInner(chipHost);
    const sectionHost = h.el.querySelector<HTMLElement>(".op-section");
    if (sectionHost) mountSectionInner(sectionHost, h.state.activeSection);
  }

  const self: SoulEditor = {
    mountSection(host, section) { mountSectionInner(host, section); },
    mountLive(host) {
      host.innerHTML = "";
      host.append(rawDetails, errLine);
    },
    mountChip(host) { mountChipInner(host); },
  };

  // Initial hydrate from the modal's current soulRaw. Guard the post-await
  // repaint so a stale (superseded) editor closure doesn't repaint over a
  // newer render's nodes.
  void (async () => {
    try {
      const v = await operatorSoulParse(h.state.soulRaw);
      if (v) { view = v; errLine.textContent = v.validation_error ?? ""; }
    } catch (e) {
      errLine.textContent = `Parse failed: ${e}`;
    }
    if ((h.el as HTMLElement & { __soulEditor?: SoulEditor | null }).__soulEditor !== self) return;
    src.value = h.state.soulRaw;
    setBodyValue(view.body ?? "");
    repaintAll();
  })();

  return self;
}

// ── Footer: delete + default toggle (left), error + cancel + save (right) ───
function renderFooter(h: ModalHandle): HTMLElement {
  const foot = document.createElement("div");
  foot.className = "op-modal-footer";

  // Destructive action lives at the far-left edge, away from Cancel/Save,
  // behind its own two-step confirm (armed in wireOperatorModal).
  const leftGroup = document.createElement("div");
  leftGroup.className = "op-modal-footer-left";
  if (h.state.mode === "edit" && h.state.existing) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "op-modal-delete";
    del.textContent = "Delete";
    // Class + guard instead of `disabled` — disabled buttons swallow the
    // mouse events attachTooltip needs to explain WHY it's off.
    if (h.state.isDefault) {
      del.classList.add("is-disabled");
      attachTooltip(del, "Default operator — promote another operator to default first");
    }
    leftGroup.append(del);
  }

  const left = document.createElement("label");
  left.className = "op-modal-default-toggle";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = h.state.setAsDefault;
  // Existing default can't un-default itself directly — must promote another.
  cb.disabled = h.state.isDefault;
  cb.addEventListener("change", () => h.setAsDefault(cb.checked));
  const cbLbl = document.createElement("span");
  cbLbl.textContent = h.state.isDefault ? "Default operator" : "Set as default";
  left.append(cb, cbLbl);
  leftGroup.append(left);
  foot.append(leftGroup);

  const right = document.createElement("div");
  right.className = "op-modal-footer-actions settings-actions";

  // Inline save-failure line (replaces the old native alert()).
  const errOut = document.createElement("span");
  errOut.className = "op-modal-footer-error";
  right.append(errOut);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "settings-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => requestClose(h));
  right.append(cancel);

  const save = document.createElement("button");
  save.type = "button";
  save.className = "op-modal-save settings-save";
  save.textContent = h.state.mode === "edit" ? "Save changes" : "Create operator";
  // SOUL.md is now the source of truth; gate save on the raw text being
  // non-empty rather than the (vestigial) draft name. Backend
  // `operator_*_from_soul` does the authoritative validation.
  save.disabled = h.state.soulRaw.trim().length === 0;
  right.append(save);

  foot.append(right);
  return foot;
}

type ModelOption = { value: string; label: string };

/// Static fallback list, used only when the configured Operator provider
/// can't be reached (offline, no key) so the dropdown is never empty.
const MODELS: ModelOption[] = [
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-opus-4-7", label: "Opus 4.7" },
];

/// Ensure the operator's currently-selected model stays selectable even
/// if the provider doesn't list it (custom/legacy id).
export function withCurrentModel(opts: ModelOption[], current?: string): ModelOption[] {
  if (current && !opts.some((m) => m.value === current)) {
    return [...opts, { value: current, label: `${current} (custom)` }];
  }
  return opts;
}

/// Resolve the model dropdown options from the provider configured for the
/// `operator` role in Settings → Models (the same source the Models tab
/// uses), so the picker lists exactly the models that provider serves.
/// Falls back to the static `MODELS` list if the provider is unreachable.
export async function operatorModelOptions(current?: string): Promise<ModelOption[]> {
  try {
    const settings = await getSettings();
    const route = settings.model_routes?.operator;
    const entry = route ? settings.providers?.[route.provider_id] : undefined;
    if (!entry) return withCurrentModel([...MODELS], current);

    let models: ModelInfo[];
    if (entry.kind === "anthropic") {
      models = await listModelsAnthropic();
    } else if (entry.kind === "azure_foundry") {
      models = await listModelsAzureFoundry({
        endpoint: entry.base_url ?? "",
        apiKey: entry.api_key ?? "",
        mode: entry.azure_mode ?? "azure_open_ai",
        apiVersion:
          entry.azure_api_version ??
          (entry.azure_mode === "ai_inference"
            ? "2024-05-01-preview"
            : "2024-10-21"),
      });
    } else {
      models = await listModelsOpenAiCompat(entry.base_url ?? "");
    }

    const opts: ModelOption[] = models.map((m) => ({
      value: m.id,
      label: m.label ?? m.id,
    }));
    return withCurrentModel(opts.length ? opts : [...MODELS], current);
  } catch {
    return withCurrentModel([...MODELS], current);
  }
}

/// Persist the operator via the SOUL.md (`*_from_soul`) commands. Returns
/// the created/updated operator so the caller can drive the post-save
/// set-default + toast flow off real backend data.
export async function saveOperator(h: ModalHandle): Promise<Operator> {
  const { operatorCreateFromSoul, operatorUpdateFromSoul } = await import("../api");
  if (h.state.mode === "edit" && h.state.existingId) {
    return operatorUpdateFromSoul(h.state.existingId, h.state.soulRaw);
  }
  return operatorCreateFromSoul(h.state.soulRaw);
}

export interface WireOpts {
  /** After a successful save. Receives the saved operator. */
  onSaved: (op: Operator) => void | Promise<void>;
  /** Delete button in edit mode. Omit to hide/ignore. */
  onDelete?: (op: Operator) => void | Promise<void>;
  /**
   * Org to assign after a successful save. `undefined` = don't touch;
   * a string = assign to that org; `null` = clear to personal (used to
   * rescue stale-org operators on edit). Applies in BOTH modes.
   */
  assignOrgSlug?: string | null;
}

/// Wire a modal handle's save/delete/close lifecycle. Ported verbatim from
/// the settings pane's former `openModalWith` so both the legacy settings
/// surface and the cockpit's immersive create surface (Task 4) share one
/// implementation of "what happens when Save/Delete/Escape fires."
export function wireOperatorModal(handle: ModalHandle, opts: WireOpts): void {
  // The modal autowires its save button to `saveOperator(h)`; we observe
  // completion by wrapping saveOperator + refresh in a capturing click
  // handler on the modal root (event delegation, since the save button is
  // re-rendered on every full render()).
  handle.el.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement | null;
    if (!target) return;
    if (target.classList.contains("op-modal-save")) {
      ev.stopImmediatePropagation();
      ev.preventDefault();
      const errOut = handle.el.querySelector<HTMLElement>(".op-modal-footer-error");
      if (errOut) errOut.textContent = "";
      (async () => {
        try {
          // saveOperator now routes through the from-soul commands and
          // returns the persisted operator — use it for the set-default
          // + toast flow instead of the (now vestigial) draft.
          const saved = await saveOperator(handle);
          // Assign (or clear) the operator's org if the caller asked for it.
          // Applies in both create and edit mode — `undefined` means "don't
          // touch", so callers that don't care about org assignment (e.g.
          // the plain settings pane) simply omit this option.
          if (opts.assignOrgSlug !== undefined && saved.id) {
            try { await operatorSetOrg(saved.id, opts.assignOrgSlug); } catch (e) {
              console.warn("operator_set_org failed", e);
            }
          }
          // Promote to default if the toggle was flipped on.
          if (handle.state.setAsDefault && !handle.state.isDefault && saved.id) {
            try { await operatorSetDefault(saved.id); } catch (e) {
              console.warn("operator_set_default failed", e);
            }
          }
          // Persist GitHub access if it changed — registry-side field,
          // not carried by the SOUL.md save path.
          const prevAccess = handle.state.mode === "edit"
            ? (handle.state.existing?.github_access ?? "Off")
            : "Off";
          if (saved.id && handle.state.githubAccess !== prevAccess) {
            try { await operatorSetGithubAccess(saved.id, handle.state.githubAccess); } catch (e) {
              console.warn("operator_set_github_access failed", e);
            }
          }
          // Same registry-side pattern for the dispatch_acp gate.
          const prevAcp = handle.state.mode === "edit"
            ? (handle.state.existing?.acp_enabled ?? false)
            : false;
          if (saved.id && handle.state.acpEnabled !== prevAcp) {
            try { await operatorSetAcpEnabled(saved.id, handle.state.acpEnabled); } catch (e) {
              console.warn("operator_set_acp_enabled failed", e);
            }
          }
          // Same registry-side pattern for the perception (auto-answer) gate.
          const prevPerception = handle.state.mode === "edit"
            ? (handle.state.existing?.perception_enabled ?? false)
            : false;
          if (saved.id && handle.state.perceptionEnabled !== prevPerception) {
            try { await operatorSetPerceptionEnabled(saved.id, handle.state.perceptionEnabled); } catch (e) {
              console.warn("operator_set_perception_enabled failed", e);
            }
          }
          closeCreator(handle.el);
          await opts.onSaved(saved);
          pushInfoToast({
            message: `${handle.state.mode === "edit" ? "Saved" : "Created"} operator: ${saved.name}`,
          });
        } catch (e) {
          console.error("operator save failed", e);
          // Inline, next to the Save button — the modal stays open with the
          // user's work intact; no native alert over the takeover.
          if (errOut) errOut.textContent = `Save failed: ${e}`;
        }
      })();
    } else if (target.classList.contains("op-modal-delete")) {
      ev.stopImmediatePropagation();
      ev.preventDefault();
      if (target.classList.contains("is-disabled")) return;
      // Two-step confirm on the button itself: first click arms for 3s.
      if (!target.classList.contains("is-armed")) {
        target.classList.add("is-armed");
        target.textContent = "Confirm delete";
        window.setTimeout(() => {
          target.classList.remove("is-armed");
          target.textContent = "Delete";
        }, 3000);
        return;
      }
      const existing = handle.state.existing;
      if (!existing) return;
      (async () => {
        await opts.onDelete?.(existing);
        closeCreator(handle.el);
      })();
    }
  }, true);

  // Lightweight close affordance: click outside the inner card or
  // press Escape. We don't have a wrapper backdrop in the modal,
  // so add a global Escape listener tied to this modal instance.
  const onKey = (e: KeyboardEvent): void => {
    if (!document.body.contains(handle.el)) return;
    if (e.key === "Escape") {
      requestClose(handle);
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      const save = handle.el.querySelector<HTMLButtonElement>(".op-modal-save");
      if (save && !save.disabled) save.click();
    }
  };
  document.addEventListener("keydown", onKey);
  // Tear down the keydown listener once the modal element is removed,
  // no matter which close path (scrim/Cancel/esc-pill/Save/Delete) fired.
  const teardownObserver = new MutationObserver(() => {
    if (!document.body.contains(handle.el)) {
      document.removeEventListener("keydown", onKey);
      teardownObserver.disconnect();
    }
  });
  teardownObserver.observe(document.body, { childList: true, subtree: true });
}

export interface ListHandlers {
  onEdit(op: Operator): void;
  onDelete(op: Operator): void;
  onDuplicate(op: Operator): void;
  onPublish?(op: Operator): void;
  /** True when the operator's org is one we no longer know about (deleted
   *  server-side). Renders an "unassigned" badge so the org-scoped cockpit
   *  roster surfaces stale operators instead of silently hiding them. */
  isStale?(op: Operator): boolean;
}

export function renderOperatorList(ops: Operator[], h: ListHandlers): HTMLElement {
  const root = document.createElement("div");
  root.className = "op-card-grid";
  for (const op of ops) {
    // The card is a delegation credential: identity (spine + avatar + name +
    // mandate line), disposition (escalation gauge), harness (model chip +
    // capability marks), then one quiet tag line. The operator's color lives
    // in the 2px spine + avatar tile — a mark, not a wash.
    const card = document.createElement("div");
    card.className = "op-card";
    card.style.setProperty("--operator-color", op.color);

    const head = document.createElement("div");
    head.className = "op-card-head";
    const avatar = document.createElement("span");
    avatar.className = "op-card-avatar";
    avatar.innerHTML = renderAvatarHtml(op.emoji || "🟣", 26);
    const id = document.createElement("span");
    id.className = "op-card-id";
    const name = document.createElement("span");
    name.className = "op-card-name";
    name.textContent = op.name;
    const mandate = document.createElement("span");
    mandate.className = "op-card-mandate";
    mandate.textContent = [op.org_slug ?? "personal", op.voice].filter(Boolean).join(" · ");
    id.append(name, mandate);
    const badges = document.createElement("span");
    badges.className = "op-card-badges";
    if (op.is_default) {
      const b = document.createElement("span");
      b.className = "op-card-badge";
      b.textContent = "default";
      badges.append(b);
    }
    if (h.isStale?.(op)) {
      const b = document.createElement("span");
      b.className = "op-card-badge is-warn";
      b.textContent = "unassigned";
      attachTooltip(b, `Org "${op.org_slug}" is gone — edit to reassign`);
      badges.append(b);
    }
    head.append(avatar, id, badges);
    card.append(head);

    const pct = Math.round(Math.min(1, Math.max(0, op.escalate_threshold)) * 100);
    const gauge = document.createElement("div");
    gauge.className = "op-card-gauge";
    gauge.innerHTML =
      `<div class="op-card-gauge-top">` +
      `<span class="op-card-gauge-lbl">Escalation threshold</span>` +
      `<span class="op-card-gauge-val">${op.escalate_threshold.toFixed(2)}</span></div>` +
      `<div class="op-card-bar"><span class="op-card-bar-fill" style="width:${pct}%"></span></div>`;
    card.append(gauge);

    const rig = document.createElement("div");
    rig.className = "op-card-rig";
    const model = document.createElement("span");
    model.className = "op-card-model";
    model.textContent = op.model || "—";
    const caps = document.createElement("span");
    caps.className = "op-card-caps";
    const cap = (label: string, on: boolean, tip: string): HTMLElement => {
      const c = document.createElement("span");
      c.className = on ? "op-card-cap is-on" : "op-card-cap";
      c.textContent = label;
      attachTooltip(c, tip);
      return c;
    };
    caps.append(
      cap("GH", op.github_access !== "Off", `GitHub tools: ${op.github_access}`),
      cap("ACP", op.acp_enabled, op.acp_enabled ? "ACP chat enabled" : "ACP chat off"),
    );
    rig.append(model, caps);
    card.append(rig);

    const tags = op.tags.map((t) => t.trim()).filter(Boolean);
    if (tags.length > 0) {
      const line = document.createElement("div");
      line.className = "op-card-tags";
      // Separate text span so the +N counter never gets eaten by the
      // ellipsis — the text truncates, the counter stays pinned.
      const text = document.createElement("span");
      text.className = "op-card-tagtext";
      text.textContent = tags.slice(0, 4).join(" · ");
      line.append(text);
      if (tags.length > 4) {
        const more = document.createElement("span");
        more.className = "op-card-tagmore";
        more.textContent = ` +${tags.length - 4}`;
        attachTooltip(more, tags.slice(4).join(", "));
        line.append(more);
      }
      card.append(line);
    }
    const actions = document.createElement("div");
    actions.className = "op-card-actions";
    const mk = (label: string, icon: string, fn: () => void, danger = false) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = danger ? "op-card-iconbtn is-danger" : "op-card-iconbtn";
      b.innerHTML = icon;
      b.setAttribute("aria-label", label);
      attachTooltip(b, label);
      b.addEventListener("click", fn);
      return b;
    };
    actions.append(mk("Edit", Icons.pencil(), () => h.onEdit(op)));
    actions.append(mk("Duplicate", Icons.copy(), () => h.onDuplicate(op)));
    if (h.onPublish) {
      actions.append(mk("Publish", Icons.upload(), () => h.onPublish!(op)));
    }
    actions.append(mk("Delete", Icons.trash(), () => h.onDelete(op), true));
    card.append(actions);
    root.append(card);
  }
  return root;
}
