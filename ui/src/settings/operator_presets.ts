// Starter operator presets used by the two-step "New Operator" modal.
// Data-only: no DOM, no side effects. Task 14 wires these into the picker.
import type { OperatorDraft } from '../api';

export type PresetKey = 'reviewer' | 'pair' | 'watcher' | 'auto';

export interface Preset {
  key: PresetKey;
  label: string;
  description: string;
  seed: () => OperatorDraft;
}

export const PRESETS: Preset[] = [
  {
    key: 'reviewer',
    label: 'Reviewer',
    description: 'Terse · code review focus',
    seed: () => ({
      name: 'Reviewer',
      emoji: '🔵',
      color: '#3b82f6',
      voice: 'Terse',
      tags: ['review'],
      persona: 'Focused code reviewer.',
      escalate_threshold: 0.4,
      model: 'claude-sonnet-4-6',
      hard_constraints: '',
    }),
  },
  {
    key: 'pair',
    label: 'Pair',
    description: 'Warm · pair-programming companion',
    seed: () => ({
      name: 'Pair',
      emoji: '🟣',
      color: '#a855f7',
      voice: 'Warm',
      tags: ['pair'],
      persona: 'Conversational pair programmer.',
      escalate_threshold: 0.5,
      model: 'claude-sonnet-4-6',
      hard_constraints: '',
    }),
  },
  {
    key: 'watcher',
    label: 'Watcher',
    description: 'Terse · read-only observer',
    seed: () => ({
      name: 'Watcher',
      emoji: '⚪',
      color: '#94a3b8',
      voice: 'Terse',
      tags: ['observer'],
      persona: 'Passive observer; suggest only.',
      escalate_threshold: 0.7,
      model: 'claude-haiku-4-5-20251001',
      hard_constraints: 'Never auto-execute commands.',
    }),
  },
  {
    key: 'auto',
    label: 'Auto',
    description: 'Terse · autonomous',
    seed: () => ({
      name: 'Auto',
      emoji: '🟢',
      color: '#22c55e',
      voice: 'Terse',
      tags: ['auto'],
      persona: 'Autonomous operator with conservative allowlist.',
      escalate_threshold: 0.3,
      model: 'claude-sonnet-4-6',
      hard_constraints: 'Allowlist only.',
    }),
  },
];
