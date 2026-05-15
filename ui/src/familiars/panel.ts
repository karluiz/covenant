import { ChatPanel } from "./chat";
import { SnapshotPanel } from "./snapshot";
import { AuditLog } from "./audit_log";
import { Familiars, type FamiliarSummary } from "./api";

type SubTab = "chat" | "status" | "audit";

const LS_OPEN = "familiar-panel-open";
const LS_TAB = "familiar-panel-tab";

export class FamiliarPanel {
  private root: HTMLElement;
  private title: HTMLElement;
  private tabs: Record<SubTab, HTMLButtonElement>;
  private bodies: Record<SubTab, HTMLElement>;
  private empty: HTMLElement;
  private chat: ChatPanel;
  private snap: SnapshotPanel;
  private audit: AuditLog;
  private active: SubTab;

  /** Host hook: deliver an approved directive into the operator session. */
  onDeliverDirective: (sessionId: string, rendered: string) => Promise<void> =
    async () => {};

  constructor() {
    this.root = document.getElementById("familiar-panel")!;
    this.root.classList.add("familiar-panel");

    this.root.innerHTML = `
      <div class="familiar-panel__header">
        <span class="familiar-panel__title">Familiar</span>
        <button class="familiar-panel__close" aria-label="Close">✕</button>
      </div>
      <div class="familiar-panel__tabs" role="tablist">
        <button class="familiar-panel__tab" data-tab="chat">Chat</button>
        <button class="familiar-panel__tab" data-tab="status">Status</button>
        <button class="familiar-panel__tab" data-tab="audit">Audit</button>
      </div>
      <div class="familiar-panel__body">
        <div class="familiar-panel__view" data-view="chat"></div>
        <div class="familiar-panel__view" data-view="status" hidden></div>
        <div class="familiar-panel__view" data-view="audit" hidden></div>
        <div class="familiar-panel__empty" hidden>
          No Familiar for this tab. Open Settings → Familiars to create one.
        </div>
      </div>`;

    this.title = this.root.querySelector(".familiar-panel__title")!;
    this.empty = this.root.querySelector(".familiar-panel__empty")!;

    this.tabs = {
      chat: this.root.querySelector('[data-tab="chat"]')!,
      status: this.root.querySelector('[data-tab="status"]')!,
      audit: this.root.querySelector('[data-tab="audit"]')!,
    };
    this.bodies = {
      chat: this.root.querySelector('[data-view="chat"]')!,
      status: this.root.querySelector('[data-view="status"]')!,
      audit: this.root.querySelector('[data-view="audit"]')!,
    };

    this.chat = new ChatPanel(this.bodies.chat);
    this.snap = new SnapshotPanel(this.bodies.status);
    this.audit = new AuditLog(this.bodies.audit);

    this.chat.onApprovedDirective = async (familiarId, rendered) => {
      const list = await Familiars.list();
      const f = list.find((x) => x.id === familiarId);
      if (f) await this.onDeliverDirective(f.session_id, rendered);
    };

    (this.root.querySelector(".familiar-panel__close") as HTMLButtonElement)
      .addEventListener("click", () => this.hide());

    for (const t of ["chat", "status", "audit"] as SubTab[]) {
      this.tabs[t].addEventListener("click", () => this.selectTab(t));
    }

    this.active = (localStorage.getItem(LS_TAB) as SubTab | null) ?? "chat";
    this.selectTab(this.active);

    const wasOpen = localStorage.getItem(LS_OPEN) === "true";
    if (wasOpen) this.show();
    else this.hide();
  }

  show() {
    this.root.classList.remove("hidden");
    document.body.classList.add("familiar-panel-open");
    localStorage.setItem(LS_OPEN, "true");
    window.dispatchEvent(new Event("resize"));
  }

  hide() {
    this.root.classList.add("hidden");
    document.body.classList.remove("familiar-panel-open");
    localStorage.setItem(LS_OPEN, "false");
    window.dispatchEvent(new Event("resize"));
  }

  toggle() {
    if (this.root.classList.contains("hidden")) this.show();
    else this.hide();
  }

  private selectTab(t: SubTab) {
    this.active = t;
    localStorage.setItem(LS_TAB, t);
    for (const k of ["chat", "status", "audit"] as SubTab[]) {
      this.tabs[k].classList.toggle("familiar-panel__tab--active", k === t);
      this.bodies[k].hidden = k !== t;
    }
  }

  async bindToSession(sessionId: string | null): Promise<void> {
    if (!sessionId) {
      this.setFamiliar(null, null);
      return;
    }
    let list: FamiliarSummary[] = [];
    try {
      list = await Familiars.list();
    } catch {
      list = [];
    }
    const f = list.find((x) => x.session_id === sessionId) ?? null;
    this.setFamiliar(f?.id ?? null, f?.name ?? null);
  }

  private setFamiliar(id: string | null, name: string | null) {
    this.title.textContent = id ? (name ?? "Familiar") : "Familiar";
    const hasFamiliar = id !== null;
    for (const k of ["chat", "status", "audit"] as SubTab[]) {
      this.tabs[k].disabled = !hasFamiliar;
    }
    this.empty.hidden = hasFamiliar;
    this.bodies[this.active].hidden = !hasFamiliar;
    this.chat.setFamiliar(id);
    this.snap.setFamiliar(id);
    this.audit.setFamiliar(id);
  }
}
