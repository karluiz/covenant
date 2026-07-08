// Singleton owner of LSP servers on the frontend side. Everything is
// keyed by server_id returned from lsp_start (the backend dedupes by
// (language, root)); each server gets exactly ONE LspClient so request
// ids never collide across the two StructureEditor instances.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ViewUpdate } from "@codemirror/view";

import { lspDownloadServer, lspSend, lspServerStatus, lspStart, lspStop } from "../api";
import { LspClient, type LspContentChange, type LspDiagnostic, type Transport } from "./client";
import { offsetToLsp, pathToUri } from "./positions";

export type LspDocStatus =
  | { kind: "unsupported" }
  | { kind: "consent-needed"; name: string; approxSizeMb: number }
  | { kind: "downloading"; percent: number | null }
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export function lspLanguageId(path: string): string | null {
  // ponytail: P1 = rust only; TS/C#/Java extend this table in P3-P5.
  return /\.rs$/i.test(path) ? "rust" : null;
}

export function consentState(language: string): boolean {
  // ponytail: localStorage until the P2 Settings section lands.
  return localStorage.getItem(`lsp.consent.${language}`) === "granted";
}

export function grantConsentFor(language: string): void {
  localStorage.setItem(`lsp.consent.${language}`, "granted");
}

interface ServerEntry {
  serverId: number;
  client: LspClient;
  openDocs: Map<string, number>; // uri → refcount
  unlisten: UnlistenFn[];
}

class TauriTransport implements Transport {
  private cb: (m: string) => void = () => {};
  constructor(private readonly serverId: number) {}
  async send(message: string): Promise<void> {
    try {
      await lspSend(this.serverId, message);
    } catch {
      // server already stopped — nothing left to deliver to.
    }
  }
  onMessage(cb: (message: string) => void): void {
    this.cb = cb;
  }
  deliver(message: string): void {
    this.cb(message);
  }
  dispose(): void {
    this.cb = () => {};
  }
}

export class LspDoc {
  private closed = false;

  constructor(
    readonly client: LspClient,
    readonly uri: string,
    private readonly onClose: (uri: string) => void,
  ) {}

  // Maps a CM6 `ViewUpdate` to incremental LSP content changes and
  // sends them immediately.
  //
  // `update.changes.iterChanges` yields non-overlapping edits in
  // ascending document-offset order, all expressed in
  // `update.startState.doc` (pre-transaction) coordinates. LSP applies
  // `contentChanges` array entries SEQUENTIALLY — each one mutates the
  // document before the next is applied — so sending our ranges in
  // that same ascending order would be wrong: an earlier edit shifts
  // every offset after it, invalidating later ranges that were
  // computed against the ORIGINAL doc. Reversing to descending order
  // fixes this: applying the rightmost edit first never touches
  // anything to its left, so every remaining range's start-state
  // coordinates are still valid when its turn comes.
  changeIncremental(update: ViewUpdate): void {
    if (this.closed) return;
    const changes: LspContentChange[] = [];
    update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      changes.push({
        range: { start: offsetToLsp(update.startState.doc, fromA), end: offsetToLsp(update.startState.doc, toA) },
        text: inserted.toString(),
      });
    });
    if (changes.length === 0) return;
    changes.reverse();
    // ponytail: no debounce here — each CM6 transaction is sent as its
    // own didChange immediately. The 200ms batching this replaced
    // existed to amortize full-document re-sync cost; incremental
    // ranged deltas are cheap enough that rust-analyzer (and LSP
    // servers generally) handle per-keystroke didChange fine.
    this.client.didChange(this.uri, changes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this.uri);
  }

  // ponytail: thin filter over the shared client's broadcast stream —
  // verified via cm6 + manual, no dedicated unit test.
  onDiagnostics(cb: (diags: LspDiagnostic[]) => void): () => void {
    return this.client.onDiagnostics((uri, diags) => {
      if (uri === this.uri) cb(diags);
    });
  }
}

class LspManager {
  /// serverId → live entry. Keyed by backend id, so backend (language,
  /// root) dedupe transparently maps two files in one workspace to one
  /// entry here.
  private servers = new Map<number, ServerEntry>();
  // In-flight entry creation, keyed by serverId, so concurrent open()
  // calls for the same server race onto ONE creation instead of each
  // building its own LspClient (see module docstring).
  private creating = new Map<number, Promise<ServerEntry>>();

  async status(path: string): Promise<LspDocStatus> {
    const language = lspLanguageId(path);
    if (!language) return { kind: "unsupported" };
    try {
      const st = await lspServerStatus(language);
      if (st.installed) return { kind: "ready" };
      if (!consentState(language)) {
        return { kind: "consent-needed", name: st.name, approxSizeMb: st.approxSizeMb };
      }
      // Granted but not installed yet — still needs the download flow.
      // The editor (Task 10) turns both branches into the same UI.
      return { kind: "consent-needed", name: st.name, approxSizeMb: st.approxSizeMb };
    } catch (e) {
      return { kind: "error", message: String(e) };
    }
  }

  grantConsent(language: string): void {
    grantConsentFor(language);
  }

  async download(language: string, onProgress: (percent: number | null) => void): Promise<void> {
    const un = await listen<{ received: number; total: number | null }>(
      `lsp://download/${language}`,
      (e) => {
        const { received, total } = e.payload;
        onProgress(total ? Math.round((received / total) * 100) : null);
      },
    );
    try {
      await lspDownloadServer(language);
    } finally {
      un();
    }
  }

  private async createEntry(serverId: number, root: string): Promise<ServerEntry> {
    const transport = new TauriTransport(serverId);
    const client = new LspClient(transport);
    const unMsg = await listen<string>(`lsp://${serverId}/message`, (e) => {
      transport.deliver(e.payload);
    });
    const unExit = await listen<null>(`lsp://${serverId}/exit`, () => {
      // ponytail: no auto-restart in P1 — drop the entry; the next
      // open() spawns fresh. P2 adds restart-once policy per spec.
      this.dropServer(serverId);
    });
    const entry: ServerEntry = { serverId, client, openDocs: new Map(), unlisten: [unMsg, unExit] };
    try {
      await client.initialize(pathToUri(root));
    } catch (e) {
      for (const un of entry.unlisten) un();
      client.dispose();
      void lspStop(serverId).catch(() => {});
      throw e;
    }
    this.servers.set(serverId, entry);
    return entry;
  }

  async open(path: string, text: string): Promise<LspDoc> {
    const language = lspLanguageId(path);
    if (!language) throw new Error(`no LSP language for ${path}`);
    const { serverId, root } = await lspStart(language, path);

    // ponytail: idle shutdown + LRU cap land in P2 when multiple
    // servers can be live simultaneously; P1 has exactly one language.
    let entry = this.servers.get(serverId);
    if (!entry) {
      let creating = this.creating.get(serverId);
      if (!creating) {
        creating = this.createEntry(serverId, root).finally(() => this.creating.delete(serverId));
        this.creating.set(serverId, creating);
      }
      entry = await creating; // both racers await the SAME promise → one client
    }

    const uri = pathToUri(path);
    const refs = entry.openDocs.get(uri) ?? 0;
    if (refs === 0) entry.client.didOpen(uri, language, text);
    entry.openDocs.set(uri, refs + 1);

    const fixed = entry;
    return new LspDoc(entry.client, uri, (u) => {
      const n = (fixed.openDocs.get(u) ?? 1) - 1;
      if (n <= 0) {
        fixed.openDocs.delete(u);
        fixed.client.didClose(u);
      } else {
        fixed.openDocs.set(u, n);
      }
    });
  }

  private dropServer(serverId: number): void {
    this.creating.delete(serverId); // defensive: no in-flight creation should outlive a drop
    const entry = this.servers.get(serverId);
    if (!entry) return;
    this.servers.delete(serverId);
    for (const un of entry.unlisten) un();
    entry.client.dispose();
    void lspStop(serverId).catch(() => {});
  }
}

export const lspManager = new LspManager();
