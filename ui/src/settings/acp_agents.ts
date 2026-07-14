/// Settings → Harnesses → "ACP agents": per-executor launch config for
/// interactive ACP tabs (trust level, default model, thinking budget,
/// env, extra args). Persists into Settings.acp_executors; the Rust
/// spawn path translates trust to each adapter's native mechanism.
import {
  getSettings,
  setSettings,
  type AcpExecutorConfig,
  type AcpTrust,
} from "../api";
import { brandIconSvg } from "../icons/brands";
import { attachTooltip } from "../tooltip/tooltip";

interface AcpExecutorMeta {
  id: string;
  label: string;
  /// Adapter exposes MAX_THINKING_TOKENS (claude only).
  thinking: boolean;
  /// Adapter accepts a default model.
  model: boolean;
}

const EXECUTORS: AcpExecutorMeta[] = [
  { id: "claude", label: "Claude", thinking: true, model: true },
  { id: "copilot", label: "Copilot", thinking: false, model: true },
  { id: "opencode", label: "Opencode", thinking: false, model: true },
  { id: "pi", label: "Pi", thinking: false, model: false },
];

const TRUST_LEVELS: { id: AcpTrust; label: string; tip: string }[] = [
  { id: "ask", label: "Ask", tip: "Every permission request is deferred to you" },
  { id: "balanced", label: "Balanced", tip: "Edits, reads and safe commands auto-allowed; the rest ask" },
  { id: "yolo", label: "YOLO", tip: "Everything auto-allowed — equivalent to --dangerously-skip-permissions" },
];

/// Mirror of Settings::acp_executor's Rust-side defaults.
const defaultCfg = (id: string): AcpExecutorConfig => ({
  trust: id === "copilot" ? "yolo" : "balanced",
});

export async function renderAcpAgentsSection(host: HTMLElement): Promise<void> {
  const section = document.createElement("div");
  section.className = "acp-agents";
  section.innerHTML = `
    <div class="acp-agents-title">ACP agents</div>
    <div class="acp-agents-sub">Launch configuration for chat-tab agents. Trust maps to each adapter's native permission mechanism.</div>
    <div class="acp-agents-cards"></div>
  `;
  host.appendChild(section);
  const cardsHost = section.querySelector<HTMLElement>(".acp-agents-cards");
  if (!cardsHost) return;

  const settings = await getSettings();
  const configs: Record<string, AcpExecutorConfig> = {};
  for (const ex of EXECUTORS) {
    configs[ex.id] = { ...defaultCfg(ex.id), ...(settings.acp_executors?.[ex.id] ?? {}) };
  }

  const persist = async (id: string): Promise<void> => {
    // Read-modify-write on fresh settings, touching only the edited
    // executor's key, so we never clobber concurrent changes to other
    // settings or to sibling acp_executors entries.
    const fresh = await getSettings();
    fresh.acp_executors = { ...(fresh.acp_executors ?? {}), [id]: configs[id]! };
    await setSettings(fresh);
  };

  for (const ex of EXECUTORS) {
    const cfg = configs[ex.id]!;
    const card = document.createElement("div");
    card.className = "acp-agent-card";
    card.dataset.executor = ex.id;

    const head = document.createElement("div");
    head.className = "acp-agent-head";
    const badge = document.createElement("span");
    badge.className = "acp-agent-brand";
    badge.innerHTML = brandIconSvg(ex.label, 14) ?? "";
    const name = document.createElement("span");
    name.className = "acp-agent-name";
    name.textContent = ex.label;
    head.append(badge, name);
    card.appendChild(head);

    // Trust segmented control.
    const seg = document.createElement("div");
    seg.className = "acp-trust-seg";
    for (const lvl of TRUST_LEVELS) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.trust = lvl.id;
      b.textContent = lvl.label;
      if (lvl.id === "yolo") b.classList.add("acp-trust-yolo");
      b.setAttribute("aria-pressed", String(cfg.trust === lvl.id));
      attachTooltip(b, lvl.tip);
      b.addEventListener("click", () => {
        cfg.trust = lvl.id;
        for (const other of seg.querySelectorAll("button")) {
          other.setAttribute("aria-pressed", String(other === b));
        }
        void persist(ex.id);
      });
      seg.appendChild(b);
    }
    card.appendChild(seg);

    const fields = document.createElement("div");
    fields.className = "acp-agent-fields";

    if (ex.model) {
      const model = document.createElement("input");
      model.type = "text";
      model.className = "acp-model-input";
      model.placeholder = "default model (blank = adapter default)";
      model.value = cfg.model ?? "";
      model.addEventListener("change", () => {
        cfg.model = model.value.trim() || null;
        void persist(ex.id);
      });
      fields.appendChild(model);
    }

    if (ex.thinking) {
      const thinking = document.createElement("input");
      thinking.type = "number";
      thinking.className = "acp-thinking-input";
      thinking.placeholder = "thinking budget (tokens)";
      thinking.min = "0";
      if (cfg.thinking_tokens != null) thinking.value = String(cfg.thinking_tokens);
      thinking.addEventListener("change", () => {
        const n = parseInt(thinking.value, 10);
        cfg.thinking_tokens = Number.isFinite(n) && n > 0 ? n : null;
        void persist(ex.id);
      });
      fields.appendChild(thinking);
    }

    // ponytail: env + args as single free-text inputs (KEY=VALUE per
    // line / whitespace-split args); upgrade to row editors if quoting
    // ever matters.
    const env = document.createElement("textarea");
    env.className = "acp-env-input";
    env.rows = 2;
    env.placeholder = "env — KEY=VALUE per line";
    env.value = (cfg.env ?? []).map(([k, v]) => `${k}=${v}`).join("\n");
    env.addEventListener("change", () => {
      cfg.env = env.value
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.includes("="))
        .map((l) => {
          const i = l.indexOf("=");
          return [l.slice(0, i).trim(), l.slice(i + 1)] as [string, string];
        });
      void persist(ex.id);
    });
    fields.appendChild(env);

    const args = document.createElement("input");
    args.type = "text";
    args.className = "acp-args-input";
    args.placeholder = "extra adapter args";
    args.value = (cfg.args ?? []).join(" ");
    args.addEventListener("change", () => {
      cfg.args = args.value.split(/\s+/).filter(Boolean);
      void persist(ex.id);
    });
    fields.appendChild(args);

    card.appendChild(fields);
    cardsHost.appendChild(card);
  }
}
