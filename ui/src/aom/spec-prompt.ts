import {
  specDetectorApi,
  subscribeSpecCandidates,
  type SpecCandidate,
} from "../api";
import {
  createSpecPromptState,
  type SpecPromptState,
  type TabSnapshot,
} from "./spec-prompt-state";

/** Provided by the host (main.ts wires this from TabManager). */
export interface SpecPromptHost {
  listTabs(): TabSnapshot[];
  setMissionForTab(tabId: string, path: string): Promise<void>;
}

let stateSingleton: SpecPromptState | null = null;
let unlisten: (() => void) | null = null;
let hostRef: SpecPromptHost | null = null;
const startedRoots = new Set<string>();

const TOAST_TIMEOUT_MS = 30_000;
const STACK_ID = "spec-prompt-stack";

export function getSpecPromptState(): SpecPromptState {
  if (!stateSingleton) stateSingleton = createSpecPromptState();
  return stateSingleton;
}

/** Mount the listener once at boot; safe to call multiple times. */
export async function startSpecPrompts(host: SpecPromptHost) {
  hostRef = host;
  if (unlisten) return;
  unlisten = await subscribeSpecCandidates((cand) => onCandidate(cand));
}

/** Idempotent: starts a backend detector for the given repo root. */
export async function ensureDetectorForRepo(repoRoot: string) {
  if (!repoRoot || startedRoots.has(repoRoot)) return;
  startedRoots.add(repoRoot);
  try {
    await specDetectorApi.start(repoRoot);
  } catch (e) {
    startedRoots.delete(repoRoot);
    console.error("specDetectorApi.start failed", repoRoot, e);
  }
}

/** Used by Task 11 (Engage AOM last-call modal). */
export function getPendingSpecCandidateForTab(tabId: string): SpecCandidate | null {
  if (!hostRef) return null;
  const tabs = hostRef.listTabs();
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  const pending = getSpecPromptState().getPendingForTab(tab, tabs, Date.now());
  return pending[0] ?? null;
}

function onCandidate(cand: SpecCandidate) {
  const state = getSpecPromptState();
  const host = hostRef;
  if (!host) return;
  state.recordCandidate(cand, Date.now());
  const tabs = host.listTabs();
  for (const tab of state.eligibleTabs(cand, tabs)) {
    if (state.isDismissed(tab.id, cand.path)) continue;
    renderToast(host, tab, cand);
  }
}

function getStack(): HTMLElement {
  let stack = document.getElementById(STACK_ID);
  if (!stack) {
    stack = document.createElement("div");
    stack.id = STACK_ID;
    document.body.appendChild(stack);
  }
  return stack;
}

function renderToast(host: SpecPromptHost, tab: TabSnapshot, cand: SpecCandidate) {
  const stack = getStack();
  const el = document.createElement("div");
  el.className = "spec-prompt-toast";
  el.dataset.tabId = tab.id;
  el.dataset.path = cand.path;
  const label =
    cand.source === "covenant" ? "Mission published" : "New spec detected";
  const fileName = cand.path.split("/").pop() ?? cand.path;
  el.innerHTML = `
    <div class="spec-prompt-toast-head">
      <span class="spec-prompt-toast-label">${escapeHtml(label)}</span>
      <span class="spec-prompt-toast-file">${escapeHtml(fileName)}</span>
    </div>
    <div class="spec-prompt-toast-snippet">${escapeHtml(cand.goal_snippet)}</div>
    <div class="spec-prompt-toast-actions">
      <button type="button" class="spec-prompt-toast-set">Set as mission</button>
      <button type="button" class="spec-prompt-toast-dismiss">Dismiss</button>
    </div>
  `;
  stack.appendChild(el);

  const close = () => {
    el.remove();
  };
  const timer = setTimeout(() => {
    getSpecPromptState().dismiss(tab.id, cand.path);
    close();
  }, TOAST_TIMEOUT_MS);

  el.querySelector(".spec-prompt-toast-set")!.addEventListener("click", async () => {
    clearTimeout(timer);
    getSpecPromptState().acceptOnTab(tab.id, cand.path);
    try {
      await host.setMissionForTab(tab.id, cand.path);
    } catch (e) {
      console.error("setMissionForTab failed", e);
    }
    close();
  });
  el.querySelector(".spec-prompt-toast-dismiss")!.addEventListener("click", () => {
    clearTimeout(timer);
    getSpecPromptState().dismiss(tab.id, cand.path);
    close();
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
