import {
  cloudSyncStatus, cloudSyncSetConfig, cloudSyncPush, cloudSyncRestore,
  type CloudSyncConfig, type CloudSyncStatus,
} from "../api";

const CATS: { key: keyof CloudSyncConfig; label: string }[] = [
  { key: "workspaces", label: "Workspaces" },
  { key: "operators", label: "Operators" },
  { key: "specs", label: "Specs" },
  { key: "preferences", label: "Preferences" },
];

export function mountCloudSyncSection(root: HTMLElement): void {
  root.innerHTML = `
    <p class="settings-help">Back up your workspaces, operators, specs and
      preferences to your Covenant account. <strong>API keys and tokens are
      never uploaded.</strong></p>
    <div class="cloud-account" data-account></div>
    <label class="settings-field cloud-master">
      <input type="checkbox" data-k="enabled" /> <span>Sync to Covenant Cloud</span>
    </label>
    <div class="cloud-cats">
      ${CATS.map((c) => `<label class="settings-field"><input type="checkbox" data-k="${c.key}" /> <span>${c.label}</span></label>`).join("")}
    </div>
    <div class="cloud-actions">
      <button type="button" data-act="backup">Back up now</button>
      <button type="button" data-act="restore">Restore from cloud…</button>
    </div>
    <div class="cloud-status" data-status></div>
  `;

  const statusEl = root.querySelector("[data-status]") as HTMLElement;
  const accountEl = root.querySelector("[data-account]") as HTMLElement;

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
    if (!s.signed_in) {
      accountEl.textContent = "Sign in with GitHub (Metrics tab) to enable cloud sync.";
      statusEl.textContent = "✗ sign-in required";
      return;
    }
    accountEl.textContent = "";
    statusEl.textContent = s.last_synced_ms
      ? `✓ last synced from ${s.device ?? "?"} · ${new Date(s.last_synced_ms).toLocaleString()}`
      : "✓ signed in · not yet backed up";
  };

  const persist = (): void => void cloudSyncSetConfig(readCfg());

  root.querySelectorAll('input[type="checkbox"]').forEach((el) =>
    el.addEventListener("change", persist),
  );

  root.querySelector('[data-act="backup"]')?.addEventListener("click", async () => {
    statusEl.textContent = "⟳ syncing…";
    try { await cloudSyncPush(); paint(await cloudSyncStatus()); }
    catch (e) { statusEl.textContent = `✗ ${String(e)}`; }
  });

  root.querySelector('[data-act="restore"]')?.addEventListener("click", async () => {
    const ok = window.confirm(
      "Restore from cloud?\n\n• Workspaces will be REPLACED.\n• Operators and specs will be merged (no deletions).\n• Preferences will be merged; your local API keys are kept.",
    );
    if (!ok) return;
    statusEl.textContent = "⟳ restoring…";
    try {
      const sum = await cloudSyncRestore();
      const skippedNote = sum.skipped > 0 ? ` · ${sum.skipped} skipped (conflict)` : "";
      statusEl.textContent = `✓ restored — ${sum.operators} operators, ${sum.specs} specs${sum.workspaces ? ", workspaces" : ""}${sum.preferences ? ", preferences" : ""}${skippedNote}`;
    } catch (e) { statusEl.textContent = `✗ ${String(e)}`; }
  });

  void cloudSyncStatus().then(paint).catch(() => { statusEl.textContent = "✗ unavailable"; });
}
