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
  markPermAnswered,
  reduceAcpEvent,
  type AcpNoticeItem,
  type AcpPermItem,
  type AcpProseItem,
  type AcpToolItem,
} from "./view";
import type { AcpPermissionRequest, AcpSessionUpdate, AcpTabEvent } from "../../api";

function update(su: AcpSessionUpdate): AcpTabEvent {
  return { type: "update", update: { sessionId: "s1", update: su } };
}

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

  it("prompt_done flips inFlight to false and appends a divider notice with the stop reason", () => {
    const state = createAcpStreamState();
    state.inFlight = true;
    reduceAcpEvent(state, { type: "prompt_done", stopReason: "end_turn" });

    expect(state.inFlight).toBe(false);
    expect(state.items).toHaveLength(1);
    const notice = state.items[0] as AcpNoticeItem;
    expect(notice.kind).toBe("notice");
    expect(notice.variant).toBe("divider");
    expect(notice.text).toContain("end_turn");
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
