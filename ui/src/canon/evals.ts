// Running a unit's evals — the Evaluate phase, shared by the rail panel and
// the cockpit's unit lists so the verdict can live next to the unit it judges
// instead of only in the aggregate.
//
// A run costs real tokens (every eval is a full agent run plus a judge call),
// so it is always gated by the in-app confirm card — never a native dialog,
// which Tauri's capability set doesn't allow anyway.

import {
  canonCancelEvals,
  canonDeleteEval,
  canonDraftEvals,
  canonEvalDetail,
  canonListEvals,
  canonRunEvals,
  canonUpdateEval,
  canonWriteEvals,
  onCanonEvalProgress,
  type CanonEvalCriterion,
  type CanonEvalDraft,
  type CanonEvalProgress,
  type CanonRunEvalsOpts,
} from "../api";
import { Icons } from "../icons";
import { pushInfoToast } from "../notifications/toast";
import { openConfirmPrompt } from "../workspaces/confirm-prompt";

// --- run registry + global event relay ------------------------------------
//
// The BACKEND owns run state (its registry, hydrated via canon_list_eval_runs);
// this map only tracks which runs currently have a pill on screen. Dismissing
// a pill loses nothing — the cockpit (⌘⌥E) shows every run either way.

interface RunEntry {
  kind: string;
  name: string;
  cwd?: string;
  runId?: string;
  pill: EvalPill;
  done: boolean;
  /** The user closed the pill mid-run — keep tracking silently, toast on done. */
  dismissed: boolean;
}

/** Live + finished-but-not-dismissed runs, keyed `kind/name`. */
const runs = new Map<string, RunEntry>();

// Ambient chrome (the status-bar chip) subscribes to the live-run count so a
// dismissed pill always leaves a door back to the cockpit.
const runsListeners = new Set<() => void>();

function notifyRunsChanged(): void {
  for (const l of runsListeners) l();
}

/** Runs currently executing (dismissed pills included). */
export function liveEvalRunCount(): number {
  return [...runs.values()].filter((r) => !r.done).length;
}

/** Subscribe to live-run count changes; returns the unsubscribe. */
export function onEvalRunsChanged(cb: () => void): () => void {
  runsListeners.add(cb);
  return () => runsListeners.delete(cb);
}

let relayReady: Promise<void> | undefined;

/** One global `canon-eval-progress` listener for the app's lifetime. Routes
 *  events to the right pill — and (the reload case) recreates a pill for a
 *  backend run that lost its window, so a mid-run reload isn't a silent orphan. */
export function initEvalProgressRelay(): Promise<void> {
  relayReady ??= onCanonEvalProgress((e) => handleProgress(e)).then(() => {});
  return relayReady;
}

function handleProgress(e: CanonEvalProgress): void {
  const key = `${e.kind}/${e.name}`;
  if (e.status === "push_failed") {
    pushInfoToast({ message: `Evals for ${e.name}: ${e.reason}` });
    return;
  }
  let run = runs.get(key);
  if (!run) {
    if (e.status === "done") return; // nothing to show for a finished stranger
    // A backend run with no pill (window reloaded mid-run): rebuild one.
    run = { kind: e.kind, name: e.name, pill: openEvalPill(key, e.name, 0), done: false, dismissed: false };
    runs.set(key, run);
    notifyRunsChanged();
  }
  if (e.run_id) run.runId = e.run_id;
  if (e.status === "done") {
    run.done = true;
    notifyRunsChanged();
    if (run.dismissed) {
      // The pill was closed mid-run; the finish still deserves one line.
      const t = run.pill.tallyText();
      pushInfoToast({
        message: `Evals — ${run.name}: ${e.reason === "cancelled" ? "stopped" : t}`,
      });
      runs.delete(key);
    } else {
      run.pill.finish(e.reason === "cancelled" ? "stopped" : "");
    }
  } else if (e.eval_id === "") {
    run.pill.finishAll(e.status === "error" ? "error" : "skipped", e.reason);
  } else {
    run.pill.setStatus(e.eval_id, e.status, e.reason, e.arm, e.duration_ms ?? undefined);
  }
}

// --- run flow --------------------------------------------------------------

/** Confirm (with the real cost arithmetic), then run. `onDone` refreshes
 *  whatever surface asked. `opts.only` runs a single eval; `opts.baseline:
 *  false` skips the control arm. */
export function runEvals(
  cwd: string,
  kind: string,
  name: string,
  btn: HTMLButtonElement,
  onDone: () => void | Promise<void>,
  opts?: CanonRunEvalsOpts,
): void {
  const key = `${kind}/${name}`;
  const live = runs.get(key);
  if (live && !live.done) {
    // Already running: surface the pill instead of stacking a second run.
    live.dismissed = false;
    reattachPill(live.pill);
    pushInfoToast({ message: `Evals for ${name} are already running.` });
    return;
  }
  void (async () => {
    const all = await canonListEvals(cwd, kind, name).catch(() => []);
    const ids = (opts?.only ? all.filter((e) => e.id === opts.only) : all).map((e) => e.id);
    if (ids.length === 0) {
      pushInfoToast({
        message: `No evals for ${name} — use Draft evals, or add .toml files under .covenant/canon/evals/${kind}/${name}/`,
      });
      return;
    }
    const arms = opts?.baseline === false ? 1 : 2;
    const n = ids.length;
    const sharing = kind === "skill"
      ? "Eval names and pass/fail are shared with your org's registry — never the judge's reasoning."
      : "Results stay on this machine — only skills installed from a registry share pass/fail.";
    openConfirmPrompt({
      label: "Run evals",
      message:
        `Run ${n} eval${n === 1 ? "" : "s"} for "${name}"? ` +
        `That's ${n * arms} sandboxed agent run${n * arms === 1 ? "" : "s"} (≤2 min each` +
        `${arms === 2 ? ", incl. the no-context baseline" : ", baseline skipped"}) ` +
        `plus up to ${n * arms} judge calls. You can stop it from the progress pill, and watch it in the Evals cockpit (⌘⌥E). ${sharing}`,
      confirmText: "Run",
      onConfirm: () => { void execute(cwd, kind, name, ids.length, btn, onDone, opts); },
    });
  })();
}

async function execute(
  cwd: string,
  kind: string,
  name: string,
  total: number,
  btn: HTMLButtonElement,
  onDone: () => void | Promise<void>,
  opts?: CanonRunEvalsOpts,
): Promise<void> {
  btn.disabled = true;
  const key = `${kind}/${name}`;
  // A one-line ambient pill, not a case list — the cockpit (⌘⌥E) is where a
  // run is inspected. The pill is just the signal that something is running.
  const pill = openEvalPill(key, name, total, cwd);
  runs.set(key, { kind, name, cwd, pill, done: false, dismissed: false });
  notifyRunsChanged();
  try {
    await initEvalProgressRelay();
    await canonRunEvals(cwd, kind, name, opts);
    pill.finish();
    await onDone();
  } catch (e) {
    pill.finishAll("error", String(e));
    pushInfoToast({ message: `Run evals failed: ${String(e)}` });
  } finally {
    const run = runs.get(key);
    if (run) run.done = true;
    notifyRunsChanged();
    btn.disabled = false;
  }
}

// --- progress pill ---------------------------------------------------------

type EvalCaseStatus = "pending" | "running" | "pass" | "fail" | "skipped" | "error";

export interface EvalPill {
  element: HTMLElement;
  setStatus(id: string, status: string, reason: string, arm?: string, durationMs?: number): void;
  finishAll(status: EvalCaseStatus, reason: string): void;
  finish(note?: string): void;
  /** Current tally line, e.g. "3/5 pass" — used for the dismissed-run toast. */
  tallyText(): string;
}

/** Auto-dismiss delay for a finished pill; the chip on the unit's row is the
 *  permanent record, the cockpit the detailed one. */
const PILL_LINGER_MS = 15_000;

/** Pills stack in one fixed bottom-right column, one per unit. */
function pillStack(): HTMLElement {
  let stack = document.querySelector<HTMLElement>(".canon-eval-pill-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "canon-eval-pill-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

function reattachPill(pill: EvalPill): void {
  if (!pill.element.isConnected) pillStack().appendChild(pill.element);
}

/** Shown once per app session, the first time a live pill is dismissed. */
let closeHintShown = false;

/** One-line ambient progress pill: dot · name · bar · n/m · elapsed · Stop ·
 *  Expand · ×. The run's durable state lives in the backend registry, so the
 *  × only hides this viewport — the cockpit (⌘⌥E) still shows everything. */
export function openEvalPill(
  key: string,
  name: string,
  total: number,
  cwd?: string,
): EvalPill {
  // One pill per unit: replace a same-unit pill, stack across units. The key
  // charset is valid_pkg_name + "/" — no quoting hazards in the selector.
  document.querySelector(`.canon-eval-pill[data-key="${key}"]`)?.remove();

  const el = document.createElement("div");
  el.className = "canon-eval-pill";
  el.dataset.key = key;

  const dot = document.createElement("span");
  dot.className = "canon-eval-pill-dot is-running";
  const label = document.createElement("span");
  label.className = "canon-eval-pill-label";
  label.textContent = "Evals"; // uppercased via CSS, per DESIGN.md rule 6
  const nameEl = document.createElement("span");
  nameEl.className = "canon-eval-pill-name";
  nameEl.textContent = name;
  const bar = document.createElement("span");
  bar.className = "canon-eval-pill-bar";
  const fill = document.createElement("i");
  bar.appendChild(fill);
  const tally = document.createElement("span");
  tally.className = "canon-eval-pill-tally";
  const elapsed = document.createElement("span");
  elapsed.className = "canon-eval-pill-elapsed";
  elapsed.textContent = "0:00";

  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "canon-eval-pill-stop";
  stopBtn.textContent = "Stop";
  const [kind = "", unit = name] = key.split("/") as [string?, string?];
  stopBtn.addEventListener("click", () => {
    stopBtn.disabled = true;
    stopBtn.textContent = "Stopping…";
    canonCancelEvals(kind, unit).catch((e) => {
      stopBtn.disabled = false;
      stopBtn.textContent = "Stop";
      pushInfoToast({ message: `Stop failed: ${String(e)}` });
    });
  });

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "canon-eval-pill-expand";
  expandBtn.textContent = "Expand";
  expandBtn.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("covenant:open-evals", {
      detail: { cwd, kind, name: unit },
    }));
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "canon-eval-pill-close";
  closeBtn.setAttribute("aria-label", "Hide");
  closeBtn.innerHTML = Icons.x({ size: 12 });
  closeBtn.addEventListener("click", () => {
    el.remove();
    const run = runs.get(key);
    if (!run) return;
    if (run.done) {
      runs.delete(key);
    } else {
      // The run keeps going in the backend; say so exactly once per session.
      run.dismissed = true;
      if (!closeHintShown) {
        closeHintShown = true;
        pushInfoToast({ message: "Run continues in background — Evals cockpit (⌘⌥E) has it." });
      }
    }
  });

  el.append(dot, label, nameEl, bar, tally, elapsed, stopBtn, expandBtn, closeBtn);
  pillStack().appendChild(el);

  const statuses = new Map<string, EvalCaseStatus>();
  let done = false;
  let dismissTimer: ReturnType<typeof setTimeout> | undefined;

  const startedAt = Date.now();
  const tick = (): void => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    elapsed.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const timer = setInterval(tick, 1000);

  const counts = (): { settled: number; passed: number; all: number } => {
    const vals = [...statuses.values()];
    return {
      settled: vals.filter((s) => s !== "pending" && s !== "running").length,
      passed: vals.filter((s) => s === "pass").length,
      all: Math.max(total, statuses.size),
    };
  };
  const sync = (): void => {
    const { settled, passed, all } = counts();
    tally.textContent = done ? `${passed}/${all} pass` : `${settled}/${all}`;
    fill.style.width = all > 0 ? `${Math.round((settled / all) * 100)}%` : "0%";
    if (done) {
      const failed = [...statuses.values()].some((s) => s === "fail" || s === "error");
      dot.className = `canon-eval-pill-dot ${failed || passed < all ? "is-fail" : "is-pass"}`;
    }
  };
  sync();

  const finishChrome = (note?: string): void => {
    if (done) return;
    done = true;
    clearInterval(timer);
    el.classList.add("is-done");
    stopBtn.remove();
    if (note) nameEl.textContent = `${name} · ${note}`;
    sync();
    dismissTimer = setTimeout(() => {
      el.remove();
      const run = runs.get(key);
      if (run?.done) runs.delete(key);
    }, PILL_LINGER_MS);
    // A finished pill that's already hidden shouldn't resurrect a timer leak.
    if (!el.isConnected && dismissTimer) clearTimeout(dismissTimer);
  };

  return {
    element: el,
    setStatus(id, status, _reason, _arm, _durationMs) {
      const s: EvalCaseStatus =
        status === "running" || status === "pass" || status === "fail" ||
        status === "skipped" || status === "error"
          ? status
          : "pending";
      statuses.set(id, s);
      sync();
    },
    finishAll(status, reason) {
      for (const [id, s] of statuses) {
        if (s === "pending" || s === "running") statuses.set(id, status);
      }
      if (statuses.size === 0 && reason) nameEl.textContent = `${name} · ${reason}`;
      finishChrome();
    },
    finish(note?: string) {
      for (const [id, s] of statuses) {
        if (s === "pending" || s === "running") statuses.set(id, "skipped");
      }
      finishChrome(note);
    },
    tallyText() {
      const { passed, all } = counts();
      return `${passed}/${all} pass`;
    },
  };
}

// --- per-eval detail (transcripts) ----------------------------------------

/** Read-only overlay with the last run's full record: scenario, rubric,
 *  verdict + reason in full, models, and both transcripts. */
export async function openEvalDetail(
  cwd: string,
  kind: string,
  name: string,
  evalId: string,
): Promise<void> {
  let d;
  try {
    d = await canonEvalDetail(cwd, kind, name, evalId);
  } catch (e) {
    pushInfoToast({ message: String(e) });
    return;
  }
  document.querySelector(".canon-eval-detail-overlay")?.remove();
  const overlay = document.createElement("div");
  overlay.className = "command-palette-overlay canon-eval-detail-overlay";
  const card = document.createElement("div");
  card.className = "command-palette-card canon-draft-card canon-eval-detail-card";

  const label = document.createElement("span");
  label.className = "command-palette-label";
  label.textContent = `${evalId} — ${d.pass ? "PASS" : "FAIL"}`;
  card.appendChild(label);

  const meta = document.createElement("div");
  meta.className = "canon-eval-detail-meta";
  const bits = [
    new Date(d.ran_at_ms).toLocaleString(),
    `${Math.round(d.duration_ms / 1000)}s`,
    d.executor_model ? `agent ${d.executor_model}` : "",
    d.judge_model ? `judge ${d.judge_model}` : "",
    d.baseline_pass === null ? "no baseline" : `baseline ${d.baseline_pass ? "pass" : "fail"}`,
  ].filter(Boolean);
  meta.textContent = bits.join(" · ");
  card.appendChild(meta);

  const body = document.createElement("div");
  body.className = "canon-eval-detail-body";
  const section = (caption: string, text: string, mono = false): void => {
    if (!text) return;
    const cap = document.createElement("div");
    cap.className = "canon-eval-detail-cap";
    cap.textContent = caption;
    const val = document.createElement(mono ? "pre" : "div");
    val.className = mono ? "canon-eval-detail-pre" : "canon-eval-detail-text";
    val.textContent = text;
    body.append(cap, val);
  };
  section("Scenario", d.scenario);
  section("Rubric", d.rubric);
  section("Judge reason", d.reason);
  section("Transcript", d.transcript, true);
  if (d.baseline_transcript) section("Baseline transcript", d.baseline_transcript, true);
  card.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "canon-draft-foot";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "workspace-confirm-cancel";
  closeBtn.textContent = "Close";
  foot.appendChild(closeBtn);
  card.appendChild(foot);
  overlay.appendChild(card);

  const close = (): void => overlay.remove();
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  document.body.appendChild(overlay);
  closeBtn.focus();
}

// --- evals manager ---------------------------------------------------------

/** Browse / edit / add / delete / run a unit's authored evals — the missing
 *  middle between "LLM drafts them" and "hand-edit TOML on disk". */
export async function openEvalManager(
  cwd: string,
  kind: string,
  name: string,
  onDone: () => void | Promise<void>,
): Promise<void> {
  const evals = await canonListEvals(cwd, kind, name).catch(() => [] as CanonEvalDraft[]);
  document.querySelector(".canon-eval-manager-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "command-palette-overlay canon-draft-overlay canon-eval-manager-overlay";
  const card = document.createElement("div");
  card.className = "command-palette-card canon-draft-card";

  const label = document.createElement("span");
  label.className = "command-palette-label";
  label.textContent = `Evals — ${name}`;
  card.appendChild(label);

  const list = document.createElement("div");
  list.className = "canon-draft-list";
  card.appendChild(list);

  const close = (): void => overlay.remove();

  const addItem = (ev: CanonEvalDraft, isNew: boolean): void => {
    const row = document.createElement("div");
    row.className = "canon-draft-item canon-eval-manage-item";
    const body = document.createElement("div");
    body.className = "canon-draft-item-body";
    let idEl: HTMLElement | HTMLInputElement;
    if (isNew) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "canon-draft-item-id-input";
      input.placeholder = "eval-id";
      input.setAttribute("aria-label", "eval id");
      idEl = input;
    } else {
      const id = document.createElement("div");
      id.className = "canon-draft-item-id";
      id.textContent = ev.id;
      idEl = id;
    }
    const scenario = draftField("Scenario", ev.scenario);
    const hasCriteria = !!(ev.criteria && ev.criteria.length > 0);
    // Weighted criteria are drafted, not hand-edited here — editing weights is
    // YAGNI until asked for (matches the draft review drawer). Show them
    // read-only and carry them through untouched; only legacy rubric-only
    // evals get the editable textarea.
    const rubric = hasCriteria ? undefined : draftField("Rubric", ev.rubric);
    const criteriaEl = hasCriteria ? criteriaList(ev.criteria as CanonEvalCriterion[]) : undefined;
    const actions = document.createElement("div");
    actions.className = "canon-eval-manage-actions";

    const currentId = (): string =>
      isNew ? (idEl as HTMLInputElement).value.trim() : ev.id;

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "workspace-confirm-cancel";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", () => {
      const id = currentId();
      const draft: CanonEvalDraft = hasCriteria
        ? { id, scenario: scenario.input.value, rubric: ev.rubric, criteria: ev.criteria }
        : { id, scenario: scenario.input.value, rubric: rubric!.input.value };
      saveBtn.disabled = true;
      const write = isNew
        ? canonWriteEvals(cwd, kind, name, [draft]).then(() => undefined)
        : canonUpdateEval(cwd, kind, name, draft);
      write
        .then(async () => {
          pushInfoToast({ message: `Saved ${id}` });
          await onDone();
          if (isNew) { close(); void openEvalManager(cwd, kind, name, onDone); }
        })
        .catch((e) => pushInfoToast({ message: `Save failed: ${String(e)}` }))
        .finally(() => { saveBtn.disabled = false; });
    });

    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "workspace-confirm-cancel";
    runBtn.textContent = "Run";
    if (isNew) runBtn.disabled = true;
    runBtn.addEventListener("click", () => {
      close();
      runEvals(cwd, kind, name, runBtn, onDone, {
        only: currentId(),
        baseline: baselineCheck.checked,
      });
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "workspace-confirm-cancel canon-eval-manage-delete";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => {
      if (isNew) { row.remove(); return; }
      openConfirmPrompt({
        label: "Delete eval",
        message: `Delete eval "${ev.id}" for ${name}? Its stored verdict and transcript go with it.`,
        confirmText: "Delete",
        onConfirm: () => {
          canonDeleteEval(cwd, kind, name, ev.id)
            .then(async () => { row.remove(); await onDone(); })
            .catch((e) => pushInfoToast({ message: `Delete failed: ${String(e)}` }));
        },
      });
    });

    actions.append(saveBtn, runBtn, delBtn);
    if (!isNew) {
      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "workspace-confirm-cancel";
      viewBtn.textContent = "Last run";
      viewBtn.addEventListener("click", () => { void openEvalDetail(cwd, kind, name, ev.id); });
      actions.appendChild(viewBtn);
    }
    body.append(idEl, scenario.wrap, (criteriaEl ?? rubric!.wrap), actions);
    row.appendChild(body);
    list.appendChild(row);
  };

  if (evals.length === 0) {
    const empty = document.createElement("div");
    empty.className = "canon-eval-manager-empty";
    empty.textContent = "No evals yet — draft some, or add one below.";
    list.appendChild(empty);
  }
  for (const ev of evals) addItem(ev, false);

  const foot = document.createElement("div");
  foot.className = "canon-draft-foot";
  const note = document.createElement("span");
  note.className = "canon-draft-note";
  note.textContent = `→ .covenant/canon/evals/${kind}/${name}/`;

  const baselineWrap = document.createElement("label");
  baselineWrap.className = "canon-eval-manage-baseline";
  const baselineCheck = document.createElement("input");
  baselineCheck.type = "checkbox";
  baselineCheck.checked = true;
  baselineCheck.setAttribute("aria-label", "measure baseline lift");
  baselineWrap.append(baselineCheck, document.createTextNode("baseline lift"));

  const newBtn = document.createElement("button");
  newBtn.type = "button";
  newBtn.className = "workspace-confirm-cancel";
  newBtn.textContent = "New eval";
  newBtn.addEventListener("click", () => addItem({ id: "", scenario: "", rubric: "" }, true));

  const runAllBtn = document.createElement("button");
  runAllBtn.type = "button";
  runAllBtn.className = "workspace-confirm-confirm";
  runAllBtn.textContent = "Run all";
  runAllBtn.disabled = evals.length === 0;
  runAllBtn.addEventListener("click", () => {
    close();
    runEvals(cwd, kind, name, runAllBtn, onDone, { baseline: baselineCheck.checked });
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "workspace-confirm-cancel";
  closeBtn.textContent = "Close";
  closeBtn.addEventListener("click", close);

  foot.append(note, baselineWrap, newBtn, closeBtn, runAllBtn);
  card.appendChild(foot);
  overlay.appendChild(card);
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  document.body.appendChild(overlay);
}

// --- draft flow ------------------------------------------------------------

/** Confirm, then draft evals and open the review drawer. Files are written
 *  only when the user approves a set — a re-draft never clobbers anything
 *  unless "overwrite existing" is explicitly checked. */
export function draftEvals(
  cwd: string,
  kind: string,
  name: string,
  btn: HTMLButtonElement,
  onDone: () => void | Promise<void>,
): void {
  openConfirmPrompt({
    label: "Draft evals",
    message:
      `Draft evals for "${name}"? An LLM reads the unit and proposes 3–5 scenario/rubric pairs ` +
      `for you to review and edit — nothing is written until you approve them.`,
    confirmText: "Draft",
    onConfirm: () => { void executeDraft(cwd, kind, name, btn, onDone); },
  });
}

async function executeDraft(
  cwd: string,
  kind: string,
  name: string,
  btn: HTMLButtonElement,
  onDone: () => void | Promise<void>,
): Promise<void> {
  btn.disabled = true;
  pushInfoToast({ message: `Drafting evals for ${name}…` });
  try {
    const drafts = await canonDraftEvals(cwd, kind, name);
    openDraftReview(cwd, kind, name, drafts, btn, onDone);
  } catch (e) {
    pushInfoToast({ message: `Draft evals failed: ${String(e)}` });
  } finally {
    btn.disabled = false;
  }
}

/** Review drawer: drafts as editable cards (id included) with include-
 *  checkboxes; the approved set is written on confirm, then Run evals is
 *  offered. Exported for tests. */
export function openDraftReview(
  cwd: string,
  kind: string,
  name: string,
  drafts: CanonEvalDraft[],
  btn: HTMLButtonElement,
  onDone: () => void | Promise<void>,
): void {
  document.querySelector(".canon-draft-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "command-palette-overlay canon-draft-overlay";
  const card = document.createElement("div");
  card.className = "command-palette-card canon-draft-card";

  const label = document.createElement("span");
  label.className = "command-palette-label";
  label.textContent = `Draft evals — ${name}`;
  card.appendChild(label);

  const list = document.createElement("div");
  list.className = "canon-draft-list";
  const rows = drafts.map((d) => {
    const row = document.createElement("div");
    row.className = "canon-draft-item";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    check.setAttribute("aria-label", `include ${d.id}`);
    const body = document.createElement("div");
    body.className = "canon-draft-item-body";
    // Editable id: a bad model slug shouldn't need a disk round-trip to fix.
    const id = document.createElement("input");
    id.type = "text";
    id.className = "canon-draft-item-id-input";
    id.value = d.id;
    id.setAttribute("aria-label", `id for ${d.id}`);
    const scenario = draftField("Scenario", d.scenario);
    body.append(id, scenario.wrap);
    let rubric: ReturnType<typeof draftField> | undefined;
    if (d.criteria && d.criteria.length > 0) {
      body.append(criteriaList(d.criteria));
    } else {
      rubric = draftField("Rubric", d.rubric);
      body.append(rubric.wrap);
    }
    row.append(check, body);
    list.appendChild(row);
    return { draft: d, check, id, scenario: scenario.input, rubric: rubric?.input };
  });
  card.appendChild(list);

  const foot = document.createElement("div");
  foot.className = "canon-draft-foot";
  const writeBtn = document.createElement("button");
  writeBtn.type = "button";
  writeBtn.className = "workspace-confirm-confirm canon-draft-write";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "workspace-confirm-cancel";
  cancelBtn.textContent = "Discard";
  const note = document.createElement("span");
  note.className = "canon-draft-note";
  note.textContent = `→ .covenant/canon/evals/${kind}/${name}/`;
  const overwriteWrap = document.createElement("label");
  overwriteWrap.className = "canon-draft-overwrite";
  const overwriteCheck = document.createElement("input");
  overwriteCheck.type = "checkbox";
  overwriteCheck.setAttribute("aria-label", "overwrite existing evals");
  overwriteWrap.append(overwriteCheck, document.createTextNode("overwrite existing"));
  foot.append(note, overwriteWrap, cancelBtn, writeBtn);
  card.appendChild(foot);
  overlay.appendChild(card);

  const syncCount = (): void => {
    const n = rows.filter((r) => r.check.checked).length;
    writeBtn.textContent = `Write ${n} eval${n === 1 ? "" : "s"}`;
    writeBtn.disabled = n === 0;
  };
  rows.forEach((r) => r.check.addEventListener("change", syncCount));
  syncCount();

  const close = (): void => overlay.remove();
  // Backdrop clicks do NOT close: the drafts cost tokens and an editable
  // form full of text is too easy to lose to a stray click. Escape/Discard only.
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  });
  cancelBtn.addEventListener("click", close);
  writeBtn.addEventListener("click", () => {
    const approved = rows
      .filter((r) => r.check.checked)
      .map((r) => ({
        id: r.id.value.trim(),
        scenario: r.scenario.value,
        rubric: r.rubric?.value ?? r.draft.rubric,
        criteria: r.draft.criteria,
      }));
    writeBtn.disabled = true;
    canonWriteEvals(cwd, kind, name, approved, overwriteCheck.checked || undefined)
      .then(async (ids) => {
        close();
        const requested = approved.length;
        const skipped = requested - ids.length;
        pushInfoToast({
          message:
            `Wrote ${ids.length} eval${ids.length === 1 ? "" : "s"} for ${name}: ${ids.join(", ")}` +
            (skipped > 0 ? ` · ${skipped} skipped (already exist — check "overwrite existing" to replace)` : ""),
        });
        await onDone();
        // Chain into the run — its own confirm card keeps the cost gate.
        runEvals(cwd, kind, name, btn, onDone);
      })
      .catch((e) => {
        writeBtn.disabled = false;
        pushInfoToast({ message: `Write evals failed: ${String(e)}` });
      });
  });

  document.body.appendChild(overlay);
  writeBtn.focus();
}

/** Read-only breakdown of a draft's weighted criteria — id, points, text —
 *  shown under the scenario. Editing weights is YAGNI until asked for. */
function criteriaList(criteria: CanonEvalCriterion[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "canon-draft-field canon-draft-criteria";
  const cap = document.createElement("span");
  cap.textContent = "Criteria";
  wrap.appendChild(cap);
  const list = document.createElement("ul");
  list.className = "canon-draft-criteria-list";
  for (const c of criteria) {
    const item = document.createElement("li");
    item.className = "canon-draft-criteria-item";
    const points = document.createElement("span");
    points.className = "canon-draft-criteria-points";
    points.textContent = `${c.points}`;
    const text = document.createElement("span");
    text.className = "canon-draft-criteria-text";
    text.textContent = c.text;
    item.append(points, text);
    list.appendChild(item);
  }
  wrap.appendChild(list);
  return wrap;
}

function draftField(caption: string, value: string): { wrap: HTMLElement; input: HTMLTextAreaElement } {
  const wrap = document.createElement("label");
  wrap.className = "canon-draft-field";
  const cap = document.createElement("span");
  cap.textContent = caption;
  const input = document.createElement("textarea");
  input.rows = 2;
  input.value = value;
  wrap.append(cap, input);
  return { wrap, input };
}
