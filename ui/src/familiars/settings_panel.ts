// Familiars settings section. Rendered inside the existing settings page
// host. Premium-gated: when `is_premium = false`, only a note is shown.
// When premium, exposes the master enable toggle plus per-Familiar config
// rows (name, style, daily cost cap).

import { Familiars, type Style, type FamiliarSummary } from "./api";

export function renderFamiliarsSettings(
  parent: HTMLElement,
  isPremium: boolean,
  enabled: boolean,
  setEnabled: (v: boolean) => Promise<void>,
): void {
  parent.innerHTML = "";
  const wrap = document.createElement("section");
  wrap.className = "settings-section";
  wrap.id = "sec-familiars";

  const head = document.createElement("h3");
  head.className = "settings-section-title";
  head.textContent = "Familiars";
  wrap.appendChild(head);

  if (!isPremium) {
    const note = document.createElement("p");
    note.className = "settings-note";
    note.textContent = "Familiars is a premium feature.";
    wrap.appendChild(note);
    parent.appendChild(wrap);
    return;
  }

  const toggleRow = document.createElement("label");
  toggleRow.className = "settings-field";
  const cbRow = document.createElement("span");
  cbRow.className = "settings-checkbox-row";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = enabled;
  toggle.addEventListener("change", () => {
    void setEnabled(toggle.checked);
  });
  const label = document.createElement("span");
  label.textContent = "Enable Familiars";
  cbRow.append(toggle, label);
  toggleRow.appendChild(cbRow);
  wrap.appendChild(toggleRow);

  const list = document.createElement("div");
  list.className = "settings-familiars-list";
  wrap.appendChild(list);

  Familiars.list()
    .then((items) => renderList(list, items))
    .catch(() => {
      list.textContent = "(could not load Familiars)";
    });

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
