import type { Pill, ExecutorPhase } from "./store";

function loader(phase: ExecutorPhase): string {
  switch (phase.kind) {
    case "thinking":
      return `<svg class="ld-think" viewBox="0 0 16 16" aria-hidden="true">
        <circle class="d1" cx="3"  cy="11" r="1.4"/>
        <circle class="d2" cx="8"  cy="11" r="1.4"/>
        <circle class="d3" cx="13" cy="11" r="1.4"/>
      </svg>`;
    case "reading":
      return `<svg class="ld-read" viewBox="0 0 16 16" aria-hidden="true">
        <line class="line" x1="2" y1="4"  x2="13" y2="4"/>
        <line class="line" x1="2" y1="7"  x2="11" y2="7"/>
        <line class="line" x1="2" y1="10" x2="13" y2="10"/>
        <line class="line" x1="2" y1="13" x2="9"  y2="13"/>
        <rect class="sweep" x="1" y="2" width="14" height="1.6" rx="0.8"/>
      </svg>`;
    case "writing":
      return `<svg class="ld-write" viewBox="0 0 16 16" aria-hidden="true">
        <path class="trail" d="M2 11 Q 5 9, 9 10" fill="none"/>
        <rect class="caret" x="10" y="6" width="1.6" height="6" rx="0.5"/>
      </svg>`;
    case "running":
      return `<svg class="ld-run" viewBox="0 0 16 16" aria-hidden="true">
        <g>
          <path class="c1" d="M3 4 L7 8 L3 12"/>
          <path class="c2" d="M6 4 L10 8 L6 12"/>
          <path class="c3" d="M9 4 L13 8 L9 12"/>
        </g>
      </svg>`;
    case "waiting":
      return `<svg class="ld-wait" viewBox="0 0 16 16" aria-hidden="true">
        <circle class="halo" cx="8" cy="8" r="3.2"/>
        <circle class="dot"  cx="8" cy="8" r="2.2"/>
      </svg>`;
    case "done":
      return `<svg class="ld-done" viewBox="0 0 16 16" aria-hidden="true">
        <circle class="ring" cx="8" cy="8" r="6.5"/>
        <path class="check" d="M4.5 8.4 L7 11 L11.8 5.6"/>
      </svg>`;
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
