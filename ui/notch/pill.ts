import type { Pill, ExecutorPhase } from "./store";

function loader(phase: ExecutorPhase): string {
  switch (phase.kind) {
    case "thinking":
      return `<div class="ld-think"></div>`;
    case "running":
      return `<div class="ld-run"></div>`;
    case "writing":
      return `<div class="ld-write"><span></span><span></span><span></span><span></span></div>`;
    case "reading":
      return `<div class="ld-read"></div>`;
    case "waiting":
      return `<div class="ld-wait"></div>`;
    case "done":
      return `<div class="ld-done"><svg viewBox="0 0 12 12"><path d="M2.5 6.5 L5 9 L9.5 3.5"/></svg></div>`;
    default:
      return "";
  }
}

function verb(phase: ExecutorPhase): string {
  switch (phase.kind) {
    case "thinking":
      return "Thinking";
    case "running":
      return "Running";
    case "writing":
      return "Writing";
    case "reading":
      return "Reading";
    case "waiting":
      return "Waiting";
    case "done":
      return "Done";
    default:
      return "";
  }
}

function target(phase: ExecutorPhase): string | null {
  switch (phase.kind) {
    case "running":
      return phase.cmd;
    case "writing":
      return phase.file;
    case "reading":
      return phase.file;
    case "waiting":
      return phase.reason;
    case "done":
      return phase.summary ?? null;
    default:
      return null;
  }
}

export function renderPill(p: Pill): string {
  const t = target(p.phase);
  if (p.compact) {
    return `
      <div class="pill compact" style="--tab:${p.tabColor}" data-sid="${escape(p.sessionId)}">
        <div class="ico">${loader(p.phase)}</div>
        <span class="verb">${verb(p.phase)}</span>
        ${t ? `<span class="target">${escape(t)}</span>` : ""}
      </div>`;
  }
  return `
    <div class="pill expanded" style="--tab:${p.tabColor}" data-sid="${escape(p.sessionId)}">
      <div class="ico">${loader(p.phase)}</div>
      <div class="col">
        <span class="tabchip">${escape(p.tabLabel)}</span>
        <span><span class="verb">${verb(p.phase)}</span>${t ? ` <span class="target">${escape(t)}</span>` : ""}</span>
      </div>
    </div>`;
}

function escape(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );
}
