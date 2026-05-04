// Audit log viewer for a Familiar's directives. Shows proposed /
// approved / rejected / executed / safety_blocked entries with their
// payloads and timestamps. Mounted in the roster's right column.

import { Familiars, type DirectiveOut } from "./api";

export class AuditLog {
  private el: HTMLDivElement;
  private familiarId: string | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "audit-log hidden";
    parent.appendChild(this.el);
  }

  setFamiliar(id: string | null): void {
    this.familiarId = id;
    if (id) void this.refresh();
  }

  show(): void {
    this.el.classList.remove("hidden");
    if (this.familiarId) void this.refresh();
  }

  hide(): void {
    this.el.classList.add("hidden");
  }

  isHidden(): boolean {
    return this.el.classList.contains("hidden");
  }

  private async refresh(): Promise<void> {
    if (!this.familiarId) return;
    let rows: DirectiveOut[] = [];
    try {
      rows = await Familiars.audit(this.familiarId, 0);
    } catch {
      // Best-effort viewer; swallow errors so UI doesn't crash.
    }
    this.el.innerHTML = `<h4>Directive audit</h4>`;
    if (rows.length === 0) {
      this.el.append(document.createTextNode("(none)"));
      return;
    }
    const ul = document.createElement("ul");
    for (const r of rows) {
      const li = document.createElement("li");
      const when = new Date(r.proposed_ms).toLocaleString();
      li.innerHTML = `<span class="audit-state ${r.state}">${r.state}</span>
        <span class="audit-kind">${r.kind}</span>
        <code>${escape(r.payload)}</code>
        <span class="audit-when">${when}</span>
        ${r.block_reason ? `<div class="audit-block">blocked: ${escape(r.block_reason)}</div>` : ""}`;
      ul.appendChild(li);
    }
    this.el.appendChild(ul);
  }
}

function escape(s: string): string {
  return s.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!,
  );
}
