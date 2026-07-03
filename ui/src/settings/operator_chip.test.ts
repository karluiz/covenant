import { describe, it, expect } from 'vitest';
import { renderOperatorChip } from './operator_chip';
import type { Operator } from '../api';

const maya: Operator = {
  id: '01H', name: 'Maya', emoji: '🟣', color: '#a855f7',
  tags: [], persona: '', escalate_threshold: 0.5, model: '',
  hard_constraints: '', is_default: false,
  created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0, voice: 'Terse',
  github_access: 'Off',
  acp_enabled: false,
};

describe('renderOperatorChip', () => {
  it('shows emoji + name with color tint var', () => {
    const el = renderOperatorChip(maya, 'md');
    expect(el.textContent).toContain('🟣');
    expect(el.textContent).toContain('Maya');
    expect(el.style.getPropertyValue('--operator-color')).toBe('#a855f7');
  });
});
