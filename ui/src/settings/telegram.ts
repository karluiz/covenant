import { openUrl } from "@tauri-apps/plugin-opener";
import { telegramTestConnection, telegramStatus } from "../api";
import { telegramIconSvg } from "../icons/brands";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";

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

type PillState = "disabled" | "ok" | "error" | "idle" | "testing";

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
    <div class="tg">
      <header class="tg-head">
        <span class="tg-glyph">${telegramIconSvg(18)}</span>
        <div class="tg-subtitle">Push escalations and spec results to your phone.</div>
        <span class="tg-pill" data-role="pill"></span>
      </header>

      <label class="tg-toggle">
        <input type="checkbox" id="tg-enabled" ${t.enabled ? "checked" : ""}/>
        <span>Enabled</span>
      </label>

      <section class="tg-section">
        <div class="tg-section-head">Connection</div>

        <div class="tg-field">
          <label class="tg-label" for="tg-token">Bot token</label>
          <div class="tg-secret">
            <input type="password" id="tg-token" autocomplete="off" spellcheck="false"
                   placeholder="123456789:ABC-DEF..." value="${escapeAttr(t.bot_token ?? "")}"/>
            <button type="button" class="tg-icon-btn" data-role="reveal" aria-label="Reveal token">${Icons.eye({ size: 15 })}</button>
            <button type="button" class="tg-icon-btn" data-role="copy" aria-label="Copy token">${Icons.copy({ size: 15 })}</button>
          </div>
          <div class="tg-hint">Create a bot with <a href="#" data-link="https://t.me/BotFather">@BotFather</a> (<code>/newbot</code>) and paste its token here.</div>
        </div>

        <div class="tg-field">
          <label class="tg-label" for="tg-chat">Chat ID</label>
          <input type="text" id="tg-chat" class="tg-input" autocomplete="off" spellcheck="false"
                 placeholder="e.g. 7560101764" value="${escapeAttr(t.chat_id ?? "")}"/>
          <div class="tg-hint">Send <code>/start</code> to your bot, then <a href="#" data-link="https://t.me/userinfobot">@userinfobot</a> tells you your chat ID.</div>
        </div>

        <div class="tg-test-row">
          <button type="button" class="tg-btn" id="tg-test">Test connection</button>
          <span class="tg-test-stat" data-role="test-stat"></span>
        </div>
      </section>

      <section class="tg-section">
        <div class="tg-section-head">Notify on</div>
        <label class="tg-check"><input type="checkbox" id="tg-ev-esc" ${t.events.escalations ? "checked" : ""}/>
          <span><b>Escalations</b><small>Operator stops and needs your call.</small></span></label>
        <label class="tg-check"><input type="checkbox" id="tg-ev-mc" ${t.events.mission_completed ? "checked" : ""}/>
          <span><b>Spec completed</b><small>A spec run finished successfully.</small></span></label>
        <label class="tg-check"><input type="checkbox" id="tg-ev-mf" ${t.events.mission_failed ? "checked" : ""}/>
          <span><b>Spec failed</b><small>A spec run errored out.</small></span></label>
      </section>
    </div>
  `;

  const q = <T extends HTMLElement>(sel: string): T => container.querySelector<T>(sel)!;
  const pill = q<HTMLElement>('[data-role="pill"]');
  const testStat = q<HTMLElement>('[data-role="test-stat"]');
  const enabled = q<HTMLInputElement>("#tg-enabled");
  const tokenInput = q<HTMLInputElement>("#tg-token");

  const paintPill = (state: PillState): void => {
    const label: Record<PillState, string> = {
      disabled: "Disabled", ok: "Connected", error: "Failing", idle: "Not tested", testing: "Testing…",
    };
    pill.className = `tg-pill tg-pill--${state}`;
    pill.innerHTML = `<span class="tg-dot"></span><span>${label[state]}</span>`;
  };

  // Reflect stored connection state on open (falls back to enabled/idle).
  paintPill(t.enabled ? "idle" : "disabled");
  void telegramStatus()
    .then((s) => paintPill(s === "ok" ? "ok" : s === "error" ? "error" : enabled.checked ? "idle" : "disabled"))
    .catch(() => {});

  const persist = (): Promise<void> =>
    save({
      telegram: {
        ...t,
        enabled: enabled.checked,
        bot_token: tokenInput.value,
        chat_id: q<HTMLInputElement>("#tg-chat").value,
        events: {
          escalations: q<HTMLInputElement>("#tg-ev-esc").checked,
          mission_completed: q<HTMLInputElement>("#tg-ev-mc").checked,
          mission_failed: q<HTMLInputElement>("#tg-ev-mf").checked,
        },
      },
    });

  container.querySelectorAll("input").forEach((el) =>
    el.addEventListener("change", () => {
      void persist();
      if (el === enabled && pill.classList.contains("tg-pill--disabled") && enabled.checked) paintPill("idle");
      if (el === enabled && !enabled.checked) paintPill("disabled");
    }),
  );

  // Reveal / copy on the bot token — same affordance as the Providers key field.
  const revealBtn = q<HTMLButtonElement>('[data-role="reveal"]');
  attachTooltip(revealBtn, "Reveal");
  revealBtn.onclick = () => {
    const hidden = tokenInput.type === "password";
    tokenInput.type = hidden ? "text" : "password";
    revealBtn.innerHTML = hidden ? Icons.eyeOff({ size: 15 }) : Icons.eye({ size: 15 });
  };
  const copyBtn = q<HTMLButtonElement>('[data-role="copy"]');
  attachTooltip(copyBtn, "Copy");
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(tokenInput.value);
      copyBtn.innerHTML = Icons.check({ size: 15 });
      setTimeout(() => (copyBtn.innerHTML = Icons.copy({ size: 15 })), 1200);
    } catch {
      /// Clipboard may be denied in the webview — silently no-op.
    }
  };

  // t.me links open in the OS browser / Telegram app.
  container.querySelectorAll<HTMLAnchorElement>("a[data-link]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      void openUrl(a.dataset.link!);
    }),
  );

  q<HTMLButtonElement>("#tg-test").addEventListener("click", async () => {
    testStat.className = "tg-test-stat tg-test-stat--pending";
    testStat.textContent = "Sending a test message…";
    paintPill("testing");
    // Test uses saved settings — flush the form first so a freshly typed
    // token/chat is what gets probed.
    try {
      await persist();
      await telegramTestConnection();
      testStat.className = "tg-test-stat tg-test-stat--ok";
      testStat.textContent = "✓ Sent — check your Telegram chat.";
      paintPill("ok");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      testStat.className = "tg-test-stat tg-test-stat--err";
      testStat.textContent = "✗ " + msg;
      paintPill("error");
    }
  });
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
