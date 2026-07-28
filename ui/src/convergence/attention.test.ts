// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderAttentionBody, agoLabel, type AttentionCallbacks } from "./attention";
import type { AttentionItem } from "../api";

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  session_id: "s1", tab_title: "deploy", tab_color: null, lane: "pty",
  executor: "claude", kind: "operator-escalation", question: "Ship it?",
  excerpt: null, permission: null, operator_name: "Zeta",
  operator_avatar: null, mission_name: null, since_unix_ms: 100, ...over,
});

const cbs = (): AttentionCallbacks => ({
  onOperatorReply: vi.fn(async () => {}),
  onPermission: vi.fn(),
  onPtyReply: vi.fn(),
});

const mounted = (frag: DocumentFragment): HTMLElement => {
  const host = document.createElement("div");
  host.append(frag);
  return host;
};

describe("renderAttentionBody", () => {
  it("operator escalation: question + scoped reply composer", () => {
    const el = mounted(renderAttentionBody(item({}), cbs()));
    expect(el.querySelector(".mc-detail__question")?.textContent).toBe("Ship it?");
    expect(el.querySelector(".mc-reply")).not.toBeNull();
    expect(el.querySelector(".mc-reply__scope")).not.toBeNull();
  });

  it("acp permission: title fallback + option buttons answer inline", () => {
    const onPermission = vi.fn();
    const el = mounted(renderAttentionBody(
      item({
        kind: "acp-permission", question: null,
        permission: {
          request_key: "rk", title: "Run cargo test?", since_unix_ms: 1,
          options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
        },
      }),
      { ...cbs(), onPermission },
    ));
    expect(el.querySelector(".mc-detail__question")?.textContent).toBe("Run cargo test?");
    el.querySelector<HTMLButtonElement>(".mc-perm-opts button")!.click();
    expect(onPermission).toHaveBeenCalledWith("s1", "rk", "allow");
  });

  it("pty waiting: composer writes to the terminal, no scope select", () => {
    const onPtyReply = vi.fn();
    const el = mounted(renderAttentionBody(item({ kind: "pty-waiting", question: null }), { ...cbs(), onPtyReply }));
    expect(el.querySelector(".mc-detail__question")?.textContent).toBe("(waiting on you)");
    expect(el.querySelector(".mc-reply__scope")).toBeNull();
    const ta = el.querySelector<HTMLTextAreaElement>(".mc-reply__textarea")!;
    ta.value = "y";
    el.querySelector<HTMLButtonElement>(".mc-reply__send")!.click();
    expect(onPtyReply).toHaveBeenCalledWith("s1", "y");
  });

  it("never renders the excerpt — the detail pane owns the tail", () => {
    const el = mounted(renderAttentionBody(item({ excerpt: "$ ls\nfoo" }), cbs()));
    expect(el.textContent).not.toContain("$ ls");
  });
});

describe("agoLabel", () => {
  it("formats seconds/minutes", () => {
    expect(agoLabel(Date.now() - 5_000)).toBe("5s ago");
    expect(agoLabel(Date.now() - 120_000)).toBe("2m ago");
  });
});
