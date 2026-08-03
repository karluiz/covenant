// Running a skill's evals — the Evaluate phase, shared by the rail panel and
// the cockpit's Skills list so the verdict can live next to the unit it judges
// instead of only in the aggregate.
//
// A run costs real tokens (every eval is a full agent run plus a judge call),
// so it is always gated by the in-app confirm card — never a native dialog,
// which Tauri's capability set doesn't allow anyway.

import {
  canonDraftEvals,
  canonListEvals,
  canonRunEvals,
  canonWriteEvals,
  onCanonEvalProgress,
  type CanonEvalDraft,
  type CanonEvalProgress,
} from "../api";
import { Icons } from "../icons";
import { pushInfoToast } from "../notifications/toast";
import { openConfirmPrompt } from "../workspaces/confirm-prompt";

/** Confirm, then run. `onDone` refreshes whatever surface asked. */
export function runEvals(
  cwd: string,
  kind: string,
  name: string,
  btn: HTMLButtonElement,
  onDone: () => void | Promise<void>,
): void {
  openConfirmPrompt({
    label: "Run evals",
    message:
      `Run evals for "${name}"? Each eval is a full agent run plus a judge call — this can take minutes and costs tokens. ` +
      `The eval's name and its pass/fail are shared with your org's registry — never the judge's reasoning.`,
    confirmText: "Run",
    onConfirm: () => { void execute(cwd, kind, name, btn, onDone); },
  });
}

async function execute(
  cwd: string,
  kind: string,
  name: string,
  btn: HTMLButtonElement,
  onDone: () => void | Promise<void>,
): Promise<void> {
  btn.disabled = true;
  let unlisten: (() => void) | undefined;
  let panel: EvalProgressPanel | undefined;
  try {
    const ids = (await canonListEvals(cwd, kind, name).catch(() => [])).map((e) => e.id);
    if (ids.length === 0) {
      pushInfoToast({
        message: `No evals for ${name} — use Draft evals, or add .toml files under .covenant/canon/evals/${kind}/${name}/`,
      });
      return;
    }
    // The panel replaces the old per-eval toast stream: a minutes-long run
    // narrated by transient toasts loses its story the moment you look away.
    panel = openEvalProgressPanel(name, ids);
    unlisten = await onCanonEvalProgress((e: CanonEvalProgress) => {
      if (e.kind !== kind || e.name !== name) return;
      if (e.status === "done") panel?.finish();
      else if (e.eval_id === "") panel?.finishAll("skipped", e.reason);
      else panel?.setStatus(e.eval_id, e.status, e.reason);
    });
    await canonRunEvals(cwd, kind, name);
    panel.finish();
    await onDone();
  } catch (e) {
    panel?.finishAll("error", String(e));
    pushInfoToast({ message: `Run evals failed: ${String(e)}` });
  } finally {
    unlisten?.();
    btn.disabled = false;
  }
}

type EvalRowStatus = "pending" | "running" | "pass" | "fail" | "skipped" | "error";

export interface EvalProgressPanel {
  element: HTMLElement;
  setStatus(id: string, status: string, reason: string): void;
  finishAll(status: EvalRowStatus, reason: string): void;
  finish(): void;
}

/** Fixed bottom-right, non-modal, one panel at a time. Survives the whole run
 *  and stays after it until dismissed — the persistent record toasts weren't.
 *  ponytail: single global panel; per-unit stacking if parallel runs ever ship. */
export function openEvalProgressPanel(name: string, ids: string[]): EvalProgressPanel {
  document.querySelector(".canon-eval-progress")?.remove();

  const el = document.createElement("div");
  el.className = "canon-eval-progress";
  const head = document.createElement("div");
  head.className = "canon-eval-progress-head";
  const title = document.createElement("span");
  title.className = "canon-eval-progress-title";
  title.textContent = `Evals — ${name}`;
  const tally = document.createElement("span");
  tally.className = "canon-eval-progress-tally";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "canon-eval-progress-close";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.innerHTML = Icons.x({ size: 13 });
  closeBtn.addEventListener("click", () => el.remove());
  head.append(title, tally, closeBtn);
  el.appendChild(head);

  const rows = new Map<string, { row: HTMLElement; dot: HTMLElement; note: HTMLElement; status: EvalRowStatus }>();
  const list = document.createElement("div");
  list.className = "canon-eval-progress-list";
  for (const id of ids) {
    const row = document.createElement("div");
    row.className = "canon-eval-progress-row is-pending";
    const dot = document.createElement("span");
    dot.className = "canon-eval-progress-dot";
    const label = document.createElement("span");
    label.className = "canon-eval-progress-id";
    label.textContent = id;
    const note = document.createElement("span");
    note.className = "canon-eval-progress-note";
    row.append(dot, label, note);
    list.appendChild(row);
    rows.set(id, { row, dot, note, status: "pending" });
  }
  el.appendChild(list);
  document.body.appendChild(el);

  const syncTally = (): void => {
    const all = [...rows.values()];
    const settled = all.filter((r) => r.status !== "pending" && r.status !== "running").length;
    const passed = all.filter((r) => r.status === "pass").length;
    tally.textContent = settled < all.length
      ? `${settled}/${all.length}`
      : `${passed}/${all.length} pass`;
  };
  syncTally();

  const set = (id: string, status: EvalRowStatus, reason: string): void => {
    const r = rows.get(id);
    if (!r) return;
    r.status = status;
    r.row.className = `canon-eval-progress-row is-${status}`;
    r.note.textContent = reason;
    syncTally();
  };

  return {
    element: el,
    setStatus(id, status, reason) {
      const s: EvalRowStatus =
        status === "running" || status === "pass" || status === "fail" ||
        status === "skipped" || status === "error"
          ? status
          : "pending";
      set(id, s, reason);
    },
    finishAll(status, reason) {
      for (const [id, r] of rows) {
        if (r.status === "pending" || r.status === "running") set(id, status, reason);
      }
      el.classList.add("is-done");
    },
    finish() {
      // Anything the run never reached stays visibly unresolved, not fake-green.
      for (const [id, r] of rows) {
        if (r.status === "pending" || r.status === "running") set(id, "skipped", "not reached");
      }
      el.classList.add("is-done");
      syncTally();
    },
  };
}

/** Confirm, then draft evals and open the review drawer. Files are written
 *  only when the user approves a set — a re-draft never clobbers anything. */
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

/** Review drawer: drafts as editable cards with include-checkboxes; the
 *  approved set is written on confirm, then Run evals is offered. Exported
 *  for tests. */
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
    const id = document.createElement("div");
    id.className = "canon-draft-item-id";
    id.textContent = d.id;
    const scenario = draftField("Scenario", d.scenario);
    const rubric = draftField("Rubric", d.rubric);
    body.append(id, scenario.wrap, rubric.wrap);
    row.append(check, body);
    list.appendChild(row);
    return { draft: d, check, scenario: scenario.input, rubric: rubric.input };
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
  note.textContent = `→ .covenant/canon/evals/${kind}/${name}/ · existing evals are never overwritten`;
  foot.append(note, cancelBtn, writeBtn);
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
      .map((r) => ({ id: r.draft.id, scenario: r.scenario.value, rubric: r.rubric.value }));
    writeBtn.disabled = true;
    canonWriteEvals(cwd, kind, name, approved)
      .then(async (ids) => {
        close();
        pushInfoToast({ message: `Wrote ${ids.length} eval${ids.length === 1 ? "" : "s"} for ${name}: ${ids.join(", ")}` });
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
