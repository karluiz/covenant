import { reviewApi, type ReviewActivity, type ReviewComment, type ReviewVerdict } from "./api";
import { parseHeadings } from "./anchors";
import { pushInfoToast } from "../notifications/toast";
import { attachTooltip } from "../tooltip/tooltip";
import { Icons } from "../icons";

export interface HeadingGroup {
  heading: string | null;
  items: ReviewComment[];
}

/// Right-rail panel mounted beside the mission viewer's spec body once a
/// spec has been shared for review. Polls `review_activity` every 15s,
/// toasts on newly-seen comments and newly-seen verdicts (after the
/// first poll, which only records a silent baseline), and lets the
/// reader resolve threads inline.
export class ReviewPanel {
  readonly el = document.createElement("aside");
  private pollTimer: number | null = null;
  private seenIds = new Set<number>();
  private seenVerdictKeys = new Set<string>();
  private firstPoll = true;
  private resolvedFoldOpen = false;
  private tooltipDisposers: Array<() => void> = [];

  constructor(private path: string, private markdown: () => string) {
    this.el.className = "review-panel";
  }

  start(): void {
    void this.poll();
    this.pollTimer = window.setInterval(() => void this.poll(), 15_000);
  }

  stop(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.disposeTooltips();
  }

  private async poll(): Promise<void> {
    let act: ReviewActivity;
    try {
      act = await reviewApi.activity(this.path);
    } catch {
      return;
    }
    const fresh = act.comments.filter((c) => !this.seenIds.has(c.id));
    for (const c of act.comments) this.seenIds.add(c.id);

    const freshVerdicts = act.verdicts.filter((v) => !this.seenVerdictKeys.has(verdictKey(v)));
    for (const v of act.verdicts) this.seenVerdictKeys.add(verdictKey(v));

    if (!this.firstPoll && fresh.length > 0) {
      pushInfoToast({
        message: `${fresh.length} new review comment${fresh.length > 1 ? "s" : ""}`,
      });
    }
    const freshLatestVerdict = latestVerdict(freshVerdicts);
    if (!this.firstPoll && freshLatestVerdict) {
      pushInfoToast({
        message:
          freshLatestVerdict.verdict === "approved"
            ? "Review verdict: approved"
            : "Review verdict: changes requested",
      });
    }
    this.firstPoll = false;
    this.render(act);
  }

  private disposeTooltips(): void {
    for (const dispose of this.tooltipDisposers) dispose();
    this.tooltipDisposers = [];
  }

  private render(act: ReviewActivity): void {
    this.disposeTooltips();
    this.el.innerHTML = "";
    this.el.appendChild(this.renderVerdictStrip(act.verdicts));

    const roots = act.comments.filter((c) => c.parentId === null);
    const repliesByParent = new Map<number, ReviewComment[]>();
    for (const c of act.comments) {
      if (c.parentId === null) continue;
      const list = repliesByParent.get(c.parentId) ?? [];
      list.push(c);
      repliesByParent.set(c.parentId, list);
    }
    for (const list of repliesByParent.values()) list.sort(byCreatedAtAsc);

    const unresolvedRoots = roots.filter((c) => !c.resolved).sort(byCreatedAtAsc);
    const resolvedRoots = roots.filter((c) => c.resolved).sort(byCreatedAtAsc);

    if (unresolvedRoots.length === 0 && resolvedRoots.length === 0) {
      this.el.appendChild(this.renderEmpty());
    } else if (unresolvedRoots.length > 0) {
      const headingOrder = parseHeadings(this.markdown());
      const groups = groupByHeading(unresolvedRoots, headingOrder);
      const threadsEl = document.createElement("div");
      threadsEl.className = "review-threads";
      for (const group of groups) {
        threadsEl.appendChild(this.renderHeadingGroup(group, repliesByParent));
      }
      this.el.appendChild(threadsEl);
    }

    if (resolvedRoots.length > 0) {
      this.el.appendChild(this.renderResolvedFold(resolvedRoots, repliesByParent));
    }
  }

  private renderVerdictStrip(verdicts: ReviewVerdict[]): HTMLElement {
    const strip = document.createElement("div");
    strip.className = "review-verdict";

    const label = document.createElement("div");
    label.className = "review-verdict-label";
    label.textContent = "Verdict";
    strip.appendChild(label);

    const latest = latestVerdict(verdicts);
    const body = document.createElement("div");
    body.className = "review-verdict-body";
    if (!latest) {
      strip.classList.add("review-verdict--none");
      body.textContent = "No verdict yet";
    } else if (latest.verdict === "approved") {
      strip.classList.add("review-verdict--approved");
      body.textContent = `Approved by ${latest.authorName}${latest.note ? ` — ${latest.note}` : ""}`;
    } else {
      strip.classList.add("review-verdict--changes");
      body.textContent = `Changes requested by ${latest.authorName}${latest.note ? ` — ${latest.note}` : ""}`;
    }
    strip.appendChild(body);

    if (latest) {
      const meta = document.createElement("div");
      meta.className = "review-verdict-meta";
      meta.textContent = relTime(latest.createdAt);
      strip.appendChild(meta);
    }
    return strip;
  }

  private renderHeadingGroup(
    group: HeadingGroup,
    repliesByParent: Map<number, ReviewComment[]>,
  ): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "review-group";
    const label = document.createElement("div");
    label.className = "review-group-label";
    label.textContent = group.heading ?? "General";
    wrap.appendChild(label);
    for (const root of group.items) {
      wrap.appendChild(this.renderThread(root, repliesByParent.get(root.id) ?? [], true));
    }
    return wrap;
  }

  private renderResolvedFold(
    resolvedRoots: ReviewComment[],
    repliesByParent: Map<number, ReviewComment[]>,
  ): HTMLElement {
    const details = document.createElement("details");
    details.className = "review-resolved-fold";
    details.open = this.resolvedFoldOpen;
    details.addEventListener("toggle", () => {
      this.resolvedFoldOpen = details.open;
    });
    const summary = document.createElement("summary");
    summary.textContent = `Resolved (${resolvedRoots.length})`;
    details.appendChild(summary);
    const list = document.createElement("div");
    list.className = "review-resolved-list";
    for (const root of resolvedRoots) {
      list.appendChild(this.renderThread(root, repliesByParent.get(root.id) ?? [], false));
    }
    details.appendChild(list);
    return details;
  }

  private renderThread(
    root: ReviewComment,
    replies: ReviewComment[],
    showResolve: boolean,
  ): HTMLElement {
    const thread = document.createElement("div");
    thread.className = "review-thread";
    thread.appendChild(this.renderRow(root, false, showResolve));
    for (const reply of replies) thread.appendChild(this.renderRow(reply, true, false));
    return thread;
  }

  private renderRow(c: ReviewComment, isReply: boolean, showResolve: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = `rail-row review-row${isReply ? " review-row--reply" : ""}`;
    row.innerHTML = `
      <div class="rail-row-line">
        <span class="rail-name review-row-author"></span>
        <span class="review-row-time"></span>
      </div>
      <div class="review-row-body"></div>
      ${
        showResolve
          ? `<div class="rail-row-actions">
              <button type="button" class="rail-row-action is-neutral review-resolve" aria-label="Mark resolved">${Icons.check(
                { size: 13 },
              )}</button>
            </div>`
          : ""
      }
    `;
    row.querySelector<HTMLElement>(".review-row-author")!.textContent = c.authorName;
    row.querySelector<HTMLElement>(".review-row-time")!.textContent = relTime(c.createdAt);
    row.querySelector<HTMLElement>(".review-row-body")!.textContent = c.body;

    if (showResolve) {
      const btn = row.querySelector<HTMLButtonElement>(".review-resolve")!;
      this.tooltipDisposers.push(attachTooltip(btn, "Mark resolved"));
      btn.addEventListener("click", () => void this.resolve(c.id));
    }
    return row;
  }

  private renderEmpty(): HTMLElement {
    const empty = document.createElement("div");
    empty.className = "rail-empty";
    empty.innerHTML = `
      <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <div class="rail-empty-title">No comments yet</div>
      <div class="rail-empty-hint">Reviewer comments arrive here within 15s</div>
    `;
    return empty;
  }

  private async resolve(commentId: number): Promise<void> {
    try {
      await reviewApi.resolveComment(this.path, commentId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("review_resolve_comment failed", err);
    }
    void this.poll();
  }
}

function byCreatedAtAsc(a: ReviewComment, b: ReviewComment): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/// Verdicts have no stable id from the backend — key them by the tuple
/// that uniquely identifies one, mirroring how `seenIds` tracks comments.
function verdictKey(v: ReviewVerdict): string {
  return `${v.version}:${v.authorName}:${v.createdAt}`;
}

function latestVerdict(verdicts: ReviewVerdict[]): ReviewVerdict | null {
  if (verdicts.length === 0) return null;
  return verdicts.reduce((latest, v) =>
    Date.parse(v.createdAt) > Date.parse(latest.createdAt) ? v : latest,
  );
}

/// Buckets unresolved root comments by `anchorHeading`, ordered "General"
/// (unanchored) first, then in document heading order. Headings that no
/// longer exist in the current doc (renamed/removed since the comment was
/// left) are appended at the end rather than dropped.
export function groupByHeading(roots: ReviewComment[], headingOrder: string[]): HeadingGroup[] {
  const byHeading = new Map<string | null, ReviewComment[]>();
  for (const c of roots) {
    const list = byHeading.get(c.anchorHeading) ?? [];
    list.push(c);
    byHeading.set(c.anchorHeading, list);
  }

  const groups: HeadingGroup[] = [];
  const general = byHeading.get(null);
  if (general) groups.push({ heading: null, items: general });
  byHeading.delete(null);

  for (const heading of headingOrder) {
    const items = byHeading.get(heading);
    if (items) {
      groups.push({ heading, items });
      byHeading.delete(heading);
    }
  }

  for (const [heading, items] of byHeading) {
    groups.push({ heading, items });
  }
  return groups;
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
