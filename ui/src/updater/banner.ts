// Update banner — dedicated row above the app chrome. Clicking the
// version chip or "What's new" opens a release-notes modal sourced from
// `update.body` (Tauri updater's `notes` field, populated by the release
// workflow from CHANGELOG.md).

import type { Update } from "@tauri-apps/plugin-updater";
import { installAndRelaunch } from "./check";

const BANNER_ID = "covenant-update-banner";
const MODAL_ID = "covenant-update-modal";
const BODY_CLASS = "has-update-banner";

export function showUpdateBanner(update: Update): void {
  if (document.getElementById(BANNER_ID)) return;

  const center = document.getElementById("app-titlebar-center");
  if (!center) return;

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.className = "update-banner no-drag";
  banner.innerHTML = `
    <span class="update-banner__pulse" aria-hidden="true"></span>
    <span class="update-banner__label">Update</span>
    <button class="update-banner__version" type="button" title="View release notes">v${update.version}</button>
    <button class="update-banner__whatsnew" type="button">What's new ›</button>
    <button class="update-banner__install" type="button" title="Install &amp; Relaunch">Install</button>
    <button class="update-banner__dismiss" type="button" aria-label="Dismiss" title="Dismiss">×</button>
  `;

  const setBusy = (msg: string) => {
    banner.classList.add("update-banner--installing");
    banner.querySelector<HTMLElement>(".update-banner__label")!.textContent = msg;
  };
  const clearBusy = (msg: string) => {
    banner.querySelector<HTMLElement>(".update-banner__label")!.textContent = msg;
    banner.classList.remove("update-banner--installing");
  };

  const startInstall = async () => {
    setBusy("Downloading…");
    try {
      await installAndRelaunch(update);
    } catch (err) {
      clearBusy(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  banner.querySelector<HTMLButtonElement>(".update-banner__install")!
    .addEventListener("click", startInstall);

  banner.querySelector<HTMLButtonElement>(".update-banner__version")!
    .addEventListener("click", () => openReleaseNotesModal(update, startInstall));
  banner.querySelector<HTMLButtonElement>(".update-banner__whatsnew")!
    .addEventListener("click", () => openReleaseNotesModal(update, startInstall));

  const hide = () => {
    banner.remove();
    document.body.classList.remove(BODY_CLASS);
  };
  banner.querySelector<HTMLButtonElement>(".update-banner__dismiss")!
    .addEventListener("click", hide);

  center.appendChild(banner);
  document.body.classList.add(BODY_CLASS);
}

function openReleaseNotesModal(update: Update, onInstall: () => void): void {
  if (document.getElementById(MODAL_ID)) return;

  const overlay = document.createElement("div");
  overlay.id = MODAL_ID;
  overlay.className = "update-modal-overlay";
  overlay.innerHTML = `
    <div class="update-modal" role="dialog" aria-modal="true" aria-label="Release notes">
      <div class="update-modal__head">
        <span class="update-modal__ver">v${update.version}</span>
        <div class="update-modal__titlewrap">
          <div class="update-modal__title">What's new</div>
          <div class="update-modal__from">Release notes</div>
        </div>
        <button class="update-modal__close" type="button" aria-label="Close">×</button>
      </div>
      <div class="update-modal__body"></div>
      <div class="update-modal__foot">
        <span class="update-modal__meta">Signed by Covenant</span>
        <span class="update-modal__spacer"></span>
        <button class="update-modal__later" type="button">Later</button>
        <button class="update-modal__install" type="button">Install &amp; Relaunch</button>
      </div>
    </div>
  `;

  const body = overlay.querySelector<HTMLElement>(".update-modal__body")!;
  body.innerHTML = renderNotes(update.body);

  const close = () => overlay.remove();
  overlay.querySelector<HTMLButtonElement>(".update-modal__close")!.addEventListener("click", close);
  overlay.querySelector<HTMLButtonElement>(".update-modal__later")!.addEventListener("click", close);
  overlay.querySelector<HTMLButtonElement>(".update-modal__install")!.addEventListener("click", () => {
    close();
    onInstall();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  const esc = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      document.removeEventListener("keydown", esc);
    }
  };
  document.addEventListener("keydown", esc);

  document.body.appendChild(overlay);
}

// Minimal Markdown → HTML for release notes: headings, lists, **bold**, `code`.
// Raw HTML is escaped — `update.body` comes from latest.json over the network.
function renderNotes(src: string | null | undefined): string {
  if (!src || !src.trim()) {
    return `<p class="update-modal__empty">No release notes were attached to this build.</p>`;
  }
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s: string) =>
    escape(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  const lines = src.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) { out.push("</ul>"); inList = false; }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h4>${inline(h[2])}</h4>`); continue; }
    const li = /^[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}
