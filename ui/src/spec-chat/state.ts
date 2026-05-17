import type { SpecStepResult, SpecDraftSummary, SpecPhase } from '../api';
import { specAuthorStep as defaultStep, specAuthorLoadDraft as defaultLoadDraft } from '../api';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SpecChatState {
  /** Current draft id (null = unstarted). */
  draftId: () => string | null;

  /** Read-only view of messages so far. */
  messages: () => readonly ChatMessage[];

  /** Awaiting an LLM response? */
  awaitingAnswer: () => boolean;

  /** Final markdown when agent has emitted; null otherwise. */
  finalMarkdown: () => string | null;

  /** Current phase ("goal", "outofscope", ...) — null if no question yet. */
  phase: () => SpecPhase | null;

  /** Submit a user message. Triggers a `specAuthorStep` call. Resolves
   *  when the response is appended. Throws if a previous submit is still pending. */
  submit: (text: string) => Promise<void>;

  /** Restore an existing draft from disk (loads via `specAuthorLoadDraft`). */
  restoreDraft: (id: string) => Promise<void>;

  /** Reset to a fresh, empty state. */
  reset: () => void;

  /** Subscribe to state changes. Returns an unsubscribe fn. */
  onChange: (cb: () => void) => () => void;
}

export function createSpecChatState(deps?: {
  step?: typeof import('../api').specAuthorStep;
  loadDraft?: typeof import('../api').specAuthorLoadDraft;
  getCwd?: () => string | null;
}): SpecChatState {
  const step = deps?.step ?? defaultStep;
  const loadDraft = deps?.loadDraft ?? defaultLoadDraft;
  const getCwd = deps?.getCwd ?? (() => null);

  let _draftId: string | null = null;
  let _messages: ChatMessage[] = [];
  let _awaitingAnswer = false;
  let _finalMarkdown: string | null = null;
  let _phase: SpecPhase | null = null;

  const listeners = new Set<() => void>();
  const fire = () => {
    for (const cb of listeners) cb();
  };

  const state: SpecChatState = {
    draftId: () => _draftId,
    messages: () => _messages,
    awaitingAnswer: () => _awaitingAnswer,
    finalMarkdown: () => _finalMarkdown,
    phase: () => _phase,

    async submit(text: string) {
      if (_awaitingAnswer) {
        throw new Error('submit in flight');
      }
      _messages = [..._messages, { role: 'user', content: text }];
      _awaitingAnswer = true;
      fire();

      let result: SpecStepResult;
      try {
        result = await step(_draftId, text, getCwd());
      } catch (err) {
        _awaitingAnswer = false;
        fire();
        throw err;
      }

      _draftId = result.draftId;
      if (result.output.kind === 'question') {
        _messages = [
          ..._messages,
          { role: 'assistant', content: result.output.text },
        ];
        _phase = result.output.phase;
      } else {
        _messages = [
          ..._messages,
          { role: 'assistant', content: result.output.markdown },
        ];
        _finalMarkdown = result.output.markdown;
        _phase = 'emit';
      }
      _awaitingAnswer = false;
      fire();
    },

    async restoreDraft(id: string) {
      const summary: SpecDraftSummary = await loadDraft(id);
      _draftId = id;
      _messages = summary.messages.map((m) => ({
        role: m.role === 'User' ? 'user' : 'assistant',
        content: m.content,
      }));
      if (summary.partial_md != null) {
        _finalMarkdown = summary.partial_md;
      }
      const status = summary.status;
      if (status === 'Ready' || status === 'Published') {
        _phase = 'emit';
      } else if (typeof status === 'object' && 'InProgress' in status) {
        _phase = status.InProgress.phase.toLowerCase() as SpecPhase;
      }
      _awaitingAnswer = false;
      fire();
    },

    reset() {
      _draftId = null;
      _messages = [];
      _awaitingAnswer = false;
      _finalMarkdown = null;
      _phase = null;
      fire();
    },

    onChange(cb: () => void) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };

  return state;
}
