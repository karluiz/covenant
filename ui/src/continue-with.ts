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

export function buildContinuePrompt(input: ContinuePromptInput): string {
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

  return [
    "Continue this work from another harness.",
    "",
    sourceLine,
    `Why: user asked to continue with ${input.destLabel}.`,
    "",
    "## Recent terminal context (oldest → newest)",
    context,
    "",
    "## Instruction",
    "Pick up where the previous harness left off. Prefer the existing worktree/branch; don't re-scaffold. Summarize what you understood, then continue.",
  ].join("\n");
}

export function clipContinuePrompt(
  text: string,
  maxChars: number = MAX_CONTINUE_PROMPT_CHARS,
): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - "\n\n[truncated]\n".length);
  return text.slice(0, keep) + "\n\n[truncated]\n";
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
