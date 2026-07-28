// Settings → Harnesses → "MCP servers" (3.26).
//
// Edits the config-level `Settings.mcp_servers` list — streamable-http
// MCP servers that operators MAY be allowed to call. Defining a server
// here grants nothing by itself: each operator additionally allowlists
// servers by name in its editor (registry-side, deny-biased).

import { getSettings, setSettings, type McpServerEntry } from "../api";
import { attachTooltip } from "../tooltip/tooltip";

/// Parse "Header-Name: value" lines into pairs; lines without ":" drop.
export function parseHeaderLines(raw: string): [string, string][] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes(":"))
    .map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string];
    })
    .filter(([k]) => k.length > 0);
}

export function formatHeaderLines(headers: [string, string][] | undefined): string {
  return (headers ?? []).map(([k, v]) => `${k}: ${v}`).join("\n");
}

export async function renderMcpServersSection(host: HTMLElement): Promise<void> {
  const section = document.createElement("div");
  section.className = "acp-agents mcp-servers";
  section.innerHTML = `
    <div class="acp-agents-title">MCP servers</div>
    <div class="acp-agents-sub">Streamable-http MCP servers operators may call directly. Defining one grants nothing — enable it per operator in the operator editor. Names become part of the tool name (lowercase a–z, 0–9, - and _).</div>
    <div class="acp-agents-cards"></div>
  `;
  host.appendChild(section);
  const cardsHost = section.querySelector<HTMLElement>(".acp-agents-cards");
  if (!cardsHost) return;

  const settings = await getSettings();
  let entries: McpServerEntry[] = (settings.mcp_servers ?? []).map((e) => ({ ...e }));

  const persist = async (): Promise<void> => {
    // Read-modify-write on fresh settings so we never clobber
    // concurrent edits to sibling settings (same pattern as
    // acp_executors). The backend normalizes names + drops empties.
    const fresh = await getSettings();
    fresh.mcp_servers = entries;
    await setSettings(fresh);
  };

  const render = (): void => {
    cardsHost.innerHTML = "";
    for (const entry of entries) {
      const card = document.createElement("div");
      card.className = "acp-agent-card";

      const head = document.createElement("div");
      head.className = "acp-agent-head";
      const name = document.createElement("input");
      name.type = "text";
      name.className = "acp-model-input";
      name.placeholder = "name (e.g. infra)";
      name.value = entry.name;
      name.addEventListener("change", () => {
        entry.name = name.value.trim();
        void persist();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "settings-toggle";
      remove.textContent = "Remove";
      attachTooltip(remove, "Remove this server. Operators that allowlisted it simply lose its tools.");
      remove.addEventListener("click", () => {
        entries = entries.filter((e) => e !== entry);
        render();
        void persist();
      });
      head.append(name, remove);
      card.appendChild(head);

      const fields = document.createElement("div");
      fields.className = "acp-agent-fields";

      const url = document.createElement("input");
      url.type = "text";
      url.className = "acp-model-input";
      url.placeholder = "http://127.0.0.1:9400/mcp";
      url.value = entry.url;
      url.addEventListener("change", () => {
        entry.url = url.value.trim();
        void persist();
      });
      fields.appendChild(url);

      const headers = document.createElement("textarea");
      headers.className = "acp-env-input";
      headers.rows = 2;
      headers.placeholder = "headers — Header-Name: value per line (e.g. Authorization: Bearer …)";
      headers.value = formatHeaderLines(entry.headers);
      headers.addEventListener("change", () => {
        entry.headers = parseHeaderLines(headers.value);
        void persist();
      });
      fields.appendChild(headers);

      card.appendChild(fields);
      cardsHost.appendChild(card);
    }

    const add = document.createElement("button");
    add.type = "button";
    add.className = "settings-toggle";
    add.textContent = "Add MCP server";
    add.addEventListener("click", () => {
      entries.push({ name: "", url: "", headers: [] });
      render();
      // Not persisted until the user fills name+url (backend drops
      // empties anyway) — but focus the fresh name input.
      cardsHost.querySelector<HTMLInputElement>(".acp-agent-card:last-of-type input")?.focus();
    });
    cardsHost.appendChild(add);
  };

  render();
}
