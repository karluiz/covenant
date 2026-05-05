const SPEC_RE = /(^|\/)docs\/specs\/(.+)$/;

export function isSpecPath(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  const m = SPEC_RE.exec(path);
  if (!m) return false;
  const rest = m[2]; // e.g. "drafts/foo.md", "_template.md", "3.17-foo.md"
  if (rest.startsWith("drafts/")) return false;
  if (rest.includes("/drafts/")) return false;
  const fileName = rest.split("/").pop() ?? "";
  if (fileName === "_template.md") return false;
  return true;
}

export interface SpecLinkMenuHost {
  getActiveTabId(): string | null;
  listTabsForRepo(repoRoot: string | null): { id: string; label: string; cwd: string; hasMission: boolean }[];
  setMissionForTab(tabId: string, path: string): Promise<void>;
  openSpec(path: string): Promise<void>;
  revealInFinder(path: string): Promise<void>;
}

export function installSpecLinkInterceptor(host: SpecLinkMenuHost): () => void {
  const handler = (e: MouseEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const link = target.closest<HTMLElement>("[data-spec-path], [data-path], a[href^='file://']");
    if (!link) return;
    const path =
      link.dataset.specPath ??
      link.dataset.path ??
      decodeURIComponent((link.getAttribute("href") ?? "").replace(/^file:\/\//, ""));
    if (!path || !isSpecPath(path)) return;
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, path, host);
  };
  document.addEventListener("click", handler, true);
  return () => document.removeEventListener("click", handler, true);
}

function showMenu(x: number, y: number, path: string, host: SpecLinkMenuHost) {
  document.querySelector(".spec-link-menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "spec-link-menu";
  menu.innerHTML = `
    <button type="button" data-act="open">Abrir spec</button>
    <button type="button" data-act="assign-active">Asignar a esta sesión</button>
    <button type="button" data-act="assign-other">Asignar a otra sesión…</button>
    <button type="button" data-act="reveal">Revelar en Finder</button>
  `;
  menu.style.position = "fixed";
  menu.style.top = `${y}px`;
  menu.style.left = `${x}px`;
  document.body.appendChild(menu);

  const close = () => {
    menu.remove();
    document.removeEventListener("click", outside, true);
  };
  const outside = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) close();
  };
  setTimeout(() => document.addEventListener("click", outside, true), 0);

  menu.addEventListener("click", async (ev) => {
    const btn = (ev.target as HTMLElement).closest("button");
    if (!btn) return;
    const act = btn.dataset.act;
    close();
    try {
      if (act === "open") await host.openSpec(path);
      else if (act === "reveal") await host.revealInFinder(path);
      else if (act === "assign-active") {
        const id = host.getActiveTabId();
        if (id) await host.setMissionForTab(id, path);
      } else if (act === "assign-other") {
        const repoRoot = inferRepoRoot(path);
        const tabs = host.listTabsForRepo(repoRoot);
        const picked = await pickTab(tabs);
        if (picked) await host.setMissionForTab(picked, path);
      }
    } catch (e) {
      console.error("spec-link action failed", act, e);
    }
  });
}

function inferRepoRoot(path: string): string | null {
  const m = /^(.*)\/docs\/specs\//.exec(path);
  return m ? m[1] : null;
}

async function pickTab(
  tabs: { id: string; label: string; cwd: string; hasMission: boolean }[],
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "spec-link-modal-overlay";
    overlay.innerHTML = `
      <div class="spec-link-modal">
        <div class="spec-link-modal-title">Asignar a otra sesión</div>
        <div class="spec-link-modal-body">
          ${tabs.length === 0
            ? `<div class="spec-link-modal-empty">No hay otras sesiones elegibles.</div>`
            : tabs.map((t) => `
              <button type="button" class="spec-link-modal-tab" data-id="${escapeAttr(t.id)}">
                <div class="spec-link-modal-tab-label">${escapeHtml(t.label)}${t.hasMission ? " (tiene misión)" : ""}</div>
                <div class="spec-link-modal-tab-cwd">${escapeHtml(t.cwd)}</div>
              </button>`).join("")}
        </div>
        <div class="spec-link-modal-actions">
          <button type="button" class="spec-link-modal-cancel">Cancelar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const cleanup = (val: string | null) => { overlay.remove(); resolve(val); };
    overlay.querySelector(".spec-link-modal-cancel")!.addEventListener("click", () => cleanup(null));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(null); });
    overlay.querySelectorAll<HTMLElement>(".spec-link-modal-tab").forEach((b) => {
      b.addEventListener("click", () => cleanup(b.dataset.id ?? null));
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string { return escapeHtml(s); }
