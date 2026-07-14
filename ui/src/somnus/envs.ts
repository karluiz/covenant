import {
  somnusEnvActivate,
  somnusEnvCreate,
  somnusEnvDelete,
  somnusEnvList,
  somnusEnvUpdate,
  type SomnusEnvironment,
  type SomnusEnvVar,
} from "../api";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { confirmPopover } from "./menu";

function parseVars(json: string): SomnusEnvVar[] {
  try {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    return (raw as SomnusEnvVar[]).filter((v) => typeof v?.key === "string");
  } catch {
    return [];
  }
}

export class EnvEditor {
  readonly element: HTMLElement;
  private listHost: HTMLElement;
  private envs: SomnusEnvironment[] = [];
  private open = new Set<string>();
  private saveTimer: number | null = null;

  constructor(private opts: { onChanged: () => void }) {
    this.element = document.createElement("div");
    this.element.className = "somnus-envs";
    const toolbar = document.createElement("div");
    toolbar.className = "somnus-tree-toolbar";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "rail-btn";
    add.setAttribute("aria-label", "New environment");
    add.innerHTML = Icons.plus({ size: 14 });
    attachTooltip(add, "New environment");
    add.addEventListener("click", () => {
      void somnusEnvCreate("New environment")
        .then((id) => {
          this.open.add(id);
          this.opts.onChanged();
          return this.refresh();
        })
        .catch((e) => console.error("somnus env create failed", e));
    });
    toolbar.append(add);
    this.listHost = document.createElement("div");
    this.listHost.className = "somnus-env-list";
    this.element.append(toolbar, this.listHost);
  }

  async refresh(): Promise<void> {
    try {
      this.render(await somnusEnvList());
    } catch (e) {
      console.error("somnus env list failed", e);
    }
  }

  render(envs: SomnusEnvironment[]): void {
    this.envs = envs;
    this.listHost.replaceChildren();
    if (envs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rail-empty";
      empty.innerHTML = `<div class="rail-empty-title">No environments</div><div class="rail-empty-hint">Create one to use {{variables}}.</div>`;
      this.listHost.append(empty);
      return;
    }
    for (const env of envs) {
      this.listHost.append(this.buildRow(env));
      if (this.open.has(env.id)) this.listHost.append(this.buildVarsTable(env));
    }
  }

  private buildRow(env: SomnusEnvironment): HTMLElement {
    const row = document.createElement("div");
    row.className = "rail-row somnus-env-row";
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    const dot = document.createElement("span");
    dot.className = `rail-dot ${env.is_active ? "is-ok" : "is-idle"}`;
    const name = document.createElement("span");
    name.className = "rail-name";
    name.textContent = env.name;
    row.append(dot, name);

    const act = document.createElement("button");
    act.type = "button";
    act.className = "rail-row-action";
    act.setAttribute("aria-label", env.is_active ? "Deactivate" : "Set active");
    act.innerHTML = Icons.power({ size: 13 });
    attachTooltip(act, env.is_active ? "Deactivate" : "Set active");
    act.addEventListener("click", (e) => {
      e.stopPropagation();
      void somnusEnvActivate(env.is_active ? null : env.id)
        .then(() => {
          this.opts.onChanged();
          return this.refresh();
        })
        .catch((err) => console.error("somnus env activate failed", err));
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "rail-row-action";
    del.setAttribute("aria-label", "Delete environment");
    del.innerHTML = Icons.trash({ size: 13 });
    attachTooltip(del, "Delete environment");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmPopover(row, `Delete environment "${env.name}"?`, "Delete", () => {
        void somnusEnvDelete(env.id)
          .then(() => {
            this.opts.onChanged();
            return this.refresh();
          })
          .catch((err) => console.error("somnus env delete failed", err));
      });
    });
    row.append(act, del);
    row.addEventListener("click", () => {
      if (this.open.has(env.id)) this.open.delete(env.id);
      else this.open.add(env.id);
      this.render(this.envs);
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") row.click();
    });
    return row;
  }

  private buildVarsTable(env: SomnusEnvironment): HTMLElement {
    const vars = parseVars(env.vars);
    const host = document.createElement("div");
    host.className = "somnus-env-vars";

    const nameInput = document.createElement("input");
    nameInput.className = "rail-search somnus-env-name";
    nameInput.type = "text";
    nameInput.value = env.name;
    nameInput.spellcheck = false;
    nameInput.addEventListener("input", () => this.scheduleSave(env.id, nameInput, host));
    host.append(nameInput);

    const addVarRow = (v: SomnusEnvVar): void => {
      const row = document.createElement("div");
      row.className = "somnus-kv-row somnus-env-var";
      const key = document.createElement("input");
      key.className = "rail-search somnus-env-key";
      key.type = "text";
      key.placeholder = "Key";
      key.spellcheck = false;
      key.value = v.key;
      const val = document.createElement("input");
      val.className = "rail-search somnus-env-val";
      val.type = v.secret ? "password" : "text";
      val.placeholder = "Value";
      val.spellcheck = false;
      val.value = v.value;
      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "rail-btn";
      eye.setAttribute("aria-label", "Secret");
      eye.classList.toggle("is-active", v.secret);
      eye.innerHTML = v.secret ? Icons.eyeOff({ size: 13 }) : Icons.eye({ size: 13 });
      attachTooltip(eye, "Mark as secret");
      eye.addEventListener("click", () => {
        row.dataset.secret = row.dataset.secret === "1" ? "0" : "1";
        const secret = row.dataset.secret === "1";
        val.type = secret ? "password" : "text";
        eye.innerHTML = secret ? Icons.eyeOff({ size: 13 }) : Icons.eye({ size: 13 });
        this.scheduleSave(env.id, nameInput, host);
      });
      row.dataset.secret = v.secret ? "1" : "0";
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "rail-btn";
      rm.setAttribute("aria-label", "Remove variable");
      rm.innerHTML = Icons.x({ size: 13 });
      rm.addEventListener("click", () => {
        row.remove();
        this.scheduleSave(env.id, nameInput, host);
      });
      key.addEventListener("input", () => this.scheduleSave(env.id, nameInput, host));
      val.addEventListener("input", () => this.scheduleSave(env.id, nameInput, host));
      row.append(key, val, eye, rm);
      host.append(row);
    };
    for (const v of vars) addVarRow(v);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "somnus-add-row";
    add.textContent = "+ variable";
    add.addEventListener("click", () => {
      addVarRow({ key: "", value: "", secret: false });
      host.append(add); // keep the button last
    });
    host.append(add);
    return host;
  }

  private collectVars(host: HTMLElement): SomnusEnvVar[] {
    const out: SomnusEnvVar[] = [];
    for (const row of host.querySelectorAll(".somnus-env-var")) {
      const key = (row.querySelector(".somnus-env-key") as HTMLInputElement).value.trim();
      const value = (row.querySelector(".somnus-env-val") as HTMLInputElement).value;
      if (key) out.push({ key, value, secret: (row as HTMLElement).dataset.secret === "1" });
    }
    return out;
  }

  private scheduleSave(id: string, nameInput: HTMLInputElement, host: HTMLElement): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const name = nameInput.value.trim() || "Untitled";
      void somnusEnvUpdate(id, name, JSON.stringify(this.collectVars(host)))
        .then(() => {
          const env = this.envs.find((e) => e.id === id);
          if (env) {
            env.name = name;
            env.vars = JSON.stringify(this.collectVars(host));
          }
          this.opts.onChanged();
        })
        .catch((e) => console.error("somnus env save failed", e));
    }, 400);
  }
}
