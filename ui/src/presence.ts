// Discord Rich Presence — composes the status line from coarse app state
// and publishes it via the backend's local-IPC client. Privacy boundary:
// workspace name + session count + operator flag only; never commands,
// cwds, paths, or output.

import { discordPresenceClear, discordPresenceSet } from "./api";

export interface PresenceSnapshot {
  workspace: string | null;
  tabs: number;
  operatorLive: boolean;
}

export function composePresence(s: PresenceSnapshot): { details: string; state: string } {
  const details = s.workspace ? `In ${s.workspace}` : "In Covenant";
  const sessions = `${s.tabs} session${s.tabs === 1 ? "" : "s"}`;
  return {
    details,
    state: s.operatorLive ? `${sessions} · operator running` : sessions,
  };
}

// ponytail: 15s poll instead of event plumbing — Discord caps activity
// updates at one per 15s anyway, and a diff check makes idle ticks free.
const TICK_MS = 15_000;

let enabled = false;
let timer: number | null = null;
let lastSent: string | null = null;
let startUnixSecs = 0;
let snapshot: (() => PresenceSnapshot) | null = null;

async function tick(): Promise<void> {
  if (!enabled || !snapshot) return;
  const { details, state } = composePresence(snapshot());
  const line = `${details}\n${state}`;
  if (line === lastSent) return;
  try {
    await discordPresenceSet(details, state, startUnixSecs);
    lastSent = line;
  } catch {
    // Discord not running (or app id unset) — retry next tick.
    lastSent = null;
  }
}

/// Wire the presence loop. Call once at boot; flip on/off afterwards
/// with setDiscordPresenceEnabled (settings toggle).
export function startDiscordPresence(
  snapshotFn: () => PresenceSnapshot,
  initiallyEnabled: boolean,
): void {
  snapshot = snapshotFn;
  startUnixSecs = Math.floor(Date.now() / 1000);
  setDiscordPresenceEnabled(initiallyEnabled);
}

export function setDiscordPresenceEnabled(on: boolean): void {
  enabled = on;
  if (on) {
    if (timer === null) {
      timer = window.setInterval(() => void tick(), TICK_MS);
      void tick();
    }
  } else {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    if (lastSent !== null) {
      lastSent = null;
      void discordPresenceClear().catch(() => {});
    }
  }
}
