// Familiars settings section. BYOK feature — the user's Anthropic API key
// (configured in Settings → API key) pays for chat/summarization, so the
// feature is opt-in without a premium gate.

import { Familiars, type Style, type FamiliarSummary } from "./api";
import { CustomSelect } from "../ui/select";

export interface FamiliarsSettingsHooks {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
}

export function renderFamiliarsSettings(
  parent: HTMLElement,
  hooks: FamiliarsSettingsHooks,
): void {
  parent.innerHTML = "";
  parent.id = "sec-familiars";
  const wrap = parent;

  const head = document.createElement("h3");
  head.className = "settings-section-title";
  head.textContent = "Familiars";
  wrap.appendChild(head);

  const intro = document.createElement("p");
  intro.className = "settings-hint";
  intro.textContent =
    "Per-operator AI companion with persistent memory. Uses your Anthropic API key (BYOK).";
  wrap.appendChild(intro);

  const enableRow = document.createElement("label");
  enableRow.className = "settings-field";
  const enableCb = document.createElement("span");
  enableCb.className = "settings-checkbox-row";
  const enableInput = document.createElement("input");
  enableInput.type = "checkbox";
  enableInput.checked = hooks.enabled;
  const enableLabel = document.createElement("span");
  enableLabel.textContent = "Enable Familiars";
  enableCb.append(enableInput, enableLabel);
  enableRow.appendChild(enableCb);
  wrap.appendChild(enableRow);

  enableInput.addEventListener("change", () => {
    hooks.setEnabled(enableInput.checked);
  });

  const list = document.createElement("div");
  list.className = "settings-familiars-list";
  wrap.appendChild(list);

  if (hooks.enabled) {
    Familiars.list()
      .then((items) => renderList(list, items))
      .catch(() => {
        list.textContent = "(could not load Familiars)";
      });
  }

}

function renderList(el: HTMLElement, items: FamiliarSummary[]): void {
  el.innerHTML = "";
  if (items.length === 0) {
    renderEmptyState(el);
    return;
  }
  const styles: Style[] = ["concise", "formal", "conversational", "sarcastic"];
  for (const f of items) {
    const row = document.createElement("div");
    row.className = "settings-familiar-row";
    const styleSelect = new CustomSelect({
      className: "f-style-select",
      ariaLabel: `${f.name} Familiar style`,
      value: f.style,
      options: styles.map((s) => ({ value: s, label: s })),
    });
    row.innerHTML = `
      <input type="text" class="f-name" value="${escapeAttr(f.name)}" />
      <span data-role="style-select"></span>
      <input type="number" class="f-cap" min="0" step="0.5" value="${f.daily_cap_usd}" />
      <button type="button" class="f-save">Save</button>`;
    row.querySelector<HTMLElement>('[data-role="style-select"]')!.replaceWith(styleSelect.element);
    row.querySelector(".f-save")!.addEventListener("click", () => {
      const name = (row.querySelector(".f-name") as HTMLInputElement).value;
      const style = styleSelect.value as Style;
      const cap = parseFloat(
        (row.querySelector(".f-cap") as HTMLInputElement).value,
      );
      void Familiars.updateConfig(f.id, name, style, cap);
    });
    el.appendChild(row);
  }
}

function renderEmptyState(el: HTMLElement): void {
  el.classList.add("familiars-empty");
  el.innerHTML = `
    <div class="familiars-empty-card">
      <div class="familiars-empty-title">No Familiars yet</div>
      <p class="familiars-empty-lede">
        A <strong>Familiar</strong> is a per-operator AI companion: it watches
        your terminal session, keeps a persistent memory across restarts, and
        chats with you in plain language. It can also propose
        <em>directives</em> — actions you approve before they reach the operator.
      </p>

      <ol class="familiars-empty-steps">
        <li>
          <span class="step-num">1</span>
          <div>
            <div class="step-title">Start an operator on a tab</div>
            <div class="step-body">Open a tab and press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>A</kbd> to toggle AOM. A Familiar is auto-spawned the first time the operator runs a command.</div>
          </div>
        </li>
        <li>
          <span class="step-num">2</span>
          <div>
            <div class="step-title">Watch the status bar</div>
            <div class="step-body">A small dot appears at the bottom — green means the Familiar is observing. Click it to jump to its chat.</div>
          </div>
        </li>
        <li>
          <span class="step-num">3</span>
          <div>
            <div class="step-title">Open the roster</div>
            <div class="step-body">Press <kbd>⌘</kbd><kbd>⇧</kbd><kbd>L</kbd> to see all Familiars. Click one to chat. Try <code>/summary</code> for a session recap.</div>
          </div>
        </li>
        <li>
          <span class="step-num">4</span>
          <div>
            <div class="step-title">Approve directives</div>
            <div class="step-body">Ask the Familiar to propose an action ("propose stopping the next deploy"). Approve or reject the card — only approved directives reach the operator.</div>
          </div>
        </li>
      </ol>

      <div class="familiars-empty-meta">
        <div><strong>Cost:</strong> uses your Anthropic API key (BYOK). Eager observation is cheap (Haiku); deep chat uses Sonnet. Per-Familiar daily cap defaults to <code>$5</code>.</div>
        <div><strong>Memory:</strong> persisted at <code>~/.karlTerminal/familiars/</code>. Survives restarts. Closing a tab does not delete its Familiar.</div>
        <div><strong>Safety:</strong> proposed commands pass through the operator blocklist. Unsafe directives are blocked and audited.</div>
      </div>
    </div>`;
}

function escapeAttr(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}
