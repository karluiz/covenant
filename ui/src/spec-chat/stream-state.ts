import type { SpecStreamEvent, SpecSectionKey } from './events';

export interface ToolActivity { id: string; tool: string; arg: string; summary?: string; ok?: boolean; }
export interface SectionView { markdown: string; status: 'filling' | 'done'; }

export interface StreamState {
  apply(e: SpecStreamEvent): void;
  activePhase(): SpecSectionKey | null;
  thinking(): string;
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
  const subs = new Set<() => void>();
  const fire = () => subs.forEach((cb) => cb());

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
        case 'turn_done': awaiting = e.awaiting_user; break;
        case 'final': finalMd = e.markdown; break;
        case 'error': err = e.message; break;
      }
      fire();
    },
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
