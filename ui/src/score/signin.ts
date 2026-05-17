import { openUrl } from "@tauri-apps/plugin-opener";
import { scoreSigninPoll, scoreSigninStart, type User } from "./api";
import { setCurrentUser } from "./user";

/// Show the device-flow popover. Resolves with the authenticated User
/// on success, or null if the user closes the popover before completing.
export async function runDeviceFlow(): Promise<User | null> {
  const dc = await scoreSigninStart();

  return new Promise<User | null>((resolve) => {
    const back = document.createElement("div");
    back.className = "score-modal-backdrop";

    const box = document.createElement("div");
    box.className = "score-modal score-signin";
    box.innerHTML = `
      <h3>Connect GitHub</h3>
      <div class="sub">Enter this code on github.com to authorize Covenant.</div>
      <div class="signin-code">${dc.user_code.split("").map(c =>
        `<span>${c === "-" ? "&minus;" : c}</span>`).join("")}</div>
      <div class="signin-actions">
        <button type="button" class="signin-open">Open github.com/login/device</button>
        <button type="button" class="signin-copy">Copy code</button>
      </div>
      <div class="signin-status">Waiting for authorization…</div>
    `;
    back.appendChild(box);
    document.body.appendChild(back);

    const status = box.querySelector(".signin-status") as HTMLElement;
    const openBtn = box.querySelector(".signin-open") as HTMLButtonElement;
    const copyBtn = box.querySelector(".signin-copy") as HTMLButtonElement;

    openBtn.addEventListener("click", () => {
      void openUrl(dc.verification_uri).catch((err) =>
        console.error("openUrl failed", err),
      );
    });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(dc.user_code);
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy code"), 1500);
    });

    let cancelled = false;
    back.addEventListener("click", (e) => {
      if (e.target === back) {
        cancelled = true;
        back.remove();
        resolve(null);
      }
    });

    const intervalMs = Math.max(dc.interval, 5) * 1000;
    const deadline = Date.now() + dc.expires_in * 1000;

    async function tick(): Promise<void> {
      if (cancelled) return;
      if (Date.now() > deadline) {
        status.textContent = "Code expired. Close and try again.";
        return;
      }
      try {
        const user = await scoreSigninPoll(dc.device_code);
        if (user) {
          setCurrentUser(user);
          back.remove();
          resolve(user);
          return;
        }
      } catch (e) {
        console.warn("signin poll error", e);
      }
      setTimeout(() => void tick(), intervalMs);
    }
    setTimeout(() => void tick(), intervalMs);
  });
}
