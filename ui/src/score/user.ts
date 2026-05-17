import { scoreCurrentUser, type User } from "./api";

let cached: User | null | undefined = undefined;
const listeners: Array<(u: User | null) => void> = [];

export async function getCurrentUser(force = false): Promise<User | null> {
  if (cached !== undefined && !force) return cached;
  cached = await scoreCurrentUser();
  return cached;
}

export function setCurrentUser(u: User | null): void {
  cached = u;
  for (const l of listeners) l(u);
}

export function onUserChanged(l: (u: User | null) => void): () => void {
  listeners.push(l);
  return () => {
    const i = listeners.indexOf(l);
    if (i >= 0) listeners.splice(i, 1);
  };
}
