import type { SpawnSpec } from "../spawns/types";
import { listSpawns, upsertSpawn, deleteSpawn } from "../spawns/api";

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

  row.innerHTML = `
    <input class="spawns-settings-input" type="text" name="label" placeholder="Label" value="${escHtml(spec.label)}" />
    <input class="spawns-settings-input spawns-settings-input--wide" type="text" name="command" placeholder="command" value="${escHtml(spec.command)}" />
    <input class="spawns-settings-input spawns-settings-input--wide" type="text" name="args" placeholder="args (space-separated)" value="${escHtml(spec.args.join(" "))}" />
    <input class="spawns-settings-input" type="text" name="model" placeholder="model (optional)" value="${escHtml(spec.model ?? "")}" />
    <label class="spawns-settings-default" title="Set as default">
      <input type="checkbox" name="default" ${spec.default ? "checked" : ""} />
      <span>default</span>
    </label>
    <button class="spawns-settings-delete btn-secondary" type="button" title="Delete">✕</button>
  `;

  const persist = async (): Promise<void> => {
    const label = (row.querySelector<HTMLInputElement>('input[name="label"]')!).value.trim();
    const command = (row.querySelector<HTMLInputElement>('input[name="command"]')!).value.trim();
    const argsRaw = (row.querySelector<HTMLInputElement>('input[name="args"]')!).value.trim();
    const model = (row.querySelector<HTMLInputElement>('input[name="model"]')!).value.trim();
    const isDefault = (row.querySelector<HTMLInputElement>('input[name="default"]')!).checked;

    const updated: SpawnSpec = {
      ...spec,
      label: label || spec.id,
      command,
      args: argsRaw ? argsRaw.split(/\s+/).filter(Boolean) : [],
      model: model || null,
      default: isDefault,
    };
    await onChange(updated);
  };

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
