import { writeToSession } from "../api";

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

/// Wraps `text` in bracketed-paste markers and appends a carriage return so a
/// multi-line prompt lands as ONE paste block and is then submitted. Pure +
/// unit-testable (no PTY / no dynamic import).
export function wrapForSend(text: string): string {
  return `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}\r`;
}

/// Resolves the active tab in `groupId` and SENDS `text` to its PTY: pastes the
/// body (bracketed-paste safe for multi-line) and submits it with a carriage
/// return. Use this for prompts; use `writeToActiveTabInGroup` for paste-only.
export async function sendToActiveTabInGroup(
  groupId: string,
  text: string,
): Promise<void> {
  await writeToActiveTabInGroup(groupId, wrapForSend(text));
}
