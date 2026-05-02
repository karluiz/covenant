// Typed wrappers around `karl-app` Tauri commands.
//
// Every command exposed by the Rust backend MUST funnel through this
// file (CLAUDE.md ts conventions). The `Channel` pattern is used for the
// per-session output stream so the frontend hands a callback to the
// backend before any bytes can be produced — no listen-before-id race.

import { Channel, invoke } from "@tauri-apps/api/core";

export type SessionId = string;

export type OutputHandler = (chunk: Uint8Array) => void;

export async function spawnSession(onOutput: OutputHandler): Promise<SessionId> {
  const channel = new Channel<number[]>();
  channel.onmessage = (data) => onOutput(new Uint8Array(data));
  return invoke<SessionId>("spawn_session", { onOutput: channel });
}

export async function writeToSession(id: SessionId, data: Uint8Array): Promise<void> {
  // Tauri serializes args via JSON. number[] deserializes cleanly into
  // Vec<u8> on the Rust side; Uint8Array → Array.from is the safe path
  // across Tauri versions.
  return invoke<void>("write_to_session", { id, data: Array.from(data) });
}

export async function resizeSession(
  id: SessionId,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke<void>("resize_session", { id, cols, rows });
}

export async function closeSession(id: SessionId): Promise<void> {
  return invoke<void>("close_session", { id });
}
