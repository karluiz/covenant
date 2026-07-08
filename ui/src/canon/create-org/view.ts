// Immersive "Create organization" experience — a focused, full-bleed moment
// where the org's identity is born live: the monogram forms and takes its
// deterministic color as you type. Same entrance language as the Spec Creator
// (scrim + ambient field + staggered rise), scoped to `.canon-createorg`.
import "./create-org.css";
import { canonCreateOrg } from "../../api";
import { slugify, orgInitials, orgHue } from "../org";

export interface CreateOrgOpts {
  /** Called with the new slug after a successful create — the caller sets it
   *  active and refreshes. The surface closes itself first. */
  onCreated: (slug: string) => void;
}

/** Open the immersive Create-organization surface. Self-managed: handles its
 *  own entrance/exit, Esc/backdrop/Cancel, and the create call. */
export function openCreateOrgExperience(opts: CreateOrgOpts): void {
  if (document.querySelector(".canon-createorg")) return;

  const root = document.createElement("div");
  root.className = "canon-createorg";
  root.innerHTML = `
    <div class="canon-createorg-scrim"></div>
    <div class="canon-createorg-field"></div>
    <div class="canon-createorg-stage">
      <div class="canon-createorg-eyebrow canon-createorg-rise" style="--rise-delay:60ms">New organization</div>
      <div class="canon-createorg-mono canon-createorg-rise" style="--rise-delay:120ms" aria-hidden="true"></div>
      <input class="canon-createorg-name canon-createorg-rise" style="--rise-delay:200ms"
             type="text" placeholder="Name your organization" autocomplete="off" spellcheck="false" />
      <div class="canon-createorg-slug canon-createorg-rise" style="--rise-delay:260ms">
        <span class="canon-createorg-slug-prefix">registry /</span>
        <span class="canon-createorg-slug-val"></span>
      </div>
      <p class="canon-createorg-err" role="alert" hidden></p>
      <div class="canon-createorg-actions canon-createorg-rise" style="--rise-delay:320ms">
        <button class="canon-createorg-cancel" type="button">Cancel</button>
        <button class="canon-createorg-create" type="button" disabled>Create</button>
      </div>
      <div class="canon-createorg-hint canon-createorg-rise" style="--rise-delay:380ms">
        <kbd>esc</kbd> to cancel · <kbd>⏎</kbd> to create
      </div>
    </div>`;

  const scrim = root.querySelector(".canon-createorg-scrim") as HTMLElement;
  const mono = root.querySelector(".canon-createorg-mono") as HTMLElement;
  const nameEl = root.querySelector(".canon-createorg-name") as HTMLInputElement;
  const slugVal = root.querySelector(".canon-createorg-slug-val") as HTMLElement;
  const err = root.querySelector(".canon-createorg-err") as HTMLElement;
  const cancelBtn = root.querySelector(".canon-createorg-cancel") as HTMLButtonElement;
  const createBtn = root.querySelector(".canon-createorg-create") as HTMLButtonElement;
  const slugField = root.querySelector(".canon-createorg-slug") as HTMLElement;

  let busy = false;

  const currentSlug = (): string => slugify(nameEl.value);

  const sync = (): void => {
    const name = nameEl.value.trim();
    const slug = currentSlug();
    // Live identity: initials + deterministic color the moment there's a name.
    const hue = orgHue(slug || name.toLowerCase() || "canon");
    // Ambient field + monogram share the hue so the whole moment tints toward
    // the org's identity as it forms.
    root.style.setProperty("--mono-h", String(hue));
    if (name) {
      mono.textContent = orgInitials(name);
      mono.classList.remove("is-empty");
    } else {
      mono.textContent = "";
      mono.classList.add("is-empty");
    }
    slugVal.textContent = slug || "…";
    slugField.classList.toggle("is-empty", !slug);
    createBtn.disabled = !name || !slug || busy;
    if (!err.hidden) { err.hidden = true; err.textContent = ""; }
  };

  const close = (): void => {
    root.classList.add("closing");
    document.removeEventListener("keydown", onKey, true);
    window.setTimeout(() => root.remove(), 300);
  };

  const submit = async (): Promise<void> => {
    const name = nameEl.value.trim();
    const slug = currentSlug();
    if (!name || !slug || busy) return;
    busy = true;
    createBtn.disabled = true;
    createBtn.classList.add("is-busy");
    root.classList.add("creating");
    try {
      await canonCreateOrg(slug, name);
      opts.onCreated(slug);
      close();
    } catch (e) {
      busy = false;
      root.classList.remove("creating");
      createBtn.classList.remove("is-busy");
      createBtn.disabled = false;
      err.hidden = false;
      err.textContent = friendly(String(e));
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Enter") { e.preventDefault(); void submit(); }
  };

  nameEl.addEventListener("input", sync);
  cancelBtn.addEventListener("click", close);
  createBtn.addEventListener("click", () => void submit());
  scrim.addEventListener("click", close);
  document.addEventListener("keydown", onKey, true);

  document.body.appendChild(root);
  sync();
  // Entrance choreography on the next frame so the transitions run.
  requestAnimationFrame(() => {
    root.classList.add("open");
    nameEl.focus();
  });
}

/** Turn a raw backend error into a one-line, actionable message. */
function friendly(raw: string): string {
  if (/conflict|slug taken|already/i.test(raw)) return "That slug is taken — try another.";
  if (/not signed in/i.test(raw)) return "Sign in to Covenant to create an organization.";
  if (/invalid slug/i.test(raw)) return "Slug must be lowercase letters, numbers, and dashes.";
  return raw;
}
