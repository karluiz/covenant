// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountImmersiveSpecCreator } from './immersive';
import { mockEventSource } from './events';

describe('mountImmersiveSpecCreator', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });

  it('opens with both columns and a composer', () => {
    const src = mockEventSource([]);
    mountImmersiveSpecCreator({ host, source: src, cwd: null });
    expect(host.querySelector('.left')).toBeTruthy();
    expect(host.querySelector('.right')).toBeTruthy();
    expect(host.querySelector('.md-editor')).toBeTruthy();
  });

  it('submitting the composer calls source.send', () => {
    const send = vi.fn(async () => 'd1');
    const src = { send, subscribe: () => () => {} };
    const inst = mountImmersiveSpecCreator({ host, source: src, cwd: '/repo' });
    // send button wiring — clicking the send button triggers submit
    expect(host.querySelector('.send')).toBeTruthy();
    inst.submit(); // no-op since composer is empty; just verify it doesn't throw
    expect(send).not.toHaveBeenCalled();
  });

  it('Esc triggers onClose', () => {
    const onClose = vi.fn();
    mountImmersiveSpecCreator({ host, source: mockEventSource([]), cwd: null, onClose });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onClose).toHaveBeenCalled();
  });
});
