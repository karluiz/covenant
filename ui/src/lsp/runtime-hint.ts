import type { LspRuntimeSuggestion } from "../api";

/// Turns a backend runtime suggestion into a human line + an optional
/// copyable command for the needs-runtime banner. Pure; the DOM/Copy
/// wiring lives in the editor.
export function runtimeSuggestionLine(
  s: LspRuntimeSuggestion | null,
): { text: string; command: string | null } {
  if (!s) return { text: "", command: null };
  if (s.kind === "on_disk_not_on_path") {
    return {
      text: `You have version ${s.version} at ${s.dir}, but it isn't on your shell's PATH. Add it to ~/.zprofile, then Recheck:`,
      command: `export PATH="${s.dir}:$PATH"`,
    };
  }
  // install
  return { text: "Install a supported version, then Recheck:", command: s.hint };
}
