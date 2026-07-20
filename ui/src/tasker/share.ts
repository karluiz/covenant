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
// The stale dot is the only signal auto-push is failing, and a dimmed dot
// alone doesn't say why — this backs the tooltip that carries the last error
// message for a project whose push() rejected. Cleared whenever a push
// succeeds or the share is torn down (re-shared or revoked) so a stale
// tooltip never survives past the state it describes.
const lastPushError = new Map<string, string>();
// Guards Finding 3: while a revoke for `id` is in flight, a second
// TASKER_SAVED_EVENT for the same deleted project must not fire another
// concurrent `boardApi.revoke` before the first one resolves. See onSaved.
const revokingProjects = new Set<string>();
// Finding 4: startBoardAutoPush registers a `window.addEventListener` with
// no teardown call site (the panel deliberately drops the unsubscribe — it
// lives for the app's lifetime). Production constructs exactly one
// TaskerPanel, so that's one listener. Tests construct many TaskerPanels in
// one process, so without this lock each construction piled up another
// listener closing over an orphaned test's storage. Track the live
// subscription's teardown here so a second call while one is already
// running is a no-op that just hands back the same teardown.
let autoPushTeardown: (() => void) | null = null;

/// Test-support only — NOT part of the public share API. Module-level state
/// above (sharedProjects/pushState/lastPushError/revokingProjects/
/// autoPushTeardown) persists across test files, so a leftover id from one
/// test's shared project — or a leftover live subscription bound to a dead
/// test's storage — can leak into the next test. Call this from `beforeEach`
/// so every test starts from a clean slate.
export function resetBoardShareStateForTests(): void {
  sharedProjects.clear();
  pushState.clear();
  lastPushError.clear();
  revokingProjects.clear();
  autoPushTeardown?.();
  autoPushTeardown = null;
}

function notifySharesChanged(): void {
  window.dispatchEvent(new CustomEvent(BOARD_SHARES_EVENT));
}

export function isBoardShared(projectId: string): boolean {
  return sharedProjects.has(projectId);
}

export function getPushState(projectId: string): PushState {
  return pushState.get(projectId) ?? "synced";
}

/// The message from the most recent failed push for `projectId`, or `null`
/// if the last push succeeded (or none has happened yet). Paired with
/// `getPushState` — the panel shows this in the share button's tooltip only
/// while state is `"stale"`.
export function getPushError(projectId: string): string | null {
  return lastPushError.get(projectId) ?? null;
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
    lastPushError.delete(project.id);
  } catch (err) {
    // ponytail: no retry timer — the next mutation retries. Each PUT carries
    // the whole snapshot, so a viewer only ever sees an older coherent board.
    pushState.set(project.id, "stale");
    const message = err instanceof Error ? err.message : String(err);
    lastPushError.set(project.id, message);
    // Review finding F9: `err` can carry the board's share URL (Rust's
    // orphan-revoke error path deliberately keeps it — see covenant_board.rs
    // — so the user has something to revoke manually). That URL's token is
    // the board's only access control, so never hand it to the console: log
    // the project id, not the error. The message itself still reaches the
    // user via the stale-dot tooltip (getPushError), which is a UI surface
    // the user already controls, not a log sink.
    console.error("board push failed", project.id);
  }
  notifySharesChanged();
}

export async function shareProjectBoard(project: Project): Promise<void> {
  const share = await boardApi.publish(project.id, project.name, toSnapshot(project));
  sharedProjects.add(project.id);
  pushState.set(project.id, "synced");
  lastPushError.delete(project.id);
  notifySharesChanged();
  await copyOrOffer(share.url);
}

export async function copyBoardLink(projectId: string): Promise<void> {
  const share = await boardApi.getShare(projectId);
  if (!share) {
    // Review finding F10: silently returning here means the click that
    // triggered this does nothing visible at all — tell the user instead.
    pushInfoToast({ message: "Couldn't find the board's share link — try re-sharing." });
    return;
  }
  await copyOrOffer(share.url);
}

// Serves two very different callers with one shape: a user clicking "revoke"
// awaits this directly and needs the rejection to reach the UI so it can
// show an error; the autonomous retraction pass (onSaved, below) fires this
// for a project that just got deleted and must never let a transient
// boardApi.revoke failure leave the id parked in sharedProjects — that would
// make every subsequent store mutation retry the same failing revoke
// forever, with nothing on screen to explain why. The `finally` cleans up
// local state unconditionally so retries stop either way, then the error (if
// any) still propagates: user-initiated calls can catch and surface it,
// while the autonomous caller explicitly `.catch()`es instead of `void`-ing
// the call, so a failure is logged once, not thrown as an unhandled
// rejection.
export async function revokeBoardShare(projectId: string): Promise<void> {
  try {
    await boardApi.revoke(projectId);
    pushInfoToast({ message: "Board share revoked" });
  } finally {
    sharedProjects.delete(projectId);
    pushState.delete(projectId);
    lastPushError.delete(projectId);
    notifySharesChanged();
  }
}

/// Subscribe to store writes and re-publish every shared board, debounced.
/// Returns an unsubscribe function. Idempotent at module level — a second
/// call while a subscription is already live does not add another listener;
/// it just returns the existing teardown so callers can still invoke it
/// safely (see Finding 4).
export function startBoardAutoPush(storage: TaskStorage): () => void {
  if (autoPushTeardown) return autoPushTeardown;

  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (projectId: string): void => {
    const existing = timers.get(projectId);
    if (existing) clearTimeout(existing);
    timers.set(
      projectId,
      setTimeout(() => {
        timers.delete(projectId);
        // Finding 1: a revoke inside the debounce window cannot reach into
        // this closure to cancel the timer, so this callback is the only
        // place left to notice the share died. Without this guard, the
        // timer fires `boardApi.publish` for a project the Rust side no
        // longer has a share record for, which takes the first-publish path
        // and mints a brand new board at a token nothing in the app knows
        // about — a live, unrevokable link.
        if (!sharedProjects.has(projectId)) return;
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
    //
    // Finding 5: this for-of iterates `sharedProjects` while
    // revokeBoardShare's `finally` mutates that same Set via `.delete()`.
    // That's safe today only because the delete happens after the `await
    // boardApi.revoke(...)` inside revokeBoardShare — i.e. strictly after
    // this synchronous for-of loop has already finished walking the Set. If
    // this ever becomes optimistic (removing `id` before the network call
    // resolves), it would mutate the Set mid-iteration and silently skip or
    // revisit entries — keep the removal post-await.
    for (const id of sharedProjects) {
      if (idSet.has(id)) continue;
      // Finding 3: a second TASKER_SAVED_EVENT can arrive for the same
      // deleted project before the first revoke resolves (sharedProjects
      // isn't touched until after the await). Track in-flight revokes
      // separately so we don't fire a second concurrent boardApi.revoke.
      if (revokingProjects.has(id)) continue;
      if (storage.getProject(id) === null) {
        revokingProjects.add(id);
        revokeBoardShare(id)
          .catch((err) => {
            // Finding 2: autonomous retraction must not spin forever
            // silently, but it also must not throw an unhandled rejection —
            // log once and move on. Local state was already cleaned up by
            // revokeBoardShare's `finally`, so this id won't be retried.
            console.error("autonomous board revoke failed", err);
          })
          .finally(() => {
            revokingProjects.delete(id);
          });
      }
    }
  };

  window.addEventListener(TASKER_SAVED_EVENT, onSaved);

  // Reconcile whatever changed while the app was closed.
  void boardApi
    .listShares()
    .then((ids) => {
      for (const id of ids) {
        sharedProjects.add(id);
        const project = storage.getProject(id);
        if (project) void push(project);
      }
      if (ids.length > 0) notifySharesChanged();
    })
    .catch((err) => {
      // Transient failure (e.g. server unreachable at startup) — the next
      // TASKER_SAVED_EVENT or app restart retries via listShares() again.
      console.error("board share reconcile failed", err);
    });

  const teardown = (): void => {
    window.removeEventListener(TASKER_SAVED_EVENT, onSaved);
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    autoPushTeardown = null;
  };
  autoPushTeardown = teardown;
  return teardown;
}
