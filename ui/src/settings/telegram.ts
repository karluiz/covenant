import { telegramTestConnection } from "../api";

export interface TelegramEvents {
  escalations: boolean;
  mission_completed: boolean;
  mission_failed: boolean;
}

export interface TelegramSettings {
  enabled: boolean;
  bot_token: string;
  chat_id: string;
  events: TelegramEvents;
  per_tab_overrides?: Record<string, unknown>;
}

export function renderTelegramSection(
  container: HTMLElement,
  settings: { telegram?: TelegramSettings },
  save: (patch: { telegram: TelegramSettings }) => Promise<void>,
): void {
  const t: TelegramSettings = settings.telegram ?? {
    enabled: false,
    bot_token: "",
    chat_id: "",
    events: { escalations: true, mission_completed: true, mission_failed: true },
    per_tab_overrides: {},
  };

  container.innerHTML = `
    <h3 class="settings-section-title">Telegram</h3>
    <label class="settings-field"><span class="settings-checkbox-row">
      <input type="checkbox" id="tg-enabled" ${t.enabled ? "checked" : ""}/> <span>Enabled</span>
    </span></label>
    <label class="settings-field">
      <span class="settings-label">Bot token</span>
      <input type="password" id="tg-token" autocomplete="off" spellcheck="false" value="${escapeAttr(t.bot_token ?? "")}"/>
      <small class="settings-hint">Crea un bot con @BotFather (/newbot) y pega aquí el token.</small>
    </label>
    <label class="settings-field">
      <span class="settings-label">Chat ID</span>
      <input type="text" id="tg-chat" autocomplete="off" spellcheck="false" value="${escapeAttr(t.chat_id ?? "")}"/>
      <small class="settings-hint">Manda /start a tu bot, luego @userinfobot te dice tu chat_id.</small>
    </label>
    <div class="settings-field" style="display:flex; gap:8px; align-items:center;">
      <button type="button" id="tg-test">Test connection</button>
      <span id="tg-test-result" aria-live="polite"></span>
    </div>
    <fieldset class="settings-field">
      <legend class="settings-label">Notify on</legend>
      <label class="settings-checkbox-row"><input type="checkbox" id="tg-ev-esc" ${t.events.escalations ? "checked" : ""}/> <span>Escalations</span></label>
      <label class="settings-checkbox-row"><input type="checkbox" id="tg-ev-mc" ${t.events.mission_completed ? "checked" : ""}/> <span>Mission completed</span></label>
      <label class="settings-checkbox-row"><input type="checkbox" id="tg-ev-mf" ${t.events.mission_failed ? "checked" : ""}/> <span>Mission failed</span></label>
    </fieldset>
  `;

  const persist = (): Promise<void> =>
    save({
      telegram: {
        ...t,
        enabled: (container.querySelector("#tg-enabled") as HTMLInputElement).checked,
        bot_token: (container.querySelector("#tg-token") as HTMLInputElement).value,
        chat_id: (container.querySelector("#tg-chat") as HTMLInputElement).value,
        events: {
          escalations: (container.querySelector("#tg-ev-esc") as HTMLInputElement).checked,
          mission_completed: (container.querySelector("#tg-ev-mc") as HTMLInputElement).checked,
          mission_failed: (container.querySelector("#tg-ev-mf") as HTMLInputElement).checked,
        },
      },
    });

  container.querySelectorAll("input").forEach((el) =>
    el.addEventListener("change", () => {
      void persist();
    }),
  );

  container.querySelector("#tg-test")!.addEventListener("click", async () => {
    const out = container.querySelector("#tg-test-result")! as HTMLElement;
    out.textContent = "...";
    try {
      await telegramTestConnection();
      out.textContent = "✓ OK";
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      out.textContent = "✗ " + msg;
    }
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
