// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderAttentionCard, type AttentionCallbacks } from "./attention";
import type { AttentionItem } from "../api";

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  session_id: "s1", tab_title: "deploy", tab_color: null, lane: "pty",
  executor: "claude", kind: "operator-escalation", question: "OK to push?",
  excerpt: null, permission: null, operator_name: "Zeta",
  operator_avatar: null, mission_name: null, since_unix_ms: 100, ...over,
});

const cbs = (): AttentionCallbacks => ({
  onFocus: vi.fn(),
  onOperatorReply: vi.fn(async () => {}),
  onPermission: vi.fn(),
  onPtyReply: vi.fn(),
});

describe("renderAttentionCard", () => {
  it("acp-permission renders option buttons and answers with option_id", () => {
    const c = cbs();
    const el = renderAttentionCard(item({
      kind: "acp-permission", lane: "acp", question: "npm test",
      permission: {
        request_key: "k1", title: "npm test", since_unix_ms: 1,
        options: [
          { option_id: "allow_once", kind: "allow_once", name: "Allow once" },
          { option_id: "rej", kind: "reject_once", name: null },
        ],
      },
    }), c);
    const btns = [...el.querySelectorAll<HTMLButtonElement>(".mc-perm-opts button")];
    expect(btns.map((b) => b.textContent)).toEqual(["Allow once", "reject once"]);
    btns[0].click();
    expect(c.onPermission).toHaveBeenCalledWith("s1", "k1", "allow_once");
    expect(el.querySelector(".mc-reply")).toBeNull(); // options answer it, no prose
  });

  it("pty-waiting renders excerpt and submits a PTY reply", () => {
    const c = cbs();
    const el = renderAttentionCard(item({
      kind: "pty-waiting", question: "waiting: input",
      excerpt: "Overwrite migrations/v2.sql? [y/N]",
    }), c);
    expect(el.querySelector(".mc-card__tail")?.textContent).toContain("Overwrite");
    const ta = el.querySelector<HTMLTextAreaElement>(".mc-reply__textarea")!;
    ta.value = " y ";
    el.querySelector<HTMLButtonElement>(".mc-reply__send")!.click();
    expect(c.onPtyReply).toHaveBeenCalledWith("s1", "y");
    expect(ta.value).toBe("");
  });

  it("operator-escalation renders question, excerpt and scoped composer", async () => {
    const c = cbs();
    const el = renderAttentionCard(item({ excerpt: "the tail" }), c);
    expect(el.querySelector(".mc-card__question")?.textContent).toBe("OK to push?");
    expect(el.querySelector(".mc-card__tail")?.textContent).toBe("the tail");
    const ta = el.querySelector<HTMLTextAreaElement>(".mc-reply__textarea")!;
    ta.value = "go";
    el.querySelector<HTMLButtonElement>(".mc-reply__send")!.click();
    await Promise.resolve();
    expect(c.onOperatorReply).toHaveBeenCalledWith("s1", "go", "one-shot");
  });

  it("every kind gets a jump-to-tab affordance", () => {
    const c = cbs();
    const el = renderAttentionCard(item({}), c);
    el.querySelector<HTMLButtonElement>(".mc-card__tab")!.click();
    expect(c.onFocus).toHaveBeenCalledWith("s1", false);
  });
});
