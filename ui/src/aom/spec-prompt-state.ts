import type { SpecCandidate } from "../api";

export interface TabSnapshot {
  id: string;
  cwd: string;
  hasMission: boolean;
  hasOperator: boolean;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingEntry {
  candidate: SpecCandidate;
  receivedAtMs: number;
}

export interface SpecPromptState {
  eligibleTabs(c: SpecCandidate, tabs: TabSnapshot[]): TabSnapshot[];
  recordCandidate(c: SpecCandidate, nowMs: number): void;
  dismiss(tabId: string, path: string): void;
  isDismissed(tabId: string, path: string): boolean;
  acceptOnTab(tabId: string, path: string): void;
  getPendingForTab(
    tab: TabSnapshot,
    allTabs: TabSnapshot[],
    nowMs: number,
  ): SpecCandidate[];
  onChange(cb: () => void): () => void;
  getPendingByPath(path: string): SpecCandidate | null;
}

export function createSpecPromptState(): SpecPromptState {
  const pending = new Map<string, PendingEntry>();
  const consumed = new Map<string, Set<string>>();
  const listeners = new Set<() => void>();
  const fire = () => {
    for (const cb of listeners) cb();
  };

  const isUnder = (cwd: string, root: string): boolean => {
    const norm = (p: string) => p.replace(/\/+$/, "");
    const r = norm(root);
    const c = norm(cwd);
    return c === r || c.startsWith(r + "/");
  };

  const consume = (tabId: string, path: string) => {
    let s = consumed.get(tabId);
    if (!s) {
      s = new Set();
      consumed.set(tabId, s);
    }
    s.add(path);
  };

  const state: SpecPromptState = {
    eligibleTabs(c, tabs) {
      return tabs.filter(
        (t) => isUnder(t.cwd, c.repo_root) && !t.hasMission,
      );
    },
    recordCandidate(c, nowMs) {
      pending.set(c.path, { candidate: c, receivedAtMs: nowMs });
      fire();
    },
    dismiss(tabId, path) {
      consume(tabId, path);
      fire();
    },
    isDismissed(tabId, path) {
      return consumed.get(tabId)?.has(path) ?? false;
    },
    acceptOnTab(tabId, path) {
      consume(tabId, path);
      fire();
    },
    getPendingForTab(tab, allTabs, nowMs) {
      const out: SpecCandidate[] = [];
      for (const [path, entry] of pending) {
        if (nowMs - entry.receivedAtMs > PENDING_TTL_MS) continue;
        if (consumed.get(tab.id)?.has(path)) continue;
        const elig = state
          .eligibleTabs(entry.candidate, allTabs)
          .some((t) => t.id === tab.id);
        if (!elig) continue;
        out.push(entry.candidate);
      }
      return out;
    },
    onChange(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    getPendingByPath(path) {
      return pending.get(path)?.candidate ?? null;
    },
  };
  return state;
}
