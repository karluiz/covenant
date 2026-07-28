// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderAgentRow, renderDetailPane, type RowCallbacks, type DetailCallbacks } from "./tile";
import type { AgentCard, AttentionItem, TileStatus } from "../api";

const agent = (over: Partial<AgentCard>): AgentCard => ({
  session_id: "s1", tab_title: "agent tests", tab_color: null, lane: "pty",
  executor: "claude", status: "working" as TileStatus, phase_label: null,
  cwd: null, vendor: "claude", raw_command_label: null,
  last_command: "cargo test --workspace", last_output_line: null, excerpt: null, started_at_unix_ms: null,
  mission_name: null, operator_id: null, operator_name: null,
  operator_avatar: null, cost_usd: null, budget_usd: null, subagents: [], ...over,
});

const rowCbs = (): RowCallbacks => ({ onSelect: vi.fn(), onFocus: vi.fn() });
const detailCbs = (): DetailCallbacks => ({
  onFocus: vi.fn(), onStop: vi.fn(),
  onOperatorReply: vi.fn(async () => {}), onPermission: vi.fn(), onPtyReply: vi.fn(),
});

describe("renderAgentRow", () => {
  it("headline is the tab title; sub-line is executor · operator; activity is mono line", () => {
    const el = renderAgentRow(
      agent({ executor: "codex", operator_name: "Zeta", phase_label: "editing a.rs" }),
      { selected: false, age: null }, rowCbs(),
    );
    expect(el.classList.contains("mc-row--working")).toBe(true);
    expect(el.querySelector(".mc-row__title")?.textContent).toBe("agent tests");
    expect(el.querySelector(".mc-row__sub")?.textContent).toBe("codex · Zeta");
    expect(el.querySelector(".mc-row__activity")?.textContent).toBe("editing a.rs");
  });

  it("selected + age render; click selects; double-click focuses the tab", () => {
    const cb = rowCbs();
    const el = renderAgentRow(agent({ status: "blocked" }), { selected: true, age: "2m ago" }, cb);
    expect(el.classList.contains("mc-row--selected")).toBe(true);
    expect(el.querySelector(".mc-row__age")?.textContent).toBe("2m ago");
    el.click();
    expect(cb.onSelect).toHaveBeenCalledWith("s1");
    el.dispatchEvent(new MouseEvent("dblclick"));
    expect(cb.onFocus).toHaveBeenCalledWith("s1");
  });

  it("activity falls back to cwd before the ellipsis placeholder", () => {
    const withCwd = renderAgentRow(
      agent({ last_command: null, last_output_line: null, cwd: "/x/y" }),
      { selected: false, age: null }, rowCbs(),
    );
    expect(withCwd.querySelector(".mc-row__activity")?.textContent).toBe("/x/y");
    const bare = renderAgentRow(
      agent({ last_command: null, last_output_line: null, cwd: null }),
      { selected: false, age: null }, rowCbs(),
    );
    expect(bare.querySelector(".mc-row__activity")?.textContent).toBe("…");
  });
});

describe("renderDetailPane", () => {
  it("acp session without excerpt gets a chat note instead of an empty void", () => {
    const el = renderDetailPane(agent({ lane: "acp", excerpt: null }), null, detailCbs());
    expect(el.querySelector(".mc-tail")).toBeNull();
    expect(el.querySelector(".mc-detail__note")?.textContent).toContain("conversation lives in its tab");
    // PTY without excerpt stays bare — no note.
    const pty = renderDetailPane(agent({ lane: "pty", excerpt: null }), null, detailCbs());
    expect(pty.querySelector(".mc-detail__note")).toBeNull();
  });

  it("head has title + status pill + Open tab; no Stop without an operator", () => {
    const cb = detailCbs();
    const el = renderDetailPane(agent({}), null, cb);
    expect(el.querySelector(".mc-detail__title")?.textContent).toBe("agent tests");
    expect(el.querySelector(".mc-pill--working")?.textContent).toBe("working");
    expect(el.querySelector(".mc-stop")).toBeNull();
    el.querySelector<HTMLButtonElement>(".mc-detail__open")!.click();
    expect(cb.onFocus).toHaveBeenCalledWith("s1", false);
  });

  it("operator: meta shows the badge, Stop stops", () => {
    const cb = detailCbs();
    const el = renderDetailPane(
      agent({ operator_id: "o1", operator_name: "Zeta", mission_name: "release", cwd: "/x", cost_usd: 0.4, budget_usd: 1 }),
      null, cb,
    );
    expect(el.querySelector(".mc-oplabel")?.textContent).toContain("Zeta");
    expect(el.querySelector(".mc-chip")?.textContent).toContain("release");
    expect(el.querySelector(".mc-detail__cwd")?.textContent).toBe("/x");
    expect(el.querySelector(".mc-cost")).not.toBeNull();
    el.querySelector<HTMLButtonElement>(".mc-stop")!.click();
    expect(cb.onStop).toHaveBeenCalledWith("s1");
  });

  it("live tail renders from card.excerpt; subagent rows render", () => {
    const el = renderDetailPane(
      agent({
        excerpt: "$ cargo test\nrunning 34/210",
        subagents: [{ id: "t1", label: "fix-flaky", detail: null, running: true, started_unix_ms: Date.now() - 61_000 }],
      }),
      null, detailCbs(),
    );
    expect(el.querySelector(".mc-tail")?.textContent).toContain("running 34/210");
    expect(el.querySelector(".mc-subrow")?.textContent).toContain("fix-flaky");
  });

  it("copy-tail action puts the excerpt on the clipboard; absent without excerpt", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const el = renderDetailPane(agent({ excerpt: "$ ls\nfoo" }), null, detailCbs());
    el.querySelector<HTMLButtonElement>(".mc-detail__copy")!.click();
    expect(writeText).toHaveBeenCalledWith("$ ls\nfoo");
    const bare = renderDetailPane(agent({ excerpt: null }), null, detailCbs());
    expect(bare.querySelector(".mc-detail__copy")).toBeNull();
  });

  it("blocked + attention item: the interaction renders inside the pane", () => {
    const at: AttentionItem = {
      session_id: "s1", tab_title: "agent tests", tab_color: null, lane: "pty",
      executor: "claude", kind: "operator-escalation", question: "Ship?",
      permission: null, operator_name: "Zeta",
      operator_avatar: null, mission_name: null, since_unix_ms: 1,
    };
    const el = renderDetailPane(agent({ status: "blocked" }), at, detailCbs());
    expect(el.querySelector(".mc-detail__question")?.textContent).toBe("Ship?");
    expect(el.querySelector(".mc-reply")).not.toBeNull();
  });
});
