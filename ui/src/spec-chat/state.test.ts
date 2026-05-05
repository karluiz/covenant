import { describe, it, expect, vi } from 'vitest';
import { createSpecChatState } from './state';
import type { SpecStepResult, SpecDraftSummary } from '../api';

function makeQuestionResult(draftId = 'draft-1'): SpecStepResult {
  return {
    draftId,
    output: { kind: 'question', phase: 'goal', text: 'What is the goal?' },
  };
}

function makeFinalResult(draftId = 'draft-1'): SpecStepResult {
  return {
    draftId,
    output: { kind: 'final', markdown: '# Spec\n\nDone.' },
  };
}

function makeDraftSummary(overrides: Partial<SpecDraftSummary> = {}): SpecDraftSummary {
  return {
    id: 'draft-42',
    messages: [
      { role: 'User', content: 'hello' },
      { role: 'Assistant', content: 'What is the goal?' },
    ],
    partial_md: null,
    last_updated: '2026-05-05T00:00:00Z',
    status: { InProgress: { phase: 'goal' } },
    ...overrides,
  };
}

describe('createSpecChatState', () => {
  it('submit happy path — question response', async () => {
    const stepMock = vi.fn().mockResolvedValue(makeQuestionResult());
    const state = createSpecChatState({ step: stepMock });

    const changes: number[] = [];
    state.onChange(() => changes.push(Date.now()));

    await state.submit('I want a new feature');

    // onChange fires twice: on submit-start and on response
    expect(changes.length).toBe(2);

    const msgs = state.messages();
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toEqual({ role: 'user', content: 'I want a new feature' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'What is the goal?' });

    expect(state.draftId()).toBe('draft-1');
    expect(state.phase()).toBe('goal');
    expect(state.awaitingAnswer()).toBe(false);
    expect(state.finalMarkdown()).toBeNull();
  });

  it('submit happy path — final response sets finalMarkdown and phase=emit', async () => {
    const stepMock = vi.fn().mockResolvedValue(makeFinalResult());
    const state = createSpecChatState({ step: stepMock });

    await state.submit('all good');

    const msgs = state.messages();
    expect(msgs[1]).toEqual({ role: 'assistant', content: '# Spec\n\nDone.' });
    expect(state.finalMarkdown()).toBe('# Spec\n\nDone.');
    expect(state.phase()).toBe('emit');
    expect(state.awaitingAnswer()).toBe(false);
  });

  it('submit while in flight throws and does NOT call step a second time', async () => {
    let resolveFirst!: (v: SpecStepResult) => void;
    const firstPromise = new Promise<SpecStepResult>((res) => { resolveFirst = res; });
    const stepMock = vi.fn().mockReturnValueOnce(firstPromise);
    const state = createSpecChatState({ step: stepMock });

    const firstSubmit = state.submit('first');

    await expect(state.submit('second')).rejects.toThrow('submit in flight');
    expect(stepMock).toHaveBeenCalledTimes(1);

    resolveFirst(makeQuestionResult());
    await firstSubmit;
  });

  it('submit with rejected step clears awaitingAnswer, re-throws, user message remains', async () => {
    const err = new Error('network error');
    const stepMock = vi.fn().mockRejectedValue(err);
    const state = createSpecChatState({ step: stepMock });

    await expect(state.submit('help')).rejects.toThrow('network error');

    expect(state.awaitingAnswer()).toBe(false);
    const msgs = state.messages();
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toEqual({ role: 'user', content: 'help' });
  });

  it('restoreDraft populates messages, draftId, phase from SpecDraftSummary', async () => {
    const summary = makeDraftSummary();
    const loadDraftMock = vi.fn().mockResolvedValue(summary);
    const state = createSpecChatState({ loadDraft: loadDraftMock });

    const changed = vi.fn();
    state.onChange(changed);

    await state.restoreDraft('draft-42');

    expect(state.draftId()).toBe('draft-42');
    expect(state.phase()).toBe('goal');
    expect(state.awaitingAnswer()).toBe(false);
    expect(state.finalMarkdown()).toBeNull();

    const msgs = state.messages();
    expect(msgs.length).toBe(2);
    expect(msgs[0]).toEqual({ role: 'user', content: 'hello' });
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'What is the goal?' });

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('restoreDraft with Ready status sets phase=emit and partial_md', async () => {
    const summary = makeDraftSummary({ status: 'Ready', partial_md: '# Done' });
    const loadDraftMock = vi.fn().mockResolvedValue(summary);
    const state = createSpecChatState({ loadDraft: loadDraftMock });

    await state.restoreDraft('draft-42');

    expect(state.phase()).toBe('emit');
    expect(state.finalMarkdown()).toBe('# Done');
  });

  it('reset clears everything and fires onChange once', async () => {
    const stepMock = vi.fn().mockResolvedValue(makeQuestionResult());
    const state = createSpecChatState({ step: stepMock });
    await state.submit('populate some state');

    const changed = vi.fn();
    state.onChange(changed);

    state.reset();

    expect(changed).toHaveBeenCalledTimes(1);
    expect(state.draftId()).toBeNull();
    expect(state.messages().length).toBe(0);
    expect(state.awaitingAnswer()).toBe(false);
    expect(state.finalMarkdown()).toBeNull();
    expect(state.phase()).toBeNull();
  });
});
