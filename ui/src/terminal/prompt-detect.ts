// Heuristic detection of a natural-language line typed at a bare shell
// prompt, so we can offer to route it to the super-agent instead of the
// shell. Deliberately conservative: triggers on clear question/prose
// shapes and avoids colliding with real command names.

const QUESTION_WORDS = new Set([
  "how", "what", "why", "when", "where", "who", "which", "whats", "hows",
  "can", "could", "should", "would", "is", "are", "do", "does",
]);
const TWO_WORD_OPENERS = ["tell me", "show me", "give me", "help me", "how to"];
const SHELL_META = /[|&;<>$()`=]/;

export function looksLikePrompt(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  const words = s.split(/\s+/);
  if (words.length < 2) return false; // single token is never prose
  if (SHELL_META.test(s)) return false; // pipes, redirects, subshells, var-assign
  const first = words[0]!;
  if (/[/.~]/.test(first)) return false; // paths / ./script / ~/x
  if (s.endsWith("?")) return true;
  const lower = s.toLowerCase();
  if (TWO_WORD_OPENERS.some((o) => lower === o || lower.startsWith(o + " "))) return true;
  return QUESTION_WORDS.has(first.toLowerCase());
  // ponytail: heuristic only, no PATH resolution. Misses imperative prose
  // (refactor/fix/make…) to avoid colliding with real binaries. Upgrade =
  // a backend `command -v` check.
}

export interface HintInputs {
  bareShell: boolean;
  recallVisible: boolean;
  line: string;
}

/** Pure gate: show the hint only on a bare shell, when Recall isn't already
 *  claiming the sidebar, and the line reads as prose. */
export function shouldHint(i: HintInputs): boolean {
  return i.bareShell && !i.recallVisible && looksLikePrompt(i.line);
}
