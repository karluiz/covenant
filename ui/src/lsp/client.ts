// Thin LSP client: JSON-RPC correlation + the handful of methods P1
// needs. Deliberately not codemirror-languageserver — that package
// lacks definition/references, so this is the spec's "fork" clause.
import type { LspPosition } from "./positions";

export interface Transport {
  send(message: string): Promise<void>;
  onMessage(cb: (message: string) => void): void;
  dispose(): void;
}

export interface LspLocation {
  uri: string;
  range: { start: LspPosition; end: LspPosition };
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 10_000;

export class LspClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private versions = new Map<string, number>();
  private disposed = false;

  constructor(private readonly transport: Transport) {
    transport.onMessage((raw) => this.handleMessage(raw));
  }

  async initialize(rootUri: string): Promise<void> {
    await this.request("initialize", {
      processId: null,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: rootUri.split("/").pop() ?? "root" }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          references: {},
          synchronization: { didSave: true },
        },
      },
    });
    this.notify("initialized", {});
  }

  didOpen(uri: string, languageId: string, text: string): void {
    this.versions.set(uri, 1);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
  }

  // ponytail: full-text sync; incremental didChange lands with P2's
  // diagnostics work where change granularity starts to matter.
  didChange(uri: string, text: string): void {
    const version = (this.versions.get(uri) ?? 1) + 1;
    this.versions.set(uri, version);
    this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  didClose(uri: string): void {
    this.versions.delete(uri);
    this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  async definition(uri: string, pos: LspPosition): Promise<LspLocation[]> {
    const r = await this.request("textDocument/definition", {
      textDocument: { uri },
      position: pos,
    });
    return normalizeLocations(r);
  }

  async hover(uri: string, pos: LspPosition): Promise<string | null> {
    const r = (await this.request("textDocument/hover", {
      textDocument: { uri },
      position: pos,
    })) as { contents?: unknown } | null;
    if (!r?.contents) return null;
    return markupToString(r.contents);
  }

  async references(uri: string, pos: LspPosition): Promise<LspLocation[]> {
    const r = await this.request("textDocument/references", {
      textDocument: { uri },
      position: pos,
      context: { includeDeclaration: true },
    });
    return normalizeLocations(r);
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("lsp client disposed"));
    }
    this.pending.clear();
    this.transport.dispose();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    void this.transport.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`lsp timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.disposed) return;
    void this.transport.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  private handleMessage(raw: string): void {
    if (this.disposed) return;
    let msg: { id?: number; method?: string; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return; // malformed — drop, never crash the pump
    }
    if (msg.id !== undefined && msg.method === undefined) {
      // Response to one of our requests.
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? "lsp error"));
      else p.resolve(msg.result ?? null);
    } else if (msg.id !== undefined && msg.method !== undefined) {
      // Server→client request. P1 supports none — decline politely so
      // the server doesn't hang awaiting a reply.
      void this.transport.send(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        error: { code: -32601, message: `method not supported: ${msg.method}` },
      }));
    }
    // Server notifications (publishDiagnostics etc.) — ignored until P2.
  }
}

function normalizeLocations(r: unknown): LspLocation[] {
  if (!r) return [];
  const arr = Array.isArray(r) ? r : [r];
  return arr.flatMap((item) => {
    const link = item as { targetUri?: string; targetSelectionRange?: LspLocation["range"] };
    if (link.targetUri && link.targetSelectionRange) {
      return [{ uri: link.targetUri, range: link.targetSelectionRange }];
    }
    const loc = item as { uri?: string; range?: LspLocation["range"] };
    if (loc.uri && loc.range) return [{ uri: loc.uri, range: loc.range }];
    return [];
  });
}

function markupToString(contents: unknown): string | null {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    const parts = contents.map((c) => markupToString(c)).filter((s): s is string => !!s);
    return parts.length ? parts.join("\n\n") : null;
  }
  const m = contents as { value?: string };
  return typeof m.value === "string" ? m.value : null;
}
