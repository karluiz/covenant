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
