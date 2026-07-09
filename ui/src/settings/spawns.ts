import type { SpawnSpec } from "../spawns/types";
import { listSpawns, upsertSpawn, deleteSpawn } from "../spawns/api";
import { CustomSelect } from "../ui/select";
import { spawnShortcutLabel, acpExecutorFor } from "../spawns/shortcuts";

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
  /// Clickable flag/subcommand chips, rendered under the row.
  chips: ArgChip[];
  /// Prose explaining usage / prerequisites — not actionable.
  note?: string;
}
const PRESETS: Record<string, ExecutorPreset> = {
  Claude: {
    label: "Claude", command: "claude", args: [],
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
    label: "Codex", command: "codex", args: [],
    chips: [
      { label: "exec '<prompt>'", insert: "exec '<prompt>'", caret: "<prompt>" },
      { label: "--model <id>", insert: "--model <id>", caret: "<id>" },
      { label: "--cd <path>", insert: "--cd <path>", caret: "<path>" },
    ],
    note: "Bare `codex` = interactive; `codex exec '<prompt>'` = headless.",
  },
  Copilot: {
    label: "Copilot", command: "gh", args: ["copilot"],
    chips: [
      { label: "suggest '<query>'", insert: "suggest '<query>'", caret: "<query>" },
      { label: "explain '<cmd>'", insert: "explain '<cmd>'", caret: "<cmd>" },
    ],
    note: "Requires: gh auth login + gh extension install github/gh-copilot.",
  },
  Opencode: {
    label: "Opencode", command: "opencode", args: [],
    chips: [
      { label: "run '<prompt>'", insert: "run '<prompt>'", caret: "<prompt>" },
      { label: "--model <provider/model>", insert: "--model <provider/model>", caret: "<provider/model>" },
      { label: "--agent <name>", insert: "--agent <name>", caret: "<name>" },
    ],
    note: "Bare `opencode` opens the interactive TUI.",
  },
  Pi: {
    label: "Pi", command: "pi", args: [],
    chips: [],
    note: "Covenant's in-house Pi RPC executor (LineFramer → PI-4 tools/thinking/steer). No external CLI; spawned via internal RPC.",
  },
  Gemini: {
    label: "Gemini", command: "gemini", args: [],
    chips: [
      { label: "-p '<prompt>'", insert: "-p '<prompt>'", caret: "<prompt>" },
      { label: "-m <model>", insert: "-m <model>", caret: "<model>" },
      { label: "--sandbox", insert: "--sandbox" },
      { label: "--all-files", insert: "--all-files" },
      { label: "--yolo", insert: "--yolo" },
    ],
  },
  Ollama: {
    label: "Ollama", command: "ollama", args: ["run"],
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

/// Brand accent for rail/header identity dots only — surfaces stay
/// neutral per the True Dark elevation rule.
const BRAND_COLORS: Record<string, string> = {
  Claude: "#d97757",
  Codex: "#e8e8e8",
  Copilot: "#6dd29a",
  Pi: "#7c8aff",
  Gemini: "#7cc4f4",
  Ollama: "#f4c97c",
  Opencode: "#8a93a0",
};
const brandColor = (label: string): string => BRAND_COLORS[label] ?? "#8a93a0";

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
    env: {},
    cwd: null,
    default: false,
  };
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
  let selectedId: string | null =
    specs.find((s) => s.default)?.id ?? specs[0]?.id ?? null;

  const persistSpec = async (updated: SpawnSpec): Promise<void> => {
    await upsertSpawn(updated);
    specs = specs.map((s) => (s.id === updated.id ? updated : s));
  };

  const renderDetail = (spec: SpawnSpec, detailHost: HTMLElement): void => {
    const isPreset = PRESET_KEYS.includes(spec.label);
    const brandSelect = new CustomSelect({
      className: "spawns-settings-select",
      ariaLabel: "Spawn brand",
      value: isPreset ? spec.label : "__custom__",
      options: [
        ...PRESET_KEYS.map((k) => ({ value: k, label: k })),
        { value: "__custom__", label: "Custom…" },
      ],
    });

    const head = document.createElement("div");
    head.className = "spawns-md-head";
    const dot = document.createElement("span");
    dot.className = "spawns-md-dot";
    dot.style.background = brandColor(spec.label);
    const spacer = document.createElement("span");
    spacer.className = "spawns-md-spacer";
    head.append(dot, brandSelect.element, spacer);

    if (spec.default) {
      const badge = document.createElement("span");
      badge.className = "spawns-md-badge";
      badge.textContent = "default";
      head.appendChild(badge);
    } else {
      const setDefault = document.createElement("button");
      setDefault.type = "button";
      setDefault.className = "spawns-md-action";
      setDefault.dataset["role"] = "set-default";
      setDefault.textContent = "Set default";
      setDefault.addEventListener("click", () => {
        void (async () => {
          const prev = specs.find((s) => s.default && s.id !== spec.id);
          if (prev) await persistSpec({ ...prev, default: false });
          await persistSpec({ ...collect(), default: true });
          render();
        })();
      });
      head.appendChild(setDefault);
    }

    const del = document.createElement("button");
    del.type = "button";
    del.className = "spawns-md-action spawns-md-action--danger";
    del.dataset["role"] = "delete";
    del.textContent = "Delete";
    del.addEventListener("click", () => {
      void (async () => {
        const idx = specs.findIndex((s) => s.id === spec.id);
        await deleteSpawn(spec.id);
        specs = specs.filter((s) => s.id !== spec.id);
        selectedId = specs[Math.min(idx, specs.length - 1)]?.id ?? null;
        render();
      })();
    });
    head.appendChild(del);
    detailHost.appendChild(head);

    const grid = document.createElement("div");
    grid.className = "spawns-md-grid";
    grid.innerHTML = `
      <label class="spawns-md-label">Command</label>
      <input class="spawns-settings-input" type="text" name="command" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="e.g. claude, gh, ollama" value="${escHtml(spec.command)}" />
      <label class="spawns-md-label">Args</label>
      <input class="spawns-settings-input" type="text" name="args" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="e.g. copilot, --model opus-4.8, run llama3" value="${escHtml(spec.args.join(" "))}" />
    `;
    detailHost.appendChild(grid);

    const cmdInp = grid.querySelector<HTMLInputElement>('input[name="command"]')!;
    const argsInp = grid.querySelector<HTMLInputElement>('input[name="args"]')!;

    const chipsHost = document.createElement("div");
    chipsHost.className = "spawns-md-hint";
    detailHost.appendChild(chipsHost);

    // "Launch as ACP tab" — only rendered when the current command maps
    // to an ACP-capable executor (claude / copilot / pi). Editing the
    // command to anything else hides the row and drops the flag on the
    // next persist (collect() re-validates eligibility).
    const acpRow = document.createElement("label");
    acpRow.className = "spawns-md-acp";
    acpRow.dataset["role"] = "acp";
    const acpCheck = document.createElement("input");
    acpCheck.type = "checkbox";
    acpCheck.checked = spec.acp === true;
    const acpText = document.createElement("span");
    acpText.textContent = "Launch as ACP tab (chat view instead of terminal)";
    acpRow.append(acpCheck, acpText);
    detailHost.appendChild(acpRow);

    const currentDraft = (): { command: string; args: string[] } => ({
      command: cmdInp.value.trim(),
      args: argsInp.value.trim().split(/\s+/).filter(Boolean),
    });
    const updateAcpRow = (): void => {
      acpRow.hidden = acpExecutorFor(currentDraft()) === null;
    };
    acpCheck.addEventListener("change", () => { void persist(); });

    const preview = document.createElement("div");
    preview.className = "spawns-md-preview";
    preview.dataset["role"] = "preview";
    detailHost.appendChild(preview);

    const updatePreview = (): void => {
      const line = [cmdInp.value.trim(), argsInp.value.trim()]
        .filter(Boolean)
        .join(" ");
      preview.innerHTML = `<span class="spawns-md-prompt">❯</span> ${escHtml(line)}`;
    };

    const collect = (): SpawnSpec => {
      const selVal = brandSelect.value;
      const label = selVal === "__custom__" ? (spec.label || spec.id) : selVal;
      const argsRaw = argsInp.value.trim();
      const draft = {
        ...spec,
        label,
        command: cmdInp.value.trim(),
        args: argsRaw ? argsRaw.split(/\s+/).filter(Boolean) : [],
      };
      return { ...draft, acp: acpCheck.checked && acpExecutorFor(draft) !== null };
    };
    const persist = async (): Promise<void> => {
      await persistSpec(collect());
    };

    for (const inp of [cmdInp, argsInp]) {
      inp.addEventListener("change", () => { void persist(); });
      inp.addEventListener("input", () => {
        updatePreview();
        updateAcpRow();
      });
    }

    brandSelect.element.addEventListener("change", () => {
      const preset = PRESETS[brandSelect.value];
      if (preset) {
        cmdInp.value = preset.command;
        argsInp.value = preset.args.join(" ");
      }
      renderChips(brandSelect.value);
      updatePreview();
      void persist().then(render);
    });

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
      updatePreview();
      void persist();
    };

    const renderChips = (k: string): void => {
      chipsHost.innerHTML = "";
      const p = PRESETS[k];
      if (!p) return;
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
        chipsHost.appendChild(chipsWrap);
      }
      if (p.note) {
        const note = document.createElement("div");
        note.className = "spawns-settings-note";
        note.textContent = p.note;
        chipsHost.appendChild(note);
      }
    };

    renderChips(brandSelect.value);
    updatePreview();
    updateAcpRow();
  };

  const render = (): void => {
    host.innerHTML = "";

    const title = document.createElement("h3");
    title.className = "settings-section-title";
    title.textContent = "Harnesses";
    host.appendChild(title);

    const desc = document.createElement("p");
    desc.className = "settings-section-desc";
    desc.textContent =
      "Executor processes the operator can launch in a terminal tab. One spawn can be marked default.";
    host.appendChild(desc);

    const wrap = document.createElement("div");
    wrap.className = "spawns-md";

    const rail = document.createElement("div");
    rail.className = "spawns-md-rail";
    specs.forEach((spec, idx) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className =
        "spawns-md-item" + (spec.id === selectedId ? " is-selected" : "");
      const dot = document.createElement("span");
      dot.className = "spawns-md-dot";
      dot.style.background = brandColor(spec.label);
      const label = document.createElement("span");
      label.className = "spawns-md-item-label";
      label.textContent = spec.label;
      item.append(dot, label);
      if (spec.default) {
        const star = document.createElement("span");
        star.className = "spawns-md-star";
        star.textContent = "★";
        item.appendChild(star);
      }
      // Ctrl+N quick-spawn hint (auto-assigned by list order, first 9).
      const kbd = spawnShortcutLabel(idx);
      if (kbd) {
        const hint = document.createElement("span");
        hint.className = "spawn-kbd spawns-md-kbd";
        hint.textContent = kbd;
        item.appendChild(hint);
      }
      item.addEventListener("click", () => {
        selectedId = spec.id;
        render();
      });
      rail.appendChild(item);
    });

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "spawns-md-add";
    addBtn.textContent = "+ Add executor";
    addBtn.addEventListener("click", () => {
      void (async () => {
        const draft = emptySpec();
        await upsertSpawn(draft);
        specs = [...specs, draft];
        selectedId = draft.id;
        render();
        host.querySelector<HTMLInputElement>('input[name="command"]')?.focus();
      })();
    });
    rail.appendChild(addBtn);
    wrap.appendChild(rail);

    const detail = document.createElement("div");
    detail.className = "spawns-md-detail";
    const selected = specs.find((s) => s.id === selectedId);
    if (selected) {
      renderDetail(selected, detail);
    } else {
      const empty = document.createElement("div");
      empty.className = "spawns-md-empty";
      empty.textContent = "No spawns yet — add an executor to get started.";
      detail.appendChild(empty);
    }
    wrap.appendChild(detail);
    host.appendChild(wrap);
  };

  render();
}
