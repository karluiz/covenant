import type { Operator } from '../api';

export type ChipSize = 'sm' | 'md' | 'lg';

export function renderOperatorChip(
  op: Pick<Operator, 'name' | 'emoji' | 'color'>,
  size: ChipSize = 'md',
): HTMLElement {
  const el = document.createElement('span');
  el.className = `op-chip op-chip-${size}`;
  el.style.setProperty('--operator-color', op.color);

  const avatar = document.createElement('span');
  avatar.className = 'op-chip-avatar';
  avatar.textContent = op.emoji || op.name.charAt(0).toUpperCase();

  const name = document.createElement('span');
  name.className = 'op-chip-name';
  name.textContent = op.name;

  el.append(avatar, name);
  return el;
}
