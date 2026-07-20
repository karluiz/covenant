import type { SpecStreamEvent, SpecSectionKey, QuestionOption } from './events';
import { parsePersistedTranscript } from './transcript';
import { SECTIONS, parseSectionsFromMarkdown, parseSectionMarkers, stripLeadingHeading } from './sections';

export interface ToolActivity { id: string; tool: string; arg: string; summary?: string; ok?: boolean; }
export interface SectionView { markdown: string; status: 'filling' | 'done'; }
export interface ConvMessage { role: 'user' | 'assistant'; content: string; previews?: string[]; }
/** A historical tool call reconstructed from a resumed transcript — rendered
 *  inline as a chip mirroring the live one (verb · arg · hit). */
export interface ToolChip { role: 'tool'; tool: string; arg?: string; summary?: string; }
/** An ask_user question. `answered` disables its chips once the user replied. */
export interface QuestionCard { role: 'question'; question: string; options: QuestionOption[]; answered: boolean; }
export type TimelineItem = ConvMessage | ToolChip | QuestionCard;

export interface StreamState {
  apply(e: SpecStreamEvent): void;
  /** Record the user's submitted message and reset live activity for the new
   *  turn. `previews` are data/blob URLs of any attached image thumbnails. */
  addUserMessage(text: string, previews?: string[]): void;
  /** Restore a persisted draft: prior conversation turns and, if the draft was
   *  already complete, its final markdown (so publish is immediately available). */
  hydrate(data: { messages: readonly ConvMessage[]; markdown?: string | null; finalMarkdown?: string | null }): void;
  /** Overwrite a section's body (user edit). Returns the rebuilt canonical
   *  spec markdown (all known sections, in order) for persistence. */
  editSection(key: SpecSectionKey, markdown: string): string;
  /** Committed timeline (user + assistant turns, plus tool chips on resume),
   *  oldest first. */
  messages(): readonly TimelineItem[];
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

/** Compose whatever sections currently have content — for live scoring of a
 *  partial draft. Unlike finalMarkdown() this never returns null. */
export function composePartialMarkdown(state: Pick<StreamState, 'section'>): string {
  return SECTIONS.map((s) => {
    const v = state.section(s.key);
    const md = v?.markdown.trim();
    return md ? `## ${s.title}\n\n${md}` : '';
  })
    .filter(Boolean)
    .join('\n\n');
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
  const messages: TimelineItem[] = [];
  const subs = new Set<() => void>();
  const fire = () => subs.forEach((cb) => cb());

  const rebuildMarkdown = () =>
    SECTIONS.filter((s) => sections.has(s.key))
      .map((s) => `## ${s.title}\n\n${sections.get(s.key)!.markdown}`)
      .join('\n\n');

  // Every section authored → the spec is self-sufficiently publishable from the
  // section cards, even if the agent never emitted an explicit `final` block.
  const allSectionsDone = () =>
    SECTIONS.every((s) => sections.get(s.key)?.status === 'done');

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
        case 'section_update': sections.set(e.section, { markdown: stripLeadingHeading(e.markdown), status: e.status }); break;
        case 'question':
          commitAssistant();
          messages.push({ role: 'question', question: e.question, options: e.options, answered: false });
          break;
        case 'turn_done': awaiting = e.awaiting_user; commitAssistant(); break;
        case 'final': finalMd = e.markdown; commitAssistant(); break;
        case 'error': err = e.message; break;
      }
      fire();
    },
    addUserMessage(t: string, previews?: string[]) {
      // Answering closes any pending question card (chips go inert).
      for (const m of messages) {
        if (m.role === 'question' && !m.answered) m.answered = true;
      }
      messages.push(
        previews && previews.length
          ? { role: 'user', content: t, previews }
          : { role: 'user', content: t },
      );
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
      for (const item of parsePersistedTranscript(data.messages)) messages.push(item);
      // Rebuild section cards: prefer the persisted spec (partial_md, which holds
      // any user edits), then fall back to the section markers in the transcript
      // for drafts that were authored via markers but never persisted partial_md.
      const fromMd = parseSectionsFromMarkdown(data.markdown ?? null);
      const fromTranscript = new Map<SpecSectionKey, SectionView>();
      for (const m of data.messages) {
        if (m.role !== 'assistant') continue;
        for (const { key, markdown } of parseSectionMarkers(m.content)) {
          fromTranscript.set(key, { markdown, status: 'done' }); // latest draft wins
        }
      }
      sections.clear();
      for (const s of SECTIONS) {
        const v = fromMd.get(s.key) ?? fromTranscript.get(s.key);
        if (v) sections.set(s.key, v);
      }
      if (data.finalMarkdown != null) finalMd = data.finalMarkdown;
      fire();
    },
    editSection(key, markdown) {
      sections.set(key, { markdown, status: 'done' });
      const rebuilt = rebuildMarkdown();
      if (finalMd != null) finalMd = rebuilt;
      fire();
      return rebuilt;
    },
    messages: () => messages,
    activePhase: () => phase,
    thinking: () => thinking,
    text: () => text,
    tools: () => tools,
    section: (k) => sections.get(k) ?? null,
    awaitingUser: () => awaiting,
    finalMarkdown: () => finalMd ?? (allSectionsDone() ? rebuildMarkdown() : null),
    ready: () => finalMd != null || allSectionsDone(),
    error: () => err,
    onChange(cb) { subs.add(cb); return () => subs.delete(cb); },
  };
}
