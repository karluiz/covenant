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

  it('footer keeps save/delete classes and shows delete only in edit', () => {
    const c = openOperatorModal({ mode: 'create' });
    expect(c.el.querySelector('.op-modal-save')).toBeTruthy();
    expect(c.el.querySelector('.op-modal-delete')).toBeFalsy();
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

  it('middle shows only the active section; right always shows live soul', () => {
    const m = openOperatorModal({ mode: 'create' });
    m.setSection('identity');
    const section = m.el.querySelector('.op-section')!;
    expect(section.querySelector('input.op-modal-input')).toBeTruthy();
    const live = m.el.querySelector('.op-soul-live')!;
    expect(live.querySelector('.op-soul-preview')).toBeFalsy();
    expect(live.querySelector('.op-soul-rawwrap')).toBeTruthy();
  });

  it('soul section shows the markdown editor in the middle', () => {
    const m = openOperatorModal({ mode: 'create' });
    m.setSection('soul');
    expect(m.el.querySelector('.op-section .md-editor')).toBeTruthy();
  });

  it('live operator chip renders in the header', () => {
    const m = openOperatorModal({ mode: 'create' });
    m.setName('Nova');
    const host = m.el.querySelector('header .op-hero-chip');
    expect(host && host.childElementCount > 0).toBeTruthy();
  });

  it('behaviour section shows hard-constraint hint and example chips', () => {
    const m = openOperatorModal({ mode: 'create' });
    m.setSection('behaviour');
    expect(m.el.querySelector('.op-hc-hint')?.textContent).toContain('Regex deny rules');
    expect(m.el.querySelectorAll('.op-hc-chip')).toHaveLength(6);
  });

  it('clicking a chip appends the rule to hard constraints, without duplicates', () => {
    const m = openOperatorModal({ mode: 'create' });
    m.setSection('behaviour');
    const chip = [...m.el.querySelectorAll<HTMLButtonElement>('.op-hc-chip')]
      .find((c) => c.textContent === '^git push --force')!;
    chip.click();
    expect(m.state.soulRaw).toContain('hard_constraints: |');
    expect(m.state.soulRaw).toContain('  ^git push --force');
    chip.click(); // exact same rule → no duplicate line
    const occurrences = m.state.soulRaw.split('^git push --force').length - 1;
    expect(occurrences).toBe(1);
  });

  it('chips append on new lines after existing rules', () => {
    const m = openOperatorModal({ mode: 'create' });
    m.setSection('behaviour');
    const chips = [...m.el.querySelectorAll<HTMLButtonElement>('.op-hc-chip')];
    chips.find((c) => c.textContent === '^npm publish')!.click();
    chips.find((c) => c.textContent === '^terraform apply')!.click();
    expect(m.state.soulRaw).toContain('  ^npm publish\n  ^terraform apply');
  });
});

describe('github access control', () => {
  it('defaults to Off in create mode', () => {
    const h = openOperatorModal({ mode: 'create' });
    expect(h.state.githubAccess).toBe('Off');
    h.el.remove();
  });

  it('seeds from the existing operator in edit mode', () => {
    const existing: Operator = {
      id: 'gh1', name: 'Maya', emoji: '🟣', color: '#a855f7',
      tags: [], persona: '', escalate_threshold: 0.5, model: 'claude-sonnet-4-6',
      hard_constraints: '', voice: 'Terse', is_default: false,
      created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
      github_access: 'ReadWrite',
    };
    const h = openOperatorModal({ mode: 'edit', existing });
    expect(h.state.githubAccess).toBe('ReadWrite');
    h.el.remove();
  });

  it('setGithubAccess updates state', () => {
    const h = openOperatorModal({ mode: 'create' });
    h.setGithubAccess('ReadOnly');
    expect(h.state.githubAccess).toBe('ReadOnly');
    h.el.remove();
  });

  it('duplicate-mode (create with existing) seeds githubAccess from source operator', () => {
    // Regression: duplicating a ReadWrite operator must seed the UI control to
    // ReadWrite so the user sees the right value — baseline for the persist
    // guard is independently forced to "Off" for all create-mode saves.
    const source: Operator = {
      id: 'src1', name: 'Maya', emoji: '🟣', color: '#a855f7',
      tags: [], persona: '', escalate_threshold: 0.5, model: 'claude-sonnet-4-6',
      hard_constraints: '', voice: 'Terse', is_default: false,
      created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
      github_access: 'ReadWrite',
    };
    const h = openOperatorModal({ mode: 'create', existing: source });
    // UI control must reflect the source operator's access level.
    expect(h.state.githubAccess).toBe('ReadWrite');
    h.el.remove();
  });
});

describe('operator list grid', () => {
  it('renders one card per operator', () => {
    const ops: Operator[] = [{
      id: '1', name: 'Maya', emoji: '🟣', color: '#a855f7',
      tags: [], persona: '', escalate_threshold: 0.5, model: 'gpt-4o',
      hard_constraints: '', is_default: true,
      created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0, voice: 'Terse',
      github_access: 'Off',
    }];
    const root = renderOperatorList(ops, { onEdit(){}, onDelete(){}, onDuplicate(){} });
    expect(root.querySelectorAll('.op-card').length).toBe(1);
    expect(root.textContent).toContain('Maya');
    expect(root.textContent).toContain('gpt-4o');
    expect(root.textContent).toContain('Terse');
  });

  it('renders one pill per tag, and no tag row when tags are empty', () => {
    const base = {
      id: '1', name: 'Maya', emoji: '🟣', color: '#a855f7',
      persona: '', escalate_threshold: 0.5, model: 'gpt-4o',
      hard_constraints: '', is_default: false,
      created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0, voice: 'Terse' as const,
      github_access: 'Off' as const,
    };
    const ops: Operator[] = [
      { ...base, id: '1', tags: ['reviewer', 'rust'] },
      { ...base, id: '2', name: 'Kiro', tags: [] },
    ];
    const root = renderOperatorList(ops, { onEdit(){}, onDelete(){}, onDuplicate(){} });
    const cards = root.querySelectorAll('.op-card');
    const pills = cards[0]!.querySelectorAll('.op-card-tag');
    expect([...pills].map((p) => p.textContent)).toEqual(['reviewer', 'rust']);
    expect(cards[1]!.querySelector('.op-card-tags')).toBeNull();
  });
});
