// The headers the Worker forwards to a room with a WebSocket upgrade: only what the upgrade needs
// and the X-Zap-* values the Worker set itself. Nothing else the browser sent (cookies, its IP as
// Cloudflare reports it, the user agent) reaches the room.

const UPGRADE_HEADERS = ['upgrade', 'connection'];

export function wsForwardHeaders(incoming: Headers, own: Record<string, string>): Headers {
  const out = new Headers();
  for (const [name, value] of incoming) {
    const k = name.toLowerCase();
    if (UPGRADE_HEADERS.includes(k) || k.startsWith('sec-websocket-')) out.set(k, value);
  }
  for (const [name, value] of Object.entries(own)) {
    if (!/^x-zap-/i.test(name)) throw new Error(`not a room header: ${name}`);
    out.set(name, value);
  }
  return out;
}
