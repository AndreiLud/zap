// What the Worker forwards to a room with a WebSocket upgrade: the upgrade headers and its own
// X-Zap-* values, nothing else the browser sent.

import { describe, expect, it } from 'vitest';
import { wsForwardHeaders } from '../src/ws-headers.ts';

describe('WebSocket upgrade forwarded to a room', () => {
  it('keeps only the upgrade headers and the values the Worker set', () => {
    const incoming = new Headers({
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Extensions': 'permessage-deflate',
      Cookie: 'zap_device=secret; zap_cred=cred',
      'CF-Connecting-IP': '198.18.1.2',
      'X-Forwarded-For': '198.18.1.2',
      'User-Agent': 'Mozilla/5.0',
      Origin: 'https://zap.example',
      'X-Zap-Device': 'forged',
      'X-Zap-Verified': '1',
    });
    const out = wsForwardHeaders(incoming, { 'X-Zap-Device': 'a'.repeat(64), 'X-Zap-Matches-Left': '3' });
    expect(Object.fromEntries(out)).toEqual({
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-extensions': 'permessage-deflate',
      'x-zap-device': 'a'.repeat(64),
      'x-zap-matches-left': '3',
    });
    // An X-Zap-* header the browser sent never passes, even when the Worker sets no value for it.
    expect(out.has('x-zap-verified')).toBe(false);
  });

  it('refuses to forward anything but X-Zap-* values of its own', () => {
    expect(() => wsForwardHeaders(new Headers(), { Cookie: 'x' })).toThrow();
  });
});
