import { writeToSession } from "../api";
import type { SessionId } from "../api";

/// Resolves the currently active tab in `groupId` and writes `text` to its
/// PTY without a trailing newline. The user confirms execution with Enter.
export async function writeToActiveTabInGroup(
  groupId: string,
  text: string,
): Promise<void> {
  // Lazily import to avoid pulling main.ts boot side-effects in tests.
  const { tabsManager } = await import("../main");
  const sessionId = tabsManager?.activeSessionInGroup(groupId) ?? null;
  if (!sessionId) {
    throw new Error("no active tab in group");
  }
  const encoder = new TextEncoder();
  await writeToSession(sessionId, encoder.encode(text));
}

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

/// Wraps `text` in bracketed-paste markers so a multi-line prompt lands as ONE
/// paste block. Does NOT append a carriage return — the submit is delivered
/// separately by `sendPromptToSession` (see why below). Pure + unit-testable.
export function pasteBlock(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;
}

/// Delay (ms) between delivering a paste block and the submitting carriage
/// return.
///
/// A human pastes, the terminal lets zle fully settle (zsh-autosuggestions and
/// bracketed-paste-magic both wrap the `bracketed-paste` widget and fetch their
/// suggestion via an async zle hook), and only THEN does Enter arrive as a
/// separate input event. Gluing `\r` onto the paste-end marker in one atomic
/// PTY write delivers `accept-line` before that async hook settles, racing it —
/// the buffer gets re-emitted (line appears twice) and a stale autosuggestion
/// fragment merges mid-line. Splitting the submit onto its own write after a
/// short delay mirrors human paste-then-Enter timing and avoids the race.
const SUBMIT_DELAY_MS = 40;

/// Sends `text` to `sessionId` as a bracketed-paste block, then submits it with
/// a carriage return on a separate write after a short delay. Use this for
/// prompts; use `writeToActiveTabInGroup` for paste-only.
export async function sendPromptToSession(
  sessionId: SessionId,
  text: string,
  delayMs: number = SUBMIT_DELAY_MS,
): Promise<void> {
  const encoder = new TextEncoder();
  await writeToSession(sessionId, encoder.encode(pasteBlock(text)));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  await writeToSession(sessionId, encoder.encode("\r"));
}

/// Resolves the active tab in `groupId` and SENDS `text` to its PTY: pastes the
/// body (bracketed-paste safe for multi-line) and submits it. Use this for
/// prompts; use `writeToActiveTabInGroup` for paste-only.
export async function sendToActiveTabInGroup(
  groupId: string,
  text: string,
): Promise<void> {
  const { tabsManager } = await import("../main");
  const sessionId = tabsManager?.activeSessionInGroup(groupId) ?? null;
  if (!sessionId) {
    throw new Error("no active tab in group");
  }
  await sendPromptToSession(sessionId, text);
}
