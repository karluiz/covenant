import { invoke } from "@tauri-apps/api/core";
import { pushInfoToast } from "../notifications/toast";
import { copyText } from "../ui/clipboard";
import { toSnapshot } from "./snapshot";
import { TASKER_SAVED_EVENT } from "./storage";
import type { TaskStorage } from "./storage";
import type { Project } from "./types";

export interface BoardShare {
  boardId: number;
  token: string;
  url: string;
}

export const boardApi = {
  getShare: (projectId: string) =>
    invoke<BoardShare | null>("board_get_share", { projectId }),
  listShares: () => invoke<string[]>("board_list_shares"),
  publish: (projectId: string, title: string, payload: unknown) =>
    invoke<BoardShare>("board_publish", { projectId, title, payload }),
  revoke: (projectId: string) => invoke<void>("board_revoke", { projectId }),
};

export const PUSH_DEBOUNCE_MS = 2000;
export const BOARD_SHARES_EVENT = "covenant:board-shares-changed";

export type PushState = "synced" | "pushing" | "stale";

const sharedProjects = new Set<string>();
const pushState = new Map<string, PushState>();
let sharesLoaded = false;

function notifySharesChanged(): void {
  window.dispatchEvent(new CustomEvent(BOARD_SHARES_EVENT));
}

export function isBoardShared(projectId: string): boolean {
  return sharedProjects.has(projectId);
}

export function getPushState(projectId: string): PushState {
  return pushState.get(projectId) ?? "synced";
}

/// Idempotent — first caller triggers the fetch, later calls no-op.
export function ensureBoardSharesLoaded(): void {
  if (sharesLoaded) return;
  sharesLoaded = true;
  void boardApi
    .listShares()
    .then((ids) => {
      for (const id of ids) sharedProjects.add(id);
      if (ids.length > 0) notifySharesChanged();
    })
    .catch(() => {
      sharesLoaded = false; // transient failure — retry on next call
    });
}

/// Copy, and if the webview refuses (transient activation is gone after the
/// network round-trip), fall back to a toast the user clicks — that click IS
/// a fresh user gesture, so the retry succeeds.
async function copyOrOffer(url: string): Promise<void> {
  try {
    await copyText(url);
    pushInfoToast({ message: "Board link copied" });
  } catch {
    pushInfoToast({
      message: `Board shared — click to copy: ${url}`,
      onClick: () => {
        void copyText(url);
      },
    });
  }
}

async function push(project: Project): Promise<void> {
  pushState.set(project.id, "pushing");
  notifySharesChanged();
  try {
    await boardApi.publish(project.id, project.name, toSnapshot(project));
    pushState.set(project.id, "synced");
  } catch (err) {
    // ponytail: no retry timer — the next mutation retries. Each PUT carries
    // the whole snapshot, so a viewer only ever sees an older coherent board.
    pushState.set(project.id, "stale");
    console.error("board push failed", err);
  }
  notifySharesChanged();
}

export async function shareProjectBoard(project: Project): Promise<void> {
  const share = await boardApi.publish(project.id, project.name, toSnapshot(project));
  sharedProjects.add(project.id);
  pushState.set(project.id, "synced");
  notifySharesChanged();
  await copyOrOffer(share.url);
}

export async function copyBoardLink(projectId: string): Promise<void> {
  const share = await boardApi.getShare(projectId);
  if (!share) return;
  await copyOrOffer(share.url);
}

export async function revokeBoardShare(projectId: string): Promise<void> {
  await boardApi.revoke(projectId);
  sharedProjects.delete(projectId);
  pushState.delete(projectId);
  notifySharesChanged();
  pushInfoToast({ message: "Board share revoked" });
}

/// Subscribe to store writes and re-publish every shared board, debounced.
/// Returns an unsubscribe function.
export function startBoardAutoPush(storage: TaskStorage): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (projectId: string): void => {
    const existing = timers.get(projectId);
    if (existing) clearTimeout(existing);
    timers.set(
      projectId,
      setTimeout(() => {
        timers.delete(projectId);
        const project = storage.getProject(projectId);
        if (project) void push(project);
      }, PUSH_DEBOUNCE_MS),
    );
  };

  const onSaved = (e: Event): void => {
    const ids = (e as CustomEvent<{ projectIds: string[] }>).detail.projectIds;
    const idSet = new Set(ids);
    for (const id of ids) {
      if (sharedProjects.has(id)) schedule(id);
    }

    // `projectIds` is a live snapshot of non-archived projects, not a diff —
    // a shared project that dropped out of it either got deleted or merely
    // archived, and `getProject()` is the only way to tell them apart
    // (`getProjects()`, which built `projectIds`, filters archived out;
    // `getProject()` does not). Archiving is reversible declutter, not
    // deletion — the shared board must survive an archive/unarchive round
    // trip, so that branch is deliberately spared: no revoke, no push.
    // Only a genuine deletion (project gone from the store entirely) tears
    // the share down, so the link dies with the project instead of serving
    // a stale board forever.
    for (const id of sharedProjects) {
      if (idSet.has(id)) continue;
      if (storage.getProject(id) === null) {
        void revokeBoardShare(id);
      }
    }
  };

  window.addEventListener(TASKER_SAVED_EVENT, onSaved);

  // Reconcile whatever changed while the app was closed.
  void boardApi.listShares().then((ids) => {
    for (const id of ids) {
      sharedProjects.add(id);
      const project = storage.getProject(id);
      if (project) void push(project);
    }
    if (ids.length > 0) notifySharesChanged();
  });

  return () => {
    window.removeEventListener(TASKER_SAVED_EVENT, onSaved);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}
