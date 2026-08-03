// Running a skill's evals — the Evaluate phase, shared by the rail panel and
// the cockpit's Skills list so the verdict can live next to the unit it judges
// instead of only in the aggregate.
//
// A run costs real tokens (every eval is a full agent run plus a judge call),
// so it is always gated by the in-app confirm card — never a native dialog,
// which Tauri's capability set doesn't allow anyway.

import { canonDraftEvals, canonRunEvals, onCanonEvalProgress, type CanonEvalProgress } from "../api";
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
  let doneReason = "";
  try {
    unlisten = await onCanonEvalProgress((e: CanonEvalProgress) => {
      if (e.kind !== kind || e.name !== name) return;
      if (e.status === "running") pushInfoToast({ message: `Eval ${e.eval_id}: running…` });
      else if (e.status === "pass") pushInfoToast({ message: `Eval ${e.eval_id}: PASS` });
      else if (e.status === "fail") pushInfoToast({ message: `Eval ${e.eval_id}: FAIL — ${e.reason}` });
      else if (e.status === "skipped") pushInfoToast({ message: `Evals skipped: ${e.reason}` });
      else if (e.status === "error") pushInfoToast({ message: `Eval ${e.eval_id}: error — ${e.reason}` });
      else if (e.status === "done") doneReason = e.reason;
    });
    await canonRunEvals(cwd, kind, name);
    // The backend signals an empty run via the done note — don't claim
    // "finished" when nothing actually ran.
    pushInfoToast({
      message:
        doneReason === "no evals found"
          ? `No evals for ${name} — use Draft evals, or add .toml files under .covenant/canon/evals/${kind}/${name}/`
          : `Evals finished for ${name}`,
    });
    await onDone();
  } catch (e) {
    pushInfoToast({ message: `Run evals failed: ${String(e)}` });
  } finally {
    unlisten?.();
    btn.disabled = false;
  }
}

/** Confirm, then draft eval .toml files from the unit's source for review. */
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
      `Draft evals for "${name}"? An LLM reads the unit and writes 3–5 eval .toml files under ` +
      `.covenant/canon/evals/${kind}/${name}/ for you to review and edit before running. ` +
      `Existing evals are never overwritten.`,
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
  try {
    const ids = await canonDraftEvals(cwd, kind, name);
    pushInfoToast({
      message: `Drafted ${ids.length} eval${ids.length === 1 ? "" : "s"} for ${name}: ${ids.join(", ")} — review, then Run evals`,
    });
    await onDone();
  } catch (e) {
    pushInfoToast({ message: `Draft evals failed: ${String(e)}` });
  } finally {
    btn.disabled = false;
  }
}
