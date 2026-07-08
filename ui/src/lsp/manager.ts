// Singleton owner of LSP servers on the frontend side. Everything is
// keyed by server_id returned from lsp_start (the backend dedupes by
// (language, root)); each server gets exactly ONE LspClient so request
// ids never collide across the two StructureEditor instances.
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ViewUpdate } from "@codemirror/view";

import {
  getSettings,
  lspDownloadServer,
  lspSend,
  lspServerStatus,
  lspStart,
  lspStop,
  setSettings,
} from "../api";
import { LspClient, type LspContentChange, type LspDiagnostic, type Transport } from "./client";
import { LruIdlePolicy } from "./lru";
import { offsetToLsp, pathToUri } from "./positions";

// Cap on simultaneously live LSP servers and how long an idle one (no
// open docs) survives before being stopped. Frontend-driven per the
// P2 design doc — the manager already tracks openDocs refcounts, so it
// alone knows when a server truly goes idle.
const LSP_SERVER_CAP = 4;
const LSP_IDLE_MS = 10 * 60 * 1000;

export type LspDocStatus =
  | { kind: "unsupported" }
  | { kind: "needs-runtime"; name: string; min: string; found: string | null }
  | { kind: "consent-needed"; name: string; approxSizeMb: number }
  | { kind: "downloading"; percent: number | null }
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export function lspLanguageId(path: string): string | null {
  if (/\.rs$/i.test(path)) return "rust";
  if (/\.cs$/i.test(path)) return "csharp";
  if (/\.java$/i.test(path)) return "java";
  // typescript-language-server handles plain JS too (incl. JSX/module
  // variants), so every one of these maps to the "typescript" server.
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(path)) return "typescript";
  return null;
}

// ---- Consent store ----------------------------------------------------
// P1 shipped consent as localStorage keys (`lsp.consent.<language>`).
// P2 moves it into the settings store (`settings.code_intelligence`) so
// it lives alongside the master + per-language toggles in the Settings
// UI. `consentState`/`grantConsentFor` are the only two entry points
// callers use; both are now async because settings access is IPC, but
// every call site was already inside an async function so this is a
// same-shape signature change, not a structural refactor.

interface CodeIntelCache {
  enabled: boolean;
  consentedLanguages: Set<string>;
}

let cache: CodeIntelCache = { enabled: true, consentedLanguages: new Set() };
let loadPromise: Promise<void> | null = null;

// Sentinel marking the one-time localStorage→settings migration as done.
// Deliberately NOT gated on `settings.code_intelligence` being absent:
// the backend field is a plain (non-Option) struct that is ALWAYS
// serialized (populated with defaults for upgrading users), so an
// absence check never fires in production. The sentinel is the only
// signal that survives that.
const MIGRATION_SENTINEL_KEY = "lsp.consent.migrated";

// ponytail: one-time migration, not a sync engine. Reads the legacy
// per-language localStorage keys, folds any "granted" ones into the
// settings-store array, and never looks at localStorage again — the
// settings store is the sole source of truth from here on.
function migrateLegacyLocalStorage(): string[] {
  const granted: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith("lsp.consent.")) continue;
    if (localStorage.getItem(key) === "granted") {
      granted.push(key.slice("lsp.consent.".length));
    }
  }
  return granted;
}

async function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const settings = await getSettings();
        let ci = settings.code_intelligence ?? { enabled: true, consented_languages: [] };
        if (localStorage.getItem(MIGRATION_SENTINEL_KEY) !== "done") {
          const granted = migrateLegacyLocalStorage();
          if (granted.length > 0) {
            // Merge — never clobber consent already recorded in the store.
            const merged = new Set([...ci.consented_languages, ...granted]);
            ci = { enabled: ci.enabled, consented_languages: [...merged] };
            await setSettings({ ...settings, code_intelligence: ci });
          }
          localStorage.setItem(MIGRATION_SENTINEL_KEY, "done");
        }
        cache = { enabled: ci.enabled, consentedLanguages: new Set(ci.consented_languages) };
      } catch (e) {
        // IPC hiccup — fall back to a safe default and let the NEXT call
        // retry instead of memoizing this rejection forever.
        cache = { enabled: true, consentedLanguages: new Set() };
        loadPromise = null;
        throw e;
      }
    })();
  }
  return loadPromise;
}

// ---- Live settings-change notification --------------------------------
// `refreshCodeIntelSettings` alone only affects the NEXT `setupLsp` call
// (i.e. the next file open) — an editor tab that already has an `LspDoc`
// open keeps it live until reopened. `onCodeIntelChange` lets an editor
// subscribe and immediately re-run `setupLsp` for whatever it currently
// has open, so disabling code intelligence (master toggle, or revoking a
// language's consent) tears down an in-progress session right away.
type CodeIntelListener = () => void;
const codeIntelListeners = new Set<CodeIntelListener>();

/// Subscribe to code-intelligence settings changes. Returns an
/// unsubscribe function. Fired at the end of `refreshCodeIntelSettings`.
export function onCodeIntelChange(cb: CodeIntelListener): () => void {
  codeIntelListeners.add(cb);
  return () => codeIntelListeners.delete(cb);
}

/// Re-reads the settings store into the cache. Called after the Settings
/// panel's Code intelligence section saves a change, so an already-open
/// editor tab picks up the new master/per-language toggle immediately.
export async function refreshCodeIntelSettings(): Promise<void> {
  loadPromise = null;
  await ensureLoaded();
  for (const cb of codeIntelListeners) cb();
}

async function persistConsent(): Promise<void> {
  const settings = await getSettings();
  await setSettings({
    ...settings,
    code_intelligence: {
      enabled: cache.enabled,
      consented_languages: [...cache.consentedLanguages],
    },
  });
}

export async function consentState(language: string): Promise<boolean> {
  await ensureLoaded();
  return cache.enabled && cache.consentedLanguages.has(language);
}

export async function grantConsentFor(language: string): Promise<void> {
  await ensureLoaded();
  if (cache.consentedLanguages.has(language)) return;
  cache.consentedLanguages.add(language);
  await persistConsent();
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
  private readonly policy = new LruIdlePolicy({
    cap: LSP_SERVER_CAP,
    idleMs: LSP_IDLE_MS,
    stop: (id) => this.dropServer(id),
  });
  // ponytail: one interval for the whole manager, not one per server —
  // started when the first server comes up, cleared once `servers` goes
  // back to empty so it never leaks past the last live server.
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private ensureSweepTimer(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.policy.sweep(Date.now()), 60_000);
  }

  private maybeClearSweepTimer(): void {
    if (this.servers.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  async status(path: string): Promise<LspDocStatus> {
    const language = lspLanguageId(path);
    if (!language) return { kind: "unsupported" };
    await ensureLoaded();
    if (!cache.enabled) return { kind: "unsupported" }; // master toggle off in Settings
    try {
      const st = await lspServerStatus(language);
      if (st.installed) return { kind: "ready" };
      // Runtime (e.g. Node for npm-installed servers) missing entirely —
      // no point walking the consent/download flow if we can't even run
      // the server once it's downloaded.
      if (st.runtimeMissing) {
        return {
          kind: "needs-runtime",
          name: st.runtimeMissing.name,
          min: st.runtimeMissing.min,
          found: st.runtimeMissing.found ?? null,
        };
      }
      if (!(await consentState(language))) {
        return { kind: "consent-needed", name: st.name, approxSizeMb: st.approxSizeMb };
      }
      // Granted but not installed yet — still needs the download flow.
      // The editor (Task 10) turns both branches into the same UI.
      return { kind: "consent-needed", name: st.name, approxSizeMb: st.approxSizeMb };
    } catch (e) {
      return { kind: "error", message: String(e) };
    }
  }

  async grantConsent(language: string): Promise<void> {
    await grantConsentFor(language);
  }

  async download(language: string, onProgress: (percent: number | null) => void): Promise<void> {
    // Two payload shapes share this event, depending on which install
    // path the backend takes: binary downloads (rust-analyzer) emit
    // byte progress `{ received, total }`; npm installs (typescript,
    // via `npm install`) are indeterminate and emit `{ message }`
    // instead. Discriminate on the `received` field's presence rather
    // than a language check — keeps this listener agnostic of which
    // languages use which install path.
    const un = await listen<{ received: number; total: number | null } | { message: string }>(
      `lsp://download/${language}`,
      (e) => {
        const payload = e.payload;
        if ("received" in payload) {
          const { received, total } = payload;
          onProgress(total ? Math.round((received / total) * 100) : null);
        } else {
          // npm install progress has no meaningful percent — render as
          // indeterminate (matches the `total === null` binary case).
          onProgress(null);
        }
      },
    );
    try {
      await lspDownloadServer(language);
    } finally {
      un();
    }
  }

  // `postInitHandshake` carries the empirically verified post-initialize
  // project-load handshake for csharp/Roslyn — `kind: "solution"` sends
  // `solution/open` (Task 3, for a `.sln`/`.slnx`), `kind: "project"` sends
  // `project/open` (Task 4, for a bare `.csproj` — `solution/open` loads
  // nothing for a csproj-only root). Sent right after `initialize` resolves
  // and before this entry is published into `this.servers`/`this.creating`
  // resolves, so it fires exactly ONCE per server regardless of how many
  // docs/racers call `open()` for the same (language, root) — never per
  // document.
  private async createEntry(
    serverId: number,
    root: string,
    postInitHandshake: { kind: string; uri: string } | null,
  ): Promise<ServerEntry> {
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
      if (postInitHandshake?.kind === "solution") client.openSolution(postInitHandshake.uri);
      else if (postInitHandshake?.kind === "project") client.openProject(postInitHandshake.uri);
    } catch (e) {
      for (const un of entry.unlisten) un();
      client.dispose();
      void lspStop(serverId).catch(() => {});
      throw e;
    }
    this.servers.set(serverId, entry);
    this.ensureSweepTimer();
    return entry;
  }

  async open(path: string, text: string): Promise<LspDoc> {
    const language = lspLanguageId(path);
    if (!language) throw new Error(`no LSP language for ${path}`);
    const { serverId, root, solutionPath, solutionKind } = await lspStart(language, path);

    let entry = this.servers.get(serverId);
    if (!entry) {
      let creating = this.creating.get(serverId);
      if (!creating) {
        // ponytail: gated to csharp — a general per-language post-init
        // hook table (like `lspLanguageId`) if more languages need one.
        const postInitHandshake =
          language === "csharp" && solutionPath && solutionKind
            ? { kind: solutionKind, uri: pathToUri(solutionPath) }
            : null;
        creating = this.createEntry(serverId, root, postInitHandshake).finally(() =>
          this.creating.delete(serverId),
        );
        this.creating.set(serverId, creating);
      }
      entry = await creating; // both racers await the SAME promise → one client
    }

    const uri = pathToUri(path);
    const refs = entry.openDocs.get(uri) ?? 0;
    if (refs === 0) entry.client.didOpen(uri, language, text);
    entry.openDocs.set(uri, refs + 1);
    this.policy.touch(serverId, Date.now());

    const fixed = entry;
    return new LspDoc(entry.client, uri, (u) => {
      const n = (fixed.openDocs.get(u) ?? 1) - 1;
      if (n <= 0) {
        fixed.openDocs.delete(u);
        fixed.client.didClose(u);
        // Last open doc on this server just closed — it's now idle.
        if (fixed.openDocs.size === 0) this.policy.release(serverId, Date.now());
      } else {
        fixed.openDocs.set(u, n);
      }
    });
  }

  private dropServer(serverId: number): void {
    this.creating.delete(serverId); // defensive: no in-flight creation should outlive a drop
    this.policy.remove(serverId);
    const entry = this.servers.get(serverId);
    if (!entry) return;
    this.servers.delete(serverId);
    for (const un of entry.unlisten) un();
    entry.client.dispose();
    void lspStop(serverId).catch(() => {});
    this.maybeClearSweepTimer();
  }
}

export const lspManager = new LspManager();
