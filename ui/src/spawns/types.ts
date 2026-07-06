export interface SpawnSpec {
  id: string;
  label: string;
  icon: string | null;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  default: boolean;
  /// Launch as an ACP chat tab instead of writing the cmdline into the
  /// PTY. Only honored when the command maps to an ACP-capable executor
  /// (see acpExecutorFor). Optional: absent in pre-existing spawns.json.
  acp?: boolean;
}
