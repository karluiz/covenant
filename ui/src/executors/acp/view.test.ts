// @vitest-environment jsdom
//
// Reducer-only tests (Step 1 of the TDD brief). No DOM assertions here —
// `reduceAcpEvent` is pure(-ish): it mutates an `AcpStreamState` in place
// and never touches the document. The view (mounted DOM, subscription,
// composer) is covered separately once implemented; this file locks the
// stream-shaping contract first so the view can be a thin renderer over it.
//
// "./view" also exports the DOM-heavy `AcpChatView` class, which imports
// `../../api` (Tauri `invoke`/`listen`). Mock that module so importing
// the reducer doesn't require a Tauri runtime.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api", () => ({
  spawnAcpSession: vi.fn(),
  closeAcpSession: vi.fn(),
  acpSendPrompt: vi.fn(),
  acpRespondPermission: vi.fn(),
  acpCancel: vi.fn(),
  subscribeAcpEvents: vi.fn(),
}));

import {
  createAcpStreamState,
  filterSlashCommands,
  isBackgroundConsole,
  isCommandNoise,
  stripFences,
  markPermAnswered,
  mentionFragmentAt,
  perceptionAuditText,
  reduceAcpEvent,
  shellIdOf,
  titleFromPrompt,
  type AcpNoticeItem,
  type AcpPermItem,
  type AcpProseItem,
  type AcpToolItem,
  relativeTime,
} from "./view";
import type { AcpPermissionRequest, AcpSessionUpdate, AcpTabEvent } from "../../api";

function update(su: AcpSessionUpdate): AcpTabEvent {
  return { type: "update", update: { sessionId: "s1", update: su } };
}

describe("relativeTime", () => {
  it("buckets seconds/minutes/hours/days and tolerates garbage", () => {
    const now = Date.now();
    expect(relativeTime(new Date(now - 5_000).toISOString())).toBe("just now");
    expect(relativeTime(new Date(now - 120_000).toISOString())).toBe("2m ago");
    expect(relativeTime(new Date(now - 2 * 3_600_000).toISOString())).toBe("2h ago");
    expect(relativeTime(new Date(now - 3 * 86_400_000).toISOString())).toBe("3d ago");
    expect(relativeTime("not-a-date")).toBe("");
  });
});

describe("reduceAcpEvent", () => {
  it("creates one prose item from a single agent_message_chunk", () => {
    const state = createAcpStreamState();
    reduceAcpEvent(state, update({ sessionUpdate: "agent_message_chunk", content: { text: "hello" } }));
    expect(state.items).toHaveLength(1);
    const item = state.items[0] as AcpProseItem;
    expect(item.kind).toBe("prose");
    expect(item.role).toBe("assistant");
    expect(item.text).toBe("hello");
  });

  it("accumulates consecutive agent_message_chunk events into ONE prose item", () => {
    const state = createAcpStreamState();
    reduceAcpEvent(state, update({ sessionUpdate: "agent_message_chunk", content: { text: "hel" } }));
    reduceAcpEvent(state, update({ sessionUpdate: "agent_message_chunk", content: { text: "lo" } }));
    reduceAcpEvent(state, update({ sessionUpdate: "agent_message_chunk", content: { text: " world" } }));
    expect(state.items).toHaveLength(1);
    expect((state.items[0] as AcpProseItem).text).toBe("hello world");
  });

  it("renders replayed user_message_chunk as a user item (session/load)", () => {
    const state = createAcpStreamState();
    reduceAcpEvent(state, update({ sessionUpdate: "user_message_chunk", content: { text: "fix the bug" } }));
    reduceAcpEvent(state, update({ sessionUpdate: "agent_message_chunk", content: { text: "done" } }));
    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toEqual({ kind: "user", text: "fix the bug" });
    expect((state.items[1] as AcpProseItem).role).toBe("assistant");
  });

  it("merges consecutive user_message_chunk events into one user item", () => {
    const state = createAcpStreamState();
    reduceAcpEvent(state, update({ sessionUpdate: "user_message_chunk", content: { text: "fix " } }));
    reduceAcpEvent(state, update({ sessionUpdate: "user_message_chunk", content: { text: "it" } }));
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toEqual({ kind: "user", text: "fix it" });
  });

  it("drops replayed slash-command bookkeeping chunks (claude-agent-acp)", () => {
    const state = createAcpStreamState();
    // Verbatim shapes seen live in a claude-agent-acp session/load replay.
    reduceAcpEvent(state, update({ sessionUpdate: "user_message_chunk", content: { text: "<command-name>/model</command-name>\n" } }));
    reduceAcpEvent(state, update({ sessionUpdate: "user_message_chunk", content: { text: "<local-command-stdout>Set model to claude-opus-4.7</local-command-stdout>" } }));
    reduceAcpEvent(state, update({ sessionUpdate: "user_message_chunk", content: { text: "fix the bug" } }));
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toEqual({ kind: "user", text: "fix the bug" });
  });

  it("flags a silent turn: end_turn with zero output pushes an error notice", () => {
    const state = createAcpStreamState();
    state.items.push({ kind: "user", text: "hola" });
    state.turnHadOutput = false;
    reduceAcpEvent(state, { type: "prompt_done", stopReason: "end_turn" });
    const last = state.items[state.items.length - 1] as AcpNoticeItem;
    expect(last.kind).toBe("notice");
    expect(last.variant).toBe("error");
    expect(last.text).toContain("no output");
  });

  it("stays quiet on end_turn when the turn produced output", () => {
    const state = createAcpStreamState();
    state.turnHadOutput = false;
    reduceAcpEvent(state, update({ sessionUpdate: "agent_message_chunk", content: { text: "hi" } }));
    reduceAcpEvent(state, { type: "prompt_done", stopReason: "end_turn" });
    expect(state.items.every((i) => i.kind !== "notice")).toBe(true);
  });

  it("keeps agent_thought_chunk and agent_message_chunk as separate prose items", () => {
    const state = createAcpStreamState();
    reduceAcpEvent(state, update({ sessionUpdate: "agent_thought_chunk", content: { text: "thinking…" } }));
    reduceAcpEvent(state, update({ sessionUpdate: "agent_message_chunk", content: { text: "hi" } }));
    expect(state.items).toHaveLength(2);
    expect((state.items[0] as AcpProseItem).role).toBe("thought");
    expect((state.items[1] as AcpProseItem).role).toBe("assistant");
  });

  it("merges tool_call_update into the tool_call by toolCallId (status upgrade, content replace, order preserved)", () => {
    const state = createAcpStreamState();
    // A prose item before, so we can assert the tool item's position stays fixed.
    reduceAcpEvent(state, update({ sessionUpdate: "agent_message_chunk", content: { text: "starting" } }));
    reduceAcpEvent(
      state,
      update({
        sessionUpdate: "tool_call",
        toolCallId: "t1",
        title: "Run tests",
        kind: "execute",
        status: "pending",
        content: [{ text: "queued" }],
      }),
    );
    // A second, unrelated item after — proves order is preserved (no re-splice).
    reduceAcpEvent(state, update({ sessionUpdate: "agent_message_chunk", content: { text: "still going" } }));

    expect(state.items).toHaveLength(3);
    expect(state.tools.size).toBe(1);

    reduceAcpEvent(
      state,
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [{ text: "exit 0" }],
      }),
    );

    // No new item appended — the update merged into the existing tool item.
    expect(state.items).toHaveLength(3);
    const toolItem = state.items[1] as AcpToolItem;
    expect(toolItem.kind).toBe("tool");
    expect(toolItem.toolCallId).toBe("t1");
    // Later non-empty wins for status/content…
    expect(toolItem.fields.status).toBe("completed");
    expect(toolItem.fields.content).toEqual([{ text: "exit 0" }]);
    // …but title/kind survive from the first frame since the update omitted them.
    expect(toolItem.fields.title).toBe("Run tests");
    expect(toolItem.fields.kind).toBe("execute");
    // Same object reference reachable both via items[] and the tools map.
    expect(state.tools.get("t1")).toBe(toolItem);
  });

  it("permission_pending adds an unanswered perm item, indexed by requestKey", () => {
    const state = createAcpStreamState();
    const request: AcpPermissionRequest = {
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Push", kind: "execute", rawInput: { command: "git push" } },
      options: [
        { optionId: "a", kind: "allow_once", name: "Allow" },
        { optionId: "b", kind: "reject_once", name: "Deny" },
      ],
    };
    reduceAcpEvent(state, { type: "permission_pending", requestKey: "req-1", request });

    expect(state.items).toHaveLength(1);
    const item = state.items[0] as AcpPermItem;
    expect(item.kind).toBe("perm");
    expect(item.requestKey).toBe("req-1");
    expect(item.answered).toBeUndefined();
    expect(state.pendingPerms.get("req-1")).toBe(item);
  });

  it("duplicate_permission_pending_is_ignored: same requestKey twice yields one perm item", () => {
    const state = createAcpStreamState();
    const request: AcpPermissionRequest = {
      sessionId: "s1",
      toolCall: { toolCallId: "t1", title: "Push", kind: "execute" },
      options: [{ optionId: "a", kind: "allow_once", name: "Allow" }],
    };
    reduceAcpEvent(state, { type: "permission_pending", requestKey: "req-1", request });
    reduceAcpEvent(state, { type: "permission_pending", requestKey: "req-1", request });

    expect(state.items).toHaveLength(1);
    expect(state.pendingPerms.size).toBe(1);
    expect((state.items[0] as AcpPermItem).requestKey).toBe("req-1");
  });

  it("markPermAnswered marks the perm item and removes it from pendingPerms", () => {
    const state = createAcpStreamState();
    const request: AcpPermissionRequest = {
      sessionId: "s1",
      toolCall: { toolCallId: "t1" },
      options: [{ optionId: "a", kind: "allow_once" }],
    };
    reduceAcpEvent(state, { type: "permission_pending", requestKey: "req-1", request });

    markPermAnswered(state, "req-1", "Allowed once · `git push`");

    const item = state.items[0] as AcpPermItem;
    expect(item.answered).toBe("Allowed once · `git push`");
    expect(state.pendingPerms.has("req-1")).toBe(false);
    // The item stays in `items` (as an answered record), it's just no
    // longer "pending".
    expect(state.items).toHaveLength(1);
  });

  it("perception_auto_answer appends a muted audit notice (never a perm card)", () => {
    const state = createAcpStreamState();
    reduceAcpEvent(state, {
      type: "perception_auto_answer",
      requestKey: "req-1",
      optionId: "allow_once",
      reason: "read-only, low risk",
    });

    expect(state.items).toHaveLength(1);
    const item = state.items[0] as AcpNoticeItem;
    expect(item.kind).toBe("notice");
    expect(item.variant).toBe("perception");
    expect(item.text).toBe("Perception ✓ auto-answered: allow_once — read-only, low risk");
    // Never registered as a pending permission — there's nothing to answer.
    expect(state.pendingPerms.size).toBe(0);
  });

  it("perceptionAuditText formats option + reason into one line", () => {
    expect(perceptionAuditText("reject_once", "matches hard constraint")).toBe(
      "Perception ✓ auto-answered: reject_once — matches hard constraint",
    );
  });

  it("prompt_done flips inFlight; end_turn is silent, informative stop reasons get a divider", () => {
    const state = createAcpStreamState();
    state.inFlight = true;
    state.turnHadOutput = true; // a normal turn — output arrived
    reduceAcpEvent(state, { type: "prompt_done", stopReason: "end_turn" });

    // The normal outcome renders nothing — a per-turn divider is noise.
    expect(state.inFlight).toBe(false);
    expect(state.items).toHaveLength(0);

    state.inFlight = true;
    reduceAcpEvent(state, { type: "prompt_done", stopReason: "timeout" });
    expect(state.inFlight).toBe(false);
    expect(state.items).toHaveLength(1);
    const notice = state.items[0] as AcpNoticeItem;
    expect(notice.kind).toBe("notice");
    expect(notice.variant).toBe("divider");
    expect(notice.text).toContain("timeout");
  });

  it("available_commands_update replaces the slash roster without touching items", () => {
    const state = createAcpStreamState();
    reduceAcpEvent(
      state,
      update({
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "compact" }, { name: "autopilot" }],
      }),
    );
    expect(state.commands.map((c) => c.name)).toEqual(["compact", "autopilot"]);
    expect(state.items).toHaveLength(0);

    // The wire sends the full list each time — replace, don't append.
    reduceAcpEvent(
      state,
      update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact" }] }),
    );
    expect(state.commands.map((c) => c.name)).toEqual(["compact"]);
  });

  it("filterSlashCommands matches only a leading single slash-token, by prefix", () => {
    const commands = [{ name: "compact" }, { name: "chronicle" }, { name: "autopilot" }];
    expect(filterSlashCommands(commands, "/").map((c) => c.name)).toEqual([
      "compact",
      "chronicle",
      "autopilot",
    ]);
    expect(filterSlashCommands(commands, "/c").map((c) => c.name)).toEqual(["compact", "chronicle"]);
    expect(filterSlashCommands(commands, "/CO").map((c) => c.name)).toEqual(["compact"]);
    // Not a bare leading token → no menu.
    expect(filterSlashCommands(commands, "/compact focus")).toEqual([]);
    expect(filterSlashCommands(commands, "hello /c")).toEqual([]);
    expect(filterSlashCommands(commands, "")).toEqual([]);
  });

  it("mentionFragmentAt finds only a trailing @token before the caret", () => {
    // Simple trailing fragment.
    expect(mentionFragmentAt("look at @src/ma", 15)).toEqual({ start: 8, fragment: "src/ma" });
    // Bare @ right at the caret.
    expect(mentionFragmentAt("@", 1)).toEqual({ start: 0, fragment: "" });
    // Caret in the middle: only text before it counts.
    expect(mentionFragmentAt("@src hello", 4)).toEqual({ start: 0, fragment: "src" });
    // No fragment cases: no @, @ followed by space before caret, email-like
    // (no leading whitespace boundary), second @ inside the token.
    expect(mentionFragmentAt("hello", 5)).toBeNull();
    expect(mentionFragmentAt("@src ", 5)).toBeNull();
    expect(mentionFragmentAt("mail@host", 9)).toBeNull();
    expect(mentionFragmentAt("a @b@c", 6)).toBeNull();
  });

  it("session_dead flips inFlight to false and appends a 'dead' notice", () => {
    const state = createAcpStreamState();
    state.inFlight = true;
    reduceAcpEvent(state, { type: "session_dead" });

    expect(state.inFlight).toBe(false);
    expect(state.items).toHaveLength(1);
    const notice = state.items[0] as AcpNoticeItem;
    expect(notice.kind).toBe("notice");
    expect(notice.variant).toBe("dead");
  });
});

describe("background consoles", () => {
  const SHELL_EXIT = { contents: [{ type: "shell_exit", shellId: "7", exitCode: 0, cwd: "/w" }] };
  const RUN_CMD = { command: "npm run dev" };

  it("sawShellExit flips only when a tool update carries a typed shell_exit", () => {
    const state = createAcpStreamState();
    reduceAcpEvent(
      state,
      update({ sessionUpdate: "tool_call", toolCallId: "t1", kind: "execute", status: "completed", content: [], rawInput: RUN_CMD }),
    );
    expect(state.sawShellExit).toBe(false);
    reduceAcpEvent(
      state,
      update({ sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed", content: [], rawOutput: SHELL_EXIT }),
    );
    expect(state.sawShellExit).toBe(true);
  });

  it("completed execute without shell_exit is background — but only after the adapter proved it emits shell_exit", () => {
    const fields = {
      toolCallId: "t1",
      title: null,
      kind: "execute",
      status: "completed",
      rawInput: RUN_CMD,
      rawOutput: undefined,
      content: [],
    };
    expect(isBackgroundConsole(fields, false)).toBe(false);
    expect(isBackgroundConsole(fields, true)).toBe(true);
    // Still in flight → not background yet.
    expect(isBackgroundConsole({ ...fields, status: "in_progress" }, true)).toBe(false);
    // Non-execute kinds never flag.
    expect(isBackgroundConsole({ ...fields, kind: "read" }, true)).toBe(false);
    // No command (edit-style rawInput) never flags.
    expect(isBackgroundConsole({ ...fields, rawInput: { fileName: "a.ts" } }, true)).toBe(false);
    // A later shell_exit un-flags it.
    expect(isBackgroundConsole({ ...fields, rawOutput: SHELL_EXIT }, true)).toBe(false);
  });

  it("shellIdOf reads only the typed field, string or number, never free text", () => {
    expect(shellIdOf(SHELL_EXIT)).toBe("7");
    expect(shellIdOf({ contents: [{ type: "shell_started", shellId: 15 }] })).toBe("15");
    expect(shellIdOf({ content: "<shellId: 9 running>" })).toBeNull();
    expect(shellIdOf(undefined)).toBeNull();
  });
});

describe("isCommandNoise", () => {
  it("matches harness bookkeeping tags, not user text", () => {
    expect(isCommandNoise("<command-name>/model</command-name>")).toBe(true);
    expect(isCommandNoise("  <local-command-stdout>ok</local-command-stdout>")).toBe(true);
    expect(isCommandNoise("<command-message>login</command-message>")).toBe(true);
    expect(isCommandNoise("fix the <command-name> parser")).toBe(false);
    expect(isCommandNoise("<commandeer the ship>")).toBe(false);
  });

  it("matches harness-injected task notifications and system reminders", () => {
    expect(
      isCommandNoise("<task-notification>\n<task-id>bfq0q3396</task-id>\n</task-notification>\nRead the output file"),
    ).toBe(true);
    expect(isCommandNoise("<system-reminder>context</system-reminder>")).toBe(true);
    expect(isCommandNoise("the <task-notification> tag is documented")).toBe(false);
  });
});

describe("stripFences", () => {
  it("drops fence-only lines, keeps content verbatim", () => {
    expect(stripFences("```\nhello\n```")).toBe("hello");
    expect(stripFences("```console\nCommand running\n```")).toBe("Command running");
    expect(stripFences("prose before\n```\ncode\n```\nprose after")).toBe(
      "prose before\ncode\nprose after",
    );
    expect(stripFences("  ```\nindented fence\n  ```")).toBe("indented fence");
  });

  it("leaves unfenced text untouched", () => {
    expect(stripFences("plain `inline` text")).toBe("plain `inline` text");
  });
});

describe("titleFromPrompt", () => {
  it("takes the first non-empty line, capped at 48 chars", () => {
    expect(titleFromPrompt("fix the login bug")).toBe("fix the login bug");
    expect(titleFromPrompt("  \n\nfix it\nplease")).toBe("fix it");
    const long = "a".repeat(60);
    expect(titleFromPrompt(long)).toBe(`${"a".repeat(47)}…`);
  });

  it("rejects slash commands, harness noise, and empties", () => {
    expect(titleFromPrompt("/model")).toBeNull();
    expect(titleFromPrompt("<command-name>/x</command-name>")).toBeNull();
    expect(titleFromPrompt("   ")).toBeNull();
  });
});
