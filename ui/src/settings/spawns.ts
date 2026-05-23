import type { SpawnSpec } from "../spawns/types";
import { listSpawns, upsertSpawn, deleteSpawn } from "../spawns/api";
import { CustomSelect } from "../ui/select";

/// Known executor presets. Picking one fills in defaults for any
/// fields the user hasn't customised yet. "Custom" leaves the row
/// editable as a free-form spawn.
/// Each chip is an actionable token the user can click to append into
/// the args field. `insert` is what we append; `label` is what we show.
/// `caret` marks the substring inside `insert` to auto-select after
/// appending, so users can immediately type the placeholder value
/// (e.g. select `<prompt>` after clicking `-p '<prompt>'`).
interface ArgChip {
  label: string;
  insert: string;
  caret?: string;
}
interface ExecutorPreset {
  label: string;
  command: string;
  args: string[];
  model: string | null;
  /// Clickable flag/subcommand chips, rendered under the row.
  chips: ArgChip[];
  /// Prose explaining usage / prerequisites — not actionable.
  note?: string;
}
const PRESETS: Record<string, ExecutorPreset> = {
  Claude: {
    label: "Claude", command: "claude", args: [], model: "claude-sonnet-4-6",
    chips: [
      { label: "-p '<prompt>'", insert: "-p '<prompt>'", caret: "<prompt>" },
      { label: "--continue", insert: "--continue" },
      { label: "--resume <sid>", insert: "--resume <sid>", caret: "<sid>" },
      { label: "--model <id>", insert: "--model <id>", caret: "<id>" },
      { label: "--add-dir <path>", insert: "--add-dir <path>", caret: "<path>" },
      { label: "--dangerously-skip-permissions", insert: "--dangerously-skip-permissions" },
    ],
  },
  Codex: {
    label: "Codex", command: "codex", args: [], model: "gpt-5",
    chips: [
      { label: "exec '<prompt>'", insert: "exec '<prompt>'", caret: "<prompt>" },
      { label: "--model <id>", insert: "--model <id>", caret: "<id>" },
      { label: "--cd <path>", insert: "--cd <path>", caret: "<path>" },
    ],
    note: "Bare `codex` = interactive; `codex exec '<prompt>'` = headless.",
  },
  Copilot: {
    label: "Copilot", command: "gh", args: ["copilot"], model: null,
    chips: [
      { label: "suggest '<query>'", insert: "suggest '<query>'", caret: "<query>" },
      { label: "explain '<cmd>'", insert: "explain '<cmd>'", caret: "<cmd>" },
    ],
    note: "Requires: gh auth login + gh extension install github/gh-copilot.",
  },
  Opencode: {
    label: "Opencode", command: "opencode", args: [], model: null,
    chips: [
      { label: "run '<prompt>'", insert: "run '<prompt>'", caret: "<prompt>" },
      { label: "--model <provider/model>", insert: "--model <provider/model>", caret: "<provider/model>" },
      { label: "--agent <name>", insert: "--agent <name>", caret: "<name>" },
    ],
    note: "Bare `opencode` opens the interactive TUI.",
  },
  Pi: {
    label: "Pi", command: "pi", args: [], model: null,
    chips: [],
    note: "Covenant's in-house Pi RPC executor (LineFramer → PI-4 tools/thinking/steer). No external CLI; spawned via internal RPC.",
  },
  Gemini: {
    label: "Gemini", command: "gemini", args: [], model: "gemini-2.5-pro",
    chips: [
      { label: "-p '<prompt>'", insert: "-p '<prompt>'", caret: "<prompt>" },
      { label: "-m <model>", insert: "-m <model>", caret: "<model>" },
      { label: "--sandbox", insert: "--sandbox" },
      { label: "--all-files", insert: "--all-files" },
      { label: "--yolo", insert: "--yolo" },
    ],
  },
  Ollama: {
    label: "Ollama", command: "ollama", args: ["run"], model: null,
    chips: [
      { label: "run <model>", insert: "run <model>", caret: "<model>" },
      { label: "pull <model>", insert: "pull <model>", caret: "<model>" },
      { label: "serve", insert: "serve" },
      { label: "--verbose", insert: "--verbose" },
    ],
    note: "Model is the trailing arg (e.g. llama3, qwen3:30b).",
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
  const labelSelect = new CustomSelect({
    className: "spawns-settings-select",
    ariaLabel: "Spawn brand",
    value: isPreset ? spec.label : "__custom__",
    options: [
      ...PRESET_KEYS.map((k) => ({ value: k, label: k })),
      { value: "__custom__", label: "Custom…" },
    ],
  });
  row.innerHTML = `
    <span data-role="label-select"></span>
    <input class="spawns-settings-input spawns-settings-input--wide" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" name="command" placeholder="e.g. claude, gh, ollama" value="${escHtml(spec.command)}" />
    <input class="spawns-settings-input spawns-settings-input--wide" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" name="args" placeholder="e.g. copilot, run llama3" value="${escHtml(spec.args.join(" "))}" />
    <input class="spawns-settings-input" type="text" name="model" placeholder="e.g. claude-sonnet-4-6" value="${escHtml(spec.model ?? "")}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
    <label class="spawns-settings-default" title="Set as default">
      <input type="checkbox" name="default" ${spec.default ? "checked" : ""} />
      <span>default</span>
    </label>
    <button class="spawns-settings-delete btn-secondary" type="button" title="Delete">✕</button>
  `;

  row.querySelector<HTMLElement>('[data-role="label-select"]')!.replaceWith(labelSelect.element);
  const cmdInp = row.querySelector<HTMLInputElement>('input[name="command"]')!;
  const argsInp = row.querySelector<HTMLInputElement>('input[name="args"]')!;
  const modelInp = row.querySelector<HTMLInputElement>('input[name="model"]')!;

  const persist = async (): Promise<void> => {
    const selVal = labelSelect.value;
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

  labelSelect.element.addEventListener("change", () => {
    const preset = PRESETS[labelSelect.value];
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

  const appendChip = (chip: ArgChip): void => {
    const current = argsInp.value;
    const sep = current.length === 0 || /\s$/.test(current) ? "" : " ";
    const before = current + sep;
    argsInp.value = before + chip.insert;
    argsInp.focus();
    // Select the placeholder (e.g. <prompt>) so the user can type
    // over it immediately. Falls back to cursor-at-end.
    if (chip.caret) {
      const start = (before + chip.insert).lastIndexOf(chip.caret);
      if (start >= 0) {
        argsInp.setSelectionRange(start, start + chip.caret.length);
      } else {
        argsInp.setSelectionRange(argsInp.value.length, argsInp.value.length);
      }
    } else {
      argsInp.setSelectionRange(argsInp.value.length, argsInp.value.length);
    }
    void persist();
  };

  const renderHint = (k: string): void => {
    hintEl.innerHTML = "";
    const p = PRESETS[k];
    if (!p) {
      hintEl.style.display = "none";
      return;
    }
    hintEl.style.display = "";

    if (p.chips.length > 0) {
      const chipsWrap = document.createElement("div");
      chipsWrap.className = "spawns-settings-chips";
      for (const chip of p.chips) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "spawns-settings-chip";
        btn.textContent = chip.label;
        btn.title = `Append \`${chip.insert}\` to args`;
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          appendChip(chip);
        });
        chipsWrap.appendChild(btn);
      }
      hintEl.appendChild(chipsWrap);
    }

    if (p.note) {
      const note = document.createElement("div");
      note.className = "spawns-settings-note";
      note.textContent = p.note;
      hintEl.appendChild(note);
    }
  };
  renderHint(labelSelect.value);
  labelSelect.element.addEventListener("change", () => renderHint(labelSelect.value));
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
