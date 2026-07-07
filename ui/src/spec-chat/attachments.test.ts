import { describe, it, expect } from 'vitest';
import { fitWithin, stripDataUrl, encodeTarget, MAX_EDGE } from './attachments';

describe('attachments', () => {
  it('fitWithin downscales the longest edge to MAX_EDGE, never upscaling', () => {
    expect(fitWithin(3136, 1568)).toEqual({ w: MAX_EDGE, h: 784 });
    expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600 });
    expect(fitWithin(1568, 3136).h).toBe(MAX_EDGE);
  });

  it('stripDataUrl splits media type and payload', () => {
    expect(stripDataUrl('data:image/png;base64,AAAA')).toEqual({ mediaType: 'image/png', dataB64: 'AAAA' });
    expect(stripDataUrl('not a data url')).toBeNull();
  });

  it('encodeTarget keeps jpeg, converts everything else to png', () => {
    expect(encodeTarget('image/jpeg')).toBe('image/jpeg');
    expect(encodeTarget('image/webp')).toBe('image/png');
    expect(encodeTarget('image/png')).toBe('image/png');
  });
});
