// Starter operator presets used by the two-step "New Operator" modal.
// Data-only: no DOM, no side effects.
//
// Personas reuse the rich charters from `ui/src/operator/persona-templates.ts`
// so chips give a one-click "fully-populated operator" rather than a stub.
import type { OperatorDraft } from '../api';
import { OPERATOR_PERSONA_TEMPLATES } from '../operator/persona-templates';

export type PresetKey =
  | 'reviewer'
  | 'pair'
  | 'watcher'
  | 'auto'
  | 'yolo'
  | 'qa'
  | 'scout'
  | 'spec';

export interface Preset {
  key: PresetKey;
  label: string;
  description: string;
  seed: () => OperatorDraft;
}

function personaByName(name: string): string {
  return OPERATOR_PERSONA_TEMPLATES.find((t) => t.name === name)?.persona ?? '';
}

export const PRESETS: Preset[] = [
  {
    key: 'reviewer',
    label: 'Reviewer',
    description: 'Terse · senior code reviewer, escalates on architecture',
    seed: () => ({
      name: 'Reviewer',
      emoji: '🔵',
      color: '#3b82f6',
      voice: 'Terse',
      tags: ['review'],
      persona: personaByName('Cautious senior'),
      escalate_threshold: 0.4,
      model: 'claude-sonnet-4-6',
      hard_constraints: '',
    }),
  },
  {
    key: 'yolo',
    label: 'Yolo',
    description: 'Throughput-first autopilot — yes to everything routine',
    seed: () => ({
      name: 'Yolo',
      emoji: '🟢',
      color: '#22c55e',
      voice: 'Terse',
      tags: ['auto', 'yolo'],
      persona: personaByName('YOLO autopilot'),
      escalate_threshold: 0.15,
      model: 'claude-sonnet-4-6',
      hard_constraints: '',
    }),
  },
  {
    key: 'qa',
    label: 'QA',
    description: 'Test-failure focus · structured debugging escalations',
    seed: () => ({
      name: 'QA',
      emoji: '🟠',
      color: '#f97316',
      voice: 'Terse',
      tags: ['qa', 'tests'],
      persona: personaByName('Debugger'),
      escalate_threshold: 0.45,
      model: 'claude-sonnet-4-6',
      hard_constraints: '',
    }),
  },
  {
    key: 'scout',
    label: 'Scout',
    description: 'Read-only auditor · always escalates with analysis',
    seed: () => ({
      name: 'Scout',
      emoji: '⚪',
      color: '#94a3b8',
      voice: 'Formal',
      tags: ['observer', 'scout'],
      persona: personaByName('Read-only auditor'),
      escalate_threshold: 0.85,
      model: 'claude-haiku-4-5-20251001',
      hard_constraints: 'Never auto-execute commands.',
    }),
  },
  {
    key: 'pair',
    label: 'Pair',
    description: 'Warm · conservative pair-programmer, explains decisions',
    seed: () => ({
      name: 'Pair',
      emoji: '🟣',
      color: '#a855f7',
      voice: 'Warm',
      tags: ['pair'],
      persona: personaByName('Junior pair'),
      escalate_threshold: 0.6,
      model: 'claude-sonnet-4-6',
      hard_constraints: '',
    }),
  },
  {
    key: 'spec',
    label: 'Spec',
    description: 'Spec-driven · only acts on documented plan steps',
    seed: () => ({
      name: 'Spec',
      emoji: '🟡',
      color: '#eab308',
      voice: 'Formal',
      tags: ['spec'],
      persona: personaByName('Spec-driven'),
      escalate_threshold: 0.5,
      model: 'claude-sonnet-4-6',
      hard_constraints: '',
    }),
  },
  {
    key: 'watcher',
    label: 'Watcher',
    description: 'Terse · passive read-only observer',
    seed: () => ({
      name: 'Watcher',
      emoji: '⚫',
      color: '#64748b',
      voice: 'Terse',
      tags: ['observer'],
      persona: personaByName('Read-only auditor'),
      escalate_threshold: 0.8,
      model: 'claude-haiku-4-5-20251001',
      hard_constraints: 'Never auto-execute commands.',
    }),
  },
  {
    key: 'auto',
    label: 'Auto',
    description: 'Terse · autonomous with conservative allowlist',
    seed: () => ({
      name: 'Auto',
      emoji: '🟩',
      color: '#16a34a',
      voice: 'Terse',
      tags: ['auto'],
      persona: personaByName('YOLO autopilot'),
      escalate_threshold: 0.3,
      model: 'claude-sonnet-4-6',
      hard_constraints: 'Allowlist only.',
    }),
  },
];
