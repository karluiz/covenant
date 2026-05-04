import { FamiliarList } from "./list";
import { ChatPanel } from "./chat";
import { SnapshotPanel } from "./snapshot";
import { AuditLog } from "./audit_log";

export class Roster {
  private root: HTMLElement;
  private list: FamiliarList;
  private chat: ChatPanel;
  private snap: SnapshotPanel;
  private audit!: AuditLog;
  /** Host hook: deliver the approved directive into the operator session. */
  onDeliverDirective: (sessionId: string, rendered: string) => Promise<void> = async () => {};

  constructor() {
    this.root = document.getElementById("familiars-roster")!;
    this.root.classList.add("roster");
    this.root.innerHTML = `
      <div class="roster-left"></div>
      <div class="roster-center"></div>
      <div class="roster-right"></div>
      <button class="roster-close" aria-label="Close">✕</button>`;
    this.list = new FamiliarList(this.root.querySelector(".roster-left")!,
      (id) => this.select(id));
    this.chat = new ChatPanel(this.root.querySelector(".roster-center")!);
    this.snap = new SnapshotPanel(this.root.querySelector(".roster-right")!);

    const right = this.root.querySelector(".roster-right") as HTMLElement;
    const auditHost = document.createElement("div");
    right.appendChild(auditHost);
    this.audit = new AuditLog(auditHost);
    const auditBtn = document.createElement("button");
    auditBtn.type = "button";
    auditBtn.className = "audit-toggle";
    auditBtn.textContent = "Audit log";
    auditBtn.addEventListener("click", () => {
      if (this.audit.isHidden()) this.audit.show();
      else this.audit.hide();
    });
    right.appendChild(auditBtn);

    this.root.querySelector(".roster-close")!.addEventListener(
      "click", () => this.hide());
    this.chat.onApprovedDirective = async (familiarId, rendered) => {
      const f = (await import("./api")).Familiars;
      const list = await f.list();
      const item = list.find(x => x.id === familiarId);
      if (item) await this.onDeliverDirective(item.session_id, rendered);
    };
  }

  async show() {
    this.root.classList.remove("hidden");
    await this.list.refresh();
  }

  hide() { this.root.classList.add("hidden"); }
  toggle() {
    if (this.root.classList.contains("hidden")) this.show();
    else this.hide();
  }

  private select(id: string) {
    this.list.select(id);
    this.chat.setFamiliar(id);
    this.snap.setFamiliar(id);
    this.audit.setFamiliar(id);
  }
}
