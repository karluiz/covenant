import { invoke } from "@tauri-apps/api/core";
import type { SpawnSpec } from "./types";

export const listSpawns = (): Promise<SpawnSpec[]> => invoke("spawns_list");
export const upsertSpawn = (spec: SpawnSpec): Promise<void> =>
  invoke("spawns_upsert", { spec });
export const deleteSpawn = (id: string): Promise<void> =>
  invoke("spawns_delete", { id });
