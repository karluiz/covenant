/** Build the provenance line stored on a captured note, e.g.
 *  "from Claude · tab 2". Idle panes (no detected executor) → just the tab name. */
const EXEC_LABEL: Record<string, string> = {
  copilot: "Copilot", pi: "pi", claude: "Claude", opencode: "OpenCode",
};

export function noteSource(executorId: string | null | undefined, tabName: string): string {
  if (!executorId) return tabName;
  const label = EXEC_LABEL[executorId] ?? executorId;
  return `from ${label} · ${tabName}`;
}
