import {
  marketplaceSearch,
  marketplaceInstallCount,
  marketplaceAdminUrl,
  operatorCreateFromSoul,
  operatorList,
  type MarketplaceListing,
} from "../api";
import { renderAvatarHtml } from "../operator/avatars";
import { suffixSoulName } from "./marketplace_install";

/// Browse + install community operators. Lives as the "Marketplace" tab of the
/// Operators settings pane. Install reuses operatorCreateFromSoul; on a local
/// name collision the SOUL name is suffixed (see suffixSoulName).
///
/// `onInstalled` is called after a successful install so the parent pane
/// can refresh its local operator grid without needing a global event.
/// (The only existing global dispatch is "operator:deleted"; there is no
/// "operator:created" event — we use the callback instead.)
export class MarketplacePanel {
  private grid: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;

  constructor(
    private mount: HTMLElement,
    private onInstalled: () => void,
  ) {
    this.mount.innerHTML = `
      <div class="mkt">
        <div class="mkt__bar">
          <input class="mkt__search" type="search" placeholder="Search operators…" />
          <button class="mkt__review" data-role="review" type="button">Review queue</button>
        </div>
        <div class="mkt__grid" data-role="grid"></div>
      </div>`;
    this.grid = this.mount.querySelector('[data-role="grid"]');
    this.input = this.mount.querySelector(".mkt__search");
    let timer: number | undefined;
    this.input?.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void this.search(), 250);
    });
    this.mount.querySelector('[data-role="review"]')?.addEventListener("click", () => {
      void marketplaceAdminUrl().then((url) => window.open(url, "_blank"));
    });
  }

  async open(): Promise<void> {
    await this.search();
  }

  private async search(): Promise<void> {
    if (!this.grid) return;
    const q = this.input?.value.trim() || undefined;
    this.grid.innerHTML = `<p class="mkt__empty">Loading…</p>`;
    let rows: MarketplaceListing[];
    try {
      rows = await marketplaceSearch(q);
    } catch {
      this.grid.innerHTML = `<p class="mkt__empty">Sign in to Covenant Cloud to browse the marketplace.</p>`;
      return;
    }
    if (rows.length === 0) {
      this.grid.innerHTML = `<p class="mkt__empty">No operators found.</p>`;
      return;
    }
    this.grid.innerHTML = "";
    for (const r of rows) this.grid.appendChild(this.card(r));
  }

  private card(r: MarketplaceListing): HTMLElement {
    const el = document.createElement("div");
    el.className = "mkt__card";

    // ── top row ────────────────────────────────────────────────────────────
    const top = document.createElement("div");
    top.className = "mkt__top";

    // Avatar: renderAvatarHtml is safe — pack/pack2 URLs come from local
    // catalogs (unknown keys fall back to ❓ emoji), and the emoji branch
    // already calls escapeHtml() before inserting into innerHTML.
    // r.color is untrusted; validate strictly before using.
    const avatarWrap = document.createElement("span");
    avatarWrap.className = "mkt__avatar";
    const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(r.color) ? r.color : "#6B7280";
    avatarWrap.style.background = safeColor;
    avatarWrap.innerHTML = renderAvatarHtml(r.emoji, 22);

    const idBlock = document.createElement("div");
    idBlock.className = "mkt__id";

    const nameEl = document.createElement("strong");
    nameEl.textContent = r.name;

    const metaEl = document.createElement("small");
    metaEl.textContent = `@${r.author_login} · ${r.installs} installs`;

    idBlock.appendChild(nameEl);
    idBlock.appendChild(metaEl);
    top.appendChild(avatarWrap);
    top.appendChild(idBlock);

    // ── tagline ────────────────────────────────────────────────────────────
    const tagline = document.createElement("p");
    tagline.className = "mkt__tagline";
    tagline.textContent = r.tagline;

    // ── tags ───────────────────────────────────────────────────────────────
    const tagsEl = document.createElement("div");
    tagsEl.className = "mkt__tags";
    for (const t of r.tags.slice(0, 4)) {
      const span = document.createElement("span");
      span.className = "mkt__tag";
      span.textContent = t;
      tagsEl.appendChild(span);
    }

    // ── install button ─────────────────────────────────────────────────────
    const btn = document.createElement("button");
    btn.className = "mkt__install";
    btn.type = "button";
    btn.textContent = "Install";
    btn.addEventListener("click", () => void this.install(r, btn));

    el.appendChild(top);
    el.appendChild(tagline);
    el.appendChild(tagsEl);
    el.appendChild(btn);
    return el;
  }

  private async install(r: MarketplaceListing, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = "Installing…";
    try {
      const existing = new Set(
        (await operatorList()).map((o) => o.name.toLowerCase()),
      );
      const raw = suffixSoulName(r.soul_md, existing);
      await operatorCreateFromSoul(raw);
      // Fire-and-forget: bump install counter on the server; failures are
      // non-fatal (marketplace is still usable if the server is unreachable).
      marketplaceInstallCount(r.id).catch(() => {});
      btn.textContent = "Installed ✓";
      // Notify the parent OperatorsPane to refresh its local grid.
      // There is no global "operator:created" event (only "operator:deleted"
      // exists), so we use the injected callback instead.
      this.onInstalled();
    } catch {
      btn.disabled = false;
      btn.textContent = "Install";
    }
  }
}
