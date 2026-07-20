// Mini activity feed — ephemeral cards that pop in for each
// Operator decision. Lives at the bottom-right of the workspace so
// it doesn't fight the AOM banner (bottom-center) or cross-session
// toasts (top-right).
//
// The point is to make AOM feel ALIVE: when the Operator does
// something, you see it happen instead of waiting for ⌘O. Each
// decision flashes a 4s card with action + rationale. Cards stack
// upward (newest at bottom) and auto-clear after the dismiss timer.
// Hover pauses the timer for that card so a long rationale stays
// readable.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { Icons } from "../icons";

// TODO(task-17): once `operator-decision` events carry `operator_id`
// (the AFK overlay already opts-in via the typed field), prepend
// `renderOperatorChip(operator, 'sm')` to each card. Today the
// activity-feed event shape doesn't include the operator entity, so
// we can't render the chip without fabricating types.
interface DecisionEvent {
  id: number | null;
  session_id: string;
  action: "reply" | "escalate" | "wait" | string;
  reply_text: string | null;
  rationale: string | null;
  escalation: string | null;
  executed: boolean;
  cost_usd: number;
  timestamp_unix_ms: number;
}

interface StartupActionEvent {
  session_id: string;
  /// Human-readable label of the action ("claude /rename",
  /// "exit bypass mode", etc.).
  action: string;
}

const AUTO_DISMISS_MS = 4_000;
/// Cap visible cards so a runaway operator doesn't fill the screen.
/// Older cards stay until their timer expires; new arrivals just
/// stack on top until cap is hit, then we drop the oldest visible.
const MAX_VISIBLE = 6;

/// Suppress consecutive WAIT cards with the same rationale within
/// this window. The backend can legitimately emit a WAIT every ~90s
/// while the executor is genuinely running, but the rationale is
/// almost always the same wording — surfacing it twice in a row
/// adds noise without information. Reply / Escalate are NEVER
/// suppressed: those represent state changes the user must see.
const WAIT_DEDUP_MS = 30_000;

export class AomActivityFeed {
  private container: HTMLElement;
  private unlistenDecision?: UnlistenFn;
  private unlistenStartup?: UnlistenFn;
  /// Per-session record of the last WAIT we surfaced. Used to drop
  /// repeat WAITs with identical rationale inside `WAIT_DEDUP_MS`.
  private lastWait = new Map<string, { rationaleKey: string; t: number }>();

  /// When true, suppress toast cards entirely. Set by the teammate
  /// panel's Activity tab so decisions flow into the sidebar instead
  /// of floating over the workspace.
  static suppress = false;

  constructor(private readonly mountHost: HTMLElement) {
    this.container = document.createElement("div");
    this.container.className = "aom-feed";
    this.mountHost.appendChild(this.container);
  }

  async start(): Promise<void> {
    this.unlistenDecision = await listen<DecisionEvent>(
      "operator-decision",
      (event) => this.pushDecision(event.payload),
    );
    this.unlistenStartup = await listen<StartupActionEvent>(
      "operator-startup-action",
      (event) => this.pushStartup(event.payload),
    );
  }

  stop(): void {
    if (this.unlistenDecision) {
      this.unlistenDecision();
      this.unlistenDecision = undefined;
    }
    if (this.unlistenStartup) {
      this.unlistenStartup();
      this.unlistenStartup = undefined;
    }
  }

  private pushDecision(d: DecisionEvent): void {
    // Dedup: suppress consecutive WAITs with identical rationale on
    // the same session within WAIT_DEDUP_MS. This is the visible
    // symptom of a stuck-spinner loop — the backend's idle-WAIT
    // detector still escalates after enough repeats; we just don't
    // need to show the same card twice in a row in the meantime.
    if (d.action === "wait") {
      const key = normalizeRationale(d.rationale);
      const prev = this.lastWait.get(d.session_id);
      const now = d.timestamp_unix_ms || Date.now();
      if (prev && prev.rationaleKey === key && now - prev.t < WAIT_DEDUP_MS) {
        prev.t = now; // refresh window so a stuck WAIT stays muted
        return;
      }
      this.lastWait.set(d.session_id, { rationaleKey: key, t: now });
    } else {
      // Any non-WAIT decision is real progress — clear the dedup
      // record so the NEXT WAIT (after activity) shows again.
      this.lastWait.delete(d.session_id);
    }

    // Action → visual + label.
    let cls: string;
    let icon: string;
    let title: string;
    let body: string;
    switch (d.action) {
      case "reply":
        cls = d.executed ? "ok" : "muted";
        icon = Icons.bot({ size: 13 });
        title = d.executed ? "typed" : "would-type (dry-run)";
        body = formatReply(d.reply_text, d.rationale);
        break;
      case "escalate":
        cls = "warn";
        icon = Icons.lightbulb({ size: 13 });
        title = "escalated";
        body = d.escalation ?? d.rationale ?? "(no detail)";
        break;
      case "wait":
        cls = "muted";
        icon = Icons.terminal({ size: 13 });
        title = "wait";
        body = d.rationale ?? "(no detail)";
        break;
      // Failed model call, not a verdict — never styled "warn" like an
      // escalation, since nothing is actually waiting on the user.
      case "error":
        cls = "muted";
        icon = Icons.terminal({ size: 13 });
        title = "api error";
        body = d.escalation ?? d.rationale ?? "(no detail)";
        break;
      default:
        cls = "muted";
        icon = Icons.bot({ size: 13 });
        title = d.action;
        body = d.rationale ?? "";
    }
    const tabSlug = shortSession(d.session_id);
    const cost = d.cost_usd > 0 ? `$${d.cost_usd.toFixed(3)}` : "";
    this.pushCard({ cls, icon, title, body, tabSlug, cost });
  }

  private pushStartup(e: StartupActionEvent): void {
    this.pushCard({
      cls: "startup",
      icon: Icons.bot({ size: 13 }),
      title: "startup",
      body: e.action,
      tabSlug: shortSession(e.session_id),
      cost: "",
    });
  }

  private pushCard(opts: {
    cls: string;
    icon: string;
    title: string;
    body: string;
    tabSlug: string;
    cost: string;
  }): void {
    // Floating operator toasts are disabled. Anonymous `…WE6JN9 ESCALATED`
    // cards floating over the workspace were noise — they couldn't be traced
    // to a tab/group and weren't actionable. Operator decisions now surface
    // only in pull-based UI: Mission Control (Convergence roster) and the
    // teammate panel Activity tab, which consume the same events directly.
    // We keep `start()`'s listeners and the `lastWait` dedup bookkeeping in
    // pushDecision() intact so nothing else regresses; this sink just drops
    // the card. See docs/superpowers/specs/2026-06-07-mission-control-stop-
    // and-kill-toasts-design.md.
    return;

    // eslint-disable-next-line no-unreachable
    const card = document.createElement("div");
    card.className = `aom-feed-card aom-feed-${opts.cls}`;
    card.innerHTML = `
      <span class="aom-feed-icon">${opts.icon}</span>
      <span class="aom-feed-meta">
        <span class="aom-feed-tab">…${escapeHtml(opts.tabSlug)}</span>
        <span class="aom-feed-title">${escapeHtml(opts.title)}</span>
        ${opts.cost ? `<span class="aom-feed-cost">${escapeHtml(opts.cost)}</span>` : ""}
      </span>
      <span class="aom-feed-body"></span>
    `;
    card.querySelector<HTMLElement>(".aom-feed-body")!.textContent = opts.body;

    let timer: number | undefined;
    const dismiss = (): void => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      card.classList.add("aom-feed-leaving");
      window.setTimeout(() => card.remove(), 200);
    };
    const arm = (): void => {
      timer = window.setTimeout(dismiss, AUTO_DISMISS_MS);
    };
    card.addEventListener("mouseenter", () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
    });
    card.addEventListener("mouseleave", arm);
    card.addEventListener("click", dismiss);

    this.container.appendChild(card);

    // If we're over the cap, drop the OLDEST visible (top of stack)
    // immediately so the new card has room without piling up.
    const cards = this.container.querySelectorAll(".aom-feed-card");
    if (cards.length > MAX_VISIBLE) {
      cards[0].remove();
    }
    arm();
  }
}

function normalizeRationale(s: string | null): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function shortSession(id: string): string {
  return id.length > 6 ? id.slice(-6) : id;
}

function formatReply(text: string | null, rationale: string | null): string {
  const safeText = (text ?? "").replace(/\n/g, "\\n").trim();
  // Show the typed bytes inline; rationale on a second line. Truncate
  // long replies so a multi-paragraph answer doesn't dominate the card.
  const head = safeText.length > 40
    ? `"${safeText.slice(0, 40)}…"`
    : `"${safeText}"`;
  return rationale ? `${head} — ${rationale}` : head;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
