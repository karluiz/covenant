export interface SpawnSpec {
  id: string;
  label: string;
  icon: string | null;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  default: boolean;
}
