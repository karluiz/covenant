import { afterEach, describe, expect, it, vi } from "vitest";

import type { Operator, Task } from "../api";
import * as ApiModule from "../api";
import { buildTaskInjection, sanitizeMentionTokens, TeammatePanel } from "./panel";

// Hoist a module-level mock so panel.ts's static import of primeSpawnedTab
// and injectCommand can be intercepted by individual tests.
vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return {
    ...original,
    primeSpawnedTab: vi.fn().mockResolvedValue(undefined),
    injectCommand:   vi.fn().mockResolvedValue(undefined),
  };
});

describe("buildTaskInjection spec prefix", () => {
  it("prepends a relative spec path when cwd matches", () => {
    expect(buildTaskInjection(
      "Develop achievements", "spec impl", "claude", new Map(),
      "/home/me/repo/docs/specs/3.23.md", "/home/me/repo",
    )).toBe("claude 'Read docs/specs/3.23.md first, then: Develop achievements — spec impl'\n");
  });
  it("falls back to abs path when cwd doesn't match", () => {
    expect(buildTaskInjection(
      "x", "y", "claude", new Map(), "/abs/path/spec.md", "/other/cwd",
    )).toBe("claude 'Read /abs/path/spec.md first, then: x — y'\n");
  });
  it("omits the prefix when no spec was mentioned", () => {
    expect(buildTaskInjection("x", "y", "claude", new Map(), null, null))
      .toBe("claude 'x — y'\n");
  });
});

describe("sanitizeMentionTokens", () => {
  it("rewrites known tokens to their resolved display", () => {
    const map = new Map([["@achievement", "docs/specs/3.23-achievements-and-reputation.md"]]);
    expect(sanitizeMentionTokens("work on @achievement now", map))
      .toBe("work on docs/specs/3.23-achievements-and-reputation.md now");
  });
  it("strips the @ from unknown tokens so executors don't see chat syntax", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(sanitizeMentionTokens("fix @ghost please", new Map())).toBe("fix ghost please");
    warn.mockRestore();
  });
  it("leaves bare @ alone", () => {
    expect(sanitizeMentionTokens("email me @ later", new Map())).toBe("email me @ later");
  });
});

const stubThread = {
  id: "th-1",
  operator_id: "op-mibli",
  title: "New conversation",
  created_at_unix_ms: 0,
  last_message_at_unix_ms: 0,
  archived: false,
};

const stubThreadDeps = {
  listThreads:   async () => [stubThread],
  createThread:  async () => ({ ...stubThread, id: "th-new" }),
  renameThread:  async () => {},
  archiveThread: async () => {},
};

const stubMentionDeps = {
  ...stubThreadDeps,
  mentionSources: {
    findFiles:          async () => [],
    listOperators:      async () => [],
    listOpenSessions:   () => [],
    findRecentCommands: async () => [],
    findSpecs:          async () => [],
  },
  readFile:           async () => ({ kind: "text" as const, content: "", size_bytes: 0 }),
  readBlockExcerpt:   async () => ({ command: "", exit_code: null, cwd: "", plain_output: "" }),
  readSessionExcerpt: async () => ({ cwd: "", shell: "", tab_index: 0, recent: [] }),
};

function makeOp(overrides: Partial<Operator> = {}): Operator {
  return {
    id: "op-mibli",
    name: "Mibli",
    emoji: "🤖",
    color: "#6B7280",
    tags: [],
    persona: "",
    escalate_threshold: 0.6,
    model: "claude-sonnet-4-6",
    hard_constraints: "",
    voice: "Terse",
    is_default: true,
    created_at_unix_ms: 0,
    updated_at_unix_ms: 0,
    xp: 0,
    ...overrides,
  };
}

describe("TeammatePanel", () => {
  it("renders the empty-state card when there are no messages", async () => {
    const host = document.createElement("div");
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn(),
      listOperators: vi.fn().mockResolvedValue([]),
    });
    await panel.openFor(makeOp());
    // The placeholder is an interactive card titled "Chat with <name>"
    // with prompt-suggestion chips, not a plain text placeholder. The
    // user prefers this richer empty state (see commit history /
    // user preferences). Assert the card markup, not legacy copy.
    const empty = host.querySelector(".teammate-panel-empty");
    expect(empty).not.toBeNull();
    expect(empty?.querySelector(".teammate-empty-title")?.textContent)
      .toMatch(/Chat with Mibli/);
    // At least one suggestion chip should be present and clickable.
    const chips = empty?.querySelectorAll(".teammate-empty-chip") ?? [];
    expect(chips.length).toBeGreaterThan(0);
  });

  it("renders avatar + name + model subtitle in the header", async () => {
    const host = document.createElement("div");
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn(),
      listOperators: vi.fn().mockResolvedValue([]),
    });
    await panel.openFor(makeOp());
    expect(host.querySelector(".teammate-panel-avatar")).not.toBeNull();
    expect(host.querySelector(".teammate-panel-title-name")?.textContent).toBe("Mibli");
    expect(host.querySelector(".teammate-panel-subtitle")?.textContent).toBe("claude-sonnet-4-6");
  });

  it("renders an XP ring around the avatar + level pill next to the name", async () => {
    const host = document.createElement("div");
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn(),
      listOperators: vi.fn().mockResolvedValue([]),
    });
    await panel.openFor(makeOp({ xp: 142 }));
    const wrap = host.querySelector(".teammate-panel-avatar-wrap") as HTMLElement | null;
    expect(wrap).not.toBeNull();
    // Progress within current level: (142 % 100) / 100 = 0.42.
    expect(wrap!.style.getPropertyValue("--xp-progress")).toBe("0.420");
    expect(host.querySelector(".teammate-panel-xp-ring")).not.toBeNull();
    // Level = floor(xp / 100) + 1 = 2. The pill lives inline next to the
    // operator name (was on the avatar, but that occluded the v2
    // character art — now sits in .teammate-panel-title-row). The wrap
    // holds only the ring + avatar + sentiment badge.
    const level = host.querySelector(".teammate-panel-title-row .teammate-panel-level");
    expect(level?.textContent).toBe("Lv 2");
    expect(wrap!.querySelector(".teammate-panel-level")).toBeNull();
  });

  it("renders the chevron as the last child of the header", async () => {
    const host = document.createElement("div");
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn(),
      listOperators: vi.fn().mockResolvedValue([]),
    });
    await panel.openFor(makeOp());
    const header = host.querySelector(".teammate-panel-header") as HTMLElement;
    const chevron = header.querySelector(".teammate-panel-header-chevron");
    expect(chevron).not.toBeNull();
    expect(header.lastElementChild).toBe(chevron);
  });

  it("renders operator bubbles in an avatar row, user bubbles solo", async () => {
    const host = document.createElement("div");
    let captured: ((m: import("../api").TeammateMessage) => void) | null = null;
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn().mockResolvedValue({
        id: "u1", operator_id: "op-mibli", task_id: null, thread_id: null, role: "user",
        content: { kind: "text", data: "hola" }, created_at_unix_ms: 1,
        confirmed_at_unix_ms: null, dismissed_at_unix_ms: null,
      }),
      listOperators: vi.fn().mockResolvedValue([]),
      onMessage: vi.fn(async (h) => { captured = h; return () => {}; }),
    });
    await panel.openFor(makeOp());
    await panel.send("hola");
    captured!({
      id: "m1", operator_id: "op-mibli", task_id: null, thread_id: null, role: "operator",
      content: { kind: "text", data: "hola, ¿en qué te ayudo?" }, created_at_unix_ms: 2,
      confirmed_at_unix_ms: null, dismissed_at_unix_ms: null,
    });
    // User bubble: no row wrapper
    expect(host.querySelectorAll(".teammate-bubble-user").length).toBe(1);
    // Operator bubble: wrapped in a row with an avatar slot
    const opRows = host.querySelectorAll(".teammate-bubble-row[data-role='operator']:not(.teammate-typing)");
    expect(opRows.length).toBe(1);
    expect(opRows[0].querySelector(".teammate-bubble-avatar")).not.toBeNull();
  });

  it("renders backtick spans as <code> in bubbles", async () => {
    const host = document.createElement("div");
    let captured: ((m: import("../api").TeammateMessage) => void) | null = null;
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn(),
      listOperators: vi.fn().mockResolvedValue([]),
      onMessage: vi.fn(async (h) => { captured = h; return () => {}; }),
    });
    await panel.openFor(makeOp());
    captured!({
      id: "m1", operator_id: "op-mibli", task_id: null, thread_id: null, role: "operator",
      content: { kind: "text", data: "the file is `src/main.rs`" }, created_at_unix_ms: 2,
      confirmed_at_unix_ms: null, dismissed_at_unix_ms: null,
    });
    const code = host.querySelector(".teammate-bubble code");
    expect(code).not.toBeNull();
    expect(code?.textContent).toBe("src/main.rs");
  });

  it("appends a bubble after sendText resolves", async () => {
    const host = document.createElement("div");
    const send = vi.fn().mockResolvedValue({
      id: "m1",
      operator_id: "op-mibli",
      task_id: null, thread_id: null,
      role: "user",
      content: { kind: "text", data: "hola" },
      created_at_unix_ms: 1,
      confirmed_at_unix_ms: null,
      dismissed_at_unix_ms: null,
    });
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      send,
      listOperators: vi.fn().mockResolvedValue([]),
    });
    await panel.openFor(makeOp());
    await panel.send("hola");
    expect(send).toHaveBeenCalledWith("op-mibli", "th-1", "hola", null);
    expect(host.querySelectorAll(".teammate-bubble:not(.teammate-typing)").length).toBe(1);
  });

  it("shows typing indicator after send and replaces it on incoming reply", async () => {
    let captured: ((m: import("../api").TeammateMessage) => void) | null = null;
    const host = document.createElement("div");
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn().mockResolvedValue({
        id: "u1", operator_id: "op-mibli", task_id: null, thread_id: null, role: "user",
        content: { kind: "text", data: "hola" }, created_at_unix_ms: 1,
        confirmed_at_unix_ms: null, dismissed_at_unix_ms: null,
      }),
      listOperators: vi.fn().mockResolvedValue([]),
      onMessage: vi.fn(async (h) => { captured = h; return () => {}; }),
    });
    await panel.openFor(makeOp());
    await panel.send("hola");
    expect(host.querySelector(".teammate-typing")).not.toBeNull();
    captured!({
      id: "m1", operator_id: "op-mibli", task_id: null, thread_id: null, role: "operator",
      content: { kind: "text", data: "hola, ¿en qué te ayudo?" }, created_at_unix_ms: 2,
      confirmed_at_unix_ms: null, dismissed_at_unix_ms: null,
    });
    expect(host.querySelector(".teammate-typing")).toBeNull();
    const bubbles = host.querySelectorAll(".teammate-bubble:not(.teammate-typing)");
    expect(bubbles.length).toBe(2);
  });

  it("opens a switcher with all operators on header click", async () => {
    const host = document.createElement("div");
    const ops = [makeOp(), makeOp({ id: "op-k", name: "Karluiz", is_default: false })];
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn(),
      listOperators: vi.fn().mockResolvedValue(ops),
    });
    await panel.openFor(makeOp());
    (host.querySelector(".teammate-panel-header") as HTMLElement).click();
    const rows = host.querySelectorAll(".teammate-panel-switcher-row");
    expect(rows.length).toBe(2);
    expect(host.textContent).toMatch(/Karluiz/);
  });

  it("passes active session id from resolver to sendText", async () => {
    const host = document.createElement("div");
    const send = vi.fn().mockResolvedValue({
      id: "u1", operator_id: "op-mibli", task_id: null, thread_id: null, role: "user",
      content: { kind: "text", data: "hola" }, created_at_unix_ms: 1,
      confirmed_at_unix_ms: null, dismissed_at_unix_ms: null,
    });
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      send,
      listOperators: vi.fn().mockResolvedValue([]),
      getActiveSessionId: () => "session-abc",
    });
    await panel.openFor(makeOp());
    await panel.send("hola");
    expect(send).toHaveBeenCalledWith("op-mibli", "th-1", "hola", "session-abc");
  });

  it("renders a tool-call line when the operator reads a file", async () => {
    let captured: ((call: import("../api").TeammateToolCall) => void) | null = null;
    const host = document.createElement("div");
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages:  vi.fn().mockResolvedValue([]),
      sendText:      vi.fn(),
      listOperators: vi.fn().mockResolvedValue([]),
      onToolCall: vi.fn(async (h) => { captured = h; return () => {}; }),
    });
    await panel.openFor(makeOp());
    captured!({
      operator_id: "op-mibli",
      progress: {
        kind: "tool_call",
        tool: "read_file",
        args: { path: "src/main.rs" },
        ok: true,
        error: null,
      },
    });
    const line = host.querySelector(".teammate-tool-line");
    expect(line).not.toBeNull();
    expect(line?.textContent ?? "").toMatch(/read_file/);
    expect(line?.textContent ?? "").toMatch(/src\/main\.rs/);
  });
});

describe("TeammatePanel propose rendering", () => {
  it("renders a task card for propose messages and dispatches confirm", async () => {
    const operator = {
      id: "op1", name: "Mibli", emoji: "🧪", color: "#aaa",
      tags: [], persona: "", escalate_threshold: 0.6,
      model: "claude-sonnet-4-6", hard_constraints: "",
      voice: "terse", is_default: true,
      created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
    } as unknown as import("../api").Operator;

    const proposeMsg: import("../api").TeammateMessage = {
      id: "msg-propose",
      operator_id: "op1",
      task_id: null, thread_id: null,
      role: "operator",
      content: {
        kind: "propose",
        data: {
          draft: {
            archetype: "do",
            title: "Revisar migración de auth",
            deliverable: "resumen",
            scope: { paths: ["crates/app/src/auth_mig.rs"] },
          },
          rationale: "audit",
        },
      },
      created_at_unix_ms: 0,
      confirmed_at_unix_ms: null,
      dismissed_at_unix_ms: null,
    };

    const confirmTask = vi.fn().mockResolvedValue({
      id: "task-1", operator_id: "op1", archetype: "do", title: "Revisar migración de auth",
      body: "", deliverable: "resumen", status: "active",
      scope: { paths: ["crates/app/src/auth_mig.rs"] },
      spawned_session: null,
      created_at_unix_ms: 1, updated_at_unix_ms: 1, completed_at_unix_ms: null,
      cost_usd_cents: 0,
    });
    const createTab = vi.fn().mockResolvedValue({ sessionId: "S-NEW" });
    const attachSession = vi.fn().mockResolvedValue(undefined);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages: async () => [proposeMsg],
      sendText:     async () => proposeMsg,
      listOperators: async () => [operator],
      onMessage:    async () => () => {},
      onToolCall:   async () => () => {},
      confirmTask,
      cancelTaskProposal: vi.fn(),
      editTaskProposal:   vi.fn(),
      attachSessionToTask: attachSession,
      spawnTabForTask: createTab,
      getActiveSessionId: () => "S-ACTIVE",
    });
    await panel.openFor(operator);

    const card = host.querySelector(".task-card") as HTMLElement;
    expect(card).not.toBeNull();
    (card.querySelector('[data-action="confirm"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(confirmTask).toHaveBeenCalledWith("op1", "msg-propose");
    // Default is "active": attach to the active tab, do NOT spawn a new one.
    expect(createTab).not.toHaveBeenCalled();
    expect(attachSession).toHaveBeenCalledWith("op1", "task-1", "S-ACTIVE");
  });
});

// ---------------------------------------------------------------------------
// primeSpawnedTab race-fix: called BEFORE the prompt-inject setTimeout fires
// ---------------------------------------------------------------------------
describe("TeammatePanel spawn+prime ordering", () => {
  afterEach(() => {
    localStorage.removeItem("covenant.teammate.confirm-target");
    vi.useRealTimers();
    vi.mocked(ApiModule.primeSpawnedTab).mockReset().mockResolvedValue(undefined);
    vi.mocked(ApiModule.injectCommand).mockReset().mockResolvedValue(undefined);
  });

  /** shared fixtures */
  function makeSpawnFixtures() {
    const operator = {
      id: "op1", name: "Mibli", emoji: "🧪", color: "#aaa",
      tags: [], persona: "", escalate_threshold: 0.6,
      model: "claude-sonnet-4-6", hard_constraints: "",
      voice: "terse", is_default: true,
      created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
    } as unknown as import("../api").Operator;

    const proposeMsg: import("../api").TeammateMessage = {
      id: "msg-propose",
      operator_id: "op1",
      task_id: null, thread_id: null,
      role: "operator",
      content: {
        kind: "propose",
        data: {
          draft: {
            archetype: "do",
            title: "Add achievements",
            deliverable: "working feature",
            scope: { paths: ["crates/app/src/achievements.rs"] },
          },
          rationale: "new feature",
        },
      },
      created_at_unix_ms: 0,
      confirmed_at_unix_ms: null,
      dismissed_at_unix_ms: null,
    };

    const confirmTask = vi.fn().mockResolvedValue({
      id: "task-99", operator_id: "op1", archetype: "do",
      title: "Add achievements", body: "", deliverable: "working feature",
      status: "active",
      scope: { paths: ["crates/app/src/achievements.rs"] },
      spawned_session: null,
      created_at_unix_ms: 1, updated_at_unix_ms: 1, completed_at_unix_ms: null,
      cost_usd_cents: 0,
    });
    const spawnTabForTask = vi.fn().mockResolvedValue({
      sessionId: "S-SPAWNED", cwd: "/repo", groupId: null, color: null,
    });
    const attachSessionToTask = vi.fn().mockResolvedValue(undefined);
    const listMessages = vi.fn().mockResolvedValue([proposeMsg]);

    return { operator, proposeMsg, confirmTask, spawnTabForTask, attachSessionToTask, listMessages };
  }

  it("calls primeSpawnedTab with correct args BEFORE the inject setTimeout fires", async () => {
    vi.useFakeTimers();
    localStorage.setItem("covenant.teammate.confirm-target", "spawn");

    const { operator, proposeMsg, confirmTask, spawnTabForTask, attachSessionToTask, listMessages } =
      makeSpawnFixtures();

    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages,
      sendText:    async () => proposeMsg,
      listOperators: async () => [operator],
      onMessage:   async () => () => {},
      onToolCall:  async () => () => {},
      confirmTask,
      cancelTaskProposal: vi.fn(),
      editTaskProposal:   vi.fn(),
      attachSessionToTask,
      spawnTabForTask,
      getActiveSessionId: () => "S-ACTIVE",
    });
    await panel.openFor(operator);

    // Plant a spec path as if the user sent a message with an @spec chip.
    (panel as unknown as { lastSentSpecPath: string }).lastSentSpecPath =
      "/repo/docs/specs/3.23-achievements.md";

    const card = host.querySelector(".task-card") as HTMLElement;
    expect(card).not.toBeNull();
    (card.querySelector('[data-action="confirm"]') as HTMLButtonElement).click();

    // Drain microtasks so handleConfirm runs through confirmTask →
    // spawnTabForTask → primeSpawnedTab and registers the inject setTimeout.
    // We use a real-Promise flush (multiple yields) rather than
    // runAllTimersAsync to avoid triggering the ActivityView setInterval loop.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // primeSpawnedTab must have been called (awaited inline, before the timer).
    expect(ApiModule.primeSpawnedTab).toHaveBeenCalledWith(
      "S-SPAWNED",
      "/repo/docs/specs/3.23-achievements.md",
    );

    // Inject timer has NOT fired yet (timers are frozen).
    expect(ApiModule.injectCommand).not.toHaveBeenCalled();

    // Advance past the 1500 ms inject delay — injectCommand fires now.
    await vi.advanceTimersByTimeAsync(1600);

    expect(ApiModule.injectCommand).toHaveBeenCalledWith(
      "S-SPAWNED",
      expect.stringContaining("Add achievements"),
    );

    // primeSpawnedTab was invoked before injectCommand (call-order check).
    const primeOrder   = vi.mocked(ApiModule.primeSpawnedTab).mock.invocationCallOrder[0]!;
    const injectOrder  = vi.mocked(ApiModule.injectCommand).mock.invocationCallOrder[0]!;
    expect(primeOrder).toBeLessThan(injectOrder);
  });

  it("still fires the inject when primeSpawnedTab throws (catch path)", async () => {
    vi.useFakeTimers();
    localStorage.setItem("covenant.teammate.confirm-target", "spawn");

    // Make primeSpawnedTab reject to exercise the catch branch.
    vi.mocked(ApiModule.primeSpawnedTab).mockRejectedValue(new Error("spec deleted"));

    const { operator, proposeMsg, confirmTask, spawnTabForTask, attachSessionToTask, listMessages } =
      makeSpawnFixtures();

    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages,
      sendText:    async () => proposeMsg,
      listOperators: async () => [operator],
      onMessage:   async () => () => {},
      onToolCall:  async () => () => {},
      confirmTask,
      cancelTaskProposal: vi.fn(),
      editTaskProposal:   vi.fn(),
      attachSessionToTask,
      spawnTabForTask,
      getActiveSessionId: () => "S-ACTIVE",
    });
    await panel.openFor(operator);

    (panel as unknown as { lastSentSpecPath: string }).lastSentSpecPath =
      "/repo/docs/specs/3.23-achievements.md";

    const card = host.querySelector(".task-card") as HTMLElement;
    (card.querySelector('[data-action="confirm"]') as HTMLButtonElement).click();

    // Drain microtasks: handleConfirm's catch block swallows the rejection
    // and execution continues to the inject setTimeout registration.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Advance past the inject delay — injectCommand must still fire despite
    // the primeSpawnedTab error.
    await vi.advanceTimersByTimeAsync(1600);

    // primeSpawnedTab threw — injectCommand must still have been called.
    expect(ApiModule.primeSpawnedTab).toHaveBeenCalled();
    expect(ApiModule.injectCommand).toHaveBeenCalledWith(
      "S-SPAWNED",
      expect.stringContaining("Add achievements"),
    );
  });
});

// ---------------------------------------------------------------------------
// Closed-task action row: a done/cancelled task must NOT leave a dead Stop
// (or a dead disabled "Open tab") button on the card. Regression for the
// "I pressed Stop, now there's a Stop button I can't press" dead-end.
// ---------------------------------------------------------------------------
describe("TeammatePanel task action row", () => {
  function makeTask(overrides: Partial<Task> = {}): Task {
    return {
      id: "task-x",
      operator_id: "op1",
      archetype: "do",
      title: "Implement achievements",
      body: "",
      deliverable: "feature",
      status: "active",
      scope: { paths: [] },
      spawned_session: null,
      created_at_unix_ms: 1,
      updated_at_unix_ms: 1,
      completed_at_unix_ms: null,
      cost_usd_cents: 0,
      ...overrides,
    };
  }

  async function mountWithTask(task: Task): Promise<HTMLElement> {
    const operator = makeOp({ id: "op1" });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = new TeammatePanel(host, {
      ...stubMentionDeps,
      listMessages:  async () => [],
      sendText:      vi.fn(),
      listOperators: async () => [operator],
      listTasks:     async () => [task],
      cancelActiveTask: vi.fn().mockResolvedValue(undefined),
      spawnTabForTask:  vi.fn(),
    });
    await panel.openFor(operator);
    // Expand the card so the action row renders.
    (host.querySelector(".task-item__head") as HTMLElement).click();
    return host;
  }

  function stopButton(host: HTMLElement): HTMLButtonElement | undefined {
    return Array.from(host.querySelectorAll<HTMLButtonElement>(".task-actions .btn"))
      .find((b) => b.textContent === "Stop");
  }

  it("renders an enabled Stop button for an active task", async () => {
    const host = await mountWithTask(makeTask({ status: "active" }));
    const stop = stopButton(host);
    expect(stop).toBeDefined();
    expect(stop!.disabled).toBe(false);
  });

  it("renders no Stop button for a cancelled task", async () => {
    const host = await mountWithTask(makeTask({ status: "cancelled" }));
    expect(stopButton(host)).toBeUndefined();
  });

  it("renders no Stop button for a done task", async () => {
    const host = await mountWithTask(makeTask({ status: "done" }));
    expect(stopButton(host)).toBeUndefined();
  });

  it("leaves no dead disabled buttons on a cancelled task with no live session", async () => {
    const host = await mountWithTask(makeTask({ status: "cancelled" }));
    const dead = Array.from(host.querySelectorAll<HTMLButtonElement>(".task-actions .btn"))
      .filter((b) => b.disabled);
    expect(dead).toHaveLength(0);
  });
});
