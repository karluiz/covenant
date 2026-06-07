import { describe, it, expect } from 'vitest';
import { mockEventSource } from './events';

describe('mockEventSource', () => {
  it('replays scripted events to subscribers', async () => {
    const src = mockEventSource([
      { kind: 'phase', section: 'goal' },
      { kind: 'turn_done', awaiting_user: true },
    ]);
    const seen: string[] = [];
    src.subscribe((e) => seen.push(e.kind));
    await src.send(null, 'hi', null);
    expect(seen).toEqual(['phase', 'turn_done']);
  });
});
