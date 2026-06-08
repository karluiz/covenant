import type { SpecStreamEvent, SpecSectionKey } from './events';

export interface ToolActivity { id: string; tool: string; arg: string; summary?: string; ok?: boolean; }
export interface SectionView { markdown: string; status: 'filling' | 'done'; }
export interface ConvMessage { role: 'user' | 'assistant'; content: string; }

export interface StreamState {
  apply(e: SpecStreamEvent): void;
  /** Record the user's submitted message and reset live activity for the new turn. */
  addUserMessage(text: string): void;
  /** Restore a persisted draft: prior conversation turns and, if the draft was
   *  already complete, its final markdown (so publish is immediately available). */
  hydrate(data: { messages: readonly ConvMessage[]; finalMarkdown?: string | null }): void;
  /** Committed conversation turns (user + assistant), oldest first. */
  messages(): readonly ConvMessage[];
  activePhase(): SpecSectionKey | null;
  thinking(): string;
  /** Assistant prose streaming in the current turn (uncommitted). */
  text(): string;
  tools(): readonly ToolActivity[];
  section(k: SpecSectionKey): SectionView | null;
  awaitingUser(): boolean;
  finalMarkdown(): string | null;
  ready(): boolean;
  error(): string | null;
  onChange(cb: () => void): () => void;
}

export function createStreamState(): StreamState {
  let phase: SpecSectionKey | null = null;
  let thinking = '';
  let text = '';
  const tools: ToolActivity[] = [];
  const sections = new Map<SpecSectionKey, SectionView>();
  let awaiting = false;
  let finalMd: string | null = null;
  let err: string | null = null;
  const messages: ConvMessage[] = [];
  const subs = new Set<() => void>();
  const fire = () => subs.forEach((cb) => cb());

  // Commit any streamed assistant prose as a conversation turn. The live `text`
  // accumulator is cleared so the committed bubble isn't duplicated; thinking
  // and tools stay visible until the user sends the next message.
  const commitAssistant = () => {
    if (text.trim()) messages.push({ role: 'assistant', content: text });
    text = '';
  };

  return {
    apply(e) {
      switch (e.kind) {
        case 'phase': phase = e.section; break;
        case 'thinking_delta': thinking += e.text; break;
        case 'text_delta': text += e.text; break;
        case 'tool_start': tools.push({ id: e.id, tool: e.tool, arg: e.arg }); break;
        case 'tool_result': {
          const t = tools.find((x) => x.id === e.id);
          if (t) { t.summary = e.summary; t.ok = e.ok; }
          break;
        }
        case 'section_update': sections.set(e.section, { markdown: e.markdown, status: e.status }); break;
        case 'turn_done': awaiting = e.awaiting_user; commitAssistant(); break;
        case 'final': finalMd = e.markdown; commitAssistant(); break;
        case 'error': err = e.message; break;
      }
      fire();
    },
    addUserMessage(t: string) {
      messages.push({ role: 'user', content: t });
      // Fresh activity for the new turn.
      text = '';
      thinking = '';
      tools.length = 0;
      err = null;
      awaiting = false;
      fire();
    },
    hydrate(data) {
      messages.length = 0;
      for (const m of data.messages) messages.push({ role: m.role, content: m.content });
      if (data.finalMarkdown != null) finalMd = data.finalMarkdown;
      fire();
    },
    messages: () => messages,
    activePhase: () => phase,
    thinking: () => thinking,
    text: () => text,
    tools: () => tools,
    section: (k) => sections.get(k) ?? null,
    awaitingUser: () => awaiting,
    finalMarkdown: () => finalMd,
    ready: () => finalMd != null,
    error: () => err,
    onChange(cb) { subs.add(cb); return () => subs.delete(cb); },
  };
}
