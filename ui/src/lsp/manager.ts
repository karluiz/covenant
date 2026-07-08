// Singleton owner of LSP servers on the frontend side. Everything is
// keyed by server_id returned from lsp_start (the backend dedupes by
// (language, root)); each server gets exactly ONE LspClient so request
// ids never collide across the two StructureEditor instances.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { lspDownloadServer, lspSend, lspServerStatus, lspStart, lspStop } from "../api";
import { LspClient, type Transport } from "./client";
import { pathToUri } from "./positions";

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

const CHANGE_DEBOUNCE_MS = 200;

interface ServerEntry {
  serverId: number;
  client: LspClient;
  initialized: Promise<void>;
  openDocs: Map<string, number>; // uri → refcount
  unlisten: UnlistenFn[];
}

class TauriTransport implements Transport {
  private cb: (m: string) => void = () => {};
  constructor(private readonly serverId: number) {}
  async send(message: string): Promise<void> {
    await lspSend(this.serverId, message);
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
  private pendingText: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    readonly client: LspClient,
    readonly uri: string,
    private readonly onClose: (uri: string) => void,
  ) {}

  change(text: string): void {
    if (this.closed) return;
    this.pendingText = text;
    this.timer ??= setTimeout(() => {
      this.timer = null;
      if (this.pendingText !== null && !this.closed) {
        this.client.didChange(this.uri, this.pendingText);
        this.pendingText = null;
      }
    }, CHANGE_DEBOUNCE_MS);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.pendingText !== null) this.client.didChange(this.uri, this.pendingText);
    this.onClose(this.uri);
  }
}

class LspManager {
  /// serverId → live entry. Keyed by backend id, so backend (language,
  /// root) dedupe transparently maps two files in one workspace to one
  /// entry here.
  private servers = new Map<number, ServerEntry>();

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

  async open(path: string, text: string): Promise<LspDoc> {
    const language = lspLanguageId(path);
    if (!language) throw new Error(`no LSP language for ${path}`);
    const { serverId, root } = await lspStart(language, path);

    // ponytail: idle shutdown + LRU cap land in P2 when multiple
    // servers can be live simultaneously; P1 has exactly one language.
    let entry = this.servers.get(serverId);
    if (!entry) {
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
      entry = {
        serverId,
        client,
        initialized: client.initialize(pathToUri(root)),
        openDocs: new Map(),
        unlisten: [unMsg, unExit],
      };
      this.servers.set(serverId, entry);
    }
    await entry.initialized;

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
    const entry = this.servers.get(serverId);
    if (!entry) return;
    this.servers.delete(serverId);
    for (const un of entry.unlisten) un();
    entry.client.dispose();
    void lspStop(serverId).catch(() => {});
  }
}

export const lspManager = new LspManager();
