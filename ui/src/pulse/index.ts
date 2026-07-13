import { mountCovenantPage } from "../score/page";

/// Full-screen "Pulse" metrics surface. Mirrors ChangesSurface
/// (ui/src/changes/index.ts): a fixed overlay below the titlebar that the
/// terminal keeps focus behind, so Escape is captured on the capture phase.
export class PulseSurface {
  private host: HTMLElement;
  private open_ = false;

  private onKey = (e: KeyboardEvent): void => {
    if (this.open_ && e.key === "Escape") { e.preventDefault(); this.close(); }
  };

  constructor(host: HTMLElement) { this.host = host; }

  get isOpen(): boolean { return this.open_; }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    document.addEventListener("keydown", this.onKey, true);
    this.mountShell();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    document.removeEventListener("keydown", this.onKey, true);
    this.host.innerHTML = "";
  }

  private mountShell(): void {
    this.host.innerHTML = "";
    const frame = document.createElement("div");
    frame.className = "pulse-frame";

    const header = document.createElement("div");
    header.className = "pulse-header";
    const title = document.createElement("span");
    title.className = "pulse-title";
    title.textContent = "Pulse";
    const spacer = document.createElement("span");
    spacer.className = "pulse-header-spacer";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "pulse-close";
    close.setAttribute("aria-label", "Close (Esc)");
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.close());
    header.append(title, spacer, close);

    const body = document.createElement("div");
    body.className = "pulse-body";

    frame.append(header, body);
    this.host.appendChild(frame);
    mountCovenantPage(body);
  }
}
