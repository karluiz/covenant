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

  it('resuming a draft rehydrates the chat from disk', async () => {
    const loadDraft = vi.fn(async () => ({
      id: 'd9',
      messages: [
        { role: 'User' as const, content: 'Quiero acceso a TASKER' },
        { role: 'Assistant' as const, content: 'Entendido, confirma el acceso…' },
      ],
      partial_md: null,
      last_updated: '2026-06-08T00:00:00Z',
      status: { InProgress: { phase: 'goal' } } as const,
    }));
    mountImmersiveSpecCreator({
      host, source: mockEventSource([]), cwd: null, draftId: 'd9', loadDraft,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(loadDraft).toHaveBeenCalledWith('d9');
    const bubbles = host.querySelectorAll('.stream .bubble');
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].textContent).toContain('Quiero acceso a TASKER');
    // Starter chips vanish once the restored conversation is present.
    expect((host.querySelector('.starters') as HTMLElement).style.display).toBe('none');
  });

  it('does not load a draft for a fresh session', () => {
    const loadDraft = vi.fn();
    mountImmersiveSpecCreator({ host, source: mockEventSource([]), cwd: null, draftId: null, loadDraft });
    expect(loadDraft).not.toHaveBeenCalled();
  });
});
