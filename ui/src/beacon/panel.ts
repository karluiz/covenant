import { openUrl } from "@tauri-apps/plugin-opener";
import { beaconWorkflowRuns, type BeaconState } from "../api";

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

/// Map a GitHub Actions run state to a dot color class suffix.
export function stateDotColor(state: string): string {
  switch (state) {
    case "success":
      return "ok";
    case "in_progress":
    case "queued":
    case "requested":
    case "waiting":
    case "pending":
      return "busy";
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "error":
      return "bad";
    default:
      return "idle"; // cancelled, skipped, neutral, action_required, stale, unknown
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

/// Centered empty state for repos with no Actions workflows.
function emptyState(title: string, hint: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "beacon-empty";
  el.innerHTML =
    `<div class="beacon-empty-glyph" aria-hidden="true">◎</div>` +
    `<div class="beacon-empty-title"></div>` +
    `<div class="beacon-empty-hint"></div>`;
  el.querySelector(".beacon-empty-title")!.textContent = title;
  el.querySelector(".beacon-empty-hint")!.textContent = hint;
  return el;
}

/// Loading placeholder — shown only on the first fetch (empty body) so the
/// 25s poll doesn't blank existing cards on every refresh.
export function renderLoading(root: HTMLElement): void {
  root.replaceChildren(notice("Loading workflows", "beacon-loading"));
}

/// Pure render of a state into `root`. No fetching, no polling.
/// `onPick(path)` is invoked when the user selects a sub-repo (`repos` state).
export function renderBeacon(
  root: HTMLElement,
  state: BeaconState,
  onPick?: (path: string) => void,
): void {
  root.replaceChildren();
  switch (state.kind) {
    case "not_authed":
      root.appendChild(notice("Sign in with GitHub to see workflows."));
      return;
    case "no_repo":
      root.appendChild(notice("No GitHub remote in this folder."));
      return;
    case "repos": {
      root.appendChild(
        notice(
          `No remote here — ${state.dirs.length} sub-repo${state.dirs.length === 1 ? "" : "s"} found. Pick one:`,
        ),
      );
      for (const dir of state.dirs) {
        const card = document.createElement("div");
        card.className = "beacon-env beacon-env-link";
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.textContent = dir.repo;
        const open = () => onPick?.(dir.path);
        card.addEventListener("click", open);
        card.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") open();
        });
        root.appendChild(card);
      }
      return;
    }
    case "error":
      root.appendChild(notice(state.message, "beacon-error"));
      return;
    case "ok": {
      if (state.runs.length === 0) {
        root.appendChild(
          emptyState(
            "No workflows yet",
            `${state.repo} has no GitHub Actions. Add a workflow under .github/workflows to light up Beacon.`,
          ),
        );
        return;
      }
      for (const run of state.runs) {
        const clickable = isHttpUrl(run.url);
        const card = document.createElement("div");
        card.className = clickable ? "beacon-env beacon-env-link" : "beacon-env";
        if (clickable) {
          card.setAttribute("role", "link");
          card.setAttribute("tabindex", "0");
          card.addEventListener("click", () => {
            void openUrl(run.url!).catch((e) =>
              console.error("beacon openUrl failed", e),
            );
          });
          card.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              void openUrl(run.url!).catch((err) =>
                console.error("beacon openUrl failed", err),
              );
            }
          });
        }

        const head = document.createElement("div");
        head.className = "beacon-env-head";
        const dot = document.createElement("span");
        dot.className = `beacon-dot ${stateDotColor(run.state)}`;
        const name = document.createElement("span");
        name.className = "beacon-env-name";
        name.textContent = run.name || "(workflow)";
        const when = document.createElement("span");
        when.className = "beacon-env-when";
        when.textContent = relTime(run.updated_at);
        head.append(dot, name, when);

        const meta = document.createElement("div");
        meta.className = "beacon-env-meta";
        const runLabel = run.run_number ? `#${run.run_number}` : "";
        const bits = [
          run.state.replace(/_/g, " "),
          runLabel,
          run.branch,
          run.sha,
          run.actor,
        ].filter(Boolean) as string[];
        meta.textContent = bits.join(" · ");

        card.append(head, meta);
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
  /// Sub-repo the user drilled into (overrides cwd), and the cwd it was
  /// chosen under — if cwd changes (tab switch / cd), the drill-down resets.
  private selectedPath: string | null = null;
  private baseCwd: string | null = null;

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
    const base = this.opts.getCwd();
    // cwd moved → drop any sub-repo drill-down.
    if (base !== this.baseCwd) {
      this.baseCwd = base;
      this.selectedPath = null;
    }
    const cwd = this.selectedPath ?? base;
    if (!cwd) {
      renderBeacon(this.body, { kind: "no_repo" });
      return;
    }
    if (this.body.childElementCount === 0) renderLoading(this.body);
    try {
      const state = await beaconWorkflowRuns(cwd);
      if (gen !== this.generation) return; // superseded
      renderBeacon(this.body, state, (path) => {
        this.selectedPath = path;
        void this.fetch();
      });
      if (this.selectedPath) this.prependBack();
    } catch (e) {
      if (gen !== this.generation) return;
      renderBeacon(this.body, { kind: "error", message: String(e) });
      if (this.selectedPath) this.prependBack();
    }
  }

  /// "← sub-repos" link shown while drilled into a sub-repo.
  private prependBack(): void {
    const back = document.createElement("button");
    back.className = "beacon-back";
    back.textContent = "← sub-repos";
    back.addEventListener("click", () => {
      this.selectedPath = null;
      void this.fetch();
    });
    this.body.prepend(back);
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
