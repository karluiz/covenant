import { detectExecutor } from "./executor";
import type { SpawnSpec } from "./spawns/types";

export const MAX_CONTINUE_PROMPT_CHARS = 14_000;
export const CONTINUE_BLOCK_COUNT = 5;
export const CONTINUE_INJECT_TIMEOUT_MS = 8_000;
export const CONTINUE_INJECT_POLL_MS = 200;

export interface ContinueWithArgs {
  sourceSessionId: string;
  sourceExecutor: string;
  cwd: string;
  groupId: string | null;
  color: string | null;
  dest: SpawnSpec;
}

export interface ContinuePromptInput {
  sourceExecutor: string;
  destLabel: string;
  cwd: string;
  branch: string | null;
  recent: Array<{ command: string; exit_code: number | null; tail: string }>;
}

/// Clips `text` to `maxChars`, keeping the head and appending a truncation
/// marker. Generic — callers decide WHAT to hand it. `buildContinuePrompt`
/// hands it only the "Recent terminal context" body, never the whole
/// assembled prompt, so a header/instruction section placed after the
/// clipped text is never a truncation casualty.
export function clipContinuePrompt(
  text: string,
  maxChars: number = MAX_CONTINUE_PROMPT_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const marker = "\n\n[truncated]\n";
  const keep = Math.max(0, maxChars - marker.length);
  return text.slice(0, keep) + marker;
}

export function buildContinuePrompt(
  input: ContinuePromptInput,
  maxChars: number = MAX_CONTINUE_PROMPT_CHARS,
): string {
  const sourceLine = input.branch
    ? `Source: ${input.sourceExecutor} · cwd ${input.cwd} · branch ${input.branch}`
    : `Source: ${input.sourceExecutor} · cwd ${input.cwd}`;

  const blocks: string[] = [];
  for (const b of input.recent) {
    const exit = b.exit_code === null ? "?" : String(b.exit_code);
    blocks.push(`$ ${b.command}  (exit ${exit})`);
    const tail = b.tail.trimEnd();
    if (tail) blocks.push(tail);
    blocks.push("");
  }

  const context =
    blocks.length > 0
      ? blocks.join("\n").trimEnd()
      : "(no recent finished blocks)";

  // The frame (everything except the context body) is fixed-size for a
  // given input; `## Instruction` lives in it, at the end. Budgeting the
  // context body against the frame's own length — rather than clipping the
  // fully-assembled string — guarantees the instruction always survives,
  // even though five ~4 KB block tails routinely blow past `maxChars`.
  const frame = (ctx: string): string =>
    [
      "Continue this work from another harness.",
      "",
      sourceLine,
      `Why: user asked to continue with ${input.destLabel}.`,
      "",
      "## Recent terminal context (oldest → newest)",
      ctx,
      "",
      "## Instruction",
      "Pick up where the previous harness left off. Prefer the existing worktree/branch; don't re-scaffold. Summarize what you understood, then continue.",
    ].join("\n");

  const full = frame(context);
  if (full.length <= maxChars) return full;

  const overhead = frame("").length;
  const contextBudget = Math.max(0, maxChars - overhead);
  return frame(clipContinuePrompt(context, contextBudget));
}

export function eligibleContinueSpawns(
  specs: SpawnSpec[],
  sourceExecutor: string,
): SpawnSpec[] {
  return specs.filter((s) => {
    if (!s.command) return false;
    if (s.acp) return false;
    const name = detectExecutor([s.command, ...s.args].join(" "));
    if (!name) return true; // unknown cmdline — still offer (user's spawn)
    return name !== sourceExecutor;
  });
}

export async function waitForExecutor(opts: {
  getExecutor: () => string | null;
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? CONTINUE_INJECT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? CONTINUE_INJECT_POLL_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (opts.getExecutor()) return true;
    await sleep(pollMs);
  }
  return !!opts.getExecutor();
}
