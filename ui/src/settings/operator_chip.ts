import type { Operator } from '../api';
import { pack2Url, parseAvatar } from '../operator/avatars';

export type ChipSize = 'sm' | 'md' | 'lg';

const AVATAR_PX: Record<ChipSize, number> = { sm: 16, md: 20, lg: 28 };

export function renderOperatorChip(
  op: Pick<Operator, 'name' | 'emoji' | 'color'>,
  size: ChipSize = 'md',
): HTMLElement {
  const el = document.createElement('span');
  el.className = `op-chip op-chip-${size}`;
  el.style.setProperty('--operator-color', op.color);

  const px = AVATAR_PX[size];
  const parsed = parseAvatar(op.emoji || '');
  let avatar: HTMLElement;
  if (parsed.kind === 'pack') {
    const img = document.createElement('img');
    img.className = 'op-chip-avatar op-chip-avatar-pixel';
    img.src = parsed.url;
    img.width = px;
    img.height = px;
    img.alt = '';
    img.draggable = false;
    avatar = img;
  } else if (parsed.kind === 'pack2') {
    // v2 avatar pack: chip surfaces are mood-agnostic (the chip can
    // appear anywhere — operator list, mention popup, AOM hover — and
    // there's no per-bubble sentiment to consult here). Always render
    // the neutral pose; sentiment-driven posing lives in the teammate
    // panel header where we know the current mood.
    const img = document.createElement('img');
    img.className = 'op-chip-avatar op-chip-avatar-pixel';
    img.src = pack2Url(parsed, 'neutral');
    img.width = px;
    img.height = px;
    img.alt = '';
    img.draggable = false;
    avatar = img;
  } else {
    avatar = document.createElement('span');
    avatar.className = 'op-chip-avatar op-chip-avatar-emoji';
    avatar.textContent = parsed.char || op.name.charAt(0).toUpperCase();
  }

  const name = document.createElement('span');
  name.className = 'op-chip-name';
  name.textContent = op.name;

  el.append(avatar, name);
  return el;
}
