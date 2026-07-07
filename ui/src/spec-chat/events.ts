export type SpecSectionKey =
  | 'goal' | 'out_of_scope' | 'acceptance' | 'file_boundaries' | 'complexity' | 'open_questions';

export interface QuestionOption { label: string; detail?: string }

export type SpecStreamEvent =
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_start'; id: string; tool: string; arg: string }
  | { kind: 'tool_result'; id: string; summary: string; ok: boolean }
  | { kind: 'section_update'; section: SpecSectionKey; markdown: string; status: 'filling' | 'done' }
  | { kind: 'phase'; section: SpecSectionKey }
  | { kind: 'turn_done'; awaiting_user: boolean }
  | { kind: 'question'; question: string; options: QuestionOption[] }
  | { kind: 'final'; markdown: string }
  | { kind: 'error'; message: string };

/** A composer attachment on its way to the backend (base64, no data: prefix). */
export interface OutgoingImage { dataB64: string; mediaType: string }

/** Abstraction over the event channel so the UI is testable without Tauri. */
export interface SpecEventSource {
  /** Start a turn; events arrive via the callback registered in `subscribe`.
   *  Resolves with the draft id once the turn completes. */
  send(draftId: string | null, userMsg: string, cwd: string | null, images?: OutgoingImage[]): Promise<string>;
  subscribe(cb: (e: SpecStreamEvent) => void): () => void;
  /** Tear down any underlying transport listeners. Optional for in-memory sources. */
  dispose?(): void;
}

/** In-memory source that replays a scripted event list — for tests + manual preview. */
export function mockEventSource(script: SpecStreamEvent[], delayMs = 0): SpecEventSource {
  const subs = new Set<(e: SpecStreamEvent) => void>();
  return {
    subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
    async send() {
      for (const e of script) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        subs.forEach((cb) => cb(e));
      }
      return 'mock-draft-id';
    },
  };
}
