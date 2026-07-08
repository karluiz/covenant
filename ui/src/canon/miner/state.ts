import type { MinerEvent, MinerFinding } from "../../api";

export interface FindingCard {
  id: string;
  finding: MinerFinding;
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
      state.findings.push({ id: ev.id, finding: ev.finding, status: "pending" });
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

export function editFindingBody(state: MinerState, id: string, body: string): void {
  const c = state.findings.find((f) => f.id === id);
  if (c) c.editedBody = body;
}

export function acceptedFindings(state: MinerState): MinerFinding[] {
  return state.findings
    .filter((c) => c.status === "accepted")
    .map((c) => ({ ...c.finding, bodyMd: c.editedBody ?? c.finding.bodyMd }));
}

const CATEGORY_ORDER: [string, string][] = [
  ["convention", "Conventions"],
  ["pattern", "Patterns"],
  ["gotcha", "Gotchas"],
  ["domain_rule", "Domain rules"],
  ["glossary", "Glossary"],
];

export function compilePreview(skillName: string, state: MinerState): string {
  const accepted = acceptedFindings(state);
  let md = `---\nname: ${skillName}\ndescription: Mined context for ${skillName}\nversion: 1.0.0\n---\n\n# ${skillName}\n`;
  for (const [key, heading] of CATEGORY_ORDER) {
    const inCat = accepted.filter((f) => f.category === key);
    if (inCat.length === 0) continue;
    md += `\n## ${heading}\n`;
    for (const f of inCat) {
      md += `\n### ${f.title}\n\n${f.bodyMd.trim()}\n`;
      if (f.evidence.length > 0) md += `\nEvidence: ${f.evidence.map((e) => `\`${e}\``).join(", ")}\n`;
    }
  }
  return md;
}
