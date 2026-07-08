import { describe, expect, it, vi } from "vitest";
import { LspClient, type Transport } from "./client";

function mockTransport() {
  let handler: (m: string) => void = () => {};
  const sent: Array<Record<string, unknown>> = [];
  const t: Transport = {
    send: async (m) => { sent.push(JSON.parse(m)); },
    onMessage: (cb) => { handler = cb; },
    dispose: () => {},
  };
  return { t, sent, reply: (msg: object) => handler(JSON.stringify(msg)) };
}

describe("LspClient", () => {
  it("initialize sends handshake and awaits the response + sends initialized", async () => {
    const { t, sent, reply } = mockTransport();
    const c = new LspClient(t);
    const p = c.initialize("file:///repo");
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].method).toBe("initialize");
    reply({ jsonrpc: "2.0", id: sent[0].id, result: { capabilities: {} } });
    await p;
    expect(sent[1].method).toBe("initialized");
  });

  it("correlates responses by id and normalizes LocationLink[]", async () => {
    const { t, sent, reply } = mockTransport();
    const c = new LspClient(t);
    const p = c.definition("file:///a.rs", { line: 1, character: 2 });
    await vi.waitFor(() => expect(sent.length).toBe(1));
    reply({
      jsonrpc: "2.0", id: sent[0].id,
      result: [{ targetUri: "file:///b.rs", targetSelectionRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 4 } }, targetRange: { start: { line: 4, character: 0 }, end: { line: 9, character: 1 } } }],
    });
    expect(await p).toEqual([{ uri: "file:///b.rs", range: { start: { line: 5, character: 0 }, end: { line: 5, character: 4 } } }]);
  });

  it("hover extracts markdown string from MarkupContent", async () => {
    const { t, sent, reply } = mockTransport();
    const c = new LspClient(t);
    const p = c.hover("file:///a.rs", { line: 0, character: 0 });
    await vi.waitFor(() => expect(sent.length).toBe(1));
    reply({ jsonrpc: "2.0", id: sent[0].id, result: { contents: { kind: "markdown", value: "**fn** main" } } });
    expect(await p).toBe("**fn** main");
  });

  it("null result resolves to empty/null, server requests get error replies", async () => {
    const { t, sent, reply } = mockTransport();
    const c = new LspClient(t);
    const p = c.references("file:///a.rs", { line: 0, character: 0 });
    await vi.waitFor(() => expect(sent.length).toBe(1));
    // unrelated server->client request must get a MethodNotFound error back
    reply({ jsonrpc: "2.0", id: 999, method: "workspace/configuration", params: {} });
    reply({ jsonrpc: "2.0", id: sent[0].id, result: null });
    expect(await p).toEqual([]);
    await vi.waitFor(() => {
      const err = sent.find((m) => m.id === 999 && "error" in m);
      expect(err).toBeDefined();
    });
  });

  it("didChange bumps version and sends full text", async () => {
    const { t, sent } = mockTransport();
    const c = new LspClient(t);
    c.didOpen("file:///a.rs", "rust", "v1");
    c.didChange("file:///a.rs", "v2");
    await vi.waitFor(() => expect(sent.length).toBe(2));
    expect(sent[0].method).toBe("textDocument/didOpen");
    const change = sent[1] as { method: string; params: { textDocument: { version: number }; contentChanges: Array<{ text: string }> } };
    expect(change.method).toBe("textDocument/didChange");
    expect(change.params.textDocument.version).toBe(2);
    expect(change.params.contentChanges).toEqual([{ text: "v2" }]);
  });
});
