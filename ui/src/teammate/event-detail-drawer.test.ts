// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventDetailDrawer, type EventDetail, type EventOrigin } from "./event-detail-drawer";

const esc: EventDetail = {
  ts: 1_717_000_000_000,
  kindLabel: "escalated",
  kindClass: "escalated",
  cost: 0.012,
  action: "escalate",
  escalation: "Your executor isn't accepting input — it may need Enter pressed.",
  rationale: "loop guard (repeat-reply)",
  inFlightCommand: "claude --dangerously-skip-permissions",
  outputExcerpt: "! [rejected] main -> main",
  operatorName: "Zeta",
  operatorId: "op-zeta-123",
};

const liveOrigin: EventOrigin = { label: "pi updates", open: true, sessionShort: "WE6JN9" };
const deadOrigin: EventOrigin = { label: "claude", open: false, sessionShort: "WE6JN9" };

describe("EventDetailDrawer", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("renders the full escalation, executor context, and operator", () => {
    const drawer = new EventDetailDrawer(document.body, () => true);
    drawer.open(esc, deadOrigin);
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("Your executor isn't accepting input");
    expect(txt).toContain("claude --dangerously-skip-permissions");
    expect(txt).toContain("! [rejected] main");
    expect(txt).toContain("Zeta");
    expect(txt).toContain("op-zeta-123");
    expect(document.querySelector(".tp-evd")).not.toBeNull();
  });

  it("shows a jump button for a live origin and fires the focus callback", () => {
    const focus = vi.fn(() => true);
    const drawer = new EventDetailDrawer(document.body, focus);
    drawer.open(esc, liveOrigin);
    const jump = document.querySelector<HTMLElement>("[data-evd-jump]");
    expect(jump).not.toBeNull();
    jump!.click();
    expect(focus).toHaveBeenCalledWith("WE6JN9");
    expect(drawer.isOpen()).toBe(false); // closes after jump
  });

  it("hides the jump button for a closed origin", () => {
    const drawer = new EventDetailDrawer(document.body, () => false);
    drawer.open(esc, deadOrigin);
    expect(document.querySelector("[data-evd-jump]")).toBeNull();
    expect(document.body.textContent).toContain("closed");
  });

  it("marks a dry-run reply as not sent", () => {
    const drawer = new EventDetailDrawer(document.body, () => true);
    drawer.open(
      { ...esc, action: "reply", kindClass: "dry-run", executed: false, replyText: "yes", escalation: null },
      deadOrigin,
    );
    expect(document.body.textContent).toContain("dry-run (not sent)");
    expect(document.body.textContent).toContain("yes");
  });

  it("closes on Escape and on the close button", () => {
    const drawer = new EventDetailDrawer(document.body, () => true);
    drawer.open(esc, deadOrigin);
    expect(drawer.isOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(drawer.isOpen()).toBe(false);

    drawer.open(esc, deadOrigin);
    document.querySelector<HTMLElement>(".tp-evd-close")!.click();
    expect(drawer.isOpen()).toBe(false);
  });
});
