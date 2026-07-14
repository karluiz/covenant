import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReviewActivity, ReviewComment, ReviewVerdict } from "./api";

// ReviewPanel.poll() calls reviewApi.activity(), which normally hits
// @tauri-apps/api/core#invoke — stub it so the verdict-toast tests below
// can drive the poll loop without a real Tauri runtime.
const activityMock = vi.fn<(path: string) => Promise<ReviewActivity>>();
vi.mock("./api", () => ({
  reviewApi: {
    activity: (path: string) => activityMock(path),
    resolveComment: vi.fn(),
    getShare: vi.fn(),
    publish: vi.fn(),
    republish: vi.fn(),
    revoke: vi.fn(),
  },
}));

const toastMock = vi.fn();
vi.mock("../notifications/toast", () => ({
  pushInfoToast: (t: { message: string }) => toastMock(t),
}));

import { groupByHeading, ReviewPanel } from "./panel";

function comment(id: number, anchorHeading: string | null): ReviewComment {
  return {
    id,
    version: 1,
    anchorHeading,
    parentId: null,
    authorName: "reviewer",
    body: "body",
    resolved: false,
    createdAt: new Date(2026, 0, id).toISOString(),
  };
}

describe("groupByHeading", () => {
  it("puts the unanchored bucket first, then follows heading order", () => {
    const roots = [comment(1, "Goal"), comment(2, null), comment(3, "Title")];
    const groups = groupByHeading(roots, ["Title", "Goal"]);
    expect(groups.map((g) => g.heading)).toEqual([null, "Title", "Goal"]);
    expect(groups[0].items).toEqual([roots[1]]);
    expect(groups[1].items).toEqual([roots[2]]);
    expect(groups[2].items).toEqual([roots[0]]);
  });

  it("skips headings with no comments", () => {
    const roots = [comment(1, "Goal")];
    const groups = groupByHeading(roots, ["Title", "Goal", "Non-Goals"]);
    expect(groups.map((g) => g.heading)).toEqual(["Goal"]);
  });

  it("appends headings no longer present in the doc at the end", () => {
    const roots = [comment(1, "Renamed Section"), comment(2, "Goal")];
    const groups = groupByHeading(roots, ["Goal"]);
    expect(groups.map((g) => g.heading)).toEqual(["Goal", "Renamed Section"]);
  });

  it("returns no groups for an empty comment list", () => {
    expect(groupByHeading([], ["Title"])).toEqual([]);
  });
});

describe("ReviewPanel verdict toast", () => {
  function verdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
    return {
      version: 1,
      authorName: "reviewer",
      verdict: "approved",
      note: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  const activity = (verdicts: ReviewVerdict[] = []): ReviewActivity => ({
    latestVersion: 1,
    comments: [],
    verdicts,
  });

  async function poll(panel: ReviewPanel): Promise<void> {
    await (panel as unknown as { poll: () => Promise<void> }).poll();
  }

  beforeEach(() => {
    activityMock.mockReset();
    toastMock.mockReset();
  });

  it("does not toast on the first poll, only records the baseline", async () => {
    activityMock.mockResolvedValueOnce(activity([verdict()]));
    const panel = new ReviewPanel("/spec.md", () => "");
    await poll(panel);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("toasts approved verdict text for a fresh verdict after the first poll", async () => {
    const panel = new ReviewPanel("/spec.md", () => "");
    activityMock.mockResolvedValueOnce(activity([]));
    await poll(panel);
    activityMock.mockResolvedValueOnce(activity([verdict({ verdict: "approved" })]));
    await poll(panel);
    expect(toastMock).toHaveBeenCalledWith({ message: "Review verdict: approved" });
  });

  it("toasts changes-requested verdict text for a non-approved verdict", async () => {
    const panel = new ReviewPanel("/spec.md", () => "");
    activityMock.mockResolvedValueOnce(activity([]));
    await poll(panel);
    activityMock.mockResolvedValueOnce(activity([verdict({ verdict: "changes_requested" })]));
    await poll(panel);
    expect(toastMock).toHaveBeenCalledWith({ message: "Review verdict: changes requested" });
  });

  it("does not re-toast a verdict already seen on a later poll", async () => {
    const panel = new ReviewPanel("/spec.md", () => "");
    const v = verdict();
    activityMock.mockResolvedValueOnce(activity([]));
    await poll(panel);
    activityMock.mockResolvedValueOnce(activity([v]));
    await poll(panel);
    toastMock.mockClear();
    activityMock.mockResolvedValueOnce(activity([v]));
    await poll(panel);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("toasts the newest fresh verdict when several arrive in one poll", async () => {
    const panel = new ReviewPanel("/spec.md", () => "");
    activityMock.mockResolvedValueOnce(activity([]));
    await poll(panel);
    activityMock.mockResolvedValueOnce(
      activity([
        verdict({ verdict: "changes_requested", createdAt: "2026-01-01T00:00:00.000Z" }),
        verdict({
          verdict: "approved",
          authorName: "other",
          createdAt: "2026-01-02T00:00:00.000Z",
        }),
      ]),
    );
    await poll(panel);
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith({ message: "Review verdict: approved" });
  });

  it("still surfaces both a comment toast and a verdict toast in the same poll", async () => {
    const panel = new ReviewPanel("/spec.md", () => "");
    activityMock.mockResolvedValueOnce(activity([]));
    await poll(panel);
    activityMock.mockResolvedValueOnce({
      latestVersion: 1,
      comments: [comment(1, null)],
      verdicts: [verdict()],
    });
    await poll(panel);
    expect(toastMock).toHaveBeenCalledTimes(2);
    expect(toastMock).toHaveBeenCalledWith({ message: "1 new review comment" });
    expect(toastMock).toHaveBeenCalledWith({ message: "Review verdict: approved" });
  });
});
