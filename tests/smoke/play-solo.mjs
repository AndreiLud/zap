// Smoke test against a running `wrangler dev`: human check with the Turnstile test keys, quick
// play, then a whole match over the WebSocket choosing random legal moves.
// Usage: node tests/smoke/play-solo.mjs [base=http://127.0.0.1:8787]
const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
async function call(path, body) {
  const res = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: base, 'content-type': 'application/json', cookie: cookieHeader() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i), kv.slice(i + 1));
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

const t0 = Date.now();
console.log('me before', await call('/api/me'));
console.log('play without check', (await call('/api/play', {})).status);
console.log('session', await call('/api/session', { token: 'XXXX.DUMMY.TOKEN.XXXX' }));
const play = await call('/api/play', { players: 4, variant: 'paulista' });
console.log('play', play);
const code = play.body.code;
console.log('room info', (await call(`/api/rooms/${code}`)).body?.seats?.map((s) => `${s.kind}:${s.name}`).join(', '));

const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${code}/ws`, { headers: { origin: base, cookie: cookieHeader() } });
let seq = 0;
let moves = 0;
let messages = 0;
let you = null;
const done = new Promise((resolve, reject) => {
  ws.onerror = (e) => reject(new Error('ws error ' + (e.message ?? '')));
  ws.onclose = (e) => resolve(`closed ${e.code}`);
  ws.onmessage = (ev) => {
    messages++;
    const m = JSON.parse(ev.data);
    if (m.t === 'room') {
      you = m.you;
      if (m.room.status === 'ended') resolve(`ended, winner team ${m.room.lastWinner}, score ${m.room.score}`);
    }
    if (m.t === 'error') console.log('error', m.code);
    if (m.t === 'game') {
      seq = m.seq;
      if (m.obs.legal && !m.obs.over) {
        const acts = [...Array(15).keys()].filter((a) => m.obs.legal & (1 << a));
        // Prefer card plays so matches end quickly.
        const cards = acts.filter((a) => a < 3);
        const pool = cards.length && Math.random() < 0.8 ? cards : acts;
        const a = pool[Math.floor(Math.random() * pool.length)];
        moves++;
        // A person takes time; the room disconnects clients that send more than 4 messages per second.
        const s = seq;
        setTimeout(() => ws.send(JSON.stringify({ t: 'act', seq: s, a })), 300);
      }
    }
  };
});
const result = await Promise.race([done, new Promise((r) => setTimeout(() => r('timeout'), 120_000))]);
console.log({ result, you, moves, messages, seconds: (Date.now() - t0) / 1000 });
ws.close();
process.exit(0);
