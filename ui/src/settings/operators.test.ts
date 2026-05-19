// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { openOperatorModal, canProceedFromStep1, saveOperator, renderOperatorList } from './operators';
import type { Operator } from '../api';

beforeEach(() => {
  document.body.innerHTML = '';
  invokeMock.mockClear();
});

describe('operator modal', () => {
  it('blocks step 1 when name empty', () => {
    const m = openOperatorModal({ mode: 'create' });
    expect(canProceedFromStep1(m)).toBe(false);
    m.setName('Maya');
    expect(canProceedFromStep1(m)).toBe(true);
  });

  it('blocks step 1 when name > 24 chars', () => {
    const m = openOperatorModal({ mode: 'create' });
    m.setName('x'.repeat(25));
    expect(canProceedFromStep1(m)).toBe(false);
  });

  it('preset seeds both steps', () => {
    const m = openOperatorModal({ mode: 'create', preset: 'reviewer' });
    expect(m.state.draft.name).toBe('Reviewer');
    expect(m.state.draft.model).toBe('claude-sonnet-4-6');
    expect(m.state.draft.voice).toBe('Terse');
  });

  it('saves via tauri command', async () => {
    const m = openOperatorModal({ mode: 'create', preset: 'reviewer' });
    m.setName('Cal');
    await saveOperator(m);
    expect(invokeMock).toHaveBeenCalledWith(
      'operator_create',
      expect.objectContaining({
        draft: expect.objectContaining({ name: 'Cal', voice: 'Terse' }),
      }),
    );
  });
});

describe('operator list grid', () => {
  it('renders one card per operator', () => {
    const ops: Operator[] = [{
      id: '1', name: 'Maya', emoji: '🟣', color: '#a855f7',
      tags: [], persona: '', escalate_threshold: 0.5, model: 'gpt-4o',
      hard_constraints: '', is_default: true,
      created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0, voice: 'Terse',
    }];
    const root = renderOperatorList(ops, { onEdit(){}, onDelete(){}, onDuplicate(){} });
    expect(root.querySelectorAll('.op-card').length).toBe(1);
    expect(root.textContent).toContain('Maya');
    expect(root.textContent).toContain('gpt-4o');
    expect(root.textContent).toContain('Terse');
  });
});
