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

  it('saves via the from-soul tauri command', async () => {
    const m = openOperatorModal({ mode: 'create' });
    // Create mode routes the raw SOUL.md text through the from-soul
    // command (the form's draft is now vestigial).
    await saveOperator(m);
    expect(invokeMock).toHaveBeenCalledWith(
      'operator_create_from_soul',
      expect.objectContaining({ raw: expect.stringContaining('New Operator') }),
    );
  });

  it('defaults to start section in create, identity in edit', () => {
    const c = openOperatorModal({ mode: 'create' });
    expect(c.state.activeSection).toBe('start');
    const e = openOperatorModal({
      mode: 'edit',
      existing: {
        id: 'x', name: 'Maya', emoji: '🟣', color: '#6B7280', voice: 'Terse',
        tags: [], persona: '', escalate_threshold: 0.5, model: 'claude-sonnet-4-6',
        hard_constraints: '', is_default: false,
      } as unknown as import('../api').Operator,
    });
    expect(e.state.activeSection).toBe('identity');
  });

  it('setSection switches the active section', () => {
    const m = openOperatorModal({ mode: 'create' });
    m.setSection('behaviour');
    expect(m.state.activeSection).toBe('behaviour');
  });

  it('renders the immersive shell scaffold', () => {
    const m = openOperatorModal({ mode: 'create' });
    const el = m.el;
    expect(el.classList.contains('op-creator')).toBe(true);
    expect(el.querySelector('.scrim')).toBeTruthy();
    expect(el.querySelector('.creator')).toBeTruthy();
    expect(el.querySelector('.creator header .brand')).toBeTruthy();
    expect(el.querySelector('.op-rail')).toBeTruthy();
    expect(el.querySelector('.op-section')).toBeTruthy();
    expect(el.querySelector('.op-soul-live')).toBeTruthy();
    expect(el.querySelector('.op-modal-save')).toBeTruthy();
  });

  it('rail shows Start only in create mode', () => {
    const c = openOperatorModal({ mode: 'create' });
    const labels = [...c.el.querySelectorAll('.op-rail-item')].map((n) => n.textContent);
    expect(labels.some((l) => /Start/i.test(l ?? ''))).toBe(true);
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
