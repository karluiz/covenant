import type { MinerEvent, MinerFinding } from "../../api";

export interface FindingCard {
  id: string;
  finding: MinerFinding;
  kind: string;
  status: "pending" | "accepted" | "discarded";
  editedBody?: string;
}
export interface MinerState {
  activity: { id: string; tool: string; arg: string; summary?: string; ok?: boolean }[];
  findings: FindingCard[];
  narration: string;
  done: boolean;
  stopped: boolean;
  error: string | null;
}

export function createMinerState(): MinerState {
  return { activity: [], findings: [], narration: "", done: false, stopped: false, error: null };
}

export function reduceMinerEvent(state: MinerState, ev: MinerEvent): void {
  switch (ev.kind) {
    case "text_delta":
      state.narration += ev.text;
      break;
    case "tool_start":
      state.activity.push({ id: ev.id, tool: ev.tool, arg: ev.arg });
      break;
    case "tool_result": {
      const row = state.activity.find((a) => a.id === ev.id);
      if (row) { row.summary = ev.summary; row.ok = ev.ok; }
      break;
    }
    case "finding":
      state.findings.push({ id: ev.id, finding: ev.finding, kind: ev.finding.kind || "skill", status: "pending" });
      break;
    case "run_done":
      state.done = true;
      state.stopped = ev.stopped;
      break;
    case "error":
      state.error = ev.message;
      break;
  }
}

export function setFindingStatus(state: MinerState, id: string, status: "accepted" | "discarded"): void {
  const c = state.findings.find((f) => f.id === id);
  if (c) c.status = status;
}

export function setFindingKind(state: MinerState, id: string, kind: string): void {
  const c = state.findings.find((f) => f.id === id);
  if (c) c.kind = kind;
}

export function editFindingBody(state: MinerState, id: string, body: string): void {
  const c = state.findings.find((f) => f.id === id);
  if (c) c.editedBody = body;
}

export function acceptedFindings(state: MinerState): MinerFinding[] {
  return state.findings
    .filter((c) => c.status === "accepted")
    .map((c) => ({ ...c.finding, kind: c.kind, bodyMd: c.editedBody ?? c.finding.bodyMd }));
}

export const CATEGORY_ORDER: [string, string][] = [
  ["convention", "Conventions"],
  ["pattern", "Patterns"],
  ["gotcha", "Gotchas"],
  ["domain_rule", "Domain rules"],
  ["glossary", "Glossary"],
  ["workflow", "Workflows"],
];

export const KIND_ORDER = ["skill", "memory", "command", "subagent"] as const;
export const KIND_LABELS: Record<string, string> = {
  skill: "Skill package", memory: "Memory", command: "Commands", subagent: "Subagents",
};

export function compilePreview(skillName: string, state: MinerState): string {
  const accepted = acceptedFindings(state);
  let md = "";
  for (const kind of KIND_ORDER) {
    const inKind = accepted.filter((f) => f.kind === kind);
    if (inKind.length === 0) continue;
    const target = kind === "skill" ? `.covenant/canon/skills/${skillName}/` : `.covenant/canon/${kind === "subagent" ? "agents" : kind === "command" ? "commands" : "memory"}/`;
    md += `# ${KIND_LABELS[kind]} → ${target}\n`;
    for (const f of inKind) {
      md += `\n## ${f.title}\n\n${(f.bodyMd).trim()}\n`;
      if (f.evidence.length > 0) md += `\nEvidence: ${f.evidence.map((e) => `\`${e}\``).join(", ")}\n`;
    }
    md += "\n";
  }
  return md || "No findings accepted yet.";
}
