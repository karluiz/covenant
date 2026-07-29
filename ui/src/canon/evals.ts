// Running a skill's evals — the Evaluate phase, shared by the rail panel and
// the cockpit's Skills list so the verdict can live next to the unit it judges
// instead of only in the aggregate.
//
// A run costs real tokens (every eval is a full agent run plus a judge call),
// so it is always gated by the in-app confirm card — never a native dialog,
// which Tauri's capability set doesn't allow anyway.

import { canonRunEvals, onCanonEvalProgress, type CanonEvalProgress } from "../api";
import { pushInfoToast } from "../notifications/toast";
import { openConfirmPrompt } from "../workspaces/confirm-prompt";

/** Confirm, then run. `onDone` refreshes whatever surface asked. */
export function runEvals(
  cwd: string,
  skill: string,
  btn: HTMLButtonElement,
  onDone: () => void | Promise<void>,
): void {
  openConfirmPrompt({
    label: "Run evals",
    message: `Run evals for "${skill}"? Each eval is a full agent run plus a judge call — this can take minutes and costs tokens.`,
    confirmText: "Run",
    onConfirm: () => { void execute(cwd, skill, btn, onDone); },
  });
}

async function execute(
  cwd: string,
  skill: string,
  btn: HTMLButtonElement,
  onDone: () => void | Promise<void>,
): Promise<void> {
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
    await onDone();
  } catch (e) {
    pushInfoToast({ message: `Run evals failed: ${String(e)}` });
  } finally {
    unlisten?.();
    btn.disabled = false;
  }
}
