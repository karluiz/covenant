import type { MinerEvent, MinerFinding, MinerUnit, InventoryReport } from "../../api";

export type UnitState = "new" | "exists" | "changed" | "detected";

export interface FindingCard {
  id: string;
  finding: MinerFinding;
  status: "pending" | "accepted" | "discarded";
  editedBody?: string;
}

export interface UnitRow {
  /** `${kind}:${slug}` — stable across kind re-routes only by re-keying. */
  id: string;
  slug: string;
  kind: string;
  name: string;
  summary: string;
  findings: FindingCard[];
  state: UnitState;
  selected: boolean;
  /** Set for detected rows: the executor dir the foreign item lives in. */
  detectedIn?: string;
}

export interface MinerState {
  activity: { id: string; tool: string; arg: string; summary?: string; ok?: boolean }[];
  units: UnitRow[];
  narration: string;
  done: boolean;
  stopped: boolean;
  error: string | null;
}

export interface CompiledUnit {
  kind: string;
  name: string;
  findings: MinerFinding[];
}

/** Mirrors `canon::compile::slugify` and `agent::context_miner::unit_slug`. */
export function slugify(name: string): string {
  let out = "";
  for (const ch of name) {
    if (/[a-zA-Z0-9]/.test(ch)) out += ch.toLowerCase();
    else if (!out.endsWith("-")) out += "-";
  }
  return out.replace(/^-+|-+$/g, "");
}

const unitId = (kind: string, slug: string) => `${kind}:${slug}`;

export function createMinerState(): MinerState {
  return { activity: [], units: [], narration: "", done: false, stopped: false, error: null };
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
    case "unit_proposed": {
      const u: MinerUnit = ev.unit;
      const slug = slugify(u.name);
      // Identity is slug ALONE, unique across ALL kinds — mirrors the
      // backend, which rejects a same-name-different-kind unit outright
      // (see agent::context_miner::MinerUnit doc comment). Do NOT also
      // check `.kind` here: a finding addresses its unit by name only, so
      // the frontend index must key the same way the backend does.
      if (state.units.some((r) => r.slug === slug)) break;
      state.units.push({
        id: unitId(u.kind, slug), slug, kind: u.kind, name: u.name, summary: u.summary,
        findings: [], state: "new", selected: true,
      });
      break;
    }
    case "finding": {
      // The backend already dropped orphans; this guard keeps the UI honest
      // if the stream is replayed out of order.
      const row = state.units.find((r) => r.slug === slugify(ev.finding.unit));
      if (!row) break;
      row.findings.push({ id: ev.id, finding: ev.finding, status: "pending" });
      break;
    }
    case "run_done":
      state.done = true;
      state.stopped = ev.stopped;
      break;
    case "error":
      state.error = ev.message;
      break;
  }
}

/** Fold backend state resolution + detected rows into the inventory.
 * Rows here ARE kind-scoped (unlike unit_proposed's slug-only identity):
 * `memory/x.md` and `skills/x/` are genuinely different files on disk, so
 * a state row only applies to the unit that shares both kind and slug. */
export function applyStates(state: MinerState, report: InventoryReport): void {
  for (const s of report.states) {
    const row = state.units.find((r) => r.kind === s.kind && r.slug === s.slug);
    if (!row) continue;
    row.state = s.state;
    // Only `new` is pre-checked. `changed` offers Update but the user opts in.
    row.selected = s.state === "new";
  }
  for (const d of report.detected) {
    const kind = d.kind === "agent" ? "subagent" : d.kind;
    const slug = slugify(d.name);
    if (state.units.some((r) => r.kind === kind && r.slug === slug)) continue;
    state.units.push({
      id: unitId(kind, slug), slug, kind, name: d.name, summary: d.summary ?? "",
      findings: [], state: "detected", selected: false, detectedIn: d.detectedIn ?? undefined,
    });
  }
}

export function setUnitSelected(state: MinerState, id: string, selected: boolean): void {
  const u = state.units.find((r) => r.id === id);
  if (u) u.selected = selected;
}

export function setUnitKind(state: MinerState, id: string, kind: string): void {
  const u = state.units.find((r) => r.id === id);
  if (!u) return;
  u.kind = kind;
  u.id = unitId(kind, u.slug);
  for (const f of u.findings) f.finding = { ...f.finding, kind };
}

function findCard(state: MinerState, id: string): FindingCard | undefined {
  for (const u of state.units) {
    const c = u.findings.find((f) => f.id === id);
    if (c) return c;
  }
  return undefined;
}

export function setFindingStatus(state: MinerState, id: string, status: "accepted" | "discarded"): void {
  const c = findCard(state, id);
  if (c) c.status = status;
}

export function setFindingKind(state: MinerState, id: string, kind: string): void {
  const c = findCard(state, id);
  if (c) c.finding = { ...c.finding, kind };
}

export function editFindingBody(state: MinerState, id: string, body: string): void {
  const c = findCard(state, id);
  if (c) c.editedBody = body;
}

/** A unit's findings as they would be written: accepted ones, edits applied. */
function unitFindings(u: UnitRow): MinerFinding[] {
  const kept = u.findings
    .filter((c) => c.status === "accepted")
    .map((c) => ({ ...c.finding, kind: u.kind, bodyMd: c.editedBody ?? c.finding.bodyMd }));
  // Non-skill kinds are a single entry; the backend slices to [..1] too.
  return u.kind === "skill" ? kept : kept.slice(0, 1);
}

export function selectedUnits(state: MinerState): CompiledUnit[] {
  return state.units
    .filter((u) => u.selected && u.state !== "detected")
    .map((u) => ({ kind: u.kind, name: u.name, findings: unitFindings(u) }))
    .filter((u) => u.findings.length > 0);
}

/** Units awaiting all findings' state resolution, for the pre-write check. */
export function pendingUnits(state: MinerState): CompiledUnit[] {
  return state.units
    .filter((u) => u.state !== "detected")
    .map((u) => ({
      kind: u.kind, name: u.name,
      findings: u.findings.map((c) => ({ ...c.finding, kind: u.kind, bodyMd: c.editedBody ?? c.finding.bodyMd })),
    }))
    .filter((u) => u.findings.length > 0);
}

export const KIND_ORDER = ["skill", "memory", "command", "subagent"] as const;
export const KIND_LABELS: Record<string, string> = {
  skill: "Skill", memory: "Memory", command: "Command", subagent: "Subagent",
};
export const STATE_LABELS: Record<UnitState, string> = {
  new: "new", exists: "in canon", changed: "changed", detected: "detected",
};

export function unitTarget(kind: string, slug: string): string {
  if (kind === "skill") return `.covenant/canon/skills/${slug}/`;
  const dir = kind === "subagent" ? "agents" : kind === "command" ? "commands" : "memory";
  return `.covenant/canon/${dir}/${slug}.md`;
}

export function compilePreview(state: MinerState): string {
  const units = state.units.filter((u) => u.selected && u.state !== "detected");
  let md = "";
  for (const kind of KIND_ORDER) {
    for (const u of units.filter((x) => x.kind === kind)) {
      const fs = unitFindings(u);
      if (fs.length === 0) continue;
      md += `# ${KIND_LABELS[kind]} → ${unitTarget(kind, u.slug)}\n\n${u.summary}\n`;
      for (const f of fs) {
        md += `\n## ${f.title}\n\n${f.bodyMd.trim()}\n`;
        if (f.evidence.length > 0) md += `\nEvidence: ${f.evidence.map((e) => `\`${e}\``).join(", ")}\n`;
      }
      md += "\n";
    }
  }
  return md || "Nothing selected yet.";
}
