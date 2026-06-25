import { Familiars, type SnapshotOut } from "./api";

export class SnapshotPanel {
  private el: HTMLDivElement;
  private familiarId: string | null = null;
  private timer: number | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "snapshot-panel";
    parent.appendChild(this.el);
  }

  setFamiliar(id: string | null) {
    this.familiarId = id;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.el.innerHTML = "";
    if (id) {
      this.refresh();
      this.timer = window.setInterval(() => this.refresh(), 5000);
    }
  }

  private async refresh() {
    if (!this.familiarId) return;
    let s: SnapshotOut;
    try { s = await Familiars.snapshot(this.familiarId); }
    catch { return; }
    const lastSync = s.last_event_ms === 0 ? "never"
      : `${Math.max(0, Math.round((Date.now() - s.last_event_ms) / 1000))}s ago`;
    this.el.innerHTML = `
      <div class="snap-section">
        <h4>Familiar status</h4>
        <div>Last sync: ${lastSync}</div>
        <div class="snap-spend ${s.frozen ? "frozen" : ""}">
          Today: $${s.spend_today_usd.toFixed(2)}${s.frozen ? " (frozen)" : ""}
        </div>
      </div>
      <div class="snap-section">
        <h4>Rolling summary</h4>
        <pre class="snap-summary"></pre>
      </div>
      <div class="snap-section">
        <h4>Recent specs</h4>
        <ul class="snap-missions"></ul>
      </div>`;
    (this.el.querySelector(".snap-summary") as HTMLElement).textContent =
      s.rolling_summary || "(empty)";
    const ul = this.el.querySelector(".snap-missions") as HTMLElement;
    if (s.recent_missions.length === 0) {
      ul.innerHTML = "<li>(none)</li>";
    } else {
      for (const m of s.recent_missions) {
        const li = document.createElement("li");
        li.textContent = `${m.objective}${m.finished_ms ? "" : " (in progress)"}`;
        ul.appendChild(li);
      }
    }
  }
}
