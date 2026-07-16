import {
  cloudSyncStatus, cloudSyncSetConfig, cloudSyncPush, cloudSyncRestore,
  type CloudSyncConfig, type CloudSyncStatus,
} from "../api";

const CATS: { key: keyof CloudSyncConfig; label: string; sub?: string }[] = [
  { key: "workspaces", label: "Workspaces" },
  { key: "operators", label: "Operators", sub: "Includes drafts not yet published to Canon" },
  { key: "specs", label: "Specs", sub: "Includes drafts not yet published to Canon" },
  { key: "preferences", label: "Preferences" },
];

export function mountCloudSyncSection(root: HTMLElement): void {
  root.innerHTML = `
    <p class="settings-help cloud-help">Restore your whole setup on a new machine.
      Canon holds what you <em>publish</em>; this backs up everything else — open
      workspaces, operator &amp; spec drafts, and preferences.
      <strong>API keys and tokens are never uploaded.</strong></p>

    <div class="cloud-account" data-account hidden></div>

    <div class="cloud-panel">
      <label class="cloud-rowflex cloud-master">
        <span class="cloud-master-text">
          <span class="cloud-master-title">Sync to Covenant Cloud</span>
          <span class="cloud-master-sub">Auto-backs up on change · restore is manual and replaces local state</span>
        </span>
        <span class="cloud-switch cloud-switch-lg">
          <input type="checkbox" data-k="enabled" />
          <span class="cloud-slider"></span>
        </span>
      </label>

      <div class="cloud-divider"></div>

      <div class="cloud-cats" data-cats>
        ${CATS.map(
          (c) =>
            `<label class="cloud-rowflex cloud-cat">
              <span class="cloud-cat-text">
                <span class="cloud-cat-label">${c.label}</span>
                ${c.sub ? `<span class="cloud-cat-sub">${c.sub}</span>` : ""}
              </span>
              <span class="cloud-switch"><input type="checkbox" data-k="${c.key}" /><span class="cloud-slider"></span></span>
            </label>`,
        ).join("")}
      </div>
    </div>

    <div class="cloud-actions">
      <button type="button" class="settings-btn cloud-btn-primary" data-act="backup">Back up now</button>
      <button type="button" class="settings-btn" data-act="restore">Restore from cloud…</button>
    </div>
    <div class="cloud-status" data-status></div>
  `;

  const statusEl = root.querySelector("[data-status]") as HTMLElement;
  const accountEl = root.querySelector("[data-account]") as HTMLElement;
  const catsEl = root.querySelector("[data-cats]") as HTMLElement;
  const setStatus = (text: string, kind: "ok" | "err" | "busy" | "" = ""): void => {
    statusEl.textContent = text;
    statusEl.className = `cloud-status${kind ? ` is-${kind}` : ""}`;
  };

  const readCfg = (): CloudSyncConfig => ({
    enabled: (root.querySelector('[data-k="enabled"]') as HTMLInputElement).checked,
    workspaces: (root.querySelector('[data-k="workspaces"]') as HTMLInputElement).checked,
    operators: (root.querySelector('[data-k="operators"]') as HTMLInputElement).checked,
    specs: (root.querySelector('[data-k="specs"]') as HTMLInputElement).checked,
    preferences: (root.querySelector('[data-k="preferences"]') as HTMLInputElement).checked,
  });

  const paint = (s: CloudSyncStatus): void => {
    (root.querySelector('[data-k="enabled"]') as HTMLInputElement).checked = s.enabled;
    for (const c of CATS) {
      (root.querySelector(`[data-k="${c.key}"]`) as HTMLInputElement).checked = s[c.key];
    }
    // Dim the category card when the master toggle is off.
    catsEl.classList.toggle("is-disabled", !s.enabled);
    if (!s.signed_in) {
      accountEl.hidden = false;
      accountEl.textContent = "Sign in with GitHub on the Metrics tab to enable cloud sync.";
      setStatus("Sign-in required", "err");
      return;
    }
    accountEl.hidden = true;
    if (s.last_synced_ms) {
      setStatus(
        `Last synced from ${s.device ?? "this device"} · ${new Date(s.last_synced_ms).toLocaleString()}`,
        "ok",
      );
    } else {
      setStatus("Signed in · not yet backed up", "ok");
    }
  };

  const persist = (): void => void cloudSyncSetConfig(readCfg());

  root.querySelectorAll('input[type="checkbox"]').forEach((el) =>
    el.addEventListener("change", persist),
  );

  const backupBtn = root.querySelector('[data-act="backup"]') as HTMLButtonElement;
  backupBtn.addEventListener("click", async () => {
    backupBtn.disabled = true;
    setStatus("Backing up…", "busy");
    try { await cloudSyncPush(); paint(await cloudSyncStatus()); }
    catch (e) { setStatus(String(e), "err"); }
    finally { backupBtn.disabled = false; }
  });

  root.querySelector('[data-act="restore"]')?.addEventListener("click", async () => {
    const ok = window.confirm(
      "Restore from cloud?\n\n• Workspaces will be REPLACED.\n• Operators and specs will be merged (no deletions).\n• Preferences will be merged; your local API keys are kept.",
    );
    if (!ok) return;
    setStatus("Restoring…", "busy");
    try {
      const sum = await cloudSyncRestore();
      const parts = [
        `${sum.operators} operators`,
        `${sum.specs} specs`,
        ...(sum.workspaces ? ["workspaces"] : []),
        ...(sum.preferences ? ["preferences"] : []),
      ];
      const skippedNote = sum.skipped > 0 ? ` · ${sum.skipped} skipped (conflict)` : "";
      setStatus(`Restored — ${parts.join(", ")}${skippedNote}`, "ok");
    } catch (e) { setStatus(String(e), "err"); }
  });

  void cloudSyncStatus().then(paint).catch(() => setStatus("Unavailable", "err"));
}
