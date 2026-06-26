import { openUrl } from "@tauri-apps/plugin-opener";
import { beaconDeployments, type BeaconState } from "../api";

const POLL_MS = 25_000;

/// Returns true only for absolute http: or https: URLs.
export function isHttpUrl(u: string | null | undefined): u is string {
  if (!u) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/// Map a GitHub deployment state to a dot color class suffix.
export function stateDotColor(state: string): string {
  switch (state) {
    case "success":
      return "ok";
    case "in_progress":
    case "pending":
      return "busy";
    case "failure":
    case "error":
      return "bad";
    default:
      return "idle"; // inactive + unknown
  }
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function notice(text: string, cls = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = `beacon-notice ${cls}`.trim();
  el.textContent = text;
  return el;
}

/// Pure render of a state into `root`. No fetching, no polling.
export function renderBeacon(root: HTMLElement, state: BeaconState): void {
  root.replaceChildren();
  switch (state.kind) {
    case "not_authed":
      root.appendChild(notice("Sign in with GitHub to see deployments."));
      return;
    case "no_repo":
      root.appendChild(notice("No GitHub remote in this folder."));
      return;
    case "error":
      root.appendChild(notice(state.message, "beacon-error"));
      return;
    case "ok": {
      if (state.envs.length === 0) {
        root.appendChild(notice(`No deployments in ${state.repo}.`));
        return;
      }
      for (const env of state.envs) {
        const clickable = isHttpUrl(env.target_url);
        const card = document.createElement("div");
        card.className = clickable ? "beacon-env beacon-env-link" : "beacon-env";
        if (clickable) {
          card.setAttribute("role", "link");
          card.setAttribute("tabindex", "0");
          card.addEventListener("click", () => {
            void openUrl(env.target_url!).catch((e) =>
              console.error("beacon openUrl failed", e),
            );
          });
          card.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              void openUrl(env.target_url!).catch((err) =>
                console.error("beacon openUrl failed", err),
              );
            }
          });
        }

        const head = document.createElement("div");
        head.className = "beacon-env-head";
        const dot = document.createElement("span");
        dot.className = `beacon-dot ${stateDotColor(env.state)}`;
        const name = document.createElement("span");
        name.className = "beacon-env-name";
        name.textContent = env.environment || "(default)";
        const when = document.createElement("span");
        when.className = "beacon-env-when";
        when.textContent = relTime(env.updated_at);
        head.append(dot, name, when);

        const meta = document.createElement("div");
        meta.className = "beacon-env-meta";
        const bits = [env.state, env.sha, env.creator].filter(Boolean) as string[];
        meta.textContent = bits.join(" · ");

        card.append(head, meta);
        if (env.description) {
          const desc = document.createElement("div");
          desc.className = "beacon-env-desc";
          desc.textContent = env.description;
          card.appendChild(desc);
        }
        root.appendChild(card);
      }
      return;
    }
  }
}

export class BeaconPanel {
  private root: HTMLElement;
  private timer: number | null = null;
  private generation = 0;
  private body: HTMLElement;

  constructor(
    host: HTMLElement,
    private opts: { getCwd: () => string | null; onClose: () => void },
  ) {
    this.root = document.createElement("div");
    this.root.className = "beacon-root";

    const header = document.createElement("div");
    header.className = "beacon-header";
    const title = document.createElement("span");
    title.className = "beacon-title";
    title.textContent = "Beacon";
    const refresh = document.createElement("button");
    refresh.className = "beacon-refresh";
    refresh.textContent = "↻";
    refresh.addEventListener("click", () => this.render());
    const close = document.createElement("button");
    close.className = "beacon-close";
    close.textContent = "✕";
    close.addEventListener("click", () => this.opts.onClose());
    header.append(title, refresh, close);

    this.body = document.createElement("div");
    this.body.className = "beacon-body";

    this.root.append(header, this.body);
    host.replaceChildren(this.root);
  }

  /// Fetch once and (re)start the visible-only poll loop.
  render(): void {
    void this.fetch();
    this.stopTimer();
    this.timer = window.setInterval(() => void this.fetch(), POLL_MS);
  }

  private async fetch(): Promise<void> {
    const gen = ++this.generation;
    const cwd = this.opts.getCwd();
    if (!cwd) {
      renderBeacon(this.body, { kind: "no_repo" });
      return;
    }
    try {
      const state = await beaconDeployments(cwd);
      if (gen !== this.generation) return; // superseded
      renderBeacon(this.body, state);
    } catch (e) {
      if (gen !== this.generation) return;
      renderBeacon(this.body, { kind: "error", message: String(e) });
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /// Stop polling. Called when the panel is hidden.
  close(): void {
    this.stopTimer();
    this.generation++; // drop any in-flight fetch
  }
}
