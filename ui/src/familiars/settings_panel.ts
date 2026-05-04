// Familiars settings section. Rendered inside the existing settings page
// host. Always shows the section so the sidebar anchor lands here.
// Premium gates the per-Familiar config; until billing ships, the premium
// flag is a manual toggle for testing.

import { Familiars, type Style, type FamiliarSummary } from "./api";

export interface FamiliarsSettingsHooks {
  isPremium: boolean;
  enabled: boolean;
  setPremium: (v: boolean) => void;
  setEnabled: (v: boolean) => void;
}

export function renderFamiliarsSettings(
  parent: HTMLElement,
  hooks: FamiliarsSettingsHooks,
): void {
  parent.innerHTML = "";
  const wrap = document.createElement("section");
  wrap.className = "settings-section";
  wrap.id = "sec-familiars";

  const head = document.createElement("h3");
  head.className = "settings-section-title";
  head.textContent = "Familiars";
  wrap.appendChild(head);

  const intro = document.createElement("p");
  intro.className = "settings-hint";
  intro.textContent =
    "Per-operator AI companion with persistent memory. Phase 1 MVP — premium gating is on the honor system until billing ships; flip it manually below to enable for testing.";
  wrap.appendChild(intro);

  // Premium toggle (dev/testing — replace with billing flow later).
  const premiumRow = document.createElement("label");
  premiumRow.className = "settings-field";
  const premiumCb = document.createElement("span");
  premiumCb.className = "settings-checkbox-row";
  const premiumInput = document.createElement("input");
  premiumInput.type = "checkbox";
  premiumInput.checked = hooks.isPremium;
  const premiumLabel = document.createElement("span");
  premiumLabel.textContent = "Premium (manual override)";
  premiumCb.append(premiumInput, premiumLabel);
  premiumRow.appendChild(premiumCb);
  wrap.appendChild(premiumRow);

  // Enable toggle (gated by premium — disabled visually but always present).
  const enableRow = document.createElement("label");
  enableRow.className = "settings-field";
  const enableCb = document.createElement("span");
  enableCb.className = "settings-checkbox-row";
  const enableInput = document.createElement("input");
  enableInput.type = "checkbox";
  enableInput.checked = hooks.enabled;
  enableInput.disabled = !hooks.isPremium;
  const enableLabel = document.createElement("span");
  enableLabel.textContent = "Enable Familiars";
  enableCb.append(enableInput, enableLabel);
  enableRow.appendChild(enableCb);
  wrap.appendChild(enableRow);

  premiumInput.addEventListener("change", () => {
    hooks.setPremium(premiumInput.checked);
    enableInput.disabled = !premiumInput.checked;
    if (!premiumInput.checked && enableInput.checked) {
      enableInput.checked = false;
      hooks.setEnabled(false);
    }
  });
  enableInput.addEventListener("change", () => {
    hooks.setEnabled(enableInput.checked);
  });

  const list = document.createElement("div");
  list.className = "settings-familiars-list";
  wrap.appendChild(list);

  if (hooks.isPremium) {
    Familiars.list()
      .then((items) => renderList(list, items))
      .catch(() => {
        list.textContent = "(could not load Familiars)";
      });
  } else {
    list.textContent =
      "(enable premium above to manage per-Familiar config)";
  }

  parent.appendChild(wrap);
}

function renderList(el: HTMLElement, items: FamiliarSummary[]): void {
  el.innerHTML = "";
  if (items.length === 0) {
    el.textContent =
      "(no Familiars yet — they appear once an operator starts)";
    return;
  }
  const styles: Style[] = ["concise", "formal", "conversational", "sarcastic"];
  for (const f of items) {
    const row = document.createElement("div");
    row.className = "settings-familiar-row";
    row.innerHTML = `
      <input type="text" class="f-name" value="${escapeAttr(f.name)}" />
      <select class="f-style">
        ${styles
          .map(
            (s) =>
              `<option value="${s}" ${s === f.style ? "selected" : ""}>${s}</option>`,
          )
          .join("")}
      </select>
      <input type="number" class="f-cap" min="0" step="0.5" value="${f.daily_cap_usd}" />
      <button type="button" class="f-save">Save</button>`;
    row.querySelector(".f-save")!.addEventListener("click", () => {
      const name = (row.querySelector(".f-name") as HTMLInputElement).value;
      const style = (row.querySelector(".f-style") as HTMLSelectElement)
        .value as Style;
      const cap = parseFloat(
        (row.querySelector(".f-cap") as HTMLInputElement).value,
      );
      void Familiars.updateConfig(f.id, name, style, cap);
    });
    el.appendChild(row);
  }
}

function escapeAttr(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}
