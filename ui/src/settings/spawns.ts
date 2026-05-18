import type { SpawnSpec } from "../spawns/types";
import { listSpawns, upsertSpawn, deleteSpawn } from "../spawns/api";

/// Known executor presets. Picking one fills in defaults for any
/// fields the user hasn't customised yet. "Custom" leaves the row
/// editable as a free-form spawn.
interface ExecutorPreset {
  label: string;
  command: string;
  args: string[];
  model: string | null;
  hint: string;
}
const PRESETS: Record<string, ExecutorPreset> = {
  Claude: {
    label: "Claude", command: "claude", args: [], model: "claude-sonnet-4-6",
    hint: "Flags: -p '<prompt>' (headless), --continue, --resume <sid>, --model <id>, --add-dir <path>, --dangerously-skip-permissions",
  },
  Codex: {
    label: "Codex", command: "codex", args: [], model: "gpt-5",
    hint: "Subcommands: codex (interactive), codex exec '<prompt>' (headless). Flags: --model <id>, --cd <path>",
  },
  Copilot: {
    label: "Copilot", command: "gh", args: ["copilot"], model: null,
    hint: "Subcommands: gh copilot suggest '<query>', gh copilot explain '<cmd>'. Requires: gh auth login + gh extension install github/gh-copilot",
  },
  Opencode: {
    label: "Opencode", command: "opencode", args: [], model: null,
    hint: "Subcommands: opencode (interactive TUI), opencode run '<prompt>'. Flags: --model <provider/model>, --agent <name>",
  },
  Pi: {
    label: "Pi", command: "pi", args: [], model: null,
    hint: "Covenant's in-house Pi RPC executor (LineFramer → PI-4 tools/thinking/steer). No external CLI; spawned via internal RPC.",
  },
  Gemini: {
    label: "Gemini", command: "gemini", args: [], model: "gemini-2.5-pro",
    hint: "Flags: -p '<prompt>' (headless), -m <model>, --sandbox, --all-files, --yolo (skip confirmations)",
  },
  Ollama: {
    label: "Ollama", command: "ollama", args: ["run"], model: null,
    hint: "Subcommands: ollama run <model>, ollama pull <model>, ollama serve. Flags: --verbose. Model is the trailing arg (e.g. llama3, qwen3:30b)",
  },
};
const PRESET_KEYS = Object.keys(PRESETS);

function emptySpec(): SpawnSpec {
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `spawn-${Date.now()}`;
  return {
    id,
    label: "New spawn",
    icon: null,
    command: "",
    args: [],
    model: null,
    env: {},
    cwd: null,
    default: false,
  };
}

function renderRow(
  spec: SpawnSpec,
  host: HTMLElement,
  onChange: (updated: SpawnSpec) => Promise<void>,
  onDelete: (id: string) => Promise<void>,
): void {
  const row = document.createElement("div");
  row.className = "spawns-settings-row";
  row.dataset["id"] = spec.id;

  const isPreset = PRESET_KEYS.includes(spec.label);
  const options = PRESET_KEYS
    .map((k) => `<option value="${escHtml(k)}"${k === spec.label ? " selected" : ""}>${escHtml(k)}</option>`)
    .join("");
  row.innerHTML = `
    <select class="spawns-settings-input" name="label">
      ${options}
      <option value="__custom__"${isPreset ? "" : " selected"}>Custom…</option>
    </select>
    <input class="spawns-settings-input spawns-settings-input--wide" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" name="command" placeholder="e.g. claude, gh, ollama" value="${escHtml(spec.command)}" />
    <input class="spawns-settings-input spawns-settings-input--wide" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" name="args" placeholder="e.g. copilot, run llama3" value="${escHtml(spec.args.join(" "))}" />
    <input class="spawns-settings-input" type="text" name="model" placeholder="e.g. claude-sonnet-4-6" value="${escHtml(spec.model ?? "")}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
    <label class="spawns-settings-default" title="Set as default">
      <input type="checkbox" name="default" ${spec.default ? "checked" : ""} />
      <span>default</span>
    </label>
    <button class="spawns-settings-delete btn-secondary" type="button" title="Delete">✕</button>
  `;

  const sel = row.querySelector<HTMLSelectElement>('select[name="label"]')!;
  const cmdInp = row.querySelector<HTMLInputElement>('input[name="command"]')!;
  const argsInp = row.querySelector<HTMLInputElement>('input[name="args"]')!;
  const modelInp = row.querySelector<HTMLInputElement>('input[name="model"]')!;

  const persist = async (): Promise<void> => {
    const selVal = sel.value;
    const label = selVal === "__custom__" ? (spec.label || spec.id) : selVal;
    const command = cmdInp.value.trim();
    const argsRaw = argsInp.value.trim();
    const model = modelInp.value.trim();
    const isDefault = (row.querySelector<HTMLInputElement>('input[name="default"]')!).checked;

    const updated: SpawnSpec = {
      ...spec,
      label,
      command,
      args: argsRaw ? argsRaw.split(/\s+/).filter(Boolean) : [],
      model: model || null,
      default: isDefault,
    };
    await onChange(updated);
  };

  sel.addEventListener("change", () => {
    const preset = PRESETS[sel.value];
    if (preset) {
      cmdInp.value = preset.command;
      argsInp.value = preset.args.join(" ");
      modelInp.value = preset.model ?? "";
    }
    void persist();
  });
  row.querySelectorAll<HTMLInputElement>("input[type=text]").forEach((inp) => {
    inp.addEventListener("change", () => { void persist(); });
  });
  row.querySelector<HTMLInputElement>('input[name="default"]')!.addEventListener("change", () => {
    void persist();
  });
  row.querySelector<HTMLButtonElement>(".spawns-settings-delete")!.addEventListener("click", () => {
    void onDelete(spec.id);
  });

  host.appendChild(row);

  const hintEl = document.createElement("div");
  hintEl.className = "spawns-settings-hint";
  const setHint = (k: string): void => {
    const p = PRESETS[k];
    hintEl.textContent = p ? p.hint : "";
    hintEl.style.display = p ? "" : "none";
  };
  setHint(spec.label);
  sel.addEventListener("change", () => setHint(sel.value));
  host.appendChild(hintEl);
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function renderSpawnsTab(host: HTMLElement): Promise<void> {
  host.innerHTML = "";

  let specs = await listSpawns();

  const render = (): void => {
    host.innerHTML = "";

    const title = document.createElement("h3");
    title.className = "settings-section-title";
    title.textContent = "Spawns";
    host.appendChild(title);

    const desc = document.createElement("p");
    desc.className = "settings-section-desc";
    desc.textContent =
      "Executor processes the operator can launch in a terminal tab. One spawn can be marked default.";
    host.appendChild(desc);

    const header = document.createElement("div");
    header.className = "spawns-settings-row spawns-settings-header";
    header.innerHTML = `
      <div>Brand</div>
      <div>Command</div>
      <div>Args</div>
      <div>Model</div>
      <div></div>
      <div></div>
    `;
    host.appendChild(header);

    const list = document.createElement("div");
    list.className = "spawns-settings-list";
    host.appendChild(list);

    for (const spec of specs) {
      renderRow(
        spec,
        list,
        async (updated) => {
          await upsertSpawn(updated);
          specs = specs.map((s) => (s.id === updated.id ? updated : s));
        },
        async (id) => {
          await deleteSpawn(id);
          specs = specs.filter((s) => s.id !== id);
          render();
        },
      );
    }

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "btn-secondary spawns-settings-add";
    addBtn.textContent = "+ New spawn";
    addBtn.addEventListener("click", async () => {
      const draft = emptySpec();
      await upsertSpawn(draft);
      specs = [...specs, draft];
      render();
    });
    host.appendChild(addBtn);
  };

  render();
}
