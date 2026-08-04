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
  type CanonEvalDraft,
  type CanonEvalProgress,
  type CanonRunEvalsOpts,
} from "../api";
import { Icons } from "../icons";
import { pushInfoToast } from "../notifications/toast";
import { openConfirmPrompt } from "../workspaces/confirm-prompt";

// --- run registry + global event relay ------------------------------------

interface RunEntry {
  kind: string;
  name: string;
  cwd?: string;
  panel: EvalProgressPanel;
  done: boolean;
}

/** Live + finished-but-not-dismissed runs, keyed `kind/name`. */
const runs = new Map<string, RunEntry>();

let relayReady: Promise<void> | undefined;

/** One global `canon-eval-progress` listener for the app's lifetime. Routes
 *  events to the right panel — and (the reload case) recreates a panel for a
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
    // A backend run with no panel (window reloaded mid-run): rebuild one.
    // Rows appear lazily as events arrive; cwd is unknown so detail links
    // are unavailable until the next explicit run.
    const panel = openEvalProgressPanel(e.kind, e.name, []);
    run = { kind: e.kind, name: e.name, panel, done: false };
    runs.set(key, run);
  }
  if (e.status === "done") {
    run.done = true;
    run.panel.finish(e.reason === "cancelled" ? "stopped" : "");
  } else if (e.eval_id === "") {
    run.panel.finishAll("skipped", e.reason);
  } else {
    run.panel.setStatus(e.eval_id, e.status, e.reason, e.arm, e.duration_ms ?? undefined);
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
    // Already running: surface the panel instead of stacking a second run.
    reattachPanel(live.panel);
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
        `plus up to ${n * arms} judge calls. You can stop it from the progress panel. ${sharing}`,
      confirmText: "Run",
      onConfirm: () => { void execute(cwd, kind, name, ids, btn, onDone, opts); },
    });
  })();
}

async function execute(
  cwd: string,
  kind: string,
  name: string,
  ids: string[],
  btn: HTMLButtonElement,
  onDone: () => void | Promise<void>,
  opts?: CanonRunEvalsOpts,
): Promise<void> {
  btn.disabled = true;
  const key = `${kind}/${name}`;
  // The panel replaces the old per-eval toast stream: a minutes-long run
  // narrated by transient toasts loses its story the moment you look away.
  const panel = openEvalProgressPanel(kind, name, ids, cwd);
  runs.set(key, { kind, name, cwd, panel, done: false });
  try {
    await initEvalProgressRelay();
    await canonRunEvals(cwd, kind, name, opts);
    panel.finish();
    await onDone();
  } catch (e) {
    panel.finishAll("error", String(e));
    pushInfoToast({ message: `Run evals failed: ${String(e)}` });
  } finally {
    const run = runs.get(key);
    if (run) run.done = true;
    btn.disabled = false;
  }
}

// --- progress panel --------------------------------------------------------

type EvalRowStatus = "pending" | "running" | "pass" | "fail" | "skipped" | "error";

export interface EvalProgressPanel {
  element: HTMLElement;
  setStatus(id: string, status: string, reason: string, arm?: string, durationMs?: number): void;
  finishAll(status: EvalRowStatus, reason: string): void;
  finish(note?: string): void;
}

/** Panels stack in one fixed bottom-right column, one per unit. */
function panelStack(): HTMLElement {
  let stack = document.querySelector<HTMLElement>(".canon-eval-progress-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "canon-eval-progress-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

function reattachPanel(panel: EvalProgressPanel): void {
  if (!panel.element.isConnected) panelStack().appendChild(panel.element);
}

/** Non-modal per-unit progress panel. Survives the whole run and stays after
 *  it until dismissed — the persistent record toasts weren't. Rows are lazy:
 *  events for unknown ids create their row (the relay's reload path starts
 *  with none). Rows expand on click to the full judge reason + duration +
 *  transcript link; Stop cancels the backend run. */
export function openEvalProgressPanel(
  kind: string,
  name: string,
  ids: string[],
  cwd?: string,
): EvalProgressPanel {
  const key = `${kind}/${name}`;
  // One panel per unit: replace a same-unit panel, stack across units. The
  // key charset is valid_pkg_name + "/" — no quoting hazards in the selector.
  document.querySelector(`.canon-eval-progress[data-key="${key}"]`)?.remove();

  const el = document.createElement("div");
  el.className = "canon-eval-progress";
  el.dataset.key = key;
  const head = document.createElement("div");
  head.className = "canon-eval-progress-head";
  const title = document.createElement("span");
  title.className = "canon-eval-progress-title";
  title.textContent = `Evals — ${name}`;
  const tally = document.createElement("span");
  tally.className = "canon-eval-progress-tally";
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "canon-eval-progress-stop";
  stopBtn.textContent = "Stop";
  stopBtn.addEventListener("click", () => {
    stopBtn.disabled = true;
    stopBtn.textContent = "Stopping…";
    canonCancelEvals(kind, name).catch((e) => {
      stopBtn.disabled = false;
      stopBtn.textContent = "Stop";
      pushInfoToast({ message: `Stop failed: ${String(e)}` });
    });
  });
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "canon-eval-progress-close";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.innerHTML = Icons.x({ size: 13 });
  closeBtn.addEventListener("click", () => {
    el.remove();
    // Dismissing a finished run retires it; a live run stays in the map so
    // the relay re-opens the panel on its next event.
    const run = runs.get(key);
    if (run?.done) runs.delete(key);
  });
  head.append(title, tally, stopBtn, closeBtn);
  el.appendChild(head);

  interface Row {
    row: HTMLElement;
    dot: HTMLElement;
    note: HTMLElement;
    dur: HTMLElement;
    status: EvalRowStatus;
  }
  const rows = new Map<string, Row>();
  const list = document.createElement("div");
  list.className = "canon-eval-progress-list";
  el.appendChild(list);

  const ensureRow = (id: string): Row => {
    let r = rows.get(id);
    if (r) return r;
    const row = document.createElement("div");
    row.className = "canon-eval-progress-row is-pending";
    const dot = document.createElement("span");
    dot.className = "canon-eval-progress-dot";
    const label = document.createElement("span");
    label.className = "canon-eval-progress-id";
    label.textContent = id;
    const dur = document.createElement("span");
    dur.className = "canon-eval-progress-dur";
    const note = document.createElement("span");
    note.className = "canon-eval-progress-note";
    row.append(dot, label, dur, note);
    // Expand: full reason, plus the transcript link once a verdict landed.
    row.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest("button")) return;
      row.classList.toggle("is-open");
    });
    if (cwd) {
      const view = document.createElement("button");
      view.type = "button";
      view.className = "canon-eval-progress-view";
      view.textContent = "transcript";
      view.addEventListener("click", () => { void openEvalDetail(cwd, kind, name, id); });
      row.appendChild(view);
    }
    list.appendChild(row);
    const entry: Row = { row, dot, note, dur, status: "pending" };
    rows.set(id, entry);
    return entry;
  };
  for (const id of ids) ensureRow(id);
  panelStack().appendChild(el);

  const syncTally = (): void => {
    const all = [...rows.values()];
    const settled = all.filter((r) => r.status !== "pending" && r.status !== "running").length;
    const passed = all.filter((r) => r.status === "pass").length;
    tally.textContent = settled < all.length
      ? `${settled}/${all.length}`
      : `${passed}/${all.length} pass`;
  };
  syncTally();

  const set = (id: string, status: EvalRowStatus, reason: string, arm?: string, durationMs?: number): void => {
    const r = ensureRow(id);
    r.status = status;
    r.row.className = `canon-eval-progress-row is-${status}${r.row.classList.contains("is-open") ? " is-open" : ""}`;
    r.note.textContent = status === "running" && arm === "baseline" ? "baseline arm…" : reason;
    if (durationMs !== undefined) r.dur.textContent = `${Math.round(durationMs / 1000)}s`;
    r.row.classList.toggle("has-verdict", status === "pass" || status === "fail");
    syncTally();
  };

  const finishChrome = (note?: string): void => {
    el.classList.add("is-done");
    stopBtn.remove();
    if (note) title.textContent = `Evals — ${name} · ${note}`;
  };

  return {
    element: el,
    setStatus(id, status, reason, arm, durationMs) {
      const s: EvalRowStatus =
        status === "running" || status === "pass" || status === "fail" ||
        status === "skipped" || status === "error"
          ? status
          : "pending";
      set(id, s, reason, arm, durationMs);
    },
    finishAll(status, reason) {
      for (const [id, r] of rows) {
        if (r.status === "pending" || r.status === "running") set(id, status, reason);
      }
      finishChrome();
    },
    finish(note?: string) {
      // Anything the run never reached stays visibly unresolved, not fake-green.
      for (const [id, r] of rows) {
        if (r.status === "pending" || r.status === "running") set(id, "skipped", "not reached");
      }
      finishChrome(note);
      syncTally();
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
    const rubric = draftField("Rubric", ev.rubric);
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
      const draft = { id, scenario: scenario.input.value, rubric: rubric.input.value };
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
    body.append(idEl, scenario.wrap, rubric.wrap, actions);
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
    const rubric = draftField("Rubric", d.rubric);
    body.append(id, scenario.wrap, rubric.wrap);
    row.append(check, body);
    list.appendChild(row);
    return { draft: d, check, id, scenario: scenario.input, rubric: rubric.input };
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
      .map((r) => ({ id: r.id.value.trim(), scenario: r.scenario.value, rubric: r.rubric.value }));
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
