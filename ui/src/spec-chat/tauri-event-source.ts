import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { SpecEventSource, SpecStreamEvent } from './events';
import { specAuthorStreamStep } from '../api';

/** Crockford-base32 ULID-shaped id (26 chars). Sufficient for a draft id;
 *  the backend only requires a parseable ULID. */
function mintUlid(): string {
  const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const time = Date.now();
  let ts = '';
  let t = time;
  for (let i = 9; i >= 0; i--) { ts = ENC[t % 32] + ts; t = Math.floor(t / 32); }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ENC[Math.floor(Math.random() * 32)];
  return ts + rand;
}

/** Real source. For a new draft, mints the id client-side so we can subscribe
 *  to `spec://{id}/event` BEFORE the backend emits. */
export function tauriEventSource(initialDraftId: string | null): SpecEventSource {
  let currentId = initialDraftId;
  const subs = new Set<(e: SpecStreamEvent) => void>();
  let unlisten: UnlistenFn | null = null;
  let listenedId: string | null = null;

  async function ensureListening(id: string): Promise<void> {
    if (listenedId === id) return;
    if (unlisten) unlisten();
    unlisten = await listen<SpecStreamEvent>(`spec://${id}/event`, (ev) =>
      subs.forEach((cb) => cb(ev.payload)));
    listenedId = id;
  }

  return {
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    dispose() {
      if (unlisten) { unlisten(); unlisten = null; }
      listenedId = null;
      subs.clear();
    },
    async send(draftId, userMsg, cwd) {
      const id = draftId ?? currentId ?? mintUlid();
      currentId = id;
      await ensureListening(id);            // subscribe BEFORE backend emits
      await specAuthorStreamStep(id, userMsg, cwd);
      return id;
    },
  };
}
