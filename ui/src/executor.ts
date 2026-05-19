// Executor detection — given a command line, return the friendly name
// of the AI coding agent it launches (claude, opencode, aider, etc.)
// or null if it doesn't match a known executor.
//
// Used by the status bar to show "🤖 claude" when an agent is running
// in the active tab, and by the operator engine elsewhere to decide
// whether a tab is worth watching.
//
// Detection is done by parsing the FIRST token of the command (after
// stripping a leading shell prefix like `env FOO=1 `, `time`, etc).
// Aliases like `cc → claude` are resolved server-side via
// `__karl_emit_output_start "${3:-$1}"` in the OSC 133 snippet, so by
// the time we see the command here it's the post-alias-expanded name.

const EXECUTORS: { match: RegExp; name: string }[] = [
  { match: /^claude(-code)?$/, name: "claude" },
  { match: /^opencode$/, name: "opencode" },
  { match: /^aider$/, name: "aider" },
  { match: /^cursor(-agent)?$/, name: "cursor" },
  { match: /^codex$/, name: "codex" },
  { match: /^pi$/, name: "pi" },
  // Standalone copilot CLI binaries — newer GitHub releases ship as
  // `copilot` directly; older as `github-copilot-cli`.
  { match: /^copilot$/, name: "copilot" },
  { match: /^github-copilot-cli$/, name: "copilot" },
];

/// Strip optional `env VAR=val ...` / `time` / `sudo` prefixes from
/// the command before checking the first real token. We don't need
/// to be perfect — false-negatives just mean no chip shows.
function firstRealToken(cmd: string): string {
  const tokens = cmd.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "env" || t === "time" || t === "sudo") {
      i++;
      // skip VAR=val pairs after `env`
      while (i < tokens.length && tokens[i].includes("=")) i++;
      continue;
    }
    return t;
  }
  return "";
}

export function detectExecutor(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  const head = firstRealToken(command);
  if (!head) return null;
  // Strip a path prefix if present (`/usr/local/bin/claude` → `claude`)
  const base = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head;
  for (const { match, name } of EXECUTORS) {
    if (match.test(base)) return name;
  }
  // `gh copilot <subcommand>` — the GitHub CLI subcommand form is
  // probably the most common Copilot invocation. Detect by checking
  // the second meaningful token when the first is `gh`.
  if (base === "gh") {
    const headIdx = tokens.indexOf(head);
    const second = tokens[headIdx + 1];
    if (second === "copilot") return "copilot";
  }
  return null;
}
