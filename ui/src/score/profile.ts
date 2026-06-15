import {
  scoreProfileGetPublish, scoreProfileSetPublish,
  scoreProfilePreview, scoreProfileShareUrl,
  type PublicProfileSnapshot,
} from "./api";

const PRIVACY_LINE =
  "Only aggregates are published: your score, the 6 reputation dimensions, " +
  "earned badges, streak, and total prompt/commit counts. Never repo names, " +
  "branches, paths, commands, or code.";

export async function renderPublicProfileCard(host: HTMLElement): Promise<void> {
  const [enabled, snap, url] = await Promise.all([
    scoreProfileGetPublish().catch(() => false),
    scoreProfilePreview().catch(() => null as PublicProfileSnapshot | null),
    scoreProfileShareUrl().catch(() => null as string | null),
  ]);

  host.innerHTML = "";
  const card = document.createElement("div");
  card.className = "cov-card";

  if (!snap) {
    card.innerHTML = `<p class="eyebrow">Public profile</p>
      <p class="cov-muted">Sign in to Covenant to publish a shareable profile.</p>`;
    host.appendChild(card);
    return;
  }

  card.innerHTML = `
    <div class="cov-pubprofile-head">
      <p class="eyebrow">Public profile</p>
      <label class="cov-pub-toggle">
        <input type="checkbox" data-pub-toggle ${enabled ? "checked" : ""} />
        <span>Publish my Covenant Score &amp; achievements</span>
      </label>
    </div>
    <div class="cov-pubprofile-preview">
      <div class="cov-score-hero">${snap.score.headline.toFixed(1)}</div>
      <div class="cov-muted">Reputation ${(snap.score.reputation01 * 10).toFixed(1)}
        &middot; Consistency ${(snap.score.activity01 * 10).toFixed(1)}</div>
      <div class="cov-pubprofile-badges">${snap.awards.length} badges &middot; ${snap.totals.current_streak}-day streak</div>
    </div>
    <div class="cov-pubprofile-share ${enabled ? "" : "cov-hidden"}">
      <code data-share-url>${url ?? ""}</code>
      <button type="button" data-copy>Copy link</button>
      <button type="button" data-view>View profile</button>
    </div>
    <p class="cov-muted cov-tiny">${PRIVACY_LINE}</p>`;

  const toggle = card.querySelector<HTMLInputElement>("[data-pub-toggle]")!;
  const share = card.querySelector<HTMLElement>(".cov-pubprofile-share")!;
  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try {
      const newUrl = await scoreProfileSetPublish(toggle.checked);
      share.classList.toggle("cov-hidden", !toggle.checked);
      if (newUrl) card.querySelector("[data-share-url]")!.textContent = newUrl;
    } catch (_e) {
      toggle.checked = !toggle.checked; // revert on failure
    } finally {
      toggle.disabled = false;
    }
  });
  card.querySelector("[data-copy]")?.addEventListener("click", () => {
    const u = card.querySelector("[data-share-url]")?.textContent ?? "";
    if (u) navigator.clipboard.writeText(u);
  });
  card.querySelector("[data-view]")?.addEventListener("click", () => {
    const u = card.querySelector("[data-share-url]")?.textContent ?? "";
    if (u) window.open(u, "_blank");
  });

  host.appendChild(card);
}
