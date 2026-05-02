// Typed wrappers around `karl-app` Tauri commands.
//
// Every command exposed by the Rust backend MUST funnel through this
// file (CLAUDE.md ts conventions). Both per-session streams — raw bytes
// for xterm and parsed BlockEvents for the sidebar — are delivered via
// `Channel<T>` instances handed in at spawn time, so the frontend has
// listeners attached before any byte can be produced (no race).

import { Channel, invoke } from "@tauri-apps/api/core";

export type SessionId = string;

export type OutputHandler = (chunk: Uint8Array) => void;
export type BlockEventHandler = (event: BlockEvent) => void;

// Mirrors the serde-tagged enum in `karl_blocks::BlockEvent`. Keep in
// sync if the Rust side grows new variants.
export type BlockEvent =
  | { kind: "prompt_start" }
  | { kind: "command_submitted"; command: string }
  | { kind: "command_finished"; exit_code: number | null }
  | { kind: "cwd_changed"; path: string };

export interface SpawnHandlers {
  onOutput: OutputHandler;
  onBlockEvent: BlockEventHandler;
}

export async function spawnSession(handlers: SpawnHandlers): Promise<SessionId> {
  const outputChannel = new Channel<number[]>();
  outputChannel.onmessage = (data) => handlers.onOutput(new Uint8Array(data));

  const blockChannel = new Channel<BlockEvent>();
  blockChannel.onmessage = (event) => handlers.onBlockEvent(event);

  return invoke<SessionId>("spawn_session", {
    onOutput: outputChannel,
    onBlockEvent: blockChannel,
  });
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
