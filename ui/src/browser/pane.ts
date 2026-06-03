import { browser, type BrowserBounds } from "../api";
import { normalizeAddress } from "./url";
import { initialNavState, applyNav, type NavState } from "./nav-state";
import { favoritesStore } from "./favorites/store";
import { attachTooltip } from "../tooltip/tooltip";

export class BrowserPane {
  readonly host: HTMLElement;
  private addr: HTMLInputElement;
  private backBtn: HTMLButtonElement;
  private fwdBtn: HTMLButtonElement;
  private reloadBtn: HTMLButtonElement;
  private bar: HTMLElement;
  private state: NavState = initialNavState();
  private ro: ResizeObserver;
  private unlistenNav?: () => void;
  private opened = false;

  constructor(
    private readonly tabId: string,
    initialUrl: string,
    private readonly onLabel: (label: string) => void,
  ) {
    this.host = document.createElement("div");
    this.host.className = "browser-host";
    this.host.innerHTML = `
      <div class="browser-chrome">
        <button class="browser-btn" data-act="back" aria-label="Back">‹</button>
        <button class="browser-btn" data-act="forward" aria-label="Forward">›</button>
        <button class="browser-btn" data-act="reload" aria-label="Reload">⟳</button>
        <input class="browser-address" type="text" spellcheck="false"
               placeholder="Search DuckDuckGo or enter URL" />
        <button class="browser-btn" data-act="star" aria-label="Add to favorites">☆</button>
      </div>
      <div class="browser-progress" hidden></div>
      <div class="browser-viewport"></div>`;
    this.bar = this.host.querySelector(".browser-progress") as HTMLElement;
    this.addr = this.host.querySelector(".browser-address") as HTMLInputElement;
    this.backBtn = this.host.querySelector('[data-act="back"]') as HTMLButtonElement;
    this.fwdBtn = this.host.querySelector('[data-act="forward"]') as HTMLButtonElement;
    this.reloadBtn = this.host.querySelector('[data-act="reload"]') as HTMLButtonElement;

    this.backBtn.addEventListener("click", () => void browser.back(this.tabId));
    this.fwdBtn.addEventListener("click", () => void browser.forward(this.tabId));
    this.reloadBtn.addEventListener("click", () => void browser.reload(this.tabId));
    const starBtn = this.host.querySelector('[data-act="star"]') as HTMLButtonElement;
    attachTooltip(starBtn, "Add to favorites");
    starBtn.addEventListener("click", () => {
      const url = this.state.url || normalizeAddress(this.addr.value);
      if (!url) return;
      void favoritesStore.addLink(null, this.state.label || url, url);
      starBtn.textContent = "★";
    });
    this.addr.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const url = normalizeAddress(this.addr.value);
        if (this.opened) void browser.navigate(this.tabId, url);
        else void this.open(url);
      }
    });

    this.ro = new ResizeObserver(() => this.syncBounds());
    this.addr.value = initialUrl;
    if (initialUrl) void this.open(normalizeAddress(initialUrl));
  }

  /// Call after host is attached to the DOM.
  mounted(): void {
    this.ro.observe(this.viewport());
    this.syncBounds();
  }

  focusAddress(): void {
    this.addr.focus();
    this.addr.select();
  }

  private viewport(): HTMLElement {
    return this.host.querySelector(".browser-viewport") as HTMLElement;
  }

  private bounds(): BrowserBounds {
    const r = this.viewport().getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  private syncBounds(): void {
    if (this.opened) void browser.setBounds(this.tabId, this.bounds());
  }

  private async open(url: string): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    this.unlistenNav = await browser.onNav(this.tabId, (n) => {
      this.state = applyNav(this.state, n);
      this.addr.value = this.state.url || this.addr.value;
      this.backBtn.disabled = !this.state.canGoBack;
      this.fwdBtn.disabled = !this.state.canGoForward;
      this.bar.hidden = !this.state.loading;
      this.onLabel(this.state.label);
    });
    await browser.open(this.tabId, url, this.bounds());
  }

  show(): void {
    if (this.opened) { void browser.show(this.tabId); this.syncBounds(); }
  }
  hide(): void {
    if (this.opened) void browser.hide(this.tabId);
  }
  destroy(): void {
    this.ro.disconnect();
    this.unlistenNav?.();
    if (this.opened) void browser.close(this.tabId);
  }
}
